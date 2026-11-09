// src/tools/impl/webSearch.ts
// Single-source implementation of web_search (P2-5: the web stack lives once,
// in TS — the old pair of orchestrations, NodeToolAdapter.handleWebSearch and
// Rust web_search_inner, had already drifted: the CJK relevance gate only
// existed on the Node side, so GUI searches could hand the model garbage that
// triggered repeated searches while CLI rolled over). Behavior caliber is the
// CLI (Node) form — the fuller one: CJK bigram relevance gate, per-backend
// quota cooldowns, shared cookie jar, one normalized retry, Jina last resort.
// Like the other impl modules this file is pure logic over injected
// primitives — no node APIs, no global fetch, no process.env — so the SAME
// module runs in Bun (CLI) and the WebView (GUI). Each adapter supplies:
//   - fetchPage: one HTTP page fetch with redirect-following. Node wraps
//     cliFetch (env-proxy routing + 75% unblock budget); the GUI wraps the
//     Rust `fetch_page` command (reqwest + the learned per-surface proxyUrl,
//     so netRoute's proxy learning keeps working). The cookie jar stays here
//     in TS on both sides — fetchPage must NOT manage cookies itself, it just
//     hands back the raw Set-Cookie header and we re-attach on the next
//     request (otherwise the jar logic would fork again).
//   - env: key lookup (Node reads process.env; the GUI maps Settings values).
//   - cacheGet/cacheSet: the shared ~/.pure/cache/web-cache.json TTL cache
//     (Node reads the file directly; the GUI goes through the Rust WebCache
//     commands) — optional; without it searches just never cache.
// The Tier-2 structured fast path (weather/geo/news/wiki/IP/FX/stock/GitHub)
// is NOT part of this module: it is caller-side on both hosts (Node's
// cachedDirectPublicApi, the GUI's web_public_api command) and converges in
// the public-API parser consolidation cut that follows this one.

import { BROWSER_UA } from '../../shared/platformUa';

// ── Injected primitive shapes ──

/** Key lookup for opt-in backends (SERPER_API_KEY, TAVILY_API_KEY, …).
 * Returns the trimmed value or '' when unset. */
export type EnvFn = (key: string) => string;

/** Result of one page fetch: raw body BYTES (charset decoding is ours — GBK
 * pages must survive the trip), plus the metadata the cookie jar and status
 * checks need. `status` is the HTTP status after redirects; `finalUrl` is
 * where the redirects landed; `setCookie` is the raw Set-Cookie header
 * (multiple cookies joined), null when absent. */
export interface PageFetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  setCookie: string | null;
  body: Uint8Array;
}

export interface PageFetchInit {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** Hard cap for the whole fetch (redirects included). */
  timeoutMs?: number;
}

export type PageFetchFn = (url: string, init?: PageFetchInit) => Promise<PageFetchResult>;

/** Network + environment surface for one search. */
export interface SearchNetDeps {
  fetchPage: PageFetchFn;
  env: EnvFn;
}

export interface WebSearchDeps extends SearchNetDeps {
  /** Shared web-cache read: undefined = miss. Async allowed — the GUI host
   * reads the shared cache over IPC. */
  cacheGet?: (key: string) => string | undefined | Promise<string | undefined>;
  /** Shared web-cache write (TTL in ms). */
  cacheSet?: (key: string, value: string, ttlMs: number) => void;
}

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

export interface WebSearchOutcome {
  /** false = every backend errored at the network level (never an empty
   * result set — that is ok with guidance text). The adapter maps this to
   * its own failure ToolResult. */
  ok: boolean;
  output: string;
}

/** Search result cache TTL — 15 minutes, shared with the Tier-2 fast path's
 * own per-intent TTLs in the same cache file. */
export const SEARCH_TTL_MS = 15 * 60 * 1000;

/** FNV-1a 64-bit over NUL-joined parts, hashed over UTF-8 BYTES —
 * byte-identical to the Rust cache_hash_key (and the old webCache.ts copy)
 * so CLI and GUI produce the same cache keys for the same inputs. */
export function fnv1a64(parts: string[]): string {
  const bytes = new TextEncoder().encode(parts.join('\u0000'));
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}

/** Query normalization for cache identity: lowercase + trim + collapse
 * whitespace; CJK queries also drop INTERNAL whitespace ("北京天气" ==
 * "北京 天气" — the space is just typing variance for Chinese, and a separate
 * cache entry would re-run the chain for no semantic difference). */
export function normalizeQuery(query: string): string {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  return /[㐀-䶿一-鿿豈-﫿]/.test(q) ? q.replace(/\s+/g, '') : q;
}

/** Key for web_search result sets (query + result count; location not needed —
 * the Tier-2 fast path is cached separately under its own key). */
export function searchCacheKey(query: string, maxResults: number): string {
  return fnv1a64(['search', String(maxResults), normalizeQuery(query)]);
}

// ── Per-backend quota (cooldown + sliding-window use cap) ──
// A failed/over-budget backend goes into cooldown instead of being retried on
// every query — free tiers die silently when every search re-probes them.

export class BackendQuota {
  private blockedUntil = new Map<string, number>();
  private uses = new Map<string, number[]>();

  isBlocked(key: string): boolean {
    const until = this.blockedUntil.get(key);
    return until !== undefined && until > Date.now();
  }

  /** Block a backend for `ms` (rate limit, quota exhausted, dead instance). */
  markBlocked(key: string, ms: number): void {
    this.blockedUntil.set(key, Date.now() + ms);
  }

  /** Record one successful use; returns true when the window is over budget. */
  registerUse(key: string, windowMs: number, cap: number): boolean {
    const now = Date.now();
    const windowStart = now - windowMs;
    const list = (this.uses.get(key) ?? []).filter((t) => t > windowStart);
    list.push(now);
    this.uses.set(key, list);
    return list.length > cap;
  }

  /** Number of uses in the sliding window (for diagnostics). */
  countInWindow(key: string, windowMs: number): number {
    const now = Date.now();
    return (this.uses.get(key) ?? []).filter((t) => t > now - windowMs).length;
  }

  /** Drop all cooldowns and usage history (diagnostics / tests). */
  clear(): void {
    this.blockedUntil.clear();
    this.uses.clear();
  }
}

/** Process-wide quota singleton. In-memory only: cooldowns reset when the
 * process restarts, which is fine — they exist to survive a burst of queries
 * inside one session, not to remember yesterday's rate limits. */
export const quota = new BackendQuota();

// ── Shared cookie jar for HTML search backends ──
// Reusing session cookies (Baidu's BAIDUID, Bing's MUID, Sogou's SUV, …)
// across searches within the process is the single cheapest captcha-avoidance
// lever there is: a fresh cookie-less client trips anti-bot challenges on the
// very first request, which is exactly how "经常搜不到" happens. Mirrors the
// Rust SEARCH_COOKIE_JAR. In-memory only (no persistence across runs) and
// carries no credentials. On BOTH hosts the jar lives here: fetchPage is a
// bare transport that must not keep its own cookie store, or the two jars
// would fight over Set-Cookie.

const searchCookieJar = new Map<string, Map<string, string>>(); // domain -> name -> value

export function cookieHeaderFor(url: string): string {
  try {
    const host = new URL(url).host;
    const pairs: string[] = [];
    for (const [domain, cookies] of searchCookieJar) {
      if (host === domain || host.endsWith('.' + domain)) {
        for (const [k, v] of cookies) pairs.push(`${k}=${v}`);
      }
    }
    return pairs.join('; ');
  } catch {
    return '';
  }
}

export function storeCookies(url: string, setCookieHeader: string | null): void {
  if (!setCookieHeader) return;
  try {
    const host = new URL(url).host;
    for (const raw of setCookieHeader.split(',')) {
      const [pair, ...attrs] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      // Honor an explicit Domain attribute; otherwise scope to the request host.
      let domain = host;
      for (const a of attrs) {
        const t = a.trim().toLowerCase();
        if (t.startsWith('domain=')) {
          const d = t.slice(7).trim().replace(/^\./, '');
          if (d) domain = d;
        }
      }
      let jar = searchCookieJar.get(domain);
      if (!jar) {
        jar = new Map();
        searchCookieJar.set(domain, jar);
      }
      jar.set(name, value);
    }
  } catch {
    /* ignore malformed cookie headers */
  }
}

/** fetch() that rides the shared cookie jar: attaches stored cookies for the
 * request host and stores any Set-Cookie the response returns. Used by the
 * HTML search backends (and the Baidu warm-up); the key-bearing API backends
 * call deps.fetchPage directly — no jar, same as the CLI always did. */
