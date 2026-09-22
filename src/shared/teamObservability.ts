// src/shared/teamObservability.ts
// 团队可观测 T3（北极星第 6 步）—— 角色阵容表的只读聚合器。
//
// 输入 = E4.1 观测记录（T1 起带 delegations[]）+ 每角色已收割的 case 数
// （宿主从 ~/.pure/roles/<role>/ 数出来传进来，本模块不做任何 IO）。
// 输出 = 渲染层直接消费的切片。
//
// 口径纪律（13.3 part 2 的同一把尺子）：旧记录没有 delegations 字段时该维度
// 显示「无数据」而不是 0——0 是缺口不是零。计数优先用 delegations（有身份的
// 委派），整条记录缺 delegations 时退回 toolCalls 的匿名计数（E4.1 口径），
// 两者都不存在才视为无数据。

import type { AgentRunObservation, DelegationObservation, PromptObservation } from './promptObservability';
import { KNOWN_SUBAGENT_ROLES } from './adaptiveControl';
import { NON_ROLE_SUBAGENTS } from './subagentAdvisory';

/** 与收割器（roleSampleHarvest）同一份可收割角色面：去掉 bash_executor。 */
export const TEAM_ROLES: readonly string[] = [...KNOWN_SUBAGENT_ROLES].filter((role) => !NON_ROLE_SUBAGENTS.has(role));

/** 一次窗口聚合的窗口长度（毫秒）——与仪表盘默认 30 天一致。 */
export const TEAM_WINDOW_DAYS = 30;

export interface TeamRoleRow {
  role: string;
  /** 窗口内派发数；null = 无数据（窗口内该角色没有记录）。 */
  delegations: number | null;
  successes: number;
  /** 成功率百分比（一位小数）；null = 无数据。 */
  successRate: number | null;
  avgDurationMs: number | null;
  /** T1 的 token 拆分合计；undefined = 没有任何一条带 usage（旧记录）。 */
  totalTokens?: number;
  /** 已收割入库的 case 数（宿主传入）。 */
  caseCount: number;
}

export interface TeamRoster {
  rows: TeamRoleRow[];
  /** 距离 A/B 门槛还差样本的角色（caseCount < minCases）。 */
  rolesShortOfGate: Array<{ role: string; caseCount: number; need: number }>;
  /** 观测口径下「观测到委派但已无法收割」的角色差距（收割对账的常驻提醒）。 */
  windowStart: number;
}

export interface TeamRosterOptions {
  now?: number;
  windowDays?: number;
  /** A/B 门槛（13.3 part 2 的 MIN_ROLE_CASES=5；注入避免 evaluation→shared 反向依赖）。 */
  minCases?: number;
  /** role → 已入库 case 数。 */
  caseCounts?: Record<string, number>;
}

function emptyRow(role: string, caseCount: number): TeamRoleRow {
  return { role, delegations: null, successes: 0, successRate: null, avgDurationMs: null, caseCount };
}

/** 抽一条 run 记录里的委派切片：优先 T1 delegations，退回匿名 toolCalls。 */
function delegationSlices(record: AgentRunObservation): Array<{ role: string; success: boolean; durationMs?: number; tokens?: number }> {
  if (record.delegations) {
    return record.delegations.map((delegation: DelegationObservation) => ({
      role: delegation.role,
      success: delegation.success ?? false,
      durationMs: delegation.durationMs,
      tokens: delegation.usage
        ? (delegation.usage.promptTokens ?? 0) + (delegation.usage.completionTokens ?? 0)
        : undefined,
    }));
  }
  return (record.toolCalls ?? [])
    .filter((call) => TEAM_ROLES.includes(call.toolName))
    .map((call) => ({ role: call.toolName, success: call.success, durationMs: call.durationMs }));
}

/** 聚合窗口内的角色阵容。窗口按 startedAt（run 记录）过滤。 */
export function summarizeTeamRoster(records: readonly PromptObservation[], options: TeamRosterOptions = {}): TeamRoster {
  const now = options.now ?? Date.now();
  const days = options.windowDays ?? TEAM_WINDOW_DAYS;
  const windowStart = now - days * 24 * 60 * 60 * 1000;
  const minCases = options.minCases ?? 5;
  const caseCounts = options.caseCounts ?? {};

  const rows = new Map<string, TeamRoleRow>(TEAM_ROLES.map((role) => [role, emptyRow(role, caseCounts[role] ?? 0)]));

  for (const record of records) {
    if (record.type !== 'agent_run' || (record.startedAt ?? 0) < windowStart) continue;
    for (const slice of delegationSlices(record)) {
      const row = rows.get(slice.role);
      if (!row) continue;
      row.delegations = (row.delegations ?? 0) + 1;
      if (slice.success) row.successes += 1;
      if (slice.durationMs && slice.durationMs > 0) {
        // 平均耗时按样本增量累计：total 只在本函数内部算，不进行外。
        (row as TeamRoleRow & { __total?: number }).__total = ((row as TeamRoleRow & { __total?: number }).__total ?? 0) + slice.durationMs;
      }
      if (slice.tokens) row.totalTokens = (row.totalTokens ?? 0) + slice.tokens;
    }
  }

  for (const row of rows.values()) {
    const total = (row as TeamRoleRow & { __total?: number }).__total;
    if (row.delegations !== null && row.delegations > 0) {
      row.successRate = Math.round((row.successes / row.delegations) * 1000) / 10;
      row.avgDurationMs = total && total > 0 ? Math.round(total / row.delegations) : null;
    }
    delete (row as TeamRoleRow & { __total?: number }).__total;
  }

  const rolesShortOfGate = [...rows.values()]
    .filter((row) => row.caseCount < minCases)
    .map((row) => ({ role: row.role, caseCount: row.caseCount, need: minCases - row.caseCount }));

  return { rows: [...rows.values()], rolesShortOfGate, windowStart };
}
