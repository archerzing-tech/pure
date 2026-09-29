// src/adapter/memory/ratchet.ts
// P0 棘轮治理 —— Ratchet 三规则落到记忆/技能库：
//   1. 容量封顶（per-type / per-project / 机器级全局域）
//   2. 按实测贡献淘汰（retention = 0.5×health + 0.3×contribution + 0.2×recency）
//   3. 漂移报警盯贡献统计（某条目在场的 run 失败率显著高于基线 → 报警卡，绝不自动删）
//
// 只增不减的现状到此终结，但定位是防御性边界：默认容量对现有任何用户都应是
// "从不触发"的界。全部纯规则、确定性计算（与 evolution.ts 同一纪律）——
// planEviction 只决定不动 store，执行走 IMemoryStore.prune?()。

import type { MemoryEntry, MemoryType } from './IMemoryStore';
import { EVOLUTION_DEFAULTS, healthScore } from './evolution';
import { GLOBAL_MEMORY_SCOPE } from '../../shared/types';
import {
  SKILL_CONTRIBUTION_PREFIX,
  summarizeInjectionContributions,
  type EntryContributionSlice,
} from '../../shared/contributionStats';
import type { AgentRunObservation, PromptObservation } from '../../shared/promptObservability';

/** 棘轮容量配置。全部阈值 —— 默认值见 RATCHET_DEFAULTS。 */
export interface RatchetConfig {
  /** 每项目每类型封顶。 */
  perTypeCaps: Record<MemoryType, number>;
  /** 单项目桶总封顶。 */
  projectTotalCap: number;
  /** 机器级全局域（GLOBAL_MEMORY_SCOPE，tool_preference 为主且无条件注入）独立封顶。 */
  globalScopeTotalCap: number;
  /** 淘汰最小年龄保护：昨天的 lesson 还没机会证明自己，不删。 */
  minAgeMs: number;
  /** 超限超过 caps 的此比例（如 1.2 = 20%）时豁免年龄保护（失控兜底）。 */
  overCapWaiveMinAge: number;
  /** 技能数量报警线（只报警不删 —— 技能是用户可见文件，删文件即回滚）。 */
  skillCountAlarm: number;
  /** 单 SKILL.md 体积报警线。 */
  skillSizeAlarmBytes: number;
}

export const RATCHET_DEFAULTS: RatchetConfig = {
  perTypeCaps: {
    successful_pattern: 100,
    error_pattern: 100,
    procedure: 60,
    tool_preference: 40,
    user_preference: 30,
    project_convention: 30,
  },
  projectTotalCap: 300,
  globalScopeTotalCap: 120,
  minAgeMs: 7 * 24 * 3600 * 1000,
  overCapWaiveMinAge: 1.2,
  skillCountAlarm: 30,
  skillSizeAlarmBytes: 32 * 1024,
};

/** 部分配置 → 完整配置（缺省项用默认值；深度合并 perTypeCaps）。 */
export function resolveRatchetConfig(partial?: Partial<RatchetConfig>): RatchetConfig {
  if (!partial) return RATCHET_DEFAULTS;
  return {
    ...RATCHET_DEFAULTS,
    ...partial,
    perTypeCaps: { ...RATCHET_DEFAULTS.perTypeCaps, ...(partial.perTypeCaps ?? {}) },
  };
}

/** E3.1 用户纠正草稿：等用户确认的卡，删了等于替用户做决定——永不自动淘汰
 *  （注入侧 confidence:'low' 过滤已使其无运行时影响）。 */
export function isCorrectionDraft(entry: MemoryEntry): boolean {
  return typeof entry.dedupeKey === 'string' && entry.dedupeKey.startsWith('correction:');
}

/**
 * 保留分（0..1，越大越该留）。contribution 缺席（归因上线前的老条目 / 无数据）
 * 给中性 0.5 —— 冷启动不遭殃；在场数据按完成率线性映射 0.2..1。
 * recency 与 evolution 的遗忘速度同一半衰期（EVOLUTION_DEFAULTS）。
 */
