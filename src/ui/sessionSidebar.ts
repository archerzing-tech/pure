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
import {
  deleteAllSessions,
  deleteSession,
  loadSession,
  loadSessionList,
  type SessionMeta,
  type StoredMessage,
} from './store';
import type { ChatController } from './chat';

export interface SessionSidebarDeps {
  chat: Pick<ChatController, 'cancel' | 'clear' | 'setSessionId' | 'setWorkspace' | 'syncEffectiveWorkspace'>;
  pasteChips: { clear(): void };
  confirm(message: string): Promise<boolean>;
  /** Render a loaded session's transcript (main.ts owns the chat DOM). */
  renderMessages(messages: StoredMessage[]): Promise<void>;
  /** Move keyboard focus into the composer (main.ts owns the input). */
  focusPrompt(): void;
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
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.renderList();
    }, 150);
  }

  /** Load a session's transcript and switch the active state to it. */
  async load(id: string): Promise<void> {
    const loaded = await loadSession(id);
    if (!loaded || loaded.messages.length === 0) return;
    // Abort any in-flight generation first: the old send() loop must not keep
    // appending to (or persisting into) the session we're about to switch to.
    // chat.setSessionId also bumps the generation guard, which is the second
    // line of defense (see ChatController.send).
    this.deps.chat.cancel();
    this.deps.pasteChips.clear();
    this.deps.chat.setSessionId(id);
    // Restore this session's own workspace ('' = none) — sessions are
    // independent, so there is no global-default fallback. Set it BEFORE
    // rendering so clickable relative paths in the transcript resolve against
    // the restored workspace.
    this.deps.chat.setWorkspace(loaded.workspace || '');
    await this.deps.chat.syncEffectiveWorkspace();
    await this.deps.renderMessages(loaded.messages);
    this.setActive(id);
    this.deps.onSessionActivated();
    this.deps.focusPrompt();
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
            this.resetToLanding();
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
