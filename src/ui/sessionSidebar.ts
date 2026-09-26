// src/ui/sessionSidebar.ts
// Session sidebar controller: renders the session list (grouped by workspace),
// handles group collapse persistence, session switching, single-session
// deletion and the delete-all action. Extracted from main.ts so the app shell stays a
// thin wiring layer. The chat transcript itself is rendered by main.ts via the
// renderMessages dependency.

import { escapeHtml } from '../shared/html';
import { t } from '../shared/i18n';
import { showToast } from '../shared/toast';
import { isTauriRuntime } from '../shared/tauri';
import { workspaceBase } from '../shared/paths';
import { relativeTime } from '../shared/format';
import { copyTextToClipboard } from '../shared/clipboard';
import { estimateCostUsd, formatCostUsd, formatTokensCompact } from '../shared/usage';
import {
  deleteAllSessions,
  deleteSession,
  loadSessionList,
  loadSessionStatsForList,
  type LoadedSession,
  type SessionMeta,
  type SessionStats,
  type SessionSnapshotV2,
} from './store';
import { isSessionRunning, type ChatController } from './chat';

export interface SessionSidebarDeps {
  chat: Pick<ChatController, 'clear' | 'setWorkspace' | 'syncEffectiveWorkspace'> & {
    /** Make a session the visible conversation, reusing its live controller
     * when already open. Returns whether it was already running (warm). */
    openSession(sessionId: string): { controller: ChatController; host: HTMLElement; warm: boolean };
    /** Stop + drop a live controller (session deleted). */
    forgetSession(sessionId: string): void;
    /** Stop + drop every live controller (delete-all). */
    clearAll(): void;
    /** Live controllers of sessions streaming right now, including ones with
     * nothing on disk yet — merged into the list so background work shows up
     * with its running dot instead of being invisible until first persist. */
    getRunningLiveSessions(): Array<{ id: string; title: string; workspace: string }>;
    /** Whether this app instance still holds a live controller for the id. */
    hasOpenSession(sessionId: string): boolean;
  };
  pasteChips: { clear(): void };
  confirm(message: string): Promise<boolean>;
  /** Disk read for one session (null when it has no archive). Injected so the
   * load() flow is drivable without the Tauri bridge. */
  loadSession(sessionId: string): Promise<LoadedSession | null>;
  /** Roadmap 4.4 retention notice: when the session's workspace is one of the
   * auto-created worktrees (4.1) with unmerged work, return the delete
   * confirmation text that says the worktree SURVIVES the delete (and where).
   * Null/absent → the plain delete confirm. Deleting a session never deletes
   * its worktree — retention is the default, this only makes it visible. */
  retentionNotice?(sessionId: string): Promise<string | null>;
  /** T2 (team observability): when the session's archive holds role
   *  delegations, return a line for the delete confirm saying the harvestable
   *  samples will be gone. Null/absent → no extra line; deletion is never
   *  blocked. */
  delegationNotice?(sessionId: string): Promise<string | null>;
  /** Render a loaded session's transcript into its session host (main.ts owns
   * the chat DOM). Called only for COLD sessions — warm sessions already have
   * their live transcript mounted. */
  renderMessages(snapshot: SessionSnapshotV2, host: HTMLElement): Promise<void>;
  /** Present a conversation with content: make sure the chat view is actually
   * visible (exit the landing screen — it hides the whole transcript column
   * via #chat-view.landing #chat) and move keyboard focus into the composer.
   * Blank sessions go through onChatCleared instead and keep landing. */
  focusPrompt(): void;
  /** Show the chat-area loading overlay while a session restores (main.ts). */
  showSessionLoading(): void;
  /** After a session was activated — its workspace may have changed. */
  onSessionActivated(): void;
  /** After the active session was cleared/deleted — back to landing. Also
   * fired when a click ENTERS an empty session: a blank conversation's
   * natural view IS the landing screen, and the landing focus is what makes
   * the switch visible (see presentSession). */
  onChatCleared(): void;
}

const COLLAPSED_GROUPS_KEY = 'pure_collapsed_groups';

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

