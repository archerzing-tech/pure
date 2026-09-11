// src/shared/netRoute.ts
// Smart per-destination network routing: decide per HOST whether requests go
// direct or through the configured proxy — replacing the manual per-surface
// toggles (LLM/tools), which could not express "github works direct but
// api.openai.com needs the proxy" inside the same surface.
//
// DIRECT-FIRST. Reachability cannot be known from a static list — it varies
// by network, ISP and time — so the default order is direct first with the
// configured proxy as the one-shot fallback (the 10s connect timeout bounds a
// wrong guess). Only hosts where a direct connection is reliably BLOCKED
// (silent-drop GFW behavior: every direct attempt just waits out the timeout)
// start proxy-first:
//
// Decision order in resolveNetRoute():
//   1. learned route for this host (persisted; evidence from real outcomes)
//   2. hard-blocked list (openai/anthropic/claude/huggingface) → proxy
//   3. everything else → direct
// Learning (recordNetOutcome): whichever route LAST SUCCEEDED is remembered;
// a failed attempt clears the memory so the order re-probes. Failed calls are
// never "learned" — retrying after a failure must stay possible.
// Persistence follows the netGuard pattern (localStorage, best-effort).

import { hostOf } from './netGuard';

export { hostOf };

export type NetRoute = 'direct' | 'proxy';

const STORE_KEY = 'pure.netRoute.v1';

// Hosts where a direct connection is not merely slow but reliably dropped —
// direct-first would burn the connect timeout EVERY turn. Deliberately short:
// an uncertain host is better served by direct-first + fallback, because a
// wrong guess costs one bounded attempt and then the learning pins the route
// that actually worked.
const BLOCKED_DIRECT_SUFFIXES = [
  'openai.com',
  'anthropic.com',
  'claude.ai',
  'huggingface.co',
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

/** True for the short hard-blocked list where direct-first is known-hopeless
 *  (silent-drop blocking) — these start proxy-first when a proxy exists. */
export function blockedDirectHost(host: string): boolean {
  return hostSuffixMatch(host, BLOCKED_DIRECT_SUFFIXES) !== null;
}

/** Route decision for a host. Without a configured proxy everything is
 *  direct; only the hard-blocked list starts THROUGH the proxy. */
export function resolveNetRoute(host: string, hasProxy: boolean): NetRoute {
  ensureLoaded();
  const entry = learned.get(host);
  if (entry) return hasProxy ? entry.route : 'direct';
  if (!hasProxy) return 'direct';
  return blockedDirectHost(host) ? 'proxy' : 'direct';
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
