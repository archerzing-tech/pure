// src/ui/parallelTaskCards.ts
// Roadmap 4.3 — the parallel-task dock: ONE card per background session that
// is still streaming, with independent spinner / title / workspace / live
// elapsed / queue chip. This is the visualization for the per-worktree lanes
// (4.2): without it, a background session's only trace was a sidebar dot.
//
// The dock deliberately shows only sessions that are NOT the visible one —
// the current conversation's state is already in the composer (stop button,
// spinner); duplicating it would be noise. Cards appear the moment a session
// starts streaming in the background and disappear when it settles.
//
// Interaction contract per card: click anywhere → switch to that session;
// the stop button → queue.cancelForSession (in-flight turn + its pending
// tasks — stopping only the turn would let the next queued task fire
// immediately, which reads as "stop did nothing").
//
// Reuses the subagent activity card experience (roadmap wording): pure HTML
// rendering separated from the live wiring, tabular-nums elapsed ticker,
// state-driven cards that never carry per-session behavior across.

import { escapeHtml } from '../shared/html';
import { t } from '../shared/i18n';
import { workspaceBase } from '../shared/paths';

export interface ParallelTask {
  sessionId: string;
  /** Display title — session title when the disk row exists, else the
   * workspace basename (a first-turn session has no persisted row yet). */
  title: string;
  workspace: string;
  /** Epoch ms when this session's current run started (per-run, not cumulative). */
  startedAt: number;
  queuedTasks: number;
}

export interface ParallelTasksState {
  tasks: ParallelTask[];
  now: number;
}

/** The dock's population rule: running sessions minus the visible one.
 * Exported + tested because "3 parallel sessions and none of them bleed into
 * the current view" is the roadmap's acceptance criterion. */
export function visibleParallelSessions(runningIds: readonly string[], currentSessionId: string | undefined): string[] {
  return runningIds.filter((id) => id && id !== currentSessionId);
}

/** Compact live elapsed: 42s → 3m05s → 1h12m. Tabular rendering matches the
 * tool-row elapsed convention. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function renderParallelTasks(state: ParallelTasksState): string {
  if (state.tasks.length === 0) return '';
  const cards = state.tasks.map((task) => {
    const elapsed = formatElapsed(state.now - task.startedAt);
    const queueChip = task.queuedTasks > 0
      ? `<span class="parallel-card-queue" title="${escapeHtml(t('parallel.queuedTitle'))}">${escapeHtml(t('parallel.queued').replace('{n}', String(task.queuedTasks)))}</span>`
      : '';
    return `
      <div class="parallel-card" role="button" tabindex="0" data-session-id="${escapeHtml(task.sessionId)}" title="${escapeHtml(t('parallel.jump.title'))}">
        <span class="parallel-card-spinner" aria-hidden="true"></span>
        <span class="parallel-card-body">
          <span class="parallel-card-title">${escapeHtml(task.title)}</span>
          <span class="parallel-card-meta">
            <span class="parallel-card-workspace">${escapeHtml(task.workspace ? workspaceBase(task.workspace) : '')}</span>
            <span class="parallel-card-elapsed">${escapeHtml(elapsed)}</span>
            ${queueChip}
          </span>
        </span>
        <button class="parallel-card-stop" data-stop-session="${escapeHtml(task.sessionId)}" title="${escapeHtml(t('parallel.stop.title'))}" aria-label="${escapeHtml(t('parallel.stop.title'))}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
        </button>
      </div>`;
  });
  return `
    <div class="parallel-dock-label">${escapeHtml(t('parallel.title'))}</div>
    <div class="parallel-dock-cards">${cards.join('')}</div>`;
}

/** Live wiring over the pure renderer. The 1s tick keeps elapsed honest and
 * doubles as a safety net for missed events; set changes re-render, steady
 * state updates only the elapsed spans (keeps hover states alive). */
