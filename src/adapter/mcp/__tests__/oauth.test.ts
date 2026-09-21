import { describe, expect, it } from 'bun:test';
import {
  McpOAuthSession,
  buildAuthorizeUrl,
  discoverAuthorizationServer,
  exchangeCode,
  makePkcePair,
  makeState,
  parseBearerChallenge,
  tokensUsable,
  wellKnownUrls,
  type OAuthHttp,
  type OAuthHttpResult,
  type OAuthTokenStore,
  type OAuthTokens,
  type StoredOAuth,
} from '../oauth';

const SERVER = 'https://mcp.example.com/mcp';
const AUTH_ISSUER = 'https://auth.example.com';

/** Fake OAuthHttp: routes by exact URL, records every request for asserts. */
function fakeHttp(routes: Record<string, (req: { method: string; body?: string }) => OAuthHttpResult | Promise<OAuthHttpResult>>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const http: OAuthHttp = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const handler = routes[url];
    if (!handler) return { status: 404, headers: {}, text: 'no route' };
    return handler({ method: init.method, body: init.body });
  };
  return { http, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): OAuthHttpResult {
  return { status, headers, text: JSON.stringify(body) };
}

function memoryStore(): OAuthTokenStore & { saved: Map<string, StoredOAuth> } {
  const saved = new Map<string, StoredOAuth>();
  return {
    saved,
    async load(name) { return saved.get(name); },
    async save(name, state) { saved.set(name, state); },
    async clear(name) { saved.delete(name); },
  };
}

const authServerRoutes = (opts: { dcr: boolean } = { dcr: true }) => ({
  [`${AUTH_ISSUER}/.well-known/oauth-authorization-server`]: () => json(200, {
    issuer: AUTH_ISSUER,
    authorization_endpoint: `${AUTH_ISSUER}/authorize`,
    token_endpoint: `${AUTH_ISSUER}/token`,
    ...(opts.dcr ? { registration_endpoint: `${AUTH_ISSUER}/register` } : {}),
    scopes_supported: ['mcp:read', 'mcp:write'],
    code_challenge_methods_supported: ['S256'],
  }),
});

describe('oauth helpers', () => {
  it('parses Bearer challenges with quoted and bare params', () => {
    expect(parseBearerChallenge('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="mcp:read"')).toEqual({
      resourceMetadata: 'https://mcp.example.com/.well-known/oauth-protected-resource',
      scope: 'mcp:read',
    });
    expect(parseBearerChallenge('Bearer realm="x"')).toEqual({ resourceMetadata: undefined, scope: undefined });
    expect(parseBearerChallenge('Basic realm="x"')).toEqual({});
    expect(parseBearerChallenge(undefined)).toEqual({});
  });

  it('inserts the well-known path component for issuers with a path (RFC 8414)', () => {
    expect(wellKnownUrls('https://auth.example.com/tenant1', 'oauth-authorization-server')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/oauth-authorization-server',
    ]);
    expect(wellKnownUrls('https://auth.example.com', 'oauth-protected-resource')).toEqual([
      'https://auth.example.com/.well-known/oauth-protected-resource',
    ]);
  });

  it('generates a PKCE pair whose challenge is the base64url SHA-256 of the verifier', async () => {
    const { verifier, challenge, method } = await makePkcePair();
    expect(method).toBe('S256');
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    let bin = '';
    for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
    expect(challenge).toBe(btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  });

  it('builds an authorize URL with every required parameter', () => {
    const url = new URL(buildAuthorizeUrl({
      metadata: {
        issuer: AUTH_ISSUER,
        authorizationEndpoint: `${AUTH_ISSUER}/authorize`,
        tokenEndpoint: `${AUTH_ISSUER}/token`,
      },
      client: { clientId: 'cid' },
      redirectUri: 'http://127.0.0.1:49152/callback',
      scopes: ['mcp:read'],
      state: 'st-1',
      pkce: { verifier: 'v', challenge: 'c', method: 'S256' },
      resource: SERVER,
    }));
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:49152/callback');
    expect(url.searchParams.get('scope')).toBe('mcp:read');
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('code_challenge')).toBe('c');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(SERVER);
  });

  it('treats tokens as unusable inside the refresh skew window', () => {
    expect(tokensUsable(undefined)).toBe(false);
    expect(tokensUsable({ accessToken: 'a' })).toBe(true);
    expect(tokensUsable({ accessToken: 'a', expiresAt: Date.now() + 10_000 })).toBe(false);
    expect(tokensUsable({ accessToken: 'a', expiresAt: Date.now() + 120_000 })).toBe(true);
  });
});

