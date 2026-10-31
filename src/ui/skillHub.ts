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
import { sha256Hex } from '../shared/sha256';
import { withGithubMirrorPrefix } from '../shared/githubAccel';

/** AbortSignal.timeout needs Safari 16+ (macOS 13) in the WebView and is also
 *  the one suspect that explains the 2026-10-14 Windows CI failure of every
 *  stub-fetch test through this module's ladder (all candidates would throw
 *  before fetch is ever reached, get swallowed, and the ladder returns null).
 *  Same fallback as llmProbe.ts / settings.ts: AbortController + setTimeout. */
function abortSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

/** Proxy-aware text fetch for hub resources. In Tauri runtime, routes through
 *  the lean Rust `fetch_url_text` command (app proxy + netRoute classification,
 *  NO rendering tiers) so raw.githubusercontent.com works behind restricted
 *  networks while a missing candidate still costs exactly one fast 404 — same
 *  request count and latency profile as the direct fetch on clear networks.
 *  `proxyUrl` comes from netRouteProxyPair at the call site when configured. */
async function hubFetchText(url: string, timeoutMs = 10000, proxyUrl = ''): Promise<string | null> {
  if (isTauriRuntime()) {
    // 桥接层缺失（预览环境 / 更老的后端 / 测试里的共享模块替身）时不能直接判死：
    // 退回 WebView 的 fetch 至少还能拿到直连结果，而不是把 hub 整块判成不可达。
    try {
      // 动态取桥接层：`loadTauriCore` 用命名 import 的话，测试里对
      // shared/tauri 的进程级替身（只导出 isTauriRuntime / tauriInvoke）会让
      // 整个模块在求值期 SyntaxError——本模块的所有 hub 调用都会跟着死掉。
      const bridge = await import('../shared/tauri');
      const loader = bridge.loadTauriCore;
      if (typeof loader === 'function') {
        const core = await loader();
        if (core) {
          const text = await core.invoke<string>('fetch_url_text', {
            url,
            accept: null,
            proxyUrl: proxyUrl || null,
            timeoutSecs: Math.max(1, Math.ceil(timeoutMs / 1000)),
          });
          // 非字符串 = 后端根本没处理这条命令（未知命令 / 共享模块替身）：
          // 不能当成「站点不可达」，落到下面的 WebView fetch 再试一次。
          if (typeof text === 'string') return text || null;
        }
      }
    } catch {
      // Rust 通道失败（网络 / 老后端 / 测试环境里被钉死的运行时标记）：落到
      // 下面的 WebView fetch 走反向路由再试一次。反向不认应用代理，所以它只是
      // 「首选路挂了再换一条」的兑底，不是替代。
    }
  }
  try {
    const resp = await fetch(url, { signal: abortSignal(timeoutMs) });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

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
  /** skillContentHash of `body` at install time — the config-side twin of the
   *  on-disk .pure-skill.json sidecar. Lets a reinstall tell "same version"
   *  from "content changed" instead of flat-out refusing same-name installs.
   *  Absent on entries installed before version stamping existed. */
  hash?: string;
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
  // Anthropic's official library (Claude skills: docx/pdf/pptx/xlsx,
  // mcp-builder, skill-creator, …). Ships no skills.sh index — discovered
  // through the skills/ directory scan fallback below.
  'anthropics/skills',
  'nvidia/skills',
  'youdotcom-oss/agent-skills',
  'zapier/agent-skills',
  'openclaw/agent-skills',
] as const;

export interface SkillSearchResult extends HubSkillSummary {
  source: string;
}

/**
 * GitHub 加速档：镜像前缀优先，再回落到原有直连阶梯。
 *
 * 预算是全局的（12s），不是每个节点一份：加速只负责「更快」，不能把原本 10s
 * 能直连成功的网络拖成 40s。预算耗尽就交给下面的原有阶梯——直连始终在链尾，
 * 所以「所有镜像都挂了」只是退回今天的行为，不会变成失败。
 */
const MIRROR_LADDER_BUDGET_MS = 12_000;

/** 镜像可能返回 200 + HTML 错误页：JSON 会 parse 失败自然被丢弃，技能正文必须
 *  显式挡一下，否则一封错误页会被当成 SKILL.md 装进 ~/.pure/skills/。 */
function looksLikeHtmlDocument(text: string): boolean {
  const head = text.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<body');
}

async function fetchThroughMirrors(
  urls: readonly string[],
  mirrorPrefixes: readonly string[],
  proxyUrl: string,
): Promise<string | null> {
  const prefixes = mirrorPrefixes.filter((p) => p);
  if (prefixes.length === 0) return null;
  const deadline = Date.now() + MIRROR_LADDER_BUDGET_MS;
  for (const prefix of prefixes) {
    for (const url of urls) {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      const text = await hubFetchText(withGithubMirrorPrefix(prefix, url), Math.min(left, 8000), proxyUrl);
      if (text && text.trim()) return text;
    }
  }
  return null;
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

/** Fallback discovery for repos that ship NO index at all (e.g.
 * anthropics/skills — Claude's official library, which only has the standard
 * `skills/<name>/SKILL.md` layout plus its own .claude-plugin metadata): list
 * the `skills/` directory through the GitHub contents API and treat every
 * subdirectory as a skill. Names only — descriptions arrive with the install,
 * same as the skills.sh.json grouped format. */
export function hubContentsApiUrl(repo: string): string {
  return `https://api.github.com/repos/${normalizeHubRepo(repo)}/contents/skills`;
}

/** Parse a GitHub contents-API directory listing into skill summaries: only
 * real subdirectories count, dot-dirs are skipped. Returns [] for anything
 * that isn't a listing. */
export function hubIndexFromContentsScan(json: unknown): HubSkillSummary[] {
  if (!Array.isArray(json)) return [];
  const out: HubSkillSummary[] = [];
  for (const entry of json) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== 'dir') continue;
    const name = typeof e.name === 'string' ? e.name : '';
    if (!name || name.startsWith('.')) continue;
    out.push({ name, description: '', hasDescription: false });
  }
  return out;
}

