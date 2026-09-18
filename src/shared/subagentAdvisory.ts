// src/shared/subagentAdvisory.ts
// E1.4 —— 子代理角色自校正建议。E4.1 把每次派发的结局记进了观测记录（子代理工具
// 就是按角色命名的，toolCalls 里 toolName 即角色），这里把它读成"哪个角色在反复
// 掉链子"的结论：窗口内某个角色派发够多、失败够密 → 出一条建议卡。
//
// 第一版只建议，pure 绝不自动改配置（设计原话）：卡片告诉用户**哪个闸能拉**
//   - 有技能开关的角色（researcher / code_reviewer / project_auditor /
//     task_planner）→ 设置 → Skills 里关掉对应技能即可停止派发；
//   - 其余角色（code_editor / deep_thinker / ui_designer）今天没有开关 →
//     只能靠把任务描述写小、把步骤拆窄，卡片如实这么说，不假称有开关。
//
// 只读纯函数：输入观测记录 + 时间窗口，输出建议列表；不碰存储、不碰 DOM。

import { KNOWN_SUBAGENT_ROLES } from './adaptiveControl';
import type { AgentRunObservation, PromptObservation, ToolObservation } from './promptObservability';

/** 默认观察窗口（天）——与仪表盘月视图同一口径，够看出"持续"而不是一次偶然。 */
export const SUBAGENT_ADVICE_WINDOW_DAYS = 30;
/** 最少派发次数：低于此不构成"持续"（1 次失败不配叫模式）。 */
export const SUBAGENT_MIN_DELEGATIONS = 3;
/** 最少失败次数（与失败率双门：避免 1/2 这种小样本触发）。 */
export const SUBAGENT_MIN_FAILURES = 2;
/** 失败率门槛（0.4 = 十次里四次失败）。 */
export const SUBAGENT_FAILURE_RATE = 0.4;
/** 高严重度：失败率 ≥ 0.6，或超时类失败 ≥ 3 次。 */
export const SUBAGENT_HIGH_SEVERITY_RATE = 0.6;
export const SUBAGENT_HIGH_SEVERITY_TIMEOUTS = 3;
/** 建议卡上限（按失败数降序取）。 */
export const SUBAGENT_MAX_ADVICE = 5;

export type SubagentAdviceReason = 'timeout' | 'failure';
export type SubagentAdviceSeverity = 'high' | 'medium';

/** bash_executor 不算角色：它是"穿了 agent 外壳的 shell 命令"（与活动栏、工具卡片
 *  同一裁决），命令失败该修命令，不该建议用户关掉一个"角色"。 */
const NON_ROLE_SUBAGENTS: ReadonlySet<string> = new Set(['bash_executor']);

/** 角色 → 对应的技能开关（镜像 chat.ts 的 subagents 过滤逻辑，改那边要改这里）。 */
const ROLE_SKILL_GATES: Readonly<Record<string, string>> = {
  task_planner: 'planning',
  code_reviewer: 'code-review',
  project_auditor: 'code-review',
  researcher: 'web-research',
};

export interface SubagentAdvice {
  role: string;
  reason: SubagentAdviceReason;
  severity: SubagentAdviceSeverity;
  delegations: number;
  failures: number;
  /** 失败率百分比（一位小数）。 */
  failureRate: number;
  timeoutCount: number;
  /** 失败里出现最多的错误类（timeout / tool_error / network …）。 */
  dominantKind: string;
  /** 该角色被派发的平均耗时（只算记了正时长的调用）；没有样本时 null。 */
  avgDurationMs: number | null;
  /** 最近一次失败的时间（run 的 endedAt，退到 startedAt）。 */
  lastFailureAt: number;
  /** 用户能拉的闸：有技能开关给 'skill-gate'，其余只能靠任务描述收紧。 */
  action: 'skill-gate' | 'prompt';
  /** action === 'skill-gate' 时的技能 id（设置 → Skills）。 */
  skillId?: string;
}

