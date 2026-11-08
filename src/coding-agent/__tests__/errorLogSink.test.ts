// src/coding-agent/__tests__/errorLogSink.test.ts
// 错误台账的工具失败记账闸口（ToolRegistry.execute 包层）：
// 真失败过账、成功与权限拒绝不过账、sink 抛错不反噬执行。
import { describe, it, expect } from 'bun:test';
import { ToolRegistry, Tags } from '../ToolRegistry';
import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../../shared/types';
import type { PermissionManager } from '../PermissionManager';

function delegateReturning(result: ToolResult): ToolAdapter {
  return {
    getTools: (): ToolDefinition[] => [],
    getMetadata: () => ({}),
    execute: async (): Promise<ToolResult> => result,
  };
}

function call(name = 'flaky_tool'): ToolCall {
  return { id: 'call-1', index: 0, function: { name, arguments: '{}' } };
}

/** 显式注册（构造器不吸收 delegate 的清单，内建名单之外要 register）。 */
function registryWith(result: ToolResult): ToolRegistry {
  const registry = new ToolRegistry(delegateReturning(result));
  registry.register({ name: 'flaky_tool', description: 'demo', input_schema: { type: 'object' }, tags: [Tags.READ], riskLevel: 'low' });
  return registry;
}

describe('ToolRegistry error-log sink', () => {
  it('records real failures with tool name, error text and duration', async () => {
    const registry = registryWith({ id: 'call-1', toolName: 'flaky_tool', error: 'boom: 404', success: false, duration: 7 });
    const lines: string[] = [];
    registry.setErrorLogSink((line) => lines.push(line));
    await registry.execute(call());
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.source).toBe('tool');
    expect(parsed.kind).toBe('tool_error');
    expect(parsed.message).toBe('flaky_tool: boom: 404');
    expect(String(parsed.detail)).toContain('durationMs=');
  });

  it('stays silent on success and on permission denials', async () => {
    const ok = registryWith({ id: 'call-1', toolName: 'flaky_tool', success: true, duration: 3 });
    const okLines: string[] = [];
    ok.setErrorLogSink((line) => okLines.push(line));
    await ok.execute(call());
    expect(okLines).toHaveLength(0);

    // 权限拒绝是预期交互流（用户说不），记账即噪音。
    const denied = registryWith({ id: 'call-1', toolName: 'flaky_tool', success: true, duration: 3 });
    denied.setPermissionManager({
      askUser: async () => ({ allowed: false, reason: 'user said no' }),
    } as unknown as PermissionManager);
    const deniedLines: string[] = [];
    denied.setErrorLogSink((line) => deniedLines.push(line));
    const result = await denied.execute(call());
    expect(result.success).toBe(false);
    expect(deniedLines).toHaveLength(0);
  });

  it('keeps executing when the sink itself throws', async () => {
    const registry = registryWith({ id: 'call-1', toolName: 'flaky_tool', error: 'disk full', success: false, duration: 1 });
    registry.setErrorLogSink(() => {
      throw new Error('sink exploded');
    });
    const result = await registry.execute(call());
    // 记账失败不影响结果原样返回。
    expect(result.error).toBe('disk full');
  });

  it('records unknown-tool calls (the model calling a ghost)', async () => {
    const registry = registryWith({ id: 'x', toolName: 'whatever', success: true, duration: 1 });
    const lines: string[] = [];
    registry.setErrorLogSink((line) => lines.push(line));
    await registry.execute(call('ghost_tool'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ghost_tool: Unknown tool');
  });
});
