// src/ui/chat.ts
// v0.6 — Uses CodingAgent/Harness instead of self-built ReAct loop.
// Iterates over EngineEvents stream to update the UI reactively.

import { loadConfig, hasConfiguredKey, customSecretKey, persistConfig, type PureConfig } from './config';
import { defaultModelFor, baseURLFor, isDeepSeekFamily, customProviderFor, customBaseURL, customDefaultModel, isCustomKeyless, providerOverrideFor, promptBudgetForProvider, imageGenEnabled, imageGenModelFor } from '../shared/providers';
import { saveSession, loadLastSession, loadSession, saveSessionStats, loadSessionStats, refreshSessionStatsFromDisk, dedupeFileWrites, upsertFileWrite, limitConversationMessages, mergeSessionSnapshotMetadata, createSessionSnapshot, createSessionPlanProgressPersistence, MAX_PERSISTED_MESSAGES, type TranscriptDraft, type ToolExecMeta, type SessionSnapshotV2, type SessionStats, type PlanCardSnapshot, type SessionPlanProgressPersistence } from './store';
import { mergeTokenUsage } from '../shared/usage';
import { memoryStore } from './memoryStore';
import { harvestUserPreferences } from '../shared/memory';
import { promptAssembler, buildGuiCapabilities, formatPromptBudgetDiagnostic, resolvePromptBudget, type PromptSkill } from '../shared/PromptAssembler';
import { compileRequestWorkflow } from '../shared/requestWorkflow';
import { stripUserTurnContext } from '../shared/promptLayers';
import { CodingAgent } from '../coding-agent/CodingAgent';
import { ContextEngine, type ContextCompactionResult } from '../harness/ContextEngine';
import { isGitMutationCommand, Tags } from '../coding-agent/ToolRegistry';
import { IMAGE_GEN_TOOL_DEF } from '../shared/toolDefs';
import { DYNAMIC_CAPABILITY_TOOL_DEFS, type DynamicCapabilityHooks, type DynamicMcpConnectionResult } from '../shared/dynamicCapabilityTools';
import { formatIntentPrompt, inferSemanticRoute, shouldBypassSemanticRoute } from '../coding-agent/Planner';
import { sanitizeSkillName } from './skillHub';
import { PermissionManager } from '../coding-agent/PermissionManager';
import { createDefaultVerifier } from '../coding-agent/Verifier';
import { BUILT_IN_SUBAGENTS } from '../coding-agent/SubagentOrchestrator';
import { requestPermission } from './permission';
import {
  requestPlanReview,
  formatPlanForPrompt,
  formatPlanContinuation,
  formatPlanPauseMessage,
  createPlanCard,
  updatePlanCard,
  clearPlanCardRefining,
  matchPlanProgressMarkers,
  type PlanProgressMarker,
  type PlanCardHandle,
} from './plan';
import { renderAttachmentCard } from './pasteChip';
import { PlanProgressModel, shouldAdvancePlanAtTurnEnd, type PlanProgressSnapshot } from './planProgress';
import { AutoContinueScheduler, AUTO_CONTINUE_DELAY_MS, DEFAULT_AUTO_CONTINUE_MAX_ROUNDS, type AutoContinueSignals } from './autoContinue';
import { TauriToolAdapter, getWebToolDefs, getSysInfoToolDefs, setToolOutputListener, takeGeneratedImages, type ImageGenContext } from './TauriToolAdapter';
import { createAssessmentFlowCard, type AssessmentFlowHandle } from './assessmentFlow';
import { attachPlanPauseActions } from './planPauseActions';
import { OpenAICompatibleAdapter } from '../adapter/openai/OpenAICompatibleAdapter';
import { RustLLMAdapter } from '../adapter/rust/RustLLMAdapter';
import { getApplicationTmpWorkspace, isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { renderMarkdown, scheduleStreamingRender, flushStreamingRender, cancelStreamingRender, stripToolCallXml } from './markdownLoader';
import { renderArtifactCards, type ArtifactItem } from './artifactCards';
import { linkifyPaths, setPathLinkWorkspace } from './pathLink';
import { wireScrollPin, scrollChatToBottomIfPinned, forceScrollToBottom, setScrollPinObservers } from './scrollPin';
import { createToolRow, updateToolRowArgs, finalizeToolRow, markToolRowStopped, appendToolStreamLine, truncateResultLines, isWebSearchLike, MAX_LIVE_STREAM_LINES, type ToolRowHandle } from './toolRow';
import { createThinkingCard, appendThinkingText, finalizeThinkingCard, setThinkingLabel, startThinkingTimer, stopThinkingTimer, dismissThinkingHint, HINT_LINGER_MS, type ThinkingCardHandle } from './thinkingCard';
import { DESIGN_READY_MARKER, deliveryVerificationSummary, discoverWorkspace, formatDeliveryFixPrompt, formatDeliveryPipeline, formatTaskContract, isBareWorkspace, buildTaskContract, isVerificationCommand, parseDesignReadyMarker, runDeliveryVerification, workspaceProfileSummary, type DeliveryVerificationResult, type TaskContract, type WorkspaceProfile } from '../shared/delivery';
import { createDesignPreviewCard } from './designPreviewCard';
import { parseResearchResult } from '../shared/research';
import { copyTextToClipboard } from '../shared/clipboard';
import { showToast } from '../shared/toast';
import { mergeTranscriptWithTurn } from '../shared/conversation';
import { t } from '../shared/i18n';
import { effectiveProxyUrl } from '../shared/proxy';
import { buildShellContext } from '../shared/shellEnv';
import { MCPClient } from '../harness/mcp/MCPClient';
import type { MCPServerConfig } from '../adapter/mcp/MCPTransport';
import type { WorkspaceRestoreResult, WorkspaceSnapshotPort } from '../shared/workspaceSnapshot';
import type {
  LLMAdapter,
  EngineEvent,
  ToolAdapter,
  ToolCall,
  ToolResult,
  ToolDefinition,
  Message,
  MessageImage,
  BudgetConfig,
  GeneratedImage,
} from '../shared/types';
import type { PermissionMode, PermissionRequestHandler, PermissionRequestInfo, PermissionDecision, TrapWarning, Plan, TaskMode, IntentAssessment } from '../coding-agent/types';

// Friendly labels for the logical-trap status bubble (raw type ids like
// 'self-contradiction' are cryptic to users).
const TRAP_TYPE_LABELS: Record<TrapWarning['type'], string> = {
  'self-contradiction': '自相矛盾',
  'impossible-constraint': '不可能满足的约束',
  'mutually-exclusive': '互斥要求',
  'trap-keyword': '悖论/陷阱题',
};

// Tool-call JSON re-parse throttle: streaming a giant argument (write_file
// `content`, a whole HTML file) grows the buffer to tens of KB; re-parsing it
// and rebuilding the Input panel on every token is O(n²) and freezes the UI.
// Mirrors the 100ms streaming-render throttle (markdown.ts).
const TOOL_CALL_REFRESH_MS = 120;

// ── Interrupt-reason sanitization ──
// FailurePolicy.stop reasons are written as instructions FOR the model (they
// contain raw HTTP error text, tool names, and directives like "stop making it").
// Surfacing them verbatim leaks internals to the user.  This helper replaces
// the reason with a localized, user-friendly summary.
function sanitizeInterruptedReason(raw: string): string {
  const lower = raw.toLowerCase();
  if (/429|rate.?limit|rate.?exceeded|too many request/i.test(lower)) {
    return t('chat.interrupted.rateLimited', 'Rate limited — please try again later');
  }
  if (/5\d{2}|server.?error|internal.?server/i.test(lower)) {
    return t('chat.interrupted.serverError', 'Service temporarily unavailable — please try again later');
  }
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|network|fetch.?fail|ENOTFOUND/i.test(lower)) {
    return t('chat.interrupted.networkError', 'Network connection failed — please check your connection');
  }
  return t('chat.interrupted.generic', 'Operation interrupted — please retry or try a different approach');
}

// ── Explicit continuation detection ──
// A plan stays in the transcript as context, but a NEW user request mid-plan
// ("页面太丑改一下" / "加个登录按钮") must be handled naturally — NOT forced into
// the "继续处理第 x 阶段第 y 个 Todo" continuation frame. Only an explicit
// "继续 / 接着做 / continue …" instruction should keep that rigid frame; a
// plain new request just lets the model understand and act on the existing
// context. Heuristic, not a parser: matched against the trimmed, lowercased
// message so mixed-case and trailing punctuation are tolerated.
const CONTINUATION_PREFIX = /^(继续|接着|往下|继续往下|继续做|接着做|往下做|继续吧|接着吧|go\s*on|continue|resume|keep\s*going|carry\s*on)/;
function isExplicitContinuation(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (CONTINUATION_PREFIX.test(t)) return true;
  // Whole message is just a continuation word (strip surrounding punctuation).
  return ['继续', '接着', '往下', 'continue', 'resume', 'go on', 'keep going'].includes(
    t.replace(/[。.，,！!？?~～\s]/g, ''),
  );
}

// Kept as a compatibility hook for the app shell. Transcript rows must not be
// removed from the live DOM: deleting them made upward scrolling show missing
// history and also raced session restore. Performance is handled by throttled
// rendering instead of destructive transcript pruning.

// ── "New content below" hint ──
// Auto-scroll pauses once the user scrolls up to re-read history. When new
// content then arrives below, a small floating pill appears above the input
// bar so the user knows the transcript is still growing (scrollPin fires
// onUnpinnedNewContent for every content change while unpinned; the pill is
// created once and stays until dismissed). Clicking it jumps back to the
// bottom; scrolling back to the bottom or sending a new message hides it.
let scrollHintBtn: HTMLButtonElement | null = null;

function showNewContentHint(chatEl: HTMLElement): void {
  if (scrollHintBtn && document.contains(scrollHintBtn)) return;
  scrollHintBtn?.remove();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'new-content-hint';
  btn.textContent = t('chat.newContent');
  btn.title = t('chat.newContentHint');
  btn.setAttribute('aria-label', t('chat.newContentHint'));
  btn.addEventListener('click', () => {
    forceScrollToBottom(chatEl);
    hideNewContentHint();
  });
  document.getElementById('chat-view')?.appendChild(btn);
  scrollHintBtn = btn;
}

/** Remove the hint pill (exported for the fresh-turn path in send()). */
export function hideNewContentHint(): void {
  scrollHintBtn?.remove();
  scrollHintBtn = null;
}

/** Idempotent per-transcript wiring: bridges scrollPin observers → hint UI. */
function wireNewContentHint(chatEl: HTMLElement): void {
  if (chatEl.dataset.newContentHintWired === '1') return;
  chatEl.dataset.newContentHintWired = '1';
  setScrollPinObservers({
    onUnpinnedNewContent: (el) => { if (el === chatEl) showNewContentHint(el); },
    onPinStateChange: (_el, pinned) => { if (pinned) hideNewContentHint(); },
  });
}

/**
 * Resolve which message history a continuation turn should run on: the
 * background pre-compacted window when it still matches the current session
 * and message state, otherwise the full transcript (whose in-engine trim then
 * runs synchronously as before).
 */
export function pickHistoryMessages(
  preCompacted: Message[] | null,
  preCompactSessionId: string,
  preCompactMessageCount: number,
  sessionId: string,
  messages: Message[],
  preCompactSource?: Message[] | null,
): Message[] {
  return preCompacted !== null &&
    preCompactSessionId === sessionId &&
    messages.length === preCompactMessageCount &&
    (preCompactSource === undefined || preCompactSource === messages)
    ? preCompacted
    : messages;
}

export { mergeTranscriptWithTurn } from '../shared/conversation';

export function shouldCancelForEscape(key: string, streaming: boolean): boolean {
  return streaming && key === 'Escape';
}

const DEFAULT_BUDGET: BudgetConfig = {
  maxTurns: 50,
  maxTotalTokens: 1_000_000,
  maxExecutionTime: 3_600_000,
  warningThreshold: 0.8,
  graceTurns: 3,
};

function isWebTool(name: string): boolean {
  // Includes MCP-discovered web tools (serverName__search / __fetch / ...) —
  // see isWebSearchLike in toolRow.ts for the base-name matching.
  return isWebSearchLike(name);
}

// File-system tool family — gated by the `toolFS` settings toggle so users can
// disable read/write/edit/search as a group from Settings → Tools.
const FS_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file', 'write_file', 'edit_file', 'search_files', 'find_files', 'list_files',
  'glob_files', 'create_directory', 'diff_files', 'replace_files',
]);

function isFsTool(name: string): boolean {
  return FS_TOOL_NAMES.has(name);
}

// ── Tool row helpers ──────────────────────────────────────────────────────
// Tool calls render as Claude-Code-style inline rows in the chat transcript
// (`.tool-row`), NOT floating toasts. Each row shows a friendly name, args
// summary, and status (spinner → ✓/✗ + duration); click to expand Input/Output.
// Shared DOM building lives in toolRow.ts so live chat and session replay
// render identically.

type ToolRowEntry = {
  row: ToolRowHandle;
  toolName: string;
  args: Record<string, unknown>;
  toolCallId?: string;
};

// Parse a tool-call buffer into { name?, args? }. Two formats occur in practice:
// 1. The { name, arguments } wrapper some adapters emit (arguments either a
//    pre-parsed object or a JSON string).
// 2. RAW function-arguments JSON ({"query": "..."}) — the engine forwards
//    tc.function.arguments / chunk.arguments verbatim, which is exactly this
//    format. Without the fallback every tool row rendered with empty args: two
//    parallel web_search calls then looked like ONE duplicated search instead
//    of two queries (see the "两个 web Search 同时出现" report).
export function assistantBubbleTextForCopy(bubble: HTMLElement): string {
  const clone = bubble.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('button, .svg-slot, .chart-slot, .mermaid-slot, .puml-diagram').forEach((el) => el.remove());
  return (clone.innerText || clone.textContent || '').trim();
}

export function shouldCopyAssistantBubbleTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as { closest?: unknown }).closest !== 'function') return true;
  return !(target as Element).closest('button, a, [role="button"], .svg-target, .chart-target, .mermaid-target, .md-img-wrap');
}

export async function copyAssistantBubbleText(
  text: string,
  copy: (value: string) => Promise<boolean> = copyTextToClipboard,
  toast: (message: string) => void = showToast,
): Promise<boolean> {
  if (!text) return false;
  const copied = await copy(text);
  toast(copied ? t('assistant.copied') : t('assistant.copyFailed'));
  return copied;
}

export function bindAssistantBubbleCopy(bubble: HTMLElement): void {
  if (bubble.dataset.assistantCopyBound === '1') return;
  bubble.dataset.assistantCopyBound = '1';
  bubble.addEventListener('dblclick', async (event) => {
    if (!shouldCopyAssistantBubbleTarget(event.target)) return;
    const text = assistantBubbleTextForCopy(bubble);
    if (!text) return;
    void copyAssistantBubbleText(text);
  });
}

/** Double-click a user bubble to select ALL of its text at once. User messages
 * are raw text (a browser double-click would only select one word), so this
 * mirrors the assistant copy shortcut: live bubbles (addBubble) and restored
 * bubbles (main.ts session replay) both bind it. */
export function bindUserBubbleSelectAll(bubble: HTMLElement): void {
  if (bubble.dataset.userSelectAllBound === '1') return;
  bubble.dataset.userSelectAllBound = '1';
  bubble.addEventListener('dblclick', (event) => {
    // Keep linkified paths (and any future interactive children) clickable.
    const target = event.target as Element | null;
    if (target?.closest?.('a, button, [role="button"]')) return;
    const range = document.createRange();
    range.selectNodeContents(bubble);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

// The currently open viewer's close function. Replacing a viewer must first
// run the previous close, otherwise its document keydown listener (and the
// closure over the detached overlay) would leak on every double-open.
let userImageViewerClose: (() => void) | null = null;

export function openUserImageViewer(image: MessageImage, alt = image.name || '上传图片'): void {
  userImageViewerClose?.();
  userImageViewerClose = null;
  const overlay = document.createElement('div');
  overlay.className = 'user-image-viewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', alt);
  const img = document.createElement('img');
  img.src = image.dataUrl;
  img.alt = alt;
  img.className = 'user-image-viewer-img';
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    if (userImageViewerClose === close) userImageViewerClose = null;
  };
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  userImageViewerClose = close;
  document.addEventListener('keydown', onKeydown);
}

export function renderUserImageAttachments(bubble: HTMLElement, images: MessageImage[]): void {
  if (!images.length) return;
  const gallery = document.createElement('div');
  gallery.className = 'user-image-attachments';
  for (const image of images) {
    if (!image.dataUrl) continue;
    const img = document.createElement('img');
    img.className = 'user-image-thumb';
    img.src = image.dataUrl;
    img.alt = image.name || '上传图片';
    img.title = '双击放大';
    img.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      openUserImageViewer(image, img.alt);
    });
    gallery.appendChild(img);
  }
  if (gallery.children.length > 0) bubble.appendChild(gallery);
}

