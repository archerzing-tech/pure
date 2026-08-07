// src/ui/main.ts
// pure v0.8 — Notion-style sidebar + modal settings

import { ChatController, bindAssistantBubbleCopy } from './chat';
import { SettingsPanel, loadConfig, hasConfiguredKey } from './settings';
import { loadSessionList, loadSession, deleteSession, deleteAllSessions, saveSessionWorkspace, getStoredThinkingSegments, type SessionMeta, type StoredMessage, type ToolExecMeta } from './store';
import { loadRecentWorkspaces, touchRecentWorkspace, setRecentPinned, removeRecentWorkspace } from './recentWorkspaces';
import { checkForUpdatesSilently, fetchAppVersion } from './updater';
import { escapeHtml } from '../shared/html';
import { t, applyTranslations, updateLanguage } from '../shared/i18n';
import type { Language as I18nLanguage } from '../shared/i18n';
import { isTauriRuntime } from '../shared/tauri';
import { showToast } from '../shared/toast';
import { copyTextToClipboard } from '../shared/clipboard';
import { renderMarkdown, stripToolCallXml } from './markdown';
import { createToolRow, finalizeToolRow } from './toolRow';
import { appendStoredThinking } from './thinkingCard';
import { wireScrollPin, setPinnedToBottom, scrollChatToBottomIfPinned } from './scrollPin';
import { initPathLinks, linkifyPaths } from './pathLink';
import { PasteChipManager, composeMessageWithAttachments, type DroppedFileRecord } from './pasteChip';

const chat = new ChatController();

// ── Oversized-paste chips (see pasteChip.ts) ──
// Pastes above 64KB become a file chip (saved to ~/.pure/tmp/<session-id>/)
// instead of jamming the textarea; double-click opens a viewer. Both the
// bottom input bar and the landing input mount a chip row sharing one list.
const pasteChips = new PasteChipManager(() => chat.getSessionId());
pasteChips.mount(document.getElementById('input-bar')!);
pasteChips.mount(document.getElementById('landing-input-wrap')!);

let hasStartedChat = false;
let contextCollapsed = false;
let contextCollapsedBeforeSettings = false;

// App version cached from fetchAppVersion() — shown in the status footer.
let appVersion = '';

// Message typed while the assistant is generating — queued and auto-sent when
// the current turn finishes (Claude Code behavior, so the input stays live).
let queuedWhileStreaming: string | null = null;

const settings = new SettingsPanel(
  onConfigSaved,
  () => {
    contextCollapsedBeforeSettings = contextCollapsed;
    setContextPanelCollapsed(true);
    document.getElementById('main')?.classList.add('settings-mode');
    if (contextPanelReopen) contextPanelReopen.hidden = true;
  },
  () => {
    document.getElementById('main')?.classList.remove('settings-mode');
    setContextPanelCollapsed(contextCollapsedBeforeSettings);
    updateContextPanelStage();
    enableInputIfReady();
  },
);

// ── Streaming state → update both send buttons ──

chat.onStreamingStateChange((streaming) => {
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  const promptEl = document.getElementById('prompt') as HTMLTextAreaElement;
  const landingSend = document.getElementById('landing-send-btn') as HTMLButtonElement;
  const landingPrompt = document.getElementById('landing-prompt') as HTMLTextAreaElement;

  if (streaming) {
    const stopSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
    sendBtn.innerHTML = stopSvg;
    sendBtn.title = t('input.stop.title');
    sendBtn.setAttribute('aria-label', t('input.stop.title'));
    sendBtn.classList.add('stopping');
    // The stop/pause button must ALWAYS be clickable while a task runs: send()
    // disables the button when it empties the input, and this branch is the
    // only place that can re-enable it for the interrupt affordance. Without
    // this, the square pause icon renders disabled and clicking it can't
    // cancel the running task.
    sendBtn.disabled = false;
    landingSend.disabled = false;
    // Keep the input ENABLED while generating: the caret stays visible and the
    // user can type the next message. Enter queues it (see keydown handler).
    promptEl.placeholder = queuedWhileStreaming ? t('input.queued') : t('input.streaming');
    landingSend.innerHTML = stopSvg;
    landingSend.title = t('input.stop.title');
    landingSend.setAttribute('aria-label', t('input.stop.title'));
    updateContextPanelStage(true);
    updateContextPanelChanges();
  } else {
    const sendSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
    sendBtn.innerHTML = sendSvg;
    sendBtn.title = t('input.send.title');
    sendBtn.setAttribute('aria-label', t('input.send.title'));
    sendBtn.classList.remove('stopping');
    // A message consisting only of pasted file chips (no typed text) is still
    // sendable — the chips' content rides along in the composed message.
    sendBtn.disabled = !promptEl.value.trim() && !pasteChips.hasAttachments();
    promptEl.placeholder = t('input.placeholder');
    promptEl.disabled = !hasConfiguredKey(loadConfig());
    landingSend.innerHTML = sendSvg;
    landingSend.title = t('input.send.title');
    landingSend.setAttribute('aria-label', t('input.send.title'));
    landingSend.disabled = !landingPrompt.value.trim() && !pasteChips.hasAttachments();
    updateContextPanelStage(false);
    updateContextPanelChanges();
  }
});

