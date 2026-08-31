// src/ui/main.ts
// App shell: wires the domain controllers together and owns the chat
// transcript + composer. Extracted concerns live in:
//   • ./workspace.ts      — workspace picker, drag & drop, file attach
//   • ./sessionSidebar.ts — session list, grouping, deletion
//   • ./settings.ts       — settings panel (lazy-loaded on first open)
//   • ../shared/providers.ts — provider metadata (labels / default models)

import { ChatController, bindAssistantBubbleCopy, bindUserBubbleSelectAll, renderUserImageAttachments, shouldCancelForEscape, ensureRuntimesProbed } from './chat';
import { loadConfig, hasConfiguredKey, defaults, invalidateConfigCache, initConfigFile, persistConfig, modelListForProvider, providerHasKey, type PureConfig } from './config';
import type { SettingsPanel } from './settings';
import { groupFileWrites, type SessionSnapshotV2, type ToolExecMeta } from './store';
import { projectSessionEvents, projectTranscript } from './transcriptProjection';
import { estimateCostUsd, formatCostUsd, formatTokens } from '../shared/usage';
import { escapeHtml } from '../shared/html';
import { buildExportSavedToast } from './statsExportToast';
import { stripUserTurnContext } from '../shared/promptLayers';
import { checkForUpdatesSilently, fetchAppVersion } from './updater';
import { t, updateLanguage } from '../shared/i18n';
import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { loadSessionList, loadSessionStatsForList, flushSessionSaves, type SessionMeta, type SessionStats } from './store';
import type { Language as I18nLanguage } from '../shared/i18n';
import { showToast, showToastHtml } from '../shared/toast';
import { copyTextToClipboard } from '../shared/clipboard';
import { providerDef, PROVIDERS, defaultModelFor, customProviderLabel, promptBudgetForProvider, type ProviderId } from '../shared/providers';
import { resolvePromptBudget } from '../shared/PromptAssembler';
import type { Message } from '../shared/types';
import { ComposerSelect, type ComposerSelectOption } from './composerSelect';
import { renderMarkdown, stripToolCallXml } from './markdownLoader';
import { createToolRow, finalizeToolRow, markToolRowStopped } from './toolRow';
import { appendStoredThinking } from './thinkingCard';
import { createAssessmentFlowCard } from './assessmentFlow';
import { createRestoredPlanCard } from './plan';
import { renderArtifactCards } from './artifactCards';
import { attachPlanPauseActions } from './planPauseActions';
import { wireScrollPin, scrollChatToBottomIfPinned, forceScrollToBottom } from './scrollPin';
import { initPathLinks, linkifyPaths, openPathLink } from './pathLink';
import { PasteChipManager, PASTE_FILE_THRESHOLD, attachmentToMessageImage, composeMessageWithAttachments, renderAttachmentCard } from './pasteChip';
import { startMemoryDecayTimer } from './memoryDecayTimer';
import { memoryStore } from './memoryStore';
import { showConfirmModal } from './modal';
import { checkPreflight, type PreflightGate } from './preflight';
import { InlineAutocomplete } from './inlineAutocomplete';
import { TaskQueue } from './taskQueue';
import { mountTaskQueuePanel } from './taskQueuePanel';
import { Scheduler } from './scheduler';
import { WorkspaceController } from './workspace';
import { SessionSidebar } from './sessionSidebar';
import { shouldYieldAfterRestoreBlock } from './sessionRestorePolicy';
import { loadDeferredStyles } from './deferredStyles';

const chat = new ChatController();

// Long text submissions are converted into the same temporary text-file chip
// used by oversized pastes, so the model receives a read_file reference rather
// than the entire prompt body.
const pasteChips = new PasteChipManager(() => chat.getSessionId(), () => {
  // Attachments enable send-with-no-text and tint the composer attach button.
  const has = pasteChips.hasAttachments();
  document.querySelectorAll('.attach-btn').forEach(b => b.classList.toggle('has-attachments', has));
  enableInputIfReady();
}, () => chat.getWorkspace());  pasteChips.mount(document.getElementById('composer-box')!);
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
    // Workspace selection is already reflected in the active chat. Defer the
    // expensive grouped-session/sidebar IPC refresh until the WebView is idle.
    sessionSidebar.refreshIdle();
  },
});

