// src/shared/evolutionDashboard.ts
// E4.2 —— 进化仪表盘的数据核心。输入是观测记录（E0.1 的 JSONL 读出来就是
// 这个形状）与时间范围，输出周/月趋势所需的全部切片：总体总量、逐日趋势桶、
// 错误簇（工具 × 错误类），以及 E4.1 的策略/角色切片。
//
// 只读纯函数，不碰 DOM / 存储 / 时钟（now 由调用方传入）——图表渲染、设置页
// 与未来的 CLI 统计共用同一套口径，测起来也不需要假 DOM。
//
// 口径（都是"未来读者会问"的三条）：
//   1. 窗口按**本地日历日**切：week = 最近 7 天（含今天）、month = 最近 30 天；
//      桶覆盖窗口内每一天（没有记录的日期留空桶），趋势线因此是连续时间轴。
//   2. 完成率 / 平均步数在空桶里是 null 而不是 0 —— 0% 与"那天没跑过"是两件事，
//      折线不该为没跑过的日子画一个谷底。
//   3. 干预 = 被中断（interrupted）**或** 验证未通过（failed/incomplete）的
//      run 数（同一 run 两种都占只算一次）；错误簇只统计窗口内带 error 的失败
//      工具调用，按 工具 × 错误类 聚簇。

import type { AgentRunObservation, PromptObservation } from './promptObservability';
import { summarizeStrategyEffects, type StrategyEffectSummary } from './strategyEffect';

export type DashboardRange = 'week' | 'month';

/** 窗口长度（天，含今天）。week = 周视图，month = 月视图。 */
export const DASHBOARD_WINDOW_DAYS: Record<DashboardRange, number> = { week: 7, month: 30 };

/** 错误簇展示上限（按出现次数降序取前 N）。 */
export const DASHBOARD_MAX_CLUSTERS = 8;

export interface ObservationStats {
  total: number;
  runs: number;
  assemblies: number;
  /** 全部记录里最早/最新的时间戳（没有可读记录时为 undefined）。 */
  oldestAt?: number;
  newestAt?: number;
}

export interface DashboardTotals {
  runs: number;
  completed: number;
  interrupted: number;
  verificationFailed: number;
  /** 被中断或验证未通过的 run 数（去重；见文件头口径 3）。 */
  interventions: number;
  /** 完成率百分比（一位小数）；窗口内没有 run 时为 null。 */
  completionRate: number | null;
  toolCalls: number;
  toolFailures: number;
  /** 平均步数（工具调用数 / run，一位小数）；没有 run 时为 null。 */
  avgSteps: number | null;
  avgDurationMs: number | null;
  /** provider 上下文缓存命中率百分比（一位小数）；没报缓存拆分时为 null。 */
  cacheHitRate: number | null;
}

export interface TrendBucket {
  /** 本地日历日 `YYYY-MM-DD`。 */
  date: string;
  runs: number;
  completed: number;
  completionRate: number | null;
  interrupted: number;
  verificationFailed: number;
  interventions: number;
  toolCalls: number;
  toolFailures: number;
  avgSteps: number | null;
}

export interface ErrorCluster {
  tool: string;
  /** promptObservability.observeError 归一的错误类（timeout / network / …）。 */
  kind: string;
  count: number;
  /** 最近一次发生时间（run 的 endedAt，退到 startedAt）。 */
  lastSeen: number;
  /** 命中过该簇的会话数（按 sessionId 去重；无 sessionId 的 run 记 1 个空会话）。 */
  sessions: number;
}

