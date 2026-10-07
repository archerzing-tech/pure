// src/shared/bottleneckSummary.ts
// 团队瓶颈视图聚合层——读 delegations（T1 观测记录），输出渲染可消费的切片。

import type { PromptObservation, DelegationObservation } from './promptObservability';
import { roleSurface } from './teamObservability';

export type BottleneckClassification = 'critical' | 'warning' | 'ok';

export interface BottleneckRow {
  role: string;
  delegations: number;
  successes: number;
  failures: number;
  /** 百分比，整数。分母是该角色窗口内的派发数——没有派发就不产出这一行，
   *  所以不存在「除以 0 冒充 0%」的读数（与 T4 成本卡同一把尺子：无数据报无数据）。 */
  failureRate: number;
  avgDurationMs: number | null;
  errors: Record<string, number>;
  /** 最近一次失败的委派起点（epoch ms）；一次都没失败过则字段缺失。
   *  「什么时候开始坏的」比「坏了多少次」更能定位问题，所以单独留一格。 */
  lastFailureAt?: number;
  /** 分档：由失败率与派发量在收尾处判定（见 `classify`）。**必填**——渲染层直接
   *  按它分色，缺字段会被读成「没分类」而不是「已分类为 ok」，那正是这套口径
   *  一贯拒绝的「拿空值冒充结论」。 */
  classification: BottleneckClassification;
}

export interface BottleneckSummary {
  roles: BottleneckRow[];
  totalDelegations: number;
  critical: BottleneckRow[];
  warning: BottleneckRow[];
  windowStart: number;
}

export interface BottleneckOptions {
  now?: number;
  windowDays?: number;
  roles?: readonly string[];
}

// 阈值。
//
// 已知设计问题（未改，测试 bottleneckSummary.test.ts:91 正指着这里）：`warning`
// 档在当前阈值下几乎不可达。失败率 ≥ 50% 被 critical 先吃掉；剩下要进 warning 得
// 同时满足 successRate ∈ [70, 90]，也就是失败率 ∈ [10, 30]。窄，但真实存在
// （夹具 failureRate=20 那条就命中了）。真正读不出来的是失败率 ∈ (30, 50) 这一段：
// 既不够 critical 又不够 healthy，被归成 ok——而「三成失败却显示 ok」对一个专门
// 找瓶颈的视图是误导。这属于产品判断（40% 失败该报什么），不是实现 bug，
// 所以这里只把边界写明：WARNING_FAILURE_RATE_LOW = 10、HIGH = 30（即上面的
// successRate 区间），要不要把 HIGH 抬到 50 让中段也进 warning，等口径定下来再动。
const CRITICAL_FAILURE_RATE = 50;
const CRITICAL_MIN_DELEGATIONS = 3;
const WARNING_SUCCESS_RATE_LOW = 70;
const WARNING_SUCCESS_RATE_HIGH = 90;

function classify(row: Pick<BottleneckRow, 'failureRate' | 'delegations'>): BottleneckClassification {
  if (row.delegations >= CRITICAL_MIN_DELEGATIONS && row.failureRate >= CRITICAL_FAILURE_RATE) return 'critical';
  const successRate = 100 - row.failureRate;
  if (successRate >= WARNING_SUCCESS_RATE_LOW && successRate <= WARNING_SUCCESS_RATE_HIGH) return 'warning';
  return 'ok';
}

export function computeBottleneckSummary(
  records: readonly PromptObservation[],
  options: BottleneckOptions = {},
): BottleneckSummary {
  const now = options.now ?? Date.now();
  const days = options.windowDays ?? 30;
  const windowStart = now - (days * 24 * 3600_000);
  const roles = roleSurface(options.roles);
  const byRole = new Map<string, BottleneckRow>();

  for (const record of records) {
    if (record.type !== 'agent_run') continue;
    const dels = record.delegations;
    if (!dels) continue;
    for (const d of dels) {
      // 窗口按**每条委派自己的起点**判，不按 run 的。一条 run 可以横跨窗口边界
      // （长会话、恢复后继续），拿 run 的 startedAt 一刀切会把窗口外的老委派算进
      // 窗口内——那样「最近 7 天失败率」会随会话长度漂移，读数不再是读数。
      // 两条兜底理由同样重要：委派可能没有 startedAt（老记录），此时退回 run 的
      // 起点，而不是把这条委派凭空判成「窗口外」——那会让失败率凭空变好。
      const at = d.startedAt ?? record.startedAt ?? 0;
      if (at < windowStart) continue;
      if (!roles.has(d.role)) continue;
      let row = byRole.get(d.role);
      if (!row) {
        // classification 先落一个默认值，收尾处（failureRate 算完之后）统一改判。
        // 必填而非可选：渲染层按它分色，缺字段会被读成「没分类」。
        row = { role: d.role, delegations: 0, successes: 0, failures: 0, failureRate: 0, avgDurationMs: null, errors: {}, classification: 'ok' };
        byRole.set(d.role, row);
      }
      row.delegations += 1;
      if (d.success) {
        row.successes += 1;
      } else {
        row.failures += 1;
        if (d.startedAt && (!row.lastFailureAt || d.startedAt > row.lastFailureAt)) {
          row.lastFailureAt = d.startedAt;
        }
        if (d.errorKind) row.errors[d.errorKind] = (row.errors[d.errorKind] ?? 0) + 1;
      }
      if (d.durationMs && d.durationMs > 0) {
        row.avgDurationMs = row.avgDurationMs === null ? d.durationMs : Math.round(((row.avgDurationMs + d.durationMs) / 2) * 10) / 10;
      }
    }
  }

  for (const row of byRole.values()) {
    if (row.delegations > 0) {
      row.failureRate = Math.round((row.failures / row.delegations) * 100);
    }
    row.classification = classify(row);
  }

  const rolesArr = [...byRole.values()].sort((a, b) => b.failureRate - a.failureRate || b.delegations - a.delegations);
  return {
    roles: rolesArr,
    totalDelegations: rolesArr.reduce((s, r) => s + r.delegations, 0),
    critical: rolesArr.filter((r) => r.classification === 'critical'),
    warning: rolesArr.filter((r) => r.classification === 'warning'),
    windowStart,
  };
}

export function topBottleneckRoles(summary: BottleneckSummary, limit = 10): BottleneckRow[] {
  return summary.roles.slice(0, limit);
}
