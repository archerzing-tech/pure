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

// Cap on buffered stderr lines. MCP servers launched via bunx/npx write benign
// startup progress to stderr ("Resolving dependencies", "Web Search MCP Server
// started") that we don't want spamming every CLI launch, so we buffer a tail
// and only surface it when the process exits unexpectedly.
const STDERR_TAIL_MAX = 20;

export class StdioTransport implements MCPTransport {
  private proc: ChildProcess | null = null;
  private processPromise: Promise<ChildProcess> | null = null;
  private pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private closed = false;
  private command: string[];
  private env?: Record<string, string>;
  private stderrTail: string[] = [];
  /** Human-readable reason the last spawn failed (latched by the 'error'
   * handler). The write-callback rejection defers one tick so a broken stdin
   * surfaces this instead of a bare ERR_STREAM_DESTROYED. */
  private startError: string | null = null;
  /** stdout line reader; closed on exit and on close() so the readline
   *  interface (and its buffered lines) does not outlive the process. */
  private rl: { close(): void } | null = null;

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
    this.startError = null;
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
    this.rl = rl;

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

    // Buffer stderr instead of printing it live. Benign startup chatter from
    // bunx/npx-launched servers would otherwise pollute every CLI launch; the
    // tail is only surfaced when the server exits mid-request, the one case
    // stderr actually helps diagnose.
    proc.stderr.on('data', (data: { toString(): string }) => {
      const line = data.toString().trim();
      if (!line) return;
      this.stderrTail.push(line);
      if (this.stderrTail.length > STDERR_TAIL_MAX) this.stderrTail.shift();
    });

    proc.on('exit', (code: number) => {
      this.teardownProcess(proc, `MCP server exited with code ${code}`);
    });

    // 'error' covers spawn failures (ENOENT / EACCES) and stream faults.
    // Without a handler Node turns a missing command into an UNCAUGHT
    // exception that kills the whole CLI; worse, a failed spawn emits 'error'
    // WITHOUT 'exit', so the exit-handler cleanup never ran and the dead
    // process stayed cached in this.proc (killed=false) — every later send()
    // wrote into its broken stdin forever. Funnel both events through the
    // shared teardown so pending requests reject with the stderr tail and the
    // next send() respawns from scratch.
    proc.on('error', (err: Error) => {
      const code = (err as { code?: string }).code;
      const detail = code === 'ENOENT'
        ? `command not found: ${this.command[0] ?? ''} — fix the MCP server's command`
        : err.message;
      this.startError = `MCP server failed to start: ${detail}`;
      this.teardownProcess(proc, this.startError);
    });

    return proc;
  }

  /** Idempotent teardown shared by 'exit' and 'error' (a dying process can
   * emit both; a failed spawn emits only 'error'). */
  private teardownProcess(proc: ChildProcess, message: string): void {
    const tail = this.stderrTail.join('\n');
    const suffix = tail ? `\n[stderr]\n${tail}` : '';
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${message}${suffix}`));
    }
    this.pending.clear();
    this.stderrTail = [];
    this.rl?.close();
    this.rl = null;
    if (this.proc === proc) this.proc = null;
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
        if (!err) return;
        const pending = this.pending.get(request.id);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(request.id);
        // A broken stdin usually means the spawn itself failed; defer one tick
        // so the 'error' handler can latch the real reason ("command not
        // found: …") before this rejection settles the promise.
        setImmediate(() => {
          reject(new Error(this.startError ?? `write to MCP server failed: ${err.message}`));
        });
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
    this.stderrTail = [];
    this.rl?.close();
    this.rl = null;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