export function retentionScore(
  entry: MemoryEntry,
  contribution: EntryContributionSlice | undefined,
  now: number,
): number {
  const health = healthScore(entry, now);
  const contributionScore = contribution && contribution.runs > 0
    ? 0.2 + 0.8 * (contribution.completions / contribution.runs)
    : 0.5;
  const lastUsed = entry.lastUsedAt ?? entry.timestamp;
  const halfLife = Math.max(1, EVOLUTION_DEFAULTS.recencyHalfLifeMs);
  const recency = Math.exp(-(Math.max(0, now - lastUsed) / halfLife) * Math.LN2);
  return 0.5 * health + 0.3 * contributionScore + 0.2 * recency;
}

export interface EvictionPlan {
  removeIds: string[];
  /** 候选耗尽后仍超限（剩下的全是豁免/受保护条目）—— 调用方可记日志或报警。 */
  keptOverCap: boolean;
}

interface EvictionCandidate {
  entry: MemoryEntry;
  /** 排序元组：dormant 优先出，confidence:'low' 次之，retention 升序兜底。 */
  dormant: number;
  lowConfidence: number;
  retention: number;
}

function overCap(group: MemoryEntry[], totalCap: number, caps: Record<MemoryType, number>, waive: number): boolean {
  if (group.length > totalCap * waive) return true;
  const byType = new Map<MemoryType, number>();
  for (const e of group) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  for (const [type, count] of byType) {
    if (count > (caps[type] ?? Infinity) * waive) return true;
  }
  return false;
}

function satisfiesCaps(group: MemoryEntry[], totalCap: number, caps: Record<MemoryType, number>): boolean {
  if (group.length > totalCap) return false;
  const byType = new Map<MemoryType, number>();
  for (const e of group) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  for (const [type, count] of byType) {
    if (count > (caps[type] ?? Infinity)) return false;
  }
  return true;
}

/**
 * 纯函数：给定全库条目 + 贡献切片，决定淘汰名单。分组（项目/全局域）→
 * 贪心按"最该走的最先走"移除，直到总封顶与各类型封顶同时满足。
 * 不动 store —— 执行走 IMemoryStore.prune?()（未实现则本轮跳过）。
 */
export function planEviction(
  entries: readonly MemoryEntry[],
  contributions: ReadonlyMap<string, EntryContributionSlice>,
  cfg: RatchetConfig,
  now: number,
): EvictionPlan {
  const removeIds = new Set<string>();
  // 项目路径分组（GLOBAL 域单独配额）；组内已移除的条目实时出组。
  const groups = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    if (removeIds.has(e.id)) continue;
    if (isCorrectionDraft(e)) continue;
    const key = e.projectPath || '';
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  let keptOverCap = false;
  for (const [project, group] of groups) {
    const isGlobal = project === GLOBAL_MEMORY_SCOPE;
    const totalCap = isGlobal ? cfg.globalScopeTotalCap : cfg.projectTotalCap;
    const caps = cfg.perTypeCaps;
    if (satisfiesCaps(group, totalCap, caps)) continue;
    // 年龄保护：超限 >20%（失控）才豁免 —— 常态轻微超限让新条目活过保护期。
    const waiveAge = overCap(group, totalCap, caps, cfg.overCapWaiveMinAge);
    const candidates: EvictionCandidate[] = [];
    for (const e of group) {
      if (!waiveAge && now - e.timestamp < cfg.minAgeMs) continue;
      candidates.push({
        entry: e,
        dormant: e.lifecycle === 'dormant' ? 0 : 1,
        lowConfidence: e.confidence === 'low' ? 0 : 1,
        retention: retentionScore(e, contributions.get(e.id), now),
      });
    }
    candidates.sort((a, b) =>
      a.dormant - b.dormant ||
      a.lowConfidence - b.lowConfidence ||
      a.retention - b.retention ||
      (a.entry.timestamp - b.entry.timestamp),
    );
    // working list 的拷贝：逐个移除候选，检查约束满足即停。
    const working = new Map(group.map(e => [e.id, e]));
    for (const candidate of candidates) {
      if (satisfiesCaps([...working.values()], totalCap, caps)) break;
      working.delete(candidate.entry.id);
      removeIds.add(candidate.entry.id);
    }
    if (!satisfiesCaps([...working.values()], totalCap, caps)) keptOverCap = true;
  }
  return { removeIds: [...removeIds], keptOverCap };
}

