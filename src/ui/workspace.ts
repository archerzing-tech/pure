// src/ui/workspace.ts
// Workspace controller: the per-session workspace picker (sidebar chip,
// input-box folder buttons, status-footer shortcut, popover with recents),
// drag & drop (folder → switch workspace, files → attachments) and the
// composer attach buttons. Extracted from main.ts so the app shell stays a
// thin wiring layer and each concern owns its own DOM.

import { isTauriRuntime, tauriInvoke } from '../shared/tauri';
import { t } from '../shared/i18n';
import { escapeHtml } from '../shared/html';
import { showToast } from '../shared/toast';
import { workspaceBase } from '../shared/paths';
import { saveSessionWorkspace } from './store';
import {
  loadRecentWorkspaces,
  touchRecentWorkspace,
  setRecentPinned,
  removeRecentWorkspace,
} from './recentWorkspaces';
import type { ChatController } from './chat';
import { UPLOAD_LIMITS } from './pasteChip';
import type { DroppedFileRecord, PasteChipManager } from './pasteChip';

type DialogModule = typeof import('@tauri-apps/plugin-dialog');
let dialogModulePromise: Promise<DialogModule> | null = null;

function getDialogModule(): Promise<DialogModule> {
  if (!dialogModulePromise) {
    dialogModulePromise = import('@tauri-apps/plugin-dialog').catch((err) => {
      // A transient plugin/chunk failure must not poison every later picker
      // attempt; clear the cache so the next click can retry the import.
      dialogModulePromise = null;
      throw err;
    });
  }
  return dialogModulePromise;
}

// Start loading the native dialog bridge as soon as the UI module is evaluated
// so the first click does not wait for a lazy chunk or plugin initialization.
if (isTauriRuntime()) void getDialogModule().catch(() => {});

export interface WorkspaceDeps {
  chat: Pick<ChatController, 'getWorkspace' | 'setWorkspace' | 'getSessionId'>;
  pasteChips: Pick<PasteChipManager, 'addImportedFile' | 'addDroppedFiles' | 'hasAttachments' | 'remainingSlots'>;
  /** After any workspace DOM refresh — refresh the status footer. */
  onWorkspaceChanged(): void;
  /** After attachments were added — re-evaluate the send buttons. */
  onAttachmentsChanged(): void;
  /** After a workspace was actually committed/cleared — refresh the sidebar
   * session list (sessions are grouped by workspace). */
  onCommitted(): void;
}

export class WorkspaceController {
  private chat: WorkspaceDeps['chat'];
  private pasteChips: WorkspaceDeps['pasteChips'];
  private onWorkspaceChanged: WorkspaceDeps['onWorkspaceChanged'];
  private onAttachmentsChanged: WorkspaceDeps['onAttachmentsChanged'];
  private onCommitted: WorkspaceDeps['onCommitted'];
  private attachFileInput: HTMLInputElement | null = null;
  private initialized = false;

  constructor(deps: WorkspaceDeps) {
    this.chat = deps.chat;
    this.pasteChips = deps.pasteChips;
    this.onWorkspaceChanged = deps.onWorkspaceChanged;
    this.onAttachmentsChanged = deps.onAttachmentsChanged;
    this.onCommitted = deps.onCommitted;
  }

  // ── DOM refresh (picker chips, context panel, status footer) ──

  refresh(): void {
    const btn = document.getElementById('workspace-picker-btn') as HTMLButtonElement | null;
    const label = document.getElementById('workspace-picker-label');
    const current = document.getElementById('wp-popover-current');
    const ws = this.chat.getWorkspace();
    this.updateContextPanelWorkspace(ws);
    // The input-bar folder buttons mirror the same workspace state (accent when
    // a workspace is set, tooltip shows the full path) so clicking them re-picks.
    const inputWsBtns = [
      document.getElementById('landing-ws-btn'),
      document.getElementById('input-ws-btn'),
    ].filter(Boolean) as HTMLButtonElement[];
    for (const b of inputWsBtns) {
      b.classList.toggle('has-workspace', !!ws);
      b.title = ws || t('workspace.browseTitle');
      b.setAttribute('aria-label', ws || t('workspace.browseTitle'));
    }
    // Show the full workspace path in the sidebar beneath the picker. The text
    // is ellipsized by CSS while its title preserves the full path.
    for (const refs of [
      { bar: 'sidebar-workspace-path', text: 'sidebar-workspace-path-text', clear: 'sidebar-workspace-path-clear' },
    ]) {
      const bar = document.getElementById(refs.bar);
      const text = document.getElementById(refs.text);
      if (!bar || !text) continue;
      bar.hidden = !ws;
      text.textContent = ws || '';
      text.title = ws || '';
      const clear = document.getElementById(refs.clear);
      if (clear) clear.hidden = !ws;
    }
    if (!btn || !label) return;
    label.textContent = ws ? workspaceBase(ws) : t('workspace.none');
    label.title = ws || '';
    btn.classList.toggle('has-workspace', !!ws);
    if (current) {
      current.textContent = ws || t('workspace.none');
      current.title = ws || '';
    }
    // The clear (×) affordance on the popover's current-path row only makes
    // sense while a workspace is set — it stays hidden for the "no workspace"
    // state.
    const clearBtn = document.getElementById('wp-clear-btn');
    if (clearBtn) clearBtn.hidden = !ws;
    this.onWorkspaceChanged();
  }

