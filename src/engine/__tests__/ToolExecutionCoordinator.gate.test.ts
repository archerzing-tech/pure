// src/engine/__tests__/ToolExecutionCoordinator.gate.test.ts
// 委派起飞闸（2026-09-26 用户实测）：取消型插话落在委派出生之前时，宿主
// 在批次起飞前拦下被取消的那支——被拦的调用拿到「用户已取消」合成结果
// （success:true + outcome:'stopped'，绝不走 success:false 的失败口径），
// 适配器根本看不到它；其余调用照常执行。无闸（CLI）行为不变。

import { describe, expect, it } from 'bun:test';
import { ToolExecutionCoordinator, type ToolExecutionBudget } from '../ToolExecutionCoordinator';
import type { EngineContext, ToolAdapter, ToolCall, ToolDefinition, ToolResult } from '../../shared/types';

class FakeTools implements ToolAdapter {
  calls: ToolCall[] = [];
  async execute(toolCall: ToolCall): Promise<ToolResult> {
    this.calls.push(toolCall);
    return { id: toolCall.id, toolName: toolCall.function.name, result: `ran:${toolCall.id}`, success: true, duration: 1 };
  }
  getMetadata(): undefined {
    return undefined;
  }
  getTools(): ToolDefinition[] {
    return [];
  }
}

const BUDGET: ToolExecutionBudget = {
  incrementToolCall() {},
  remaining: () => ({ time: 1_000_000 }),
  streamDeadlineMs: () => 60_000,
};

const delegate = (id: string, topic: string): ToolCall => ({
  id,
  index: 0,
  function: { name: 'researcher', arguments: JSON.stringify({ prompt: `请调研${topic}的最新进展，给出时间范围与关键事实。` }) },
});

describe('ToolExecutionCoordinator 委派起飞闸', () => {
  it('被取消点名的那支不进适配器，拿到合成取消结果；兄弟支照常跑', async () => {
    const tools = new FakeTools();
    const coordinator = new ToolExecutionCoordinator();
    const ctx = {
      tools,
      gateDelegations: async (calls: ToolCall[]) => {
        // 宿主口径的缩影：取消话按区分词点名——这里直接锁 callId=c3。
        return calls.filter((c) => c.function.arguments.includes('爆发点')).map((c) => ({ callId: c.id, reason: '用户说「这个不要调研了」' }));
      },
    } as unknown as EngineContext;

    const streamed: ToolResult[] = [];
    for await (const tr of coordinator.executeStream(
      [delegate('c1', 'agent 开发技术趋势'), delegate('c2', 'LLM 的发展方向'), delegate('c3', '未来三年的爆发点')],
      ctx,
      BUDGET,
    )) {
      streamed.push(tr.result);
    }

    // 三支都有结算结果（引擎的 tool_call/result 配对协议不允许悬空调用）。
    expect(streamed).toHaveLength(3);
    const cancelled = streamed.find((r) => r.id === 'c3');
    expect(cancelled?.success).toBe(true);
    expect(cancelled?.outcome).toBe('stopped');
    // 内层结算体对齐真停支形态：UI 从这里读 outcome（灰态）和 summary（卡面
    // 正文）——内层若是纯字符串，outcome 被漏读，卡片按绿✓成功结算（2026-09-26 用户复测）。
    const inner = (cancelled?.result ?? {}) as { aborted?: boolean; outcome?: string; reason?: string; summary?: string };
    expect(inner.aborted).toBe(true);
    expect(inner.outcome).toBe('stopped');
    expect(inner.summary).toContain('派出前收掉了这一路');
    // 模型侧指令在 reason：别算进汇总、别再派工。
    expect(inner.reason).toContain('最终汇总不要包含');
    expect(inner.reason).toContain('不要再为它派工');
    // 适配器只见到没被拦的两支——被取消的分支根本不出生。
    expect(tools.calls.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    // 兄弟支拿到的是真实执行结果，不是取消说明。
    expect(streamed.find((r) => r.id === 'c1')?.result).toBe('ran:c1');
  });

  it('闸放行（无挂号/认不出）：全部调用照常执行，无合成结果', async () => {
    const tools = new FakeTools();
    const coordinator = new ToolExecutionCoordinator();
    const ctx = {
      tools,
      gateDelegations: async () => [],
    } as unknown as EngineContext;

    const streamed: ToolResult[] = [];
    for await (const tr of coordinator.executeStream([delegate('c1', '趋势'), delegate('c2', '方向')], ctx, BUDGET)) {
      streamed.push(tr.result);
    }

    expect(streamed).toHaveLength(2);
    expect(streamed.every((r) => r.outcome === undefined)).toBe(true);
    expect(tools.calls.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
  });

  it('没接闸（CLI / 子代理引擎）：行为与历史完全一致', async () => {
    const tools = new FakeTools();
    const coordinator = new ToolExecutionCoordinator();
    const ctx = { tools } as unknown as EngineContext;

    const streamed: ToolResult[] = [];
    for await (const tr of coordinator.executeStream([delegate('c1', '趋势')], ctx, BUDGET)) {
      streamed.push(tr.result);
    }

    expect(streamed).toHaveLength(1);
    expect(streamed[0].result).toBe('ran:c1');
  });
});
