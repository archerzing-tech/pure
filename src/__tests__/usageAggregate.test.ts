// src/__tests__/usageAggregate.test.ts
// Cross-session usage aggregation math: totals, per-provider cost, command
// frequency + success rate, and the 14-day activity window.

import { describe, expect, it } from 'bun:test';
import { aggregateUsage, dayKey, type UsageSessionEntry } from '../shared/usageAggregate';

const NOW = new Date(2026, 7, 30, 12, 0, 0).getTime(); // 2026-08-30 noon

function entry(overrides: Partial<UsageSessionEntry> = {}): UsageSessionEntry {
  return {
    sessionId: 's1',
    createdAt: NOW - 24 * 60 * 60 * 1000,
    updatedAt: NOW - 24 * 60 * 60 * 1000,
    stats: { turns: 1, commands: [], fileWrites: [] },
    ...overrides,
  };
}

describe('aggregateUsage', () => {
  it('sums tokens, turns, and cost across sessions', () => {
    const a = aggregateUsage([
      entry({ stats: { provider: 'deepseek-openai', turns: 3, usage: { promptTokens: 100, completionTokens: 50, cacheHitTokens: 20, cacheMissTokens: 80 } } }),
      entry({ stats: { provider: 'deepseek-openai', turns: 2, usage: { promptTokens: 40, completionTokens: 10 } } }),
    ], { now: NOW });
    expect(a.sessionCount).toBe(2);
    expect(a.totalTurns).toBe(5);
    expect(a.totalInputTokens).toBe(140);
    expect(a.totalOutputTokens).toBe(60);
    expect(a.totalCacheHitTokens).toBe(20);
    expect(a.totalCacheMissTokens).toBe(80);
    // deepseek-openai input $0.14/M (on cacheMiss), cache hit $0.0028/M,
    // output $0.28/M — estimateCostUsd prices the cache split, not raw prompt.
    expect(a.totalCostUsd).toBeCloseTo((80 * 0.14 + 20 * 0.0028 + 50 * 0.28) / 1e6 + (40 * 0.14 + 10 * 0.28) / 1e6, 10);
  });

  it('groups providers by session count and cost', () => {
    const a = aggregateUsage([
      entry({ stats: { provider: 'deepseek-openai', usage: { promptTokens: 1000 } } }),
      entry({ stats: { provider: 'deepseek-openai' } }),
      entry({ stats: { provider: 'qwen' } }),
    ], { now: NOW });
    const ds = a.providers.find((p) => p.provider === 'deepseek-openai')!;
    expect(ds.sessions).toBe(2);
    expect(a.providers[0].provider).toBe('deepseek-openai'); // sorted by count desc
  });

  it('ranks commands by frequency with success rate', () => {
    const a = aggregateUsage([
      entry({ stats: { commands: [
        { command: 'bun test', success: true },
        { command: 'bun test', success: true },
        { command: 'bun test', success: false },
        { command: 'bun run typecheck', success: true },
      ] } }),
    ], { now: NOW });
    expect(a.commandTotal).toBe(4);
    expect(a.commandSuccessRate).toBeCloseTo(0.75);
    expect(a.topCommands[0]).toEqual({ command: 'bun test', count: 3, successRate: 2 / 3 });
    expect(a.topCommands[1].command).toBe('bun run typecheck');
  });

  it('fills a contiguous 14-day activity window', () => {
    const a = aggregateUsage([
      entry({ updatedAt: NOW, createdAt: NOW }),            // today
      entry({ updatedAt: NOW - 3 * 86400000 }),             // 3 days ago
    ], { now: NOW });
    expect(a.last14Days).toHaveLength(14);
    expect(a.last14Days[13].day).toBe(dayKey(NOW));
    expect(a.last14Days[13].sessions).toBe(1);
    expect(a.last14Days[10].sessions).toBe(1); // 3 days ago
    expect(a.last14Days[0].sessions).toBe(0);
  });

  it('counts file writes', () => {
    const a = aggregateUsage([
      entry({ stats: { fileWrites: [{ success: true }, { success: false }] } }),
    ], { now: NOW });
    expect(a.fileWriteTotal).toBe(2);
  });
});