export function parseToolCallBuffer(buf: string | undefined): { name?: string; args?: Record<string, unknown> } {
  const trimmed = (buf ?? '').trim();
  if (!trimmed) return {};
  let parsed: any;
  try { parsed = JSON.parse(trimmed); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object') return {};
  const name = typeof parsed.name === 'string' ? parsed.name : undefined;
  let args: Record<string, unknown> | undefined;
  if (parsed.arguments && typeof parsed.arguments === 'object') {
    args = parsed.arguments as Record<string, unknown>;
  } else if (typeof parsed.arguments === 'string') {
    try { args = JSON.parse(parsed.arguments) as Record<string, unknown>; } catch { args = undefined; }
  } else if (!('arguments' in parsed) && !name) {
    // Raw arguments object (no wrapper keys): treat the whole parsed object as
    // the args. The `!name` guard keeps a name-only payload from being misread
    // as args.
    args = parsed as Record<string, unknown>;
  }
  return { name, args };
}

/**
 * Map a tool name to its settings-toggle gate. Unknown tools (subagents,
 * MCP-discovered, future additions) default to enabled so the gate never
 * silently hides a tool the user didn't explicitly disable.
 */
function isToolEnabled(name: string, config: PureConfig): boolean {
  if (isWebTool(name)) return config.toolBrowser;
  if (name === 'execute_command') return config.toolCmd;
  if (name.startsWith('git_')) return config.toolGit;
  if (isFsTool(name)) return config.toolFS;
  return true;
}

// ── Scroll & status-bubble helpers ──
//
// Pinned-to-bottom tracking and rAF-coalesced auto-scroll live in scrollPin.ts
// (shared with main.ts session restore). The reason it is coalesced: tokens /
// streamed command lines / reasoning deltas can arrive many times per frame,
// and each direct scrollTop write reads scrollHeight (a forced layout on the
// WHOLE transcript — all bubbles, code blocks, SVGs), so per-event scrolling
// is the classic long-transcript stutter. One rAF-scheduled scroll per frame
// caps the cost at the display refresh rate.
//
// Why not a px threshold for pinning? The old approach (scroll only when
// scrollHeight - scrollTop - clientHeight < 120) broke the moment a single
// markdown render grew the transcript by more than the threshold in one step
// — e.g. diffStreaming landing a complete fenced code block in one throttled
// pass, or renderMarkdown replacing the bubble on Completed. The distance
// from bottom then exceeded the threshold and auto-scroll silently stopped
// even though the user never scrolled up, leaving the scrollbar stuck above
// the newest content.

// Resolve every still-pending tool row (stream ended without a ToolResult —
// aborted mid-call, error, or budget stop) so none remains in `pending` state.
// Rows stay in the transcript, marked stopped (⏹) instead of dismissed.
// The per-call parse-throttle map is cleared alongside so stale keys never
// accumulate across turns.
function resolvePendingToolRows(refresh: Map<string, number>, ...maps: Map<string, ToolRowEntry>[]): void {
  refresh.clear();
  for (const map of maps) {
    for (const [, entry] of map) {
      markToolRowStopped(entry.row);
    }
    map.clear();
  }
}

// Plain-chat-mode tool lists: web tools (gated by the toolBrowser toggle) +
// sys_info (always callable without a workspace — the Rust backend ignores
// the workspace field), so the LLM can't generate a function call the hybrid
// adapter will then reject. Schemas come from TauriToolAdapter — single
// source of truth, no drift on field changes.
const WEB_TOOL_DEFS: ToolDefinition[] = getWebToolDefs();
const SYS_INFO_DEFS: ToolDefinition[] = getSysInfoToolDefs();

// Layered prompt assembly (L0 system core + L1 tools/behavior + L2 per-request
// user context — see src/shared/promptLayers.ts). The immutable identity,
// operating principles, permission modes, runtime and response-format contract
// come from the shared SYSTEM_CORE_PROMPT; the tools block and workspace
// capability note are application-layer; per-request fragments (traps,
// artifact protocol, approved plan) are composed into the USER message via
// composeUserTurn at the run call, never appended to the system prompt.
// Exported for the regression guard in chat.test.ts (asserts section headers
// appear exactly once — a past splice bug doubled "Output style:").
export const BASE_SYSTEM_PROMPT = (hasWorkspace: boolean, temporaryWorkspace = false): string =>
  promptAssembler.buildSystemPrompt({
    surface: 'gui',
    capabilities: buildGuiCapabilities(hasWorkspace, temporaryWorkspace),
  });

// The cross-session memory store singleton lives in ./memoryStore (own module
// so the settings panel can render the memory dashboard without importing this
// whole chat pipeline).

// Lightweight environment context injected into every turn's system prompt.
// Time/timezone intentionally stay OUT (they go stale immediately — the model
// calls sys_info() for those); only the location + answer language are stable
// enough to pre-seed. This is what lets "帮我安排一个去上海的旅游计划" resolve
// its departure point to the user's configured city without a lookup.
function buildEnvironmentContext(config: PureConfig | null): string {
  const lang = config?.language === 'en' ? 'English' : 'Chinese (zh-CN)';
  const city = config?.city?.trim();
  if (!city) {
    return `Environment: reply in ${lang}. The user has NOT configured a location — when a task depends on where they are (trip planning, weather, local services), ask for it or state the assumption clearly.`;
  }
  return `Environment: reply in ${lang}; user location is ${city} (configured in Settings → General → Environment). Use ${city} as the user's home base — e.g. the departure point for trip planning, the reference for weather / local services. Call sys_info() for the exact current time, timezone, or OS.`;
}

function buildModelIdentity(config: PureConfig | null): { provider: string; model: string } | undefined {
  const provider = config?.provider?.trim();
  if (!provider) return undefined;
  const model = config?.model?.trim() || customDefaultModel(config?.customProviders, provider);
  return model ? { provider, model } : undefined;
}

function buildSystemPrompt(hasWorkspace: boolean, temporaryWorkspace = false, config: PureConfig | null = null, toolDefinitions: ToolDefinition[] = [], imageGeneration = false): string {
  return promptAssembler.buildSystemPrompt({
    surface: 'gui',
    capabilities: buildGuiCapabilities(hasWorkspace, temporaryWorkspace, { imageGeneration }),
    imageGeneration,
    toolDefinitions,
    modelIdentity: buildModelIdentity(config),
    environment: buildEnvironmentContext(config),
    runtimes: buildRuntimesContext(),
    network: buildNetworkContext(),
    shell: buildShellContextLine(),
    skills: config?.hubSkills,
    budget: promptBudgetForProvider(config?.customProviders, config?.provider, config?.model),
  });
}

function makeAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function makeTimeoutError(message: string): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

/** Race preflight work against the active turn's AbortSignal. The underlying
 * IPC promise may finish later, but the UI never waits for an uncancellable
 * native call before releasing the composer and stop controls. */
function withAbortTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => finish(() => reject(makeAbortError(`${label} aborted`)));
    timer = setTimeout(() => finish(() => reject(makeTimeoutError(`${label} timed out`))), timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

// ── Environment probe: installed runtimes + network state ──
// Probed ONCE per session via the Rust sys_info backend (Tauri only) and
// cached, then injected into every system prompt so the model knows which
// runtimes exist on this machine (e.g. whether `node` is available before
// proposing a Node script) and which network it sits on (system/env proxy,
// VPN, domestic/international reachability — so web_search backends and
// web_fetch targets are chosen for what actually works). The Rust side now
// warms its own process-level cache at app startup (static fields permanent,
// network fields TTL), so this front-end promise resolves instantly after
// the first send AND every later sys_info tool call hits the same cache
// instead of re-probing. A missing probe (browser dev mode, Rust invoke
// failure) leaves the context empty — the sys_info tool still reports on
// demand in that case.
let cachedRuntimes = '';
let cachedNetwork = '';
let cachedOs = '';
let runtimesProbe: Promise<string> | null = null;

/** Kick off the one-shot environment probe (idempotent). Callers await the
 * same promise so the first send doesn't race the probe. */
export function ensureRuntimesProbed(signal?: AbortSignal): Promise<string> {
  if (!runtimesProbe) {
    runtimesProbe = (async () => {
      try {
        const core = await loadTauriCore();
        if (!core) return '';
        const raw = await withAbortTimeout(
          core.invoke<string>('sys_info', { workspace: '', location: null }),
          undefined,
          8_000,
          'environment probe',
        ) ?? '';
      // sys_info output: "runtimes:  node: v22.x.x  bun: 1.3.x  python3: 3.x.x  rustc: …"
      // and "network:   proxy: …; env: …; vpn: …; reach: …"
        const m = raw.match(/^runtimes:\s*(.+)$/m);
        cachedRuntimes = m?.[1]?.trim() ?? '';
        const n = raw.match(/^network:\s*(.+)$/m);
        cachedNetwork = n?.[1]?.trim() ?? '';
        const o = raw.match(/^os:\s*(.+)$/m);
        cachedOs = o?.[1]?.trim() ?? '';
      } catch {
        cachedRuntimes = '';
        cachedNetwork = '';
        cachedOs = '';
      }
      return cachedRuntimes;
    })();
  }
  return withAbortTimeout(runtimesProbe, signal, 8_500, 'environment probe');
}

function buildRuntimesContext(): string {
  return cachedRuntimes
    ? `\nEnvironment runtimes (installed on this machine): ${cachedRuntimes}. Use the actual versions above when the task depends on a runtime or tool version (e.g. writing a package.json engines field, a requirements.txt, or a CI/git workflow), and assume a tool is NOT installed when it is absent from this list.`
    : '';
}

function buildNetworkContext(): string {
  if (!cachedNetwork) return '';
  return `\nEnvironment network (this machine): ${cachedNetwork}. Use it to choose what will actually work: if international is blocked, prefer domestic search engines (cn.bing.com / sogou / baidu / 360) and domestic sources, and expect Google/DuckDuckGo to fail; if a system/env proxy is listed, requests route through it when proxy is enabled in Settings → 网络代理.`;
}

function buildShellContextLine(): string {
  return cachedOs ? buildShellContext(cachedOs) : '';
}

// Third-party skills installed from a Skill Hub (Settings → Skills → Skill
// Hub) are injected into the system prompt when enabled — the model follows
// each skill's SKILL.md instructions just like the built-in skills. Bodies are
// pre-stripped of frontmatter at install time (splitSkillMarkdown).
function buildHubSkillsContext(config: PureConfig | null): string {
  const skills = config?.hubSkills ?? [];
  const enabled = skills.filter((s) => s.enabled && s.body);
  if (enabled.length === 0) return '';
  return `

Installed skills (follow these when they apply):
${enabled.map((s) => `
<skill name="${sanitizeSkillName(s.name)}">
${s.body}
</skill>`).join('')}`;
}

// ── Permission policy mapping ──
// The settings panel exposes a global permission mode plus fine-grained
// auto-approve toggles per tool category (read / write / cmd / git). Map them
// onto the PermissionManager modes and wrap the dialog handler.

function mapPermissionMode(mode: PureConfig['permissionMode'] | undefined): PermissionMode {
  switch (mode) {
    case 'auto': return 'YOLO';
    case 'restricted': return 'DONT_ASK';
    case 'confirm': return 'NORMAL';
    default: return 'NORMAL';
  }
}

function toolCategory(tool: string): 'read' | 'write' | 'cmd' | 'git' | 'other' {
  if (tool.startsWith('git_')) return 'git';
  if (tool === 'execute_command') return 'cmd';
  if (tool === 'write_file' || tool === 'edit_file' || tool === 'create_directory' || tool === 'replace_files') return 'write';
  // Web tools (DuckDuckGo search + plain HTTP fetch) are pure reads: they
  // never mutate state, never execute code, and the Rust backend restricts
  // web_fetch to text/html + text/plain content types and strips
  // <script>/<style> before returning. Grouping them under 'read' lets the
  // same autoPermRead toggle (default true in settings.ts) silently approve
  // web calls just like local file reads — plain-chat users aren't prompted
  // before every web_search / web_fetch.
  //
  // NB: by short-circuiting here, this branch never reaches PermissionManager,
  // so the "Allow always for this session" option (remember:true) is moot for
  // web reads — auto-approve already covers them per session.
  if (isWebTool(tool) || tool === 'sys_info' || tool === 'read_file' || tool === 'list_files' || tool === 'search_files' || tool === 'glob_files' || tool === 'diff_files') return 'read';
  return 'other';
}

function createPermissionHandler(config: PureConfig): PermissionRequestHandler {
  return async (info: PermissionRequestInfo): Promise<PermissionDecision> => {
    const cat = toolCategory(info.tool);
    const auto = cat === 'read' ? config.autoPermRead
      : cat === 'git' ? config.autoPermGit
      : cat === 'write' ? config.autoPermWrite
      : cat === 'cmd' ? config.autoPermCmd
      : false;
    if (auto) return { allowed: true, autoApproved: true };
    return requestPermission(info);
  };
}

// ── Adapter factory ──

function createLLMAdapter(config: ReturnType<typeof loadConfig>): LLMAdapter {
  if (!config) {
    throw new Error('No configuration');
  }
  const customs = config.customProviders ?? [];
  const custom = customProviderFor(customs, config.provider);
  // Custom providers resolve their own base URL / default model; built-ins
  // fall back to the shared registry (a per-provider override, e.g. a proxy
  // or mirror set in Settings → LLM → 连接设置, wins over the registry). The
  // legacy global config.baseURL is deliberately NOT read here — a stale
  // value once hijacked every provider's endpoint.
  const baseURL = customBaseURL(customs, config.provider, config.providerOverrides);
  const model = config.model || customDefaultModel(customs, config.provider);
  // DeepSeek reasoning models spend reasoning_content tokens from the SAME
  // output budget as content — at the shared 8192 default, complex tasks (e.g.
  // generating a full HTML animation) exhaust the budget on thinking and the
  // visible answer comes back EMPTY → verify failure → retry loop. Give
  // DeepSeek a larger budget; Qwen/GLM/custom keep the shared default.
  const maxTokens = !custom && isDeepSeekFamily(config.provider)
    ? 32768
    : undefined;
  // GLM's tool_stream extra applies to the built-in GLM provider only.
  const extraBody = !custom && config.provider === 'glm' ? { tool_stream: true } : undefined;
  if (isTauriRuntime()) {
    // Desktop: the key lives in Rust secrets (~/.pure/secrets.json, 0600) and
    // is resolved inside `chat_stream` — it never passes through the WebView.
    // Custom providers resolve their own named secret ('llm.apiKey.<id>');
    // keyless ones resolve to nothing and Rust omits the Authorization header.
    const builtinOverride = providerOverrideFor(config.providerOverrides, config.provider);
    return new RustLLMAdapter({
      provider: config.provider,
      model,
      baseURL,
      // Built-in providers with their own saved key resolve it from the same
      // per-provider Rust secret slot ('llm.apiKey.<id>') as custom providers;
      // without an override the Rust backend falls back to the shared
      // 'llm.apiKey' slot (or omits the header for keyless custom endpoints).
      secretKey: custom ? customSecretKey(custom.id)
        : builtinOverride?.hasApiKey ? customSecretKey(config.provider)
        : undefined,
      proxyUrl: effectiveProxyUrl(config.proxy, 'llm'),
      proxyBypassProviders: config.proxy?.bypassProviders ?? [],
      extraBody,
      maxTokens,
    });
  }
  const builtinOverride = providerOverrideFor(config.providerOverrides, config.provider);
  const apiKey = custom?.apiKey ?? builtinOverride?.apiKey ?? config.apiKey;
  if (!apiKey && !isCustomKeyless(customs, config.provider)) {
    throw new Error('No API key configured');
  }
  return new OpenAICompatibleAdapter({
    baseURL,
    apiKey: apiKey ?? '',
    model,
    extraBody,
    maxTokens,
  });
}

// TauriToolAdapter passes the effective workspace through to the Rust backend
// for every call. When the user has not selected a workspace, send() supplies
// an application-owned temporary directory for this session; web tools remain
// filesystem-independent.

/**
 * App skills from ~/.pure/skills plus the workspace's .agents/skills (the
 * capability-gap protocol's install targets), injected into the system prompt
 * like Skill Hub skills. Desktop: read via the Rust list_app_skills command;
 * browser dev mode: none. Cached for 30s (keyed on the workspace) so a skill
 * installed mid-session loads without a restart while a per-turn invoke is
 * avoided.
 */
interface AppSkillEntry { name: string; description: string; body: string }
let appSkillsCache: { at: number; workspace: string; items: PromptSkill[] } | null = null;
async function loadAppSkills(workspace: string): Promise<PromptSkill[]> {
  const ws = workspace || '';
  if (appSkillsCache && Date.now() - appSkillsCache.at < 30_000 && appSkillsCache.workspace === ws) {
    return appSkillsCache.items;
  }
  let items: PromptSkill[] = [];
  if (isTauriRuntime()) {
    try {
      const core = await loadTauriCore();
      const entries = await core?.invoke<AppSkillEntry[]>('list_app_skills', { workspace: ws });
      items = (entries ?? []).map((entry) => ({
        name: entry.name,
        body: entry.body,
        enabled: true,
      }));
    } catch (err) {
      console.warn('[pure] failed to load app skills:', err);
    }
  }
  appSkillsCache = { at: Date.now(), workspace: ws, items };
  return items;
}
const MAX_MESSAGE_HISTORY = MAX_PERSISTED_MESSAGES;

function limitMessageHistory(messages: Message[], max = MAX_MESSAGE_HISTORY): Message[] {
  return limitConversationMessages(messages, max);
}

// 预检不再有固定的“开工前确认几个问题”卡片，也不再做 LLM 实时预分析（该环节
// 从未稳定成功过：超时/空输出只会拖慢启动并留下失败提示与通用步骤兜底的噪音）。
// 计划直接来自本地规则分析（Planner.analyzeTask），关键细节由模型在执行语境中
// 自然提问解决——问题由执行过程驱动，而不是在思考前弹一张预制的卡片。

// Short display label for the auto-selected task mode (used in status bubbles
// and the plan-card chip).
// Short display label for the auto-selected task mode (used in status bubbles
// and the plan-card chip).
function modeLabel(mode: TaskMode): string {
  switch (mode) {
    case 'build': return t('plan.mode.build');
    case 'plan': return t('plan.mode.plan');
    default: return t('plan.mode.yolo');
  }
}

/** Short user-facing risk label used by the assessment card / status bubbles. */
function riskLabelOf(risk: IntentAssessment['riskLevel']): string {
  switch (risk) {
    case 'high': return '高风险';
    case 'medium': return '中风险';
    default: return '低风险';
  }
}

/** Keep safety review independent from the current plan cursor. A new
 * high-risk request must reopen review even during a paused or active plan. */
export function shouldEnterPlanReview(
  continuingPlan: boolean,
  planPauseRequested: boolean,
  planningEnabled: boolean,
  needsDeliveryGate: boolean,
  requiresConfirmation: boolean,
  workflowRequiresPlanReview = true,
): boolean {
  return requiresConfirmation || (workflowRequiresPlanReview
    && (!continuingPlan || requiresConfirmation)
    && (!planPauseRequested || requiresConfirmation)
    && (planningEnabled || needsDeliveryGate));
}

/**
 * Resolve the text-to-image context for the connected provider: undefined when
 * the provider/model has no image-generation support (SVG stays the fallback),
 * otherwise the image model id + endpoint + secrets key the generate_image
 * tool needs. Mirrors createLLMAdapter's resolution (same base URL / key).
 */
function imageGenContextFor(config: PureConfig): ImageGenContext | undefined {
  const customs = config.customProviders ?? [];
  if (!imageGenEnabled(customs, config.provider, config.model)) return undefined;
  const custom = customProviderFor(customs, config.provider);
  return {
    provider: config.provider,
    model: imageGenModelFor(customs, config.provider, config.model),
    baseURL: customBaseURL(customs, config.provider, config.providerOverrides),
    secretKey: custom ? customSecretKey(custom.id)
      : providerOverrideFor(config.providerOverrides, config.provider)?.hasApiKey ? customSecretKey(config.provider)
      : undefined,
    // Image generation hits the provider's LLM-family API — route it through
    // the same proxy scope (and bypass rules) as chat traffic.
    proxyUrl: effectiveProxyUrl(config.proxy, 'llm'),
    proxyBypassProviders: config.proxy?.bypassProviders ?? [],
  };
}

function createToolAdapter(workspace: string, config: PureConfig, sessionId = '', capabilityHooks?: DynamicCapabilityHooks): ToolAdapter {
  const inner = new TauriToolAdapter(workspace, config.tavilyApiKey, config.serperApiKey, config.city, undefined, sessionId, effectiveProxyUrl(config.proxy, 'tools'), imageGenContextFor(config), config.searxngUrl, capabilityHooks);
  // A tool is available only when the settings toggle allows it. The caller
  // supplies either the selected user workspace or the session's application
  // temporary workspace, so filesystem tools have a valid root in both modes.
  // generate_image is workspace-independent (it calls the provider's image
  // API), so it stays available in plain-chat mode like the web tools.
  const available = (name: string): boolean =>
    isToolEnabled(name, config) && (!!workspace || isWebTool(name) || name === 'sys_info' || name === 'generate_image' || DYNAMIC_CAPABILITY_TOOL_DEFS.some((tool) => tool.name === name));
  return {
    getTools: () => inner.getTools().filter((t) => available(t.name)),
    getMetadata: (name) => (available(name) ? inner.getMetadata(name) : undefined),
    getSnapshotPort: () => inner.getSnapshotPort(),
    execute: async (toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> => {
      const name = toolCall.function.name;
      if (!available(name)) {
        const why = `'${name}' is disabled in Settings → Tools.`;
        return { id: toolCall.id, toolName: name, error: why, success: false, duration: 0 };
      }
      return inner.execute(toolCall, signal);
    },
  };
}

/** Let the browser complete one paint after newly appended transcript
 * content before continuing with send-time setup or other expensive work. A
 * single rAF callback runs before its frame paints; the second callback proves
 * that at least the intervening frame was presented. */
function yieldToNextPaint(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, 250);
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener('abort', finish, { once: true });
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(finish));
    } else {
      finish();
    }
  });
}

// ── ChatController ──

export class ChatController {
  private streaming = false;
  private abortController: AbortController | null = null;
  private onStreamingChange?: (streaming: boolean) => void;
  private workspace: string = '';
  private effectiveWorkspace: string = '';
  private sessionId: string = '';
  private messages: Message[] = [];
  private hasHistory = false;
  // Cross-turn complex-task workflow state. The plan and cursor survive the
  // end of send() so the next user message continues the same Todo instead of
  // reopening the planning preflight.
  private activeComplexPlan: Plan | null = null;
  private activePlanNumber = 1;
  private activeTodoNumber = 1;
  private activePlanStarted = false;
  // Persistable snapshot of the in-chat plan card for the CURRENT turn, so a
  // session restore can rebuild the card in place with its progress. Reset at
  // the top of every send() and set whenever a plan card is shown or its
  // cursor advances; a completed plan keeps its final snapshot for that turn's
  // persist even though activeComplexPlan is cleared on completion.
  private activePlanCardSnapshot: PlanCardSnapshot | null = null;
  private activePlanProgress: PlanProgressModel | null = null;
  // Live handle of the plan card currently in the transcript. A continuation
  // turn rebinds THIS card to a fresh progress model (updatePlanCard) instead
  // of appending a duplicate card per round.
  private activePlanCardHandle: PlanCardHandle | null = null;
  private activePlanProgressUnsubscribe?: () => void;
  private activePlanProgressPersistence?: SessionPlanProgressPersistence;
  /** Whether the active plan was approved as a project build — carried across
   * continuation turns so the delivery gate follows the plan, not the prompt. */
  private activePlanProjectBuild = false;
  /** Per-session count of how many times each generated/modified file has been
   * written (write_file / edit_file / replace_files) this session. Drives the
   * "v1 / v2 / …" version badge on artifact cards so the user can see which
   * revision a card reflects when a file is updated several times. Keyed by a
   * normalized path; reset on a new chat (clear()). */
  private fileWriteVersions = new Map<string, number>();
  // Background pre-compaction cache: the ContextEngine's LLM summarization —
  // the dominant pre-send cost once a long session crosses maxMessages — runs
  // after each completed turn (idle) instead of blocking the next send. The
  // reuse guard (sessionId + message count) makes a stale window inert.
  private contextEngine?: { compact(messages: Message[], options?: { force?: boolean }): Promise<ContextCompactionResult> };
  private preCompactedMessages: Message[] | null = null;
  private preCompactSourceMessages: Message[] | null = null;
  private preCompactSessionId = '';
  private preCompactMessageCount = 0;
  private cancelPreCompaction: (() => void) | null = null;
  private mcpClient?: MCPClient;
  private deferredInitDone = false;
  // Session identity + MCP config the current mcpClient was built with. MCP
  // stdio transports are session-bound (the Rust registry keys subprocesses by
  // sessionId), so a client must be torn down and rebuilt when either changes.
  private mcpSessionId = '';
  private mcpConfigSnapshot = '';
  private dynamicMcpConnector: ((config: MCPServerConfig, signal?: AbortSignal) => Promise<DynamicMcpConnectionResult>) | null = null;
  private readonly dynamicCapabilityHooks: DynamicCapabilityHooks = {
    connectMcpServer: (config, signal) => {
      if (!this.dynamicMcpConnector) return Promise.reject(new Error('Dynamic MCP connection is not ready'));
      return this.dynamicMcpConnector(config, signal);
    },
  };
  // Generation counter: bumped on every session switch / new chat so an
  // in-flight send() loop notices it has been superseded (see send()).
  private generation = 0;
  // In-transcript pause cards (plan card + assessment card), hoisted from the
  // turn closure so the pause-bubble cancel shortcut can flip them out of the
  // "等待你回复" state. Cleared on continue / cancel / clear.
  private pausePlanCard: PlanCardHandle | null = null;
  private pauseAssessmentFlow: AssessmentFlowHandle | null = null;
  // Long-task auto-continue (docs/auto-continue-design.md): the scheduler owns
  // the pending round timer + per-user-message budget; pendingAutoContinue
  // carries the last completed round's signals from the engine loop to send()'s
  // finally, where streaming is released and the schedule actually happens.
  private autoContinue = new AutoContinueScheduler();
  private pendingAutoContinue: AutoContinueSignals | null = null;
  // Session-scoped permission manager: CodingAgent creates its own per send,
  // which would reset the "始终允许(本次会话)" cache after every turn. Hoisted
  // here so approvals last the whole chat session; cleared on new chat.
  private permissionManager: PermissionManager;
  // Per-session usage stats (token totals, cost, search / file / command
  // activity) for the right-panel 统计 tab. Reloaded on session switch,
  // persisted to localStorage after every completed turn.
  private sessionStats: SessionStats = { searches: [], fileWrites: [], fileReads: [], commands: [] };
  private onStatsChanged?: (stats: SessionStats) => void;
  private snapshotPort?: WorkspaceSnapshotPort;
  private sessionToolAdapter?: ToolAdapter;
  private sessionToolAdapterKey = '';
  private onSnapshotChanged?: (available: boolean) => void;

  constructor() {
    this.sessionId = `session_${Date.now()}`;
    this.permissionManager = new PermissionManager();
    this.sessionStats = loadSessionStats(this.sessionId);
  }

  onStreamingStateChange(fn: (streaming: boolean) => void) {
    this.onStreamingChange = fn;
  }

