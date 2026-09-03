// src/ui/sessionSidebar.ts
// Session sidebar controller: renders the session list (grouped by workspace),
// handles group collapse persistence, session switching, single-session
// deletion and the delete-all action. Extracted from main.ts so the app shell stays a
// thin wiring layer. The chat transcript itself is rendered by main.ts via the
// renderMessages dependency.

import { escapeHtml } from '../shared/html';
import { t } from '../shared/i18n';
import { showToast } from '../shared/toast';
import { workspaceBase } from '../shared/paths';
import { estimateCostUsd, formatCostUsd, formatTokensCompact } from '../shared/usage';
import {
  deleteAllSessions,
  deleteSession,
  loadSession,
  loadSessionList,
  loadSessionStatsForList,
  type SessionMeta,
  type SessionStats,
  type SessionSnapshotV2,
} from './store';
import type { ChatController } from './chat';

export interface SessionSidebarDeps {
  chat: Pick<ChatController, 'clear' | 'setWorkspace' | 'syncEffectiveWorkspace'> & {
    /** Make a session the visible conversation, reusing its live controller
     * when already open. Returns whether it was already running (warm). */
    openSession(sessionId: string): { controller: ChatController; host: HTMLElement; warm: boolean };
    /** Stop + drop a live controller (session deleted). */
    forgetSession(sessionId: string): void;
    /** Stop + drop every live controller (delete-all). */
    clearAll(): void;
  };
  pasteChips: { clear(): void };
  confirm(message: string): Promise<boolean>;
  /** Render a loaded session's transcript into its session host (main.ts owns
   * the chat DOM). Called only for COLD sessions — warm sessions already have
   * their live transcript mounted. */
  renderMessages(snapshot: SessionSnapshotV2, host: HTMLElement): Promise<void>;
  /** Move keyboard focus into the composer (main.ts owns the input). */
  focusPrompt(): void;
  /** Show the chat-area loading overlay while a session restores (main.ts). */
  showSessionLoading(): void;
  /** After a session was activated — its workspace may have changed. */
  onSessionActivated(): void;
  /** After the active session was cleared/deleted — back to landing. */
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
    const loaded = await loadSession(id);
    // A newer load request superseded this one (rapid session clicking): the
    // latest click owns the transcript — drop this stale result entirely,
    // including its tail effects (render / focus).
    if (this.isLoadStale(seq) || !loaded || loaded.snapshot.modelContext.messages.length === 0) return;
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

  // ── Session list rendering ──

  private async renderList(): Promise<void> {
    const container = document.getElementById('sidebar-session-list')!;
    try {
      const list = await loadSessionList();
      if (!list || list.length === 0) {
        container.innerHTML = `<div class="sidebar-session-empty">${t('sidebar.noSessions')}</div>`;
        return;
      }

      const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);

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
               <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
               <span class="group-name">${escapeHtml(workspaceBase(ws))}</span>
             </button>`
          : `<button class="sidebar-session-group-label" data-group="" aria-expanded="${collapsed ? 'false' : 'true'}">
               ${chevron}
               <span class="group-name">${t('workspace.none')}</span>
             </button>`;
        const items = sessions.map(s => {
          const title = escapeHtml(s.title.slice(0, 50));
          return `<div class="sidebar-session-item" data-sid="${s.id}">
          <div class="sidebar-session-item-main">
            <span class="sidebar-session-item-title" title="${title}">${title}</span>
            ${usageLine(s)}
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
          if (sid && !(e.target as HTMLElement).closest('.sidebar-session-delete')) {
            void this.load(sid);
          }
        });
      });

      // Delete session
      container.querySelectorAll('.sidebar-session-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const sid = btn.getAttribute('data-sid');
          if (!sid) return;
          if (!(await this.deps.confirm(t('confirm.deleteSession')))) return;
          try {
            await deleteSession(sid);
          } catch (err) {
            console.error('[pure] deleteSession failed:', err);
            showToast(t('toast.deleteFailed'));
            return;
          }
          if (this.currentActiveId === sid) {
            // Deleting the visible session: clear() cancels its run (explicit
            // user intent) and bounces back to landing.
            this.resetToLanding();
          } else {
            // A deleted session may still have a LIVE controller running in
            // the background — stop and drop it so its run cannot keep
            // re-persisting a session the user just deleted.
            this.deps.chat.forgetSession(sid);
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