function onConfigSaved() {
  // Each session owns its workspace independently (persisted with the
  // session); a settings save must never touch the current chat's workspace.
  updateWorkspacePicker();
  updateSidebarModel();
  updateContextPanelStage();
  enableInputIfReady();
}

// ── DOM refs ──
const chatView = document.getElementById('chat-view')!;
const promptEl = document.getElementById('prompt') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const landingPrompt = document.getElementById('landing-prompt') as HTMLTextAreaElement;
const landingSend = document.getElementById('landing-send-btn') as HTMLButtonElement;
const sidebarNewChat = document.getElementById('sidebar-new-chat') as HTMLButtonElement;
const sidebarSettingsBtn = document.getElementById('sidebar-settings-btn') as HTMLButtonElement;

// ── Workspace picker (sidebar top, Claude Desktop style) ──
// Every session is an independent workspace: this string is the session's own
// path ('' = no workspace), persisted with the session. There is no global
// default — a brand-new chat always starts with no workspace.
let sessionWorkspace = '';

/** Last path segment (basename) for display, e.g. "/a/b" → "b". */
function workspaceBase(path: string): string {
  const trimmed = path.replace(/[\/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function updateContextPanelWorkspace(path: string) {
  const workspace = document.getElementById('context-workspace');
  const name = document.getElementById('context-workspace-name');
  if (workspace) {
    workspace.textContent = path || t('workspace.none');
    workspace.title = path;
  }
  if (name) name.textContent = path ? workspaceBase(path) : 'workspace';
}

function providerLabel(provider: string | undefined): string {
  const labels: Record<string, string> = {
    'deepseek-openai': 'DeepSeek',
    'deepseek-anthropic': 'DeepSeek',
    qwen: 'Qwen',
    glm: 'GLM',
  };
  return labels[provider ?? ''] || provider || 'Model';
}

function updateContextPanelModel() {
  const cfg = loadConfig();
  const model = document.getElementById('context-model');
  if (!model) return;
  model.textContent = cfg?.model ? `${providerLabel(cfg.provider)} · ${cfg.model}` : (cfg?.provider ? providerLabel(cfg.provider) : t('context.model.notConfigured'));
}

function updateContextPanelChanges() {
  const count = document.getElementById('context-change-count');
  if (!count) return;
  const changed = document.querySelectorAll('#chat .tool-row.success, #chat .diff-card, #chat .bubble.md-rendered pre').length;
  count.textContent = changed === 0
    ? t('context.changes.none')
    : t('context.changes.count').replace('{n}', String(changed));
}

/** Persistent status footer: workspace · model · live state · version. */
function updateStatusBar() {
  const cfg = loadConfig();
  const ws = chat.getWorkspace();

  // Workspace shortcut (left) — same ghost-button language as the sidebar.
  const wsBtn = document.getElementById('status-workspace');
  const wsText = document.getElementById('status-workspace-text');
  if (wsBtn) {
    wsBtn.classList.toggle('has-workspace', !!ws);
    wsBtn.title = ws || t('workspace.browseTitle');
    wsBtn.setAttribute('aria-label', ws || t('workspace.browseTitle'));
  }
  if (wsText) {
    wsText.textContent = ws || t('workspace.none');
    wsText.title = ws || '';
  }

  // Model badge — same format as the sidebar model chip.
  const model = document.getElementById('status-model');
  if (model) {
    model.textContent = cfg?.model
      ? `${providerLabel(cfg.provider)} · ${cfg.model}`
      : (cfg?.provider ? providerLabel(cfg.provider) : t('context.model.notConfigured'));
    model.title = cfg?.model ? cfg.model : '';
  }

  // Live state dot + text (busy while the agent is generating).
  const bar = document.getElementById('status-bar');
  const statusText = document.getElementById('status-text');
  const busy = chat.isStreaming();
  if (bar) bar.classList.toggle('busy', busy);
  if (statusText) statusText.textContent = busy ? t('status.generating') : t('status.ready');

  // App version pill (right).
  const version = document.getElementById('status-version');
  if (version) version.textContent = appVersion ? `v${appVersion}` : '';
}

function updateContextPanelStage(streaming = chat.isStreaming()) {
  const label = document.getElementById('context-stage-label');
  const percent = document.getElementById('context-stage-percent');
  const progress = document.getElementById('context-stage-progress');
  const status = document.getElementById('preview-status');
  const stage = streaming ? t('context.stage.building') : (hasStartedChat ? t('context.stage.next') : t('context.stage.ready'));
  const value = streaming ? 62 : (hasStartedChat ? 28 : 0);
  updateContextPanelChanges();
  if (label) label.textContent = stage;
  if (percent) percent.textContent = `${value}%`;
  if (progress) progress.style.width = `${value}%`;
  if (status) status.textContent = streaming ? t('context.status.updating') : (hasStartedChat ? t('context.status.ready') : t('context.status.waiting'));
  updateStatusBar();
}

function updateWorkspacePicker() {
  const btn = document.getElementById('workspace-picker-btn') as HTMLButtonElement | null;
  const label = document.getElementById('workspace-picker-label');
  const current = document.getElementById('wp-popover-current');
  const ws = chat.getWorkspace();
  updateContextPanelWorkspace(ws);
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
  updateStatusBar();
}

function openWorkspacePopover() {
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
  void renderRecentWorkspaces();
  updateWorkspacePicker();
}

function closeWorkspacePopover() {
  document.getElementById('workspace-picker-popover')!.classList.add('hidden');
  updateWorkspacePicker();
}

/** Native folder dialog in the desktop app; fall back to the popover. */
async function browseWorkspace() {
  if (isTauriRuntime()) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false, title: t('workspace.browseTitle') });
      if (typeof selected === 'string' && selected) {
        await commitWorkspace(selected);
      }
    } catch (err) {
      console.error('[pure] folder picker failed:', err);
    }
  } else {
    // No native dialog in plain web/dev mode — show the simplified popover
    // (current path + recent folders the user can switch to).
    openWorkspacePopover();
  }
}

