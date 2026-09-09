// src/ui/skillHub.ts
// Third-party skill hub integration (Settings → Skills → Skill Hub).
//
// Hubs follow the open `skills` ecosystem (the `npx skills` CLI / skills.sh):
//   - Index (two formats, probed in order):
//       * `skills.sh.json` at the repo root — Vercel-style grouped catalog
//         ({ groupings: [{ title, description, skills: [name, …] }] }).
//       * `.well-known/skills/index.json` — the standard discovery format
//         ({ $schema?, skills: [{ name, description, … }] }, with V1/V2
//         schemas both accepted; see the skills CLI's normalizeIndex).
//   - Skill content: `<repo>/skills/<name>/SKILL.md` with YAML frontmatter
//     (name, description, optional metadata), exactly what the `npx skills`
//     CLI installs into .agents/skills/.
//
// Installed skills are stored in the PureConfig `hubSkills` array (name +
// description + source + the SKILL.md body) and surface as toggle cards next
// to the built-in skills. When enabled, the body is injected into the system
// prompt (shared PromptAssembler), so the
// agent behaves per the skill's instructions.

import { isTauriRuntime } from '../shared/tauri';

/** Proxy-aware text fetch for hub resources. In Tauri runtime, routes through
 *  the Rust `web_fetch` command (which has app proxy + netRoute classification)
 *  so raw.githubusercontent.com works behind restricted networks. `proxyUrl`
 *  comes from netRouteProxyPair at the call site when one is configured. */
async function hubFetchText(url: string, timeoutMs = 10000, proxyUrl = ''): Promise<string | null> {
  if (isTauriRuntime()) {
    try {
      const core = await loadTauriCore();
      if (!core) return null;
      const text = await core.invoke<string>('web_fetch', {
        workspace: '',
        url,
        maxChars: 500000,
        proxyUrl: proxyUrl || '',
      });
      return text || null;
    } catch {
      return null;
    }
  }
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// Re-import loadTauriCore for the Tauri path above.
import { loadTauriCore } from '../shared/tauri';

export interface HubSkill {
  /** Skill id — the directory name (e.g. "web-design-guidelines"). */
  name: string;
  /** Short description from the index or SKILL.md frontmatter. */
  description: string;
  /** Repository source, e.g. "vercel-labs/agent-skills". */
  source: string;
  /** Full SKILL.md body (frontmatter stripped) injected when enabled. */
  body: string;
  /** Whether the skill is currently enabled. */
  enabled: boolean;
}

export interface HubSkillSummary {
  name: string;
  description: string;
  /** True when the entry carries enough metadata for a rich card. */
  hasDescription: boolean;
}

export interface HubIndex {
  /** Grouped catalog (skills.sh.json format). Empty when the source was the
   * standard index.json. */
  groupings: Array<{ title: string; description: string; skills: HubSkillSummary[] }>;
  /** Flat catalog (standard index.json format). */
  skills: HubSkillSummary[];
}

export interface SkillHubError {
  message: string;
  /** True when the hub was reachable but had no parseable index. */
  notFound?: boolean;
}

/** Default hub seeded in the UI — Vercel's official skills catalog. */
export const DEFAULT_HUB_REPO = 'vercel-labs/agent-skills';

export const SEARCH_HUB_REPOS = [
  DEFAULT_HUB_REPO,
  'nvidia/skills',
  'youdotcom-oss/agent-skills',
  'zapier/agent-skills',
  'openclaw/agent-skills',
] as const;

export interface SkillSearchResult extends HubSkillSummary {
  source: string;
}

/** Rewrite "owner/repo" or a bare repo name into a canonical GitHub repo
 * string. Accepts full https://github.com/owner/repo URLs too. */
export function normalizeHubRepo(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  if (m) return m[1];
  const bare = trimmed.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/);
  if (bare) return bare[1];
  return trimmed;
}

/** Map a hub repo to the candidate index URLs, probed in order. Mirrors the
 * skills CLI's well-known paths — both `.well-known/skills` and
 * `.well-known/agent-skills` are standard discovery locations. */