  isStreaming(): boolean {
    return this.streaming;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getPlanProgressModel(): PlanProgressModel | null {
    return this.activePlanProgress;
  }

  private applyPlanProgressSnapshot(snapshot: PlanProgressSnapshot): void {
    const complete = snapshot.status === 'complete';
    this.activePlanCardSnapshot = {
      plan: snapshot.plan,
      currentPlan: snapshot.currentPlan,
      currentTodo: snapshot.currentTodo,
      complete,
    };
    if (complete) {
      this.activePlanNumber = snapshot.plan.steps.length;
      this.activeTodoNumber = (snapshot.plan.steps.at(-1)?.substeps?.length ?? 0) + 1;
      this.activePlanStarted = true;
      this.activeComplexPlan = null;
      return;
    }
    this.activeComplexPlan = snapshot.plan;
    this.activePlanNumber = snapshot.currentPlan;
    this.activeTodoNumber = snapshot.currentTodo;
    this.activePlanStarted = snapshot.status !== 'waiting';
  }

  private detachActivePlanProgress(): void {
    this.activePlanProgressUnsubscribe?.();
    this.activePlanProgressUnsubscribe = undefined;
    const persistence = this.activePlanProgressPersistence;
    this.activePlanProgressPersistence = undefined;
    if (persistence) {
      void persistence.flush();
      persistence.dispose();
    }
  }

  private bindActivePlanProgress(
    model: PlanProgressModel,
    sessionId = this.sessionId,
    workspace = this.workspace,
  ): void {
    this.detachActivePlanProgress();
    this.activePlanProgress = model;
    this.activePlanProjectBuild = model.getSnapshot().projectBuild === true;
    this.applyPlanProgressSnapshot(model.getSnapshot());
    const persistence = createSessionPlanProgressPersistence(sessionId, workspace);
    this.activePlanProgressPersistence = persistence;
    this.activePlanProgressUnsubscribe = model.subscribePersistence((snapshot) => {
      if (this.activePlanProgress !== model) return;
      this.applyPlanProgressSnapshot(snapshot);
      persistence.persist(snapshot);
    }, { emitCurrent: false });
  }

  setSessionId(id: string) {
    this.cancelBackgroundPreCompaction();
    // Session switch = human takeover: stop any pending auto-continue chain.
    this.autoContinue.cancel();
    this.pendingAutoContinue = null;
    this.detachActivePlanProgress();
    this.activePlanProgress = null;
    this.activePlanProjectBuild = false;
    this.activeComplexPlan = null;
    this.activePlanNumber = 1;
    this.activeTodoNumber = 1;
    this.activePlanStarted = false;
    this.activePlanCardSnapshot = null;
    this.activePlanProgress = null;
    this.sessionId = id;
    this.contextEngine = undefined;
    this.preCompactedMessages = null;
    this.preCompactSourceMessages = null;
    this.preCompactSessionId = '';
    this.preCompactMessageCount = 0;
    this.snapshotPort = undefined;
    this.sessionToolAdapter = undefined;
    this.sessionToolAdapterKey = '';
    this.onSnapshotChanged?.(false);
    // Session switch: invalidate any in-flight send loop so it stops writing
    // into the new transcript and never persists into the wrong session.
    this.generation++;
    // Loading a different session (sidebar click) is a new "本次会话": drop
    // approvals granted under the previous session so they don't leak across.
    this.permissionManager.clearCache();
    // Switch the stats view to the loaded session and refresh the panel. The
    // durable copy lives on disk (~/.pure/sessions/<id>/stats.json), so wait
    // for the async read to land before re-rendering — otherwise the panel
    // would briefly show the sync cache (possibly stale from a prior run).
    this.sessionStats = loadSessionStats(id);
    void refreshSessionStatsFromDisk(id).then(() => {
      if (this.sessionId !== id) return; // session switched again meanwhile
      this.sessionStats = loadSessionStats(id);
      this.onStatsChanged?.(this.sessionStats);
    });
    // Session-bound MCP must not outlive its session: actively close every
    // stdio transport (killing the spawned subprocesses) instead of leaving
    // them running until the next send() notices the sessionId changed.
    this.disconnectMcpClient();
  }

  /**
   * Tear down the current MCP client synchronously: disconnectAll() closes
   * every stdio transport, killing the spawned servers. Also clears the
   * deferred-init marker so the next send() reconnects under the new
   * sessionId/config. Safe to call when no client exists. Used on session
   * switches / new chat (MCP transports are session-bound — the Rust registry
   * keys subprocesses by sessionId) and from the send() identity check.
   */
  private disconnectMcpClient(): void {
    if (this.mcpClient) {
      this.mcpClient.disconnectAll();
      this.mcpClient = undefined;
    }
    this.deferredInitDone = false;
    this.mcpSessionId = '';
    this.mcpConfigSnapshot = '';
    this.dynamicMcpConnector = null;
  }

  /** Subscribe to per-session stats updates (right-panel 统计 tab). */
  onSessionStatsChanged(fn: (stats: SessionStats) => void): void {
    this.onStatsChanged = fn;
  }

  onWorkspaceSnapshotChanged(fn: (available: boolean) => void): void {
    this.onSnapshotChanged = fn;
    fn(!!this.snapshotPort?.getLatestWriteBatch());
  }

  async undoLastWriteBatch(): Promise<WorkspaceRestoreResult> {
    const result = this.snapshotPort
      ? await this.snapshotPort.undoLastWriteBatch()
      : { restored: false, restoredPaths: [], removedPaths: [], conflicts: [], message: '没有可撤销的写入。' };
    this.onSnapshotChanged?.(!!this.snapshotPort?.getLatestWriteBatch());
    return result;
  }

  async compactContext(): Promise<ContextCompactionResult> {
    const messages = this.messages;
    if (this.streaming || messages.length === 0) {
      return { messages, compacted: false, summarized: false, summaryUnavailable: false, evictedMessages: 0, estimatedTokens: 0, overBudget: false, oversizedNewestGroup: false };
    }
    this.cancelBackgroundPreCompaction();
    const config = loadConfig();
    const contextEngine = this.contextEngine ?? new ContextEngine({
      maxMessages: 20,
      maxTokens: resolvePromptBudget(promptBudgetForProvider(config?.customProviders, config?.provider, config?.model)).availableInputTokens,
    });
    this.contextEngine = contextEngine;
    const result = await contextEngine.compact(messages, { force: true });
    if (result.compacted) {
      this.preCompactedMessages = result.messages;
      this.preCompactSourceMessages = messages;
      this.preCompactSessionId = this.sessionId;
      this.preCompactMessageCount = messages.length;
    }
    return result;
  }

  /** Resume a paused plan from the pause-bubble shortcut. Reuses the normal
   * continuation pipeline: a synthetic "继续" turn hits the continuation
   * branch (no re-planning) and flips the chat plan card back to executing.
   * Returns false (and locks nothing) when a turn is already streaming. */
  continuePausedPlan(): boolean {
    if (this.streaming) return false;
    this.pausePlanCard = null;
    this.pauseAssessmentFlow = null;
    void this.send('继续');
    return true;
  }

  /** Abandon a paused plan from the pause-bubble shortcut: clears the plan
   * cursor, flips the in-transcript pause cards to
   * a cancelled state, and persists so a reload does not restore the paused
   * state. Returns false (and locks nothing) when there is nothing to cancel
   * or a turn is still streaming. */
  cancelPausedPlan(): boolean {
    if (!this.activeComplexPlan || this.streaming) return false;
    this.detachActivePlanProgress();
    this.activePlanProgress = null;
    this.activePlanProjectBuild = false;
    this.activeComplexPlan = null;
    this.activePlanNumber = 1;
    this.activeTodoNumber = 1;
    this.activePlanStarted = false;
    this.activePlanCardSnapshot = null;
    // The in-transcript plan/assessment cards must not stay stuck on
    // "等待你回复" next to a cancellation notice.
    this.pauseAssessmentFlow?.cancel('已取消本次执行计划。');
    this.pausePlanCard?.setActivity('已取消本次执行计划。');
    this.pausePlanCard = null;
    this.pauseAssessmentFlow = null;
    const chatEl = document.getElementById('chat')!;
    this.addStatusBubble('已取消本次执行计划，未执行任何改动。如需继续，请重新描述需求。', true, false);
    scrollChatToBottomIfPinned(chatEl);
    // Re-persist without planState so a reload no longer restores the plan
    // cursor or the pause bubble's "waiting for reply" flags.
    void this.persistSession(this.messages, new Map(), [], this.sessionId, this.workspace);
    return true;
  }

  /** Register the assessment card rebuilt on session restore so the cancel
   * shortcut can flip it when the restored paused plan is cancelled. */
  registerPausedAssessment(flow: AssessmentFlowHandle | null): void {
    this.pauseAssessmentFlow = flow;
  }

  /** Current session's aggregated stats (token totals, cost, tool activity). */
  getSessionStats(): SessionStats {
    return this.sessionStats;
  }

  private updateTurnCount(turnCount: number, persist = false): void {
    if (!Number.isFinite(turnCount)) return;
    const next = Math.max(0, Math.floor(turnCount));
    if (next <= (this.sessionStats.turns ?? 0)) return;
    this.sessionStats.turns = next;
    if (persist) this.persistStats();
    else this.onStatsChanged?.(this.sessionStats);
  }

  /** Record a tool execution into the session's activity history (capped). */
  private recordToolActivity(toolName: string, args: Record<string, unknown> | undefined, success: boolean): void {
    const ts = Date.now();
    const s = this.sessionStats;
    const push = <T,>(list: T[], item: T): void => {
      list.push(item);
      if (list.length > 50) list.shift();
    };
    if (toolName === 'web_search' || toolName === 'researcher_web' || toolName === 'researcher_docs' || toolName === 'code_searcher') {
      const query = typeof args?.query === 'string'
        ? args.query
        : typeof args?.prompt === 'string'
          ? args.prompt
          : [args?.library, args?.topic].filter((value): value is string => typeof value === 'string').join(' ');
      if (query) push(s.searches, { query: query.slice(0, 200), ts });
    } else if (toolName === 'read_file') {
      const path = typeof args?.path === 'string' ? args.path : '';
      if (path) push(s.fileReads, { path, ts });
    } else if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'replace_files') {
      const path = typeof args?.path === 'string' ? args.path
        : Array.isArray(args?.files) ? (args!.files as string[]).join(', ') : '';
      if (path) upsertFileWrite(s.fileWrites, { path, ts, success }, this.workspace);
    } else if (toolName === 'execute_command') {
      const command = typeof args?.command === 'string' ? args.command : '';
      if (command) push(s.commands, { command: command.slice(0, 300), ts, success });
    }
  }

  /** Persist the current session's stats + notify the panel to re-render. */
  private persistStats(): void {
    saveSessionStats(this.sessionId, this.sessionStats);
    this.onStatsChanged?.(this.sessionStats);
  }

  /** Load stored messages into the agent's internal state so subsequent turns use history. */
  loadFromStorage(snapshot: SessionSnapshotV2) {
    const boundedMessages = limitConversationMessages(snapshot.modelContext.messages);
    this.messages = boundedMessages.map(m => ({ ...m }));
    this.detachActivePlanProgress();
    this.activePlanProgress = null;
    this.activePlanProjectBuild = false;
    this.activeComplexPlan = null;
    this.activePlanNumber = 1;
    this.activeTodoNumber = 1;
    this.activePlanStarted = false;
    this.activePlanCardSnapshot = null;

    const savedPlanState = snapshot.uiState.planState;
    const savedPlanCard = [...snapshot.transcript].reverse().find((entry) => entry.planCard)?.planCard;
    const savedProgress = snapshot.uiState.planProgress !== undefined
      ? snapshot.uiState.planProgress
      : savedPlanState
        ? {
            plan: savedPlanState.plan,
            currentPlan: savedPlanState.complete ? savedPlanState.plan.steps.length + 1 : savedPlanState.planNumber,
            currentTodo: savedPlanState.todoNumber,
            status: savedPlanState.complete ? 'complete' as const : savedPlanState.started ? 'active' as const : 'waiting' as const,
          }
        : savedPlanCard
          ? {
              plan: savedPlanCard.plan,
              currentPlan: savedPlanCard.complete ? savedPlanCard.plan.steps.length + 1 : savedPlanCard.currentPlan,
              currentTodo: savedPlanCard.currentTodo,
              status: savedPlanCard.complete ? 'complete' as const : 'active' as const,
            }
          : null;
    if (savedProgress) {
      const restoredProgress = PlanProgressModel.fromSnapshot(savedProgress);
      this.bindActivePlanProgress(restoredProgress);
      if (savedProgress.status === 'complete') this.activePlanCardSnapshot = null;
    }
    this.hasHistory = this.messages.length > 0;
  }

  /** Restore last session for view-only display. Messages are NOT loaded into CodingAgent. */
  async restoreLastSession(): Promise<SessionSnapshotV2 | null> {
    const saved = await loadLastSession();
    if (!saved) return null;
    this.sessionId = saved.sessionId;
    this.sessionStats = loadSessionStats(saved.sessionId);
    this.generation++;
    // Route through setWorkspace so the clickable-path resolver stays in sync,
    // then resolve the application tmp path when this session has no user
    // workspace selected.
    this.setWorkspace(saved.workspace ?? '');
    await this.syncEffectiveWorkspace();
    return saved.snapshot;
  }

  setWorkspace(path: string) {
    this.workspace = path;
    this.effectiveWorkspace = path;
    this.snapshotPort = undefined;
    this.sessionToolAdapter = undefined;
    this.sessionToolAdapterKey = '';
    this.onSnapshotChanged?.(false);
    const fileWrites = dedupeFileWrites(this.sessionStats.fileWrites, path);
    if (fileWrites.length !== this.sessionStats.fileWrites.length || fileWrites.some((entry, index) => entry.path !== this.sessionStats.fileWrites[index]?.path)) {
      this.sessionStats = { ...this.sessionStats, fileWrites };
      saveSessionStats(this.sessionId, this.sessionStats);
      this.onStatsChanged?.(this.sessionStats);
    }
    // Keep the transcript's clickable-path resolver in sync with the session's
    // workspace so relative paths in bubbles/tool rows resolve correctly.
    setPathLinkWorkspace(path);
  }

  getWorkspace(): string {
    return this.workspace;
  }

  /** Workspace used to open generated files when the session has no selected
   * workspace and tools run inside the application-owned temporary directory. */
  getEffectiveWorkspace(): string {
    return this.effectiveWorkspace || this.workspace;
  }

  /** Sync path-link resolution with the effective session workspace without
   * changing the user-visible workspace selection. */
  async syncEffectiveWorkspace(): Promise<void> {
    const effective = this.workspace || await getApplicationTmpWorkspace(this.sessionId);
    this.effectiveWorkspace = effective;
    if (effective) setPathLinkWorkspace(effective);
  }

  private getOrCreateSessionToolAdapter(workspace: string, config: PureConfig, sessionId: string): ToolAdapter {
    const key = JSON.stringify([
      workspace,
      sessionId,
      config.tavilyApiKey,
      config.serperApiKey,
      config.searxngUrl,
      config.city,
      config.proxy?.enabled,
      config.proxy?.llmEnabled,
      config.proxy?.toolsEnabled,
      effectiveProxyUrl(config.proxy, 'tools'),
      effectiveProxyUrl(config.proxy, 'llm'),
      ...(config.proxy?.bypassProviders ?? []),
      config.toolBrowser,
      config.toolCmd,
      config.toolGit,
      config.toolFS,
    ]);
    if (this.sessionToolAdapter && this.sessionToolAdapterKey === key) return this.sessionToolAdapter;
    this.sessionToolAdapter = createToolAdapter(workspace, config, sessionId, this.dynamicCapabilityHooks);
    this.sessionToolAdapterKey = key;
    return this.sessionToolAdapter;
  }

