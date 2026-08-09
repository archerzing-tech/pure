// src/ui/main.ts
// App shell: wires the domain controllers together and owns the chat
// transcript + composer. Extracted concerns live in:
//   • ./workspace.ts      — workspace picker, drag & drop, file attach
//   • ./sessionSidebar.ts — session list, grouping, deletion
//   • ./settings.ts       — settings panel (lazy-loaded on first open)
//   • ../shared/providers.ts — provider metadata (labels / default models)

import { ChatController, bindAssistantBubbleCopy, wireTranscriptPrune } from './chat';
import { loadConfig, hasConfiguredKey, defaults, STORAGE_KEY, invalidateConfigCache, type PureConfig } from './config';
import type { SettingsPanel } from './settings';
import { getStoredThinkingSegments, type StoredMessage, type ToolExecMeta } from './store';
import { estimateCostUsd, formatCostUsd, formatTokens } from '../shared/usage';
import { escapeHtml } from '../shared/html';
import { buildExportSavedToast } from './statsExportToast';
import { stripUserTurnContext } from '../shared/promptLayers';
import { checkForUpdatesSilently, fetchAppVersion } from './updater';
import { t, updateLanguage } from '../shared/i18n';
import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { loadSessionList, loadSessionStatsForList, type SessionMeta, type SessionStats } from './store';
import type { Language as I18nLanguage } from '../shared/i18n';
import { showToast, showToastHtml } from '../shared/toast';
import { copyTextToClipboard } from '../shared/clipboard';
import { providerLabel, providerDef, PROVIDERS, defaultModelFor, type ProviderId } from '../shared/providers';
import { renderMarkdown, stripToolCallXml } from './markdown';
import { createToolRow, finalizeToolRow } from './toolRow';
import { appendStoredThinking } from './thinkingCard';
import { wireScrollPin, scrollChatToBottomIfPinned, forceScrollToBottom } from './scrollPin';
import { initPathLinks, linkifyPaths, openPathLink } from './pathLink';
import { PasteChipManager, composeMessageWithAttachments } from './pasteChip';
import { showConfirmModal } from './modal';
import { WorkspaceController } from './workspace';
import { SessionSidebar } from './sessionSidebar';

const chat = new ChatController();

// ── Oversized-paste chips (see pasteChip.ts) ──
// Pastes above 64KB become a file chip (saved to ~/.pure/tmp/<session-id>/)
// instead of jamming the textarea; double-click opens a viewer. Both the
// bottom input bar and the landing input mount a chip row sharing one list.
const pasteChips = new PasteChipManager(() => chat.getSessionId(), () => {
  // Attachments enable send-with-no-text and tint the composer attach button.
  const has = pasteChips.hasAttachments();
  document.querySelectorAll('.attach-btn').forEach(b => b.classList.toggle('has-attachments', has));
  enableInputIfReady();
});  pasteChips.mount(document.getElementById('composer-box')!);
  pasteChips.mount(document.getElementById('landing-input-wrap')!);

// ── App controllers ──
// `sessionSidebar` is declared before `workspace` so the workspace's onCommitted
// callback can close over it without a forward-reference; the callbacks only
// fire on user interaction (after both are initialized), never during module
// evaluation.
let sessionSidebar: SessionSidebar;

const workspace = new WorkspaceController({
  chat,
  pasteChips,
  onWorkspaceChanged: () => {
    updateStatusBar();
  },
  onAttachmentsChanged: () => {
    enableInputIfReady();
  },
  onCommitted: () => {
    sessionSidebar.refresh();
  },
});

sessionSidebar = new SessionSidebar({
  chat,
  pasteChips,
  confirm: confirmDialog,
  renderMessages: renderSessionMessages,
  focusPrompt: focusPromptCaretEnd,
  onSessionActivated: () => {
    queuedWhileStreaming = null;
    workspace.refresh();
    updateContextPanelStage();
  },
  onChatCleared: () => {
    goToLanding();
    workspace.refresh();
    updateContextPanelStage();
  },
});

// ── Settings panel: lazy-loaded on first open so the eager startup bundle
//    stays lean. The panel binds its DOM (index.html) when constructed. ──

let settingsPanelPromise: Promise<SettingsPanel> | null = null;

function getSettingsPanel(): Promise<SettingsPanel> {
  if (!settingsPanelPromise) {
    settingsPanelPromise = import('./settings')
      .then(({ SettingsPanel }) =>
        new SettingsPanel(
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
        ),
      )
      // A failed import/construction must not brick the panel for the whole
      // session: reset the cached promise so the next open retries.
      .catch((err) => {
        settingsPanelPromise = null;
        throw err;
      });
  }
  return settingsPanelPromise;
}

async function openSettings(): Promise<void> {
  (await getSettingsPanel()).open();
}

async function closeSettings(): Promise<void> {
  (await getSettingsPanel()).close();
}

async function settingsVisible(): Promise<boolean> {
  return (await getSettingsPanel()).isVisible();
}

let hasStartedChat = false;
let contextCollapsed = false;
let contextCollapsedBeforeSettings = false;

// App version cached from fetchAppVersion() — shown in the status footer.
let appVersion = '';

// Message typed while the assistant is generating — queued and auto-sent when
// the current turn finishes (Claude Code behavior, so the input stays live).
let queuedWhileStreaming: string | null = null;

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
  }
});

