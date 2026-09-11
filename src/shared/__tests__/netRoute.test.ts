// src/shared/__tests__/netRoute.test.ts

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

describe('classifyHost', () => {
  it('classifies known-foreign hosts', () => {
    expect(netRoute.classifyHost('api.openai.com')).toBe('foreign');
    expect(netRoute.classifyHost('raw.githubusercontent.com')).toBe('foreign');
    expect(netRoute.classifyHost('claude.ai')).toBe('foreign');
    // NVIDIA is a built-in provider — an unclassified host would route direct
    // and hang for users who need the proxy.
    expect(netRoute.classifyHost('integrate.api.nvidia.com')).toBe('foreign');
  });

  it('classifies known-domestic hosts', () => {
    expect(netRoute.classifyHost('api.deepseek.com')).toBe('domestic');
    expect(netRoute.classifyHost('open.bigmodel.cn')).toBe('domestic');
    expect(netRoute.classifyHost('api.z.ai')).toBe('domestic');
  });

  it('returns unknown for unrecognized hosts', () => {
    expect(netRoute.classifyHost('example.org')).toBe('unknown');
  });
});

describe('resolveNetRoute', () => {
  it('routes known-foreign hosts through proxy when available', () => {
    expect(netRoute.resolveNetRoute('api.openai.com', true)).toBe('proxy');
  });

  it('routes domestic hosts direct', () => {
    expect(netRoute.resolveNetRoute('api.deepseek.com', true)).toBe('direct');
  });

  it('routes unknown hosts direct by default', () => {
    expect(netRoute.resolveNetRoute('example.org', true)).toBe('direct');
  });

  it('falls back to direct when no proxy is configured', () => {
    expect(netRoute.resolveNetRoute('api.openai.com', false)).toBe('direct');
  });
});

describe('recordNetOutcome', () => {
  it('learns from success and clears on failure', () => {
    const host = 'api.deepseek.com';
    netRoute.recordNetOutcome(host, 'proxy', true);
    expect(netRoute.resolveNetRoute(host, true)).toBe('proxy');

    // A failure clears the learned route.
    netRoute.recordNetOutcome(host, 'proxy', false);
    // Without a learned route, classification decides (domestic = direct).
    expect(netRoute.resolveNetRoute(host, true)).toBe('direct');
  });

  it('keeps the learning across route objects (persisted)', () => {
    localStorage.setItem('pure.netRoute.v1', JSON.stringify({
      'api.openai.com': { route: 'proxy', at: Date.now() },
    }));
    expect(netRoute.resolveNetRoute('api.openai.com', true)).toBe('proxy');
    localStorage.removeItem('pure.netRoute.v1');
  });
});
