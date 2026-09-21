import { describe, expect, it } from 'bun:test';
import {
  callbackFromRedirect,
  loginMcpServer,
  logoutMcpServer,
  mcpLoginState,
  type McpOAuthFlowDeps,
  type McpOAuthStage,
} from '../mcpOAuthFlow';
import type { OAuthHttp, OAuthHttpResult, OAuthTokenStore, StoredOAuth } from '../../adapter/mcp/oauth';

const SERVER = 'https://mcp.example.com/mcp';
const AUTH = 'https://auth.example.com';

/** In-memory store + recorded writes (the assertions look inside it). */
function memoryStore(): OAuthTokenStore & { saved: Map<string, StoredOAuth> } {
  const saved = new Map<string, StoredOAuth>();
  return {
    saved,
    async load(name) { return saved.get(name); },
    async save(name, state) { saved.set(name, state); },
    async clear(name) { saved.delete(name); },
  };
}

/** Metadata + token endpoints straight off the unit-test routes in
 * adapter/mcp/__tests__/oauth.test.ts — enough for beginLogin/completeLogin. */
function oauthHttp(): OAuthHttp {
  return async (url, init): Promise<OAuthHttpResult> => {
    if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource') {
      return { status: 200, headers: {}, text: JSON.stringify({ resource: SERVER, authorization_servers: [AUTH] }) };
    }
    if (url === `${AUTH}/.well-known/oauth-authorization-server`) {
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          issuer: AUTH,
          authorization_endpoint: `${AUTH}/authorize`,
          token_endpoint: `${AUTH}/token`,
          registration_endpoint: `${AUTH}/register`,
          code_challenge_methods_supported: ['S256'],
        }),
      };
    }
    if (url === `${AUTH}/register`) {
      return { status: 201, headers: {}, text: JSON.stringify({ client_id: 'cid-flow' }) };
    }
    if (url === `${AUTH}/token`) {
      const form = new URLSearchParams(init.body ?? '');
      if (form.get('grant_type') === 'authorization_code' && form.get('code') === 'abc') {
        return { status: 200, headers: {}, text: JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }) };
      }
      return { status: 400, headers: {}, text: JSON.stringify({ error: 'invalid_grant' }) };
    }
    return { status: 404, headers: {}, text: 'no route' };
  };
}

interface InvokeRecord { cmd: string; args?: Record<string, unknown> }

/** Fake Rust invoke for the loopback receiver + open_path. `deliver` plays the
 * provider: it resolves a pending wait, or parks the redirect until the wait
 * call arrives (whichever is first — open_path always precedes the wait). */
function fakeInvoke() {
  const calls: InvokeRecord[] = [];
  let parkedRedirect: string | undefined;
  let waiter: ((v: string) => void) | undefined;
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    if (cmd === 'mcp_oauth_loopback_start') return { flowId: 'flow-1', port: 49152 } as T;
    if (cmd === 'mcp_oauth_loopback_wait') {
      if (parkedRedirect !== undefined) {
        const redirect = parkedRedirect;
        parkedRedirect = undefined;
        return redirect as T;
      }
      return await new Promise<T>((resolve) => { waiter = resolve as (v: string) => void; });
    }
    if (cmd === 'mcp_oauth_token_read') return null as T;
    return undefined as T;
  };
  return {
    invoke,
    calls,
    deliver: (redirect: string) => {
      if (waiter) {
        const resolve = waiter;
        waiter = undefined;
        resolve(redirect);
      } else {
        parkedRedirect = redirect;
      }
    },
  };
}

const baseDeps = (invoke: McpOAuthFlowDeps['invoke'], store: OAuthTokenStore & { saved: Map<string, StoredOAuth> } = memoryStore()): McpOAuthFlowDeps => ({
  invoke,
  http: oauthHttp(),
  store,
});

