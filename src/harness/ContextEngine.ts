// src/harness/ContextEngine.ts
// v0.6 — context compaction with tool-call atomicity and explicit results.
// 8.1 — the token budget is the primary retention bound: when maxTokens is
// configured (the production default via configureBudget) the message-count
// window stands down entirely, so small messages are kept as long as they
// fit the provider window instead of being cut at the count. maxMessages
// governs only when no token budget is known (standalone/test use).
// 9.1 — three more layers, in the order the mainstream agents apply them:
//   L1 microcompaction: tool RESULT bodies are replaced by a placeholder
//      (zero LLM cost) before any message is evicted. Long agent sessions
//      spend most of their window on tool output; shedding that first keeps
//      the conversational skeleton (who asked what, what was decided) intact
//      instead of deleting whole turns. The protected tail is sized by token
//      budget, not just a result count, and an atomic group that alone cannot
//      fit (a parallel batch) has its bodies cleared instead of hard-stopping
//      the run: the assistant toolCalls and toolCallIds stay, so the request
//      remains valid.
//   L2 summary: whenever messages ARE evicted and an adapter is available the
//      eviction is summarized. The old "only past 40 evicted messages" gate
//      meant a token-driven overflow of 5 messages silently dropped content —
//      the exact failure that lost an attachment path across turns.
//   L3 rehydration: after a compaction that evicted something, the workspace
//      state the model was working from is restated — the most recently
//      modified files are re-read from disk and the live plan/todos are
//      re-declared — so the model resumes against the real files rather than
//      a summary's memory of them.

import { estimateToolDefinitionTokens } from '../shared/providers';
import { estimateTextTokens } from '../shared/tokenEstimate';
import { stripUserTurnContext } from '../shared/promptLayers';
import { closeDanglingFence } from '../shared/fenceHygiene';
import type { Message, MessageImage, LLMAdapter, ToolDefinition } from '../shared/types';

export interface ContextMicrocompactionConfig {
  /** Count ceiling for the protected tail (default 8). */
  keepRecent?: number;
  /** Token budget for the protected tail. The newest tool results are kept
   *  verbatim only while their cumulative size fits BOTH this budget and
   *  `keepRecent`: eight max-size reads can dwarf a small window, and the old
   *  count-only rule protected all of them. Defaults to 10% of the configured
   *  window (clamped 2K–32K); ignored when no budget is configured. */
  keepRecentTokens?: number;
  /** Results shorter than this many characters are left alone: the
   *  placeholder costs tokens too, and clearing a 40-char `ok` reclaims
   *  nothing while churning the prompt cache (default 1000). */
  minChars?: number;
}

export interface ContextRehydrationConfig {
  /** Read a file's current text; return undefined when it cannot be read.
   *  Omit to skip file rehydration (plan/todo restatement still applies). */
  readFile?: (path: string) => Promise<string | undefined>;
  /** Current plan / todo lines to restate after compaction. Omit when the
   *  host has no plan surface (CLI). */
  todos?: () => string | undefined | Promise<string | undefined>;
  /** Capacities mirror the mainstream rehydration budget (defaults 5 / 5000 / 50000). */
  maxFiles?: number;
  maxCharsPerFile?: number;
  maxTotalChars?: number;
}

export interface ContextEngineConfig {
  /** Retention bound when no token budget is configured. With a token
   *  budget (production always resolves one) this window does not bind. */
  maxMessages: number;
  /** Token budget for messages plus the provider's output reserve. */
  maxTokens?: number;
  /** Tool schemas are sent outside messages and must count toward the same window. */
  tools?: ToolDefinition[];
  toolsProvider?: () => ToolDefinition[];
  llm?: LLMAdapter;
  /** L1 tool-result microcompaction. `false` disables the layer entirely. */
  microcompaction?: ContextMicrocompactionConfig | false;
  /** L3 post-compaction rehydration. `false` disables the layer entirely. */
  rehydration?: ContextRehydrationConfig | false;
}

export interface ContextCompactionOptions {
  /** Re-run compaction even when the current window is already within limits. */
  force?: boolean;
  /** Reactive mode: the provider rejected the request as too long despite the
   *  estimator saying it fit. Compacts to a safety margin BELOW the configured
   *  budget and lets the cheap layers clear aggressively, so the retry
   *  actually converges instead of overflowing again. */
  aggressive?: boolean;
  /** Soft mode (idle pre-compaction): shed at `trigger`×budget instead of
   *  waiting for the wall. Above `trigger` (measured after L1) the retained
   *  window is bounded by `target`×budget — the oldest groups leave through
   *  the normal L2 summary, nothing drops silently, and the next send never
   *  crosses 100% on the critical path. Without this the idle pass is a no-op
   *  until the window is already over budget, so the FIRST over-budget send
   *  blocks on the summarizer (up to 60s) mid-task. */
  soft?: { trigger: number; target: number };
  /** Skip the L2 summarizer call even when messages were evicted. Stop-time
   *  salvage uses this: the turn is already ending, evicted content is covered
   *  by L3 rehydration + the handover summary, and blocking the stop on a
   *  60s summarizer call is exactly the wrong moment to be patient. */
  skipSummary?: boolean;
}