function onConfigSaved() {
  // Each session owns its workspace independently (persisted with the
  // session); a settings save must never touch the current chat's workspace.
  workspace.refresh();
  updateSidebarModel();
  updateContextPanelStage();
  enableInputIfReady();
  // The composer's mode/model dropdowns mirror the persisted config — a
  // settings save (provider/model change, language switch) must re-sync them.
  populateComposerSelects();
}

// ── DOM refs ──
const chatView = document.getElementById('chat-view')!;
const promptEl = document.getElementById('prompt') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const landingPrompt = document.getElementById('landing-prompt') as HTMLTextAreaElement;
const landingSend = document.getElementById('landing-send-btn') as HTMLButtonElement;
const sidebarNewChat = document.getElementById('sidebar-new-chat') as HTMLButtonElement;
const sidebarSettingsBtn = document.getElementById('sidebar-settings-btn') as HTMLButtonElement;

// ── Composer quick selectors (mode + model) ──
// Both the chat composer and the landing hero have the same pair of frameless
// dropdowns that write straight into the config the Settings panel uses
// (config.taskMode, provider + model). populateComposerSelects() rebuilds the
// <option> lists and re-syncs the values — it is called on boot and after
// every settings save so the selects always mirror the persisted config. The
// change listeners are attached ONCE in wireComposerSelects (to the <select>
// elements, not the options), so re-populating never duplicates them.

const MODE_SELECT_IDS = ['composer-mode-select', 'landing-mode-select'] as const;
const MODEL_SELECT_IDS = ['composer-model-select', 'landing-model-select'] as const;

function populateModeSelect(sel: HTMLSelectElement, cfg: PureConfig): void {
  const modes: Array<[PureConfig['taskMode'], string]> = [
    ['auto', t('composer.mode.auto')],
    ['yolo', t('composer.mode.yolo')],
    ['plan', t('composer.mode.plan')],
    ['build', t('composer.mode.build')],
  ];
  sel.innerHTML = '';
  for (const [value, label] of modes) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  sel.value = cfg.taskMode ?? 'auto';
}

function populateModelSelect(sel: HTMLSelectElement, cfg: PureConfig): void {
  const provider = cfg.provider;
  const model = cfg.model?.trim() || defaultModelFor(provider);
  // One option per known provider (its default model), labeled with the full
  // display name (t(i18nKey)) so the two DeepSeek entries — same label +
  // same default model, different API protocol — stay distinguishable. A
  // custom model typed into Settings is appended with a UNIQUE value
  // ("<provider>:custom") so the select can actually point at it; a plain
  // provider value would resolve to the first matching default option and
  // silently display the wrong model.
  sel.innerHTML = '';
  const isCustom = !PROVIDERS.some((p) => p.id === provider && p.defaultModel === model);
  let selectedValue: string = provider;
  for (const p of PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.dataset.model = p.defaultModel;
    opt.textContent = `${t(p.i18nKey)} · ${p.defaultModel}`;
    sel.appendChild(opt);
  }
  if (isCustom) {
    const opt = document.createElement('option');
    opt.value = `${provider}:custom`;
    opt.dataset.model = model;
    // Same label style as the default options (t(i18nKey)) so a custom model
    // stays visually consistent (e.g. "DeepSeek (OpenAI)" not "DeepSeek").
    opt.textContent = `${t(providerDef(provider)?.i18nKey ?? provider)} · ${model}`;
    sel.appendChild(opt);
    selectedValue = `${provider}:custom`;
  }
  sel.value = selectedValue;
}

function populateComposerSelects(): void {
  const cfg = loadConfig() ?? defaults();
  for (const id of MODE_SELECT_IDS) {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (sel) populateModeSelect(sel, cfg);
  }
  for (const id of MODEL_SELECT_IDS) {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (sel) populateModelSelect(sel, cfg);
  }
}

function wireModeSelect(sel: HTMLSelectElement): void {
  sel.addEventListener('change', () => {
    const cfg = loadConfig() ?? defaults();
    cfg.taskMode = sel.value as PureConfig['taskMode'];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    invalidateConfigCache();
    showToast(t('composer.modeSaved'));
  });
}

function wireModelSelect(sel: HTMLSelectElement): void {
  sel.addEventListener('change', () => {
    const cfg = loadConfig() ?? defaults();
    const opt = sel.selectedOptions[0];
    // Custom entries carry a "<provider>:custom" value so they stay
    // distinct from the plain provider option (see populate above).
    const raw = sel.value;
    const providerId = raw.endsWith(':custom') ? raw.slice(0, -':custom'.length) : raw;
    cfg.provider = providerId as ProviderId;
    cfg.model = opt?.dataset.model || defaultModelFor(providerId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    invalidateConfigCache();
    // updateSidebarModel() cascades into the status footer + context panel.
    updateSidebarModel();
    showToast(t('composer.modelSaved'));
  });
}

function wireComposerSelects(): void {
  for (const id of MODE_SELECT_IDS) {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (sel) wireModeSelect(sel);
  }
  for (const id of MODEL_SELECT_IDS) {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (sel) wireModelSelect(sel);
  }
  populateComposerSelects();
}

// ── Context panel display ──

function updateContextPanelModel() {
  const cfg = loadConfig();
  const model = document.getElementById('context-model');
  if (!model) return;
  model.textContent = cfg?.model ? `${providerLabel(cfg.provider)} · ${cfg.model}` : (cfg?.provider ? providerLabel(cfg.provider) : t('context.model.notConfigured'));
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
  updateStatusBar();
}

// ── Boot splash ──
// The branded splash (index.html #boot-splash) covers the window from first
// paint while the app initializes. dismissBootSplash() reveals the landing
// once it has been painted AND a short minimum display time has passed, so
// fast machines get a smooth transition instead of a blink. A pure-CSS
// failsafe hides the splash after 6s even if this module never runs.
const bootStartedAt = performance.now();

function dismissBootSplash(minVisibleMs = 450): void {
  const splash = document.getElementById('boot-splash');
  if (!splash) return;
  const wait = Math.max(0, minVisibleMs - (performance.now() - bootStartedAt));
  setTimeout(() => {
    // Two rAFs guarantee the landing page has actually painted before the
    // fade starts — otherwise the reveal could flash a blank background.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      splash.classList.add('boot-dismiss');
      document.getElementById('chat-view')?.classList.add('boot-reveal');
      const remove = () => splash.remove();
      splash.addEventListener('transitionend', remove, { once: true });
      setTimeout(remove, 600); // fallback if transitionend never fires
    }));
  }, wait);
}

