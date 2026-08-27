// src/engine/AgentLoopEngine.ts
// v0.4 — full 5-state ReAct loop: THINK → ACT → OBSERVE → THINK (tool loop) → VERIFY → TERMINATE.
// Fixes: BudgetWarning events, completedSteps/lastState tracking, note injection for recoverable errors,
//        VERIFY_FAILED → loop back to THINK with reflection note instead of completing.

import type { Message, EngineContext, EngineEvent, RunInput, RunContinueInput, ToolCall, AgentStateType, FailureRecord, TokenUsage, VerificationSummary, ToolResult, LLMAdapter, ToolDefinition } from '../shared/types';
import { mergeTokenUsage } from '../shared/usage';
import { safeParseArgs } from '../shared/format';
import { BudgetManager } from './BudgetManager';
import { FileLockManager } from './FileLockManager';

// v1.9.15 — research-loop guard: successful web searches never trip the
// failure policy (empty/relevance-gated-out result sets return success so the
// model sees "rephrase, don't repeat" guidance), so a niche or ambiguous query
// can loop through many rephrased searches with no escalation. Count
// consecutive tool rounds made up ENTIRELY of web-research tools and inject a
// wrap-up directive once the streak crosses the limit.
const WEB_RESEARCH_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'web_scrape',
  'web_public_api',
  'researcher_web',
  'researcher_docs',
  'web_researcher',
]);

function isWebResearchTool(name: string): boolean {
  const base = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  return WEB_RESEARCH_TOOLS.has(base);
}

