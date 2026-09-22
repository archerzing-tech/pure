// src/engine/AgentLoopEngine.ts
// v0.4 — full 5-state ReAct loop: THINK → ACT → OBSERVE → THINK (tool loop) → VERIFY → TERMINATE.
// Fixes: BudgetWarning events, completedSteps/lastState tracking, note injection for recoverable errors,
//        VERIFY_FAILED → loop back to THINK with reflection note instead of completing.

import type { Message, EngineContext, EngineEvent, EngineLlmPhase, RunInput, RunContinueInput, ToolCall, AgentStateType, FailureRecord, TokenUsage, VerificationSummary, ToolResult, LLMAdapter, SubagentActivityEvent } from '../shared/types';
import { mergeTokenUsage } from '../shared/usage';
import { interruptedReasonFor } from '../shared/pauseSignal';
import { streamLlmTurn, MAX_STREAM_RESUMES, STREAM_RESUME_HINT, MAX_TOOL_CALL_RESUMES, TOOL_CALL_RESUME_HINT } from './LlmTurnRunner';
import { runWithDeadline } from './streamDeadline';
import { BudgetManager } from './BudgetManager';
import { ToolExecutionCoordinator, type ExecutedToolResult, type ToolExecutionBudget } from './ToolExecutionCoordinator';

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
const VERIFIER_TIMEOUT_MS = 60_000;
// Cap on continueGuard re-entries per run: the guard injects a "keep going"
// directive when the model ends its turn with plain text while work remains.
// Without a cap, a weak model and a strict guard could deadlock in a
// think-text → nudge → think-text loop; three chances is enough to recover a
// premature stop, after which the turn genuinely ends.
const MAX_GUARD_CONTINUES = 3;
// Stable key for a tool call (name + arguments with sorted object keys), used
// by the consecutive-identical-call dedupe below.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
function callKey(name: string, argsJson: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(argsJson || '{}'); } catch { parsed = argsJson; }
  return `${name}::${typeof parsed === 'string' ? parsed : stableStringify(parsed)}`;
}
const DEDUPE_NOTE = '[dedupe] This call is identical to the immediately preceding call (same tool, same arguments) — its result was REUSED instead of executing again. If you genuinely need fresh data, change the call or say why in your reply.';
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

/**
 * E0.3 — resolve the adapter for an engine phase. The single-model contract:
 * a phase WITHOUT a dedicated adapter (the resolver returns undefined, or no
 * resolver is configured at all) always falls back to ctx.llm, so a user who
 * configured one model gets exactly the single-adapter behavior. A throwing
 * resolver is treated the same way — a config-layer bug must not kill a run.
 */
function llmForPhase(ctx: EngineContext, phase: EngineLlmPhase): LLMAdapter {
  if (!ctx.llmFor) return ctx.llm;
  try {
    return ctx.llmFor(phase) ?? ctx.llm;
  } catch {
    return ctx.llm;
  }
}

export class AgentLoopEngine {
  private toolCoordinator = new ToolExecutionCoordinator();

