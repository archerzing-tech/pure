// src/adapter/mcp/StdioTransport.ts
// v0.2 — MCP stdio transport: spawns a subprocess and communicates via stdin/stdout JSON-RPC.
// Node.js APIs are loaded dynamically to avoid crashing the Vite bundle in browser/Tauri contexts.

import type { MCPTransport, JSONRPCResponse } from './MCPTransport';
import { makeRequest } from './MCPTransport';

// Inline types to avoid static Node.js imports
interface ChildProcess {
  stdout: any; stderr: any; stdin: any;
  killed: boolean;
  on(event: string, cb: (...args: any[]) => void): void;
  kill(signal?: string): void;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class StdioTransport implements MCPTransport {
  private proc: ChildProcess | null = null;
  private processPromise: Promise<ChildProcess> | null = null;
  private pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private closed = false;
  private command: string[];
  private env?: Record<string, string>;

  constructor(command: string[], env?: Record<string, string>, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
    this.command = command;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  private async ensureProcess(): Promise<ChildProcess> {
    if (this.closed) throw new Error('Transport closed');
    if (this.proc && !this.proc.killed) return this.proc;
    if (this.processPromise) return this.processPromise;

    this.processPromise = this.startProcess();
    try {
      return await this.processPromise;
    } finally {
      this.processPromise = null;
    }
  }

  private async startProcess(): Promise<ChildProcess> {
    // Dynamically load Node.js APIs — only works in CLI/Node context, not browser
    const nodeCP = await (new Function('return import("node:child_process")')() as Promise<any>);
    const nodeRL = await (new Function('return import("node:readline")')() as Promise<any>);
    const { spawn } = nodeCP;
    const { createInterface } = nodeRL;

    const [cmd, ...args] = this.command;
    const proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(typeof process !== 'undefined' ? process.env : {}), ...this.env },
    }) as ChildProcess;
    if (this.closed) {
      proc.kill();
      throw new Error('Transport closed');
    }
    this.proc = proc;

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });

    rl.on('line', (line: string) => {
      try {
        const msg = JSON.parse(line) as JSONRPCResponse;
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // non-JSON line, ignore
      }
    });

    proc.stderr.on('data', (data: { toString(): string }) => {
      console.error('[MCP stderr]', data.toString().trim());
    });

    proc.on('exit', (code: number) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server exited with code ${code}`));
      }
      this.pending.clear();
      if (this.proc === proc) this.proc = null;
    });

    return proc;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const proc = await this.ensureProcess();
    const request = makeRequest(method, params);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(request.id)) return;
        reject(new Error(`MCP request timed out after ${this.requestTimeoutMs}ms: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });

      const payload = JSON.stringify(request) + '\n';
      proc.stdin.write(payload, (err: Error | null) => {
        if (err) {
          const pending = this.pending.get(request.id);
          if (pending) clearTimeout(pending.timer);
          this.pending.delete(request.id);
          reject(err);
        }
      });
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const proc = await this.ensureProcess();
    const notification = { jsonrpc: '2.0' as const, method, params };
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`MCP notification timed out after ${this.requestTimeoutMs}ms: ${method}`));
      }, this.requestTimeoutMs);
      proc.stdin.write(JSON.stringify(notification) + '\n', (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      });
    });
  }

  close(): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Transport closed'));
    }
    this.pending.clear();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
