// src/adapter/mcp/HttpTransport.ts
// v0.2 — MCP Streamable HTTP transport (spec 2026-07-28): a single endpoint
// receives every JSON-RPC message via POST with `Accept: application/json,
// text/event-stream`. Servers answer either with plain JSON or with an SSE
// stream on the same POST; session continuity uses the `Mcp-Session-Id`
// response header returned by `initialize`, and later requests carry
// `MCP-Protocol-Version`. Servers that only implement the retired HTTP+SSE
// transport (GET /sse + POST /message, ≤2025-03-26) are detected when the
// streamable POST fails with 404/405 and the connection switches to legacy
// mode for its lifetime.
//
// In the desktop WebView requests are relayed through the Rust
// `mcp_http_request` command (proxy support + response headers); in the CLI /
// plain browser it uses fetch with a lightweight SSE line reader.

import type { MCPTransport } from './MCPTransport';
import { makeRequest, MCPAuthRequiredError, type JSONRPCMessage } from './MCPTransport';
import { isTauriRuntime, loadTauriCore } from '../../shared/tauri';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// Newest protocol this client speaks — offered during initialize.
export const MCP_HTTP_PROTOCOL_VERSION = '2026-07-28';
// Older versions a server may negotiate instead; echoed back verbatim.
const SUPPORTED_PROTOCOL_VERSIONS = [MCP_HTTP_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05'];

/** OAuth face of the transport (6.4): the session supplies Bearer tokens and
 * hears about 401s so the UI can offer the login button. */
export interface HttpTransportAuth {
  /** Token for the Authorization header — undefined when the user has not
   *  logged in yet (request goes out unauthenticated; the server's 401 then
   *  marks the server as needing a login). */
  getAccessToken(): Promise<string | undefined>;
  /** A request came back 401 — this login is missing or has gone stale. */
  onAuthRequired?(challenge?: string): void;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RpcResponseLike {
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export class HttpTransport implements MCPTransport {
  private pending = new Map<number, PendingRequest>();
  private baseUrl: string;
  private closed = false;
  private proxyUrl: string;
  private requestTimeoutMs: number;
  /** Streamable HTTP is the default; flipped on when the server answers
   * 404/405 on the endpoint (a legacy HTTP+SSE-only server). Sticky for the
   * connection lifetime. */
  private legacyMode = false;
  /** Legacy push channel (fetch path only); created on demand in legacy mode. */
  private legacyEventSource: EventSource | null = null;
  /** Streamable POST bodies still being read line-by-line (SSE). Held so
   *  close() can release them instead of leaving the reader to the fetch
   *  timeout. */
  private sseReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  /** `Mcp-Session-Id` assigned by the server during initialize (streamable). */
  private sessionId: string | undefined;
  /** Protocol version agreed during initialize (echoed on later requests). */
  private negotiatedVersion: string | undefined;
  /** OAuth session face — Bearer tokens in, 401 notifications out. */
  private auth?: HttpTransportAuth;

  constructor(
    url: string,
    proxyUrl = '',
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    auth?: HttpTransportAuth,
  ) {
    this.baseUrl = url.replace(/\/$/, '');
    this.proxyUrl = proxyUrl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.auth = auth;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('Transport closed');
    const request = makeRequest(method, params);

    if (this.proxyUrl && isTauriRuntime()) {
      return this.sendViaRust(request);
    }
    return this.sendViaFetch(request);
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new Error('Transport closed');
    const notification: JSONRPCMessage = { jsonrpc: '2.0' as const, method, params };
    if (this.proxyUrl && isTauriRuntime()) {
      await this.postViaRust(notification);
      return;
    }
    if (this.legacyMode) {
      this.ensureLegacySse();
      await postLegacy(this.baseUrl, notification, this.requestTimeoutMs, await this.authHeaders());
      return;
    }
    const res = await fetchStreamable(this.baseUrl, notification, { ...this.buildHeaders(), ...(await this.authHeaders()) }, this.requestTimeoutMs);
    if (res.status === 401) this.authRequired(res.headers.get('WWW-Authenticate') ?? undefined);
    if (res.status === 404 || res.status === 405) {
      this.legacyMode = true;
      this.ensureLegacySse();
      await postLegacy(this.baseUrl, notification, this.requestTimeoutMs, await this.authHeaders());
      return;
    }
    // 202 Accepted (notification ack) or an SSE stream that carries no
    // response for a notification — nothing to settle either way. Drain the
    // body without hanging on a held-open stream.
    await res.text().catch(() => '');
  }

  close(): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Transport closed'));
    }
    this.pending.clear();
    for (const reader of this.sseReaders) {
      // Released on close(): an in-flight SSE body would otherwise stay held
      // until the fetch's own timeout fires.
      void reader.cancel().catch(() => { /* already closed */ });
    }
    this.sseReaders.clear();
    if (this.legacyEventSource) {
      this.legacyEventSource.close();
      this.legacyEventSource = null;
    }
  }

  // ── Shared header construction ──

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.negotiatedVersion ?? MCP_HTTP_PROTOCOL_VERSION,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  /** Authorization header for the current token, when one is available. A
   *  token-read failure never breaks the request — it just goes out without
   *  auth and the server's 401 tells the truth. */
  private async authHeaders(): Promise<Record<string, string>> {
    const token = this.auth
      ? await this.auth.getAccessToken().catch(() => undefined)
      : undefined;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** Flag the auth face (drives the Settings card / login button) and throw
   *  the typed error every 401 surfaces as. */
  private authRequired(challenge?: string): never {
    this.auth?.onAuthRequired?.(challenge);
    throw new MCPAuthRequiredError(challenge);
  }

  /** Track session id + negotiated version. */
  private absorbMeta(status: number, sessionId: string | undefined, result?: unknown): void {
    if (sessionId) this.sessionId = sessionId;
    if (result && typeof result === 'object' && 'protocolVersion' in (result as Record<string, unknown>)) {
      const version = (result as { protocolVersion?: string }).protocolVersion;
      if (typeof version === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
        this.negotiatedVersion = version;
      }
    }
    if (status === 404 || status === 405) this.legacyMode = true;
  }

  // ── fetch path (CLI / plain browser) ──

  private async sendViaFetch(request: { id: number; method: string; params?: Record<string, unknown> }): Promise<unknown> {
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(request.id)) return;
        reject(new Error(`MCP request timed out after ${this.requestTimeoutMs}ms: ${request.method}`));
      }, this.requestTimeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
    });
    // The pending timer can fire while no handler is attached to `promise` yet
    // (an SSE read loop is awaiting the stream, not this promise). Rejecting in
    // that window would surface as an unhandled rejection, so mark it handled
    // immediately; the real handler below still observes the outcome.
    promise.catch(() => {});

    try {
      if (this.legacyMode) {
        this.ensureLegacySse();
        const res = await postLegacy(this.baseUrl, request, this.requestTimeoutMs, await this.authHeaders());
        this.resolveFromBody(request.id, await res.text(), res.status, res.headers.get('WWW-Authenticate') ?? undefined);
        return await promise;
      }

      const res = await fetchStreamable(this.baseUrl, request, { ...this.buildHeaders(), ...(await this.authHeaders()) }, this.requestTimeoutMs);
      if (res.status === 401) this.authRequired(res.headers.get('WWW-Authenticate') ?? undefined);
      if (res.status === 404 || res.status === 405) {
        // Legacy-only server: switch modes and retry over /message.
        this.legacyMode = true;
        this.ensureLegacySse();
        const legacyRes = await postLegacy(this.baseUrl, request, this.requestTimeoutMs, await this.authHeaders());
        this.resolveFromBody(request.id, await legacyRes.text(), legacyRes.status, legacyRes.headers.get('WWW-Authenticate') ?? undefined);
        return await promise;
      }
      this.absorbMeta(res.status, res.headers.get('Mcp-Session-Id') ?? undefined);
      const contentType = res.headers.get('Content-Type') ?? '';
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (contentType.includes('text/event-stream') && res.body) {
        // Spec: the server may keep the POST open and stream the response as
        // SSE events. Read lines until this request's answer arrives; the
        // pending timeout covers the case where it never does.
        await this.readSseResponse(res, request.id);
        return await promise;
      }
      const text = await res.text();
      if (res.status === 202) return await promise; // notification-style ack
      this.resolveFromBody(request.id, text, res.status);
    } catch (err) {
      const pending = this.pending.get(request.id);
      if (pending) {
        this.pending.delete(request.id);
        clearTimeout(pending.timer);
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      }
      // No pending entry → the request already settled (SSE reply, timeout, or
      // close()); a trailing stream error must not double-reject.
    }
    return promise;
  }

  /** Read the SSE stream attached to a streamable POST until the response for
   * `requestId` arrives, then cancel the stream. */
  private async readSseResponse(res: Response, requestId: number): Promise<void> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    this.sseReaders.add(reader);
    const finish = async () => {
      try { await reader.cancel(); } catch { /* already closed */ }
      this.sseReaders.delete(reader);
    };
    try {
      while (true) {
        // The pending timer settles this request on timeout while the server may
        // keep the POST open. Nothing downstream consumes the rest of the
        // stream, so stop here instead of holding the reader until the fetch's
        // own timeout fires.
        if (!this.pending.has(requestId)) { await finish(); return; }
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineAt = buffer.indexOf('\n');
        while (newlineAt >= 0) {
          const line = buffer.slice(0, newlineAt).replace(/\r$/, '');
          buffer = buffer.slice(newlineAt + 1);
          if (line.startsWith('data:')) {
            const settled = this.handleSseData(line.slice(5).trim(), requestId);
            if (settled) { await finish(); return; }
          }
          newlineAt = buffer.indexOf('\n');
        }
      }
    } finally {
      this.sseReaders.delete(reader);
    }
  }

  /** Parse one SSE `data:` payload; settles the pending request when it is a
   * JSON-RPC response (for `requestId` or any id when `requestId` is null).
   * Returns true when the pending request was settled. */
  private handleSseData(payload: string, requestId: number | null): boolean {
    if (!payload) return false;
    let msg: RpcResponseLike;
    try {
      msg = JSON.parse(payload) as RpcResponseLike;
    } catch {
      return false;
    }
    if (!msg || typeof msg !== 'object' || !('result' in msg || 'error' in msg)) return false;
    const id = typeof msg.id === 'number' ? msg.id : undefined;
    if (requestId !== null && id !== requestId) return false;
    const pending = requestId !== null && id !== undefined ? this.pending.get(id) : undefined;
    const settledId = id;
    if (!pending || settledId === undefined) return false;
    this.pending.delete(settledId);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
    else pending.resolve(msg.result);
    return true;
  }

  private resolveFromBody(requestId: number, text: string, status: number, wwwAuthenticate?: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (status === 401) {
      // Legacy /message replies have no dedicated 401 branch — surface the
      // same typed error here so every path reports auth the same way.
      this.auth?.onAuthRequired?.(wwwAuthenticate);
      pending.reject(new MCPAuthRequiredError(wwwAuthenticate));
      return;
    }
    const parsed = parseRpcPayload(text);
    if (!parsed) {
      pending.reject(new Error(`MCP HTTP ${status}: no JSON-RPC response in body (${text.slice(0, 120)})`));
      return;
    }
    if (parsed.error) pending.reject(new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`));
    else pending.resolve(parsed.result);
  }

  /** Legacy push channel: GET /sse delivers responses to /message POSTs.
   * Skipped where EventSource is unavailable (bun tests, some CLIs) — inline
   * /message responses still work without it. */
  private ensureLegacySse(): void {
    if (typeof EventSource === 'undefined') return;
    if (this.legacyEventSource && this.legacyEventSource.readyState !== EventSource.CLOSED) return;
    this.legacyEventSource = new EventSource(`${this.baseUrl}/sse`);
    this.legacyEventSource.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data) as RpcResponseLike;
        const id = typeof msg.id === 'number' ? msg.id : null;
        if (id === null) return;
        this.handleSseData(event.data, id);
      } catch { /* ignore malformed events */ }
    };
    this.legacyEventSource.onerror = () => {
      // SSE reconnect is automatic; fail outstanding requests so callers see
      // the outage instead of waiting for their timeout.
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('MCP SSE connection error'));
      }
      this.pending.clear();
    };
  }

  // ── Rust relay path (desktop WebView) ──

  private async sendViaRust(request: { id: number; method: string; params?: Record<string, unknown> }): Promise<unknown> {
    const res = await this.postViaRust(request);
    const parsed = parseRpcPayload(res.text);
    if (!parsed) {
      throw new Error(`MCP server returned no JSON-RPC response (HTTP ${res.status}: ${res.text.slice(0, 120)})`);
    }
    if (parsed.error) throw new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`);
    return parsed.result;
  }

  private async postViaRust(message: JsonRpcBody): Promise<{ status: number; text: string }> {
    const core = await loadTauriCore();
    if (!core) throw new Error('MCP proxy requires the Tauri runtime');
    const url = this.legacyMode ? `${this.baseUrl}/message` : this.baseUrl;
    // Rust sets Content-Type itself (content_type param) — don't duplicate it.
    const { 'Content-Type': _ct, ...headers } = { ...this.buildHeaders(), ...(await this.authHeaders()) };
    const body = await core.invoke<string>('mcp_http_request', {
      url,
      method: 'POST',
      body: JSON.stringify(message),
      proxyUrl: this.proxyUrl,
      headers,
      timeoutSecs: Math.max(1, Math.ceil(this.requestTimeoutMs / 1000)),
      returnHeaders: true,
    });
    // Envelope mode carries every response — including non-2xx — so status
    // drives all the branching here (the old Err-string regex is gone along
    // with Rust's non-2xx-throws behavior in envelope mode).
    const { text, sessionId, status, wwwAuthenticate } = parseRustRelayBody(String(body ?? ''));
    if (status === 401) this.authRequired(wwwAuthenticate);
    if ((status === 404 || status === 405) && !this.legacyMode) {
      this.legacyMode = true;
      return this.postViaRust(message);
    }
    const parsed = parseRpcPayload(text);
    this.absorbMeta(status, sessionId, parsed?.result);
    return { status, text };
  }
}