export class ParallelTaskCards {
  private readonly chat: ParallelTaskCardsDeps['chat'];
  private readonly queue: ParallelTaskCardsDeps['queue'];
  private readonly listTitles: ParallelTaskCardsDeps['listTitles'];
  private host: HTMLElement;
  private startedAt = new Map<string, number>();
  private titleCache = new Map<string, { title: string; workspace: string }>();
  private lastRenderedKey = '';
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ParallelTaskCardsDeps) {
    this.chat = deps.chat;
    this.queue = deps.queue;
    this.listTitles = deps.listTitles;
    this.host = deps.host;
    this.ticker = setInterval(() => void this.refresh(), 1000);
    void this.refresh();
  }

  /** Stop the ticker (app teardown / tests). */
  dispose(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
  }

  async refresh(): Promise<void> {
    const currentSessionId = this.currentSessionId();
    const running = visibleParallelSessions(this.chat.runningIds(), currentSessionId);
    // Elapsed anchors: a run's clock starts when the dock first sees it; the
    // clock resets when the run ends (session leaves the set) — per-run, not
    // cumulative across restarts.
    for (const id of running) {
      if (!this.startedAt.has(id)) this.startedAt.set(id, Date.now());
    }
    for (const id of [...this.startedAt.keys()]) {
      if (!running.includes(id)) this.startedAt.delete(id);
    }
    if (running.length === 0) {
      this.lastRenderedKey = '';
      if (this.host.innerHTML !== '') this.render([], 0);
      return;
    }
    await this.warmTitleCache(running);
    const now = Date.now();
    const tasks = running.map((sessionId) => {
      const cached = this.titleCache.get(sessionId);
      const workspace = cached?.workspace || this.chat.workspaceOf(sessionId) || '';
      return {
        sessionId,
        title: cached?.title || workspaceBase(workspace) || `…${sessionId.slice(-4)}`,
        workspace,
        startedAt: this.startedAt.get(sessionId) ?? now,
        queuedTasks: this.queue.pendingCountFor(sessionId),
      } satisfies ParallelTask;
    });
    // Re-render only when the card SET or its chips changed; a steady run
    // updates elapsed text in place below.
    const key = JSON.stringify(tasks.map(({ sessionId, queuedTasks }) => [sessionId, queuedTasks]));
    if (key !== this.lastRenderedKey) {
      this.lastRenderedKey = key;
      this.render(tasks, now);
      return;
    }
    for (const task of tasks) {
      this.host.querySelector<HTMLElement>(`.parallel-card[data-session-id="${CSS.escape(task.sessionId)}"] .parallel-card-elapsed`)
        ?.replaceChildren(formatElapsed(now - task.startedAt));
    }
  }

  private render(tasks: ParallelTask[], now: number): void {
    this.host.innerHTML = renderParallelTasks({ tasks, now });
    this.host.hidden = tasks.length === 0;
  }

  private currentSessionId(): string | undefined {
    try {
      return this.chat.currentId() || undefined;
    } catch {
      return undefined;
    }
  }

  private async warmTitleCache(sessionIds: readonly string[]): Promise<void> {
    const missing = sessionIds.filter((id) => !this.titleCache.has(id));
    if (missing.length === 0) return;
    try {
      const rows = await this.listTitles();
      for (const row of rows) {
        this.titleCache.set(row.id, { title: row.title, workspace: row.workspace });
      }
      for (const id of missing) {
        if (!this.titleCache.has(id)) {
          // No disk row (first turn) — cache the live workspace so the card
          // still names itself after its project.
          const workspace = this.chat.workspaceOf(id) || '';
          this.titleCache.set(id, { title: '', workspace });
        }
      }
    } catch {
      // Metadata read failed — cards fall back to workspace basenames.
    }
  }
}

export interface ParallelTaskCardsDeps {
  host: HTMLElement;
  /** Narrow facade over SessionChatManager — keeps this module testable. */
  chat: {
    currentId(): string;
    runningIds(): string[];
    workspaceOf(sessionId: string): string;
    jumpTo(sessionId: string): void;
  };
  queue: {
    pendingCountFor(sessionId: string): number;
    cancelForSession(sessionId: string): void;
  };
  /** Session metadata rows (id/title/workspace) for title resolution. */
  listTitles(): Promise<Array<{ id: string; title: string; workspace: string }>>;
}

/** DOM event wiring: card click → jump, stop button → cancel that session.
 * Bound once by the app shell. */
export function bindParallelTaskCards(host: HTMLElement, deps: ParallelTaskCardsDeps): void {
  host.addEventListener('click', (event) => {
    const stop = (event.target as HTMLElement).closest<HTMLElement>('[data-stop-session]');
    if (stop) {
      event.stopPropagation();
      deps.queue.cancelForSession(stop.dataset.stopSession!);
      return;
    }
    const card = (event.target as HTMLElement).closest<HTMLElement>('.parallel-card[data-session-id]');
    if (card) deps.chat.jumpTo(card.dataset.sessionId!);
  });
}