  async send(userText: string, userImages: MessageImage[] = [], displayUserText = userText, isAuto = false, userAttachments: import('../shared/types').MessageAttachment[] = [], attachmentViewer?: (attachment: import('../shared/types').MessageAttachment) => void) {
    const chatEl = document.getElementById('chat')!;
    wireScrollPin(chatEl);
    wireNewContentHint(chatEl);
    const config = loadConfig();
    if (!hasConfiguredKey(config)) return;
    // A fresh turn's signals supersede any that were never consumed (defensive;
    // the finally of a completed turn always consumes them).
    this.pendingAutoContinue = null;

    // A previous turn may have queued an idle pre-compaction pass. Cancel it
    // before handling this input so an optimization can never compete with the
    // user's first frame or the new turn's setup.
    this.cancelBackgroundPreCompaction();

    // IMMEDIATE feedback: the user's own message renders synchronously here,
    // BEFORE any await below (workspace resolve, memory harvest, runtime
    // probe, LLM plan generation up to 8s, interactive review). Delaying it
    // made complex tasks feel like the submit didn't register — the transcript
    // stayed frozen while the pre-flight silently ran. If the plan review is
    // then cancelled, the bubble is removed (see the cancel branch) so no
    // ghost message remains.
    const userBubble = this.addBubble('user', userText);
    const userMessageAttachments = userAttachments.length > 0 ? userAttachments : undefined;
    const openUserAttachment = attachmentViewer;

    if (displayUserText !== userText || userImages.length > 0) {
      userBubble.textContent = displayUserText;
      renderUserImageAttachments(userBubble, userImages);
      for (const attachment of userAttachments) {
        userBubble.appendChild(renderAttachmentCard(attachment, () => openUserAttachment?.(attachment)));
      }
    }

    // Snapshot the user-selected workspace separately from the effective tool
    // workspace. An empty user workspace uses an application-owned tmp folder,
    // but the session must continue to persist an empty user workspace so the
    // UI still means "no user workspace selected" after reload.
    const sendSessionId = this.sessionId;
    const sendWorkspace = this.workspace;

    // Supersede any in-flight turn (abort + release). A user send also cancels
    // any pending auto-continue (full budget reset); an auto-continue round
    // must NOT reset the budget — it IS the chain.
    this.abortController?.abort();
    if (!isAuto) {
      this.autoContinue.cancel();
      // A manual send takes over the chain: drop the in-flight badge right away.
      this.activePlanCardHandle?.clearAutoContinue();
    }
    const gen = ++this.generation;
    // The plan-card snapshot belongs to this turn only; a follow-up simple
    // task must not re-attach a stale card from a previous complex plan.
    if (!this.activeComplexPlan) {
      this.detachActivePlanProgress();
      this.activePlanProgress = null;
      this.activePlanCardSnapshot = null;
    }
    // Create the turn controller before any preflight await. Previously the
    // controller and streaming state were installed only after workspace
    // resolution, so Stop/Escape could not interrupt a slow startup probe.
    const turnController = new AbortController();
    this.abortController = turnController;
    this.setStreaming(true);
    const releaseSupersededTurn = (): void => {
      if (this.abortController !== turnController) return;
      this.setStreaming(false);
      this.abortController = null;
    };
    // A turn paused BEFORE the engine ran (Stop/Escape during pre-flight) keeps
    // its request as a visible bubble AND must enter the live model history.
    // Persisting to disk alone left `this.messages` without the request, so a
    // follow-up like "继续" reached the LLM with no trace of the original task
    // and the model answered that it did not know what to continue. Committing
    // here (+ hasHistory) makes the NEXT send resume via continueTurn with the
    // paused request in context; reloads were already covered by the disk write.
    // Tool meta/phases come in as parameters because early abort sites run
    // before their declarations below (a direct reference would be a TDZ error).
    const commitPausedUserTurn = (
      turnToolResults: Map<string, ToolExecMeta>,
      phases: Array<{ text: string; assistantIndex: number }>,
    ): Message[] => {
      const pausedMessages = limitMessageHistory([
        ...this.messages,
        { role: 'user', content: userText, images: userImages, attachments: userMessageAttachments },
      ]);
      this.messages = pausedMessages;
      this.hasHistory = true;
      void this.persistSession(pausedMessages, turnToolResults, phases, sendSessionId, sendWorkspace);
      return pausedMessages;
    };
    // Do not let path-linkification, scrolling, workspace resolution, or any
    // other preflight work run in the same event turn as the user's click.
    // Long transcripts make even small DOM/layout work visible; yielding here
    // guarantees the new bubble gets a browser paint first.
    await yieldToNextPaint(turnController.signal);
    if (gen !== this.generation) {
      userBubble.remove();
      releaseSupersededTurn();
      return;
    }
    linkifyPaths(userBubble);
    forceScrollToBottom(chatEl);
    hideNewContentHint(); // a fresh user turn resumes following the newest content

    const effectiveWorkspace = sendWorkspace || await withAbortTimeout(
      getApplicationTmpWorkspace(sendSessionId),
      turnController.signal,
      5_000,
      'workspace resolution',
    ).catch((error: Error) => {
      if (error.name === 'AbortError') return '';
      console.warn('[pure] workspace resolution timed out; continuing without a workspace:', error.message);
      return '';
    });
    if (gen !== this.generation) {
      // The immediately-rendered user bubble belongs to the superseded
      // transcript — drop it so no ghost message appears in the new session.
      userBubble.remove();
      releaseSupersededTurn();
      return;
    }
    if (turnController.signal.aborted) {
      this.addStatusBubble('⏸ 已暂停：你的请求已保留在对话中。', true, false);
      commitPausedUserTurn(new Map(), []);
      releaseSupersededTurn();
      return;
    }
    if (effectiveWorkspace) setPathLinkWorkspace(effectiveWorkspace);

    // 用户点击「停止」时，已发送的消息必须留在对话里（这是发送记录，不是幽灵气泡），
    // 并写入会话存储，重载后依然可见；仅当切换到其他会话（generation 变化）时才移除
    // ——此时转录将由新会话重建，消息属于旧会话。
    const keepOrDropUserBubble = (pausedText: string): void => {
      if (gen !== this.generation) {
        userBubble.remove();
        return;
      }
      this.addStatusBubble(pausedText, true, false);
      // 把被暂停的消息落盘（与运行中断路径一致），避免重载后“输入消失”，
      // 并提交进内存历史，让同会话的后续输入（如「继续」）仍能看到原始请求。
      commitPausedUserTurn(toolResults, thinkingPhases);
    };

    // Generation guard: if the user navigates to another session / starts a
    // new chat while this turn streams, the switch bumps `generation` and this
    // loop must stop appending to the (now different) transcript and must not
    // persist into the wrong session. Also snapshot the session identity: even
    // if a switch races the final persist, we write back to the session the
    // turn STARTED in — never the one the user just opened.

    // Hoist the streamingRender flag once — toggle defaults to true, but
    // users on low-end hardware can disable it from Settings → Chat to skip
    // the 100ms throttled markdown re-render entirely. Reading loadConfig()
    // on every TokenDelta would parse JSON hundreds of times per turn,
    // undermining the perf benefit the toggle is supposed to provide.
    const streamingRenderEnabled = (loadConfig()?.streamingRender ?? true);

    let finalMessages: Message[] = [];
    let interruptedMessages: Message[] | undefined;
    const thinkingAssistantOffset = this.messages.filter(message => message.role === 'assistant').length;
    let assistantIteration = -1;
    const thinkingPhases: Array<{ text: string; assistantIndex: number }> = [];
    // The preflight analysis card is separate from engine reasoning, but it is
    // still user-visible transcript content and must survive session restore.
    let taskAnalysisText = '';
    // Assistant output renders as ONE OR MORE bubbles in transcript order.
    // When text arrives AFTER tool rows have been appended, a new bubble is
    // started so the model's post-tool answer appears BELOW the tools the user
    // already watched execute — not glued into the pre-tool bubble that now
    // sits above them (the ordering bug this fixes). Each segment keeps its
    // own raw text for the final markdown pass on Completed.
    type AssistantSegment = { el: HTMLDivElement; text: string; mayContainToolCallXml: boolean; toolCallXmlTail: string };
    const assistantSegments: AssistantSegment[] = [];
    let currentSegment: AssistantSegment | null = null;
    // Files the agent actually wrote this turn (deduped). Folders created for
    // project scaffolding never become result cards. Collected from SUCCESSFUL
    // write/edit/replace tool results only.
    const turnArtifacts: ArtifactItem[] = [];
    const artifactSeen = new Set<string>();
    const addArtifact = (path: string): void => {
      const key = path;
      if (artifactSeen.has(key)) return;
      artifactSeen.add(key);
      const norm = path.trim().toLowerCase().replaceAll('\\', '/').replace(/^\.\//, '');
      turnArtifacts.push({ path, version: this.fileWriteVersions.get(norm) ?? 1 });
    };
    let toolRowSinceSegment = false;
    const createSegment = (): AssistantSegment => {
      const el = this.addBubble('assistant', '');
      el.classList.add('streaming');
      const seg = { el, text: '', mayContainToolCallXml: false, toolCallXmlTail: '' };
      assistantSegments.push(seg);
      currentSegment = seg;
      return seg;
    };
    // Reuse the current bubble while no tool row has been inserted after it;
    // otherwise (or on the first text) start a fresh bubble at the end of the
    // transcript — i.e. below any tool rows that were just appended.
    const ensureSegment = (): AssistantSegment => {
      if (currentSegment && !toolRowSinceSegment) return currentSegment;
      // New text is arriving after a tool row was inserted. In the normal
      // protocol a tool's ToolResult finalizes its row (✓/✗) before any
      // follow-up text streams, so any row still in `pending` here was cut off
      // mid-execution — e.g. a provider timeout that triggered an internal
      // retry: its result will never arrive. Leave it as a blinking "in
      // progress" row and the new text reads as a contradiction (a tool still
      // running above content that already continues the turn). Resolve the
      // orphaned rows (⏹ stopped) so they close cleanly beneath the new text.
      if (pendingRows.size > 0 || pendingByName.size > 0) {
        resolvePendingToolRows(toolCallRefresh, pendingRows, pendingByName);
      }
      toolRowSinceSegment = false;
      return createSegment();
    };
    // Track pending tool-call rows so we can show "calling… (args)" before
    // execution and "✓/✗ duration" + parsed result preview on ToolResult. The
    // row element itself lives in the chat transcript; this map stores the
    // entry references + parsed args so we can update the summary line on each
    // subsequent TokenDelta (args grow as the JSON streams in).
    // pendingRows is keyed by toolCallId (BUG-6 fix): each tool call gets its
    // own row so parallel same-name calls can't overwrite each other.
    // pendingByName stages mid-stream argument deltas whose toolCallId hasn't
    // arrived yet; the engine's id-bearing TokenDelta (from the `tool_call` /
    // `done` chunks) migrates the staged row onto the id-keyed map.
    const pendingRows = new Map<string, ToolRowEntry>();
    const pendingByName = new Map<string, ToolRowEntry>();
    // Per-call throttle for tool-call JSON re-parses (keyed by toolCallId or
    // staged tool name). Streaming a giant argument (write_file `content`, a
    // whole HTML file) grows the buffer to tens of KB; re-parsing it AND
    // re-rendering the Input panel on every token freezes the UI mid-stream
    // ("stuck with only the blinking cursor"). See the TokenDelta handler.
    const toolCallRefresh = new Map<string, number>();
    type LiveToolOutputLine = { kind: 'stdout' | 'stderr'; line: string };
    const liveToolOutputQueue = new Map<string, LiveToolOutputLine[]>();
    let liveToolOutputFrame: number | undefined;
    const LIVE_OUTPUT_BATCH_SIZE = 24;
    const flushLiveToolOutput = (): void => {
      liveToolOutputFrame = undefined;
      let rendered = false;
      let hasMore = false;
      for (const [toolCallId, lines] of liveToolOutputQueue) {
        const entry = pendingRows.get(toolCallId);
        if (!entry || !entry.row.details.classList.contains('pending')) {
          liveToolOutputQueue.delete(toolCallId);
          continue;
        }
        for (let i = 0; i < LIVE_OUTPUT_BATCH_SIZE && lines.length > 0; i++) {
          const next = lines.shift()!;
          appendToolStreamLine(entry.row, next.kind, next.line);
          rendered = true;
        }
        if (lines.length > 0) hasMore = true;
        else liveToolOutputQueue.delete(toolCallId);
      }
      if (rendered) scrollChatToBottomIfPinned(chatEl);
      if (hasMore) scheduleLiveToolOutputFlush();
    };
    const scheduleLiveToolOutputFlush = (): void => {
      if (liveToolOutputFrame !== undefined) return;
      liveToolOutputFrame = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(flushLiveToolOutput)
        : window.setTimeout(flushLiveToolOutput, 0);
    };
    // Live bash output: lines the Rust backend streams while a command runs
    // (execute_command_stream) are appended to the matching pending tool row's
    // Output panel in real time — a long-running command shows progress rather
    // than a silent wait. Keyed by the LLM tool call id, the same id the
    // engine uses for the id-bearing TokenDelta and the ToolResult event; rows
    // staged by name migrate onto the id key before execution, so the row
    // always exists by the time the first line streams.
    setToolOutputListener((toolCallId, kind, line) => {
      if (gen !== this.generation) return;
      const entry = pendingRows.get(toolCallId);
      if (!entry || !entry.row.details.classList.contains('pending')) return;
      if (Number(entry.row.resultEl.dataset.streamLines ?? 0) >= MAX_LIVE_STREAM_LINES) return;
      const queued = liveToolOutputQueue.get(toolCallId) ?? [];
      // The final ToolResult still carries the complete output. The live DOM
      // only needs a bounded preview, so never let a chatty command build an
      // unbounded queue that can starve keyboard and click events.
      if (queued.length >= MAX_LIVE_STREAM_LINES) return;
      queued.push({ kind, line });
      liveToolOutputQueue.set(toolCallId, queued);
      scheduleLiveToolOutputFlush();
    });
    // toolCallId → outcome, replayed as status rows (StoredMessage.toolExec)
    // when the session is restored from storage.
    const toolResults = new Map<string, ToolExecMeta>();
    // Tool-round grid: tool calls issued in the SAME LLM iteration (e.g. two
    // parallel web_search calls, or a web_search + list_files batch) render
    // side by side in one horizontal grid, so the transcript reads "running
    // simultaneously" instead of a vertical stack of identical-looking rows.
    // A single-call round renders as one full-width item (the grid collapses
    // to one column). Closed by the next StateChange → THINK.
    let toolGrid: HTMLElement | null = null;
    const appendToolRow = (toolName: string, args: Record<string, unknown>): ToolRowHandle => {
      // Tool calls interrupt text streaming — the bubble above the new row
      // stops blinking now, not at turn completion (see above).
      finalizeStreamingSegments();
      if (!toolGrid) {
        toolGrid = document.createElement('div');
        toolGrid.className = 'bubble-row tool-grid';
        chatEl.appendChild(toolGrid);
      }
      return this.addToolRow(toolName, args, toolGrid);
    };
    // Live thinking card: created once the user bubble lands, finalized on the
    // first content/tool delta, and nulled so a later reasoning phase (after
    // tool results) opens a fresh card below whatever it followed.
    let thinkingCard: ThinkingCardHandle | null = null;
    // Consecutive LLM retry/reflect/degrade notices this turn (FailurePolicy
    // decisions) — shown on the live thinking card so silent retries become
    // visible feedback.
    let llmRetryNotices = 0;
    // Reasoning deltas are batched into 50ms flushes before touching the DOM:
    // reasoning streams (DeepSeek/Qwen/GLM) can deliver hundreds of deltas per
    // second, and a per-delta append + scroll forces a layout read every time
    // (the classic streaming stutter). thinkingPhases still accumulates EVERY
    // delta for persistence — only the DOM append is throttled.
    let thinkingPending = '';
    let thinkingFlushTimer: number | undefined;
    const THINKING_FLUSH_MS = 50;
    const flushThinking = (): void => {
      thinkingFlushTimer = undefined;
      if (!thinkingCard || !thinkingPending) return;
      appendThinkingText(thinkingCard, thinkingPending);
      thinkingPending = '';
      scrollChatToBottomIfPinned(chatEl);
    };
    // Tool-result gap watchdog: after a tool row finalizes (✓/✗), the model
    // must re-read the result and decide the next step — on slow models this
    // gap can last many seconds with NOTHING on screen, which reads as a
    // stuck/hung session. After a short debounce (so back-to-back tool calls
    // don't flash a card) we open a "正在思考下一步…" waiting card with live
    // dots; the next ReasoningDelta / TokenDelta / ToolCallStart cancels it
    // and takes over with real content.
    let toolGapTimer: number | undefined;
    const TOOL_GAP_DEBOUNCE_MS = 600;
    const scheduleToolGapCard = (): void => {
      if (toolGapTimer !== undefined) return;
      toolGapTimer = window.setTimeout(() => {
        toolGapTimer = undefined;
        if (gen !== this.generation || this.abortController?.signal.aborted) return;
        if (thinkingCard) return;
        // A tool row still executing (image generation, a long command) already
        // shows its own spinner — never stack a "正在思考下一步…" card on top.
        if (pendingRows.size > 0 || pendingByName.size > 0) return;
        thinkingCard = openThinkingCard();
        setThinkingLabel(thinkingCard, '正在思考下一步…');
        // Mark the card as a silence-waiter so the first real reasoning delta
        // resets this label back to the default thinking state.
        thinkingCard.card.classList.add('waiting');
        scrollChatToBottomIfPinned(chatEl);
      }, TOOL_GAP_DEBOUNCE_MS);
    };
    const cancelToolGapCard = (): void => {
      if (toolGapTimer !== undefined) {
        clearTimeout(toolGapTimer);
        toolGapTimer = undefined;
      }
    };
    // Drop the live trace on aborted turns (pre-flight cancel / plan gate
    // rejection / fatal error) — a "正在准备…" card must not linger as a
    // ghost when the turn never produced output.
    const removeThinkingCard = (): void => {
      cancelToolGapCard();
      if (thinkingFlushTimer !== undefined) {
        clearTimeout(thinkingFlushTimer);
        thinkingFlushTimer = undefined;
      }
      thinkingPending = '';
      if (thinkingCard) {
        stopThinkingTimer(thinkingCard);
        thinkingCard.el.remove();
        thinkingCard = null;
      }
    };
    const endThinking = () => {
      cancelToolGapCard();
      if (thinkingFlushTimer !== undefined) {
        clearTimeout(thinkingFlushTimer);
        thinkingFlushTimer = undefined;
      }
      // Flush any buffered reasoning before finalizing so the card never loses
      // the last (un-flushed) slice of the stream.
      if (thinkingPending) {
        if (thinkingCard) appendThinkingText(thinkingCard, thinkingPending);
        thinkingPending = '';
      }
      if (!thinkingCard) return;
      // Non-reasoning models (standard GPT-4, Claude, …) never emit
      // ReasoningDelta — the card was opened with a "正在思考…" label but
      // received zero text. Finalizing it leaves an empty "思考完成" ghost
      // that cluttered the transcript. Drop it instead.
      if (!thinkingCard.textEl.textContent) {
        thinkingCard.el.remove();
        thinkingCard = null;
        return;
      }
      finalizeThinkingCard(thinkingCard);
      thinkingCard = null;
    };
    // Stop the streaming caret on every text bubble the moment a tool row is
    // appended: the pre-tool text is complete once the agent hands off to a
    // tool, and write_file / edit_file / execute_command can run for seconds
    // or minutes — the `|` cursor (.bubble.streaming::after) must not blink
    // above the row for the whole execution. Finalized segments keep their
    // rendered text; if the model streams again after the tool, ensureSegment
    // opens a fresh bubble below the tool rows (with its own caret).
    const finalizeStreamingSegments = (): void => {
      for (const seg of assistantSegments) {
        const text = seg.mayContainToolCallXml ? stripToolCallXml(seg.text) : seg.text;
        // A tool-call delta can arrive before the throttled markdown render for
        // the latest text slice. Commit that slice before cancelling the timer,
        // otherwise the tool row is inserted after the previous frame and the
        // user sees a sentence cut off halfway through.
        flushStreamingRender(seg.el, text);
        cancelStreamingRender(seg.el);
        seg.el.classList.remove('streaming');
      }
    };
    // createThinkingCard() builds the element tree but does NOT attach it —
    // append to the transcript here, right below whatever was last added.
    // Every live card gets an elapsed-time chip: a long "正在思考下一步…" with
    // only dots reads as a hung session, ticking seconds prove it is alive.
    const openThinkingCard = (): ThinkingCardHandle => {
      const card = createThinkingCard();
      chatEl.appendChild(card.el);
      startThinkingTimer(card);
      return card;
    };

    // `null as … | null`: TS control-flow can't see the assignment inside
    // maybeShowAssessment() (a closure), so without the widening cast it keeps
    // narrowing assessmentFlow to null and the later `if (assessmentFlow)`
    // reads see type `never` (same pattern as planCard below).
    let assessmentFlow: AssessmentFlowHandle | null = null as AssessmentFlowHandle | null;
    try {
      if (turnController.signal.aborted) {
        keepOrDropUserBubble('⏸ 已暂停：你的请求已保留在对话中。');
        return;
      }
      // All setup that could throw synchronously (adapter creation, agent construction)
      // Memory skill toggle: when disabled, skip learning + memory injection.
      const memoryEnabled = config.skills?.memory ?? true;
      if (memoryEnabled) {
        const entries = harvestUserPreferences(userText, {
          sessionId: this.sessionId,
          projectPath: effectiveWorkspace,
        });
        await Promise.all(entries.map(e => memoryStore.add(e).catch(() => '')));
      }
      // Persona + tool list are split by the effective workspace: an
      // application temporary workspace is a real filesystem root for this
      // session, while web tools remain available independently.
      const usingTemporaryWorkspace = !sendWorkspace && !!effectiveWorkspace;
      // Eager feedback: open the live trace BEFORE the remaining preflight
      // (runtime probe, request assessment) so the user never stares at a
      // frozen transcript between the user bubble and the first token. The
      // label tracks the real phase; the first streamed reasoning delta
      // replaces the waiting text with live content. The same card is reused
      // as the task-analysis trace and (for plain turns) the engine's
      // thinking card, so exactly one card exists per turn.
      thinkingCard = openThinkingCard();
      setThinkingLabel(thinkingCard, '正在准备…');
      // One-shot runtime probe (node/bun/python3/rustc/git versions) — the cached
      // promise resolves in ms after the first send; awaiting here guarantees
      // the first turn already carries the runtimes line in its prompt.
      await ensureRuntimesProbed(this.abortController?.signal);
      let systemPrompt = '';
      // L2 per-request context (promptLayers.ts): task-specific fragments ride
      // with the USER message via composeUserTurn, not the system prompt.
      let userTraps: string | undefined;
      let userBuildProtocol: string | undefined;
      let userPlan: string | undefined;
      let userAssessment: string | undefined;
      let userPlausibilityOverride: string | undefined;
      let taskContract: TaskContract | undefined;

      const llm = createLLMAdapter(config);
      const toolAdapter = this.getOrCreateSessionToolAdapter(effectiveWorkspace, config, sendSessionId);
      this.snapshotPort = toolAdapter.getSnapshotPort?.();
      this.onSnapshotChanged?.(!!this.snapshotPort?.getLatestWriteBatch());

      // Skill toggles: when a skill is disabled, drop its matching subagent so
      // the LLM can't delegate work it would expect to succeed (web_researcher
      // ↔ web-research, code_reviewer ↔ code-review, planner ↔ planning).
      // `undefined` keeps the full built-in set (CodingAgent defaults to
      // BUILT_IN_SUBAGENTS).
      const subagents = (() => {
        const keep = BUILT_IN_SUBAGENTS.filter((def) => {
          if (def.name === 'web_researcher') return config.skills?.['web-research'] ?? true;
          if (def.name === 'code_reviewer') return config.skills?.['code-review'] ?? true;
          if (def.name === 'planner') return config.skills?.planning ?? true;
          if (def.name === 'project_auditor') return config.skills?.['code-review'] ?? true;
          return true;
        });
        return keep.length === BUILT_IN_SUBAGENTS.length ? undefined : keep;
      })();

      // Refresh mode + handler for this turn so a settings change (e.g.
      // toggling "自动放行命令") takes effect immediately on the next send
      // while keeping the session's approval cache alive.
      this.permissionManager.setMode(mapPermissionMode(config.permissionMode));
      this.permissionManager.setRequestHandler(createPermissionHandler(config));

      // Rebuild MCP when the session identity or MCP config changed since the
      // last init. MCP transports are session-bound (the Rust subprocess
      // registry keys them by sessionId), so reusing a client across sessions
      // would leave subprocesses under a stale session AND ignore config edits
      // made in Settings. disconnectAll() closes every transport, killing the
      // spawned servers, before the next deferred init reconnects under the
      // new sessionId/config.
      if (this.deferredInitDone && (
        this.mcpSessionId !== sendSessionId ||
        this.mcpConfigSnapshot !== JSON.stringify([config.mcpServers ?? [], effectiveProxyUrl(config.proxy, 'tools')])
      )) {
        this.disconnectMcpClient();
      }

      // Text-to-image capability for this turn: true when the connected
      // provider/model exposes an OpenAI-compatible images API (explicit
      // provider setting or image-capable model name). When true the model
      // gets the generate_image tool and image requests render as <img> cards;
      // when false (DeepSeek/Qwen/GLM default) SVG remains the output path.
      const imageGen = imageGenEnabled(config.customProviders, config.provider, config.model);

      const codingAgent = new CodingAgent({
        sessionId: this.sessionId,
        llm,
        toolAdapter,
        subagents,
        // With either a user workspace or an application temporary workspace,
        // defer to the live ToolRegistry so filesystem tools, subagents, and
        // MCP tools registered after construction are visible to the LLM.
        // generate_image joins the tool list when the provider supports
        // text-to-image (imageGen flag below) — otherwise models answer image
        // requests with ```svg blocks as before.
        toolsDefs: effectiveWorkspace ? undefined : [
          ...(config.toolBrowser ? WEB_TOOL_DEFS : []),
          ...SYS_INFO_DEFS,
          ...DYNAMIC_CAPABILITY_TOOL_DEFS,
          ...(imageGen ? [IMAGE_GEN_TOOL_DEF] : []),
        ],
        budget: DEFAULT_BUDGET,
        // Cross-session memory: passed only when the Memory skill is enabled;
        // the Harness composes it into the system prompt at session start.
        memory: memoryEnabled ? memoryStore : undefined,
        projectPath: effectiveWorkspace || undefined,
        workspaceAvailable: Boolean(effectiveWorkspace),
        promptAssembler,
        promptBudget: promptBudgetForProvider(config.customProviders, config.provider, config.model),
        mcpClient: this.mcpClient,
        mcpServers: this.deferredInitDone ? undefined : (config.mcpServers ?? []),
        mcpExcludedPrefixes: config.mcpExcludedPrefixes,
        proxyUrl: effectiveProxyUrl(config.proxy, 'tools'),
        permissionManager: this.permissionManager,
        // The engine verifier stays purely rule-based (non-empty-output check);
        // a hard failure there triggers an in-engine rewrite. No LLM re-check of
        // the final output surfaces internal verifier feedback to the user.
        verifier: createDefaultVerifier(),
      });
      // Text-to-image support: computed once per send from the connected
      // provider/model (see imageGenContextFor). When enabled, register the
      // generate_image tool with the live registry so the LLM sees it in
      // workspace mode too, and the prompt contracts switch from SVG to
      // image-generation (SVG stays the automatic fallback on tool failure).
      if (imageGen) {
        codingAgent.toolRegistry.register({ ...IMAGE_GEN_TOOL_DEF, tags: [Tags.READ], riskLevel: 'low' });
      }
      for (const tool of DYNAMIC_CAPABILITY_TOOL_DEFS) {
        codingAgent.toolRegistry.register({
          ...tool,
          tags: tool.name === 'connect_mcp_server' ? [Tags.DESTRUCTIVE] : [Tags.READ],
          riskLevel: tool.name === 'connect_mcp_server' ? 'high' : 'low',
          serverName: 'pure-capabilities',
        });
      }
      this.dynamicMcpConnector = async (server, signal): Promise<DynamicMcpConnectionResult> => {
        let client = this.mcpClient;
        if (!client) {
          client = new MCPClient({
            servers: [],
            sessionId: sendSessionId,
            onToolDiscovered: (tool) => codingAgent.toolRegistry.register(tool),
            proxyUrl: effectiveProxyUrl(config.proxy, 'tools'),
            excludedPrefixes: config.mcpExcludedPrefixes,
          });
          codingAgent.toolRegistry.setMCPExecutor(client);
          this.mcpClient = client;
          this.deferredInitDone = true;
          this.mcpSessionId = sendSessionId;
        }
        await withAbortTimeout(client.connectServer(server), signal, 30_000, `MCP ${server.name} connection`);
        const current = loadConfig() ?? config;
        const servers = [...(current.mcpServers ?? [])];
        const existing = servers.findIndex((item) => item.name === server.name);
        if (existing >= 0) servers[existing] = server;
        else servers.push(server);
        persistConfig({ ...current, mcpServers: servers });
        this.mcpConfigSnapshot = JSON.stringify([servers, effectiveProxyUrl(current.proxy, 'tools')]);
        return { tools: client.getTools(), persisted: true };
      };
      const promptTools = effectiveWorkspace
        ? codingAgent.toolRegistry.getTools()
        : [
            ...(config.toolBrowser ? WEB_TOOL_DEFS : []),
            ...SYS_INFO_DEFS,
            ...DYNAMIC_CAPABILITY_TOOL_DEFS,
            ...(imageGen ? [IMAGE_GEN_TOOL_DEF] : []),
          ];
      systemPrompt = buildSystemPrompt(!!effectiveWorkspace, usingTemporaryWorkspace, config, promptTools, imageGen);
      this.contextEngine = codingAgent.getHarness().getContextEngine();

      // ── Logical-trap pre-scan (runs in plain-chat AND workspace mode):
      // contradictory / impossible / trick premises are flagged before the
      // run and injected into the system prompt so the model verifies the
      // premise instead of following it into a failure loop. The same analysis
      // also drives the plan review below.
      // P0: 评估卡最终由「模型的分析判断 + 规则层保守兜底」合并落定（effectiveIntent）。
      // 规则启发式先支撑 prompt 注入与只读探针；LLM 三段式思考完成后，用它的语义判断
      // 校准风险/意图/可逆性——规则层只会抬高安全要求，永远不会把模型判断压得更低。
      // The shared compiler keeps this preflight identical between GUI and CLI.
      const forcedMode: TaskMode | undefined =
        config.taskMode && config.taskMode !== 'auto' ? config.taskMode : undefined;
      // A plan that already reached its final "## 计划 n 已完成" (or the
      // turn-end completion dispatch) is DONE — its progress model status is
      // 'complete'. A subsequent user message ("页面很丑，改一下" / a brand-new
      // tweak) must NOT be treated as a continuation of that finished plan: the
      // old plan card stays in the transcript as history, but the request is a
      // fresh task that may or may not spawn its own new plan. Treating a
      // finished plan as still-active made the agent answer "收到，我们继续处理
      // 第 x 阶段的第 y 个 Todo" even though the project was already delivered.
      const activePlanFinished =
        this.activePlanProgress?.getSnapshot().status === 'complete' ||
        this.activePlanCardSnapshot?.complete === true;
      const continuingPlan = !activePlanFinished && this.activeComplexPlan !== null && this.hasHistory && !forcedMode;
      const planPauseRequested = !activePlanFinished && this.activeComplexPlan !== null && !this.hasHistory && !forcedMode;
      // Semantic routing is the primary decision for ordinary turns. The
      // synchronous Planner remains only a safety floor; it must not decide
      // that a design critique is a build, or that a creative constraint needs
      // a reasonableness card. Continuing plans skip this extra call and keep
      // their already-approved route.
      const semanticRoute = continuingPlan
        ? null
        : shouldBypassSemanticRoute(userText, userImages)
          ? null
          : await inferSemanticRoute(llm, userText, this.abortController?.signal, userImages);
      const workflow = compileRequestWorkflow(userText, {
        forcedMode,
        hasTools: !!effectiveWorkspace,
        continuingPlan,
        planPauseRequested,
        // The delivery gate follows the approved plan's build-ness across
        // turns, not the continuation prompt ("继续" must not silently lose
        // the gate, and an ordinary complex plan must not gain it).
        continuingProjectBuild: this.activePlanProjectBuild,
        semanticRoute,
      });
      const analysis = workflow.analysis;
      let effectiveIntent: IntentAssessment = analysis.intent;
      if (workflow.userContext.traps) userTraps = workflow.userContext.traps;
      userAssessment = workflow.userContext.assessment;
      userPlausibilityOverride = workflow.userContext.plausibilityOverride;

      // 主动评估卡绝不在此刻同步弹出：这里只有规则启发式，还不是真实思考。卡片延后
      // 到 LLM 真正完成分析之后才出现（maybeShowAssessment）——thinking 卡先行展示
      // 模型对这项任务的推理，评估卡的意图/风险节点以那次分析（effectiveIntent）落定。

      // 只读探针是否已真实完成（评估卡稍后创建时据此落定闸门节点）。
      let probeGateDone = false;
      // 探针发现（探索/契约气泡）只在 LLM 分析完成后呈现一次——先思考，再报告发现。
      // 空工作区换成诚实说明，不再输出“unknown/未发现验证入口”这类对全新项目无意义的内容。
      let probeFindingsReported = false;
      const reportProbeFindings = (): void => {
        if (probeFindingsReported) return;
        if (workflow.probeRequired && !workflow.probeAvailable) {
          probeFindingsReported = true;
          this.addStatusBubble('⚠ 这项请求需要先做只读探针，但当前没有可用工作区工具，已降级为有限上下文执行。', false, false);
          return;
        }
        if (!workspaceProfile || !taskContract) return;
        probeFindingsReported = true;
        if (isBareWorkspace(workspaceProfile)) {
          // “从零搭建”只在项目级构建语境下说；非构建请求没有可报告的探索结论。
          if (needsDeliveryGate) {
            this.addStatusBubble('当前工作区为空或尚未建立项目结构，将从零搭建。', false, false);
          }
          return;
        }
        this.addStatusBubble(`🔎 已完成项目探索：${workspaceProfileSummary(workspaceProfile)}`, true, false);
        this.addStatusBubble(`📋 已建立任务契约：${taskContract.acceptanceCriteria.length} 项验收标准，验证结果将决定是否交付。`, true, false);
      };
      const maybeShowAssessment = (): void => {
        if (assessmentFlow) return;
        // 是否展示评估卡由合并后的判断（effectiveIntent）决定：LLM 分析把风险抬高到
        // 中/高时评估卡随之出现——规则层已不单独决定这件事，但永远不会压低模型判断。
        // The normal build path already has a live reasoning trace and a
        // task-specific plan. Reserve a separate assessment surface for a
        // real safety boundary (or a concrete trap), rather than showing a
        // fixed checklist for every non-trivial request.
        const showAssessmentFlow = (effectiveIntent.requiresConfirmation || analysis.traps.length > 0)
          && effectiveIntent.intent !== 'question';
        if (!showAssessmentFlow) return;
        assessmentFlow = createAssessmentFlowCard(effectiveIntent);
        chatEl.appendChild(assessmentFlow.el);
        assessmentFlow.completePhase('intent', '已完成需求分析，明确了任务目标与边界。');
        assessmentFlow.completePhase('risk', `风险等级已确认：${riskLabelOf(effectiveIntent.riskLevel)}`);
        // 前置检查已完成的（探针跑完、或本就不需要探针）且不是高风险：闸门落定；
        // 高风险仍保持等待，直到用户在确认卡上明确批准。
        if ((probeGateDone || !effectiveIntent.requiresProbe) && !effectiveIntent.requiresConfirmation) {
          assessmentFlow.completePhase('gate', '前置检查已通过，可以进入执行阶段。');
        }
        // 探索/契约结论跟随评估卡一起呈现：先看到真实分析，再看到基于它的发现。
        reportProbeFindings();
      };
      // "写一个小游戏 / 做一个网页 / 开发一个工具" → build the artifact on disk
      // instead of printing the full source inline (see the compiled build protocol).
      // Multi-file builds also get the incremental-build protocol (outline
      // first, one verifiable step at a time, per-step report + verification,
      // next-step recommendation) — composed into the user turn on artifact
      // requests only, so plain Q&A turns don't carry its token cost.
      const needsDeliveryGate = workflow.needsDeliveryGate;
      const needsIntentProbe = workflow.needsProbe;
      const shouldRunTaskAnalysis = !continuingPlan && (
        workflow.requiresPlanReview
        || needsDeliveryGate
        || effectiveIntent.requiresConfirmation
        || forcedMode === 'plan'
        || forcedMode === 'build'
      );
      // The live trace opened before the preflight doubles as the analysis
      // card — one continuous feedback row instead of two stacked cards.
      const earlyAnalysisCard = shouldRunTaskAnalysis ? thinkingCard : null;
      if (earlyAnalysisCard) setThinkingLabel(earlyAnalysisCard, '正在读取工作区，并结合你的目标判断…');
      let workspaceProfile: WorkspaceProfile | undefined;
      // 探针本身只读、快速，照常先行（结果用于给 LLM 分析做 grounding）；但它的
      // 结论气泡不再此刻弹出——等 LLM 分析完成后由 reportProbeFindings() 统一呈现。
      if (effectiveWorkspace && (needsDeliveryGate || needsIntentProbe || analysis.complexity === 'complex')) {
        workspaceProfile = await discoverWorkspace(codingAgent.toolRegistry, this.abortController?.signal);
        taskContract = buildTaskContract(userText, workspaceProfile);
        if (needsIntentProbe) {
          probeGateDone = true;
        }
      } else if (needsIntentProbe) {
        probeGateDone = true;
      }
      // 探针期间用户点击「停止」：立即收尾，不再进入访谈（探针只读，无副作用）。
      if (this.abortController?.signal.aborted) {
        removeThinkingCard();
        keepOrDropUserBubble('⏸ 已暂停：你的请求已保留在对话中。');
        return;
      }
      let pauseAfterPlanning = false;
      if (workflow.userContext.buildProtocol) {
        userBuildProtocol = workflow.userContext.buildProtocol;
      }

      // ── Plan pre-flight: complex tasks get a plan before execution. It also
      // applies in the application temporary workspace when the user has not
      // selected a project directory. An approved plan becomes a live
      // phase-progress card in the transcript (planCard below) and the
      // model is told to emit `## 阶段 n/m` markers so the card can track
      // which phase is running.
      //
      // 计划来自本地规则分析（Planner.analyzeTask）。曾经的 LLM 实时预分析环节
      // 已整体移除：它从未稳定成功（超时/空输出），每次都把失败提示与通用步骤
      // 兜底的噪音留给用户，还拖慢启动。项目级构建和高风险请求
      // 仍然要求用户在确认卡上批准计划后才开始写入；只有用户强制指定的计划/
      // 构建模式保留同样的确认对话框（显式选择进入的规划流程）。
      // `as PlanCardHandle | null`: TS control-flow can't see assignments made
      // inside the closures below (showPlanCard / discardPlanCard), so without
      // the widening cast it keeps narrowing the variable to null and the
      // handlers that read the plan model would see type `never`.
      let planCard: PlanCardHandle | null = null as PlanCardHandle | null;
      let planProgress: PlanProgressModel | null = null;
      const discardPlanCard = (): void => {
        if (!planCard) return;
        clearPlanCardRefining(planCard);
        planCard.el.remove();
        planCard = null;
        planProgress = null;
        this.activePlanCardHandle = null;
        this.detachActivePlanProgress();
        this.activePlanCardSnapshot = null;
        this.activePlanProgress = null;
      };
      // A plan is useful for a real build even when no approval is needed.
      // Approval is a separate safety decision, not a consequence of the word
      // “project” or the number of files involved.
      if (shouldRunTaskAnalysis) {
        // Plan review runs when: auto-detected complex task (has a heuristic
        // plan), OR the user forced plan/build mode from the composer. A forced
        // YOLO suppresses review even for complex tasks.
        const riskReview = effectiveIntent.requiresConfirmation;
        const wantsPlan = workflow.requiresPlanReview || needsDeliveryGate || riskReview || Boolean(
          forcedMode === 'plan' || forcedMode === 'build',
        );
        if (wantsPlan) {
          // 检测到的复杂任务：只有一条诚实的模式气泡。用户强制指定的计划/构建
          // 模式保留原有确认流程。
          const modeBubble = forcedMode
            ? this.addStatusBubble(t('plan.modeForced', '已按你的选择进入 {mode} 模式，正在生成执行计划…').replace('{mode}', modeLabel(analysis.mode)))
            : null;
          // 计划直接来自本地规则分析（Planner.analyzeTask）：不再做 LLM 实时预分析。
          // 规则分析没有给出计划时（如强制计划模式遇到简单任务），用一条诚实的
          // 最小起步步骤兜底，执行中由模型按实际情况推进，绝不假装“已经想清楚”。
          let planForReview: Plan = analysis.plan ?? {
            steps: [{
              id: '1',
              action: '探明工作区现状，完成第一处真实改动',
              description: '本次未生成更细的任务计划：从最小的一步做起，边做边按实际情况调整。',
              expectedOutcome: '得到可验证的中间结果后再继续推进。',
              todosRequired: false,
            }],
            reasoning: '基于规则分析的保守起点。',
          };
          const showPlanCard = (plan: Plan, refining = false): void => {
            if (!planProgress) planProgress = new PlanProgressModel(plan, 'active', 1, 1, needsDeliveryGate);
            else if (planProgress.getSnapshot().plan !== plan) planProgress.dispatch({ type: 'planReplaced', plan });
            if (planCard) {
              // Keep one stable, flat progress list in the transcript. Updating
              // its contents in place preserves the user's visual anchor and
              // makes later phase changes visible instead of replacing the
              // only plan card that appeared at the start.
              updatePlanCard(planCard, plan, refining, planProgress);
            } else {
              planCard = createPlanCard(plan, refining, planProgress);
              chatEl.appendChild(planCard.el);
            }
            this.activePlanCardHandle = planCard;
            this.bindActivePlanProgress(planProgress, sendSessionId, sendWorkspace);
            scrollChatToBottomIfPinned(chatEl);
          };
          // 探查（工作区扫描）已完成：预检期的思考卡只是过渡反馈且没有内容，
          // 直接收走——不留下“思考完成却什么都没想”的空行。探索/契约结论与
          // 评估卡此刻一并落定（规则层判断），随后渲染计划卡进入确认/执行流程。
          removeThinkingCard();
          maybeShowAssessment();
          showPlanCard(planForReview);
          const approvePlan = (explicitlyApproved = false) => {
            if (assessmentFlow) {
              // 计划已确认：先落定风险与闸门两个前置节点，再进入执行/等待。
              assessmentFlow.completePhase('risk', `风险等级已确认：${riskLabelOf(effectiveIntent.riskLevel)}`);
              assessmentFlow.completePhase('gate', effectiveIntent.requiresConfirmation
                ? '你已确认影响范围，安全闸门已通过。'
                : '评估完成，当前请求可以进入执行阶段。');
              assessmentFlow.setPhase('execute', pauseAfterPlanning
                ? '计划已就绪，等待你回复后开始第一个可验证步骤…'
                : '边界已确认，准备按小步策略执行…');
            }
            // Keep the approved plan and cursor outside this send() so the next
            // user message continues the same phase/Todo instead of reopening
            // the planning interview.
            this.activeComplexPlan = planForReview;
            this.activePlanNumber = 1;
            this.activeTodoNumber = 1;
            this.activePlanStarted = false;
            // 用户已在确认卡上明确批准（项目构建/高风险/强制计划模式）：直接进入执行，
            // 不再二次暂停等一句“开始”；自动检测的复杂任务保留“计划就绪→回复开工”的节奏。
            if (!forcedMode && !explicitlyApproved) pauseAfterPlanning = true;
            // Inject the validated plan object, never the raw model response.
            // This keeps repaired JSON out of context while still ensuring the
            // approved project steps are the instructions the build follows.
            // !pauseAfterPlanning = 本轮无需等待用户“开工”消息（确认卡已批准，或
            // forced-yolo 直接放行）→ 模型第一轮必须立即开始执行，不能再要求“等用户
            // 下一条消息才开工”，否则引擎第一轮就空转完成，界面会直接从计划跳到交付。
            userPlan = formatPlanForPrompt(planForReview, needsDeliveryGate, !pauseAfterPlanning);
            // Plan is ready: the bubble no longer promises generation.
            if (modeBubble) modeBubble.textContent = forcedMode
              ? t('plan.modeActive', '已切换为 {mode} 模式，按方案执行').replace('{mode}', modeLabel(analysis.mode))
              : t('plan.humanActive', '方案已经整理好，按实际进展继续推进。');
            planCard?.setActivity(needsInteractiveApproval
              ? '方案已经整理好，等待你确认后开始。'
              : '方案已经整理好，马上从第一项开始验证。');
          };
          // 用户强制 yolo 时不做任何门控：即使请求是项目级构建，也直接放行执行
          // （forceMode 是用户明确的“不要问我”选择）。
          const needsInteractiveApproval = riskReview || forcedMode === 'plan' || forcedMode === 'build';
          if (needsInteractiveApproval) {
            if (riskReview) {
              assessmentFlow?.setPhase('gate', '高风险请求需要你的明确确认，尚未执行任何写入…');
            } else if (needsDeliveryGate) {
              assessmentFlow?.setPhase('gate', '这是你主动选择的执行模式，我先把方案停在这里，等你确认后开始…');
            }
            // 高风险 / 项目级构建 / 用户手动选择计划·构建模式：在任何写入或破坏性
            // 动作前保留明确的确认点——先展示影响与计划，用户批准后才开始构建。
            const decision = await requestPlanReview(
              { ...analysis, plan: planForReview, reasoning: planForReview.reasoning },
              { allowSkip: !needsDeliveryGate && !riskReview, riskReview, signal: this.abortController?.signal },
            );
            if (decision === 'cancel') {
              // 用户点了「停止」与点了「取消」文案区分：停止=暂停保留，取消=拒绝执行。
              const stopped = this.abortController?.signal.aborted === true;
              assessmentFlow?.cancel(stopped ? '已暂停：尚未执行任何改动。' : '你暂未批准本次执行，未执行任何改动。');
              // 用户拒绝/停止执行：他的请求保留在对话里作为记录（只有切换会话才移除），
              // 计划卡与模式提示属于本次流程，一并清理。
              discardPlanCard();
              removeThinkingCard();
              keepOrDropUserBubble(stopped ? '⏸ 已暂停：你的请求已保留在对话中。' : '已取消本次执行计划，你的请求已保留在对话中。');
              modeBubble?.remove();
              return; // finally resets streaming
            }
            if (decision === 'skip') {
              assessmentFlow?.skipPhase('gate', '你跳过了计划确认，继续按普通流程处理…');
              discardPlanCard();
              modeBubble?.remove();
            } else {
              approvePlan(true);
            }
          } else {
            // Auto-detected work keeps moving. The plan is visible context,
            // not a second confirmation prompt the user has to dismiss.
            approvePlan(true);
          }
        } else if (forcedMode === 'plan' || forcedMode === 'build') {
          // The plan gate needs a real filesystem root (and the Planning skill);
          // without it a forced plan/build would silently do nothing. Surface the
          // mismatch instead of ignoring the user's mode choice.
          if (!needsDeliveryGate) {
            this.addStatusBubble(
              effectiveWorkspace
                ? t('plan.modeDisabled', '🧭 计划/构建模式已被禁用（设置 → Skills → Planning），本次按普通对话继续')
                : t('plan.modeNoWorkspace', '🧭 计划/构建模式需要先选择工作区，本次按普通对话继续'),
            );
          }
        }
      } else if (continuingPlan && this.activeComplexPlan) {
        // Continuation turn (auto-continue round or a user follow-up while a
        // plan is active): shouldRunTaskAnalysis is false by definition here,
        // so this branch MUST live outside that block. It used to be its
        // else-arm — dead code, since !continuingPlan gates the whole block —
        // leaving planProgress null for the entire round: stage markers had no
        // model to advance, the card froze on the first turn's state, and 🔁
        // rounds looped until maxRounds.
        // 明确的“继续/接着做”才注入续跑框架（计划作为上下文、模型按 Todo 推进）；
        // 中途的“新诉求”则不注入，让模型直接基于既有对话与计划卡自然理解处理。
        userPlan = isExplicitContinuation(userText)
          ? formatPlanContinuation(this.activeComplexPlan, this.activePlanNumber, this.activeTodoNumber, needsDeliveryGate)
          : undefined;
        planProgress = new PlanProgressModel(this.activeComplexPlan, 'active', this.activePlanNumber, this.activeTodoNumber, this.activePlanProjectBuild);
        const existingCard = this.activePlanCardHandle?.el.isConnected ? this.activePlanCardHandle : null;
        if (existingCard) {
          // One stable progress list per transcript: rebind the SAME card to
          // the fresh model instead of stacking a duplicate every round.
          updatePlanCard(existingCard, this.activeComplexPlan, false, planProgress);
          planCard = existingCard;
        } else {
          planCard = createPlanCard(this.activeComplexPlan, false, planProgress);
          chatEl.appendChild(planCard.el);
        }
        this.activePlanCardHandle = planCard;
        this.bindActivePlanProgress(planProgress, sendSessionId, sendWorkspace);
        // 仅当是明确续跑指令时才输出“继续处理第 x 阶段第 y 个 Todo”的生硬框架；
        // 中途的新诉求沿用计划上下文，但不套用该文案，直接自然处理。
        if (isExplicitContinuation(userText)) {
          this.addStatusBubble(`收到，我们继续处理第 ${this.activePlanNumber} 阶段的第 ${this.activeTodoNumber} 个 Todo，不重新规划。`, false, false);
        }
        // 用户回复即明确“开工”：聊天中的计划卡从「等待回复」切回「正在执行」。
        planProgress?.dispatch({ type: 'statusChanged', status: 'active' });
        scrollChatToBottomIfPinned(chatEl);
      }

      if (needsDeliveryGate && !effectiveWorkspace) {
        this.addStatusBubble(t('plan.modeNoWorkspace', '🧭 项目构建需要先选择工作区；计划已确认，本次暂不执行'));
      }

      // The user bubble was already rendered synchronously at send() start
      // (immediate feedback, before the plan pre-flight above) — do NOT add it
      // again here; a duplicate would appear after the interactive review.
      // Approved execution plan → a compact phase tracker in the transcript:
      // total phase count + which phase is currently running, updated live
      // from the model's `## 阶段 n/m` markers (see formatPlanForPrompt).
  // The plan card was created during the plan gate (hoisted above) — no card
  // creation here; the transcript already shows the steps.
  const planTrack = { seg: null as { el: HTMLDivElement; text: string } | null, scanLen: 0, consumedMarkers: new Set<string>(), phaseStarted: new Set<number>(), phaseCompleted: new Set<number>(), protocolStarted: false, deferredMarkers: new Map<number, Array<Extract<PlanProgressMarker, { kind: 'substep' | 'substepDone' }>>>(), deferredPhase: null as number | null, deferredReason: null as 'protocol' | null, completedPlan: null as number | null, unblockDeferredOnWork: null as (() => void) | null };
      if (needsDeliveryGate && !effectiveWorkspace) {
        // 计划已确认但没有可选工作区：结束本轮，评估卡明确收尾而不是停在“执行中”。
        assessmentFlow?.cancel('未选择工作区，计划已确认但本次不执行。');
        return;
      }
      const trackPlanPhase = (seg: { el: HTMLDivElement; text: string }) => {
        if (!planCard) return;
        const card = planCard;
        const modelSnapshot = (): PlanProgressSnapshot | null => planProgress?.getSnapshot() ?? null;
        if (planTrack.seg !== seg) { planTrack.seg = seg; planTrack.scanLen = 0; planTrack.consumedMarkers.clear(); }
        if (planTrack.scanLen >= seg.text.length) return;
        // Overlap window keeps the previous 24 chars in the slice so a marker
        // split across token boundaries ("## 阶段 " + "2/4") is still seen whole.
        const tail = seg.text.slice(Math.max(0, planTrack.scanLen - 24));
        planTrack.scanLen = seg.text.length;         const markers = matchPlanProgressMarkers(tail);
         const finishPlan = (planNumber: number): void => {
          const finishSnapshot = modelSnapshot();
          if (!finishSnapshot || planNumber !== finishSnapshot.currentPlan) return;
          const isLastPlan = planNumber >= finishSnapshot.plan.steps.length;
          // 所有阶段一视同仁：Todo 未真实完成时，完成播报只更新文案、不推进
          // 游标。最后计划不再 force 清空未完成 Todo——收尾证据由回合末判定把关，
          // 否则“只做了一半就播报完成”会被当成整计划完成。
          if (!(planProgress?.canCompleteCurrentTodos() ?? false)) {
            card.setActivity(`计划 ${planNumber} 仍有 Todo 未完成，暂不进入下一计划…`);
            return;
          }
          planProgress?.dispatch({ type: 'todosCompleted' });
          card.setActivity(isLastPlan
            ? `计划 ${planNumber} 已完成，整个计划收尾中…`
            : `计划 ${planNumber} 已完成，正在准备下一个计划…`);
          planProgress?.dispatch({ type: 'phaseStarted', planNumber: planNumber + 1 });
          planTrack.completedPlan = planNumber;
          consumeDeferredSubsteps(planNumber, planNumber + 1);
        };
        const consumeTodoMarker = (marker: Extract<PlanProgressMarker, { kind: 'substep' | 'substepDone' }>): void => {
          const todoSnapshot = modelSnapshot();
          if (!todoSnapshot) return;
          const activePlan = todoSnapshot.currentPlan;
          const activeStep = todoSnapshot.plan.steps[activePlan - 1];
          const todos = activeStep?.substeps ?? [];
          const totalTodos = todos.length;
          const todoLabel = todos[marker.number - 1]?.action;
          if (marker.kind === 'substepDone') {
            const wasCurrentTodo = activeStep?.todosRequired !== false && marker.number >= 1 && marker.number <= totalTodos && todoSnapshot.currentTodo === marker.number && planProgress?.isTodoStarted(marker.number) === true;
            planProgress?.dispatch({ type: 'todoCompleted', todoNumber: marker.number });
            if (wasCurrentTodo) {
              const nextTodo = planProgress?.getSnapshot().currentTodo ?? marker.number + 1;
              card.setActivity(`计划 ${activePlan} 的 Todo ${marker.number} 已完成${nextTodo <= totalTodos ? '，开始下一项…' : '，Todos 已全部完成，等待计划收尾…'}`);
            }
          } else {
            planProgress?.dispatch({ type: 'todoStarted', todoNumber: marker.number });
            card.setActivity(`正在执行计划 ${activePlan} 的 Todo ${marker.number}${todoLabel ? `：${todoLabel}` : ''}…`);
          }
          if ((planProgress?.canCompleteCurrentTodos() ?? false)) {
            card.setActivity(`计划 ${activePlan} 的 Todos 已完成，等待“计划 ${activePlan} 已完成”播报…`);
          }
          };
         // Strict-protocol safety net: the projection must follow the actual
         // build, not stall forever on a missing `## 计划 n 已完成` line. When a
         // later plan was announced but blocked (completion never announced),
         // the first real tool call for the announced plan advances the card
         // with implicit completion of everything before it. Delivery
         // verification is enforced at turn end by the deterministic backstop,
         // so mid-plan cursor movement no longer waits on it here.
         planTrack.unblockDeferredOnWork = (): void => {
           const target = planTrack.deferredPhase;
           if (target === null) return;
           const snapshot = modelSnapshot();
           if (!snapshot || !planTrack.phaseStarted.has(target) || target <= snapshot.currentPlan) return;
           planProgress?.dispatch({ type: 'phaseJumped', planNumber: target });
           planTrack.deferredPhase = null;
           planTrack.deferredReason = null;
           const after = modelSnapshot();
           if (after && after.currentPlan === target) {
             const stepLabel = after.plan.steps[target - 1]?.action;
             const todosRequired = after.plan.steps[target - 1]?.todosRequired !== false;
             card.setActivity(`已开始计划 ${target}${stepLabel ? `：${stepLabel}` : ''}${todosRequired ? '，正在执行它的 Todos…' : '，正在执行原子任务…'}`);
             const queued = planTrack.deferredMarkers.get(target) ?? [];
             planTrack.deferredMarkers.delete(target);
             for (const todoMarker of queued) consumeTodoMarker(todoMarker);
           }
         };
         const tailStart = Math.max(0, planTrack.scanLen - tail.length);
         for (const marker of markers) {
           const markerKey = `${marker.kind}:${marker.number}:${tailStart + marker.index}`;
           if (planTrack.consumedMarkers.has(markerKey)) continue;
           planTrack.consumedMarkers.add(markerKey);
           if (marker.kind === 'phase') {
            const markerText = tail.slice(marker.index, marker.end);
            const isProtocolStart = /(?:计划|Plan)\s*\d+\s*(?=[:：])/i.test(markerText);
            if (isProtocolStart) {
              planTrack.phaseStarted.add(marker.number);
              planTrack.protocolStarted = true;
            }
            const beforeSnapshot = modelSnapshot();
            if (!beforeSnapshot) continue;
            const before = beforeSnapshot.currentPlan;
            planProgress?.dispatch({ type: 'phaseStarted', planNumber: marker.number });
            const afterStart = modelSnapshot();
            if (afterStart?.currentPlan === marker.number) {
              const stepLabel = afterStart.plan.steps[marker.number - 1]?.action;
              const todosRequired = afterStart.plan.steps[marker.number - 1]?.todosRequired !== false;
              card.setActivity(`已开始计划 ${marker.number}${stepLabel ? `：${stepLabel}` : ''}${todosRequired ? '，正在执行它的 Todos…' : '，正在执行原子任务…'}`);
              const queued = planTrack.deferredMarkers.get(marker.number) ?? [];
              planTrack.deferredMarkers.delete(marker.number);
              for (const todoMarker of queued) consumeTodoMarker(todoMarker);
              planTrack.deferredPhase = null;
              planTrack.deferredReason = null;
            } else if (marker.number > before) {
              // The model explicitly started a later plan, but a later stage may
              // start only after the current stage has emitted its explicit
              // completion event. This keeps both progress views driven by the
              // conversation protocol instead of tool timing.
              if (planTrack.protocolStarted && !planTrack.phaseCompleted.has(before)) {
                card.setActivity(`计划 ${before} 尚未播报完成，暂不进入计划 ${marker.number}…`);
                planTrack.deferredPhase = marker.number;
                planTrack.deferredReason = 'protocol';
              } else {
                // Jump straight to the reported plan instead of one step per
                // marker: a single-step imperative updater would advance by exactly one, so
                // a model that reports "## 计划 3：" while the card is on plan
                // 1 would otherwise leave the chat card
                // mirroring it stuck on the old step while the transcript
                // already shows plan 3 work. Everything in between is
                // implicitly done. total + 1 (beyond the list) completes.
                planProgress?.dispatch({ type: 'phaseJumped', planNumber: Math.max(before + 1, Math.min(marker.number, beforeSnapshot.plan.steps.length + 1)) });
                const afterJump = modelSnapshot();
                if (afterJump?.currentPlan === marker.number) {
                  const stepLabel = afterJump.plan.steps[marker.number - 1]?.action;
                  const todosRequired = afterJump.plan.steps[marker.number - 1]?.todosRequired !== false;
                  card.setActivity(`已开始计划 ${marker.number}${stepLabel ? `：${stepLabel}` : ''}${todosRequired ? '，正在执行它的 Todos…' : '，正在执行原子任务…'}`);
                  const queued = planTrack.deferredMarkers.get(marker.number) ?? [];
                  planTrack.deferredMarkers.delete(marker.number);
                  for (const todoMarker of queued) consumeTodoMarker(todoMarker);
                  planTrack.deferredPhase = null;
                  planTrack.deferredReason = null;
                } else {
                  planTrack.deferredPhase = marker.number;
                  planTrack.deferredReason = 'protocol';
                }
              }
            }
          } else if (marker.kind === 'phaseDone') {
            const markerText = tail.slice(marker.index, marker.end);
            if (/(?:计划|Plan)\s*\d+\s*(?:完成|已完成)/i.test(markerText)) {
              planTrack.phaseCompleted.add(marker.number);
              planTrack.protocolStarted = true;
            }
            finishPlan(marker.number);
            planTrack.deferredPhase = null;
            planTrack.deferredReason = null;
          } else if (planTrack.deferredPhase !== null) {
            const queued = planTrack.deferredMarkers.get(planTrack.deferredPhase) ?? [];
            queued.push(marker);
            planTrack.deferredMarkers.set(planTrack.deferredPhase, queued);
          } else {
            consumeTodoMarker(marker);
          }
        }
        const afterMarkers = planProgress?.getSnapshot();
        if (afterMarkers) consumeDeferredSubsteps(afterMarkers.currentPlan, afterMarkers.currentPlan + 1);
      };
      const consumeDeferredSubsteps = (finishedPlan: number, targetPlan: number): void => {
        if (!planCard) return;
        const snapshot = planProgress?.getSnapshot();
        const queued = planTrack.deferredMarkers.get(targetPlan);
        if (!snapshot || !queued || !planTrack.phaseCompleted.has(finishedPlan) || snapshot.currentPlan !== finishedPlan || !(planProgress?.canCompleteCurrentTodos() ?? false)) return;
        planProgress?.dispatch({ type: 'todosCompleted' });
        planProgress?.dispatch({ type: 'phaseStarted', planNumber: targetPlan });
        if (planProgress?.getSnapshot().currentPlan !== targetPlan) return;
        planTrack.deferredMarkers.delete(targetPlan);
        planCard.setActivity(`计划 ${finishedPlan} 已完成，正在执行计划 ${targetPlan}…`);
        for (const marker of queued) {
          const todo = snapshot.plan.steps[targetPlan - 1]?.substeps?.[marker.number - 1]?.action;
          if (marker.kind === 'substepDone') planProgress?.dispatch({ type: 'todoCompleted', todoNumber: marker.number });
          else planProgress?.dispatch({ type: 'todoStarted', todoNumber: marker.number });
          planCard.setActivity(`正在执行计划 ${targetPlan} 的 Todo ${marker.number}${todo ? `：${todo}` : ''}…`);
        }
      };
      const turnSignal = this.abortController.signal;
      // One bounded auto-fix round driven by REAL failing verification output
      // (Claude-Code stop-hook semantics): the model fixes root causes, re-runs
      // the failed checks itself, and the deterministic backstop re-runs after.
      const runDeliveryFixRound = async (
        messages: Message[],
        failed: DeliveryVerificationResult,
      ): Promise<{ completed: boolean; messages: Message[]; output: string }> => {
        const fixPrompt = formatDeliveryFixPrompt(failed);
        const fixCommandGuard = (command: string): string | null => isGitMutationCommand(command)
          ? '修复阶段禁止修改 Git 仓库状态（包括 git -C、shell 包装形式）；请只修复交付验证报告的代码问题。'
          : null;
        this.addStatusBubble('🛠️ 修复阶段：agent 正在根据真实失败输出修复并重新验证…', true);
        const fixSegment = createSegment();
        const fixEvents = codingAgent.continueTurn(systemPrompt, messages, fixPrompt, turnSignal);
        codingAgent.toolRegistry.setCommandGuard(fixCommandGuard);
        let output = '';
        let latestMessages = messages;
        try {
          for await (const fixEvent of fixEvents) {
            if (gen !== this.generation || turnSignal.aborted) return { completed: false, messages: latestMessages, output };
          if (fixEvent.type === 'TokenDelta' && !fixEvent.payload.isToolCall && fixEvent.payload.content) {
            output += fixEvent.payload.content;
            fixSegment.text = output;
            if (streamingRenderEnabled) {
              scheduleStreamingRender(output, fixSegment.el, () => scrollChatToBottomIfPinned(chatEl));
            } else {
              fixSegment.el.textContent = output;
            }
          } else if (fixEvent.type === 'ToolResult') {
            const ok = fixEvent.payload.result.success;
            toolResults.set(fixEvent.payload.toolCallId, {
              toolName: fixEvent.payload.toolName,
              success: ok,
              duration: fixEvent.payload.duration,
              resultText: typeof fixEvent.payload.result.result === 'string' ? fixEvent.payload.result.result.slice(0, 800) : fixEvent.payload.result.error,
            });
            this.recordToolActivity(fixEvent.payload.toolName, undefined, ok);
            this.addStatusBubble(`${ok ? '🔧✅' : '🔧⛔'} 修复工具 ${fixEvent.payload.toolName}：${ok ? '已完成' : fixEvent.payload.result.error ?? '失败'}`, !ok, !ok);
            scrollChatToBottomIfPinned(chatEl);
          } else if (fixEvent.type === 'Completed') {
            latestMessages = fixEvent.payload.messages ?? latestMessages;
            if (!output && fixEvent.payload.finalOutput) {
              output = fixEvent.payload.finalOutput;
              fixSegment.text = output;
            }
            return { completed: !fixEvent.payload.interrupted, messages: latestMessages, output };
          } else if (fixEvent.type === 'Error' || fixEvent.type === 'Interrupted') {
            return { completed: false, messages: latestMessages, output };
            }
          }
        } finally {
          codingAgent.toolRegistry.setCommandGuard(undefined);
        }
        return { completed: false, messages: latestMessages, output };
      };
      // Surface detected logical traps as a neutral notice (not an error): the
      // agent will verify the premise before executing.
      if (analysis.traps.length > 0) {
        const labels = [...new Set(analysis.traps.map(t => TRAP_TYPE_LABELS[t.type] ?? t.type))].join('、');
        this.addStatusBubble(`⚠️ 检测到请求中可能包含逻辑陷阱（${labels}）— 将先验证前提，若前提有误会换思路处理`);
      }
      // Eager thinking indicator: the user sees the animation while waiting
      // for the first token; reasoning deltas upgrade it with live text. A
      // plain turn (no task analysis) reuses the card opened before the
      // preflight; analysis turns get a fresh card below the plan card.
      if (!thinkingCard) thinkingCard = openThinkingCard();
      // Waiting for the engine's first token: a stable honest label keeps the
      // card alive (dots animate) without pretending to do specific work; the
      // first streamed reasoning delta replaces it with real content.
      setThinkingLabel(thinkingCard, '正在思考…');
      // A new user turn is explicit intent to continue at the bottom: re-pin
      // even if the user had scrolled up to re-read history (the pin normally
      // survives until a manual scroll-away, but a fresh send must resume
      // following the newest content — otherwise the transcript stays frozen
      // above the reply for the rest of the session). Route through the
      // rAF-coalesced helper so this first content growth joins the same frame
      // budget as every streamed token (a direct scrollTop write here forced a
      // synchronous full-transcript layout). A fresh turn also dismisses any
      // "new content below" pill left over from the previous turn.
      forceScrollToBottom(chatEl);
      hideNewContentHint();

      // ── Deferred init: boot MCP on first use ──
      if (!this.deferredInitDone) {
        this.deferredInitDone = true;
        this.mcpSessionId = sendSessionId;
        this.mcpConfigSnapshot = JSON.stringify([config.mcpServers ?? [], effectiveProxyUrl(config.proxy, 'tools')]);
        this.mcpClient = codingAgent.mcpClient;

        if (this.mcpClient) {
          // Await MCP connect so tools are registered before the first run builds
          // its toolsDefs (toolsDefsProvider reads them live) — but never block
          // the first send: race against a short timeout, then proceed without
          // MCP tools if a server is slow. They'll appear on the next turn.
          await withAbortTimeout(
            this.mcpClient.connectAll().catch((err: Error) => {
              console.warn('[pure] MCP connection failed:', err.message);
            }),
            this.abortController?.signal,
            1_500,
            'MCP initialization',
          ).catch((err: Error) => {
            if (err.name === 'AbortError') throw err;
            console.warn('[pure] MCP initialization skipped:', err.message);
          });
        }
      }

      if ((pauseAfterPlanning || planPauseRequested) && this.activeComplexPlan) {
        // 计划就绪并停在第一个 Todo 前：明确切到「等待你回复」状态，而不是
        // 让执行节点一直“进行中”地空转。计划卡、暂停气泡、评估卡三处联动。
        assessmentFlow?.awaitPhase('execute', '计划已就绪，等待你回复后开始第一个可验证步骤…');
        endThinking();
        this.activePlanStarted = false;
        const pauseMessage = formatPlanPauseMessage(this.activeComplexPlan);
        const pauseSnapshot: Message[] = [
          ...this.messages,
          { role: 'user', content: userText, images: userImages, attachments: userMessageAttachments },
          { role: 'assistant', content: pauseMessage },
        ];
        this.messages = pauseSnapshot;
        this.hasHistory = true;
        const pauseSegment = createSegment();
        pauseSegment.text = pauseMessage;
        pauseSegment.el.classList.remove('streaming');
        pauseSegment.el.classList.add('plan-pause-message');
        void renderMarkdown(pauseMessage, pauseSegment.el);
        // Hoist the in-transcript pause cards so the cancel shortcut can flip
        // them out of the "等待你回复" state.
        this.pausePlanCard = planCard;
        this.pauseAssessmentFlow = assessmentFlow;
        // Continue/cancel shortcuts live on the row (outside the bubble), so
        // the async markdown render cannot wipe them.
        attachPlanPauseActions(
          pauseSegment.el.parentElement ?? chatEl,
          () => this.continuePausedPlan(),
          () => this.cancelPausedPlan(),
        );
        const firstLabel = this.activeComplexPlan.steps[0]?.action ?? '当前阶段';
        planProgress?.dispatch({ type: 'statusChanged', status: 'waiting' });
        // 一个脉冲状态气泡放在最后：明确告诉用户“一切就绪，等你回复开工”，
        // 避免输入框恢复后看起来像流程悄悄停止了。
        this.addStatusBubble(`⏸ 已暂停在这里等你：直接回复即可开始第 1 项「${firstLabel}」。`, true, false);
        scrollChatToBottomIfPinned(chatEl);
        await this.persistSession(
          pauseSnapshot,
          toolResults,
          thinkingPhases,
          sendSessionId,
          sendWorkspace,
          true,
          effectiveIntent,
          taskAnalysisText,
          assistantSegments.map(segment => segment.text),
          turnArtifacts,
          displayUserText,
        );
        return;
      }

      // 未走计划访谈的路径（如中风险但简单的请求）在这里补出评估卡：此时所有前置
      // 检查都已真实完成，闸门随检查结果落定，卡片再随执行/验证进度推进。
      maybeShowAssessment();
      if (assessmentFlow && !pauseAfterPlanning) {
        assessmentFlow.setPhase('execute', '已通过评估闸门，开始按确认范围小步执行…');
      }
      const finalPromptTools = effectiveWorkspace
        ? codingAgent.toolRegistry.getTools()
        : promptTools;
      // App skills (~/.pure/skills, installed by the capability-gap protocol)
      // join the enabled Skill Hub skills in the system prompt. TTL-cached: a
      // skill installed mid-session shows up within 30s, not after a restart.
      const appSkills = await loadAppSkills(effectiveWorkspace);
      const assembly = promptAssembler.assemble({
        surface: 'gui',
        capabilities: buildGuiCapabilities(!!effectiveWorkspace, usingTemporaryWorkspace, { imageGeneration: imageGen }),
        imageGeneration: imageGen,
        toolDefinitions: finalPromptTools,
        modelIdentity: buildModelIdentity(config),
        environment: buildEnvironmentContext(config),
        runtimes: buildRuntimesContext(),
        network: buildNetworkContext(),
        shell: buildShellContextLine(),
        skills: [...(config.hubSkills ?? []), ...appSkills],
        mode: analysis.mode,
        budget: promptBudgetForProvider(config.customProviders, config.provider, config.model),
      }, userText, {
        traps: userTraps,
        buildProtocol: userBuildProtocol,
        plan: userPlan,
        contract: taskContract ? formatTaskContract(taskContract) : undefined,
        assessment: userAssessment,
        plausibilityOverride: userPlausibilityOverride,
        // 项目构建的交付验证管线（检视→typecheck→单测→e2e）作为计划的最后一个
        // 阶段下发给模型本身执行；UI 工程额外携带设计先行协议（先出 design.html
        // 等用户在预览卡确认，再写实现代码）。
        deliveryPipeline: needsDeliveryGate
          ? formatDeliveryPipeline(workspaceProfile, workflow.needsDesignPhase)
          : undefined,
      });
      systemPrompt = assembly.systemPrompt;
      const userTurn = assembly.userPrompt ?? userText;
      const budgetDiagnostic = formatPromptBudgetDiagnostic(assembly.budget);
      if (budgetDiagnostic) console.warn(budgetDiagnostic);
      // Hand the background pre-compacted window (when it matches the current
      // session + message state) to continueTurn instead of the full history:
      // the in-engine trim then short-circuits (already under threshold) and
      // the LLM summarization stays off the send critical path.
      const historyMessages = pickHistoryMessages(
        this.preCompactedMessages, this.preCompactSessionId, this.preCompactMessageCount,
        sendSessionId, this.messages, this.preCompactSourceMessages,
      );
      // Safety net: whenever a plan card exists and the engine is about to
      // run (any pre-flight path — continuation, approval, forced mode), the
      // chat plan card must be in the executing state, never stale-waiting.
      // When the turn has NO plan card (simple task, forced mode abandoning
      // the plan, or a follow-up after the previous plan finished), do not
      // attach any stale plan presentation to the new turn.
      const events = this.hasHistory
        ? codingAgent.continueTurn(systemPrompt, historyMessages, userTurn, turnSignal, userImages)
        : codingAgent.run(systemPrompt, userTurn, turnSignal, userImages);
      // 本轮是否至少有一个工具真实成功：全失败的工具轮既不能推进阶段，也不能
      // 作为“阶段完成”的证据（hasToolWork 只表示模型调用了工具，含失败）。
      let hasToolSuccess = false;
      for await (const event of events) {

        // Session switched mid-stream (sidebar click / new chat): stop writing
        // into the new transcript immediately. The engine is aborted via
        // cancel() (main.ts loadAndDisplaySession), so no events remain — this
        // guard also covers slow-abort cases where a straggler still yields.
        if (gen !== this.generation) break;
        switch (event.type) {
          case 'YieldControl': {
            this.updateTurnCount(event.payload.turnNumber, true);
            break;
          }

          case 'StateChange': {
            if (event.payload.to === 'VERIFY') {
              assessmentFlow?.setPhase('verify', event.payload.reason ?? '执行阶段完成，正在验证结果…');
            } else if (event.payload.to === 'ACT') {
              assessmentFlow?.setPhase('execute', event.payload.reason ?? '正在执行当前确认范围内的改动…');
            }
            if (event.payload.to === 'THINK') {
              assistantIteration++;
              // A new LLM iteration = a new tool round: close the previous
              // round's parallel grid so the next batch of tool rows starts
              // its own horizontal group.
              toolGrid = null;
            }
            break;
          }

          case 'FailurePolicyDecision': {
            // The engine retries failed LLM calls SILENTLY from the UI's point
            // of view (a retry re-streams the whole context) — one of the main
            // causes of long "正在思考下一步…" silences. Surface it on the live
            // card so the user can tell a retry from a hang.
            const kind = event.payload?.action?.kind;
            if (kind === 'retry' || kind === 'reflect') {
              llmRetryNotices++;
              cancelToolGapCard();
              if (!thinkingCard) {
                thinkingCard = openThinkingCard();
                thinkingCard.card.classList.add('waiting');
                scrollChatToBottomIfPinned(chatEl);
              }
              setThinkingLabel(thinkingCard, `模型请求失败，正在重试（连续第 ${llmRetryNotices} 次）…`);
            } else if (kind === 'degrade') {
              llmRetryNotices++;
              if (thinkingCard) setThinkingLabel(thinkingCard, `连续失败，已降级处理（第 ${llmRetryNotices} 次）…`);
            }
            // kind === 'stop' surfaces via the Interrupted event path below.
            break;
          }

          case 'TokenDelta': {
            if (!event.payload.isToolCall) {
              const delta = event.payload.content;
              if (delta) {
                // Answer text is now visibly streaming: schedule the hint's
                // 1s linger BEFORE endThinking finalizes the card, so a showing
                // hint survives finalize and completes its own fade.
                if (thinkingCard) dismissThinkingHint(thinkingCard, HINT_LINGER_MS);
                // First visible answer token closes the thinking phase.
                endThinking();
                const seg = ensureSegment();
                seg.text += delta;
                // Scan newly-appended text for `阶段 n/m` plan markers so the
                // approved-plan phase card advances as the run progresses.
                trackPlanPhase(seg);
                // Strip leaked <tool_calls> XML before it ever reaches the DOM.
                const xmlProbe = `${seg.toolCallXmlTail}${delta}`;
                if (!seg.mayContainToolCallXml && /<(?:tool_calls|invoke\b|parameter\b)/i.test(xmlProbe)) {
                  seg.mayContainToolCallXml = true;
                }
                seg.toolCallXmlTail = xmlProbe.slice(-32);
                const text = seg.mayContainToolCallXml ? stripToolCallXml(seg.text) : seg.text;
                if (streamingRenderEnabled) {
                  // diffStreaming owns the DOM: setting textContent here would
                  // wipe the rendered blocks on every token and defeat the
                  // data-md-raw diff (flicker + full re-highlight each tick).
                  // The throttled renderer keeps blocks intact and only updates
                  // changed ones; the callback re-syncs scroll since the DOM
                  // mutates up to 100ms after the token that triggered it.
                  scheduleStreamingRender(text, seg.el, () => {
                    scrollChatToBottomIfPinned(chatEl);
                  });
                } else {
                  // streamingRender disabled: plain-text fallback, full render
                  // happens once on Completed.
                  seg.el.textContent = text;
                }
                // Text streaming is itself visible feedback — no gap card
                // needed while tokens are arriving. (Re-arming here caused the
                // card to keep popping during long image rendering: every
                // token cancelled + re-armed the debounce, and every pause
                // longer than the debounce re-opened it. The gap card is only
                // for the silence AFTER a tool result, armed in ToolResult.)
              }
              if (!streamingRenderEnabled) scrollChatToBottomIfPinned(chatEl);
            } else {
              // ── Tool call delta → append/update inline tool row ──
              // A tool call for an announced-but-blocked later plan is hard
              // evidence the model actually started it — let the projection
              // catch up instead of waiting forever for the missing
              // completion line (see planTrack.unblockDeferredOnWork).
              planTrack.unblockDeferredOnWork?.();
              const toolName = event.payload.toolCallName ||
                (event.payload.toolCallBuffer || '').match(/"name"\s*:\s*"([^"]+)"/)?.[1];
              const toolCallId = event.payload.toolCallId;
              if (toolName) {
                const now = Date.now();
                if (toolCallId) {
                  // Id-bearing chunk (`tool_call` / `done`): the call's FINAL
                  // args — parse once (fires once per call) and fill the full
                  // Input section. Also key the row by toolCallId so parallel
                  // same-name calls get distinct rows, migrating a name-staged
                  // streaming row if one exists.
                  const args = parseToolCallBuffer(event.payload.toolCallBuffer).args || {};
                  let entry = pendingRows.get(toolCallId);
                  if (!entry) {
                    const staged = pendingByName.get(toolName);
                    if (staged) {
                      pendingByName.delete(toolName);
                      entry = { ...staged, toolCallId };
                      pendingRows.set(toolCallId, entry);
                    } else {
                      endThinking();
                      const row = appendToolRow(toolName, args);
                      toolRowSinceSegment = true;
                      entry = { row, toolName, args, toolCallId };
                      pendingRows.set(toolCallId, entry);
                    }
                  }
                  entry.args = args;
                  updateToolRowArgs(entry.row, toolName, args);
                } else {
                  // Mid-stream argument delta: id unknown, stage by name. The
                  // final id-bearing chunk migrates this entry. Streaming a
                  // giant argument (write_file `content`, a whole HTML file)
                  // grows the buffer to tens of KB, so parsing it AND
                  // re-rendering the Input section on every token is O(n²) and
                  // freezes the UI. Throttle the parse to ~120ms and only
                  // refresh the compact one-line summary while streaming; the
                  // Input body is filled on row creation and the id chunk.
                  const key = toolName;
                  const lastRefresh = toolCallRefresh.get(key) ?? 0;
                  const due = now - lastRefresh >= TOOL_CALL_REFRESH_MS;
                  if (due) toolCallRefresh.set(key, now);
                  const args = due
                    ? (parseToolCallBuffer(event.payload.toolCallBuffer).args || {})
                    : undefined;
                  const existing = pendingByName.get(toolName);
                  if (!existing) {
                    endThinking();
                    const row = appendToolRow(toolName, args ?? {});
                    toolRowSinceSegment = true;
                    pendingByName.set(toolName, { row, toolName, args: args ?? {} });
                  } else if (args) {
                    existing.args = args;
                    updateToolRowArgs(existing.row, toolName, args, false);
                  }
                }
              }
            }
            break;
          }

          case 'ReasoningDelta': {
            const content = event.payload.content;
            if (!content) break;
            cancelToolGapCard();
            // Reasoning can resume after tool rows (each LLM iteration), so a
            // fresh card opens below whatever was appended since the last one.
            if (!thinkingCard) thinkingCard = openThinkingCard();
            // First real reasoning after a silence-waiter/retry label resets
            // the card back to its default thinking state.
            if (thinkingCard.card.classList.contains('waiting')) {
              thinkingCard.card.classList.remove('waiting');
              setThinkingLabel(thinkingCard, t('thinking.thinking'));
            }
            // The slow-response hint describes a silent wait: now that
            // reasoning is visibly streaming it lingers 1s, then fades. Called
            // OUTSIDE the waiting-branch so a plain first-token wait (no
            // 'waiting' class) dismisses its hint too — previously that hint
            // hung around until the phase ended.
            dismissThinkingHint(thinkingCard, HINT_LINGER_MS);
            // Phase tracking runs per-delta (persistence); the DOM append is
            // throttled, so "card empty" must also consider the pending buffer
            // to avoid opening a duplicate phase while text is only buffered.
            if (thinkingPhases.length === 0 || (thinkingCard.textEl.textContent === '' && !thinkingPending)) {
              thinkingPhases.push({ text: '', assistantIndex: thinkingAssistantOffset + Math.max(assistantIteration, 0) });
            }
            thinkingPhases[thinkingPhases.length - 1].text += content;
            thinkingPending += content;
            if (thinkingFlushTimer === undefined) {
              thinkingFlushTimer = window.setTimeout(flushThinking, THINKING_FLUSH_MS);
            }
            break;
          }

          case 'ToolResult': {
            if (event.payload.result.success) hasToolSuccess = true;
            const status = event.payload.result.success ? '✓' : '✗';
            const toolName = event.payload.toolName;
            const duration = event.payload.duration;
            const rawResult = event.payload.result.result;
            // generate_image returns a structured summary (the LLM must never
            // see megabytes of base64): pull the human text out of the object.
            const resultText = rawResult && typeof rawResult === 'object' && 'summary' in rawResult
              ? String((rawResult as { summary?: unknown }).summary ?? '')
              : String(rawResult ?? '');
            // Special-parse web_search / web_fetch results for rich body
            // rendering; generated images render as <img> cards. Other tools
            // fall back to a raw preview in <pre>.
            let resultKind: 'search' | 'fetch' | 'image' | undefined;
            let resultItems: Array<{ title: string; snippet: string; url: string }> | undefined;
            let resultImages: GeneratedImage[] | undefined;
            let resultPreview = '';
            if (event.payload.result.success) {
              if (toolName === 'generate_image') {
                // The full base64 payloads never ride in ToolResult.result
                // (they would be JSON-serialized back into the LLM context);
                // they are claimed from the adapter's side channel here.
                resultImages = takeGeneratedImages(event.payload.toolCallId);
                if (resultImages?.length) {
                  resultKind = 'image';
                  resultPreview = resultText;
                } else {
                  resultPreview = resultText || '图片已生成（数据未送达界面）。';
                }
              } else if (toolName === 'web_search' || toolName === 'researcher_web' || toolName === 'researcher_docs') {
                resultKind = 'search';
                resultItems = parseResearchResult(resultText);
                resultPreview = resultText.slice(0, 800);
              } else if (toolName === 'web_fetch') {
                resultKind = 'fetch';
                resultPreview = resultText.slice(0, 800);
              } else if (toolName === 'execute_command') {
                // Bash output was already streamed into the row live; keep the
                // trace on finalize (streaming was about progress, not
                // truncation) so the panel never visibly shrinks — but cap it
                // at MAX_LIVE_STREAM_LINES: a 5000-line build log must not
                // balloon the DOM (nor the persisted session preview). The
                // LLM still received the FULL output in the tool result.
                resultPreview = truncateResultLines(resultText);
              } else {
                resultPreview = resultText.slice(0, 800);
              }
            } else {
              resultPreview = String(event.payload.result.error ?? '');
            }
            // Record the outcome so a session reload (main.ts flushToolExecs)
            // can replay the same tool row with full args + result preview.
            toolResults.set(event.payload.toolCallId, {
              toolName,
              success: event.payload.result.success,
              duration,
              args: (pendingRows.get(event.payload.toolCallId) ?? pendingByName.get(toolName))?.args,
              resultKind,
              resultItems,
              resultImages,
              resultText: resultPreview,
            });
            // Feed the session's activity history (search / file / command records).
            const resultArgs = (pendingRows.get(event.payload.toolCallId) ?? pendingByName.get(toolName))?.args;
            // Keep the plan card informative even when the model omits its
            // phase heading: tool results provide a local progress signal and
            // successful verification commands advance the visible checklist.
            if (planCard) {
                const cmd = String(resultArgs?.command ?? '');
              if (event.payload.result.success && event.payload.toolName === 'execute_command' && isVerificationCommand(cmd)) {
                planCard.setActivity(`验证命令已通过：${cmd}，正在继续交付验证管线…`);
              } else if (event.payload.result.success) {
                planCard.setActivity(`已完成 ${event.payload.toolName}，正在继续处理当前计划…`);
              } else {
                planCard.setActivity(`${event.payload.toolName} 未完成：${event.payload.result.error ?? '请查看工具输出'}`);
              }

              }
            this.recordToolActivity(
              toolName,
              resultArgs,
              event.payload.result.success,
            );
            // Collect written artifacts for the end-of-turn file cards: only
            // successful writes count (a failed write_file created nothing).
            if (event.payload.result.success && resultArgs) {
              // Bump the per-session version counter for each file actually
              // written/edited so the artifact card can show v1/v2/… (the
              // revision the card reflects when a file is updated repeatedly).
              const bumpVersion = (p: string): void => {
                const norm = p.trim().toLowerCase().replaceAll('\\', '/').replace(/^\.\//, '');
                if (!norm) return;
                this.fileWriteVersions.set(norm, (this.fileWriteVersions.get(norm) ?? 0) + 1);
              };
              if (toolName === 'write_file' || toolName === 'edit_file') {
                if (typeof resultArgs.path === 'string' && resultArgs.path.trim()) {
                  bumpVersion(resultArgs.path);
                  addArtifact(resultArgs.path);
                }
              } else if (toolName === 'replace_files' && Array.isArray(resultArgs.files)) {
                for (const f of resultArgs.files) {
                  if (typeof f === 'string' && f.trim()) {
                    bumpVersion(f);
                    addArtifact(f);
                  }
                }
              }
            }
            // Finalize the matching pending row — keyed by toolCallId (the
            // engine's id-bearing TokenDelta ensures one row per call).
            liveToolOutputQueue.delete(event.payload.toolCallId);
            const pending = pendingRows.get(event.payload.toolCallId) ?? pendingByName.get(toolName);
            if (pending) {
              finalizeToolRow(pending.row, {
                success: event.payload.result.success,
                duration,
                resultKind,
                resultItems,
                resultImages,
                resultText: resultPreview,
              });
              pendingRows.delete(event.payload.toolCallId);
              pendingByName.delete(toolName);
            } else {
              this.addToolStatusBubble(toolName, status, duration);
            }
            scrollChatToBottomIfPinned(chatEl);
            // The model now re-reads the tool result and plans the next step —
            // on slow models this gap is silent. Open a waiting card (debounced)
            // so the session never looks frozen between tool calls.
            scheduleToolGapCard();
            break;
          }

          case 'Error':
            if (event.payload.recoverable) {
              assessmentFlow?.setPhase('verify', '正在调整输出…');
            } else {
              assessmentFlow?.fail(`流程未完成：${event.payload.message}`);
            }
            // Recoverable verifier failures are internal retries. Keep one
            // continuous thinking card alive while the engine changes its
            // approach; exposing the policy code as a transcript card makes a
            // normal recovery look like a user-facing failure.
            const recoverable = event.payload.recoverable === true;
            if (recoverable) {
              if (thinkingCard) setThinkingLabel(thinkingCard, '正在调整输出…');
              break;
            }
            endThinking();
            this.addStatusBubble(`⚠️ ${event.payload.code}: ${event.payload.message}`, false, true);
            scrollChatToBottomIfPinned(chatEl);
            break;

          case 'Completed': {
            this.updateTurnCount(event.payload.turnCount);
            // 本轮是否真的执行过工具（写文件/跑命令）：模型提问/确认轮没有 tool 消息，
            // 那不是交付完成而是“等待用户回答”——不触发交付验证卡，评估卡保持执行等待。
            const hasToolWork = (event.payload.messages ?? []).some((m) => m.role === 'tool');
            if (hasToolWork) {
              assessmentFlow?.setPhase('verify', event.payload.interrupted ? '运行被中断，正在整理已完成部分…' : '执行阶段完成，正在验证最终结果…');
            } else {
              assessmentFlow?.setPhase('execute', event.payload.interrupted
                ? '运行被中断，正在整理已完成部分…'
                : '本轮没有产生文件改动（如需确认细节，模型会直接提问），等待你的回复后继续…');
            }
            endThinking();
            let completionMessages = event.payload.messages ?? this.messages;
            // Deterministic delivery backstop (end of turn): re-run the
            // workspace's mechanical verification specs for real — no model
            // claims involved. On failure, bounded agent-driven fix rounds get
            // the REAL failing output, and every round closes with a fresh
            // re-check. The model was already told (formatDeliveryPipeline) to
            // verify as the final plan stage; this is the stop-gate behind it.
            let qualityRepairRan = false;
            let qualityRepairRounds = 0;
            const qualityRepairIssues: string[] = [];
            const MAX_QUALITY_REPAIR_ROUNDS = 3;
            let deliveryResult: DeliveryVerificationResult | null = null;
            if (needsDeliveryGate && hasToolWork && !event.payload.interrupted && gen === this.generation) {
              this.addStatusBubble('🧪 交付验证：正在重跑机械检查（typecheck / 测试 / 构建）…', true);
              scrollChatToBottomIfPinned(chatEl);
              deliveryResult = await runDeliveryVerification(codingAgent.toolRegistry, workspaceProfile, turnSignal);
              while (
                !deliveryResult.passed &&
                !turnSignal.aborted &&
                gen === this.generation &&
                qualityRepairRounds < MAX_QUALITY_REPAIR_ROUNDS
              ) {
                qualityRepairRounds++;
                const round = qualityRepairRounds;
                const issueSummary = deliveryVerificationSummary(deliveryResult);
                qualityRepairIssues.push(`第 ${round} 轮发现：${issueSummary}`);
                this.addStatusBubble(`🔎 第 ${round}/${MAX_QUALITY_REPAIR_ROUNDS} 轮交付验证未通过：${issueSummary}`, true, true);
                const fix = await runDeliveryFixRound(completionMessages, deliveryResult);
                qualityRepairRan = qualityRepairRan || fix.completed;
                completionMessages = fix.messages;
                if (gen !== this.generation || this.abortController?.signal.aborted) return;
                if (!fix.completed) {
                  qualityRepairIssues.push(`第 ${round} 轮修复未完成：修复 agent 未返回可继续验证的完成结果。`);
                  this.addStatusBubble(`⚠️ 第 ${round} 轮修复没有完成，仍先重新验证当前工作区；未达到三轮前不会让人工介入。`, true, true);
                } else {
                  this.addStatusBubble(`🔁 第 ${round} 轮修复完成，重新执行全部交付验证…`, true);
                }
                // Every round closes with a real re-check, never the previous
                // round's evidence.
                deliveryResult = await runDeliveryVerification(codingAgent.toolRegistry, workspaceProfile, turnSignal);
              }
              if (gen !== this.generation || this.abortController?.signal.aborted) return;
              if (!deliveryResult.passed && qualityRepairRounds >= MAX_QUALITY_REPAIR_ROUNDS) {
                qualityRepairIssues.push(`第 ${MAX_QUALITY_REPAIR_ROUNDS} 轮后仍未通过：${deliveryVerificationSummary(deliveryResult)}`);
                this.addStatusBubble(`⚠️ 已自动完成 ${MAX_QUALITY_REPAIR_ROUNDS} 轮修复与复查，仍有明确问题未解决，建议人工介入。\n${qualityRepairIssues.join('\n')}`, false, true);
              }
              this.addStatusBubble(deliveryResult.passed
                ? `✅ 交付验证通过：${deliveryVerificationSummary(deliveryResult)}`
                : `⛔ 项目暂不交付：${deliveryVerificationSummary(deliveryResult)}`,
              !deliveryResult.passed, !deliveryResult.passed);
              scrollChatToBottomIfPinned(chatEl);
            }
            if (deliveryResult && completionMessages && gen === this.generation) {
              const evidence = deliveryResult.steps.length > 0
                ? deliveryResult.steps.map((s) => `$ ${s.command}\n${s.status === 'passed' ? '通过' : s.status === 'skipped' ? '跳过' : '失败'}${s.exitCode !== undefined ? `（exit ${s.exitCode}）` : ''}\n${s.output || '(无输出)'}`).join('\n\n')
                : '本工作区没有标准机械验证入口（静态页面或空工作区），按通过处理。';
              completionMessages = [...completionMessages, { role: 'assistant', content: `交付验证结果（回合末机械检查重跑）：\n${evidence}` }];
            }
            const qualityPassed = !needsDeliveryGate || (deliveryResult?.passed === true && gen === this.generation);
            // 计划完成的收尾不能只依赖模型的 `## 计划 n 已完成` 标记：模型漏发时
            // 卡片会永远停在第一步。只要回合正常结束、本轮真实执行过工具（与上方
            // hasToolWork 同一约定：提问/确认轮没有 tool 消息）、末句不是提问、且
            // 没有显式暂停，就按完成收尾——标记仍负责执行中的逐步推进。
            // 交付门禁的结果不参与收尾判定：步骤确实执行完了，计划卡就该推进到
            // 完成态（否则门禁一旦未通过，卡片会永远停在最后一步，和对话窗口内
            // 已经完成的步骤不一致）；门禁是否通过单独用气泡展示。
            const finalAnswer = String(event.payload.finalOutput ?? '').trim();
            const turnAsksForInput = finalAnswer.length > 0 && /[?？]\s*$/.test(finalAnswer);
            // Design-first builds: when the model declares the static mockup
            // ready (`## 设计稿已就绪：<file>`), hold implementation until the
            // user confirms in the preview card below.
            const designMockupFile = needsDeliveryGate && workflow.needsDesignPhase
              && !event.payload.interrupted && gen === this.generation
              ? parseDesignReadyMarker(finalAnswer)
              : null;
            const planFinished = planCard && hasToolSuccess && !event.payload.interrupted
              && !turnAsksForInput && gen === this.generation && !this.pausePlanCard;
            const completionSnapshot = planProgress?.getSnapshot();
            // True when the turn-end finalize actually dispatched 'completed'
            // (needed by the auto-continue terminal gate below).
            let planMarkedCompleted = false;
            // A missing stage marker may only finish the CURRENT stage. The old
            // fallback treated every tool-bearing turn as the whole-plan
            // completion, which cleared activeComplexPlan after version 1/4.
            const legacyPlanFinished = planCard && !planTrack.protocolStarted
              && completionSnapshot !== undefined
              && completionSnapshot.currentPlan >= completionSnapshot.plan.steps.length;
            const protocolPlanFinished = planCard && completionSnapshot && planTrack.phaseCompleted.has(completionSnapshot.plan.steps.length);
            // Last-resort finalize under the strict stage protocol: the model
            // announced (and did real tool work for) the last plan but never
            // emitted its `## 计划 n 已完成` line. Real completed work must not
            // leave the chat card stuck on the last step.
            const toolFinishedLastPlan = planCard && completionSnapshot
              && planTrack.protocolStarted && planTrack.phaseStarted.has(completionSnapshot.plan.steps.length)
              && completionSnapshot.currentPlan === completionSnapshot.plan.steps.length && hasToolSuccess;
            // A final turn often contains NO tool calls at all (pure summary
            // after the last plan's work, or a plain user ack after the model
            // asked a closing question). If the card already reached the last
            // plan, that work finished in an earlier turn — only the finalize
            // step remained. Without this the chat card would stay at N-1/N
            // forever whenever the last turn ran no tools; this is the stale
            // progress state this path used to show.
            const turnText = finalAnswer || assistantSegments.map((segment) => segment.text).join('').trim();
            const planSummarized = planCard && !hasToolWork && !event.payload.interrupted
              && !turnAsksForInput && gen === this.generation && !this.pausePlanCard
              && completionSnapshot !== undefined
              && completionSnapshot.currentPlan === completionSnapshot.plan.steps.length && turnText.length > 0;
            const planCompletionCandidate = (planFinished || planSummarized) && planCard;
            // 完成标记驱动的一次推进（finishPlan）已把游标推到 completedPlan+1，
            // 回合收尾的兜底不能再推进一次——否则"一轮一阶段"时会把下一阶段整段跳过。
            const canAdvancePlan = completionSnapshot !== undefined
              && shouldAdvancePlanAtTurnEnd(planFinished === true, completionSnapshot, planTrack.completedPlan);
            if (canAdvancePlan && planProgress && planCard) {
              const finishedPlan = completionSnapshot.currentPlan;
              const nextPlan = finishedPlan + 1;
              // 兜底推进必须带真实证据，不能把只做了一半的阶段当成完成：
              // 当前阶段 Todo 已全部完成、或模型已显式播报下一阶段（隐式完成
              // 当前阶段）；构建计划还需要验证证据（模型自跑验证 / phase backstop
              // / 本轮交付门禁通过）。绝不 force 清空未完成的 Todo。
              const todosDone = planProgress.canCompleteCurrentTodos();
              const nextAnnounced = planTrack.phaseStarted.has(nextPlan);
              const noStandardVerification = workspaceProfile !== undefined
                && workspaceProfile.verification.length === 0;
              const evidenced = !needsDeliveryGate
                || noStandardVerification
                || qualityPassed === true;
              if ((todosDone || nextAnnounced) && evidenced) {
                if (todosDone) planProgress.dispatch({ type: 'todosCompleted' });
                planProgress.dispatch({ type: nextAnnounced && !todosDone ? 'phaseJumped' : 'phaseStarted', planNumber: nextPlan });
                planCard.setActivity(`计划 ${finishedPlan} 已完成，已准备计划 ${nextPlan}；回复“继续”开始下一阶段。`);
              } else {
                planCard.setActivity(todosDone
                  ? `计划 ${finishedPlan} 的工作已完成，等待验证结果后继续…`
                  : `计划 ${finishedPlan} 的工作尚未全部完成，继续处理当前计划…`);
              }
            } else if (planCompletionCandidate && (protocolPlanFinished || legacyPlanFinished || planSummarized || toolFinishedLastPlan) && planCard) {
              // 收尾判定加独立证据（审计第 3 项）：不能只信模型一句“已完成”——
              // 最后阶段的 Todo 要真实完成、或构建计划的回合末交付验证通过。
              // 证据不足时只更新文案，不 dispatch completed。
              const lastPlanNumber = completionSnapshot?.plan.steps.length ?? 0;
              const lastTodosDone = (planProgress?.canCompleteCurrentTodos() ?? false);
              const deliveryBlocked = needsDeliveryGate && !qualityPassed;
              if (deliveryBlocked) {
                // 交付门禁未通过（审计第 4 项）：不把计划标记为完成，保留续跑
                // 上下文（activeComplexPlan 不被清空），下一轮“修复/继续”仍走
                // 原计划续跑，而不是丢失计划卡后重新分析。
                planCard.setActivity('所有阶段已完成，但交付检查未通过；回复后可继续修复并重新验证。');
              } else if (lastTodosDone || (needsDeliveryGate && qualityPassed === true)) {
                planProgress?.dispatch({ type: 'completed' });
                planMarkedCompleted = true;
                if (this.activeComplexPlan)
                  planCard.setActivity('计划中的所有步骤已完成，交付检查也已结束。');
              } else {
                planCard.setActivity('最后阶段的工作或验证尚未完成，继续处理当前计划。');
              }
            }
            // Cancel any throttled streaming render on every segment so a
            // late-firing tick from before completion cannot race with the
            // final pipeline below.
            for (const seg of assistantSegments) cancelStreamingRender(seg.el);
            resolvePendingToolRows(toolCallRefresh, pendingRows, pendingByName);
            for (const seg of assistantSegments) seg.el.classList.remove('streaming');
            // Render the text the user actually watched stream in. Each segment
            // carries its own accumulated deltas; the engine's finalOutput only
            // holds the LAST turn's content and is used as the fallback for the
            // final segment (e.g. text produced without TokenDelta events).
            if (assistantSegments.length === 0 && event.payload.finalOutput) {
              const seg = createSegment();
              seg.el.classList.remove('streaming');
              seg.text = event.payload.finalOutput;
            }
            for (let i = 0; i < assistantSegments.length; i++) {
              const seg = assistantSegments[i];
              const isLast = i === assistantSegments.length - 1;
              const finalText = seg.text || (isLast ? (event.payload.finalOutput || '') : '');
              if (!finalText) continue;
              // Render markdown + code highlights + mermaid + plantuml. Fire-and-forget so
              // the for-await loop doesn't block on the async mermaid render; the bubble is
              // visibly replaced as soon as innerHTML is set synchronously inside renderMarkdown.
              // Same XML filter as streaming, then re-scroll once the async diagram pass
              // has changed the bubble height.
              void renderMarkdown(stripToolCallXml(finalText), seg.el).then(() => {
                // The async diagram pass can resolve AFTER a session switch: the
                // bubble may already be detached and the transcript re-rendered
                // with another session's messages. Guard on the generation so a
                // stale render never scrolls the wrong transcript.
                if (gen !== this.generation) return;
                scrollChatToBottomIfPinned(chatEl);
              });
            }
            if (completionMessages) {
              finalMessages = mergeTranscriptWithTurn(this.messages, completionMessages, userText);
              this.messages = limitMessageHistory(finalMessages);
              this.hasHistory = true;
              // Background pre-compaction: trim + LLM-summarize the model
              // history in the idle window so the next send is not blocked.
              this.preCompactedMessages = null;
              this.preCompactSourceMessages = null;
              this.preCompactInBackground(systemPrompt, completionMessages, gen, codingAgent, this.messages);
            }
            // Merge this turn's billing usage into the session totals, then
            // persist + refresh the right-panel 统计 tab.
            if (event.payload.usage) {
              this.sessionStats.usage = mergeTokenUsage(this.sessionStats.usage, event.payload.usage);
            }
            this.sessionStats.provider = config.provider;
            this.persistStats();

            // Design-first pause: read the mockup from the workspace and render
            // it in a sandboxed iframe so the user reviews the intended look
            // BEFORE any implementation code exists. Best-effort: a read
            // failure never breaks the turn (the model's own evidence remains).
            let designPreviewShown = false;
            if (designMockupFile && effectiveWorkspace) {
              try {
                const previewAdapter = createToolAdapter(effectiveWorkspace, config);
                const res = await previewAdapter.execute({
                  id: `design_preview_${Date.now()}`,
                  index: 0,
                  function: { name: 'read_file', arguments: JSON.stringify({ path: designMockupFile }) },
                }, turnSignal);
                const html = typeof res.result === 'string' ? res.result : '';
                if (html.trim() && gen === this.generation) {
                  chatEl.appendChild(createDesignPreviewCard(html, designMockupFile, () => {
                    void this.send('用户已确认当前设计稿：请严格按照该设计稿开始实现，实现完成后继续执行交付验证管线。');
                  }).el);
                  this.addStatusBubble('⏸ 已按约定停在实现前：请在上方预览卡确认设计效果；确认前不会写实现代码，想调整直接回复意见。', true, false);
                  scrollChatToBottomIfPinned(chatEl);
                  designPreviewShown = true;
                }
              } catch {
                // Preview is best-effort only.
              }
            }

            // Smart artifact display: files the agent generated this turn become
            // clickable cards after the final answer — one card per artifact when
            // few (open with default app / reveal in file manager), collapsing to
            // a single project-directory card when many. Skipped on stale
            // generations (user switched sessions while the turn was streaming).
            // The Interrupted handler already rendered the artifact cards for
            // an aborted turn (the engine always yields Completed right after
            // Interrupted) — rendering them again here would duplicate the
            // project-directory card. Normal completions still render here.
            if (gen === this.generation && !event.payload.interrupted && (!needsDeliveryGate || deliveryResult?.passed === true) && turnArtifacts.length > 0) {
              const artifactRow = document.createElement('div');
              artifactRow.className = 'bubble-row artifact-row';
              chatEl.appendChild(artifactRow);
              renderArtifactCards(artifactRow, turnArtifacts, effectiveWorkspace, { userRequest: userText });
              scrollChatToBottomIfPinned(chatEl);
            }
            if (assessmentFlow && designPreviewShown) {
              assessmentFlow.awaitPhase('execute', '设计稿已就绪，等待你在预览卡确认后开始实现…');
            } else if (assessmentFlow && !event.payload.interrupted && (!needsDeliveryGate || (hasToolWork && deliveryResult?.passed === true))) {
              assessmentFlow.complete('评估、执行与验证已完成，结果满足当前交付条件。');
            } else if (assessmentFlow && event.payload.interrupted) {
              assessmentFlow.cancel('运行已中断，已保留当前进度，未把未验证内容标记为完成。');
            } else if (assessmentFlow && needsDeliveryGate && deliveryResult && !deliveryResult.passed) {
              assessmentFlow.fail('交付验证未通过，结果已保留，等待修复或进一步确认。');
            } else if (assessmentFlow && needsDeliveryGate && !hasToolWork && !event.payload.interrupted) {
              assessmentFlow.setPhase('execute', '本轮没有产生文件改动（如需确认细节，模型会直接提问），等待你的回复后继续。');
            }
            // Long-task auto-continue (docs/auto-continue-design.md): record
            // this round's signals; send()'s finally schedules the next round
            // once streaming is released and the session persisted. planTerminal
            // stops the chain at completion / delivery-gate block — a completed
            // plan has activeComplexPlan nulled, so a continuation must never
            // fire after it (it would re-analyze "继续" as a fresh task).
            const lastPlanIndex = completionSnapshot?.plan.steps.length ?? 0;
            const onFinalStage = completionSnapshot !== undefined
              && completionSnapshot.currentPlan >= lastPlanIndex;
            this.pendingAutoContinue = {
              planActive: planCard !== undefined,
              cleanEnd: planCard !== undefined && gen === this.generation && !this.pausePlanCard,
              asksForInput: turnAsksForInput,
              hasToolSuccess,
              currentPlan: completionSnapshot?.currentPlan ?? -1,
              currentTodo: completionSnapshot?.currentTodo ?? -1,
              // planTerminal must ALSO catch marker-driven completion: the last
              // stage's `## 计划 n 已完成` goes through finishPlan → phaseStarted
              // beyond the list → applyCompleted, which nulls activeComplexPlan
              // without ever dispatching the turn-end 'completed' action.
              // A failed delivery gate only stops the chain on the FINAL stage.
              // Mid-plan stages are partial work (e.g. stage 1 "set up project
              // structure" has no complete code to review); blocking the chain
              // there froze multi-stage builds on stage 1 forever.
              planTerminal: planMarkedCompleted
                || (this.activeComplexPlan === null && this.activePlanCardSnapshot?.complete === true)
                || (needsDeliveryGate && !qualityPassed && onFinalStage)
                // Design-first pause is a hard stop: the chain must wait for
                // the user's design confirmation, never auto-continue into
                // implementation.
                || designPreviewShown,
            };
            break;
          }

          case 'Interrupted': {
            assessmentFlow?.cancel(`运行已中断：${event.payload.reason}`);
            endThinking();
            if (event.payload.messages) {
              interruptedMessages = mergeTranscriptWithTurn(this.messages, event.payload.messages, userText);
              finalMessages = interruptedMessages;
              this.messages = limitMessageHistory(interruptedMessages);
              this.hasHistory = true;
              // Background pre-compaction on interruption too: the next send
              // benefits from the already-trimmed window just the same.
              this.preCompactedMessages = null;
              this.preCompactSourceMessages = null;
              this.preCompactInBackground(systemPrompt, event.payload.messages, gen, codingAgent, this.messages);
            }
            // Stop any in-flight throttled render so a late tick can't race
            // the finalization below, and resolve any "calling…" pending tool
            // cards whose ToolResult will never arrive.
            for (const seg of assistantSegments) cancelStreamingRender(seg.el);
            resolvePendingToolRows(toolCallRefresh, pendingRows, pendingByName);
            for (const seg of assistantSegments) seg.el.classList.remove('streaming');
            // Re-render each segment through the full markdown pipeline so
            // interrupted sessions get code highlighting, mermaid diagrams,
            // and path linkification — same treatment as Completed.
            for (const seg of assistantSegments) {
              if (!seg.text) continue;
              void renderMarkdown(stripToolCallXml(seg.text), seg.el).then(() => {
                if (gen !== this.generation) return;
                scrollChatToBottomIfPinned(chatEl);
              });
            }
            const hasContent = assistantSegments.some(s => s.el.textContent || s.el.children.length > 0);
            const lastSeg = assistantSegments.length ? assistantSegments[assistantSegments.length - 1] : null;
            if (event.payload.reason !== 'aborted') {
              // Keep the already-rendered content; surface the reason as a
              // separate status row instead of flattening a bubble to text.
              // Runtime interrupt notices follow the UI language (were hard-
              // coded English) — see chat.* keys in i18n.ts.
              const interrupted = t('chat.interrupted', '⏹ Interrupted: {reason}').replace('{reason}', sanitizeInterruptedReason(event.payload.reason));
              if (hasContent) {
                this.addStatusBubble(interrupted);
              } else if (lastSeg) {
                lastSeg.el.textContent = interrupted;
              } else {
                const seg = createSegment();
                seg.el.classList.remove('streaming');
                seg.el.textContent = interrupted;
              }
            } else if (!hasContent) {
              const cancelled = t('chat.cancelled', '(cancelled)');
              if (lastSeg) {
                lastSeg.el.textContent = cancelled;
              } else {
                const seg = createSegment();
                seg.el.classList.remove('streaming');
                seg.el.textContent = cancelled;
              }
            }
            // Files written before the interruption are still real artifacts —
            // surface them the same way a completed turn would.
            if (turnArtifacts.length > 0) {
              const artifactRow = document.createElement('div');
              artifactRow.className = 'bubble-row artifact-row';
              chatEl.appendChild(artifactRow);
              renderArtifactCards(artifactRow, turnArtifacts, effectiveWorkspace, { userRequest: userText });
            }
            scrollChatToBottomIfPinned(chatEl);
            break;
          }
        }
      }

      // Persist session (memory is persisted inside the store on every add).
      // Only write when this send is still the current generation, and always
      // to the session/workspace snapshot captured at send() start.
      if (finalMessages.length > 0 && gen === this.generation) {
        // The turn's output is complete and on screen — release the streaming
        // UI (send button back to Send, input live) BEFORE the disk write so a
        // large session doesn't hold the UI in the "generating" state while
        // the JSON is serialized + written. chat.send() still awaits the write
        // below, so doSend's finally (sidebar refresh / queued send) keeps its
        // ordering — only the visual streaming state flips early.
        this.setStreaming(false);
        await this.persistSession(
          finalMessages,
          toolResults,
          thinkingPhases,
          sendSessionId,
          sendWorkspace,
          false,
          undefined,
          taskAnalysisText,
          assistantSegments.map(segment => segment.text),
          turnArtifacts,
          displayUserText,
        );
      }
    } catch (err: any) {
      if (assessmentFlow) {
        if (err?.name === 'AbortError') {
          assessmentFlow.cancel('本轮运行已取消，未把未验证内容标记为完成。');
        } else {
          assessmentFlow.fail(`流程异常：${err?.message || err}`);
        }
      }
      endThinking();
      for (const seg of assistantSegments) {
        seg.el.classList.remove('streaming');
        cancelStreamingRender(seg.el);
      }
      resolvePendingToolRows(toolCallRefresh, pendingRows, pendingByName);
      // Pre-flight failure (the plan gate threw before any engine event): the
      // immediately-rendered user bubble never entered this.messages, so drop
      // it — a visual-only ghost would otherwise linger until session reload.
      // A genuine streaming error always produced assistant segments, so this
      // cleanly distinguishes pre-flight failure from mid-stream failure.
      if (assistantSegments.length === 0 && finalMessages.length === 0 && !interruptedMessages) {
        // 前置检查失败/被停止时不再删除用户消息：它仍是发送过的记录。只有切换会话
        // 才移除（转录将由新会话重建）；同一会话内保留并给出提示。
        removeThinkingCard();
        keepOrDropUserBubble(err?.name === 'AbortError' ? '⏸ 已暂停：你的请求已保留在对话中。' : '本轮处理未完成，你的请求已保留在对话中。');
      }
      if (interruptedMessages && gen === this.generation) {
        await this.persistSession(
          interruptedMessages,
          toolResults,
          thinkingPhases,
          sendSessionId,
          sendWorkspace,
          false,
          undefined,
          taskAnalysisText,
          assistantSegments.map(segment => segment.text),
          turnArtifacts,
          displayUserText,
        );
      } else if (thinkingPhases.length > 0 && gen === this.generation) {
        const partialOutput = assistantSegments.map(segment => segment.text).filter(Boolean).join('\n\n');
        // Same commit semantics as the Interrupted event: the paused request +
        // partial answer enter the live history so a follow-up can continue.
        const interruptedSnapshot: Message[] = limitMessageHistory([
          ...this.messages,
          { role: 'user', content: userText },
          { role: 'assistant', content: partialOutput },
        ]);
        this.messages = interruptedSnapshot;
        this.hasHistory = true;
        await this.persistSession(
          interruptedSnapshot,
          toolResults,
          thinkingPhases,
          sendSessionId,
          sendWorkspace,
          false,
          undefined,
          taskAnalysisText,
          assistantSegments.map(segment => segment.text),
          turnArtifacts,
          displayUserText,
        );
      }
      const lastSeg = assistantSegments.length ? assistantSegments[assistantSegments.length - 1] : null;
      if (err.name === 'AbortError') {
        if (lastSeg && !lastSeg.el.textContent && lastSeg.el.children.length === 0) {
          lastSeg.el.textContent = t('chat.cancelled', '(cancelled)');
        }
      } else if (lastSeg) {
        const rawError = String(err?.message || err);
        const imageError = userImages.length > 0 && /image|vision|multimodal|content[_ -]?type|unsupported|400/i.test(rawError);
        const visibleError = imageError
          ? '当前模型或接口拒绝了图片输入，可能不支持视觉理解。请切换到支持图片的模型后重试；本次不会再通过 web_scrape 查找图片。'
          : rawError;
        lastSeg.el.textContent = t('chat.error', 'Error: {msg}').replace('{msg}', visibleError);
        lastSeg.el.classList.add('error');
      } else {
        // Failure before bubbles were created (e.g. plan review threw) — toast it.
        // Route through the shared toast helper (one module-level timer — an
        // inline setTimeout here could hide a NEWER toast early) and keep the
        // message up for 8s: actionable failures like an invalid API key must
        // not scroll out of sight in 2.5s.
        const rawError = String(err?.message || err);
        const visibleError = userImages.length > 0 && /image|vision|multimodal|content[_ -]?type|unsupported|400/i.test(rawError)
          ? '当前模型或接口拒绝了图片输入，可能不支持视觉理解。请切换到支持图片的模型后重试；本次不会再通过 web_scrape 查找图片。'
          : rawError;
        showToast(t('chat.error', 'Error: {msg}').replace('{msg}', visibleError), 8000);
      }
    } finally {
      if (liveToolOutputFrame !== undefined) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(liveToolOutputFrame);
        else clearTimeout(liveToolOutputFrame);
      }
      liveToolOutputFrame = undefined;
      liveToolOutputQueue.clear();
      // Release the turn-scoped closure (pendingRows, toolResults, chatEl,
      // assistantSegments DOM nodes …) held by the module-level tool output
      // listener; otherwise it keeps the whole last turn alive until the next
      // send (and, after a chat.clear(), detached bubbles stay in memory).
      setToolOutputListener(null);
      // Release the streaming state ONLY if this turn still owns the
      // controller. An unconditional setStreaming(false) here could run AFTER
      // a newer send has already installed its own turn controller + set
      // streaming(true) — the abort is processed asynchronously, so the old
      // turn's finally can land mid-stream of the new turn and flicker the UI
      // back to "not generating". releaseSupersededTurn() is idempotent for
      // the already-released early-return paths.
      const ownsTurn = this.abortController === turnController;
      releaseSupersededTurn();
      // Long-task auto-continue: schedule the next round only when THIS turn
      // still owns the controller (a newer send superseding us cancels the
      // chain) and the round recorded eligible signals. Streaming is already
      // released here and the session persisted, so the fire-time checks are
      // race-free; the scheduler's token guards against any late cancel().
      const pendingAuto = this.pendingAutoContinue;
      this.pendingAutoContinue = null;
      if (ownsTurn && pendingAuto !== null && gen === this.generation) {
        const cfgNow = loadConfig();
        if (cfgNow?.autoContinue === true) {
          const max = cfgNow.autoContinueMaxRounds ?? DEFAULT_AUTO_CONTINUE_MAX_ROUNDS;
          const scheduled = this.autoContinue.schedule(
            pendingAuto,
            max,
            AUTO_CONTINUE_DELAY_MS,
            () => this.fireAutoContinue(),
          );
          // Reflect the chain state on the plan card: a scheduled next round
          // keeps the badge (advanced to the pending round), the chain ending
          // (terminal / budget / stall) clears it.
          if (scheduled) this.activePlanCardHandle?.setAutoContinue(this.autoContinue.roundCount + 1, max);
          else this.activePlanCardHandle?.clearAutoContinue();
        } else {
          // Auto-continue turned off mid-chain — drop the badge.
          this.activePlanCardHandle?.clearAutoContinue();
        }
      } else {
        // No eligible signals / superseded turn: the chain is over.
        this.activePlanCardHandle?.clearAutoContinue();
      }
    }
  }

