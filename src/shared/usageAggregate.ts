// src/shared/usageAggregate.ts
// Cross-session usage aggregation for the 用量统计 settings page. Pure + sync:
// takes per-session stat entries and returns user-level totals, so the math
// unit-tests without localStorage/DOM. The DOM layer (src/ui/usageStats.ts)
// feeds it from the store (src/ui/store.ts SessionStats), which structurally
// satisfies the minimal `SessionStatsLike` shape here — shared never imports ui.

import type { TokenUsage } from './types';
import { estimateCostUsd } from './usage';

/** Minimal per-session shape consumed by the aggregator (store.SessionStats
 * satisfies it structurally). */
export interface SessionStatsLike {
  provider?: string;
  usage?: TokenUsage | null;
  turns?: number;
  commands?: Array<{ command: string; success: boolean }>;
  fileWrites?: Array<{ success: boolean }>;
  fileReads?: unknown[];
  searches?: unknown[];
}

/** One session's metadata + stats, as the aggregator needs them. */
export interface UsageSessionEntry {
  sessionId: string;
  /** Epoch ms; used to bucket activity into calendar days. */
  createdAt: number;
  updatedAt: number;
  stats: SessionStatsLike;
}

export interface CommandFreq {
  command: string;
  count: number;
  successRate: number;
}

export interface ProviderCount {
  provider: string;
  sessions: number;
  costUsd: number;
}

export interface DayActivity {
  /** Local date key YYYY-MM-DD. */
  day: string;
  sessions: number;
}

export interface UserUsageAggregate {
  sessionCount: number;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheHitTokens: number;
  totalCacheMissTokens: number;
  totalCostUsd: number;
  providers: ProviderCount[];
  topCommands: CommandFreq[];
  commandSuccessRate: number;
  commandTotal: number;
  fileWriteTotal: number;
  last14Days: DayActivity[];
}

export interface AggregateOptions {
  now?: number;
  topN?: number;
}

/** Local YYYY-MM-DD key for an epoch ms timestamp. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Aggregate user-level usage across every session stat entry. */
export function aggregateUsage(entries: UsageSessionEntry[], opts: AggregateOptions = {}): UserUsageAggregate {
  const now = opts.now ?? Date.now();
  const topN = opts.topN ?? 8;

  let totalTurns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheHitTokens = 0;
  let totalCacheMissTokens = 0;
  let totalCostUsd = 0;
  let fileWriteTotal = 0;

  const providerCost = new Map<string, { sessions: number; costUsd: number }>();
  const commandCount = new Map<string, { count: number; success: number }>();
  let commandTotal = 0;
  let commandSuccess = 0;
  const daySessions = new Map<string, number>();

  const oldestDay = dayKey(now - 13 * 24 * 60 * 60 * 1000);

  for (const entry of entries) {
    const stats = entry.stats;
    totalTurns += stats.turns ?? 0;
    totalInputTokens += stats.usage?.promptTokens ?? 0;
    totalOutputTokens += stats.usage?.completionTokens ?? 0;
    totalCacheHitTokens += stats.usage?.cacheHitTokens ?? 0;
    totalCacheMissTokens += stats.usage?.cacheMissTokens ?? 0;
    fileWriteTotal += stats.fileWrites?.length ?? 0;

    const provider = stats.provider ?? 'unknown';
    const prev = providerCost.get(provider) ?? { sessions: 0, costUsd: 0 };
    prev.sessions += 1;
    prev.costUsd += estimateCostUsd(stats.usage ?? undefined, provider);
    providerCost.set(provider, prev);

    for (const cmd of stats.commands ?? []) {
      commandTotal += 1;
      if (cmd.success) commandSuccess += 1;
      const c = commandCount.get(cmd.command) ?? { count: 0, success: 0 };
      c.count += 1;
      if (cmd.success) c.success += 1;
      commandCount.set(cmd.command, c);
    }

    const key = dayKey(entry.updatedAt);
    if (key >= oldestDay) daySessions.set(key, (daySessions.get(key) ?? 0) + 1);
  }

  totalCostUsd = [...providerCost.values()].reduce((sum, p) => sum + p.costUsd, 0);

  const providers = [...providerCost.entries()]
    .map(([provider, v]) => ({ provider, sessions: v.sessions, costUsd: v.costUsd }))
    .sort((a, b) => b.sessions - a.sessions);

  const topCommands = [...commandCount.entries()]
    .map(([command, v]) => ({ command, count: v.count, successRate: v.count > 0 ? v.success / v.count : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  // Fill a contiguous 14-day window (oldest → today) so missing days render 0.
  const last14Days: DayActivity[] = [];
  for (let i = 13; i >= 0; i--) {
    const key = dayKey(now - i * 24 * 60 * 60 * 1000);
    last14Days.push({ day: key, sessions: daySessions.get(key) ?? 0 });
  }

  return {
    sessionCount: entries.length,
    totalTurns,
    totalInputTokens,
    totalOutputTokens,
    totalCacheHitTokens,
    totalCacheMissTokens,
    totalCostUsd,
    providers,
    topCommands,
    commandSuccessRate: commandTotal > 0 ? commandSuccess / commandTotal : 0,
    commandTotal,
    fileWriteTotal,
    last14Days,
  };
}
