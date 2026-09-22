// src/shared/adviceApplication.ts
// 13.1 — 已应用建议的回看读模型（纯函数，无 IO）。写入半边在两处建议源：
// skill-gate 记录构造器在 subagentAdvisory.ts，tool-note 在 toolCorrections.ts；
// 这里只做"读了怎么算"：从观测日志里收集 advice_applied 记录，并为每条现算
// "应用后"的数字（skill-gate → 该角色其后的派发/失败；tool-note → 该工具其后
// 的失败调用，不分错误类——观测里只有错误分类标签没有原文，分不了）。

import type { AdviceAppliedObservation, PromptObservation } from './promptObservability';

/** 仪表盘是"扫一眼"不是审计台：只回看最近 N 条应用记录。 */
export const MAX_APPLIED_ADVICE_ROWS = 10;

/** 按应用时间倒序取最近的已应用建议记录。 */
export function collectAppliedAdvice(
  records: readonly PromptObservation[],
  limit = MAX_APPLIED_ADVICE_ROWS,
): AdviceAppliedObservation[] {
  return records
    .filter((record): record is AdviceAppliedObservation => record.type === 'advice_applied')
    .sort((a, b) => b.appliedAt - a.appliedAt)
    .slice(0, limit);
}

export interface PostApplyStats {
  /** skill-gate：应用之后该角色被派发的次数（0 = 还没再派发过）。 */
  delegations: number;
  /** 应用之后该目标（角色或工具）失败的次数。 */
  failures: number;
}

/**
 * "应用了之后后来怎么样了"：从 appliedAt 起数目标的后继行为。只读单条记录
 * 就能算（agent_run.toolCalls 的 toolName 即角色名/工具名），不依赖 T1 的
 * delegations 字段——旧记录也回看得动。
 */
export function postApplyStats(
  records: readonly PromptObservation[],
  applied: AdviceAppliedObservation,
  now: number,
): PostApplyStats {
  let delegations = 0;
  let failures = 0;
  if (applied.appliedAt > now) return { delegations, failures };
  for (const record of records) {
    if (record.type !== 'agent_run') continue;
    if (record.startedAt < applied.appliedAt || record.startedAt > now) continue;
    for (const call of record.toolCalls) {
      if (call.toolName !== applied.target) continue;
      if (applied.kind === 'skill-gate') delegations++;
      if (!call.success) failures++;
    }
  }
  return { delegations, failures };
}
