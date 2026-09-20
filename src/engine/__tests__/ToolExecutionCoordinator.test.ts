// src/engine/__tests__/ToolExecutionCoordinator.test.ts
// The generic per-tool cap (TOOL_EXECUTION_TIMEOUT_MS) must yield to a tool's
// own declared budget: subagent delegations bracket a whole nested agent loop
// and announce their definition budget via getMetadata().timeoutMs. Before
// that channel existed, code_reviewer (budgeted 10 minutes) was killed by the
// generic 3-minute cap, and every FailurePolicy retry re-hit the same wall.

import { describe, expect, it } from 'bun:test';
import { ToolExecutionCoordinator, TOOL_EXECUTION_TIMEOUT_MS, type ExecutedToolResult } from '../ToolExecutionCoordinator';
import { abortPaused } from '../../shared/pauseSignal';
import type { EngineContext, ToolAdapter, ToolCall, ToolResult } from '../../shared/types';

const BUDGET = {
  incrementToolCall: () => {},
  remaining: () => ({ time: 60_000 }),
  streamDeadlineMs: () => 60_000,
};

type ToolMetadata = { sideEffects?: boolean; isWrite?: boolean; timeoutMs?: number };

function makeContext(
  execute: (tc: ToolCall) => Promise<ToolResult>,
  metadata?: ToolMetadata | ((name: string) => ToolMetadata | undefined),
): EngineContext {
  const tools: ToolAdapter = {
    getTools: () => [],
    getMetadata: (name: string) => (typeof metadata === 'function' ? metadata(name) : metadata),
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
    }, { timeoutMs: 50 });

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
    }, { timeoutMs: 600_000 });
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

describe('ToolExecutionCoordinator concurrency policy (2026-09-20)', () => {
  // Regression anchor: sideEffects used to force the writes pool, so four
  // bash_executor delegations scanning four folders ran one-after-another —
  // the exact fan-out users delegate subagents for (2026-09-20 user report).
  it('side-effecting-but-not-writing calls overlap in one batch', async () => {
    const coordinator = new ToolExecutionCoordinator();
    let inFlight = 0;
    let peak = 0;
    const ctx = makeContext(async (tc) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 60));
      inFlight--;
      return ok(tc);
    }, { sideEffects: true, isWrite: false });

    const results = await coordinator.execute([call('scan_a'), call('scan_b'), call('scan_c'), call('scan_d')], ctx, BUDGET);
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.result.success)).toBe(true);
    expect(peak).toBe(4);
  }, 5_000);

  it('isWrite tools stay sequential (lock discipline for file mutators)', async () => {
    const coordinator = new ToolExecutionCoordinator();
    let inFlight = 0;
    let peak = 0;
    const ctx = makeContext(async (tc) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight--;
      return ok(tc);
    }, { sideEffects: true, isWrite: true });

    const results = await coordinator.execute([call('write_a'), call('write_b')], ctx, BUDGET);
    expect(results).toHaveLength(2);
    expect(peak).toBe(1);
  }, 5_000);

  it('a mixed batch overlaps the side-effecting call and queues the write behind reads', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const events: string[] = [];
    const metadataFor = (name: string) => (name === 'mutator' ? { sideEffects: true, isWrite: true } : { sideEffects: true, isWrite: false });
    const ctx = makeContext(async (tc) => {
      events.push(`start:${tc.function.name}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
      events.push(`end:${tc.function.name}`);
      return ok(tc);
    }, metadataFor);

    await coordinator.execute([call('mutator'), call('scanner')], ctx, BUDGET);
    // Reads fire first (concurrently), the write runs after they settle.
    expect(events[0]).toBe('start:scanner');
    expect(events.indexOf('start:mutator')).toBeGreaterThan(events.indexOf('end:scanner'));
  }, 5_000);
});

describe('ToolExecutionCoordinator pause semantics (阶段 12)', () => {
  // Coordinator-local view of the pause contract: a PAUSE abort (reason
  // PAUSE_ABORT_REASON) must never reach the tool — in-flight work finishes
  // with a clean signal and its real result is returned; a plain abort still
  // forwards (hard stop unchanged).
  function makeSignalCtx(signal: AbortSignal | undefined, execute: (tc: ToolCall, signal?: AbortSignal) => Promise<ToolResult>): EngineContext {
    const tools: ToolAdapter = {
      getTools: () => [],
      getMetadata: (name: string) => (name === 'writer' ? { isWrite: true } : undefined),
      execute,
    };
    return { tools, signal } as unknown as EngineContext;
  }

  it('a pause abort does not reach an in-flight tool; its real result is returned', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const ac = new AbortController();
    let toolSawAbort = false;
    const ctx = makeSignalCtx(ac.signal, async (tc, signal) => {
      while (!ac.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      toolSawAbort = signal?.aborted ?? false;
      return ok(tc);
    });

    const gen = coordinator.executeStream([call('slow_read')], ctx, BUDGET);
    const yielded: ExecutedToolResult[] = [];
    const consume = (async () => {
      for await (const tr of gen) yielded.push(tr);
    })();
    setTimeout(() => abortPaused(ac), 10);
    await consume;

    expect(toolSawAbort).toBe(false);
    expect(yielded).toHaveLength(1);
    expect(yielded[0].result.success).toBe(true);
  }, 5_000);

  it('a queued write is skipped once paused (never executed), with a pairing result', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const ac = new AbortController();
    let writerExecuted = 0;
    const ctx = makeSignalCtx(ac.signal, async (tc) => {
      if (tc.function.name === 'reader') {
        while (!ac.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      } else {
        writerExecuted++;
      }
      return ok(tc);
    });

    const gen = coordinator.executeStream([call('reader'), call('writer')], ctx, BUDGET);
    const yielded: ExecutedToolResult[] = [];
    const consume = (async () => {
      for await (const tr of gen) yielded.push(tr);
    })();
    setTimeout(() => abortPaused(ac), 10);
    await consume;

    expect(writerExecuted).toBe(0);
    const writerResult = yielded.find((tr) => tr.toolCallId === 'call_writer');
    // The transcript pairing still needs a result for every call id — it just
    // records that the call never started.
    expect(writerResult).toBeDefined();
    expect(writerResult!.result.success).toBe(false);
    expect(String(writerResult!.result.error)).toContain('paused');
  }, 5_000);

  it('a plain abort still forwards to the in-flight tool (hard stop unchanged)', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const ac = new AbortController();
    let toolSawAbort = false;
    const ctx = makeSignalCtx(ac.signal, async (tc, signal) => {
      // Record the kill synchronously in the child signal's own abort event:
      // runWithDeadline stops waiting for this tool the instant it aborts, so
      // anything assigned after an await would run after the test finished.
      signal?.addEventListener('abort', () => { toolSawAbort = true; });
      await new Promise((resolve) => setTimeout(resolve, 60));
      return ok(tc);
    });

    const gen = coordinator.executeStream([call('slow_read')], ctx, BUDGET);
    const yielded: ExecutedToolResult[] = [];
    const consume = (async () => {
      for await (const tr of gen) yielded.push(tr);
    })();
    setTimeout(() => ac.abort(), 10);
    await consume;

    expect(toolSawAbort).toBe(true);
    expect(yielded).toHaveLength(1);
    expect(yielded[0].result.success).toBe(false);
  }, 5_000);
});
