// src/adapter/mcp/oauthBindings.ts
// 6.4 — runtime bindings for the OAuth core: where its HTTP calls go and
// where tokens live. The desktop WebView relays through Rust (proxy support,
// envelope'd headers, the 0600 token store under ~/.pure/mcp/oauth); the CLI
// falls back to plain fetch with an in-memory store (per-run refresh works;
// cross-run token persistence lands with CLI login).

import { isTauriRuntime, loadTauriCore } from '../../shared/tauri';
import type { OAuthHttp, OAuthHttpResult, OAuthTokenStore } from './oauth';

/** fetch-backed OAuthHttp (CLI / tests). */
export function fetchOAuthHttp(): OAuthHttp {
  return async (url, init) => {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(30_000),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: res.status, headers, text: await res.text() };
  };
}

/** Rust-relayed OAuthHttp (desktop WebView) — same command the MCP transport
 * uses, in envelope mode so 401s and their WWW-Authenticate survive the trip. */
export function tauriOAuthHttp(): OAuthHttp {
  return async (url, init) => {
    const core = await loadTauriCore();
    if (!core) throw new Error('OAuth HTTP 需要 Tauri 运行时');
    const raw = await core.invoke<string>('mcp_http_request', {
      url,
      method: init.method,
      body: init.body,
      headers: init.headers,
      timeoutSecs: 30,
      returnHeaders: true,
    });
    const envelope = JSON.parse(String(raw ?? '{}')) as {
      __status?: number;
      __headers?: Record<string, string>;
      body?: string;
    };
    const result: OAuthHttpResult = {
      status: envelope.__status ?? 200,
      headers: envelope.__headers ?? {},
      text: envelope.body ?? '',
    };
    return result;
  };
}

/** In-memory store: tokens live for the process run only (CLI for now). */
export function memoryTokenStore(): OAuthTokenStore {
  const tokens = new Map<string, string>();
  return {
    async load(server) {
      const raw = tokens.get(server);
      return raw ? (JSON.parse(raw) as Awaited<ReturnType<OAuthTokenStore['load']>>) : undefined;
    },
    async save(server, state) {
      tokens.set(server, JSON.stringify(state));
    },
    async clear(server) {
      tokens.delete(server);
    },
  };
}

/** Rust-backed store: ~/.pure/mcp/oauth/<server>.json, 0600 — tokens stay out
 * of WebView storage, same contract as secrets.json. */
export function tauriTokenStore(): OAuthTokenStore {
  return {
    async load(server) {
      const core = await loadTauriCore();
      if (!core) return undefined;
      const raw = await core.invoke<string | null>('mcp_oauth_token_read', { server });
      return raw ? (JSON.parse(raw) as Awaited<ReturnType<OAuthTokenStore['load']>>) : undefined;
    },
    async save(server, state) {
      const core = await loadTauriCore();
      if (!core) throw new Error('OAuth token store 需要 Tauri 运行时');
      await core.invoke('mcp_oauth_token_write', { server, payload: JSON.stringify(state) });
    },
    async clear(server) {
      const core = await loadTauriCore();
      if (!core) return;
      await core.invoke('mcp_oauth_token_delete', { server });
    },
  };
}

/** The binding pair for this runtime. */
export function oauthBindings(): { http: OAuthHttp; store: OAuthTokenStore } {
  return isTauriRuntime()
    ? { http: tauriOAuthHttp(), store: tauriTokenStore() }
    : { http: fetchOAuthHttp(), store: memoryTokenStore() };
}
