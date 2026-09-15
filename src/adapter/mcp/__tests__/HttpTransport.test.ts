import { describe, expect, it } from 'bun:test';
import { serve } from 'bun';
import { HttpTransport, MCP_HTTP_PROTOCOL_VERSION } from '../HttpTransport';

/** Minimal streamable-HTTP MCP server: answers `initialize` with a session
 * header + inline JSON (negotiated version), other requests echo received
 * headers. Can be told to require the legacy /message endpoint, or to hold an
 * SSE reply open without ever sending the response. */
function startStreamableServer(opts: { legacyOnly?: boolean; sseReply?: boolean; neverReplySse?: boolean } = {}) {
  const sessions = new Set<string>();
  const server = serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (opts.legacyOnly) {
        if (url.pathname === '/sse') return new Response('event: message\ndata: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
        if (url.pathname !== '/message') return new Response('not found', { status: 404 });
      } else if (url.pathname === '/sse') {
        return new Response('event: message\ndata: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const body = await req.text();
      const msg = JSON.parse(body) as { id?: number; method?: string; params?: Record<string, unknown> };
      const sessionId = req.headers.get('mcp-session-id') ?? undefined;

      // Notifications (no id) are acked with 202 and no body per spec.
      if (msg.id === undefined) return new Response(null, { status: 202 });

      if (msg.method === 'initialize') {
        const sid = 'sess-test-1';
        sessions.add(sid);
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: MCP_HTTP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '0' } },
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': sid,
          },
        });
      }

      if (msg.method === 'tools/list') {
        if (opts.neverReplySse) {
          // Hold the SSE body open forever: no data, no close, no error — the
          // client's pending timer (not the stream) must settle the request.
          return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (opts.sseReply) {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } })}\n\n`));
              controller.close();
            },
          });
          return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        // Echo back the protocol version + session id the client sent.
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: {
            tools: [],
            echoedProtocolVersion: req.headers.get('mcp-protocol-version'),
            echoedSessionId: sessionId,
            sessionKnown: sessionId ? sessions.has(sessionId) : false,
          },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 0, error: { code: -32601, message: 'unknown method' } }), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { url: `http://localhost:${server.port}`, server, sessions };
}

describe('MCP Streamable HTTP transport', () => {
  it('negotiates the newest protocol version and carries the session id + version header on later requests', async () => {
    const { url, server } = startStreamableServer();
    try {
      const t = new HttpTransport(url);
      const init = await t.send('initialize', { protocolVersion: MCP_HTTP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'pure', version: 'test' } }) as { protocolVersion: string };
      expect(init.protocolVersion).toBe(MCP_HTTP_PROTOCOL_VERSION);
      await t.notify('notifications/initialized', {});
      const result = await t.send('tools/list', {}) as { echoedProtocolVersion?: string; echoedSessionId?: string; sessionKnown?: boolean };
      expect(result.echoedProtocolVersion).toBe(MCP_HTTP_PROTOCOL_VERSION);
      expect(result.echoedSessionId).toBe('sess-test-1');
      expect(result.sessionKnown).toBe(true);
      t.close();
    } finally {
      server.stop(true);
    }
  });

  it('reads the JSON-RPC response from an SSE stream attached to the POST', async () => {
    const { url, server } = startStreamableServer({ sseReply: true });
    try {
      const t = new HttpTransport(url);
      await t.send('initialize', { protocolVersion: MCP_HTTP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'pure', version: 'test' } });
      await t.notify('notifications/initialized', {});
      const result = await t.send('tools/list', {}) as { tools: Array<{ name: string }> };
      expect(result.tools.map((tool) => tool.name)).toContain('echo');
      t.close();
    } finally {
      server.stop(true);
    }
  });

  it('rejects on timeout while an SSE reply is held open and releases the reader', async () => {
    const { url, server } = startStreamableServer({ neverReplySse: true });
    try {
      const t = new HttpTransport(url, '', 200);
      // The stream never carries the response, so the pending timer settles
      // the request while the server keeps the POST open.
      await expect(t.send('tools/list', {})).rejects.toThrow(/timed out after 200ms/);
      // The fetch abort lands a tick after the pending timer (same
      // requestTimeoutMs, timer inserted first), so the read loop's cleanup
      // (finish()/finally) may run just after the rejection is observed —
      // poll briefly for the reader to leave sseReaders instead of asserting
      // synchronously. A reader left behind keeps the SSE body held past the
      // request's lifetime, the leak this cleanup exists to prevent.
      const readers = t as unknown as { sseReaders: Set<unknown> };
      const deadline = Date.now() + 1000;
      while (readers.sseReaders.size > 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(readers.sseReaders.size).toBe(0);
      t.close();
    } finally {
      server.stop(true);
    }
  });

  it('falls back to the legacy /message endpoint when the streamable endpoint 404s', async () => {
    const { url, server } = startStreamableServer({ legacyOnly: true });
    try {
      const t = new HttpTransport(url);
      const init = await t.send('initialize', { protocolVersion: MCP_HTTP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'pure', version: 'test' } }) as { protocolVersion: string };
      // Legacy test server still answers initialize inline.
      expect(init.protocolVersion).toBe(MCP_HTTP_PROTOCOL_VERSION);
      await t.notify('notifications/initialized', {});
      t.close();
    } finally {
      server.stop(true);
    }
  });

  it('propagates JSON-RPC errors from the server', async () => {
    const { url, server } = startStreamableServer();
    try {
      const t = new HttpTransport(url);
      await t.send('initialize', { protocolVersion: MCP_HTTP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'pure', version: 'test' } });
      await t.notify('notifications/initialized', {});
      await expect(t.send('bogus/method', {})).rejects.toThrow(/MCP error -32601/);
      t.close();
    } finally {
      server.stop(true);
    }
  });
});
