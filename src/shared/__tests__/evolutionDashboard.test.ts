// src/shared/__tests__/evolutionDashboard.test.ts
// E4.2 — 进化仪表盘的数据口径：窗口按本地日历日切、空桶是 null 而不是 0、
// 干预去重、错误簇按 工具 × 错误类 聚簇、策略切片只喂窗口内的记录。
//
// 断言全部相对"本地日"（用模块自己的 startOfLocalDay / localDayKey 算期望），
// 不写死日期字符串 —— 时区不同不该让测试红。

import { describe, it, expect } from 'bun:test';
import type { AgentRunObservation, PromptObservation, StrategyObservation } from '../promptObservability';
import {
  buildEvolutionDashboard,
  localDayKey,
  startOfLocalDay,
  DASHBOARD_MAX_CLUSTERS,
} from '../evolutionDashboard';

const NOW = startOfLocalDay(Date.now()) + 12 * 3600 * 1000; // 今天中午，本地时区

function strategy(overrides: Partial<StrategyObservation> = {}): StrategyObservation {
  return {
    exploration: 'targeted',
    verification: 'focused',
    delegation: 'none',
    recovery: 'continue-with-evidence',
    autonomy: 'unattended-local',
    complexity: 'trivial',
    confidence: 0.5,
    intentTags: ['code'],
    recommendedRoles: [],
    parallelRoles: [],
    priorArtHint: false,
    ...overrides,
  };
}

