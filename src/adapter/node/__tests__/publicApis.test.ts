// src/adapter/node/__tests__/publicApis.test.ts
// Tier-2 structured public API module: deterministic intent classifier, FX
// grammar, stock symbol resolution, RSS parsing, and the resolver entry point
// (network calls mocked).

import { describe, expect, it, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BackendQuota,
  PUBLIC_API_TTL_MS,
  cachedDirectPublicApi,
  classifyIntent,
  extractLocation,
  isBuildRequest,
  parseFxQuery,
  parseRssItems,
  resolveStockSymbol,
  tryDirectPublicApi,
} from '../publicApis';
import { resetWebCache } from '../webCache';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetWebCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetWebCache();
  delete process.env.PURE_CACHE_DIR;
});

function mockFetchOnce(body: unknown, contentType = 'application/json', status = 200): void {
  globalThis.fetch = (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': contentType },
    })) as unknown as typeof fetch;
}

describe('isBuildRequest guard', () => {
  it('never auto-routes requests that want something built', () => {
    expect(isBuildRequest('写一个天气网站')).toBe(true);
    expect(isBuildRequest('帮我写一个爬虫脚本')).toBe(true);
    expect(isBuildRequest('帮我做一个小游戏')).toBe(true);
    expect(isBuildRequest('build a weather app')).toBe(true);
  });

  it('keeps plain lookups unblocked', () => {
    expect(isBuildRequest('北京天气')).toBe(false);
    expect(isBuildRequest('帮我查一下天气')).toBe(false);
    expect(isBuildRequest('weather in tokyo')).toBe(false);
  });
});

describe('BackendQuota cooldown + sliding window', () => {
  it('blocks a backend until the cooldown expires', () => {
    const q = new BackendQuota();
    expect(q.isBlocked('serper')).toBe(false);
    q.markBlocked('serper', 40);
    expect(q.isBlocked('serper')).toBe(true);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(q.isBlocked('serper')).toBe(false);
        resolve();
      }, 60);
    });
  });

  it('records sliding-window usage and reports when over budget', () => {
    const q = new BackendQuota();
    expect(q.registerUse('tavily', 60_000, 2)).toBe(false);
    expect(q.registerUse('tavily', 60_000, 2)).toBe(false);
    expect(q.registerUse('tavily', 60_000, 2)).toBe(true);
    expect(q.countInWindow('tavily', 60_000)).toBe(3);
  });

  it('clear() resets cooldowns and usage history', () => {
    const q = new BackendQuota();
    q.markBlocked('exa', 60_000);
    q.registerUse('exa', 60_000, 1);
    q.clear();
    expect(q.isBlocked('exa')).toBe(false);
    expect(q.countInWindow('exa', 60_000)).toBe(0);
  });
});

describe('classifyIntent', () => {
  it('routes structured intents to their resolvers', () => {
    expect(classifyIntent('北京明天天气')).toBe('weather');
    expect(classifyIntent('东京的经纬度')).toBe('geocode');
    expect(classifyIntent('今天有什么新闻')).toBe('news');
    expect(classifyIntent('JavaScript 是什么')).toBe('wiki');
    expect(classifyIntent('我的IP地址')).toBe('ip');
    expect(classifyIntent('100 usd to cny')).toBe('fx');
    expect(classifyIntent('苹果股价')).toBe('stock');
    expect(classifyIntent('github 上最火的 AI 仓库')).toBe('github');
    expect(classifyIntent('北京到上海机票')).toBeNull();
  });

  it('returns null for build requests, empty input, and non-structured queries', () => {
    expect(classifyIntent('')).toBeNull();
    expect(classifyIntent('写一个天气网站')).toBeNull();
    expect(classifyIntent('react 状态管理最佳实践')).toBeNull();
  });

  it('applies conservative length caps so long prose cannot be hijacked', () => {
    const longWeather = '北京明天天气怎么样，我想知道会不会下雨，因为我要考虑要不要带伞出门上班，还要看看温度适不适合穿外套';
    expect(longWeather.length).toBeGreaterThan(40);
    expect(classifyIntent(longWeather)).toBeNull();
  });
});

describe('extractLocation', () => {
  it('strips time/intent words and keeps the city', () => {
    expect(extractLocation('北京明天天气')).toBe('北京');
    expect(extractLocation('weather in tokyo')).toBe('tokyo');
  });
});

describe('parseFxQuery', () => {
  it('parses English currency pairs with optional amount', () => {
    expect(parseFxQuery('100 usd to cny')).toEqual({ from: 'USD', to: 'CNY', amount: 100 });
    expect(parseFxQuery('usd cny')).toEqual({ from: 'USD', to: 'CNY', amount: 1 });
    expect(parseFxQuery('5 EUR in JPY')).toEqual({ from: 'EUR', to: 'JPY', amount: 5 });
  });

  it('parses Chinese currency phrases', () => {
    expect(parseFxQuery('1美元等于多少人民币')).toEqual({ from: 'USD', to: 'CNY', amount: 1 });
    expect(parseFxQuery('人民币兑日元')).toEqual({ from: 'CNY', to: 'JPY', amount: 1 });
    expect(parseFxQuery('美元汇率')).toEqual({ from: 'USD', to: 'CNY', amount: 1 });
  });

  it('rejects non-currency queries', () => {
    expect(parseFxQuery('你好吗')).toBeNull();
    expect(parseFxQuery('今天天气')).toBeNull();
  });
});

