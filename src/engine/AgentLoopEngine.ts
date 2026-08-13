// src/engine/AgentLoopEngine.ts
// v0.4 — full 5-state ReAct loop: THINK → ACT → OBSERVE → THINK (tool loop) → VERIFY → TERMINATE.
// Fixes: BudgetWarning events, completedSteps/lastState tracking, note injection for recoverable errors,
//        VERIFY_FAILED → loop back to THINK with reflection note instead of completing.

import type { Message, EngineContext, EngineEvent, RunInput, RunContinueInput, ToolCall, AgentStateType, FailureRecord, TokenUsage, VerificationSummary } from '../shared/types';
import { mergeTokenUsage } from '../shared/usage';
import { safeParseArgs } from '../shared/format';
import { BudgetManager } from './BudgetManager';
import { FileLockManager } from './FileLockManager';

export class AgentLoopEngine {
  private fileLock = new FileLockManager();

  async *run(
    input: RunInput,
    ctx: EngineContext,
  ): AsyncGenerator<EngineEvent, void, void> {
    const budget = new BudgetManager(input.budget);
    const messages: Message[] = [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userPrompt },
    ];
    budget.addTokens(input.systemPrompt + input.userPrompt);

    yield* this.runLoop(messages, ctx, budget, 1);
  }

  async *continue(
    input: RunContinueInput,
    ctx: EngineContext,
  ): AsyncGenerator<EngineEvent, void, void> {
    const budget = new BudgetManager(input.budget);
    const messages: Message[] = [...input.messages, { role: 'user' as const, content: input.newUserPrompt }];
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
    const hasTools = ctx.tools && ctx.toolsDefs.length > 0;
    const completedSteps: string[] = [];
    let finalOutput: string | undefined;
    let interrupted = false;
    const failures: FailureRecord[] = [];
    // Aggregated billing usage across every LLM call in this turn (each
    // iteration's stream yields a `usage` chunk) — surfaced on Completed so
    // the GUI can accumulate per-session token totals + cost.
    let turnUsage: TokenUsage | undefined;
    let verification: VerificationSummary = { status: 'not_run', evidence: [] };

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

      try {
        const toolsDefs = hasTools ? ctx.toolsDefs : [];
        for await (const chunk of ctx.llm.stream(messages, toolsDefs, ctx.signal)) {
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
              yield { type: 'TokenDelta', payload: { content: chunk.arguments ?? '', stateId: sid(), isToolCall: true, toolCallBuffer: chunk.arguments, toolCallName: chunk.name }, timestamp: Date.now() };
              break;
            case 'tool_call':
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
      } catch (err: any) {
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
            messages.push({ role: 'user' as const, content: action.hint });
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
            const resultText = tr.result.success
              ? typeof tr.result.result === 'string' ? tr.result.result : JSON.stringify(tr.result.result)
              : `Error: ${tr.result.error}`;
            messages.push({ role: 'tool', content: resultText, toolCallId: tr.toolCallId, toolName: tr.toolName });
            budget.addTokens(resultText);
          }
          if (action.kind !== 'degrade') {
            messages.push({ role: 'user' as const, content: action.hint });
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
          const resultText = tr.result.success
            ? typeof tr.result.result === 'string' ? tr.result.result : JSON.stringify(tr.result.result)
            : `Error: ${tr.result.error}`;
          messages.push({ role: 'tool', content: resultText, toolCallId: tr.toolCallId, toolName: tr.toolName });
          budget.addTokens(resultText);
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
          const result = await ctx.verifier.evaluate({ output: content, context: messages });
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
          const result = await ctx.tools!.execute(tc, ctx.signal);
          return { toolName: tc.function.name, result, duration: result.duration, toolCallId: tc.id };
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
          const result = await ctx.tools!.execute(tc, ctx.signal);
          results.push({ toolName: tc.function.name, result, duration: result.duration, toolCallId: tc.id });
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

