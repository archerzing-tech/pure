// src/shared/__tests__/baselineSnapshot.test.ts
// 发布口径基线快照：读取层的不变量 + 漂移门禁。
//
// 漂移门禁是这里的重点：快照是随发布提交进仓库的静态数据，套件版本或 fixture
// 集合变了却忘记重新生成时，仪表盘会把旧成绩当成当前成绩展示 —— 所以用测试
// 把"快照的套件版本与 fixture 指纹必须等于当前套件"钉死。

import { describe, expect, it } from 'bun:test';
import { BASELINE_SUITE_VERSION, isBaselineCostPriced, orderBaselineRows, type BaselineProviderRow } from '../baseline';
import { BASELINE_SNAPSHOT, baselineCacheHitRate, isBaselineStale } from '../baselineSnapshot';
import { CODING_TASK_SUITE_VERSION, codingTaskFixtureHash } from '../../evaluation/codingTaskBaseline';

function row(overrides: Partial<BaselineProviderRow> = {}): BaselineProviderRow {
  return {
    provider: 'glm',
    model: 'glm-5.3-flash',
    gitRevision: '1ed8235',
    passAt1: 15,
    taskCount: 15,
    meanDurationMs: 87_600,
    estimatedCostUsd: 0.427,
    promptTokens: 1_000_000,
    cacheHitTokens: 884_000,
    report: 'evals/glm.v5.json',
    ...overrides,
  };
}

describe('baseline snapshot helpers', () => {
  it('reports the cache hit rate as a percentage', () => {
    expect(baselineCacheHitRate(row())).toBeCloseTo(88.4, 1);
  });

  it('returns null when no prompt usage was recorded — not 0', () => {
    expect(baselineCacheHitRate(row({ promptTokens: 0, cacheHitTokens: 0 }))).toBeNull();
  });

  it('flags a snapshot from another suite as stale', () => {
    expect(isBaselineStale({ ...BASELINE_SNAPSHOT, suiteVersion: 'pure-coding-baseline-v3' })).toBe(true);
    expect(isBaselineStale({ ...BASELINE_SNAPSHOT, suiteVersion: BASELINE_SUITE_VERSION })).toBe(false);
  });
});

describe('priced vs unpriced baseline rows', () => {
  it('calls a run with no usage unpriced — 0 is a gap, not a free run', () => {
    expect(isBaselineCostPriced(row({ promptTokens: 0, cacheHitTokens: 0, estimatedCostUsd: 0 }))).toBe(false);
  });

  it('calls a provider with no rate card unpriced even when tokens were reported', () => {
    // NVIDIA NIM has no entry in usage.ts, so its estimate is 0 by construction.
    expect(isBaselineCostPriced(row({ provider: 'nvidia', promptTokens: 1_000_000, estimatedCostUsd: 0 }))).toBe(false);
  });

  it('keeps priced rows first by ascending cost and pushes unpriced rows to the tail', () => {
    const ordered = orderBaselineRows([
      row({ provider: 'nvidia', model: 'nemotron', promptTokens: 0, estimatedCostUsd: 0 }),
      row({ provider: 'glm', model: 'glm-4.5-flash', estimatedCostUsd: 0.5707 }),
      row({ provider: 'deepseek-openai', model: 'deepseek-flash', estimatedCostUsd: 0.0325 }),
    ]);
    expect(ordered.map((entry) => entry.model)).toEqual(['deepseek-flash', 'glm-4.5-flash', 'nemotron']);
  });

  it('orders the unpriced tail by provider then model, so it is stable', () => {
    const ordered = orderBaselineRows([
      row({ provider: 'nvidia', model: 'b', promptTokens: 0, estimatedCostUsd: 0 }),
      row({ provider: 'nvidia', model: 'a', promptTokens: 0, estimatedCostUsd: 0 }),
    ]);
    expect(ordered.map((entry) => entry.model)).toEqual(['a', 'b']);
  });

  it('does not mutate the array it was given', () => {
    const rows = [row({ estimatedCostUsd: 0.5 }), row({ estimatedCostUsd: 0.1 })];
    orderBaselineRows(rows);
    expect(rows[0]!.estimatedCostUsd).toBe(0.5);
  });
});

describe('committed baseline snapshot', () => {
  // 快照的顺序就是页面上的顺序：未定价的行必须待在末尾，否则它在页面上顶着
  // 0 成本占「最省」的位置。重新生成时排序错了，这条会先红。
  it('keeps every unpriced row after the priced ones', () => {
    const firstUnpriced = BASELINE_SNAPSHOT.rows.findIndex((entry) => !isBaselineCostPriced(entry));
    if (firstUnpriced < 0) return;
    expect(BASELINE_SNAPSHOT.rows.slice(firstUnpriced).every((entry) => !isBaselineCostPriced(entry))).toBe(true);
  });

  it('matches the current suite version and fixture hash', () => {
    expect(BASELINE_SNAPSHOT.suiteVersion).toBe(BASELINE_SUITE_VERSION);
    expect(BASELINE_SNAPSHOT.fixtureHash).toBe(codingTaskFixtureHash());
  });

  // 套件版本在 shared 与 evaluation 两侧各有一份导出，值必须相同：仪表盘用它判断
  // 快照是否过期，评测侧用它写报告。
  it('keeps one suite version across the ui and evaluation sides', () => {
    expect(CODING_TASK_SUITE_VERSION).toBe(BASELINE_SUITE_VERSION);
  });

  it('never stores a raw report payload or a key', () => {
    const json = JSON.stringify(BASELINE_SNAPSHOT);
    expect(json).not.toContain('sk-');
    expect(json).not.toContain('tasks');
  });
});