/** Run non-essential work after the landing is revealed, in idle slots
 * (falls back to a short timeout where requestIdleCallback is missing). */
function deferToIdle(fn: () => void): void {
  const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) {
    idle(() => fn(), { timeout: 500 });
  } else {
    setTimeout(fn, 200);
  }
}

// ── Init ──
// Startup is split into a CRITICAL path and a DEFERRED path so the landing
// page becomes interactive as early as possible:
//   • critical — theme/language (applySavedAppearance), landing mode, the
//     composer's mode/model dropdowns and input enablement: everything the
//     landing hero needs. dismissBootSplash() runs as soon as this finishes.
//   • deferred — status-bar chrome, session list, drag & drop, version fetch:
//     all safe to run in idle slots after the first reveal, so none of it can
//     delay the first paint or the splash transition.
(async () => {
  applySavedAppearance();
  chat.setWorkspace('');
  wireComposerSelects();
  checkLandingState();
  enableInputIfReady();
  dismissBootSplash();

  deferToIdle(() => {
    // Error isolation: a throw in any single deferred step must not silently
    // skip the rest (e.g. an unbound session sidebar for the whole session).
    try {
      workspace.refresh();
      updateSidebarModel();
      updateContextPanelStage();
      sessionSidebar.refresh();
      workspace.init();
      sessionSidebar.init();
      initPathLinks();
      // Stats panel: subscribe to per-session updates + draw the empty state.
      chat.onSessionStatsChanged(() => renderSessionStats());
      renderSessionStats();
      void fetchAppVersion().then((version) => {
        appVersion = version;
        const el = document.getElementById('landing-version');
        if (el) el.textContent = `v${version}`;
        updateStatusBar();
      });
    } catch (err) {
      console.error('[pure] deferred init failed:', err);
    }
  });
  setTimeout(() => checkForUpdatesSilently(), 3000);
})().catch(err => {
  console.error('[pure] init failed:', err);
  dismissBootSplash();
});

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
  syncLandingHasText();
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

async function renderSessionMessages(messages: StoredMessage[]) {
  enterChatMode();
  chat.loadFromStorage(messages);

  const chatEl = document.getElementById('chat')!;
  chatEl.innerHTML = '';
  // Same coalesced scroll machinery as live streaming (chat.ts), so the
  // one-shot restore scroll joins the shared rAF budget instead of forcing a
  // synchronous full-transcript layout at the end of the restore.
  wireScrollPin(chatEl);
  wireTranscriptPrune(chatEl);
  // Loading notice while the transcript replays: a long session restores
  // bubble-by-bubble with rAF yields (seconds), so without feedback the app
  // looks frozen. Removed in the finally below on success or failure.
  const loadingRow = document.createElement('div');
  loadingRow.className = 'bubble-row status loading';
  const loadingBubble = document.createElement('div');
  loadingBubble.className = 'bubble status';
  loadingBubble.textContent = t('session.restoring');
  loadingRow.appendChild(loadingBubble);
  chatEl.appendChild(loadingRow);
  const toolExecs: ToolExecMeta[] = [];
  // Restoring a long session must not block the GUI: each bubble's markdown
  // pass (marked parse + sanitize + hljs + linkify) is effectively synchronous
  // for plain content, so yield to the browser between bubbles for a paint and
  // input processing instead of rendering the whole transcript in one burst.
  const yieldToUI = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));

  try {
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
      // Per-request task context (<task_context> block, see promptLayers.ts) is
      // for the model only — strip it so replay never shows it in the user's
      // own bubble.
      bubble.textContent = stripUserTurnContext(m.content);
      linkifyPaths(bubble);
      wrapper.appendChild(bubble);
      chatEl.appendChild(wrapper);
    }
    // Let the browser paint + process input between bubbles.
    await yieldToUI();
  }
  flushToolExecs(toolExecs, chatEl);
  } finally {
    loadingRow.remove();
  }
  // A session restore rebuilds the transcript from scratch, so it always
  // lands at the newest content — force the pin state the same way a fresh
  // stream would, then scroll through the shared coalesced helper.
  forceScrollToBottom(chatEl);
  // The restored session's stats belong to the same conversation id —
  // re-render the 统计 tab so the panel matches the transcript.
  renderSessionStats();
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

// The landing send button fades in once the user has typed something (or the
// box has focus). Because the send button now lives in the toolbar row below
// the prompt, the old `:not(:placeholder-shown) ~ #landing-send-btn` sibling
// selector no longer matches — a .has-text class on the wrap drives the same
// reveal from JS (see #landing-input-wrap.has-text in styles.css).
function syncLandingHasText(): void {
  const wrap = document.getElementById('landing-input-wrap');
  if (wrap) wrap.classList.toggle('has-text', !!landingPrompt.value.trim());
}

