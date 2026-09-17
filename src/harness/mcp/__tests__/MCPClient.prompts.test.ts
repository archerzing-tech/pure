// src/harness/mcp/__tests__/MCPClient.prompts.test.ts
// MCP prompts (6.2): capability gating, `server__name` addressing, argument
// validation, and failure isolation — a server whose prompts misbehave must
// still keep its tools, and every error must be a message the user can read.

import { describe, expect, it } from 'bun:test';
import { MCPClient } from '../MCPClient';
import type {
  MCPPromptDescription,
  MCPTransport,
  MCPToolDescription,
} from '../../../adapter/mcp/MCPTransport';

class PromptTransport implements MCPTransport {
  capabilities: Record<string, unknown> = { tools: {}, prompts: {} };
  prompts: MCPPromptDescription[] = [];
  /** What `prompts/get` returns, keyed by prompt name. */
  result: { description?: string; messages?: unknown[] } = {};
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
    if (method === 'prompts/list') return { prompts: this.prompts };
    if (method === 'prompts/get') return this.result;
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

function makeClient(transport: PromptTransport): MCPClient {
  return new MCPClient({
    servers: [{ name: 'srv', transport: 'stdio', command: ['fake'] }],
    transportFactory: () => transport,
  });
}

describe('MCPClient prompts', () => {
  it('never probes prompts when the server does not advertise them', async () => {
    const transport = new PromptTransport();
    transport.capabilities = { tools: {} };
    transport.prompts = [{ name: 'weekly' }];
    const client = makeClient(transport);

    await client.connectAll();

    expect(transport.countCalls('prompts/list')).toBe(0);
    expect(await client.listPrompts()).toEqual([]);
  });

  it('addresses templates as server__name for the composer', async () => {
    const transport = new PromptTransport();
    transport.prompts = [{ name: 'summarize', description: 'Summarize a file', arguments: [{ name: 'path', required: true }] }];
    const client = makeClient(transport);

    await client.connectAll();

    expect(await client.listPrompts()).toEqual([
      {
        name: 'summarize',
        description: 'Summarize a file',
        arguments: [{ name: 'path', required: true }],
        serverName: 'srv',
        key: 'srv__summarize',
      },
    ]);
  });

  it('renders the server template returned by prompts/get', async () => {
    const transport = new PromptTransport();
    transport.prompts = [{ name: 'summarize', description: 'Summarize a file', arguments: [{ name: 'path', required: true }] }];
    transport.result = {
      description: 'Summarize a file',
      messages: [{ role: 'user', content: { type: 'text', text: 'Summarize notes.md and list risks.' } }],
    };
    const client = makeClient(transport);

    await client.connectAll();
    const resolved = await client.getPrompt('srv__summarize', { path: 'notes.md' });

    expect(resolved).toEqual({
      ok: true,
      key: 'srv__summarize',
      description: 'Summarize a file',
      text: 'Summarize notes.md and list risks.',
    });
    const getCall = transport.calls.find((c) => c.method === 'prompts/get');
    expect(getCall?.params).toEqual({ name: 'summarize', arguments: { path: 'notes.md' } });
  });

  it('refuses to send a template with a required argument missing', async () => {
    const transport = new PromptTransport();
    transport.prompts = [{ name: 'summarize', arguments: [{ name: 'path', required: true }, { name: 'format' }] }];
    const client = makeClient(transport);

    await client.connectAll();
    const resolved = await client.getPrompt('srv__summarize', {});

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain('path');
    expect(transport.countCalls('prompts/get')).toBe(0);
  });

  it('reports an unknown key together with the ones that do exist', async () => {
    const transport = new PromptTransport();
    transport.prompts = [{ name: 'weekly' }];
    const client = makeClient(transport);

    await client.connectAll();
    const resolved = await client.getPrompt('srv__nope', {});

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toContain('srv__nope');
      expect(resolved.error).toContain('srv__weekly');
    }
  });

  it('explains an empty catalog instead of only saying "not found"', async () => {
    const transport = new PromptTransport();
    const client = makeClient(transport);

    await client.connectAll();
    const resolved = await client.getPrompt('srv__weekly', {});

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain('没有已连接服务器提供 prompt 模板');
  });

  it('keeps the tools and the connection when prompts/list fails', async () => {
    const transport = new PromptTransport();
    transport.failOn = 'prompts/list';
    transport.prompts = [{ name: 'weekly' }];
    const client = makeClient(transport);

    await client.connectAll();

    expect(client.getTools().map((t) => t.name)).toEqual(['srv__get']);
    expect(client.isConnected('srv')).toBe(true);
    expect(await client.listPrompts()).toEqual([]);
  });

  it('surfaces a prompts/get failure as a readable error', async () => {
    const transport = new PromptTransport();
    transport.prompts = [{ name: 'weekly' }];
    transport.failOn = 'prompts/get';
    const client = makeClient(transport);

    await client.connectAll();
    const resolved = await client.getPrompt('srv__weekly', {});

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain('prompts/get exploded');
  });
});
