// src/harness/mcp/__tests__/MCPClient.resources.test.ts
// MCP resource context: capability gating, text-only injection, size caps, and
// failure isolation. A server that advertises resources but cannot serve them
// must still keep its tools; a chatty server must not flood the prompt.

import { describe, expect, it } from 'bun:test';
import { MCPClient } from '../MCPClient';
import type {
  MCPResourceContents,
  MCPResourceDescription,
  MCPTransport,
  MCPToolDescription,
} from '../../../adapter/mcp/MCPTransport';

class ResourceTransport implements MCPTransport {
  /** Server capabilities echoed by initialize — `resources` is the gate. */
  capabilities: Record<string, unknown> = { tools: {}, resources: {} };
  resources: MCPResourceDescription[] = [];
  contents = new Map<string, MCPResourceContents[]>();
  failOn: string | null = null;
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'initialize') {
      return { protocolVersion: '2026-07-28', capabilities: this.capabilities, serverInfo: { name: 'fake', version: '1' } };
    }
    if (method === this.failOn) throw new Error(`${method} exploded`);
    if (method === 'tools/list') {
      const tool: MCPToolDescription = { name: 'get', description: 'HTTP get', inputSchema: { type: 'object' } };
      return { tools: [tool] };
    }
    if (method === 'resources/list') return { resources: this.resources };
    if (method === 'resources/read') {
      const uri = (params as { uri: string }).uri;
      return { contents: this.contents.get(uri) ?? [] };
    }
    return {};
  }

  notify(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {}

  countCalls(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

function makeClient(transport: ResourceTransport): MCPClient {
  return new MCPClient({
    servers: [{ name: 'srv', transport: 'stdio', command: ['fake'] }],
    transportFactory: () => transport,
  });
}

describe('MCPClient resource context', () => {
  it('never probes resources when the server does not advertise them', async () => {
    const transport = new ResourceTransport();
    transport.capabilities = { tools: {} };
    transport.resources = [{ uri: 'file:///a.md', name: 'a' }];
    const client = makeClient(transport);

    await client.connectAll();

    expect(transport.countCalls('resources/list')).toBe(0);
    expect(await client.collectResourceContext()).toBe('');
    expect(client.getResources()).toEqual([]);
  });

  it('reads listed text resources into the injected context', async () => {
    const transport = new ResourceTransport();
    transport.resources = [{ uri: 'file:///notes.md', name: 'notes', description: 'Project notes', mimeType: 'text/markdown' }];
    transport.contents.set('file:///notes.md', [{ uri: 'file:///notes.md', mimeType: 'text/markdown', text: 'ship the MCP layer' }]);
    const client = makeClient(transport);

    await client.connectAll();
    const context = await client.collectResourceContext();

    expect(context).toContain('[srv]');
    expect(context).toContain('file:///notes.md (text/markdown) — Project notes');
    expect(context).toContain('<resource uri="file:///notes.md">');
    expect(context).toContain('ship the MCP layer');
    expect(client.getResources()).toEqual([
      { uri: 'file:///notes.md', name: 'notes', description: 'Project notes', mimeType: 'text/markdown', serverName: 'srv' },
    ]);
  });

  it('skips binary resources carried only as base64 blobs', async () => {
    const transport = new ResourceTransport();
    transport.resources = [
      { uri: 'file:///shot.png', name: 'shot', mimeType: 'image/png' },
      { uri: 'file:///blob.bin', name: 'blob', mimeType: 'application/octet-stream' },
    ];
    transport.contents.set('file:///shot.png', [{ uri: 'file:///shot.png', mimeType: 'image/png', blob: 'aGk=' }]);
    transport.contents.set('file:///blob.bin', [{ uri: 'file:///blob.bin', blob: 'aGk=' }]);
    const client = makeClient(transport);

    await client.connectAll();

    expect(await client.collectResourceContext()).toBe('');
    expect(transport.countCalls('resources/read')).toBe(0);
  });

  it('truncates an oversized resource instead of flooding the prompt', async () => {
    const transport = new ResourceTransport();
    transport.resources = [{ uri: 'file:///big.txt', name: 'big', mimeType: 'text/plain' }];
    transport.contents.set('file:///big.txt', [{ uri: 'file:///big.txt', text: 'x'.repeat(9_000) }]);
    const client = makeClient(transport);

    await client.connectAll();
    const context = await client.collectResourceContext();

    expect(context).toContain('…[truncated]');
    expect(context.length).toBeLessThan(3_000);
  });

  it('keeps the tools and stays quiet when resources/list fails', async () => {
    const transport = new ResourceTransport();
    transport.resources = [{ uri: 'file:///a.md', name: 'a' }];
    transport.failOn = 'resources/list';
    const client = makeClient(transport);

    await client.connectAll();

    expect(client.getTools().map((t) => t.name)).toEqual(['srv__get']);
    expect(client.isConnected('srv')).toBe(true);
    expect(await client.collectResourceContext()).toBe('');
  });

  it('reads each resource once per connection and reuses the rendered body', async () => {
    const transport = new ResourceTransport();
    transport.resources = [{ uri: 'file:///a.md', name: 'a', mimeType: 'text/markdown' }];
    transport.contents.set('file:///a.md', [{ uri: 'file:///a.md', text: 'cached body' }]);
    const client = makeClient(transport);

    await client.connectAll();
    const first = await client.collectResourceContext();
    const second = await client.collectResourceContext();

    expect(first).toBe(second);
    expect(transport.countCalls('resources/read')).toBe(1);

    // A reconnect drops the cached body along with the old transport.
    client.disconnectAll();
    expect(await client.collectResourceContext()).toBe('');
  });
});
