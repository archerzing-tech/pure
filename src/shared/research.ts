export interface ResearchSource {
  title: string;
  snippet: string;
  url: string;
  content?: string;
}

export interface ResearchPayload {
  kind: 'researcher_web' | 'researcher_docs';
  query: string;
  sources: ResearchSource[];
  failed: string[];
  retrievedAt: string;
  truncated: boolean;
  filtered?: number;
  officialVerified?: boolean;
  versionMatched?: boolean;
  library?: string;
  topic?: string;
  version?: string;
}

export function parseWebSearchText(resultText: string): ResearchSource[] {
  const out: ResearchSource[] = [];
  if (!resultText) return out;
  const blocks = resultText.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length < 3) continue;
    const titleMatch = lines[0].match(/^\d+\.\s*(.+)$/);
    if (!titleMatch) continue;
    const urlIndex = lines.findIndex((line) => /^https?:\/\//i.test(line));
    if (urlIndex < 1) continue;
    out.push({
      title: titleMatch[1],
      snippet: lines.slice(1, urlIndex).join(' '),
      url: lines[urlIndex],
    });
  }
  return out;
}

export function parseResearchResult(resultText: string): ResearchSource[] {
  if (!resultText) return [];
  try {
    const value = JSON.parse(resultText) as Partial<ResearchPayload> & { items?: ResearchSource[] };
    if (Array.isArray(value.sources)) return value.sources.filter(isResearchSource);
    if (Array.isArray(value.items)) return value.items.filter(isResearchSource);
  } catch {
    // Legacy web_search text remains supported for old sessions and aliases.
  }
  return parseWebSearchText(resultText);
}

export function parseLegacyCodeSearchText(resultText: string): Array<{ path: string; line: number; text: string }> {
  return resultText.split('\\n').flatMap((line) => {
    const match = line.match(/^(.*?):(\\d+):\\s?(.*)$/);
    return match ? [{ path: match[1], line: Number(match[2]), text: match[3] }] : [];
  });
}

export function filterResearchSources(sources: ResearchSource[], allowedDomains: unknown): ResearchSource[] {
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) return sources;
  const domains = allowedDomains
    .filter((domain): domain is string => typeof domain === 'string')
    .map((domain) => domain.trim().toLowerCase().replace(/^\\*\\./, ''))
    .map((domain) => {
      try { return new URL(domain.includes('://') ? domain : `https://${domain}`).hostname.toLowerCase(); }
      catch { return ''; }
    })
    .filter(Boolean);
  return sources.filter((source) => {
    try {
      const host = new URL(source.url).hostname.toLowerCase();
      return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    } catch {
      return false;
    }
  });
}

const OFFICIAL_DOCUMENTATION_HOSTS: Record<string, string[]> = {
  anthropic: ['docs.anthropic.com'],
  bun: ['bun.sh'],
  next: ['nextjs.org'],
  node: ['nodejs.org'],
  openai: ['platform.openai.com'],
  python: ['docs.python.org'],
  react: ['react.dev'],
  rust: ['doc.rust-lang.org'],
  tauri: ['tauri.app'],
  typescript: ['typescriptlang.org'],
  vite: ['vite.dev'],
  vue: ['vuejs.org'],
};

export function isOfficialDocumentationSource(library: string, url: string): boolean {
  const normalized = library.trim().toLowerCase();
  const hosts = Object.entries(OFFICIAL_DOCUMENTATION_HOSTS)
    .filter(([name]) => normalized === name || normalized.includes(name))
    .flatMap(([, values]) => values);
  if (hosts.length === 0) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return hosts.some((officialHost) => host === officialHost || host.endsWith(`.${officialHost}`));
  } catch {
    return false;
  }
}

export function makeResearchPayload(
  kind: ResearchPayload['kind'],
  query: string,
  sources: ResearchSource[],
  options: Partial<Omit<ResearchPayload, 'kind' | 'query' | 'sources'>> = {},
): string {
  return JSON.stringify({
    kind,
    query,
    sources,
    failed: options.failed ?? [],
    retrievedAt: options.retrievedAt ?? new Date().toISOString(),
    truncated: options.truncated ?? false,
    ...(typeof options.filtered === 'number' ? { filtered: options.filtered } : {}),
    ...(typeof options.officialVerified === 'boolean' ? { officialVerified: options.officialVerified } : {}),
    ...(typeof options.versionMatched === 'boolean' ? { versionMatched: options.versionMatched } : {}),
    ...(options.library ? { library: options.library } : {}),
    ...(options.topic ? { topic: options.topic } : {}),
    ...(options.version ? { version: options.version } : {}),
  });
}

function isResearchSource(value: unknown): value is ResearchSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<ResearchSource>;
  return typeof source.title === 'string'
    && typeof source.snippet === 'string'
    && typeof source.url === 'string';
}
