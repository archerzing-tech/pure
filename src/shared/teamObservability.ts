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
import { estimateCostUsd, isPriceKnown } from './usage';

/**
 * The default role surface: the built-in eight minus `bash_executor` (a shell
 * command in an agent's coat, not a role — same verdict as the advice scanner).
 *
 * It is the **default**, not the truth. A role generated into
 * `~/.pure/subagents/` is registered and delegable but absent from this list, so
 * every one of its delegations used to fall outside the roster, the cost view
 * and the advice cards — which left the trial-period verdict (13.2) with nothing
 * to read. Hosts pass the real surface via `TeamRosterOptions.roles`.
 */
export const TEAM_ROLES: readonly string[] = [...KNOWN_SUBAGENT_ROLES].filter((role) => !NON_ROLE_SUBAGENTS.has(role));

/** The role surface a slice recognises: the default, or whatever the host
 *  actually registered. `bash_executor` is filtered out either way. */
export function roleSurface(roles?: readonly string[]): ReadonlySet<string> {
  if (!roles || roles.length === 0) return new Set(TEAM_ROLES);
  return new Set(roles.filter((role) => !NON_ROLE_SUBAGENTS.has(role)));
}

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
  /** The delegable role surface (built-ins + generated roles). Omitted = the
   *  built-in default, which is what every caller had before generated roles
   *  existed — kept as the default so a forgotten argument degrades to the old
   *  behaviour rather than to a wrong global. */
  roles?: readonly string[];
}

function emptyRow(role: string, caseCount: number): TeamRoleRow {
  return { role, delegations: null, successes: 0, successRate: null, avgDurationMs: null, caseCount };
}

/** 抽一条 run 记录里的委派切片：优先 T1 delegations，退回匿名 toolCalls。 */
function delegationSlices(record: AgentRunObservation, roles: ReadonlySet<string>): Array<{ role: string; success: boolean; durationMs?: number; tokens?: number }> {
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
    .filter((call) => roles.has(call.toolName))
    .map((call) => ({ role: call.toolName, success: call.success, durationMs: call.durationMs }));
}