describe('discoverAuthorizationServer', () => {
  it('follows the 401 challenge → protected resource → authorization server chain', async () => {
    const { http, calls } = fakeHttp({
      'https://meta.example.com/.well-known/oauth-protected-resource': () => json(200, {
        resource: SERVER,
        authorization_servers: [AUTH_ISSUER],
      }),
      ...authServerRoutes(),
    });
    const found = await discoverAuthorizationServer(http, SERVER, {
      resourceMetadata: 'https://meta.example.com/.well-known/oauth-protected-resource',
    });
    expect(found.metadata.tokenEndpoint).toBe(`${AUTH_ISSUER}/token`);
    expect(found.resource?.resource).toBe(SERVER);
    expect(calls[0].url).toBe('https://meta.example.com/.well-known/oauth-protected-resource');
  });

  it('probes the MCP origin well-knowns directly when the challenge carries no hint', async () => {
    const { http } = fakeHttp({
      [`${new URL(SERVER).origin}/.well-known/oauth-protected-resource`]: () => ({ status: 404, headers: {}, text: 'nope' }),
      ...authServerRoutes(),
    });
    // auth.example.com !== mcp origin → discovery falls back to the origin
    // issuer itself, whose routes we did NOT register — expect the miss error.
    await expect(discoverAuthorizationServer(http, SERVER)).rejects.toThrow(/找不到授权服务器元数据/);
  });
});