async function fetchViaJar(deps: SearchNetDeps, url: string, init: PageFetchInit = {}): Promise<PageFetchResult> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const cookies = cookieHeaderFor(url);
  if (cookies) headers.Cookie = headers.Cookie ? `${headers.Cookie}; ${cookies}` : cookies;
  const resp = await deps.fetchPage(url, { ...init, headers });
  storeCookies(url, resp.setCookie);
  return resp;
}

/** Test/diagnostics hook: empty the jar (cookie state would otherwise leak
 * between cases in the same process). */
export function resetSearchCookieJar(): void {
  searchCookieJar.clear();
}

// Lazily warmed-up flag: the first Baidu search first fetches the homepage so
// the jar picks up a BAIDUID cookie before the real query — Baidu serves a
// captcha page to cookie-less clients and the warm-up is the documented
// workaround. Best-effort (a failed warm-up just means the search may hit the
// captcha and degrade to the next backend). Mirrors Rust ensure_baidu_cookies.
let baiduWarmed = false;
async function ensureBaiduCookies(deps: SearchNetDeps): Promise<void> {
  if (baiduWarmed) return;
  baiduWarmed = true;
  try {
    await fetchViaJar(deps, 'https://www.baidu.com/', {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      timeoutMs: 4000,
    });
  } catch {
    /* best-effort */
  }
}

/** Test hook: re-arm the one-shot Baidu warm-up. */
export function resetBaiduWarmup(): void {
  baiduWarmed = false;
}

// ── Charset-aware HTTP body decoding ──
// Raw response bytes are always decoded as UTF-8 by a naive decoder, so
// GBK/GB2312 pages — very common on Chinese sites (Sogou, many 门户 sites) —
// would otherwise come back as mojibake. The charset is resolved in priority
// order: Content-Type header charset → HTML <meta> charset sniff → UTF-8.
// Mirrors decode_response_with_charset in src-tauri/src/lib.rs.

/** Extract the charset parameter from a Content-Type header, if declared. */
export function charsetFromContentType(contentType: string): string | undefined {
  const m = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return m?.[1];
}

/** Sniff `<meta charset=…>` / `<meta http-equiv="Content-Type" content="…charset=…">`
 * from the first bytes of an HTML page. The meta tag is ASCII, so scanning a
 * lossily-UTF-8-decoded head slice is safe even when the body is GBK. */
export function sniffHtmlCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('utf-8').decode(bytes.slice(0, 2048));
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_\-]+)/i);
  return m?.[1];
}

function normalizeCharsetLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const l = label.trim().toLowerCase();
  // UTF-8 family needs no re-decode; iso-8859-1/latin1 is the classic
  // mislabel on pages that are actually UTF-8, so keep the UTF-8 behavior
  // rather than windows-1252-decode them into mojibake.
  if (!l || /^(utf-?8|us-ascii|ascii|iso-?8859-?1|latin-?1)$/.test(l)) return undefined;
  return l;
}

/** Decode a fetched body with the resolved charset, falling back to UTF-8.
 * `TextDecoder` itself normalizes WHATWG labels (GB2312/gb_2312-80 → GBK), so
 * the declared label is passed through; utf-8-family and latin1 labels (the
 * common mislabel for actually-UTF-8 pages) skip re-decoding to avoid
 * regressions. */
export function decodeBody(result: Pick<PageFetchResult, 'contentType' | 'body'>): string {
  const label = normalizeCharsetLabel(
    charsetFromContentType(result.contentType) ?? sniffHtmlCharset(result.body),
  );
  if (!label) return new TextDecoder('utf-8').decode(result.body);
  try {
    return new TextDecoder(label).decode(result.body);
  } catch {
    return new TextDecoder('utf-8').decode(result.body);
  }
}

function isOk(r: PageFetchResult): boolean {
  return r.status >= 200 && r.status < 300;
}

/** status !== 2xx → throw with the code, the uniform backend failure shape. */
function assertOk(r: PageFetchResult): void {
  if (!isOk(r)) throw new Error(`HTTP ${r.status}`);
}

// ── Shared HTML helpers (parsers) ──

/** Strip HTML to readable text (shared by the search result parsers). Mirror-
 * tested against the Rust strip_html_full in stripHtml.test.ts — the two must
 * agree on the common core (tag stripping, script/style removal, whitespace
 * collapse, block breaks). Intentional divergences (entities, inline tags,
 * script case) are documented there. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(?:div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    // Numeric character references (common in Bing snippets, e.g. &#0183;).
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

/** Extract an href attribute value after a `<a` marker, mirroring the Rust
 * parser's extract_href: read the quote char (single OR double) that follows
 * `href=`, then the text up to the matching quote. Returns undefined when the
 * attribute is missing or unquoted so the block is skipped. */
function extractHref(s: string, from: number): string | undefined {
  const rest = s.slice(from);
  const hrefIdx = rest.indexOf('href=');
  if (hrefIdx === -1) return undefined;
  const afterHref = rest.slice(hrefIdx + 'href='.length);
  const quote = afterHref[0];
  if (quote !== '"' && quote !== "'") return undefined;
  const end = afterHref.indexOf(quote, 1);
  if (end === -1) return undefined;
  return decodeHtmlEntities(afterHref.slice(1, end));
}

/** Extract a bare double-quoted attribute value from HTML, e.g.
 * `data-mdurl="https://…"` — used where `<a>` hrefs are redirect wrappers.
 * Mirrors the Rust extract_attr. */
function extractAttr(block: string, attr: string): string | undefined {
  const idx = block.indexOf(attr);
  if (idx === -1) return undefined;
  const rest = block.slice(idx + attr.length).trimStart();
  if (!rest.startsWith('=')) return undefined;
  const after = rest.slice(1).trimStart();
  if (after[0] === '"' || after[0] === "'") {
    const end = after.indexOf(after[0], 1);
    if (end === -1) return undefined;
    return after.slice(1, end);
  }
  const m = after.match(/^[^\s>]+/);
  return m?.[0];
}

function percentDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Bing wraps result URLs in `/ck/a` redirects: `…&u=a1aHR0cHM6Ly9ydXN0LWxhbmcub3JnLw&ntb=1`.
 * The `u=` param holds the base64 (URL-safe, sometimes prefixed `a1`) real
 * URL. Decode it when present so the model gets the actual destination
 * (fetchable via web_fetch) instead of a bing.com redirect. Mirrors the Rust
 * resolve_bing_ck_url. */
export function resolveBingCkUrl(url: string): string {
  const idx = url.indexOf('u=');
  if (idx === -1) return url;
  const after = url.slice(idx + 2);
  const end = Math.min(...['&', '#'].map(c => after.indexOf(c)).filter(i => i !== -1), after.length);
  const b64raw = after.slice(0, end).trim();
  if (!b64raw) return url;
  const decoded = percentDecode(b64raw);
  const candidates = [decoded, decoded.startsWith('a1') ? decoded.slice(2) : ''];
  for (const cand of candidates) {
    if (!cand) continue;
    const normalized = cand.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    try {
      const s = new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0)));
      if (s.startsWith('http')) return s;
    } catch { /* not valid base64 → try next */ }
  }
  return url;
}

// ── RSS/Atom parsing (shared with the web_public_api news intent) ──

export interface RssItem { title: string; link: string; date: string; description: string; }

function cleanXmlText(s: string): string {
  return s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
}

/** Parse RSS/Atom <item>/<entry> blocks (no XML dependency, mirrors the
 * regex-based HTML parsers elsewhere in the codebase). */
export function parseRssItems(xml: string, maxItems = 8): RssItem[] {
  const items: RssItem[] = [];
  const re = /<(item|entry)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && items.length < maxItems) {
    const block = m[2];
    const pick = (tag: string): string => {
      const mm = block.match(new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return mm ? cleanXmlText(mm[1]) : '';
    };
    const title = pick('title');
    const link = pick('link').trim();
    if (!title) continue;
    items.push({ title, link, date: pick('pubDate') || pick('published') || pick('updated'), description: pick('description') || pick('summary') });
  }
  return items;
}

// ── Key-bearing API backends (direct deps.fetchPage, no cookie jar) ──

/**
 * Serper.dev Google SERP API backend: a real Google index — the best quality
 * for both Chinese and English, captcha-free. ~2500 free trial queries, then
 * prepaid credits (~$0.3–1 per 1k). Enabled when SERPER_API_KEY is set;
 * throws otherwise so callers degrade to Tavily / scraping. Mirrors the Rust
 * search_backend_serper in lib.rs (same gl/hl selection for CJK).
 */
