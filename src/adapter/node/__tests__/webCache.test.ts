// src/adapter/node/__tests__/webCache.test.ts
// File-backed TTL cache shared by web_search / web_public_api / web_scrape /
// web_fetch: TTL expiry, oldest-first eviction, persistence round-trip,
// disable flag, and key normalization.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_ENTRIES,
  MAX_VALUE_BYTES,
  WebCache,
  hashKey,
  pageCacheKey,
  publicApiCacheKey,
  resetWebCache,
  searchCacheKey,
  webCache,
  webCacheFile,
  webCacheEnabled,
} from '../webCache';

const originalDir = process.env.PURE_CACHE_DIR;
const originalFlag = process.env.PURE_WEB_CACHE;

function tempCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pure-web-cache-'));
  process.env.PURE_CACHE_DIR = dir;
  resetWebCache();
  return dir;
}

beforeEach(() => {
  tempCacheDir();
});

afterEach(() => {
  resetWebCache();
  if (originalDir === undefined) delete process.env.PURE_CACHE_DIR;
  else process.env.PURE_CACHE_DIR = originalDir;
  if (originalFlag === undefined) delete process.env.PURE_WEB_CACHE;
  else process.env.PURE_WEB_CACHE = originalFlag;
});

describe('WebCache TTL behavior', () => {
  it('serves a fresh value and expires it after the TTL', () => {
    const c = new WebCache();
    c.set('k', 'v', 40);
    expect(c.get('k')).toBe('v');
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(c.get('k')).toBeUndefined();
        resolve();
      }, 80);
    });
  });

  it('persists records to the shared file and reloads them', () => {
    const c = new WebCache();
    c.set('k1', 'hello', 60_000);
    const file = webCacheFile();
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { v: string; t: number; ttl: number }>;
    expect(onDisk.k1.v).toBe('hello');
    // A fresh instance (new process) reads the same file.
    const c2 = new WebCache();
    expect(c2.get('k1')).toBe('hello');
  });

  it('treats a corrupt cache file as empty instead of failing', () => {
    const file = webCacheFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{not json!!');
    const c = new WebCache();
    expect(c.get('k1')).toBeUndefined();
    c.set('k2', 'v2', 60_000);
    expect(c.get('k2')).toBe('v2');
  });

  it('evicts oldest entries first when over the entry cap', () => {
    const c = new WebCache();
    for (let i = 0; i < MAX_ENTRIES + 10; i++) {
      c.set(`key-${i}`, `value-${i}`, 60_000);
    }
    expect(c.get('key-0')).toBeUndefined(); // oldest evicted
    expect(c.get(`key-${MAX_ENTRIES + 9}`)).toBe(`value-${MAX_ENTRIES + 9}`);
  });

  it('caps oversized values so the file stays bounded', () => {
    const c = new WebCache();
    c.set('big', 'x'.repeat(MAX_VALUE_BYTES + 10_000), 60_000);
    const stored = c.get('big') ?? '';
    expect(stored.length).toBeLessThanOrEqual(MAX_VALUE_BYTES);
  });

  it('clear() drops everything including the file', () => {
    const c = new WebCache();
    c.set('k', 'v', 60_000);
    c.clear();
    expect(c.get('k')).toBeUndefined();
    expect(existsSync(webCacheFile())).toBe(false);
  });
});

describe('webCache controls + keys', () => {
  it('PURE_WEB_CACHE=off disables reads and writes', () => {
    process.env.PURE_WEB_CACHE = 'off';
    resetWebCache();
    const c = new WebCache();
    c.set('k', 'v', 60_000);
    expect(c.get('k')).toBeUndefined();
    expect(webCacheEnabled()).toBe(false);
    // The singleton also respects the flag.
    webCache().set('k2', 'v2', 60_000);
    expect(webCache().get('k2')).toBeUndefined();
  });

  it('normalizes search keys (case + whitespace + result count)', () => {
    expect(searchCacheKey('React  Hooks', 10)).toBe(searchCacheKey('react hooks', 10));
    expect(searchCacheKey('react hooks', 10)).not.toBe(searchCacheKey('react hooks', 5));
  });

  it('page keys include selector and maxChars bucket', () => {
    expect(pageCacheKey('https://a.com/x', undefined, 20000)).toBe(pageCacheKey('https://a.com/x', undefined, 15000));
    expect(pageCacheKey('https://a.com/x', undefined, 20000)).not.toBe(pageCacheKey('https://a.com/x', '#main', 20000));
    expect(pageCacheKey('https://a.com/x', undefined, 20000)).not.toBe(pageCacheKey('https://a.com/x', undefined, 50000));
  });

  it('public-API keys include category and location', () => {
    expect(publicApiCacheKey('北京天气', undefined, 'beijing')).toBe(publicApiCacheKey('北京 天气', undefined, 'beijing'));
    expect(publicApiCacheKey('天气', undefined, 'beijing')).not.toBe(publicApiCacheKey('天气', undefined, 'shanghai'));
    expect(publicApiCacheKey('weather', 'weather', undefined)).not.toBe(publicApiCacheKey('weather', undefined, undefined));
  });

  it('hashKey is stable, bounded, and matches the Rust mirror (FNV-1a 64 over UTF-8)', () => {
    expect(hashKey(['a', 'b'])).toBe(hashKey(['a', 'b']));
    expect(hashKey(['a', 'b']).length).toBeLessThanOrEqual(16);
    expect(hashKey(['a', 'b'])).not.toBe(hashKey(['a', 'c']));
    // Cross-language constant: fnv1a64("a\0b") — locked against the Rust
    // mirror test so CLI and GUI keys stay identical.
    expect(hashKey(['a', 'b'])).toBe('e5d29919042666b2');
    // CJK path: UTF-8 bytes, not UTF-16 code units — matches the Rust side.
    expect(hashKey(['publicapi', '', '京', ''])).toBe('bcf7740e6f3298ee');
  });
});