  /**
   * One tool-execution batch as a unified event stream: tool completions
   * (`tool`) and live subagent interior activity (`subagent`) interleaved in
   * arrival order. The engine's generator can only yield from its own body,
   * so tool-interior events must be raced against the tool completions here —
   * draining only at completion points would make a slow subagent's stream go
   * stale until some tool settles. The reader is per-batch and always closed
   * (finally), so the fanout never accumulates dead queues; no feed (CLI /
   * nested subagent runs) degrades to the plain tool stream.
   */
  private async *runBatch(
    toExecute: ToolCall[],
    ctx: EngineContext,
    budget: ToolExecutionBudget,
  ): AsyncGenerator<{ kind: 'tool'; tr: ExecutedToolResult } | { kind: 'subagent'; event: SubagentActivityEvent }> {
    const reader = ctx.subagentEvents?.subscribe();
    const toolsIter = this.toolCoordinator.executeStream(toExecute, ctx, budget);
    try {
      if (!reader) {
        for await (const tr of toolsIter) yield { kind: 'tool', tr };
        return;
      }
      let toolsDone = false;
      let toolsNext: Promise<IteratorResult<ExecutedToolResult>> | null = toolsIter.next();
      // Armed only when the buffer is empty (see loop head): calling next()
      // eagerly after each reader win would swallow the OLDEST buffered event
      // into a promise while the loop-head drain emits the NEWER ones first —
      // a visible reordering of the subagent's trace.
      let readerNext: Promise<IteratorResult<SubagentActivityEvent>> | null = null;
      while (true) {
        // Chatter that queued up while we were between awaits goes out first,
        // in arrival order, before anything newer can overtake it.
        for (const event of reader.drainAvailable()) yield { kind: 'subagent', event };
        if (toolsDone) return;
        if (!readerNext) readerNext = reader.next();
        // Reader FIRST in the race: for two already-settled promises
        // Promise.race picks by registration order, and a queued reader event
        // is always older than a tool result we haven't yielded yet. Tools
        // first STRANDED that event when the last tool of a batch settled at
        // the same moment — consumed from the queue but never yielded before
        // the `toolsDone` return (test-verified loss).
        const winner = await Promise.race([
          readerNext.then((r) => ({ which: 'reader' as const, r })),
          toolsNext!.then((r) => ({ which: 'tools' as const, r })),
        ]);
        if (winner.which === 'tools') {
          if (winner.r.done) { toolsDone = true; toolsNext = null; }
          else {
            yield { kind: 'tool', tr: winner.r.value };
            toolsNext = toolsIter.next();
          }
        } else if (!winner.r.done) {
          yield { kind: 'subagent', event: winner.r.value };
          readerNext = null; // re-armed at the loop head, after the drain
        } else {
          // Reader closed under us — keep going on the synchronous buffer.
          readerNext = null;
        }
      }
    } finally {
      reader?.close();
    }
  }

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
    // Consecutive-identical-call dedupe: the last executed call (tool + args),
    // so an IMMEDIATE repeat — the model re-issuing the same list/read/write
    // after a rewrite round, a continuation nudge, or a parallel duplicate in
    // the same round — reuses the previous result instead of executing again.
    // Only the IMMEDIATELY preceding call counts: anything executed in between
    // may have changed the world, and a repeat is then legitimate. The same
    // rule holds within a round: only a call directly continuing a run of
    // identical calls dedupes; an identical call AFTER a different call runs
    // for real (e.g. re-reading a file the round itself just edited).
    let lastExecuted: { key: string; text: string; ok: boolean } | null = null;
    // Survives THINK re-entries within one turn: caps how many times a stream
    // idle-timeout may be auto-resumed (see the THINK catch) so a pathological
    // stall can't loop forever.
    let streamResumes = 0;
    // continueGuard re-entries this run (plan-incomplete nudges), and
    // disconnected-tool-call recoveries (stream cut off mid tool call).
    let guardContinues = 0;
    let toolCallResumes = 0;