describe('mcpOAuthFlow', () => {
  it('runs the full login: loopback → browser → wait → exchange → store', async () => {
    const remote = fakeInvoke();
    const store = memoryStore();
    const stages: McpOAuthStage[] = [];
    let succeeded = false;
    let openedPath = '';

    // Drive the fake browser: when open_path fires, extract the state from the
    // authorize URL and deliver the provider redirect to the loopback waiter.
    const invoke: McpOAuthFlowDeps['invoke'] = async <T,>(cmd: string, args?: Record<string, unknown>) => {
      const result = await remote.invoke<T>(cmd, args);
      if (cmd === 'open_path') {
        openedPath = String((args as { path: string }).path);
        const state = new URL(openedPath).searchParams.get('state');
        remote.deliver(`http://127.0.0.1:49152/callback?code=abc&state=${state}`);
      }
      return result;
    };

    const ok = await loginMcpServer(
      { name: 'linear', url: SERVER, auth: {} },
      { onStage: (s) => stages.push(s), onSuccess: () => { succeeded = true; } },
      baseDeps(invoke, store),
    );

    expect(ok).toBe(true);
    expect(succeeded).toBe(true);
    expect(stages).toEqual(['opening', 'waiting', 'exchanging']);
    expect(openedPath.startsWith(`${AUTH}/authorize`)).toBe(true);
    expect(remote.calls.map((c) => c.cmd)).toEqual([
      'mcp_oauth_loopback_start',
      'open_path',
      'mcp_oauth_loopback_wait',
    ]);
    expect(store.saved.get('linear')?.tokens.accessToken).toBe('at-1');
    // The dynamically-registered client is persisted with the tokens.
    expect(store.saved.get('linear')?.client?.clientId).toBe('cid-flow');
  });

  it('releases the loopback receiver and reports the error when discovery fails', async () => {
    const remote = fakeInvoke();
    const errors: string[] = [];
    const ok = await loginMcpServer(
      // Not in the fake http routes → discovery fails after the receiver bound.
      { name: 'linear', url: 'https://unreachable.example.com/x', auth: {} },
      { onError: (m) => errors.push(m) },
      baseDeps(remote.invoke),
    );
    expect(ok).toBe(false);
    expect(errors).toHaveLength(1);
    expect(remote.calls.some((c) => c.cmd === 'mcp_oauth_loopback_cancel')).toBe(true);
    expect(remote.calls.some((c) => c.cmd === 'open_path')).toBe(false);
  });

  it('reports provider-side denial (error param) through onError', async () => {
    const remote = fakeInvoke();
    const errors: string[] = [];
    const invoke: McpOAuthFlowDeps['invoke'] = async <T,>(cmd: string, args?: Record<string, unknown>) => {
      const result = await remote.invoke<T>(cmd, args);
      if (cmd === 'open_path') {
        remote.deliver('http://127.0.0.1:49152/callback?error=access_denied');
      }
      return result;
    };
    const ok = await loginMcpServer(
      { name: 'linear', url: SERVER, auth: {} },
      { onError: (m) => errors.push(m) },
      baseDeps(invoke),
    );
    expect(ok).toBe(false);
    expect(errors[0]).toContain('access_denied');
  });

  it('parses code/state/error out of a raw redirect URL', () => {
    expect(callbackFromRedirect('http://127.0.0.1:49152/callback?code=abc&state=st')).toEqual({
      code: 'abc', state: 'st', error: undefined,
    });
    expect(callbackFromRedirect('http://127.0.0.1:49152/callback?error=server_error').error).toBe('server_error');
  });

  it('logout clears the store; login state reflects stored tokens', async () => {
    const remote = fakeInvoke();
    const store = memoryStore();
    const invoke: McpOAuthFlowDeps['invoke'] = async <T,>(cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'mcp_oauth_token_read') {
        return (store.saved.has('linear') ? '{}' : null) as T; // mimic Rust
      }
      return remote.invoke<T>(cmd, args);
    };
    const deps = baseDeps(invoke, store);

    expect(await mcpLoginState({ name: 'linear' }, deps)).toBe('logged_out');
    await store.save('linear', { tokens: { accessToken: 'at' } });
    expect(await mcpLoginState({ name: 'linear' }, deps)).toBe('logged_in');
    await logoutMcpServer({ name: 'linear', url: SERVER, auth: {} }, deps);
    expect(await mcpLoginState({ name: 'linear' }, deps)).toBe('logged_out');
  });

  it('reports unsupported when the store cannot be reached (CLI)', async () => {
    const deps = baseDeps(async <T,>() => { throw new Error('no tauri'); });
    expect(await mcpLoginState({ name: 'linear' }, deps)).toBe('unsupported');
  });
});
