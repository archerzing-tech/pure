// src/adapter/mcp/TauriStdioTransport.ts
// v0.1 — MCP stdio transport backed by the Rust subprocess manager
// (spawn_mcp / mcp_request / mcp_notify / mcp_shutdown). The desktop WebView
// cannot import node:child_process (StdioTransport), so stdio MCP servers are
// spawned in Rust, which owns the child process and its pipes; this transport
// is a thin invoke wrapper over that registry.

import type { MCPTransport, JSONRPCResponse } from './MCPTransport';
import { makeRequest } from './MCPTransport';
import { loadTauriCore } from '../../shared/tauri';

const REQUEST_TIMEOUT_MS = 30_000;

export class TauriStdioTransport implements MCPTransport {
  private spawned = false;
  private closed = false;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly sessionId: string,
    private readonly name: string,
    private readonly command: string[],
    private readonly env?: Record<string, string>,
    private readonly proxyUrl = '',
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
  }

  private async ensureSpawned(): Promise<void> {
    if (this.spawned) return;
    if (this.closed) throw new Error('Transport closed');
    const core = await loadTauriCore();
    if (!core) throw new Error('MCP stdio requires the Tauri runtime');
    const args: Record<string, unknown> = {
      sessionId: this.sessionId,
      name: this.name,
      command: this.command[0] ?? '',
      args: this.command.slice(1),
    };
    const env = { ...(this.env ?? {}) };
    if (this.proxyUrl) {
      env.HTTP_PROXY = this.proxyUrl;
      env.HTTPS_PROXY = this.proxyUrl;
      env.ALL_PROXY = this.proxyUrl;
      env.NO_PROXY = 'localhost,127.0.0.1,::1';
    }
    if (Object.keys(env).length > 0) args.env = env;
    await core.invoke<string>('spawn_mcp', args);
    this.spawned = true;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureSpawned();
    const core = await loadTauriCore();
    if (!core) throw new Error('MCP stdio requires the Tauri runtime');
    const request = makeRequest(method, params);
    const response = await withTimeout(
      core.invoke<string>('mcp_request', {
        sessionId: this.sessionId,
        name: this.name,
        request: JSON.stringify(request),
      }),
      this.requestTimeoutMs,
      `MCP request timed out after ${this.requestTimeoutMs}ms: ${method}`,
    );

    let msg: JSONRPCResponse;
    try {
      msg = JSON.parse(response) as JSONRPCResponse;
    } catch {
      throw new Error(`MCP invalid response: ${response.slice(0, 200)}`);
    }
    if (msg.error) {
      throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
    }
    return msg.result;
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.ensureSpawned();
    const core = await loadTauriCore();
    if (!core) throw new Error('MCP stdio requires the Tauri runtime');
    const notification = { jsonrpc: '2.0' as const, method, params };
    await core.invoke<void>('mcp_notify', {
      sessionId: this.sessionId,
      name: this.name,
      request: JSON.stringify(notification),
    });
  }

  close(): void {
    this.closed = true;
    if (!this.spawned) return;
    void loadTauriCore().then((core) => {
      if (!core) return;
      core.invoke<void>('mcp_shutdown', { sessionId: this.sessionId, name: this.name }).catch(() => {});
    });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