    while (true) {
      if (ctx.signal?.aborted) {
        yield { type: 'Interrupted', payload: { reason: interruptedReasonFor(ctx.signal), lastState: 'THINK', completedSteps, messages, turnCount }, timestamp: Date.now() };
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

      // Mid-run steering: user messages queued while tools were running join
      // here, after the before_think hooks (so a wholesale hook rewrite can't
      // clobber them) and before the model call. The protocol is clean at this
      // exact point — every tool result is already appended, and OBSERVE ends
      // with a `continue` — so the next THINK round simply reconciles them in
      // stride. No abort, no replan: a nudge should steer, not restart.
      // Async-capable so the host can resolve a fold-in at the boundary
      // itself (run the addition to completion, inject its RESULT) instead of
      // trusting the model to act on an instruction.
      const steered = (await ctx.takeSteerMessages?.()) ?? [];
      if (steered.length > 0) {
        for (const m of steered) {
          messages.push(m);
          budget.addTokens(m.content);
        }
        yield { type: 'SteerInjected', payload: { count: steered.length, turnNumber: turnCount }, timestamp: Date.now() };
      }

      let content = '';
      let reasoningText = '';
      let toolCalls: ToolCall[] = [];
      // Mid-stream interruptions (Ctrl+C / budget-stop) leave the in-flight
      // answer only in `content` — the push below (after a completed stream)
      // never runs, so the partial text was never persisted and interrupted
      // turns vanished from history. Flush it (text only, never while a tool
      // call is in flight, since toolCalls stays empty until the `done` chunk)
      // so resume/restore keeps what the user already saw.
      const flushPartialAssistant = (): void => {
        if (content.length > 0 && toolCalls.length === 0) {
          messages.push({ role: 'assistant' as const, content });
        }
      };
      // Graceful handover: a policy stop is a hard landing. Give the model ONE
      // tool-less round to summarize state — what was completed, what is
      // blocked, the recommended next step — so the turn ends with a usable
      // report instead of a bare reason string. If the LLM itself is dead
      // (the common stop cause is TOOL failures, not the model), the plain
      // stop reason still lands unchanged.
      const emitHandover = async function* (reason: string): AsyncGenerator<EngineEvent, void, void> {
        try {
          const ask: Message = {
            role: 'user',
            content: `HANDOVER (system directive): this turn is ending now. Reason: ${reason}. Do NOT call any tools — reply with text only, in the user's language: (1) what was completed (files written / verified), (2) what remains blocked and why, (3) the single recommended next step. 2-5 sentences of plain flowing text, no headings.`,
            internal: true,
          };
          let text = '';
          // E0.3 — the handover round is a summarization chore, not the user's
          // answer stream; a per-phase adapter (cheap model) may serve it.
          for await (const chunk of streamLlmTurn({ llm: llmForPhase(ctx, 'HANDOVER'), messages: [...messages, ask], tools: [], signal: ctx.signal, timeoutMs: 60_000 })) {
            if (chunk.type === 'content' && chunk.content) {
              text += chunk.content;
              budget.addTokens(chunk.content);
              yield { type: 'TokenDelta', payload: { content: chunk.content, stateId: sid(), isToolCall: false }, timestamp: Date.now() };
            }
          }
          text = text.trim();
          if (text) messages.push({ role: 'assistant' as const, content: text });
        } catch {
          // LLM unavailable — fall through to the plain stop reason.
        }
      };
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
        const toolsDefs = ctx.tools && currentToolsDefs.length > 0 ? currentToolsDefs : [];
        // Stream deadline follows the budget line that ACTUALLY ends the run
        // (hardMaxTime, else the soft cap while it lasts, else the soft cap
        // duration once the run is elastic). remaining().time clamps at 0
        // after the soft cap — Math.max(1, 0) used to become a 1ms deadline
        // that instantly timed out every remaining round.
        const streamTimeoutMs = budget.streamDeadlineMs();
        for await (const chunk of streamLlmTurn({
          llm: llmForPhase(ctx, 'THINK'),
          messages,
          tools: toolsDefs,
          signal: ctx.signal,
          timeoutMs: streamTimeoutMs,
          firstTokenTimeoutMs: budget.streamFirstTokenMs(),
        })) {
          switch (chunk.type) {
            case 'content':
              content += chunk.content;
              yield { type: 'TokenDelta', payload: { content: chunk.content, stateId: sid(), isToolCall: false }, timestamp: Date.now() };
              break;
            case 'reasoning':
              reasoningText += chunk.content;
              yield { type: 'ReasoningDelta', payload: { content: chunk.content, stateId: sid() }, timestamp: Date.now() };
              break;
            case 'tool_call_delta':
              sawToolCall = true;
              yield { type: 'TokenDelta', payload: { content: chunk.arguments ?? '', stateId: sid(), isToolCall: true, toolCallBuffer: chunk.arguments, toolCallName: chunk.name }, timestamp: Date.now() };
              break;
            case 'tool_call':
              sawToolCall = true;
              yield { type: 'TokenDelta', payload: { content: '', stateId: sid(), isToolCall: true, toolCallBuffer: chunk.arguments, toolCallName: chunk.name, toolCallId: chunk.id }, timestamp: Date.now() };
              break;
            case 'usage':
              turnUsage = mergeTokenUsage(turnUsage, chunk.usage);
              break;
            case 'done':
              content = chunk.content || content;
              toolCalls = chunk.toolCalls;
              sawDone = true;
              if (toolCalls.length > 0) sawToolCall = true;
              for (const tc of toolCalls) {
                yield { type: 'TokenDelta', payload: { content: '', stateId: sid(), isToolCall: true, toolCallBuffer: tc.function.arguments, toolCallName: tc.function.name, toolCallId: tc.id }, timestamp: Date.now() };
              }
              break;
          }
        }

        const silentlyTruncated =
          (sawDone && !sawToolCall && content.length > 0 && (content.match(/```/g) ?? []).length % 2 === 1) ||
          (!sawDone && !sawToolCall && content.length > 0);
        if (silentlyTruncated && streamResumes < MAX_STREAM_RESUMES) {
          streamResumes++;
          messages.push({ role: 'assistant' as const, content });
          messages.push({ role: 'user' as const, content: STREAM_RESUME_HINT, internal: true });
          turnCount++;
          budget.incrementTurn();
          yield { type: 'YieldControl', payload: { turnNumber: turnCount, budget: budget.snapshot() }, timestamp: Date.now() };
          continue;
        }
        // A tool call that started streaming but never saw its terminal `done`
        // chunk: `toolCalls` stays empty and the round would fall through to
        // VERIFY with the call silently DROPPED — the model asked to act, the
        // act never ran, the turn "completed". Recover instead: keep any
        // partial text, tell the model its call was cut off, let it re-issue
        // the complete call. Bounded; past the cap the legacy path applies.
        if (sawToolCall && !sawDone && toolCallResumes < MAX_TOOL_CALL_RESUMES) {
          toolCallResumes++;
          if (content.length > 0) messages.push({ role: 'assistant' as const, content });
          messages.push({ role: 'user' as const, content: TOOL_CALL_RESUME_HINT, internal: true });
          budget.addTokens(TOOL_CALL_RESUME_HINT);
          turnCount++;
          budget.incrementTurn();
          yield { type: 'YieldControl', payload: { turnNumber: turnCount, budget: budget.snapshot() }, timestamp: Date.now() };
          continue;
        }
      } catch (err: any) {
        if (ctx.signal?.aborted) {
          flushPartialAssistant();
          yield { type: 'Interrupted', payload: { reason: interruptedReasonFor(ctx.signal), lastState: 'THINK', completedSteps, messages, turnCount }, timestamp: Date.now() };
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
            flushPartialAssistant();
            yield* emitHandover(action.reason);
            yield { type: 'Interrupted', payload: { reason: action.reason, lastState: 'THINK', completedSteps, messages, turnCount }, timestamp: Date.now() };
            interrupted = true; break;
          }
          // retry/reflect carry a hint; degrade carries a reason. Inject
          // whichever applies — the model must SEE the directive, including
          // the degraded-mode instruction, or the escalate levels are silent.
          const guidance = action.kind === 'degrade' ? action.reason : action.hint;
          messages.push({ role: 'user' as const, content: guidance, internal: true });
          turnCount++; budget.incrementTurn();
          yield { type: 'YieldControl', payload: { turnNumber: turnCount, budget: budget.snapshot() }, timestamp: Date.now() };
          continue;
        }
        yield { type: 'Error', payload: { code: 'LLM_STREAM_ERROR', message: err?.message ?? String(err), stateType: 'THINK', recoverable: false, recoveryAction: 'terminate' }, timestamp: Date.now() };
        // Terminal event guarantee: consumers key their cleanup on Completed
        // OR Interrupted. A bare `return` here used to emit NEITHER, so the
        // GUI's finalMessages stayed empty and this turn's user prompt +
        // partial answer were silently dropped from history.
        yield { type: 'Interrupted', payload: { reason: `llm_stream_error: ${err?.message ?? String(err)}`, lastState: 'THINK', completedSteps, messages, turnCount }, timestamp: Date.now() };
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

        for (const call of toolCalls) {
          yield { type: 'ToolStarted', payload: { toolName: call.function.name, toolCallId: call.id, toolCallArgs: call.function.arguments }, timestamp: Date.now() };
        }
        // Consecutive-identical dedupe: split the round's calls into real
        // executions and repeats of the immediately preceding SUCCESSFUL call
        // — across rounds (lastExecuted) and within the round itself, where a
        // parallel batch sometimes contains the very same call twice. A repeat
        // reuses that result instead of touching the world again — write tools
        // included, since re-writing identical content is a no-op. Only runs
        // of back-to-back identical calls dedupe: an identical call after a
        // DIFFERENT call may legitimately want fresh data (the round itself
        // may have changed the world in between). FAILED calls are never
        // deduped: re-executing after a failure is the legitimate
        // transient-fault retry path, so a failed anchor's repeats run for
        // real in a second pass below.
        const dedupedCalls: Array<{ call: (typeof toolCalls)[number]; key: string }> = [];
        const sameRoundDups: Array<{ call: (typeof toolCalls)[number]; anchorId: string }> = [];
        const toExecute: typeof toolCalls = [];
        // The open back-to-back run: its key and the first real-execution
        // candidate of the run (null when the run started from a cross-round
        // reuse — its result comes from lastExecuted, rule 1 above).
        let runKey: string | null = null;
        let runAnchorId: string | null = null;
        for (const call of toolCalls) {
          const key = callKey(call.function.name, call.function.arguments);
          if (lastExecuted && lastExecuted.ok && lastExecuted.key === key) {
            dedupedCalls.push({ call, key });
            runKey = key;
            runAnchorId = null;
            continue;
          }
          if (runKey === key && runAnchorId) {
            sameRoundDups.push({ call, anchorId: runAnchorId });
            continue;
          }
          runKey = key;
          runAnchorId = call.id;
          toExecute.push(call);
        }
        // Stream per-call completion: a parallel batch reports each tool the
        // moment it settles, so the GUI finalizes the fast subagent's card
        // while slower siblings still run (they used to all wait for the
        // whole Promise.all). executedResults ends up completion-ordered;
        // everything below (dedupe reuse, failure policy, transcript pairing)
        // keys by toolCallId / assembles in original order, so the reorder is
        // safe. lastExecuted's cursor now means "last to finish", which for a
        // concurrent batch is the truest "immediately preceding call".
        const executedResults: ExecutedToolResult[] = [];
        for await (const step of this.runBatch(toExecute, ctx, budget)) {
          if (step.kind === 'tool') {
            executedResults.push(step.tr);
            yield { type: 'ToolResult', payload: step.tr, timestamp: Date.now() };
          } else {
            yield { type: 'SubagentActivity', payload: step.event, timestamp: Date.now() };
          }
        }
        const textOfResult = (tr: ExecutedToolResult): string => tr.result.success
          ? typeof tr.result.result === 'string' ? tr.result.result : JSON.stringify(tr.result.result)
          : `Error: ${tr.result.error}`;
        // Second pass: repeats of a FAILED anchor execute for real. (A missing
        // anchor result counts as failed — never fabricate a reuse.)
        if (sameRoundDups.length > 0) {
          const passOne = new Map(executedResults.map((tr) => [tr.toolCallId, tr]));
          const retried = sameRoundDups
            .filter((dup) => !passOne.get(dup.anchorId)?.result.success)
            .map((dup) => dup.call);
          if (retried.length > 0) {
            for await (const step of this.runBatch(retried, ctx, budget)) {
              if (step.kind === 'tool') {
                executedResults.push(step.tr);
                yield { type: 'ToolResult', payload: step.tr, timestamp: Date.now() };
              } else {
                yield { type: 'SubagentActivity', payload: step.event, timestamp: Date.now() };
              }
            }
          }
        }
        const executedByCallId = new Map(executedResults.map((tr) => [tr.toolCallId, tr]));
        // Assemble in the ORIGINAL call order so the UI maps results back to
        // the right cards; deduped calls reuse the executed result. Repeats of
        // a failed anchor already re-executed in the second pass and keep
        // their own result.
        const reusedTextByCallId = new Map<string, string | null>();
        for (const dup of dedupedCalls) {
          // lastExecuted is immutable across the execution above — safe here.
          const snap = lastExecuted && lastExecuted.key === dup.key ? lastExecuted : null;
          reusedTextByCallId.set(dup.call.id, snap ? `${snap.text}\n\n${DEDUPE_NOTE}` : null);
        }
        for (const dup of sameRoundDups) {
          const anchor = executedByCallId.get(dup.anchorId);
          if (anchor?.result.success) {
            reusedTextByCallId.set(dup.call.id, `${textOfResult(anchor)}\n\n${DEDUPE_NOTE}`);
          }
        }
        const toolResults: ExecutedToolResult[] = [];
        for (const call of toolCalls) {
          if (reusedTextByCallId.has(call.id)) {
            const reused = reusedTextByCallId.get(call.id)!;
            toolResults.push({
              toolCallId: call.id,
              toolName: call.function.name,
              result: { id: call.id, toolName: call.function.name, result: reused ?? 'dedupe resolution failed', success: reused !== null, duration: 0 },
              duration: 0,
            });
            continue;
          }
          const tr = executedByCallId.get(call.id);
          if (tr) toolResults.push(tr);
        }
        // Real executions already streamed their ToolResult at completion
        // time; this tail loop emits only the synthetic results (dedupe
        // reuse / same-round repeats), so no card hears its result twice.
        const liveEmitted = new Set(executedResults.map((tr) => tr.toolCallId));
        for (const result of toolResults) {
          if (liveEmitted.has(result.toolCallId)) continue;
          yield { type: 'ToolResult', payload: result, timestamp: Date.now() };
        }
        // Advance the consecutive-call cursor from the last REAL execution
        // (second-pass retries included).
        const lastExec = executedResults[executedResults.length - 1];
        if (lastExec) {
          const callFor = toolCalls.find((c) => c.id === lastExec.toolCallId);
          lastExecuted = {
            key: callKey(lastExec.toolName, callFor?.function.arguments ?? ''),
            text: textOfResult(lastExec).slice(0, 8_000),
            ok: lastExec.result.success,
          };
        }

        // Append tool results to the conversation BEFORE anything else
        // consumes `messages`: the failure-policy branches below AND the
        // eventual Interrupted/Completed payloads (handover request, persisted
        // checkpoint) all assume every assistant.toolCalls is paired with tool
        // role messages — an unpaired tail gets the handover LLM call and any
        // resume request rejected with 400. (The policy-stop branch used to
        // emit handover/Interrupted BEFORE this push, so "graceful handover"
        // never actually worked in the most common stop scenario.)
        for (const tr of toolResults) {
          const rawText = tr.result.success
            ? typeof tr.result.result === 'string' ? tr.result.result : JSON.stringify(tr.result.result)
            : `Error: ${tr.result.error}`;
          const resultText = capToolResult(rawText, tr.toolName);
          messages.push({ role: 'tool', content: resultText, toolCallId: tr.toolCallId, toolName: tr.toolName });
          budget.addTokens(resultText);
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
            yield* emitHandover(action.reason);
            yield { type: 'Interrupted', payload: { reason: action.reason, lastState: 'ACT', completedSteps, messages, turnCount }, timestamp: Date.now() };
            interrupted = true; break;
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
          // retry/reflect carry a hint; degrade carries a reason — inject
          // whichever applies so the model sees the directive (degrade must
          // not silently retry without guidance).
          const toolGuidance = action.kind === 'degrade' ? action.reason : action.hint;
          messages.push({ role: 'user' as const, content: toolGuidance, internal: true });
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

        // Tool results were already appended to `messages` right after
        // execution (shared with the failure-policy branches — a single push
        // site keeps every consumer of `messages` well-formed).

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

        // Hard step cap (opt-in). With no hardMaxTurns set the budget is elastic
        // and the agent keeps working past the soft maxTurns instead of stopping.
        const hardMaxTurns = ctx.budget.hardMaxTurns ?? 0;
        if (hardMaxTurns > 0 && turnCount >= hardMaxTurns) {
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
        yield { type: 'Interrupted', payload: { reason: interruptedReasonFor(ctx.signal), lastState: 'THINK', completedSteps, messages, turnCount }, timestamp: Date.now() };
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
            Math.min(VERIFIER_TIMEOUT_MS, budget.streamDeadlineMs()),
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
                yield* emitHandover(action.reason);
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
              // hint already resolves degrade → action.reason, so the degraded
              // directive reaches the model instead of vanishing.
              messages.push({ role: 'user' as const, content: hint });
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
            yield { type: 'Interrupted', payload: { reason: interruptedReasonFor(ctx.signal), lastState: 'VERIFY', completedSteps, messages, turnCount }, timestamp: Date.now() };
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

      // ── continueGuard: "is the task ACTUALLY done?" ──
      // The model ended its round with plain text and no tool calls, and
      // VERIFY passed. For a question that is the correct ending; for a
      // multi-step plan it is frequently a PREMATURE stop (the model reports
      // progress and goes quiet while stages remain). The GUI supplies a
      // guard that knows the live plan state; a directive return injects an
      // internal nudge and re-enters THINK instead of terminating.
      if (ctx.continueGuard) {
        const directive = ctx.continueGuard({ content, turnCount, guardContinues });
        const emptyOutputNudge = 'Your previous response contained no output. Either continue executing the remaining task steps with tools, or give your final answer as text — an empty response is not acceptable.';
        const nudge = typeof directive === 'string' && directive.trim()
          ? directive
          : (!content.trim() && guardContinues < MAX_GUARD_CONTINUES ? emptyOutputNudge : false);
        if (nudge && guardContinues < MAX_GUARD_CONTINUES) {
          guardContinues++;
          messages.push({ role: 'user' as const, content: nudge, internal: true });
          budget.addTokens(nudge);
          turnCount++;
          budget.incrementTurn();
          yield { type: 'YieldControl', payload: { turnNumber: turnCount, budget: budget.snapshot() }, timestamp: Date.now() };
          continue;
        }
      }

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


}

