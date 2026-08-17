export interface ProxyConfig {
  enabled: boolean;
  llmEnabled: boolean;
  toolsEnabled: boolean;
  url: string;
  username: string;
  /**
   * Browser-only plaintext password (desktop scrubs it from the persisted
   * config and keeps the real value in Rust secrets instead).
   */
  password: string;
  /**
   * True on desktop when the password is stored in ~/.pure/secrets.json
   * (slot `proxy.password`). The WebView never sees the value; Rust injects
   * it into the proxy URL at request time.
   */
  hasPassword: boolean;
  bypassProviders: string[];
  bypassModels: string[];
}

export function normalizeProxyList(value: string | readonly string[] | null | undefined): string[] {
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[\n,，]/);
  return [...new Set(values.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

export function normalizeProxyConfig(config: Partial<ProxyConfig> | null | undefined): ProxyConfig {
  return {
    // Proxy is opt-in. Older explicitly enabled configurations remain enabled;
    // missing fields (including a fresh config) stay safely disabled.
    enabled: config?.enabled === true,
    llmEnabled: config?.llmEnabled === true,
    toolsEnabled: config?.toolsEnabled === true,
    url: String(config?.url ?? '').trim(),
    username: String(config?.username ?? '').trim(),
    // Password is not trimmed — leading/trailing spaces can be part of a
    // real password.
    password: String(config?.password ?? ''),
    hasPassword: config?.hasPassword === true,
    bypassProviders: normalizeProxyList(config?.bypassProviders),
    bypassModels: normalizeProxyList(config?.bypassModels),
  };
}

export function proxyMatches(value: string, patterns: readonly string[]): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return patterns.some((pattern) => {
    const normalizedPattern = pattern.trim().toLowerCase();
    return normalizedPattern === normalized || normalized.includes(normalizedPattern);
  });
}

export function shouldBypassProxy(
  provider: string,
  model: string,
  config: Pick<ProxyConfig, 'bypassProviders' | 'bypassModels'>,
): boolean {
  return proxyMatches(provider, config.bypassProviders) || proxyMatches(model, config.bypassModels);
}

/**
 * Split a stored proxy URL into its editable parts for the settings form
 * (scheme select + host + port). Accepts the full `scheme://host:port` form
 * and the scheme-less `host:port` shorthand, and strips any embedded
 * credentials (username/password live in their own fields). Falls back to a
 * raw split when `new URL` rejects the input, so a half-typed value never
 * wipes the other fields while the user is editing.
 */
export function parseProxyUrl(url: string): { scheme: string; host: string; port: string } {
  let candidate = String(url ?? '').trim();
  if (!candidate) return { scheme: 'http://', host: '', port: '' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = 'http://' + candidate;
  try {
    const parsed = new URL(candidate);
    const scheme = parsed.protocol.endsWith(':') ? parsed.protocol + '//' : parsed.protocol + '://';
    // URL drops a port that equals the scheme default (e.g. https:443), but a
    // proxy address needs the explicit port preserved — read it from the raw
    // authority when URL normalized it away.
    let port = parsed.port || '';
    if (!port) {
      const authority = candidate.slice(candidate.indexOf('://') + 3).split(/[/?#]/)[0];
      const m = authority.match(/:(\d+)$/);
      if (m) port = m[1];
    }
    return { scheme, host: parsed.hostname || '', port };
  } catch {
    const m = candidate.match(/^([a-z][a-z0-9+.-]*:\/\/)?([^:/]+)(?::(\d+))?/i);
    return { scheme: m?.[1] || 'http://', host: m?.[2] || '', port: m?.[3] || '' };
  }
}

/**
 * Compose the stored proxy URL from the settings form's scheme/host/port
 * fields. Defaults the scheme to http://, tolerates a scheme or `host:port`
 * pasted into the host field, and strips any credentials pasted in. The
 * stored form is always `scheme://host:port` (no trailing slash) so the
 * request-time credential injection keeps working.
 */
export function composeProxyUrl(scheme: string, host: string, port: string): string {
  const schemeNorm = (scheme || 'http://').trim().toLowerCase();
  const schemePart = /:\/\//.test(schemeNorm) ? schemeNorm : schemeNorm + '://';
  let hostPart = host.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  const at = hostPart.lastIndexOf('@');
  if (at >= 0) hostPart = hostPart.slice(at + 1);
  let portPart = port.trim();
  const colonIdx = hostPart.lastIndexOf(':');
  if (!portPart && colonIdx > 0 && !hostPart.startsWith('[')) {
    const maybe = hostPart.slice(colonIdx + 1);
    if (/^\d+$/.test(maybe)) {
      portPart = maybe;
      hostPart = hostPart.slice(0, colonIdx);
    }
  }
  // Nothing configured stays an empty string so the stored config never
  // carries a meaningless bare scheme.
  if (!hostPart) return '';
  return portPart ? `${schemePart}${hostPart}:${portPart}` : `${schemePart}${hostPart}`;
}

export type ProxyScope = 'llm' | 'tools';

export function isUsableProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol) && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Embed proxy authentication into the URL as `scheme://user:pass@host:port`.
 * The credentials are percent-encoded; reqwest's proxy parser percent-decodes
 * them before applying basic auth (HTTP) or SOCKS5 auth, so passwords with
 * reserved characters round-trip correctly. Returns the URL unchanged when no
 * username is set (a password alone cannot authenticate).
 */
export function proxyUrlWithAuth(url: string, username: string, password: string): string {
  const user = username.trim();
  if (!user) return url;
  try {
    const parsed = new URL(url);
    parsed.username = user;
    parsed.password = password;
    return parsed.toString();
  } catch {
    return url;
  }
}

export function effectiveProxyUrl(config: ProxyConfig, scope: ProxyScope = 'tools'): string {
  const scopeEnabled = scope === 'llm' ? config.llmEnabled : config.toolsEnabled;
  if (!config.enabled || !scopeEnabled || !isUsableProxyUrl(config.url)) return '';
  // Desktop keeps the password in Rust secrets: the URL carries only the
  // username, and the backend injects the password from `proxy.password`.
  const password = config.hasPassword ? '' : config.password;
  return proxyUrlWithAuth(config.url, config.username, password);
}