  private updateContextPanelWorkspace(path: string) {
    const workspace = document.getElementById('context-workspace');
    if (workspace) {
      workspace.textContent = path || t('workspace.none');
      workspace.title = path;
    }
  }

  // ── Popover ──

  openPopover(): void {
    const popover = document.getElementById('workspace-picker-popover')!;
    const btn = document.getElementById('workspace-picker-btn');
    // Anchor the popover below the picker button (the sidebar has overflow
    // hidden, so a child dropdown would be clipped — position against the
    // button's viewport rect instead).
    if (btn) {
      const rect = btn.getBoundingClientRect();
      popover.style.left = `${Math.max(8, rect.left)}px`;
      popover.style.top = `${rect.bottom + 6}px`;
    }
    popover.classList.remove('hidden');
    void this.renderRecentWorkspaces();
    this.refresh();
  }

  closePopover(): void {
    document.getElementById('workspace-picker-popover')!.classList.add('hidden');
    this.refresh();
  }

  /** Native folder dialog in the desktop app; fall back to the popover. */
  async browse(): Promise<void> {
    if (isTauriRuntime()) {
      try {
        const importStart = performance.now();
        const { open } = await getDialogModule();
        const importMs = performance.now() - importStart;
        const dialogStart = performance.now();
        const selected = await open({ directory: true, multiple: false, title: t('workspace.browseTitle') });
        const dialogMs = performance.now() - dialogStart;
        // Diagnostic: when the folder picker feels slow, this pinpoints
        // whether the delay is the module load or the native panel itself.
        if (importMs > 100 || dialogMs > 300) {
          console.log(`[pure] folder picker latency — import ${importMs.toFixed(0)}ms · native dialog ${dialogMs.toFixed(0)}ms`);
        }
        if (typeof selected === 'string' && selected) {
          await this.commit(selected);
        }
      } catch (err) {
        console.error('[pure] folder picker failed:', err);
      }
    } else {
      // No native dialog in plain web/dev mode — show the simplified popover
      // (current path + recent folders the user can switch to).
      this.openPopover();
    }
  }

  async commit(value: string): Promise<void> {
    const ws = value.trim();
    if (ws) {
      // Record usage in the independent recent list (MRU bump + pin state).
      touchRecentWorkspace(ws);
    }
    if (ws === this.chat.getWorkspace()) {
      // Nothing changed (e.g. re-applying the current path) — just close.
      this.closePopover();
      return;
    }
    this.chat.setWorkspace(ws);
    this.closePopover();
    this.refresh();
    // Persist with the session so the override survives a restart. The backend
    // no-ops when the session dir doesn't exist yet (brand-new unsaved chat);
    // the override is then captured on the first save_session call.
    try {
      await saveSessionWorkspace(this.chat.getSessionId(), ws);
    } catch (err) {
      console.error('[pure] saveSessionWorkspace failed:', err);
    }
    showToast(ws ? t('workspace.saved') : t('workspace.cleared'));
    this.onCommitted();
  }