async function commitWorkspace(value: string) {
  const ws = value.trim();
  if (ws) {
    // Record usage in the independent recent list (MRU bump + pin state).
    touchRecentWorkspace(ws);
  }
  if (ws === chat.getWorkspace()) {
    // Nothing changed (e.g. re-applying the current path) — just close.
    closeWorkspacePopover();
    return;
  }
  if (ws) {
    // Pin this session only — workspaces are per-session, never global.
    sessionWorkspace = ws;
    chat.setWorkspace(ws);
  } else {
    // Cleared → this session simply has no workspace.
    sessionWorkspace = '';
    chat.setWorkspace('');
  }
  closeWorkspacePopover();
  updateWorkspacePicker();
  // Persist with the session so the override survives a restart. The backend
  // no-ops when the session dir doesn't exist yet (brand-new unsaved chat);
  // the override is then captured on the first save_session call.
  try {
    await saveSessionWorkspace(chat.getSessionId(), ws);
  } catch (err) {
    console.error('[pure] saveSessionWorkspace failed:', err);
  }
  refreshSidebarSessions();
  showToast(ws ? t('workspace.saved') : t('workspace.cleared'));
}

/** Render the "Recent" list from the independent recents store (not sessions):
 * pinned projects always first, each row with pin + remove actions. */
function renderRecentWorkspaces() {
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
  // Typed as HTMLElement so addEventListener picks the typed overloads.
  list.querySelectorAll<HTMLElement>('.wp-recent-item').forEach(el => {
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.wp-recent-pin') || target.closest('.wp-recent-remove')) return;
      const ws = el.getAttribute('data-ws') || '';
      void commitWorkspace(ws);
    });
    // Keyboard parity with the old <button> row: Enter/Space activates.
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const ws = el.getAttribute('data-ws') || '';
        void commitWorkspace(ws);
      }
    });
  });

  // Pin / unpin.
  list.querySelectorAll('.wp-recent-pin').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ws = btn.getAttribute('data-ws') || '';
      setRecentPinned(ws, !btn.classList.contains('pinned'));
      void renderRecentWorkspaces();
    });
  });

  // Remove from recents (does not delete the session or the folder).
  list.querySelectorAll('.wp-recent-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ws = btn.getAttribute('data-ws') || '';
      removeRecentWorkspace(ws);
      void renderRecentWorkspaces();
    });
  });
}

// ── Drag & drop: drop a folder anywhere on the window to switch workspace ──

function setDragActive(active: boolean) {
  const overlay = document.getElementById('drag-overlay');
  if (overlay) overlay.classList.toggle('active', active);
}

function handleDroppedWorkspacePath(path: string) {
  if (!path) return;
  void commitWorkspace(path);
}

async function handleDroppedPaths(paths: string[]): Promise<void> {
  const sessionId = chat.getSessionId();
  for (const path of paths) {
    if (!path) continue;
    try {
      if (isTauriRuntime()) {
        const core = await (await import('../shared/tauri')).loadTauriCore();
        const record = await core?.invoke<DroppedFileRecord>('import_dropped_file', { sessionId, sourcePath: path });
        if (record?.isDirectory) {
          handleDroppedWorkspacePath(path);
        } else if (record) {
          pasteChips.addImportedFile(record);
        }
      }
    } catch (err) {
      console.error('[pure] dropped file import failed:', err);
      showToast(`无法导入文件: ${path}`);
    }
  }
  enableInputIfReady();
}

/** Native folder drop (Tauri). The webview's default dragDropEnabled:true
 * intercepts OS drops and emits enter/over/drop/leave events instead of
 * navigating to the dropped file. */
async function setupNativeDragDrop() {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === 'enter' || p.type === 'over') {
        setDragActive(true);
      } else if (p.type === 'drop') {
        setDragActive(false);
        void handleDroppedPaths(p.paths);
      } else if (p.type === 'leave') {
        setDragActive(false);
      }
    });
  } catch (err) {
    console.error('[pure] drag-drop setup failed:', err);
  }
}

