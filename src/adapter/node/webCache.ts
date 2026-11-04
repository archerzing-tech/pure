// src/adapter/node/webCache.ts
// Persistent TTL cache for web tool results (web_search / web_public_api /
// web_scrape / web_fetch). Search backends have free-tier quota (Serper,
// Tavily, Exa) and repeated identical queries are common inside agent loops,
// so fresh results are served from disk instead of burning quota or latency.
//
// Storage: ~/.pure/cache/web-cache.json — the SAME file the Rust GUI mirror
// (src-tauri/src/lib.rs WebCache) uses, with the same key scheme, so CLI and
// GUI share a warm cache. The file is bounded (MAX_ENTRIES with oldest-first
// eviction, per-value size cap) and tolerates corruption (a bad file is
// treated as empty, never an error).
//
// Controls:
//   PURE_WEB_CACHE=off|0|false  → cache disabled (get misses, set no-ops)
//   PURE_CACHE_DIR=<dir>        → override the base dir (default ~/.pure)

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fnv1a64, normalizeQuery, searchCacheKey } from '../../tools/impl/webSearch';

/** Maximum number of entries before oldest-first eviction. */
export const MAX_ENTRIES = 200;
/**
 * Per-value cap in UTF-16 chars. 60k covers the largest shape the tools
 * promise (web_scrape maxChars caps at 50k) — a smaller cap made a cached
 * big page come back SHORTER on the second read, silently. Truncation now
 * also says so (marker below), so a shortened cache copy can never pass as
 * the full page. (The old name MAX_VALUE_BYTES lied: value.length counts
 * UTF-16 units, not bytes. The Rust mirror caps by UTF-8 bytes at 180_000 —
 * the largest byte shape 60k all-CJK chars can produce.)
 */
export const MAX_VALUE_CHARS = 60_000;
/** Truncation marker stored INSIDE the cap, appended to shortened values. */
export const TRUNCATION_MARKER = '\n\n[cache copy truncated - re-run the tool for the full text]';

export interface CacheRecord {
  /** Serialized value (string or JSON string). */
  v: string;
  /** Epoch ms when the record was written. */
  t: number;
  /** TTL in ms — records past storedAt+ttl are expired. */
  ttl: number;
}

export function webCacheFile(): string {
  const base = process.env.PURE_CACHE_DIR?.trim() || `${process.env.HOME || homedir()}/.pure`;
  return join(base, 'cache', 'web-cache.json');
}

export function webCacheEnabled(): boolean {
  const flag = process.env.PURE_WEB_CACHE?.trim().toLowerCase();
  return flag !== 'off' && flag !== '0' && flag !== 'false' && flag !== '';
}

/** Stable cache key — hashed so queries/URLs never leak into the file name.
 * FNV-1a 的单源实现是 tools/impl/webSearch 的 fnv1a64（P2-5 收敛，键不变）。 */
export function hashKey(parts: string[]): string {
  return fnv1a64(parts);
}

// normalizeQuery / searchCacheKey 的单源在 tools/impl/webSearch（P2-5）：
// 同一 FNV-1a、同一键序，盘上缓存键完全兼容。
export { normalizeQuery, searchCacheKey };



/** Key for URL content (web_scrape / web_fetch) — selector and the maxChars
 * bucket are part of the cache identity because they change the output. */
export function pageCacheKey(url: string, selector: string | undefined, maxChars: number): string {
  const bucket = maxChars <= 20000 ? '20k' : maxChars <= 50000 ? '50k' : 'big';
  return hashKey(['page', url.trim(), selector ?? '', bucket]);
}

/** Key for direct public-API outcomes (query + optional forced category +
 * location — weather answers differ by city). */
export function publicApiCacheKey(query: string, category: string | undefined, location: string | undefined): string {
  return hashKey(['publicapi', category ?? '', normalizeQuery(query), location ?? '']);
}

export class WebCache {
  private records = new Map<string, CacheRecord>();
  private file: string;
  private loaded = false;

  constructor(file = webCacheFile()) {
    this.file = file;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!webCacheEnabled()) return;
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, CacheRecord>;
      if (parsed && typeof parsed === 'object') {
        for (const [k, rec] of Object.entries(parsed)) {
          if (rec && typeof rec.v === 'string' && typeof rec.t === 'number' && typeof rec.ttl === 'number') {
            this.records.set(k, rec);
          }
        }
      }
    } catch {
      // Missing or corrupt file — start empty (never fail a search for a cache).
    }
  }

  /** Fresh record for `key`, or undefined (expired entries are dropped). */
  get(key: string): string | undefined {
    if (!webCacheEnabled()) return undefined;
    this.load();
    const rec = this.records.get(key);
    if (!rec) return undefined;
    if (rec.t + rec.ttl <= Date.now()) {
      this.records.delete(key);
      return undefined;
    }
    return rec.v;
  }

  /** Store `value` under `key` for `ttlMs`; oldest entries are evicted when
   * the cache is over MAX_ENTRIES. Persisted to disk (best-effort). */
  set(key: string, value: string, ttlMs: number): void {
    if (!webCacheEnabled()) return;
    this.load();
    if (value.length > MAX_VALUE_CHARS) value = value.slice(0, MAX_VALUE_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
    this.records.set(key, { v: value, t: Date.now(), ttl: ttlMs });
    while (this.records.size > MAX_ENTRIES) {
      // Evict the entry with the oldest storedAt (approximate LRU).
      let oldestKey: string | undefined;
      let oldestT = Infinity;
      for (const [k, rec] of this.records) {
        if (rec.t < oldestT) {
          oldestT = rec.t;
          oldestKey = k;
        }
      }
      if (oldestKey === undefined) break;
      this.records.delete(oldestKey);
    }
    this.save();
  }

  private save(): void {
    if (!webCacheEnabled()) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.records)));
    } catch {
      // Best-effort persistence — a read-only home dir must not break search.
    }
  }

  /** Drop everything (tests / diagnostics). */
  clear(): void {
    this.records.clear();
    this.loaded = true;
    try {
      rmSync(this.file, { force: true });
    } catch {
      // ignore
    }
  }
}

/** Process-wide singleton. Tests call resetWebCache() (with PURE_CACHE_DIR
 * pointed at a temp dir) so the cache never touches the real home dir. */
let cache: WebCache | null = null;

export function webCache(): WebCache {
  if (cache === null) cache = new WebCache();
  return cache;
}

/** Re-create the singleton (tests): the next use re-reads env vars. */
export function resetWebCache(): void {
  cache = null;
}

export const SEARCH_TTL_MS = 15 * 60 * 1000;
export const PAGE_TTL_MS = 60 * 60 * 1000;