/** 聚合窗口内的角色阵容。窗口按 startedAt（run 记录）过滤。 */
export function summarizeTeamRoster(records: readonly PromptObservation[], options: TeamRosterOptions = {}): TeamRoster {
  const now = options.now ?? Date.now();
  const days = options.windowDays ?? TEAM_WINDOW_DAYS;
  const windowStart = now - days * 24 * 60 * 60 * 1000;
  const minCases = options.minCases ?? 5;
  const caseCounts = options.caseCounts ?? {};
  const roles = roleSurface(options.roles);

  const rows = new Map<string, TeamRoleRow>([...roles].map((role) => [role, emptyRow(role, caseCounts[role] ?? 0)]));

  for (const record of records) {
    if (record.type !== 'agent_run' || (record.startedAt ?? 0) < windowStart) continue;
    for (const slice of delegationSlices(record, roles)) {
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

// ── T4 成本视图 ──
//
// 「这支团队贵在哪」：按 角色 × provider × model 聚合 T1 的委派 usage。
// provider/model 取自委派所属的 agent_run 记录（子代理跑在父轮的同一 adapter
// 上，所以同一 run 内的委派共享这一对）——记录本身没带 provider 时该行照实
// 显示「无数据」，不拿别的字段冒充。
//
// 两把尺子（与评测基线卡同款，13.3 part 2 的教训）：
//   1. 没有 usage 的委派**不计价**（unmetered）——不是 0 元；
//   2. provider 没有价目表的委派**不冒充 0**（unpriced）——显示「未定价」，
//      且不进占比的分母，否则真实成本会被虚低的百分比稀释。

/** T4 — one 角色 × provider × model 成本桶。 */
export interface TeamCostRow {
  role: string;
  /** 委派所属 run 的 provider；'' = 旧记录没带这个字段（渲染为「无数据」）。 */
  provider: string;
  model?: string;
  /** 该桶内的委派数（含无 usage 的）。 */
  delegations: number;
  /** 带 usage 的委派数——只有它们能进成本计算。 */
  metered: number;
  /** 有 usage 的委派 token 合计（prompt + completion，含缓存命中）。 */
  totalTokens?: number;
  /** 估算成本（USD）；只在 priced 为 true 时有值。 */
  costUsd?: number;
  /** 该桶确实算出了钱（有 usage 且 provider 有价目表）。 */
  priced: boolean;
  /** 占已定价成本合计的百分比（一位小数）；null = 没有已定价成本可比。 */
  sharePercent: number | null;
}

export interface TeamCostView {
  rows: TeamCostRow[];
  /** 已定价成本合计（USD）——未定价的委派不进这个数。 */
  totalUsd: number;
  /** 有 usage 但 provider 无价目表的委派数。 */
  unpricedDelegations: number;
  /** 完全没有 usage 的委派数（T1 之前的记录，或子代理没回用量）。 */
  unmeteredDelegations: number;
  /** 至少一条委派带了 usage（渲染层据此决定是画表还是给空态）。 */
  hasMetered: boolean;
  windowStart: number;
}

const UNKNOWN_PROVIDER = '';

/** 只保留能命名 provider 的行在前，其余按派发数排——未定价/无数据不占头名。 */
function bySpendThenVolume(a: TeamCostRow, b: TeamCostRow): number {
  if (a.priced !== b.priced) return a.priced ? -1 : 1;
  if (a.priced && b.priced) return (b.costUsd ?? 0) - (a.costUsd ?? 0);
  return b.delegations - a.delegations;
}

/** 聚合窗口内的委派成本（角色 × provider × model）。窗口按 run 的 startedAt 过滤。 */
export function summarizeTeamCosts(records: readonly PromptObservation[], options: TeamRosterOptions = {}): TeamCostView {
  const now = options.now ?? Date.now();
  const days = options.windowDays ?? TEAM_WINDOW_DAYS;
  const windowStart = now - days * 24 * 60 * 60 * 1000;

  const roles = roleSurface(options.roles);
  const rows = new Map<string, TeamCostRow>();
  let unpricedDelegations = 0;
  let unmeteredDelegations = 0;
  let hasMetered = false;

  for (const record of records) {
    if (record.type !== 'agent_run' || (record.startedAt ?? 0) < windowStart) continue;
    const provider = record.provider ?? UNKNOWN_PROVIDER;
    const model = record.model;
    const delegations = record.delegations;
    if (!delegations) {
      // T1 之前的记录只有匿名 toolCalls：数得出派发，但对不出任何用量。
      unmeteredDelegations += (record.toolCalls ?? [])
        .filter((call) => roles.has(call.toolName)).length;
      continue;
    }
    for (const delegation of delegations) {
      if (!roles.has(delegation.role)) continue;
      // NUL 分隔：角色名与 provider/model 里都不可能含它，省掉转义歧义。
      const key = `${delegation.role}\u0000${provider}\u0000${model ?? ''}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          role: delegation.role,
          provider,
          model,
          delegations: 0,
          metered: 0,
          priced: false,
          sharePercent: null,
        };
        rows.set(key, row);
      }
      row.delegations += 1;
      const usage = delegation.usage;
      if (!usage) {
        unmeteredDelegations += 1;
        continue;
      }
      row.metered += 1;
      hasMetered = true;
      row.totalTokens = (row.totalTokens ?? 0) + (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
      if (isPriceKnown(provider)) {
        row.priced = true;
        row.costUsd = (row.costUsd ?? 0) + estimateCostUsd(usage, provider);
      } else {
        unpricedDelegations += 1;
      }
    }
  }

  const totalUsd = [...rows.values()].reduce((sum, row) => sum + (row.priced ? row.costUsd ?? 0 : 0), 0);
  for (const row of rows.values()) {
    row.sharePercent = row.priced && totalUsd > 0
      ? Math.round(((row.costUsd ?? 0) / totalUsd) * 1000) / 10
      : null;
  }

  return {
    rows: [...rows.values()].sort(bySpendThenVolume),
    totalUsd,
    unpricedDelegations,
    unmeteredDelegations,
    hasMetered,
    windowStart,
  };
}