/** Browser fallback (vite dev / plain web preview): prevents the page from
 * navigating to a dropped file and mirrors the overlay. Browser File objects
 * are sent through the same attachment manager; directories remain a no-op.
 */
function setupBrowserDragDrop() {
  if (isTauriRuntime()) return;
  let depth = 0;
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    setDragActive(true);
  });
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) setDragActive(false);
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    setDragActive(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) pasteChips.addDroppedFiles(files);
  });
}

// ── Init ──
(async () => {
  applySavedAppearance();
  chat.setWorkspace('');
  updateWorkspacePicker();
  updateSidebarModel();
  updateContextPanelStage();
  enableInputIfReady();
  checkLandingState();
  refreshSidebarSessions();
  setupBrowserDragDrop();
  void setupNativeDragDrop();
  initPathLinks();
  setTimeout(() => checkForUpdatesSilently(), 3000);
  void fetchAppVersion().then((version) => {
    appVersion = version;
    const el = document.getElementById('landing-version');
    if (el) el.textContent = `v${version}`;
    updateStatusBar();
  });
})().catch(err => console.error('[pure] init failed:', err));

/** Ensure the landing class is set correctly based on chat state */
function checkLandingState() {
  if (!hasStartedChat) {
    chatView.classList.add('landing');
  } else {
    chatView.classList.remove('landing');
  }
}

/** Transition from landing to chat view */
function enterChatMode() {
  if (hasStartedChat) return;
  hasStartedChat = true;
  chatView.classList.remove('landing');
  updateContextPanelStage();
  promptEl.focus();
}

/** Update sidebar model badge from config */
function updateSidebarModel() {
  const cfg = loadConfig();
  const el = document.getElementById('sidebar-model');
  if (!el) return;
  el.textContent = cfg?.model ? `${providerLabel(cfg.provider)} · ${cfg.model}` : (cfg?.provider ? providerLabel(cfg.provider) : '');
  updateContextPanelModel();
  // updateContextPanelStage() already refreshes the status footer.
  updateContextPanelStage();
}

/** Reset to landing state for a new conversation */
function goToLanding() {
  hasStartedChat = false;
  queuedWhileStreaming = null;
  pasteChips.clear();
  updateContextPanelStage(false);
  chatView.classList.add('landing');
  landingPrompt.value = '';
  landingPrompt.style.height = 'auto';
  landingSend.disabled = !landingPrompt.value.trim() && !pasteChips.hasAttachments();
}

/** Apply saved theme, language, font size, and density on initial load */
function applySavedAppearance() {
  const cfg = loadConfig();
  if (!cfg) return;

  if (cfg.theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', cfg.theme);
  }

  updateLanguage(cfg.language as I18nLanguage);

  document.documentElement.style.setProperty('--font-size',
    cfg.fontSize === 'small' ? '13px' : cfg.fontSize === 'large' ? '15px' : '14px');
  document.documentElement.style.setProperty('--spacing',
    cfg.density === 'compact' ? '8px' : cfg.density === 'spacious' ? '16px' : '12px');
}

function renderSessionMessages(messages: StoredMessage[]) {
  enterChatMode();
  chat.loadFromStorage(messages);

  const chatEl = document.getElementById('chat')!;
  chatEl.innerHTML = '';
  // Same coalesced scroll machinery as live streaming (chat.ts), so the
  // one-shot restore scroll joins the shared rAF budget instead of forcing a
  // synchronous full-transcript layout at the end of the restore.
  wireScrollPin(chatEl);
  const toolExecs: ToolExecMeta[] = [];

  for (const m of messages) {
    if (m.role === 'tool' && m.toolExec) {
      toolExecs.push(m.toolExec);
      continue;
    }
    if (m.role === 'assistant') {
      flushToolExecs(toolExecs, chatEl);
      for (const segment of getStoredThinkingSegments(m)) appendStoredThinking(segment, chatEl);
      toolExecs.length = 0;
      if (!m.content) continue;
      const wrapper = document.createElement('div');
      wrapper.className = 'bubble-row assistant';
      const label = document.createElement('span');
      label.className = 'bubble-label';
      label.textContent = t('context.role.pure');
      wrapper.appendChild(label);
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bindAssistantBubbleCopy(bubble);
      wrapper.appendChild(bubble);
      chatEl.appendChild(wrapper);
      // Same leaked-<tool_calls> filter as live streaming; re-scroll once the
      // async diagram pass settles so restored content is never hidden.
      void renderMarkdown(stripToolCallXml(m.content), bubble).then(() => {
        scrollChatToBottomIfPinned(chatEl);
      });
    } else if (m.role === 'user' && m.content) {
      flushToolExecs(toolExecs, chatEl);
      toolExecs.length = 0;
      const wrapper = document.createElement('div');
      wrapper.className = 'bubble-row user';
      const label = document.createElement('span');
      label.className = 'bubble-label';
      label.textContent = t('context.role.you');
      wrapper.appendChild(label);
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = m.content;
      linkifyPaths(bubble);
      wrapper.appendChild(bubble);
      chatEl.appendChild(wrapper);
    }
  }
  flushToolExecs(toolExecs, chatEl);
  // A session restore rebuilds the transcript from scratch, so it always
  // lands at the newest content — force the pin state the same way a fresh
  // stream would, then scroll through the shared coalesced helper.
  setPinnedToBottom(chatEl, true);
  scrollChatToBottomIfPinned(chatEl);
  updateContextPanelChanges();
}