export function hubIndexUrls(repo: string): string[] {
  const r = normalizeHubRepo(repo);
  return [
    `https://raw.githubusercontent.com/${r}/HEAD/skills.sh.json`,
    `https://raw.githubusercontent.com/${r}/HEAD/.well-known/skills/index.json`,
    `https://raw.githubusercontent.com/${r}/HEAD/.well-known/agent-skills/index.json`,
    `https://raw.githubusercontent.com/${r}/main/.well-known/skills/index.json`,
    `https://raw.githubusercontent.com/${r}/main/.well-known/agent-skills/index.json`,
  ];
}

/** Fetch the first reachable hub index and normalize it into HubIndex. In
 * Tauri runtime the fetch rides the proxy-aware Rust web_fetch (see
 * hubFetchText); browser/dev mode fetches directly. */
export async function fetchHubIndex(repo: string, proxyUrl = ''): Promise<HubIndex> {
  const urls = hubIndexUrls(repo);
  const errors: string[] = [];
  let anyReached = false;
  for (const url of urls) {
    let text: string | null;
    if (isTauriRuntime()) {
      text = await hubFetchText(url, 10000, proxyUrl);
      if (text == null) continue;
      anyReached = true;
    } else {
      let resp: Response;
      try {
        resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      } catch {
        continue;
      }
      if (resp.status === 404) continue;
      if (!resp.ok) {
        errors.push(`${url}: HTTP ${resp.status}`);
        continue;
      }
      anyReached = true;
      text = await resp.text();
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // 200 but not JSON — record it so the failure message says "format
      // problem" instead of a misleading "unreachable".
      errors.push(`${url}: not JSON`);
      continue;
    }
    const index = normalizeIndex(json);
    if (index) return index;
    errors.push(`${url}: no parseable skills index`);
  }
  throw new Error(
    `无法从 ${normalizeHubRepo(repo)} 获取 skill 索引 — ${anyReached ? errors.join('; ') || '索引格式无法解析' : '仓库或分支不可达，请确认仓库名正确（owner/repo 或完整 GitHub URL）'}`,
  );
}

/** Normalize raw hub index JSON (either format) into HubIndex, or null. */
export function normalizeIndex(json: unknown): HubIndex | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;

  // skills.sh.json grouped format.
  const groupings = Array.isArray(record.groupings)
    ? record.groupings
        .map((g) => {
          if (!g || typeof g !== 'object') return null;
          const grp = g as Record<string, unknown>;
          const names = Array.isArray(grp.skills) ? grp.skills.filter((s): s is string => typeof s === 'string') : [];
          if (names.length === 0) return null;
          return {
            title: typeof grp.title === 'string' ? grp.title : 'Skills',
            description: typeof grp.description === 'string' ? grp.description : '',
            skills: names.map((n) => ({ name: n, description: '', hasDescription: false })),
          };
        })
        .filter((g): g is NonNullable<typeof g> => g !== null)
    : [];
  if (groupings.length > 0) {
    return { groupings, skills: [] };
  }

  // Standard .well-known/skills/index.json format (V1 + V2).
  if (Array.isArray(record.skills)) {
    const skills: HubSkillSummary[] = record.skills
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const e = entry as Record<string, unknown>;
        const name = typeof e.name === 'string' ? e.name : '';
        if (!name) return null;
        const description = typeof e.description === 'string' ? e.description : '';
        return { name, description, hasDescription: description.length > 0 };
      })
      .filter((s): s is HubSkillSummary => s !== null);
    if (skills.length > 0) return { groupings: [], skills };
  }

  return null;
}

/** Fetch a skill's raw SKILL.md (frontmatter intact; callers split it via
 * splitSkillMarkdown). Desktop runtime delegates to the Rust
 * `fetch_skill_markdown` ladder — raw CDN → api.github.com contents → repo
 * zip — which is proxy-aware and keeps working when raw.githubusercontent.com
 * is blocked; on any error it falls back to the direct candidates so an older
 * backend that predates the command still works. Browser/dev mode probes the
 * same candidates directly. */
