// src/adapter/memory/__tests__/ratchet.test.ts
// P0 棘轮 — 三规则的验收：容量封顶（总/每类/全局域）、按贡献淘汰
// （dormant → low → retention 升序）、护栏（最小年龄/超限豁免/correction
// 豁免/冷启动中性分）、漂移报警阈值（runs 下限 + 绝对差 + 倍数）。

import { describe, it, expect } from 'bun:test';
import type { MemoryEntry } from '../IMemoryStore';
import type { AgentRunObservation, MemoryInjectionObservation, PromptObservation } from '../../../shared/promptObservability';
import {
  RATCHET_DEFAULTS,
  detectContributionDrift,
  detectSkillOverload,
  isCorrectionDraft,
  planEviction,
  retentionScore,
} from '../ratchet';
import { SKILL_CONTRIBUTION_PREFIX, type EntryContributionSlice } from '../../../shared/contributionStats';

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-09-29T12:00:00Z');

let seq = 0;
function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  seq++;
  return {
    id: `m${seq}`,
    type: 'successful_pattern',
    content: `entry ${seq}`,
    timestamp: NOW - 30 * DAY,
    sessionId: `s${seq}`,
    projectPath: '/proj',
    ...overrides,
  };
}

function slice(overrides: Partial<EntryContributionSlice> = {}): EntryContributionSlice {
  return { entryId: 'x', runs: 0, completions: 0, failures: 0, failureRate: 0, ...overrides };
}

function run(at: number, injection: MemoryInjectionObservation | undefined, ok: boolean): AgentRunObservation {
  seq++;
  return {
    type: 'agent_run',
    traceId: `run_${seq}`,
    startedAt: at,
    eventCounts: {},
    toolCalls: [],
    reasoningChars: 0,
    outputChars: 0,
    memoryInjection: injection,
    outcome: { isComplete: ok, interrupted: false },
  };
}

// ── retentionScore ──

describe('retentionScore', () => {
  it('gives absent contribution data the neutral 0.5 (cold start never evicted for it)', () => {
    const withData = retentionScore(entry({ timestamp: NOW - DAY }), undefined, NOW);
    const fresh = retentionScore(entry({ timestamp: NOW }), undefined, NOW);
    expect(withData).toBeGreaterThan(0);
    // 无贡献数据时只有 recency 拉开差距 —— 公式仍然单调。
    expect(fresh).toBeGreaterThan(withData);
  });

  it('rewards contributing entries above neutral and punishes failing ones below', () => {
    const base = entry({ timestamp: NOW - DAY, lastUsedAt: NOW - DAY });
    const good = retentionScore(base, slice({ runs: 10, completions: 10, failures: 0 }), NOW);
    const bad = retentionScore(base, slice({ runs: 10, completions: 0, failures: 10, failureRate: 1 }), NOW);
    const neutral = retentionScore(base, undefined, NOW);
    // contribution: 全成 → 1.0，全败 → 0.2，无数据 → 0.5（中性）。
    expect(good).toBeGreaterThan(neutral);
    expect(bad).toBeLessThan(neutral);
  });
});

// ── planEviction ──