export interface ContextCompactionResult {
  messages: Message[];
  compacted: boolean;
  summarized: boolean;
  summaryUnavailable: boolean;
  evictedMessages: number;
  estimatedTokens: number;
  overBudget: boolean;
  oversizedNewestGroup: boolean;
  /** L1 — tool results replaced by a placeholder this pass. */
  microcompactedToolResults: number;
  /** L1 — tokens the placeholder substitution removed from the window. */
  reclaimedTokens: number;
  /** L3 — files re-read and restated after the compaction. */
  rehydratedFiles: number;
  /** L3 — a live plan/todo list was restated after the compaction. */
  restoredPlan: boolean;
}

interface MessageGroup {
  messages: Message[];
  retainable: boolean;
}

const SUMMARY_TIMEOUT_MS = 60_000;

/** Per-message excerpt caps for the summarizer prompt. composeUserTurn
 * prepends the <task_context> wrapper to user turns; without stripping it the
 * wrapper eats the excerpt budget and whatever follows it — the attachment
 * path lines — is exactly what the summarizer never sees (it is then asked to
 * "include file paths mentioned" and has to invent one). The head+tail split
 * keeps both the request (head) and trailing attachment-path blocks (tail)
 * when a message must still be cut. */
const USER_SUMMARY_EXCERPT_CHARS = 2_000;
const TOOL_SUMMARY_EXCERPT_CHARS = 500;

/** Soft thresholds for PROACTIVE compaction. The hosts run this in an idle
 *  slot between turns; the engine runs the same numbers before every send, so
 *  a single long turn (dozens of tool rounds) also sheds at 85% instead of
 *  growing until the provider rejects the request. Kept here rather than in
 *  each host so the two paths cannot drift to different lines. */
export const PROACTIVE_COMPACT_TRIGGER = 0.85;
export const PROACTIVE_COMPACT_TARGET = 0.7;

/** L1 defaults — see ContextMicrocompactionConfig. */
const MICROCOMPACT_KEEP_RECENT = 8;
const MICROCOMPACT_MIN_CHARS = 1_000;
/** Protected-tail token budget fallbacks (window-relative in production). */
const MICROCOMPACT_RECENT_TOKEN_SHARE = 0.1;
const MICROCOMPACT_RECENT_TOKEN_MIN = 2_000;
const MICROCOMPACT_RECENT_TOKEN_MAX = 32_000;
const MICROCOMPACT_KEEP_RECENT_TOKENS = 8_000;
/** Reactive compaction keeps only the newest two results as a starting point;
 *  the target-driven second pass may still clear them when the tail alone
 *  exceeds the provider's real limit. */
const AGGRESSIVE_KEEP_RECENT_TOKENS = 2_000;
/** Reactive mode protects fewer results and clears smaller ones so a retry
 *  that overflowed by a little is fixed by the cheap layer alone. */
const AGGRESSIVE_KEEP_RECENT = 2;
const AGGRESSIVE_MIN_CHARS = 200;
/** Reactive mode targets this fraction of the configured budget: the provider
 *  ignored our estimate once, so land well under the limit rather than on it. */
const AGGRESSIVE_BUDGET_RATIO = 0.7;

/** Clamp a soft-mode fraction into [0, 1]. The caller passes constants; this
 *  keeps a bad config from producing a nonsense retention budget. */
