// src/shared/netRoute.ts
// Smart per-destination network routing: decide per HOST whether requests go
// direct or through the configured proxy — replacing the manual per-surface
// toggles (LLM/tools), which could not express "github needs the proxy but
// amap tiles must go direct" inside the same surface.
//
// Decision order in resolveNetRoute():
//   1. learned route for this host (persisted; evidence from real outcomes)
//   2. built-in classification: known-foreign hosts → proxy (when a proxy
//      exists), known-domestic hosts → direct
//   3. unknown hosts → direct (with a one-shot proxy fallback at the adapter)
// Learning (recordNetOutcome): whichever route LAST SUCCEEDED is remembered;
// a failed attempt clears the memory so classification decides again. Failed
// calls are never "learned" — retrying after a failure must stay possible.
// Persistence follows the netGuard pattern (localStorage, best-effort).

import { hostOf } from './netGuard';

export { hostOf };

export type NetRoute = 'direct' | 'proxy';

const STORE_KEY = 'pure.netRoute.v1';

const FOREIGN_SUFFIXES = [
  'openai.com',
  'anthropic.com',
  'claude.ai',
  'openrouter.ai',
  // NVIDIA's built-in provider (integrate.api.nvidia.com) is foreign-hosted —
  // leaving it unclassified routed it DIRECT and hung without a proxy.
  'nvidia.com',
  'github.com',
  'githubusercontent.com',
  'githubassets.com',
  'huggingface.co',
  'basemaps.cartocdn.com',
  'server.arcgisonline.com',
];

const DOMESTIC_SUFFIXES = [
  'deepseek.com',
  'bigmodel.cn',
  'z.ai',
  'dashscope.aliyuncs.com',
  'aliyuncs.com',
  'moonshot.cn',
  'minimax.io',
  'autonavi.com',
  'amap.com',
  'map.gtimg.com',
  'tianditu.gov.cn',
];

interface RouteEntry {
  route: NetRoute;
  at: number;
}

const learned = new Map<string, RouteEntry>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, RouteEntry>;
    for (const [host, entry] of Object.entries(parsed)) {
      if ((entry.route === 'direct' || entry.route === 'proxy') && typeof entry.at === 'number') {
        learned.set(host, { route: entry.route, at: entry.at });
      }
    }
  } catch {
    // corrupted store — start empty
  }
}

function persist(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const obj: Record<string, RouteEntry> = {};
    const now = Date.now();
    for (const [host, entry] of learned) {
      obj[host] = { route: entry.route, at: entry.at ?? now };
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(obj));
  } catch {
    // storage unavailable — in-memory routing still works
  }
}

export function hostSuffixMatch(host: string, suffixes: string[]): string | null {
  const h = host.toLowerCase();
  for (const suffix of suffixes) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return suffix;
  }
  return null;
}

/** Built-in destination class for a host: 'foreign' (needs the proxy),
 *  'domestic' (must NOT use it), or 'unknown'. */
export function classifyHost(host: string): 'foreign' | 'domestic' | 'unknown' {
  if (hostSuffixMatch(host, DOMESTIC_SUFFIXES)) return 'domestic';
  if (hostSuffixMatch(host, FOREIGN_SUFFIXES)) return 'foreign';
  return 'unknown';
}

/** Route decision for a host. Without a configured proxy everything is
 *  direct; classification only routes THROUGH the proxy when one exists. */
export function resolveNetRoute(host: string, hasProxy: boolean): NetRoute {
  ensureLoaded();
  const entry = learned.get(host);
  if (entry) return hasProxy ? entry.route : 'direct';
  if (!hasProxy) return 'direct';
  return classifyHost(host) === 'foreign' ? 'proxy' : 'direct';
}

/** Learn from a real outcome: success pins the route that worked; failure
 *  clears the memory so classification (or a route change) decides next. */
export function recordNetOutcome(host: string, route: NetRoute, ok: boolean): void {
  ensureLoaded();
  const entry = learned.get(host);
  if (ok) {
    if (entry?.route === route) return;
    learned.set(host, { route, at: Date.now() });
    persist();
  } else if (entry?.route === route) {
    learned.delete(host);
    persist();
  }
}

/** For a URL: the proxyUrl to try FIRST, and (when a proxy is configured)
 *  the OPPOSITE route as the one-shot fallback for network-class failures.
 *  Adapter contract: attempt first; on a network-class failure re-attempt
 *  once with fallbackProxyUrl; record the final outcome. */
export function netRouteProxyPair(
  url: string,
  proxyUrl: string,
): { proxyUrl: string; fallbackProxyUrl: string | null; host: string | null } {
  const host = hostOf(url);
  if (!proxyUrl || !host) return { proxyUrl, fallbackProxyUrl: null, host: null };
  const route = resolveNetRoute(host, true);
  return route === 'proxy'
    ? { proxyUrl, fallbackProxyUrl: '', host }
    : { proxyUrl: '', fallbackProxyUrl: proxyUrl, host };
}