function run(overrides: Partial<AgentRunObservation> = {}): AgentRunObservation {
  return {
    type: 'agent_run',
    traceId: `run_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 's1',
    startedAt: NOW - 3600_000,
    eventCounts: {},
    toolCalls: [],
    reasoningChars: 0,
    outputChars: 0,
    ...overrides,
  };
}

function daysAgo(days: number, hour = 10): number {
  return startOfLocalDay(NOW) - days * 86_400_000 + hour * 3600_000;
}

const records: PromptObservation[] = [
  // 今天：完成 + 验证通过 + 3 次工具调用（一次网络失败）+ 缓存拆分。
  run({
    startedAt: daysAgo(0, 9),
    strategy: strategy({ verification: 'focused' }),
    outcome: { isComplete: true, interrupted: false },
    verification: { status: 'passed', evidence: [] },
    toolCalls: [
      { toolName: 'read_file', success: true, durationMs: 10 },
      { toolName: 'web_fetch', success: false, durationMs: 900, error: { kind: 'network', hash: 'h1', chars: 20 } },
      { toolName: 'web_fetch', success: true, durationMs: 800 },
    ],
    durationMs: 2000,
    cache: { hitTokens: 800, missTokens: 200, hitRate: 80 },
  }),
  // 今天：被中断 + 验证未通过（同一 run 两种干预只算一次）+ 又撞同一个错误簇。
  run({
    startedAt: daysAgo(0, 11),
    sessionId: 's2',
    strategy: strategy({ verification: 'thorough', delegation: 'parallel' }),
    outcome: { isComplete: false, interrupted: true },
    verification: { status: 'failed', evidence: [] },
    toolCalls: [
      { toolName: 'web_fetch', success: false, durationMs: 700, error: { kind: 'network', hash: 'h2', chars: 18 } },
      { toolName: 'write_file', success: false, durationMs: 4, error: { kind: 'permission', hash: 'h3', chars: 30 } },
    ],
    durationMs: 4000,
  }),
  // 3 天前：完成但没验证记录（verificationAbsent），中途被中断过一次。
  run({
    startedAt: daysAgo(3, 8),
    strategy: strategy({ verification: 'focused', delegation: 'targeted' }),
    outcome: { isComplete: true, interrupted: false },
    toolCalls: [{ toolName: 'read_file', success: true, durationMs: 5 }],
    durationMs: 1000,
  }),
  // 40 天前：在 window 之外（week / month 都看不见）——不该进任何切片。
  run({
    startedAt: daysAgo(40, 8),
    strategy: strategy({ verification: 'thorough' }),
    outcome: { isComplete: false, interrupted: true },
    toolCalls: [{ toolName: 'bash', success: false, durationMs: 5, error: { kind: 'timeout', hash: 'h4', chars: 9 } }],
    durationMs: 99,
  }),
  // 没有 strategy 的旧记录：不进策略切片，但窗口内的总量/趋势照常计入。
  run({ startedAt: daysAgo(1, 11), outcome: { isComplete: true, interrupted: false } }),
  // 组装记录：只进观测概览，永远不进 run 统计。
  {
    type: 'prompt_assembly',
    traceId: 'prompt_x',
    timestamp: daysAgo(2, 12),
    promptVersion: 'prompt_abc',
    system: { chars: 10, hash: 'aaaa' },
    budget: {
      contextWindowTokens: 0,
      outputReserveTokens: 0,
      safetyMarginTokens: 0,
      availableInputTokens: 0,
      estimatedInputTokens: 0,
      estimatedToolTokens: 0,
      includedFragmentIds: [],
      omittedFragmentIds: [],
      overBudget: false,
    },
  },
];

describe('buildEvolutionDashboard', () => {
  const week = buildEvolutionDashboard(records, { range: 'week', now: NOW });

  it('covers every day of the window, with empty days as null (not zero)', () => {
    expect(week.buckets).toHaveLength(7);
    expect(week.buckets.map((b) => b.date).at(-1)).toBe(localDayKey(NOW));
    expect(week.buckets[0].date).toBe(localDayKey(startOfLocalDay(NOW) - 6 * 86_400_000));
    // 第 5 天（4 天前）没有任何 run：计数是 0，比率是 null —— 折线不为它画谷底。
    const empty = week.buckets.find((b) => b.date === localDayKey(daysAgo(4)));
    expect(empty).toMatchObject({ runs: 0, completionRate: null, avgSteps: null, toolCalls: 0 });
  });

  it('buckets today: runs, completion rate, steps and interventions', () => {
    const today = week.buckets.find((b) => b.date === localDayKey(NOW))!;
    expect(today.runs).toBe(2);
    expect(today.completed).toBe(1);
    expect(today.completionRate).toBe(50);
    expect(today.interrupted).toBe(1);
    expect(today.verificationFailed).toBe(1);
    expect(today.interventions).toBe(1); // 同一 run 被中断 + 验证失败只算一次
    expect(today.toolCalls).toBe(5);
    expect(today.toolFailures).toBe(3);
    expect(today.avgSteps).toBe(2.5);
  });

  it('totals the window: completion rate, avg steps, duration and cache hit rate', () => {
    // 窗口内 4 个 run —— 40 天前那个不算。
    expect(week.windowRuns).toBe(4);
    expect(week.totals.runs).toBe(4);
    expect(week.totals.completed).toBe(3);
    expect(week.totals.interrupted).toBe(1);
    expect(week.totals.verificationFailed).toBe(1);
    expect(week.totals.interventions).toBe(1);
    expect(week.totals.completionRate).toBe(75);
    expect(week.totals.toolCalls).toBe(6);
    expect(week.totals.toolFailures).toBe(3);
    expect(week.totals.avgSteps).toBe(1.5);
    expect(week.totals.avgDurationMs).toBe(2333); // (2000 + 4000 + 1000) / 3 —— 没记时长的 run 不进均值
    expect(week.totals.cacheHitRate).toBe(80);
  });

  it('clusters failures by tool × kind inside the window only', () => {
    expect(week.errorClusters).toEqual([
      { tool: 'web_fetch', kind: 'network', count: 2, lastSeen: daysAgo(0, 11), sessions: 2 },
      { tool: 'write_file', kind: 'permission', count: 1, lastSeen: daysAgo(0, 11), sessions: 1 },
    ]);
    // 40 天前的 timeout 不在窗口内，连簇都不该出现。
    expect(week.errorClusters.some((c) => c.kind === 'timeout')).toBe(false);
  });

  it('feeds only in-window runs to the E4.1 strategy slices', () => {
    expect(week.strategy.overall.runs).toBe(3); // 窗口内 4 个 run 里有 1 个没有 strategy
    expect(week.strategy.byDimension.verification.focused.runs).toBe(2);
    expect(week.strategy.byDimension.verification.thorough.runs).toBe(1);
    expect(week.strategy.byDimension.verification.thorough.completed).toBe(0);
    expect(week.strategy.byDimension.delegation.parallel.runs).toBe(1);
  });

  it('counts every record for the observation overview, regardless of the window', () => {
    expect(week.observations).toEqual({
      total: records.length,
      runs: 5,
      assemblies: 1,
      oldestAt: daysAgo(40, 8),
      newestAt: daysAgo(0, 11),
    });
  });

  it('widens to the last 30 days for the month range', () => {
    const month = buildEvolutionDashboard(records, { range: 'month', now: NOW });
    expect(month.buckets).toHaveLength(30);
    expect(month.windowRuns).toBe(4);
    expect(month.windowStart).toBe(startOfLocalDay(NOW) - 29 * 86_400_000);
    expect(month.totals.completionRate).toBe(75);
  });

  it('returns null rates and no clusters for an empty window', () => {
    const empty = buildEvolutionDashboard([], { range: 'month', now: NOW });
    expect(empty.windowRuns).toBe(0);
    expect(empty.totals).toMatchObject({
      runs: 0,
      completionRate: null,
      avgSteps: null,
      avgDurationMs: null,
      cacheHitRate: null,
      interventions: 0,
    });
    expect(empty.buckets).toHaveLength(30);
    expect(empty.buckets.every((b) => b.runs === 0)).toBe(true);
    expect(empty.errorClusters).toEqual([]);
    expect(empty.observations).toEqual({ total: 0, runs: 0, assemblies: 0 });
  });

  it('leaves the cache marker null when no provider reported a split', () => {
    const noCache = buildEvolutionDashboard([run({ startedAt: daysAgo(0, 9) })], { range: 'week', now: NOW });
    expect(noCache.totals.cacheHitRate).toBeNull();
  });

  it('ignores future-dated runs (a stale clock must not skew today)', () => {
    const future = buildEvolutionDashboard([run({ startedAt: NOW + 86_400_000 })], { range: 'week', now: NOW });
    expect(future.windowRuns).toBe(0);
  });

  it('caps the error cluster list and sorts it by frequency', () => {
    const many: PromptObservation[] = [];
    const tools = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
    tools.forEach((tool, index) => {
      for (let n = 0; n <= index; n++) {
        many.push(run({
          startedAt: daysAgo(0, 9),
          toolCalls: [{ toolName: tool, success: false, durationMs: 1, error: { kind: 'tool_error', hash: `h${tool}${n}`, chars: 3 } }],
        }));
      }
    });
    const dashboard = buildEvolutionDashboard(many, { range: 'week', now: NOW });
    expect(dashboard.errorClusters).toHaveLength(DASHBOARD_MAX_CLUSTERS);
    expect(dashboard.errorClusters[0]).toMatchObject({ tool: 't8', count: 9 });
    expect(dashboard.errorClusters.map((c) => c.count)).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
  });
});