const RESEARCH_ROUND_LIMIT = 4;
const LLM_STREAM_IDLE_TIMEOUT_MS = 120_000;
// First-token budget is far more lenient than inter-chunk idle: a huge prompt
// (large input file / giant attachment) makes the provider's time-to-first-token
// (TTFT) long, and a big generation can also stall before the first byte. Killing
// the stream on a 120s TTFT wrongly aborts legitimate large tasks — only treat a
// *gap between delivered chunks* as a real stall.
const LLM_STREAM_FIRST_TOKEN_TIMEOUT_MS = 300_000;
// Tool results (read_file of a big file, a giant build/test dump, …) are folded
// into the LLM context verbatim. A huge result both inflates the prompt (slow
// first-token / TTFT → stream timeout) and can blow the context window. Cap the
// slice that enters the conversation; the full output already lives on disk or
// can be re-read in ranges. read_file gets a tailored nudge to read by range.
const TOOL_RESULT_MAX_CHARS = 40_000;
function capToolResult(text: string, toolName: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  const omitted = text.length - TOOL_RESULT_MAX_CHARS;
  const notice = toolName === 'read_file'
    ? `\n\n« Tool result too large — ${omitted.toLocaleString()} chars omitted. The full content is NOT in context: use read_file with startLine/endLine to read only the parts you need, instead of loading the entire large file at once (it slows the response and can trip the stream timeout). »`
    : `\n\n« Tool result too large — ${omitted.toLocaleString()} chars omitted. Fetch it in pages/ranges if you need the rest. »`;
  return text.slice(0, TOOL_RESULT_MAX_CHARS) + notice;
}
// On a stream idle-timeout while the model is still producing plain text (no
// half-formed tool call), keep what we have and let it continue seamlessly
// instead of hard-aborting. Cap so a pathological stall can't loop forever.
const MAX_STREAM_RESUMES = 2;
const STREAM_RESUME_HINT = '[system] The previous response generation was cut off by a stream timeout. Continue EXACTLY from where the last assistant message ended — do NOT repeat any already-generated content, just complete the remainder (and close any open code block).';
// Heuristic truncation check for a SILENT cut: a generation that ends with an
// unterminated fenced code block (``` opened but never closed) was almost
// certainly cut off mid-stream — e.g. token-limit truncation of an HTML page
// wrapped in a ```html fence. The provider still emits a clean `done`, so the
// engine would otherwise treat the partial content as complete (the silent
// truncation the user hit). A balanced fence count means a real completion.
function contentLooksTruncated(text: string): boolean {
  const fenceCount = (text.match(/```/g) ?? []).length;
  return fenceCount % 2 === 1;
}
const TOOL_EXECUTION_TIMEOUT_MS = 180_000;
const VERIFIER_TIMEOUT_MS = 60_000;

function makeLifecycleError(name: 'AbortError' | 'TimeoutError', message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function runWithDeadline<T>(
  operation: () => Promise<T> | T,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => finish(() => reject(makeLifecycleError('AbortError', `${label} aborted`)));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      onTimeout?.();
      finish(() => reject(makeLifecycleError('TimeoutError', `${label} timed out after ${timeoutMs}ms`)));
    }, Math.max(1, timeoutMs));
    Promise.resolve().then(operation).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export async function* streamWithDeadline(
  llm: LLMAdapter,
  messages: Message[],
  tools: ToolDefinition[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AsyncGenerator<Extract<import('../shared/types').LLMChunk, { type: string }>, void, void> {
  const linkedController = new AbortController();
  const forwardAbort = (): void => linkedController.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const iterator = llm.stream(messages, tools, linkedController.signal)[Symbol.asyncIterator]();
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let firstChunk = true;
  try {
    while (true) {
      const idleCap = firstChunk ? LLM_STREAM_FIRST_TOKEN_TIMEOUT_MS : LLM_STREAM_IDLE_TIMEOUT_MS;
      const remaining = Math.min(
        deadline - Date.now(),
        idleCap,
      );
      if (remaining <= 0) {
        linkedController.abort();
        throw makeLifecycleError('TimeoutError', firstChunk
          ? 'LLM stream exceeded its first-token deadline'
          : 'LLM stream exceeded its deadline');
      }
      const next = await runWithDeadline(
        () => iterator.next(),
        signal,
        remaining,
        'LLM stream read',
        () => linkedController.abort(),
      );
      if (next.done) return;
      firstChunk = false;
      yield next.value;
    }
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
    linkedController.abort();
    void iterator.return?.();
  }
}

export class AgentLoopEngine {
  private fileLock = new FileLockManager();

  async *run(
    input: RunInput,
    ctx: EngineContext,
  ): AsyncGenerator<EngineEvent, void, void> {
    const budget = new BudgetManager(input.budget);
    const messages: Message[] = [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userPrompt, images: input.images },
    ];
    budget.addTokens(input.systemPrompt + input.userPrompt);

    yield* this.runLoop(messages, ctx, budget, 1);
  }

  async *continue(
    input: RunContinueInput,
    ctx: EngineContext,
  ): AsyncGenerator<EngineEvent, void, void> {
    const budget = new BudgetManager(input.budget);
    const messages: Message[] = [...input.messages, { role: 'user' as const, content: input.newUserPrompt, images: input.images }];
    budget.addTokens(input.newUserPrompt);
    for (const m of input.messages) budget.addTokens(m.content);

    yield* this.runLoop(messages, ctx, budget, 1);
  }

  private async *runLoop(
    messages: Message[],
    ctx: EngineContext,
    budget: BudgetManager,
    turnCount: number,
  ): AsyncGenerator<EngineEvent, void, void> {
    const sid = () => `st_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const completedSteps: string[] = [];
    let finalOutput: string | undefined;
    let interrupted = false;
    const failures: FailureRecord[] = [];
    // Aggregated billing usage across every LLM call in this turn (each
    // iteration's stream yields a `usage` chunk) — surfaced on Completed so
    // the GUI can accumulate per-session token totals + cost.
    let turnUsage: TokenUsage | undefined;
    let verification: VerificationSummary = { status: 'not_run', evidence: [] };
    // Consecutive tool rounds made up entirely of web-research tools (see the
    // research-loop guard above). Reset by any non-research tool or answer.
    let researchStreak = 0;
    // Survives THINK re-entries within one turn: caps how many times a stream
    // idle-timeout may be auto-resumed (see the THINK catch) so a pathological
    // stall can't loop forever.
    let streamResumes = 0;

    while (true) {
      if (ctx.signal?.aborted) {
        yield { type: 'Interrupted', payload: { reason: 'aborted', lastState: 'THINK', completedSteps, messages, turnCount }, timestamp: Date.now() };
        interrupted = true;
        break;
      }

      // ── Budget check: emit warning first, interrupt on exceeded ──
      const budgetStatus = budget.check();
      if (budgetStatus === 'exceeded') {
        yield {
          type: 'BudgetWarning',
          payload: { exhausted: true, reason: 'Budget exhausted', remaining: budget.remaining(), gracePeriodEnds: budget.gracePeriodEnd },
          timestamp: Date.now(),
        };
        yield { type: 'Interrupted', payload: { reason: 'Budget exceeded', lastState: 'THINK', completedSteps, messages, turnCount }, timestamp: Date.now() };
        interrupted = true;
        break;
      } else if (budgetStatus === 'warning') {
        yield {
          type: 'BudgetWarning',
          payload: { exhausted: false, reason: 'Approaching budget limit', remaining: budget.remaining(), gracePeriodEnds: budget.gracePeriodEnd },
          timestamp: Date.now(),
        };
        if (ctx.hooks) {
          const hookResults = await ctx.hooks.dispatch('on_budget_warning', { messages, turnCount, phase: 'THINK' });
          if (hookResults.some(r => r.action === 'abort')) {
            yield { type: 'Interrupted', payload: { reason: 'Hook aborted on budget warning', lastState: 'THINK', completedSteps, messages, turnCount }, timestamp: Date.now() };
            interrupted = true; break;
          }
        }
      }

      // ── THINK ──
      yield { type: 'StateChange', payload: { from: turnCount === 1 ? 'THINK' : 'OBSERVE', to: 'THINK', stateId: sid() }, timestamp: Date.now() };
      completedSteps.push('THINK');

      // Hook: before_think
      if (ctx.hooks) {
        const results = await ctx.hooks.dispatch('before_think', { messages, turnCount, phase: 'THINK' });
        if (results.some(r => r.action === 'abort')) {
          yield { type: 'Interrupted', payload: { reason: 'Hook aborted before think', lastState: 'THINK', completedSteps, messages, turnCount }, timestamp: Date.now() };
          interrupted = true; break;
        }
        const modify = results.find(r => r.action === 'modify' && r.modifiedMessages);
        if (modify?.modifiedMessages) {
          messages.length = 0;
          messages.push(...modify.modifiedMessages);
        }
      }

      let content = '';
      let reasoningText = '';
      let toolCalls: ToolCall[] = [];
      // Set as soon as the stream starts emitting a tool call. A timeout mid
      // tool-call-argument can't be safely resumed (the partial call would be
      // corrupt), so the auto-resume branch below only fires for plain text.
      let sawToolCall = false;
      // Set once the terminal `done` chunk arrives. If the stream ends WITHOUT a
      // `done` (silent connection close), it stays false and we treat the
      // accumulated text as truncated.
      let sawDone = false;

      try {
        const currentToolsDefs = ctx.toolsDefsProvider?.() ?? ctx.toolsDefs;
        const hasTools = !!ctx.tools && currentToolsDefs.length > 0;
        const toolsDefs = hasTools ? currentToolsDefs : [];
        const streamTimeoutMs = Math.max(1, budget.remaining().time);
        for await (const chunk of streamWithDeadline(ctx.llm, messages, toolsDefs, ctx.signal, streamTimeoutMs)) {
          switch (chunk.type) {
            case 'content':
              content += chunk.content;
              yield { type: 'TokenDelta', payload: { content: chunk.content, stateId: sid(), isToolCall: false }, timestamp: Date.now() };
              break;
            case 'reasoning':
              // Reasoning (chain-of-thought) is surfaced to the GUI as its own
              // event — never folded into TokenDelta content, so it stays out of
              // the visible answer and the persisted assistant message.
              reasoningText += chunk.content;
              yield { type: 'ReasoningDelta', payload: { content: chunk.content, stateId: sid() }, timestamp: Date.now() };
              break;
            case 'tool_call_delta':
              sawToolCall = true;
              yield { type: 'TokenDelta', payload: { content: chunk.arguments ?? '', stateId: sid(), isToolCall: true, toolCallBuffer: chunk.arguments, toolCallName: chunk.name }, timestamp: Date.now() };
              break;
            case 'tool_call':
              sawToolCall = true;
              // BUG-6: surface the completed tool-call id for streaming
              // adapters that emit it mid-stream (Anthropic-style). The UI
              // keys its toasts by toolCallId, not toolName — parallel
              // same-name calls would otherwise collide on one toast.
              yield { type: 'TokenDelta', payload: { content: '', stateId: sid(), isToolCall: true, toolCallBuffer: chunk.arguments, toolCallName: chunk.name, toolCallId: chunk.id }, timestamp: Date.now() };
              break;
            case 'usage':
              turnUsage = mergeTokenUsage(turnUsage, chunk.usage);
              break;
            case 'done':
              content = chunk.content || content;
              toolCalls = chunk.toolCalls;
              sawDone = true;
              if (chunk.toolCalls.length > 0) sawToolCall = true;
              // BUG-6: the `done` chunk is the single guaranteed source of the
              // final tool calls (every adapter emits it per the LLMAdapter
              // contract, even ones that never stream `tool_call` chunks).
              // Emit one id-bearing TokenDelta per call so the UI can key its
              // pending toasts by toolCallId before any ToolResult arrives.
              for (const tc of chunk.toolCalls) {
                yield { type: 'TokenDelta', payload: { content: '', stateId: sid(), isToolCall: true, toolCallBuffer: tc.function.arguments, toolCallName: tc.function.name, toolCallId: tc.id }, timestamp: Date.now() };
              }
              break;
          }
        }

        // Silent-truncation guard: the stream ended but the answer is NOT
        // complete. Two cases:
        //  - no terminal `done` arrived (connection closed without error), or
        //  - a `done` arrived but the text ends inside an unterminated code
        //    fence (token-limit truncation of an HTML page / long doc).
        // Either way the partial content must not be treated as the final answer.
        // Resume it exactly like a stream timeout — keep what we have and let the
        // model finish the remainder (capped by MAX_STREAM_RESUMES).
        const silentlyTruncated =
          (sawDone && !sawToolCall && content.length > 0 && contentLooksTruncated(content)) ||
          (!sawDone && !sawToolCall && content.length > 0);
        if (silentlyTruncated && streamResumes < MAX_STREAM_RESUMES) {
          streamResumes++;
          messages.push({ role: 'assistant' as const, content });
          messages.push({ role: 'user' as const, content: STREAM_RESUME_HINT, internal: true });
          turnCount++; budget.incrementTurn();
          yield { type: 'YieldControl', payload: { turnNumber: turnCount, budget: budget.snapshot() }, timestamp: Date.now() };
          continue;
        }
      } catch (err: any) {
        if (ctx.signal?.aborted) {
          yield { type: 'Interrupted', payload: { reason: 'aborted', lastState: 'THINK', completedSteps, messages, turnCount }, timestamp: Date.now() };
          interrupted = true;
          break;
        }
        const isTimeout = err?.name === 'TimeoutError';
        // Auto-resume: the idle deadline fired while the model was STILL
        // producing plain text (we have a non-empty partial, and no half-formed
        // tool call). Keep the partial answer, nudge the model to continue
        // exactly where it stopped, and re-enter the THINK loop — turning a
        // fatal "stream timeout" into a seamless continuation. Without this the
        // same timeout would hit repeatedly and then hard-abort (the
        // "两次流式输出超时" the user hit on large HTML / large output).
        if (isTimeout && streamResumes < MAX_STREAM_RESUMES && content.length > 0 && !sawToolCall) {
          streamResumes++;
          messages.push({ role: 'assistant' as const, content });
          messages.push({ role: 'user' as const, content: STREAM_RESUME_HINT, internal: true });
          turnCount++; budget.incrementTurn();
          yield { type: 'YieldControl', payload: { turnNumber: turnCount, budget: budget.snapshot() }, timestamp: Date.now() };
          continue;
        }
        failures.push({ type: 'llm_error', message: err?.message ?? String(err), turnNumber: turnCount });
        if (ctx.failurePolicy) {
          const action = ctx.failurePolicy.decide(failures);
          // §12.3: surface the decision so the Harness can persist error_pattern
          // memories (stop → error_pattern now, retry → on eventual success).
          yield { type: 'FailurePolicyDecision', payload: { action, failure: failures[failures.length - 1], turnNumber: turnCount }, timestamp: Date.now() };
          if (action.kind === 'stop') {
            yield { type: 'Interrupted', payload: { reason: action.reason, lastState: 'THINK', completedSteps, messages, turnCount }, timestamp: Date.now() };
            interrupted = true; break;
          }
          if (action.kind !== 'degrade') {
            messages.push({ role: 'user' as const, content: action.hint, internal: true });
          }
          turnCount++; budget.incrementTurn();
          yield { type: 'YieldControl', payload: { turnNumber: turnCount, budget: budget.snapshot() }, timestamp: Date.now() };
          continue;
        }
        yield { type: 'Error', payload: { code: 'LLM_STREAM_ERROR', message: err?.message ?? String(err), stateType: 'THINK', recoverable: false, recoveryAction: 'terminate' }, timestamp: Date.now() };
        return;
      }

      budget.addTokens(content + reasoningText);
      messages.push({ role: 'assistant' as const, content, ...(toolCalls.length > 0 ? { toolCalls } : {}) });

      // Hook: after_think
      if (ctx.hooks) {
        const results = await ctx.hooks.dispatch('after_think', { messages, turnCount, phase: 'THINK' });
        if (results.some(r => r.action === 'abort')) {
          yield { type: 'Interrupted', payload: { reason: 'Hook aborted after think', lastState: 'THINK', completedSteps, messages, turnCount }, timestamp: Date.now() };
          interrupted = true; break;
        }
      }

      // ── If LLM returned tool calls and we have tools → ACT → OBSERVE → loop ──
      if (toolCalls.length > 0 && ctx.tools) {
        // Hook: before_act
        if (ctx.hooks) {
          const results = await ctx.hooks.dispatch('before_act', { messages, turnCount, phase: 'ACT' });
          if (results.some(r => r.action === 'abort')) {
            yield { type: 'Interrupted', payload: { reason: 'Hook aborted before act', lastState: 'ACT', completedSteps, messages, turnCount }, timestamp: Date.now() };
            interrupted = true; break;
          }
        }

        yield { type: 'StateChange', payload: { from: 'THINK', to: 'ACT', stateId: sid() }, timestamp: Date.now() };
        completedSteps.push('ACT');

        const toolResults = await this.executeTools(toolCalls, ctx, budget);
        for (const result of toolResults) {
          yield { type: 'ToolResult', payload: result, timestamp: Date.now() };
        }

        // Track tool failures and consult policy
        const toolErrors = toolResults.filter(tr => !tr.result.success);
        for (const te of toolErrors) {
          failures.push({ type: 'tool_error', message: te.result.error ?? 'Unknown', turnNumber: turnCount, toolName: te.toolName });
        }
        if (toolErrors.length > 0 && ctx.failurePolicy) {
          const action = ctx.failurePolicy.decide(failures);
          yield { type: 'FailurePolicyDecision', payload: { action, failure: failures[failures.length - 1], turnNumber: turnCount }, timestamp: Date.now() };
          if (action.kind === 'stop') {
            yield { type: 'Interrupted', payload: { reason: action.reason, lastState: 'ACT', completedSteps, messages, turnCount }, timestamp: Date.now() };
            interrupted = true; break;
          }
          // Append tool results so the LLM sees them on retry
          for (const tr of toolResults) {
            const rawText = tr.result.success
              ? typeof tr.result.result === 'string' ? tr.result.result : JSON.stringify(tr.result.result)
              : `Error: ${tr.result.error}`;
            const resultText = capToolResult(rawText, tr.toolName);
            messages.push({ role: 'tool', content: resultText, toolCallId: tr.toolCallId, toolName: tr.toolName });
            budget.addTokens(resultText);
          }
          // v1.9.7 — every failed execution explicitly degrades the subsequent
          // reasoning: the model is told the exact call is a dead-end and to
          // prefer paths already proven this session. Complements the policy
          // hint (which decides retry vs reflect): a retry must change
          // something material instead of re-issuing the identical call.
          for (const te of toolErrors) {
            const note = this.degradationNote(te);
            messages.push({ role: 'user' as const, content: note, internal: true });
            budget.addTokens(note);
          }
          if (action.kind !== 'degrade') {
            messages.push({ role: 'user' as const, content: action.hint, internal: true });
          }
          turnCount++; budget.incrementTurn();
          yield { type: 'YieldControl', payload: { turnNumber: turnCount, budget: budget.snapshot() }, timestamp: Date.now() };
          continue;
        }

        // Hook: after_act
        if (ctx.hooks) {
          const results = await ctx.hooks.dispatch('after_act', { messages, turnCount, phase: 'ACT' });
          if (results.some(r => r.action === 'abort')) {
            yield { type: 'Interrupted', payload: { reason: 'Hook aborted after act', lastState: 'ACT', completedSteps, messages, turnCount }, timestamp: Date.now() };
            interrupted = true; break;
          }
        }

        // A clean tool round resets the failure streak so the recovery policy
        // only escalates on genuinely consecutive failures.
        if (toolErrors.length === 0) failures.length = 0;

        yield { type: 'StateChange', payload: { from: 'ACT', to: 'OBSERVE', stateId: sid() }, timestamp: Date.now() };
        completedSteps.push('OBSERVE');

        for (const tr of toolResults) {
          const rawText = tr.result.success
            ? typeof tr.result.result === 'string' ? tr.result.result : JSON.stringify(tr.result.result)
            : `Error: ${tr.result.error}`;
          const resultText = capToolResult(rawText, tr.toolName);
          messages.push({ role: 'tool', content: resultText, toolCallId: tr.toolCallId, toolName: tr.toolName });
          budget.addTokens(resultText);
        }
        // v1.9.7 — same degradation without a failure policy: the model still
        // sees the raw error, but the explicit directive guarantees the next
        // THINK treats the failed call as a dead-end instead of re-issuing it.
        for (const te of toolErrors) {
          const note = this.degradationNote(te);
          messages.push({ role: 'user' as const, content: note, internal: true });
          budget.addTokens(note);
        }

        // v1.9.15 — research-loop guard: after several consecutive all-web
        // research rounds, tell the model to stop searching and synthesize from
        // the evidence it already has. The streak resets on any non-research
        // tool round (real work) and after the nudge, so it re-fires if the
        // model keeps researching instead of answering.
        const allResearch = toolCalls.length > 0 && toolCalls.every((tc) => isWebResearchTool(tc.function.name));
        researchStreak = allResearch ? researchStreak + 1 : 0;
        if (researchStreak >= RESEARCH_ROUND_LIMIT) {
          researchStreak = 0;
          const wrapUp = `You have made ${RESEARCH_ROUND_LIMIT} consecutive web research rounds for this request. Stop issuing more searches and deliver a complete, well-organized answer now from the evidence you have already gathered. If a specific fact is still missing, state the assumption or the gap plainly instead of searching again.`;
          messages.push({ role: 'user' as const, content: wrapUp, internal: true });
          budget.addTokens(wrapUp);
        }

        turnCount++;
        budget.incrementTurn();
        yield { type: 'YieldControl', payload: { turnNumber: turnCount, budget: budget.snapshot() }, timestamp: Date.now() };

        if (turnCount > ctx.budget.maxTurns) {
          yield { type: 'Interrupted', payload: { reason: 'max_turns', lastState: 'OBSERVE', completedSteps, messages, turnCount }, timestamp: Date.now() };
          interrupted = true;
          break;
        }
        continue;
      }

      // ── No tool calls → VERIFY ──
      // A turn aborted mid-THINK (the stream ended because the user hit Stop)
      // must NOT run a fresh verifier LLM call — surface the interruption
      // immediately instead of a pointless (and slow) verify round-trip. The
      // top-of-loop check would catch this next iteration, but only after the
      // verifier had already been invoked.
      if (ctx.signal?.aborted) {
        yield { type: 'Interrupted', payload: { reason: 'aborted', lastState: 'THINK', completedSteps, messages, turnCount }, timestamp: Date.now() };
        interrupted = true;
        break;
      }
      // Hook: before_verify
      if (ctx.hooks) {
        const results = await ctx.hooks.dispatch('before_verify', { messages, turnCount, phase: 'VERIFY' });
        if (results.some(r => r.action === 'abort')) {
          yield { type: 'Interrupted', payload: { reason: 'Hook aborted before verify', lastState: 'VERIFY', completedSteps, messages, turnCount }, timestamp: Date.now() };
          interrupted = true; break;
        }
      }

      yield { type: 'StateChange', payload: { from: 'THINK', to: 'VERIFY', stateId: sid() }, timestamp: Date.now() };
      completedSteps.push('VERIFY');

      let verifyPassed = true;
      if (ctx.verifier) {
        try {
          const result = await runWithDeadline(
            () => ctx.verifier!.evaluate({ output: content, context: messages }),
            ctx.signal,
            Math.min(VERIFIER_TIMEOUT_MS, Math.max(1, budget.remaining().time)),
            'verification',
          );
          const evidence = result.evidence ?? [{
            id: `verifier_round_${turnCount}`,
            checkName: 'verifier',
            status: result.passed ? 'passed' : 'failed',
            summary: result.feedback ?? (result.passed ? 'Engine verifier passed.' : 'Engine verifier failed.'),
            source: 'engine' as const,
            timestamp: Date.now(),
          }];
          const hasFailedEvidence = evidence.some((item) => item.status === 'failed');
          const hasIncompleteEvidence = evidence.some((item) => item.status === 'incomplete' || item.status === 'not_run');
          verification = {
            status: !result.passed || hasFailedEvidence
              ? 'failed'
              : hasIncompleteEvidence
                ? 'incomplete'
                : 'passed',
            evidence,
          };
          if (!result.passed) {
            verifyPassed = false;
            failures.push({ type: 'verify_failure', message: result.feedback ?? 'Verification failed', turnNumber: turnCount });
            if (ctx.failurePolicy) {
              const action = ctx.failurePolicy.decide(failures);
              yield { type: 'FailurePolicyDecision', payload: { action, failure: failures[failures.length - 1], turnNumber: turnCount }, timestamp: Date.now() };
              if (action.kind === 'stop') {
                yield { type: 'Interrupted', payload: { reason: action.reason, lastState: 'VERIFY', completedSteps, messages, turnCount }, timestamp: Date.now() };
                interrupted = true; break;
              }
              const recoveryAction = action.kind === 'retry' ? 'retry' as const : action.kind === 'degrade' ? 'skip' as const : 'reflect' as const;
              const hint = action.kind === 'degrade' ? action.reason : (action as { hint: string }).hint;
              yield {
                type: 'Error',
                payload: { code: 'VERIFY_FAILED', message: hint, stateType: 'VERIFY', recoverable: true, recoveryAction },
                timestamp: Date.now(),
              };
              if (action.kind !== 'degrade') {
                messages.push({ role: 'user' as const, content: hint });
              }
            } else {
              yield {
                type: 'Error',
                payload: { code: 'VERIFY_FAILED', message: result.feedback ?? 'Verification failed', stateType: 'VERIFY', recoverable: true, recoveryAction: 'reflect' },
                timestamp: Date.now(),
              };
              messages.push({
                role: 'user' as const,
                content: `Verification failed: ${result.feedback ?? ''}. Please review the output above and fix any issues.`,
                internal: true,
              });
            }
            turnCount++;
            budget.incrementTurn();
            yield { type: 'YieldControl', payload: { turnNumber: turnCount, budget: budget.snapshot() }, timestamp: Date.now() };
            // Hook: after_verify (failed path)
            if (ctx.hooks) {
              await ctx.hooks.dispatch('after_verify', { messages, turnCount, phase: 'VERIFY' });
            }
            continue;
          }
        } catch (err: any) {
          if (ctx.signal?.aborted || err?.name === 'AbortError') {
            yield { type: 'Interrupted', payload: { reason: 'aborted', lastState: 'VERIFY', completedSteps, messages, turnCount }, timestamp: Date.now() };
            interrupted = true;
            break;
          }
          verification = {
            status: 'incomplete',
            evidence: [{
              id: `verifier_error_${turnCount}`,
              checkName: 'verifier',
              status: 'incomplete',
              summary: err?.message ?? String(err),
              source: 'engine',
              timestamp: Date.now(),
            }],
          };
          yield {
            type: 'Error',
            payload: { code: 'VERIFIER_ERROR', message: err?.message ?? String(err), stateType: 'VERIFY', recoverable: true, recoveryAction: 'skip' },
            timestamp: Date.now(),
          };
        }
      }

      // ── VERIFY passed → TERMINATE ──
      // Hook: after_verify
      if (ctx.hooks) {
        await ctx.hooks.dispatch('after_verify', { messages, turnCount, phase: 'VERIFY' });
      }

      // Successful verification resets the failure streak.
      failures.length = 0;

      // G-5: the design yields YieldControl at the bottom of every loop
      // iteration — including the one where VERIFY passes and we terminate.
      // Emit a final snapshot (no turn increment here; turnCount was already
      // counted by the last completed phase).
      yield { type: 'YieldControl', payload: { turnNumber: turnCount, budget: budget.snapshot() }, timestamp: Date.now() };

      finalOutput = content;
      yield { type: 'StateChange', payload: { from: 'VERIFY', to: 'TERMINATE', stateId: sid() }, timestamp: Date.now() };
      completedSteps.push('TERMINATE');
      break;
    }

    yield {
      type: 'Completed',
      payload: { finalOutput, isComplete: !interrupted, interrupted, turnCount, messages, usage: turnUsage, verification },
      timestamp: Date.now(),
    };
  }

  /**
   * v1.9.7 — explicit degradation directive injected after every failed tool
   * call, so the next THINK step treats the call as a dead-end: do not repeat
   * the exact same call; adapt or switch; prefer what already worked.
   */
  private degradationNote(te: { toolName: string; result: ToolResult }): string {
    return `Tool call ${te.toolName} failed: ${te.result.error ?? 'unknown error'}. Degrade this approach — do NOT repeat the exact same call: either adapt it (different arguments) or use a different tool or strategy. Prefer approaches that have already proven successful this session.`;
  }

  private async executeTools(
    toolCalls: ToolCall[],
    ctx: EngineContext,
    budget: BudgetManager,
  ): Promise<Array<{ toolName: string; result: import('../shared/types').ToolResult; duration: number; toolCallId: string }>> {
    const results: Array<{ toolName: string; result: import('../shared/types').ToolResult; duration: number; toolCallId: string }> = [];
    const reads: ToolCall[] = [];
    const writes: ToolCall[] = [];

    for (const tc of toolCalls) {
      budget.incrementToolCall();
      const meta = ctx.tools!.getMetadata(tc.function.name);
      // Tools marked side-effectful (MCP and subagents included) must not be
      // run concurrently merely because they are not file writes. Parallel
      // execution is reserved for explicitly read-only tools.
      if (meta?.isWrite || meta?.sideEffects) {
        writes.push(tc);
      } else {
        reads.push(tc);
      }
    }

    // Execute reads in parallel
    const readResults = await Promise.all(reads.map(async tc => {
      try {
        const args = safeParseArgs(tc.function.arguments);
        const path = typeof args.path === 'string' ? args.path : '';
        const lm = ctx.lockManager ?? this.fileLock;
        if (path) await lm.acquireRead(path, ctx.signal);
        try {
          const toolController = new AbortController();
          const forwardAbort = (): void => toolController.abort();
          ctx.signal?.addEventListener('abort', forwardAbort, { once: true });
          try {
            const result = await runWithDeadline(
              () => ctx.tools!.execute(tc, toolController.signal),
              ctx.signal,
              Math.min(TOOL_EXECUTION_TIMEOUT_MS, Math.max(1, budget.remaining().time)),
              `tool ${tc.function.name}`,
              () => toolController.abort(),
            );
            return { toolName: tc.function.name, result, duration: result.duration, toolCallId: tc.id };
          } finally {
            ctx.signal?.removeEventListener('abort', forwardAbort);
          }
        } finally {
          // Release even when the tool itself throws — a leaked lock would
          // deadlock every later write to the same path.
          if (path) lm.release(path);
        }
      } catch (err: any) {
        return { toolName: tc.function.name, result: { id: tc.id, toolName: tc.function.name, error: err?.message ?? 'unknown', success: false, duration: 0 }, duration: 0, toolCallId: tc.id };
      }
    }));
    results.push(...readResults);

    // Execute writes sequentially
    for (const tc of writes) {
      try {
        const args = safeParseArgs(tc.function.arguments);
        const path = typeof args.path === 'string' ? args.path : '';
        const lm = ctx.lockManager ?? this.fileLock;
        if (path) await lm.acquireWrite(path, ctx.signal);
        try {
          const toolController = new AbortController();
          const forwardAbort = (): void => toolController.abort();
          ctx.signal?.addEventListener('abort', forwardAbort, { once: true });
          try {
            const result = await runWithDeadline(
              () => ctx.tools!.execute(tc, toolController.signal),
              ctx.signal,
              Math.min(TOOL_EXECUTION_TIMEOUT_MS, Math.max(1, budget.remaining().time)),
              `tool ${tc.function.name}`,
              () => toolController.abort(),
            );
            results.push({ toolName: tc.function.name, result, duration: result.duration, toolCallId: tc.id });
          } finally {
            ctx.signal?.removeEventListener('abort', forwardAbort);
          }
        } finally {
          if (path) lm.release(path);
        }
      } catch (err: any) {
        results.push({ toolName: tc.function.name, result: { id: tc.id, toolName: tc.function.name, error: err?.message ?? 'unknown', success: false, duration: 0 }, duration: 0, toolCallId: tc.id });
      }
    }

    return results;
  }
}

