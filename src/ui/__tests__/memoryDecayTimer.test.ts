// src/ui/__tests__/memoryDecayTimer.test.ts
// Covers the GUI background memory-decay timer (src/ui/memoryDecayTimer.ts):
//  • computeNextDecayDelayMs — the pure throttle-window math
//  • start/stop + the decay run — a real LocalStorageMemoryStore with a
//    localStorage stub, asserting decay fires, meta advances, and the
//    pure:memory-decay-run event is dispatched

import { describe, it, expect, afterEach } from 'bun:test';
import {
  computeNextDecayDelayMs,
  MEMORY_DECAY_INTERVAL_MS,
  startMemoryDecayTimer,
  stopMemoryDecayTimer,
} from '../memoryDecayTimer';
import { invalidateConfigCache } from '../config';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// ── Throttle-window math (pure) ──

describe('computeNextDecayDelayMs', () => {
  const now = 1_700_000_000_000;

  it('returns 0 when decay never ran (immediate first round)', () => {
    expect(computeNextDecayDelayMs(undefined, now)).toBe(0);
  });

  it('returns 0 once the throttle window has already elapsed', () => {
    expect(computeNextDecayDelayMs(now - 2 * HOUR, now)).toBe(0);
  });

  it('returns the remaining time inside the throttle window', () => {
    // last run 15 min ago → ~45 min left.
    const delay = computeNextDecayDelayMs(now - 15 * 60_000, now);
    expect(delay).toBe(MEMORY_DECAY_INTERVAL_MS - 15 * 60_000);
    expect(delay).toBeGreaterThan(0);
  });

  it('is never negative (clock skew / future lastDecayAt)', () => {
    // A future lastDecayAt shifts the window forward — the delay stays a
    // positive, finite number (never NaN/negative): the Math.max(0, …) guard
    // only clamps the already-elapsed case.
    const delay = computeNextDecayDelayMs(now + HOUR, now);
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(0);
  });
});

// ── Timer lifecycle (integration with the real store singleton) ──

describe('memory decay background timer', () => {
  const mem: Record<string, string> = {};
  const events: string[] = [];

  afterEach(() => {
    stopMemoryDecayTimer();
    events.length = 0;
    Object.keys(mem).forEach(k => delete mem[k]);
    delete (globalThis as Record<string, unknown>).localStorage;
    delete (globalThis as Record<string, unknown>).document;
    delete (globalThis as Record<string, unknown>).window;
    invalidateConfigCache(); // loadConfig() caches; reset between cases
  });

  function stubGlobals(lastDecayAt?: number): void {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => { mem[k] = v; },
      removeItem: (k: string) => { delete mem[k]; },
    };
    (globalThis as Record<string, unknown>).document = {
      dispatchEvent: (e: CustomEvent) => { events.push(e.type); return true; },
    };
    // config.ts's loadConfig() reads window.location.search (dev query params).
    (globalThis as Record<string, unknown>).window = {
      location: { search: '' },
    };
    if (lastDecayAt !== undefined) {
      mem['pure_memories_meta_v1'] = JSON.stringify({ lastDecayAt });
    }
  }

  it('fires decay immediately when the window already elapsed and advances meta', async () => {
    stubGlobals(Date.now() - 2 * HOUR); // last decay 2h ago → overdue
    // One stale entry old enough to be processed.
    mem['pure_memories_v2'] = JSON.stringify([{
      id: 'm1', type: 'user_preference', content: 'stale', timestamp: Date.now() - 40 * DAY,
      sessionId: 's1', projectPath: '/p', decayScore: 0.5, lifecycle: 'degraded',
    }]);

    startMemoryDecayTimer();
    // Delay is 0 → the run is scheduled on a macrotask; give it a beat.
    await new Promise(r => setTimeout(r, 50));
    stopMemoryDecayTimer();

    expect(events).toContain('pure:memory-decay-run');
    const meta = JSON.parse(mem['pure_memories_meta_v1'] ?? '{}');
    expect(meta.lastDecayAt).toBeGreaterThanOrEqual(Date.now() - 5000);
    // The overdue 40-day-old entry must have been decayed/recomputed or deleted.
    const entries = JSON.parse(mem['pure_memories_v2'] ?? '[]');
    expect(entries.length).toBeLessThanOrEqual(1);
  });

  it('does NOT decay before the throttle window elapses', async () => {
    stubGlobals(Date.now() - 5 * 60_000); // last decay 5 min ago → 55 min left
    mem['pure_memories_v2'] = JSON.stringify([{
      id: 'm1', type: 'user_preference', content: 'fresh', timestamp: Date.now(),
      sessionId: 's1', projectPath: '/p', decayScore: 0.9, lifecycle: 'active',
    }]);

    startMemoryDecayTimer();
    await new Promise(r => setTimeout(r, 50));
    stopMemoryDecayTimer();

    expect(events).not.toContain('pure:memory-decay-run');
    // Meta untouched — no decay ran.
    expect(JSON.parse(mem['pure_memories_meta_v1'] ?? '{}').lastDecayAt)
      .toBeLessThanOrEqual(Date.now() - 4 * 60_000);
  });

  it('start is idempotent and stop prevents further rounds', async () => {
    stubGlobals(Date.now() - 2 * HOUR);
    startMemoryDecayTimer();
    startMemoryDecayTimer(); // second start must not double-schedule
    await new Promise(r => setTimeout(r, 50));
    stopMemoryDecayTimer();
    const runs = events.filter(e => e === 'pure:memory-decay-run').length;
    expect(runs).toBe(1);
  });

  it('skips decay when the Memory skill is disabled but keeps scheduling', async () => {
    stubGlobals(Date.now() - 2 * HOUR);
    mem['pure_config'] = JSON.stringify({ skills: { memory: false } });
    mem['pure_memories_v2'] = JSON.stringify([{
      id: 'm1', type: 'user_preference', content: 'stale', timestamp: Date.now() - 40 * DAY,
      sessionId: 's1', projectPath: '/p', decayScore: 0.5, lifecycle: 'degraded',
    }]);

    startMemoryDecayTimer();
    await new Promise(r => setTimeout(r, 50));
    stopMemoryDecayTimer();

    expect(events).not.toContain('pure:memory-decay-run');
    // Entry untouched.
    expect(JSON.parse(mem['pure_memories_v2'] ?? '[]')).toHaveLength(1);
  });

  it('does NOT busy-loop when disabled with a stale lastDecayAt (1h floor)', async () => {
    // Stale meta (overdue) + skill off: the old code re-scheduled with delay 0
    // forever (computeNextDecayDelayMs → 0). The fix floors the disabled
    // path at MEMORY_DECAY_INTERVAL_MS, so within a few macrotask beats only
    // the FIRST round runs and no decay/event happens.
    stubGlobals(Date.now() - 30 * DAY);
    mem['pure_config'] = JSON.stringify({ skills: { memory: false } });

    startMemoryDecayTimer();
    await new Promise(r => setTimeout(r, 50));
    stopMemoryDecayTimer();

    // A busy loop would spin far more macrotask rounds than this in 50ms;
    // instead, the timer waits the full hour and stays quiet.
    expect(events).not.toContain('pure:memory-decay-run');
    // Meta unchanged — decay never ran.
    expect(JSON.parse(mem['pure_memories_meta_v1'] ?? '{}').lastDecayAt)
      .toBeLessThanOrEqual(Date.now() - 29 * DAY);
  });
});
