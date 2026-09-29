// src/shared/contributionStats.ts
// P0 棘轮 — 注入贡献聚合：把带 memoryInjection 的 agent_run 观测按条目（记忆
// id / `skill:` 前缀的技能名）切片，回答"这条记忆/技能在场时 run 跑得怎么样"。
// 只读纯函数，输入是 PromptObservability.records() 的任意子集；棘轮淘汰公式
// 与漂移报警都从这里拿数字。
//
// 切分的前提是记录里就带着名单：Harness 在 startRun 时把 composeMemoryPrompt
// 选定的 entryIds/skills 挂上同一条 agent_run 记录（与 E4.1 的 strategy 同一
// 缝），toolCalls/verification/outcome 同记录共存 —— 聚合端零 join。
// memoryInjection 字段缺席的旧记录直接跳过（无数据 ≠ 零贡献）。

import type { AgentRunObservation, PromptObservation } from './promptObservability';

/** 技能名在贡献 key 空间里的前缀（记忆条目 id 原样作 key）。 */
export const SKILL_CONTRIBUTION_PREFIX = 'skill:';

export interface EntryContributionSlice {
  entryId: string;
  /** 该条目在场的 run 数（只数有 outcome 的 —— 无裁决的 run 不进分子分母）。 */
  runs: number;
  /** Completed 且未被中断。 */
  completions: number;
  /** 其余全部算失败（含 interrupted）—— 与 E4.2 "intervention = interrupted
   *  OR failed" 同一口径。 */
  failures: number;
  /** failures / runs，两位小数。 */
  failureRate: number;
  /** 最近一次在场 run 的 startedAt。 */
  lastRunAt?: number;
}

function emptySlice(entryId: string): EntryContributionSlice {
  return { entryId, runs: 0, completions: 0, failures: 0, failureRate: 0 };
}

function isAttributedRun(record: PromptObservation): record is AgentRunObservation {
  return record.type === 'agent_run' && record.memoryInjection !== undefined;
}

/** 单条记录展开成 key 列表（run 内去重，防 double-count）。injected === false
 *  表示 <session_memory> 没活过 token 预算 —— 整个 run 不计入任何条目（它们
 *  没真正到场；技能片段暂无独立标志，随本布尔一起保守处理：宁可少记，不多记）。 */
function injectionKeys(record: AgentRunObservation): string[] {
  const injection = record.memoryInjection!;
  if (injection.injected === false) return [];
  const keys = [...new Set(injection.entryIds)];
  for (const name of injection.skills ?? []) keys.push(`${SKILL_CONTRIBUTION_PREFIX}${name}`);
  return keys;
}

/** 零 join 单遍扫描：key → 贡献切片。 */
export function summarizeInjectionContributions(records: readonly PromptObservation[]): Map<string, EntryContributionSlice> {
  const slices = new Map<string, EntryContributionSlice>();
  for (const record of records) {
    if (!isAttributedRun(record)) continue;
    if (!record.outcome) continue; // 无裁决的 run 不进分子分母
    const completed = record.outcome.isComplete && !record.outcome.interrupted;
    for (const key of injectionKeys(record)) {
      const slice = slices.get(key) ?? emptySlice(key);
      slice.runs++;
      if (completed) slice.completions++;
      else slice.failures++;
      slice.failureRate = Math.round((slice.failures / slice.runs) * 100) / 100;
      slice.lastRunAt = slice.lastRunAt === undefined
        ? record.startedAt
        : Math.max(slice.lastRunAt, record.startedAt);
      slices.set(key, slice);
    }
  }
  return slices;
}