describe('planEviction', () => {
  it('removes nothing when everything is under every cap', () => {
    const entries = Array.from({ length: 5 }, () => entry());
    const plan = planEviction(entries, new Map(), RATCHET_DEFAULTS, NOW);
    expect(plan.removeIds).toHaveLength(0);
    expect(plan.keptOverCap).toBe(false);
  });

  it('evicts dormant first, then low-confidence, then lowest retention', () => {
    const dormant = entry({ lifecycle: 'dormant', content: 'd' });
    const low = entry({ confidence: 'low', content: 'l' });
    const weak = entry({ timestamp: NOW - 60 * DAY, content: 'w' }); // 老 → recency 低
    const strong = entry({ timestamp: NOW - DAY, lastUsedAt: NOW - DAY, content: 's' });
    const cap2 = {
      ...RATCHET_DEFAULTS,
      projectTotalCap: 2,
      perTypeCaps: { ...RATCHET_DEFAULTS.perTypeCaps, successful_pattern: 2 },
    };
    const plan = planEviction([strong, weak, low, dormant], new Map(), cap2, NOW);
    // 4 条压到 2 条：dormant 先出、low 次之，strong/weak 都留下。
    expect(plan.removeIds).toHaveLength(2);
    expect(plan.removeIds).toContain(dormant.id);
    expect(plan.removeIds).toContain(low.id);
    expect(plan.removeIds).not.toContain(strong.id);
    expect(plan.removeIds).not.toContain(weak.id);
  });

  it('prefers failing-contribution entries over neutral ones at equal health', () => {
    const loser = entry({ timestamp: NOW - DAY, lastUsedAt: NOW - DAY });
    const winner = entry({ timestamp: NOW - DAY, lastUsedAt: NOW - DAY });
    const cap1 = {
      ...RATCHET_DEFAULTS,
      projectTotalCap: 1,
      perTypeCaps: { ...RATCHET_DEFAULTS.perTypeCaps, successful_pattern: 1 },
    };
    const contributions = new Map([
      [loser.id, slice({ entryId: loser.id, runs: 10, completions: 0, failures: 10, failureRate: 1 })],
      [winner.id, slice({ entryId: winner.id, runs: 10, completions: 10, failures: 0 })],
    ]);
    const plan = planEviction([winner, loser], contributions, cap1, NOW);
    expect(plan.removeIds).toEqual([loser.id]);
  });

  it('protects young entries under gentle overage even when they rank worst', () => {
    // 10 条压 cap 9：超限 11% < 20% 豁免线 → 年龄保护生效。
    // 最年轻的 dormant 条目排序最差，但因为是"昨天的 lesson"被豁出候选，
    // 淘汰落在老条目头上。
    const youngDormant = entry({ timestamp: NOW - DAY, lifecycle: 'dormant' });
    const olds = Array.from({ length: 9 }, () => entry({ timestamp: NOW - 30 * DAY }));
    const capGentle = {
      ...RATCHET_DEFAULTS,
      projectTotalCap: 9,
      perTypeCaps: { ...RATCHET_DEFAULTS.perTypeCaps, successful_pattern: 9 },
    };
    const plan = planEviction([youngDormant, ...olds], new Map(), capGentle, NOW);
    expect(plan.removeIds).toHaveLength(1);
    expect(plan.removeIds).not.toContain(youngDormant.id);
    expect(plan.keptOverCap).toBe(false);
  });

  it('waives the age guard when the group is over cap by >20%', () => {
    // 2 条压 cap 1：超限 100% > 20% → 年龄保护豁免，昨天创建的 dormant
    // 条目照常可淘汰（失控兜底）。
    const youngDormant = entry({ timestamp: NOW - DAY, lifecycle: 'dormant' });
    const strong = entry({ timestamp: NOW - 30 * DAY, lastUsedAt: NOW - DAY });
    const cap1 = {
      ...RATCHET_DEFAULTS,
      projectTotalCap: 1,
      perTypeCaps: { ...RATCHET_DEFAULTS.perTypeCaps, successful_pattern: 1 },
    };
    const plan = planEviction([strong, youngDormant], new Map(), cap1, NOW);
    expect(plan.removeIds).toEqual([youngDormant.id]);
  });

  it('never evicts correction drafts even when they rank worst', () => {
    // correction: 草稿不进分组（不占配额、永不入候选）——即使它是最恶劣
    // 条目（dormant + low + 最老），淘汰也只落在普通条目头上。
    const draft = entry({
      dedupeKey: 'correction:project_convention:abc',
      type: 'project_convention',
      timestamp: NOW - 60 * DAY,
      lifecycle: 'dormant',
      confidence: 'low',
    });
    const oldFiller = entry({ type: 'project_convention', timestamp: NOW - 30 * DAY });
    const freshFiller = entry({ type: 'project_convention', timestamp: NOW - DAY });
    const cap1 = {
      ...RATCHET_DEFAULTS,
      projectTotalCap: 1,
      perTypeCaps: { ...RATCHET_DEFAULTS.perTypeCaps, project_convention: 1 },
    };
    const plan = planEviction([draft, oldFiller, freshFiller], new Map(), cap1, NOW);
    expect(isCorrectionDraft(draft)).toBe(true);
    expect(plan.removeIds).toEqual([oldFiller.id]);
    expect(plan.removeIds).not.toContain(draft.id);
  });

  it('reports keptOverCap when only age-protected entries remain over cap', () => {
    // 10 条全新条目压 cap 9：轻微超限（豁免线未到）+ 全部受年龄保护
    // → 候选为空、无法入界 —— 如实上报 keptOverCap 而不是硬删。
    const young = Array.from({ length: 10 }, () => entry({ timestamp: NOW - DAY }));
    const capGentle = {
      ...RATCHET_DEFAULTS,
      projectTotalCap: 9,
      perTypeCaps: { ...RATCHET_DEFAULTS.perTypeCaps, successful_pattern: 9 },
    };
    const plan = planEviction(young, new Map(), capGentle, NOW);
    expect(plan.removeIds).toHaveLength(0);
    expect(plan.keptOverCap).toBe(true);
  });

  it('applies a separate (tighter) cap to the machine-global scope', () => {
    const globals = Array.from({ length: 5 }, () => entry({ projectPath: '__machine__', type: 'tool_preference' }));
    const capG3 = {
      ...RATCHET_DEFAULTS,
      globalScopeTotalCap: 3,
      perTypeCaps: { ...RATCHET_DEFAULTS.perTypeCaps, tool_preference: 5 },
    };
    const plan = planEviction(globals, new Map(), capG3, NOW);
    expect(plan.removeIds).toHaveLength(2);
    // 项目桶不受全局域收紧影响（projectTotalCap 300 仍当家）。
    const proj = Array.from({ length: 5 }, () => entry({ type: 'tool_preference' }));
    const planP = planEviction(proj, new Map(), capG3, NOW);
    expect(planP.removeIds).toHaveLength(0);
  });
});