function saveCollapsedGroups(groups: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...groups]));
  } catch { /* ignore */ }
}

/** Session ids embed their creation time (`session_<ms>_<seq>`); live-only
 * sidebar entries have no SessionMeta on disk, so recover the timestamp from
 * the id itself for createdAt display/sorting. */
function sessionIdCreatedAt(id: string): number {
  const m = id.match(/^session_(\d+)_/);
  return m ? Number(m[1]) : Date.now();
}

/** Stable short fingerprint of a session id for the card's id chip: the full
 * `session_<ms>_<seq>` is too long to show, so each card carries a derived
 * base36 hash instead — deterministic across renders (seeded, order-free),
 * full id stays one hover away in the tooltip, one click copies it. */
function shortSessionSeed(id: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(6, '0').slice(0, 6);
}

/** Assign the visible batch collision-free short ids: on the (astronomically
 * unlikely) hash clash, re-derive with the next seed — deterministic because
 * it depends only on the id set, not on render order. */
export function assignShortIds(ids: string[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const id of ids) {
    let seed = 5381;
    let s = shortSessionSeed(id, seed);
    while (used.has(s) && seed < 5381 + 16) {
      seed += 1;
      s = shortSessionSeed(id, seed);
    }
    used.add(s);
    out.set(id, s);
  }
  return out;
}

/** Open a NEW pure app window (Tauri WebviewWindow; browser fallback = new
 *  tab). Each window is a full, independent pure app — its own JS context,
 *  free to start new chats and open any session. `sessionId` merely preloads
 *  that conversation in the new window. */
