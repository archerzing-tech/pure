// src/adapter/node/fetchFallback.ts
// Tier-3 web-fetch fallback helpers: the pieces of the "get the page ANYWAY"
// chain that the adapter composes (direct → Jina → Wayback → Firecrawl → PDF).
// Pure helpers only — the orchestration, cache, selector handling and content-
// type gating live in NodeToolAdapter, so this module never imports the adapter.
// Each helper is defensive: on any failure it returns null / the last response
// so callers fall through to the next tier instead of throwing.

import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { BROWSER_UA } from '../../shared/platformUa';

/** Overall budget for a single direct fetch (matches the old 30s timeout). */
const DIRECT_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Origin of a URL (for a same-site Referer) or undefined when unparsable. */
export function refererFor(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * A direct fetch with browser-like headers, transient-error retry and an
 * overall timeout. Retries 429 / 5xx / network failures up to `retries` times
 * with linear backoff; other 4xx responses are returned immediately (they will
 * not succeed on retry). Honors an external abort signal (user cancel).
 */
export async function fetchWithRetry(
  url: string,
  opts: { signal?: AbortSignal; retries?: number; headers?: Record<string, string> } = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const referer = refererFor(url);
      const resp = await fetch(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
          ...(referer ? { Referer: referer } : {}),
          ...(opts.headers ?? {}),
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (resp.ok) return resp;
      // Only 408 / 429 / 5xx are worth retrying; a hard 4xx is final.
      const retriable = resp.status === 408 || resp.status === 429 || resp.status >= 500;
      if (!retriable || attempt === retries) return resp;
      try { resp.body?.cancel(); } catch { /* release the connection */ }
      await sleep(400 * (attempt + 1));
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (opts.signal?.aborted || controller.signal.aborted) throw lastErr;
      if (attempt === retries) throw lastErr;
      await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Detect a `<meta http-equiv="refresh" content="0; url=…">` redirect target
 * (handles either attribute order and quoted/unquoted URLs). Returns null when
 * absent. Landing pages that JS-redirect via meta-refresh otherwise extract to
 * nothing — following the hop turns them into real content.
 */
export function extractMetaRefreshUrl(html: string): string | null {
  const re = /<meta[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    if (!/http-equiv\s*=\s*["']?refresh["']?/i.test(tag)) continue;
    // The value delimiter must match the OPENING quote — a double-quoted value
    // may contain single quotes (e.g. url='/rel/path') and vice versa.
    const content = tag.match(/content\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/content\s*=\s*'([^']*)'/i)?.[1];
    if (content === undefined) continue;
    const um = content.match(/(?:^|;)\s*url\s*=\s*(.+)/i);
    if (!um) continue;
    let target = um[1].trim();
    if ((target.startsWith("'") && target.endsWith("'")) || (target.startsWith('"') && target.endsWith('"'))) {
      target = target.slice(1, -1);
    }
    if (!target) continue;
    return decodeHtmlEntities(target);
  }
  return null;
}

/** Resolve a possibly-relative redirect target against the page URL. */
export function resolveRedirectTarget(base: string, target: string): string {
  try {
    return new URL(target, base).toString();
  } catch {
    return target;
  }
}

/**
 * Wayback Machine fallback: locate the closest snapshot of `url` and fetch its
 * captured HTML. Tries the archive.org availability API first, then the Memento
 * aggregator (which also covers other web archives). Returns null when no
 * snapshot exists or the fetch fails — callers fall through to the next tier.
 */
export async function scrapeViaWayback(url: string): Promise<string | null> {
  const direct = await waybackAvailable(url);
  if (direct) return direct;
  return waybackViaMemento(url);
}

async function waybackAvailable(url: string): Promise<string | null> {
  try {
    const now = new Date();
    const ts = now.toISOString().replace(/[-:]/g, '').slice(0, 14);
    const resp = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=${ts}`, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { archived_snapshots?: { closest?: { url?: string; status?: string } } };
    const snap = data.archived_snapshots?.closest;
    if (!snap?.url || (snap.status && snap.status !== '200')) return null;
    const page = await fetch(snap.url, {
      headers: { 'User-Agent': BROWSER_UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!page.ok) return null;
    const body = await page.text();
    return body.trim() ? body : null;
  } catch {
    return null;
  }
}

async function waybackViaMemento(url: string): Promise<string | null> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const resp = await fetch(`https://timetravel.mementoweb.org/api/json/${day}/${encodeURIComponent(url)}`, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { mementos?: { closest?: { uri?: string } } };
    const uri = data.mementos?.closest?.uri;
    if (!uri) return null;
    const page = await fetch(uri, {
      headers: { 'User-Agent': BROWSER_UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!page.ok) return null;
    const body = await page.text();
    return body.trim() ? body : null;
  } catch {
    return null;
  }
}

/**
 * Firecrawl fallback (opt-in FIRECRAWL_API_KEY): server-side rendering + clean
 * markdown for the hardest anti-bot / JS-heavy pages. Returns null without a
 * key (that tier is simply skipped) or on any failure.
 */
export async function scrapeViaFirecrawl(url: string, apiKey?: string): Promise<string | null> {
  const key = apiKey?.trim();
  if (!key) return null;
  try {
    const resp = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ url, formats: ['markdown'] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { success?: boolean; data?: { markdown?: string } };
    const md = data.success ? data.data?.markdown : undefined;
    return md && md.trim() ? md : null;
  } catch {
    return null;
  }
}

/**
 * Minimal text-based PDF extractor (no dependencies): inflate FlateDecode
 * content streams with node:zlib and pull text out of `Tj` / `TJ` operators.
 * Returns null on any failure or when the PDF carries no embedded text (scanned
 * PDFs need OCR — a separate capability). Text-based PDFs that r.jina.ai is
 * blocked for still extract, which is the point of this tier.
 */
export function extractPdfText(bytes: Uint8Array): string | null {
  try {
    // Buffer.toString('latin1') is TRUE raw byte→code-unit (TextDecoder's
    // 'latin1' maps to windows-1252, which rewrites 0x80–0x9F and corrupts
    // binary streams — exactly what breaks deflate in PDFs).
    const raw = Buffer.from(bytes).toString('latin1');
    const out: string[] = [];
    const streamRe = /<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let m: RegExpExecArray | null;
    while ((m = streamRe.exec(raw)) !== null) {
      const dict = m[1];
      if (!/FlateDecode|\bFl\b/.test(dict)) continue;
      const chunk = m[2];
      let decoded: Uint8Array;
      try {
        decoded = inflateSync(Uint8Array.from(chunk, (c) => c.charCodeAt(0) & 0xff));
      } catch {
        continue;
      }
      out.push(extractPdfTextOperators(Buffer.from(decoded).toString('latin1')));
    }
    const joined = out
      .join('\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/ {2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return joined ? joined : null;
  } catch {
    return null;
  }
}

function extractPdfTextOperators(content: string): string {
  const out: string[] = [];
  // (...) Tj  |  [...] TJ — pull the string literals (parenthesized, PDF-escaped).
  const re = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ)|\[([\s\S]*?)\]\s*TJ/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const literal = m[1];
    if (literal !== undefined) {
      out.push(unescapePdfString(literal));
      continue;
    }
    // TJ array: each element is a string literal; join with spaces.
    const items: string[] = [];
    const itemRe = /\(((?:\\.|[^\\()])*)\)/g;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(m[2])) !== null) items.push(unescapePdfString(im[1]));
    if (items.length) out.push(items.join(' '));
  }
  return out.join(' ');
}

function unescapePdfString(s: string): string {
  return s
    .replace(/\\([nrtbf()\\])/g, (_, c: string) => (({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[c] ?? c))
    .replace(/\\(\d{1,3})/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\\\r?\n/g, '');
}

/**
 * Fall back to the poppler `pdftotext` CLI (when installed) for PDFs the JS
 * extractor cannot read. Returns null when unavailable or the file has no text.
 */
export async function extractPdfViaPdftotext(filePath: string): Promise<string | null> {
  try {
    const { statSync } = await import('node:fs');
    if (!statSync(filePath).isFile()) return null;
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const child = spawn('pdftotext', ['-layout', filePath, '-']);
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(null); }, 10_000);
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.trim() ? out : null);
    });
  });
}
