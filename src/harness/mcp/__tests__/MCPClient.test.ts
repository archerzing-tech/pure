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

// 审计批 5⑦：MCP 工具写性客户端无从得知（注册恒 [Tags.MCP]，getMetadata
// 的 isWrite 恒 false → 并发池全放行），而同一 server 是一个进程、一份共享
// 状态——同服并发就是竞态。串行链建在 MCPClient（知识真正所在的一层）：
// 同服排队、跨服照旧并行。
describe('per-server call serialization (审计批 5⑦)', () => {
  it('same-server calls fired in parallel run one at a time (max in-flight = 1)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const transport = new FakeTransport();
    transport.tools = SERVER_TOOLS;
    const origSend = transport.send.bind(transport);
    transport.send = async (method, params) => {
      if (method === 'tools/call') {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
      }
      return origSend(method, params);
    };
    const client = makeClient(transport);
    await client.connectAll();
    const [a, b] = await Promise.all([
      client.execute({ id: 'p1', index: 0, function: { name: 'srv__get', arguments: '{}' } }),
      client.execute({ id: 'p2', index: 0, function: { name: 'srv__fetch', arguments: '{}' } }),
    ]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  it('a failed call does not poison the chain — the next same-server call still runs', async () => {
    const transport = new FakeTransport();
    transport.tools = SERVER_TOOLS;
    let failFirst = true;
    const origSend = transport.send.bind(transport);
    transport.send = async (method, params) => {
      if (method === 'tools/call' && failFirst) {
        failFirst = false;
        throw new Error('server hiccup');
      }
      return origSend(method, params);
    };
    const client = makeClient(transport);
    await client.connectAll();
    const first = await client.execute({ id: 'f1', index: 0, function: { name: 'srv__get', arguments: '{}' } });
    expect(first.success).toBe(false);
    const second = await client.execute({ id: 'f2', index: 0, function: { name: 'srv__get', arguments: '{}' } });
    expect(second.success).toBe(true);
  });
});

// 评审批 5 P2-1：串行链的生命周期必须跟着 transport 走。断连/重连后旧链的
// 队尾是一个已关 transport 上的僵尸在途调用（永不落定）——链不清，重连后的
// 新调用就被压在僵尸后面无限排队，表面是该 server 永久无响应。execute 不会
// 自动重连（断开直接报 not connected），所以每条用例先显式重连再发新调用。
describe('reconnect drops the zombie call chain (审计批 5⑦ P2-1)', () => {
  // 每次连接从工厂领新 transport：重连前的 tools/call 永不返回（僵尸），
  // unhang() 之后的连接正常应答。
  function hangingThenGoodClient(): { client: MCPClient; unhang: () => void } {
    let hangCalls = true;
    const client = new MCPClient({
      servers: [{ name: 'srv', transport: 'stdio', command: ['fake'] }],
      transportFactory: () => {
        const transport = new FakeTransport();
        transport.tools = SERVER_TOOLS;
        const origSend = transport.send.bind(transport);
        transport.send = async (method, params) => {
          if (method === 'tools/call' && hangCalls) await new Promise<void>(() => {});
          return origSend(method, params);
        };
        return transport;
      },
    });
    return { client, unhang: () => { hangCalls = false; } };
  }

  const fireZombie = async (client: MCPClient): Promise<void> => {
    void client.execute({ id: 'zombie', index: 0, function: { name: 'srv__get', arguments: '{}' } })
      .catch(() => undefined); // transport 被关后这条可能拒绝——测试不关心它的结局
    // 等僵尸真正进入挂起分支：串行链的任务在微任务里才起跑，同步代码之后
    // 才排空——不隔一拍，下面的 unhang() 会抢在 send 检查 hangCalls 之前，
    // 僵尸根本没挂住，测试对旧代码也是绿的。
    await Bun.sleep(10);
  };

  const raceFresh = (client: MCPClient): Promise<unknown> => Promise.race([
    client.execute({ id: 'fresh', index: 0, function: { name: 'srv__get', arguments: '{}' } }),
    new Promise((resolve) => setTimeout(() => resolve('stalled'), 500).unref?.()),
  ]);

  it('reconnecting a server: the next call is not queued behind a call that never returned', async () => {
    const { client, unhang } = hangingThenGoodClient();
    await client.connectAll();
    await fireZombie(client);
    unhang();
    await client.connectServer({ name: 'srv', transport: 'stdio', command: ['fake'] });
    const result = await raceFresh(client);
    expect(result).not.toBe('stalled');
    expect((result as { success: boolean }).success).toBe(true);
  });

  it('disconnectAll drops every chain — a fresh connect answers immediately', async () => {
    const { client, unhang } = hangingThenGoodClient();
    await client.connectAll();
    await fireZombie(client);
    client.disconnectAll();
    unhang();
    await client.connectAll();
    const result = await raceFresh(client);
    expect(result).not.toBe('stalled');
    expect((result as { success: boolean }).success).toBe(true);
  });
});
