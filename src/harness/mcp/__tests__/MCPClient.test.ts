// src/harness/mcp/__tests__/MCPClient.test.ts
// MCPClient discovery + routing with the excluded-prefix filter (third-party
// MCP tool lists must not crowd out built-in tool selection). Uses the
// transportFactory test seam — no real subprocesses are spawned.

import { describe, expect, it } from 'bun:test';
import { MCPClient } from '../MCPClient';
import type { MCPTransport, MCPToolDescription } from '../../../adapter/mcp/MCPTransport';

class FakeTransport implements MCPTransport {
  tools: MCPToolDescription[] = [];
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'initialize') {
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } };
    }
    if (method === 'tools/list') return { tools: this.tools };
    if (method === 'tools/call') {
      return { content: [{ type: 'text', text: `called:${(params as { name: string }).name}` }] };
    }
    return {};
  }

  notify(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {}
}

const SERVER_TOOLS: MCPToolDescription[] = [
  { name: 'get', description: 'HTTP get', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'bulk_get', description: 'HTTP bulk get', inputSchema: { type: 'object' } },
  { name: 'fetch', description: 'Browser fetch', inputSchema: { type: 'object' } },
];

function makeClient(transport: FakeTransport, excludedPrefixes?: string[]): MCPClient {
  return new MCPClient({
    servers: [{ name: 'srv', transport: 'stdio', command: ['fake'] }],
    excludedPrefixes,
    transportFactory: () => transport,
  });
}

describe('MCPClient discovery with excluded prefixes', () => {
  it('registers every tool without a filter', async () => {
    const transport = new FakeTransport();
    transport.tools = SERVER_TOOLS;
    const client = makeClient(transport);
    await client.connectAll();
    expect(client.getTools().map((t) => t.name)).toEqual(['srv__get', 'srv__bulk_get', 'srv__fetch']);
  });

  it('hides tools whose full name starts with an excluded prefix', async () => {
    const transport = new FakeTransport();
    transport.tools = SERVER_TOOLS;
    const client = makeClient(transport, ['srv__bulk_']);
    await client.connectAll();
    const names = client.getTools().map((t) => t.name);
    expect(names).toEqual(['srv__get', 'srv__fetch']);
    // The server itself stays connected — only its tools are filtered.
    expect(client.isConnected('srv')).toBe(true);
  });

  it('hides everything when the prefix matches the server namespace', async () => {
    const transport = new FakeTransport();
    transport.tools = SERVER_TOOLS;
    const client = makeClient(transport, ['srv__']);
    await client.connectAll();
    expect(client.getTools()).toHaveLength(0);
    expect(client.isConnected('srv')).toBe(true);
  });

  it('routes calls to the filtered-in tools through the transport', async () => {
    const transport = new FakeTransport();
    transport.tools = SERVER_TOOLS;
    const client = makeClient(transport, ['srv__bulk_']);
    await client.connectAll();
    const result = await client.execute({
      id: 'call_1',
      index: 0,
      function: { name: 'srv__get', arguments: '{"url":"https://example.com"}' },
    });
    expect(result.success).toBe(true);
    expect(transport.calls.some((c) => c.method === 'tools/call' && (c.params as { name: string }).name === 'get')).toBe(true);
  });

  it('rejects calls to filtered-out tools as unknown', async () => {
    const transport = new FakeTransport();
    transport.tools = SERVER_TOOLS;
    const client = makeClient(transport, ['srv__bulk_']);
    await client.connectAll();
    const result = await client.execute({
      id: 'call_2',
      index: 0,
      function: { name: 'srv__bulk_get', arguments: '{}' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown MCP tool');
  });
});