  /** Render the "Recent" list from the independent recents store (not sessions):
   * pinned projects always first, each row with pin + remove actions. */
  private renderRecentWorkspaces(): void {
    const list = document.getElementById('wp-recent-list');
    if (!list) return;
    const recents = loadRecentWorkspaces();
    if (recents.length === 0) {
      list.innerHTML = `<div class="wp-recent-empty">${t('workspace.recentEmpty')}</div>`;
      return;
    }
    // Pinned entries are always shown; unpinned are already capped by the store.
    list.innerHTML = recents.map(r => {
      const pinTitle = r.pinned ? t('workspace.unpin') : t('workspace.pin');
      const starFill = r.pinned ? 'currentColor' : 'none';
      return `
    <div class="wp-recent-item" role="button" tabindex="0" data-ws="${escapeHtml(r.path)}" title="${escapeHtml(r.path)}">
      <svg class="wp-recent-folder" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="wp-recent-item-path">${escapeHtml(r.path)}</span>
      <span class="wp-recent-item-actions">
        <button class="wp-recent-pin${r.pinned ? ' pinned' : ''}" data-ws="${escapeHtml(r.path)}" title="${pinTitle}" aria-label="${pinTitle}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="${starFill}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </button>
        <button class="wp-recent-remove" data-ws="${escapeHtml(r.path)}" title="${t('workspace.remove')}" aria-label="${t('workspace.remove')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </span>
    </div>`;
    }).join('');

    // Row click → switch workspace (ignore clicks on the action buttons).
    list.querySelectorAll<HTMLElement>('.wp-recent-item').forEach(el => {
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.wp-recent-pin') || target.closest('.wp-recent-remove')) return;
        const ws = el.getAttribute('data-ws') || '';
        void this.commit(ws);
      });
      // Keyboard parity with the old <button> row: Enter/Space activates.
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const ws = el.getAttribute('data-ws') || '';
          void this.commit(ws);
        }
      });
    });

    // Pin / unpin.
    list.querySelectorAll('.wp-recent-pin').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const ws = btn.getAttribute('data-ws') || '';
        setRecentPinned(ws, !btn.classList.contains('pinned'));
        void this.renderRecentWorkspaces();
      });
    });

    // Remove from recents (does not delete the session or the folder).
    list.querySelectorAll('.wp-recent-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const ws = btn.getAttribute('data-ws') || '';
        removeRecentWorkspace(ws);
        void this.renderRecentWorkspaces();
      });
    });
  }

  // ── Drag & drop ──

  private setDragActive(active: boolean) {
    const overlay = document.getElementById('drag-overlay');
    if (overlay) overlay.classList.toggle('active', active);
  }

  private handleDroppedWorkspacePath(path: string) {
    if (!path) return;
    void this.commit(path);
  }

  private async handleDroppedPaths(paths: string[]): Promise<void> {
    const sessionId = this.chat.getSessionId();
    // Pre-flight the batch cap BEFORE importing: Rust copies each dropped file
    // into the session tmp dir, so importing 20 files just to reject 10 would
    // copy 20 and spam toasts. Stop at the cap with a single notice.
    if (isTauriRuntime()) {
      const slots = this.pasteChips.remainingSlots();
      if (slots <= 0) {
        showToast(t('paste.tooManyAttachments').replace('{max}', String(UPLOAD_LIMITS.MAX_ATTACHMENTS)));
        return;
      }
      paths = paths.slice(0, slots);
    }
    for (const path of paths) {
      if (!path) continue;
      try {
        if (isTauriRuntime()) {
          const record = await tauriInvoke<DroppedFileRecord>('import_dropped_file', { sessionId, sourcePath: path });
          if (record?.isDirectory) {
            this.handleDroppedWorkspacePath(path);
          } else if (record) {
            this.pasteChips.addImportedFile(record);
          }
        }
      } catch (err) {
        console.error('[pure] dropped file import failed:', err);
        showToast(`无法导入文件: ${path}`);
      }
    }
    this.onAttachmentsChanged();
  }

  /** Native folder drop (Tauri). The webview's default dragDropEnabled:true
   * intercepts OS drops and emits enter/over/drop/leave events instead of
   * navigating to the dropped file. */
  private async setupNativeDragDrop() {
    if (!isTauriRuntime()) return;
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      await getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'enter' || p.type === 'over') {
          this.setDragActive(true);
        } else if (p.type === 'drop') {
          this.setDragActive(false);
          void this.handleDroppedPaths(p.paths);
        } else if (p.type === 'leave') {
          this.setDragActive(false);
        }
      });
    } catch (err) {
      console.error('[pure] drag-drop setup failed:', err);
    }
  }

  /** Browser fallback (vite dev / plain web preview): prevents the page from
   * navigating to a dropped file and mirrors the overlay. Browser File objects
   * are sent through the same attachment manager; directories remain a no-op. */
  private setupBrowserDragDrop() {
    if (isTauriRuntime()) return;
    let depth = 0;
    document.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      this.setDragActive(true);
    });
    document.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    document.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.setDragActive(false);
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      this.setDragActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) {
        this.pasteChips.addDroppedFiles(files);
        this.onAttachmentsChanged();
      }
    });
  }

  // ── Composer attach button: upload files as attachment chips ──
  // Tauri: native multi-file dialog → same import path as OS drops. Browser:
  // a hidden <input type="file"> since plain web has no native dialog.

  private getAttachFileInput(): HTMLInputElement {
    if (!this.attachFileInput) {
      this.attachFileInput = document.createElement('input');
      this.attachFileInput.type = 'file';
      this.attachFileInput.multiple = true;
      this.attachFileInput.style.display = 'none';
      document.body.appendChild(this.attachFileInput);
      this.attachFileInput.addEventListener('change', () => {
        const input = this.attachFileInput;
        if (!input) return;
        const files = Array.from(input.files ?? []);
        input.value = '';
        if (files.length > 0) {
          this.pasteChips.addDroppedFiles(files);
          this.onAttachmentsChanged();
        }
      });
    }
    return this.attachFileInput;
  }

  async attachFiles(): Promise<void> {
    if (isTauriRuntime()) {
      try {
        const { open } = await getDialogModule();
        const selected = await open({ multiple: true, directory: false, title: t('input.attach.title') });
        const paths = Array.isArray(selected) ? selected : (typeof selected === 'string' && selected ? [selected] : []);
        if (paths.length > 0) await this.handleDroppedPaths(paths);
      } catch (err) {
        console.error('[pure] attach file picker failed:', err);
      }
    } else {
      this.getAttachFileInput().click();
    }
  }

  // ── Init: bind all workspace-owned DOM events ──

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    const workspacePickerBtn = document.getElementById('workspace-picker-btn');
    workspacePickerBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.browse();
    });

    // ── Input-box folder buttons: one click opens the native folder dialog ──
    // (same fast path as the sidebar chip). In browser/dev mode, where there is
    // no native dialog, fall back to opening the workspace popover instead.
    for (const id of ['landing-ws-btn', 'input-ws-btn']) {
      document.getElementById(id)?.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.browse();
      });
    }

    // The status-footer workspace shortcut opens the same native folder picker.
    document.getElementById('status-workspace')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.browse();
    });

    // The sidebar workspace path shortcut lets users re-pick the folder without
    // opening the sidebar popover first.
    const sidebarPathBar = document.getElementById('sidebar-workspace-path');
    if (sidebarPathBar) {
      sidebarPathBar.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.sidebar-workspace-path-clear')) return;
        void this.browse();
      });
      // Keyboard parity (the bar is role=button): Enter/Space re-picks. The
      // nested clear button keeps its own activation — return BEFORE
      // preventDefault.
      sidebarPathBar.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if ((e.target as HTMLElement).closest('.sidebar-workspace-path-clear')) return;
        e.preventDefault();
        void this.browse();
      });
    }
    document.getElementById('sidebar-workspace-path-clear')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.commit('');
    });

    // The popover's single current-path row is clickable too: it opens the same
    // native picker (in browser/dev mode this re-opens the already-open
    // popover, where the recents below remain the actionable list).
    document.getElementById('wp-current-row')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('#wp-clear-btn')) return;
      e.stopPropagation();
      void this.browse();
    });
    document.getElementById('wp-current-row')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if ((e.target as HTMLElement).closest('#wp-clear-btn')) return;
        e.preventDefault();
        void this.browse();
      }
    });
    // Restore the ability to clear a session's workspace (was lost when the old
    // popover input row was simplified away): a small × on the current-path row.
    document.getElementById('wp-clear-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.commit('');
    });

    // Close the popover on outside click (input's own keydown stays live).
    document.addEventListener('click', (e) => {
      const popover = document.getElementById('workspace-picker-popover');
      if (!popover || popover.classList.contains('hidden')) return;
      if (popover.contains(e.target as Node) || workspacePickerBtn?.contains(e.target as Node)) return;
      this.closePopover();
    });

    // The paperclip buttons on both composers (landing + chat) share one handler.
    for (const id of ['attach-btn', 'landing-attach-btn']) {
      document.getElementById(id)?.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.attachFiles();
      });
    }

    this.setupBrowserDragDrop();
    void this.setupNativeDragDrop();
  }
}