describe('McpOAuthSession login flow', () => {
  const tokenBody = { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' };

  function flowRoutes(store: { dcrClientId?: string } = {}) {
    return {
      // The MCP origin's protected-resource metadata names the auth server —
      // the same chain real servers (e.g. Linear) publish.
      'https://mcp.example.com/.well-known/oauth-protected-resource': () => json(200, {
        resource: SERVER,
        authorization_servers: [AUTH_ISSUER],
        scopes_supported: ['mcp:read'],
      }),
      ...authServerRoutes({ dcr: !store.dcrClientId }),
      ...(store.dcrClientId ? {} : {
        [`${AUTH_ISSUER}/register`]: ({ body }: { body?: string }) => {
          const req = JSON.parse(body ?? '{}') as Record<string, unknown>;
          expect(req.token_endpoint_auth_method).toBe('none');
          expect(req.grant_types).toContain('authorization_code');
          return json(201, { client_id: 'cid-dcr', client_name: req.client_name });
        },
      }),
      [`${AUTH_ISSUER}/token`]: ({ body }: { body?: string }) => {
        const form = new URLSearchParams(body ?? '');
        if (form.get('grant_type') === 'authorization_code') {
          if (form.get('code') !== 'abc') return json(400, { error: 'invalid_grant', error_description: 'bad code' });
          expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
          return json(200, tokenBody);
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (form.get('refresh_token') !== 'rt-1') return json(400, { error: 'invalid_grant' });
          return json(200, { ...tokenBody, access_token: 'at-2', refresh_token: 'rt-2' });
        }
        return json(400, { error: 'unsupported_grant_type' });
      },
    };
  }

  it('registers, authorizes, exchanges and persists tokens end to end', async () => {
    const { http, calls } = fakeHttp(flowRoutes());
    const store = memoryStore();
    const session = new McpOAuthSession({ serverName: 'linear', serverUrl: SERVER }, http, store);

    const pending = await session.beginLogin('http://127.0.0.1:49152/callback');
    expect(pending.authorizeUrl.startsWith(`${AUTH_ISSUER}/authorize`)).toBe(true);
    // Dynamic registration ran exactly once and produced the client_id.
    expect(calls.filter((c) => c.url.endsWith('/register'))).toHaveLength(1);

    // State mismatch aborts the flow before the code is spent.
    await expect(session.completeLogin({ code: 'abc', state: 'wrong' })).rejects.toThrow(/state 不匹配/);

    const tokens = await session.completeLogin({ code: 'abc', state: pending.state });
    expect(tokens.accessToken).toBe('at-1');
    expect(tokens.refreshToken).toBe('rt-1');
    expect(store.saved.get('linear')?.tokens.accessToken).toBe('at-1');
    // The client identity is persisted too — refresh needs it after a restart.
    expect(store.saved.get('linear')?.client?.clientId).toBe('cid-dcr');
    // A usable token is served without any network round-trip.
    expect(await session.getAccessToken()).toBe('at-1');
  });

  it('accepts a configured static client_id without dynamic registration', async () => {
    const { http, calls } = fakeHttp(flowRoutes({ dcrClientId: 'cid-static' }));
    const session = new McpOAuthSession(
      { serverName: 'linear', serverUrl: SERVER, clientId: 'cid-static' },
      http,
      memoryStore(),
    );
    const pending = await session.beginLogin('http://127.0.0.1:49152/callback');
    const url = new URL(pending.authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe('cid-static');
    expect(calls.filter((c) => c.url.endsWith('/register'))).toHaveLength(0);
  });

  it('surfaces the server token error on a bad code', async () => {
    const { http } = fakeHttp(flowRoutes());
    const session = new McpOAuthSession({ serverName: 'linear', serverUrl: SERVER }, http, memoryStore());
    const pending = await session.beginLogin('http://127.0.0.1:49152/callback');
    await expect(session.completeLogin({ code: 'wrong', state: pending.state })).rejects.toThrow(/invalid_grant: bad code/);
  });

  it('refreshes an expired access token and persists the rotated pair', async () => {
    const { http } = fakeHttp(flowRoutes());
    const store = memoryStore();
    const session = new McpOAuthSession({ serverName: 'linear', serverUrl: SERVER }, http, store);
    // Seed the store the way a previous app run left it: dead tokens plus the
    // client identity they were issued to.
    await store.save('linear', {
      tokens: { accessToken: 'stale', refreshToken: 'rt-1', expiresAt: Date.now() - 1_000 },
      client: { clientId: 'cid-static' },
    });
    const token = await session.getAccessToken();
    expect(token).toBe('at-2');
    expect(store.saved.get('linear')?.tokens.refreshToken).toBe('rt-2');
    expect(store.saved.get('linear')?.client?.clientId).toBe('cid-static');
  });

  it('clears the store when the refresh token is dead so the UI offers a fresh login', async () => {
    const { http } = fakeHttp(flowRoutes());
    const store = memoryStore();
    const session = new McpOAuthSession({ serverName: 'linear', serverUrl: SERVER }, http, store);
    await store.save('linear', {
      tokens: { accessToken: 'stale', refreshToken: 'rotted', expiresAt: Date.now() - 1_000 },
      client: { clientId: 'cid-static' },
    });
    expect(await session.getAccessToken()).toBeUndefined();
    expect(store.saved.has('linear')).toBe(false);
  });

  it('logout removes the stored tokens', async () => {
    const { http } = fakeHttp(flowRoutes());
    const store = memoryStore();
    const session = new McpOAuthSession({ serverName: 'linear', serverUrl: SERVER }, http, store);
    await store.save('linear', { tokens: { accessToken: 'a' } });
    await session.logout();
    expect(store.saved.has('linear')).toBe(false);
  });

  it('makes unique states across logins', () => {
    expect(makeState()).not.toBe(makeState());
  });
});

describe('exchangeCode request shape', () => {
  it('posts the RFC 6749 form fields including the PKCE verifier', async () => {
    const bodies: Array<URLSearchParams> = [];
    const http: OAuthHttp = async (_url, init) => {
      bodies.push(new URLSearchParams(init.body ?? ''));
      return json(200, { access_token: 'at', expires_in: 600 });
    };
    const tokens = await exchangeCode(http, {
      metadata: {
        issuer: AUTH_ISSUER,
        authorizationEndpoint: `${AUTH_ISSUER}/authorize`,
        tokenEndpoint: `${AUTH_ISSUER}/token`,
      },
      client: { clientId: 'cid' },
      code: 'abc',
      redirectUri: 'http://127.0.0.1:49152/callback',
      verifier: 'verify-me',
      resource: SERVER,
    });
    expect(tokens.accessToken).toBe('at');
    expect(tokens.expiresAt).toBeDefined();
    const form = bodies[0];
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('abc');
    expect(form.get('client_id')).toBe('cid');
    expect(form.get('code_verifier')).toBe('verify-me');
    expect(form.get('resource')).toBe(SERVER);
  });
});
