// src/shared/__tests__/baselineSnapshot.test.ts
// 发布口径基线快照：读取层的不变量 + 漂移门禁。
//
// 漂移门禁是这里的重点：快照是随发布提交进仓库的静态数据，套件版本或 fixture
// 集合变了却忘记重新生成时，仪表盘会把旧成绩当成当前成绩展示 —— 所以用测试
// 把"快照的套件版本与 fixture 指纹必须等于当前套件"钉死。

import { describe, expect, it } from 'bun:test';
import { BASELINE_SUITE_VERSION, type BaselineProviderRow } from '../baseline';
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

describe('committed baseline snapshot', () => {
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
