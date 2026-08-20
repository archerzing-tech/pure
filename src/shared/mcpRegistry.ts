import type { MCPServerConfig } from '../adapter/mcp/MCPTransport';

export interface McpCandidate {
  id: string;
  name: string;
  title: string;
  description: string;
  version: string;
  source: 'official-registry' | 'community-search';
  repository?: string;
  config?: MCPServerConfig;
  requiresAuth: boolean;
  installHint?: string;
  url?: string;
}

interface RegistryServer {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  version?: unknown;
  repository?: { url?: unknown };
  packages?: unknown;
  remotes?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRequiredHeader(value: unknown): boolean {
  const record = asRecord(value);
  return record?.isRequired === true || record?.isSecret === true;
}

function remoteConfig(serverName: string, remote: unknown): { config?: MCPServerConfig; requiresAuth: boolean; url?: string } | null {
  const record = asRecord(remote);
  const url = text(record?.url);
  if (!url) return null;
  const headers = Array.isArray(record?.headers) ? record.headers : [];
  const requiresAuth = headers.some(isRequiredHeader);
  if (requiresAuth) return { requiresAuth, url };
  const kind = text(record?.type).toLowerCase();
  if (kind !== 'streamable-http' && kind !== 'sse' && kind !== 'http') return { requiresAuth, url };
  return {
    requiresAuth,
    url,
    config: { name: serverName, transport: 'http', url },
  };
}

function packageConfig(serverName: string, pkg: unknown): { config?: MCPServerConfig; requiresAuth: boolean; hint?: string } | null {
  const record = asRecord(pkg);
  const identifier = text(record?.identifier);
  if (!identifier) return null;
  const registryType = text(record?.registryType).toLowerCase();
  const runtime = text(record?.runtimeHint);
  if (registryType === 'npm') {
    return { config: { name: serverName, transport: 'stdio', command: [runtime || 'npx', '-y', identifier] }, requiresAuth: false };
  }
  if (registryType === 'pypi') {
    return { config: { name: serverName, transport: 'stdio', command: [runtime || 'uvx', identifier] }, requiresAuth: false };
  }
  if (registryType === 'oci') {
    return { config: { name: serverName, transport: 'stdio', command: [runtime || 'docker', 'run', '--rm', '-i', identifier] }, requiresAuth: false };
  }
  return { requiresAuth: true, hint: `${registryType || 'package'} package: ${identifier}` };
}

function candidateFromServer(server: RegistryServer, source: 'official-registry' | 'community-search'): McpCandidate | null {
  const name = text(server.name);
  if (!name) return null;
  const version = text(server.version);
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const remote = remotes.map((item) => remoteConfig(name, item)).find((item) => item !== null && item.config) ?? remotes.map((item) => remoteConfig(name, item)).find((item) => item !== null);
  const pkg = packages.map((item) => packageConfig(name, item)).find((item) => item !== null && item.config) ?? packages.map((item) => packageConfig(name, item)).find((item) => item !== null);
  const selected = remote?.config ? remote : pkg;
  const requiresAuth = Boolean(remote?.requiresAuth || pkg?.requiresAuth);
  const repository = text(asRecord(server.repository)?.url);
  const id = `mcp:${name}:${version || 'latest'}`;
  return {
    id,
    name,
    title: text(server.title) || name.split('/').pop() || name,
    description: text(server.description),
    version,
    source,
    repository: repository || undefined,
    config: selected?.config,
    requiresAuth,
    installHint: selected && 'hint' in selected ? selected.hint : undefined,
    url: remote?.url,
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  }
}

export function mcpRegistrySearchUrl(query: string, limit = 20): string {
  const params = new URLSearchParams({ search: query.trim(), limit: String(Math.max(1, Math.min(50, limit))) });
  return `https://registry.modelcontextprotocol.io/v0.1/servers?${params.toString()}`;
}

export function parseMcpRegistryPayload(raw: string, maxResults = 20): McpCandidate[] {
  const payload = asRecord(parseJson(raw));
  const entries = Array.isArray(payload?.servers) ? payload.servers : [];
  const latest = new Map<string, McpCandidate>();
  for (const entry of entries) {
    const wrapper = asRecord(entry);
    const server = asRecord(wrapper?.server);
    if (!server) continue;
    const candidate = candidateFromServer(server, 'official-registry');
    if (!candidate) continue;
    const previous = latest.get(candidate.name);
    const isLatest = asRecord(wrapper?._meta)?.['io.modelcontextprotocol.registry/official']
      && asRecord(asRecord(wrapper?._meta)?.['io.modelcontextprotocol.registry/official'])?.isLatest === true;
    if (!previous || isLatest || candidate.version > previous.version) latest.set(candidate.name, candidate);
  }
  return [...latest.values()].slice(0, Math.max(1, maxResults));
}

export function communityMcpCandidates(
  results: Array<{ title?: string; url?: string; snippet?: string }>,
  maxResults = 8,
): McpCandidate[] {
  return results
    .filter((result) => result.url)
    .slice(0, Math.max(1, maxResults))
    .map((result, index) => ({
      id: `community-mcp:${index}:${result.url}`,
      name: result.title || `community-${index + 1}`,
      title: result.title || 'Community MCP service',
      description: result.snippet || 'Community directory result; inspect the source before configuring it.',
      version: '',
      source: 'community-search',
      url: result.url,
      requiresAuth: true,
      installHint: 'Community result has no trusted executable recipe; inspect the source and configure it manually before connecting.',
    }));
}
