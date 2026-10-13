// src/__tests__/cliCapabilityTools.test.ts
// CLI 侧动态能力工具的组合适配器 + ToolRegistry 可见性开口（2026-10-13
// 真机判例：workspace 模式的模型清单走 getTools()，纯 isPublicToolName
// 过滤把注册过的动态/MCP 工具全滤掉——执行路通而模型看不见）。

import { describe, expect, it } from 'bun:test';
import { ToolRegistry, Tags } from '../coding-agent/ToolRegistry';
import { CliCapabilityToolAdapter, type CliCapabilityHost } from '../harness/cliCapabilityTools';
import { DYNAMIC_CAPABILITY_TOOL_DEFS } from '../shared/dynamicCapabilityTools';
import type { ToolAdapter, ToolCall, ToolResult } from '../shared/types';

function stubInner(): ToolAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getTools: () => [{ name: 'read_file', description: 'x', input_schema: { type: 'object' } }],
    getMetadata: () => undefined,
    execute: async (toolCall: ToolCall): Promise<ToolResult> => {
      calls.push(toolCall.function.name);
      return { id: toolCall.id, toolName: toolCall.function.name, result: 'inner-ok', success: true, duration: 1 };
    },
  } as ToolAdapter & { calls: string[] };
}

function stubHost(): CliCapabilityHost & { configs: unknown[] } {
  const configs: unknown[] = [];
  return {
    configs,
    connectMcp: async (config) => {
      configs.push(config);
      return { tools: [{ name: 'rea__trace', description: 'd', input_schema: { type: 'object' } }], persisted: true };
    },
  };
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `test_${name}`, index: 0, function: { name, arguments: JSON.stringify(args) } };
}

describe('ToolRegistry model-visible filter opens for dynamic + MCP tools', () => {
  it('exposes registered dynamic capability tools and MCP-discovered tools', () => {
    const registry = new ToolRegistry(stubInner());
    for (const tool of DYNAMIC_CAPABILITY_TOOL_DEFS) {
      registry.register({ ...tool, tags: [Tags.READ], riskLevel: 'low', serverName: 'pure-capabilities' });
    }
    registry.register({ name: 'rea__trace', description: 'mcp tool', input_schema: { type: 'object' }, tags: [Tags.MCP], riskLevel: 'low' });
    // 未注册进 PUBLIC 名单的普通自定义工具仍被滤（开口只给动态能力与 MCP）。
    registry.register({ name: 'mystery_tool', description: 'nope', input_schema: { type: 'object' }, tags: [Tags.READ], riskLevel: 'low' });
    const names = registry.getTools().map((t) => t.name);
    expect(names).toContain('search_mcp_servers');
    expect(names).toContain('register_mcp_server');
    expect(names).toContain('rea__trace');
    expect(names).not.toContain('mystery_tool');
  });
});

describe('CliCapabilityToolAdapter', () => {
  it('forwards non-dynamic tool calls to the inner adapter', async () => {
    const inner = stubInner();
    const adapter = new CliCapabilityToolAdapter(inner, stubHost());
    const result = await adapter.execute(toolCall('read_file', { path: 'a.txt' }));
    expect(result.success).toBe(true);
    expect(inner.calls).toEqual(['read_file']);
  });

  it('lists the five dynamic capability tools after the inner tools', () => {
    const adapter = new CliCapabilityToolAdapter(stubInner(), stubHost());
    const names = adapter.getTools().map((t) => t.name);
    expect(names[0]).toBe('read_file');
    for (const def of DYNAMIC_CAPABILITY_TOOL_DEFS) expect(names).toContain(def.name);
  });

  it('registers a custom stdio server through the host with the exact config', async () => {
    const host = stubHost();
    const adapter = new CliCapabilityToolAdapter(stubInner(), host);
    const result = await adapter.execute(toolCall('register_mcp_server', {
      name: 'rea',
      transport: 'stdio',
      command: ['npx', '-y', 'rea-agents@latest', 'mcp'],
      env: { REA_LOG: 'info' },
      requestTimeoutMs: 120000,
    }));
    expect(result.success).toBe(true);
    expect(host.configs).toEqual([{ name: 'rea', transport: 'stdio', command: ['npx', '-y', 'rea-agents@latest', 'mcp'], env: { REA_LOG: 'info' }, requestTimeoutMs: 120000 }]);
    expect(String(result.result)).toContain('rea__trace');
  });

  it('rejects malformed register_mcp_server args before the host is ever reached', async () => {
    const host = stubHost();
    const adapter = new CliCapabilityToolAdapter(stubInner(), host);
    for (const args of [
      { transport: 'stdio', command: ['npx'] },
      { name: 'x', transport: 'stdio' },
      { name: 'x', transport: 'stdio', command: [] },
      { name: 'x', transport: 'http' },
      { name: 'x', transport: 'http', url: 'ftp://nope' },
      { name: 'x', transport: 'websocket' },
    ]) {
      const result = await adapter.execute(toolCall('register_mcp_server', args));
      expect(result.success).toBe(false);
      expect(result.error).toBeTypeOf('string');
    }
    expect(host.configs).toEqual([]);
  });

  it('connect_mcp_server rejects an unknown candidate without touching the host', async () => {
    const host = stubHost();
    const adapter = new CliCapabilityToolAdapter(stubInner(), host);
    const result = await adapter.execute(toolCall('connect_mcp_server', { candidateId: 'never-searched' }));
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Unknown MCP candidate');
    expect(host.configs).toEqual([]);
  });

  it('wraps adapter errors as failed tool results instead of throwing', async () => {
    const host: CliCapabilityHost = {
      connectMcp: async () => {
        throw new Error('npx not found');
      },
    };
    const adapter = new CliCapabilityToolAdapter(stubInner(), host);
    const result = await adapter.execute(toolCall('register_mcp_server', { name: 'rea', transport: 'stdio', command: ['npx'] }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('npx not found');
  });
});
