// src/shared/parallelismSummary.ts
// B5 ——「并行机会」读数：一轮里派了几支、实际同时跑了几支。
//
// 起因（2026-10-16 整体审计）：多 agent 的并行是**模型自决 + 提示词软约束**，代码
// 里没有任何一处数过「本可并行却串了」。这条读数不改行为，只把已经落盘的委派记录
// （AgentRunObservation.delegations，带 startedAt / durationMs）折成两件事实：
//   - 一轮里 ≥2 支委派、时间上却从不重叠 → **串行扇出**（本可并行而没并行的候选）；
//   - 一轮扇出数超过并发上限 → 多出来的支只能排队（名义扇出被上限截断）。
//
// 诚实边界：这只能测「重叠与否」。「拆得太碎」（过拆）测不出来——那要看依赖关系与
// 参数相似度，本刀不做，也不拿一个替代指标冒充它。
//
// 分层：本模块在 shared，不允许反向 import engine，所以并发上限在这里镜像一份常量
// （engine/ToolExecutionCoordinator.ts 的 DEFAULT_MAX_READ_CONCURRENCY）。调用方
// 可以传真实 cap 覆盖；两边漂移时以调用方为准。

import type { PromptObservation } from './promptObservability';

/** 并发上限的镜像值。见文件头「分层」说明。 */
export const MIRRORED_READ_CONCURRENCY = 5;

/** 与仪表盘其它切片一致的 30 天窗口。 */
export const PARALLELISM_WINDOW_DAYS = 30;

export interface RunParallelism {
  traceId: string;
  startedAt: number;
  delegations: number;
  /** 本轮观察到的最大同时委派数（按每支的 [start, start+duration] 区间扫描）。 */
  maxConcurrency: number;
  /** ≥2 支委派却从不重叠——「本可并行却串了」的形状。 */
  sequential: boolean;
  /** 扇出数超过并发上限：多出来的支只能排队（名义扇出被上限截断）。 */
  exceedsCap: boolean;
}

export interface ParallelismSummary {
  windowStart: number;
  /** 窗口内带委派、且能算出形状的轮数。 */
  runs: number;
  /** 其中扇出 ≥2 支的轮数——单支没有「并行机会」可言。 */
  multiDelegationRuns: number;
  /** 上面这些里，完全串行的轮数。 */
  sequentialRuns: number;
  /** 扇出超过并发上限的轮数。 */
  exceedingRuns: number;
  /** 窗口内任一时刻观察到的最大同时委派数。 */
  maxConcurrencySeen: number;
  /** 只列扇出 ≥2 支的轮（按时间倒序）——单支的行不带信息。 */
  rows: RunParallelism[];
}

interface Span {
  start: number;
  end: number;
}

/**
 * 区间集合的最大重叠数（扫描线）。
 *
 * 空缺的 durationMs 折成最小占位（end = start + 1ms）：观察到的委派确实跑过一点
 * 时间，「没测到时长」不该让它连自己都不算——但 1ms 又不会把相邻的支误判成重叠。
 */
export function maxOverlap(spans: readonly Span[]): number {
  const points: Array<{ t: number; delta: number }> = [];
  for (const span of spans) {
    points.push({ t: span.start, delta: 1 });
    points.push({ t: Math.max(span.end, span.start + 1), delta: -1 });
  }
  // 同一时刻先减后加：相邻（首尾相接）不算重叠，零长区间不与自己相消出负数。
  points.sort((a, b) => (a.t - b.t) || (a.delta - b.delta));
  let current = 0;
  let max = 0;
  for (const point of points) {
    current += point.delta;
    if (current > max) max = current;
  }
  return max;
}

/** 单轮形状；不是 agent_run、或那一轮一支都没派 → null（无数据，不是 0）。 */
export function runParallelism(record: PromptObservation, cap: number = MIRRORED_READ_CONCURRENCY): RunParallelism | null {
  if (record.type !== 'agent_run') return null;
  const delegations = record.delegations ?? [];
  if (delegations.length === 0) return null;
  const maxConcurrency = maxOverlap(
    delegations.map((delegation) => ({ start: delegation.startedAt, end: delegation.startedAt + (delegation.durationMs ?? 0) })),
  );
  return {
    traceId: record.traceId,
    startedAt: record.startedAt,
    delegations: delegations.length,
    maxConcurrency,
    sequential: delegations.length >= 2 && maxConcurrency <= 1,
    exceedsCap: delegations.length > cap,
  };
}

/** 窗口内的并行机会汇总。纯函数：now / cap 由调用方给，便于断言。 */
export function summarizeParallelism(
  records: readonly PromptObservation[],
  options: { now?: number; windowDays?: number; cap?: number } = {},
): ParallelismSummary {
  const now = options.now ?? Date.now();
  const windowDays = options.windowDays ?? PARALLELISM_WINDOW_DAYS;
  const cap = options.cap ?? MIRRORED_READ_CONCURRENCY;
  const windowStart = now - windowDays * 24 * 60 * 60 * 1000;

  const runs: RunParallelism[] = [];
  for (const record of records) {
    if (record.type !== 'agent_run' || record.startedAt < windowStart) continue;
    const shape = runParallelism(record, cap);
    if (shape) runs.push(shape);
  }
  const multi = runs.filter((run) => run.delegations >= 2);
  return {
    windowStart,
    runs: runs.length,
    multiDelegationRuns: multi.length,
    sequentialRuns: multi.filter((run) => run.sequential).length,
    exceedingRuns: runs.filter((run) => run.exceedsCap).length,
    maxConcurrencySeen: runs.reduce((max, run) => Math.max(max, run.maxConcurrency), 0),
    rows: multi.sort((a, b) => b.startedAt - a.startedAt),
  };
}
