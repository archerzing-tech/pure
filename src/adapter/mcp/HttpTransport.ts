// src/adapter/mcp/HttpTransport.ts
// v0.1 — MCP HTTP transport using SSE for server→client and POST for client→server.

import type { MCPTransport } from './MCPTransport';
import { makeRequest } from './MCPTransport';

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class HttpTransport implements MCPTransport {
  private pending = new Map<number, PendingRequest>();
  private eventSource: EventSource | null = null;
  private baseUrl: string;
  private closed = false;

  constructor(url: string) {
    this.baseUrl = url.replace(/\/$/, '');
  }

  private ensureConnected(): void {
    if (this.closed) throw new Error('Transport closed');
    if (this.eventSource && this.eventSource.readyState !== EventSource.CLOSED) return;
    this.eventSource = new EventSource(`${this.baseUrl}/sse`);

    this.eventSource.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) {
            p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    this.eventSource.onerror = () => {
      // SSE reconnect is automatic; reject outstanding requests
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('MCP SSE connection error'));
      }
      this.pending.clear();
    };
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('Transport closed');

    this.ensureConnected();
    const request = makeRequest(method, params);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(request.id)) return;
        reject(new Error(`MCP request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(request.id, { resolve, reject, timer });

      fetch(`${this.baseUrl}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).then(async (res) => {
        if (!res.ok) {
          const pending = this.pending.get(request.id);
          if (pending) clearTimeout(pending.timer);
          this.pending.delete(request.id);
          reject(new Error(`MCP HTTP ${res.status}`));
          return;
        }
        // Some servers return the response directly; others stream via SSE
        const body = await res.text();
        if (body && this.pending.has(request.id)) {
          try {
            const msg = JSON.parse(body);
            const pending = this.pending.get(request.id);
            if (pending) clearTimeout(pending.timer);
            this.pending.delete(request.id);
            if (msg.error) {
              reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
            } else {
              resolve(msg.result);
            }
          } catch {
            // Will be resolved by SSE eventSource.onmessage
          }
        }
      }).catch((err) => {
        const pending = this.pending.get(request.id);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(request.id);
        reject(err);
      });
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new Error('Transport closed');
    this.ensureConnected();
    const notification = { jsonrpc: '2.0' as const, method, params };
    await fetch(`${this.baseUrl}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  close(): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Transport closed'));
    }
    this.pending.clear();
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}
