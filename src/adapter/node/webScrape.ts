// src/adapter/node/webScrape.ts
// Tier-3 web tool helpers: extracting readable content from a KNOWN URL.
// Pure parsing/extraction utilities only — the fetch wiring lives in
// NodeToolAdapter.handleWebScrape (which owns charset decoding, content-type
// gating, and timeouts), so this module never imports from the adapter.
//
// Extraction pipeline, in order:
//   1. HTML → noise-tag stripping (nav/header/footer/aside/form/…), optional
//      selector scoping (#id / .class / tag), then tag-strip + entity-decode.
//   2. JSON → pretty-printed, truncated.
//   3. RSS/Atom → parsed item list (title/link/date/description).
//   4. Jina Reader (r.jina.ai) fallback for blocked, JS-heavy, or binary
//      pages — free tier, no key required (PURE_JINA_API_KEY raises limits).

import { parseRssItems } from './publicApis';
import { BROWSER_UA } from '../../shared/platformUa';

/** Block-level noise tags removed before text extraction. The capture group
 * is REQUIRED for the `<\/\1>` backreference (a non-capturing alternation
 * would leave \1 empty and the whole pattern would misbehave). */
const NOISE_TAGS_RE = /<(nav|header|footer|aside|form|button|script|style|iframe|svg|canvas|noscript|template|dialog)[^>]*>[\s\S]*?<\/\1>/gi;

/** Remove navigation/boilerplate blocks from an HTML page. */
export function stripNoiseTags(html: string): string {
  return html.replace(NOISE_TAGS_RE, '');
}

/**
 * Extract the inner HTML of elements matching a simple selector: `#id`,
 * `.class`, or a bare tag name (`article`, `main`). Regex-based by design —
 * the codebase has no DOM dependency and the existing search parsers follow
 * the same approach. Returns [] when nothing matches so callers fall back to
 * whole-page extraction.
 */
export function extractBySelector(html: string, selector: string): string[] {
  const sel = selector.trim();
  if (!sel) return [];
  const isId = sel.startsWith('#');
  const isClass = sel.startsWith('.');
  if (isId || isClass) {
    const token = sel.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!token) return [];
    const attr = isId ? `id=["']${token}["']` : `class=["'][^"']*${token}[^"']*["']`;
    const re = new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)[^>]*${attr}[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && out.length < 8) out.push(m[2]);
    return out;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(sel)) return [];
  const re = new RegExp(`<${sel}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${sel}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 8) out.push(m[1]);
  return out;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

/** Tag-strip to readable text (mirrors NodeToolAdapter.stripHtml — duplicated
 * here to keep this module import-free of the adapter). */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(?:div|h[1-6]|li|tr|section|article|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Full HTML extraction: noise strip → optional selector scope → readable text. */
export function extractScrapeText(html: string, selector?: string): string {
  const cleaned = stripNoiseTags(html);
  let body = cleaned;
  if (selector) {
    const scoped = extractBySelector(cleaned, selector).join('\n\n');
    if (scoped.trim()) body = scoped;
  }
  return decodeEntities(stripHtml(body).trim());
}

/** Pretty-print a JSON body (capped by the caller). Falls back to the raw
 * body when it is not valid JSON. */
export function formatJsonBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** True when the body looks like an RSS/Atom feed (has item/entry blocks). */
export function isFeedBody(body: string): boolean {
  return /<(item|entry)>[\s\S]*?<\/(item|entry)>/i.test(body);
}

/** Format a feed body as a numbered list (title / date / link / description). */
export function formatFeedText(body: string): string {
  const items = parseRssItems(body, 8);
  return items
    .map((item, i) => `${i + 1}. ${item.title}${item.date ? `\n   ${item.date}` : ''}\n   ${item.link}${item.description ? `\n   ${item.description}` : ''}`)
    .join('\n\n');
}

/** Cap a string at maxChars with a truncation marker. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

/**
 * Jina Reader fallback: `https://r.jina.ai/<url>` renders any page
 * (including PDFs and JS-heavy SPAs) as readable text. Free tier works
 * without a key; PURE_JINA_API_KEY raises the rate limits.
 */
export async function scrapeViaJina(url: string, apiKey?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = { Accept: 'text/plain', 'User-Agent': BROWSER_UA };
    if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
    const resp = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}