async function fetchSkillsDirListing(repo: string, proxyUrl = ''): Promise<HubSkillSummary[]> {
  const url = hubContentsApiUrl(repo);
  let text: string | null;
  if (isTauriRuntime()) {
    text = await hubFetchText(url, 10000, proxyUrl);
  } else {
    try {
      const resp = await fetch(url, { signal: abortSignal(10000), headers: { Accept: 'application/vnd.github+json' } });
      if (!resp.ok) return [];
      text = await resp.text();
    } catch {
      return [];
    }
  }
  if (!text) return [];
  try {
    return hubIndexFromContentsScan(JSON.parse(text));
  } catch {
    return [];
  }
}

/** Fetch the first reachable hub index and normalize it into HubIndex. In
 * Tauri runtime the fetch rides the proxy-aware Rust web_fetch (see
 * hubFetchText); browser/dev mode fetches directly. */
export async function fetchHubIndex(
  repo: string,
  proxyUrl = '',
  mirrorPrefixes: readonly string[] = [],
): Promise<HubIndex> {
  const urls = hubIndexUrls(repo);
  // 加速档最先跑（默认关闭时 mirrorPrefixes 为空，一次多余请求都不会发）。
  const mirrored = await fetchThroughMirrors(urls, mirrorPrefixes, proxyUrl);
  if (mirrored) {
    try {
      const index = normalizeIndex(JSON.parse(mirrored));
      if (index) return index;
    } catch {
      // 镜像回了非 JSON（错误页/挡板页）：当作加速档没命中，继续直连阶梯。
    }
  }
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
        resp = await fetch(url, { signal: abortSignal(10000) });
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
  // No skills.sh-style index anywhere — that's not necessarily a dead end:
  // Anthropic's official library (anthropics/skills) and similar collections
  // ship only the standard `skills/<name>/SKILL.md` layout. Scan that
  // directory through the GitHub contents API so the Hub can browse them.
  const scanned = await fetchSkillsDirListing(repo, proxyUrl);
  if (scanned.length > 0) {
    return { groupings: [], skills: scanned };
  }
  errors.push('skills/ 目录扫描也没有结果');
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
export async function fetchSkillBody(
  repo: string,
  skillName: string,
  proxyUrl = '',
  mirrorPrefixes: readonly string[] = [],
): Promise<string | null> {
  const r = normalizeHubRepo(repo);
  const rawUrls = [
    `https://raw.githubusercontent.com/${r}/HEAD/skills/${skillName}/SKILL.md`,
    `https://raw.githubusercontent.com/${r}/main/skills/${skillName}/SKILL.md`,
    `https://raw.githubusercontent.com/${r}/HEAD/${skillName}/SKILL.md`,
    `https://raw.githubusercontent.com/${r}/main/${skillName}/SKILL.md`,
    `https://raw.githubusercontent.com/${r}/HEAD/SKILL.md`,
    `https://raw.githubusercontent.com/${r}/main/SKILL.md`,
  ];
  // 加速档最先跑：同一份 raw 路径走镜像前缀。显式节点/custom 时非空；
  // auto（默认）证据先行——raw host 直连被实测打死才非空（健康直连不绕镜像，
  // 见 githubAccel.githubMirrorLadderPrefixes）；显式 direct 恒空。
  const mirrored = await fetchThroughMirrors(rawUrls, mirrorPrefixes, proxyUrl);
  if (mirrored && !looksLikeHtmlDocument(mirrored)) return mirrored;
  if (isTauriRuntime()) {
    try {
      // 与 hubFetchText 同一个理由：命名 import 会在共享模块替身下炸掉整个模块。
      const bridge = await import('../shared/tauri');
      const loader = bridge.loadTauriCore;
      if (typeof loader === 'function') {
        const core = await loader();
        if (core) {
          const res = await core.invoke<{ path: string; body: string; via: string }>('fetch_skill_markdown', {
            repo: r,
            skill: skillName,
            proxyUrl: proxyUrl || null,
          });
          return res?.body || null;
        }
      }
    } catch {
      // Unknown command (old backend) or all ladder routes unreachable —
      // retry via the direct candidates below.
    }
  }
  for (const url of rawUrls) {
    try {
      const resp = await fetch(url, { signal: abortSignal(10000) });
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

/** Content fingerprint for installed skills: sha256 of the trimmed instruction
 *  body, shortened to 12 hex chars. This — not the SKILL.md bytes — is the
 *  version stamp all three install paths (CLI tool, GUI tool, Settings Hub)
 *  compare on: the CLI stores the raw file with its original frontmatter while
 *  the Rust write_app_skill rebuilds the frontmatter, so the on-disk bytes
 *  legitimately differ for the same skill, but the body is the same thing
 *  every path hashes and injects into the prompt. */
export function skillContentHash(body: string): string {
  return sha256Hex(body.trim()).slice(0, 12);
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
