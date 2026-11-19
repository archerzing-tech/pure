import {
  createHistoryGroup,
  formatHistoryGroupSummary,
  TRANSCRIPT_GROUP_THRESHOLD,
  TRANSCRIPT_GROUP_TURNS,
  TRANSCRIPT_RECENT_PLAIN_TURNS,
  type HistoryGroupHandle,
} from './transcriptHistory';
import { isElementPinnedToBottom } from './scrollPin';

/** 活跃 turn 的估算 DOM 体量帽（2026-11-18 run5 判例）：工程构建是单个 send
 *  内的 auto-continue 巨物，按「轮数」分箱的直播窗口对它整体失明——run5 一
 *  个 turn 装下 21MB（读截图产生的 base64 内嵌图+大工具卡），WKWebView 合成
 *  器弃画早期图层，用户看到「渲染了一半、糊成一片」。体量帽按估算字节计
 *  （文本 ×2 + 图片 src 全长），越帽即把活跃 turn 的老节点部分折叠进历史组
 *  （视口泊车/滚回恢复与恢复路径同一套机制）。 */
const LIVE_TURN_WEIGHT_BYTES = 1_500_000;
/** 部分折叠时保留在活跃 turn 里的最新顶层节点数：直播流正在写的气泡必须
 *  保持挂载（折进泊车组=写进游离节点，内容会从视野里消失）。 */
const LIVE_TURN_TAIL_KEEP = 4;

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
  /** 活跃 turn 的估算体量帽（字节）。默认 1.5MB；测试传小值驱动折叠规则。 */
  liveTurnWeightBytes?: number;
}

export class LiveTranscriptWindow {
  private readonly rootEl: HTMLElement | null;
  private readonly scrollRoot: HTMLElement | null;
  private readonly groupSize: number;
  private readonly recentPlainTurns: number;
  private readonly groupThreshold: number;
  private readonly liveTurnWeightCap: number;
  private readonly turns: LiveTurnHandle[] = [];
  private readonly groups: HistoryGroupHandle[] = [];
  private groupedTurns = 0;
  private nextTurnId = 1;
  private activeObserver: MutationObserver | null = null;
  private activeWeightBytes = 0;

  constructor(options: LiveTranscriptWindowOptions = {}) {
    this.rootEl = options.root ?? null;
    this.scrollRoot = options.scrollRoot ?? null;
    this.groupSize = Math.max(1, Math.floor(options.groupSize ?? TRANSCRIPT_GROUP_TURNS));
    this.recentPlainTurns = Math.max(0, Math.floor(options.recentPlainTurns ?? TRANSCRIPT_RECENT_PLAIN_TURNS));
    this.groupThreshold = Math.max(0, Math.floor(options.groupThreshold ?? TRANSCRIPT_GROUP_THRESHOLD));
    this.liveTurnWeightCap = Math.max(1, Math.floor(options.liveTurnWeightBytes ?? LIVE_TURN_WEIGHT_BYTES));
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
    this.attachWeightObserver(host);
    return turn;
  }

  finishTurn(turn: LiveTurnHandle): void {
    if (!this.turns.includes(turn)) return;
    turn.completed = true;
    turn.host.dataset.turnState = 'complete';
    this.compactHistory();
  }

  reset(): void {
    this.activeObserver?.disconnect();
    this.activeObserver = null;
    this.activeWeightBytes = 0;
    this.turns.length = 0;
    this.groups.length = 0;
    this.groupedTurns = 0;
    this.nextTurnId = 1;
  }