export async function serperSearch(query: string, maxResults: number, deps: SearchNetDeps): Promise<SearchResult[]> {
  const apiKey = deps.env('SERPER_API_KEY');
  if (!apiKey) throw new Error('SERPER_API_KEY not set');
  const cjk = containsCJK(query);
  const r = await deps.fetchPage('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({
      q: query,
      gl: cjk ? 'cn' : 'us',
      hl: cjk ? 'zh-cn' : 'en',
      num: maxResults,
    }),
    timeoutMs: 10000,
  });
  assertOk(r);
  const data: { organic?: Array<{ title?: string; link?: string; snippet?: string }> } = JSON.parse(decodeBody(r));
  return (data.organic ?? [])
    .filter((x) => x.title && x.link)
    .map((x) => ({ title: x.title!, snippet: x.snippet ?? '', url: x.link! }));
}

/**
 * Tavily Search API backend (used by Claude Code / opencode-class agents):
 * stable index, captcha-free, good Chinese coverage. Enabled when
 * TAVILY_API_KEY is set; throws otherwise so callers degrade to scraping.
 */
export async function tavilySearch(query: string, maxResults: number, deps: SearchNetDeps): Promise<SearchResult[]> {
  const apiKey = deps.env('TAVILY_API_KEY');
  if (!apiKey) throw new Error('TAVILY_API_KEY not set');
  const r = await deps.fetchPage('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
    }),
    timeoutMs: 10000,
  });
  assertOk(r);
  const data: { results?: Array<{ title?: string; url?: string; content?: string }> } = JSON.parse(decodeBody(r));
  return (data.results ?? [])
    .filter((x) => x.title && x.url)
    // snippet 帽 600 字符（对齐 Exa 后端 maxCharacters）：content 字段是
    // 页面级正文，不裁的话 20 条结果能把单次搜索塞进数万字符。
    .map((x) => ({ title: x.title!, snippet: (x.content ?? '').slice(0, 600), url: x.url! }));
}

/**
 * Exa neural-search backend: semantic + keyword hybrid search with page
 * contents and publish dates. Free tier = $20 signup credits (~2,800
 * searches) plus $10 in credits every month, no payment method required.
 * Enabled when EXA_API_KEY is set; throws otherwise so callers degrade to
 * the free HTML backends.
 */
export async function exaSearch(query: string, maxResults: number, deps: SearchNetDeps): Promise<SearchResult[]> {
  const apiKey = deps.env('EXA_API_KEY');
  if (!apiKey) throw new Error('EXA_API_KEY not set');
  const r = await deps.fetchPage('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      query,
      numResults: maxResults,
      type: 'auto',
      contents: { text: { maxCharacters: 600 } },
    }),
    timeoutMs: 10000,
  });
  assertOk(r);
  const data: { results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string }> } = JSON.parse(decodeBody(r));
  return (data.results ?? [])
    .filter((x) => x.title && x.url)
    .map((x) => {
      const date = typeof x.publishedDate === 'string' && x.publishedDate ? ` (${x.publishedDate.slice(0, 10)})` : '';
      return { title: `${x.title}${date}`, snippet: x.text ?? '', url: x.url! };
    });
}

/** SearXNG metasearch backend (opt-in via SEARXNG_URL): intranet /
 * self-hosted instances aggregate dozens of upstream engines behind one JSON
 * endpoint — the standard answer for corporate or offline networks where
 * every public engine is blocked. Expects an instance with JSON format
 * enabled (settings.yml `formats: [html, json]`). Mirrors the Rust
 * search_backend_searxng in lib.rs. */
export async function searxngSearch(query: string, maxResults: number, deps: SearchNetDeps): Promise<SearchResult[]> {
  const base = deps.env('SEARXNG_URL');
  if (!base) throw new Error('SEARXNG_URL not set');
  const r = await deps.fetchPage(
    `${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0`,
    {
      headers: { 'User-Agent': BROWSER_UA },
      timeoutMs: 10000,
    },
  );
  assertOk(r);
  const data: { results?: Array<{ title?: string; url?: string; content?: string }> } = JSON.parse(decodeBody(r));
  return (data.results ?? [])
    .filter((x) => x.title && x.url)
    // snippet 帽 600 字符（对齐 Exa 后端 maxCharacters）：content 字段是
    // 页面级正文，不裁的话 20 条结果能把单次搜索塞进数万字符。
    .map((x) => ({ title: x.title!, snippet: (x.content ?? '').slice(0, 600), url: x.url! }));
}

// ── Structured free backends (cookie-jar fetches, no key) ──

/** Google News RSS backend (free, no key): recent news matching the query in
 * structured RSS. Reachable on more networks than full search engines, and the
 * parser is shared with the web_public_api news intent. News-leaning results —
 * the relevance gate drops them for off-topic queries. Mirrors Rust
 * search_backend_google_news_rss. */
export async function googleNewsSearch(query: string, maxResults: number, deps: SearchNetDeps): Promise<SearchResult[]> {
  const cjk = containsCJK(query);
  const hl = cjk ? 'zh-CN' : 'en-US';
  const gl = cjk ? 'CN' : 'US';
  const ceid = cjk ? 'CN:zh-Hans' : 'US:en';
  const r = await fetchViaJar(deps,
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`,
    { headers: { 'User-Agent': BROWSER_UA }, timeoutMs: 8000 },
  );
  assertOk(r);
  const items = parseRssItems(decodeBody(r), maxResults);
  return items.map((item) => ({ title: item.title, snippet: item.description, url: item.link }));
}

/** DuckDuckGo Instant Answer API (free, no key): structured facts/definitions
 * for direct queries ("what is X"). Returns zero results for non-answer
 * queries, so it is a cheap structured tier that drops out harmlessly. Mirrors
 * Rust search_backend_ddg_instant. */
export async function ddgInstantSearch(query: string, maxResults: number, deps: SearchNetDeps): Promise<SearchResult[]> {
  const r = await fetchViaJar(deps,
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    { headers: { 'User-Agent': BROWSER_UA }, timeoutMs: 8000 },
  );
  assertOk(r);
  const data = JSON.parse(decodeBody(r)) as {
    Heading?: string; AbstractText?: string; AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };
  const out: SearchResult[] = [];
  if (data.AbstractText && data.AbstractURL) {
    out.push({ title: data.Heading || query, snippet: data.AbstractText, url: data.AbstractURL });
  }
  const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
  for (const topic of related) {
    if (!topic || typeof topic !== 'object') continue;
    if (Array.isArray(topic.Topics)) {
      for (const sub of topic.Topics) {
        if (sub?.Text && sub.FirstURL && out.length < maxResults) {
          out.push({ title: sub.Text.slice(0, 80), snippet: sub.Text, url: sub.FirstURL });
        }
      }
    } else if (topic.Text && topic.FirstURL && out.length < maxResults) {
      out.push({ title: topic.Text.slice(0, 80), snippet: topic.Text, url: topic.FirstURL });
    }
  }
  return out;
}

/** Wikipedia search API (free, no key): fact-oriented page hits. Snippets come
 * with `<span class="searchmatch">` highlights — stripped here. CJK queries hit
 * zh.wikipedia.org. Mirrors Rust search_backend_wikipedia. */
export async function wikipediaSearch(query: string, maxResults: number, deps: SearchNetDeps): Promise<SearchResult[]> {
  const cjk = containsCJK(query);
  const host = cjk ? 'zh.wikipedia.org' : 'en.wikipedia.org';
  const r = await fetchViaJar(deps,
    `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${Math.min(maxResults, 10)}`,
    { headers: { 'User-Agent': BROWSER_UA }, timeoutMs: 8000 },
  );
  assertOk(r);
  const data = JSON.parse(decodeBody(r)) as { query?: { search?: Array<{ title?: string; snippet?: string }> } };
  const hits = data.query?.search ?? [];
  const out: SearchResult[] = [];
  for (const hit of hits) {
    if (out.length >= maxResults) break;
    const title = String(hit.title ?? '').trim();
    if (!title) continue;
    const snippet = stripHtml(String(hit.snippet ?? '')).trim();
    out.push({ title, snippet, url: `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` });
  }
  return out;
}

// ── Jina Reader last-resort backends ──

/** Shared Jina Reader render: fetch <engineUrl><encodedQuery> through
 * r.jina.ai (free tier, PURE_JINA_API_KEY raises limits) and parse the
 * returned markdown into results. Used by every last-resort engine. */
async function jinaRenderSearch(query: string, maxResults: number, engineUrl: string, deps: SearchNetDeps): Promise<SearchResult[]> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    'X-Return-Format': 'markdown',
    Accept: 'text/plain',
  };
  const apiKey = deps.env('PURE_JINA_API_KEY');
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const r = await fetchViaJar(deps, `https://r.jina.ai/${engineUrl}${encodeURIComponent(query)}`, {
    headers,
    timeoutMs: 15000,
  });
  assertOk(r);
  return parseJinaMarkdownResults(decodeBody(r), maxResults);
}