function flushToolExecs(execs: ToolExecMeta[], parent: HTMLElement) {
  if (execs.length === 0) return;
  // Restored sessions render each round's tool calls in the same horizontal
  // grid as live streaming (chat.ts appendToolRow), so parallel batches (two
  // web_search calls, a search + list, …) read as parallel instead of a
  // vertical stack of identical rows. Each flush batch == one LLM iteration
  // (flushToolExecs is called at assistant-message boundaries).
  const grid = document.createElement('div');
  grid.className = 'bubble-row tool-grid';
  for (const te of execs) {
    const row = createToolRow(te.toolName, te.args ?? {});
    finalizeToolRow(row, te);
    grid.appendChild(row.el);
  }
  parent.appendChild(grid);
}

// ── Input handling ──

function enableInputIfReady() {
  const config = loadConfig();
  const ready = hasConfiguredKey(config);
  promptEl.disabled = !ready;
  sendBtn.disabled = !ready || (!promptEl.value.trim() && !pasteChips.hasAttachments());
  landingSend.disabled = !landingPrompt.value.trim() && !pasteChips.hasAttachments();
  // Keep the landing composer usable before setup so the user can write a
  // draft first. Sending it opens Settings and the draft remains intact.
  landingPrompt.disabled = false;
  if (!ready) {
    promptEl.placeholder = t('input.placeholderDisabled');
    landingPrompt.placeholder = t('landing.placeholderDisabled');
  } else {
    promptEl.placeholder = t('input.placeholder');
    landingPrompt.placeholder = t('landing.placeholder');
  }
}

// ── Landing input auto-resize ──

landingPrompt.addEventListener('input', () => {
  landingPrompt.style.height = 'auto';
  landingPrompt.style.height = Math.min(landingPrompt.scrollHeight, 200) + 'px';
  if (!chat.isStreaming()) {
    landingSend.disabled = !landingPrompt.value.trim() && !pasteChips.hasAttachments();
  }
});

landingPrompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleLandingSendOrStop();
  }
  if (e.key === 'Escape' && chat.isStreaming()) {
    chat.cancel();
  }
});

// ── Chat (bottom) input auto-resize ──

promptEl.addEventListener('input', () => {
  autoResizePrompt();
  if (!chat.isStreaming()) {
    sendBtn.disabled = !promptEl.value.trim() && !pasteChips.hasAttachments();
  }
});

// Double-click either composer to copy the current draft without disturbing
// the selection or send behavior. Empty drafts are ignored.
function bindDraftDoubleClickCopy(input: HTMLTextAreaElement): void {
  input.addEventListener('dblclick', async () => {
    const text = input.value;
    if (!text) return;
    const copied = await copyTextToClipboard(text);
    showToast(copied ? t('input.copied') : t('input.copyFailed'));
  });
}

bindDraftDoubleClickCopy(promptEl);
bindDraftDoubleClickCopy(landingPrompt);

// Oversized pastes are intercepted here (both inputs) and become file chips.
promptEl.addEventListener('paste', (e) => { pasteChips.consumePaste(e); });
landingPrompt.addEventListener('paste', (e) => { pasteChips.consumePaste(e); });

promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (chat.isStreaming()) {
      // Enter while generating: queue the typed message instead of cancelling.
      const text = promptEl.value.trim();
      if (text) {
        queuedWhileStreaming = text;
        promptEl.value = '';
        promptEl.style.height = 'auto';
        promptEl.placeholder = t('input.queued');
      }
      return;
    }
    handleSendOrStop();
  }
  if (e.key === 'Escape' && chat.isStreaming()) {
    queuedWhileStreaming = null;
    chat.cancel();
  }
});

sendBtn.addEventListener('click', handleSendOrStop);
landingSend.addEventListener('click', handleLandingSendOrStop);

function handleSendOrStop() {
  if (chat.isStreaming()) {
    queuedWhileStreaming = null;
    chat.cancel();
    return;
  }
  sendMessage(promptEl);
}

function handleLandingSendOrStop() {
  if (chat.isStreaming()) {
    queuedWhileStreaming = null;
    chat.cancel();
    return;
  }
  sendMessage(landingPrompt);
}

async function sendMessage(sourceEl: HTMLTextAreaElement) {
  const text = sourceEl.value.trim();
  // Empty typed text is fine when pasted file chips carry the message.
  if ((!text && !pasteChips.hasAttachments()) || chat.isStreaming()) return;

  // Validate BEFORE clearing the input: without a key we return here and the
  // user's draft stays in the box (doSend's own check covers the queued path).
  if (!hasConfiguredKey(loadConfig())) {
    showToast(t('toast.setApiKey'));
    settings.open();
    return;
  }

  sourceEl.value = '';
  sourceEl.style.height = 'auto';
  if (sourceEl === landingPrompt) {
    landingSend.disabled = true;
  }
  sendBtn.disabled = true;
  await doSend(text);
}

