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

export class StdioTransport implements MCPTransport {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private command: string[];
  private env?: Record<string, string>;

  constructor(command: string[], env?: Record<string, string>) {
    this.command = command;
    this.env = env;
  }

  private async ensureProcess(): Promise<ChildProcess> {
    if (this.proc && !this.proc.killed) return this.proc;

    // Dynamically load Node.js APIs — only works in CLI/Node context, not browser
    const nodeCP = await (new Function('return import("node:child_process")')() as Promise<any>);
    const nodeRL = await (new Function('return import("node:readline")')() as Promise<any>);
    const { spawn } = nodeCP;
    const { createInterface } = nodeRL;

    const [cmd, ...args] = this.command;
    this.proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(typeof process !== 'undefined' ? process.env : {}), ...this.env },
    }) as ChildProcess;

    const rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });

    rl.on('line', (line: string) => {
      try {
        const msg = JSON.parse(line) as JSONRPCResponse;
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
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

    this.proc.stderr.on('data', (data: { toString(): string }) => {
      console.error('[MCP stderr]', data.toString().trim());
    });

    this.proc.on('exit', (code: number) => {
      for (const [id, p] of this.pending) {
        p.reject(new Error(`MCP server exited with code ${code}`));
      }
      this.pending.clear();
      this.proc = null;
    });

    return this.proc;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const proc = await this.ensureProcess();
    const request = makeRequest(method, params);

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });

      const payload = JSON.stringify(request) + '\n';
      proc.stdin.write(payload, (err: Error | null) => {
        if (err) {
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
      proc.stdin.write(JSON.stringify(notification) + '\n', (err: Error | null) => {
        if (err) reject(err); else resolve();
      });
    });
  }

  close(): void {
    for (const [, p] of this.pending) {
      p.reject(new Error('Transport closed'));
    }
    this.pending.clear();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