/** Last-resort universal backends: Bing / Google / DuckDuckGo rendered through
 * Jina Reader (`r.jina.ai`, free tier ~20 req/min, no key). Jina fetches each
 * engine from its own infrastructure, so this works when every local engine is
 * blocked or rate-limited (China / restrictive networks), as long as r.jina.ai
 * itself is reachable. Tried in sequence, Bing first. Mirrors the Rust
 * search_backend_jina_bing / search_backend_jina_google / search_backend_jina_ddg. */
export async function jinaBingSearch(query: string, maxResults: number, deps: SearchNetDeps): Promise<SearchResult[]> {
  return jinaRenderSearch(query, maxResults, 'https://www.bing.com/search?q=', deps);
}
export async function jinaGoogleSearch(query: string, maxResults: number, deps: SearchNetDeps): Promise<SearchResult[]> {
  return jinaRenderSearch(query, maxResults, 'https://www.google.com/search?q=', deps);
}
export async function jinaDuckDuckGoSearch(query: string, maxResults: number, deps: SearchNetDeps): Promise<SearchResult[]> {
  return jinaRenderSearch(query, maxResults, 'https://html.duckduckgo.com/html/?q=', deps);
}

// ── CJK routing + relevance gate ──

/** True when the query contains CJK ideographs (CJK Unified Ideographs, CJK
 * Extension A, and CJK Compatibility Ideographs) — the trigger for routing a
 * search through the China Bing backend (cn.bing.com) first. Mirrors
 * src-tauri/src/lib.rs `is_chinese_query`; both sides have matching tests. */
export function containsCJK(query: string): boolean {
  return /[㐀-䶿一-鿿豈-﫿]/.test(query);
}

/** Chars that glue Chinese queries together (particles / prepositions /
 * function words) — a CJK bigram containing one is NOT a meaningful content
 * token ("西安到重庆" keeps 西安/重庆; 安到/到重 are dropped). Content words like
 * 时间/价格/大小 are deliberately NOT here — they are what relevance is
 * measured against. Mirrors src-tauri/src/lib.rs `significant_cjk_bigrams`
 * (same table, same semantics). */
const CJK_FUNCTION_CHARS = new Set(
  // Particles / prepositions / function words that glue CJK queries together.
  // Direction/position words (上下左右前后内外中) are deliberately ABSENT — 上/中
  // etc. start too many content words (上海/中国) for them to be safe to drop.
  '到从的与和及了在是这那之而或把被让为对于等些个吗呢吧啊呀过并但可就最很也都' +
  '不没无来去要将会正已经还又请问想有里给做用得着所以且者起向往自从于对'.split(''),
);

function isCJKChar(c: string): boolean {
  return /[㐀-䶿一-鿿豈-﫿]/.test(c);
}

/** Significant CJK content bigrams of a query (deduped, glue chars dropped).
 * Mirrors the Rust side; exported for the mirror tests. */
export function significantCJKBigrams(query: string): string[] {
  const chars = [...query];
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) {
    const a = chars[i];
    const b = chars[i + 1];
    if (isCJKChar(a) && isCJKChar(b) && !CJK_FUNCTION_CHARS.has(a) && !CJK_FUNCTION_CHARS.has(b)) {
      out.add(a + b);
    }
  }
  return [...out];
}

/** Relevance gate: accept a backend's result set only if the top-5 results
 * actually address the query. For CJK queries this means covering the query's
 * significant bigrams (cn.bing.com returning Xi'an tourism guides for
 * "西安到重庆 机票" covers only 西安 → 1/3 → REJECTED, so the chain rolls over
 * instead of handing the model garbage that triggers repeated searches).
 * Accept when ≥2 distinct bigrams are covered, or ≥ half of a short query's
 * bigrams. Non-CJK queries and queries with <2 significant bigrams are always
 * accepted. Mirrors src-tauri/src/lib.rs `results_relevant`. */
export function resultsRelevant(query: string, results: SearchResult[]): boolean {
  const sig = significantCJKBigrams(query);
  if (sig.length < 2) return true;
  const covered = new Set<string>();
  for (const r of results.slice(0, 5)) {
    const hay = `${r.title}\n${r.snippet}\n${r.url}`;
    for (const bg of sig) {
      if (hay.includes(bg)) covered.add(bg);
    }
  }
  if (covered.size >= 2) return true;
  return covered.size / sig.length >= 0.5;
}

/** Drop duplicate results (same URL or same title) — search pages repeat
 * entries across sections, and duplicated titles confuse the LLM. */
