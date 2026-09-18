// src/shared/strategyEffect.ts
// E4.1 — 策略效果聚合：把带 strategy 的 agent_run 观测按策略维度（exploration
// / verification / delegation / recovery / complexity）和子代理角色切片，回答
// "哪档策略真的跑得更稳"。只读纯函数，输入是 PromptObservability.records() 的
// 任意子集；E4.2 仪表盘直接消费，E1.4 的 per-role 自校正建议也从这里起步。
//
// 切分的前提是记录里就带着策略：Harness 在 startRun 时把 observeStrategy() 的
// 结果挂上同一条 agent_run 记录，toolCalls / verification / outcome 同记录共
// 存 —— 聚合端零 join。没有 strategy 的旧记录/辅助 run 直接跳过。

import { KNOWN_SUBAGENT_ROLES } from './adaptiveControl';
import type { AgentRunObservation, PromptObservation, StrategyObservation } from './promptObservability';

export type StrategyDimension = 'exploration' | 'verification' | 'delegation' | 'recovery' | 'complexity';

const DIMENSIONS: StrategyDimension[] = ['exploration', 'verification', 'delegation', 'recovery', 'complexity'];

export interface RunEffectSlice {
  runs: number;
  /** Completed 且未被中断 —— 这一档策略下"跑完并给出结果"的比例的分母是 runs。 */
  completed: number;
  interrupted: number;
  /** verification.status === 'passed' 的 run 数。 */
  verificationPassed: number;
  /** 'failed' 或 'incomplete' —— 没通过验证的都算。 */
  verificationFailed: number;
  /** 没有验证记录、或明确 not_run（无 verifier / 快问答）。 */
  verificationAbsent: number;
  toolCalls: number;
  toolFailures: number;
  totalDurationMs: number;
  avgDurationMs?: number;
}

export interface RoleEffectSlice {
  delegations: number;
  successes: number;
  totalDurationMs: number;
  avgDurationMs?: number;
}

export interface StrategyEffectSummary {
  overall: RunEffectSlice;
  byDimension: Record<StrategyDimension, Record<string, RunEffectSlice>>;
  byRole: Record<string, RoleEffectSlice>;
}

function isStrategyRun(record: PromptObservation): record is AgentRunObservation & { strategy: StrategyObservation } {
  return record.type === 'agent_run' && record.strategy !== undefined;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function emptyRunSlice(): RunEffectSlice {
  return {
    runs: 0,
    completed: 0,
    interrupted: 0,
    verificationPassed: 0,
    verificationFailed: 0,
    verificationAbsent: 0,
    toolCalls: 0,
    toolFailures: 0,
    totalDurationMs: 0,
  };
}

/** 把一条 run 计进 slice。验证三桶互斥且覆盖全部情况：passed / failed+incomplete
 *  / 无记录或 not_run。 */
function accumulate(slice: RunEffectSlice, record: AgentRunObservation): void {
  slice.runs++;
  if (record.outcome) {
    if (record.outcome.isComplete) slice.completed++;
    if (record.outcome.interrupted) slice.interrupted++;
  }
  const status = record.verification?.status;
  if (status === 'passed') slice.verificationPassed++;
  else if (status === 'failed' || status === 'incomplete') slice.verificationFailed++;
  else slice.verificationAbsent++;
  for (const call of record.toolCalls) {
    slice.toolCalls++;
    if (!call.success) slice.toolFailures++;
  }
  if (record.durationMs !== undefined && record.durationMs >= 0) {
    slice.totalDurationMs += record.durationMs;
    slice.avgDurationMs = round1(slice.totalDurationMs / slice.runs);
  }
}

/** 按单个策略维度切片：key 是该维度的档位值（如 verification → 'focused'）。 */
export function summarizeByDimension(records: readonly PromptObservation[], dimension: StrategyDimension): Record<string, RunEffectSlice> {
  const slices: Record<string, RunEffectSlice> = {};
  for (const record of records) {
    if (!isStrategyRun(record)) continue;
    const key = record.strategy[dimension];
    slices[key] = slices[key] ?? emptyRunSlice();
    accumulate(slices[key], record);
  }
  return slices;
}

/** 按子代理角色切片：子代理工具就是按角色命名的（KNOWN_SUBAGENT_ROLES），
 *  写路径不需要新字段 —— 这里按 toolName 归类即可。 */
export function summarizeByRole(records: readonly PromptObservation[]): Record<string, RoleEffectSlice> {
  const slices: Record<string, RoleEffectSlice> = {};
  for (const record of records) {
    if (record.type !== 'agent_run') continue;
    for (const call of record.toolCalls) {
      if (!KNOWN_SUBAGENT_ROLES.has(call.toolName)) continue;
      const slice = slices[call.toolName] ?? { delegations: 0, successes: 0, totalDurationMs: 0 };
      slice.delegations++;
      if (call.success) slice.successes++;
      if (call.durationMs > 0) slice.totalDurationMs += call.durationMs;
      slices[call.toolName] = slice;
    }
  }
  for (const slice of Object.values(slices)) {
    if (slice.totalDurationMs > 0) slice.avgDurationMs = round1(slice.totalDurationMs / slice.delegations);
  }
  return slices;
}

/** 一次性汇总：总体 + 五个策略维度 + 角色。E4.2 仪表盘的唯一入口。 */
export function summarizeStrategyEffects(records: readonly PromptObservation[]): StrategyEffectSummary {
  const overall = emptyRunSlice();
  for (const record of records) {
    if (isStrategyRun(record)) accumulate(overall, record);
  }
  const byDimension = Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, summarizeByDimension(records, dimension)]),
  ) as Record<StrategyDimension, Record<string, RunEffectSlice>>;
  return { overall, byDimension, byRole: summarizeByRole(records) };
}
