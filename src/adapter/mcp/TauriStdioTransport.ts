// src/adapter/mcp/TauriStdioTransport.ts
// v0.2 — MCP stdio transport backed by the Rust subprocess manager
// (spawn_mcp / mcp_request / mcp_notify / mcp_shutdown). The desktop WebView
// cannot import node:child_process (StdioTransport), so stdio MCP servers are
// spawned in Rust, which owns the child process and its pipes; this transport
// is a thin invoke wrapper over that registry.
// v0.2 adds lazy respawn: Rust detects a dead child (mcp.rs
// drop_handle_if_dead), drops its registry handle and marks the error; on a
// marked failure we un-latch `spawned` so the next send/notify respawns —
// the GUI counterpart of CLI StdioTransport's exit→teardown→respawn cycle.

import type { MCPTransport, JSONRPCResponse } from './MCPTransport';
import { makeRequest } from './MCPTransport';
import { loadTauriCore } from '../../shared/tauri';

const REQUEST_TIMEOUT_MS = 30_000;

/** 子进程死亡标记，与 Rust 侧 mcp.rs 的 CHILD_GONE_PREFIX 成对：子进程死
 *  后 Rust 丢掉注册表句柄并给错误打这个稳定前缀。改一边必须同步另一边。 */
const CHILD_GONE_PREFIX = 'MCP server process gone';

/** 判断一次 send/notify 失败是否意味着「子进程已死、句柄已丢」。除了
 *  死亡标记，「MCP not found」是同一事实的并发面：Rust 丢句柄与下一请求
 *  查表竞态时，第二者拿到的是查表失败——spawned 闩同样已过期，该摘。 */
function isChildGone(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.startsWith(CHILD_GONE_PREFIX) || message.startsWith('MCP not found')
  );
}

export class TauriStdioTransport implements MCPTransport {
  private spawned = false;
  /** 在飞的首次 spawn：并发首调的单飞闸（审计批 4⑥）。没有它，两个请求
   *  各看到 spawned=false 就各 invoke 一遍 spawn_mcp，Rust 侧同键覆盖旧
   *  handle——旧子进程从此没人杀，每个重复 spawn 泄漏一个进程。 */
  private spawning?: Promise<void>;
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
    this.spawning ??= this.doSpawn().catch((err: unknown) => {
      // 失败不锁门：清掉在飞凭据，下次调用可以重试 spawn。
      this.spawning = undefined;
      throw err;
    });
    return this.spawning;
  }

  private async doSpawn(): Promise<void> {
    const args: Record<string, unknown> = {
      sessionId: this.sessionId,
      name: this.name,
      command: this.command[0] ?? '',
      args: this.command.slice(1),
      // The proxy URL carries the username only; Rust resolves the password
      // from ~/.pure/secrets.json and sets HTTP(S)_PROXY on the child.
      proxyUrl: this.proxyUrl,
    };
    if (this.env && Object.keys(this.env).length > 0) args.env = this.env;
    await this.invokeCommand<string>('spawn_mcp', args);
    this.spawned = true;
  }

  /** 单一 invoke 收口：core 获取与命令调用都从这里走。测试以仓内的实例
   *  覆写惯例替换它——mock.module 是全进程注册，会与别的测试文件互踩。 */
  private async invokeCommand<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    const core = await loadTauriCore();
    if (!core) throw new Error('MCP stdio requires the Tauri runtime');
    return core.invoke<T>(cmd, args);
  }

  /** 子进程已死的善后：摘掉 spawned 闩、清掉在飞 spawn 凭据，下一次
   *  send/notify 经 ensureSpawned 懒重生——等价 CLI StdioTransport 的
   *  exit→teardown（proc 置空）→下次 send 从头重生。当次请求照常失败，
   *  不做透明重试。 */
  private markProcessDead(): void {
    this.spawned = false;
    this.spawning = undefined;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureSpawned();
    const request = makeRequest(method, params);
    let response: string;
    try {
      response = await withTimeout(
        this.invokeCommand<string>('mcp_request', {
          sessionId: this.sessionId,
          name: this.name,
          request: JSON.stringify(request),
        }),
        this.requestTimeoutMs,
        `MCP request timed out after ${this.requestTimeoutMs}ms: ${method}`,
      );
    } catch (err) {
      if (isChildGone(err)) this.markProcessDead();
      throw err;
    }

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
    const notification = { jsonrpc: '2.0' as const, method, params };
    try {
      await this.invokeCommand<void>('mcp_notify', {
        sessionId: this.sessionId,
        name: this.name,
        request: JSON.stringify(notification),
      });
    } catch (err) {
      if (isChildGone(err)) this.markProcessDead();
      throw err;
    }
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
