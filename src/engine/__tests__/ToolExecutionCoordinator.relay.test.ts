// src/engine/__tests__/ToolExecutionCoordinator.relay.test.ts
// 接力流水线的编排层集成测试（北极星第 5 步）：拓扑序执行、参数直灌、
// 观察消隐（收据）、失败传播与回灌、声明校验。纯函数层见 relayPipeline.test.ts。

import { describe, expect, it } from 'bun:test';
import { ToolExecutionCoordinator, type ExecutedToolResult } from '../ToolExecutionCoordinator';
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

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, index: 0, function: { name, arguments: JSON.stringify(args) } };
}

async function collect(gen: AsyncGenerator<ExecutedToolResult>): Promise<ExecutedToolResult[]> {
  const out: ExecutedToolResult[] = [];
  for await (const tr of gen) out.push(tr);
  return out;
}

describe('ToolExecutionCoordinator relay pipeline', () => {
  it('runs a two-stage chain in order, hands the output over, and ships a receipt', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const events: string[] = [];
    let plannerSaw = '';
    const ctx = makeContext(async (tc) => {
      events.push(`start:${tc.function.name}`);
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      if (tc.function.name === 'researcher') {
        events.push(`end:${tc.function.name}`);
        return { id: tc.id, toolName: tc.function.name, result: 'RESEARCH_FINDINGS_BODY', success: true, duration: 1 };
      }
      plannerSaw = String(args.context ?? '');
      events.push(`end:${tc.function.name}`);
      return { id: tc.id, toolName: tc.function.name, result: `PLAN_BUILT_ON:${plannerSaw}`, success: true, duration: 1 };
    });

    const results = await collect(coordinator.executeStream([
      call('c1', 'researcher', { topic: 'x', relay: { as: 'research' } }),
      call('c2', 'planner', { context: '', relay: { from: { research: 'context' } } }),
    ], ctx, BUDGET));

    // Serial handoff: researcher fully settles before planner starts.
    expect(events).toEqual(['start:researcher', 'end:researcher', 'start:planner', 'end:planner']);
    expect(plannerSaw).toBe('RESEARCH_FINDINGS_BODY');
    // The parent sees a receipt for the consumed stage — not the raw text.
    const research = results.find((tr) => tr.toolCallId === 'c1')!;
    expect(String(research.result.result)).toContain('[relay]');
    expect(String(research.result.result)).toContain('"planner"');
    expect(String(research.result.result)).not.toContain('RESEARCH_FINDINGS_BODY');
    // The final stage's result reaches the parent untouched.
    const plan = results.find((tr) => tr.toolCallId === 'c2')!;
    expect(plan.result.result).toBe('PLAN_BUILT_ON:RESEARCH_FINDINGS_BODY');
  }, 5_000);

  it('receipt keeps the SubagentResult shape and only swaps the output field', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const ctx = makeContext(async (tc) => (
      tc.function.name === 'researcher'
        ? { id: tc.id, toolName: tc.function.name, result: { agentId: 'ag-1', agentName: 'researcher', success: true, output: 'RAW_FINDINGS' }, success: true, duration: 1 }
        : { id: tc.id, toolName: tc.function.name, result: 'ok', success: true, duration: 1 }
    ));

    const results = await collect(coordinator.executeStream([
      call('c1', 'researcher', { relay: { as: 'r' } }),
      call('c2', 'planner', { relay: { from: { r: 'context' } } }),
    ], ctx, BUDGET));

    const value = results.find((tr) => tr.toolCallId === 'c1')!.result.result as Record<string, unknown>;
    expect(value.agentId).toBe('ag-1');
    expect(String(value.output)).toContain('[relay]');
    expect(String(value.output)).not.toContain('RAW_FINDINGS');
  }, 5_000);

  it('a failed upstream skips its consumers (never executed) and ships its FULL result', async () => {
    const coordinator = new ToolExecutionCoordinator();
    let plannerRan = false;
    const ctx = makeContext(async (tc) => {
      if (tc.function.name === 'researcher') {
        return { id: tc.id, toolName: tc.function.name, error: 'provider 5xx', success: false, duration: 1 };
      }
      plannerRan = true;
      return { id: tc.id, toolName: tc.function.name, result: 'ok', success: true, duration: 1 };
    });

    const results = await collect(coordinator.executeStream([
      call('c1', 'researcher', { relay: { as: 'research' } }),
      call('c2', 'planner', { relay: { from: { research: 'context' } } }),
    ], ctx, BUDGET));

    expect(plannerRan).toBe(false);
    const skip = results.find((tr) => tr.toolCallId === 'c2')!;
    expect(skip.result.success).toBe(false);
    expect(String(skip.result.error)).toContain('research');
    expect(String(skip.result.error)).toContain('provider 5xx');
    // The failed upstream's own result is untouched (no receipt on failures).
    const research = results.find((tr) => tr.toolCallId === 'c1')!;
    expect(research.result.success).toBe(false);
    expect(research.result.error).toBe('provider 5xx');
  }, 5_000);

  it('a consumer failure keeps the upstream FULL output for re-planning', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const ctx = makeContext(async (tc) => (
      tc.function.name === 'researcher'
        ? { id: tc.id, toolName: tc.function.name, result: 'PRECIOUS_FINDINGS', success: true, duration: 1 }
        : { id: tc.id, toolName: tc.function.name, error: 'planner crashed', success: false, duration: 1 }
    ));

    const results = await collect(coordinator.executeStream([
      call('c1', 'researcher', { relay: { as: 'research' } }),
      call('c2', 'planner', { relay: { from: { research: 'context' } } }),
    ], ctx, BUDGET));

    const research = results.find((tr) => tr.toolCallId === 'c1')!;
    expect(research.result.result).toBe('PRECIOUS_FINDINGS');
  }, 5_000);

  it('a diamond hands one upstream to two consumers; receipt names both', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const seen: Record<string, string> = {};
    const ctx = makeContext(async (tc) => {
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      if (tc.function.name !== 'researcher') seen[tc.function.name] = String(args.input ?? '');
      return { id: tc.id, toolName: tc.function.name, result: 'COMMON', success: true, duration: 1 };
    });

    const results = await collect(coordinator.executeStream([
      call('c1', 'researcher', { relay: { as: 'r' } }),
      call('c2', 'planner_a', { relay: { from: { r: 'input' } } }),
      call('c3', 'planner_b', { relay: { from: { r: 'input' } } }),
    ], ctx, BUDGET));

    expect(seen.planner_a).toBe('COMMON');
    expect(seen.planner_b).toBe('COMMON');
    const research = results.find((tr) => tr.toolCallId === 'c1')!;
    expect(String(research.result.result)).toContain('"planner_a"');
    expect(String(research.result.result)).toContain('"planner_b"');
  }, 5_000);

  it('independent calls still overlap while a relay chain serializes', async () => {
    const coordinator = new ToolExecutionCoordinator();
    let inFlight = 0;
    let peak = 0;
    const chainOrder: string[] = [];
    const ctx = makeContext(async (tc) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      chainOrder.push(`start:${tc.function.name}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      chainOrder.push(`end:${tc.function.name}`);
      inFlight--;
      if (tc.function.name === 'stage_a') return { id: tc.id, toolName: tc.function.name, result: 'A_OUT', success: true, duration: 1 };
      return { id: tc.id, toolName: tc.function.name, result: 'ok', success: true, duration: 1 };
    });

    await collect(coordinator.executeStream([
      call('c1', 'stage_a', { relay: { as: 'a' } }),
      call('c2', 'stage_b', { relay: { from: { a: 'input' } } }),
      call('c3', 'solo_read', {}),
      call('c4', 'solo_read2', {}),
    ], ctx, BUDGET));

    expect(peak).toBe(3); // stage_a + two solos overlap in level 0
    expect(chainOrder.indexOf('start:stage_b')).toBeGreaterThan(chainOrder.indexOf('end:stage_a'));
  }, 5_000);

  it('invalid declarations yield pairing errors; every call still gets exactly one result', async () => {
    const coordinator = new ToolExecutionCoordinator();
    let executed = 0;
    const ctx = makeContext(async (tc) => {
      executed++;
      return { id: tc.id, toolName: tc.function.name, result: 'ok', success: true, duration: 1 };
    });

    const results = await collect(coordinator.executeStream([
      call('c1', 'agent_x', { relay: { as: 'dup' } }),
      call('c2', 'agent_x', { relay: { as: 'dup' } }), // duplicate stage name
      call('c3', 'agent_x', { relay: { from: { ghost: 'x' } } }), // unknown upstream
      call('c4', 'agent_x', { relay: { as: 's', from: { s: 'x' } } }), // self-cycle
      call('c5', 'agent_x', {}), // plain call runs normally
    ], ctx, BUDGET));

    expect(executed).toBe(2); // c1 (first 'dup' registration wins) and c5
    expect(results).toHaveLength(5);
    const byId = new Map(results.map((tr) => [tr.toolCallId, tr]));
    expect(byId.get('c5')!.result.success).toBe(true);
    expect(byId.get('c1')!.result.success).toBe(true);
    expect(String(byId.get('c2')!.result.error)).toContain('已被同批另一个调用占用');
    expect(String(byId.get('c3')!.result.error)).toContain('ghost');
    expect(String(byId.get('c4')!.result.error)).toContain('成环');
  }, 5_000);

  it('a three-stage chain substitutes transitively (A → B → C)', async () => {
    const coordinator = new ToolExecutionCoordinator();
    const seen: Record<string, string> = {};
    const ctx = makeContext(async (tc) => {
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      const output = { stage_a: 'A_OUT', stage_b: `B(A=${String(args.input ?? '')})`, stage_c: `C(B=${String(args.plan ?? '')})` }[tc.function.name];
      if (tc.function.name !== 'stage_a') seen[tc.function.name] = output;
      return { id: tc.id, toolName: tc.function.name, result: output, success: true, duration: 1 };
    });

    await collect(coordinator.executeStream([
      call('c1', 'stage_a', { relay: { as: 'a' } }),
      call('c2', 'stage_b', { relay: { as: 'b', from: { a: 'input' } } }),
      call('c3', 'stage_c', { relay: { from: { b: 'plan' } } }),
    ], ctx, BUDGET));

    expect(seen.stage_b).toBe('B(A=A_OUT)');
    expect(seen.stage_c).toBe('C(B=B(A=A_OUT))');
  }, 5_000);
});