/**
 * Shared send core (also used by flushQueued so a queued message can be sent
 * even when the user has already started typing a new draft).
 */
async function doSend(text: string) {
  if (!hasConfiguredKey(loadConfig())) {
    showToast(t('toast.setApiKey'));
    settings.open();
    return;
  }
  // Large pasted content rides along with the typed text (each attachment is
  // prefixed with a [粘贴文件] marker). Chips are cleared ONLY after a
  // successful send — on failure the user keeps them for a retry.
  const fullText = composeMessageWithAttachments(text, pasteChips.getAttachments());
  try {
    enterChatMode();
    await chat.send(fullText);
    pasteChips.clear();
  } catch (err: any) {
    showToast(`${t('toast.sendFailed')}: ${err?.message || err}`);
    console.error('[pure] sendMessage failed:', err);
  } finally {
    sendBtn.disabled = !promptEl.value.trim() && !pasteChips.hasAttachments();
    focusPromptCaretEnd();
    refreshSidebarSessions();
    flushQueued();
  }
}

/** Focus the bottom input with the caret at the end of its content. */
function focusPromptCaretEnd() {
  promptEl.focus();
  const len = promptEl.value.length;
  promptEl.setSelectionRange(len, len);
}

/** Match the bottom input's auto-resize so programmatic value sets grow the box. */
function autoResizePrompt() {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px';
}

/** Auto-send a message queued with Enter while the assistant was generating. */
function flushQueued() {
  if (!queuedWhileStreaming) return;
  const text = queuedWhileStreaming;
  queuedWhileStreaming = null;
  // The input stays live during generation, so the user may have already
  // started typing a new draft. Never clobber it AND never drop the queue:
  // send the queued message (it was typed first) while leaving the draft
  // untouched in the input for the next turn.
  if (promptEl.value.trim()) {
    void doSend(text);
    return;
  }
  promptEl.value = text;
  autoResizePrompt();
  promptEl.placeholder = t('input.placeholder');
  sendMessage(promptEl);
}

// ── Sidebar: new chat ──

const sidebarToggle = document.getElementById('sidebar-toggle') as HTMLButtonElement;
const sidebar = document.getElementById('sidebar')!;

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  // The picker button is hidden when the sidebar collapses — don't leave a
  // floating popover behind.
  if (sidebar.classList.contains('collapsed')) {
    closeWorkspacePopover();
  }
});

// ── Workspace picker (sidebar top): toggle + commit ──

const workspacePickerBtn = document.getElementById('workspace-picker-btn');
// The sidebar chip is now the same fast path as the input-box folder icons:
// one click opens the native folder dialog (or the simplified popover with
// recents in browser/dev mode, where no native dialog exists).
workspacePickerBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  void browseWorkspace();
});

// ── Input-box folder buttons: one click opens the native folder dialog ──
// (same fast path as the sidebar chip). In browser/dev mode, where there is no
// native dialog, fall back to opening the workspace popover instead.
for (const id of ['landing-ws-btn', 'input-ws-btn']) {
  document.getElementById(id)?.addEventListener('click', (e) => {
    e.stopPropagation();
    void browseWorkspace();
  });
}

// The status-footer workspace shortcut opens the same native folder picker.
document.getElementById('status-workspace')?.addEventListener('click', (e) => {
  e.stopPropagation();
  void browseWorkspace();
});

// The sidebar workspace path shortcut lets users re-pick the folder without
// opening the sidebar popover first.
const sidebarPathBar = document.getElementById('sidebar-workspace-path');
if (sidebarPathBar) {
  sidebarPathBar.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.sidebar-workspace-path-clear')) return;
    void browseWorkspace();
  });
  // Keyboard parity (the bar is role=button): Enter/Space re-picks. The nested
  // clear button keeps its own activation — return BEFORE preventDefault.
  sidebarPathBar.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if ((e.target as HTMLElement).closest('.sidebar-workspace-path-clear')) return;
    e.preventDefault();
    void browseWorkspace();
  });
}
document.getElementById('sidebar-workspace-path-clear')?.addEventListener('click', (e) => {
  e.stopPropagation();
  void commitWorkspace('');
});

// The popover's single current-path row is clickable too: it opens the same
// native picker (in browser/dev mode this re-opens the already-open popover,
// where the recents below remain the actionable list). Clicks on the clear
// (×) button are handled separately and must not trigger the picker.
document.getElementById('wp-current-row')?.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('#wp-clear-btn')) return;
  e.stopPropagation();
  void browseWorkspace();
});
// Keyboard parity with the old <button> row: Enter/Space picks a folder.
// The nested clear (×) button must keep its own native keyboard activation,
// so its keydown returns BEFORE preventDefault (otherwise Enter/Space on the
// focused clear button would be swallowed by this row-level handler).
document.getElementById('wp-current-row')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    if ((e.target as HTMLElement).closest('#wp-clear-btn')) return;
    e.preventDefault();
    void browseWorkspace();
  }
});
// Restore the ability to clear a session's workspace (was lost when the old
// popover input row was simplified away): a small × on the current-path row.
document.getElementById('wp-clear-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  void commitWorkspace('');
});

