// src/ui/mcpOAuthFlow.ts
// 6.4 — user-triggered OAuth login for HTTP MCP servers.
//
// The flow: bind a 127.0.0.1 loopback receiver (Rust) → resolve metadata and
// build the authorize URL (oauth.ts core) → open the browser via open_path →
// wait for the provider's single redirect on the loopback port → exchange the
// code → tokens land in ~/.pure/mcp/oauth/<server>.json (0600).
//
// INVARIANT: login is user-triggered only (Settings → MCP). Nothing here ever
// runs mid-task or opens a browser on its own — a delegation must never pop a
// window over the user's head.

import { loadTauriCore } from '../shared/tauri';
import { McpOAuthSession, type OAuthHttp, type OAuthServerOptions, type OAuthTokenStore } from '../adapter/mcp/oauth';
import { oauthBindings } from '../adapter/mcp/oauthBindings';

export type McpOAuthStage = 'opening' | 'waiting' | 'exchanging';

export interface McpOAuthFlowCallbacks {
  onStage?(stage: McpOAuthStage): void;
  onSuccess?(): void;
  onError?(message: string): void;
}

/** The server slice the flow needs (a PureConfig mcpServers entry qualifies). */
export interface McpOAuthFlowServer {
  name: string;
  url?: string;
  auth?: { scopes?: string[]; clientId?: string; clientSecret?: string };
}

/** Seam for tests: every effect that leaves the process goes through here. */
export interface McpOAuthFlowDeps {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  http: OAuthHttp;
  store: OAuthTokenStore;
}

/** Desktop bindings: Rust invoke + the relayed HTTP/token-store pair. */
export function defaultFlowDeps(): McpOAuthFlowDeps {
  const { http, store } = oauthBindings();
  return {
    invoke: async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      const core = await loadTauriCore();
      if (!core) throw new Error('OAuth 登录需要在桌面应用中进行');
      return core.invoke<T>(cmd, args);
    },
    http,
    store,
  };
}

/** Pull the OAuth callback fields out of the full redirect URL the loopback
 *  receiver captured (`http://127.0.0.1:PORT/callback?code=…&state=…`). */
export function callbackFromRedirect(raw: string): { code?: string; state?: string; error?: string } {
  const url = new URL(raw);
  return {
    code: url.searchParams.get('code') ?? undefined,
    state: url.searchParams.get('state') ?? undefined,
    error: url.searchParams.get('error') ?? undefined,
  };
}

/**
 * Run one login. Resolves `true` on success; every failure path reports
 * through `onError` and returns `false` — the loopback receiver is always
 * released, on cancel, timeout, and error alike.
 */
export async function loginMcpServer(
  server: McpOAuthFlowServer,
  callbacks: McpOAuthFlowCallbacks = {},
  deps: McpOAuthFlowDeps = defaultFlowDeps(),
): Promise<boolean> {
  if (!server.url) {
    callbacks.onError?.('这个服务器没有配置 URL，无法登录');
    return false;
  }
  const options: OAuthServerOptions = {
    serverName: server.name,
    serverUrl: server.url,
    scopes: server.auth?.scopes,
    clientId: server.auth?.clientId,
    clientSecret: server.auth?.clientSecret,
  };
  const session = new McpOAuthSession(options, deps.http, deps.store);
  let flowStarted = false;
  let flowId = '';
  try {
    // The receiver exists before the authorize URL: beginLogin needs the
    // redirect URI the provider will actually be redirected to.
    const started = await deps.invoke<{ flowId: string; port: number }>('mcp_oauth_loopback_start', {});
    flowStarted = true;
    flowId = started.flowId;
    const pending = await session.beginLogin(`http://127.0.0.1:${started.port}/callback`);
    callbacks.onStage?.('opening');
    await deps.invoke('open_path', { path: pending.authorizeUrl });
    callbacks.onStage?.('waiting');
    const redirect = await deps.invoke<string>('mcp_oauth_loopback_wait', {
      flowId: started.flowId,
      timeoutSecs: 300,
    });
    callbacks.onStage?.('exchanging');
    await session.completeLogin(callbackFromRedirect(redirect));
    callbacks.onSuccess?.();
    return true;
  } catch (err) {
    if (flowStarted) {
      // One-shot receiver — release the port and the accept task whatever
      // happened (cancel is a no-op once wait consumed the flow).
      await deps.invoke('mcp_oauth_loopback_cancel', { flowId }).catch(() => { /* best effort */ });
    }
    const message = err instanceof Error ? err.message : String(err);
    callbacks.onError?.(message);
    return false;
  }
}

/** Drop the stored tokens for one server. Idempotent. */
export async function logoutMcpServer(
  server: McpOAuthFlowServer,
  deps: McpOAuthFlowDeps = defaultFlowDeps(),
): Promise<void> {
  if (!server.url) return;
  const session = new McpOAuthSession(
    {
      serverName: server.name,
      serverUrl: server.url,
      scopes: server.auth?.scopes,
      clientId: server.auth?.clientId,
      clientSecret: server.auth?.clientSecret,
    },
    deps.http,
    deps.store,
  );
  await session.logout();
}

export type McpLoginState = 'logged_in' | 'logged_out' | 'unsupported';

/** Whether tokens exist for one server. 'unsupported' outside the desktop
 *  runtime (the CLI login flow is a later step) or when the store errors. */
export async function mcpLoginState(
  server: Pick<McpOAuthFlowServer, 'name'>,
  deps: McpOAuthFlowDeps = defaultFlowDeps(),
): Promise<McpLoginState> {
  try {
    const raw = await deps.invoke<string | null>('mcp_oauth_token_read', { server: server.name });
    return raw ? 'logged_in' : 'logged_out';
  } catch {
    return 'unsupported';
  }
}