export async function openPureWindow(sessionId?: string): Promise<void> {
  if (!isTauriRuntime()) {
    window.open(`${location.pathname}${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`, '_blank');
    return;
  }
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const label = `pure_${sessionId ?? 'app'}_${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_-]/g, '_');
    new WebviewWindow(label, {
      url: `index.html${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`,
      title: 'pure',
      width: 1280,
      height: 860,
    });
  } catch (err) {
    console.error('[pure] open window failed:', err);
    showToast(t('toast.deleteFailed'));
  }
}

export class SessionSidebar {
  private deps: SessionSidebarDeps;
  private currentActiveId: string | null = null;
  private collapsedGroups = loadCollapsedGroups();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private idleRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private idleRefreshHandle: number | undefined;
  /**
   * Monotonic load-request counter. Rapid clicks on two sessions start two
   * overlapping loads; without a guard the FIRST disk read to complete wins
   * even when the user's LAST click is still pending — the transcript ends up
   * showing the wrong session. Every in-flight load checks its captured
   * sequence against this counter after each await and bails out when a newer
   * click superseded it.
   */
  private loadSequence = 0;

  constructor(deps: SessionSidebarDeps) {
    this.deps = deps;
  }

  setActive(id: string | null): void {
    this.currentActiveId = id;
    document.querySelectorAll('.sidebar-session-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-sid') === id);
    });
  }

  /**
   * Coalesce rapid sidebar rebuilds into a single one: doSend's finally fires
   * after EVERY send (and flushQueued can send several queued messages back
   * to back), each triggering a full innerHTML rebuild + a loadSessionList
   * disk read. Debouncing collapses those bursts into one refresh with no
   * visible lag.
   */
  refresh(): void {
    if (this.idleRefreshHandle !== undefined) {
      const browserWindow = window as typeof window & { cancelIdleCallback?: (id: number) => void };
      browserWindow.cancelIdleCallback?.(this.idleRefreshHandle);
      this.idleRefreshHandle = undefined;
    }
    if (this.idleRefreshTimer) {
      clearTimeout(this.idleRefreshTimer);
      this.idleRefreshTimer = undefined;
    }
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.renderList();
    }, 150);
  }

  /**
   * Refresh after a low-priority metadata change without competing with the
   * interaction that caused it. Workspace selection already updates the
   * visible workspace immediately; rebuilding the whole grouped sidebar can
   * involve IPC and stats reads, so defer that work until the WebView is idle.
   */
  refreshIdle(): void {
    if (this.refreshTimer || this.idleRefreshTimer || this.idleRefreshHandle !== undefined) return;
    const browserWindow = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };
    if (browserWindow.requestIdleCallback) {
      this.idleRefreshHandle = browserWindow.requestIdleCallback(() => {
        this.idleRefreshHandle = undefined;
        this.refresh();
      }, { timeout: 1200 });
      return;
    }
    this.idleRefreshTimer = setTimeout(() => {
      this.idleRefreshTimer = undefined;
      this.refresh();
    }, 700);
  }

  /** Load a session's transcript and switch the active state to it.
   *
   * Switching NEVER cancels the previously visible session: if it was still
   * running it keeps executing in the background and re-attaches exactly where
   * it was (mid-task, streaming, or already finished) when the user returns. A
   * session that is ALREADY OPEN in this app instance (warm) is simply
   * re-shown with its live state; only a never-opened (cold) session is
   * rebuilt from its stored snapshot. */
  async load(id: string): Promise<void> {
    const seq = ++this.loadSequence;
    const loaded = await this.deps.loadSession(id);
    // Live-only fallback: the session streams but has no disk snapshot yet
    // (first turn still running). The controller owns the whole transcript in
    // memory — re-show it warm instead of silently dropping the click.
    if (!loaded && this.deps.chat.hasOpenSession(id)) {
      if (this.isLoadStale(seq)) return;
      const opened = this.deps.chat.openSession(id);
      if (this.isLoadStale(seq)) return;
      this.presentSession(opened, id);
      return;
    }
    // A newer load request superseded this one (rapid session clicking): the
    // latest click owns the transcript — drop this stale result entirely,
    // including its tail effects (render / focus).
    if (this.isLoadStale(seq)) return;
    if (!loaded) {
      // Neither a disk archive nor a live controller: a stale card (deleted
      // from another window, swept by the empty-session prune). Re-render so
      // the dead entry leaves the list instead of sitting there as a click
      // that does nothing.
      this.refresh();
      return;
    }
    if (loaded.snapshot.modelContext.messages.length === 0) {
      // Empty-content session (a "New chat" card): with multiple sessions it
      // is a real card in the list, and clicking it must ENTER it. The old
      // silent return predates multi-session — back then the only empty
      // transcript was the one already on screen, so "nothing to load" was
      // true; now it reads as a dead card (2026-09-26 用户反馈).
      const opened = this.deps.chat.openSession(id);
      if (this.isLoadStale(seq)) return;
      this.presentSession(opened, id, loaded.workspace || '');
      return;
    }
    const opened = this.deps.chat.openSession(id);
    if (this.isLoadStale(seq)) return;
    this.deps.pasteChips.clear();
    if (opened.warm) {
      // The session's own live controller is still running exactly as the user
      // left it — no disk rebuild, no interruption. Its workspace/state are
      // the authoritative in-memory ones. The ONE exception: a cold restore
      // that was superseded mid-render left the host 'pending' (partial
      // content, no completion) — rebuild it from disk like a cold session so
      // returning shows the full transcript, not a half-rendered column.
      if (opened.host.dataset.restored === 'pending') {
        // fall through to the cold rebuild path below
      } else {
        if (this.isLoadStale(seq)) return;
        this.setActive(id);
        this.deps.onSessionActivated();
        this.deps.focusPrompt();
        return;
      }
    }
    // Cold session: restore this session's own workspace ('' = none) —
    // sessions are independent, so there is no global-default fallback. Set it
    // BEFORE rendering so clickable relative paths in the transcript resolve
    // against the restored workspace.
    // The loading overlay shows the moment the session card is clicked —
    // feedback before the disk read and bubble-by-bubble render complete.
    this.deps.showSessionLoading();
    this.deps.chat.setWorkspace(loaded.workspace || '');
    await this.deps.chat.syncEffectiveWorkspace();
    // A newer click may have landed while we resolved the workspace — its
    // load owns the transcript from here on.
    if (this.isLoadStale(seq)) return;
    await this.deps.renderMessages(loaded.snapshot, opened.host);
    if (this.isLoadStale(seq)) return;
    this.setActive(id);
    this.deps.onSessionActivated();
    this.deps.focusPrompt();
  }

  /** True when a load captured at `seq` has been superseded by a newer click. */
  private isLoadStale(seq: number): boolean {
    return seq !== this.loadSequence;
  }

  /** Make an opened session the visible one and PRESENT it. An empty
   * conversation's natural view is the landing screen — focus goes to the
   * landing input, which also gives the click a visible effect when the user
   * was already on landing (otherwise switching to a blank card shows no
   * change at all and reads as "切不进去", 2026-09-26 用户反馈). A live
   * session with in-flight content keeps its transcript + composer focus.
   * `restoreWorkspace` re-applies a cold session's stored workspace (live
   * controllers own theirs in memory). */
  private presentSession(
    opened: { controller: ChatController; host: HTMLElement; warm: boolean },
    id: string,
    restoreWorkspace?: string,
  ): void {
    if (!opened.warm && restoreWorkspace !== undefined) this.deps.chat.setWorkspace(restoreWorkspace);
    this.deps.pasteChips.clear();
    this.setActive(id);
    this.deps.onSessionActivated();
    // 空白判定必须是「无消息且没在跑」：send() 里用户消息要等引擎交接才进
    // modelContext，预检窗口内 getMessages() 为空但回合已经在跑——只看消息
    // 会把正在进行的回合误判成空白卡，切回来被 landing 盖掉转写（2026-09-26
    // 用户反馈「切回正在运行的会话显示不出来」）。
    if (opened.controller.getMessages().length === 0 && !opened.controller.isStreaming()) this.deps.onChatCleared();
    else this.deps.focusPrompt();
  }

  // ── Session list rendering ──

  /** Cheap in-place refresh of the running dots (streaming state changed):
   * toggles the dot per visible card without re-rendering the list, so an
   * active background session starting/stopping never disturbs scroll or
   * focus in the sidebar. */
  refreshRunningDots(): void {
    const container = document.getElementById('sidebar-session-list');
    if (!container) return;
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('.sidebar-session-item'))) {
      const sid = el.getAttribute('data-sid') ?? '';
      const running = isSessionRunning(sid);
      el.classList.toggle('session-running', running);
      const existing = el.querySelector('.sidebar-session-running-dot');
      if (running && !existing) {
        // The dot lives in the title row (same line as the title), not on the
        // card body — fall back to main for any pre-restructure DOM.
        (el.querySelector('.sidebar-session-item-top') ?? el.querySelector('.sidebar-session-item-main'))?.insertAdjacentHTML(
          'afterbegin',
          `<span class="sidebar-session-running-dot" role="status" aria-label="${escapeHtml(t('sidebar.running'))}" title="${escapeHtml(t('sidebar.running'))}"></span>`,
        );
      } else if (!running && existing) {
        existing.remove();
      }
    }
  }

  private async renderList(): Promise<void> {
    const container = document.getElementById('sidebar-session-list')!;
    try {
      const list = await loadSessionList();
      // Sessions streaming in the background merge ON TOP of the disk list: a
      // first turn that is still running has never been persisted, so without
      // this the conversation the user just started vanishes from the sidebar
      // the moment they switch away — no entry, no running dot.
      const persisted = new Set((list ?? []).map(s => s.id));
      const live = this.deps.chat
        .getRunningLiveSessions()
        .filter(s => !persisted.has(s.id))
        .map(s => ({
          id: s.id,
          title: s.title,
          createdAt: sessionIdCreatedAt(s.id),
          updatedAt: Date.now(),
          messageCount: 0,
          workspace: s.workspace || undefined,
        }));
      if ((!list || list.length === 0) && live.length === 0) {
        container.innerHTML = `<div class="sidebar-session-empty">${t('sidebar.noSessions')}</div>`;
        return;
      }

      const sorted = [...(list ?? []), ...live].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
      // Card id chips: collision-free within the visible batch (the list is
      // sorted last-updated first, so the batch — and thus the assignment —
      // is deterministic).
      const shortIds = assignShortIds(sorted.map(s => s.id));

      // Per-session token/cost summary line: bulk-load stats for every visible
      // row (one IPC round-trip) and show a compact `1.2k · $0.01` line under
      // the title. Sessions without usage data simply omit the line.
      const statsMap = await loadSessionStatsForList(sorted.map(s => s.id));
      const usageLine = (s: SessionMeta): string => {
        const stats: SessionStats | undefined = statsMap.get(s.id);
        if (!stats?.usage) return '';
        const total =
          (stats.usage.promptTokens ?? 0) + (stats.usage.completionTokens ?? 0);
        const cost = estimateCostUsd(stats.usage, stats.provider ?? 'deepseek-openai');
        const line = `${formatTokensCompact(total)} tok · ${formatCostUsd(cost)}`;
        return `<span class="sidebar-session-item-usage">${line}</span>`;
      };

      // Group sessions by their workspace (Claude Desktop style project
      // grouping): a sticky folder header per workspace, sessions beneath it.
      const groups = new Map<string, SessionMeta[]>();
      for (const s of sorted) {
        const key = s.workspace || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(s);
      }

      container.innerHTML = [...groups.entries()].map(([ws, sessions]) => {
        const key = ws || '';
        const collapsed = this.collapsedGroups.has(key);
        const chevron = `<svg class="group-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;
        const label = ws
          ? `<button class="sidebar-session-group-label" data-group="${escapeHtml(key)}" title="${escapeHtml(ws)}" aria-expanded="${collapsed ? 'false' : 'true'}">
               ${chevron}
               <svg class="wp-folder-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
               <span class="group-name">${escapeHtml(workspaceBase(ws))}</span>
             </button>`
          : `<button class="sidebar-session-group-label" data-group="" aria-expanded="${collapsed ? 'false' : 'true'}">
               ${chevron}
               <span class="group-name">${t('workspace.none')}</span>
             </button>`;
        const items = sessions.map(s => {
          const title = escapeHtml(s.title.slice(0, 50));
          // A pulsing dot marks sessions whose controller is still streaming —
          // including background sessions the user has navigated away from.
          const dot = isSessionRunning(s.id)
            ? `<span class="sidebar-session-running-dot" role="status" aria-label="${escapeHtml(t('sidebar.running'))}" title="${escapeHtml(t('sidebar.running'))}"></span>`
            : '';
          // Card meta row: unique id chip (click copies the full id) + the
          // last-updated time, which also makes the updatedAt sort legible.
          const when = escapeHtml(relativeTime(s.updatedAt, Date.now()));
          return `<div class="sidebar-session-item${dot ? ' session-running' : ''}" data-sid="${s.id}">
          <div class="sidebar-session-item-main">
            <div class="sidebar-session-item-top">${dot}<span class="sidebar-session-item-title" title="${title}">${title}</span></div>
            <div class="sidebar-session-item-meta">
              <button class="sidebar-session-item-id" data-copy-id="${escapeHtml(s.id)}" title="${escapeHtml(s.id)}">#${shortIds.get(s.id) ?? '??????'}</button>
              <span class="sidebar-session-item-time" title="${escapeHtml(new Date(s.updatedAt).toLocaleString())}">${when}</span>
              ${usageLine(s)}
            </div>
          </div>
          <button class="sidebar-session-delete" data-sid="${s.id}" title="${t('sidebar.delete.title')}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>`;
        }).join('');
        return `<div class="sidebar-session-group${collapsed ? ' collapsed' : ''}">${label}<div class="sidebar-session-group-items">${items}</div></div>`;
      }).join('');

      // Restore active state
      this.setActive(this.currentActiveId);

      // Toggle group collapse on header click
      container.querySelectorAll('.sidebar-session-group-label').forEach(el => {
        el.addEventListener('click', () => {
          const group = el.closest('.sidebar-session-group') as HTMLElement | null;
          if (!group) return;
          // The header button carries the same data-group as the one used to
          // render the group — read it directly from the clicked element.
          const key = el.getAttribute('data-group') || '';
          this.toggleGroupCollapsed(key);
          const nowCollapsed = this.collapsedGroups.has(key);
          group.classList.toggle('collapsed', nowCollapsed);
          el.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        });
      });

      // Click session → load it
      container.querySelectorAll('.sidebar-session-item').forEach(el => {
        el.addEventListener('click', (e) => {
          const sid = el.getAttribute('data-sid');
          if (sid && !(e.target as HTMLElement).closest('.sidebar-session-delete') && !(e.target as HTMLElement).closest('.sidebar-session-item-id') && !(e.target as HTMLElement).closest('.sidebar-session-open-window')) {
            void this.load(sid);
          }
        });
      });

      // Click the id chip → copy the FULL session id (the visible `#xxxxxx`
      // is just the display fingerprint; the tooltip/copy carry the real one).
      container.querySelectorAll<HTMLButtonElement>('.sidebar-session-item-id').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          void copyTextToClipboard(btn.dataset.copyId ?? '').then((ok) => {
            if (ok) showToast(t('paste.copied'));
          });
        });
      });

      // Delete session
      container.querySelectorAll('.sidebar-session-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const sid = btn.getAttribute('data-sid');
          if (!sid) return;
          // 4.4: a worktree-bound session with unmerged work gets the
          // retention wording — delete removes the session, not its worktree.
          const retention = this.deps.retentionNotice ? await this.deps.retentionNotice(sid) : null;
          // T2: a session with role-delegation archives loses its harvestable
          // samples on delete — say so instead of deleting silently.
          const delegationNotice = this.deps.delegationNotice ? await this.deps.delegationNotice(sid) : null;
          const message = [retention, delegationNotice].filter(Boolean).join('\n') || t('confirm.deleteSession');
          if (!(await this.deps.confirm(message))) return;
          // Tear the controller down BEFORE the disk delete: a background run
          // between the two steps would re-persist the session the user just
          // deleted, and a live-only entry (never persisted, sidebar-merged)
          // deletes cleanly even though it has no file to remove.
          if (this.currentActiveId === sid) {
            // Deleting the visible session: clear() cancels its run (explicit
            // user intent) and opens a fresh blank session on landing — 与点
            // 「新建对话」同一终点（2026-09-26 用户定调），焦点由主侧的
            // onChatCleared 落进 landing 输入框。
            this.resetToLanding();
          } else {
            this.deps.chat.forgetSession(sid);
          }
          try {
            await deleteSession(sid);
          } catch (err) {
            console.error('[pure] deleteSession failed:', err);
            showToast(t('toast.deleteFailed'));
            return;
          }
          this.refresh();
        });
      });
    } catch {
      container.innerHTML = `<div class="sidebar-session-empty">${t('session.loadError')}</div>`;
    }
  }

  private toggleGroupCollapsed(key: string): void {
    if (this.collapsedGroups.has(key)) {
      this.collapsedGroups.delete(key);
    } else {
      this.collapsedGroups.add(key);
    }
    saveCollapsedGroups(this.collapsedGroups);
  }

  /** Clear the active session state and bounce the UI back to landing. */
  private resetToLanding(): void {
    this.deps.chat.clear();
    this.deps.chat.setWorkspace('');
    this.setActive(null);
    this.deps.onChatCleared();
  }

  // ── Sidebar: delete all sessions ──

  private async clearAllSessions(): Promise<void> {
    if (!(await this.deps.confirm(t('confirm.deleteAllSessions')))) return;
    try {
      await deleteAllSessions();
    } catch (err) {
      console.error('[pure] deleteAllSessions failed:', err);
      showToast(t('toast.deleteFailed'));
      return;
    }
    // Stop every live background controller so no deleted session keeps
    // running or re-persisting after the disk wipe.
    this.deps.chat.clearAll();
    this.resetToLanding();
    this.refresh();
    showToast(t('toast.sessionsCleared'));
  }

  // ── Init: bind the sidebar session list + delete-all events ──

  init(): void {
    document.getElementById('sidebar-sessions-clear')?.addEventListener('click', () => {
      void this.clearAllSessions();
    });
  }
}