// ── Input event profiling (performance.measure) ──
// Records each input event's synchronous handler cost (auto-resize, send
// button state) so the jank fixes — no per-keystroke forced layout, purely
// compositor sidebar animation, #chat layout containment — can be verified
// numerically. Every INPUT_PROFILE_WINDOW events a compact summary logs to
// the console; per-event records are inspectable via
// performance.getEntriesByType('measure'); an on-demand dump is available as
// window.__pureInputProfile().
const INPUT_PROFILE_WINDOW = 200;

interface InputProfileStats {
  count: number;
  max: number;
  recent: number[];
}

const inputProfileStats = new Map<string, InputProfileStats>();

function logInputProfileSummary(name: string, s: InputProfileStats): void {
  const recent = s.recent;
  const sorted = [...recent].sort((a, b) => a - b);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  console.log(
    `[pure] input profile "${name}" — ${recent.length} events · avg ${avg.toFixed(2)}ms · p95 ${p95.toFixed(2)}ms · max ${s.max.toFixed(2)}ms`,
  );
}

function recordInputProfile(name: string, duration: number): void {
  let s = inputProfileStats.get(name);
  if (!s) {
    s = { count: 0, max: 0, recent: [] };
    inputProfileStats.set(name, s);
  }
  s.count += 1;
  s.max = Math.max(s.max, duration);
  s.recent.push(duration);
  if (s.recent.length > INPUT_PROFILE_WINDOW) s.recent.shift();
  if (s.count % INPUT_PROFILE_WINDOW === 0) logInputProfileSummary(name, s);
}

/** Run fn under a performance.measure record named `input:${name}`. */
function profileInput(name: string, fn: () => void): void {
  const startMark = `input:${name}:${performance.now()}`;
  performance.mark(startMark);
  const start = performance.now();
  fn();
  const duration = performance.now() - start;
  try {
    performance.measure(`input:${name}`, startMark);
  } catch {
    // The start mark may have been evicted from the performance buffer — the
    // manual now() delta above is the source of truth for the stats.
  }
  recordInputProfile(name, duration);
}

function dumpInputProfiles(): void {
  if (inputProfileStats.size === 0) {
    console.log('[pure] input profile: no data yet — type in either composer.');
    return;
  }
  for (const [name, s] of inputProfileStats) logInputProfileSummary(name, s);
}

const profileGlobal = window as unknown as { __pureInputProfile: () => void };
profileGlobal.__pureInputProfile = dumpInputProfiles;

landingPrompt.addEventListener('input', () => {
  profileInput('landing', () => {
    // Only write when the height actually changed — see autoResizePrompt() for
    // why per-keystroke forced layout stalls sidebar animations.
    const next = Math.min(landingPrompt.scrollHeight, 200);
    if (landingPrompt.style.height !== `${next}px`) {
      landingPrompt.style.height = `${next}px`;
    }
    syncLandingHasText();
    if (!chat.isStreaming()) {
      landingSend.disabled = !landingPrompt.value.trim() && !pasteChips.hasAttachments();
    }
  });
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
  profileInput('chat', () => {
    autoResizePrompt();
    if (!chat.isStreaming()) {
      sendBtn.disabled = !promptEl.value.trim() && !pasteChips.hasAttachments();
    }
  });
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
    void openSettings();
    return;
  }

  sourceEl.value = '';
  sourceEl.style.height = 'auto';
  if (sourceEl === landingPrompt) {
    landingSend.disabled = true;
    syncLandingHasText();
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
    void openSettings();
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
    // A conversation created from the landing page never went through
    // SessionSidebar.load(), so the sidebar didn't know it was active — deleting
    // it then left a stale transcript instead of returning to the landing view.
    // Marking the current session active on every send keeps delete-in-place
    // (resetToLanding) and the list highlight correct.
    sessionSidebar.setActive(chat.getSessionId());
    sessionSidebar.refresh();
    flushQueued();
  }
}

/** Focus the bottom input with the caret at the end of its content. */
function focusPromptCaretEnd() {
  promptEl.focus();
  const len = promptEl.value.length;
  promptEl.setSelectionRange(len, len);
}

/**
 * Match the bottom input's auto-resize so programmatic value sets grow the
 * box. Writing style.height twice per keystroke forces a synchronous layout
 * (style write → scrollHeight read → write) that steals the main thread and
 * makes sidebar width animations jank while typing — so only touch the DOM
 * when the height actually changed.
 */