  /** 记一笔活跃 turn 的估算体量增量（字节），越帽即尝试部分折叠。观察器回
   *  调与测试都走这里——增量来源（MutationObserver）与折叠规则解耦。 */
  noteLiveWeight(bytes: number): void {
    if (this.turns.length === 0) return;
    this.activeWeightBytes += Math.max(0, bytes);
    if (this.activeWeightBytes > this.liveTurnWeightCap) this.foldLiveTail();
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

  /** 活跃 turn 的体量观察器：直播流对 turn host 的每一次插入/文本增长都
   *  折算成估算字节并送 noteLiveWeight。观察器回调本就按微任务合批，增量
   *  估算只对新增子树做 textContent/img 统计，全程 O(内容总量)。
   *  不开 characterDataOldValue（流式 tick 每拍强制旧值拷贝是卡顿源，
   *  2026-11-19 判例）：文本节点用 WeakMap 记上次长度算增量。 */
  private readonly lastSeenTextLen = new WeakMap<Node, number>();

  private attachWeightObserver(host: HTMLElement): void {
    this.activeObserver?.disconnect();
    this.activeWeightBytes = 0;
    if (typeof MutationObserver === 'undefined') return;
    this.activeObserver = new MutationObserver((muts) => {
      let delta = 0;
      for (const m of muts) {
        if (m.type === 'characterData') {
          const nv = m.target.textContent?.length ?? 0;
          const ov = this.lastSeenTextLen.get(m.target) ?? 0;
          delta += Math.max(0, nv - ov) * 2;
          this.lastSeenTextLen.set(m.target, nv);
        } else {
          for (const n of m.addedNodes) {
            delta += estimateNodeBytes(n);
            if (n.nodeType === Node.TEXT_NODE) this.lastSeenTextLen.set(n, n.textContent?.length ?? 0);
          }
        }
      }
      if (delta > 0) this.noteLiveWeight(delta);
    });
    this.activeObserver.observe(host, { childList: true, subtree: true, characterData: true });
  }

  /**
   * 部分折叠活跃 turn：把最老的顶层节点折进历史组（视口泊车/滚回恢复与恢
   * 复路径同一套），最新 LIVE_TURN_TAIL_KEEP 个节点留挂——直播流正在写的
   * 气泡必须在文档里。两道闸：①用户没钉在底部时不折（折叠会把他正在读的
   * 内容收进折叠组，视野被拽走）；②顶层节点数不足 keep+1 时不折（体量在
   * 尾节点里的巨气泡留给单气泡手术，不在这一刀的范围）。
   */
  private foldLiveTail(): void {
    const turn = this.turns.at(-1);
    if (!turn || turn.grouped) return;
    const host = turn.host;
    const children = Array.from(host.childNodes);
    if (children.length <= LIVE_TURN_TAIL_KEEP) return;
    const scroller = this.scrollRoot ?? this.rootEl ?? document.getElementById('chat');
    if (scroller && !isElementPinnedToBottom(scroller)) return;
    const keep = children.slice(-LIVE_TURN_TAIL_KEEP);
    const fold = children.slice(0, children.length - LIVE_TURN_TAIL_KEEP);
    let toolCalls = 0;
    let images = 0;
    for (const n of fold) {
      host.removeChild(n);
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element;
        toolCalls += el.querySelectorAll('.tool-row-row').length;
        // 剥重物（2026-11-19 窗口卡死判例）：折叠组若带 base64 截图挂载，文
        // 本虽轻、位图解码与合成层照旧压垮 WKWebView。原图在盘上与快照里都
        // 在——DOM 里换成轻占位，重开会话走恢复路径可看原图。
        for (const img of el.querySelectorAll('img')) {
          const src = img.getAttribute('src') ?? '';
          if (!src.startsWith('data:')) continue;
          const note = document.createElement('span');
          note.className = 'folded-image-note';
          note.textContent = `📷 截图已存盘（${Math.round(src.length / 1365)} KB），重开会话可看原图`;
          img.replaceWith(note);
        }
        images += el.querySelectorAll('img').length;
      }
    }
    const group = createHistoryGroup({ scrollRoot: this.scrollRoot, parkOffscreen: true });
    group.setSummary(formatHistoryGroupSummary({
      startTurn: turn.id,
      endTurn: turn.id,
      turnCount: 1,
      toolCalls,
      artifacts: images,
      preview: `${turn.userText}（回合前段）`,
    }));
    this.root().insertBefore(group.el, host);
    group.adopt(fold);
    this.groups.push(group);
    // 折后立即泊车：组在钉底视图的上方（视口外），先挂后泊的展开闪烁没有
    // 观众。2026-11-19 二次修正：曾因 WKWebView「已画行向上滚回变空白」
    // 改为流式期禁泊车，但用户快速上翻仍卡死——真凶是挂载 DOM 全量常驻
    // （折叠只挪账不减重量）。剥图（上方）+asset src+lazy 之后，泊车/重挂
    // 载的重 paint 源（base64 巨串与位图解码）已消失，纯文本挂载与恢复路
    // 径同形状（实测安全），泊车回归。
    group.park();
    // 权重按余下节点精确重算：增量估算的累计误差在这里归零。
    this.activeWeightBytes = keep.reduce((sum, n) => sum + estimateNodeBytes(n), 0);
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

/** 估算一个节点（子树）的渲染体量：文本按 2 字节/字符（CJK 主场），图片按
 *  src 全长（read_file 截图内嵌的 data: URL 是直播 DOM 里最重的一项）。只
 *  对新增子树调用——全程 O(内容总量)，不做全树重扫。 */
function estimateNodeBytes(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent?.length ?? 0) * 2;
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  const el = node as Element;
  let bytes = (el.textContent?.length ?? 0) * 2;
  if (el.tagName === 'IMG') bytes += el.getAttribute('src')?.length ?? 0;
  for (const img of el.querySelectorAll('img')) {
    bytes += img.getAttribute('src')?.length ?? 0;
  }
  return bytes;
}