describe('resolveStockSymbol', () => {
  it('resolves known Chinese names and tickers', () => {
    expect(resolveStockSymbol('苹果股价')).toBe('usAAPL');
    expect(resolveStockSymbol('贵州茅台')).toBe('sh600519');
    expect(resolveStockSymbol('腾讯控股')).toBe('hk00700');
  });

  it('resolves explicit market codes and bare tickers', () => {
    expect(resolveStockSymbol('0700.hk')).toBe('hk00700');
    expect(resolveStockSymbol('aapl.us')).toBe('usAAPL');
    expect(resolveStockSymbol('tsla')).toBe('usTSLA');
  });

  it('returns null for non-stock queries', () => {
    expect(resolveStockSymbol('not a ticker')).toBeNull();
    expect(resolveStockSymbol('github')).toBeNull();
  });
});

describe('parseRssItems', () => {
  it('extracts title/link/date/description from RSS item blocks', () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>First story</title><link>https://example.com/1</link><pubDate>Mon, 11 Aug 2026 10:00:00 GMT</pubDate><description>Lead paragraph one.</description></item>
      <item><title>Second story</title><link>https://example.com/2</link><pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate><description>Lead paragraph two.</description></item>
    </channel></rss>`;
    const items = parseRssItems(xml);
    expect(items.length).toBe(2);
    expect(items[0].title).toBe('First story');
    expect(items[0].link).toBe('https://example.com/1');
    expect(items[0].date).toContain('2026');
    expect(items[1].description).toBe('Lead paragraph two.');
  });
});


describe('tryDirectPublicApi (mocked network)', () => {
  it('answers an FX lookup from the Frankfurter API', async () => {
    mockFetchOnce({ rates: { CNY: 7.2 }, date: '2026-08-16' });
    const outcome = await tryDirectPublicApi('100 usd to cny');
    expect(outcome?.intent).toBe('fx');
    expect(outcome?.source).toBe('Frankfurter (ECB)');
    expect(outcome?.text).toContain('100 USD = 720.00 CNY');
    expect(outcome?.text).toContain('1 USD = 7.2 CNY');
  });

  it('cachedDirectPublicApi serves a fresh repeat query from the shared cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pure-pubapi-cache-'));
    process.env.PURE_CACHE_DIR = dir;
    resetWebCache();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ rates: { CNY: 7.2 }, date: '2026-08-16' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const first = await cachedDirectPublicApi('100 usd to cny');
    expect(first.outcome?.intent).toBe('fx');
    expect(first.cached).toBe(false);
    expect(calls).toBe(1);

    // Second call: same query → cache hit, no network.
    const second = await cachedDirectPublicApi('100 usd to cny');
    expect(second.outcome?.source).toBe('Frankfurter (ECB)');
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);

    // Location changes the key → fresh resolve.
    const third = await cachedDirectPublicApi('100 usd to cny', undefined, 'beijing');
    expect(third.cached).toBe(false);
    expect(calls).toBe(2);

    rmSync(dir, { recursive: true, force: true });
    resetWebCache();
    delete process.env.PURE_CACHE_DIR;
  });

  it('does not cache failed resolutions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pure-pubapi-cache-'));
    process.env.PURE_CACHE_DIR = dir;
    resetWebCache();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('', { status: 500 });
    }) as unknown as typeof fetch;

    // FX lookup touches the network; a 500 makes the resolver return null.
    const first = await cachedDirectPublicApi('100 usd to cny');
    expect(first.outcome).toBeNull();
    const second = await cachedDirectPublicApi('100 usd to cny');
    expect(second.outcome).toBeNull();
    expect(calls).toBe(2); // re-resolved, nothing cached

    rmSync(dir, { recursive: true, force: true });
    resetWebCache();
    delete process.env.PURE_CACHE_DIR;
  });

  it('assigns per-intent TTLs (news is minutes-fresh, wiki is weeks-fresh)', () => {
    expect(PUBLIC_API_TTL_MS.news).toBe(10 * 60 * 1000);
    expect(PUBLIC_API_TTL_MS.weather).toBe(20 * 60 * 1000);
    expect(PUBLIC_API_TTL_MS.wiki).toBe(7 * 24 * 60 * 60 * 1000);
    expect(PUBLIC_API_TTL_MS.geocode).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('answers a weather query through geocode + forecast', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: any) => {
      calls += 1;
      const url = String(input);
      if (url.includes('geocoding-api.open-meteo.com')) {
        return new Response(JSON.stringify({
          results: [{ name: '北京', latitude: 39.9, longitude: 116.4, country: '中国' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        timezone: 'Asia/Shanghai',
        current: { time: '2026-08-16T12:00', temperature_2m: 27, apparent_temperature: 29, relative_humidity_2m: 55, precipitation: 0, weather_code: 2, wind_speed_10m: 12 },
        daily: {
          time: ['2026-08-16', '2026-08-17', '2026-08-18'],
          temperature_2m_max: [30, 31, 29],
          temperature_2m_min: [22, 23, 21],
          precipitation_probability_max: [10, 20, 30],
          weather_code: [2, 3, 61],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const outcome = await tryDirectPublicApi('北京明天天气');
    expect(calls).toBe(2);
    expect(outcome?.intent).toBe('weather');
    expect(outcome?.source).toBe('Open-Meteo');
    expect(outcome?.text).toContain('北京');
    expect(outcome?.text).toContain('27°C');
    expect(outcome?.text).toContain('明日');
  });

  it('returns null for queries outside the structured intents', async () => {
    const outcome = await tryDirectPublicApi('react 状态管理最佳实践');
    expect(outcome).toBeNull();
  });
});
