// src/shared/__tests__/netRoute.test.ts
// Direct-first routing semantics: only the hard-blocked list starts proxy-
// first, learned routes (real outcomes) override classification, and a
// failure clears only the route that failed. Each test uses a distinct host
// — the learned map is module state and deliberately survives across tests
// within this file.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

let netRoute: typeof import('../netRoute');

beforeAll(async () => {
  GlobalRegistrator.register();
  netRoute = await import('../netRoute');
});

beforeEach(() => {
  localStorage.removeItem('pure.netRoute.v1');
});

afterAll(() => GlobalRegistrator.unregister());

describe('blockedDirectHost', () => {
  it('matches only the reliably-blocked direct list', () => {
    expect(netRoute.blockedDirectHost('api.openai.com')).toBe(true);
    expect(netRoute.blockedDirectHost('claude.ai')).toBe(true);
    expect(netRoute.blockedDirectHost('anthropic.com')).toBe(true);
    expect(netRoute.blockedDirectHost('huggingface.co')).toBe(true);
  });

  it('leaves reachable-direct hosts out — github/nvidia/domestic all direct-first', () => {
    expect(netRoute.blockedDirectHost('github.com')).toBe(false);
    expect(netRoute.blockedDirectHost('raw.githubusercontent.com')).toBe(false);
    expect(netRoute.blockedDirectHost('integrate.api.nvidia.com')).toBe(false);
    expect(netRoute.blockedDirectHost('api.deepseek.com')).toBe(false);
    expect(netRoute.blockedDirectHost('open.bigmodel.cn')).toBe(false);
    expect(netRoute.blockedDirectHost('example.org')).toBe(false);
  });
});

describe('resolveNetRoute', () => {
  it('routes hard-blocked hosts proxy-first when a proxy exists', () => {
    expect(netRoute.resolveNetRoute('api.openai.com', true)).toBe('proxy');
  });

  it('routes everything else direct-first — foreign, domestic, unknown alike', () => {
    expect(netRoute.resolveNetRoute('github.com', true)).toBe('direct');
    expect(netRoute.resolveNetRoute('integrate.api.nvidia.com', true)).toBe('direct');
    expect(netRoute.resolveNetRoute('api.deepseek.com', true)).toBe('direct');
    expect(netRoute.resolveNetRoute('example.org', true)).toBe('direct');
  });

  it('falls back to direct when no proxy is configured', () => {
    expect(netRoute.resolveNetRoute('api.openai.com', false)).toBe('direct');
  });
});

describe('recordNetOutcome', () => {
  it('pins a learned route over classification in both directions', () => {
    // A reachable-direct host that needed the proxy once: pin proxy.
    netRoute.recordNetOutcome('learned-proxy.test', 'proxy', true);
    expect(netRoute.resolveNetRoute('learned-proxy.test', true)).toBe('proxy');
    // A blocked-list host that turned out to work direct: pin direct.
    netRoute.recordNetOutcome('learned-direct.openai.com', 'direct', true);
    expect(netRoute.resolveNetRoute('learned-direct.openai.com', true)).toBe('direct');
  });

  it('a failure clears ONLY the route that failed', () => {
    netRoute.recordNetOutcome('keep-entry.test', 'proxy', true);
    // The opposite route failing says nothing about the learned one.
    netRoute.recordNetOutcome('keep-entry.test', 'direct', false);
    expect(netRoute.resolveNetRoute('keep-entry.test', true)).toBe('proxy');
    // The learned route failing un-pins it; classification decides again.
    netRoute.recordNetOutcome('keep-entry.test', 'proxy', false);
    expect(netRoute.resolveNetRoute('keep-entry.test', true)).toBe('direct');
  });

  it('persists learned routes to localStorage', () => {
    // The learned map loads ONCE per process; the honest persistence check is
    // the WRITE side — a recorded outcome must land in the store that the
    // next launch's ensureLoaded() reads.
    netRoute.recordNetOutcome('persist-write.test', 'proxy', true);
    const raw = localStorage.getItem('pure.netRoute.v1');
    expect(raw).toContain('persist-write.test');
    expect(JSON.parse(raw ?? '{}')['persist-write.test']?.route).toBe('proxy');
    localStorage.removeItem('pure.netRoute.v1');
  });
});

describe('netRouteProxyPair', () => {
  it('proxy-first hosts get the proxy as primary and DIRECT as fallback', () => {
    const pair = netRoute.netRouteProxyPair('https://api.openai.com/v1', 'http://127.0.0.1:7890');
    expect(pair.proxyUrl).toBe('http://127.0.0.1:7890');
    expect(pair.fallbackProxyUrl).toBe('');
    expect(pair.host).toBe('api.openai.com');
  });

  it('direct-first hosts go direct first with the proxy as one-shot fallback', () => {
    const pair = netRoute.netRouteProxyPair('https://github.com/x', 'http://127.0.0.1:7890');
    expect(pair.proxyUrl).toBe('');
    expect(pair.fallbackProxyUrl).toBe('http://127.0.0.1:7890');
  });

  it('without a proxy there is no fallback and no route decision at all', () => {
    // Contract: empty proxyUrl short-circuits — no fallback, no host.
    const pair = netRoute.netRouteProxyPair('https://api.openai.com/v1', '');
    expect(pair.proxyUrl).toBe('');
    expect(pair.fallbackProxyUrl).toBeNull();
    expect(pair.host).toBeNull();
  });
});
