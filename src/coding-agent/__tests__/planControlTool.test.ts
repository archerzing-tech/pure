// src/coding-agent/__tests__/planControlTool.test.ts
// request_plan（决策边界刀 2，2026-11-07）的机械面契约：按名转发（known
// 检查前，stop_branch 同构）、独立超时 metadata、def 本体。清单面的回合
// 状态判据与桥的编排语义是宿主职责（chat.test 源码锚锁）。

import { describe, expect, it } from 'bun:test';
import { ToolRegistry } from '../ToolRegistry';
import type { ToolAdapter, ToolCall, ToolResult } from '../../shared/types';
import { REQUEST_PLAN_TOOL_DEF, REQUEST_PLAN_TOOL_NAME, REQUEST_PLAN_TIMEOUT_MS } from '../planControlTool';

const stubAdapter: ToolAdapter = {
  async execute(_call: ToolCall): Promise<ToolResult> {
    return { id: _call.id, toolName: _call.function.name, success: false, error: 'stub delegate must not be hit', duration: 0 };
  },
  getMetadata() { return {}; },
  getTools() { return []; },
};

function planCall(args = '{}'): ToolCall {
  return { id: 'call_rp', index: 0, function: { name: REQUEST_PLAN_TOOL_NAME, arguments: args } };
}

describe('request_plan 按名转发（known 检查前，决策边界刀 2）', () => {
  it('calls land on the host bridge, not the registry known-list', async () => {
    const registry = new ToolRegistry(stubAdapter);
    let received: ToolCall | undefined;
    registry.setPlanControl({
      defs: () => [REQUEST_PLAN_TOOL_DEF],
      execute: async (call) => {
        received = call;
        return { id: call.id, toolName: REQUEST_PLAN_TOOL_NAME, success: true, result: '规划已完成', duration: 0 };
      },
    });
    // 不在公共/委派 defs 里（getTools 空）——转发成功的证据 = 桥收到了调用。
    const result = await registry.execute(planCall('{"focus":"先定技术选型"}'));
    expect(result.success).toBe(true);
    expect(result.result).toBe('规划已完成');
    expect(received?.function.name).toBe(REQUEST_PLAN_TOOL_NAME);
  });

  it('no bridge injected → honest unknown-tool error (CLI shape)', async () => {
    const registry = new ToolRegistry(stubAdapter);
    const result = await registry.execute(planCall());
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('metadata declares the dedicated planning timeout (not the generic 180s cap)', () => {
    const registry = new ToolRegistry(stubAdapter);
    registry.setPlanControl({ defs: () => [], execute: async (c) => ({ id: c.id, toolName: c.function.name, success: true, duration: 0 }) });
    const meta = registry.getMetadata(REQUEST_PLAN_TOOL_NAME);
    expect(meta?.timeoutMs).toBe(REQUEST_PLAN_TIMEOUT_MS);
    expect(meta?.timeoutMs).toBeGreaterThan(180_000);
    expect(meta?.sideEffects).toBe(false);
    expect(meta?.isWrite).toBe(false);
  });
});

describe('REQUEST_PLAN_TOOL_DEF 本体', () => {
  it('name/schema contract: focus optional, no required args', () => {
    expect(REQUEST_PLAN_TOOL_DEF.name).toBe(REQUEST_PLAN_TOOL_NAME);
    expect(REQUEST_PLAN_TOOL_DEF.input_schema.required).toEqual([]);
    expect(REQUEST_PLAN_TOOL_DEF.input_schema.properties).toHaveProperty('focus');
  });

  it('description describes the mechanics, not when-to-call decision rules', () => {
    // 决策边界铁律：工具描述写「调用后会发生什么」，不写触发条件清单。
    expect(REQUEST_PLAN_TOOL_DEF.description).toContain('planning pass');
    expect(REQUEST_PLAN_TOOL_DEF.description).not.toMatch(/when (the task|you (should|need)|complex)/i);
  });
});
