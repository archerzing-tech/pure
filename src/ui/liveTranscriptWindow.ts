import {
  createHistoryGroup,
  formatHistoryGroupSummary,
  TRANSCRIPT_GROUP_THRESHOLD,
  TRANSCRIPT_GROUP_TURNS,
  TRANSCRIPT_RECENT_PLAIN_TURNS,
  type HistoryGroupHandle,
} from './transcriptHistory';

export interface LiveTurnHandle {
  id: number;
  host: HTMLElement;
  userText: string;
  completed: boolean;
  /** True once the turn has been folded into a history group. */
  grouped: boolean;
}

export interface LiveTranscriptWindowOptions {
  /** Session-owned transcript column this live window appends into. Defaults
   * to the shared #chat element (single-session mode). */
  root?: HTMLElement | null;
  /** Scrolling container the history groups observe. Defaults to #chat. */
  scrollRoot?: HTMLElement | null;
  groupSize?: number;
  recentPlainTurns?: number;
  groupThreshold?: number;
}

export class LiveTranscriptWindow {
  private readonly rootEl: HTMLElement | null;
  private readonly scrollRoot: HTMLElement | null;
  private readonly groupSize: number;
  private readonly recentPlainTurns: number;
  private readonly groupThreshold: number;
  private readonly turns: LiveTurnHandle[] = [];
  private readonly groups: HistoryGroupHandle[] = [];
  private groupedTurns = 0;
  private nextTurnId = 1;

  constructor(options: LiveTranscriptWindowOptions = {}) {
    this.rootEl = options.root ?? null;
    this.scrollRoot = options.scrollRoot ?? null;
    this.groupSize = Math.max(1, Math.floor(options.groupSize ?? TRANSCRIPT_GROUP_TURNS));
    this.recentPlainTurns = Math.max(0, Math.floor(options.recentPlainTurns ?? TRANSCRIPT_RECENT_PLAIN_TURNS));
    this.groupThreshold = Math.max(0, Math.floor(options.groupThreshold ?? TRANSCRIPT_GROUP_THRESHOLD));
  }

  /** Root transcript container this live window writes into. */
  private root(): HTMLElement {
    return this.rootEl ?? document.getElementById('chat')!;
  }

  startTurn(userText: string): LiveTurnHandle {
    const previous = this.turns.at(-1);
    if (previous && !previous.completed) {
      previous.completed = true;
      previous.host.dataset.turnState = 'complete';
    }
    const host = document.createElement('div');
    host.className = 'bubble-turn';
    host.dataset.turnId = String(this.nextTurnId);
    host.dataset.turnState = 'active';
    this.root().appendChild(host);
    const turn: LiveTurnHandle = {
      id: this.nextTurnId++,
      host,
      userText,
      completed: false,
      grouped: false,
    };
    this.turns.push(turn);
    this.compactHistory();
    return turn;
  }

  finishTurn(turn: LiveTurnHandle): void {
    if (!this.turns.includes(turn)) return;
    turn.completed = true;
    turn.host.dataset.turnState = 'complete';
    this.compactHistory();
  }

  reset(): void {
    this.turns.length = 0;
    this.groups.length = 0;
    this.groupedTurns = 0;
    this.nextTurnId = 1;
  }

  /** Turns still mounted as plain, individually visible turns. */
  getMountedTurnCount(): number {
    return this.turns.filter(turn => !turn.grouped).length;
  }

  /** Turns folded into a history group (their content is mounted on demand). */
  getGroupedTurnCount(): number {
    return this.turns.filter(turn => turn.grouped).length;
  }

  /** The history groups built so far, oldest first (diagnostics + tests). */
  getGroupHandles(): readonly HistoryGroupHandle[] {
    return this.groups;
  }

  moveNodeToTurn(node: Node, target: LiveTurnHandle): boolean {
    if (!this.turns.includes(target) || target.grouped) return false;
    for (const turn of this.turns) {
      if (turn === target || turn.grouped) continue;
      if (turn.host.contains(node)) {
        node.parentNode?.removeChild(node);
        target.host.appendChild(node);
        return true;
      }
    }
    for (const group of this.groups) {
      if (!group.contains(node)) continue;
      group.detach(node);
      target.host.appendChild(node);
      return true;
    }
    const chat = this.root();
    if (chat && node.parentNode === chat) {
      chat.removeChild(node);
      target.host.appendChild(node);
      return true;
    }
    return false;
  }

  /**
   * Fold the oldest turns into history groups once the session is long enough
   * that browsing it needs structure. The newest `recentPlainTurns` turns stay
   * plain, and every `groupSize` turns before them become ONE group — the same
   * segmentation a disk restore produces, and expanded by default either way.
   */
  private compactHistory(): void {
    if (this.turns.length <= this.groupThreshold) return;
    const targetGrouped = this.turns.length - this.recentPlainTurns;
    while (this.groupedTurns + this.groupSize <= targetGrouped) {
      const slice = this.turns.slice(this.groupedTurns, this.groupedTurns + this.groupSize);
      this.foldTurns(slice);
      this.groupedTurns += slice.length;
    }
  }

  private foldTurns(slice: LiveTurnHandle[]): void {
    const group = createHistoryGroup({ scrollRoot: this.scrollRoot, parkOffscreen: true });
    const nodes: Node[] = [];
    let toolCalls = 0;
    let artifacts = 0;
    for (const turn of slice) {
      // The live transcript has no projected blocks, so the group summary is
      // counted from the DOM the turns already built.
      toolCalls += turn.host.querySelectorAll('.tool-row-row').length;
      artifacts += turn.host.querySelectorAll('.bubble-row.artifact-row').length;
      while (turn.host.firstChild) nodes.push(turn.host.removeChild(turn.host.firstChild));
    }
    group.setSummary(formatHistoryGroupSummary({
      startTurn: slice[0].id,
      endTurn: slice[slice.length - 1].id,
      turnCount: slice.length,
      toolCalls,
      artifacts,
      preview: slice[0].userText,
    }));

    const chat = this.root();
    // The group takes the place of the turns it absorbs: before the first turn
    // that is still plain, so the transcript order never changes.
    const anchor = this.turns.find(turn => !turn.grouped && turn.host.isConnected)?.host ?? null;
    if (anchor) chat.insertBefore(group.el, anchor);
    else chat.appendChild(group.el);

    for (const turn of slice) {
      turn.grouped = true;
      turn.host.dataset.turnState = 'grouped';
      turn.host.remove();
    }
    group.adopt(nodes);
    this.groups.push(group);
    // A group covers the OLD part of a long session, so it is normally off
    // screen: the group's viewport observer parks the content on its first
    // callback and mounts it again the moment the reader scrolls up to it. No
    // explicit park() here — a group that happens to land inside the viewport
    // must keep its content mounted.
  }
}
