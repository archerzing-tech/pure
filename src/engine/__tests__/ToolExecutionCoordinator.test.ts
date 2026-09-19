// src/engine/__tests__/ToolExecutionCoordinator.test.ts
// The generic per-tool cap (TOOL_EXECUTION_TIMEOUT_MS) must yield to a tool's
// own declared budget: subagent delegations bracket a whole nested agent loop
// and announce their definition budget via getMetadata().timeoutMs. Before
// that channel existed, code_reviewer (budgeted 10 minutes) was killed by the
// generic 3-minute cap, and every FailurePolicy retry re-hit the same wall.

import { describe, expect, it } from 'bun:test';
import { ToolExecutionCoordinator, TOOL_EXECUTION_TIMEOUT_MS } from '../ToolExecutionCoordinator';
import type { EngineContext, ToolAdapter, ToolCall, ToolResult } from '../../shared/types';

const BUDGET = {
  incrementToolCall: () => {},
  remaining: () => ({ time: 60_000 }),
  streamDeadlineMs: () => 60_000,
};

function makeContext(execute: (tc: ToolCall) => Promise<ToolResult>, timeoutMs?: number): EngineContext {
  const tools: ToolAdapter = {
    getTools: () => [],
    getMetadata: () => (timeoutMs === undefined ? undefined : { sideEffects: false, isWrite: false, timeoutMs }),
    execute,
  };
  return { tools } as unknown as EngineContext;
}

function call(name: string): ToolCall {
  return { id: `call_${name}`, index: 0, function: { name, arguments: '{}' } };
}

function ok(tc: ToolCall): ToolResult {
  return { id: tc.id, toolName: tc.function.name, result: 'done', success: true, duration: 0 };
}

describe('ToolExecutionCoordinator tool budget', () => {
  it('a declared budget SMALLER than the generic cap bounds the execution', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const ctx = makeContext(async (tc) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return ok(tc);
    }, 50);

    const results = await coordinator.execute([call('slow_tool')], ctx, BUDGET);
    expect(results).toHaveLength(1);
    expect(results[0].result.success).toBe(false);
    // Stream deadline errors read in human units, and 50ms stays in seconds.
    expect(String(results[0].result.error)).toContain('timed out');
  }, 5_000);

  it('a tool without a declared budget keeps the generic cap (and succeeds under it)', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const ctx = makeContext(async (tc) => ok(tc));

    const results = await coordinator.execute([call('quick_tool')], ctx, BUDGET);
    expect(results[0].result.success).toBe(true);
    expect(TOOL_EXECUTION_TIMEOUT_MS).toBe(180_000); // the generic cap itself is unchanged
  }, 5_000);

  it('the engine remaining wall clock still wins over a generous declared budget', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const ctx = makeContext(async (tc) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return ok(tc);
    }, 600_000);
    const tightBudget = { incrementToolCall: () => {}, remaining: () => ({ time: 10 }), streamDeadlineMs: () => 10 };

    const results = await coordinator.execute([call('reviewer')], ctx, tightBudget);
    expect(results[0].result.success).toBe(false);
    expect(String(results[0].result.error)).toContain('timed out');
  }, 5_000);
});

describe('ToolExecutionCoordinator streaming completion', () => {
  it('executeStream yields the fast read while the slow sibling is still running', async () => {
    const coordinator = new ToolExecutionCoordinator();
    let slowResolved = false;
    const ctx = makeContext(async (tc) => {
      if (tc.function.name === 'slow_subagent') {
        await new Promise((resolve) => setTimeout(resolve, 120));
        slowResolved = true;
      }
      return ok(tc);
    });

    const yielded: string[] = [];
    for await (const tr of coordinator.executeStream([call('slow_subagent'), call('fast_subagent')], ctx, BUDGET)) {
      // The fast tool's result must surface while the slow one is still in
      // flight — that is the whole point (GUI finalizes finished cards early).
      if (tr.toolCallId === 'call_fast_subagent') expect(slowResolved).toBe(false);
      yielded.push(tr.toolCallId);
    }
    expect(yielded).toContain('call_fast_subagent');
    expect(yielded).toContain('call_slow_subagent');
    expect(slowResolved).toBe(true);
  }, 5_000);

  it('execute() keeps returning the full result set after the batch (back-compat)', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const ctx = makeContext(async (tc) => ok(tc));

    const results = await coordinator.execute([call('a'), call('b'), call('c')], ctx, BUDGET);
    expect(results.map((r) => r.toolCallId).sort()).toEqual(['call_a', 'call_b', 'call_c']);
  }, 5_000);
});