function autoResizePrompt() {
  profileInput('autoresize', () => {
    const next = Math.min(promptEl.scrollHeight, 120);
    if (promptEl.style.height !== `${next}px`) {
      promptEl.style.height = `${next}px`;
    }
  });
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

// The chat view carries a 0.4s width transition for the settings-mode
// squeeze (#chat-view.squeezed). A sidebar toggle reclaims flex width in a
// SINGLE layout at the end of its transform tween — without this guard that
// snap would replay a per-frame width animation on the chat area (composer
// included) right while the user might be typing. Drop the transition for
// the duration of the tween so the chat area snaps with the sidebar instead.
// The 600ms restore covers the longest reclaim (context panel: 0.35s tween +
// 0.35s width delay) — keep it in sync with those durations if they change.
function withChatWidthSnap(action: () => void) {
  const main = document.getElementById('main');
  const chatView = document.getElementById('chat-view');
  if (!main || !chatView || main.classList.contains('settings-mode')) {
    action();
    return;
  }
  chatView.style.transition = 'none';
  // Schedule the restore BEFORE running the action so a synchronous throw
  // can never leave the chat view permanently transition-less.
  window.setTimeout(() => {
    chatView.style.transition = '';
  }, 600);
  action();
}

sidebarToggle.addEventListener('click', () => {
  withChatWidthSnap(() => sidebar.classList.toggle('collapsed'));
  // The picker button is hidden when the sidebar collapses — don't leave a
  // floating popover behind.
  if (sidebar.classList.contains('collapsed')) {
    workspace.closePopover();
  }
});

sidebarNewChat.addEventListener('click', () => {
  chat.clear();
  goToLanding();
  landingPrompt.focus();
  sessionSidebar.setActive(null);
  // A fresh session is independent: it starts with no workspace.
  chat.setWorkspace('');
  workspace.refresh();
});

// ── Sidebar: settings ──

sidebarSettingsBtn.addEventListener('click', () => {
  workspace.closePopover();
  void openSettings();
});

// ── Right-side floating settings button ──

const rightSettingsBtn = document.getElementById('right-settings-btn') as HTMLButtonElement;
if (rightSettingsBtn) {
  rightSettingsBtn.addEventListener('click', () => {
    workspace.closePopover();
    void openSettings();
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

contextPanelReopen?.addEventListener('click', () => withChatWidthSnap(() => setContextPanelCollapsed(!contextCollapsed)));

// Both sidebars start collapsed: the right context panel begins hidden and its
// edge toggle flips to the left-pointing "expand" arrow (the left sidebar's
// collapsed class lives in index.html).
setContextPanelCollapsed(true);

// The right panel is now a single always-visible stats view (预览/变更/结构
// tabs were removed).

// Stats panel export menu (导出 → JSON / Markdown).
initStatsExportMenu();

// ── Per-session stats (右面板「统计」tab) ──
// Renders the CURRENT conversation's aggregated token usage, cache hit rate,
// estimated cost, and tool-activity history (searches / file reads+writes /
// commands). Refreshed on every completed turn, session switch, and restore.

function renderSessionStats() {
  const stats = chat.getSessionStats();
  const provider = stats.provider ?? loadConfig()?.provider ?? 'deepseek-openai';
  const cost = estimateCostUsd(stats.usage, provider);
  const setText = (id: string, v: string): void => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };

  setText('stat-input', formatTokens(stats.usage?.promptTokens));
  setText('stat-output', formatTokens(stats.usage?.completionTokens));
  setText('stat-cost', formatCostUsd(cost));

  const hit = stats.usage?.cacheHitTokens ?? 0;
  const miss = stats.usage?.cacheMissTokens ?? Math.max(0, (stats.usage?.promptTokens ?? 0) - hit);
  const total = hit + miss;
  const rate = total > 0 ? Math.round((hit / total) * 100) : null;
  setText('stat-cache-rate', rate === null ? '—' : `${rate}%`);
  setText('stat-cache-hit', formatTokens(hit));
  setText('stat-cache-miss', formatTokens(miss));
  const bar = document.getElementById('stat-cache-bar');
  if (bar) bar.style.width = rate === null ? '0%' : `${Math.max(2, Math.min(100, rate))}%`;

  setText('stat-search-count', String(stats.searches.length));
  setText('stat-write-count', String(stats.fileWrites.length));
  setText('stat-read-count', String(stats.fileReads.length));
  setText('stat-cmd-count', String(stats.commands.length));

  renderStatsList('stat-search-list', stats.searches, (s) => s.query);
  // File write/read entries carry the path: double-clicking opens the file
  // with the OS default app (via open_path). Commands/searches have no path.
  renderStatsList('stat-write-list', stats.fileWrites, (w) => (w.success ? '' : '✗ ') + w.path, (w) => w.path);
  renderStatsList('stat-read-list', stats.fileReads, (r) => r.path, (r) => r.path);
  renderStatsList('stat-cmd-list', stats.commands, (c) => (c.success ? '' : '✗ ') + c.command);
}

function renderStatsList<T>(
  id: string,
  items: T[],
  label: (item: T) => string,
  /** When given, each row becomes double-click-to-open with this path. */
  pathFor?: (item: T) => string,
): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (items.length === 0) {
    el.innerHTML = `<div class="stats-empty">${t('stats.empty')}</div>`;
    return;
  }
  // Newest first; cap the DOM so a long session can't flood the panel.
  const rows = items
    .slice()
    .reverse()
    .slice(0, 20)
    .map((item) => {
      const text = label(item);
      const path = pathFor ? pathFor(item) : '';
      const cls = path ? 'stats-list-item stats-list-item-openable' : 'stats-list-item';
      const title = path ? `${t('stats.dblclickOpen')} ${text}` : text;
      const dataAttr = path ? ` data-path="${escapeHtml(path)}"` : '';
      return `<div class="${cls}" title="${escapeHtml(title)}"${dataAttr}>${escapeHtml(text)}</div>`;
    })
    .join('');
  el.innerHTML = rows;
  if (!pathFor) return;
  // Double-click a file row → open with the OS default app (relative paths
  // resolve against the active workspace via openPathLink).
  el.querySelectorAll('.stats-list-item-openable').forEach((row) => {
    row.addEventListener('dblclick', () => {
      const p = (row as HTMLElement).getAttribute('data-path') ?? '';
      if (p) openPathLink(p);
    });
  });
}

// ── Stats export (导出: JSON / Markdown) ──
// Same save flow as markdown.ts code-block exports: native save dialog + the
// save_file invoke in Tauri, File System Access API then a download anchor in
// plain browser dev. Content builders are pure so they stay unit-testable.

function formatTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function buildStatsExportJson(stats: SessionStats, provider: string, meta?: SessionMeta): string {
  const cost = estimateCostUsd(stats.usage, provider);
  const hit = stats.usage?.cacheHitTokens ?? 0;
  const miss = stats.usage?.cacheMissTokens ?? Math.max(0, (stats.usage?.promptTokens ?? 0) - hit);
  const total = hit + miss;
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      sessionId: meta?.id,
      title: meta?.title,
      createdAt: meta?.createdAt,
      provider,
      usage: stats.usage ?? null,
      totalTokens: (stats.usage?.promptTokens ?? 0) + (stats.usage?.completionTokens ?? 0),
      cacheHitRate: total > 0 ? Math.round((hit / total) * 1000) / 10 : null,
      costUsd: cost,
      searches: stats.searches,
      fileWrites: stats.fileWrites,
      fileReads: stats.fileReads,
      commands: stats.commands,
    },
    null,
    2,
  );
}