export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter(r => {
    const key = r.url || r.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Strip search operators / quotes / punctuation for a lighter retry query.
 * When every backend fails on a syntactically heavy query (quotes, colons,
 * parens, site: filters), one normalized retry often succeeds — engines are
 * picky about operators and punctuation, and the model shouldn't have to
 * rephrase by hand. Returns null when nothing would change. Mirrors the Rust
 * normalize_query_for_retry. */
export function normalizeQueryForRetry(query: string): string | null {
  const operators = /^(site|filetype|inurl|intitle|intext|lang|before|after|define):/i;
  const filtered = query.split(/\s+/).filter(w => !operators.test(w));
  const cleaned = filtered.join(' ')
    .replace(/["'()（）\[\]{}:|~!?，。？！、；：]/g, ' ');
  const joined = cleaned.split(/\s+/).filter(Boolean).join(' ').trim();
  if (!joined || joined === query) return null;
  return joined;
}

// ── Orchestration helpers ──

/** Human-readable list of the actually-configured backends for the
 * no-results guidance the model feeds back on (mirrors the Rust
 * configured_backend_names). */
export function searchBackendNames(cjk: boolean, env: EnvFn): string {
  const names: string[] = [
    ...(env('SERPER_API_KEY') ? ['Serper'] : []),
    ...(env('TAVILY_API_KEY') ? ['Tavily'] : []),
    ...(env('EXA_API_KEY') ? ['Exa'] : []),
    ...(env('SEARXNG_URL') ? ['SearXNG'] : []),
    'DuckDuckGo Instant',
    'Wikipedia',
    'Google News RSS',
    ...(cjk ? ['Sogou', 'cn.bing.com', '360', 'Baidu'] : []),
    'DuckDuckGo',
    'Bing',
    ...(cjk ? [] : ['Brave', 'Mojeek']),
  ];
  return names.join(', ');
}

/** Wrap a free-HTML-backend fetch so a failure puts the backend into a short
 * cooldown (30s) — a captcha-walled or geo-blocked engine is otherwise
 * re-probed on every query, wasting latency on a dead endpoint. */
function guarded(label: string, fetch: () => Promise<SearchResult[]>): () => Promise<SearchResult[]> {
  return async () => {
    try {
      return await fetch();
    } catch (err) {
      quota.markBlocked(label, 30_000);
      throw err;
    }
  };
}

/**
 * Probe all HTML backends concurrently and return the first result set that
 * passes the relevance gate ("first win"). A backend that errors, returns
 * empty, or fails the gate just drops out; if none survives, the aggregated
 * failure info lets the caller compose the right message. O(backends) memory
 * for the pending-promise set is fine (≤4 backends).
 */
export async function firstRelevantResult(
  query: string,
  backends: Array<{ label: string; fetch: () => Promise<SearchResult[]> }>,
): Promise<{ results?: SearchResult[]; failed: string[]; anyEmpty: boolean; irrelevant: number }> {
  const failed: string[] = [];
  let anyEmpty = false;
  let irrelevant = 0;
  let pending = backends.map((b, i) =>
    b.fetch().then(
      (r) => ({ i, r }),
      (err: unknown) => ({ i, error: err instanceof Error ? err.message : String(err) }),
    ),
  );
  while (pending.length > 0) {
    // Race the current pending set; the resolved VALUE carries the ORIGINAL
    // backend index (captured at creation) while pendingIndex is the index
    // within the CURRENT (shrinking) array — the two must stay separate so
    // removing a finished task never mislabels a later one.
    const { value, pendingIndex } = await Promise.race(
      pending.map((p, idx) => p.then((v) => ({ value: v, pendingIndex: idx }))),
    );
    pending = pending.filter((_, k) => k !== pendingIndex);
    if ('error' in value) {
      failed.push(`${backends[value.i].label}: ${value.error}`);
      continue;
    }
    if (value.r.length > 0) {
      // Relevance gate: a set that does not address the query must not be
      // handed to the model — it is what pushed the agent into repeated
      // searches. Gated-out sets drop out like empty ones.
      if (resultsRelevant(query, value.r)) {
        return { results: dedupeResults(value.r), failed, anyEmpty, irrelevant };
      }
      irrelevant += 1;
    } else {
      anyEmpty = true;
    }
  }
  return { failed, anyEmpty, irrelevant };
}

// ── HTML result parsers ──
// All mirrors of the Rust parsers in src-tauri/src/lib.rs; the mirror tests
// (searchParser.test.ts ↔ Rust web_search_tests) lock the shared behavior.

// ── Sogou HTML result parser (CJK-priority backend) ──

/** Parse Sogou results (`<h3 class="vr-title …">` blocks with a single
 * `<a href="…">TITLE</a>`, snippet in the block's trailing
 * `<p class="star-wiki …">` or `<div class="fz-mid space-txt">`). Sogou
 * highlights matched terms with `<em><!--red_beg-->…<!--red_end--></em>` inside
 * titles — the title is stripped to `</a>` (NOT to the first '<' like the Bing
 * parser, whose titles have no nested tags). `/link?url=…` redirects are
 * absolutized to `https://www.sogou.com/…` so the model can still web_fetch
 * them. Dedupes by URL/title. Mirrors src-tauri/src/lib.rs
 * `parse_sogou_results` — both sides have matching tests. */
export function parseSogouResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  let pos = 0;
  while (results.length < maxResults) {
    const relH3 = html.indexOf('<h3', pos);
    if (relH3 === -1) break;
    // Block = this <h3> through the start of the next <h3> (or end of page):
    // the anchor/title live inside the h3, while the snippet container
    // (<p class="star-wiki"> / <div class="fz-mid space-txt">) sits right
    // AFTER </h3>, before the next result block.
    const afterH3 = relH3 + 3;
    const nextRel = html.indexOf('<h3', afterH3);
    const nextH3 = nextRel === -1 ? html.length : nextRel;
    const block = html.slice(relH3, nextH3);
    const parsed = parseSogouBlock(block);
    if (parsed && !results.some(x => x.url === parsed.url || x.title === parsed.title)) {
      results.push(parsed);
    }
    pos = nextH3;
  }
  return results;
}

function parseSogouBlock(block: string): SearchResult | undefined {
  const aIdx = block.indexOf('<a');
  if (aIdx === -1) return undefined;
  const rawUrl = extractHref(block, aIdx);
  if (!rawUrl) return undefined;
  // Absolutize Sogou's relative redirect links (/link?url=…, //www.sogou.com/…).
  let url = rawUrl;
  if (url.startsWith('//')) url = `https:${url}`;
  else if (url.startsWith('/')) url = `https://www.sogou.com${url}`;

  // Title: anchor text, stripped to </a> — Sogou bolds matched terms with <em>
  // INSIDE the title text, so stripping to the first '<' would cut the title
  // short; strip tags and keep everything up to </a>.
  const afterA = block.slice(aIdx);
  const gt = afterA.indexOf('>');
  if (gt === -1) return undefined;
  const afterGt = afterA.slice(gt + 1);
  const anchorEnd = afterGt.indexOf('</a>');
  if (anchorEnd === -1) return undefined;
  const title = decodeHtmlEntities(stripHtml(afterGt.slice(0, anchorEnd))).trim();

  // Snippet: star-wiki <p> first (organic results), else the fz-mid div
  // (zhihu/other layouts). Both sit after the anchor inside the h3 block.
  let snippet = '';
  const region = afterGt.slice(anchorEnd + '</a>'.length);
  const star = region.indexOf('<p class="star-wiki');
  if (star !== -1) {
    const afterStar = region.slice(star);
    const starGt = afterStar.indexOf('>');
    if (starGt !== -1) {
      const content = afterStar.slice(starGt + 1);
      const end = content.indexOf('</p>');
      if (end !== -1) snippet = content.slice(0, end);
    }
  } else {
    // fz-mid div (zhihu/other layouts). Substring search so a reordered class
    // list ("space-txt fz-mid") still matches; the star-wiki <p> was already
    // ruled out above, so a stray match here is a genuine snippet container.
    const fz = region.indexOf('fz-mid');
    if (fz !== -1) {
      const afterFz = region.slice(fz);
      const fzGt = afterFz.indexOf('>');
      if (fzGt !== -1) {
        const content = afterFz.slice(fzGt + 1);
        const end = content.indexOf('</div>');
        if (end !== -1) snippet = content.slice(0, end);
      }
    }
  }
  snippet = decodeHtmlEntities(stripHtml(snippet)).trim();

  if (!title || !url) return undefined;
  return { title, snippet, url };
}

/** Parse 360 Search (so.com) results (`<li class="res-list">` blocks with a
 * `<h3 class="res-title"><a data-mdurl="REAL_URL" href="…">TITLE</a></h3>`
 * title and a `<p class="res-desc">` snippet). `data-mdurl` carries the real
 * destination (the href is a /link?m=… redirect), so it wins; otherwise the
 * href is absolutized. Mirrors src-tauri/src/lib.rs `parse_so360_results`. */
export function parseSo360Results(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const marker = '<li class="res-list';
  let rest = html;
  while (results.length < maxResults) {
    const idx = rest.indexOf(marker);
    if (idx === -1) break;
    const tail = rest.slice(idx);
    const next = tail.indexOf(marker, marker.length);
    const end = next === -1 ? tail.length : next;
    const block = tail.slice(0, end);
    const parsed = parseSo360Block(block);
    if (parsed) results.push(parsed);
    rest = tail.slice(end);
  }
  return results;
}

function parseSo360Block(block: string): SearchResult | undefined {
  const titleStart = block.indexOf('res-title');
  if (titleStart === -1) return undefined;
  const relA = block.slice(titleStart).indexOf('<a');
  if (relA === -1) return undefined;
  const aIdx = titleStart + relA;
  const rawHref = extractHref(block, aIdx);
  if (rawHref === undefined) return undefined;
  // data-mdurl holds the real URL when present (modern markup); else the
  // href is a /link?m=… redirect we absolutize.
  const url = extractAttr(block, 'data-mdurl')
    ?? (rawHref.startsWith('//') ? `https:${rawHref}`
      : rawHref.startsWith('/') ? `https://www.so.com${rawHref}`
      : rawHref);

  const afterA = block.slice(aIdx);
  const gt = afterA.indexOf('>');
  if (gt === -1) return undefined;
  const afterGt = afterA.slice(gt + 1);
  const anchorEnd = afterGt.indexOf('</a>');
  if (anchorEnd === -1) return undefined;
  const title = decodeHtmlEntities(stripHtml(afterGt.slice(0, anchorEnd))).trim();
  if (!title || !url) return undefined;

  // Snippet: <p class="res-desc">…</p> (organic) — the span inside is
  // stripped too. res-desc IS the <p> tag's class, so the content starts at
  // the tag's '>' after the class name.
  let snippet = '';
  const d = block.indexOf('res-desc');
  if (d !== -1) {
    const afterD = block.slice(d);
    const gt = afterD.indexOf('>');
    if (gt !== -1) {
      const content = afterD.slice(gt + 1);
      const end = content.indexOf('</p>');
      if (end !== -1) snippet = decodeHtmlEntities(stripHtml(content.slice(0, end))).trim();
    }
  }

  return { title, snippet, url };
}

/** Parse Baidu results (best-effort — Baidu serves a captcha to cookie-less
 * or foreign clients, so this backend degrades gracefully to the next one).
 * Blocks are `<div class="result c-container …">`; title from
 * `<h3 class="t"><a href="…">TITLE</a></h3>` (or the `data-tools` JSON on
 * some blocks), snippet from `.content-right_…` / `.c-abstract` / `.c-span-last`.
 * Mirrors src-tauri/src/lib.rs `parse_baidu_results`. */
export function parseBaiduResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const marker = 'class="result c-container';
  let rest = html;
  while (results.length < maxResults) {
    const idx = rest.indexOf(marker);
    if (idx === -1) break;
    const tail = rest.slice(idx);
    const next = tail.indexOf(marker, marker.length);
    const end = next === -1 ? tail.length : next;
    const block = tail.slice(0, end);
    const parsed = parseBaiduBlock(block);
    if (parsed) results.push(parsed);
    rest = tail.slice(end);
  }
  return results;
}

function parseBaiduBlock(block: string): SearchResult | undefined {
  // data-tools='{"title":"…","url":"…"}' is the most reliable source on
  // modern Baidu markup; fall back to the h3 anchor.
  let title = '';
  let url = '';
  const tools = extractAttr(block, 'data-tools');
  if (tools) {
    try {
      const v = JSON.parse(tools.replace(/&quot;/g, '"'));
      title = String(v.title ?? '');
      url = String(v.url ?? '');
    } catch { /* malformed JSON → fall through to h3 */ }
  }
  if (!url) {
    const h3 = block.indexOf('<h3');
    if (h3 !== -1) {
      const afterH3 = block.slice(h3);
      const aIdx = afterH3.indexOf('<a');
      if (aIdx !== -1) {
        url = extractHref(afterH3, aIdx) ?? '';
        const afterA = afterH3.slice(aIdx);
        const gt = afterA.indexOf('>');
        if (gt !== -1) {
          const afterGt = afterA.slice(gt + 1);
          const end = afterGt.indexOf('</a>');
          if (end !== -1) title = decodeHtmlEntities(stripHtml(afterGt.slice(0, end))).trim();
        }
      }
    }
  }
  // Snippet: content-right… / c-abstract / c-span-last containers.
  let snippet = '';
  for (const needle of ['content-right', 'c-abstract', 'c-span-last']) {
    const i = block.indexOf(needle);
    if (i === -1) continue;
    const after = block.slice(i);
    const gt = after.indexOf('>');
    if (gt === -1) continue;
    const content = after.slice(gt + 1);
    const divEnd = content.indexOf('</div>');
    const spanEnd = content.indexOf('</span>');
    const end = divEnd === -1 ? (spanEnd === -1 ? content.length : spanEnd) : (spanEnd === -1 ? divEnd : Math.min(divEnd, spanEnd));
    const s = decodeHtmlEntities(stripHtml(content.slice(0, end))).trim();
    if (s) {
      snippet = s;
      break;
    }
  }
  title = title.trim();
  if (!title || !url) return undefined;
  return { title, snippet, url: decodeHtmlEntities(url) };
}

/** Parse Brave Search results (`<div class="snippet …" data-type="web">`
 * blocks with a `title search-snippet-title` div — the anchor URL lives
 * earlier in the block — and a `generic-snippet` paragraph). The svelte hash
 * suffixes rotate across Brave builds, so blocks are matched on the stable
 * `class="snippet ` prefix and the `search-snippet-title` / `generic-snippet`
 * substrings. Mirrors src-tauri/src/lib.rs `parse_brave_results`. */
export function parseBraveResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const marker = 'class="snippet ';
  let rest = html;
  while (results.length < maxResults) {
    const idx = rest.indexOf(marker);
    if (idx === -1) break;
    const tail = rest.slice(idx);
    const next = tail.indexOf(marker, marker.length);
    const end = next === -1 ? tail.length : next;
    const block = tail.slice(0, end);
    const parsed = parseBraveBlock(block);
    if (parsed) results.push(parsed);
    rest = tail.slice(end);
  }
  return results;
}

function parseBraveBlock(block: string): SearchResult | undefined {
  const aIdx = block.indexOf('<a');
  if (aIdx === -1) return undefined;
  const url = extractHref(block, aIdx);
  if (url === undefined) return undefined;

  let title = '';
  const ti = block.indexOf('search-snippet-title');
  if (ti !== -1) {
    const rest = block.slice(ti);
    const gt = rest.indexOf('>');
    if (gt !== -1) {
      const content = rest.slice(gt + 1);
      const end = content.indexOf('<');
      if (end !== -1) title = decodeHtmlEntities(stripHtml(content.slice(0, end))).trim();
    }
  }
  if (!title) return undefined;

  let snippet = '';
  const si = block.indexOf('generic-snippet');
  if (si !== -1) {
    const rest = block.slice(si);
    const gt = rest.indexOf('>');
    if (gt !== -1) {
      const content = rest.slice(gt + 1);
      const end = content.indexOf('</p>');
      if (end !== -1) snippet = decodeHtmlEntities(stripHtml(content.slice(0, end))).trim();
    }
  }

  return { title, snippet, url };
}

/** Parse Bing results (`<li class="b_algo">` blocks): `<h2><a href="…">TITLE</a></h2>`
 * plus a `<p>…</p>` snippet. Mirrors the Rust parser in src-tauri/src/lib.rs — the
 * two MUST stay behaviorally identical (entity decoding, quote handling, block
 * skipping, max cap); tests on both sides lock the shared fixtures. INTENTIONAL
 * divergences: whitespace handling (TS stripHtml collapses block tags to
 * newlines — shared with the DDG/web_fetch paths — while Rust keeps raw
 * whitespace) and unquoted hrefs (TS skips, Rust would parse). Both favor TS
 * in practice and must not be "unified" blindly. */
export function parseBingResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  let rest = html;
  while (results.length < maxResults) {
    const idx = rest.indexOf('<li class="b_algo');
    if (idx === -1) break;
    const tail = rest.slice(idx);
    const liEnd = tail.indexOf('</li>');
    if (liEnd === -1) break;
    const block = tail.slice(0, liEnd + '</li>'.length);
    const parsed = parseBingBlock(block);
    if (parsed) results.push(parsed);
    rest = tail.slice(liEnd + '</li>'.length);
  }
  return results;
}