  clear() {
    this.cancel();
    this.snapshotPort = undefined;
    this.sessionToolAdapter = undefined;
    this.sessionToolAdapterKey = '';
    this.onSnapshotChanged?.(false);
    this.cancelBackgroundPreCompaction();
    // New chat supersedes any in-flight send loop.
    this.generation++;
    this.messages = [];
    this.contextEngine = undefined;
    this.hasHistory = false;
    this.activeComplexPlan = null;
    this.activePlanNumber = 1;
    this.activeTodoNumber = 1;
    this.activePlanStarted = false;
    this.activePlanCardSnapshot = null;
    this.activePlanCardHandle = null;
    this.detachActivePlanProgress();
    this.activePlanProgress = null;
    this.activePlanProjectBuild = false;
    this.fileWriteVersions.clear();
    this.pausePlanCard = null;
    this.pauseAssessmentFlow = null;
    // Invalidate any background pre-compaction from the previous session.
    this.preCompactedMessages = null;
    this.preCompactSourceMessages = null;
    this.preCompactSessionId = '';
    this.preCompactMessageCount = 0;
    this.sessionId = `session_${Date.now()}`;
    // New chat = a fresh session: drop any session-scoped tool approvals.
    this.permissionManager.clearCache();
    // Fresh session → fresh stats view.
    this.sessionStats = loadSessionStats(this.sessionId);
    this.onStatsChanged?.(this.sessionStats);
    // New chat = a fresh session (new sessionId): MCP transports are
    // session-bound, so actively close every stdio subprocess now instead of
    // leaving it running until the next send().
    this.disconnectMcpClient();
    const chatEl = document.getElementById('chat')!;
    chatEl.innerHTML = '';
  }