function buildStatsExportMarkdown(stats: SessionStats, provider: string, meta?: SessionMeta): string {
  const cost = estimateCostUsd(stats.usage, provider);
  const hit = stats.usage?.cacheHitTokens ?? 0;
  const miss = stats.usage?.cacheMissTokens ?? Math.max(0, (stats.usage?.promptTokens ?? 0) - hit);
  const total = hit + miss;
  const rate = total > 0 ? `${Math.round((hit / total) * 100)}%` : '—';

  const lines: string[] = [
    '# 会话统计',
    '',
    // Archive header: the session title + first-message time make exported
    // reports self-identifying when collected into a folder of reports.
    ...(meta?.title ? [`> **${meta.title}**`] : []),
    ...(meta?.createdAt ? [`> 创建于 ${formatTs(meta.createdAt)}`] : []),
    ...(meta?.title || meta?.createdAt ? [''] : []),
    `- **Provider**: \`${provider}\``,
    `- **输入 tokens**: ${formatTokens(stats.usage?.promptTokens)}`,
    `- **输出 tokens**: ${formatTokens(stats.usage?.completionTokens)}`,
    `- **缓存命中**: ${formatTokens(hit)}（${rate}）`,
    `- **缓存未命中**: ${formatTokens(miss)}`,
    `- **总 tokens**: ${formatTokens((stats.usage?.promptTokens ?? 0) + (stats.usage?.completionTokens ?? 0))}`,
    `- **估算花费**: ${formatCostUsd(cost)}`,
    '',
    '## 搜索历史',
    ...(stats.searches.length
      ? stats.searches.map((s) => `- ${formatTs(s.ts)} — ${s.query}`)
      : ['暂无记录']),
    '',
    '## 文件写入',
    ...(stats.fileWrites.length
      ? stats.fileWrites.map((w) => `- ${formatTs(w.ts)} — ${w.success ? '✓' : '✗'} \`${w.path}\``)
      : ['暂无记录']),
    '',
    '## 文件读取',
    ...(stats.fileReads.length
      ? stats.fileReads.map((r) => `- ${formatTs(r.ts)} — \`${r.path}\``)
      : ['暂无记录']),
    '',
    '## 命令执行',
    ...(stats.commands.length
      ? stats.commands.map((c) => `- ${formatTs(c.ts)} — ${c.success ? '✓' : '✗'} \`${c.command}\``)
      : ['暂无记录']),
    '',
  ];
  return lines.join('\n');
}

/** Escape one CSV field per RFC 4180 (quotes doubled; commas/CRLF quoted). */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Build a spreadsheet-friendly CSV (long format: one row per activity entry,
 * prefixed by summary rows). The UTF-8 BOM makes Excel/Numbers detect the
 * encoding correctly instead of showing mojibake for the CJK column names.
 */
