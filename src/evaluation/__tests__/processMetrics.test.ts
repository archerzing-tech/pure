// src/evaluation/__tests__/processMetrics.test.ts
// W2 —— 过程指标的两个口径：
//   ① 聚合只统计「有读数」的题（缺失不稀释平均值），通过题的单题成本单独算；
//   ② compare 的过程块只在两份报告**都带** process 时出现——旧报告没有这个块，
//      硬比会把「没记录」当 0，读出一个假的效率提升。

import { describe, expect, it } from 'bun:test';
import { codingTaskProcessMetrics, type CodingTaskResult, type CodingTaskStatus, type CodingTaskSuiteReport } from '../codingTaskBaseline';
import { compareSuiteReports } from '../reportCompare';

function task(
  id: string,
  status: CodingTaskStatus,
  agent?: CodingTaskResult['agent'],
): CodingTaskResult {
  const passing = status === 'passed';
  return {
    taskId: id,
    category: 'bugfix',
    difficulty: 'easy',
    status,
    success: passing,
    passAt1: passing,
    verificationPassed: passing,
    score: passing ? 1 : 0,
    durationMs: 100,
    verification: [],
    ...(agent ? { agent } : {}),
  };
}

function report(tasks: CodingTaskResult[], withProcess: boolean): CodingTaskSuiteReport {
  const passing = tasks.filter((entry) => entry.passAt1).length;
  return {
    suiteVersion: 'v5',
    generatedAt: '2026-11-03T00:00:00.000Z',
    fixtureHash: 'hash-x',
    metadata: { provider: 'deepseek-openai', model: 'deepseek-v4-flash', runtime: 'bun', platform: 'darwin' },
    taskCount: tasks.length,
    passAt1: passing,
    successRate: tasks.length > 0 ? passing / tasks.length : 0,
    meanScore: tasks.length > 0 ? passing / tasks.length : 0,
    meanDurationMs: 100,
    estimatedCostUsd: 0.1,
    tasks,
    ...(withProcess ? { process: codingTaskProcessMetrics(tasks) } : {}),
  };
}

describe('codingTaskProcessMetrics', () => {
  it('averages only the tasks that actually carry a reading', () => {
    const results = [
      task('a', 'passed', { turns: 3, toolCalls: 5, usage: { promptTokens: 1000, cacheHitTokens: 800, cacheMissTokens: 200 } }),
      task('b', 'passed', { turns: 5, toolCalls: 7, usage: { promptTokens: 2000 } }),
      // 跑断的题：有回合/调用读数，没有 usage —— 它必须进平均值（否则「跑得越久」
      // 会被漏记），但不会拉低单题 token 成本。
      task('c', 'agent_error', { turns: 30, toolCalls: 12 }),
    ];
    const metrics = codingTaskProcessMetrics(results);
    expect(metrics.meanTurns).toBeCloseTo((3 + 5 + 30) / 3, 5);
    expect(metrics.meanToolCalls).toBeCloseTo((5 + 7 + 12) / 3, 5);
    expect(metrics.toolCallsPerPass).toBeCloseTo(6, 5);
    expect(metrics.promptTokensPerPass).toBeCloseTo(1500, 5);
    expect(metrics.cacheHitRate).toBeCloseTo(0.8, 5);
    expect(metrics.unfinished).toBe(1);
    expect(metrics.sampled).toBe(3);
  });

  it('does not dilute the mean with tasks that have no agent reading', () => {
    const results = [task('a', 'passed', { turns: 4, toolCalls: 2 }), task('b', 'passed')];
    const metrics = codingTaskProcessMetrics(results);
    expect(metrics.meanTurns).toBe(4);
    expect(metrics.meanToolCalls).toBe(2);
    expect(metrics.sampled).toBe(1);
    // 没有通过题就不编造「通过一题花多少」。
    expect(codingTaskProcessMetrics([task('x', 'failed')]).promptTokensPerPass).toBe(0);
    expect(codingTaskProcessMetrics([]).cacheHitRate).toBe(0);
  });
});

describe('reportCompare · process 块', () => {
  it('compares the process block when both reports carry it', () => {
    const before = report([task('a', 'passed', { turns: 8, toolCalls: 10 })], true);
    const after = report([task('a', 'passed', { turns: 6, toolCalls: 7 })], true);
    const result = compareSuiteReports(before, after);
    expect(result.process).toBeDefined();
    expect(result.process?.meanTurns).toEqual({ baseline: 8, candidate: 6, delta: -2 });
    expect(result.process?.meanToolCalls.delta).toBe(-3);
  });

  it('omits the block when either side predates it (no fake 0 → N improvement)', () => {
    const legacy = report([task('a', 'passed', { turns: 8, toolCalls: 10 })], false);
    const current = report([task('a', 'passed', { turns: 6, toolCalls: 7 })], true);
    expect(compareSuiteReports(legacy, current).process).toBeUndefined();
    expect(compareSuiteReports(current, legacy).process).toBeUndefined();
  });
});