// Close the popover on outside click (input's own keydown stays live).
document.addEventListener('click', (e) => {
  const popover = document.getElementById('workspace-picker-popover');
  if (!popover || popover.classList.contains('hidden')) return;
  if (popover.contains(e.target as Node) || workspacePickerBtn?.contains(e.target as Node)) return;
  closeWorkspacePopover();
});

// ── Sidebar: new chat ──

sidebarNewChat.addEventListener('click', () => {
  chat.clear();
  goToLanding();
  landingPrompt.focus();
  setActiveSession(null);
  // A fresh session is independent: it starts with no workspace.
  sessionWorkspace = '';
  chat.setWorkspace('');
  updateWorkspacePicker();
});

// ── Sidebar: settings ──

sidebarSettingsBtn.addEventListener('click', () => {
  closeWorkspacePopover();
  settings.open();
});

// ── Right-side floating settings button ──

const rightSettingsBtn = document.getElementById('right-settings-btn') as HTMLButtonElement;
if (rightSettingsBtn) {
  rightSettingsBtn.addEventListener('click', () => {
    closeWorkspacePopover();
    settings.open();
  });
}

const contextPanel = document.getElementById('context-panel');
const contextPanelReopen = document.getElementById('context-panel-reopen');

function setContextPanelCollapsed(collapsed: boolean) {
  if (!contextPanel || !contextPanelReopen) return;
  contextCollapsed = collapsed;
  contextPanel.classList.toggle('collapsed', collapsed);
  document.getElementById('main')?.classList.toggle('context-collapsed', collapsed);
  // The edge toggle stays visible in both states — only its arrow flips:
  // pointing right while the panel is open (collapse), left while collapsed
  // (expand). The hidden attribute is reserved for settings mode (see the
  // SettingsPanel open/close callbacks above).
  const contextLabel = collapsed ? t('context.show') : t('context.hide');
  contextPanelReopen.setAttribute('aria-label', contextLabel);
  contextPanelReopen.title = contextLabel;
  const poly = contextPanelReopen.querySelector('polyline');
  if (poly) poly.setAttribute('points', collapsed ? '15 18 9 12 15 6' : '9 18 15 12 9 6');
}

contextPanelReopen?.addEventListener('click', () => setContextPanelCollapsed(!contextCollapsed));

// Both sidebars start collapsed: the right context panel begins hidden and its
// edge toggle flips to the left-pointing "expand" arrow (the left sidebar's
// collapsed class lives in index.html).
setContextPanelCollapsed(true);

document.querySelectorAll<HTMLButtonElement>('[data-context-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    const selected = tab.dataset.contextTab;
    document.querySelectorAll<HTMLButtonElement>('[data-context-tab]').forEach((item) => {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll<HTMLElement>('[data-context-view]').forEach((view) => {
      view.classList.toggle('hidden', view.dataset.contextView !== selected);
    });
  });
});

// ── In-app confirm dialog ──
// Tauri's WKWebView does NOT implement window.confirm(): calling it silently
// returns false, which made the session delete button a no-op. Render a real
// dialog instead and resolve a promise with the user's choice.
// One dialog at a time: a second confirmDialog() call while one is open (e.g.
// a rapid double-click before the overlay intercepts) must not stack a second
// set of listeners on the same buttons — resolve the pending one as "no" and
// let the newest call own the overlay.
let pendingConfirm: { resolve: (v: boolean) => void } | null = null;

function confirmDialog(message: string): Promise<boolean> {
  if (pendingConfirm) {
    pendingConfirm.resolve(false);
    pendingConfirm = null;
  }
  return new Promise((resolve) => {
    pendingConfirm = { resolve };
    const overlay = document.getElementById('confirm-overlay') as HTMLDivElement;
    const messageEl = document.getElementById('confirm-message') as HTMLDivElement;
    const okBtn = document.getElementById('confirm-ok') as HTMLButtonElement;
    const cancelBtn = document.getElementById('confirm-cancel') as HTMLButtonElement;

    messageEl.textContent = message;
    overlay.classList.remove('hidden');
    cancelBtn.focus();

    const cleanup = () => {
      if (pendingConfirm?.resolve === resolve) pendingConfirm = null;
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKeydown);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onKeydown = (e: KeyboardEvent) => {
      // Esc cancels; Enter deliberately does NOT confirm — the focus sits on
      // the Cancel button, and a habitual Enter on a destructive dialog must
      // never delete data.
      if (e.key === 'Escape') onCancel();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeydown);
  });
}

// ── Sidebar sessions ──

let currentActiveId: string | null = null;

// ── Collapsible session groups (persisted per workspace) ──

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

let collapsedGroups = loadCollapsedGroups();

function toggleGroupCollapsed(key: string): void {
  if (collapsedGroups.has(key)) {
    collapsedGroups.delete(key);
  } else {
    collapsedGroups.add(key);
  }
  saveCollapsedGroups(collapsedGroups);
}