// ── 规则三：漂移报警（盯贡献统计，不盯端到端分） ──

export interface DriftAlert {
  /** 贡献 key：记忆条目 id 或 `skill:<name>`。 */
  key: string;
  kind: 'memory' | 'skill';
  runs: number;
  /** 该条目在场 run 的失败率（0..1）。 */
  failureRate: number;
  /** 同窗口全部归因 run 的基线失败率（0..1）。 */
  baselineRate: number;
  windowDays: number;
}

export interface DriftOptions {
  windowDays?: number;
  /** 最少在场 run 数 —— 低于此不判定（样本太薄的报警全是噪音）。 */
  minRuns?: number;
  /** 与基线的最小绝对差。 */
  minDelta?: number;
  /** 与基线的最小倍数。 */
  minRatio?: number;
  now?: number;
}

/**
 * 找"在场即翻车"的条目/技能：窗口内 runs ≥ minRuns 且失败率较基线
 * ≥ +minDelta 且 ≥ minRatio 倍 → 报警。基线取同窗口全部归因 run 的总失败率。
 * 只报警 —— 自动删交给 retention 公式，人看完卡再决定。
 */
export function detectContributionDrift(records: readonly PromptObservation[], opts?: DriftOptions): DriftAlert[] {
  const windowDays = opts?.windowDays ?? 30;
  const minRuns = opts?.minRuns ?? 8;
  const minDelta = opts?.minDelta ?? 0.25;
  const minRatio = opts?.minRatio ?? 1.5;
  const now = opts?.now ?? Date.now();
  const windowStart = now - windowDays * 24 * 3600 * 1000;

  const windowed = records.filter((r): r is AgentRunObservation &
    { memoryInjection: NonNullable<AgentRunObservation['memoryInjection']> } =>
    r.type === 'agent_run' &&
    r.memoryInjection !== undefined &&
    r.outcome !== undefined &&
    r.startedAt >= windowStart &&
    r.startedAt <= now,
  );
  if (windowed.length === 0) return [];
  let baselineRuns = 0;
  let baselineFailures = 0;
  for (const r of windowed) {
    baselineRuns++;
    if (!(r.outcome!.isComplete && !r.outcome!.interrupted)) baselineFailures++;
  }
  const baselineRate = baselineFailures / baselineRuns;

  const slices = summarizeInjectionContributions(windowed);
  const alerts: DriftAlert[] = [];
  for (const [key, slice] of slices) {
    if (slice.runs < minRuns) continue;
    if (slice.failureRate - baselineRate < minDelta) continue;
    if (slice.failureRate < baselineRate * minRatio) continue;
    alerts.push({
      key,
      kind: key.startsWith(SKILL_CONTRIBUTION_PREFIX) ? 'skill' : 'memory',
      runs: slice.runs,
      failureRate: slice.failureRate,
      baselineRate: Math.round(baselineRate * 100) / 100,
      windowDays,
    });
  }
  // 最恶劣的排前面。
  alerts.sort((a, b) => (b.failureRate - b.baselineRate) - (a.failureRate - a.baselineRate));
  return alerts;
}

// ── 技能侧：只统计 + 报警，不删 ──

export interface SkillOverloadReport {
  count: number;
  countAlarm: number;
  oversized: Array<{ name: string; bytes: number; cap: number }>;
}

/** 技能数量/体积超界报告（读 SKILL.md 侧；只报警，不自动删）。 */
export function detectSkillOverload(
  skills: ReadonlyArray<{ name: string; body: string }>,
  cfg?: Partial<RatchetConfig>,
): SkillOverloadReport {
  const c = resolveRatchetConfig(cfg);
  const oversized = skills
    .map(s => ({ name: s.name, bytes: new TextEncoder().encode(s.body).length, cap: c.skillSizeAlarmBytes }))
    .filter(s => s.bytes > s.cap);
  return { count: skills.length, countAlarm: c.skillCountAlarm, oversized };
}