// ── Module helpers ──

/** Any JSON-RPC message body (request or notification). */
type JsonRpcBody = JSONRPCMessage | { id: number; method: string; params?: Record<string, unknown> };

/** POST a JSON-RPC message to the streamable endpoint; returns the raw
 * Response so callers can branch on status / Content-Type / body stream. */
async function fetchStreamable(baseUrl: string, message: JsonRpcBody, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
  return fetch(baseUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function postLegacy(baseUrl: string, message: JsonRpcBody, timeoutMs: number, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** The Rust relay with `returnHeaders` wraps the body in a JSON envelope
 * carrying selected response headers (Mcp-Session-Id, WWW-Authenticate for the
 * OAuth login) and the HTTP status — including non-2xx responses. */
function parseRustRelayBody(raw: string): { text: string; sessionId?: string; status: number; wwwAuthenticate?: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.includes('"__headers"')) {
    try {
      const envelope = JSON.parse(trimmed) as { __headers?: Record<string, string>; body?: string; __status?: number };
      if (envelope.__headers && typeof envelope.body === 'string') {
        return {
          text: envelope.body,
          sessionId: envelope.__headers['mcp-session-id'],
          status: envelope.__status ?? 200,
          wwwAuthenticate: envelope.__headers['www-authenticate'],
        };
      }
    } catch { /* fall through: treat as plain body */ }
  }
  return { text: raw, status: 200 };
}

/** Parse a JSON-RPC response from either a raw JSON body or an SSE body
 * (`data:` lines). Returns undefined when the body carries no response. */
function parseRpcPayload(text: string): RpcResponseLike | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('data:') || trimmed.includes('\ndata:') || trimmed.includes('\r\ndata:')) {
    const lines = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    for (const line of lines) {
      try {
        const msg = JSON.parse(line.slice(5).trim()) as RpcResponseLike;
        if (msg && ('result' in msg || 'error' in msg)) return msg;
      } catch { /* next line */ }
    }
    return undefined;
  }
  try {
    const msg = JSON.parse(trimmed) as RpcResponseLike;
    if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return msg;
    return undefined;
  } catch {
    return undefined;
  }
}