// ── detectContributionDrift ──

describe('detectContributionDrift', () => {
  const inj = (id: string): MemoryInjectionObservation => ({ entryIds: [id], injected: true });
  const inside = NOW - 5 * DAY;
  const outside = NOW - 60 * DAY;

  it('flags entries whose failure rate is far above baseline', () => {
    const records: PromptObservation[] = [
      // 基线池：20 run 只翻车 2 次；bad1：9 run 全翻车。
      ...Array.from({ length: 20 }, (_, i) => run(inside, inj(`base${i % 9}`), i >= 2)),
      ...Array.from({ length: 9 }, () => run(inside, inj('bad1'), false)),
    ];
    const alerts = detectContributionDrift(records, { now: NOW });
    const bad = alerts.find(a => a.key === 'bad1');
    expect(bad).toBeDefined();
    expect(bad!.kind).toBe('memory');
    expect(bad!.runs).toBe(9);
    expect(bad!.failureRate).toBe(1);
  });

  it('does not flag entries at or near baseline', () => {
    const records: PromptObservation[] = [
      ...Array.from({ length: 20 }, (_, i) => run(inside, inj(`base${i % 9}`), i >= 2)),
      ...Array.from({ length: 10 }, (_, i) => run(inside, inj('ok1'), i >= 2)),
    ];
    expect(detectContributionDrift(records, { now: NOW }).map(a => a.key)).not.toContain('ok1');
  });

  it('respects minRuns: thin slices stay silent even at 100% failure', () => {
    const records: PromptObservation[] = [
      ...Array.from({ length: 12 }, () => run(inside, inj('bg'), true)),
      ...Array.from({ length: 3 }, () => run(inside, inj('thin'), false)),
    ];
    expect(detectContributionDrift(records, { now: NOW }).map(a => a.key)).not.toContain('thin');
  });

  it('ignores records outside the time window entirely', () => {
    const records: PromptObservation[] = [
      ...Array.from({ length: 12 }, () => run(outside, inj('bg'), true)),
      ...Array.from({ length: 12 }, () => run(outside, inj('old'), false)),
    ];
    expect(detectContributionDrift(records, { now: NOW })).toHaveLength(0);
  });

  it('flags drifting skills with the skill kind', () => {
    const records: PromptObservation[] = [
      // 基线池成功为主；auto-x 技能在场即翻车 → skill:<name> key。
      ...Array.from({ length: 12 }, () => run(inside, inj('bg'), true)),
      ...Array.from({ length: 9 }, () => run(inside, { entryIds: [], skills: ['auto-x'], injected: true }, false)),
    ];
    const alerts = detectContributionDrift(records, { now: NOW });
    const key = `${SKILL_CONTRIBUTION_PREFIX}auto-x`;
    const skill = alerts.find(a => a.key === key);
    expect(skill).toBeDefined();
    expect(skill!.kind).toBe('skill');
  });

  it('tolerates old records without the attribution field (no data, never zero)', () => {
    const legacy: PromptObservation[] = [{
      type: 'agent_run',
      traceId: 'legacy',
      startedAt: inside,
      eventCounts: {},
      toolCalls: [],
      reasoningChars: 0,
      outputChars: 0,
      outcome: { isComplete: false, interrupted: false },
    }];
    expect(detectContributionDrift(legacy, { now: NOW })).toHaveLength(0);
  });
});

// ── detectSkillOverload ──

describe('detectSkillOverload', () => {
  it('reports count and oversized skills without deleting anything', () => {
    const big = 'x'.repeat(40 * 1024);
    const report = detectSkillOverload(
      [{ name: 'a', body: 'small' }, { name: 'b', body: big }],
      { skillCountAlarm: 1, skillSizeAlarmBytes: 32 * 1024 },
    );
    expect(report.count).toBe(2);
    expect(report.countAlarm).toBe(1);
    expect(report.oversized).toEqual([{ name: 'b', bytes: 40 * 1024, cap: 32 * 1024 }]);
  });
});
