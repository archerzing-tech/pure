// src/engine/AgentLoopEngine.ts
// v0.4 — full 5-state ReAct loop: THINK → ACT → OBSERVE → THINK (tool loop) → VERIFY → TERMINATE.
// Fixes: BudgetWarning events, completedSteps/lastState tracking, note injection for recoverable errors,
//        VERIFY_FAILED → loop back to THINK with reflection note instead of completing.

import type { Message, EngineContext, EngineEvent, RunInput, RunContinueInput, ToolCall, AgentStateType, FailureRecord, TokenUsage, VerificationSummary, ToolResult } from '../shared/types';
import { mergeTokenUsage } from '../shared/usage';
import { streamLlmTurn, MAX_STREAM_RESUMES, STREAM_RESUME_HINT } from './LlmTurnRunner';
import { runWithDeadline } from './streamDeadline';
import { BudgetManager } from './BudgetManager';
import { ToolExecutionCoordinator } from './ToolExecutionCoordinator';

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

export class AgentLoopEngine {
  private toolCoordinator = new ToolExecutionCoordinator();

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
          for await (const chunk of streamLlmTurn({ llm: ctx.llm, messages: [...messages, ask], tools: [], signal: ctx.signal, timeoutMs: 60_000 })) {
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
        const streamTimeoutMs = Math.max(1, budget.remaining().time);
        for await (const chunk of streamLlmTurn({
          llm: ctx.llm,
          messages,
          tools: toolsDefs,
          signal: ctx.signal,
          timeoutMs: streamTimeoutMs,
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
      } catch (err: any) {
        if (ctx.signal?.aborted) {
          flushPartialAssistant();
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
        const toolResults = await this.toolCoordinator.execute(toolCalls, ctx, budget);
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
            yield* emitHandover(action.reason);
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


}