function parseBingBlock(block: string): SearchResult | undefined {
  // Result link lives inside <h2>: find <h2>, then the first <a after it.
  const h2 = block.indexOf('<h2');
  if (h2 === -1) return undefined;
  const afterH2 = block.slice(h2);
  const aIdx = afterH2.indexOf('<a');
  if (aIdx === -1) return undefined;
  const url = extractHref(afterH2, aIdx);
  if (url === undefined) return undefined;

  // Title: text between the anchor's '>' and the next '<'. A block whose
  // anchor never closes is skipped entirely (mirrors the Rust `?` on find).
  const afterA = afterH2.slice(aIdx);
  const gt = afterA.indexOf('>');
  if (gt === -1) return undefined;
  const afterGt = afterA.slice(gt + 1);
  const titleEnd = afterGt.indexOf('<');
  if (titleEnd === -1) return undefined;
  const title = decodeHtmlEntities(stripHtml(afterGt.slice(0, titleEnd))).trim();
  if (!title || !url) return undefined;

  // Snippet: first <p ...>…</p> in the block. Decoded like the title so
  // numeric/named entities in Bing snippets (&#0183; middle dots, &ensp;)
  // render as characters, matching the Rust parser.
  let snippet = '';
  const pIdx = block.indexOf('<p');
  if (pIdx !== -1) {
    const afterP = block.slice(pIdx);
    const pGt = afterP.indexOf('>');
    if (pGt !== -1) {
      const content = afterP.slice(pGt + 1);
      const pEnd = content.indexOf('</p>');
      if (pEnd !== -1) snippet = decodeHtmlEntities(stripHtml(content.slice(0, pEnd))).trim();
    }
  }

  return { title, snippet, url };
}

/** Parse DuckDuckGo HTML results (`<div class="result">` blocks containing
 * `<a class="result__a" href="…">TITLE</a>` plus a
 * `<div class="result__snippet">…</div>`). Exported for the mirror tests in
 * searchParser.test.ts, which lock behavior against the Rust parser
 * (src-tauri/src/lib.rs parse_duckduckgo_results). */
export function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Parse DuckDuckGo HTML search: each result is in a div with class "result"
  const resultBlockRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result|$)/gi;
  const blocks = html.match(resultBlockRegex);
  if (!blocks) return results;

  for (const block of blocks) {
    if (results.length >= maxResults) break;

    // Extract title + URL from <a class="result__a" href="...">Title</a>
    const linkMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const url = decodeHtmlEntities(linkMatch[1].trim());
    const title = decodeHtmlEntities(stripHtml(linkMatch[2])).trim();

    if (!title || !url) continue;

    // Extract snippet from <a class="result__snippet">
    const snippetMatch = block.match(/<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
    const snippet = snippetMatch ? decodeHtmlEntities(stripHtml(snippetMatch[1])).trim() : '';

    results.push({ title, snippet, url });
  }

  return results;
}

/** Parse Mojeek results (`<li class="result">` blocks with an `<a class="title">`
 * or `<a class="ob">` anchor and a `<p class="s">` snippet). Mojeek is an
 * independent, bot-friendly index serving clean HTML — a useful extra non-CJK
 * backend. Mirrors the Rust parse_mojeek_results. */