function softFraction(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Vision payload fallback when the snapshot predates width/height. A
 *  ~1100×1100 image lands near this after provider-side resizing; providers
 *  bill images by pixels, so treating them as text/base64 is not an option. */
export const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1_600;

/** Anthropic downsizes the long edge to 1568 before tokenizing; using the same
 *  cap keeps our estimate comparable across providers instead of billing a 4K
 *  screenshot as 9M pixels. Tokens ≈ width × height / 750. */
const IMAGE_LONG_EDGE_CAP = 1_568;

/** Below this many tokens a usage report is dominated by chat-template noise
 *  and one-off overhead, so it must not move the calibration. */
const MIN_USAGE_CALIBRATION_TOKENS = 1_000;
/** Keep a single pathological report (provider counting a huge system prompt
 *  we cannot see, or an error body's usage) from swinging every later trim. */
const USAGE_SCALE_MIN = 0.5;
const USAGE_SCALE_MAX = 3;
/** EMA weight for a new observation: one sample should move the line, a burst
 *  of cache-hit/cache-miss variance should not make the trigger oscillate. */
const USAGE_SCALE_SMOOTHING = 0.35;

/** Estimated vision tokens for one inline image. Dimensions win when present;
 *  old snapshots without them get the constant instead of zero, because zero
 *  is exactly the blind spot that let image-heavy sessions overflow. */
export function estimateImageTokens(image: MessageImage): number {
  const width = image.width ?? 0;
  const height = image.height ?? 0;
  if (width > 0 && height > 0) {
    const longEdge = Math.max(width, height);
    const scale = longEdge > IMAGE_LONG_EDGE_CAP ? IMAGE_LONG_EDGE_CAP / longEdge : 1;
    return Math.max(1, Math.ceil((width * scale * height * scale) / 750));
  }
  return DEFAULT_IMAGE_TOKEN_ESTIMATE;
}

/** L3 defaults (files / per-file chars / total chars). */
const REHYDRATE_MAX_FILES = 5;
const REHYDRATE_MAX_CHARS_PER_FILE = 5_000;
const REHYDRATE_MAX_TOTAL_CHARS = 50_000;

/** Tool calls that leave a file in the workspace: the rehydration candidates. */
const FILE_MUTATION_TOOL_RE = /^(write_file|create_file|edit_file|apply_patch|str_replace|multi_edit|notebook_edit|write|edit)$/i;

/** The rehydration block's first line. Used both to announce the block and,
 *  on the NEXT compaction, to recognize and drop the stale one — otherwise a
 *  fresh copy stacks up on every compaction and never leaves the window. */
const REHYDRATION_PREFIX = 'State restored after context compaction';

function summarizeExcerpt(message: Message): string {
  const raw = message.content ?? '';
  const text = message.role === 'user' ? stripUserTurnContext(raw) : raw;
  const cap = message.role === 'user' ? USER_SUMMARY_EXCERPT_CHARS : TOOL_SUMMARY_EXCERPT_CHARS;
  if (text.length <= cap) return text;
  const headLen = Math.max(1, Math.ceil(cap * 0.7));
  const tailLen = Math.max(1, cap - headLen);
  // head/tail 各自做围栏卫生再拼 excerpt 标记：head 停在 ``` 中途时不补收
  // 栏，标记行和它后面的一切都会被模型吞进围栏里读（注入面截断卫生，
  // fenceHygiene.ts——渲染侧同族判例 0b5679f）。
  const head = closeDanglingFence(text.slice(0, headLen));
  const tail = closeDanglingFence(text.slice(text.length - tailLen));
  return `${head}\n[...excerpt...]\n${tail}`;
}

/** Single source for compaction sizing: content + tool-call arguments, shared
 *  with the GUI's background pre-compaction gate so both surfaces blind-spot
 *  the same wire payload or neither does. */
export function estimateTokens(messages: Message[]): number {
  let sum = 0;
  for (const message of messages) {
    sum += estimateTextTokens(message.content ?? '');
    // Vision payloads ride outside `content` (adapters map them to native
    // image blocks), so the old text-only sum counted a screenshot as zero.
    if (message.images?.length) {
      for (const image of message.images) sum += estimateImageTokens(image);
    }
    // Tool-call arguments ARE wire payload: mapMessages serializes every
    // assistant tool_calls entry (write_file `content` = a whole file) into
    // the request body, yet none of it lives in `content`. Blind to it, the
    // compactor under-counted exactly the heaviest part of a long task,
    // "trimmed" to a window that still overflowed, and every request came
    // back 400 (context length) — the session wedged, immune to "继续".
    if (message.toolCalls) {
      for (const call of message.toolCalls) {
        // Dense JSON (quotes, escapes, punctuation) runs ~3 chars/token, not
        // the Latin-average 4 — pad by 4/3 so the estimator's residue can't
        // eat the whole safety margin.
        sum += Math.ceil(
          (estimateTextTokens(call.function.name) + estimateTextTokens(call.function.arguments)) * 4 / 3,
        );
      }
    }
  }
  return sum;
}

/** The placeholder that replaces a cleared tool result. It keeps the message's
 *  role/toolCallId/toolName untouched — the wire protocol stays valid — and
 *  tells the model both what was dropped and how to get it back. */
function microcompactedPlaceholder(toolName: string | undefined, chars: number): string {
  return `[old ${toolName ?? 'tool'} result cleared after compaction — ${chars} chars omitted. Re-run the tool if you still need this content.]`;
}

/** Window-relative protected-tail budget: recent tool context is worth about
 *  a tenth of the input window, with hard floors/ceilings so a tiny test window
 *  still protects something and a 1M window does not hoard a whole file. */
function recentToolResultBudget(maxTokens: number | undefined): number {
  if (maxTokens === undefined) return MICROCOMPACT_KEEP_RECENT_TOKENS;
  return Math.max(
    MICROCOMPACT_RECENT_TOKEN_MIN,
    Math.min(MICROCOMPACT_RECENT_TOKEN_MAX, Math.floor(maxTokens * MICROCOMPACT_RECENT_TOKEN_SHARE)),
  );
}

/**
 * L1 — replace the content of tool results with a placeholder.
 * Pure text surgery: no LLM call, no message dropped, no tool pair broken — the
 * assistant's toolCalls and every tool message (with its toolCallId) stay put,
 * so the wire request remains valid.
 *
 * Protection is "newest N results AND a token budget", not count alone: the
 * model usually still works from the recent results, but eight 32KB reads are
 * not a working set on a 64K window. When `reclaimTokens` is supplied (the
 * pressure path) the oldest unprotected results give first. If that is not
 * enough — e.g. the newest parallel batch alone is larger than the target —
 * the second pass clears inside the protected tail, oldest first, including
 * the newest batch's own results. That is deliberately better than evicting a
 * whole atomic batch or stopping the run: a placeholder says what was dropped
 * and that the tool can be re-run, while a hard stop loses the task.
 */
export function microcompactToolResults(
  messages: Message[],
  options: {
    keepRecent: number;
    minChars: number;
    /** Budget for the protected tail; only meaningful with `reclaimTokens`. */
    keepRecentTokens?: number;
    /** Reclaim enough tokens to fall to the pressure line. Omit for the legacy
     *  "clear every unprotected result" behavior (tests / count-only mode). */
    reclaimTokens?: number;
    /** Also clear inside the protected tail when the reclaimed amount is not
     *  enough. Reserved for reactive compaction and the post-eviction
     *  oversized-group emergency: normal pressure evicts old whole groups
     *  instead, so the working tail keeps its newest results. */
    clearProtected?: boolean;
  },
): { messages: Message[]; cleared: number; reclaimedTokens: number } {
  const toolIndices: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === 'tool') toolIndices.push(index);
  }
  const protectedIndices = new Set<number>();
  const tailBudget = options.reclaimTokens === undefined ? undefined : (options.keepRecentTokens ?? Number.POSITIVE_INFINITY);
  if (tailBudget === undefined) {
    for (const index of toolIndices.slice(-options.keepRecent)) protectedIndices.add(index);
  } else {
    let protectedTokens = 0;
    for (let cursor = toolIndices.length - 1; cursor >= 0 && protectedIndices.size < options.keepRecent; cursor--) {
      const index = toolIndices[cursor];
      const size = estimateTextTokens(messages[index].content ?? '');
      // Always take the newest result (the model may be holding it); older
      // ones join only while the tail still fits the budget.
      if (protectedIndices.size > 0 && protectedTokens + size > tailBudget) break;
      protectedIndices.add(index);
      protectedTokens += size;
    }
  }

  const reclaimTarget = options.reclaimTokens ?? Number.POSITIVE_INFINITY;
  const output = messages.slice();
  const clearedIndices = new Set<number>();
  let cleared = 0;
  let reclaimedTokens = 0;
  const clear = (index: number, minChars: number = options.minChars): boolean => {
    const message = output[index];
    if (message.role !== 'tool') return false;
    const text = message.content ?? '';
    if (text.length < minChars) return false;
    const placeholder = microcompactedPlaceholder(message.toolName, text.length);
    const saving = estimateTextTokens(text) - estimateTextTokens(placeholder);
    if (saving <= 0) return false;
    output[index] = { ...message, content: placeholder };
    clearedIndices.add(index);
    cleared++;
    reclaimedTokens += saving;
    return true;
  };

  // Pass 1 — oldest unprotected results first: the working tail stays intact
  // as long as shedding the stale ones is enough.
  for (const index of toolIndices) {
    if (reclaimedTokens >= reclaimTarget) break;
    if (!protectedIndices.has(index)) clear(index);
  }
  // Pass 2 — pressure still above the line: clear inside the protected tail,
  // oldest first. The newest result survives whenever the target allows it.
  if (options.clearProtected === true && reclaimedTokens < reclaimTarget) {
    for (const index of toolIndices) {
      if (reclaimedTokens >= reclaimTarget) break;
      if (protectedIndices.has(index)) clear(index);
    }
  }
  // Pass 3 — emergency floor: the only remaining results are shorter than
  // `minChars` (a parallel batch of medium reads). Skipping them would trade a
  // few placeholder tokens for a hard stop. Big net savings first, so the
  // fewest results leave the transcript; the saving guard still skips any
  // result the placeholder would not actually shrink.
  if (options.clearProtected === true && reclaimedTokens < reclaimTarget) {
    const candidates = toolIndices
      .filter(index => !clearedIndices.has(index))
      .map(index => ({
        index,
        saving: estimateTextTokens(output[index].content ?? '') -
          estimateTextTokens(microcompactedPlaceholder(output[index].toolName, (output[index].content ?? '').length)),
      }))
      .filter(candidate => candidate.saving > 0)
      .sort((a, b) => b.saving - a.saving);
    for (const candidate of candidates) {
      if (reclaimedTokens >= reclaimTarget) break;
      clear(candidate.index, 1);
    }
  }
  return { messages: output, cleared, reclaimedTokens };
}