export interface EvolutionDashboard {
  range: DashboardRange;
  /** 窗口起点（本地当天 00:00 往前推 windowDays - 1 天）。 */
  windowStart: number;
  generatedAt: number;
  /** 全部传入记录的概览（E0.1 的"观测统计 UI"），不受窗口裁剪影响。 */
  observations: ObservationStats;
  /** 窗口内的 run 数（总量与趋势的分母来源）。 */
  windowRuns: number;
  totals: DashboardTotals;
  buckets: TrendBucket[];
  errorClusters: ErrorCluster[];
  /** E4.1 聚合结果，只喂窗口内的记录 —— "哪档策略真的跑得更稳"。 */
  strategy: StrategyEffectSummary;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 本地区历日起点（00:00:00.000）。 */
export function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 本地日历日键 `YYYY-MM-DD`（桶的 key，也是图表的 x 轴标签）。 */
export function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function isRun(record: PromptObservation): record is AgentRunObservation {
  return record.type === 'agent_run';
}

function runEndTime(record: AgentRunObservation): number {
  return record.endedAt && record.endedAt >= record.startedAt ? record.endedAt : record.startedAt;
}

function emptyBucket(date: string): TrendBucket {
  return {
    date,
    runs: 0,
    completed: 0,
    completionRate: null,
    interrupted: 0,
    verificationFailed: 0,
    interventions: 0,
    toolCalls: 0,
    toolFailures: 0,
    avgSteps: null,
  };
}

/** 一条 run 是否"发生过干预"：被中断或验证未通过（去重计数用）。 */
function wasIntervened(record: AgentRunObservation): boolean {
  if (record.outcome?.interrupted) return true;
  const status = record.verification?.status;
  return status === 'failed' || status === 'incomplete';
}

function accumulateBucket(bucket: TrendBucket, record: AgentRunObservation): void {
  bucket.runs++;
  if (record.outcome?.isComplete) bucket.completed++;
  if (record.outcome?.interrupted) bucket.interrupted++;
  const status = record.verification?.status;
  if (status === 'failed' || status === 'incomplete') bucket.verificationFailed++;
  if (wasIntervened(record)) bucket.interventions++;
  for (const call of record.toolCalls) {
    bucket.toolCalls++;
    if (!call.success) bucket.toolFailures++;
  }
}

function finalizeBucket(bucket: TrendBucket): void {
  bucket.completionRate = bucket.runs > 0 ? round1((bucket.completed / bucket.runs) * 100) : null;
  bucket.avgSteps = bucket.runs > 0 ? round1(bucket.toolCalls / bucket.runs) : null;
}

function buildObservationStats(records: readonly PromptObservation[]): ObservationStats {
  let runs = 0;
  let assemblies = 0;
  let oldestAt: number | undefined;
  let newestAt: number | undefined;
  const see = (timestamp: number | undefined) => {
    if (timestamp === undefined || !Number.isFinite(timestamp)) return;
    if (oldestAt === undefined || timestamp < oldestAt) oldestAt = timestamp;
    if (newestAt === undefined || timestamp > newestAt) newestAt = timestamp;
  };
  for (const record of records) {
    if (isRun(record)) {
      runs++;
      see(record.startedAt);
    } else if (record.type === 'prompt_assembly') {
      assemblies++;
      see(record.timestamp);
    } else {
      // advice_applied（13.1）：既不是 run 也不是 assembly，不进这两个计数，
      // 但 appliedAt 照样参与观测窗口的边界——它真实占用日志里的时间跨度。
      see(record.appliedAt);
    }
  }
  return { total: records.length, runs, assemblies, oldestAt, newestAt };
}

function buildErrorClusters(runs: readonly AgentRunObservation[]): ErrorCluster[] {
  const clusters = new Map<string, ErrorCluster & { sessionIds: Set<string> }>();
  for (const record of runs) {
    for (const call of record.toolCalls) {
      if (call.success || !call.error) continue;
      const key = `${call.toolName}::${call.error.kind}`;
      const existing = clusters.get(key) ?? {
        tool: call.toolName,
        kind: call.error.kind,
        count: 0,
        lastSeen: 0,
        sessions: 0,
        sessionIds: new Set<string>(),
      };
      existing.count++;
      existing.lastSeen = Math.max(existing.lastSeen, runEndTime(record));
      existing.sessionIds.add(record.sessionId ?? '');
      clusters.set(key, existing);
    }
  }
  return [...clusters.values()]
    .map(({ sessionIds, ...cluster }) => ({ ...cluster, sessions: sessionIds.size }))
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen || a.tool.localeCompare(b.tool))
    .slice(0, DASHBOARD_MAX_CLUSTERS);
}

/**
 * 一次性汇总：总体 + 逐日趋势桶 + 错误簇 + E4.1 策略/角色切片。
 * 设置页的进化仪表盘与（未来的）CLI 统计都从这里取数。
 */
export function buildEvolutionDashboard(
  records: readonly PromptObservation[],
  options: { range: DashboardRange; now?: number },
): EvolutionDashboard {
  const now = options.now ?? Date.now();
  const windowDays = DASHBOARD_WINDOW_DAYS[options.range];
  const windowStart = startOfLocalDay(now) - (windowDays - 1) * 86_400_000;

  const buckets = new Map<string, TrendBucket>();
  for (let offset = 0; offset < windowDays; offset++) {
    const dayStart = windowStart + offset * 86_400_000;
    buckets.set(localDayKey(dayStart), emptyBucket(localDayKey(dayStart)));
  }

  const windowRuns: AgentRunObservation[] = [];
  for (const record of records) {
    if (!isRun(record)) continue;
    const timestamp = record.startedAt;
    if (timestamp < windowStart || timestamp > now) continue;
    windowRuns.push(record);
    const bucket = buckets.get(localDayKey(timestamp));
    if (bucket) accumulateBucket(bucket, record);
  }
  for (const bucket of buckets.values()) finalizeBucket(bucket);

  let completed = 0;
  let interrupted = 0;
  let verificationFailed = 0;
  let interventions = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let totalDurationMs = 0;
  let timedRuns = 0;
  let cacheHit = 0;
  let cacheMiss = 0;
  for (const record of windowRuns) {
    if (record.outcome?.isComplete) completed++;
    if (record.outcome?.interrupted) interrupted++;
    const status = record.verification?.status;
    if (status === 'failed' || status === 'incomplete') verificationFailed++;
    if (wasIntervened(record)) interventions++;
    for (const call of record.toolCalls) {
      toolCalls++;
      if (!call.success) toolFailures++;
    }
    if (record.durationMs !== undefined && record.durationMs >= 0) {
      totalDurationMs += record.durationMs;
      timedRuns++;
    }
    cacheHit += record.cache?.hitTokens ?? 0;
    cacheMiss += record.cache?.missTokens ?? 0;
  }
  const cacheTotal = cacheHit + cacheMiss;

  return {
    range: options.range,
    windowStart,
    generatedAt: now,
    observations: buildObservationStats(records),
    windowRuns: windowRuns.length,
    totals: {
      runs: windowRuns.length,
      completed,
      interrupted,
      verificationFailed,
      interventions,
      completionRate: windowRuns.length > 0 ? round1((completed / windowRuns.length) * 100) : null,
      toolCalls,
      toolFailures,
      avgSteps: windowRuns.length > 0 ? round1(toolCalls / windowRuns.length) : null,
      avgDurationMs: timedRuns > 0 ? Math.round(totalDurationMs / timedRuns) : null,
      cacheHitRate: cacheTotal > 0 ? round1((cacheHit / cacheTotal) * 100) : null,
    },
    buckets: [...buckets.values()],
    errorClusters: buildErrorClusters(windowRuns),
    strategy: summarizeStrategyEffects(windowRuns),
  };
}