function buildStatsExportCsv(stats: SessionStats, provider: string, meta?: SessionMeta): string {
  const hit = stats.usage?.cacheHitTokens ?? 0;
  const miss = stats.usage?.cacheMissTokens ?? Math.max(0, (stats.usage?.promptTokens ?? 0) - hit);
  const total = hit + miss;
  const cost = estimateCostUsd(stats.usage, provider);
  const rows: string[] = [];
  const header = ['category', 'time', 'status', 'detail'].map(csvField).join(',');

  // Summary rows (category = summary; detail carries the value).
  rows.push(header);
  if (meta?.title) rows.push(['summary', 'session_title', '', meta.title].map(csvField).join(','));
  if (meta?.createdAt) rows.push(['summary', 'session_created', '', formatTs(meta.createdAt)].map(csvField).join(','));
  rows.push(['summary', 'provider', '', provider].map(csvField).join(','));
  rows.push(['summary', 'input_tokens', '', String(stats.usage?.promptTokens ?? 0)].map(csvField).join(','));
  rows.push(['summary', 'output_tokens', '', String(stats.usage?.completionTokens ?? 0)].map(csvField).join(','));
  rows.push(['summary', 'cache_hit_tokens', '', String(hit)].map(csvField).join(','));
  rows.push(['summary', 'cache_miss_tokens', '', String(miss)].map(csvField).join(','));
  rows.push(['summary', 'cache_hit_rate', '', total > 0 ? `${Math.round((hit / total) * 100)}%` : ''].map(csvField).join(','));
  rows.push(['summary', 'cost_usd', '', cost > 0 ? cost.toFixed(6) : ''].map(csvField).join(','));

  const pushRows = <T,>(
    category: string,
    items: T[],
    extract: (item: T) => { status: string; detail: string; ts: number },
  ): void => {
    for (const item of items) {
      const { status, detail, ts } = extract(item);
      rows.push([category, formatTs(ts), status, detail].map(csvField).join(','));
    }
  };

  pushRows('search', stats.searches, (s) => ({ status: '', detail: s.query, ts: s.ts }));
  pushRows('file_write', stats.fileWrites, (w) => ({ status: w.success ? 'ok' : 'fail', detail: w.path, ts: w.ts }));
  pushRows('file_read', stats.fileReads, (r) => ({ status: '', detail: r.path, ts: r.ts }));
  pushRows('command', stats.commands, (c) => ({ status: c.success ? 'ok' : 'fail', detail: c.command, ts: c.ts }));

  // \uFEFF BOM + CRLF line endings (the most spreadsheet-compatible combo).
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

/**
 * Save text through the native save dialog (Tauri: plugin-dialog save + the
 * dedicated save_file invoke) or the browser fallback (File System Access API
 * → download anchor). Returns the path saved to, or null when cancelled.
 */
async function saveStatsExport(content: string, filename: string, ext: string): Promise<string | null> {
  if (isTauriRuntime()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: filename, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return null; // cancelled
    const core = await loadTauriCore();
    if (!core) throw new Error('Tauri core unavailable');
    await core.invoke('save_file', { path, content });
    return path;
  }

  // Browser dev mode: File System Access API (Chrome/Edge).
  const w = window as unknown as {
    showSaveFilePicker?: (opts: {
      suggestedName?: string;
      types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<{
      createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }>;
    }>;
  };
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const mime = ext === 'json' ? 'application/json' : ext === 'csv' ? 'text/csv' : 'text/markdown';
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: ext.toUpperCase(), accept: { [mime]: [`.${ext}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([content], { type: 'text/plain;charset=utf-8' }));
      await writable.close();
      return filename;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null; // cancelled
      // Any other failure — fall through to the download fallback.
    }
  }

  // Last-resort download (works everywhere).
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return null;
}

/**
 * Save binary bytes (base64 over IPC in Tauri) via the native save dialog,
 * mirroring markdown.ts's saveImageFile flow: Tauri → save_file_binary,
 * browser File System Access API → download anchor fallback.
 */
async function saveStatsExportBinary(bytes: Uint8Array<ArrayBuffer>, filename: string, mime: string): Promise<string | null> {
  if (isTauriRuntime()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: filename, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
    if (!path) return null; // cancelled
    // Base64-encode the raw bytes for the save_file_binary IPC command.
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const dataBase64 = btoa(binary);
    const core = await loadTauriCore();
    if (!core) throw new Error('Tauri core unavailable');
    await core.invoke('save_file_binary', { path, dataBase64 });
    return path;
  }

  // Browser dev mode: File System Access API (Chrome/Edge).
  const w = window as unknown as {
    showSaveFilePicker?: (opts: {
      suggestedName?: string;
      types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<{
      createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }>;
    }>;
  };
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'ZIP', accept: { [mime]: ['.zip'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([bytes], { type: mime }));
      await writable.close();
      return filename;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null; // cancelled
    }
  }

  // Last-resort download (works everywhere).
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return null;
}

/**
 * Export EVERY session's stats as one ZIP archive: one JSON file per session
 * (named by its title, fallback to session id), plus a human-readable
 * README.md overview. Sessions without a stats.json are skipped.
 */
async function exportAllSessionStatsZip(): Promise<void> {
  let list: SessionMeta[] = [];
  try {
    list = await loadSessionList();
  } catch {
    showToast(`${t('toast.sendFailed')}: ${t('stats.export')}`);
    return;
  }
  if (list.length === 0) {
    showToast(t('stats.export.zipEmpty'));
    return;
  }

  const sessionIds = list.map((s) => s.id);
  const statsMap = await loadSessionStatsForList(sessionIds);
  const statsById = new Map(list.map((s) => [s.id, s]));
  const provider = loadConfig()?.provider ?? 'deepseek-openai';

  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const summary: Array<{ id: string; title: string; totalTokens: number; costUsd: number }> = [];
  let exported = 0;

  for (const session of list) {
    const stats = statsMap.get(session.id);
    if (!stats?.usage) continue; // no usage recorded → nothing worth archiving
    const sessProvider = stats.provider ?? provider;
    const content = buildStatsExportJson(stats, sessProvider, session);
    const safeTitle = (session.title || session.id).replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 60);
    zip.file(`${safeTitle}.json`, content);
    summary.push({
      id: session.id,
      title: session.title,
      totalTokens: (stats.usage.promptTokens ?? 0) + (stats.usage.completionTokens ?? 0),
      costUsd: estimateCostUsd(stats.usage, sessProvider),
    });
    exported++;
  }

  if (exported === 0) {
    showToast(t('stats.export.zipEmpty'));
    return;
  }

  // Human-readable overview: a markdown table (by tokens, heaviest first)
  // plus aggregate totals, so the archive reads without opening a single
  // per-session file. Title pipes/backticks are escaped to keep the table
  // well-formed.
  const sorted = summary.sort((a, b) => b.totalTokens - a.totalTokens);
  const mdTitle = (title: string): string => title.replace(/\|/g, '\|').replace(/`/g, '\`');
  const totalTokens = sorted.reduce((n, s) => n + s.totalTokens, 0);
  const totalCost = sorted.reduce((n, s) => n + s.costUsd, 0);
  const readme = [
    '# Pure 会话统计导出',
    '',
    `- **导出时间**: ${new Date().toLocaleString()}`,
    `- **会话数**: ${exported}`,
    `- **总 tokens**: ${formatTokens(totalTokens)}`,
    `- **总花费**: ${formatCostUsd(totalCost)}`,
    '',
    '| # | 会话 | tokens | 花费 |',
    '|---|------|-------:|-----:|',
    ...sorted.map((s, i) => `| ${i + 1} | ${mdTitle(s.title || s.id)} | ${formatTokens(s.totalTokens)} | ${formatCostUsd(s.costUsd)} |`),
    '',
    '> 每个会话的完整统计见同名 JSON 文件。',
    '',
  ].join('\n');
  zip.file('README.md', readme);

  const generated = await zip.generateAsync({ type: 'uint8array' });
  // Copy into a fresh ArrayBuffer-backed view — JSZip's returned view is
  // typed ArrayBufferLike, which Blob/TS strictness rejects.
  const bytes: Uint8Array<ArrayBuffer> = Uint8Array.from(generated);
  const filename = `pure-stats-all-${new Date().toISOString().slice(0, 10)}.zip`;
  try {
    const savedTo = await saveStatsExportBinary(bytes, filename, 'application/zip');
    if (savedTo) showToastHtml(buildExportSavedToast(savedTo));
  } catch {
    showToast(`${t('toast.sendFailed')}: ${t('stats.export')}`);
  }
}

async function exportSessionStats(format: 'json' | 'markdown' | 'csv'): Promise<void> {
  const stats = chat.getSessionStats();
  const provider = stats.provider ?? loadConfig()?.provider ?? 'deepseek-openai';
  // Session metadata (title / first-message time) for the report header —
  // looked up from the session index so archives identify themselves.
  const sessionId = chat.getSessionId();
  let meta: SessionMeta | undefined;
  try {
    const list = await loadSessionList();
    meta = list.find((s) => s.id === sessionId);
  } catch { /* export still works without the meta line */ }

  const ext = format === 'json' ? 'json' : format === 'csv' ? 'csv' : 'md';
  const content = format === 'json'
    ? buildStatsExportJson(stats, provider, meta)
    : format === 'csv'
      ? buildStatsExportCsv(stats, provider, meta)
      : buildStatsExportMarkdown(stats, provider, meta);
  const filename = `session-stats-${sessionId.replace(/[^\w-]/g, '')}.${ext}`;

  try {
    const savedTo = await saveStatsExport(content, filename, ext);
    if (savedTo) showToastHtml(buildExportSavedToast(savedTo));
  } catch {
    showToast(`${t('toast.sendFailed')}: ${t('stats.export')}`);
  }
}

function initStatsExportMenu(): void {
  const btn = document.getElementById('stats-export-btn');
  const menu = document.getElementById('stats-export-menu');
  if (!btn || !menu) return;

  const close = (): void => {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !menu.classList.contains('hidden');
    close();
    if (!isOpen) {
      menu.classList.remove('hidden');
      btn.setAttribute('aria-expanded', 'true');
    }
  });

  menu.querySelectorAll<HTMLButtonElement>('[data-export-format]').forEach((item) => {
    item.addEventListener('click', () => {
      close();
      const fmt = item.getAttribute('data-export-format');
      if (fmt === 'zip') {
        void exportAllSessionStatsZip();
      } else if (fmt === 'json' || fmt === 'markdown' || fmt === 'csv') {
        void exportSessionStats(fmt);
      }
    });
  });

  // Close on outside click / Escape.
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target as Node) && e.target !== btn) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

// ── Confirm modal (destructive actions) ──
// Session deletion / delete-all render in a centered MODAL overlay (see
// modal.ts) instead of a card in the chat transcript: a destructive action
// deserves an explicit dialog that can't be missed mid-conversation, and unlike
// window.confirm() (which Tauri's WKWebView does not implement) it works
// everywhere. The permission / plan-review confirmations keep their inline-card
// form (they belong in the conversation flow).
function confirmDialog(message: string): Promise<boolean> {
  return showConfirmModal({
    title: t('confirm.title'),
    message,
    okLabel: t('confirm.ok'),
    cancelLabel: t('confirm.cancel'),
    danger: true,
  });
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
    void (async () => {
      if (await settingsVisible()) {
        await closeSettings();
      } else {
        workspace.closePopover();
        await openSettings();
      }
    })();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault();
    void (async () => {
      if (!(await settingsVisible())) {
        workspace.closePopover();
        chat.clear();
        goToLanding();
        landingPrompt.focus();
        chat.setWorkspace('');
        workspace.refresh();
        sessionSidebar.setActive(null);
      }
    })();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault();
    withChatWidthSnap(() => sidebar.classList.toggle('collapsed'));
    // Same as the sidebarToggle click handler: don't leave a floating popover
    // when the sidebar (and its picker button) collapse.
    if (sidebar.classList.contains('collapsed')) {
      workspace.closePopover();
    }
  }
  if (e.key === 'Escape') {
    void (async () => {
      if (await settingsVisible()) {
        await closeSettings();
      }
      if (!document.getElementById('workspace-picker-popover')!.classList.contains('hidden')) {
        workspace.closePopover();
      }
    })();
  }
});