export async function fetchSkillBody(repo: string, skillName: string, proxyUrl = ''): Promise<string | null> {
  const r = normalizeHubRepo(repo);
  if (isTauriRuntime()) {
    try {
      const core = await loadTauriCore();
      if (core) {
        const res = await core.invoke<{ path: string; body: string; via: string }>('fetch_skill_markdown', {
          repo: r,
          skill: skillName,
          proxyUrl: proxyUrl || null,
        });
        return res?.body || null;
      }
    } catch {
      // Unknown command (old backend) or all ladder routes unreachable —
      // retry via the direct candidates below.
    }
  }
  const candidates = [
    `https://raw.githubusercontent.com/${r}/HEAD/skills/${skillName}/SKILL.md`,
    `https://raw.githubusercontent.com/${r}/main/skills/${skillName}/SKILL.md`,
    `https://raw.githubusercontent.com/${r}/HEAD/${skillName}/SKILL.md`,
    `https://raw.githubusercontent.com/${r}/main/${skillName}/SKILL.md`,
    `https://raw.githubusercontent.com/${r}/HEAD/SKILL.md`,
    `https://raw.githubusercontent.com/${r}/main/SKILL.md`,
  ];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (resp.status === 404) continue;
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text.trim()) return text;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Strip the YAML frontmatter block (--- … ---) from a SKILL.md, returning
 * the instruction body plus the frontmatter description when present. */
export function splitSkillMarkdown(md: string): { description?: string; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: md };
  const fm = m[1];
  const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
  return { description: desc, body: m[2].trim() };
}

/** Sanitize a skill id for use inside the `<skill name="…">` prompt tag and
 * as the install directory name: keep only word chars, dashes, and dots so a
 * hostile hub cannot break the tag with quotes/angle brackets, and the name
 * always passes the Rust write_app_skill validation (which rejects slashes
 * and path components like `.` / `..`). */
export function sanitizeSkillName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** Build the HubSkill record persisted into PureConfig.hubSkills. */
export function makeHubSkill(
  repo: string,
  summary: HubSkillSummary,
  body: string,
  enabled = true,
): HubSkill {
  return {
    name: sanitizeSkillName(summary.name),
    description: summary.description,
    source: normalizeHubRepo(repo),
    body,
    enabled,
  };
}

/** Search the configured public skill hubs and return matching candidates. */
const SEARCH_TOTAL_DEADLINE_MS = 20_000;

export async function searchHubSkills(
  query: string,
  maxResults = 8,
  repos: readonly string[] = SEARCH_HUB_REPOS,
  proxyUrl = '',
): Promise<SkillSearchResult[]> {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  // The repos are fetched in parallel but each probes up to 5 index URLs with
  // a 10s timeout each — without a total deadline a single unresponsive host
  // would stall the whole search_agent_skills tool call for ~50s. Fail fast
  // and return whatever matched so far (empty on timeout) instead.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let indexes: Array<PromiseSettledResult<{ repo: string; index: HubIndex }>>;
  try {
    indexes = await Promise.race([
      Promise.allSettled(repos.map(async (repo) => ({ repo, index: await fetchHubIndex(repo, proxyUrl) }))),
      new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => reject(new Error('skill search timed out')), SEARCH_TOTAL_DEADLINE_MS);
      }),
    ]);
  } catch {
    return [];
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
  const matches: SkillSearchResult[] = [];
  for (const result of indexes) {
    if (result.status !== 'fulfilled') continue;
    const { repo, index } = result.value;
    const summaries = [
      ...index.skills,
      ...index.groupings.flatMap((group) => group.skills),
    ];
    for (const summary of summaries) {
      const haystack = `${summary.name} ${summary.description}`.toLowerCase();
      if (!terms.some((term) => haystack.includes(term))) continue;
      matches.push({ ...summary, source: normalizeHubRepo(repo) });
    }
  }
  const seen = new Set<string>();
  return matches
    .filter((skill) => {
      const key = `${skill.source}:${skill.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, Math.min(20, maxResults)));
}
