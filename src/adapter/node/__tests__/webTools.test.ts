// src/adapter/node/__tests__/webTools.test.ts
// Adapter-level wiring for the Tier-2/3 web tools: web_search structured fast
// path, web_public_api dispatch, and web_scrape extraction with Jina fallback
// (all network calls mocked).

import { describe, expect, it, beforeAll, afterAll, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeToolAdapter } from '../NodeToolAdapter';
import { quota } from '../publicApis';
import { resetWebCache } from '../webCache';
import type { ToolCall } from '../../../shared/types';

const originalFetch = globalThis.fetch;
let cacheDir: string;

function call(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${name}`,
    index: 0,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function mockFetchByUrl(routes: Record<string, { body: unknown; contentType?: string; status?: number }>): void {
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    for (const [prefix, route] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        return new Response(
          typeof route.body === 'string' ? route.body : JSON.stringify(route.body),
          { status: route.status ?? 200, headers: { 'Content-Type': route.contentType ?? 'application/json' } },
        );
      }
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

const WEATHER_GEO = {
  results: [{ name: '北京', latitude: 39.9, longitude: 116.4, country: '中国' }],
};
const WEATHER_FORECAST = {
  timezone: 'Asia/Shanghai',
  current: { time: '2026-08-16T12:00', temperature_2m: 27, apparent_temperature: 29, relative_humidity_2m: 55, precipitation: 0, weather_code: 2, wind_speed_10m: 12 },
  daily: {
    time: ['2026-08-16', '2026-08-17'],
    temperature_2m_max: [30, 31],
    temperature_2m_min: [22, 23],
    precipitation_probability_max: [10, 20],
    weather_code: [2, 3],
  },
};

describe('CLI Tier-2/3 web tool wiring', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-web-tools-'));
    adapter = new NodeToolAdapter({ workspace });
    delete process.env.SERPER_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.PURE_JINA_API_KEY;
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Isolate the shared web cache: temp dir + fresh singleton per test so a
    // test's cached results never leak into the next one (or the real home).
    cacheDir = mkdtempSync(join(tmpdir(), 'pure-web-tools-cache-'));
    process.env.PURE_CACHE_DIR = cacheDir;
    resetWebCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWebCache();
    delete process.env.PURE_CACHE_DIR;
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('exposes web_public_api and web_scrape to the model while hiding legacy names', () => {
    const names = adapter.getTools().map((tool) => tool.name);
    expect(names).toContain('web_public_api');
    expect(names).toContain('web_scrape');
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('web_fetch');
  });

  it('web_public_api answers an FX lookup from the direct API tier', async () => {
    mockFetchByUrl({ 'https://api.frankfurter.app/': { body: { rates: { CNY: 7.2 }, date: '2026-08-16' } } });
    const result = await adapter.execute(call('web_public_api', { query: '100 usd to cny' }));
    expect(result.success).toBe(true);
    expect(result.toolName).toBe('web_public_api');
    expect(String(result.result)).toContain('[Frankfurter (ECB)]');
    expect(String(result.result)).toContain('100 USD = 720.00 CNY');
  });

  it('web_public_api auto-escalates to web search when no structured source matches', async () => {
    mockFetchByUrl({ 'https://': { body: '<html></html>', contentType: 'text/html' } });
    const result = await adapter.execute(call('web_public_api', { query: 'react hooks 教程' }));
    expect(result.success).toBe(true);
    expect(result.toolName).toBe('web_public_api');
    expect(String(result.result)).toContain('No results found');
  });

  it('web_public_api respects searchOnMiss:false and fails with recovery guidance', async () => {
    const result = await adapter.execute(call('web_public_api', { query: '写一个爬虫脚本', searchOnMiss: false }));
    expect(result.success).toBe(false);
    expect(result.toolName).toBe('web_public_api');
    expect(result.error).toContain('researcher_web');
  });

  it('web_public_api rejects an empty query', async () => {
    const result = await adapter.execute(call('web_public_api', { query: '' }));
    expect(result.success).toBe(false);
  });

  it('web_search answers structured queries through the direct-API fast path', async () => {
    mockFetchByUrl({
      'https://geocoding-api.open-meteo.com/': { body: WEATHER_GEO },
      'https://api.open-meteo.com/': { body: WEATHER_FORECAST },
    });
    const result = await adapter.execute(call('web_search', { query: '北京天气' }));
    expect(result.success).toBe(true);
    expect(result.toolName).toBe('web_search');
    expect(String(result.result)).toContain('[Open-Meteo]');
    expect(String(result.result)).toContain('27°C');
  });

  it('web_search falls through to search backends for general queries', async () => {
    // All backends return an empty page → the classic "no results" success
    // message proves the direct-API tier did NOT answer this query.
    mockFetchByUrl({ 'https://': { body: '<html></html>', contentType: 'text/html' } });
    const result = await adapter.execute(call('web_search', { query: 'react hooks 教程' }));
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('No results found');
    expect(String(result.result)).not.toContain('[');
  });

  it('web_scrape strips navigation and extracts readable text', async () => {
    mockFetchByUrl({
      'https://example.com/article': {
        body: '<html><nav>menu</nav><main><h1>Story</h1><p>First &amp; second paragraph.</p></main><footer>bye</footer></html>',
        contentType: 'text/html',
      },
    });
    const result = await adapter.execute(call('web_scrape', { url: 'https://example.com/article' }));
    expect(result.success).toBe(true);
    const text = String(result.result);
    expect(text).toContain('Story');
    expect(text).toContain('First & second paragraph.');
    expect(text).not.toContain('menu');
    expect(text).not.toContain('bye');
  });

  it('web_scrape honors a selector scope', async () => {
    mockFetchByUrl({
      'https://example.com/side': {
        body: '<div id="main"><p>Main content</p></div><div id="sidebar"><p>Side content</p></div>',
        contentType: 'text/html',
      },
    });
    const result = await adapter.execute(call('web_scrape', { url: 'https://example.com/side', selector: '#main' }));
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('Main content');
    expect(String(result.result)).not.toContain('Side content');
  });

  it('web_scrape formats RSS feeds as a numbered list', async () => {
    mockFetchByUrl({
      'https://example.com/feed': {
        body: '<rss><channel><item><title>One</title><link>https://example.com/1</link><description>Lead one.</description></item></channel></rss>',
        contentType: 'application/rss+xml',
      },
    });
    const result = await adapter.execute(call('web_scrape', { url: 'https://example.com/feed' }));
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('1. One');
    expect(String(result.result)).toContain('Lead one.');
  });

  it('web_scrape pretty-prints JSON payloads', async () => {
    mockFetchByUrl({
      'https://api.example.com/data': { body: { ok: true, items: [1, 2] }, contentType: 'application/json' },
    });
    const result = await adapter.execute(call('web_scrape', { url: 'https://api.example.com/data' }));
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('"ok": true');
  });

  it('web_scrape falls back to Jina Reader on HTTP errors', async () => {
    mockFetchByUrl({
      'https://example.com/blocked': { body: 'Forbidden', status: 403 },
      'https://r.jina.ai/': { body: 'Rendered by Jina Reader', contentType: 'text/plain' },
    });
    const result = await adapter.execute(call('web_scrape', { url: 'https://example.com/blocked' }));
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('Rendered by Jina Reader');
  });

  it('web_scrape falls back to Jina Reader for binary content types', async () => {
    mockFetchByUrl({
      'https://example.com/doc.pdf': { body: '%PDF-1.4', contentType: 'application/pdf' },
      'https://r.jina.ai/': { body: 'PDF text extracted', contentType: 'text/plain' },
    });
    const result = await adapter.execute(call('web_scrape', { url: 'https://example.com/doc.pdf' }));
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('PDF text extracted');
  });

  it('web_scrape fails with guidance when direct fetch and Jina both fail', async () => {
    mockFetchByUrl({
      'https://example.com/dead': { body: 'Forbidden', status: 403 },
      'https://r.jina.ai/': { body: '', status: 503 },
    });
    const result = await adapter.execute(call('web_scrape', { url: 'https://example.com/dead' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('researcher_web');
  });

  it('skips an API backend in cooldown instead of calling it', async () => {
    const called: string[] = [];
    globalThis.fetch = (async (input: any) => {
      called.push(String(input));
      return new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as unknown as typeof fetch;
    process.env.SERPER_API_KEY = 'serper-test';
    quota.markBlocked('serper', 60_000);
    try {
      const result = await adapter.execute(call('web_search', { query: 'react hooks 教程' }));
      expect(result.success).toBe(true);
      expect(called.some((u) => u.includes('google.serper.dev'))).toBe(false);
      expect(called.some((u) => u.includes('sogou.com') || u.includes('duckduckgo.com') || u.includes('bing.com'))).toBe(true);
    } finally {
      delete process.env.SERPER_API_KEY;
      quota.clear();
    }
  });

  it('web_search serves an identical repeat query from the cache without re-fetching', async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response(JSON.stringify({ organic: [{ title: 'T', link: 'https://r.example.com/1', snippet: 'c' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    process.env.SERPER_API_KEY = 'serper-test';
    try {
      const first = await adapter.execute(call('web_search', { query: 'react hooks 教程' }));
      expect(first.success).toBe(true);
      expect(called).toBe(1);
      const second = await adapter.execute(call('web_search', { query: 'react hooks 教程' }));
      expect(second.success).toBe(true);
      expect(called).toBe(1); // cache hit — no network
      expect(String(second.result)).toContain('[cached]');
    } finally {
      delete process.env.SERPER_API_KEY;
    }
  });

  it('web_public_api repeat queries hit the per-intent cache with a cached marker', async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response(JSON.stringify({ rates: { CNY: 7.2 }, date: '2026-08-16' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const first = await adapter.execute(call('web_public_api', { query: '100 usd to cny' }));
    expect(first.success).toBe(true);
    expect(called).toBe(1);
    const second = await adapter.execute(call('web_public_api', { query: '100 usd to cny' }));
    expect(second.success).toBe(true);
    expect(called).toBe(1);
    expect(String(second.result)).toContain('[cached]');
    expect(String(second.result)).toContain('Frankfurter');
  });

  it('web_scrape serves a repeat URL from the page cache', async () => {
    let called = 0;
    globalThis.fetch = (async (input: any) => {
      called += 1;
      const url = String(input);
      if (url.startsWith('https://example.com/article')) {
        return new Response('<html><body><article><h1>Hello</h1><p>World</p></article></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const first = await adapter.execute(call('web_scrape', { url: 'https://example.com/article' }));
    expect(first.success).toBe(true);
    expect(String(first.result)).toContain('Hello');
    expect(called).toBe(1);
    const second = await adapter.execute(call('web_scrape', { url: 'https://example.com/article' }));
    expect(second.success).toBe(true);
    expect(called).toBe(1); // cache hit — no re-fetch
    expect(String(second.result)).toContain('Hello');
  });
});