  cancel() {
    this.abortController?.abort();
    // Stop / Escape take the human back: kill any pending auto-continue too.
    this.autoContinue.cancel();
    this.activePlanCardHandle?.clearAutoContinue();
  }

  /** Cancel a pending auto-continue (user started typing / any other takeover). */
  cancelAutoContinue(): void {
    this.autoContinue.cancel();
    this.activePlanCardHandle?.clearAutoContinue();
  }

  /** Fire the next auto round. Runs from the scheduler timer; re-checks that
   * the chain is still wanted (config on, plan still active) before re-entering
   * send(). No streaming check needed — any user send/Stop cleared the timer. */
  private fireAutoContinue(): void {
    const cfg = loadConfig();
    if (!cfg || cfg.autoContinue !== true) return;
    if (!this.activeComplexPlan || this.pausePlanCard) return;
    // Round/max hint: the scheduler already bumped its counter to this round,
    // so the bubble tells the user how far along the auto chain is — and the
    // plan card shows the same N/M on its live badge.
    const round = this.autoContinue.roundCount;
    const max = cfg.autoContinueMaxRounds ?? DEFAULT_AUTO_CONTINUE_MAX_ROUNDS;
    this.activePlanCardHandle?.setAutoContinue(round, max);
    void this.send('继续', [], `🔁 自动续跑 ${round}/${max}：继续处理计划 ${this.activePlanNumber}`, true);
  }

