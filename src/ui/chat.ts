// src/ui/chat.ts
// v0.6 — Uses CodingAgent/Harness instead of self-built ReAct loop.
// Iterates over EngineEvents stream to update the UI reactively.

import { loadConfig, hasConfiguredKey, customSecretKey, type PureConfig } from './config';
import { defaultModelFor, baseURLFor, isDeepSeekFamily, customProviderFor, customBaseURL, customDefaultModel, isCustomKeyless, providerOverrideFor, promptBudgetForProvider, imageGenEnabled, imageGenModelFor } from '../shared/providers';
import { saveSession, loadLastSession, loadSession, saveSessionStats, loadSessionStats, refreshSessionStatsFromDisk, dedupeFileWrites, upsertFileWrite, limitConversationMessages, mergeSessionSnapshotMetadata, createSessionSnapshot, MAX_PERSISTED_MESSAGES, type TranscriptDraft, type ToolExecMeta, type SessionSnapshotV2, type SessionStats, type PlanCardSnapshot } from './store';
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
import { formatIntentPrompt, parsePlanJsonWithMeta } from '../coding-agent/Planner';
import { sanitizeSkillName } from './skillHub';
import { PermissionManager } from '../coding-agent/PermissionManager';
import { createLLMOnlyVerifier, createDefaultVerifier } from '../coding-agent/Verifier';
import { BUILT_IN_SUBAGENTS } from '../coding-agent/SubagentOrchestrator';
import { requestPermission } from './permission';
import {
  requestPlanReview,
  formatPlanForPrompt,
  formatPlanContinuation,
  formatPlanPauseMessage,
  restorePlanCardProgress,
  createPlanCard,
  updatePlanCard,
  clearPlanCardRefining,
  setPlanPhase,
  updatePlanCardPhase,
  updatePlanCardSubstep,
  completePlanCardSubstep,
  canCompletePlanCardSubsteps,
  completePlanCardSubsteps,
  finalizePlanCard,
  matchPlanPhaseMarker,
  matchPlanProgressMarkers,
  type PlanProgressMarker,
  createQualityGateCard,
  type PlanCardHandle,
} from './plan';
import { TauriToolAdapter, getWebToolDefs, getSysInfoToolDefs, setToolOutputListener, takeGeneratedImages, type ImageGenContext } from './TauriToolAdapter';
import { createAssessmentFlowCard, type AssessmentFlowHandle } from './assessmentFlow';
import { planOverview, setOverviewPositionSession, type PlanOverviewStatus } from './planOverview';
import { attachPlanPauseActions } from './planPauseActions';
import { createRequestReviewCard, formatRequestReviewSection, hasFlaggedReviewItems, type RequestReviewCardHandle, type RequestReviewItem } from './requestReview';
import { OpenAICompatibleAdapter } from '../adapter/openai/OpenAICompatibleAdapter';
import { RustLLMAdapter } from '../adapter/rust/RustLLMAdapter';
import { getApplicationTmpWorkspace, isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { renderMarkdown, scheduleStreamingRender, cancelStreamingRender, stripToolCallXml } from './markdownLoader';
import { renderArtifactCards, type ArtifactItem } from './artifactCards';
import { linkifyPaths, setPathLinkWorkspace } from './pathLink';
import { wireScrollPin, scrollChatToBottomIfPinned, forceScrollToBottom, setScrollPinObservers } from './scrollPin';
import { createToolRow, updateToolRowArgs, finalizeToolRow, markToolRowStopped, appendToolStreamLine, truncateResultLines, isWebSearchLike, MAX_LIVE_STREAM_LINES, type ToolRowHandle } from './toolRow';
import { createThinkingCard, appendThinkingText, finalizeThinkingCard, setThinkingLabel, type ThinkingCardHandle } from './thinkingCard';
import { buildRepairPrompt, buildVerifyCommand, hasRepairableQualityFindings, isVerificationCommand, qualityGateEvidence, qualityGateSummary, runProjectQualityGate, type ProjectQualityGateResult } from './projectQualityGate';
import { buildTaskContract, discoverWorkspace, formatTaskContract, isBareWorkspace, workspaceProfileSummary, type TaskContract, type WorkspaceProfile } from '../shared/delivery';
import { parseResearchResult } from '../shared/research';
import { repairJsonSource } from '../shared/parseRepair';
import { copyTextToClipboard } from '../shared/clipboard';
import { showToast } from '../shared/toast';
import { mergeTranscriptWithTurn } from '../shared/conversation';
import { t } from '../shared/i18n';
import { effectiveProxyUrl } from '../shared/proxy';
import type { MCPClient } from '../harness/mcp/MCPClient';
import type { WorkspaceRestoreResult, WorkspaceSnapshotPort } from '../shared/workspaceSnapshot';
import type {
  LLMAdapter,
  EngineEvent,
  ToolAdapter,
  ToolCall,
  ToolResult,
  ToolDefinition,
  Message,
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

function buildSystemPrompt(hasWorkspace: boolean, temporaryWorkspace = false, config: PureConfig | null = null, toolDefinitions: ToolDefinition[] = [], imageGeneration = false): string {
  return promptAssembler.buildSystemPrompt({
    surface: 'gui',
    capabilities: buildGuiCapabilities(hasWorkspace, temporaryWorkspace, { imageGeneration }),
    imageGeneration,
    toolDefinitions,
    environment: buildEnvironmentContext(config),
    runtimes: buildRuntimesContext(),
    network: buildNetworkContext(),
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
// web_fetch targets are chosen for what actually works). A missing probe
// (browser dev mode, Rust invoke failure) leaves the context empty — the
// sys_info tool still reports both on demand in that case.
let cachedRuntimes = '';
let cachedNetwork = '';
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
      } catch {
        cachedRuntimes = '';
        cachedNetwork = '';
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
      proxyBypassModels: config.proxy?.bypassModels ?? [],
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
// ── Task analysis + plan generation (P1-6 enhancement) ──
// Complex multi-step tasks get a CONCRETE plan from the LLM — and, crucially,
// the model's REASONING about this specific task streams into a thinking card
// first, so the user watches real analysis instead of a pre-fabricated step
// list. The task-specific steps replace the fixed heuristic template (了解需
// 求/制定方案/分步实现) and vary by business and difficulty. The heuristic plan
// from analyzeTask() stays only as a fallback when the streaming analysis fails.
// Total ceiling for one task-analysis stream. DeepSeek-style reasoning models
// take tens of seconds to think through the request before emitting the plan,
// so a tight deadline turns every request into a forced heuristic fallback.
// The per-chunk idle clock below is the real safety valve for stalled streams.
const PLAN_ANALYSIS_TIMEOUT_MS = 60000;

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
/** Idle timeout while streaming a task analysis: as long as the model keeps
 * yielding chunks (even a long reasoning pass), the clock resets; only a
 * genuinely dead connection trips the bail-out before the total ceiling. */
const PLAN_ANALYSIS_IDLE_TIMEOUT_MS = 30000;
const MAX_MESSAGE_HISTORY = MAX_PERSISTED_MESSAGES;

function limitMessageHistory(messages: Message[], max = MAX_MESSAGE_HISTORY): Message[] {
  return limitConversationMessages(messages, max);
}

// Streaming analysis + plan generation: the model FIRST reasons about this
// specific task (business domain, difficulty, what matters) — that reasoning
// streams into the thinking card so the user watches real analysis happen —
// and THEN outputs the task-specific plan as JSON. The plan steps therefore
// vary by business and difficulty (a monitoring dashboard, a refactor, and a
// full-stack app get different step lists), never a fixed template. The
// heuristic plan from analyzeTask() is only a fallback when this call fails.
const TASK_ANALYSIS_PROMPT = `You are a senior engineer thinking through a task before executing it. Think about THIS request, not a generic software task. Write natural, conversational reasoning first in the user's language. Do not use prescribed headings, a fixed number of sections, or a canned sequence. Explain what you understood, what is still unknown, why the scope is easy or difficult, and what you would do next in the order that makes sense for this request. Refer to concrete details from the request. For a Shandong 5G monitoring dashboard, distinguish province-wide city drill-down, live data freshness, data-source availability, alert/diagnosis logic, and whether the workspace is an empty prototype or an existing system. If a missing decision blocks implementation, say so plainly and ask only the smallest useful question at the point where it matters; do not pretend an invented assumption is settled.

First, honestly review the REASONABLENESS of the user's request itself — not your plan. List every notable part of the request (requirements, constraints, tech choices, deadlines, scope) with a verdict: \"reasonable\" (feasible, no hidden cost → execute as asked), \"questionable\" (risky, depends on an unverified premise, or likely not what the user really wants → needs the user's decision), or \"unreasonable\" (infeasible, self-contradictory, wrong tool for the goal, destructive to existing work, or conflicts with the project reality → needs the user's decision). Do not rubber-stamp the request: call out impossible deadlines, wrong-technology choices, contradictory requirements, and scope that would destroy existing work. Do not flag trivial details either — only parts that genuinely need the user's decision. For questionable/unreasonable parts give a concrete suggestion (adjustment or alternative). If every part is fine, output an empty array. Output the machine-readable block before the JSON plan:
<request_review>
[{\"part\":\"one part of the request\",\"verdict\":\"questionable\",\"reason\":\"why it needs a decision\",\"suggestion\":\"what I propose instead\"}]
</request_review>

Then output a JSON array of concrete, ordered steps tailored to THIS task for the application to track. Choose the number and granularity from the work itself; never pad the list to reach a target count. Include testing or meaningful verification when it matters. Use a visible Todo list only when it genuinely clarifies independently verifiable work (todosRequired=true); use false for an atomic step. Do NOT invent file contents or claim that an external data source exists. Write every plan and Todo in plain language the USER understands, in the same language as the user's request.

After the natural reasoning, output a fenced JSON plan block and one intent_assessment JSON block. These machine-readable blocks are application metadata and are not part of the user-facing reasoning:
\`\`\`json
[{"action":"task-specific step","description":"what this step achieves","expectedOutcome":"how success looks","todosRequired":false}]
\`\`\`
<intent_assessment>
{"intent":"build","riskLevel":"medium","reversibility":"partially-reversible","impact":"一句话说明真实影响","recommendation":"一句话说明当前最合适的推进方式","requiresProbe":true,"requiresConfirmation":false}
</intent_assessment>

Rules for the metadata: intent is one of question/research/add/modify/debug/refactor/migrate/delete/build. riskLevel is high when the change deletes or overwrites existing data/files/history or touches production; medium for auth/permission/database/migration/refactor/public-API changes; low for local isolated edits and pure Q&A. reversibility is irreversible for deletion/destruction, hard-to-reverse for migrations, partially-reversible for medium refactors, reversible otherwise. requiresConfirmation MUST be true when riskLevel is high (the GUI blocks writes until the user approves). requiresProbe is true when riskLevel is not low. impact and recommendation are concise and in the user's language. Be honest and conservative: when uncertain, err toward higher risk and probe-first.`;

export interface TaskAnalysisResult {
  /** The model's reasoning about this task (shown in the thinking card). */
  analysis: string;
  plan: Plan | null;
  repaired: boolean;
  /** The model's own intent/risk judgment for the safety gate; null when the
   * model did not provide a parseable assessment (rules layer then decides). */
  llmIntent: IntentAssessment | null;
  /** The model's structured verdict on the reasonableness of the user's
   * request itself; empty when nothing needs a decision (or the model did
   * not provide a parseable review). */
  review: RequestReviewItem[];
}

/** Parse the streamed analysis response into { analysis, plan, repaired }.
 * The model writes prose analysis first, then a fenced JSON plan. Tolerates a
 * missing analysis or a missing fence (bare JSON array) so a non-compliant
 * reply still degrades to the plan parse instead of the heuristic fallback. */
export function parseTaskAnalysisText(text: string, userText: string): TaskAnalysisResult {
  const fence = text.match(/\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`/);
  // Strip the <analysis>…</analysis> wrapper tags the prompt asks for, so the
  // reasoning text shown in the thinking card reads naturally.
  const rawAnalysis = fence ? text.slice(0, fence.index ?? 0) : text.replace(/\[[\s\S]*$/, '');
  const analysis = rawAnalysis
    .replace(/<\/?analysis>/g, '')
    .replace(/<request_review>[\s\S]*?<\/request_review>/g, '')
    .trim();
  const planText = fence ? fence[1].trim() : text;
  const parsed = parsePlanJsonWithMeta(planText);
  return {
    analysis,
    plan: parsed.plan,
    repaired: parsed.repaired,
    llmIntent: parseIntentAssessmentBlock(text),
    review: parseRequestReviewBlock(text),
  };
}

const REVIEW_VERDICTS: ReadonlyArray<RequestReviewItem['verdict']> =
  ['reasonable', 'questionable', 'unreasonable'];

/** Parse the <request_review> JSON block the model emits after its reasoning.
 * Any missing/invalid block degrades to [] — the request then proceeds with
 * no extra gate, so a non-compliant reply can never block execution. Items
 * with an invalid verdict or an empty part are dropped individually. */
export function parseRequestReviewBlock(text: string): RequestReviewItem[] {
  const block = text.match(/<request_review>\s*([\s\S]*?)\s*<\/request_review>/);
  if (!block) return [];
  const raw = block[1].trim();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    try {
      data = JSON.parse(repairJsonSource(raw).source);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(data)) return [];
  const items: RequestReviewItem[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const verdict = (entry as Record<string, unknown>).verdict as RequestReviewItem['verdict'];
    const part = (entry as Record<string, unknown>).part;
    if (!REVIEW_VERDICTS.includes(verdict)) continue;
    if (typeof part !== 'string' || !part.trim()) continue;
    items.push({
      part: part.trim(),
      verdict,
      reason: typeof (entry as Record<string, unknown>).reason === 'string'
        ? (entry as Record<string, unknown>).reason as string
        : '',
      suggestion: typeof (entry as Record<string, unknown>).suggestion === 'string'
        ? (entry as Record<string, unknown>).suggestion as string
        : undefined,
    });
  }
  return items;
}

const INTENT_KEYS: ReadonlyArray<IntentAssessment['intent']> =
  ['question', 'research', 'add', 'modify', 'debug', 'refactor', 'migrate', 'delete', 'build'];
const RISK_KEYS: ReadonlyArray<IntentAssessment['riskLevel']> = ['low', 'medium', 'high'];
const REVERSIBILITY_KEYS: ReadonlyArray<IntentAssessment['reversibility']> =
  ['reversible', 'partially-reversible', 'hard-to-reverse', 'irreversible'];

/** Parse the <intent_assessment> JSON block the model emits after the plan.
 * Any missing/invalid block degrades to null — the rules layer then decides,
 * so a non-compliant reply can never lower the safety baseline. */
export function parseIntentAssessmentBlock(text: string): IntentAssessment | null {
  const block = text.match(/<intent_assessment>\s*([\s\S]*?)\s*<\/intent_assessment>/);
  if (!block) return null;
  const raw = block[1].trim();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    try {
      data = JSON.parse(repairJsonSource(raw).source) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const intent = data.intent as IntentAssessment['intent'];
  const riskLevel = data.riskLevel as IntentAssessment['riskLevel'];
  const reversibility = data.reversibility as IntentAssessment['reversibility'];
  // Any core field outside its enum → reject the whole block (rules fallback).
  if (!INTENT_KEYS.includes(intent) || !RISK_KEYS.includes(riskLevel) || !REVERSIBILITY_KEYS.includes(reversibility)) {
    return null;
  }
  return {
    intent,
    riskLevel,
    reversibility,
    impact: typeof data.impact === 'string' ? data.impact : '',
    recommendation: typeof data.recommendation === 'string' ? data.recommendation : '',
    requiresProbe: data.requiresProbe === true,
    requiresConfirmation: data.requiresConfirmation === true,
  };
}

const RISK_ORDER: Record<IntentAssessment['riskLevel'], number> = { low: 0, medium: 1, high: 2 };
const REVERSIBILITY_ORDER: Record<IntentAssessment['reversibility'], number> = {
  reversible: 0,
  'partially-reversible': 1,
  'hard-to-reverse': 2,
  irreversible: 3,
};

/** Merge the rules-layer heuristic with the LLM's own semantic judgment for the
 * safety card. The model's reading wins on intent/impact/recommendation, but
 * safety flags are conservative: risk and reversibility take the worse of the
 * two, and a probe/confirmation requirement from EITHER side wins. The rules
 * layer therefore only ever raises the bar, never lowers the model's judgment. */
export function mergeIntentAssessments(
  heuristic: IntentAssessment,
  llm: IntentAssessment | null,
): IntentAssessment {
  if (!llm) return heuristic;
  const riskLevel = RISK_ORDER[llm.riskLevel] > RISK_ORDER[heuristic.riskLevel] ? llm.riskLevel : heuristic.riskLevel;
  const reversibility =
    REVERSIBILITY_ORDER[llm.reversibility] > REVERSIBILITY_ORDER[heuristic.reversibility]
      ? llm.reversibility
      : heuristic.reversibility;
  return {
    intent: llm.intent,
    riskLevel,
    reversibility,
    impact: llm.impact || heuristic.impact,
    recommendation: llm.recommendation || heuristic.recommendation,
    // 保守并集 + 推导：合并后的风险等级一旦为 high，无论哪一边漏判，都必须
    // 先探针并等待用户明确确认；非 low 风险至少要求只读探针。
    requiresProbe: heuristic.requiresProbe || llm.requiresProbe || riskLevel !== 'low',
    requiresConfirmation: heuristic.requiresConfirmation || llm.requiresConfirmation || riskLevel === 'high',
  };
}

export async function generateTaskAnalysis(
  llm: LLMAdapter,
  userText: string,
  timeoutMs: number = PLAN_ANALYSIS_TIMEOUT_MS,
  signal?: AbortSignal,
  opts: { context?: string; onThinking?: (delta: string) => void } = {},
): Promise<TaskAnalysisResult> {
  try {
    if (signal?.aborted) return { analysis: '', plan: null, repaired: false, llmIntent: null, review: [] };
    // Ground the analysis+plan in reality: the workspace scan makes steps
    // reference real files.
    const grounding: string[] = [];
    if (opts.context) grounding.push(`The current workspace (use real files to make steps concrete):\n${opts.context}`);
    const messages: Message[] = [
      { role: 'system', content: TASK_ANALYSIS_PROMPT },
      { role: 'user', content: grounding.length ? `${userText}\n\n${grounding.join('\n\n')}` : userText },
    ];
    // Stream so the user sees the model reason about THIS task in real time;
    // each pending iterator read is raced against the remaining budget and the
    // active AbortSignal. A timer that only flips a flag cannot interrupt an
    // async generator waiting on a network response, which used to leave the
    // GUI in streaming state forever.
    //
    // Two streams are collected separately: `content` is the model's final,
    // user-facing output, while `reasoning` carries the thinking chain that
    // DeepSeek/Qwen reasoning models emit as `reasoning_content`. Those models
    // routinely put the whole natural analysis into `reasoning` and leave
    // `content` nearly empty — which used to make the analysis look like it
    // "never happened". The reasoning stream is therefore also surfaced as
    // visible thinking and used as a parse fallback when content comes back
    // empty.
    let contentText = '';
    let reasoningText = '';
    let visibleText = '';
    let visibleSent = 0;
    const linkedController = new AbortController();
    const forwardAbort = (): void => linkedController.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const iterator = llm.stream(messages, [], linkedController.signal)[Symbol.asyncIterator]();
    // Total deadline + idle clock: every chunk resets the idle timer, so a
    // long but alive reasoning stream is never cut off early, while a stalled
    // connection still bails out well before the total ceiling.
    const deadline = Date.now() + timeoutMs;
    let lastActivity = Date.now();
    try {
      while (true) {
        const now = Date.now();
        const totalRemaining = deadline - now;
        const idleRemaining = PLAN_ANALYSIS_IDLE_TIMEOUT_MS - (now - lastActivity);
        const remaining = Math.min(totalRemaining, idleRemaining);
        if (remaining <= 0) {
          throw makeTimeoutError(idleRemaining <= 0 ? 'task analysis stream idle' : 'task analysis timed out');
        }
        const next = await withAbortTimeout(iterator.next(), linkedController.signal, remaining, 'task analysis');
        if (next.done) break;
        lastActivity = Date.now();
        const chunk = next.value;
        if (chunk.type === 'content') {
          contentText += chunk.content;
          visibleText += chunk.content;
        } else if (chunk.type === 'reasoning') {
          reasoningText += chunk.content;
          visibleText += chunk.content;
        } else {
          continue;
        }
        // Keep machine metadata out of the visible thinking trace. The user
        // should see the model's reasoning continuously, not JSON delimiters
        // or an implementation-specific assessment payload.
        const metadataStart = visibleText.search(/```|<intent_assessment>|\[\s*\{/);
        const visible = metadataStart >= 0 ? visibleText.slice(0, metadataStart) : visibleText;
        if (visible.length > visibleSent) {
          opts.onThinking?.(visible.slice(visibleSent));
          visibleSent = visible.length;
        }
      }
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      linkedController.abort();
      void iterator.return?.();
    }
    // `content` wins when it produced a real analysis; reasoning steps in for
    // reasoning-first models. Each field independently picks the first source
    // that yields a usable value, so a plan split across both streams still
    // surfaces instead of forcing the heuristic fallback.
    const contentResult = parseTaskAnalysisText(contentText, userText);
    const reasoningResult = reasoningText.trim() ? parseTaskAnalysisText(reasoningText, userText) : null;
    return {
      analysis: contentResult.analysis || reasoningResult?.analysis || '',
      plan: contentResult.plan ?? reasoningResult?.plan ?? null,
      repaired: contentResult.repaired || reasoningResult?.repaired || false,
      llmIntent: contentResult.llmIntent ?? reasoningResult?.llmIntent ?? null,
      review: contentResult.review ?? reasoningResult?.review ?? [],
    };
  } catch (err) {
    console.warn('[pure] task analysis failed, falling back to heuristic plan:', (err as Error)?.message ?? err);
    return { analysis: '', plan: null, repaired: false, llmIntent: null, review: [] };
  }
}

// 预检不再有固定的“开工前确认几个问题”卡片：关键细节（技术栈/数据来源/平台）由模型在
// 分析阶段识别，作为计划的第一步“先确认关键细节”，执行到那一步时用自然语言提问并等待
// 用户回答（见 TASK_ANALYSIS_PROMPT 与 plan 执行指令）。问题由执行过程自然驱动，
// 而不是在思考前就弹一张预制的卡片。

/** Scan the workspace so plan generation and clarifying questions reference
 * real files instead of guessing. Returns a compact context string, or ''
 * when there is no workspace / the scan fails (callers degrade gracefully). */
async function buildWorkspaceContext(workspace: string, config: PureConfig, signal?: AbortSignal): Promise<string> {
  if (!workspace) return '';
  try {
    const adapter = createToolAdapter(workspace, config);
    const exec = (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
      withAbortTimeout(
        adapter.execute({
          id: `wsctx_${name}_${Date.now()}`,
          index: 0,
          function: { name, arguments: JSON.stringify(args) },
        }, signal),
        signal,
        8_000,
        `workspace ${name}`,
      );
    const listing = await exec('list_files', { path: '.', recursive: false });
    if (!listing.success) return '';
    const parts: string[] = [`Structure of the workspace root:\n${String(listing.result ?? '').slice(0, 800)}`];
    // Key manifests give the planner the real stack (scripts, deps, name).
    const manifests = ['package.json', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'README.md'] as const;
    const reads = await Promise.all(manifests.map((m) => exec('read_file', { path: m })));
    reads.forEach((r, i) => {
      if (r.success && typeof r.result === 'string' && r.result.trim()) {
        parts.push(`${manifests[i]}:\n${r.result.slice(0, 400)}`);
      }
    });
    return parts.join('\n\n').slice(0, 2200);
  } catch {
    return '';
  }
}

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
    proxyBypassModels: config.proxy?.bypassModels ?? [],
  };
}

function createToolAdapter(workspace: string, config: PureConfig, sessionId = ''): ToolAdapter {
  const inner = new TauriToolAdapter(workspace, config.tavilyApiKey, config.serperApiKey, config.city, undefined, sessionId, effectiveProxyUrl(config.proxy, 'tools'), imageGenContextFor(config), config.searxngUrl);
  // A tool is available only when the settings toggle allows it. The caller
  // supplies either the selected user workspace or the session's application
  // temporary workspace, so filesystem tools have a valid root in both modes.
  // generate_image is workspace-independent (it calls the provider's image
  // API), so it stays available in plain-chat mode like the web tools.
  const available = (name: string): boolean =>
    isToolEnabled(name, config) && (!!workspace || isWebTool(name) || name === 'sys_info' || name === 'generate_image');
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
  /** Abort controller for the fire-and-forget LLM verification (P1-1) launched
   *  after a turn completes. Cancelled alongside the turn controller so a new
   *  send / session switch / Stop stops the verifier LLM call (and its token
   *  burn) instead of letting it run to completion. */
  private verifierAbort: AbortController | null = null;
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
  // Generation counter: bumped on every session switch / new chat so an
  // in-flight send() loop notices it has been superseded (see send()).
  private generation = 0;
  // In-transcript pause cards (plan card + assessment card), hoisted from the
  // turn closure so the pause-bubble cancel shortcut can flip them out of the
  // "等待你回复" state. Cleared on continue / cancel / clear.
  private pausePlanCard: PlanCardHandle | null = null;
  private pauseAssessmentFlow: AssessmentFlowHandle | null = null;
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
    // The outline's position memory follows the active session.
    setOverviewPositionSession(this.sessionId);
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

  setSessionId(id: string) {
    this.cancelBackgroundPreCompaction();
    // A different conversation starts without the previous plan's outline.
    planOverview().clear();
    this.sessionId = id;
    // Re-apply this session's remembered outline position.
    setOverviewPositionSession(id);
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
   * branch (no re-planning) and flips the floating outline back to executing.
   * Returns false (and locks nothing) when a turn is already streaming. */
  continuePausedPlan(): boolean {
    if (this.streaming) return false;
    this.pausePlanCard = null;
    this.pauseAssessmentFlow = null;
    void this.send('继续');
    return true;
  }

  /** Abandon a paused plan from the pause-bubble shortcut: clears the plan
   * cursor, drops the floating outline, flips the in-transcript pause cards to
   * a cancelled state, and persists so a reload does not restore the paused
   * state. Returns false (and locks nothing) when there is nothing to cancel
   * or a turn is still streaming. */
  cancelPausedPlan(): boolean {
    if (!this.activeComplexPlan || this.streaming) return false;
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
    planOverview().clear();
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
    const savedPlanState = snapshot.uiState.planState;
    if (savedPlanState) {
      if (savedPlanState.complete) {
        // A completed plan: the cross-turn cursor is gone (activeComplexPlan
        // was nulled on completion), so the next turn plans fresh. Only the
        // floating outline comes back, in its all-done state.
        this.activeComplexPlan = null;
        this.activePlanNumber = 1;
        this.activeTodoNumber = 1;
        this.activePlanStarted = false;
        this.activePlanCardSnapshot = null;
        planOverview().show(savedPlanState.plan, 'complete', savedPlanState.planNumber, savedPlanState.todoNumber, '');
      } else {
        this.activeComplexPlan = savedPlanState.plan;
        this.activePlanNumber = savedPlanState.planNumber;
        this.activeTodoNumber = savedPlanState.todoNumber;
        this.activePlanStarted = savedPlanState.started;
        // Re-show the floating outline for a restored plan: a paused plan
        // (never started) comes back in the "waiting for reply" state, an
        // in-progress one in the executing state with its persisted cursor.
        planOverview().show(
          this.activeComplexPlan,
          this.activePlanStarted ? 'active' : 'waiting',
          this.activePlanNumber,
          this.activeTodoNumber,
          '',
        );
      }
    } else {
      this.activeComplexPlan = null;
      this.activePlanNumber = 1;
      this.activeTodoNumber = 1;
      this.activePlanStarted = false;
      this.activePlanCardSnapshot = null;
    }
    this.hasHistory = this.messages.length > 0;
  }

  /** Restore last session for view-only display. Messages are NOT loaded into CodingAgent. */
  async restoreLastSession(): Promise<SessionSnapshotV2 | null> {
    const saved = await loadLastSession();
    if (!saved) return null;
    this.sessionId = saved.sessionId;
    setOverviewPositionSession(saved.sessionId);
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
      ...(config.proxy?.bypassModels ?? []),
      config.toolBrowser,
      config.toolCmd,
      config.toolGit,
      config.toolFS,
    ]);
    if (this.sessionToolAdapter && this.sessionToolAdapterKey === key) return this.sessionToolAdapter;
    this.sessionToolAdapter = createToolAdapter(workspace, config, sessionId);
    this.sessionToolAdapterKey = key;
    return this.sessionToolAdapter;
  }

  async send(userText: string) {
    const chatEl = document.getElementById('chat')!;
    wireScrollPin(chatEl);
    wireNewContentHint(chatEl);
    const config = loadConfig();
    if (!hasConfiguredKey(config)) return;

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

    // Snapshot the user-selected workspace separately from the effective tool
    // workspace. An empty user workspace uses an application-owned tmp folder,
    // but the session must continue to persist an empty user workspace so the
    // UI still means "no user workspace selected" after reload.
    const sendSessionId = this.sessionId;
    const sendWorkspace = this.workspace;

    this.cancel();
    const gen = ++this.generation;
    // The plan-card snapshot belongs to this turn only; a follow-up simple
    // task must not re-attach a stale card from a previous complex plan.
    this.activePlanCardSnapshot = null;
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
      void this.persistSession(
        [...this.messages, { role: 'user', content: userText }],
        new Map(),
        [],
        sendSessionId,
        sendWorkspace,
      );
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
      // 把被暂停的消息落盘（与运行中断路径一致），避免重载后“输入消失”。
      void this.persistSession(
        [...this.messages, { role: 'user', content: userText }],
        toolResults, thinkingPhases, sendSessionId, sendWorkspace,
      );
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
    const assistantSegments: Array<{ el: HTMLDivElement; text: string }> = [];
    let currentSegment: { el: HTMLDivElement; text: string } | null = null;
    // Files the agent actually wrote this turn (deduped). Folders created for
    // project scaffolding never become result cards. Collected from SUCCESSFUL
    // write/edit/replace tool results only.
    const turnArtifacts: ArtifactItem[] = [];
    const artifactSeen = new Set<string>();
    const addArtifact = (path: string): void => {
      const key = path;
      if (artifactSeen.has(key)) return;
      artifactSeen.add(key);
      turnArtifacts.push({ path });
    };
    let toolRowSinceSegment = false;
    const createSegment = (): { el: HTMLDivElement; text: string } => {
      const el = this.addBubble('assistant', '');
      el.classList.add('streaming');
      const seg = { el, text: '' };
      assistantSegments.push(seg);
      currentSegment = seg;
      return seg;
    };
    // Reuse the current bubble while no tool row has been inserted after it;
    // otherwise (or on the first text) start a fresh bubble at the end of the
    // transcript — i.e. below any tool rows that were just appended.
    const ensureSegment = (): { el: HTMLDivElement; text: string } => {
      if (currentSegment && !toolRowSinceSegment) return currentSegment;
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
    };
    // Drop the live trace on aborted turns (pre-flight cancel / plan gate
    // rejection / fatal error) — a "正在准备…" card must not linger as a
    // ghost when the turn never produced output.
    const removeThinkingCard = (): void => {
      if (thinkingFlushTimer !== undefined) {
        clearTimeout(thinkingFlushTimer);
        thinkingFlushTimer = undefined;
      }
      thinkingPending = '';
      if (thinkingCard) {
        thinkingCard.el.remove();
        thinkingCard = null;
      }
    };
    const endThinking = () => {
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
        cancelStreamingRender(seg.el);
        seg.el.classList.remove('streaming');
      }
    };
    // createThinkingCard() builds the element tree but does NOT attach it —
    // append to the transcript here, right below whatever was last added.
    const openThinkingCard = (): ThinkingCardHandle => {
      const card = createThinkingCard();
      chatEl.appendChild(card.el);
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
        // P1-1 (async verification): the engine's `verifier` stays PURELY
        // rule-based (non-empty-output check — a hard failure there must still
        // trigger an in-engine rewrite). The LLM re-check of the final output
        // no longer blocks the turn: it runs fire-and-forget after Completed
        // (see the Completed handler) and a failed verdict only appends a
        // suggestion bubble instead of rewriting the displayed answer.
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
      const promptTools = effectiveWorkspace
        ? codingAgent.toolRegistry.getTools()
        : [
            ...(config.toolBrowser ? WEB_TOOL_DEFS : []),
            ...SYS_INFO_DEFS,
            ...(imageGen ? [IMAGE_GEN_TOOL_DEF] : []),
          ];
      systemPrompt = buildSystemPrompt(!!effectiveWorkspace, usingTemporaryWorkspace, config, promptTools, imageGen);
      this.contextEngine = codingAgent.getHarness().getContextEngine();

      // LLM-only verifier for the post-Completed async check (P1-1). Created
      // once per send when the Code Review skill is enabled; invoked
      // fire-and-forget so it can never delay the turn-complete UI.
      const llmVerifyVerifier = (config.skills?.['code-review'] ?? true)
        ? createLLMOnlyVerifier(llm)
        : undefined;

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
      const continuingPlan = this.activeComplexPlan !== null && this.hasHistory && !forcedMode;
      const planPauseRequested = this.activeComplexPlan !== null && !this.hasHistory && !forcedMode;
      const workflow = compileRequestWorkflow(userText, {
        forcedMode,
        hasTools: !!effectiveWorkspace,
        continuingPlan,
        planPauseRequested,
      });
      const analysis = workflow.analysis;
      let effectiveIntent: IntentAssessment = analysis.intent;
      if (workflow.userContext.traps) userTraps = workflow.userContext.traps;
      userAssessment = workflow.userContext.assessment;

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
        needsDeliveryGate
        || effectiveIntent.requiresConfirmation
        || forcedMode === 'plan'
        || forcedMode === 'build'
        || (analysis.complexity === 'complex' && !!analysis.plan)
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
      // 诉求合理性分析卡（live-only，随本回合渲染）；存在存疑/不合理项时执行前
      // 暂停，由卡上的决策按钮（或暂停气泡）让用户选择调整/原样执行。
      let reviewCard: RequestReviewCardHandle | null = null;
      let reviewNeedsDecision = false;
      let reviewItems: RequestReviewItem[] = [];
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
      // Smarter behavior: complex multi-step requests first get a REAL
      // analysis from the LLM (generateTaskAnalysis) — the model streams its
      // reasoning about THIS task into a thinking card (business domain,
      // difficulty, risks), then emits task-specific steps that vary by
      // business and difficulty. The heuristic generic template (了解需求/制定
      // 方案/分步实现) is never shown first; it survives only as a clearly
      // marked fallback when the analysis fails or times out. AUTO-DETECTED
      // complex tasks are acknowledged with a human-style intro; project-level
      // builds and high-risk requests additionally require the user to approve
      // the plan on the review card before any write happens（先分析 → 澄清缺失
      // 细节 → 计划 → 确认 → 才开始构建）。Only a plan/build mode the user
      // FORCED keeps the review dialog (an explicit planning flow the user opted into).
      // Phase tracker card: a thinking card opens right after the intro so the
      // user watches real analysis stream in, and the task-specific plan card
      // renders when the LLM analysis lands — no dead gap, and no fake
      // scaffold pretending to be the plan.
      // `as PlanCardHandle | null`: TS control-flow can't see assignments made
      // inside the closures below (showPlanCard / discardPlanCard), so without
      // the widening cast it keeps narrowing the variable to null and the
      // handlers that read planCard.current would see type `never`.
      let planCard: PlanCardHandle | null = null as PlanCardHandle | null;
      // Keep the right-edge floating outline in step with the in-chat card.
      const syncPlanOverview = (status: PlanOverviewStatus = 'active'): void => {
        const overview = planOverview();
        if (!planCard) {
          overview.clear();
          return;
        }
        // Mirror the card itself, not the cross-turn cursor: the cursor is
        // nulled the moment the card advances past its last plan (completion),
        // which used to leave the floating outline stuck on an earlier step
        // even though the card was already all-done. Deriving from the card
        // keeps both in lockstep and flips the outline to "complete" the
        // instant the card finishes, without waiting for the turn-final path.
        const plan = planCard.plan;
        const done = planCard.current > planCard.total;
        const todoNumber = planCard.currentSubstep;
        const todoRows = planCard.substepEls[Math.min(planCard.current, planCard.total) - 1] ?? [];
        const todoLabel = planCard.currentTodosRequired && todoNumber >= 1 && todoNumber <= todoRows.length
          ? todoRows[todoNumber - 1]?.querySelector<HTMLElement>('.plan-progress-substep-action')?.textContent ?? ''
          : '';
        overview.update(plan, done ? 'complete' : status, Math.min(planCard.current, planCard.total), todoNumber, todoLabel);
      };
      const discardPlanCard = (): void => {
        if (!planCard) return;
        clearPlanCardRefining(planCard);
        planCard.el.remove();
        planCard = null;
        this.activePlanCardSnapshot = null;
        planOverview().clear();
      };
      // Analysis is useful for a real build even when no approval is needed.
      // Approval is a separate safety decision, not a consequence of the word
      // “project” or the number of files involved.
      if (shouldRunTaskAnalysis) {
        // Plan review runs when: auto-detected complex task (has a heuristic
        // plan), OR the user forced plan/build mode from the composer. A forced
        // YOLO suppresses review even for complex tasks.
        // 事前决策（是否进入计划分析）：先用规则层判断。真正的风险确认在 LLM 分析
        // 完成后用合并后的 effectiveIntent 重新落定（见下方 merge 之后的赋值）。
        let riskReview = effectiveIntent.requiresConfirmation;
        const wantsPlan = needsDeliveryGate || riskReview || (forcedMode
          ? forcedMode === 'plan' || forcedMode === 'build'
          : analysis.complexity === 'complex' && !!analysis.plan);
        if (wantsPlan) {
          // 检测到的复杂任务：只有一条诚实的模式气泡（说明会先分析再逐步执行），
          // 不再有“我先确认一下我理解的需求”这类未经 LLM 就宣称理解的开场白——
          // 理解与否由 thinking 卡里真实流式的分析来展示。用户强制指定的计划/构建
          // 模式保留原有确认流程。
          // The thinking trace is the introduction for an automatically
          // detected task. Do not prepend a canned narration; an explicit
          // composer mode may still get a small status marker.
          const modeBubble = forcedMode
            ? this.addStatusBubble(t('plan.modeForced', '已按你的选择进入 {mode} 模式，正在生成执行计划…').replace('{mode}', modeLabel(analysis.mode)))
            : null;
          // Upgrade the heuristic plan with an LLM-generated task-specific one;
          // keep the heuristic result when the generation call fails/times out.
          // A forced plan/build on a simple task has no heuristic plan yet —
          // fall back to the generic scaffold (same shape as Planner's) so the
          // review card always has steps to show.
          let planForReview: Plan = analysis.plan ?? {
            steps: [{
              id: '1',
              action: '先建立一个可验证的起点',
              description: '当前分析没有拿到完整的任务计划，先依据工作区和用户目标做最小范围的真实探查，再决定下一步。',
              expectedOutcome: '得到足够证据后再继续，不用通用清单替代任务判断。',
              todosRequired: false,
            }],
            reasoning: '实时计划生成未完成，先从最小证据开始。',
          };
          // 立即渲染当前步骤（启发式骨架，卡头带「完善中…」动画徽标提示 LLM 正在细化步骤），
          // LLM 专属计划就绪后原位升级（徽标消失），避免开场白与计划卡之间出现数秒空白等待。
          // 升级走平滑过渡：旧骨架卡在原地淡出收起，新计划卡插入它原来的位置、淡入滑入，
          // 而不是生硬替换（尊重系统减弱动态设置——此时直接替换、不做动画）。
          const showPlanCard = (plan: Plan, refining = false, fallback = false): void => {
            if (planCard) {
              // Keep one stable, flat progress list in the transcript. Updating
              // its contents in place preserves the user's visual anchor and
              // makes later phase changes visible instead of replacing the
              // only plan card that appeared at the start.
              updatePlanCard(planCard, plan, analysis.mode, refining, fallback);
            } else {
              planCard = createPlanCard(plan, analysis.mode, refining, fallback);
              chatEl.appendChild(planCard.el);
            }
            // Right-edge outline: mirror the (possibly refining) plan card.
            this.activeComplexPlan = plan;
            this.activePlanCardSnapshot = { plan, currentPlan: 1, currentTodo: 1, complete: false };
            syncPlanOverview();
            scrollChatToBottomIfPinned(chatEl);
          };
          // 不再先渲染固定的通用骨架卡：先挂一张思考卡，把 LLM 对这项任务的真实
          // 分析（业务领域、难度、风险）流式展示出来，分析完成后再渲染任务专属
          // 计划卡——步骤随业务与难度变化，而不是固定模板。固定骨架只在 LLM 分析
          // 失败/超时时作为明确标注的兜底。
          // The card was opened before the workspace probe; reuse it so the
          // visible trace remains one continuous piece of feedback.
          const analysisCard = earlyAnalysisCard ?? openThinkingCard();
          setThinkingLabel(analysisCard, '正在分析你的请求…');
          // Freebuff-style interview: scan the workspace so the plan is
          // grounded in real files, then ask 1-3 clarifying questions when the
          // request is ambiguous. Answers constrain BOTH the plan and the run.
          const wsContext = [
            workspaceProfile ? (isBareWorkspace(workspaceProfile) ? '当前工作区为空或尚未建立项目结构。' : workspaceProfileSummary(workspaceProfile)) : '',
            taskContract ? formatTaskContract(taskContract) : '',
            await buildWorkspaceContext(effectiveWorkspace, config, this.abortController?.signal),
          ].filter(Boolean).join('\n\n');
          if (gen !== this.generation || this.abortController?.signal.aborted) {
            assessmentFlow?.cancel('本轮准备工作被中断，未执行任何改动。');
            removeThinkingCard();
            discardPlanCard();
            modeBubble?.remove();
            keepOrDropUserBubble('⏸ 已暂停：你的请求已保留在对话中。');
            return;
          }
          // 流式分析 + 任务专属计划：模型按「我理解的需求 → 难度与复杂度 → 我准备怎么做」
          // 的顺序把思考流进思考卡（用户实时看到它怎么想），再输出任务专属计划。需要确认
          // 的关键细节由模型列为计划第一步，执行时自然提问——没有预制的澄清卡片。
          const llmAnalysis = await generateTaskAnalysis(llm, userText, PLAN_ANALYSIS_TIMEOUT_MS, this.abortController?.signal, {
            context: wsContext,
            onThinking: (delta) => {
              taskAnalysisText += delta;
              appendThinkingText(analysisCard, delta);
            },
          });
          finalizeThinkingCard(analysisCard);
          // The analysis card is complete and stays in the transcript; the
          // engine loop gets its own fresh card below any plan card.
          thinkingCard = null;
          // 实时分析没有返回任何内容时，思考卡不能假装“已经想清楚”：明确标注分析
          // 未完成并说明接下来按通用步骤推进，而不是留一张空卡误导用户（“思考完
          // 成”却什么都没想，正是用户这次反馈的困惑点）。
          if (!llmAnalysis.analysis) {
            if (llmAnalysis.plan) {
              // 任务专属计划其实拿到了，只是缺少自然语言分析文本（推理型模型常把
              // 分析写进 reasoning_content、content 留空）。这时不能宣称“回退到通用
              // 步骤”——计划是真的，只标注“已生成计划”即可。
              setThinkingLabel(analysisCard, t('thinking.planned', '已生成任务计划'));
            } else {
              setThinkingLabel(analysisCard, t('thinking.failed', '分析未完成'));
              appendThinkingText(analysisCard, t('thinking.failedNote', '\n（实时分析未返回内容，已回退到通用步骤；执行中会结合实际情况调整。）'));
            }
          }
          // The user may have switched sessions / started a new chat during the
          // analysis — abandon this turn before showing anything.
          if (gen !== this.generation || this.abortController?.signal.aborted) {
            assessmentFlow?.cancel('本轮准备工作被中断，未执行任何改动。');
            discardPlanCard();
            modeBubble?.remove();
            keepOrDropUserBubble('⏸ 已暂停：你的请求已保留在对话中。');
            return;
          }
          // P0: 模型的分析判断落定评估卡——把规则启发式与 LLM 的语义判断保守合并：
          // 意图/影响/建议以模型为准，风险/可逆性取两者更保守者，确认与探针要求
          // 任一 true 即 true（规则层只会抬高安全要求，不会压低模型判断）。
          effectiveIntent = mergeIntentAssessments(analysis.intent, llmAnalysis.llmIntent);
          // Recompile the request-scoped assessment after semantic analysis so
          // the final user prompt reflects the conservative merged judgment.
          userAssessment = formatIntentPrompt(effectiveIntent);
          // LLM 分析后重算风险确认要求：若模型把风险抬高（规则漏判），确认门必须重新
          // 打开——不能用合并前的旧值决定“要不要向用户确认高风险操作”。
          riskReview = effectiveIntent.requiresConfirmation;
          // 评估卡此刻才出现：thinking 卡已经流式展示过模型对这项任务的真实分析，
          // 卡上的意图/风险节点以合并后的 effectiveIntent 落定，不再先于任何思考弹出。
          maybeShowAssessment();
          // 诉求合理性分析卡：把模型对诉求本身的评审结论展示给用户。合理项直接
          // 执行；存疑/不合理项会让本回合在执行前停下等用户决策（见 approvePlan
          // 与暂停块）——评审结论始终可见，即使不触发暂停。
          if (llmAnalysis.review.length > 0) {
            reviewItems = llmAnalysis.review;
            reviewNeedsDecision = hasFlaggedReviewItems(llmAnalysis.review);
            reviewCard = createRequestReviewCard(llmAnalysis.review);
            chatEl.appendChild(reviewCard.el);
          }
          if (llmAnalysis.plan) {
            planForReview = llmAnalysis.plan;
            // 分析真实完成：意图/风险前置节点随分析落地，计划卡用任务专属步骤渲染。
            showPlanCard(planForReview);
          } else {
            // LLM 分析失败/超时 → 回退启发式骨架，并明确告知这是通用步骤而非专属计划。
            showPlanCard(planForReview, false, true);
            this.addStatusBubble('⚠️ 实时分析未完成，已回退到通用步骤；执行中会按实际情况调整。', false, false);
          }
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
              // 计划卡、评审卡与模式提示属于本次流程，一并清理。
              discardPlanCard();
              reviewCard?.remove();
              reviewCard = null;
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
            // 评审卡发现存疑/不合理项：即使是自动检测的复杂任务也停在执行前，
            // 先让用户对诉求做决策（采纳建议调整 / 仍按原诉求执行）。用户已通过
            // 确认对话框明确批准（上一条分支）时不再二次暂停。
            if (reviewNeedsDecision && !forcedMode) {
              pauseAfterPlanning = true;
              const sendDecision = (text: string): boolean => {
                if (this.streaming) return false;
                reviewCard?.setDecided();
                void this.send(text);
                return true;
              };
              reviewCard?.enableDecisions(
                () => sendDecision('用户决策：请按你刚才给出的建议调整后继续执行。'),
                () => sendDecision('用户决策：我已知晓你的顾虑，仍按原诉求执行。'),
              );
            }
          }
        } else if (continuingPlan && this.activeComplexPlan) {
            userPlan = formatPlanContinuation(this.activeComplexPlan, this.activePlanNumber, this.activeTodoNumber, needsDeliveryGate);
            const restored = createPlanCard(this.activeComplexPlan, analysis.mode, false);
            restorePlanCardProgress(restored, this.activePlanNumber, this.activeTodoNumber);
            planCard = restored;
            this.activePlanCardSnapshot = { plan: this.activeComplexPlan, currentPlan: this.activePlanNumber, currentTodo: this.activeTodoNumber, complete: false };
            chatEl.appendChild(planCard.el);
            this.addStatusBubble(`收到，我们继续处理第 ${this.activePlanNumber} 阶段的第 ${this.activeTodoNumber} 个 Todo，不重新规划。`, false, false);
            // 用户回复即明确“开工”：悬浮大纲卡从「等待回复」切回「正在执行」。
            syncPlanOverview('active');
            scrollChatToBottomIfPinned(chatEl);
          } else if (forcedMode === 'plan' || forcedMode === 'build') {
        // The plan gate needs a real filesystem root (and the Planning skill);
        // without it a forced plan/build would silently do nothing. Surface the
        // mismatch instead of ignoring the user's mode choice.
        if (!needsDeliveryGate) {
          this.addStatusBubble(
            effectiveWorkspace
              ? t('plan.modeDisabled', '🧭 计划/构建模式已被禁用（设置 → Skills → Planning），本次按普通对话继续')
              :              t('plan.modeNoWorkspace', '🧭 计划/构建模式需要先选择工作区，本次按普通对话继续'),
          );
        }
      }
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
  // creation here; the transcript already shows the steps.      // phaseVerifySeen[n] is true when the model ran a real verification command
      // (typecheck/tests/build…) and it succeeded while phase n was active. It is
      // required for project builds, but ordinary complex plans can advance from
      // explicit Todo completion alone.
  const planTrack = { seg: null as { el: HTMLDivElement; text: string } | null, scanLen: 0, consumedMarkers: new Set<string>(), phaseVerifySeen: [] as boolean[], deferredMarkers: new Map<number, Array<Extract<PlanProgressMarker, { kind: 'substep' | 'substepDone' }>>>() };
      let projectQualityResult: ProjectQualityGateResult | null = null;
      if (needsDeliveryGate && !effectiveWorkspace) {
        // 计划已确认但没有可选工作区：结束本轮，评估卡明确收尾而不是停在“执行中”。
        assessmentFlow?.cancel('未选择工作区，计划已确认但本次不执行。');
        return;
      }
      const syncActivePlanCursor = (card: PlanCardHandle): void => {
        if (!this.activeComplexPlan || card.total === 0) return;
        if (card.current > card.total) {
          this.activePlanNumber = card.total;
          this.activeTodoNumber = (card.substepEls[card.total - 1]?.length ?? 0) + 1;
          this.activePlanStarted = true;
          this.activePlanCardSnapshot = { plan: card.plan, currentPlan: this.activePlanNumber, currentTodo: this.activeTodoNumber, complete: true };
          this.activeComplexPlan = null;
          return;
        } else {
          this.activePlanNumber = card.current;
          this.activeTodoNumber = card.currentTodosRequired && card.substepEls[card.current - 1]?.length
            ? Math.max(1, card.currentSubstep)
            : 1;
        }
        this.activePlanStarted = true;
        this.activePlanCardSnapshot = { plan: card.plan, currentPlan: this.activePlanNumber, currentTodo: this.activeTodoNumber, complete: false };
      };
      const trackPlanPhase = (seg: { el: HTMLDivElement; text: string }) => {
        if (!planCard) return;
        const card = planCard;         if (planTrack.seg !== seg) { planTrack.seg = seg; planTrack.scanLen = 0; planTrack.consumedMarkers.clear(); }
        if (planTrack.scanLen >= seg.text.length) return;
        // Overlap window keeps the previous 24 chars in the slice so a marker
        // split across token boundaries ("## 阶段 " + "2/4") is still seen whole.
        const tail = seg.text.slice(Math.max(0, planTrack.scanLen - 24));
        planTrack.scanLen = seg.text.length;         const markers = matchPlanProgressMarkers(tail);
         const finishPlan = (planNumber: number): void => {
          if (planNumber !== card.current) return;
          if (needsDeliveryGate && !planTrack.phaseVerifySeen[planNumber]) {
            card.setActivity(`计划 ${planNumber} 已报告完成，等待真实验证结果…`);
            return;
          }
          const isLastPlan = planNumber >= card.total;
          // Earlier plans keep waiting for granular Todo-done markers (or the
          // next plan's start marker, which force-advances); the LAST plan has
          // no following marker, so the model's explicit completion claim must
          // finish its remaining Todos itself — otherwise the card and the
          // floating outline stay at N-1/N after the work is done.
          if (!isLastPlan && !canCompletePlanCardSubsteps(card)) {
            card.setActivity(`计划 ${planNumber} 仍有 Todo 未完成，暂不进入下一计划…`);
            return;
          }
          completePlanCardSubsteps(card, isLastPlan);
          card.setActivity(isLastPlan
            ? `计划 ${planNumber} 已完成，整个计划收尾中…`
            : `计划 ${planNumber} 已完成，正在准备下一个计划…`);
          updatePlanCardPhase(card, planNumber + 1);
          consumeDeferredSubsteps(planNumber, planNumber + 1);
        };
        const consumeTodoMarker = (marker: Extract<PlanProgressMarker, { kind: 'substep' | 'substepDone' }>): void => {
          const activePlan = card.current;
          const totalTodos = card.substepEls[activePlan - 1]?.length ?? 0;
          const todoLabel = card.substepEls[activePlan - 1]?.[marker.number - 1]
            ?.querySelector<HTMLElement>('.plan-progress-substep-action')?.textContent;
          if (marker.kind === 'substepDone') {
            const wasCurrentTodo = card.currentTodosRequired && marker.number >= 1 && marker.number <= totalTodos && card.currentSubstep === marker.number && card.substepStarted;
            completePlanCardSubstep(card, marker.number);
            if (wasCurrentTodo) {
              card.setActivity(`计划 ${activePlan} 的 Todo ${marker.number} 已完成${card.currentSubstep <= totalTodos ? '，开始下一项…' : '，Todos 已全部完成，等待计划收尾…'}`);
            }
          } else {
            updatePlanCardSubstep(card, marker.number);
            card.setActivity(`正在执行计划 ${activePlan} 的 Todo ${marker.number}${todoLabel ? `：${todoLabel}` : ''}…`);
          }
          if ((!needsDeliveryGate || planTrack.phaseVerifySeen[activePlan]) && canCompletePlanCardSubsteps(card)) {
            finishPlan(activePlan);
          }
          syncActivePlanCursor(card);
        };         let deferredForPhase: number | null = null;
         const tailStart = Math.max(0, planTrack.scanLen - tail.length);
         for (const marker of markers) {
           const markerKey = `${marker.kind}:${marker.number}:${tailStart + marker.index}`;
           if (planTrack.consumedMarkers.has(markerKey)) continue;
           planTrack.consumedMarkers.add(markerKey);
           if (marker.kind === 'phase') {
            const before = card.current;
            updatePlanCardPhase(card, marker.number);
            if (card.current === marker.number) {
              const stepLabel = card.stepEls[marker.number - 1]?.querySelector<HTMLElement>('.plan-progress-step-action')?.textContent;
              card.setActivity(`已开始计划 ${marker.number}${stepLabel ? `：${stepLabel}` : ''}${card.currentTodosRequired ? '，正在执行它的 Todos…' : '，正在执行原子任务…'}`);
              const queued = planTrack.deferredMarkers.get(marker.number) ?? [];
              planTrack.deferredMarkers.delete(marker.number);
              for (const todoMarker of queued) consumeTodoMarker(todoMarker);
              deferredForPhase = null;
            } else if (marker.number > before) {
              // The model explicitly started a later plan: treat that as
              // implicit completion of the current plan's Todos and advance,
              // so the card (and the floating outline mirroring it) follows
              // the build instead of stalling on step 1 whenever the model
              // reports plan-level progress without granular Todo-done lines.
              // Project builds still wait for the finished phase's real
              // verification evidence before moving on.
              if (needsDeliveryGate && !planTrack.phaseVerifySeen[before]) {
                card.setActivity(`计划 ${before} 已报告完成，等待真实验证结果…`);
                deferredForPhase = marker.number;
              } else {
                const rows = card.substepEls[before - 1] ?? [];
                rows.forEach((row) => {
                  row.classList.remove('active', 'pending');
                  row.classList.add('done');
                  const check = row.querySelector<HTMLElement>('.plan-progress-substep-check');
                  if (check) check.textContent = '✓';
                });
                if (card.currentTodosRequired && rows.length > 0) {
                  card.substepStarted = true;
                  card.currentSubstep = rows.length + 1;
                }
                // Jump straight to the reported plan instead of one step per
                // marker: updatePlanCardPhase only advances by exactly one, so
                // a model that reports "## 计划 3：" while the card is on plan
                // 1 would otherwise leave the card (and the floating outline
                // mirroring it) stuck on the old step while the transcript
                // already shows plan 3 work. Everything in between is
                // implicitly done. total + 1 (beyond the list) completes.
                setPlanPhase(card, Math.max(before + 1, Math.min(marker.number, card.total + 1)));
                if (card.current === marker.number) {
                  const stepLabel = card.stepEls[marker.number - 1]?.querySelector<HTMLElement>('.plan-progress-step-action')?.textContent;
                  card.setActivity(`已开始计划 ${marker.number}${stepLabel ? `：${stepLabel}` : ''}${card.currentTodosRequired ? '，正在执行它的 Todos…' : '，正在执行原子任务…'}`);
                  const queued = planTrack.deferredMarkers.get(marker.number) ?? [];
                  planTrack.deferredMarkers.delete(marker.number);
                  for (const todoMarker of queued) consumeTodoMarker(todoMarker);
                  deferredForPhase = null;
                } else {
                  deferredForPhase = marker.number;
                }
              }
            }
          } else if (marker.kind === 'phaseDone') {
            finishPlan(marker.number);
            deferredForPhase = null;
          } else if (deferredForPhase !== null) {
            const queued = planTrack.deferredMarkers.get(deferredForPhase) ?? [];
            queued.push(marker);
            planTrack.deferredMarkers.set(deferredForPhase, queued);
          } else {
            consumeTodoMarker(marker);
          }
        }
        consumeDeferredSubsteps(planCard.current, planCard.current + 1);
        syncActivePlanCursor(planCard);
        syncPlanOverview();
      };
      const consumeDeferredSubsteps = (finishedPlan: number, targetPlan: number): void => {
        if (!planCard) return;
        const queued = planTrack.deferredMarkers.get(targetPlan);
        if (!queued || (needsDeliveryGate && !planTrack.phaseVerifySeen[finishedPlan]) || planCard.current !== finishedPlan || !canCompletePlanCardSubsteps(planCard)) return;
        completePlanCardSubsteps(planCard);
        updatePlanCardPhase(planCard, targetPlan);
        if (planCard.current !== targetPlan) return;
        planTrack.deferredMarkers.delete(targetPlan);
        planCard.setActivity(`计划 ${finishedPlan} 已完成${needsDeliveryGate ? '并验证' : ''}，正在执行计划 ${targetPlan}…`);
        for (const marker of queued) {
          const todo = planCard.substepEls[targetPlan - 1]?.[marker.number - 1]
            ?.querySelector<HTMLElement>('.plan-progress-substep-action')?.textContent;
          if (marker.kind === 'substepDone') completePlanCardSubstep(planCard, marker.number);
          else updatePlanCardSubstep(planCard, marker.number);
          planCard.setActivity(`正在执行计划 ${targetPlan} 的 Todo ${marker.number}${todo ? `：${todo}` : ''}…`);
        }
      };
      // Phase-end verification backstop (Freebuff-style per-step verify): the
      // model is told to verify each phase itself, but when it advances anyway
      // without evidence, we run the stack's standard check once (debounced so
      // an immediately-following model tool call wins). Failures surface here;
      // the final delivery gate remains the hard block.
      let phaseBackstopTimer: number | undefined;
      const schedulePhaseBackstop = (finishedPhase: number): void => {
        // Read-only verification commands only run under auto permission mode —
        // in confirm mode silently executing commands would contradict the
        // user's explicit choice (the final quality gate still prompts and
        // blocks delivery there).
        if (!needsDeliveryGate || !effectiveWorkspace || !config.toolCmd || config.permissionMode !== 'auto') return;
        if (phaseBackstopTimer !== undefined) return; // one watchdog at a time
        phaseBackstopTimer = window.setTimeout(() => {
          phaseBackstopTimer = undefined;
          if (gen !== this.generation || this.abortController?.signal.aborted || !planCard) return;
          // The model may have run its own verification during the debounce.
          if (planTrack.phaseVerifySeen[finishedPhase]) return;
          // Skip if the model's own verification command is still running —
          // avoid two concurrent test/typecheck runs on the same workspace.
          for (const entry of pendingRows.values()) {
            if (entry.toolName === 'execute_command' &&
                isVerificationCommand(String(entry.args?.command ?? '')) &&
                entry.row.details.classList.contains('pending')) {
              return;
            }
          }
          void (async () => {
            try {
              const adapter = createToolAdapter(effectiveWorkspace, config);
              const res = await adapter.execute({
                id: `phase_verify_${finishedPhase}_${Date.now()}`,
                index: 0,
                function: { name: 'execute_command', arguments: JSON.stringify({ command: buildVerifyCommand() }) },
              }, this.abortController?.signal);
              if (gen !== this.generation || this.abortController?.signal.aborted) return;
              const out = String(res.result ?? '');
              const ok = res.success && !out.includes('[verify-unavailable]') && !out.includes('[verify-not-applicable]');
              this.addStatusBubble(
                ok
                  ? `✅ 阶段 ${finishedPhase} 自动验证通过`
                  : `⛔ 阶段 ${finishedPhase} 自动验证未通过，最终交付检查将阻止交付`,
                !ok, !ok,
              );
              scrollChatToBottomIfPinned(chatEl);
            } catch {
              // The backstop must never break the running turn.
            }
          })();
        }, 1400);
      };
      const turnSignal = this.abortController.signal;
      const runQualityRepair = async (
        messages: Message[],
        failedGate: ProjectQualityGateResult,
      ): Promise<{ completed: boolean; messages: Message[]; output: string }> => {
        const repairPrompt = buildRepairPrompt(failedGate);
        const repairCommandGuard = (command: string): string | null => isGitMutationCommand(command)
          ? '修复阶段禁止修改 Git 仓库状态（包括 git -C、shell 包装形式）；请只修复质量门禁报告的代码问题。'
          : null;
        this.addStatusBubble('🛠️ 修复阶段：agent 正在根据真实检查结果修复并重新验证…', true);
        const repairSegment = createSegment();
        const repairEvents = codingAgent.continueTurn(systemPrompt, messages, repairPrompt, turnSignal);
        codingAgent.toolRegistry.setCommandGuard(repairCommandGuard);
        let output = '';
        let latestMessages = messages;
        let repairToolCount = 0;
        try {
          for await (const repairEvent of repairEvents) {
            if (gen !== this.generation || turnSignal.aborted) return { completed: false, messages: latestMessages, output };
          if (repairEvent.type === 'TokenDelta' && !repairEvent.payload.isToolCall && repairEvent.payload.content) {
            output += repairEvent.payload.content;
            repairSegment.text = output;
            if (streamingRenderEnabled) {
              scheduleStreamingRender(output, repairSegment.el, () => scrollChatToBottomIfPinned(chatEl));
            } else {
              repairSegment.el.textContent = output;
            }
          } else if (repairEvent.type === 'ToolResult') {
            repairToolCount++;
            const ok = repairEvent.payload.result.success;
            toolResults.set(repairEvent.payload.toolCallId, {
              toolName: repairEvent.payload.toolName,
              success: ok,
              duration: repairEvent.payload.duration,
              resultText: typeof repairEvent.payload.result.result === 'string' ? repairEvent.payload.result.result.slice(0, 800) : repairEvent.payload.result.error,
            });
            this.recordToolActivity(repairEvent.payload.toolName, undefined, ok);
            this.addStatusBubble(`${ok ? '🔧✅' : '🔧⛔'} 修复工具 ${repairEvent.payload.toolName}：${ok ? '已完成' : repairEvent.payload.result.error ?? '失败'}`, !ok, !ok);
            scrollChatToBottomIfPinned(chatEl);
          } else if (repairEvent.type === 'Completed') {
            latestMessages = repairEvent.payload.messages ?? latestMessages;
            if (!output && repairEvent.payload.finalOutput) {
              output = repairEvent.payload.finalOutput;
              repairSegment.text = output;
            }
            return { completed: !repairEvent.payload.interrupted, messages: latestMessages, output };
          } else if (repairEvent.type === 'Error' || repairEvent.type === 'Interrupted') {
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
        // 评审摘要并入暂停消息：任何后续回复（决策按钮或直接打字）都能看到
        // 评审结论与建议——评审卡本身是 live-only，不随会话恢复。
        const pauseMessage = formatPlanPauseMessage(this.activeComplexPlan)
          + (reviewNeedsDecision ? formatRequestReviewSection(reviewItems) : '');
        const pauseSnapshot: Message[] = [
          ...this.messages,
          { role: 'user', content: userText },
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
        planCard?.setWaiting(1, firstLabel);
        syncPlanOverview('waiting');
        // 一个脉冲状态气泡放在最后：明确告诉用户“一切就绪，等你回复开工”，
        // 避免输入框恢复后看起来像流程悄悄停止了。评审待决策时文案指向评审卡。
        this.addStatusBubble(reviewNeedsDecision
          ? '⏸ 你的诉求中有需要决策的部分：请在上方评审卡选择「采纳建议调整后继续」或「仍按原诉求执行」，也可以直接回复你的决定。'
          : `⏸ 已暂停在这里等你：直接回复即可开始第 1 项「${firstLabel}」。`, true, false);
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
        environment: buildEnvironmentContext(config),
        runtimes: buildRuntimesContext(),
        network: buildNetworkContext(),
        skills: [...(config.hubSkills ?? []), ...appSkills],
        mode: analysis.mode,
        budget: promptBudgetForProvider(config.customProviders, config.provider, config.model),
      }, userText, {
        traps: userTraps,
        buildProtocol: userBuildProtocol,
        plan: userPlan,
        contract: taskContract ? formatTaskContract(taskContract) : undefined,
        assessment: userAssessment,
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
      // floating outline must be in the executing state, never stale-waiting.
      // When the turn has NO plan card (simple task, forced mode abandoning
      // the plan, or a follow-up after the previous plan finished), clear the
      // outline so the previous task's list cannot keep floating over
      // unrelated work — the outline mirrors the CURRENT turn only.
      syncPlanOverview();
      const events = this.hasHistory
        ? codingAgent.continueTurn(systemPrompt, historyMessages, userTurn, turnSignal)
        : codingAgent.run(systemPrompt, userTurn, turnSignal);
      for await (const event of events) {

        // Session switched mid-stream (sidebar click / new chat): stop writing
        // into the new transcript immediately. The engine is aborted via
        // cancel() (main.ts loadAndDisplaySession), so no events remain — this
        // guard also covers slow-abort cases where a straggler still yields.
        if (gen !== this.generation) break;
        switch (event.type) {
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

          case 'TokenDelta': {
            if (!event.payload.isToolCall) {
              const delta = event.payload.content;
              if (delta) {
                // First visible answer token closes the thinking phase.
                endThinking();
                const seg = ensureSegment();
                seg.text += delta;
                // Scan newly-appended text for `阶段 n/m` plan markers so the
                // approved-plan phase card advances as the run progresses.
                trackPlanPhase(seg);
                // Strip leaked <tool_calls> XML before it ever reaches the DOM.
                const text = stripToolCallXml(seg.text);
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
              }
              scrollChatToBottomIfPinned(chatEl);
            } else {
              // ── Tool call delta → append/update inline tool row ──
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
            // Reasoning can resume after tool rows (each LLM iteration), so a
            // fresh card opens below whatever was appended since the last one.
            if (!thinkingCard) thinkingCard = openThinkingCard();
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
            scrollChatToBottomIfPinned(chatEl);
            break;
          }

          case 'ToolResult': {
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
                const finishedPhase = planCard.current;
                if (!planTrack.phaseVerifySeen[finishedPhase]) {
                  planTrack.phaseVerifySeen[finishedPhase] = true;
                  if (canCompletePlanCardSubsteps(planCard)) {
                    completePlanCardSubsteps(planCard);
                    planCard.setActivity(`计划 ${finishedPhase} 的子步骤和验证都已完成，正在准备下一个计划…`);
                    updatePlanCardPhase(planCard, finishedPhase + 1);
                  } else {
                    planCard.setActivity(`计划 ${finishedPhase} 的验证已通过，等待剩余子步骤完成后再进入下一个计划…`);
                  }
                  consumeDeferredSubsteps(finishedPhase, finishedPhase + 1);
                  syncActivePlanCursor(planCard);
                  syncPlanOverview();
                }
              } else if (event.payload.result.success) {
                planCard.setActivity(`已完成 ${event.payload.toolName}，正在继续处理当前计划…`);
              } else {
                planCard.setActivity(`${event.payload.toolName} 未完成：${event.payload.result.error ?? '请查看工具输出'}`);
              }
              syncActivePlanCursor(planCard);
              syncPlanOverview();
            }
            this.recordToolActivity(
              toolName,
              resultArgs,
              event.payload.result.success,
            );
            // Collect written artifacts for the end-of-turn file cards: only
            // successful writes count (a failed write_file created nothing).
            if (event.payload.result.success && resultArgs) {
              if (toolName === 'write_file' || toolName === 'edit_file') {
                if (typeof resultArgs.path === 'string' && resultArgs.path.trim()) addArtifact(resultArgs.path);
              } else if (toolName === 'replace_files' && Array.isArray(resultArgs.files)) {
                for (const f of resultArgs.files) {
                  if (typeof f === 'string' && f.trim()) addArtifact(f);
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
            break;
          }

          case 'Error':
            if (event.payload.recoverable) {
              assessmentFlow?.setPhase('verify', `验证反馈：${event.payload.message}，正在调整方案…`);
            } else {
              assessmentFlow?.fail(`流程未完成：${event.payload.message}`);
            }
            // Error events (VERIFY_FAILED, LLM_STREAM_ERROR, …). Recoverable
            // ones (e.g. VERIFY_FAILED → the engine loops back to THINK with a
            // reflection hint) are an INTERNAL retry, not a user-facing failure
            // — render them as a neutral pulsing "correcting output" notice so
            // the transcript doesn't scream ERROR while the agent is simply
            // iterating. Unrecoverable errors (LLM_STREAM_ERROR, policy stop)
            // keep the full-width danger styling. Either way the engine may
            // not yield Completed/Interrupted, so close the thinking card here.
            endThinking();
            const recoverable = event.payload.recoverable === true;
            this.addStatusBubble(
              recoverable
                ? `↻ ${event.payload.code}: ${event.payload.message}`
                : `⚠️ ${event.payload.code}: ${event.payload.message}`,
              recoverable,   // pending: accent-pulse neutral notice
              !recoverable,  // isError: danger-styled bubble
            );
            scrollChatToBottomIfPinned(chatEl);
            break;

          case 'Completed': {
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
            let completionMessages = event.payload.messages ?? this.messages;              let qualityRepairOutput = '';
              let qualityRepairRan = false;
              let qualityRepairRounds = 0;
              const qualityRepairIssues: string[] = [];
              const MAX_QUALITY_REPAIR_ROUNDS = 3;
            if (needsDeliveryGate && hasToolWork && !event.payload.interrupted && gen === this.generation) {
              // Keep the turn visibly interruptible while review/audit/tests run.
              // The stop button and Escape both route to this same AbortSignal.
              // The verification steps render as a live checklist card (review →
              // audit → verify) so the user sees what will be tested/audited and
              // watches each step get checked off as it completes.
              const gateCard = createQualityGateCard();
              chatEl.appendChild(gateCard.el);
              const runGate = async (): Promise<ProjectQualityGateResult> => runProjectQualityGate(codingAgent.toolRegistry, {
                profile: workspaceProfile,
                signal: turnSignal,
                onPhase: (phase, status, summary) => {
                  if (gen !== this.generation || this.abortController?.signal.aborted) return;
                  gateCard.set(phase, status, summary);
                  scrollChatToBottomIfPinned(chatEl);
                },
                onActivity: (phase, message) => {
                  if (gen !== this.generation || this.abortController?.signal.aborted) return;
                  gateCard.setActivity(message);
                  scrollChatToBottomIfPinned(chatEl);
                },
                onCheck: (check) => {
                  if (gen !== this.generation || this.abortController?.signal.aborted) return;
                  gateCard.setEvidence(check);
                  scrollChatToBottomIfPinned(chatEl);
                },
              });
              let gateOutcome: 'passed' | 'failed' | 'cancelled' = 'cancelled';
              try {
                projectQualityResult = await runGate();
                gateOutcome = turnSignal.aborted || gen !== this.generation
                  ? 'cancelled'
                  : projectQualityResult.passed ? 'passed' : 'failed';
              } finally {
                gateCard.dispose(gateOutcome);
              }
              if (gen !== this.generation || this.abortController?.signal.aborted) return;
              while (
                !projectQualityResult.passed &&
                !turnSignal.aborted &&
                gen === this.generation &&
                qualityRepairRounds < MAX_QUALITY_REPAIR_ROUNDS &&
                hasRepairableQualityFindings(projectQualityResult)
              ) {
                qualityRepairRounds++;
                const round = qualityRepairRounds;
                const issueSummary = qualityGateSummary(projectQualityResult);
                qualityRepairIssues.push(`第 ${round} 轮发现：${issueSummary}`);
                this.addStatusBubble(`🔎 第 ${round}/${MAX_QUALITY_REPAIR_ROUNDS} 轮交付检查未通过：${issueSummary}`, true, true);
                this.addStatusBubble(`🛠️ 现在先修复第 ${round} 轮列出的具体问题，修复后重新测试和审计。`, true);
                const repair = await runQualityRepair(completionMessages, projectQualityResult);
                qualityRepairRan = qualityRepairRan || repair.completed;
                completionMessages = repair.messages;
                qualityRepairOutput = repair.output;
                if (gen !== this.generation || this.abortController?.signal.aborted) return;
                if (!repair.completed) {
                  qualityRepairIssues.push(`第 ${round} 轮修复未完成：修复 agent 未返回可继续验证的完成结果。`);
                  this.addStatusBubble(`⚠️ 第 ${round} 轮修复没有完成，仍先重新测试和审计当前工作区；未达到三轮前不会让人工介入。`, true, true);
                } else {
                  this.addStatusBubble(`🔁 第 ${round} 轮修复完成，重新执行全部质量门禁（测试、审计、代码审查）…`, true);
                }
                // Every round closes with a real re-check, even when the repair
                // agent stopped early. The next round must use fresh evidence,
                // never the previous gate result.
                gateCard.reset();
                let retryGateOutcome: 'passed' | 'failed' | 'cancelled' = 'cancelled';
                try {
                  projectQualityResult = await runGate();
                  retryGateOutcome = turnSignal.aborted || gen !== this.generation
                    ? 'cancelled'
                    : projectQualityResult.passed ? 'passed' : 'failed';
                } finally {
                  gateCard.dispose(retryGateOutcome);
                }
                if (gen !== this.generation || this.abortController?.signal.aborted) return;
              }
              if (!projectQualityResult.passed && qualityRepairRounds >= MAX_QUALITY_REPAIR_ROUNDS && hasRepairableQualityFindings(projectQualityResult)) {
                qualityRepairIssues.push(`第 ${MAX_QUALITY_REPAIR_ROUNDS} 轮后仍未通过：${qualityGateSummary(projectQualityResult)}`);
                this.addStatusBubble(`⚠️ 已自动完成 ${MAX_QUALITY_REPAIR_ROUNDS} 轮修复与复查，仍有明确问题未解决，建议人工介入。\n${qualityRepairIssues.join('\n')}`, false, true);
              }
              if (gen !== this.generation) return;
              if (!projectQualityResult.passed && !hasRepairableQualityFindings(projectQualityResult)) {
                this.addStatusBubble('ℹ️ 检查未通过，但原因属于审计工具、网络、权限或验证环境限制，暂不启动自动修复；请先处理对应环境问题后重新检查。', true);
              }
              this.addStatusBubble(qualityGateEvidence(projectQualityResult, qualityRepairRan, qualityRepairRounds, qualityRepairIssues), !projectQualityResult.passed, !projectQualityResult.passed);
              if (!projectQualityResult.passed) {
                this.addStatusBubble(`⛔ 项目暂不交付：${qualityGateSummary(projectQualityResult)}`, false, true);
              } else {
                this.addStatusBubble(`✅ 交付检查完成：${qualityGateSummary(projectQualityResult)}`, false, false);
              }
            }
            if (projectQualityResult && completionMessages && gen === this.generation) {
              completionMessages = [...completionMessages, { role: 'assistant', content: qualityGateEvidence(projectQualityResult, qualityRepairRan, qualityRepairRounds, qualityRepairIssues) }];
            }
            const qualityPassed = !needsDeliveryGate || (projectQualityResult?.passed === true && gen === this.generation);
            // 计划完成的收尾不能只依赖模型的 `## 计划 n 已完成` 标记：模型漏发时
            // 大纲会永远停在第一步。只要回合正常结束、本轮真实执行过工具（与上方
            // hasToolWork 同一约定：提问/确认轮没有 tool 消息）、末句不是提问、且
            // 没有显式暂停，就按完成收尾——标记仍负责执行中的逐步推进。
            // 交付门禁的结果不参与收尾判定：步骤确实执行完了，计划卡与漂浮大纲卡
            // 就该推进到完成态（否则门禁一旦未通过，大纲会永远停在最后一步，和对话
            // 窗口内已经完成的步骤不一致）；门禁是否通过单独用气泡展示。
            const finalAnswer = String(event.payload.finalOutput ?? '').trim();
            const turnAsksForInput = finalAnswer.length > 0 && /[?？]\s*$/.test(finalAnswer);
            const planFinished = planCard && hasToolWork && !event.payload.interrupted
              && !turnAsksForInput && gen === this.generation && !this.pausePlanCard;
            // A final turn often contains NO tool calls at all (pure summary
            // after the last plan's work, or a plain user ack after the model
            // asked a closing question). If the card already reached the last
            // plan, that work finished in an earlier turn — only the finalize
            // step remained. Without this the card and the floating outline
            // stay at N-1/N forever whenever the last turn ran no tools, which
            // is exactly the "进度和浮动窗口不同步" the UI kept showing.
            const turnText = finalAnswer || assistantSegments.map((segment) => segment.text).join('').trim();
            const planSummarized = planCard && !hasToolWork && !event.payload.interrupted
              && !turnAsksForInput && gen === this.generation && !this.pausePlanCard
              && planCard.current === planCard.total && turnText.length > 0;
            if ((planFinished || planSummarized) && planCard) {
              finalizePlanCard(planCard);
              if (this.activeComplexPlan) syncActivePlanCursor(planCard);
              planCard.setActivity(qualityPassed
                ? '计划中的所有步骤已完成，交付检查也已结束。'
                : '计划中的所有步骤已完成，但交付检查未通过，项目暂不交付。');
              planOverview().setStatus('complete');
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

            // P1-1 (async verification): the LLM re-check of the answer runs
            // AFTER the stream — fire-and-forget so the UI flips back to Send
            // immediately (setStreaming(false) below is not delayed by an LLM
            // round-trip). A failed verdict does NOT rewrite the answer the
            // user just read; it only appends a neutral suggestion bubble.
            // Skipped on interrupted turns (user Stop) and stale generations.
            const qualityEvidence = projectQualityResult ? qualityGateEvidence(projectQualityResult, qualityRepairRan, qualityRepairRounds, qualityRepairIssues) : '';
            const verifyOutput = [event.payload.finalOutput, qualityRepairOutput, qualityEvidence, assistantSegments.map(s => s.text).filter(Boolean).join('\n\n')]
              .filter(Boolean)
              .join('\n\n');
            if (llmVerifyVerifier && verifyOutput && !event.payload.interrupted && gen === this.generation) {
              const verifyCtx = completionMessages ?? this.messages;
              // Only append the suggestion while the transcript is still at the
              // completed answer: if the user has already sent a follow-up, a
              // late-arriving bubble would land out of chronological order.
              const msgCountAtComplete = this.messages.length;
              void (async () => {
                // A dedicated controller lets cancel() interrupt the verifier's
                // LLM call (new send / session switch / Stop) instead of
                // burning tokens to completion — the turn controller is already
                // released by the time this async check runs.
                const verifierAbort = new AbortController();
                this.verifierAbort = verifierAbort;
                try {
                  const verdict = await llmVerifyVerifier.evaluate({ output: verifyOutput, context: verifyCtx, signal: verifierAbort.signal });
                  if (this.verifierAbort === verifierAbort) this.verifierAbort = null;
                  if (!verdict.passed && gen === this.generation && this.messages.length <= msgCountAtComplete) {
                    this.addStatusBubble(`🔎 验证建议: ${verdict.feedback ?? ''}`, true);
                    scrollChatToBottomIfPinned(chatEl);
                  }
                } catch {
                  // A broken verifier call must never break the session.
                  if (this.verifierAbort === verifierAbort) this.verifierAbort = null;
                }
              })();
            }
            // Smart artifact display: files the agent generated this turn become
            // clickable cards after the final answer — one card per artifact when
            // few (open with default app / reveal in file manager), collapsing to
            // a single project-directory card when many. Skipped on stale
            // generations (user switched sessions while the turn was streaming).
            if (gen === this.generation && (!needsDeliveryGate || projectQualityResult?.passed === true) && turnArtifacts.length > 0) {
              const artifactRow = document.createElement('div');
              artifactRow.className = 'bubble-row artifact-row';
              chatEl.appendChild(artifactRow);
              renderArtifactCards(artifactRow, turnArtifacts, effectiveWorkspace, { userRequest: userText });
              scrollChatToBottomIfPinned(chatEl);
            }
            if (assessmentFlow && !event.payload.interrupted && (!needsDeliveryGate || (hasToolWork && projectQualityResult?.passed === true))) {
              assessmentFlow.complete('评估、执行与验证已完成，结果满足当前交付条件。');
            } else if (assessmentFlow && event.payload.interrupted) {
              assessmentFlow.cancel('运行已中断，已保留当前进度，未把未验证内容标记为完成。');
            } else if (assessmentFlow && needsDeliveryGate && projectQualityResult && !projectQualityResult.passed) {
              assessmentFlow.fail('交付验证未通过，结果已保留，等待修复或进一步确认。');
            } else if (assessmentFlow && needsDeliveryGate && !hasToolWork && !event.payload.interrupted) {
              assessmentFlow.setPhase('execute', '本轮没有产生文件改动（如需确认细节，模型会直接提问），等待你的回复后继续。');
            }
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
            const hasContent = assistantSegments.some(s => s.el.textContent || s.el.children.length > 0);
            const lastSeg = assistantSegments.length ? assistantSegments[assistantSegments.length - 1] : null;
            if (event.payload.reason !== 'aborted') {
              // Keep the already-rendered content; surface the reason as a
              // separate status row instead of flattening a bubble to text.
              // Runtime interrupt notices follow the UI language (were hard-
              // coded English) — see chat.* keys in i18n.ts.
              const interrupted = t('chat.interrupted', '⏹ Interrupted: {reason}').replace('{reason}', event.payload.reason);
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
        );
      } else if (thinkingPhases.length > 0 && gen === this.generation) {
        const partialOutput = assistantSegments.map(segment => segment.text).filter(Boolean).join('\n\n');
        const interruptedSnapshot: Message[] = [
          ...this.messages,
          { role: 'user', content: userText },
          { role: 'assistant', content: partialOutput },
        ];
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
        );
      }
      const lastSeg = assistantSegments.length ? assistantSegments[assistantSegments.length - 1] : null;
      if (err.name === 'AbortError') {
        if (lastSeg && !lastSeg.el.textContent && lastSeg.el.children.length === 0) {
          lastSeg.el.textContent = t('chat.cancelled', '(cancelled)');
        }
      } else if (lastSeg) {
        // Localized error prefix; the raw message is kept verbatim after it.
        lastSeg.el.textContent = t('chat.error', 'Error: {msg}').replace('{msg}', err.message || err);
        lastSeg.el.classList.add('error');
      } else {
        // Failure before bubbles were created (e.g. plan review threw) — toast it.
        // Route through the shared toast helper (one module-level timer — an
        // inline setTimeout here could hide a NEWER toast early) and keep the
        // message up for 8s: actionable failures like an invalid API key must
        // not scroll out of sight in 2.5s.
        showToast(t('chat.error', 'Error: {msg}').replace('{msg}', err?.message || err), 8000);
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
      releaseSupersededTurn();
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
    this.pausePlanCard = null;
    this.pauseAssessmentFlow = null;
    // Drop the right-edge execution outline — the new conversation has none.
    planOverview().clear();
    // Invalidate any background pre-compaction from the previous session.
    this.preCompactedMessages = null;
    this.preCompactSourceMessages = null;
    this.preCompactSessionId = '';
    this.preCompactMessageCount = 0;
    this.sessionId = `session_${Date.now()}`;
    // A fresh session has no saved outline position: reset to the default corner.
    setOverviewPositionSession(this.sessionId);
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
    // Also stop any in-flight async verification: the turn's stream already
    // finished, so only this controller can interrupt the verifier's LLM call.
    this.verifierAbort?.abort();
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
  ) {
    if (messages.length <= 0) return;
    let assistantIndex = 0;
    let renderedAssistantIndex = 0;
    let analysisAttached = false;
    let planCardAttached = false;
    // A completed plan nulls activeComplexPlan (see syncActivePlanCursor), so
    // the cross-turn cursor alone would leave the finished plan with no
    // persisted state and the floating outline would not survive a reload.
    // The final card snapshot (complete: true) stands in for the cursor so the
    // all-done outline can be restored; an in-progress plan keeps its cursor.
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
        content: m.content,
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
    const nextSnapshot = createSessionSnapshot(canonicalMessages, transcriptDrafts);
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

  private addBubble(role: 'user' | 'assistant', content: string): HTMLDivElement {
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