/** Pull a path out of a tool call's JSON arguments. Partial/streamed arguments
 *  simply yield no path — a rehydration candidate we cannot name is skipped. */
function extractToolPath(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    for (const key of ['path', 'file_path', 'filePath', 'filename', 'file', 'target_file']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    // Partial JSON — no path.
  }
  return undefined;
}

/** Newest-first list of files this conversation mutated, deduped, capped. */
export function collectModifiedFilePaths(messages: Message[], limit: number): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (let index = messages.length - 1; index >= 0 && paths.length < limit; index--) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    for (const call of message.toolCalls) {
      if (paths.length >= limit) break;
      if (!FILE_MUTATION_TOOL_RE.test(call.function.name)) continue;
      const path = extractToolPath(call.function.arguments);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

/**
 * L3 — assemble the post-compaction state block: re-read the files the
 * conversation most recently changed, and restate the live plan/todos. Both
 * halves are optional; a host with neither configured gets no block and the
 * behavior is exactly the pre-9.1 compaction.
 */
export async function buildRehydrationMessage(
  messages: Message[],
  config: ContextRehydrationConfig,
): Promise<{ message: Message; files: number; restoredPlan: boolean } | undefined> {
  const parts: string[] = [];
  let files = 0;
  if (config.readFile) {
    const maxFiles = config.maxFiles ?? REHYDRATE_MAX_FILES;
    const maxCharsPerFile = config.maxCharsPerFile ?? REHYDRATE_MAX_CHARS_PER_FILE;
    let remaining = config.maxTotalChars ?? REHYDRATE_MAX_TOTAL_CHARS;
    for (const path of collectModifiedFilePaths(messages, maxFiles)) {
      if (remaining <= 0) break;
      let text: string | undefined;
      try {
        text = await config.readFile(path);
      } catch {
        text = undefined;
      }
      if (typeof text !== 'string' || text.length === 0) continue;
      const cap = Math.min(maxCharsPerFile, remaining);
      // 先闭合围栏再拼 truncated 标记：cap 停在 ``` 中途时，标记行不能跟着
      // 被吞进未闭合围栏（同 summarizeExcerpt 的注入面卫生）。
      const body = text.length > cap ? `${closeDanglingFence(text.slice(0, cap))}\n[...truncated]` : text;
      remaining -= body.length;
      files++;
      parts.push(`--- ${path} ---\n${body}`);
    }
  }
  let restoredPlan = false;
  if (config.todos) {
    let todos: string | undefined;
    try {
      todos = await config.todos();
    } catch {
      todos = undefined;
    }
    if (todos && todos.trim()) {
      restoredPlan = true;
      parts.push(`Live plan / todos:\n${todos.trim()}`);
    }
  }
  if (parts.length === 0) return undefined;
  const header = files > 0
    ? `${REHYDRATION_PREFIX} — the versions of these files from before the compaction were evicted; these are their current on-disk contents. Do not assume earlier text still applies.`
    : `${REHYDRATION_PREFIX} — the transcript was trimmed; this is the live state to continue from.`;
  return {
    message: { role: 'system', content: `${header}\n\n${parts.join('\n\n')}` },
    files,
    restoredPlan,
  };
}

export class ContextEngine {
  private config: ContextEngineConfig;
  private lastCompactionResult?: ContextCompactionResult;
  /** Provider-reported prompt tokens ÷ our estimate, learned from usage. The
   *  estimator is a text heuristic (plus the image formula above); providers
   *  count chat templates, image blocks and tokenizer differences on their
   *  side. Without this ratio the 85% line is measured in our units while the
   *  wall is in theirs — the failure mode is a preflight that believes it fits
   *  and a provider that rejects it. */
  private usageScale = 1;
  private usageSamples = 0;

  constructor(config: ContextEngineConfig) {
    this.config = {
      maxMessages: Math.max(1, config.maxMessages),
      maxTokens: config.maxTokens,
      tools: config.tools,
      toolsProvider: config.toolsProvider,
      llm: config.llm,
      microcompaction: config.microcompaction,
      rehydration: config.rehydration,
    };
  }

  async trim(messages: Message[]): Promise<Message[]> {
    return (await this.compact(messages)).messages;
  }

  /** Proactive pre-send compaction: shed to `target` once the window is past
   *  `trigger`. Soft mode keeps L1 (tool-result clearing) as the first resort,
   *  so a window that the cheap layer alone can bring back under the trigger
   *  loses no message at all. */
  async compactBeforeSend(messages: Message[]): Promise<ContextCompactionResult> {
    return this.compact(messages, {
      soft: { trigger: PROACTIVE_COMPACT_TRIGGER, target: PROACTIVE_COMPACT_TARGET },
    });
  }

  getLastCompactionResult(): ContextCompactionResult | undefined {
    return this.lastCompactionResult;
  }

  /**
   * Cheap pre-send pressure check: text estimation only, no LLM call, no
   * mutation. The engine asks this before every THINK request so the cheap
   * no-op path (most rounds) costs one transcript scan instead of running a
   * full compaction that would immediately return unchanged.
   *
   * Returns false without a token budget: the count window (`maxMessages`) is
   * a standalone/test fallback with no notion of headroom, so a proactive
   * pass there has nothing to size itself against — the per-turn trim still
   * enforces it.
   */
  needsCompaction(messages: Message[], trigger: number = PROACTIVE_COMPACT_TRIGGER): boolean {
    const max = this.config.maxTokens;
    if (max === undefined) return false;
    const toolTokens = this.scaleTokens(estimateToolDefinitionTokens(this.config.toolsProvider?.() ?? this.config.tools));
    return this.scaledEstimate(messages) + toolTokens > max * softFraction(trigger);
  }

  /** Feed one provider response's prompt-token count back into the estimator.
   *  Ignored below {@link MIN_USAGE_CALIBRATION_TOKENS} (noise) and clamped to
   *  a sane band (a single broken report must not wedge every later trim).
   *  Purely advisory: a provider that reports no usage leaves the scale at 1
   *  and behavior is exactly the text/image estimate. */
  observePromptUsage(promptTokens: number | undefined, messages: Message[]): void {
    if (promptTokens === undefined || !Number.isFinite(promptTokens) || promptTokens < MIN_USAGE_CALIBRATION_TOKENS) return;
    const raw = estimateTokens(messages) + estimateToolDefinitionTokens(this.config.toolsProvider?.() ?? this.config.tools);
    if (raw < MIN_USAGE_CALIBRATION_TOKENS) return;
    const observed = Math.min(USAGE_SCALE_MAX, Math.max(USAGE_SCALE_MIN, promptTokens / raw));
    this.usageScale = this.usageSamples === 0
      ? observed
      : this.usageScale * (1 - USAGE_SCALE_SMOOTHING) + observed * USAGE_SCALE_SMOOTHING;
    this.usageSamples += 1;
  }

  /** The learned provider/estimate ratio (1 = uncalibrated). Exposed for
   *  diagnostics and tests; hosts do not need to call it. */
  getEstimateScale(): number {
    return this.usageScale;
  }

  private scaleTokens(tokens: number): number {
    return this.usageScale === 1 ? tokens : Math.ceil(tokens * this.usageScale);
  }

  private scaledEstimate(messages: Message[]): number {
    return this.scaleTokens(estimateTokens(messages));
  }

  async compact(
    messages: Message[],
    options: ContextCompactionOptions = {},
  ): Promise<ContextCompactionResult> {
    const allSystemMessages = messages.filter(message => message.role === 'system');
    const baseSystemMessages = allSystemMessages.filter(
      message => !this.isCompactionSummary(message) && !this.isRehydrationMessage(message),
    );
    const priorSummaries = allSystemMessages.filter(message => this.isCompactionSummary(message));
    const priorSummary = priorSummaries.at(-1);
    const priorRehydration = allSystemMessages.filter(message => this.isRehydrationMessage(message)).at(-1);
    const systemMessages = [
      ...baseSystemMessages,
      ...(priorSummary ? [priorSummary] : []),
      ...(priorRehydration ? [priorRehydration] : []),
    ];
    const toolTokens = this.scaleTokens(estimateToolDefinitionTokens(this.config.toolsProvider?.() ?? this.config.tools));
    const configuredMax = this.config.maxTokens;

    // ── L1: microcompaction ──────────────────────────────────────────────
    // Runs before eviction, and only under pressure: it rewrites content in
    // the middle of the history, which invalidates provider cache breakpoints
    // after that point. That cost is worth paying exactly when the window is
    // over budget — which is also the only time the old path would have
    // deleted whole turns instead.
    let working = messages;
    let microcompactedToolResults = 0;
    let reclaimedTokens = 0;
    const microSetting = this.config.microcompaction === false ? undefined : (this.config.microcompaction ?? {});
    const preTokens = this.scaledEstimate(messages) + toolTokens;
    const underPressure = configuredMax !== undefined && preTokens > configuredMax;
    // Soft mode is pressure too: give L1 the first shot — if the cheap layer
    // alone sheds the window back under the trigger, no message is evicted.
    const softPressure = options.soft !== undefined && configuredMax !== undefined &&
      preTokens > configuredMax * softFraction(options.soft.trigger);
    const overCountWindow = configuredMax === undefined && messages.filter(m => m.role !== 'system').length > this.config.maxMessages;
    if (microSetting && (underPressure || overCountWindow || softPressure || options.aggressive === true)) {
      const baseKeep = microSetting.keepRecent ?? MICROCOMPACT_KEEP_RECENT;
      const baseMin = microSetting.minChars ?? MICROCOMPACT_MIN_CHARS;
      // How far L1 must shed: reactive lands on the aggressive target (the
      // provider already refused once); soft lands just under its trigger; the
      // hard path only needs to get under the wall (eviction/summary then own
      // the rest). Measuring the goal itself keeps L1 from over-clearing.
      const l1Target = configuredMax === undefined
        ? undefined
        : options.aggressive
          ? Math.max(1, Math.floor(configuredMax * AGGRESSIVE_BUDGET_RATIO))
          : softPressure && options.soft !== undefined
            ? configuredMax * softFraction(options.soft.trigger)
            : underPressure
              ? configuredMax
              : undefined;
      // `l1Target` and the pressure figures are provider-token units (maxTokens),
      // while L1 substantiates its savings in our own estimate. Convert the
      // target back before subtracting, or a calibrated scale (>1) would ask L1
      // to shed more than the window actually needs and clear useful results.
      const l1RawTarget = l1Target === undefined
        ? undefined
        : Math.max(0, Math.ceil(estimateTokens(messages) -
            (l1Target / this.usageScale - estimateToolDefinitionTokens(this.config.toolsProvider?.() ?? this.config.tools))));
      const outcome = microcompactToolResults(messages, {
        keepRecent: options.aggressive ? Math.min(baseKeep, AGGRESSIVE_KEEP_RECENT) : baseKeep,
        minChars: options.aggressive ? Math.min(baseMin, AGGRESSIVE_MIN_CHARS) : baseMin,
        keepRecentTokens: options.aggressive
          ? AGGRESSIVE_KEEP_RECENT_TOKENS
          : (microSetting.keepRecentTokens ?? recentToolResultBudget(configuredMax)),
        reclaimTokens: l1RawTarget,
        // Normal pressure leaves the newest results alone and lets eviction
        // drop old groups; reactive compaction has no such second chance.
        clearProtected: options.aggressive === true,
      });
      working = outcome.messages;
      microcompactedToolResults = outcome.cleared;
      reclaimedTokens = outcome.reclaimedTokens;
    }

    const nonSystem = working.filter(message => message.role !== 'system');
    const currentTokens = this.scaledEstimate([...systemMessages, ...nonSystem]) + toolTokens;
    // Token budget primary (8.1): with one configured, the count window is not
    // a trigger — a 40-message transcript of short turns is healthy, not over
    // budget. Without a token budget the count window is all we know.
    const overMessageBudget = configuredMax === undefined && nonSystem.length > this.config.maxMessages;
    const overTokenBudget = configuredMax !== undefined && currentTokens > configuredMax;
    // Post-L1 soft trigger: still above the trigger line even after the cheap
    // layer — now the eviction pass runs, bounded by the soft target.
    const softTriggered = options.soft !== undefined && configuredMax !== undefined &&
      currentTokens > configuredMax * softFraction(options.soft.trigger);
    // Reactive mode aims BELOW the configured budget: the provider already
    // rejected one request our estimator believed fit, so landing at exactly
    // the limit would just overflow again. Soft mode targets its own lower
    // line: shed to `target` so the window saws between target and trigger
    // instead of ever touching the wall.
    const retentionBudget = options.aggressive && configuredMax !== undefined
      ? Math.max(1, Math.floor(configuredMax * AGGRESSIVE_BUDGET_RATIO))
      : softTriggered && options.soft !== undefined
        ? Math.max(1, Math.floor(configuredMax * softFraction(options.soft.target)))
        : configuredMax;

    const groups = this.groupAtomicPairs(nonSystem);
    const hasInvalidFragments = groups.some(group => !group.retainable);
    const hasCollapsedSummaries = priorSummaries.length > 1;
    if (!options.force && !overMessageBudget && !overTokenBudget && !softTriggered && !hasInvalidFragments && !hasCollapsedSummaries) {
      // Microcompaction alone may have been enough. Report it honestly rather
      // than as a no-op, and keep the caller's message order (only tool-result
      // contents changed; nothing was moved or dropped).
      return this.remember({
        messages: microcompactedToolResults > 0 ? working : messages,
        compacted: microcompactedToolResults > 0,
        summarized: false,
        summaryUnavailable: false,
        evictedMessages: 0,
        estimatedTokens: currentTokens,
        overBudget: false,
        oversizedNewestGroup: false,
        microcompactedToolResults,
        reclaimedTokens,
        rehydratedFiles: 0,
        restoredPlan: false,
      });
    }

    const kept = new Set<MessageGroup>();
    const isUserGroup = (group: MessageGroup): boolean => group.messages[0]?.role === 'user';
    let keptCount = 0;
    let remainingTokens = retentionBudget === undefined
      ? undefined
      : retentionBudget - this.scaledEstimate(systemMessages) - toolTokens;

    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index];
      if (!group.retainable) continue;
      if (isUserGroup(group)) continue; // pinned below, outside the count budget

      const groupTokens = this.scaledEstimate(group.messages);
      // The count bound applies only in the no-token-budget fallback; with a
      // token budget the loop stops on tokens alone, keeping as many groups
      // as the provider window actually fits.
      const exceedsCount = retentionBudget === undefined &&
        keptCount > 0 && keptCount + group.messages.length > this.config.maxMessages;
      const exceedsTokens = remainingTokens !== undefined && keptCount > 0 && remainingTokens - groupTokens < 0;
      if (exceedsCount || exceedsTokens) break;

      kept.add(group);
      keptCount += group.messages.length;
      if (remainingTokens !== undefined) remainingTokens -= groupTokens;

      // A complete newest tool pair stays intact even if that pair itself is
      // larger than the configured window; splitting it would make the next
      // provider request invalid.
    }

    // User messages are pinned: they carry the request itself and the
    // attachment paths the app tells the model to read by absolute path, so
    // aging them out of the window is how a follow-up turn loses the task
    // anchor and goes hunting for a file it can no longer name. They do not
    // spend the assistant/tool window; only the token shed below may drop the
    // oldest ones.
    for (const group of groups) {
      if (group.retainable && isUserGroup(group)) kept.add(group);
    }

    // Last resort: pinned users alone pushed the window past the token budget
    // — shed the OLDEST pinned ones (they join `evicted`, so the summarizer
    // can still carry their content forward). The newest kept group is never
    // shed: the newest request must survive even when it alone exceeds the
    // window (oversizedNewestGroup below reports that case).
    if (remainingTokens !== undefined) {
      for (const group of groups) {
        if (kept.has(group) && isUserGroup(group)) remainingTokens -= this.scaledEstimate(group.messages);
      }
      const newestKept = [...groups].reverse().find(group => kept.has(group));
      for (const group of groups) {
        if (remainingTokens >= 0) break;
        if (group === newestKept) continue;
        if (!kept.has(group) || !isUserGroup(group)) continue;
        kept.delete(group);
        remainingTokens += this.scaledEstimate(group.messages);
      }
    }

    const retained: Message[] = [];
    const evicted: Message[] = [];
    let evictedRetainableMessages = 0;
    for (const group of groups) {
      if (kept.has(group)) retained.push(...group.messages);
      else {
        evicted.push(...group.messages);
        if (group.retainable) evictedRetainableMessages += group.messages.length;
      }
    }

    // An interrupted checkpoint may contain an incomplete tool call. Never
    // feed that dangling assistant/tool fragment back to a provider.
    const systemTokens = this.scaledEstimate(systemMessages) + toolTokens;
    const newestRetained = [...groups].reverse().find(group => kept.has(group));
    let oversizedNewestGroup = retentionBudget !== undefined &&
      systemTokens <= retentionBudget &&
      newestRetained !== undefined &&
      this.scaledEstimate(newestRetained.messages) > retentionBudget - systemTokens;

    // Emergency L1 inside the NEWEST group: a parallel tool batch is atomic,
    // so if the newest group alone does not fit, eviction has nothing left to
    // drop (older groups are gone or pinned users). Clear its tool-result
    // bodies instead — the assistant toolCalls and toolCallIds stay, the
    // request stays valid, and the model is told each result can be re-run.
    // Only this group is touched: clearing older results cannot shrink the
    // actual blocker and would trade useful context for nothing. Without this
    // the group was reported oversized and the run later hard-stopped.
    if (oversizedNewestGroup && microSetting && newestRetained!.messages.some(m => m.role === 'tool')) {
      const groupBudget = retentionBudget! - systemTokens;
      const groupExcess = this.scaledEstimate(newestRetained!.messages) - groupBudget;
      if (groupExcess > 0) {
        const emergency = microcompactToolResults(newestRetained!.messages, {
          keepRecent: 0,
          // The normal floor is deliberately conservative; an unshrinkable
          // newest batch justifies clearing medium results too (the saving
          // guard below still skips anything the placeholder would not shrink).
          minChars: Math.min(microSetting.minChars ?? MICROCOMPACT_MIN_CHARS, AGGRESSIVE_MIN_CHARS),
          reclaimTokens: groupExcess,
          clearProtected: true,
        });
        if (emergency.cleared > 0) {
          newestRetained!.messages.length = 0;
          newestRetained!.messages.push(...emergency.messages);
          // Rebuild the retained tail from the (mutated) group so the caller
          // persists the cleared bodies instead of the old messages.
          retained.length = 0;
          for (const group of groups) if (kept.has(group)) retained.push(...group.messages);
          microcompactedToolResults += emergency.cleared;
          reclaimedTokens += emergency.reclaimedTokens;
          oversizedNewestGroup = this.scaledEstimate(newestRetained!.messages) > groupBudget;
        }
      }
    }

    // ── L2: summarize every eviction ─────────────────────────────────────
    // The trigger is "messages were evicted", not "more than N were evicted":
    // a structural overflow that drops five turns is exactly as lossy as one
    // that drops fifty, and the silent-drop gate is how an attachment path
    // vanished between turns. Invalid-fragment-only evictions (a dangling
    // tool call from an interrupted checkpoint) carry no conversation and are
    // not worth a call.
    let summaryMessage: Message | undefined;
    let summarized = false;
    if (!options.skipSummary && this.config.llm && evictedRetainableMessages > 0) {
      try {
        const summaryInput = priorSummary ? [priorSummary, ...evicted] : evicted;
        const summaryPrompt = `Summarize the key information from this conversation. Include decisions made, code patterns discussed, file paths mentioned, user preferences, and unresolved work. Do not invent facts. Quote exact file paths and identifiers verbatim.\\n\\n${summaryInput.map(message => `${message.role}: ${summarizeExcerpt(message)}`).join('\\n')}`;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const summaryPromise = this.config.llm.complete([{ role: 'user', content: summaryPrompt }], [], controller.signal);
        const summary = await Promise.race([
          summaryPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`conversation summary timed out after ${SUMMARY_TIMEOUT_MS}ms`));
            }, SUMMARY_TIMEOUT_MS);
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
        summaryMessage = {
          role: 'system',
          content: `Earlier conversation summary: ${String(summary.content)}`,
        };
        summarized = true;
      } catch {
        // A failed summary must never prevent the bounded recent window.
      }
    }

    // ── L3: rehydrate the state the model was working from ───────────────
    // Only after a compaction that actually dropped messages, and only when a
    // host supplied the hooks. A stale rehydration block from an earlier
    // compaction is dropped and replaced by this fresh one (see
    // isRehydrationMessage), never stacked.
    let rehydratedFiles = 0;
    let restoredPlan = false;
    let rehydrationMessage: Message | undefined;
    if (evicted.length > 0 && this.config.rehydration !== false && this.config.rehydration) {
      const built = await buildRehydrationMessage(working, this.config.rehydration);
      if (built) {
        rehydrationMessage = built.message;
        rehydratedFiles = built.files;
        restoredPlan = built.restoredPlan;
      }
    }

    const ordered: Message[] = [...baseSystemMessages];
    if (summaryMessage) ordered.push(summaryMessage);
    else if (priorSummary) ordered.push(priorSummary);
    if (rehydrationMessage) ordered.push(rehydrationMessage);
    else if (priorRehydration) ordered.push(priorRehydration);
    ordered.push(...retained);

    // skipSummary is a deliberate skip, not an outage — report it honestly.
    const summaryUnavailable = evictedRetainableMessages > 0 && !summarized && !options.skipSummary;
    const estimatedTokens = this.scaledEstimate(ordered) + toolTokens;

    return this.remember({
      messages: ordered,
      compacted: overMessageBudget || overTokenBudget || evicted.length > 0 || ordered.length !== messages.length,
      summarized,
      summaryUnavailable,
      evictedMessages: evicted.length,
      estimatedTokens,
      overBudget: configuredMax !== undefined && estimatedTokens > configuredMax,
      oversizedNewestGroup,
      microcompactedToolResults,
      reclaimedTokens,
      rehydratedFiles,
      restoredPlan,
    });
  }

  /** Keep a caller-provided ContextEngine aligned with the resolved provider budget. */
  configureBudget(maxTokens: number, toolsProvider?: () => ToolDefinition[]): void {
    this.config.maxTokens = Math.max(1, maxTokens);
    if (toolsProvider) this.config.toolsProvider = toolsProvider;
  }

  private remember(result: ContextCompactionResult): ContextCompactionResult {
    this.lastCompactionResult = result;
    return result;
  }

  private isCompactionSummary(message: Message): boolean {
    return message.role === 'system' && message.content.startsWith('Earlier conversation summary:');
  }

  private isRehydrationMessage(message: Message): boolean {
    return message.role === 'system' && message.content.startsWith(REHYDRATION_PREFIX);
  }

  private groupAtomicPairs(messages: Message[]): MessageGroup[] {
    const groups: MessageGroup[] = [];
    let index = 0;

    while (index < messages.length) {
      const message = messages[index];
      if (message.role === 'assistant' && message.toolCalls?.length) {
        const expectedIds = new Set(message.toolCalls.map(toolCall => toolCall.id));
        const pair: Message[] = [message];
        index++;
        while (
          index < messages.length &&
          messages[index].role === 'tool' &&
          messages[index].toolCallId &&
          expectedIds.has(messages[index].toolCallId!)
        ) {
          pair.push(messages[index]);
          index++;
        }
        const receivedIds = new Set(pair.slice(1).map(tool => tool.toolCallId));
        groups.push({ messages: pair, retainable: receivedIds.size === expectedIds.size });
        continue;
      }

      // An orphan tool result has no valid provider context without its
      // assistant tool call, so it is evicted together with other invalid
      // fragments instead of being retained as a standalone tail message.
      groups.push({ messages: [message], retainable: message.role !== 'tool' });
      index++;
    }

    return groups;
  }
}
