// src/ui/chat.ts
// v0.6 — Uses CodingAgent/Harness instead of self-built ReAct loop.
// Iterates over EngineEvents stream to update the UI reactively.

import { loadConfig, hasConfiguredKey, customSecretKey, persistConfig, type PureConfig } from './config';
import { abortPaused, isPauseAbort } from '../shared/pauseSignal';
import { defaultModelFor, baseURLFor, isDeepSeekFamily, customProviderFor, customBaseURL, customDefaultModel, isCustomKeyless, providerOverrideFor, providerDef, promptBudgetForProvider, imageGenEnabled, imageGenModelFor, estimatePromptTokens, estimateToolDefinitionTokens, resolveProviderProtocol, firstTokenHintTimeoutMs, resolveReasoningEffort } from '../shared/providers';
import { saveSession, loadLastSession, loadSession, flushSessionSaves, saveSessionStats, loadSessionStats, refreshSessionStatsFromDisk, dedupeFileWrites, upsertFileWrite, limitConversationMessages, mergeSessionSnapshotMetadata, createSessionSnapshot, createSessionPlanProgressPersistence, MAX_PERSISTED_MESSAGES, extractTitle, type TranscriptDraft, type ToolExecMeta, type SessionSnapshotV2, type SessionSnapshot, type SessionEvent, type SessionStats, type TurnTiming, type PlanCardSnapshot, type SessionPlanProgressPersistence } from './store';
import { mergeTokenUsage } from '../shared/usage';
import { blockedHosts } from '../shared/netGuard';
import { hostOf, resolveNetRoute, netRouteProxyPair, recordNetOutcome } from '../shared/netRoute';
import { memoryStore } from './memoryStore';
import { distillSkill, matchSkillDistillInstruction, pickDistillSource } from '../shared/skillDistill';
import { harvestUserPreferences } from '../shared/memory';
import { promptAssembler, buildGuiCapabilities, formatPromptBudgetDiagnostic, resolvePromptBudget, type PromptSkill } from '../shared/PromptAssembler';
import { mergeConventions } from '../shared/conventions';
import { stripUserTurnContext } from '../shared/promptLayers';
import { estimateTextTokens } from '../shared/tokenEstimate';
import { CodingAgent } from '../coding-agent/CodingAgent';
import { failureHistoryFromMemories } from '../engine/FailurePolicy';
import { ContextEngine, type ContextCompactionResult } from '../harness/ContextEngine';
import { isGitMutationCommand, Tags } from '../coding-agent/ToolRegistry';
import { IMAGE_GEN_TOOL_DEF } from '../shared/toolDefs';
import { DYNAMIC_CAPABILITY_TOOL_DEFS, type DynamicCapabilityHooks, type DynamicMcpConnectionResult } from '../shared/dynamicCapabilityTools';
import { formatIntentPrompt, markParallelPlanSteps } from '../coding-agent/Planner';
import { decideTurnRoute, prefetchTurnRoute } from '../coding-agent/turnRoute';
import { adaptiveControlPlane } from '../shared/adaptiveControl';
import { DynamicInsertionCoordinator, type DynamicInsertionDecision } from '../coding-agent/DynamicInsertionCoordinator';
import { describeTiming, needsClarification, isDestructiveAction, type InputAction, type InputTiming } from '../coding-agent/inputDecision';
import { sanitizeSkillName } from './skillHub';
import { matchInFlightBranch, steerDeliversTo, steerConsumedBy, type SteerTarget, type SteerRecipient, type InFlightBranch } from '../shared/steerTargeting';
import { PermissionManager } from '../coding-agent/PermissionManager';
import { createDefaultVerifier } from '../coding-agent/Verifier';
import { BUILT_IN_SUBAGENTS, CODING_AGENT_ROLES, type SubagentProgress, type SubagentActivity } from '../coding-agent/SubagentOrchestrator';
import type { SubagentDefinition } from '../coding-agent/types';
import { compileExternalSubagents } from '../harness/externalSubagents';
import { compilePersonaOverlays } from '../harness/personaOverlays';
import { requestPermission } from './permission';
import { MemoryStateStore } from '../adapter/storage/MemoryStateStore';
import {
  requestPlanReview,
  formatPlanForPrompt,
  formatPlanContinuation,
  formatPlanPauseMessage,
  createPlanCard,
  updatePlanCard,
  clearPlanCardRefining,
  matchPlanProgressMarkers,
  dedupePlanAnnouncements,
  evaluatePlanContinuation,
  type PlanProgressMarker,
  type PlanCardHandle,
} from './plan';
import { renderAttachmentCard } from './pasteChip';
import { PlanProgressModel, formatPlanProgressNarration, planProgressNarrationSeedFrom, shouldAdvancePlanAtTurnEnd, type PlanProgressNarrationSeed, type PlanProgressSnapshot } from './planProgress';
import { AutoContinueScheduler, AUTO_CONTINUE_DELAY_MS, DEFAULT_AUTO_CONTINUE_MAX_ROUNDS, type AutoContinueSignals } from './autoContinue';
import { TauriToolAdapter, getWebToolDefs, getSysInfoToolDefs, registerToolOutputListener, registerDownloadProgressListener, cancelDownload, takeGeneratedImages, type ImageGenContext } from './TauriToolAdapter';
import { createAssessmentFlowCard, type AssessmentFlowHandle } from './assessmentFlow';
import { createAgentActivityPanel, mergeAgentActivity, type AgentActivityPanelHandle } from './agentActivityPanel';
import { attachPlanPauseActions } from './planPauseActions';
import { OpenAICompatibleAdapter } from '../adapter/openai/OpenAICompatibleAdapter';
import { DeepSeekAnthropicAdapter } from '../adapter/deepseek/DeepSeekAnthropicAdapter';
import { RustLLMAdapter } from '../adapter/rust/RustLLMAdapter';
import { getApplicationTmpWorkspace, isTauriRuntime, loadTauriCore, tauriInvoke } from '../shared/tauri';
import { invoke } from '@tauri-apps/api/core';
import { resourceDir, join, homeDir } from '@tauri-apps/api/path';
import { renderMarkdown, scheduleStreamingRender, flushStreamingRender, cancelStreamingRender, stripToolCallXml } from './markdownLoader';
import { renderArtifactCards, computeProjectDir, type ArtifactItem } from './artifactCards';
import { linkifyPaths, setPathLinkWorkspace, openPathLink } from './pathLink';
import { downloadHub } from '../shared/downloadHub';
import { wireScrollPin, scrollChatToBottomIfPinned, forceScrollToBottom, setScrollPinObservers } from './scrollPin';
import { createToolRow, updateToolRowArgs, finalizeToolRow, markToolRowStopped, appendToolStreamLine, truncateResultLines, formatSubagentTraceLine, isWebSearchLike, toolGridClass, MAX_LIVE_STREAM_LINES, type ToolRowHandle, type ToolCardKind } from './toolRow';
import { isToolEnabled } from './toolInventory';
import type { AppSkillEntry } from '../shared/skillFiles';
import { createThinkingCard, appendThinkingText, finalizeThinkingCard, setThinkingLabel, resetThinkingLabelForOutput, startThinkingTimer, stopThinkingTimer, dismissThinkingHint, HINT_LINGER_MS, type ThinkingCardHandle } from './thinkingCard';
import { DESIGN_READY_MARKER, deliveryVerificationSummary, discoverWorkspace, formatDeliveryFixPrompt, formatDeliveryPipeline, formatTaskContract, isBareWorkspace, buildTaskContract, isVerificationCommand, parseDesignReadyMarker, runDeliveryVerification, workspaceProfileSummary, type DeliveryStepResult, type DeliveryVerificationResult, type TaskContract, type WorkspaceProfile } from '../shared/delivery';
import { createDesignPreviewCard } from './designPreviewCard';
import { parseResearchResult } from '../shared/research';
import { copyTextToClipboard } from '../shared/clipboard';
import { formatBytes } from '../shared/format';
import { showToast } from '../shared/toast';
import { mergeTranscriptWithTurn } from '../shared/conversation';
import { t } from '../shared/i18n';
import { effectiveProxyUrl } from '../shared/proxy';
import { buildShellContext } from '../shared/shellEnv';
import { MCPClient, type MCPPromptSummary, type MCPResourceSummary } from '../harness/mcp/MCPClient';
import { parseMcpPromptCommand } from '../shared/mcpPrompt';
import type { MCPServerConfig } from '../adapter/mcp/MCPTransport';
import type { WorkspaceRestoreResult, WorkspaceSnapshotPort } from '../shared/workspaceSnapshot';
import type { DownloadProgressEvent } from './TauriToolAdapter';
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
  IStateStore,
  Checkpoint,
  EngineLlmPhase,
  SubagentActivityEvent,
} from '../shared/types';
import { EventFanout } from '../shared/asyncQueue';
import { phaseModelOverrides } from '../shared/phaseModels';
import type { PermissionMode, PermissionRequestHandler, PermissionRequestInfo, PermissionDecision, TrapWarning, Plan, TaskMode, IntentAssessment } from '../coding-agent/types';
import type { SessionAgentActivity } from './store';
import { createOptimizeCard } from './optimizeCard';
import { LiveTranscriptWindow, type LiveTurnHandle } from './liveTranscriptWindow';
import { setInlineCardHost } from './inlineCard';
import { createPathRepairNote } from './pathRepairNote';
import { warmPathIndex, type PathRepair } from './pathIndex';

// Insert a `-v{n}` segment before the extension (or append it for extension-less
// files) so a written file `a/b/index.html` snapshots to `a/b/index-v1.html`.
// This mirrors the version badge shown on the artifact card.
function versionedCopyPath(path: string, version: number): string {
  const norm = path.trim();
  const dot = norm.lastIndexOf('.');
  const slash = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  if (dot <= slash + 1) return `${norm}-v${version}`;
  return `${norm.slice(0, dot)}-v${version}${norm.slice(dot)}`;
}

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

/**
 * Pull the concrete failure cause out of a FailurePolicy stop reason. The raw
 * reason is written for the model (English, with "stop making it" directives),
 * so we keep only the diagnostic prefix — the repeated call, its tool, and the
 * actual error text — and drop the instructional tail. Returns '' when nothing
 * recognizable is present.
 */
function extractFailureCause(raw: string): string {
  // Identical-call loop stop: `3 consecutive failures of the identical call (tool: X): "msg". This exact call keeps failing…`
  const identical = raw.match(/^\s*(\d+\s+consecutive failures of the identical call(?: \(tool: [^)]+\))?: ".*?")/);
  if (identical) return identical[1];
  // Generic ceiling stop: `6 consecutive failures. Last: msg. Please review…`
  const ceiling = raw.match(/^\s*(\d+\s+consecutive failures\. Last: .*?)\./);
  if (ceiling) return ceiling[1];
  return '';
}

export function sanitizeInterruptedReason(raw: string): string {
  const lower = raw.toLowerCase();
  // ── User stop / frontend-or-network disconnect (signal aborted) ──
  if (raw === 'aborted') {
    return t('chat.interrupted.aborted', 'Cancelled (stopped by user, or network/connection dropped)');
  }
  // ── Engine-issued structural stops (exact / stable codes) ──
  if (raw === 'max_turns' || /^max.?turns?$/i.test(raw)) {
    return t('chat.interrupted.maxTurns', 'Stopped: this turn reached the maximum number of steps — split the task or start a new session');
  }
  // Only the engine's exact budget stop has this meaning. A provider failure
  // may mention a request/token budget in its diagnostic text; classifying any
  // such substring as the engine budget hid the actual GLM/API failure.
  if (raw === 'Budget exceeded' || raw === 'Budget exhausted') {
    return t('chat.interrupted.budget', 'Stopped: this turn hit its step/token/time budget — compact the context or start a new session');
  }
  if (/hook aborted/i.test(raw)) {
    return t('chat.interrupted.policy', 'Stopped by a safety/policy check');
  }
  // FailurePolicy stop reasons ("N consecutive failures ..."). These already
  // contain the concrete cause (the repeated tool + its real error text), so
  // surface it instead of replacing it with a vague summary — the user must
  // know WHY the run was halted, not just that it stopped.
  if (/consecutive failures|keeps failing|same error|switch to a fundamentally different approach/i.test(raw)) {
    const cause = extractFailureCause(raw);
    const base = t('chat.interrupted.repeatedFailures', 'Stopped after repeated failed attempts — please check the task or try a different approach');
    return cause
      ? `${base}\n${t('chat.interrupted.repeatedFailuresCause', '失败原因：{detail}').replace('{detail}', cause)}`
      : base;
  }
  // ── Stream idle / first-token timeout (huge output buffering OR huge input
  //    → slow time-to-first-token). This is the "两次流式输出超时" case: the
  //    engine's LLM_STREAM_IDLE_TIMEOUT_MS fired, not a network drop.
  if (/deadline|exceeded its deadline|stream.*(timeout|timed out)|first.?token|ttft|took too long/i.test(lower)) {
    return t('chat.interrupted.streamTimeout', 'Generation timed out: the model took too long (output too large or input file too large). Split the task into smaller steps, generate the file in parts, or compress/summarize oversized input first.');
  }
  // ── Provider / transport errors ──
  if (/429|rate.?limit|rate.?exceeded|too many request/i.test(lower)) {
    return t('chat.interrupted.rateLimited', 'Rate limited — please try again later');
  }
  if (/5\d{2}|server.?error|internal.?server|overload|unavailable|bad gateway|gateway timeout|service (is )?(temp|current|busy)|model (is )?busy/i.test(lower)) {
    return t('chat.interrupted.serverError', 'Service temporarily unavailable — please try again later');
  }
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|network|fetch.?fail|ENOTFOUND|timeout|timed out|connection/i.test(lower)) {
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

// Elastic by default: no hard caps set, so the GUI agent never hard-stops on a
// step / token / time limit. maxTurns is a soft "warn once" threshold only.
const DEFAULT_BUDGET: BudgetConfig = {
  maxTurns: 1000,
  maxTotalTokens: 4_000_000,
  maxExecutionTime: 7_200_000,
  warningThreshold: 0.9,
  graceTurns: 3,
};

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
  /** Live interior trace this card has shown (delegation tools only). Kept on
   *  the entry so a deduped repeat — collapsed onto this card and finalized
   *  with a synthetic result — keeps the trace the card already streamed. */
  subagentTrace?: string[];
};

/** Deterministic key for a tool call's arguments (sorted object keys), used to
 *  collapse a repeated identical call onto the card that already shows it. */
function stableArgsStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableArgsStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableArgsStringify(v)}`).join(',')}}`;
}

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
  clone.querySelectorAll('button, .svg-slot, .chart-slot, .mermaid-slot, .puml-slot').forEach((el) => el.remove());
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
// Rows stay in the transcript, marked stopped (⏹) instead of dismissed, and
// carry one muted line saying WHY — a bare gray card reads as a mystery
// ("这张卡为什么是灰的"), the line turns it into a legible interruption.
// The per-call parse-throttle map is cleared alongside so stale keys never
// accumulate across turns.
function resolvePendingToolRows(refresh: Map<string, number>, ...maps: Map<string, ToolRowEntry>[]): void {
  refresh.clear();
  for (const map of maps) {
    for (const [, entry] of map) {
      markToolRowStopped(entry.row);
      appendToolStreamLine(entry.row, 'stdout', '本轮输出在此中断，该调用未执行完成');
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
  // Capability brief (planner + executor both read this): hosts that tripped
  // the network circuit breaker this session must not appear in any plan
  // step that depends on reaching them.
  const blocked = blockedHosts();
  const netNote = blocked.length
    ? ` Known-unreachable hosts this session (circuit-broken): ${blocked.join(', ')} — do not plan or attempt downloads/fetches from them; use inline/local alternatives instead.`
    : '';
  if (!city) {
    return `Environment: reply in ${lang}. The user has NOT configured a location — when a task depends on where they are (trip planning, weather, local services), ask for it or state the assumption clearly.${netNote}`;
  }
  return `Environment: reply in ${lang}; user location is ${city} (configured in Settings → General → Environment). Use ${city} as the user's home base — e.g. the departure point for trip planning, the reference for weather / local services. Call sys_info() for the exact current time, timezone, or OS.${netNote}`;
}

/** Smart LLM proxy routing (see netRoute.ts): bypass lists force direct;
 *  otherwise the destination host is classified (known-foreign → proxy,
 *  known-domestic → direct) and the learned per-host route decides when a
 *  proxy source exists. Returns '' (direct) whenever no proxy is configured. */
function llmProxyUrlFor(config: PureConfig | null, baseURL: string, providerId: string): string {
  const proxy = config?.proxy;
  if (!proxy) return '';
  const base = effectiveProxyUrl(proxy, 'llm');
  if (!base) return '';
  // Bypass is provider-level by design (shouldBypassProxy): a model-level
  // list existed once but was two deciders disagreeing — removed.
  if (proxy.bypassProviders?.includes(providerId)) return '';
  const route = resolveNetRoute(hostOf(baseURL) ?? '', true);
  return route === 'proxy' ? base : '';
}

/** Proxy route PAIR for the LLM turn: the classified route goes first, and —
 *  when a proxy exists at all — the OPPOSITE route rides along as the
 *  one-shot fallback (netRouteProxyPair). Rust re-sends once on the fallback
 *  after the primary exhausts its attempts, so a wrong classification or a
 *  system proxy that changed/died mid-session self-heals on the same turn
 *  instead of erroring. */
function llmProxyPairFor(config: PureConfig | null, baseURL: string, providerId: string): { proxyUrl: string; fallbackProxyUrl?: string } {
  const proxyUrl = llmProxyUrlFor(config, baseURL, providerId);
  if (!proxyUrl) return { proxyUrl: '' };
  const pair = netRouteProxyPair(baseURL, proxyUrl);
  return { proxyUrl: pair.proxyUrl, fallbackProxyUrl: pair.fallbackProxyUrl ?? undefined };
}

function buildModelIdentity(config: PureConfig | null): { provider: string; model: string } | undefined {
  const provider = config?.provider?.trim();
  if (!provider) return undefined;
  const model = config?.model?.trim() || customDefaultModel(config?.customProviders, provider);
  return model ? { provider, model } : undefined;
}

/** Load + merge the two AGENTS.md layers for the Tauri GUI. App-level defaults to
 * the app resource dir; user-level comes from the active workspace (optional).
 * Returns '' outside the Tauri runtime or on any read failure (best-effort).
 * TTL-cached: the read is three IPC round trips and it used to run on EVERY
 * turn, all of it before the first token. Same 30s window as app skills, so
 * an edit to AGENTS.md still lands without a restart. */
let guiConventionsCache: { at: number; workspace: string; text: string } | null = null;

async function loadGuiConventions(userWorkspace?: string): Promise<string> {
  const ws = userWorkspace ?? '';
  if (guiConventionsCache && Date.now() - guiConventionsCache.at < 30_000 && guiConventionsCache.workspace === ws) {
    return guiConventionsCache.text;
  }
  const text = await readGuiConventions(ws);
  guiConventionsCache = { at: Date.now(), workspace: ws, text };
  return text;
}

async function readGuiConventions(userWorkspace?: string): Promise<string> {
  if (!isTauriRuntime()) return '';
  try {
    const appRoot = await resourceDir();
    const globalRoot = await join(await homeDir(), '.pure');
    const read = async (root: string): Promise<string | null> => {
      try {
        return (await invoke<string>('read_file', { workspace: root, path: 'AGENTS.md' })) || null;
      } catch {
        return null;
      }
    };
    const [appMd, globalMd, userMd] = await Promise.all([
      read(appRoot),
      read(globalRoot),
      userWorkspace ? read(userWorkspace) : Promise.resolve(null),
    ]);
    // Seed ~/.pure/AGENTS.md from the app default on first run (best-effort),
    // so a user-editable global conventions file exists after install.
    let effectiveGlobal = globalMd;
    if (!effectiveGlobal && appMd) {
      try {
        await invoke<string>('write_file', {
          workspace: globalRoot,
          path: 'AGENTS.md',
          content: appMd,
        });
        effectiveGlobal = appMd;
      } catch {
        /* ignore seeding failure */
      }
    }
    const appPlusGlobal = mergeConventions(appMd, effectiveGlobal);
    return mergeConventions(appPlusGlobal || null, userMd);
  } catch {
    return '';
  }
}

/** 阶段 13.2 (loading half) — external subagent roles from ~/.pure/subagents/*.json.
 * Scanned once per app run (Rust does the IO, the shared compiler validates);
 * adding/removing a manifest takes effect on the next app start. Errors are
 * logged once, never thrown — a broken file must not block a turn. */
let externalSubagentsPromise: Promise<SubagentDefinition[]> | null = null;
function loadGuiExternalSubagents(): Promise<SubagentDefinition[]> {
  externalSubagentsPromise ??= (async () => {
    if (!isTauriRuntime()) return [];
    try {
      const sources = await tauriInvoke<Array<{ file: string; text: string }>>('list_external_subagents');
      const reserved = [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES].map((d) => d.name);
      const { defs, errors } = compileExternalSubagents(sources ?? [], reserved);
      for (const line of errors) console.warn(`[external-subagents] ${line}`);
      return defs;
    } catch (error) {
      console.warn('[external-subagents] scan failed:', error);
      return [];
    }
  })();
  return externalSubagentsPromise;
}

/** 阶段 13.3 — persona overlays from ~/.pure/personas/*.overlay.md. Same shape
 * as the 13.2 scan: Rust does the IO, the shared compiler validates; scanned
 * once per app run, a broken file warns instead of blocking a turn. Deleting
 * an overlay file reverts the role at the next app start. */
let personaOverlaysPromise: Promise<Map<string, string>> | null = null;
function loadGuiPersonaOverlays(knownRoles: string[]): Promise<Map<string, string>> {
  personaOverlaysPromise ??= (async () => {
    if (!isTauriRuntime()) return new Map<string, string>();
    try {
      const sources = await tauriInvoke<Array<{ file: string; text: string }>>('list_persona_overlays');
      const { overlays, errors } = compilePersonaOverlays(sources ?? [], knownRoles);
      for (const line of errors) console.warn(`[persona-overlays] ${line}`);
      return overlays;
    } catch (error) {
      console.warn('[persona-overlays] scan failed:', error);
      return new Map<string, string>();
    }
  })();
  return personaOverlaysPromise;
}

function buildSystemPrompt(hasWorkspace: boolean, temporaryWorkspace = false, config: PureConfig | null = null, toolDefinitions: ToolDefinition[] = [], imageGeneration = false, conventions?: string): string {
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
    budget: promptBudgetForProvider(config?.customProviders, config?.provider, config?.model, config?.providerOverrides),
    conventions,
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
/** Epoch ms of the last FAILED probe. A failure no longer degrades the whole
 * session: after a short cooldown the next send re-triggers the probe, so a
 * transient network blip that hid the runtimes oracle at startup is
 * re-established once the network returns. */
let runtimesProbeFailedAt = 0;
const PROBE_RETRY_COOLDOWN_MS = 30_000;
/** ⑤ 首回复延迟：send 对探针的软等待上限。探针通常早已温好（Rust 端开机预热、
 * promise 会话内缓存），这里只是给冷启动/失败冷却重探兜底——超时不再扣住首 token，
 * 本轮提示词先不带 runtimes 行，探针继续跑完供后续轮次使用。 */
const PROBE_SOFT_WAIT_MS = 1_500;

/** Kick off the one-shot environment probe (idempotent). Callers await the
 * same promise so the first send doesn't race the probe. A failed probe is
 * cleared after a cooldown so a later send re-probes instead of silently
 * running the whole session with no runtimes/network context. */
export function ensureRuntimesProbed(signal?: AbortSignal): Promise<string> {
  if (!runtimesProbe) {
    if (runtimesProbeFailedAt > 0 && Date.now() - runtimesProbeFailedAt < PROBE_RETRY_COOLDOWN_MS) {
      // Still inside the cooldown: serve the last-known (possibly empty) state.
      return Promise.resolve(cachedRuntimes);
    }
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
        runtimesProbeFailedAt = 0;
      } catch {
        // Network or runtime blip: remember the failure so a subsequent send
        // re-probes after the cooldown instead of running without environment
        // context forever. The probe promise itself stays settled (the caller
        // that started it still sees its resolved value).
        cachedRuntimes = '';
        cachedNetwork = '';
        cachedOs = '';
        runtimesProbeFailedAt = Date.now();
        runtimesProbe = null;
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
  // Includes MCP-discovered web tools (serverName__search / __fetch / ...) —
  // see isWebSearchLike in toolRow.ts for the base-name matching.
  if (isWebSearchLike(tool) || tool === 'sys_info' || tool === 'read_file' || tool === 'list_files' || tool === 'search_files' || tool === 'glob_files' || tool === 'diff_files') return 'read';
  return 'other';
}

function createPermissionHandler(config: PureConfig, hostFor?: () => HTMLElement, scope = 'default'): PermissionRequestHandler {
  return async (info: PermissionRequestInfo): Promise<PermissionDecision> => {
    const cat = toolCategory(info.tool);
    const auto = cat === 'read' ? config.autoPermRead
      : cat === 'git' ? config.autoPermGit
      : cat === 'write' ? config.autoPermWrite
      : cat === 'cmd' ? config.autoPermCmd
      : false;
    if (auto) return { allowed: true, autoApproved: true };
    return requestPermission(info, { host: hostFor?.(), scope });
  };
}

// ── Adapter factory ──

// Exported for the Settings evolution dashboard (13.3 part 3), which drafts a
// persona overlay and runs its A/B gate on the SAME provider/adapter pipeline.
export function createLLMAdapter(config: ReturnType<typeof loadConfig>): LLMAdapter {
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
  const maxTokens = resolvePromptBudget(
    promptBudgetForProvider(customs, config.provider, model, config.providerOverrides),
  ).outputReserveTokens;
  const builtinOverride = providerOverrideFor(config.providerOverrides, config.provider);
  const providerProtocol = providerDef(config.provider)?.protocol;
  // A CUSTOM provider stores its explicit wire-protocol choice on its own
  // entry (Settings → LLM), never in providerOverrides (which only holds
  // built-ins) — so pass it through as the user override, and treat the
  // custom baseURL as an overridden endpoint for URL-based detection.
  const protocol = resolveProviderProtocol(
    providerProtocol,
    baseURL,
    Boolean(custom?.baseURL) || Boolean(builtinOverride?.baseURL),
    custom?.protocol ?? builtinOverride?.protocol,
  );
  // Reasoning effort — a PER-MODEL setting on the model row (modelBudgets
  // entry, same slot as the token budgets; Settings → LLM → 供应商面板 → 模型库).
  // resolveReasoningEffort applies the row's 低/中/高/关闭 choice, falling back
  // to the 2026+ name pattern (extend that list in shared/providers.ts).
  // DeepSeekAnthropicAdapter (browser-dev anthropic branch below) has no
  // extraBody plumb and anthropic endpoints reject unknown top-level fields,
  // so this stays an OpenAI-protocol-only parameter for now.
  const reasoning = resolveReasoningEffort({ ...config, protocol });
  const extraBody = reasoning.effort ? { reasoning_effort: reasoning.effort } : undefined;
  const apiKey = custom?.apiKey ?? builtinOverride?.apiKey ?? config.apiKey;
  if (protocol === 'anthropic' && !isTauriRuntime()) {
    if (!apiKey && !isCustomKeyless(customs, config.provider)) throw new Error('No API key configured');
    return new DeepSeekAnthropicAdapter({ apiKey: apiKey ?? '', model, baseURL, maxTokens });
  }
  if (isTauriRuntime()) {
    // Desktop: the key lives in Rust secrets (~/.pure/secrets.json, 0600) and
    // is resolved inside `chat_stream` — it never passes through the WebView.
    // Custom providers resolve their own named secret ('llm.apiKey.<id>');
    // keyless ones resolve to nothing and Rust omits the Authorization header.
    const llmProxy = llmProxyPairFor(config, baseURL, config.provider);
    return new RustLLMAdapter({
      provider: config.provider,
      model,
      protocol,
      baseURL,
      // Built-in providers with their own saved key resolve it from the same
      // per-provider Rust secret slot ('llm.apiKey.<id>') as custom providers;
      // without an override the Rust backend falls back to the shared
      // 'llm.apiKey' slot (or omits the header for keyless custom endpoints).
      secretKey: custom ? customSecretKey(custom.id)
        : builtinOverride?.hasApiKey ? customSecretKey(config.provider)
        : undefined,
      proxyUrl: llmProxy.proxyUrl,
      fallbackProxyUrl: llmProxy.fallbackProxyUrl,
      // 实测学习：这条路由真的通了（或真的失败）就按主机记住，下次直接走
      // 可行的路。没配代理时不学——所有轮次都是直连，记了只是噪声。
      onNetOutcome: (outcome) => {
        if (!effectiveProxyUrl(config.proxy, 'llm')) return;
        const host = hostOf(baseURL);
        if (host) recordNetOutcome(host, outcome.route, outcome.ok);
      },
      proxyBypassProviders: config.proxy?.bypassProviders ?? [],
      extraBody,
      maxTokens,
    });
  }
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
// The first MCP handshake: a configured-but-slow stdio server
// must not hold the first token hostage. The connection keeps running in the
// background and registers its tools as soon as it answers (next turn).
const MCP_FIRST_TURN_BUDGET_MS = 600;
// MCP resource bodies are optional context that joins the prompt as a
// lower-priority tier. Waiting the full 3s prefetch window on the FIRST turn
// (when the prefetch has just started, so it is always in flight) put that
// wait in front of the first token; the prefetch keeps running in the
// background and the resources land from the next turn onward.
const MCP_RESOURCE_FIRST_TURN_BUDGET_MS = 800;

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
    proxyUrl: llmProxyUrlFor(config, customBaseURL(customs, config.provider, config.providerOverrides), config.provider),
    proxyBypassProviders: config.proxy?.bypassProviders ?? [],
  };
}

function createToolAdapter(workspace: string, config: PureConfig, sessionId = '', capabilityHooks?: DynamicCapabilityHooks): ToolAdapter {
  const inner = new TauriToolAdapter(workspace, config.tavilyApiKey, config.serperApiKey, config.city, undefined, sessionId, effectiveProxyUrl(config.proxy, 'tools'), imageGenContextFor(config), config.searxngUrl, capabilityHooks, config.sandboxCommands === true);
  // A tool is available only when the settings toggle allows it. The caller
  // supplies either the selected user workspace or the session's application
  // temporary workspace, so filesystem tools have a valid root in both modes.
  // generate_image is workspace-independent (it calls the provider's image
  // API), so it stays available in plain-chat mode like the web tools.
  const available = (name: string): boolean =>
    isToolEnabled(name, config) && (!!workspace || isWebSearchLike(name) || name === 'sys_info' || name === 'generate_image' || DYNAMIC_CAPABILITY_TOOL_DEFS.some((tool) => tool.name === name));
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

// ── Multi-agent activity visualization ──
// Agent activity is task-scoped and stays in the transcript. The panel is
// updated from the orchestrator callbacks and restored from SessionUiState so
// a long-running multi-step task has one continuous visual status surface.

/**
 * 规则分析没能给出具体计划时的起步步骤兜底。关键：按用户真实诉求生成，而不是
 * 套用与上下文无关的“探明工作区现状，完成第一处真实改动”这类固定话术——一个
 * “项目做完了运行不起来，你给看看”的排查请求，不该被当成从零构建来对待。
 */
function deriveFallbackPlan(prompt: string): Plan {
  // 兜底计划：只引用用户这次请求的真实文本，按“先理解、再小步验证”的通用方式推进，
  // 绝不根据关键词把请求归类为“提问 / 创建 / 其他”之类的固定类型再去套模板。
  const summary = prompt.replace(/\s+/g, ' ').trim();
  const display = summary.length > 64 ? `${summary.slice(0, 64)}…` : summary;
  return {
    steps: [{
      id: '1',
      action: `先看清这次请求真正想要的结果：${display || '你的请求'}`,
      description: '结合对话上下文理解目标、约束与已知条件，再决定怎么动手；不要套用任何固定模板。',
      expectedOutcome: '目标与边界清楚后再开始。',
      todosRequired: false,
    }],
    reasoning: '没有可用的计划分析时，先按这次请求的真实语义理解目标，而不是把请求归类为某种固定任务类型。',
  };
}

// ── ChatController ──

interface DownloadBarState {
  wrap: HTMLElement;
  fill: HTMLElement;
  label: HTMLElement;
  pauseBtn: HTMLButtonElement;
  lastDownloaded: number;
  lastTs: number;
}

/** Pause/cancel a running download. On the Tauri build this kills the native
 * command (SIGKILL); the partial file is kept so a resume re-run continues. On
 * the Node build it pauses the in-process controller. */
function pauseDownload(toolCallId: string): void {
  try {
    downloadHub.pause(toolCallId);
  } catch {
    /* node build only */
  }
  cancelDownload(toolCallId).catch(() => {});
}

function createDownloadBarEl(row: ToolRowHandle, toolCallId: string): DownloadBarState {
  const wrap = document.createElement('div');
  wrap.className = 'download-progress';
  const track = document.createElement('div');
  track.className = 'download-track';
  const fill = document.createElement('div');
  fill.className = 'download-fill';
  track.appendChild(fill);
  const label = document.createElement('div');
  label.className = 'download-label';
  label.textContent = '准备下载…';
  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'download-pause-btn';
  pauseBtn.type = 'button';
  pauseBtn.textContent = '停止';
  pauseBtn.addEventListener('click', () => {
    pauseDownload(toolCallId);
    pauseBtn.textContent = '已停止';
    pauseBtn.disabled = true;
  });
  wrap.append(track, label, pauseBtn);
  row.el.appendChild(wrap);
  return { wrap, fill, label, pauseBtn, lastDownloaded: 0, lastTs: 0 };
}

/** Completion card for a finished download: the one action that matters is
 * revealing the file's folder (opening the file itself lives in the folder). */
function createDownloadCard(path: string, size: number, via?: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'download-card';
  const icon = document.createElement('span');
  icon.className = 'download-card-icon';
  icon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#icon-download"/></svg>';
  const meta = document.createElement('div');
  meta.className = 'download-card-meta';
  const name = document.createElement('div');
  name.className = 'download-card-name';
  name.textContent = path.split(/[\\/]/).pop() || path;
  const sub = document.createElement('div');
  sub.className = 'download-card-sub';
  sub.textContent = `${formatBytes(size)}${via ? ` · 通过 ${via}` : ''}`;
  meta.append(name, sub);
  const actions = document.createElement('div');
  actions.className = 'download-card-actions';
  const openFolder = document.createElement('button');
  openFolder.type = 'button';
  openFolder.className = 'download-card-btn';
  openFolder.textContent = '打开所在文件夹';
  openFolder.addEventListener('click', () => openPathLink(path.replace(/[\\/][^\\/]+$/, '')));
  actions.append(openFolder);
  card.append(icon, meta, actions);
  return card;
}

export interface ChatControllerOptions {
  /** Session-owned transcript column (multi-session mode). When omitted the
   * controller renders into the shared #chat element (single-session mode). */
  host?: HTMLElement | null;
  /** False while this session is hidden behind another active conversation. A
   * hidden session keeps running — only its shared shell surfaces (activity
   * rail, plan narration) are unmounted until the session becomes visible again. */
  viewActive?: boolean;
}

// ── Agent activity host layout ──
// The host is a full-height absolute overlay on #view-container's right edge
// (see #agent-activity-host in styles.css). Its bottom must stop ABOVE the
// composer, never over it (2026-09-23 user report: completed agent cards piled
// up on top of the input box). The composer's height is dynamic (multiline
// input, attachment previews), so no fixed CSS offset can be right; instead a
// ResizeObserver on #input-bar keeps the host's --agent-host-bottom custom
// property equal to the composer height plus a small gap. The ≤720px
// bottom-sheet rules in the stylesheets set bottom: 0 directly, so narrow
// windows keep their docked-sheet behavior regardless of this property.
let agentActivityHostLayoutInstalled = false;
function installAgentActivityHostLayout(): void {
  if (agentActivityHostLayoutInstalled) return;
  const host = document.getElementById('agent-activity-host');
  const inputBar = document.getElementById('input-bar');
  if (!host || !inputBar) return;
  agentActivityHostLayoutInstalled = true;
  const sync = (): void => {
    const h = inputBar.offsetHeight;
    host.style.setProperty('--agent-host-bottom', `${h > 0 ? h + 12 : 0}px`);
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(sync).observe(inputBar);
  window.addEventListener('resize', sync);
  sync();
}

export class ChatController {
  private streaming = false;
  private abortController: AbortController | null = null;
  /** 1c 升级硬停：当本回合的 abortController 已经以 pause reason 中止后，
   * 再叫停走这条第二通道——立即掐掉宽限内的在飞工具（主信号二次 abort 是
   * no-op，升级必须走独立通道）。随回合创建、随释放置空。 */
  private hardStopController: AbortController | null = null;
  /** 阶段 12: the 「继续」 affordance appended under a paused turn. One at a
   * time; dismissed by any new send (a send IS the resume) or by clicking. */
  private pausedResumeBar: HTMLElement | null = null;
  private onStreamingChange?: (streaming: boolean) => void;
  /** 11.2 — set by the shell via onRestoreDraft (see that method). */
  private restoreDraftHandler?: (text: string) => void;
  private workspace: string = '';
  private effectiveWorkspace: string = '';
  private sessionId: string = '';
  /** Session-owned transcript column; null in single-session mode. */
  private readonly transcriptHost: HTMLElement | null;
  /** Whether this session is currently the visible conversation. */
  private viewActive: boolean;
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
  /** 会话级交付证据：构建计划曾在某一回合真实通过机械验证（typecheck/测试/构建）。
   * 后续纯总结轮没有工具调用、不会重跑验证，收尾时仍可据此把计划置为完成，
   * 避免进度播报在项目交付后停在「执行中 第 N 步」。新对话/会话切换清零。 */
  private deliveryGatePassed = false;
  /** 本会话内已生成的第几个独立规划（1、2、…）。同一规划的细化/续跑不递增，
   * 只有新请求在对话里再开一份计划才 +1；会话切换/新对话清零。 */
  private planSeqCounter = 0;
  /** 当前活动规划的会话内编号（applyPlanProgressSnapshot 从快照恢复）。 */
  private activePlanSeq = 1;
  /** 对话内进度播报（2026-09-25 顶部固定进度条拆除后的替身）：阶段推进不
   * 再钉在聊天区上方，而是在对话流里说一句「已完成哪几步、正在跑哪步」。
   * 播报位 = 上次播报时看到的快照形状，模型订阅里比差出话。 */
  private planProgressNarrationSeed: PlanProgressNarrationSeed | null = null;
  private activePlanProgressNarrator?: () => void;
  /** Task-scoped collaboration trace shared by live execution and restore. */
  private agentActivities: SessionAgentActivity[] = [];
  private agentActivityPanel: AgentActivityPanelHandle | null = null;
  private agentActivityHistorical = false;
  private agentActivityPersistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-session count of how many times each generated/modified file has been
   * written (write_file / edit_file / replace_files) this session. Drives the
   * "v1 / v2 / …" version badge on artifact cards so the user can see which
   * revision a card reflects when a file is updated several times. Keyed by a
   * normalized path; reset on a new chat (clear()). */
  private fileWriteVersions = new Map<string, number>();
  // Cumulative list of every file written across all turns of the current
  // project (session-scoped, reset on a new chat). Used to present the
  // "project directory" card exactly once, on genuine completion — including
  // when the project was interrupted and resumed, where the final completion
  // turn itself may write no new files.
  private sessionArtifacts: ArtifactItem[] = [];
  private sessionArtifactSeen = new Set<string>();
  private projectDirectoryShown = false;
  /** 最近一次上下文装配（send 构建 systemPrompt + promptTools）的真实固定开销
   * （系统提示词 + 工具定义 token 估算），与底部上下文窗口进度条共用口径；
   * 尚未发过消息时为 0，由 main.ts 的静态近似兜底（启动/恢复场景）。 */
  private contextOverhead = { system: 0, tools: 0 };
  /** Messages the user typed while a turn was running, judged UNRELATED to the
   * current task. They are queued and started as fresh tasks once the current
   * task/plan reaches a terminal state (no auto-continue pending). */
  private pendingTasks: Array<{ text: string; images: MessageImage[]; displayText: string; ts: number }> = [];
  /** The live 待办队列 card (renderQueueCard); null while the queue is empty. */
  private queueCardEl: HTMLElement | null = null;
  /** Status rows whose interject receipt promised an in-flight action (停 /
   *  方向变了 / 前提变了). keepPending keeps the shimmer honest WHILE the
   *  abort drains, but once the promise cashes — the turn finalizes, or the
   *  held insert re-enters send() — nobody else touches that row, and a
   *  shimmer that never stops reads as work still running. settleInterject
   *  Receipts() cashes them at exactly those moments. */
  private interjectReceiptRows = new Set<HTMLElement>();
  /** A message the user typed mid-run that IS related to the current task. Held
   * until the interrupted round finalizes, then re-entered as a continuation of
   * the SAME task so the model re-plans/rewrites around the new variable. */
  private relatedInsert: { text: string; images: MessageImage[]; displayText: string } | null = null;
  /** Serializes mid-run insert classifications. A second insert typed while
   * the first is still being judged must WAIT its turn — main.ts clears the
   * input box the moment interject() is called, so dropping the call would
   * lose the user's words for good. */
  private insertClassificationChain: Promise<void> = Promise.resolve();
  private dynamicInsertionCoordinator = new DynamicInsertionCoordinator();
  /** The LLM adapter for the current turn — interject() reuses it to classify
   * a mid-run insert (set by send(); null before first run). */
  private turnLlm?: import('../shared/types').LLMAdapter;
  /** 插话重构 — steering channel into the RUNNING turn. classifyAndApplyInterject
   * pushes here; the engine drains the queue at each THINK boundary (via
   * takeSteerMessages) so the very next round reconciles the words mid-flight —
   * no abort, no replan. Leftovers after the turn ends fall back to a normal
   * send in dispatchDeferred so nothing typed is ever lost.
   * 1a 定向投递（对话智能升格）: 每条插话带着目的地入队——'parent' 只进父
   * 引擎（委派不在飞时的普通顺路带上）、'all' 广播给所有在飞的活、点名某支
   * 时直达那一支。渲染一致性：displayText 保存用户原话，回合结束后残留的
   * 插话以原话重入（不是引擎框架文），重载后与实时所见一致。 */
  private pendingSteers: Array<{ message: import('../shared/types').Message; target: SteerTarget; displayText: string; images?: import('../shared/types').MessageImage[] }> = [];
  /** 阶段感知的 scope 追加（2026-09-22 用户定稿）：并行委派还没收齐时插进
   * 来的追加活不走"收尾后排队"——那会先输出一份没有它的汇总。折入汇合轮：
   * 代执行回合（takeSyntheticToolCalls，2026-09-22 重设计）在委派收齐后的
   * 第一个 THINK 边界把追加包成普通委派调用交还引擎，走原生 ACT 管线——
   * 卡片/明细/回放全部原生，顺序由结构保证。syntheticCallId 记录代执行
   * 调用 id，ToolResult 事件据此回写 mechanicallyDone（机器核验兑现）；
   * mergeFramed 保证合并口径指令只铺一次。指令型折入（mechanical=false）
   * 仍走 takeSteerMessages 框架注入 + 水位核验。收尾 settleFoldIns 兜底
   * 转排队，话绝不丢。 */
  private pendingFoldIns: Array<{ text: string; images: MessageImage[]; displayText: string; delivered: boolean; activityCountAtDelivery: number; mechanical: boolean; cancels?: boolean; mechanicallyDone?: boolean; syntheticCallId?: string; mergeFramed?: boolean }> = [];
  /** 插话重构 — REFLECT-phase adapter for the current turn, when 9.2 phase
   * routing is on: side-channel mid-run questions prefer the cheap model
   * (an answer is a summarization chore, not the main reasoning stream). */
  private turnPhaseLlm?: import('../shared/types').LLMAdapter;
  // Background pre-compaction cache: the ContextEngine's LLM summarization —
  // the dominant pre-send cost once a long session crosses the token budget —
  // runs
  // after each completed turn (idle) instead of blocking the next send. The
  // reuse guard (sessionId + message count) makes a stale window inert.
  private contextEngine?: {
    compact(messages: Message[], options?: { force?: boolean }): Promise<ContextCompactionResult>;
    getLastCompactionResult?(): ContextCompactionResult | undefined;
  };
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
  // In-memory subagent checkpoint store for this conversation — lets a sub-task
  // resume after a user stop + continue within the same session.
  private subagentStore = new MemoryStateStore();
  private liveTranscript: LiveTranscriptWindow;
  private liveTurn: LiveTurnHandle | null = null;

  constructor(options: ChatControllerOptions = {}) {
    this.sessionId = `session_${Date.now()}`;
    this.permissionManager = new PermissionManager();
    this.sessionStats = loadSessionStats(this.sessionId);
    this.transcriptHost = options.host ?? null;
    this.viewActive = options.viewActive ?? true;
    this.liveTranscript = new LiveTranscriptWindow({ root: this.transcriptHost });
  }

  /** The transcript column this session streams into: its own host when in
   * multi-session mode, otherwise the shared #chat element. */
  transcriptElement(): HTMLElement {
    return this.transcriptHost ?? document.getElementById('chat')!;
  }

  /** The session-owned host element (multi-session mode) or null. */
  getViewHost(): HTMLElement | null {
    return this.transcriptHost;
  }

  /** Whether this session is currently the visible conversation. */
  isViewActive(): boolean {
    return this.viewActive;
  }

  /** Mark this session as the visible conversation (or as a hidden background
   * session). Switching NEVER cancels the session: a hidden session keeps its
   * run alive in its own transcript host and re-mounts its shared surfaces
   * (activity rail / plan narration) when shown again. */
  setViewActive(on: boolean): void {
    if (this.viewActive === on) return;
    this.viewActive = on;
    if (this.transcriptHost) this.transcriptHost.hidden = !on;
    if (on) {
      this.mountAgentActivityPanel();
    } else {
      this.hideAgentActivitySurface();
    }
  }

  /** Actual scrolling container: the shared #chat box that owns the scrollbar
   * (per-session hosts live inside it). */
  private scrollRoot(): HTMLElement {
    const host = this.transcriptHost;
    if (host?.isConnected) return host.parentElement ?? this.transcriptElement();
    return this.transcriptElement();
  }

  private transcriptTarget(): HTMLElement {
    return this.liveTurn?.host.isConnected ? this.liveTurn.host : this.transcriptElement();
  }

  private appendToTranscript(node: Node): void {
    this.transcriptTarget().appendChild(node);
  }

  private beginLiveTurn(userText: string): LiveTurnHandle {
    const turn = this.liveTranscript.startTurn(userText);
    if (this.activeComplexPlan && this.activePlanCardHandle) {
      this.liveTranscript.moveNodeToTurn(this.activePlanCardHandle.el, turn);
    }
    this.liveTurn = turn;
    setInlineCardHost(turn.host);
    return turn;
  }

  private finishLiveTurn(turn: LiveTurnHandle | null): void {
    if (!turn || this.liveTurn !== turn) return;
    this.liveTranscript.finishTurn(turn);
    this.liveTurn = null;
    setInlineCardHost(null);
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
    // 快照带会话内计划编号：恢复旧会话时编号接续，后续新计划不会重复编号。
    this.activePlanSeq = snapshot.planSeq ?? 1;
    this.planSeqCounter = Math.max(this.planSeqCounter, this.activePlanSeq);
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
    this.activePlanProgressNarrator?.();
    this.activePlanProgressNarrator = undefined;
    this.planProgressNarrationSeed = null;
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
    // 播报位从当前快照起算：bind/恢复不回放历史，之后每次前进才说话。
    this.planProgressNarrationSeed = planProgressNarrationSeedFrom(model.getSnapshot());
    this.activePlanProgressNarrator = model.subscribe((snapshot) => {
      if (this.activePlanProgress !== model) return;
      const line = formatPlanProgressNarration(this.planProgressNarrationSeed, snapshot);
      this.planProgressNarrationSeed = planProgressNarrationSeedFrom(snapshot);
      if (line) this.addStatusBubble(line, false, false, 'info');
    }, { emitCurrent: false });
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
    this.liveTranscript.reset();
    this.liveTurn = null;
    setInlineCardHost(null);
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
    this.agentActivities = [];
    this.agentActivityHistorical = false;
    this.clearAgentActivityPersistence();
    this.removeAgentActivityPanel();
    // 会话切换 = 新的一次对话：规划编号重新起算，进度播报随之重新播种。
    this.planSeqCounter = 0;
    this.activePlanSeq = 1;
    this.deliveryGatePassed = false;
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

  /**
   * Prompt templates published by the connected MCP servers, for the composer
   * autocomplete (6.2). Deliberately side-effect free: it only reports what an
   * already-connected client knows, so typing in the composer can never spawn
   * third-party subprocesses. `waitMs` bounds a prefetch already in flight.
   */
  async listMcpPrompts(waitMs = 600): Promise<MCPPromptSummary[]> {
    if (!this.mcpClient) return [];
    return this.mcpClient.listPrompts(waitMs);
  }

  /**
   * Resources the live MCP client has already discovered (Settings → MCP card
   * prefill). Read-only like listMcpPrompts: it never connects, so opening
   * Settings cannot spawn a server, and an empty list simply means this session
   * has none loaded yet.
   */
  async listMcpResources(waitMs = 600): Promise<MCPResourceSummary[]> {
    if (!this.mcpClient) return [];
    return this.mcpClient.listResources(waitMs);
  }

  /**
   * Expand a `/mcp-prompt <server__name> [key=value …]` composer command into
   * the server's template text (6.2). Returns null when the text is not a
   * prompt command, so callers can pass any draft through unchanged.
   *
   * A command IS an explicit request to use MCP, so this path may connect the
   * configured servers on demand (the composer often sees the first command
   * before any turn has run). The bookkeeping mirrors the deferred init below
   * so the first send afterwards does not reconnect what we just wired up.
   */
  async expandMcpPromptCommand(text: string): Promise<{ ok: true; text: string; label: string } | { ok: false; error: string } | null> {
    const invocation = parseMcpPromptCommand(text);
    if (!invocation) return null;
    try {
      const client = await this.ensureMcpReadyForComposer();
      if (!client) return { ok: false, error: '未配置 MCP 服务器，无法调用 prompt 模板。' };
      const result = await client.getPrompt(invocation.key, invocation.args);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, text: result.text, label: result.description?.trim() || invocation.key };
    } catch (err) {
      return { ok: false, error: `MCP 连接失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * E2.2 —「把这个做法沉淀成技能」。用户触发（正则识别，见 skillDistill）：
   * 取最近的过程记忆，一次 LLM 调用扩写成 SKILL.md，经 Rust write_app_skill
   * 落到 ~/.pure/skills/auto-<name>/，下个会话 <skills> 注入自动带上。任何
   * 一步失败都在原状态条上讲人话，不留半成品。
   */
  private async runSkillDistill(instruction: string): Promise<void> {
    this.addBubble('user', instruction);
    const wrapper = this.addStatusBubble(t('skill.distill.running'), true);
    const bubble = wrapper.querySelector<HTMLElement>('.bubble');
    const fail = (text: string) => {
      wrapper.classList.remove('pending');
      wrapper.classList.add('error');
      if (bubble) bubble.textContent = text;
    };
    try {
      if (!isTauriRuntime()) {
        fail(t('skill.distill.desktopOnly'));
        return;
      }
      const source = pickDistillSource(memoryStore.list());
      if (!source) {
        fail(t('skill.distill.noSource'));
        return;
      }
      const config = loadConfig();
      if (!config || !hasConfiguredKey(config)) {
        fail(t('skill.distill.failed'));
        return;
      }
      const skill = await distillSkill(createLLMAdapter(config), source.content, instruction);
      if (!skill) {
        fail(t('skill.distill.failed'));
        return;
      }
      await invoke('write_app_skill', { name: skill.name, description: skill.description, body: skill.body });
      wrapper.classList.remove('pending');
      wrapper.classList.add('hl-success');
      if (bubble) bubble.textContent = t('skill.distill.done').replace('{name}', skill.name);
    } catch (err) {
      fail(t('chat.error', 'Error: {msg}').replace('{msg}', err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * Connect MCP on demand for composer-level work. Reuses the live client when
   * one exists; otherwise builds it from the config the same way `send()` would
   * (a `servers: []` client that connects each configured server by hand), then
   * records the same session/config snapshot the deferred init records.
   */
  private async ensureMcpReadyForComposer(): Promise<MCPClient | null> {
    const config = loadConfig();
    if (!config) return null;
    const servers = config.mcpServers ?? [];
    if (servers.length === 0) return null;
    const proxyUrl = effectiveProxyUrl(config.proxy, 'tools');
    if (!this.mcpClient) {
      this.mcpClient = new MCPClient({
        servers: [],
        sessionId: this.sessionId,
        proxyUrl,
        excludedPrefixes: config.mcpExcludedPrefixes,
      });
    }
    const client = this.mcpClient;
    if (!this.deferredInitDone) {
      await withAbortTimeout(
        Promise.allSettled(servers.map((server) => client.connectServer(server))),
        undefined,
        20_000,
        'MCP initialization',
      );
      this.deferredInitDone = true;
      this.mcpSessionId = this.sessionId;
      this.mcpConfigSnapshot = JSON.stringify([servers, proxyUrl]);
    }
    return client;
  }

  /** Subscribe to per-session stats updates (right-panel 统计 tab). */
  onSessionStatsChanged(fn: (stats: SessionStats) => void): void {
    this.onStatsChanged = fn;
  }

  onWorkspaceSnapshotChanged(fn: (available: boolean) => void): void {
    this.onSnapshotChanged = fn;
    fn(this.hasUndoableWrites());
  }

  /** Whether this session has file writes that undo could restore. */
  hasUndoableWrites(): boolean {
    return !!this.snapshotPort?.getLatestWriteBatch();
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
      maxTokens: resolvePromptBudget(promptBudgetForProvider(config?.customProviders, config?.provider, config?.model, config?.providerOverrides)).availableInputTokens,
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
    const chatEl = this.scrollRoot();
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

  /** Mount the task-scoped collaboration trace outside the transcript scroll box.
   * Only the VISIBLE session may own the shared activity rail; a hidden session
   * keeps tracking its own activities in memory/persistence and re-mounts the
   * rail when the user switches back. The panel object survives being replaced
   * on the shared host (it simply detaches), so an agent that is still running
   * does not replay its entry animation when its session regains focus. */
  mountAgentActivityPanel(): void {
    if (!this.viewActive) return;
    const host = document.getElementById('agent-activity-host');
    if (!host) return;
    installAgentActivityHostLayout();
    if (this.agentActivities.length === 0) {
      host.hidden = true;
      return;
    }
    if (this.agentActivityPanel && !this.agentActivityPanel.el.isConnected) {
      // Another session mounted over ours while we were hidden — reattach the
      // SAME panel (its per-agent animation state is still current).
      host.replaceChildren(this.agentActivityPanel.el);
    } else if (!this.agentActivityPanel) {
      this.agentActivityPanel = createAgentActivityPanel(this.sessionId);
      host.replaceChildren(this.agentActivityPanel.el);
    }
    host.hidden = false;
    this.agentActivityPanel.update(this.agentActivities, { historical: this.agentActivityHistorical, sessionId: this.sessionId });
  }

  /** Hide the shared rail only when THIS session's panel is mounted on it (a
   * visible session must not lose its rail). The panel stays alive detached so
   * reactivation can reattach it without replaying entry animations. */
  private hideAgentActivitySurface(): void {
    const host = document.getElementById('agent-activity-host');
    if (host && this.agentActivityPanel && host.contains(this.agentActivityPanel.el)) {
      host.hidden = true;
    }
  }

  /** Destroy this session's activity panel state (session cleared/deleted or a
   * fresh restore is about to mount a historical panel). The shared host is
   * only wiped when THIS session's panel is actually mounted on it — a hidden
   * session must never clear the visible session's rail. */
  private removeAgentActivityPanel(): void {
    const host = document.getElementById('agent-activity-host');
    if (this.agentActivityPanel) {
      if (host?.contains(this.agentActivityPanel.el)) {
        host.hidden = true;
        host.replaceChildren();
      }
      this.agentActivityPanel = null;
    } else if (host && this.viewActive) {
      host.hidden = true;
      host.replaceChildren();
    }
  }

  private updateAgentActivity(activity: SubagentActivity): void {
    const index = this.agentActivities.findIndex((item) => item.callId === activity.callId);
    const previous = index >= 0 ? this.agentActivities[index] : undefined;
    // Progress callbacks from parallel work can arrive after a terminal update.
    // A per-call sequence makes the latest observed lifecycle authoritative and
    // prevents a delayed state/tool callback from bringing a finished agent back.
    if (previous?.sequence !== undefined && activity.sequence !== undefined && activity.sequence <= previous.sequence) return;
    const next = mergeAgentActivity(previous, activity);
    if (index >= 0) {
      this.agentActivities[index] = next;
    } else {
      // First sighting of this delegation: number it among this task's
      // dispatches of the same agent, so four ui_designer cards read as
      // ui_designer（1）…（4）instead of four identical names.
      next.instanceNo = this.agentActivities.filter((item) => item.agentName === next.agentName).length + 1;
      this.agentActivities.push(next);
    }
    if (this.viewActive) {
      this.mountAgentActivityPanel();
      this.agentActivityPanel?.update(this.agentActivities);
    }
    this.scheduleAgentActivityPersistence();
  }

  private scheduleAgentActivityPersistence(): void {
    if (this.agentActivityPersistTimer !== null) clearTimeout(this.agentActivityPersistTimer);
    const sessionId = this.sessionId;
    const generation = this.generation;
    this.agentActivityPersistTimer = setTimeout(() => {
      this.agentActivityPersistTimer = null;
      void flushSessionSaves().then(() => loadSession(sessionId)).then((loaded) => {
        if (!loaded || this.sessionId !== sessionId || this.generation !== generation) return;
        const snapshot: SessionSnapshot = {
          ...loaded.snapshot,
          uiState: {
            ...loaded.snapshot.uiState,
            agentActivities: this.agentActivities.map((item) => ({ ...item })),
          },
        };
        return saveSession(sessionId, snapshot, loaded.workspace);
      }).catch(() => {});
    }, 250);
  }

  private clearAgentActivityPersistence(): void {
    if (this.agentActivityPersistTimer !== null) clearTimeout(this.agentActivityPersistTimer);
    this.agentActivityPersistTimer = null;
  }

  /** Register the restored plan card as the scroll target for the fixed progress bar. */
  registerRestoredPlanCard(card: PlanCardHandle): void {
    this.activePlanCardHandle = card;
  }

  /** Current session's aggregated stats (token totals, cost, tool activity). */
  getSessionStats(): SessionStats {
    return this.sessionStats;
  }

  /** Live transcript messages (current context). Used by the context-panel
   * charts to estimate the context window actually consumed right now —
   * sessionStats.usage.promptTokens is cumulative across turns, not current. */
  getMessages(): Message[] {
    return this.messages;
  }

  /** 最近一次 send 装配的上下文固定开销（系统提示词 + 工具定义 token 估算），
   * 与底部上下文窗口进度条共用口径。 */
  getContextOverheadTokens(): { system: number; tools: number } {
    return this.contextOverhead;
  }

  /** The engine's latest POST-compaction estimate — the exact token load the
   *  next request would carry (system + tools + trimmed transcript). Null
   *  before the first send. The raw transcript is never sent as-is once it
   *  overflows; this is the number that actually matters. */
  getLastCompaction(): ContextCompactionResult | null {
    return this.contextEngine?.getLastCompactionResult?.() ?? null;
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
    this.liveTranscript.reset();
    this.liveTurn = null;
    setInlineCardHost(null);
    // Switching to another session invalidates any in-flight send of the
    // previous one, so its subagent-progress callbacks can never recreate
    // multi-agent cards here (they check gen === this.generation).
    this.generation++;
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
    this.agentActivities = (snapshot.uiState.agentActivities ?? []).map((activity) => ({ ...activity }));
    // Snapshots saved before per-instance numbering lacked instanceNo — derive
    // it from dispatch order so a restored roster numbers consistently with a
    // live one (and new delegations continue the sequence, not collide with it).
    const seen = new Map<string, number>();
    for (const activity of this.agentActivities) {
      const next = (seen.get(activity.agentName) ?? 0) + 1;
      seen.set(activity.agentName, next);
      activity.instanceNo = activity.instanceNo ?? next;
    }
    this.agentActivityHistorical = true;
    this.removeAgentActivityPanel();
    this.planSeqCounter = 0;
    this.activePlanSeq = 1;

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
    // ⑥ 长会话恢复后立刻把 trim/摘要挪进 idle 窗口，首次发送不再在关键路径上
    // 同步等压实（见 preCompactAfterLoad）。
    this.preCompactAfterLoad();
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
    // 11.2 — every workspace change funnels through here (picker, session load,
    // landing reset), so this is the one place that can warm the path index the
    // moment the workspace is known: by the time the user has typed a prompt the
    // index is ready, and the FIRST send already gets path repair. Fire and
    // forget — the composer never waits for it.
    void warmPathIndex(path, { force: true });
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

  /** Compact snapshot of the current task, fed to classifyInsertion so it can
   * judge whether a mid-run insert is related. */
  private buildInsertionContext(images?: MessageImage[]): string {
    const parts: string[] = [];
    const lastUser = [...this.messages].reverse().find((m) => m.role === 'user');
    if (lastUser?.content) parts.push(`用户当前诉求：${lastUser.content.slice(0, 400)}`);
    if (images?.length) parts.push(`（本回合含 ${images.length} 张图片）`);
    const plan = this.activeComplexPlan;
    if (plan && plan.steps.length > 0) {
      parts.push(`当前计划（第 ${Math.max(1, this.activePlanNumber)} 阶段 / 共 ${plan.steps.length} 步）`);
      for (const s of plan.steps.slice(0, 8)) {
        parts.push(`- ${(s.action ?? s.id).slice(0, 120)}`);
      }
    }
    // 委派在飞状态喂给分类器：steer 的承诺（"下个动作带上"）只有在真有
    // 下个动作时才可兑现——在飞/收尾的事实是 steer vs task 判定的关键输入。
    if (this.agentActivities.length > 0) {
      const inFlight = this.agentActivities.filter((item) => item.status === 'running').length;
      parts.push(`并行委派：共 ${this.agentActivities.length} 个，在飞 ${inFlight} 个${inFlight === 0 ? '（已收齐，任务即将汇总收尾）' : ''}`);
    }
    if (this.sessionArtifacts.length > 0) {
      parts.push(`本会话已写入文件：${this.sessionArtifacts.slice(0, 12).map((a) => a.path).join(', ')}`);
    }
    return parts.join('\n') || '（当前任务）';
  }

  /**
   * Handle a message the user typed while a turn is running (interrupt-and-
   * insert). 插话重构 — 判定的依据从"相不相关"换成了"一个埋头干活的人听到
   * 这句话会怎么处理"，只有两种情况值得停下手里的活：
   *   - stop        → 用户叫停，结束当前任务（正则直判，不占分类往返）。
   *   - goal-change → 方向被掀掉，停下并把这句话作为新指令重新出发。
   * 其余全部不打断：
   *   - steer   → 进引擎转向通道（takeSteerMessages），下一个 THINK 轮顺路
   *               带上，手头的活继续干。
   *   - question → 侧路回答一句，主循环毫无感知。
   *   - task    → 阶段感知：委派还在飞 → 折入汇合轮（foldInScopeAddition，
   *               先补这项再合并汇总，收尾核验没折入就转排队兜底）；
   *               委派收齐 → 排队（pendingTasks），收尾后作为新任务启动。
   *   - chatter → 收下即可，用户的话以自己的气泡上屏，不打扰干活的人。
   * 分类不可用时保守按 steer 处理：话一定送到，活绝不推倒重来。
   */
  async interject(text: string, images: MessageImage[] = [], displayText = text): Promise<void> {
    if (!text.trim()) return;
    // Not mid-run → a normal send.
    if (!this.isStreaming()) {
      void this.send(text, images, displayText);
      return;
    }
    // Serialize classifications instead of dropping concurrent inserts: the
    // old insertInFlight early-return silently discarded any message typed
    // while an earlier one was still being judged — and the caller has
    // already cleared the input box, so those words were gone.
    // The judge is an LLM round trip (seconds). During it the user's words
    // are deliberately not on screen yet (the abort classes re-enter through
    // send(), which renders its own bubble) — without an instant ack that
    // window reads as dead air: you said something and nobody reacted. The
    // ack is ONE pending status line that the final receipt REPLACES in
    // place, so the transcript never shows two lines for one insert.
    const ack = this.addStatusBubble('收到——看一下这句话怎么安排…', true, false);
    const ackRow = ack.parentElement;
    if (ackRow) this.interjectReceiptRows.add(ackRow);
    const run = this.insertClassificationChain.then(() => this.classifyAndApplyInterject(text, images, displayText, ack));
    // A rejected link must never poison the chain for later inserts.
    this.insertClassificationChain = run.catch(() => {
      this.settleAck(ack, '这句话没安排上——直接再发一次就行。');
    });
    await run;
  }

  /** Flip the interject ack from "looking at it" to its final one-line receipt.
   * Same row, new words — the conversation gains a sentence instead of a second
   * system line. keepPending keeps the shimmer through an async abort drain;
   * kind upgrades the row's highlight to match the old dedicated receipts. */
  private settleAck(ack: HTMLElement | null, text: string, keepPending = false, kind?: 'success' | 'warn' | 'info'): void {
    if (!ack) return;
    ack.textContent = text;
    if (!keepPending) ack.parentElement?.classList.remove('pending');
    if (kind) ack.classList.add(`hl-${kind}`);
    linkifyPaths(ack);
  }

  /** 插话回显的次序保证：用户原话在前，宿主回执（ack 行）紧随其后。ack 在
   * 插话瞬间就上屏（比秒级分类快），而回显气泡默认追加在它后面——不移一行，
   * 「已收到…」这类回执就永远压在用户那句话的头上（用户实测报过这个顺序
   * bug）。只在两行确实相邻时搬，避免打乱中间可能插进来的其他内容。 */
  private placeAckAfterEcho(ack: HTMLElement | null, bubble: HTMLElement): void {
    const ackRow = ack?.parentElement;
    const bubbleRow = bubble.parentElement;
    if (ackRow && bubbleRow && ackRow.previousElementSibling === bubbleRow) {
      bubbleRow.insertAdjacentElement('afterend', ackRow);
    }
  }

  /** Cash the receipts that promised an in-flight action: the abort has drained
   * (turn finalize) or the held insert is re-entering as a fresh turn (fresh
   * send) — either way the shimmer's claim stopped being true the moment this
   * runs. Called from dispatchDeferred (the finalize-side entry) and send()
   * (the re-entry/new-send entry) so every path that ends the wait sweeps. */
  private settleInterjectReceipts(): void {
    if (this.interjectReceiptRows.size === 0) return;
    for (const row of this.interjectReceiptRows) row.classList.remove('pending');
    this.interjectReceiptRows.clear();
  }

  /** One link of the interject chain: runs only after every earlier insert has
   * been judged. Re-checks isStreaming() because an earlier stop/goal-change
   * aborts the turn — by the time this link runs, the insert may belong to a
   * fresh send instead. */
  private async classifyAndApplyInterject(text: string, images: MessageImage[], displayText: string, ack: HTMLElement | null): Promise<void> {
    if (!this.isStreaming()) {
      // The turn is over; a normal send renders the user's own bubble, so the
      // provisional ack would only orphan a promise nobody keeps.
      ack?.parentElement?.remove();
      void this.send(text, images, displayText);
      return;
    }
    // Steer / question / chatter never re-render the user's words later, so the
    // echo here is the only chance for the transcript to show who said what.
    // The abort classes (goal-change / premise-change) are the exception: their
    // insert is HELD and re-enters through send(), which renders the bubble as
    // the fresh turn's opening line — echoing here too made the same message
    // appear twice (user-reported). The status label carries the instant
    // feedback while the abort drains.
    const echoUserBubble = (): void => {
      const bubble = this.addBubble('user', displayText, images);
      // 回执行跟随到气泡下面——用户的话在前，宿主的收执在后。
      this.placeAckAfterEcho(ack, bubble);
    };
    // 分类器不可用（turnLlm 还没立起来）也照走 decide(null)：协调器的兜底
    // 现在是 task（折入/排队，确定性目的地）——话绝不因没有分类器而失踪。
    const decision = await this.dynamicInsertionCoordinator.decide(this.turnLlm ?? null, this.buildInsertionContext(images), { text, images, displayText }, this.abortController?.signal);
    if (this.abortController?.signal?.aborted) {
      // The turn was hard-stopped while we were classifying — don't drop the
      // insert; queue it so it still runs as a task. The queue card that
      // queueInterjectTask renders is the receipt; the provisional ack would
      // only duplicate it.
      ack?.parentElement?.remove();
      this.queueInterjectTask(text, images, displayText);
      return;
    }
    // 输入级时间语义先于 kind 生效：这句话自己报了执行时刻，那它现在就不该被
    // 执行——不管分类器把它读成什么（stop 除外：停是立即的，timing 恒为 now）。
    // 少了这一步，"下午三点再跑一遍"会被当成当场追加的活跑掉。
    if (decision.timing.mode === 'at' && this.deferTimedInsert(decision.timing, text, images, displayText)) {
      ack?.parentElement?.remove();
      return;
    }
    // 置信门在这里兑现（此前门只改写决策、分发按 kind 照走——低置信的
    // goal-change 照样拆任务，"问而不赌"从未发生）：分类器明确报告没把握、
    // 且原判定是破坏性的（停/重开），先把问题问出来，手头的活照跑。不破坏的
    // 误判自己能愈（排队晚点跑、旁答只答一次），照旧分发，不拿问题烦人。
    const gatedFrom = decision.signals.gatedFrom;
    if (needsClarification(decision) && typeof gatedFrom === 'string' && isDestructiveAction(gatedFrom as InputAction)) {
      this.settleAck(ack, '先不动手——这句话我拿不准，问你一句…', true);
      echoUserBubble();
      void this.askMidrunClarification(decision, text, images, ack);
      return;
    }
    switch (decision.kind) {
      case 'stop':
        this.settleAck(ack, '收到，停——正在收尾当前任务，已经跑完的部分都留着。', true, 'info');
        this.abortController?.abort();
        return;
      case 'goal-change':
        // 不在这里回显——held insert 从 send() 重入时会作为新回合开场气泡上屏，
        // 先回显再重入 = 同一句话上两遍。
        this.relatedInsert = { text, images, displayText };
        this.settleAck(ack, '方向变了——在跑的先停下止损，已完成的不丢，马上按新的方向来。', true, 'info');
        this.abortController?.abort();
        // Same late-classification hazard as queueInterjectTask: if the turn
        // already finished while we were judging, no finalize will dispatch
        // the held insert — re-arm the deferred dispatch here.
        if (!this.isStreaming()) this.scheduleDeferred();
        return;
      case 'premise-change':
        // 前提被推翻（"其实我在西安"）：目标没变，但在飞的委派按错误前提算
        // 下去全是白跑——走同一条 abort 链止损，插话暂存，收尾后作为新指令
        // 重新入场，按纠正后的事实重排。不预回显：重入 send() 时才上屏，
        // 否则同一句话出现两遍（用户实测暴露）。
        this.relatedInsert = { text, images, displayText };
        this.settleAck(ack, '前提变了——按旧前提跑下去只会白跑，先停下止损，马上按纠正后的事实重新来。', true, 'info');
        this.abortController?.abort();
        if (!this.isStreaming()) this.scheduleDeferred();
        return;
      case 'steer': {
        // 取消型在飞期间仍折入（取消框架 + 取消回执，2026-09-24 取消案例）：
        // 真正停掉某一支是第 2 期分支中断的事，这里的"收掉一项"靠汇合轮
        // 核验兜底。非取消的 steer 走 1a 定向投递。
        if (decision.signals.cancelsPart === true && this.hasDelegationInFlight()) {
          this.foldInScopeAddition(text, images, displayText, false, ack, true);
          return;
        }
        // 1a 定向投递：委派在飞时，用户的话按点名找收件人——点到某一支就
        // 直达那一支（其余照跑），没点名就广播给所有在飞的活。委派不在飞
        // 时照旧：父引擎下个 THINK 边界顺路带上。
        echoUserBubble();
        if (this.hasDelegationInFlight()) {
          this.steerRunningTurn(text, images, ack, this.matchSteerRecipient(text));
        } else {
          this.steerRunningTurn(text, images, ack);
        }
        return;
      }
      case 'question':
        // 回答气泡马上就来（旁路一次 LLM 调用），临时回执不再留行。
        ack?.parentElement?.remove();
        echoUserBubble();
        void this.answerMidrunQuestion(text, images);
        return;
      case 'task': {
        // 取消不是活（2026-09-24 取消案例的宿主兜底）：分类器万一仍把"收掉
        // 一项"判成 task（cancelsPart 为真），绝不能让它进队列或被机械折入
        // ——排队一个"取消"等于把它当活跑，反向执行。按取消型 steer 处理。
        if (decision.signals.cancelsPart === true) {
          if (this.hasDelegationInFlight()) {
            this.foldInScopeAddition(text, images, displayText, false, ack, true);
            return;
          }
          echoUserBubble();
          this.steerRunningTurn(text, images, ack);
          return;
        }
        // 阶段感知（2026-09-22 用户定稿）：并行委派还没收齐时插进来的追加活，
        // 不进"当前任务完成后处理"的队列——那会先输出一份没有它的汇总。折入
        // 汇合轮：正在跑的收齐后先补这项，再合并输出一份覆盖全部的汇总。
        // 委派都收齐了才插的，照旧排队（先出已有结果，再单独补跑）。
        if (this.hasDelegationInFlight()) {
          this.foldInScopeAddition(text, images, displayText, true, ack); // scope 追加：机械执行
        } else {
          // 队列卡本身就是回执（逐条可见、就地更新），临时回执不再留行。
          ack?.parentElement?.remove();
          this.queueInterjectTask(text, images, displayText);
        }
        return;
      }
      case 'chatter':
        // 收下了。同事埋头干活时说了句"哈哈"，你不会停下来回一句"收到"——
        // 气泡已上屏，这就够了，别再打扰干活的人。临时回执也一并收走。
        ack?.parentElement?.remove();
        echoUserBubble();
        return;
    }
  }

  /** 1a 定向投递 — 从 agentActivities（宿主唯一在飞账本，观测单向，不另立
   * 注册表）取在飞分支视图，交给纯匹配器判断用户这句话点名了哪一支。返回
   * 'all' = 没点名，按广播处理。 */
  private matchSteerRecipient(text: string): SteerTarget {
    const branches: InFlightBranch[] = this.agentActivities
      .filter((item) => item.status === 'running')
      .map((item) => ({ callId: item.callId, name: item.agentName, role: item.agentRole, snippet: item.inputSnippet }));
    const matched = matchInFlightBranch(text, branches);
    return matched ? { branchCallId: matched.callId, branchName: matched.name } : 'all';
  }

  /** 插话重构 — hand a remark to the RUNNING turn via the steering channel:
   * the engine drains it at the next THINK boundary and reconciles it in
   * stride. No abort, no replan, no queue — a nudge should steer, not
   * restart. The user prompt carries a light frame (2026-09-24 插话协议案例集):
   * the model sees a bare mid-transcript user line and could read it as a new
   * turn's instruction — the frame marks it as a steer and points at the
   * <insertion_protocol> rules so the reconciliation follows the protocol
   * (smallest action, state what changed/stays, never discard finished work).
   * 1a 定向投递：target='parent' 走父引擎；委派在飞时是 'all'（广播）或点名
   * 某一支（直达，其余照跑）。收执按目的地说清楚话去了哪，别让用户猜。 */
  private steerRunningTurn(text: string, images: MessageImage[], ack: HTMLElement | null = null, target: SteerTarget = 'parent'): void {
    this.pendingSteers.push({
      message: {
        role: 'user',
        content: `【用户插话·顺路带上】${text}\n（这是任务进行中的插话，不是新任务：按 <insertion_protocol> 判断它影响什么，选最小动作，手头的活继续。）`,
        images,
      },
      target,
      displayText: text,
      images,
    });
    this.settleAck(ack,
      target === 'parent'
        ? '已转达——手头的活不停，下个动作就带上。'
        : typeof target === 'string'
          ? '在跑的几路都收到了——各自下个动作就带上。'
          : `已直接转给「${target.branchName}」那一路——它下个动作就带上，其余照跑。`);
  }

  /** 插话重构 — answer a mid-run question out-of-band: one LLM call with the
   * current task snapshot (cheap REFLECT-phase adapter when 9.2 routing is
   * on). The running turn is never touched — no abort, no replan. 1b question
   * 入账（对话智能升格）：旁答不再是一次性的——问答对折进运行回合的下个
   * THINK 边界（internal 消息，模型读得到、转录有账、重放不冒充用户说话），
   * 最终汇总与旁答口径不再打架；旁答失败不再静默，问题入账，收尾时统一答。 */
  private async answerMidrunQuestion(text: string, images: MessageImage[]): Promise<void> {
    let answer = '';
    const llm = this.turnPhaseLlm ?? this.turnLlm;
    if (llm) {
      const system = `The user asked you something WHILE you are mid-task. Answer now, briefly and like a colleague who keeps working while talking: 2-4 sentences of plain flowing text in the user's language, no lists, no headings, no promises beyond what the current state supports. Here is where the task stands:
<current_task>
${this.buildInsertionContext(images).slice(0, 3_200)}
</current_task>`;
      const request: import('../shared/types').Message[] = [
        { role: 'system', content: system },
        { role: 'user', content: text, images },
      ];
      try {
        const response = await llm.complete(request, [], this.abortController?.signal);
        answer = response.content?.trim() ?? '';
      } catch {
        answer = '';
      }
    }
    if (this.abortController?.signal?.aborted) return; // 回合正被叫停——记录与提示都随止损走
    if (answer) {
      const bubble = this.addBubble('assistant', '');
      bubble.textContent = `（边干边答）${answer}`;
      this.recordSideAnswer(text, answer);
    } else {
      // 旁答失败不再静默：明说没答上，问题已入账，收尾时模型统一答。
      this.addStatusBubble('这个问题我暂时没答上来——先记下了，收尾时一并答你。', false, false, 'info');
      this.recordSideAnswer(text, '');
    }
  }

  /** 1b question 入账 — 把问答对（answer 为空 = 没答上）作为 internal 消息
   * 折进运行回合：模型下个边界读到，最终输出与旁答口径一致。displayText 的
   * 区分兜底在 dispatchDeferred：答上的记录回合就结束了 = 账已清，残留即弃；
   * 没答上的把问题原话重入（「收尾时统一答」的承诺必须兑现）。 */
  private recordSideAnswer(question: string, answer: string): void {
    const content = answer
      ? `【边干边答记录】用户刚才问：「${question}」，宿主已旁答：「${answer}」。知悉即可，后续输出与此口径一致，不必再答一遍。`
      : `【边干边答记录】用户刚才问：「${question}」，宿主暂时没答上。收尾时在输出里把这个问题答了。`;
    this.pendingSteers.push({
      message: { role: 'user', content, internal: true },
      target: this.hasDelegationInFlight() ? 'all' : 'parent',
      displayText: answer ? '' : question,
    });
  }

  /** 置信门的「问」在这里落地：分类器对一句破坏性插话（停/重开）明确报告了
   * 没把握时，不赌，把疑问一句话问出来。手头的活照跑；用户的回答作为新插话
   * 重新分类。同事拿不准你会问「你是要全停？还是先继续？」——而不是先拆了
   * 再说。ask 是旁路一次 LLM 调用（秒级），pending 的 ack 撑住这段空档。 */
  private async askMidrunClarification(decision: DynamicInsertionDecision, text: string, images: MessageImage[], ack: HTMLElement | null): Promise<void> {
    const llm = this.turnPhaseLlm ?? this.turnLlm;
    const gatedFrom = typeof decision.signals.gatedFrom === 'string' ? (decision.signals.gatedFrom as InputAction) : 'replan';
    const reading = gatedFrom === 'stop' ? '把当前任务停掉' : '推倒当前方向重来';
    const fallback = `先不动手——你是想${reading}吗？还是我理解偏了，说一声我就照办。手头的活先照旧。`;
    let question = '';
    if (llm) {
      const system = `The user typed something WHILE you are mid-task, and the router is genuinely unsure what they want. Its best reading: "${reading}" (confidence ${Math.round(decision.confidence * 100)}%). Ask ONE short confirming question in the user's language: name your best reading and ask them to confirm or correct it. Like a colleague who keeps working while asking — no apology, no filler, 1-2 sentences, no lists. Here is where the task stands:
<current_task>
${this.buildInsertionContext(images).slice(0, 2_000)}
</current_task>`;
      const request: import('../shared/types').Message[] = [
        { role: 'system', content: system },
        { role: 'user', content: text, images },
      ];
      try {
        question = (await llm.complete(request, [], this.abortController?.signal)).content?.trim() ?? '';
      } catch {
        // 问询失败就用模板问——问题必须落到用户面前，静默等于赌了一把。
      }
    }
    // 临时回执的历史使命完成：问题气泡接管对话。
    ack?.parentElement?.remove();
    const bubble = this.addBubble('assistant', '');
    bubble.textContent = question || fallback;
  }

  /** Queue an UNRELATED insert and make sure something will dispatch it. The
   * send() finally schedules the deferred dispatch only for turns that end
   * AFTER this point — a classification that lands after the turn already
   * finished (LLM judges can take seconds) would otherwise leave the queued
   * task or a RELATED insert frozen until the user's NEXT turn completed. */
  private queueInterjectTask(text: string, images: MessageImage[], displayText: string): void {
    this.pendingTasks.push({ text, images, displayText, ts: Date.now() });
    this.renderQueueCard();
    if (!this.isStreaming()) this.scheduleDeferred();
  }

  /** The visible to-do queue: ONE card in the transcript that re-renders as
   * items queue up and drain, instead of a system line per enqueue. A
   * colleague keeps a running list you can glance at — "待办队列更新：1… 2…"
   * — not a receipt for every entry. DOM-only by design: pendingTasks is live
   * state (a restored session has none), so there is nothing to re-render on
   * disk restore and nothing stale to clean up. */
  private renderQueueCard(): void {
    if (this.pendingTasks.length === 0) {
      this.queueCardEl?.parentElement?.remove();
      this.queueCardEl = null;
      return;
    }
    if (!this.queueCardEl) {
      const wrapper = document.createElement('div');
      wrapper.className = 'bubble-row status';
      const bubble = document.createElement('div');
      bubble.className = 'bubble status hl-info queue-card';
      wrapper.appendChild(bubble);
      this.appendToTranscript(wrapper);
      this.queueCardEl = bubble;
    }
    const bubble = this.queueCardEl;
    bubble.textContent = '';
    const title = document.createElement('div');
    title.className = 'queue-card-title';
    title.textContent = `⏳ 待办队列（${this.pendingTasks.length} 件）——当前任务完成后依次处理`;
    bubble.appendChild(title);
    const list = document.createElement('ol');
    list.className = 'queue-card-items';
    for (const t of this.pendingTasks) {
      const item = document.createElement('li');
      item.textContent = t.displayText.length > 60 ? `${t.displayText.slice(0, 60)}…` : t.displayText;
      list.appendChild(item);
    }
    bubble.appendChild(list);
    // 活卡必须活在"现在"：第一版可能落进早已归档的旧回合块（折叠/收起后
    // 更新就没人看得见了），有在飞回合就把它挪进当前回合——计划卡同款处理。
    const wrapper = bubble.parentElement;
    if (wrapper && this.liveTurn) this.liveTranscript.moveNodeToTurn(wrapper, this.liveTurn);
  }

  /** 把定了时刻的插话交给能定时的那一层（main.ts 的持久化队列）。返回 true
   *  = 已接管，现在什么都不做。没有宿主队列（CLI / 单测）时返回 false，调用方
   * 按原有目的地处理——话一定会跑到，只是按"当前任务之后"而不是指定时刻。 */
  private deferTimedInsert(timing: InputTiming, text: string, images: MessageImage[], displayText: string): boolean {
    const at = timing.at;
    if (!at || !timedInputSink) return false;
    if (!timedInputSink({ text, images, displayText, at, timingText: timing.text })) return false;
    this.addBubble('user', displayText, images);
    const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    this.addStatusBubble(`⏳ 已排期：${describeTiming(timing)}执行「${preview}」，当前任务不受影响。`, false, false, 'info');
    return true;
  }

  /** 阶段判据：还有在飞的并行委派吗（agentActivities 首见即入列，
   * 终态只改 status——有 running 就说明委派还没收齐）。 */
  private hasDelegationInFlight(): boolean {
    return this.agentActivities.some((item) => item.status === 'running');
  }

  /** 阶段感知：把插话折入当前任务的汇合轮。用户原话照常上屏（气泡）。
   * mechanical=true（scope 追加）：汇合边界直接把这项跑完、把结果喂给汇总
   * 轮——顺序由机制保证；mechanical=false（steer 类）：注入强框架指令。
   * 两者收尾都核验，没兑现就转排队兜底，话绝不丢。 */
  private foldInScopeAddition(text: string, images: MessageImage[], displayText: string, mechanical: boolean, ack: HTMLElement | null = null, cancels = false): void {
    const bubble = this.addBubble('user', displayText, images);
    this.placeAckAfterEcho(ack, bubble);
    this.pendingFoldIns.push({ text, images, displayText, delivered: false, activityCountAtDelivery: -1, mechanical, cancels });
    // 取消型折入（2026-09-24 取消案例）：回执必须说"拿掉"，绝不能沿用追加
    // 口径——案例里用户收掉一项，回执却说"先补这项"，与意图正好相反。
    // 不说"调研"——折入的可能是任何活，点名的任务类型说错了才突兀。
    this.settleAck(ack, cancels
      ? '收到——这项收掉了，不进最终汇总；其余照跑，收齐后只合并剩下的。'
      : '已收到——正在跑的活收齐后先补这项，再合并出一份覆盖全部的汇总。');
  }

  /** 引擎侧的折入指令：命令式框架，把"别光汇总"说死——模型在汇合轮看到
   * 的不是一句转达，而是排定的追加委派。 */
  private foldInInstruction(text: string): string {
    return `【中途追加的任务，不是闲聊】用户要求在本次任务里追加：${text}\n执行要求：把这项追加的工作像其他委派一样派出去做完；拿到结果后，把它与本次任务已产出的全部内容合并，输出一份覆盖所有对象的最终汇总。在此之前不要输出最终汇总。`;
  }

  /** 取消型折入的汇合轮框架（2026-09-24 取消案例）：与追加框架反着说死——
   * 不许为它派新委派、部分产出不算结论不进汇总；幸存分支照常合并，取消
   * 用一句话入账。没有这个框架，取消在汇合轮会被追加口径（"派出去做完…
   * 覆盖所有对象"）反向执行。 */
  private cancelFoldInstruction(text: string): string {
    return `【中途取消，不是追加】用户中途收掉了这项工作：${text}\n执行要求：不要再为它派任何委派；已经跑出的相关部分不算结论、不写入最终汇总（用户没说要保留）。委派收齐后，最终汇总只覆盖剩下的对象，并用一句话交代这项已按要求取消。`;
  }

  /** 折入没被照办时的兜底口径（转排队后作为新指令重入）。 */
  private foldInFollowUpText(text: string): string {
    return `（中途追加）${text}\n把这项追加的工作做完，然后把结果与此前任务的产出合并，输出一份覆盖全部对象的完整汇总（此前的产出在会话历史里）。`;
  }

  /** 收尾核验折入的追加：机械执行成功的直接算数；指令注入的看投递后
   * agentActivities 是否有新增（真的发起了新委派）。都没有（模型直奔汇总）
   * 或根本没投递（回合提前终止）→ 转 pendingTasks 按合并口径补跑。由
   * dispatchDeferred 在回合收尾时调用。 */
  private settleFoldIns(): void {
    for (const fold of this.pendingFoldIns.splice(0)) {
      // 取消型折入不做"补跑"兜底（2026-09-24 取消案例）：排除一项永远不会
      // 产生新委派活动，按追加的水位核验它恒算"没照办"；而取消一旦错过
      // 汇合轮也无法事后补——转排队只会把"取消"当活重跑（反向伤害）。未
      // 照办的取消接受为残差（与轻转向同款），靠汇合轮框架 + 协议文本保证。
      if (fold.cancels) continue;
      const honored = fold.mechanicallyDone || (fold.delivered && this.agentActivities.length > fold.activityCountAtDelivery);
      if (honored) continue;
      this.pendingTasks.push({ text: this.foldInFollowUpText(fold.text), images: fold.images, displayText: fold.displayText, ts: Date.now() });
    }
  }

  /** Schedule the deferred dispatch just after a turn fully finalizes. */
  private scheduleDeferred(): void {
    window.setTimeout(() => this.dispatchDeferred(), 40);
  }

  /** After the current turn is over:
   *  - a goal-change insert → immediately re-enter the same task with it (fold in).
   *  - else, steers that never reached a THINK boundary (queued in the turn's
   *    final seconds) → send them as a normal message, so nothing typed is lost.
   *  - else, if a queued task waits AND the task is terminal (no auto-continue
   *    pending) → start it as a fresh task.
   * The isStreaming guard makes overlapping schedules (turn finalize + a late
   * interject classification) safe: the first dispatch enters send(), which
   * flips streaming on synchronously, and the second becomes a no-op instead
   * of starting a second concurrent turn. */
  private dispatchDeferred(): void {
    if (this.isStreaming()) return;
    // 回执的账在这里结：收尾派发点就是"承诺的动作已兑现"的时刻——停的收尾
    // 落定、被留下的插话正要重入、排队的活开始交接，微光都该停了。
    this.settleInterjectReceipts();
    // 折入追加的收尾核验先行：没被照办的转进 pendingTasks，下面同一趟
    // dispatchDeferred 就会把它们作为新指令派发出去。
    this.settleFoldIns();
    if (this.relatedInsert) {
      const ri = this.relatedInsert;
      this.relatedInsert = null;
      this.autoContinue.cancel(); // folding in supersedes the '继续' chain
      void this.send(ri.text, ri.images, ri.displayText);
      return;
    }
    // 插话重构 — steers left over when the turn already ended never reached a
    // THINK boundary. A colleague would just say them out loud as the next
    // thing to do; so does pure: they open the next turn as the user's words.
    // 1a 定向投递 + 渲染一致性：重入用用户原话（displayText），不是引擎框架
    // 文——开场气泡、存档、重载看到的都是用户自己说的话。点名某支但那支已
    // 收工的也一样：话不丢，作为用户的新指令重开。1b 旁答记录按账处置：答
    // 上的（displayText 空）账已清，残留即弃；没答上的把问题原话重入。
    const leftoverSteers = this.pendingSteers.filter((entry) => !entry.message.internal || entry.displayText);
    this.pendingSteers = []; // 没被带走的只剩「已答上的旁答记录」——账已清，弃
    if (leftoverSteers.length > 0) {
      const drained = leftoverSteers;
      this.autoContinue.cancel(); // the user's own words supersede '继续'
      const text = drained.map((entry) => entry.displayText || entry.message.content).join('\n');
      void this.send(text, drained.flatMap((entry) => entry.images ?? []));
      return;
    }
    if (this.pendingTasks.length > 0 && !this.autoContinue.pending) {
      const t = this.pendingTasks.shift()!;
      const remaining = this.pendingTasks.length;
      // 交接先说一声再动手（队列卡同步收掉这项/空了撤卡）——用户的下一句
      // 话凭空开始跑，没有这句衔接读起来就是无中生有。
      this.renderQueueCard();
      this.addStatusBubble(remaining > 0
        ? `手头的活收尾了——先处理排队的，这后面还排着 ${remaining} 件。`
        : '手头的活收尾了——现在处理刚才排下的那件。', false, false, 'info');
      void this.send(t.text, t.images, t.displayText);
    }
  }

  /** 11.2 — how a path-repair note puts the original draft back in the
   *  composer. This controller does not own the composer; the shell (main.ts)
   *  registers it via SessionChatManager.onRestoreDraft. */
  onRestoreDraft(fn: (text: string) => void): void {
    this.restoreDraftHandler = fn;
  }

  async send(userText: string, userImages: MessageImage[] = [], displayUserText = userText, isAuto = false, userAttachments: import('../shared/types').MessageAttachment[] = [], attachmentViewer?: (attachment: import('../shared/types').MessageAttachment) => void, userPathRepairs: PathRepair[] = []) {
    const chatEl = this.scrollRoot();
    wireScrollPin(chatEl);
    wireNewContentHint(chatEl);
    // A held insert re-entering here cashes its receipt ("马上按新的方向来" —
    // it just did); a fresh user send cashes any stray one the same way.
    this.settleInterjectReceipts();
    const config = loadConfig();
    if (!hasConfiguredKey(config)) return;
    // A fresh turn's signals supersede any that were never consumed (defensive;
    // the finally of a completed turn always consumes them).
    this.pendingAutoContinue = null;

    // First-token observability: one timing record per send attempt. The stage
    // stamps are filled in at each pre-request await below; the record is
    // committed in the turn's finally (generation-guarded so a turn superseded
    // by a session switch never writes into the session the user switched TO).
    const turnStartMs = performance.now();
    const turnTiming: TurnTiming = { ts: Date.now(), ttftMs: null, routeMs: null, probeMs: null, contextMs: null, totalMs: null };
    // First STREAMED byte counts — reasoning deltas open the visible card just
    // like answer text, so both TokenDelta and ReasoningDelta mark through here.
    const markFirstToken = (): void => {
      if (turnTiming.ttftMs === null) turnTiming.ttftMs = Math.round(performance.now() - turnStartMs);
    };

    // A previous turn may have queued an idle pre-compaction pass. Cancel it
    // before handling this input so an optimization can never compete with the
    // user's first frame or the new turn's setup.
    this.cancelBackgroundPreCompaction();

    // MCP prompt command: `/mcp-prompt <server__name> [key=value …]` is
    // expanded to the server's template BEFORE the turn is committed, so
    // history, intent analysis, and the engine all see the template itself
    // while the transcript keeps showing the command the user typed.
    //
    // Skipped when the caller already passed a distinct display text: the
    // composer expands the draft itself (so a failed expansion keeps the text
    // in the box) and hands the template over as userText.
    if (!isAuto && displayUserText === userText) {
      // E2.2 —「把这个做法沉淀成技能」：元指令，不进引擎。拦在 beginLiveTurn
      // 之前自己渲染气泡，失败也不留 ghost 消息。
      if (matchSkillDistillInstruction(userText) !== null) {
        await this.runSkillDistill(userText);
        return;
      }
      const expansion = await this.expandMcpPromptCommand(userText);
      if (expansion?.ok === false) {
        showToast(expansion.error);
        return;
      }
      if (expansion?.ok) {
        displayUserText = userText;
        userText = expansion.text;
      }
    }

    // IMMEDIATE feedback: the user's own message renders synchronously here,
    // BEFORE any await below (workspace resolve, memory harvest, runtime
    // probe, LLM plan generation up to 8s, interactive review). Delaying it
    // made complex tasks feel like the submit didn't register — the transcript
    // stayed frozen while the pre-flight silently ran. If the plan review is
    // then cancelled, the bubble is removed (see the cancel branch) so no
    // ghost message remains.
    const liveTurn = this.beginLiveTurn(displayUserText || userText);
    const userBubble = this.addBubble('user', userText);
    const userMessageAttachments = userAttachments.length > 0 ? userAttachments : undefined;
    const openUserAttachment = attachmentViewer;

    if (displayUserText !== userText || userImages.length > 0) {
      userBubble.textContent = displayUserText;
      renderUserImageAttachments(userBubble, userImages);
      for (const attachment of userAttachments) {
        // Images already render as thumbnails above (renderUserImageAttachments
        // from userImages) — don't double them as a full attachment card.
        if (attachment.kind === 'image') continue;
        userBubble.appendChild(renderAttachmentCard(attachment, () => openUserAttachment?.(attachment)));
      }
    }

    // 11.2 — path slips: the bubble keeps the user's OWN words (displayUserText),
    // the note names what pure read instead, and one click puts the original
    // draft back in the composer. Appended AFTER the block above, which
    // rewrites the bubble's textContent and would otherwise wipe the note.
    const repairNote = createPathRepairNote(userPathRepairs, () => this.restoreDraftHandler?.(displayUserText));
    if (repairNote) userBubble.appendChild(repairNote);

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
    // 阶段 12: a new send IS the resume (or a fresh task) — the paused-turn
    // affordance has served its purpose the moment anything streams again.
    this.dismissPausedResumeBar();

    // The activity panel is task-scoped: a continuation keeps the existing
    // rows, while a new top-level task starts a fresh collaboration trace.
    const preserveAgentActivities = this.activeComplexPlan !== null && this.hasHistory;
    this.agentActivityHistorical = false;
    if (!preserveAgentActivities) {
      this.agentActivities = [];
      this.removeAgentActivityPanel();
    }
    const subagentProgress: SubagentProgress = {
      onStart: (a) => {
        if (gen !== this.generation) return;
        this.updateAgentActivity(a);
      },
      onState: (a) => {
        if (gen !== this.generation) return;
        this.updateAgentActivity(a);
      },
      onTool: (a) => {
        if (gen !== this.generation) return;
        this.updateAgentActivity(a);
      },
      onDone: (a) => {
        if (gen !== this.generation) return;
        this.updateAgentActivity(a);
      },
      onError: (a) => {
        if (gen !== this.generation) return;
        this.updateAgentActivity(a);
      },
    };
    // The plan-card snapshot belongs to this turn only; a follow-up simple
    // task must not re-attach a stale card from a previous complex plan.
    // The fixed progress pin is stale too — if this same turn spawns a new
    // plan, showPlanCard remounts it with the fresh plan.
    if (!this.activeComplexPlan) {
      this.detachActivePlanProgress();
      this.activePlanProgress = null;
      this.activePlanCardSnapshot = null;
    }
    // Create the turn controller before any preflight await. Previously the
    // controller and streaming state were installed only after workspace
    // resolution, so Stop/Escape could not interrupt a slow startup probe.
    const turnController = new AbortController();
    // 1c 升级硬停第二通道：暂停的宽限窗口里再叫停时，用它立即掐掉在飞工具
    // （主 controller 已 abort，规范规定二次 abort 是 no-op，换不掉 reason）。
    const turnHardStop = new AbortController();
    this.abortController = turnController;
    this.hardStopController = turnHardStop;
    this.setStreaming(true);
    // Set by the Interrupted(paused) branch; the release path must not eat the
    // 「继续」 bar it just showed. Any other ending clears a stale pausing notice.
    let pausedThisTurn = false;
    const releaseSupersededTurn = (): void => {
      if (this.abortController !== turnController) return;
      this.setStreaming(false);
      this.abortController = null;
      this.hardStopController = null;
      if (!pausedThisTurn) this.dismissPausedResumeBar();
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
      this.finishLiveTurn(liveTurn);
      releaseSupersededTurn();
      return;
    }
    linkifyPaths(userBubble);
    // Background sessions run their auto-continue chains inside the same
    // shared scroll container: yanking the viewport here used to drag the
    // session the user is ACTUALLY reading every ~1.2s. Fresh-turn re-pinning
    // is explicit intent only for the visible transcript.
    if (this.viewActive) {
      forceScrollToBottom(chatEl);
      hideNewContentHint(); // a fresh user turn resumes following the newest content
    }

    // Stage 1 of the turn-route decision (turnRoute.ts): the synchronous half,
    // needed before the workspace await below. `workspaceFree` is deliberately
    // narrower than "no router needed" — a conversational turn like "现有页面很难看，
    // 从哪些设计方向改善" still wants to read the code, so it must keep its
    // workspace. The async half re-runs nothing here: it receives this object.
    const routePrefetch = prefetchTurnRoute(userText, userImages);
    const fastConversationalTurn = !sendWorkspace && routePrefetch.workspaceFree;
    const effectiveWorkspace = sendWorkspace || (fastConversationalTurn ? '' : await withAbortTimeout(
      getApplicationTmpWorkspace(sendSessionId),
      turnController.signal,
      5_000,
      'workspace resolution',
    ).catch((error: Error) => {
      if (error.name === 'AbortError') return '';
      console.warn('[pure] workspace resolution timed out; continuing without a workspace:', error.message);
      return '';
    }));
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
      this.finishLiveTurn(liveTurn);
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
    // write/edit/replace tool results only. `op` records HOW the file came to
    // exist: 'edit' = an existing file modified in place — planArtifactDisplay
    // treats that as a must-show signal, because it is the file the user
    // handed over and they must be told where it ended up.
    const turnArtifacts: ArtifactItem[] = [];
    // 是否本轮真实交付了项目（projectDelivered 命中：非中断、且验证/计划/任务满足
    // 交付条件）。仅在此时把 artifact 块持久化进 transcript——否则一个"写到一半被中断
    // /未验证"的回合会把目录卡片写进历史，切回会话时错误重现。声明在最前以覆盖所有
    // persistSession 调用点（含计划暂停的早期分支）。
    let deliveredThisTurn = false;
    const artifactSeen = new Set<string>();
    const addArtifact = (path: string, op: 'edit' | 'create'): void => {
      const key = path;
      if (artifactSeen.has(key)) return;
      artifactSeen.add(key);
      const norm = path.trim().toLowerCase().replaceAll('\\', '/').replace(/^\.\//, '');
      const version = this.fileWriteVersions.get(norm) ?? 1;
      // Only 'edit' is materialized (see transcriptProjection.artifactsFromToolExecs).
      const item: ArtifactItem = op === 'edit' ? { path, version, op } : { path, version };
      turnArtifacts.push(item);
      if (!this.sessionArtifactSeen.has(norm)) {
        this.sessionArtifactSeen.add(norm);
        this.sessionArtifacts.push(item);
      }
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
    // Last COMPLETED row per stable call key (tool + sorted args). When the
    // model repeats an identical call (continuation rounds love re-listing /
    // re-reading), the engine reuses the result and the UI re-points at this
    // card instead of appending a second identical one.
    const completedToolRowKeys = new Map<string, ToolRowEntry>();
    const pendingByName = new Map<string, ToolRowEntry>();
    // Per-call throttle for tool-call JSON re-parses (keyed by toolCallId or
    // staged tool name). Streaming a giant argument (write_file `content`, a
    // whole HTML file) grows the buffer to tens of KB; re-parsing it AND
    // re-rendering the Input panel on every token freezes the UI mid-stream
    // ("stuck with only the blinking cursor"). See the TokenDelta handler.
    const toolCallRefresh = new Map<string, number>();
    /** Collapse target for a repeated identical call: the completed card with
     *  the same tool + args (see completedToolRowKeys), or null. */
    const tryCollapseDuplicateRow = (toolName: string, args: Record<string, unknown> | undefined): ToolRowEntry | null => {
      if (!args) return null;
      return completedToolRowKeys.get(`${toolName}::${stableArgsStringify(args)}`) ?? null;
    };
    type LiveToolOutputLine = { kind: 'stdout' | 'stderr'; line: string; progress?: boolean };
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
          appendToolStreamLine(entry.row, next.kind, next.line, next.progress);
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
    const unregisterToolOutput = registerToolOutputListener((toolCallId, kind, line, progress) => {
      if (gen !== this.generation) return;
      const entry = pendingRows.get(toolCallId);
      if (!entry || !entry.row.details.classList.contains('pending')) return;
      if (Number(entry.row.resultEl.dataset.streamLines ?? 0) >= MAX_LIVE_STREAM_LINES) return;
      const queued = liveToolOutputQueue.get(toolCallId) ?? [];
      // The final ToolResult still carries the complete output. The live DOM
      // only needs a bounded preview, so never let a chatty command build an
      // unbounded queue that can starve keyboard and click events.
      if (queued.length >= MAX_LIVE_STREAM_LINES) return;
      queued.push({ kind, line, progress });
      liveToolOutputQueue.set(toolCallId, queued);
      scheduleLiveToolOutputFlush();
    });
    // Live download progress: download_file streams machine-readable progress
    // (via downloadHub on the Node build, or registerDownloadProgressListener on
    // the Tauri build). Render it as a progress bar inside the tool row.
    const downloadBars = new Map<string, DownloadBarState>();
    const unregisterDownloadProgress = registerDownloadProgressListener((toolCallId, p) => {
      if (gen !== this.generation) return;
      const entry = pendingRows.get(toolCallId);
      if (!entry) return;
      // A failed download must not leave a visible progress bar — tear it down
      // and forget it (only successful downloads keep a bar). No-op if a bar
      // was never created.
      if (p.state === 'hidden') {
        const existing = downloadBars.get(toolCallId);
        if (existing) {
          downloadBars.delete(toolCallId);
          existing.wrap.remove();
        }
        return;
      }
      const row = entry.row;
      let bar = downloadBars.get(toolCallId);
      if (!bar) {
        if (row.toolName !== 'download_file') return;
        bar = createDownloadBarEl(row, toolCallId);
        downloadBars.set(toolCallId, bar);
      }
      const now = performance.now();
      let speed = p.speed;
      if (speed === 0 && bar.lastTs > 0) {
        const dt = (now - bar.lastTs) / 1000;
        if (dt > 0) speed = (p.downloaded - bar.lastDownloaded) / dt;
      }
      bar.lastDownloaded = p.downloaded;
      bar.lastTs = now;
      const pct = p.percent >= 0 ? p.percent : 0;
      bar.fill.style.width = `${pct}%`;
      const sizeStr = p.total > 0 ? `${formatBytes(p.downloaded)} / ${formatBytes(p.total)}` : formatBytes(p.downloaded);
      const speedStr = speed > 0 ? ` · ${formatBytes(speed)}/s` : '';
      const viaStr = p.via ? ` · ${p.via}` : '';
      if (p.state === 'done') {
        bar.wrap.classList.add('download-done');
        bar.pauseBtn.style.display = 'none';
        bar.label.textContent = `完成 · ${formatBytes(p.downloaded)}`;
      } else if (p.state === 'error') {
        bar.label.textContent = '下载出错';
      } else {
        bar.label.textContent = `${pct}%${p.total > 0 ? '' : '?'}${speedStr}${viaStr} · ${sizeStr}`;
      }
    });
    // toolCallId → outcome, replayed as status rows (StoredMessage.toolExec)
    // when the session is restored from storage.
    const toolResults = new Map<string, ToolExecMeta>();
    // Subagent interior activity, round-tripped through the engine: CodingAgent
    // publishes orchestrator progress onto this fanout, the engine re-emits it
    // as SubagentActivity events (namespaced by the delegation toolCallId), and
    // the event loop below streams the lines into the matching delegation card.
    // The trace also lands in toolResults, so session replay restores the full
    // run narrative instead of a bare final output.
    const subagentEventFanout = new EventFanout<SubagentActivityEvent>();
    const subagentTraceByCall = new Map<string, string[]>();
    // Tool-round grids: tool calls issued in the SAME LLM iteration (e.g. two
    // parallel web_search calls) render side by side so the transcript reads
    // "running simultaneously" instead of a vertical stack of identical rows.
    // Cards group into CONSECUTIVE same-kind runs (toolCardKind): a plain tool
    // probe and subagent delegation cards never share one row — [sys_info,
    // agent×3] reads as one setup step above a row of three parallel
    // colleagues. A kind change opens a new row BELOW, never back into an
    // earlier row, so the timeline stays monotone (no visual reordering). A
    // single-card run is full-width (grid collapses to one column). Closed by
    // the next StateChange → THINK.
    let roundGrid: { el: HTMLElement; kind: ToolCardKind } | null = null;
    const appendToolRow = (toolName: string, args: Record<string, unknown>, kind: ToolCardKind): ToolRowHandle => {
      // Tool calls interrupt text streaming — the bubble above the new row
      // stops blinking now, not at turn completion (see above).
      finalizeStreamingSegments();
      if (!roundGrid || roundGrid.kind !== kind) {
        const el = document.createElement('div');
        el.className = toolGridClass(kind);
        this.appendToTranscript(el);
        roundGrid = { el, kind };
      }
      return this.addToolRow(toolName, args, roundGrid.el);
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
    // Stall watchdog: some engine phases emit NO events for a long time —
    // VERIFY rule checks (up to 60s), failure-policy backoff sleeps, context
    // summarization — and during those windows the UI looks frozen ("卡了？").
    // Every 3s while this turn streams: if NOTHING on screen shows a live
    // indicator, open the animated waiting card. Cheap no-op whenever any
    // other indicator (thinking card, tool rows) is already visible.
    const stallWatchdog = window.setInterval(() => {
      if (gen !== this.generation || this.abortController?.signal.aborted) {
        clearInterval(stallWatchdog);
        return;
      }
      if (!thinkingCard && pendingRows.size === 0 && pendingByName.size === 0) {
        scheduleToolGapCard();
      }
    }, 3000);
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
      resetThinkingLabelForOutput(thinkingCard);
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
      this.appendToTranscript(card.el);
      // Slow-reasoning / local models have a longer time-to-first-token: the
      // slow-response hint must wait for THIS provider's typical latency
      // instead of a fixed 15s that would cry wolf on deepseek-reasoner.
      startThinkingTimer(card, {
        hintAfterMs: firstTokenHintTimeoutMs(config.provider, config.model || customDefaultModel(config.customProviders ?? [], config.provider)),
      });
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
      const probeStartMs = performance.now();
      const probe = ensureRuntimesProbed(this.abortController?.signal);
      // 输在竞争里的那一侧（探针慢于软等待、或中止事件后到）不得变成未处理 rejection。
      probe.catch(() => {});
      await Promise.race([probe, new Promise<void>((resolve) => setTimeout(resolve, PROBE_SOFT_WAIT_MS))]);
      turnTiming.probeMs = Math.round(performance.now() - probeStartMs);
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
      this.turnLlm = llm;
      // 9.2 — per-phase model routing (experimental). Each phase naming a
      // different model gets its own same-provider adapter through the shared
      // factory; blank / main-model entries fall through to `llm` via the E0.3
      // fallback contract (llmForPhase). Built once per turn — the factory
      // resolves provider key + protocol and is not free.
      const phaseOverrides = phaseModelOverrides(config.phaseModels, config.model);
      const phaseAdapters = new Map<EngineLlmPhase, LLMAdapter>();
      for (const [phase, model] of Object.entries(phaseOverrides) as [EngineLlmPhase, string][]) {
        phaseAdapters.set(phase, createLLMAdapter({ ...config, model }));
      }
      const llmFor = phaseAdapters.size > 0
        ? (phase: EngineLlmPhase) => phaseAdapters.get(phase)
        : undefined;
      // 插话重构 — side-channel mid-run questions answer on the REFLECT-phase
      // (cheap) adapter when routing is on, else the main model.
      this.turnPhaseLlm = phaseAdapters.get('REFLECT');
      const toolAdapter = this.getOrCreateSessionToolAdapter(effectiveWorkspace, config, sendSessionId);
      this.snapshotPort = toolAdapter.getSnapshotPort?.();
      this.onSnapshotChanged?.(!!this.snapshotPort?.getLatestWriteBatch());

      // Skill toggles: when a skill is disabled, drop its matching subagent so
      // the LLM can't delegate work it would expect to succeed (web_researcher
      // ↔ web-research, code_reviewer ↔ code-review, planner ↔ planning).
      // `undefined` keeps the full built-in set (CodingAgent defaults to
      // BUILT_IN_SUBAGENTS).
      // BUILT_IN_SUBAGENTS (code_reviewer / project_auditor) plus the coding
      // roles (task_planner / code_editor / deep_thinker / ui_designer /
      // bash_executor / researcher). Skill toggles gate by role name.
      const allSubagents = [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES];
      // 阶段 13.2 — declarative roles from ~/.pure/subagents/ join the
      // delegation surface. They skip the skill toggles (they aren't skills)
      // and can never shadow a built-in (the compiler rejects the collision).
      const externalSubagents = await loadGuiExternalSubagents();
      // 13.3 — overlays load alongside the roles; unknown-role files are
      // rejected at compile time against the full delegable surface.
      const personaOverlays = await loadGuiPersonaOverlays(
        [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES, ...externalSubagents].map((d) => d.name),
      );
      const subagents = (() => {
        const keep = allSubagents.filter((def) => {
          if (def.name === 'task_planner') return config.skills?.planning ?? true;
          if (def.name === 'code_reviewer') return config.skills?.['code-review'] ?? true;
          if (def.name === 'project_auditor') return config.skills?.['code-review'] ?? true;
          if (def.name === 'researcher') return config.skills?.['web-research'] ?? true;
          return true;
        });
        const kept = keep.length === allSubagents.length ? undefined : keep;
        if (!externalSubagents.length) return kept;
        return [...(kept ?? allSubagents), ...externalSubagents];
      })();

      // Names of every subagent the model may delegate to — used to tag a
      // subagent's tool row so its activity card can trace back to it (Word-
      // comment style) and so trivial requests can stay single-agent.
      const subagentNames = new Set((subagents ?? allSubagents).map((d) => d.name));

      // Refresh mode + handler for this turn so a settings change (e.g.
      // toggling "自动放行命令") takes effect immediately on the next send
      // while keeping the session's approval cache alive.
      this.permissionManager.setMode(mapPermissionMode(config.permissionMode));
      this.permissionManager.setRequestHandler(createPermissionHandler(
        config,
        () => this.transcriptTarget(),
        this.sessionId || sendSessionId,
      ));

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
        llmFor,
        // 插话重构 — the engine pulls queued steers at each THINK boundary, so
        // a mid-run remark lands in the very next reasoning round instead of
        // killing the turn. 1a 定向投递：拉取者自带身份（分支由编排器包上
        // branchCallId/branchName，不带参 = 父引擎），按身份过滤投递与消费。
        takeSteerMessages: async (recipient) => {
          const isBranch = Boolean(recipient?.branchCallId);
          const drained: import('../shared/types').Message[] = [];
          const remaining: typeof this.pendingSteers = [];
          // 投递/消费语义（steerTargeting 单一口径）：点名条目只给被点名的那
          // 一支、也只有它能取走；广播条目在飞分支人人可读（复制），只有父
          // 边界能收走——话在回合收尾时仍归父处置，绝不因分支读过就丢。
          for (const entry of this.pendingSteers) {
            if (steerDeliversTo(entry.target, recipient)) drained.push(entry.message);
            if (!steerConsumedBy(entry.target, recipient)) remaining.push(entry);
          }
          this.pendingSteers = remaining;
          // 折入只在父引擎边界（非分支拉取）且没有在飞委派时交付——那恰好是
          // 父任务的汇合轮。旧实现靠"在飞恒 true"挡子代理偷折入，现在分支
          // 拉取被身份检查结构性排除，闸门只留父级时序这一职责。
          if (!isBranch && !this.hasDelegationInFlight()) {
          // 指令型折入：合并口径框架随转向通道注入。scope 追加（mechanical）
          // 不在这里交付——它们走 takeSyntheticToolCalls 的代执行回合（见下），
          // 这里只提前铺一句合并口径，交付标记留给代执行闭包。
          for (const fold of this.pendingFoldIns) {
            if (fold.delivered || fold.mechanical) continue;
            fold.delivered = true;
            fold.activityCountAtDelivery = this.agentActivities.length;
            drained.push({ role: 'user', content: fold.cancels ? this.cancelFoldInstruction(fold.text) : this.foldInInstruction(fold.text), images: fold.images });
          }
          // 代执行回合的合并口径（每条折入只铺一次）：本轮系统将直接委派执行
          // 追加项，模型下一个 THINK 才被咨询——这句话先入档，让"合并全部
          // 产出"成为它睁眼后的自然任务。
          for (const fold of this.pendingFoldIns) {
            if (fold.delivered || !fold.mechanical || fold.mergeFramed) continue;
            const role = this.agentActivities[this.agentActivities.length - 1]?.agentName;
            if (!role) continue;
            fold.mergeFramed = true;
            drained.push({
              role: 'user',
              content: `【系统接管执行】用户中途追加的任务「${fold.text}」将在本轮由系统直接委派给 ${role} 执行，结果稍后回收到本对话。请在追加结果回收后，把本次任务全部产出（含这项追加）合并，输出一份覆盖所有对象的最终汇总。`,
              images: fold.images,
            });
          }
          }
          return drained;
        },
        // 代执行回合（2026-09-22 插话重设计）：委派收齐后的第一个 THINK 边界，
        // 宿主把 scope 追加包成普通委派调用交还引擎——引擎跳过本轮模型调用，
        // 让这些调用走原生 ACT 管线（ToolStarted 出卡片、SubagentActivity 流
        // 明细、ToolResult 收尾入档、会话回放恢复）。顺序由结构保证：追加结果
        // 落地前模型不会被咨询，"先汇总再补跑"没有发生的材料；卡片和正常委派
        // 完全同源，不再手搓任何 UI（此前的合成卡片/事件泵/思考卡接管全删）。
        takeSyntheticToolCalls: async () => {
          if (this.hasDelegationInFlight()) return [];
          const calls: ToolCall[] = [];
          for (const fold of this.pendingFoldIns) {
            if (fold.delivered || !fold.mechanical) continue;
            const role = this.agentActivities[this.agentActivities.length - 1]?.agentName;
            if (!role) continue;
            fold.delivered = true;
            fold.activityCountAtDelivery = this.agentActivities.length;
            const callId = `foldin_${Date.now()}_${calls.length}`;
            fold.syntheticCallId = callId;
            // 恰好一行的因果叙述：把"追加"和"第三张卡"在对话流里接起来。
            this.addStatusBubble(`你追加的安排上了——派 ${role} 单独补跑，跑完和前面的产出一起汇总。`, false, false, 'info');
            // 子代理没有对话上下文——fold.text 是用户原话速记（"新增一个平台，
            // 爱奇艺"），原样当任务书它只能瞎猜调研对象（2026-09-22 实测跑成了
            // 爱奇艺开放平台 API 文档）。任务书必须带上主任务原文，并约束它
            // 只补追加项、口径与兄弟调研对齐。
            const brief = `用户的主任务：「${userText}」。任务进行中用户追加了新要求：${fold.text}。请只针对这项追加内容完成工作，口径与主任务其他部分一致（如调研需给出时间范围、来源、关键事实与遗留风险），不要重复主任务已覆盖的其他对象。`;
            calls.push({ id: callId, index: calls.length, function: { name: role, arguments: JSON.stringify({ prompt: brief }) } });
          }
          return calls;
        },
        toolAdapter,
        subagents,
        personaOverlays,
        // In-memory subagent checkpoint store: lets the GUI resume a sub-task
        // after a stop + continue in this same conversation.
        stateStore: this.subagentStore,
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
        // E1.2 — cross-session failure history: traps past sessions recorded
        // in error_pattern memories escalate the failure ladder immediately.
        failureHistory: memoryEnabled
          ? failureHistoryFromMemories(memoryStore.list({ type: 'error_pattern', activeOnly: true }))
          : undefined,
        projectPath: effectiveWorkspace || undefined,
        workspaceAvailable: Boolean(effectiveWorkspace),
        promptAssembler,
        promptBudget: promptBudgetForProvider(config.customProviders, config.provider, config.model, config.providerOverrides),
        mcpClient: this.mcpClient,
        mcpServers: this.deferredInitDone ? undefined : (config.mcpServers ?? []),
        mcpExcludedPrefixes: config.mcpExcludedPrefixes,
        proxyUrl: effectiveProxyUrl(config.proxy, 'tools'),
        permissionManager: this.permissionManager,
        // The engine verifier stays purely rule-based (non-empty-output check);
        // a hard failure there triggers an in-engine rewrite. No LLM re-check of
        // the final output surfaces internal verifier feedback to the user.
        verifier: createDefaultVerifier(),
        // Anti-stall guard: when the model ends its round with plain text while
        // plan stages remain, the engine re-enters THINK with a continue
        // directive instead of completing the turn. Independent of the
        // round-based auto-continue chain: the guard keeps the CURRENT turn
        // alive (bounded, 3 chances); the chain decides whether ANOTHER user
        // turn starts at all.
        continueGuard: config.planContinueGuard === false ? undefined : (args) => this.planContinueGuard(args),
        // Surface each spawned subagent as a live "which agent is working" card.
        subagentProgress,
        // And feed the same activity into the engine's event stream so the
        // delegation card can live-stream interior progress (see the
        // SubagentActivity case below).
        subagentEvents: subagentEventFanout,
      });
      // MCP warm-up: kick the transport handshake off HERE so it overlaps the
      // local preflight that follows, instead of being awaited on its own right
      // before the first model call. A cold stdio server (spawn + initialize)
      // used to spend the full budget serially in front of the first token.
      let mcpConnectPromise: Promise<void> | null = null;
      if (!this.deferredInitDone) {
        this.mcpSessionId = sendSessionId;
        this.mcpConfigSnapshot = JSON.stringify([config.mcpServers ?? [], effectiveProxyUrl(config.proxy, 'tools')]);
        this.mcpClient = codingAgent.mcpClient;
        if (this.mcpClient && !fastConversationalTurn) {
          this.deferredInitDone = true;
          mcpConnectPromise = this.mcpClient.connectAll().catch((err: Error) => {
            console.warn('[pure] MCP connection failed:', err.message);
          });
        }
      }
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
      const conventions = await loadGuiConventions(effectiveWorkspace || undefined);
      systemPrompt = buildSystemPrompt(!!effectiveWorkspace, usingTemporaryWorkspace, config, promptTools, imageGen, conventions);
      // 缓存本次真实装配的固定开销，供底部上下文窗口进度条读取（与引擎估算同口径）。
      this.contextOverhead = {
        system: estimatePromptTokens(systemPrompt),
        tools: estimateToolDefinitionTokens(promptTools),
      };
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
      // A request that is deterministically a low-stakes conversational
      // question (date/weather Q&A, casual questions) skips the hidden LLM
      // classification round trip entirely: the sync fallback already
      // reproduces the router's verdict for it, and on slow providers that
      // call alone costs 6-12s of dead time before the first visible token.
      // Stage 2: the ONE producer (turnRoute.ts). It runs the router when stage
      // 1 said it is needed, folds the result through the shared workflow
      // compiler, and records the whole decision — action, confidence, timing,
      // scope, and which layer decided — into the replayable log. The callers
      // below consume `route` / `workflow` exactly as the five separate
      // derivations used to produce them.
      const routeStartMs = performance.now();
      const turnRoute = await decideTurnRoute(routePrefetch, llm, {
        forcedMode,
        hasTools: !!effectiveWorkspace,
        continuingPlan,
        planPauseRequested,
        // The delivery gate follows the approved plan's build-ness across
        // turns, not the continuation prompt ("继续" must not silently lose
        // the gate, and an ordinary complex plan must not gain it).
        continuingProjectBuild: this.activePlanProjectBuild,
      }, this.abortController?.signal);
      // The hidden router round trip is the single largest pre-request cost
      // (6-12s on slow providers) — timing it is what makes that visible.
      turnTiming.routeMs = Math.round(performance.now() - routeStartMs);
      const semanticRoute = turnRoute.route;
      const workflow = turnRoute.workflow;
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
          this.addStatusBubble('⚠ 这项请求需要先做只读探针，但当前没有可用工作区工具，已降级为有限上下文执行。', false, false, 'warn');
          return;
        }
        if (!workspaceProfile || !taskContract) return;
        probeFindingsReported = true;
        if (isBareWorkspace(workspaceProfile)) {
          // “从零搭建”只在项目级构建语境下说；非构建请求没有可报告的探索结论。
          if (needsDeliveryGate) {
            this.addStatusBubble('当前工作区为空或尚未建立项目结构，将从零搭建。', false, false, 'info');
          }
          return;
        }
        this.addStatusBubble(`🔎 已完成项目探索：${workspaceProfileSummary(workspaceProfile)}`, true, false, 'info');
        this.addStatusBubble(`📋 已建立任务契约：${taskContract.acceptanceCriteria.length} 项验收标准，验证结果将决定是否交付。`, true, false, 'info');
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
        this.appendToTranscript(assessmentFlow.el);
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
      // 执行方案卡：把语义路由的决策（意图/复杂度/策略/风险/计划协作的子 agent
      // 名单）在 LLM 分析完成后、执行开始前呈现给用户——让"为什么这样拆、打算
      // 动用哪些角色"与计划/评估卡并列可见，而不是只在引擎内部消费。每轮只展示
      // 一次；继续轮与纯咨询不重复弹卡。
      let planSummaryShown = false;
      const maybeShowPlanSummary = (): void => {
        // Plan summary card REMOVED: it was redundant with the plan card (both
        // announce multi-agent delegation), used generic "这个问题" phrasing
        // that mismatched build intents, and its heavy bubble visual competed
        // with the plan card. The plan card alone communicates the stages.
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
          // 规则分析没有给出计划时（如强制计划模式遇到简单任务），用一条按用户真实
          // 诉求生成的起步步骤兜底，执行中由模型按实际情况推进，绝不假装“已经想清楚”，
          // 也绝不套用与上下文无关的“探明工作区现状”之类固定话术。
          let planForReview: Plan = analysis.plan ?? deriveFallbackPlan(userText);
          // E2.3 — 策略层的 parallelRoles 接进计划卡：这里与 buildContext 用同一
          // 份输入复算一次 select（纯计算，无副作用），把推荐里可并行的角色域
          // 对到独立的只读步骤上；批准后的提示词让模型把这些步的派发合并进同一
          // 轮，reads 并发池真正并行。
          const planStrategy = adaptiveControlPlane.select({
            prompt: userText,
            environment: {
              now: Date.now(),
              projectPath: sendWorkspace || undefined,
              hasWorkspace: Boolean(sendWorkspace),
              toolCount: effectiveWorkspace ? 1 : 0,
              verifierAvailable: true,
              memoryAvailable: true,
            },
            semantic: semanticRoute
              ? { tags: [semanticRoute.intent], complexity: semanticRoute.complexity, roles: semanticRoute.subagents }
              : undefined,
          });
          planForReview = markParallelPlanSteps(planForReview, planStrategy.parallelRoles);
          const showPlanCard = (plan: Plan, refining = false): void => {
            if (!planProgress) {
              // 新计划：本会话内计划编号 +1，并把触发它的用户输入带给卡头，
              // 让第 1 份计划与「新一轮计划」（因反馈而来）一眼可分。
              const planSeq = ++this.planSeqCounter;
              this.activePlanSeq = planSeq;
              planProgress = new PlanProgressModel(plan, 'active', 1, 1, needsDeliveryGate, planSeq, userText);
            } else if (planProgress.getSnapshot().plan !== plan) {
              // 同一规划在细化中换了步骤（planReplaced）：编号沿用，不递增。
              planProgress.dispatch({ type: 'planReplaced', plan });
            }
            if (planCard) {
              // Keep one stable, flat progress list in the transcript. Updating
              // its contents in place preserves the user's visual anchor and
              // makes later phase changes visible instead of replacing the
              // only plan card that appeared at the start.
              updatePlanCard(planCard, plan, refining, planProgress);
            } else {
              planCard = createPlanCard(plan, refining, planProgress);
              this.appendToTranscript(planCard.el);
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
          maybeShowPlanSummary();
          showPlanCard(planForReview);
          const approvePlan = () => {
            if (assessmentFlow) {
              // 计划已确认：先落定风险与闸门两个前置节点，再进入执行。
              assessmentFlow.completePhase('risk', `风险等级已确认：${riskLabelOf(effectiveIntent.riskLevel)}`);
              assessmentFlow.completePhase('gate', effectiveIntent.requiresConfirmation
                ? '影响范围已评估，安全闸门已通过。'
                : '评估完成，当前请求可以进入执行阶段。');
              assessmentFlow.setPhase('execute', '边界已确认，准备按小步策略执行…');
            }
            // Keep the approved plan and cursor outside this send() so the next
            // user message continues the same phase/Todo instead of reopening
            // the planning interview.
            this.activeComplexPlan = planForReview;
            this.activePlanNumber = 1;
            this.activeTodoNumber = 1;
            this.activePlanStarted = false;
            // Inject the validated plan object, never the raw model response.
            // This keeps repaired JSON out of context while still ensuring the
            // approved project steps are the instructions the build follows.
            // 计划一就绪本轮直接开工（2026-09-17 产品决策：不再有“计划批准暂停”）
            // → approved=true，模型第一轮必须立即开始执行，不能再要求“等用户下一条
            // 消息才开工”，否则引擎第一轮就空转完成，界面会直接从计划跳到交付。
            userPlan = formatPlanForPrompt(planForReview, needsDeliveryGate, true);
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
          // 高风险不再单独触发确认卡（2026-09-17 产品决策：默认自动允许，不等授权）；
          // 只有用户主动选择的计划/构建模式保留确认流程——那是模式本身的语义。
          const needsInteractiveApproval = forcedMode === 'plan' || forcedMode === 'build';
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
              {
                allowSkip: !needsDeliveryGate && !riskReview,
                riskReview,
                signal: this.abortController?.signal,
                host: this.transcriptTarget(),
                scope: this.sessionId || sendSessionId,
              },
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
              approvePlan();
            }
          } else {
            // Auto-detected work keeps moving. The plan is visible context,
            // not a second confirmation prompt the user has to dismiss.
            approvePlan();
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
        planProgress = new PlanProgressModel(this.activeComplexPlan, 'active', this.activePlanNumber, this.activeTodoNumber, this.activePlanProjectBuild, this.activePlanSeq);
        const existingCard = this.activePlanCardHandle?.el.isConnected
          ? this.activePlanCardHandle
          : null;
        if (existingCard && this.liveTurn && !this.liveTurn.host.contains(existingCard.el)) {
          existingCard.el.parentNode?.removeChild(existingCard.el);
          this.liveTurn.host.appendChild(existingCard.el);
        }
        if (existingCard) {
          // One stable progress list per transcript: rebind the SAME card to
          // the fresh model instead of stacking a duplicate every round.
          updatePlanCard(existingCard, this.activeComplexPlan, false, planProgress);
          planCard = existingCard;
        } else {
          planCard = createPlanCard(this.activeComplexPlan, false, planProgress);
          this.appendToTranscript(planCard.el);
        }
        this.activePlanCardHandle = planCard;
        this.bindActivePlanProgress(planProgress, sendSessionId, sendWorkspace);
        // 仅当是明确续跑指令时才输出“继续处理第 x 阶段第 y 个 Todo”的生硬框架；
        // 中途的新诉求沿用计划上下文，但不套用该文案，直接自然处理。
        if (isExplicitContinuation(userText)) {
          this.addStatusBubble(`收到，接着第 ${this.activePlanNumber} 阶段的第 ${this.activeTodoNumber} 个 Todo 往下干。`, false, false);
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
            card.setActivity(`计划 ${planNumber} 还有 Todo 没收尾，先不进下一计划…`);
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
            card.setActivity(`计划 ${activePlan} 的 Todos 都完成了，就差「计划 ${activePlan} 已完成」这行标记收尾…`);
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
                card.setActivity(`计划 ${before} 还没收尾，计划 ${marker.number} 先等一等…`);
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
            this.addStatusBubble(`${ok ? '🔧✅' : '🔧⛔'} 修复工具 ${fixEvent.payload.toolName}：${ok ? '已完成' : fixEvent.payload.result.error ?? '失败'}`, !ok, !ok, ok ? 'success' : undefined);
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
        this.addStatusBubble(`⚠️ 检测到请求中可能包含逻辑陷阱（${labels}）— 将先验证前提，若前提有误会换思路处理`, false, false, 'warn');
      }
      // Eager thinking indicator: the user sees the animation while waiting
      // for the first token; reasoning deltas upgrade it with live text. A
      // plain turn (no task analysis) reuses the card opened before the
      // preflight; analysis turns get a fresh card below the plan card.
      if (!thinkingCard) thinkingCard = openThinkingCard();
      // Waiting for the engine's first token: a stable honest label keeps the
      // card alive (dots animate) without pretending to do specific work; the
      // first streamed reasoning delta replaces it with real content. The
      // label names the real state (request sent, no token yet) instead of
      // the generic "思考", so a retry notice later reads as a DIFFERENT
      // cause (network) rather than more of the same wait.
      setThinkingLabel(thinkingCard, '等待模型首字返回…');
      // Mark this card as a silence-waiter (same as the tool-gap card below):
      // 'waiting' is what lets resetThinkingLabelForOutput flip the label to
      // "思考" on the first ReasoningDelta. Without it the first-token label
      // matched neither reset path and stayed stuck over visibly streaming
      // reasoning text — reading as "still waiting" while tokens arrive.
      thinkingCard.card.classList.add('waiting');
      // A new user turn is explicit intent to continue at the bottom: re-pin
      // even if the user had scrolled up to re-read history (the pin normally
      // survives until a manual scroll-away, but a fresh send must resume
      // following the newest content — otherwise the transcript stays frozen
      // above the reply for the rest of the session). Route through the
      // rAF-coalesced helper so this first content growth joins the same frame
      // budget as every streamed token (a direct scrollTop write here forced a
      // synchronous full-transcript layout). A fresh turn also dismisses any
      // "new content below" pill left over from the previous turn. Background
      // sessions must not touch the shared viewport at all (see the
      // viewActive guard at the fresh-user-turn scroll).
      if (this.viewActive) {
        forceScrollToBottom(chatEl);
        hideNewContentHint();
      }

      // ── Deferred init: the MCP handshake was started right after the agent
      // was built (see the warm-up above). Only the REMAINING budget is awaited
      // here, so the connection overlapped everything in between; a server that
      // still has not answered registers its tools on a later turn.
      if (mcpConnectPromise) {
        const mcpConnectStartMs = performance.now();
        const pendingConnect = mcpConnectPromise;
        mcpConnectPromise = null;
        await withAbortTimeout(
          pendingConnect,
          this.abortController?.signal,
          MCP_FIRST_TURN_BUDGET_MS,
          'MCP initialization',
        ).catch((err: Error) => {
          if (err.name === 'AbortError') throw err;
          console.warn('[pure] MCP initialization skipped:', err.message);
        });
        turnTiming.contextMs = (turnTiming.contextMs ?? 0) + Math.round(performance.now() - mcpConnectStartMs);
      }

      if (planPauseRequested && this.activeComplexPlan) {
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
          userPathRepairs,
          deliveredThisTurn,
        );
        return;
      }

      // 未走计划访谈的路径（如中风险但简单的请求）在这里补出评估卡：此时所有前置
      // 检查都已真实完成，闸门随检查结果落定，卡片再随执行/验证进度推进。
      maybeShowAssessment();
      maybeShowPlanSummary();
      if (assessmentFlow) {
        assessmentFlow.setPhase('execute', '已通过评估闸门，开始按确认范围小步执行…');
      }
      const finalPromptTools = effectiveWorkspace
        ? [...codingAgent.toolRegistry.getTools(), ...codingAgent.toolRegistry.getSubagentTools()]
        : promptTools;
      // App skills (~/.pure/skills, installed by the capability-gap protocol)
      // join the enabled Skill Hub skills in the system prompt. TTL-cached: a
      // skill installed mid-session shows up within 30s, not after a restart.
      const appSkills = await loadAppSkills(effectiveWorkspace);
      // MCP resources join the same optional-context tier as skills. The
      // client prefetches them on connect and caches the rendered body, so a
      // slow server costs at most one bounded wait on the post-connect turn.
      // Hoisted out of the assemble() literal below so the wait lands in the
      // turn's contextMs bucket (first-token observability).
      const mcpResourceStartMs = performance.now();
      const mcpResourceContext = this.mcpClient
        ? await this.mcpClient.collectResourceContext({ waitMs: MCP_RESOURCE_FIRST_TURN_BUDGET_MS })
        : undefined;
      turnTiming.contextMs = (turnTiming.contextMs ?? 0) + Math.round(performance.now() - mcpResourceStartMs);
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
        mcpResources: mcpResourceContext,
        mode: analysis.mode,
        budget: promptBudgetForProvider(config.customProviders, config.provider, config.model, config.providerOverrides),
        // Subagent tools join the model-visible list only in workspace mode
        // (finalPromptTools above), so the multi_agent protocol should only
        // fire when delegation is actually possible. Without a workspace there
        // are no subagent tools — don't tell the model to delegate.
        hasSubagents: !!effectiveWorkspace,
        // Thread the merged AGENTS.md conventions into the EXECUTION prompt too
        // (not just the pre-analysis buildSystemPrompt). Without this the GUI
        // runs with no project_conventions — the model never sees the
        // multi-agent delegation + display-discipline rules it needs to
        // actually delegate and to keep output concise. `conventions` is in
        // scope from line 2467.
        conventions,
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
        ? codingAgent.continueTurn(systemPrompt, historyMessages, userTurn, turnSignal, userImages, semanticRoute, turnHardStop.signal)
        : codingAgent.run(systemPrompt, userTurn, turnSignal, userImages, semanticRoute, turnHardStop.signal);
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
              // Plain turns have no assessment flow — VERIFY (rule checks,
              // up to 60s) would be minutes of dead silence with no indicator.
              // Keep the live card visible through the phase.
              if (!thinkingCard) {
                thinkingCard = openThinkingCard();
                thinkingCard.card.classList.add('waiting');
                scrollChatToBottomIfPinned(chatEl);
              }
              setThinkingLabel(thinkingCard, '正在验证结果…');
              dismissThinkingHint(thinkingCard, HINT_LINGER_MS);
            } else if (event.payload.to === 'ACT') {
              assessmentFlow?.setPhase('execute', event.payload.reason ?? '正在执行当前确认范围内的改动…');
            }
            if (event.payload.to === 'THINK') {
              assistantIteration++;
              // A new LLM iteration = a new tool round: close the previous
              // round's parallel grid so the next batch of tool rows starts
              // its own horizontal group.
              roundGrid = null;
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
              const failureType = event.payload.failure.type;
              const failureLabel = failureType === 'llm_error'
                ? '模型请求未成功'
                : failureType === 'tool_error'
                  ? '工具执行未成功'
                  : '验证未通过';
              const actionLabel = kind === 'retry' ? '正在重试' : '正在调整输出';
              setThinkingLabel(thinkingCard, `${failureLabel}，${actionLabel}（连续第 ${llmRetryNotices} 次）…`);
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
                markFirstToken();
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
                    // A repeated identical call collapses onto the completed
                    // card that already shows it — the engine reuses that
                    // result instead of executing again, so a second card
                    // would only ever duplicate the first.
                    const collapse = tryCollapseDuplicateRow(toolName, args);
                    const staged = pendingByName.get(toolName);
                    if (collapse && staged) {
                      // The duplicate streamed its own placeholder row —
                      // remove it and point at the completed original.
                      staged.row.el.remove();
                      pendingByName.delete(toolName);
                      entry = { ...collapse, toolCallId };
                      pendingRows.set(toolCallId, entry);
                    } else if (collapse) {
                      entry = { ...collapse, toolCallId };
                      pendingRows.set(toolCallId, entry);
                    } else if (staged) {
                      pendingByName.delete(toolName);
                      entry = { ...staged, toolCallId };
                      pendingRows.set(toolCallId, entry);
                    } else {
                      endThinking();
                      const row = appendToolRow(toolName, args, subagentNames.has(toolName) ? 'agent' : 'tool');
                      toolRowSinceSegment = true;
                      entry = { row, toolName, args, toolCallId };
                      if (subagentNames.has(toolName)) row.el.dataset.agentCallId = toolCallId;
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
                    // Repeated identical call mid-stream: stage VIRTUALLY on
                    // the completed card instead of appending a new row.
                    const collapse = args ? tryCollapseDuplicateRow(toolName, args) : null;
                    if (collapse) {
                      pendingByName.set(toolName, { ...collapse, toolName });
                    } else {
                      endThinking();
                      const row = appendToolRow(toolName, args ?? {}, subagentNames.has(toolName) ? 'agent' : 'tool');
                      toolRowSinceSegment = true;
                      pendingByName.set(toolName, { row, toolName, args: args ?? {} });
                    }
                  } else if (args) {
                    existing.args = args;
                    updateToolRowArgs(existing.row, toolName, args, false);
                  }
                }
              }
            }
            break;
          }

          case 'ToolStarted': {
            // 代执行回合（fold-in 补跑）的委派卡在这里落地：合成回合完全跳过
            // 模型流式调用，TokenDelta 里永远等不到它的 id 分块——没有这条
            // 兜底，追加的委派在后台跑得欢，对话流里却一张卡都不出（用户实测
            // 报过）。流式回合走到这里时行早已建好（id 分块先行），直接跳过，
            // 不会重卡。
            const callId = event.payload.toolCallId;
            const toolName = event.payload.toolName;
            if (!callId || !toolName || pendingRows.has(callId)) break;
            const args = parseToolCallBuffer(event.payload.toolCallArgs ?? '').args || {};
            const staged = pendingByName.get(toolName);
            if (staged) {
              // 极少见：流式半截行按名字暂存着还没等来 id 分块——迁移它，
              // 别让 ToolStarted 再开一行。
              pendingByName.delete(toolName);
              const migrated = { ...staged, toolCallId: callId, args };
              pendingRows.set(callId, migrated);
              updateToolRowArgs(migrated.row, toolName, args);
              break;
            }
            endThinking();
            const row = appendToolRow(toolName, args, subagentNames.has(toolName) ? 'agent' : 'tool');
            toolRowSinceSegment = true;
            if (subagentNames.has(toolName)) row.el.dataset.agentCallId = callId;
            pendingRows.set(callId, { row, toolName, args, toolCallId: callId });
            scrollChatToBottomIfPinned(chatEl);
            break;
          }

          case 'ReasoningDelta': {
            const content = event.payload.content;
            if (!content) break;
            markFirstToken();
            cancelToolGapCard();
            // Reasoning can resume after tool rows (each LLM iteration), so a
            // fresh card opens below whatever was appended since the last one.
            if (!thinkingCard) thinkingCard = openThinkingCard();
            // First real reasoning after a silence-waiter or recovery label
            // resets the card back to its default thinking state.
            resetThinkingLabelForOutput(thinkingCard);
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

          case 'SubagentActivity': {
            // Interior progress of a running subagent, namespaced by the
            // delegation toolCallId: stream one human line into the matching
            // delegation card and accumulate the trace — finalize re-renders
            // it after the result wipe, and session replay restores it from
            // toolResults. A delegation card no longer sits silently spinning
            // while its sub-agent works.
            const activity = event.payload;
            const trace = subagentTraceByCall.get(activity.callId) ?? [];
            subagentTraceByCall.set(activity.callId, trace);
            const line = formatSubagentTraceLine(activity);
            if (line === null) break;
            trace.push(line);
            if (trace.length > MAX_LIVE_STREAM_LINES) trace.splice(0, trace.length - MAX_LIVE_STREAM_LINES);
            const agentRow = pendingRows.get(activity.callId);
            if (agentRow) {
              // The run id deliberately does NOT decorate the transcript card —
              // the floating rail card carries the id chip (and error trace
              // lines quote it); the conversation keeps clean cards.
              agentRow.subagentTrace = trace;
              appendToolStreamLine(agentRow.row, activity.kind === 'error' ? 'stderr' : 'stdout', line);
              scrollChatToBottomIfPinned(chatEl);
            }
            break;
          }

          case 'ToolResult': {
            if (event.payload.result.success) hasToolSuccess = true;
            // 代执行回合的兑现回写（2026-09-22 重设计）：foldin_* 调用成功
            // 结束 ⇒ 对应折入机器核验完成，settle 直接放行。
            if (event.payload.toolCallId.startsWith('foldin_')) {
              const fold = this.pendingFoldIns.find((f) => f.syntheticCallId === event.payload.toolCallId);
              if (fold && event.payload.result.success) fold.mechanicallyDone = true;
            }
            const status = event.payload.result.success ? '✓' : '✗';
            const toolName = event.payload.toolName;
            const duration = event.payload.duration;
            const rawResult = event.payload.result.result;
            // generate_image returns a structured summary (the LLM must never
            // see megabytes of base64): pull the human text out of the object.
            // Subagent tools (code_reviewer / bash_executor / …) return a
            // SubagentResult carrying the delegated output — String() of that
            // object is "[object Object]", so the real body text is extracted
            // here too, otherwise the bash_executor console panel renders
            // garbage instead of the command's conclusion.
            const resultText = rawResult && typeof rawResult === 'object'
              ? 'summary' in rawResult
                ? String((rawResult as { summary?: unknown }).summary ?? '')
                // SubagentResult always carries the `output` key; a missing
                // value must become "" (the empty-result note), never
                // "[object Object]" from the object-stringify fallback.
                : 'output' in rawResult
                  ? String((rawResult as { output?: unknown }).output ?? '')
                  : String(rawResult ?? '')
              : String(rawResult ?? '');
            // Special-parse web_search / web_fetch results for rich body
            // rendering; generated images render as <img> cards. Other tools
            // fall back to a raw preview in <pre>.
            let resultKind: 'search' | 'fetch' | 'image' | undefined;
            let resultItems: Array<{ title: string; snippet: string; url: string }> | undefined;
            let resultImages: GeneratedImage[] | undefined;
            let resultPreview = '';
            let downloadMeta: { path: string; size: number; via?: string } | null = null;
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
              } else if (toolName === 'download_file') {
                try {
                  const parsed = JSON.parse(resultText) as { kind?: string; path?: string; size?: number; via?: string };
                  if (parsed && parsed.path) {
                    downloadMeta = { path: parsed.path, size: Number(parsed.size ?? 0), via: parsed.via };
                    resultPreview = `已下载到 ${parsed.path}（${formatBytes(Number(parsed.size ?? 0))}）`;
                  } else {
                    resultPreview = resultText.slice(0, 800);
                  }
                } catch {
                  resultPreview = resultText.slice(0, 800);
                }
              } else if (toolName === 'execute_command') {
                // Bash output was already streamed into the row live; keep the
                // trace on finalize (streaming was about progress, not
                // truncation) so the panel never visibly shrinks — but cap it
                // at MAX_LIVE_STREAM_LINES: a 5000-line build log must not
                // balloon the DOM (nor the persisted session preview). The
                // LLM still received the FULL output in the tool result.
                resultPreview = truncateResultLines(resultText);
              } else if (subagentNames.has(toolName)) {
                // Subagent bodies show the delegated output (bash conclusion,
                // review verdict, file list). Cap by line count like live
                // execute_command output — a fixed 800-char slice would cut a
                // build/conclusion summary off mid-sentence.
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
              subagentTrace: subagentTraceByCall.get(event.payload.toolCallId),
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
              const bumpVersion = (p: string): number => {
                const norm = p.trim().toLowerCase().replaceAll('\\', '/').replace(/^\.\//, '');
                if (!norm) return 0;
                const v = (this.fileWriteVersions.get(norm) ?? 0) + 1;
                this.fileWriteVersions.set(norm, v);
                // Snapshot the freshly written file as a physical `-v{n}` copy
                // on disk so the user can compare revisions (v1, v2, …). The
                // copy is a raw byte copy via the `copy_file` command, so it
                // preserves binaries (images, etc.) and never recurses back
                // through the write_file tool.
                if (effectiveWorkspace && isTauriRuntime()) {
                  const dst = versionedCopyPath(p, v);
                  void tauriInvoke('copy_file', { workspace: effectiveWorkspace, src: p, dst }).catch(
                    () => {
                      /* best-effort snapshot; ignore copy failures */
                    },
                  );
                }
                return v;
              };
              if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'create_document') {
                if (typeof resultArgs.path === 'string' && resultArgs.path.trim()) {
                  bumpVersion(resultArgs.path);
                  // edit_file modifies the user's existing file in place — the
                  // card must surface it even when the extension reads like
                  // source code. write_file / create_document are new files.
                  addArtifact(resultArgs.path, toolName === 'edit_file' ? 'edit' : 'create');
                }
              } else if (toolName === 'replace_files' && Array.isArray(resultArgs.files)) {
                for (const f of resultArgs.files) {
                  if (typeof f === 'string' && f.trim()) {
                    bumpVersion(f);
                    addArtifact(f, 'edit');
                  }
                }
              }
            }
            // Finalize the matching pending row — keyed by toolCallId (the
            // engine's id-bearing TokenDelta ensures one row per call).
            liveToolOutputQueue.delete(event.payload.toolCallId);
            const pending = pendingRows.get(event.payload.toolCallId) ?? pendingByName.get(toolName);
            if (pending) {
              // Remember the completed card so a repeated identical call
              // collapses onto it instead of rendering twice.
              if (pending.args) completedToolRowKeys.set(`${toolName}::${stableArgsStringify(pending.args)}`, pending);
              if (pending.toolCallId && subagentNames.has(pending.toolName)) pending.row.el.dataset.agentCallId = pending.toolCallId;
              finalizeToolRow(pending.row, {
                success: event.payload.result.success,
                duration,
                resultKind,
                resultItems,
                resultImages,
                resultText: resultPreview,
                // A deduped repeat has no trace of its own — fall back to the
                // lines this collapsed card already streamed, so the synthetic
                // finalize doesn't wipe them.
                subagentTrace: subagentTraceByCall.get(event.payload.toolCallId) ?? pending.subagentTrace,
              });
              if (downloadMeta && event.payload.result.success) {
                pending.row.el.appendChild(createDownloadCard(downloadMeta.path, downloadMeta.size, downloadMeta.via));
              }
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
            // 交付验证步骤气泡先收集到离屏容器，回合末再整体前置到“完成
            // 总结”之前（而非追加到末尾），避免“先声称完成、后验证”的顺序。
            const deliveryHolder = document.createElement('div');
            const addDeliveryBubble = (text: string, pending = false, isError = false): HTMLElement => {
              const bubble = document.createElement('div');
              bubble.className = 'bubble status';
              if (pending) bubble.classList.add('pending');
              if (isError) bubble.classList.add('error');
              bubble.textContent = text;
              linkifyPaths(bubble);
              const wrapper = document.createElement('div');
              wrapper.className = `bubble-row status${pending ? ' pending' : ''}${isError ? ' error' : ''}`;
              wrapper.appendChild(bubble);
              deliveryHolder.appendChild(wrapper);
              return bubble;
            };
            let deliveryResult: DeliveryVerificationResult | null = null;
            if (needsDeliveryGate && hasToolWork && !event.payload.interrupted && gen === this.generation) {
              addDeliveryBubble('🧪 交付验证：正在重跑机械检查（typecheck / 测试 / 构建）…', true);
              scrollChatToBottomIfPinned(chatEl);
              // Surface each mechanical check as it finishes so the user can see
              // the verification actually running (instead of a static bubble
              // that appears to do nothing before "passed").
              const onDeliveryStep = (step: DeliveryStepResult): void => {
                if (gen !== this.generation) return;
                const icon = step.status === 'passed' ? '✅' : step.status === 'skipped' ? '⏭️' : '❌';
                const dur = step.durationMs ? ` · ${(step.durationMs / 1000).toFixed(1)}s` : '';
                this.addStatusBubble(`${icon} 交付验证 · ${step.label}（${step.command}）${dur}`, false, step.status === 'failed', step.status === 'passed' ? 'success' : undefined);
                scrollChatToBottomIfPinned(chatEl);
              };
              deliveryResult = await runDeliveryVerification(codingAgent.toolRegistry, workspaceProfile, turnSignal, onDeliveryStep);
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
                  this.addStatusBubble(`🔁 第 ${round} 轮修复完成，重新执行全部交付验证…`, true, false, 'info');
                }
                // Every round closes with a real re-check, never the previous
                // round's evidence.
                deliveryResult = await runDeliveryVerification(codingAgent.toolRegistry, workspaceProfile, turnSignal, onDeliveryStep);
              }
              if (gen !== this.generation || this.abortController?.signal.aborted) return;
              if (!deliveryResult.passed && qualityRepairRounds >= MAX_QUALITY_REPAIR_ROUNDS) {
                qualityRepairIssues.push(`第 ${MAX_QUALITY_REPAIR_ROUNDS} 轮后仍未通过：${deliveryVerificationSummary(deliveryResult)}`);
                this.addStatusBubble(`⚠️ 已自动完成 ${MAX_QUALITY_REPAIR_ROUNDS} 轮修复与复查，仍有明确问题未解决，建议人工介入。\n${qualityRepairIssues.join('\n')}`, false, true);
              }
              this.addStatusBubble(deliveryResult.passed
                ? (deliveryResult.steps.length === 0
                    // No mechanical verification entry in this workspace — skip
                    // the "没有标准机械验证入口" explanation, just confirm pass.
                    ? '✅ 交付验证通过'
                    : `✅ 交付验证通过：${deliveryVerificationSummary(deliveryResult)}`)
                : `⛔ 项目暂不交付：${deliveryVerificationSummary(deliveryResult)}`,
              !deliveryResult.passed, !deliveryResult.passed,
              deliveryResult.passed ? 'success' : undefined);
              scrollChatToBottomIfPinned(chatEl);
            }
            if (deliveryResult && completionMessages && gen === this.generation) {
              const evidence = deliveryResult.steps.length > 0
                ? deliveryResult.steps.map((s) => `$ ${s.command}\n${s.status === 'passed' ? '通过' : s.status === 'skipped' ? '跳过' : '失败'}${s.exitCode !== undefined ? `（exit ${s.exitCode}）` : ''}\n${s.output || '(无输出)'}`).join('\n\n')
                : '本工作区没有标准机械验证入口（静态页面或空工作区），按通过处理。';
              completionMessages = [...completionMessages, { role: 'assistant', content: `交付验证结果（回合末机械检查重跑）：\n${evidence}` }];
            }
            const qualityPassed = !needsDeliveryGate || (deliveryResult?.passed === true && gen === this.generation);
            // 交付验证结果是会话级证据：记下“本会话真实通过过一次机械验证”，供后续
            // 纯总结轮（无工具调用、不重跑验证）收尾时使用。
            if (needsDeliveryGate && !event.payload.interrupted && gen === this.generation && deliveryResult?.passed === true) {
              this.deliveryGatePassed = true;
            }
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
            // 交付门禁证据完成的兜底（修复游标卡在中段的场景）：构建计划的交付
            // 验证通过（真实 typecheck / 测试 / 构建全绿）即视为整个项目已交付，
            // 即使标记扫描的游标还停在列表中间——模型做文档类项目时后期常以自然
            // 语言叙述、漏发 `## 计划 n` 起始标记（或步骤 Todo 未逐项播报被
            // canCompleteCurrentTodos 卡住），项目完成后播报仍停在「第 N 步」。
            // 守卫：本轮已播报下一计划（游标正要由标记机制推进）时不抢跑。
            const deliveryCompletedPlan = planCard
              && needsDeliveryGate && qualityPassed === true
              && !event.payload.interrupted && gen === this.generation
              && !turnAsksForInput && !this.pausePlanCard
              && hasToolSuccess
              && completionSnapshot !== undefined
              && completionSnapshot.currentPlan < completionSnapshot.plan.steps.length
              && !planTrack.phaseStarted.has(completionSnapshot.currentPlan + 1);
            // 纯总结轮的交付兜底：构建计划的收尾回合常常不带工具调用（模型以自然语言
            // 总结并展示结果），deliveryResult 因此不会重算。只要本会话已真实通过过
            // 交付验证，且这轮是干净的总结/确认收尾，就视为项目已交付并把计划置为
            // 完成——否则进度播报就停留在「执行中 第 N 步」，与对话里已经结束
            // 的项目不一致。该轮未通过验证（或从未通过）时不触发，继续保持续跑上下文。
            const deliverySummarizedPlan = planCard
              && needsDeliveryGate && this.deliveryGatePassed === true
              && !hasToolWork && !event.payload.interrupted && gen === this.generation
              && !turnAsksForInput && !this.pausePlanCard
              && completionSnapshot !== undefined
              && completionSnapshot.currentPlan < completionSnapshot.plan.steps.length
              && completionSnapshot.status !== 'complete';
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
                planCard.setActivity(`计划 ${finishedPlan} 完成，计划 ${nextPlan} 已就绪；说声“继续”我就接着干。`);
              } else {
                planCard.setActivity(todosDone
                  ? `计划 ${finishedPlan} 的工作已完成，等待验证结果后继续…`
                  : `计划 ${finishedPlan} 的工作尚未全部完成，继续处理当前计划…`);
              }
            } else if (planCompletionCandidate && (protocolPlanFinished || legacyPlanFinished || planSummarized || toolFinishedLastPlan) && planCard || (deliveryCompletedPlan && planCard) || (deliverySummarizedPlan && planCard)) {
              // 收尾判定加独立证据（审计第 3 项）：不能只信模型一句“已完成”——
              // 最后阶段的 Todo 要真实完成、或构建计划的回合末交付验证通过。
              // 证据不足时只更新文案，不 dispatch completed。
              const lastPlanNumber = completionSnapshot?.plan.steps.length ?? 0;
              const lastTodosDone = (planProgress?.canCompleteCurrentTodos() ?? false);
              const deliveryBlocked = needsDeliveryGate && !qualityPassed && !this.deliveryGatePassed;
              if (deliveryBlocked) {
                // 交付门禁未通过（审计第 4 项）：不把计划标记为完成，保留续跑
                // 上下文（activeComplexPlan 不被清空），下一轮“修复/继续”仍走
                // 原计划续跑，而不是丢失计划卡后重新分析。
                planCard.setActivity('活都干完了，但交付检查没过；回我一声，我接着修并重新验证。');
              } else if (lastTodosDone || (needsDeliveryGate && (qualityPassed === true || this.deliveryGatePassed === true))) {
                planProgress?.dispatch({ type: 'completed' });
                planMarkedCompleted = true;
                if (this.activeComplexPlan)
                  planCard.setActivity('计划中的所有步骤已完成，交付检查也已结束。');
              } else {
                planCard.setActivity('最后阶段还没收口，我继续处理当前计划。');
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
              // has changed the bubble height. Protocol control lines (「## 计划
              // n：…」) are folded so a model echo of an already-announced stage
              // cannot render as duplicated headings.
              void renderMarkdown(stripToolCallXml(dedupePlanAnnouncements(finalText)), seg.el).then(() => {
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
                  this.appendToTranscript(createDesignPreviewCard(html, designMockupFile, () => {
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

            // Artifact cards follow the human rule per TURN: a colleague who
            // edited your file this turn ends with "改好了，文件是 xxx" —
            // every turn that wrote files says so, not just the first one.
            // The once-per-session cumulative directory card survives only as
            // the wrap-up entry point for a plan-built project whose final
            // completion turn may write no new files (the reason the session
            // list, not the turn list, was used here historically). Rendering
            // the turn list also matches the replay projection, which has
            // always persisted per-turn artifacts.
            const deliveredPlanIndex = completionSnapshot?.plan.steps.length ?? 0;
            const deliveredOnFinalStage = completionSnapshot !== undefined
              && completionSnapshot.currentPlan >= deliveredPlanIndex;
            const isPlanBuild = planCard !== undefined;
            const projectDelivered =
              gen === this.generation
              && !event.payload.interrupted
              && (isPlanBuild
                ? (planMarkedCompleted || (needsDeliveryGate && qualityPassed && deliveredOnFinalStage))
                : (!needsDeliveryGate || qualityPassed) && hasToolWork);
            // 目录/路径卡片是「项目在哪」的信息，不是「交付合格」的声明：
            // 只要本轮正常结束且产生过文件就显示。此前它被交付门禁拦住——
            // 而会话恢复路径按 write 记录无条件重建卡片，导致「实时不显示、
            // 重载后反而出现」的分叉。门禁是否通过由状态气泡单独表达。
            const turnHasNewArtifacts =
              gen === this.generation
              && !event.payload.interrupted
              && turnArtifacts.length > 0;
            const projectWrapUp =
              !turnHasNewArtifacts
              && projectDelivered
              && this.sessionArtifacts.length > 0
              && !this.projectDirectoryShown;
            if (turnHasNewArtifacts || projectWrapUp) {
              const cardItems = turnHasNewArtifacts ? turnArtifacts : this.sessionArtifacts;
              const artifactRow = document.createElement('div');
              artifactRow.className = 'bubble-row artifact-row';
              this.appendToTranscript(artifactRow);
              renderArtifactCards(artifactRow, cardItems, computeProjectDir(cardItems) ?? effectiveWorkspace, { userRequest: userText, workspace: effectiveWorkspace });
              this.projectDirectoryShown = true;
              deliveredThisTurn = true;
              scrollChatToBottomIfPinned(chatEl);
            }
            // 课后优化建议卡（非阻断）：交付通过且本回合写过文件时，给用户
            // 一个手动触发的「生成优化建议」入口。绝不自动跑——不烧 token、
            // 不拖慢回合收尾。
            if (projectDelivered && this.sessionArtifacts.length > 0 && gen === this.generation) {
              createOptimizeCard(this.transcriptTarget(), {
                files: this.sessionArtifacts.map((a) => a.path),
                workspace: effectiveWorkspace,
                userRequest: userText,
                runReview: async (prompt, files): Promise<string> => {
                  const toolCall: ToolCall = {
                    id: `optimize-${gen}-${Date.now()}`,
                    index: 0,
                    function: { name: 'code_reviewer', arguments: JSON.stringify({ prompt, files: files.join(', ') }) },
                  };
                  const result = await codingAgent.subagentOrchestrator.execute(toolCall, this.abortController?.signal);
                  if (!result.success || result.error) throw new Error(result.error || 'code_reviewer failed');
                  return String(result.result ?? '');
                },
              });
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
              // 被中断的回合（用户点停止 / Escape / 插话接管）绝不是 cleanEnd：
              // 链路必须随中止一起终止，否则 send() 的 finally 会在 1.2s 后重新
              // 排下一轮「自动续跑」——表现为“点了暂停，计划却继续跑”。
              cleanEnd: planCard !== undefined && !event.payload.interrupted && gen === this.generation && !this.pausePlanCard,
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
              // Safeguard against a lost in-flight partial reply: the DOM's
              // accumulated text is the ground truth for what the user actually
              // SAW this turn. If the engine's final messages (which depends on
              // the adapter throwing/rejecting on abort) did not carry that
              // partial, append it now — otherwise the interrupted answer is
              // silently dropped from history. Only touches the interrupted
              // path, and only when the partial is genuinely missing.
              const visiblePartial = assistantSegments.map((s) => s.text).filter(Boolean).join('\n\n').trim();
              const partialTail = visiblePartial.slice(-48);
              const alreadyCarried = partialTail.length > 0
                && interruptedMessages.some((m) => m.role === 'assistant' && (m.content ?? '').includes(partialTail));
              if (visiblePartial.length > 0 && !alreadyCarried) {
                interruptedMessages.push({ role: 'assistant', content: visiblePartial });
              }
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
              void renderMarkdown(stripToolCallXml(dedupePlanAnnouncements(seg.text)), seg.el).then(() => {
                if (gen !== this.generation) return;
                scrollChatToBottomIfPinned(chatEl);
              });
            }
            const hasContent = assistantSegments.some(s => s.el.textContent || s.el.children.length > 0);
            const lastSeg = assistantSegments.length ? assistantSegments[assistantSegments.length - 1] : null;
            if (event.payload.reason === 'paused') {
              // 阶段 12: paused is not an interruption — the archive is on
              // disk (this branch's merge/persist above IS the archive) and
              // the subagent cards already flipped to ⏸ via the progress
              // sink. Friendly copy + the resume affordance instead of the
              // alarming "⏹ Interrupted".
              pausedThisTurn = true;
              const pausedText = t('chat.paused', '⏸ 已暂停：进度已存档，随时接着跑。');
              if (hasContent) {
                this.addStatusBubble(pausedText);
              } else if (lastSeg) {
                lastSeg.el.textContent = pausedText;
              } else {
                const seg = createSegment();
                seg.el.classList.remove('streaming');
                seg.el.textContent = pausedText;
              }
              this.showPausedResumeBar();
            } else if (event.payload.reason !== 'aborted') {
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
            // Do NOT surface the project-directory card here: an interruption
            // (e.g. max-steps reached) means the project is NOT done. The card
            // must only appear once on genuine completion (handled in the
            // Completed branch), so a mid-run abort never implies success.
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
          userPathRepairs,
          deliveredThisTurn,
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
          userPathRepairs,
          deliveredThisTurn,
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
          userPathRepairs,
          deliveredThisTurn,
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
      // Commit the turn's timing record (completed, failed, or aborted — all
      // three carry attribution). Superseded turns are dropped: their session
      // id now points at the session the user switched TO, and writing there
      // would pollute another conversation's stats.
      if (gen === this.generation) {
        turnTiming.totalMs = Math.round(performance.now() - turnStartMs);
        const timings = this.sessionStats.turnTimings ?? (this.sessionStats.turnTimings = []);
        timings.push(turnTiming);
        if (timings.length > 20) timings.splice(0, timings.length - 20);
        this.persistStats();
      }
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
      unregisterToolOutput();
      unregisterDownloadProgress();
      clearInterval(stallWatchdog);
      // Turn-scoped UI teardown for EVERY exit — not just Interrupted/catch.
      // A superseded turn (send() bumped this.generation: a queued task,
      // auto-continue round or session switch started a new send while this
      // turn was mid-tool) leaves the event loop via the generation-guard
      // `break`, so its Interrupted branch never runs. Without this block the
      // background transcript kept a forever-animating thinking card, tool
      // rows stuck on "calling…", a blinking streaming caret and an
      // assessment card pinned on 执行中 — all visible the moment the user
      // switches back to that session. Every call is idempotent (null /
      // empty / finished guards), so paths that already cleaned up are
      // no-ops here. The assessment card is only force-cancelled on the
      // superseded path: a normal turn's flow has already reached a terminal
      // state (or intentionally stays open), and cancel() must not rewrite it.
      endThinking();
      resolvePendingToolRows(toolCallRefresh, pendingRows, pendingByName);
      for (const seg of assistantSegments) {
        cancelStreamingRender(seg.el);
        seg.el.classList.remove('streaming');
      }
      if (gen !== this.generation) assessmentFlow?.cancel('本轮被新的请求接管，未继续执行。');
      // Release the streaming state ONLY if this turn still owns the
      // controller. An unconditional setStreaming(false) here could run AFTER
      // a newer send has already installed its own turn controller + set
      // streaming(true) — the abort is processed asynchronously, so the old
      // turn's finally can land mid-stream of the new turn and flicker the UI
      // back to "not generating". releaseSupersededTurn() is idempotent for
      // the already-released early-return paths.
      const ownsTurn = this.abortController === turnController;
      this.finishLiveTurn(liveTurn);
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
          else {
            this.activePlanCardHandle?.clearAutoContinue();
            // The chain ended WITHOUT a scheduled round — say WHY instead of
            // letting the badge silently vanish (capped vs stalled).
            const deny = this.autoContinue.denyReason;
            if (deny === 'budget') {
              this.addStatusBubble(t('chat.autoContinue.capped').replace('{n}', String(this.autoContinue.roundCount)).replace('{max}', String(max)), false, false);
            } else if (deny === 'stall') {
              this.addStatusBubble(t('chat.autoContinue.stalled'), false, false);
            }
          }
        } else {
          // Auto-continue turned off mid-chain — drop the badge.
          this.activePlanCardHandle?.clearAutoContinue();
        }
      } else {
        // No eligible signals / superseded turn: the chain is over.
        this.activePlanCardHandle?.clearAutoContinue();
      }
      // After a turn fully finalizes (this turn still owns the controller),
      // fold in any RELATED insert or start the next queued UNRELATED task once
      // the current task/plan is terminal (no auto-continue pending). Defers via
      // a timer so it never re-enters send() synchronously from inside the
      // finally stack.
      if (ownsTurn) this.scheduleDeferred();
    }
  }

  clear() {
    this.cancel();
    this.liveTranscript.reset();
    this.liveTurn = null;
    setInlineCardHost(null);
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
    this.pendingTasks = [];
    this.queueCardEl?.parentElement?.remove();
    this.queueCardEl = null;
    this.relatedInsert = null;
    this.interjectReceiptRows.clear();
    // 插话重构 — new chat discards steers aimed at the old conversation.
    this.pendingSteers = [];
    this.pendingFoldIns = [];
    this.activePlanNumber = 1;
    this.activeTodoNumber = 1;
    this.activePlanStarted = false;
    this.activePlanCardSnapshot = null;
    this.activePlanCardHandle = null;
    this.agentActivities = [];
    this.agentActivityHistorical = false;
    this.clearAgentActivityPersistence();
    this.removeAgentActivityPanel();
    this.detachActivePlanProgress();
    this.activePlanProgress = null;
    this.activePlanProjectBuild = false;
    // 新对话 = 新的一次会话：规划编号重新起算，进度播报随之重新播种。
    this.planSeqCounter = 0;
    this.activePlanSeq = 1;
    this.deliveryGatePassed = false;
    this.fileWriteVersions.clear();
    this.sessionArtifacts = [];
    this.sessionArtifactSeen.clear();
    this.projectDirectoryShown = false;
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
    // Clear only this session's own transcript column (host mode) or the
    // shared #chat element in single-session mode.
    this.transcriptElement().innerHTML = '';
  }

  cancel() {
    const wasPausing = isPauseAbort(this.abortController?.signal);
    this.abortController?.abort();
    // 1c 升级硬停：暂停的宽限窗口里再叫停，不等宽限——立即掐掉在飞工具
    // （记账仍归暂停：断点照存、卡片如实标 ⏸）。
    if (wasPausing) this.hardStopController?.abort();
    // Stop / Escape take the human back: kill any pending auto-continue too.
    this.autoContinue.cancel();
    this.activePlanCardHandle?.clearAutoContinue();
  }

  /** 阶段 12 — pause, not stop: aborts the turn with the pause reason so the
   * engine cuts the LLM stream immediately, in-flight tools finish and land in
   * the archive, queued tools never start, and subagent cards flip to ⏸. The
   * checkpoint machinery (stable sessionId + subagent_interrupted + engine
   * continue) does the rest — resume is a plain "继续" send away. Hard cancel
   * (session switch, new chat) stays on cancel(). */
  pause() {
    if (!this.isStreaming()) return;
    // 手感修复（2026-09-20 用户试用反馈）：中断后的收尾——在跑的工具先做完、
    // 排队的合成跳过、子 agent 走到 THINK 边界——可能要几秒到几十秒。回执必须
    // 与点击同步出现，否则收尾期间的连点全是无声 no-op，读起来就是"暂停失灵"。
    this.showPausingNotice();
    abortPaused(this.abortController);
    this.autoContinue.cancel();
    this.activePlanCardHandle?.clearAutoContinue();
  }

  /** 1c Esc 语义统一（对话智能升格）：Esc 双轨收敛为一个确认层级——第一下
   * Esc = 暂停（收尾、存档、可继续）；「正在暂停」的收尾期里再按一次 =
   * 升级为硬停。差别由两条链路各自的条子说清（pausing 条 → 继续条 / 停止
   * 回执），用户永远知道按的是哪一档。 */
  escapeWhileStreaming(): void {
    if (this.pausedResumeBar?.dataset.state === 'pausing') {
      this.cancel();
      return;
    }
    this.pause();
  }

  /** Transitional notice the instant the user asks for a pause. Replaced by
   * the 「继续」 bar when the Interrupted(paused) event lands; cleared by the
   * turn-release path if the turn ended some other way (pause raced the end). */
  private showPausingNotice(): void {
    if (this.pausedResumeBar?.dataset.state === 'pausing') return;
    this.dismissPausedResumeBar();
    const bar = document.createElement('div');
    bar.className = 'paused-resume-bar paused-resume-bar--pausing';
    bar.dataset.state = 'pausing';
    const note = document.createElement('span');
    note.className = 'paused-resume-note';
    note.textContent = t('chat.paused.draining', '⏸ 正在暂停：等在跑的步骤收尾（子 agent 会存档进度），马上停下…');
    bar.appendChild(note);
    this.transcriptElement().appendChild(bar);
    this.pausedResumeBar = bar;
  }

  /** The resume affordance under a paused turn: one 「继续」 button. Clicking
   * injects a resume turn through the normal send path — the parent sees its
   * archived transcript (paused delegation results included) and naturally
   * re-delegates; identical subtasks hit the same stable sessionIds and the
   * subagents continue from their checkpoints. Single-flight: ignored while
   * another turn streams — two writers on one session is the one thing we
   * never allow. */
  private showPausedResumeBar(): void {
    this.dismissPausedResumeBar();
    const bar = document.createElement('div');
    bar.className = 'paused-resume-bar';
    bar.dataset.state = 'paused';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'paused-resume-btn';
    btn.textContent = `▶ ${t('chat.paused.resume', '继续')}`;
    btn.title = t('chat.paused.resumeTitle', '从暂停点接着跑——子 agent 从存档续，不重头来');
    btn.addEventListener('click', () => {
      if (this.isStreaming()) return;
      this.dismissPausedResumeBar();
      void this.send('继续');
    });
    bar.appendChild(btn);
    this.transcriptElement().appendChild(bar);
    this.pausedResumeBar = bar;
  }

  private dismissPausedResumeBar(): void {
    this.pausedResumeBar?.remove();
    this.pausedResumeBar = null;
  }

  /** Cancel a pending auto-continue (user started typing / any other takeover). */
  cancelAutoContinue(): void {
    this.autoContinue.cancel();
    this.activePlanCardHandle?.clearAutoContinue();
  }

  /** Fire the next auto round. Runs from the scheduler timer; re-checks that
   * the chain is still wanted (config on, plan still active) before re-entering
   * send(). No streaming check needed — any user send/Stop cleared the timer. */
  /** Engine continueGuard closure: thin adapter over the pure decision,
   *  feeding it THIS controller's live plan state. */
  private planContinueGuard(args: { content: string; turnCount: number; guardContinues: number }): string | false {
    const snapshot = this.activePlanProgress?.getSnapshot() ?? null;
    return evaluatePlanContinuation({
      content: args.content,
      plan: this.activeComplexPlan,
      snapshot: snapshot ? { currentPlan: snapshot.currentPlan, currentTodo: snapshot.currentTodo, status: snapshot.status } : null,
      paused: !!(this.pausePlanCard || this.pauseAssessmentFlow),
    });
  }

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
    artifacts: Array<{ path: string; op?: 'edit' | 'create' }> = [],
    visibleUserText = '',
    /** 11.2 — path repairs this turn applied, so the transcript note survives a
     *  reload (the bubble shows the original words, modelContext the fixed
     *  text; the pairs are the only record of the difference). */
    pathRepairs: PathRepair[] = [],
    /** Only persist the artifact block when this turn genuinely delivered the
     * project (projectDelivered). Without this, an interrupted / unverified
     * turn writes its artifacts into the transcript and the directory/file
     * card wrongly reappears when the history session is replayed. */
    artifactsDelivered = false,
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
        pathRepairs: m.role === 'user' && index === latestUserIndex && pathRepairs.length > 0 ? pathRepairs : undefined,
        images: m.images,
        attachments: m.attachments,
        analysis,
        artifacts: m.role === 'assistant' && index === lastAssistantIndex && artifactsDelivered && artifacts.length > 0 ? artifacts : undefined,
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
    const nextSnapshotV2 = createSessionSnapshot(canonicalMessages, transcriptDrafts, {
      planProgress: progressSnapshot,
      planState: turnPlanState,
    });
    const events = nextSnapshotV2.events;
    const nextSnapshot: SessionSnapshot = {
      version: 3,
      modelContext: nextSnapshotV2.modelContext,
      events,
      transcript: nextSnapshotV2.transcript,
      uiState: {
        ...nextSnapshotV2.uiState,
        agentActivities: this.agentActivities.length > 0 ? this.agentActivities.map((activity) => ({ ...activity })) : undefined,
      },
    };
    await saveSession(sessionId, nextSnapshot, workspace);
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
      this.scheduleBackgroundPreCompaction(ctx, systemPrompt, msgs, gen, transcriptMessages, true);
    }

    /**
     * ⑥ 首回复延迟：载入会话时的后台预压实。刚恢复的长会话若不这样做，首次
     * 发送就要在关键路径上同步跑 trim + LLM 摘要（摘要最长 60s）。要点：
     * - 引擎与适配器经工厂惰性构建（idle 守卫全过之后才执行）；预算内的会话
     *   被廉价估算直接豁免，一次适配器都不建；
     * - 系统提示词用占位版本——Harness.continueTurn 会把 messages[0] 换成
     *   真系统提示词，且 pickHistoryMessages 按 身份+条数 校验缓存窗口；
     * - overBudget 静默：与今天发送期内联 trim 的行为一致（Harness 无 toast）。
     */
    private preCompactAfterLoad(): void {
      if (this.streaming || this.messages.length === 0) return;
      const transcriptMessages = this.messages;
      const cfg = loadConfig();
      const maxTokens = resolvePromptBudget(promptBudgetForProvider(cfg?.customProviders, cfg?.provider, cfg?.model, cfg?.providerOverrides)).availableInputTokens;
      const placeholderSystem = BASE_SYSTEM_PROMPT(!!(this.effectiveWorkspace || this.workspace));
      const priorSummaries = transcriptMessages.filter((message) => message.role === 'system' && message.content.startsWith('Earlier conversation summary:'));
      const compactionInput: Message[] = [
        { role: 'system', content: placeholderSystem },
        ...priorSummaries,
        ...transcriptMessages.filter((message) => message.role !== 'system'),
      ];
      // 廉价闸：窗口明显放得下（给工具 schema + 真提示词增量留足半个预算）时，
      // 发送期 trim 本来就是 no-op，整条链路（含适配器构建）直接跳过。
      if (estimateTextTokens(compactionInput.map((m) => m.content ?? '').join('')) < maxTokens / 2) return;
      this.scheduleBackgroundPreCompaction(
        () => new ContextEngine({
          maxMessages: 20,
          maxTokens,
          llm: createLLMAdapter(cfg),
        }),
        placeholderSystem,
        transcriptMessages,
        this.generation,
        transcriptMessages,
        false,
      );
    }

    /**
     * Shared idle-slot scheduler behind both pre-compaction entry points. The
     * engine is either the live harness one (post-turn) or lazily built for a
     * freshly loaded transcript (preCompactAfterLoad); guards, double-yield
     * and the cache write are identical.
     */
    private scheduleBackgroundPreCompaction(
      ctxOrFactory: ContextEngine | (() => ContextEngine | null),
      systemPrompt: string,
      msgs: Message[],
      gen: number,
      transcriptMessages: Message[],
      notifyOverBudget: boolean,
    ): void {
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
            const ctx = typeof ctxOrFactory === 'function' ? ctxOrFactory() : ctxOrFactory;
            if (!ctx) return;
            const priorSummaries = msgs.filter((message) => message.role === 'system' && message.content.startsWith('Earlier conversation summary:'));
            const compactionInput: Message[] = [
              { role: 'system', content: systemPrompt },
              ...priorSummaries,
              ...msgs.filter((message) => message.role !== 'system'),
            ];
            const compaction = await ctx.compact(compactionInput);
            const trimmed = compaction.messages;
            if (gen === this.generation && this.messages === transcriptMessages) {
              if (compaction.overBudget && notifyOverBudget) {
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
    this.appendToTranscript(wrapper);
    return bubble;
  }

  /**
   * Append a system status bubble to the transcript. `pending` pulses in
   * accent (in-progress); `isError` renders the full-width danger row. `kind`
   * adds a tonal highlight for result-bearing messages so key moments (root
   * cause found, a bug discovered, verification all-green) are noticed at a
   * glance instead of blending into neutral notices:
   *  - 'success' → green: verification passed, a step completed cleanly
   *  - 'warn'    → amber: a defect/bug found, degraded mode, needs attention
   *  - 'info'    → accent: root-cause / probe findings, contract established
   */
  /** Host-facing: leave a status line in the visible transcript for something
   *  the host did around the engine. A held (scheduled) input needs it most —
   *  the composer is already cleared, so with no trace the message reads as
   *  dropped, and the status line is what quotes it back. */
  notifyStatus(text: string): void {
    this.addStatusBubble(text, false, false, 'info');
  }

  private addStatusBubble(
    text: string,
    pending = false,
    isError = false,
    kind: 'success' | 'warn' | 'info' | undefined = undefined,
  ): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'bubble-row status';
    if (pending) wrapper.classList.add('pending');
    if (isError) wrapper.classList.add('error');
    const bubble = document.createElement('div');
    bubble.className = 'bubble status';
    if (isError) bubble.classList.add('error');
    if (kind) bubble.classList.add(`hl-${kind}`);
    bubble.textContent = text;
    linkifyPaths(bubble);
    wrapper.appendChild(bubble);
    this.appendToTranscript(wrapper);
    return bubble;
  }

  // Fallback tool-result status bubble (no live tool row existed for this
  // call): render the tool name highlighted, matching .tool-row-name.
  private addToolStatusBubble(toolName: string, status: string, duration: number) {
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
    this.appendToTranscript(wrapper);
  }

  private addToolRow(toolName: string, args: Record<string, unknown>, parent: HTMLElement): ToolRowHandle {
    const row = createToolRow(toolName, args);
    parent.appendChild(row.el);
    scrollChatToBottomIfPinned(this.scrollRoot());
    return row;
  }

  private setStreaming(v: boolean) {
    this.streaming = v;
    this.onStreamingChange?.(v);
  }
}

// ── Multi-session chat manager ──
// Pure supports several concurrent conversations. Each session owns a
// ChatController + its own .session-transcript host inside the shared #chat
// scroll box, so switching to another session NEVER cancels the previous one:
// its engine loop keeps running and streaming into its (hidden) host, its
// state keeps persisting under its own session id, and switching back
// re-attaches exactly the live state it was left in — mid-search, mid-plan,
// or already finished with results — instead of rebuilding from disk.
//
// The facade below forwards the app-shell calls to the CURRENT (visible)
// controller, so main.ts / sessionSidebar.ts keep their existing call shapes.

export interface OpenSessionResult {
  /** Controller owning the requested session (existing live or freshly made). */
  controller: ChatController;
  /** Its .session-transcript host inside #chat (the DOM restore target). */
  host: HTMLElement;
  /** True when the session was already open and running in this app instance. */
  warm: boolean;
}

// ── Live-session registry (sidebar running dots) ──
// Sessions whose controller is currently streaming, regardless of whether
// they are the visible conversation. The sidebar reads this to pulse a dot
// on cards whose session is still working in the background.
const runningSessionIds = new Set<string>();
const runningSessionsListeners = new Set<() => void>();

/** An input the user asked to run at a named moment. */
export interface TimedInputRequest {
  text: string;
  images: MessageImage[];
  displayText: string;
  /** Absolute epoch ms. */
  at: number;
  /** The user's own words for the time, for echoing back. */
  timingText?: string;
}

/**
 * Host hook for input-level time semantics: `main.ts` owns the durable task
 * queue (it survives a reload and re-arms its timer), so the queue is the only
 * place a "下午三点再跑" can actually wait. A module-level sink rather than a
 * per-session field because the queue it feeds is per-APP, while the decision
 * to hold is taken inside whichever session's chat the input arrived on.
 *
 * Returning false means nobody can hold it (CLI, tests, a host without a
 * queue) — the caller then keeps the words in its own in-memory lane rather
 * than dropping them.
 */
let timedInputSink: ((request: TimedInputRequest) => boolean) | null = null;

export function setTimedInputSink(sink: ((request: TimedInputRequest) => boolean) | null): void {
  timedInputSink = sink;
}

/** True when `sessionId` has a live controller that is streaming right now. */
export function isSessionRunning(sessionId: string): boolean {
  return runningSessionIds.has(sessionId);
}

/** Snapshot of every currently-streaming session id (roadmap 4.3): the
 * parallel-task cards enumerate the set to build one card per background
 * session — a boolean probe alone cannot discover who is running. */
export function runningSessionIdList(): string[] {
  return [...runningSessionIds];
}

/** Subscribe to running-set changes (session started/finished streaming).
 * Returns an unsubscribe function. */
export function onRunningSessionsChanged(cb: () => void): () => void {
  runningSessionsListeners.add(cb);
  return () => {
    runningSessionsListeners.delete(cb);
  };
}

export class SessionChatManager {
  private controllers = new Map<string, ChatController>();
  private hosts = new Map<string, HTMLElement>();
  private currentSessionId = '';
  private current: ChatController | null = null;
  private currentHost: HTMLElement | null = null;
  private nextSessionSeq = 1;

  private streamingCb?: (streaming: boolean) => void;
  private statsCb?: (stats: SessionStats) => void;
  private snapshotCb?: (available: boolean) => void;
  private restoreDraftCb?: (text: string) => void;
  private activeSessionCb?: (sessionId: string) => void;

  private container(): HTMLElement {
    return document.getElementById('chat')!;
  }

  private createSessionHost(sessionId: string): HTMLElement {
    const host = document.createElement('div');
    host.className = 'session-transcript';
    host.dataset.sessionId = sessionId;
    host.hidden = true;
    this.container().appendChild(host);
    return host;
  }

  private wireController(controller: ChatController, sessionId: string): void {
    controller.onStreamingStateChange((streaming) => {
      // Track EVERY session's streaming state for the sidebar's running dots —
      // background sessions keep working while another one is visible.
      const changed = streaming ? !runningSessionIds.has(sessionId) : runningSessionIds.has(sessionId);
      if (streaming) runningSessionIds.add(sessionId);
      else runningSessionIds.delete(sessionId);
      if (changed) runningSessionsListeners.forEach((cb) => cb());
      // Only the visible conversation drives the shared streaming UI.
      if (controller === this.current) this.streamingCb?.(streaming);
    });
    controller.onSessionStatsChanged((stats) => {
      if (controller === this.current) this.statsCb?.(stats);
    });
    controller.onWorkspaceSnapshotChanged((available) => {
      if (controller === this.current) this.snapshotCb?.(available);
    });
    controller.onRestoreDraft((text) => {
      if (controller === this.current) this.restoreDraftCb?.(text);
    });
  }

  /** 11.2 — register the composer's "put the original draft back" action. */
  onRestoreDraft(fn: (text: string) => void): void {
    this.restoreDraftCb = fn;
  }

  /** Register a "the visible session changed" listener. Session switches have
   * many entry points — sidebar click, parallel-task dock card, tray 前往,
   * notification click, lazy first session — and every one funnels through
   * openSession/makeActive, so this is the single chokepoint for UI that must
   * follow the visible conversation (the sidebar's active highlight). */
  onActiveSessionChanged(fn: (sessionId: string) => void): void {
    this.activeSessionCb = fn;
  }

  /** The visible controller; creates the first session lazily when needed. */
  private activeNow(): ChatController {
    if (this.current) return this.current;
    this.openSession(`session_${Date.now()}_${this.nextSessionSeq++}`);
    return this.current!;
  }

  private makeActive(controller: ChatController, host: HTMLElement, sessionId: string): void {
    const changed = this.current !== controller;
    if (this.current && changed) this.current.setViewActive(false);
    this.current = controller;
    this.currentHost = host;
    this.currentSessionId = sessionId;
    if (changed) {
      controller.setViewActive(true);
      // Relative-path resolution must follow the now-VISIBLE session. Warm
      // switches bypass ChatController.setWorkspace entirely, so without this
      // a transcript clicked right after returning from another conversation
      // resolved against the previous session's workspace and opened the
      // wrong directory.
      setPathLinkWorkspace(controller.getEffectiveWorkspace());
      this.streamingCb?.(controller.isStreaming());
      // Re-publish the newly visible session's undo availability + stats so the
      // shell chrome (undo button, context panel) reflects the session that is
      // actually shown, not the previous one. The per-controller wiring above
      // only forwards events while the session stays current, so a switch needs
      // an explicit refresh here.
      this.snapshotCb?.(controller.hasUndoableWrites());
      this.statsCb?.(controller.getSessionStats());
      // The switch may have come from outside the sidebar (dock card, tray,
      // notification) — let listeners move the sidebar highlight along.
      this.activeSessionCb?.(sessionId);
      const scroll = document.getElementById('chat');
      if (scroll && typeof requestAnimationFrame === 'function') forceScrollToBottom(scroll);
    }
  }

  /** Fires when the visible session changes (sidebar click, new chat, …).
   * One-way notification for UI state that must follow the conversation —
   * e.g. the per-session input history store warms the new session's bucket. */
  onSessionIdChanged: ((sessionId: string) => void) | null = null;

  /** Make `sessionId` the visible conversation, reusing its live controller
   * when this app instance already has it open. Returns the session's host so
   * a cold session can be rendered from disk into it. Never cancels work. */
  openSession(sessionId: string): OpenSessionResult {
    let controller = this.controllers.get(sessionId) ?? null;
    let host = this.hosts.get(sessionId) ?? null;
    const warm = controller !== null;
    if (!controller) {
      host = this.createSessionHost(sessionId);
      controller = new ChatController({ host, viewActive: false });
      // Bind the fresh controller to the REAL session id (the constructor only
      // mints a placeholder) before it goes live, so persistence, stats and
      // MCP ownership all key on the actual session.
      controller.setSessionId(sessionId);
      this.wireController(controller, sessionId);
      this.controllers.set(sessionId, controller);
      this.hosts.set(sessionId, host);
    }
    this.makeActive(controller, host!, sessionId);
    this.onSessionIdChanged?.(sessionId);
    return { controller, host: host!, warm };
  }

  /** Switch to an already-open session (sidebar click on a live one). */
  setSessionId(sessionId: string): void {
    this.openSession(sessionId);
  }

  /** The live controller for `sessionId`, WITHOUT activating or creating it
   * (roadmap 4.2): the task queue's background lanes drive sessions that are
   * already open this app-run — hidden controllers keep streaming by design,
   * so a lane can run against one while another conversation is visible.
   * Returns null for sessions never opened here; those stay pending until
   * the user actually visits the workspace. */
  controllerFor(sessionId: string): ChatController | null {
    return this.controllers.get(sessionId) ?? null;
  }

  /** The transcript host of a live session (roadmap 5.2: settle-notification
   * classification probes the settled transcript's tail). Null when the
   * controller is not live. */
  sessionHost(sessionId: string): HTMLElement | null {
    return this.hosts.get(sessionId) ?? null;
  }

  /** Cancel and drop every live session controller + host (delete-all). */
  clearAll(): void {
    for (const sessionId of [...this.controllers.keys()]) this.forgetSession(sessionId);
  }

  /** Current visible session id. */
  getSessionId(): string {
    return this.activeNow().getSessionId();
  }

  /** Whether the session identified by `sessionId` is still open (live). */
  hasOpenSession(sessionId: string): boolean {
    return this.controllers.has(sessionId);
  }

  /** Live sessions streaming RIGHT NOW, including ones never persisted to disk
   * (a first turn still running has no SessionMeta yet). The sidebar merges
   * these into its list so background work stays visible with a running dot
   * instead of vanishing until its first persist. Titles come from the live
   * transcript via the same extractTitle rule persistence uses, so the entry
   * the user sees now matches the one disk will show later. */
  getRunningLiveSessions(): Array<{ id: string; title: string; workspace: string }> {
    const out: Array<{ id: string; title: string; workspace: string }> = [];
    for (const id of runningSessionIds) {
      const controller = this.controllers.get(id);
      if (controller) {
        out.push({
          id,
          title: extractTitle(controller.getMessages()),
          workspace: controller.getEffectiveWorkspace(),
        });
      }
    }
    return out;
  }

  /** Dispose a session's controller: cancels its run and removes its host.
   * Used when a session is deleted from the sidebar. If it was the visible
   * session the caller is expected to follow with clear()/landing. */
  forgetSession(sessionId: string): void {
    const controller = this.controllers.get(sessionId);
    if (!controller) return;
    controller.cancel();
    controller.setViewActive(false);
    this.hosts.get(sessionId)?.remove();
    this.hosts.delete(sessionId);
    this.controllers.delete(sessionId);
    if (runningSessionIds.delete(sessionId)) runningSessionsListeners.forEach((cb) => cb());
    if (this.current === controller) {
      this.current = null;
      this.currentHost = null;
      this.currentSessionId = '';
    }
  }

  /** New chat: start a fresh conversation. On the 新建对话 / ⌘N path
   * (keepRunningSession) a still-streaming visible session is NOT cancelled —
   * it keeps running in the background exactly like a hidden session does on a
   * sidebar switch: own host, own persistence, sidebar running dot. The user
   * can stop it explicitly or switch back mid-run. Without the flag (the
   * delete-visible-session path via resetToLanding) the run IS stopped: a
   * deleted session must not keep executing or re-persisting after its disk
   * state is gone. Idle sessions are always dropped, so repeated new-chats
   * never build up dead controllers. */
  clear({ keepRunningSession = false }: { keepRunningSession?: boolean } = {}): void {
    const id = this.currentSessionId || this.getSessionId();
    const keepRunning = keepRunningSession && this.controllers.get(id)?.isStreaming() === true;
    if (!keepRunning) this.forgetSession(id);
    // A fresh, empty conversation becomes the new active session. makeActive()
    // flips the kept controller to viewActive(false), so it parks in the
    // background through the same path a sidebar switch uses.
    this.openSession(`session_${Date.now()}_${this.nextSessionSeq++}`);
  }

  cancel(): void {
    this.activeNow().cancel();
  }

  /** 阶段 12: pause = resumable stop. Delegates to the visible controller;
   * the 「继续」 bar lives inside it, so a pause in a background session waits
   * there until that session is shown again. */
  pause(): void {
    this.activeNow().pause();
  }

  /** 1c Esc 统一：第一下暂停、暂停收尾期里再按升级硬停（转发到可见会话）。 */
  escapeWhileStreaming(): void {
    this.activeNow().escapeWhileStreaming();
  }

  cancelAutoContinue(): void {
    this.activeNow().cancelAutoContinue();
  }

  async send(...args: Parameters<ChatController['send']>): Promise<void> {
    await this.activeNow().send(...args);
  }

  /** Append a status line to the visible transcript (see ChatController's). */
  notifyStatus(text: string): void {
    this.activeNow().notifyStatus(text);
  }

  /** MCP prompt templates of the visible session's client (composer
   *  autocomplete, 6.2). Read-only: never connects on its own. */
  async listMcpPrompts(waitMs?: number): Promise<MCPPromptSummary[]> {
    return this.activeNow().listMcpPrompts(waitMs);
  }

  /** Resources the visible session's MCP client already discovered (Settings
   *  card prefill). Read-only: never connects on its own. */
  async listMcpResources(waitMs?: number): Promise<MCPResourceSummary[]> {
    return this.activeNow().listMcpResources(waitMs);
  }

  /** Expand a `/mcp-prompt …` composer draft (6.2). Null for non-commands. */
  async expandMcpPromptCommand(text: string): Promise<{ ok: true; text: string; label: string } | { ok: false; error: string } | null> {
    return this.activeNow().expandMcpPromptCommand(text);
  }

  async interject(...args: Parameters<ChatController['interject']>): Promise<void> {
    await this.activeNow().interject(...args);
  }

  isStreaming(): boolean {
    return this.activeNow().isStreaming();
  }

  onStreamingStateChange(fn: (streaming: boolean) => void): void {
    this.streamingCb = fn;
  }

  setWorkspace(path: string): void {
    this.activeNow().setWorkspace(path);
  }

  getWorkspace(): string {
    return this.activeNow().getWorkspace();
  }

  getEffectiveWorkspace(): string {
    return this.activeNow().getEffectiveWorkspace();
  }

  async syncEffectiveWorkspace(): Promise<void> {
    await this.activeNow().syncEffectiveWorkspace();
  }

  loadFromStorage(snapshot: SessionSnapshotV2): void {
    this.activeNow().loadFromStorage(snapshot);
  }

  mountAgentActivityPanel(): void {
    this.activeNow().mountAgentActivityPanel();
  }

  registerPausedAssessment(flow: AssessmentFlowHandle | null): void {
    this.activeNow().registerPausedAssessment(flow);
  }

  registerRestoredPlanCard(card: PlanCardHandle): void {
    this.activeNow().registerRestoredPlanCard(card);
  }

  getPlanProgressModel(): PlanProgressModel | null {
    return this.activeNow().getPlanProgressModel();
  }

  continuePausedPlan(): boolean {
    return this.activeNow().continuePausedPlan();
  }

  cancelPausedPlan(): boolean {
    return this.activeNow().cancelPausedPlan();
  }

  onSessionStatsChanged(fn: (stats: SessionStats) => void): void {
    this.statsCb = fn;
  }

  getSessionStats(): SessionStats {
    return this.activeNow().getSessionStats();
  }

  onWorkspaceSnapshotChanged(fn: (available: boolean) => void): void {
    this.snapshotCb = fn;
    const current = this.current;
    if (current) fn(current.hasUndoableWrites());
  }

  getMessages(): Message[] {
    return this.activeNow().getMessages();
  }

  getContextOverheadTokens(): { system: number; tools: number } {
    return this.activeNow().getContextOverheadTokens();
  }

  getLastCompaction(): ContextCompactionResult | null {
    return this.activeNow().getLastCompaction();
  }

  async undoLastWriteBatch(): Promise<WorkspaceRestoreResult> {
    return this.activeNow().undoLastWriteBatch();
  }

  async compactContext(): Promise<ContextCompactionResult> {
    return this.activeNow().compactContext();
  }
}