sessionSidebar = new SessionSidebar({
  chat,
  pasteChips,
  confirm: confirmDialog,
  renderMessages: renderSessionMessages,
  showSessionLoading,
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
            // The open callback hides the edge toggle (see above); it must be
            // restored here or the right-side button stays gone until reload.
            if (contextPanelReopen) contextPanelReopen.hidden = false;
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
  await loadDeferredStyles();
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
  document.querySelectorAll<HTMLButtonElement>('.undo-write-btn, .compact-context-btn').forEach((button) => {
    button.disabled = streaming;
  });
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
  // Schedule edits (Settings → 定时任务) persist via the config — re-arm the
  // frontend scheduler so changes apply immediately without an app restart.
  scheduler?.reschedule();
}

// ── DOM refs ──
const chatView = document.getElementById('chat-view')!;
const promptEl = document.getElementById('prompt') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const landingPrompt = document.getElementById('landing-prompt') as HTMLTextAreaElement;
const landingSend = document.getElementById('landing-send-btn') as HTMLButtonElement;
const sidebarNewChat = document.getElementById('sidebar-new-chat') as HTMLButtonElement;
const sidebarSettingsBtn = document.getElementById('sidebar-settings-btn') as HTMLButtonElement;

// ── Composer inline autocomplete (context-based suggestions) ──
// Suggests recent session titles / past commands / written paths while typing.
new InlineAutocomplete(promptEl);
if (landingPrompt) new InlineAutocomplete(landingPrompt);

// ── Batch task queue (chat is single-flight, so tasks run one after another) ──
// Model + popover panel. Tasks persist to localStorage, so a reload resumes any
// that were still pending.
const taskQueue = new TaskQueue({
  chat,
  getContext: () => ({ workspace: chat.getWorkspace(), sessionId: chat.getSessionId() }),
});
mountTaskQueuePanel(taskQueue);

// ── Scheduled tasks (frontend scheduler) ──
// Schedules live in the config (Settings → 定时任务). A due task enqueues into
// the queue; it is skipped for that cycle while a chat turn is active so it
// never hijacks an in-progress conversation.
const scheduler = new Scheduler({
  queue: taskQueue,
  isBusy: () => chat.isStreaming(),
});
scheduler.start();

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

// Custom in-page dropdowns (ComposerSelect) replace the former native
// <select> elements: macOS WKWebView under Tauri's drag-drop handler dismisses
// native select popups instantly, which made models unselectable.
const modeSelects = new Map<string, ComposerSelect>();
const modelSelects = new Map<string, ComposerSelect>();

function ensureComposerSelects(): void {
  for (const id of MODE_SELECT_IDS) {
    if (modeSelects.has(id)) continue;
    const host = document.getElementById(id);
    if (!host) continue;
    modeSelects.set(id, new ComposerSelect(host, (value) => {
      const cfg = loadConfig() ?? defaults();
      cfg.taskMode = value as PureConfig['taskMode'];
      persistConfig(cfg);
      invalidateConfigCache();
      showToast(t('composer.modeSaved'));
    }, t('composer.mode.title')));
  }
  for (const id of MODEL_SELECT_IDS) {
    if (modelSelects.has(id)) continue;
    const host = document.getElementById(id);
    if (!host) continue;
    modelSelects.set(id, new ComposerSelect(host, (value) => {
      const cfg = loadConfig() ?? defaults();
      const providerId = value.split('::')[0] || value;
      const model = value.split('::')[1];
      cfg.provider = providerId as ProviderId;
      cfg.model = model !== undefined ? (modelListForProvider(cfg, providerId)[Number(model)] ?? defaultModelFor(providerId)) : defaultModelFor(providerId);
      persistConfig(cfg);
      invalidateConfigCache();
      // updateSidebarModel() cascades into the status footer + context panel.
      updateSidebarModel();
      showToast(t('composer.modelSaved'));
    }, t('composer.model.title')));
  }
}

function populateModeSelect(cs: ComposerSelect, cfg: PureConfig): void {
  const modes: Array<[PureConfig['taskMode'], string]> = [
    ['auto', t('composer.mode.auto')],
    ['yolo', t('composer.mode.yolo')],
    ['plan', t('composer.mode.plan')],
    ['build', t('composer.mode.build')],
  ];
  cs.setOptions(modes.map(([value, label]) => ({ value, label })), cfg.taskMode ?? 'auto');
}

function populateModelSelect(cs: ComposerSelect, cfg: PureConfig): void {
  const customs = cfg.customProviders ?? [];
  const currentModel = cfg.model?.trim() || '';
  const options: ComposerSelectOption[] = [];
  let selectedValue = '';
  const appendProviderModels = (provider: string, label: string): void => {
    const models = modelListForProvider(cfg, provider);
    models.forEach((model, index) => {
      options.push({ value: `${provider}::${index}`, label: model, hint: label });
      if (provider === cfg.provider && model === currentModel) selectedValue = `${provider}::${index}`;
    });
  };
  for (const p of PROVIDERS) {
    if (!providerHasKey(cfg, p.id)) continue;
    appendProviderModels(p.id, t(p.i18nKey));
  }
  for (const c of customs) {
    if (!providerHasKey(cfg, c.id)) continue;
    appendProviderModels(c.id, c.name);
  }
  cs.setOptions(options, selectedValue || undefined);
}

function populateComposerSelects(): void {
  ensureComposerSelects();
  const cfg = loadConfig() ?? defaults();
  for (const cs of modeSelects.values()) {
    cs.setTriggerTitle(t('composer.mode.title'));
    populateModeSelect(cs, cfg);
  }
  for (const cs of modelSelects.values()) {
    cs.setTriggerTitle(t('composer.model.title'));
    populateModelSelect(cs, cfg);
  }
}

function wireComposerSelects(): void {
  populateComposerSelects();
}

// ── Context panel display ──

/** Provider display label, resolving custom providers by their saved name and
 *  built-in providers by their per-provider override (Settings → LLM). */
function providerDisplayLabel(cfg: PureConfig | null): string {
  if (!cfg) return '';
  return customProviderLabel(cfg.customProviders ?? [], cfg.provider, cfg.providerOverrides);
}

function updateContextPanelModel() {
  const cfg = loadConfig();
  const model = document.getElementById('context-model');
  if (!model) return;
  model.textContent = cfg?.model ? `${providerDisplayLabel(cfg)} · ${cfg.model}` : (cfg?.provider ? providerDisplayLabel(cfg) : t('context.model.notConfigured'));
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
      ? `${providerDisplayLabel(cfg)} · ${cfg.model}`
      : (cfg?.provider ? providerDisplayLabel(cfg) : t('context.model.notConfigured'));
    model.title = cfg?.model ? cfg.model : '';
  }

  // Live state dot + text (busy while the agent is generating). When no
  // provider is configured the model badge already reads 未配置 — the state
  // text must match instead of claiming 就绪 while the composer is disabled.
  const bar = document.getElementById('status-bar');
  const statusText = document.getElementById('status-text');
  const busy = chat.isStreaming();
  if (bar) bar.classList.toggle('busy', busy);
  if (statusText) {
    statusText.textContent = busy
      ? t('status.generating')
      : (cfg?.provider ? t('status.ready') : t('status.notConfigured'));
  }

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
  tagPlatform();
  await initConfigFile();
  applySavedAppearance();
  // 冷启动就把运行时/网络探测放到后台：用户阅读 landing 页期间 sys_info 已完成，
  // 首条消息不再在关键路径上等环境探针（与 memoryStore.warmUp() 同一预热模式）。
  void ensureRuntimesProbed();
  chat.setWorkspace('');
  wireComposerSelects();
  checkLandingState();
  enableInputIfReady();
  // Corner chrome reveal (CSS): the top-left sidebar toggle and top-right
  // settings button are hidden while the pointer is outside the app window
  // and fade in when it enters. `mousemove` inside the window shows them;
  // `mouseleave` on the root document schedules a delayed hide (fires when
  // the pointer leaves the webview). The delay lets a quick departure — e.g.
  // overshooting toward the corner buttons themselves — keep the buttons
  // visible instead of blinking them out and back under the cursor, which is
  // where accidental clicks come from. classList is idempotent, so the
  // high-frequency mousemove is safe — it only ever adds, never churns the
  // DOM.
  const CHROME_HIDE_DELAY_MS = 1000;
  const appShell = document.getElementById('main');
  if (appShell) {
    let hideChromeTimer: ReturnType<typeof setTimeout> | undefined;
    document.addEventListener('mousemove', () => {
      if (hideChromeTimer) {
        clearTimeout(hideChromeTimer);
        hideChromeTimer = undefined;
      }
      appShell.classList.add('window-hover');
    }, { passive: true });
    document.documentElement.addEventListener('mouseleave', () => {
      if (!hideChromeTimer) {
        hideChromeTimer = setTimeout(() => {
          hideChromeTimer = undefined;
          appShell.classList.remove('window-hover');
        }, CHROME_HIDE_DELAY_MS);
      }
    });
  }
  // Bind folder buttons on the critical path. The native dialog bridge is
  // preloaded by workspace.ts, so a first click can open the macOS picker
  // immediately instead of waiting for the idle bootstrap callback.
  workspace.init();
  window.addEventListener('pagehide', () => {
    void flushSessionSaves();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushSessionSaves();
  });
  dismissBootSplash();
  // Preload the memory embedder (WASM + model) so the first message of a new
  // chat never blocks on the one-time load. Deferred to an idle slot (NOT run
  // inline on the critical path): the transformers.js module evaluation + WASM
  // runtime init are CPU-heavy on the main thread, and on slower Intel Macs
  // running them right after the splash competed with the user's first click —
  // notably the native folder picker, whose AppKit init then had to wait and
  // felt frozen. Best-effort; a failure just means the next search pays the
  // load as before.
  deferToIdle(() => {
    void memoryStore.warmUp().catch(() => {});
  });

  deferToIdle(async () => {
    // Feature styles are a separate CSS chunk. Await it before the deferred
    // controllers so the first tool/session render never flashes unstyled.
    // Error isolation: a throw in any single deferred step must not silently
    // skip the rest (e.g. an unbound session sidebar for the whole session).
    try {
      await loadDeferredStyles().catch((err) => {
        console.error('[pure] deferred styles failed:', err);
      });
      workspace.refresh();
      updateSidebarModel();
      updateContextPanelStage();
      sessionSidebar.refresh();
      sessionSidebar.init();
      initPathLinks();
      // Background memory decay: Harness only decays at session start (1h
      // throttle), so idle apps never forget. A timer re-runs decay after the
      // throttle window elapses — see src/ui/memoryDecayTimer.ts.
      startMemoryDecayTimer();
      // Stats panel: subscribe to per-session updates + draw the empty state.
      chat.onSessionStatsChanged(() => renderSessionStats());
      chat.onWorkspaceSnapshotChanged((available) => {
        document.querySelectorAll<HTMLButtonElement>('.undo-write-btn').forEach((button) => {
          button.hidden = !available;
          button.disabled = chat.isStreaming();
        });
        document.querySelectorAll<HTMLButtonElement>('.compact-context-btn').forEach((button) => {
          button.disabled = chat.isStreaming();
        });
      });
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
  // Silent update probe: defer long enough for the boot splash + landing to
  // reveal before the version check hits the network. Named constant so the
  // delay is discoverable/tunable instead of a bare magic number.
  const UPDATE_CHECK_DELAY_MS = 3_000;
  setTimeout(() => checkForUpdatesSilently(), UPDATE_CHECK_DELAY_MS);
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
  // The composer model selector was populated at startup with the initial
  // config; the user may have changed the model on the landing selector since
  // then — sync it so the chat input shows the correct model.
  populateComposerSelects();
  updateContextPanelStage();
  promptEl.focus();
}

/** Update sidebar model badge from config */
function updateSidebarModel() {
  const cfg = loadConfig();
  const el = document.getElementById('sidebar-model');
  if (!el) return;
  el.textContent = cfg?.model ? `${providerDisplayLabel(cfg)} · ${cfg.model}` : (cfg?.provider ? providerDisplayLabel(cfg) : '');
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

/** Tag the platform for CSS (Windows WebView2 renders crisper with ClearType
 * subpixel AA; macOS keeps its preferred grayscale antialiasing). Runs before
 * any config-dependent setup so it applies even on a first-run profile. */
function tagPlatform(): void {
  if (/Windows/i.test(navigator.userAgent) || navigator.platform?.startsWith('Win')) {
    document.documentElement.setAttribute('data-platform', 'win');
  }
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

let sessionRestoreToken = 0;

// ── Session-loading transition ──
// Opening a historical conversation can take a moment (disk read + one bubble
// per rAF yield), so the content area shows a semi-transparent loading
// overlay the instant a session card is clicked, then fades it out and fades
// the restored transcript in when the restore completes. The overlay lives in
// #chat-view and never blocks the sidebar or composer.
let sessionLoadingEl: HTMLElement | null = null;

function showSessionLoading(): void {
  if (sessionLoadingEl) return; // already visible
  const host = document.getElementById('chat-view');
  if (!host) return;
  const overlay = document.createElement('div');
  overlay.id = 'session-loading-overlay';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.innerHTML =
    `<span class="session-loading-ring" aria-hidden="true"></span>` +
    `<span class="session-loading-label">${t('session.loading.history')}</span>`;
  sessionLoadingEl = overlay;
  host.appendChild(overlay);
  // One frame later the element is in the DOM, so the opacity transition from
  // 0 → 1 actually animates (a same-frame class toggle would jump instantly).
  requestAnimationFrame(() => overlay.classList.add('visible'));
}

function hideSessionLoading(): void {
  const overlay = sessionLoadingEl;
  sessionLoadingEl = null;
  if (!overlay) return;
  overlay.classList.remove('visible');
  // Wait for the fade-out before removing the node so the transition is
  // visible; the fallback timer covers reduced-motion / stalled frames.
  const remove = () => overlay.remove();
  overlay.addEventListener('transitionend', remove, { once: true });
  setTimeout(remove, 220);
}

async function renderSessionMessages(snapshot: SessionSnapshotV2) {
  const blocks = snapshot.events.length > 0
    ? projectSessionEvents(snapshot.events)
    : projectTranscript(snapshot.transcript);
  const restoreToken = ++sessionRestoreToken;
  const isCurrentRestore = (): boolean => restoreToken === sessionRestoreToken;
  enterChatMode();
  // Multi-agent floating cards are ephemeral and session-scoped: clear them on
  // every session load so the previous session's cards never bleed into this one.
  document.getElementById('agent-float')?.replaceChildren();
  chat.loadFromStorage(snapshot);

  const chatEl = document.getElementById('chat')!;
  chatEl.innerHTML = '';
  // Same coalesced scroll machinery as live streaming (chat.ts), so the
  // one-shot restore scroll joins the shared rAF budget instead of forcing a
  // synchronous full-transcript layout at the end of the restore.
  wireScrollPin(chatEl);
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
  const replayTools: Array<{ exec: ToolExecMeta; stopped: boolean }> = [];
  const flushReplayTools = (): void => {
    if (replayTools.length === 0) return;
    const grid = document.createElement('div');
    grid.className = 'bubble-row tool-grid';
    for (const item of replayTools) {
      const row = createToolRow(item.exec.toolName, item.exec.args ?? {});
      if (item.stopped) markToolRowStopped(row);
      else finalizeToolRow(row, item.exec);
      grid.appendChild(row.el);
    }
    chatEl.appendChild(grid);
    replayTools.length = 0;
  };
  // Restoring a long session must not block the GUI. Render a small batch in
  // one turn, then yield for a paint and input processing. Waiting after every
  // block made a 400-message session spend several seconds in artificial rAF
  // gaps; a batch keeps the UI responsive without serializing every bubble.
  const yieldToUI = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));
  let blocksSinceYield = 0;
  const yieldIfNeeded = async (): Promise<void> => {
    blocksSinceYield++;
    if (!shouldYieldAfterRestoreBlock(blocksSinceYield)) return;
    blocksSinceYield = 0;
    await yieldToUI();
  };

  try {
    for (const block of blocks) {
      if (!isCurrentRestore()) return;
      if (block.type === 'tool') {
        replayTools.push(block);
        await yieldIfNeeded();
        if (!isCurrentRestore()) return;
        continue;
      }
      flushReplayTools();

      // Per-block isolation: one broken block (e.g. markdown that trips the
      // renderer, a malformed card payload) must not abort the whole restore —
      // it used to truncate everything AFTER it, so reviewing a long project
      // history silently lost all later messages. Log and keep going.
      try {
        if (block.type === 'user') {
          const wrapper = document.createElement('div');
          wrapper.className = 'bubble-row user';
          const label = document.createElement('span');
          label.className = 'bubble-label';
          label.textContent = t('context.role.you');
          wrapper.appendChild(label);
          const bubble = document.createElement('div');
          bubble.className = 'bubble';
          bubble.textContent = stripUserTurnContext(block.content);
          renderUserImageAttachments(bubble, block.images);
          for (const attachment of block.attachments) {
            bubble.appendChild(renderAttachmentCard(attachment, () => pasteChips.openStoredAttachment(attachment)));
          }
          bindUserBubbleSelectAll(bubble);
          linkifyPaths(bubble);
          wrapper.appendChild(bubble);
          chatEl.appendChild(wrapper);
        } else if (block.type === 'analysis' || block.type === 'thinking') {
          appendStoredThinking(block.text, chatEl);
        } else if (block.type === 'assessment') {
          const flow = createAssessmentFlowCard(block.assessment);
          flow.completePhase('gate');
          flow.awaitPhase('execute', '计划已就绪，等待你回复后开始第一个可验证步骤…');
          chatEl.appendChild(flow.el);
          chat.registerPausedAssessment(flow);
        } else if (block.type === 'plan') {
          const progress = chat.getPlanProgressModel();
          if (!progress) continue;
          const restoredPlanCard = createRestoredPlanCard(progress);
          chatEl.appendChild(restoredPlanCard.el);
        } else if (block.type === 'assistant') {
          const wrapper = document.createElement('div');
          wrapper.className = 'bubble-row assistant';
          const label = document.createElement('span');
          label.className = 'bubble-label';
          label.textContent = t('context.role.pure');
          wrapper.appendChild(label);
          const bubble = document.createElement('div');
          bubble.className = block.isPlanPause ? 'bubble plan-pause-message' : 'bubble';
          bindAssistantBubbleCopy(bubble);
          wrapper.appendChild(bubble);
          chatEl.appendChild(wrapper);
          await renderMarkdown(stripToolCallXml(block.content), bubble, { yieldBeforeParse: false });
          if (block.isPlanPause) {
            attachPlanPauseActions(
              wrapper,
              () => chat.continuePausedPlan(),
              () => chat.cancelPausedPlan(),
            );
          }
        } else if (block.type === 'artifact') {
          const artifactRow = document.createElement('div');
          artifactRow.className = 'bubble-row artifact-row';
          chatEl.appendChild(artifactRow);
          renderArtifactCards(artifactRow, block.items, chat.getEffectiveWorkspace() || '.', { userRequest: block.userRequest });
        }
      } catch (blockErr) {
        console.warn('[pure] restore: skipping unrenderable transcript block', block.type, blockErr);
      }

      await yieldIfNeeded();
      if (!isCurrentRestore()) return;
    }
    if (!isCurrentRestore()) return;
    flushReplayTools();
    // 恢复可能重建了计划卡：重新挂载固定进度条，让当前步骤在滚动后仍可见；
    // 无活动计划时是幂等移除（no-op）。
    chat.syncPlanProgressPin();
  } catch (err) {
    // Always remove this restore's local loading row, but only the current
    // restore may dismiss the shared overlay. An older restore can fail after
    // the user has already selected another session and must not hide the new
    // session's loading feedback.
    loadingRow.remove();
    if (isCurrentRestore()) hideSessionLoading();
    throw err;
  }
  // Only the CURRENT restore may dismiss the overlay: a stale restore (user
  // already clicked a newer session) must not hide the newer session's
  // loading feedback.
  if (!isCurrentRestore()) return;
  hideSessionLoading();
  loadingRow.remove();
  if (!isCurrentRestore()) return;
  // A session restore rebuilds the transcript from scratch, so it always
  // lands at the newest content — force the pin state the same way a fresh
  // stream would, then scroll through the shared coalesced helper.
  forceScrollToBottom(chatEl);
  // Fade the restored transcript in so the swap from loading overlay to
  // content reads as one smooth transition instead of an abrupt cut.
  chatEl.classList.add('session-transition-fade');
  chatEl.addEventListener('animationend', () => chatEl.classList.remove('session-transition-fade'), { once: true });
  // The restored session's stats belong to the same conversation id —
  // re-render the 统计 tab so the panel matches the transcript.
  renderSessionStats();
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
  // Typing = human takeover: stop any pending auto-continue chain.
  chat.cancelAutoContinue();
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
  // 输入法组字（拼音→汉字）时，Enter 是确认候选字，绝不能当成发送。
  if (e.isComposing || e.keyCode === 229) return;
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
  // Typing = human takeover: stop any pending auto-continue chain.
  chat.cancelAutoContinue();
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

// Explicit copy button in each composer's tool row: one click copies the whole
// draft (no manual select-all needed). The button mirrors the attach button's
// ghost-icon look and is disabled while the input is empty.
function bindComposerCopyButton(btnId: string, input: HTMLTextAreaElement): void {
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (!btn) return;
  const sync = (): void => {
    btn.disabled = !input.value.trim();
  };
  btn.addEventListener('click', async () => {
    const text = input.value;
    if (!text) return;
    const copied = await copyTextToClipboard(text);
    showToast(copied ? t('input.copied') : t('input.copyFailed'));
    // Keep the textarea selection intact after copying so the user can see
    // exactly what was copied.
  });
  input.addEventListener('input', sync);
  input.addEventListener('keyup', sync);
  sync();
}

bindComposerCopyButton('copy-btn', promptEl);
bindComposerCopyButton('landing-copy-btn', landingPrompt);

// Oversized pastes are intercepted here (both inputs) and become file chips.
promptEl.addEventListener('paste', (e) => { pasteChips.consumePaste(e); });
landingPrompt.addEventListener('paste', (e) => { pasteChips.consumePaste(e); });

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  // A confirm modal owns Escape while it is open: the modal's own keydown
  // handler (src/ui/modal.ts) closes it. Skipping the stream-cancel path here
  // keeps Esc from ALSO aborting an in-flight turn behind the dialog — two
  // document-level Escape handlers would otherwise both fire.
  if (document.querySelector('.modal-overlay')) return;
  // Stop must win over any inline permission/plan card. A stale card can remain
  // in the transcript while a tool is already running; letting it short-circuit
  // here made Escape appear broken even though the active turn was cancellable.
  if (shouldCancelForEscape(e.key, chat.isStreaming())) {
    e.preventDefault();
    queuedWhileStreaming = null;
    chat.cancel();
    return;
  }
  if (document.querySelector('.bubble-row.inline-card')) return;
});

// Right-click on empty space in the desktop WebView would only offer the native
// navigation menu (Reload / Back / Forward) — useless here, and Reload wipes the
// in-memory session. Suppress the native menu in that case, but keep it whenever
// it has something useful: a text selection (Copy), a link (Open/Copy Link), an
// image, or an editable field (Paste).
document.addEventListener('contextmenu', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const editable = target.closest('input, textarea, [contenteditable="true"], [contenteditable=""]');
  const link = target.closest('a[href]');
  const image = target.closest('img');
  const selection = window.getSelection();
  const hasSelection = !!selection && !selection.isCollapsed;
  if (!editable && !link && !image && !hasSelection) {
    e.preventDefault();
  }
});

promptEl.addEventListener('keydown', (e) => {
  // 输入法组字（拼音→汉字）时，Enter 是确认候选字，绝不能当成发送。
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (chat.isStreaming()) {
      // Enter while generating: interrupt-and-insert. chat.interject() judges
      // whether the new message is RELATED to the current task (fold in +
      // re-plan) or UNRELATED (queue it, run after the task completes), instead
      // of the old behaviour of dumping it as a follow-up after the run.
      const text = promptEl.value.trim();
      if (text) {
        void chat.interject(text, [], text);
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

function bindUndoWriteButton(id: string): void {
  const button = document.getElementById(id) as HTMLButtonElement | null;
  if (!button) return;
  button.addEventListener('click', async () => {
    if (chat.isStreaming()) return;
    button.disabled = true;
    try {
      const result = await chat.undoLastWriteBatch();
      showToast(result.message);
      renderSessionStats();
      updateContextPanelStage();
    } catch (error) {
      showToast(`撤销失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function bindCompactContextButton(id: string): void {
  const button = document.getElementById(id) as HTMLButtonElement | null;
  if (!button) return;
  button.addEventListener('click', async () => {
    if (chat.isStreaming()) return;
    button.disabled = true;
    try {
      const result = await chat.compactContext();
      if (result.overBudget) {
        showToast(t(result.oversizedNewestGroup ? 'context.compact.overBudget' : 'context.compact.contextOverBudget'));
      } else if (result.evictedMessages > 0) {
        const summary = result.summarized
          ? '，已生成摘要'
          : result.summaryUnavailable ? `，${t('context.compact.noSummary')}` : '';
        showToast(t('context.compact.done').replace('{n}', String(result.evictedMessages)).replace('{summary}', summary));
      } else if (result.messages.length === 0) {
        showToast(t('context.compact.empty'));
      } else {
        showToast(t('context.compact.none'));
      }
    } catch (error) {
      showToast(`上下文压缩失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      button.disabled = chat.isStreaming();
    }
  });
}

bindUndoWriteButton('undo-write-btn');
bindUndoWriteButton('landing-undo-write-btn');
bindCompactContextButton('compact-btn');
bindCompactContextButton('landing-compact-btn');

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

  // Error prediction & prevention: a destructive intent (delete / clear /
  // reset / drop…) must be explicitly confirmed before the draft leaves the
  // composer. Cancelling returns here with the draft untouched.
  const gate = checkPreflight(text);
  if (gate && !(await confirmHighRiskDraft(gate))) return;

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
  // Snapshot attachments before sending. Images are awaited so the vision
  // payload is complete, then the composer is cleared before the request starts;
  // the submitted image lives in the transcript instead of remaining attached
  // to the input bar.
  const attachments = await pasteChips.prepareForSend();
  const hasSameTextAttachment = attachments.some((a) => a.kind === 'text' && a.content === text);
  const longTextAttachment = [...text].length > PASTE_FILE_THRESHOLD && !hasSameTextAttachment
    ? pasteChips.addLongText(text)
    : null;
  const outgoingAttachments = longTextAttachment ? await pasteChips.prepareForSend() : attachments;
  const fullText = composeMessageWithAttachments(longTextAttachment || hasSameTextAttachment ? '' : text, outgoingAttachments);
  const images = outgoingAttachments.map(attachmentToMessageImage).filter((image): image is NonNullable<typeof image> => image !== null);
  const displayText = longTextAttachment || hasSameTextAttachment ? `已附加长文本文件：${outgoingAttachments.find((a) => a.kind === 'text' && a.content === text)?.name ?? '文本文件'}` : text;
  const attachmentMetadata = outgoingAttachments.map((a) => ({ id: a.id, name: a.name, path: a.path, size: a.size, kind: a.kind, truncated: a.truncated }));
  const openAttachment = (attachment: import('../shared/types').MessageAttachment) => pasteChips.openStoredAttachment(attachment);
  pasteChips.clear();
  try {
    enterChatMode();
    await chat.send(fullText, images, displayText, false, attachmentMetadata, openAttachment);
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

contextPanelReopen?.addEventListener('click', () => {
  withChatWidthSnap(() => setContextPanelCollapsed(!contextCollapsed));
  // Charts live inside the collapsed-by-default panel; init them only once it
  // is actually expanded so echarts measures real container dimensions.
  if (!contextCollapsed) void renderContextCharts();
});

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

  setText('stat-turns', String(stats.turns ?? 0));
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

  const fileGroups = groupFileWrites(stats.fileWrites);
  setText('stat-search-count', String(stats.searches.length));
  setText('stat-write-count', String(fileGroups.length));
  setText('stat-read-count', String(stats.fileReads.length));
  setText('stat-cmd-count', String(stats.commands.length));

  renderStatsList('stat-search-list', stats.searches, (s) => s.query);
  // File writes are grouped by normalized path. Each row shows only the
  // newest operation for that file, while retaining the path-open affordance.
  renderFileWriteGroups('stat-write-list', fileGroups);
  renderStatsList('stat-read-list', stats.fileReads, (r) => r.path, (r) => r.path);
  // Command rows are copyable: a hover-revealed copy button copies the raw
  // command (without the ✗ failure prefix shown in the label).
  renderStatsList('stat-cmd-list', stats.commands, (c) => (c.success ? '' : '✗ ') + c.command, undefined, (c) => c.command);

  // Context-panel charts (窗口预算仪表盘 + Token 分布) refresh alongside the numbers.
  void renderContextCharts();
}

// ── Context-panel charts (上下文窗口仪表盘 + Token 分布环形图) ──
// The window gauge measures the CURRENT live transcript, not the cumulative
// usage counter: sessionStats.usage.promptTokens is summed across turns.
// Estimator mirrors engine/BudgetManager.countTokens (CJK ≈ 1 token/char,
// Latin ≈ 1/4) so the gauge reads in the same units the engine budgets in.
const CJK_CHAR_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) if (CJK_CHAR_RE.test(ch)) cjk++;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

function estimateMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTextTokens(m.content ?? '');
    for (const tc of m.toolCalls ?? []) total += estimateTextTokens(tc.function?.arguments ?? '');
  }
  return total;
}

// echarts stays out of the main bundle: only ```chart blocks (echartsChart.ts)
// and these panel charts lazy-import it. One cached dynamic import shared here.
let echartsModulePromise: Promise<typeof import('./echartsChart')> | null = null;
function loadEchartsChart(): Promise<typeof import('./echartsChart')> {
  if (!echartsModulePromise) echartsModulePromise = import('./echartsChart');
  return echartsModulePromise;
}

// Chart palettes kept local to main.ts (NOT chartTheme — importing it
// statically would pull echarts into the main bundle).
const CHART_THEMES = {
  light: { text: '#4b5563', sub: '#9ca3af', border: '#e5e7eb', accent: '#3E63DD', cyan: '#7ED9FF', green: '#2e9e6b', red: '#e5484d' },
  dark: { text: '#c7cdd6', sub: '#6b7280', border: '#2a2f3a', accent: '#6f8fff', cyan: '#57c7ff', green: '#3ecf8e', red: '#ff6b70' },
};

async function renderContextCharts(): Promise<void> {
  // The right panel starts collapsed; inited charts on hidden containers would
  // be invisible/blank. Skip and let the reopen trigger render them.
  if (contextCollapsed) return;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const theme = CHART_THEMES[dark ? 'dark' : 'light'];
  const { renderEchartOption } = await loadEchartsChart();
  const usage = chat.getSessionStats().usage;
  const hit = usage?.cacheHitTokens ?? 0;
  const miss = usage?.cacheMissTokens ?? Math.max(0, (usage?.promptTokens ?? 0) - hit);
  const out = usage?.completionTokens ?? 0;

  // Token-distribution donut: cache hit / cache miss / output.
  const distEl = document.getElementById('token-dist-chart');
  if (distEl) {
    const pieces = [
      { name: t('stats.cacheHit'), value: hit, color: theme.accent },
      { name: t('stats.cacheMiss'), value: miss, color: theme.cyan },
      { name: t('stats.output'), value: out, color: theme.green },
    ].filter((p) => p.value > 0);
    if (pieces.length === 0) {
      distEl.className = 'stats-chart stats-chart-empty';
      distEl.textContent = t('stats.noUsage');
    } else {
      distEl.className = 'stats-chart';
      distEl.textContent = '';
      renderEchartOption(distEl, {
        tooltip: { trigger: 'item' },
        legend: { bottom: 0, textStyle: { fontSize: 9, color: theme.sub } },
        series: [{
          type: 'pie', radius: ['55%', '75%'], center: ['50%', '42%'],
          avoidLabelOverlap: false,
          itemStyle: { borderColor: 'transparent', borderRadius: 3 },
          label: { show: false },
          emphasis: { label: { show: false } },
          data: pieces.map((p) => ({ value: p.value, name: p.name, itemStyle: { color: p.color } })),
        }],
      });
    }
  }

  // Context-window budget ring: live transcript estimate vs available budget.
  const winEl = document.getElementById('context-window-chart');
  const winPctEl = document.getElementById('stat-window-pct');
  if (winEl && winPctEl) {
    const config = loadConfig();
    const budget = resolvePromptBudget(promptBudgetForProvider(config?.customProviders, config?.provider, config?.model));
    const max = budget.availableInputTokens ?? 0;
    const used = estimateMessageTokens(chat.getMessages());
    if (max <= 0 || used <= 0) {
      winEl.className = 'stats-chart stats-chart-empty';
      winEl.textContent = t('stats.noUsage');
      winPctEl.textContent = '—';
    } else {
      winEl.className = 'stats-chart';
      winEl.textContent = '';
      const pct = Math.min(100, (used / max) * 100);
      winPctEl.textContent = `${Math.round(pct)}%`;
      const overflow = used > max;
      const usedColor = overflow || pct > 80 ? theme.red : theme.accent;
      renderEchartOption(winEl, {
        tooltip: { formatter: (): string => `${t('stats.windowUsed')}: ${formatTokens(used)} / ${formatTokens(max)}` },
        series: [{
          type: 'pie', radius: ['72%', '88%'], center: ['50%', '45%'],
          silent: true, clockwise: true,
          label: {
            show: true, position: 'center', formatter: `${Math.round(pct)}%`,
            fontSize: 15, fontWeight: 600, color: theme.text,
          },
          data: [
            { value: used, itemStyle: { color: usedColor } },
            { value: Math.max(0, max - used), itemStyle: { color: theme.border } },
          ],
        }],
      });
    }
  }
}

function renderFileWriteGroups(
  id: string,
  groups: Array<{ path: string; ts: number; success: boolean }>,
): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (groups.length === 0) {
    el.innerHTML = `<div class="stats-empty">${t('stats.empty')}</div>`;
    return;
  }
  el.innerHTML = '';
  for (const group of groups.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'stats-file-group stats-list-item-openable';
    row.title = `${t('stats.dblclickOpen')} ${group.path}`;
    row.dataset.path = group.path;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `${group.path} — ${group.success ? t('stats.write.success') : t('stats.write.failed')}`);

    const top = document.createElement('div');
    top.className = 'stats-file-group-top';
    const path = document.createElement('span');
    path.className = 'stats-file-path';
    path.textContent = group.path;
    top.appendChild(path);

    const status = document.createElement('span');
    status.className = `stats-file-status ${group.success ? 'success' : 'failure'}`;
    status.textContent = group.success ? t('stats.write.success') : t('stats.write.failed');
    top.appendChild(status);
    row.appendChild(top);

    const meta = document.createElement('div');
    meta.className = 'stats-file-group-meta';
    const latest = document.createElement('span');
    latest.textContent = t('stats.write.latest');
    const time = document.createElement('time');
    const date = new Date(group.ts);
    if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString();
    time.textContent = formatTs(group.ts);
    meta.append(latest, time);
    row.appendChild(meta);

    const open = () => openPathLink(group.path);
    row.addEventListener('dblclick', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    el.appendChild(row);
  }
}

function renderStatsList<T>(
  id: string,
  items: T[],
  label: (item: T) => string,
  /** When given, each row becomes double-click-to-open with this path. */
  pathFor?: (item: T) => string,
  /** When given, each row gets a hover-revealed copy button copying this value. */
  copyValueFor?: (item: T) => string,
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
      const copyValue = copyValueFor ? copyValueFor(item) : '';
      const cls = path ? 'stats-list-item stats-list-item-openable' : 'stats-list-item';
      const title = path ? `${t('stats.dblclickOpen')} ${text}` : text;
      const dataAttr = path ? ` data-path="${escapeHtml(path)}"` : '';
      // data-command is the RAW value (label may carry a status prefix like
      // "✗ "); copying the row text would include that prefix.
      const copyBtn = copyValue
        ? `<button type="button" class="stats-cmd-copy" data-command="${escapeHtml(copyValue)}" title="${t('stats.commandCopy')}" aria-label="${t('stats.commandCopy')}">` +
          `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>` +
          `</button>`
        : '';
      return `<div class="${cls}" title="${escapeHtml(title)}"${dataAttr}>${escapeHtml(text)}${copyBtn}</div>`;
    })
    .join('');
  el.innerHTML = rows;
  // One delegated listener per list (not per row): the list survives session
  // re-renders (only innerHTML changes), so handlers are never duplicated.
  if (copyValueFor && !el.dataset.copyBound) {
    el.dataset.copyBound = '1';
    el.addEventListener('click', async (event) => {
      const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('.stats-cmd-copy');
      if (!btn) return;
      const command = btn.dataset.command ?? '';
      if (!command) return;
      const copied = await copyTextToClipboard(command);
      btn.classList.toggle('copied', copied);
      btn.setAttribute('aria-label', copied ? t('stats.commandCopied') : t('codeBlock.copyError'));
      btn.setAttribute('title', copied ? t('stats.commandCopied') : t('codeBlock.copyError'));
      // Swap the icon to a check briefly, then restore the copy glyph.
      if (copied) {
        const restore = () => btn.classList.remove('copied');
        btn.addEventListener('transitionend', restore, { once: true });
        setTimeout(restore, 1400);
      }
      showToast(copied ? t('stats.commandCopied') : t('codeBlock.copyError'));
    });
  }
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
      turns: stats.turns ?? 0,
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
    `- **模型交互轮次**: ${stats.turns ?? 0}`,
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
  rows.push(['summary', 'llm_turns', '', String(stats.turns ?? 0)].map(csvField).join(','));
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

/** Preflight confirmation for a high-risk draft. The assessment's impact /
 * recommendation strings are already localized by assessIntent. Focus stays on
 * Cancel: Esc / Enter-on-cancel can never confirm a destructive send. */
function confirmHighRiskDraft(gate: PreflightGate): Promise<boolean> {
  const a = gate.assessment;
  return showConfirmModal({
    title: t('preflight.title'),
    message: `${a.impact}\n\n${a.recommendation}`,
    okLabel: t('preflight.ok'),
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
