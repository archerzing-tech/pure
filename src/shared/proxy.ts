export interface ProxyConfig {
  enabled: boolean;
  llmEnabled: boolean;
  toolsEnabled: boolean;
  url: string;
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

export type ProxyScope = 'llm' | 'tools';

export function isUsableProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol) && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function effectiveProxyUrl(config: ProxyConfig, scope: ProxyScope = 'tools'): string {
  const scopeEnabled = scope === 'llm' ? config.llmEnabled : config.toolsEnabled;
  return config.enabled && scopeEnabled && isUsableProxyUrl(config.url) ? config.url : '';
}