export function parseMojeekResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const marker = '<li class="result';
  let rest = html;
  while (results.length < maxResults) {
    const idx = rest.indexOf(marker);
    if (idx === -1) break;
    const tail = rest.slice(idx);
    const next = tail.indexOf(marker, marker.length);
    const end = next === -1 ? tail.length : next;
    const block = tail.slice(0, end);
    const parsed = parseMojeekBlock(block);
    if (parsed) results.push(parsed);
    rest = tail.slice(end);
  }
  return results;
}

function parseMojeekBlock(block: string): SearchResult | undefined {
  const aMatch = block.match(/<a[^>]*class="[^"]*(?:title|ob)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  if (!aMatch) return undefined;
  const url = decodeHtmlEntities(aMatch[1].trim());
  const title = decodeHtmlEntities(stripHtml(aMatch[2])).trim();
  if (!title || !url) return undefined;
  let snippet = '';
  const sMatch = block.match(/<p[^>]*class="[^"]*s[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  if (sMatch) snippet = decodeHtmlEntities(stripHtml(sMatch[1])).trim();
  return { title, snippet, url };
}

/** Parse Jina Reader (r.jina.ai) markdown output — the last-resort backend
 * renders `https://www.bing.com/search?q=…` from Jina's infrastructure and
 * returns clean markdown, so it works even when every local engine is
 * blocked (China / restrictive networks) as long as r.jina.ai is reachable.
 * Results are `## [Title](url)` headings (optionally numbered) followed by a
 * snippet paragraph. Mirrors src-tauri/src/lib.rs `parse_jina_markdown_results`. */
export function parseJinaMarkdownResults(text: string, maxResults: number): SearchResult[] {
  const lines = text.split('\n');
  const out: SearchResult[] = [];
  const heading = /^\s*(?:\d+\.\s+)?#{1,4}\s*\[([^\]]+)\]\(([^)]+)\)\s*$/;
  for (let i = 0; i < lines.length && out.length < maxResults; i++) {
    const m = lines[i].match(heading);
    if (!m) continue;
    const title = m[1].replace(/\*\*/g, '').trim();
    const url = resolveBingCkUrl(m[2]);
    // Snippet: the next non-empty, non-heading line.
    let snippet = '';
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (!t) {
        j += 1;
        continue;
      }
      if (t.startsWith('#')) break;
      snippet = t;
      break;
    }
    if (title && url) out.push({ title, snippet, url });
  }
  return out;
}

// ── The orchestration (8 layers, CLI caliber) ──

/**
 * Run one web_search end to end. Layer order — each layer only runs when the
 * previous one produced nothing:
 *   cache → Serper → Tavily → Exa → SearXNG → structured trio (parallel,
 *   first relevant win) → HTML engines (parallel, first relevant win) → one
 *   normalized retry → Jina Reader (sequential last resort).
 * Pure logic over `deps`: the adapters wrap {@link WebSearchOutcome} into
 * their own ToolResult (cache hits carry a `[cached] ` prefix in output).
 */
export interface WebSearchOptions {
  /**
   * 换路重试轮（GUI runRoutedSurface 的第 2+ 次尝试）跳过后端冷却：冷却
   * 记录的是「该网络路径下此刚失败」，换代理后未必还失败；若后端真被封，
   * 这一轮再失败会重新入冷却（只多一轮，不放大伤害）。NA 单轮编排不传。
   */
  ignoreCooldown?: boolean;
}

