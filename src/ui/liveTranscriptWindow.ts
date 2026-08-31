export interface LiveTurnHandle {
  id: number;
  host: HTMLElement;
  userText: string;
  completed: boolean;
  parked: Node[];
}

export interface LiveTranscriptWindowOptions {
  maxMountedTurns?: number;
}

const DEFAULT_MAX_MOUNTED_TURNS = 8;

export function summarizeLiveTurn(userText: string, turnNumber: number): string {
  const preview = userText.trim().replace(/\s+/g, ' ');
  const short = preview.length > 72 ? `${preview.slice(0, 72)}…` : preview;
  return `第 ${turnNumber} 轮 · ${short || '无文本请求'}`;
}

export class LiveTranscriptWindow {
  private readonly maxMountedTurns: number;
  private readonly turns: LiveTurnHandle[] = [];
  private nextTurnId = 1;

  constructor(options: LiveTranscriptWindowOptions = {}) {
    this.maxMountedTurns = Math.max(1, Math.floor(options.maxMountedTurns ?? DEFAULT_MAX_MOUNTED_TURNS));
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
    document.getElementById('chat')?.appendChild(host);
    const turn: LiveTurnHandle = {
      id: this.nextTurnId++,
      host,
      userText,
      completed: false,
      parked: [],
    };
    this.turns.push(turn);
    this.archiveOldTurns();
    return turn;
  }

  finishTurn(turn: LiveTurnHandle): void {
    if (!this.turns.includes(turn)) return;
    turn.completed = true;
    turn.host.dataset.turnState = 'complete';
    this.archiveOldTurns();
  }

  reset(): void {
    this.turns.length = 0;
    this.nextTurnId = 1;
  }

  getMountedTurnCount(): number {
    return this.turns.filter(turn => turn.host.dataset.turnState !== 'archived').length;
  }

  getArchivedTurnCount(): number {
    return this.turns.filter(turn => turn.host.dataset.turnState === 'archived').length;
  }

  moveNodeToTurn(node: Node, target: LiveTurnHandle): boolean {
    if (!this.turns.includes(target)) return false;
    for (const turn of this.turns) {
      if (turn === target) continue;
      const parkedIndex = turn.parked.indexOf(node);
      if (parkedIndex >= 0) {
        turn.parked.splice(parkedIndex, 1);
        target.host.appendChild(node);
        return true;
      }
      if (turn.host.contains(node)) {
        node.parentNode?.removeChild(node);
        target.host.appendChild(node);
        return true;
      }
    }
    const chat = document.getElementById('chat');
    if (chat && node.parentNode === chat) {
      chat.removeChild(node);
      target.host.appendChild(node);
      return true;
    }
    return false;
  }

  private archiveOldTurns(): void {
    const mountedCompleted = this.turns.filter(turn => turn.completed && turn.host.dataset.turnState !== 'archived');
    const hasActiveTurn = this.turns.at(-1)?.completed === false;
    const keepCount = Math.max(0, this.maxMountedTurns - (hasActiveTurn ? 1 : 0));
    const keep = new Set(keepCount > 0 ? mountedCompleted.slice(-keepCount) : []);
    for (const turn of mountedCompleted) {
      if (keep.has(turn)) continue;
      this.archive(turn);
    }
  }

  private archive(turn: LiveTurnHandle): void {
    const host = turn.host;
    const parked: Node[] = [];
    while (host.firstChild) parked.push(host.removeChild(host.firstChild));
    turn.parked = parked;

    const details = document.createElement('details');
    details.className = 'live-turn-archive';
    const summary = document.createElement('summary');
    summary.className = 'live-turn-archive-summary';
    summary.textContent = summarizeLiveTurn(turn.userText, turn.id);
    const body = document.createElement('div');
    body.className = 'live-turn-archive-body';
    details.append(summary, body);
    host.classList.add('archived');
    host.dataset.turnState = 'archived';
    host.appendChild(details);

    details.addEventListener('toggle', () => {
      if (details.open) {
        while (turn.parked.length > 0) body.appendChild(turn.parked.shift()!);
      } else {
        while (body.firstChild) turn.parked.push(body.removeChild(body.firstChild));
      }
    });
  }
}
