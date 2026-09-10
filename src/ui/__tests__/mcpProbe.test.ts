// src/ui/__tests__/mcpProbe.test.ts
// The settings MCP probe must discover every tool (including excluded ones,
// marked — not omitted), strip the [MCP:server] description prefix, and always
// tear down the transport — even when connect fails or times out. Runs on the
// transportFactory seam: no real subprocess is spawned.

import { describe, expect, it } from 'bun:test';
import { probeMcpServerTools } from '../mcpProbe';
import type { MCPTransport, MCPToolDescription, MCPServerConfig } from '../../adapter/mcp/MCPTransport';

class FakeTransport implements MCPTransport {
  tools: MCPToolDescription[] = [];
  failOnInitialize = false;
  closed = false;
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'initialize') {
      if (this.failOnInitialize) throw new Error('spawn failed: command not found');
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } };
    }
    if (method === 'tools/list') return { tools: this.tools };
    return {};
  }

  notify(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
  }
}

const SERVER: MCPServerConfig = { name: 'fs', transport: 'stdio', command: ['fake'] };

describe('probeMcpServerTools', () => {
  it('returns full tool names with [MCP:server] stripped from descriptions', async () => {
    const transport = new FakeTransport();
    // Server-side descriptions are unprefixed; mcpToolToDefinition adds
    // "[MCP:fs]" during registration, and the probe strips it back off.
    transport.tools = [
      { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
      { name: 'bulk_read', description: 'Bulk reads', inputSchema: { type: 'object' } },
    ];
    const result = await probeMcpServerTools(SERVER, {
      excludedPrefixes: [],
      transportFactory: () => transport,
    });
    expect(result.error).toBeUndefined();
    expect(result.tools.map((t) => t.name)).toEqual(['fs__read_file', 'fs__bulk_read']);
    expect(result.tools[0].description).toBe('Read a file');
    expect(transport.closed).toBe(true);
  });

  it('marks excluded-prefix tools instead of omitting them', async () => {
    const transport = new FakeTransport();
    transport.tools = [
      { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
      { name: 'bulk_read', description: 'Bulk reads', inputSchema: { type: 'object' } },
    ];
    const result = await probeMcpServerTools(SERVER, {
      excludedPrefixes: ['fs__bulk_'],
      transportFactory: () => transport,
    });
    expect(result.tools.map((t) => t.excluded)).toEqual([false, true]);
    expect(result.tools).toHaveLength(2);
  });

  it('surfaces connect failures and still closes the transport', async () => {
    const transport = new FakeTransport();
    transport.failOnInitialize = true;
    const result = await probeMcpServerTools(SERVER, {
      excludedPrefixes: [],
      transportFactory: () => transport,
    });
    expect(result.error).toContain('spawn failed');
    expect(result.tools).toEqual([]);
    expect(transport.closed).toBe(true);
  });

  it('times out a hung server and still closes the transport', async () => {
    const transport = new FakeTransport();
    transport.send = () => new Promise(() => {}); // never resolves
    const result = await probeMcpServerTools(SERVER, {
      excludedPrefixes: [],
      timeoutMs: 30,
      timeoutLabel: '连接 MCP 服务器超时',
      transportFactory: () => transport,
    });
    expect(result.error).toBe('连接 MCP 服务器超时');
    expect(transport.closed).toBe(true);
  });
});