export async function runWebSearch(
  query: string,
  maxResults: number,
  deps: WebSearchDeps,
  options?: WebSearchOptions,
): Promise<WebSearchOutcome> {
  const cjk = containsCJK(query);
  const cooldownActive = (label: string): boolean =>
    options?.ignoreCooldown !== true && quota.isBlocked(label);

  // Result cache: identical queries inside an agent loop (or across CLI/GUI
  // sessions) hit the shared ~/.pure/cache/web-cache.json instead of burning
  // free-tier quota or re-hitting rate-limited backends.
  const cacheKey = searchCacheKey(query, maxResults);
  const cached = deps.cacheGet ? await deps.cacheGet(cacheKey) : undefined;
  if (cached !== undefined && cached !== null) {
    return { ok: true, output: `[cached] ${cached}` };
  }

  // 1) Serper API backend (real Google index — best quality for Chinese AND
  // English): opt-in via the SERPER_API_KEY env var. Each API backend is
  // guarded by BackendQuota: a failed/over-budget backend goes into cooldown
  // instead of being retried on every query (free tiers die silently).
  let results: SearchResult[] = [];
  const failed: string[] = [];
  let anyEmpty = false;
  let irrelevant = 0;
  if (deps.env('SERPER_API_KEY') && !cooldownActive('serper')) {
    try {
      const r = await serperSearch(query, maxResults, deps);
      if (quota.registerUse('serper', 60_000, 20)) quota.markBlocked('serper', 60_000);
      if (r.length > 0) {
        if (!cjk || resultsRelevant(query, r)) results = dedupeResults(r);
        else irrelevant += 1;
      } else {
        anyEmpty = true;
      }
    } catch (err: unknown) {
      quota.markBlocked('serper', 300_000);
      failed.push(`Serper: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2) Tavily API backend (the approach Claude Code / opencode use): opt-in
  // via the TAVILY_API_KEY env var. On failure or (for CJK) a relevance-gated-
  // out set, degrade to the free HTML backends below.
  if (deps.env('TAVILY_API_KEY') && !cooldownActive('tavily')) {
    try {
      const r = await tavilySearch(query, maxResults, deps);
      if (quota.registerUse('tavily', 60_000, 20)) quota.markBlocked('tavily', 60_000);
      if (r.length > 0) {
        // API results are usually on-topic; the CJK relevance gate still
        // applies so a bad API answer degrades to scraping.
        if (!cjk || resultsRelevant(query, r)) results = dedupeResults(r);
        else irrelevant += 1;
      } else {
        anyEmpty = true;
      }
    } catch (err: unknown) {
      quota.markBlocked('tavily', 300_000);
      failed.push(`Tavily: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3) Exa neural-search backend: opt-in via the EXA_API_KEY env var; same
  // cooldown/use-cap treatment as Serper and Tavily.
  if (deps.env('EXA_API_KEY') && !cooldownActive('exa')) {
    try {
      const r = await exaSearch(query, maxResults, deps);
      if (quota.registerUse('exa', 60_000, 30)) quota.markBlocked('exa', 60_000);
      if (r.length > 0) {
        if (!cjk || resultsRelevant(query, r)) results = dedupeResults(r);
        else irrelevant += 1;
      } else {
        anyEmpty = true;
      }
    } catch (err: unknown) {
      quota.markBlocked('exa', 300_000);
      failed.push(`Exa: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4) SearXNG metasearch backend (opt-in via SEARXNG_URL): intranet /
  // self-hosted instances aggregate dozens of upstream engines behind one
  // JSON endpoint — the standard answer for corporate or offline networks
  // where every public engine is blocked. Tried right after the API
  // backends, before scraping.
  if (results.length === 0 && deps.env('SEARXNG_URL') && !cooldownActive('SearXNG')) {
    try {
      const r = await searxngSearch(query, maxResults, deps);
      if (r.length > 0) {
        if (!cjk || resultsRelevant(query, r)) results = dedupeResults(r);
        else irrelevant += 1;
      } else {
        anyEmpty = true;
      }
    } catch (err: unknown) {
      quota.markBlocked('SearXNG', 300_000);
      failed.push(`SearXNG: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 5) Structured free backends (no key): DuckDuckGo Instant Answer,
  // Wikipedia search API, and Google News RSS. Each answers a different query
  // shape (facts/definitions, encyclopedic pages, current news) at near-API
  // quality with no quota — probed in parallel, first relevant set wins.
  // A failed/rate-limited backend sits in cooldown (guarded) so it is not
  // re-probed on every query.
  if (results.length === 0) {
    // 冷却中的 structured 后端直接不进扇出（与 HTML 层 activeBackends、旧
    // Rust backend_blocked 同语义——搬运时曾漏掉这层过滤）。
    const structured: Array<{ label: string; fetch: () => Promise<SearchResult[]> }> = [
      { label: 'DuckDuckGo Instant', fetch: guarded('DuckDuckGo Instant', () => ddgInstantSearch(query, maxResults, deps)) },
      { label: 'Wikipedia', fetch: guarded('Wikipedia', () => wikipediaSearch(query, maxResults, deps)) },
      { label: 'Google News RSS', fetch: guarded('Google News RSS', () => googleNewsSearch(query, maxResults, deps)) },
    ].filter((b) => !cooldownActive(b.label));
    const outcome = await firstRelevantResult(query, structured);
    if (outcome.results) {
      results = outcome.results;
    } else {
      failed.push(...outcome.failed);
      anyEmpty = anyEmpty || outcome.anyEmpty;
      irrelevant += outcome.irrelevant;
    }
  }

  // Free HTML backends, probed IN PARALLEL by firstRelevantResult below
  // (first set that passes the CJK relevance gate wins). CJK queries probe
  // the China-relevant engines — Sogou, cn.bing.com, 360 (so.com), Baidu —
  // plus the international ones as safety nets; non-CJK probes DuckDuckGo,
  // Bing, Brave and Mojeek. All fetches ride the shared cookie jar
  // (fetchViaJar) so session cookies from earlier searches keep anti-bot
  // challenges at bay.
  const backends: Array<{ label: string; fetch: () => Promise<SearchResult[]> }> = [
    ...(cjk
      ? [
          {
            label: 'Sogou',
            fetch: guarded('Sogou', async () => {
              const r = await fetchViaJar(deps, `https://www.sogou.com/web?query=${encodeURIComponent(query)}`, {
                headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
                timeoutMs: 8000,
              });
              assertOk(r);
              return parseSogouResults(decodeBody(r), maxResults);
            }),
          },
          {
            label: 'cn.bing.com',
            fetch: guarded('cn.bing.com', async () => {
              const r = await fetchViaJar(deps, `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}&mkt=zh-CN`, {
                headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
                timeoutMs: 8000,
              });
              assertOk(r);
              return parseBingResults(decodeBody(r), maxResults);
            }),
          },
          {
            label: '360',
            fetch: guarded('360', async () => {
              const r = await fetchViaJar(deps, `https://www.so.com/s?q=${encodeURIComponent(query)}`, {
                headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
                timeoutMs: 8000,
              });
              assertOk(r);
              return parseSo360Results(decodeBody(r), maxResults);
            }),
          },
          {
            label: 'Baidu',
            fetch: guarded('Baidu', async () => {
              // Warm up a BAIDUID cookie before the first real query —
              // Baidu serves a captcha to cookie-less clients.
              await ensureBaiduCookies(deps);
              const r = await fetchViaJar(deps, `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&ie=utf-8`, {
                headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
                timeoutMs: 8000,
              });
              assertOk(r);
              return parseBaiduResults(decodeBody(r), maxResults);
            }),
          },
        ]
      : []),
    {
      label: 'DuckDuckGo',
      fetch: guarded('DuckDuckGo', async () => {
        const r = await fetchViaJar(deps, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' },
          timeoutMs: 8000,
        });
        assertOk(r);
        return parseDuckDuckGoResults(decodeBody(r), maxResults);
      }),
    },
    {
      label: 'Bing',
      fetch: guarded('Bing', async () => {
        const mkt = cjk ? '&mkt=zh-CN&setlang=zh-hans' : '';
        const r = await fetchViaJar(deps, `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}${mkt}`, {
          headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' },
          timeoutMs: 8000,
        });
        assertOk(r);
        return parseBingResults(decodeBody(r), maxResults);
      }),
    },
    ...(cjk
      ? []
      : [
          {
            label: 'Brave',
            fetch: guarded('Brave', async () => {
              const r = await fetchViaJar(deps, `https://search.brave.com/search?q=${encodeURIComponent(query)}`, {
                headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
                timeoutMs: 8000,
              });
              assertOk(r);
              return parseBraveResults(decodeBody(r), maxResults);
            }),
          },
          {
            label: 'Mojeek',
            fetch: guarded('Mojeek', async () => {
              const r = await fetchViaJar(deps, `https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, {
                headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
                timeoutMs: 8000,
              });
              assertOk(r);
              return parseMojeekResults(decodeBody(r), maxResults);
            }),
          },
        ]),
  ];
  // A failed/rate-limited backend sits in cooldown (30s) so the next query
  // skips it instead of re-hitting the same dead endpoint.
  const activeBackends = backends.filter((b) => !cooldownActive(b.label));

  // 6) Free HTML backends, probed IN PARALLEL — first relevant set wins
  // ("first win"), so a dead/slow/irrelevant backend no longer serializes
  // the search.
  if (results.length === 0 && activeBackends.length > 0) {
    const outcome = await firstRelevantResult(query, activeBackends);
    if (outcome.results) {
      results = outcome.results;
    } else {
      failed.push(...outcome.failed);
      anyEmpty = anyEmpty || outcome.anyEmpty;
      irrelevant += outcome.irrelevant;
    }
  } else if (results.length === 0) {
    // Every free backend is in cooldown (all failed recently) — retrying
    // now would only re-hit rate limits.
    failed.push('free HTML backends in cooldown (recent failures)');
  }

  // 7) One normalized retry: syntactically heavy queries (quotes,
  // operators, Chinese punctuation) make engines fail or return nothing
  // even when the intent is findable — strip the noise once and re-probe
  // the HTML backends before giving up.
  if (results.length === 0) {
    const simplified = normalizeQueryForRetry(query);
    if (simplified) {
      const retryBackends = backends.filter((b) => !cooldownActive(b.label));
      if (retryBackends.length > 0) {
        const outcome = await firstRelevantResult(simplified, retryBackends);
        if (outcome.results) {
          results = outcome.results;
        } else {
          failed.push(...outcome.failed);
          anyEmpty = anyEmpty || outcome.anyEmpty;
          irrelevant += outcome.irrelevant;
        }
      }
    }
  }

  // 8) Last resort: engines rendered through Jina Reader (r.jina.ai, free
  // tier ~20 req/min) — Bing, then Google, then DuckDuckGo. Jina fetches each
  // from its own infrastructure, so this works when every local engine is
  // blocked / rate-limited (China, restrictive networks) as long as r.jina.ai
  // is reachable. Each engine is rate-limited via the shared quota: a failed
  // or over-budget engine cools down instead of being re-hit every query.
  if (results.length === 0) {
    const jinaEngines: Array<{ label: string; run: () => Promise<SearchResult[]> }> = [
      { label: 'Bing via Jina', run: () => jinaBingSearch(query, maxResults, deps) },
      { label: 'Google via Jina', run: () => jinaGoogleSearch(query, maxResults, deps) },
      { label: 'DDG via Jina', run: () => jinaDuckDuckGoSearch(query, maxResults, deps) },
    ];
    for (const engine of jinaEngines) {
      if (results.length > 0) break;
      if (cooldownActive(engine.label)) continue;
      try {
        const r = await engine.run();
        if (quota.registerUse(engine.label, 60_000, 20)) quota.markBlocked(engine.label, 60_000);
        if (r.length > 0) {
          results = dedupeResults(r);
        } else {
          anyEmpty = true;
        }
      } catch (err: unknown) {
        quota.markBlocked(engine.label, 60_000);
        failed.push(`${engine.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (results.length === 0) {
    // Backends answered but nothing usable (empty OR relevance-gated-out OR
    // all unreachable): the actionable guidance is the same — the query
    // itself needs rephrasing, or the search infra is down.
    if (anyEmpty || irrelevant > 0) {
      // When some backends were unreachable, say so — the model should not
      // conclude the query is bad when the real cause was network.
      const unreachable = failed.length > 0 ? ` (some backends unreachable: ${failed.join('; ')})` : '';
      return {
        ok: true,
        output: `No results found for "${query}" on the available search backends (${searchBackendNames(cjk, deps.env)}) — the backends returned either no hits or only content unrelated to the query${unreachable}. Do NOT repeat the same query — rephrase it (broader terms, simpler wording, or English), or use web_fetch / web_scrape on a URL you expect to contain the information.`,
      };
    }
    // Every backend errored (none returned empty): almost always network /
    // rate-limit / geo-block, NOT a bad query — tell the model not to
    // blindly retry, and how to recover. This is the message the failure
    // policy feeds back on.
    const details = failed.length > 0 ? failed.join('; ') : 'all backends unreachable';
    return {
      ok: false,
      output: `Web search failed on all backends (${details}). This looks like a network or rate-limit issue rather than a bad query — do NOT retry web_search immediately with the same or similar queries. Retry later, or use web_fetch / web_scrape on a URL you expect to contain the information.`,
    };
  }

  const output = results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`)
    .join('\n\n');
  deps.cacheSet?.(cacheKey, output, SEARCH_TTL_MS);

  return { ok: true, output };
}