  private async persistSession(
    messages: Message[],
    toolResults: Map<string, ToolExecMeta>,
    thinkingPhases: Array<{ text: string; assistantIndex: number }>,
    sessionId = this.sessionId,
    workspace = this.workspace,
    planPause = false,
    pauseAssessment?: IntentAssessment,
    taskAnalysisText = '',
    renderedAssistantTexts: string[] = [],
    artifacts: Array<{ path: string }> = [],
    visibleUserText = '',
  ) {
    if (messages.length <= 0) return;
    await this.activePlanProgressPersistence?.flush();
    let assistantIndex = 0;
    let renderedAssistantIndex = 0;
    let analysisAttached = false;
    let planCardAttached = false;
    // A completed plan nulls activeComplexPlan, so
    // the cross-turn cursor alone would leave the finished plan with no
    // persisted state and the chat plan card would not survive a reload.
    // The final card snapshot (complete: true) stands in for the cursor so the
    // completed chat card can be restored; an in-progress plan keeps its cursor.
    const turnPlanState = this.activeComplexPlan
      ? { plan: this.activeComplexPlan, planNumber: this.activePlanNumber, todoNumber: this.activeTodoNumber, started: this.activePlanStarted }
      : this.activePlanCardSnapshot?.complete
        ? { plan: this.activePlanCardSnapshot.plan, planNumber: this.activePlanCardSnapshot.currentPlan, todoNumber: this.activePlanCardSnapshot.currentTodo, started: true, complete: true }
        : null;
    const latestUserIndex = messages.reduce((latest, message, index) => message.role === 'user' ? index : latest, -1);
    const lastAssistantIndex = messages.reduce((latest, message, index) => message.role === 'assistant' ? index : latest, -1);
    const canonicalMessages = messages.map((message, index) => {
      if (message.role !== 'assistant' || message.toolCalls?.length || index <= latestUserIndex) return message;
      const rendered = renderedAssistantTexts[renderedAssistantIndex++];
      return !message.content && rendered ? { ...message, content: rendered } : message;
    });
    const toolCallsById = new Map<string, { toolName: string; args: Record<string, unknown> }>();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const call of message.toolCalls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.function.arguments);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {}
        toolCallsById.set(call.id, { toolName: call.function.name, args });
      }
    }
    const transcriptDrafts: TranscriptDraft[] = canonicalMessages.flatMap((m, index): TranscriptDraft[] => {
      if (m.role === 'system') return [];
      const currentAssistantIndex = m.role === 'assistant' ? assistantIndex++ : -1;
      const phases = currentAssistantIndex >= 0
        ? thinkingPhases.filter(candidate => candidate.assistantIndex === currentAssistantIndex && candidate.text)
        : [];
      const isCurrentTurnAssistant = m.role === 'assistant' && index > latestUserIndex;
      const analysis = isCurrentTurnAssistant && !analysisAttached && taskAnalysisText
        ? (analysisAttached = true, taskAnalysisText)
        : undefined;
      const isPauseMessage = planPause && m.role === 'assistant' && index === messages.length - 1;
      // The plan card lives between the preflight analysis and the engine's
      // reasoning, so persist it on the same (first) assistant entry of this
      // turn that carries the analysis.
      const planCard = isCurrentTurnAssistant && !planCardAttached && this.activePlanCardSnapshot
        ? (planCardAttached = true, this.activePlanCardSnapshot)
        : undefined;
      const storedToolCall = m.toolCallId ? toolCallsById.get(m.toolCallId) : undefined;
      const recordedToolExec = m.role === 'tool' && m.toolCallId
        ? (() => {
            const existing = toolResults.get(m.toolCallId);
            if (existing) {
              return {
                ...existing,
                toolName: existing.toolName || m.toolName || storedToolCall?.toolName || 'tool',
                args: existing.args ?? storedToolCall?.args,
                resultText: existing.resultText ?? (m.content || undefined),
              };
            }
            return {
              toolName: m.toolName || storedToolCall?.toolName || 'tool',
              success: !/^Error:\s/i.test(m.content),
              duration: 0,
              args: storedToolCall?.args,
              resultText: m.content || undefined,
            } satisfies ToolExecMeta;
          })()
        : undefined;
      const planState = index === messages.length - 1 && turnPlanState
        ? turnPlanState
        : m === messages[messages.length - 1] ? null : undefined;
      return [{
        message: m,
        modelMessageIndex: index,
        content: m.role === 'user' && index === latestUserIndex && visibleUserText ? visibleUserText : m.content,
        images: m.images,
        attachments: m.attachments,
        analysis,
        artifacts: m.role === 'assistant' && index === lastAssistantIndex && artifacts.length > 0 ? artifacts : undefined,
        thinkingPhases: phases.length > 0 ? phases : undefined,
        toolExec: recordedToolExec,
        isPlanPause: isPauseMessage || undefined,
        assessment: isPauseMessage ? pauseAssessment : undefined,
        planState,
        planCard,
      }];
    });
    // Merge with the previously saved transcript before writing: in-memory
    // messages never carry stored-only fields (analysis, thinking phases,
    // display snapshot), so a plain rebuild would wipe the preflight analysis
    // and reasoning trace of every earlier turn on the next persist — the
    // "analysis shows live but disappears from history" bug. Load the last
    // saved session and carry those fields over by message position.
    const progressSnapshot = this.activePlanProgress?.getSnapshot()
      ?? (turnPlanState
        ? {
            plan: turnPlanState.plan,
            currentPlan: turnPlanState.complete ? turnPlanState.plan.steps.length + 1 : turnPlanState.planNumber,
            currentTodo: turnPlanState.todoNumber,
            status: turnPlanState.complete ? 'complete' as const : turnPlanState.started ? 'active' as const : 'waiting' as const,
          }
        : null);
    const nextSnapshot = createSessionSnapshot(canonicalMessages, transcriptDrafts, {
      planProgress: progressSnapshot,
      planState: turnPlanState,
    });
    let previousSnapshot: SessionSnapshotV2 | null = null;
    try {
      previousSnapshot = (await loadSession(sessionId))?.snapshot ?? null;
    } catch {
      // No previous session (or storage failure) — nothing to merge.
    }
    await saveSession(sessionId, mergeSessionSnapshotMetadata(previousSnapshot, nextSnapshot), workspace);
  }

  /** Cancel a queued idle pre-compaction pass before a new user turn. */
    private cancelBackgroundPreCompaction(): void {
      this.cancelPreCompaction?.();
      this.cancelPreCompaction = null;
    }

    /**
     * Background context pre-compaction (see the preCompactedMessages field):
     * run ContextEngine.trim — whose LLM summarization is the dominant pre-send
     * cost in long sessions — only during a browser idle slot after a completed
     * turn. The pending slot is cancellable when the user sends again, and the
     * result is cached only while the generation and message state still match.
     */
    private preCompactInBackground(
      systemPrompt: string,
      msgs: Message[],
      gen: number,
      agent: CodingAgent,
      transcriptMessages: Message[] = this.messages,
    ): void {
      const ctx = agent.getHarness().getContextEngine();
      if (!ctx) return;
      this.cancelBackgroundPreCompaction();
      let cancelled = false;
      const run = (): void => {
        this.cancelPreCompaction = null;
        if (cancelled || gen !== this.generation || this.messages !== transcriptMessages || this.streaming) return;
        void (async () => {
          try {
            if (cancelled || gen !== this.generation || this.messages !== transcriptMessages || this.streaming) return;
            // Even an idle callback can be followed immediately by a user
            // input task. Yield once more so cancellation gets a chance to run
            // before ContextEngine.trim begins its synchronous transcript scan.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (cancelled || gen !== this.generation || this.messages !== transcriptMessages || this.streaming) return;
            const priorSummaries = msgs.filter((message) => message.role === 'system' && message.content.startsWith('Earlier conversation summary:'));
            const compactionInput: Message[] = [
              { role: 'system', content: systemPrompt },
              ...priorSummaries,
              ...msgs.filter((message) => message.role !== 'system'),
            ];
            const compaction = await ctx.compact(compactionInput);
            const trimmed = compaction.messages;
            if (gen === this.generation && this.messages === transcriptMessages) {
              if (compaction.overBudget) {
                showToast(t(compaction.oversizedNewestGroup ? 'context.compact.overBudget' : 'context.compact.contextOverBudget'));
              }
              this.preCompactedMessages = trimmed;
              this.preCompactSourceMessages = transcriptMessages;
              this.preCompactSessionId = this.sessionId;
              this.preCompactMessageCount = transcriptMessages.length;
            }
          } catch {
            // Background pre-compaction must never break the session.
          }
        })();
      };
      const browserWindow = typeof window !== 'undefined'
        ? window as unknown as {
            requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
            cancelIdleCallback?: (id: number) => void;
          }
        : undefined;
      if (browserWindow?.requestIdleCallback) {
        const id = browserWindow.requestIdleCallback(run, { timeout: 1500 });
        this.cancelPreCompaction = () => {
          cancelled = true;
          browserWindow.cancelIdleCallback?.(id);
        };
      } else {
        const timer = setTimeout(run, 1000);
        this.cancelPreCompaction = () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }
    }

  private addBubble(role: 'user' | 'assistant', content: string, images: MessageImage[] = []): HTMLDivElement {
    const chatEl = document.getElementById('chat')!;
    const wrapper = document.createElement('div');
    wrapper.className = `bubble-row ${role}`;
    const label = document.createElement('span');
    label.className = 'bubble-label';
    label.textContent = role === 'user' ? 'You' : 'pure';
    wrapper.appendChild(label);
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    // Assistant bubbles start empty: they get markdown-rendered at the
    // `Completed` event (see send()); user bubbles stay as raw escaped text
    // and gain the double-click select-all shortcut.
    if (role === 'user') {
      bubble.textContent = content;
      renderUserImageAttachments(bubble, images);
      bindUserBubbleSelectAll(bubble);
    } else {
      bindAssistantBubbleCopy(bubble);
    }
    wrapper.appendChild(bubble);
    chatEl.appendChild(wrapper);
    return bubble;
  }

  private addStatusBubble(text: string, pending = false, isError = false): HTMLElement {
    const chatEl = document.getElementById('chat')!;
    const wrapper = document.createElement('div');
    wrapper.className = 'bubble-row status';
    if (pending) wrapper.classList.add('pending');
    if (isError) wrapper.classList.add('error');
    const bubble = document.createElement('div');
    bubble.className = 'bubble status';
    if (isError) bubble.classList.add('error');
    bubble.textContent = text;
    linkifyPaths(bubble);
    wrapper.appendChild(bubble);
    chatEl.appendChild(wrapper);
    return bubble;
  }

  // Fallback tool-result status bubble (no live tool row existed for this
  // call): render the tool name highlighted, matching .tool-row-name.
  private addToolStatusBubble(toolName: string, status: string, duration: number) {
    const chatEl = document.getElementById('chat')!;
    const wrapper = document.createElement('div');
    wrapper.className = 'bubble-row status';
    const bubble = document.createElement('div');
    bubble.className = 'bubble status';
    bubble.appendChild(document.createTextNode('🔧 '));
    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = toolName;
    bubble.appendChild(name);
    bubble.appendChild(document.createTextNode(`: ${status} (${duration}ms)`));
    // Same path-linkification as addStatusBubble (tool names are identifiers,
    // but path-shaped text must stay clickable for parity).
    linkifyPaths(bubble);
    wrapper.appendChild(bubble);
    chatEl.appendChild(wrapper);
  }

  private addToolRow(toolName: string, args: Record<string, unknown>, parent: HTMLElement): ToolRowHandle {
    const chatEl = document.getElementById('chat')!;
    const row = createToolRow(toolName, args);
    parent.appendChild(row.el);
    scrollChatToBottomIfPinned(chatEl);
    return row;
  }

  private setStreaming(v: boolean) {
    this.streaming = v;
    this.onStreamingChange?.(v);
  }
}
