// src/adapter/node/__tests__/fetchFallback.test.ts
// Pure-helper tests for the Tier-3 fallback chain (direct retry / meta-refresh
// follow / Wayback / Firecrawl / PDF text). All network is mocked; the PDF
// fixture is generated in-memory with zlib so no binary fixture file is needed.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deflateSync } from 'node:zlib';
import {
  fetchWithRetry,
  extractMetaRefreshUrl,
  resolveRedirectTarget,
  scrapeViaWayback,
  scrapeViaFirecrawl,
  extractPdfText,
  cliFetch,
  cliProxyFor,
  hostMatchesNoProxy,
  resolveEnvProxy,
} from '../fetchFallback';

/** Build a minimal single-page PDF whose content stream holds `content`. */
function buildPdf(content: string): Uint8Array {
  const deflated = deflateSync(new TextEncoder().encode(content));
  const head = new TextEncoder().encode(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`,
  );
  const tail = new TextEncoder().encode(
    `\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF`,
  );
  return new Uint8Array([...head, ...deflated, ...tail]);
}

describe('fetchWithRetry', () => {
  it('retries transient 5xx with backoff, then succeeds', async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3) return new Response('boom', { status: 503 });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const resp = await fetchWithRetry('https://example.com/');
      expect(resp.status).toBe(200);
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not retry a hard 4xx', async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const resp = await fetchWithRetry('https://example.com/');
      expect(resp.status).toBe(404);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('adds a same-origin Referer header', async () => {
    let seen: Headers | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      seen = new Headers(init.headers);
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await fetchWithRetry('https://example.com/page');
      expect(seen?.get('Referer')).toBe('https://example.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('三处调用点的语义必须逐条一致（cliFetch 收口后的回归锁）', () => {
  // 收口前 fetchFallback 与 NodeToolAdapter 各有一份 cliProxyFor，两份都在用，且 SOCKS 文案已经漂移。
  // 现在定义唯一（shared/cliFetch.ts），三处只做 re-export。这里用“对对的公式身份”把这一点
  // 锁死：任何一处回开自己的实现，这里立即失败。
  it('fetchFallback 与 NodeToolAdapter 导出的是同一个函数对象', async () => {
    const shared = await import('../../../shared/cliFetch');
    const fallback = await import('../fetchFallback');
    const adapter = await import('../NodeToolAdapter');
    expect(fallback.cliFetch).toBe(shared.cliFetch);
    expect(fallback.cliProxyFor).toBe(shared.cliProxyFor);
    expect(fallback.hostMatchesNoProxy).toBe(shared.hostMatchesNoProxy);
    expect(fallback.resolveEnvProxy).toBe(shared.resolveEnvProxy);
    expect(adapter.cliFetch).toBe(shared.cliFetch);
    expect(adapter.cliProxyFor).toBe(shared.cliProxyFor);
    expect(adapter.hostMatchesNoProxy).toBe(shared.hostMatchesNoProxy);
    expect(adapter.resolveEnvProxy).toBe(shared.resolveEnvProxy);
    expect(adapter.parseProxy).toBe(shared.parseProxy);
    expect(adapter.isPrivateHost).toBe(shared.isPrivateHost);
  });

  it('publicApis 也导出同一个函数（静态查源码里的 import）', async () => {
    // publicApis 不重导出 cliFetch，只导入使用；用源码表达式把它扎在收口的那一份上。
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../publicApis.ts', import.meta.url), 'utf8');
    expect(src).toContain("import { cliFetch } from '../../shared/cliFetch'");
    expect(src).not.toContain("from './fetchFallback'");
  });

  it('三个调用点对同一个 URL 得到同一个出口路由', async () => {
    const shared = await import('../../../shared/cliFetch');
    const fallback = await import('../fetchFallback');
    const adapter = await import('../NodeToolAdapter');
    for (const url of ['https://example.com/a', 'http://127.0.0.1:8080/x', 'not a url']) {
      const viaShared = shared.cliProxyFor(url);
      expect(fallback.cliProxyFor(url)).toEqual(viaShared);
      expect(adapter.cliProxyFor(url)).toEqual(viaShared);
    }
  });
});

describe('CLI 出口代理路由（定义在 shared/cliFetch，三处调用点共用）', () => {
  // 实现已从本文件与 NodeToolAdapter 收口到 shared/cliFetch.ts；下面这些断言三处调用
  // 点共用同一份实现，不再需要两份对齐。
  const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  let saved: Record<string, string | undefined> = {};

  function setEnv(vars: Record<string, string>): void {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, vars);
  }

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    setEnv({});
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('没有配置时代理恒为空（直连）', () => {
    expect(cliProxyFor('https://example.com/x')).toEqual({ proxy: '', direct: true });
    expect(resolveEnvProxy()).toBe('');
  });

  it('从环境变量取代理，并回传到 fetch 的原生 proxy 选项', async () => {
    setEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    expect(cliProxyFor('https://example.com/x')).toEqual({ proxy: 'http://127.0.0.1:7890', direct: false });

    let seenProxy: unknown;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: RequestInit & { proxy?: string }) => {
      seenProxy = init.proxy;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      // 代理优先主机（cohere.ai 在分类面里）：首选就是代理，所以第一次调用
      // 就应带上原生 proxy 选项。direct-first 主机的首选直连另有用例覆盖。
      await cliFetch('https://cohere.ai/x');
      // 必须用原生 proxy 选项：undici ProxyAgent 与 Bun 的 proxy 选项是两套
      // 栈，混用会出现「搜索走代理、下载不走」这种最难排查的不一致。
      expect(seenProxy).toBe('http://127.0.0.1:7890');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('direct-first 主机：直连 → 代理 → 直连·重试（75% 预算）', async () => {
    setEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    const seen: Array<string | undefined> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: RequestInit & { proxy?: string }) => {
      seen.push(init?.proxy);
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    try {
      await expect(cliFetch('https://cli-plan-direct.test/x')).rejects.toThrow();
      // 首选直连（不传 proxy）→ 反向代理 → 首选·重试（再直连）。
      expect(seen).toEqual([undefined, 'http://127.0.0.1:7890', undefined]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('非幂等请求（POST）不重试，避免重复副作用', async () => {
    setEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    const seen: Array<string | undefined> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: RequestInit & { proxy?: string }) => {
      seen.push(init?.proxy);
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    try {
      await expect(cliFetch('https://cli-plan-post.test/x', { method: 'POST' })).rejects.toThrow();
      expect(seen.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('真实连接失败措辞（Bun「Unable to connect」）也触发换路兜底', async () => {
    setEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    const seen: Array<string | undefined> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: RequestInit & { proxy?: string }) => {
      seen.push(init?.proxy);
      throw new Error('Unable to connect. Is the computer able to access the url?');
    }) as unknown as typeof fetch;
    try {
      await expect(cliFetch('https://cli-plan-real.test/x')).rejects.toThrow();
      expect(seen).toEqual([undefined, 'http://127.0.0.1:7890', undefined]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('取消/超时（AbortSignal）不换路重试：信号已 abort，重试只会立即再失败', async () => {
    setEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    const seen: Array<string | undefined> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: RequestInit & { proxy?: string }) => {
      seen.push(init?.proxy);
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;
    try {
      await expect(cliFetch('https://cli-plan-timeout.test/x', { signal: AbortSignal.timeout(50) })).rejects.toThrow();
      expect(seen.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('非网络类失败不换出口（换条路也答不出同一份字节）', async () => {
    setEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    const seen: Array<string | undefined> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: RequestInit & { proxy?: string }) => {
      seen.push(init?.proxy);
      throw new Error('JSON parse error');
    }) as unknown as typeof fetch;
    try {
      await expect(cliFetch('https://cli-plan-content.test/x')).rejects.toThrow();
      expect(seen.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('直连时完全不传 proxy（Bun 把 proxy:"" 当作「回退读环境变量」）', async () => {
    setEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '.internal.test' });
    let seenProxy: unknown = 'unset';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: RequestInit & { proxy?: string }) => {
      seenProxy = 'proxy' in init ? init.proxy : 'absent';
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await cliFetch('https://svc.internal.test/api');
      expect(seenProxy).toBe('absent');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('环回/私网地址永不走代理（走代理访问本机会形成自指死循环）', () => {
    setEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    for (const host of ['127.0.0.1:5173', '10.1.2.3', '192.168.0.9', 'localhost', 'foo.local']) {
      expect(cliProxyFor(`http://${host}/x`).direct).toBe(true);
    }
  });

  it('NO_PROXY 支持精确、后缀与通配', () => {
    expect(hostMatchesNoProxy('a.example.com', 'example.com')).toBe(false);
    expect(hostMatchesNoProxy('a.example.com', '.example.com')).toBe(true);
    expect(hostMatchesNoProxy('a.example.com', 'a.example.com')).toBe(true);
    expect(hostMatchesNoProxy('a.example.com', '*')).toBe(true);
  });

  it('SOCKS 明确报错而不是悄悄直连', async () => {
    setEnv({ ALL_PROXY: 'socks5://127.0.0.1:1080' });
    const route = cliProxyFor('https://example.com/x');
    expect(route.direct).toBe(false);
    expect(route.unsupported).toContain('SOCKS');
    await expect(cliFetch('https://example.com/x')).rejects.toThrow(/SOCKS/);
  });

  it('无法解析的代理地址同样拒绝执行', () => {
    setEnv({ ALL_PROXY: 'not a url' });
    expect(cliProxyFor('https://example.com/x').unsupported).toContain('无法解析');
  });
});

