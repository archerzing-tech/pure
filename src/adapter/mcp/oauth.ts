// src/adapter/mcp/oauth.ts
// 6.4 — OAuth 2.0 (Authorization Code + PKCE) for HTTP MCP servers.
//
// pure is a public client: no client secret is required — servers either
// publish a dynamic-registration endpoint (RFC 7591) and we register on first
// login, or the user pastes a static client_id into the server config.
// Discovery follows the MCP authorization spec chain: a 401 WWW-Authenticate
// challenge may point at RFC 9728 protected-resource metadata, which names the
// authorization server(s); otherwise the well-known URLs are probed directly.
//
// All HTTP goes through an injected `OAuthHttp` so the core is testable and
// runtime-agnostic (WebView relays via `mcp_http_request`, CLI can use fetch).

// ── Types ──

export interface OAuthTokens {
  accessToken: string;
  tokenType?: string;
  refreshToken?: string;
  /** Epoch ms the access token dies at (issued_at + expires_in − skew). */
  expiresAt?: number;
  scope?: string;
}

export interface OAuthClientInfo {
  clientId: string;
  clientSecret?: string;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  responseTypesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
}

export interface ProtectedResourceMetadata {
  resource?: string;
  authorizationServers?: string[];
  scopesSupported?: string[];
}

export interface OAuthHttpResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export type OAuthHttp = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<OAuthHttpResult>;

/** Per-server knobs: scopes come from config; a static clientId skips DCR. */
export interface OAuthServerOptions {
  /** Config name of the MCP server (also the token-store key). */
  serverName: string;
  /** MCP endpoint URL — doubles as the RFC 8707 `resource` audience. */
  serverUrl: string;
  scopes?: string[];
  clientId?: string;
  clientSecret?: string;
}

/** What lives in the token store for one server: the tokens plus the client
 *  identity they were issued to — refreshing after an app restart needs the
 *  same client_id, and a dynamically-registered one exists nowhere else. */
export interface StoredOAuth {
  tokens: OAuthTokens;
  client?: OAuthClientInfo;
}

/** Token persistence seam (Rust store commands in the desktop app). */
export interface OAuthTokenStore {
  load(serverName: string): Promise<StoredOAuth | undefined>;
  save(serverName: string, state: StoredOAuth): Promise<void>;
  clear(serverName: string): Promise<void>;
}

export class OAuthFlowError extends Error {
  constructor(
    /** Which leg of the flow failed — the UI maps it to a human hint. */
    readonly kind: 'metadata' | 'registration' | 'authorize' | 'exchange' | 'refresh',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

// ── Small helpers ──

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** RFC 7636 PKCE pair: 32 random bytes → verifier, SHA-256 → challenge. */
export async function makePkcePair(): Promise<PkcePair> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new OAuthFlowError('authorize', '此环境没有 WebCrypto，无法生成 PKCE');
  const verifierBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(verifierBytes);
  const verifier = base64url(verifierBytes);
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)), method: 'S256' };
}

