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
import { checkForUpdatesSilently, fetchAppVersion } from './updater';
import { t, updateLanguage } from '../shared/i18n';
import type { Language as I18nLanguage } from '../shared/i18n';
import { showToast } from '../shared/toast';
import { copyTextToClipboard } from '../shared/clipboard';
import { providerLabel, providerDef, PROVIDERS, defaultModelFor, type ProviderId } from '../shared/providers';
import { renderMarkdown, stripToolCallXml } from './markdown';
import { createToolRow, finalizeToolRow } from './toolRow';
import { appendStoredThinking } from './thinkingCard';
import { wireScrollPin, setPinnedToBottom, scrollChatToBottomIfPinned } from './scrollPin';
import { initPathLinks, linkifyPaths } from './pathLink';
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
  const toolExecs: ToolExecMeta[] = [];
  // Restoring a long session must not block the GUI: each bubble's markdown
  // pass (marked parse + sanitize + hljs + linkify) is effectively synchronous
  // for plain content, so yield to the browser between bubbles for a paint and
  // input processing instead of rendering the whole transcript in one burst.
  const yieldToUI = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));

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
    // Let the browser paint + process input between bubbles.
    await yieldToUI();
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

// The landing send button fades in once the user has typed something (or the
// box has focus). Because the send button now lives in the toolbar row below
// the prompt, the old `:not(:placeholder-shown) ~ #landing-send-btn` sibling
// selector no longer matches — a .has-text class on the wrap drives the same
// reveal from JS (see #landing-input-wrap.has-text in styles.css).
function syncLandingHasText(): void {
  const wrap = document.getElementById('landing-input-wrap');
  if (wrap) wrap.classList.toggle('has-text', !!landingPrompt.value.trim());
}

landingPrompt.addEventListener('input', () => {
  landingPrompt.style.height = 'auto';
  landingPrompt.style.height = Math.min(landingPrompt.scrollHeight, 200) + 'px';
  syncLandingHasText();
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
    sidebar.classList.toggle('collapsed');
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