interface RoleTally {
  delegations: number;
  failures: number;
  kinds: Map<string, number>;
  durationSum: number;
  durationCount: number;
  lastFailureAt: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function endTime(record: AgentRunObservation): number {
  return record.endedAt && record.endedAt >= record.startedAt ? record.endedAt : record.startedAt;
}

function isRoleCall(call: ToolObservation): boolean {
  return KNOWN_SUBAGENT_ROLES.has(call.toolName) && !NON_ROLE_SUBAGENTS.has(call.toolName);
}

function tallyRole(tally: RoleTally, call: ToolObservation, record: AgentRunObservation): void {
  tally.delegations++;
  if (call.durationMs > 0) {
    tally.durationSum += call.durationMs;
    tally.durationCount++;
  }
  if (call.success) return;
  tally.failures++;
  const kind = call.error?.kind ?? 'tool_error';
  tally.kinds.set(kind, (tally.kinds.get(kind) ?? 0) + 1);
  tally.lastFailureAt = Math.max(tally.lastFailureAt, endTime(record));
}

function dominantKind(kinds: Map<string, number>): string {
  let best = 'tool_error';
  let bestCount = -1;
  for (const [kind, count] of kinds) {
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 扫窗口内的观测记录，产出子代理角色建议（只建议，不改配置）。
 * 空列表 = 没有达到门槛的角色，不代表"一切正常"；调用方负责把这句话说清楚。
 */
export function scanSubagentAdvice(
  records: readonly PromptObservation[],
  options: { now?: number; windowDays?: number } = {},
): SubagentAdvice[] {
  const now = options.now ?? Date.now();
  const windowDays = options.windowDays ?? SUBAGENT_ADVICE_WINDOW_DAYS;
  const windowStart = now - windowDays * 86_400_000;

  const tallies = new Map<string, RoleTally>();
  for (const record of records) {
    if (record.type !== 'agent_run') continue;
    if (record.startedAt < windowStart || record.startedAt > now) continue;
    for (const call of record.toolCalls) {
      if (!isRoleCall(call)) continue;
      const tally = tallies.get(call.toolName) ?? {
        delegations: 0,
        failures: 0,
        kinds: new Map<string, number>(),
        durationSum: 0,
        durationCount: 0,
        lastFailureAt: 0,
      };
      tallyRole(tally, call, record);
      tallies.set(call.toolName, tally);
    }
  }

  const advice: SubagentAdvice[] = [];
  for (const [role, tally] of tallies) {
    if (tally.delegations < SUBAGENT_MIN_DELEGATIONS) continue;
    if (tally.failures < SUBAGENT_MIN_FAILURES) continue;
    const failureRate = tally.failures / tally.delegations;
    if (failureRate < SUBAGENT_FAILURE_RATE) continue;

    const timeoutCount = tally.kinds.get('timeout') ?? 0;
    // 超时占半数的失败 = 这个角色的任务体量不对（不是偶发报错），指向"拆分/换角色"；
    // 其余归到泛化的高失败率。
    const reason: SubagentAdviceReason = timeoutCount >= 2 && timeoutCount * 2 >= tally.failures ? 'timeout' : 'failure';
    const severity: SubagentAdviceSeverity = failureRate >= SUBAGENT_HIGH_SEVERITY_RATE || timeoutCount >= SUBAGENT_HIGH_SEVERITY_TIMEOUTS
      ? 'high'
      : 'medium';
    const skillId = ROLE_SKILL_GATES[role];
    advice.push({
      role,
      reason,
      severity,
      delegations: tally.delegations,
      failures: tally.failures,
      failureRate: round1(failureRate * 100),
      timeoutCount,
      dominantKind: dominantKind(tally.kinds),
      avgDurationMs: tally.durationCount > 0 ? Math.round(tally.durationSum / tally.durationCount) : null,
      lastFailureAt: tally.lastFailureAt,
      action: skillId ? 'skill-gate' : 'prompt',
      skillId,
    });
  }

  return advice
    .sort((a, b) => b.failures - a.failures
      || b.failureRate - a.failureRate
      || b.lastFailureAt - a.lastFailureAt
      || a.role.localeCompare(b.role))
    .slice(0, SUBAGENT_MAX_ADVICE);
}