/** Cryptographically random `state` for the redirect round-trip. */
export function makeState(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Parse a WWW-Authenticate challenge: `Bearer scope="…" resource_metadata="…"`
 *  (RFC 6750 §3 / RFC 9728 §5). Unquoted values tolerated. */
export function parseBearerChallenge(header: string | undefined): { scope?: string; resourceMetadata?: string } {
  if (!header) return {};
  const m = /^\s*Bearer\b(.*)$/i.exec(header);
  if (!m) return {};
  const pick = (name: string): string | undefined => {
    const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|([^\\s,]+))`, 'i');
    const hit = re.exec(m[1]);
    return hit ? (hit[1] ?? hit[2]) : undefined;
  };
  return { scope: pick('scope'), resourceMetadata: pick('resource_metadata') };
}

function formEncode(fields: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) params.set(k, v);
  }
  return params.toString();
}

async function fetchJson(http: OAuthHttp, url: string): Promise<{ status: number; body: unknown }> {
  const res = await http(url, { method: 'GET', headers: { Accept: 'application/json' } });
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    throw new OAuthFlowError('metadata', `元数据不是 JSON（HTTP ${res.status}）：${url}`);
  }
  return { status: res.status, body };
}

// ── Discovery ──

/** RFC 8414 §3.1 well-known URLs for an issuer, path component inserted. */
export function wellKnownUrls(issuer: string, wellKnown: 'oauth-authorization-server' | 'oauth-protected-resource'): string[] {
  const origin = new URL(issuer).origin;
  const path = new URL(issuer).pathname.replace(/\/$/, '');
  const urls: string[] = [];
  if (path && path !== '') urls.push(`${origin}/.well-known/${wellKnown}${path}`);
  urls.push(`${origin}/.well-known/${wellKnown}`);
  return [...new Set(urls)];
}

function asMetadata(body: unknown): AuthorizationServerMetadata | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.authorization_endpoint !== 'string' || typeof b.token_endpoint !== 'string') return undefined;
  return {
    issuer: typeof b.issuer === 'string' ? b.issuer : '',
    authorizationEndpoint: b.authorization_endpoint,
    tokenEndpoint: b.token_endpoint,
    registrationEndpoint: typeof b.registration_endpoint === 'string' ? b.registration_endpoint : undefined,
    scopesSupported: Array.isArray(b.scopes_supported) ? b.scopes_supported.map(String) : undefined,
    responseTypesSupported: Array.isArray(b.response_types_supported) ? b.response_types_supported.map(String) : undefined,
    codeChallengeMethodsSupported: Array.isArray(b.code_challenge_methods_supported) ? b.code_challenge_methods_supported.map(String) : undefined,
  };
}

/** Follow the discovery chain to authorization-server metadata:
 *  401 challenge → protected-resource metadata → its authorization server;
 *  no challenge hints → probe the MCP origin's well-knowns directly. */
export async function discoverAuthorizationServer(
  http: OAuthHttp,
  serverUrl: string,
  challenge?: { resourceMetadata?: string },
): Promise<{ metadata: AuthorizationServerMetadata; resource?: ProtectedResourceMetadata }> {
  let resource: ProtectedResourceMetadata | undefined;

  const readResourceMetadata = async (url: string): Promise<ProtectedResourceMetadata | undefined> => {
    const { status, body } = await fetchJson(http, url);
    if (status !== 200 || !body || typeof body !== 'object') return undefined;
    const b = body as Record<string, unknown>;
    return {
      resource: typeof b.resource === 'string' ? b.resource : undefined,
      authorizationServers: Array.isArray(b.authorization_servers) ? b.authorization_servers.map(String) : undefined,
      scopesSupported: Array.isArray(b.scopes_supported) ? b.scopes_supported.map(String) : undefined,
    };
  };

  if (challenge?.resourceMetadata) {
    resource = await readResourceMetadata(challenge.resourceMetadata).catch(() => undefined);
  }
  if (!resource) {
    for (const url of wellKnownUrls(serverUrl, 'oauth-protected-resource')) {
      resource = await readResourceMetadata(url).catch(() => undefined);
      if (resource) break;
    }
  }

  const issuerCandidates = resource?.authorizationServers?.length
    ? resource.authorizationServers
    : [new URL(serverUrl).origin];
  let lastError: string | undefined;
  for (const issuer of issuerCandidates) {
    for (const url of wellKnownUrls(issuer, 'oauth-authorization-server')) {
      const { status, body } = await fetchJson(http, url).catch((e: Error) => {
        lastError = e.message;
        return { status: 0, body: null };
      });
      const metadata = status === 200 ? asMetadata(body) : undefined;
      if (metadata) return { metadata, resource };
      if (status !== 0) lastError = `HTTP ${status} @ ${url}`;
    }
  }
  throw new OAuthFlowError('metadata', `找不到授权服务器元数据：${lastError ?? '没有可探测的地址'}`);
}

// ── Registration / authorize / token ──

/** RFC 7591 dynamic client registration (public client). */
export async function registerClient(
  http: OAuthHttp,
  metadata: AuthorizationServerMetadata,
  opts: { clientName: string; redirectUri: string; scopes?: string[] },
): Promise<OAuthClientInfo> {
  if (!metadata.registrationEndpoint) {
    throw new OAuthFlowError('registration', '授权服务器不支持动态注册，请在服务器配置里填 client_id');
  }
  const res = await http(metadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: opts.clientName,
      redirect_uris: [opts.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: opts.scopes?.join(' '),
    }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new OAuthFlowError('registration', `动态注册失败（HTTP ${res.status}）：${res.text.slice(0, 200)}`);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    throw new OAuthFlowError('registration', '动态注册响应不是 JSON');
  }
  if (typeof body.client_id !== 'string' || !body.client_id) {
    throw new OAuthFlowError('registration', '动态注册响应缺少 client_id');
  }
  return {
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === 'string' ? body.client_secret : undefined,
  };
}

export interface AuthorizeRequest {
  metadata: AuthorizationServerMetadata;
  client: OAuthClientInfo;
  redirectUri: string;
  scopes?: string[];
  state: string;
  pkce: PkcePair;
  /** RFC 8707 audience — the MCP server URL when resource metadata was found. */
  resource?: string;
}

export function buildAuthorizeUrl(req: AuthorizeRequest): string {
  const url = new URL(req.metadata.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', req.client.clientId);
  url.searchParams.set('redirect_uri', req.redirectUri);
  if (req.scopes?.length) url.searchParams.set('scope', req.scopes.join(' '));
  url.searchParams.set('state', req.state);
  url.searchParams.set('code_challenge', req.pkce.challenge);
  url.searchParams.set('code_challenge_method', req.pkce.method);
  if (req.resource) url.searchParams.set('resource', req.resource);
  return url.toString();
}

interface TokenSuccess {
  access_token?: unknown;
  token_type?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

function normalizeTokens(body: TokenSuccess, now: number): OAuthTokens {
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new OAuthFlowError('exchange', '令牌响应缺少 access_token');
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined;
  return {
    accessToken: body.access_token,
    tokenType: typeof body.token_type === 'string' ? body.token_type : undefined,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    // Refresh 60s early so an in-flight request never rides a dying token.
    expiresAt: expiresIn !== undefined ? now + Math.max(0, expiresIn - 60) * 1000 : undefined,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
  };
}

/** POST one token request (form-encoded) and normalize the result. */
async function postTokenRequest(
  http: OAuthHttp,
  tokenEndpoint: string,
  fields: Record<string, string | undefined>,
  kind: 'exchange' | 'refresh',
): Promise<OAuthTokens> {
  const res = await http(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: formEncode(fields),
  });
  if (res.status !== 200) {
    let detail = res.text.slice(0, 200);
    try {
      const body = JSON.parse(res.text) as { error?: string; error_description?: string };
      if (body.error) detail = [body.error, body.error_description].filter(Boolean).join(': ');
    } catch { /* keep raw body */ }
    throw new OAuthFlowError(kind, `令牌接口返回 HTTP ${res.status}：${detail}`);
  }
  let body: TokenSuccess;
  try {
    body = JSON.parse(res.text) as TokenSuccess;
  } catch {
    throw new OAuthFlowError(kind, '令牌响应不是 JSON');
  }
  return normalizeTokens(body, Date.now());
}

export interface CodeExchangeRequest {
  metadata: AuthorizationServerMetadata;
  client: OAuthClientInfo;
  code: string;
  redirectUri: string;
  verifier: string;
  resource?: string;
}

export function exchangeCode(http: OAuthHttp, req: CodeExchangeRequest): Promise<OAuthTokens> {
  return postTokenRequest(http, req.metadata.tokenEndpoint, {
    grant_type: 'authorization_code',
    code: req.code,
    redirect_uri: req.redirectUri,
    client_id: req.client.clientId,
    client_secret: req.client.clientSecret,
    code_verifier: req.verifier,
    resource: req.resource,
  }, 'exchange');
}

export function refreshTokens(
  http: OAuthHttp,
  metadata: AuthorizationServerMetadata,
  client: OAuthClientInfo,
  refreshToken: string,
  resource?: string,
): Promise<OAuthTokens> {
  return postTokenRequest(http, metadata.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    resource,
  }, 'refresh');
}

/** True when the token is missing or dies within `skewMs` (refresh early). */
export function tokensUsable(tokens: OAuthTokens | undefined, skewMs = 60_000): boolean {
  if (!tokens?.accessToken) return false;
  if (tokens.expiresAt === undefined) return true;
  return Date.now() + skewMs < tokens.expiresAt;
}

// ── Session: the stateful face the transport and the login UI both use ──

export interface PendingAuthorization {
  state: string;
  verifier: string;
  redirectUri: string;
  authorizeUrl: string;
}

/** One server's OAuth session: cached tokens (auto-refresh on read), cached
 *  metadata + client info (discovery/registration happen once per login). */
export class McpOAuthSession {
  private metadata: AuthorizationServerMetadata | undefined;
  private client: OAuthClientInfo | undefined;
  private resource: ProtectedResourceMetadata | undefined;
  private pending: PendingAuthorization | undefined;
  private refreshInFlight: Promise<OAuthTokens | undefined> | undefined;

  constructor(
    private options: OAuthServerOptions,
    private http: OAuthHttp,
    private store: OAuthTokenStore,
  ) {}

  /** Bearer token for request headers — undefined when the server needs a
   *  login. Refreshes an expired token when a refresh token exists; a failed
   *  refresh clears the store so the UI offers a fresh login. */
  async getAccessToken(): Promise<string | undefined> {
    const stored = await this.store.load(this.options.serverName);
    if (stored && tokensUsable(stored.tokens)) return stored.tokens.accessToken;
    const refreshToken = stored?.tokens.refreshToken;
    if (!refreshToken) return undefined;
    this.refreshInFlight ??= this.refresh(refreshToken).finally(() => {
      this.refreshInFlight = undefined;
    });
    const refreshed = await this.refreshInFlight;
    return refreshed?.accessToken;
  }

  private async refresh(refreshToken: string): Promise<OAuthTokens | undefined> {
    try {
      const stored = await this.store.load(this.options.serverName);
      // Client identity: this login's registration → the stored one → config.
      const client = this.client
        ?? stored?.client
        ?? (this.options.clientId
          ? { clientId: this.options.clientId, clientSecret: this.options.clientSecret }
          : undefined);
      if (!client?.clientId) {
        // Without the client the token was issued to, refresh is impossible —
        // drop the stale entry so the UI offers a fresh login.
        await this.store.clear(this.options.serverName).catch(() => { /* best effort */ });
        return undefined;
      }
      this.client = client;
      const found = await discoverAuthorizationServer(this.http, this.options.serverUrl);
      this.metadata ??= found.metadata;
      this.resource ??= found.resource;
      const tokens = await refreshTokens(
        this.http, this.metadata, client, refreshToken, this.resource?.resource,
      );
      await this.store.save(this.options.serverName, { tokens, client });
      return tokens;
    } catch {
      // A dead refresh token means the login is stale — start over via login.
      await this.store.clear(this.options.serverName).catch(() => { /* best effort */ });
      return undefined;
    }
  }

  /** Step 1 of a login: resolve metadata + client and build the authorize URL.
   *  `redirectUri` comes from the caller (the loopback flow owns the port). */
  async beginLogin(redirectUri: string): Promise<PendingAuthorization> {
    const found = await discoverAuthorizationServer(this.http, this.options.serverUrl);
    this.metadata = found.metadata;
    this.resource = found.resource;
    const scopes = this.options.scopes?.length ? this.options.scopes : found.resource?.scopesSupported ?? found.metadata.scopesSupported;
    const client: OAuthClientInfo = this.options.clientId
      ? { clientId: this.options.clientId, clientSecret: this.options.clientSecret }
      : await registerClient(this.http, found.metadata, {
          clientName: `pure (${this.options.serverName})`,
          redirectUri,
          scopes,
        });
    this.client = client;
    if (found.metadata.codeChallengeMethodsSupported
      && !found.metadata.codeChallengeMethodsSupported.includes('S256')) {
      throw new OAuthFlowError('authorize', '授权服务器不支持 S256 PKCE，无法安全登录');
    }
    const pkce = await makePkcePair();
    const state = makeState();
    const authorizeUrl = buildAuthorizeUrl({
      metadata: found.metadata,
      client,
      redirectUri,
      scopes,
      state,
      pkce,
      resource: found.resource?.resource,
    });
    this.pending = { state, verifier: pkce.verifier, redirectUri, authorizeUrl };
    return this.pending;
  }

  /** Step 2: the loopback redirect landed — validate and swap the code.
   *  Validation failures keep the flow alive: a stray prefetch or a wrong-tab
   *  callback must not burn the real one, which may still arrive. */
  async completeLogin(callback: { code?: string; state?: string; error?: string }): Promise<OAuthTokens> {
    const pending = this.pending;
    if (!pending || !this.metadata || !this.client) {
      throw new OAuthFlowError('exchange', '没有进行中的登录流程');
    }
    if (callback.error) {
      throw new OAuthFlowError('exchange', `授权被拒绝：${callback.error}`);
    }
    if (!callback.code) {
      throw new OAuthFlowError('exchange', '授权回调缺少 code');
    }
    if (callback.state !== pending.state) {
      throw new OAuthFlowError('exchange', 'state 不匹配（可能的 CSRF），登录已中止');
    }
    const tokens = await exchangeCode(this.http, {
      metadata: this.metadata,
      client: this.client,
      code: callback.code,
      redirectUri: pending.redirectUri,
      verifier: pending.verifier,
      resource: this.resource?.resource,
    });
    this.pending = undefined;
    await this.store.save(this.options.serverName, { tokens, client: this.client });
    return tokens;
  }

  async logout(): Promise<void> {
    this.pending = undefined;
    await this.store.clear(this.options.serverName);
  }

  /** Server-advertised scopes (for the settings card hint). Best effort. */
  async knownScopes(): Promise<string[] | undefined> {
    try {
      this.metadata ??= (await discoverAuthorizationServer(this.http, this.options.serverUrl)).metadata;
      return this.metadata.scopesSupported;
    } catch {
      return undefined;
    }
  }
}