describe('extractMetaRefreshUrl', () => {
  it('parses refresh meta tags in both attribute orders', () => {
    expect(extractMetaRefreshUrl('<meta http-equiv="refresh" content="0; url=https://example.com/new" />')).toBe('https://example.com/new');
    expect(extractMetaRefreshUrl("<meta http-equiv=\"REFRESH\" content=\"5; url='/rel/path'\" />")).toBe('/rel/path');
    expect(extractMetaRefreshUrl('<meta content="0;url=https://a.com/" http-equiv="refresh">')).toBe('https://a.com/');
  });

  it('returns null when absent or not a refresh', () => {
    expect(extractMetaRefreshUrl('<html><body>plain</body></html>')).toBeNull();
    expect(extractMetaRefreshUrl('<meta charset="utf-8">')).toBeNull();
    expect(extractMetaRefreshUrl('<meta http-equiv="refresh" content="5">')).toBeNull();
  });
});

describe('resolveRedirectTarget', () => {
  it('resolves relative targets against the page URL', () => {
    expect(resolveRedirectTarget('https://a.com/x', '/new')).toBe('https://a.com/new');
    expect(resolveRedirectTarget('https://a.com/x', 'https://b.com/y')).toBe('https://b.com/y');
  });
});

describe('scrapeViaWayback', () => {
  it('fetches the closest archived snapshot', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('archive.org/wayback/available')) {
        return new Response(JSON.stringify({ archived_snapshots: { closest: { url: 'https://web.archive.org/web/20260828000000/https://example.com/', status: '200' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.startsWith('https://web.archive.org/web/')) {
        return new Response('<html><body><h1>Archived</h1><p>snapshot content</p></body></html>', { status: 200 });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const html = await scrapeViaWayback('https://example.com/');
      expect(html).toContain('snapshot content');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns null when no snapshot exists', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ archived_snapshots: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    try {
      expect(await scrapeViaWayback('https://never-archived.example/')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('scrapeViaFirecrawl', () => {
  it('is skipped without a key', async () => {
    expect(await scrapeViaFirecrawl('https://example.com/')).toBeNull();
  });

  it('returns markdown when the key is set', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, data: { markdown: '# Title\ncontent' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    try {
      const md = await scrapeViaFirecrawl('https://example.com/', 'fc-key');
      expect(md).toContain('# Title');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('extractPdfText', () => {
  it('extracts text from a FlateDecode Tj content stream', () => {
    const pdf = buildPdf('BT /F1 12 Tf 72 720 Td (Hello PDF world) Tj ET');
    const text = extractPdfText(pdf);
    expect(text).toBe('Hello PDF world');
  });

  it('extracts TJ arrays with kerning offsets', () => {
    const pdf = buildPdf('BT /F1 12 Tf 72 720 Td [(Hel) -20 (lo) 30 ( PDF) 10 (world)] TJ ET');
    const text = extractPdfText(pdf);
    expect(text).toBe('Hel lo PDF world');
  });

  it('handles escaped parentheses in literal strings', () => {
    const pdf = buildPdf('BT /F1 12 Tf 72 720 Td (a \\(parenthesis\\) b) Tj ET');
    const text = extractPdfText(pdf);
    expect(text).toBe('a (parenthesis) b');
  });

  it('returns null for non-PDF bytes', () => {
    expect(extractPdfText(new TextEncoder().encode('definitely not a pdf'))).toBeNull();
  });
});