function setActiveSession(id: string | null) {
  currentActiveId = id;
  document.querySelectorAll('.sidebar-session-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-sid') === id);
  });
}

async function refreshSidebarSessions() {
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
      const collapsed = collapsedGroups.has(key);
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
    setActiveSession(currentActiveId);

    // Toggle group collapse on header click
    container.querySelectorAll('.sidebar-session-group-label').forEach(el => {
      el.addEventListener('click', () => {
        const group = el.closest('.sidebar-session-group') as HTMLElement | null;
        if (!group) return;
        // The header button carries the same data-group as the one used to
        // render the group — read it directly from the clicked element.
        const key = el.getAttribute('data-group') || '';
        toggleGroupCollapsed(key);
        const nowCollapsed = collapsedGroups.has(key);
        group.classList.toggle('collapsed', nowCollapsed);
        el.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
      });
    });

    // Click session → load it
    container.querySelectorAll('.sidebar-session-item').forEach(el => {
      el.addEventListener('click', (e) => {
        const sid = el.getAttribute('data-sid');
        if (sid && !(e.target as HTMLElement).closest('.sidebar-session-delete')) {
          loadAndDisplaySession(sid);
        }
      });
    });

    // Delete session
    container.querySelectorAll('.sidebar-session-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sid = btn.getAttribute('data-sid');
        if (!sid) return;
        if (!(await confirmDialog(t('confirm.deleteSession')))) return;
        try {
          await deleteSession(sid);
        } catch (err) {
          console.error('[pure] deleteSession failed:', err);
          showToast(t('toast.deleteFailed'));
          return;
        }
        if (currentActiveId === sid) {
          chat.clear();
          goToLanding();
          setActiveSession(null);
          sessionWorkspace = '';
          chat.setWorkspace('');
          updateWorkspacePicker();
        }
        refreshSidebarSessions();
      });
    });
  } catch {
    container.innerHTML = `<div class="sidebar-session-empty">${t('session.loadError')}</div>`;
  }
}

// ── Sidebar: delete all sessions ──

const sidebarSessionsClear = document.getElementById('sidebar-sessions-clear') as HTMLButtonElement;
if (sidebarSessionsClear) {
  sidebarSessionsClear.addEventListener('click', async () => {
    if (!(await confirmDialog(t('confirm.deleteAllSessions')))) return;
    try {
      await deleteAllSessions();
    } catch (err) {
      console.error('[pure] deleteAllSessions failed:', err);
      showToast(t('toast.deleteFailed'));
      return;
    }
    chat.clear();
    goToLanding();
    setActiveSession(null);
    sessionWorkspace = '';
    chat.setWorkspace('');
    updateWorkspacePicker();
    refreshSidebarSessions();
    showToast(t('toast.sessionsCleared'));
  });
}

async function loadAndDisplaySession(id: string) {
  const loaded = await loadSession(id);
  if (!loaded || loaded.messages.length === 0) return;
  queuedWhileStreaming = null;
  // A different session's pending pastes must not leak into this transcript.
  pasteChips.clear();
  // Abort any in-flight generation first: the old send() loop must not keep
  // appending to (or persisting into) the session we're about to switch to.
  // chat.setSessionId also bumps the generation guard, which is the second
  // line of defense (see ChatController.send).
  chat.cancel();
  chat.setSessionId(id);
  // Restore this session's own workspace ('' = none) — sessions are
  // independent, so there is no global-default fallback. Set it BEFORE
  // rendering so clickable relative paths in the transcript resolve against
  // the restored workspace.
  sessionWorkspace = loaded.workspace || '';
  chat.setWorkspace(sessionWorkspace);
  await chat.syncEffectiveWorkspace();
  renderSessionMessages(loaded.messages);
  updateWorkspacePicker();
  setActiveSession(id);
  focusPromptCaretEnd();
}

// ── Theme: respond to system preference change ──

const darkModeMedia = window.matchMedia('(prefers-color-scheme: dark)');
darkModeMedia.addEventListener('change', () => {
  const cfg = loadConfig();
  if (cfg?.theme === 'system') {
    document.documentElement.setAttribute('data-theme', darkModeMedia.matches ? 'dark' : 'light');
  }
});

// ── Global keyboard shortcuts ──

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault();
    if (settings.isVisible()) {
      settings.close();
    } else {
      closeWorkspacePopover();
      settings.open();
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault();
    if (!settings.isVisible()) {
      closeWorkspacePopover();
      chat.clear();
      goToLanding();
      landingPrompt.focus();
      sessionWorkspace = '';
      chat.setWorkspace('');
      updateWorkspacePicker();
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault();
    sidebar.classList.toggle('collapsed');
    // Same as the sidebarToggle click handler: don't leave a floating popover
    // when the sidebar (and its picker button) collapse.
    if (sidebar.classList.contains('collapsed')) {
      closeWorkspacePopover();
    }
  }
  if (e.key === 'Escape') {
    if (settings.isVisible()) {
      settings.close();
    }
    if (!document.getElementById('workspace-picker-popover')!.classList.contains('hidden')) {
      closeWorkspacePopover();
    }
  }
});
