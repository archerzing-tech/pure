// src/harness/ContextEngine.ts
// v0.6 — context compaction with tool-call atomicity and explicit results.
// 8.1 — the token budget is the primary retention bound: when maxTokens is
// configured (the production default via configureBudget) the message-count
// window stands down entirely, so small messages are kept as long as they
// fit the provider window instead of being cut at the count. maxMessages
// governs only when no token budget is known (standalone/test use).
// 9.1 — three more layers, in the order the mainstream agents apply them:
//   L1 microcompaction: old tool RESULTS are replaced by a placeholder
//      (zero LLM cost) before any message is evicted. Long agent sessions
//      spend most of their window on tool output; shedding that first keeps
//      the conversational skeleton (who asked what, what was decided) intact
//      instead of deleting whole turns.
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
import type { Message, LLMAdapter, ToolDefinition } from '../shared/types';

export interface ContextMicrocompactionConfig {
  /** Tool results within the newest N are never cleared (default 8). */
  keepRecent?: number;
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

/** L1 defaults — see ContextMicrocompactionConfig. */
const MICROCOMPACT_KEEP_RECENT = 8;
const MICROCOMPACT_MIN_CHARS = 1_000;
/** Reactive mode protects fewer results and clears smaller ones so a retry
 *  that overflowed by a little is fixed by the cheap layer alone. */
const AGGRESSIVE_KEEP_RECENT = 2;
const AGGRESSIVE_MIN_CHARS = 200;
/** Reactive mode targets this fraction of the configured budget: the provider
 *  ignored our estimate once, so land well under the limit rather than on it. */
const AGGRESSIVE_BUDGET_RATIO = 0.7;

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
  return `${text.slice(0, headLen)}\n[...excerpt...]\n${text.slice(text.length - tailLen)}`;
}

/** Single source for compaction sizing: content + tool-call arguments, shared
 *  with the GUI's background pre-compaction gate so both surfaces blind-spot
 *  the same wire payload or neither does. */
export function estimateTokens(messages: Message[]): number {
  let sum = 0;
  for (const message of messages) {
    sum += estimateTextTokens(message.content ?? '');
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

/**
 * L1 — replace the content of OLD, LARGE tool results with a placeholder.
 * Pure text surgery: no LLM call, no message dropped, no tool pair broken.
 * The newest `keepRecent` results stay verbatim (the model is usually still
 * working from them); only results long enough to be worth the placeholder
 * are touched.
 */
export function microcompactToolResults(
  messages: Message[],
  options: { keepRecent: number; minChars: number },
): { messages: Message[]; cleared: number; reclaimedTokens: number } {
  const toolIndices: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === 'tool') toolIndices.push(index);
  }
  const protectedIndices = new Set(options.keepRecent > 0 ? toolIndices.slice(-options.keepRecent) : []);
  let cleared = 0;
  let reclaimedTokens = 0;
  const output = messages.map((message, index) => {
    if (message.role !== 'tool' || protectedIndices.has(index)) return message;
    const text = message.content ?? '';
    if (text.length < options.minChars) return message;
    const placeholder = microcompactedPlaceholder(message.toolName, text.length);
    cleared++;
    reclaimedTokens += estimateTextTokens(text) - estimateTextTokens(placeholder);
    return { ...message, content: placeholder };
  });
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
      const body = text.length > cap ? `${text.slice(0, cap)}\n[...truncated]` : text;
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

  getLastCompactionResult(): ContextCompactionResult | undefined {
    return this.lastCompactionResult;
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
    const toolTokens = estimateToolDefinitionTokens(this.config.toolsProvider?.() ?? this.config.tools);
    const configuredMax = this.config.maxTokens;
    // Reactive mode aims BELOW the configured budget: the provider already
    // rejected one request our estimator believed fit, so landing at exactly
    // the limit would just overflow again.
    const retentionBudget = options.aggressive && configuredMax !== undefined
      ? Math.max(1, Math.floor(configuredMax * AGGRESSIVE_BUDGET_RATIO))
      : configuredMax;

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
    const underPressure = configuredMax !== undefined && estimateTokens(messages) + toolTokens > configuredMax;
    const overCountWindow = configuredMax === undefined && messages.filter(m => m.role !== 'system').length > this.config.maxMessages;
    if (microSetting && (underPressure || overCountWindow || options.aggressive === true)) {
      const baseKeep = microSetting.keepRecent ?? MICROCOMPACT_KEEP_RECENT;
      const baseMin = microSetting.minChars ?? MICROCOMPACT_MIN_CHARS;
      const outcome = microcompactToolResults(messages, {
        keepRecent: options.aggressive ? Math.min(baseKeep, AGGRESSIVE_KEEP_RECENT) : baseKeep,
        minChars: options.aggressive ? Math.min(baseMin, AGGRESSIVE_MIN_CHARS) : baseMin,
      });
      working = outcome.messages;
      microcompactedToolResults = outcome.cleared;
      reclaimedTokens = outcome.reclaimedTokens;
    }

    const nonSystem = working.filter(message => message.role !== 'system');
    const currentTokens = estimateTokens([...systemMessages, ...nonSystem]) + toolTokens;
    // Token budget primary (8.1): with one configured, the count window is not
    // a trigger — a 40-message transcript of short turns is healthy, not over
    // budget. Without a token budget the count window is all we know.
    const overMessageBudget = configuredMax === undefined && nonSystem.length > this.config.maxMessages;
    const overTokenBudget = configuredMax !== undefined && currentTokens > configuredMax;

    const groups = this.groupAtomicPairs(nonSystem);
    const hasInvalidFragments = groups.some(group => !group.retainable);
    const hasCollapsedSummaries = priorSummaries.length > 1;
    if (!options.force && !overMessageBudget && !overTokenBudget && !hasInvalidFragments && !hasCollapsedSummaries) {
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
      : retentionBudget - estimateTokens(systemMessages) - toolTokens;

    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index];
      if (!group.retainable) continue;
      if (isUserGroup(group)) continue; // pinned below, outside the count budget

      const groupTokens = estimateTokens(group.messages);
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
        if (kept.has(group) && isUserGroup(group)) remainingTokens -= estimateTokens(group.messages);
      }
      const newestKept = [...groups].reverse().find(group => kept.has(group));
      for (const group of groups) {
        if (remainingTokens >= 0) break;
        if (group === newestKept) continue;
        if (!kept.has(group) || !isUserGroup(group)) continue;
        kept.delete(group);
        remainingTokens += estimateTokens(group.messages);
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
    const systemTokens = estimateTokens(systemMessages) + toolTokens;
    const newestRetained = [...groups].reverse().find(group => kept.has(group));
    const oversizedNewestGroup = retentionBudget !== undefined &&
      systemTokens <= retentionBudget &&
      newestRetained !== undefined &&
      estimateTokens(newestRetained.messages) > retentionBudget - systemTokens;

    // ── L2: summarize every eviction ─────────────────────────────────────
    // The trigger is "messages were evicted", not "more than N were evicted":
    // a structural overflow that drops five turns is exactly as lossy as one
    // that drops fifty, and the silent-drop gate is how an attachment path
    // vanished between turns. Invalid-fragment-only evictions (a dangling
    // tool call from an interrupted checkpoint) carry no conversation and are
    // not worth a call.
    let summaryMessage: Message | undefined;
    let summarized = false;
    if (this.config.llm && evictedRetainableMessages > 0) {
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

    const summaryUnavailable = evictedRetainableMessages > 0 && !summarized;
    const estimatedTokens = estimateTokens(ordered) + toolTokens;

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
