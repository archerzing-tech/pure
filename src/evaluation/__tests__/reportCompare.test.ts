// src/evaluation/__tests__/reportCompare.test.ts
// B1 —— 报告对比纯核的行为判例。
//
// 这里锁的是三条会直接影响结论正确性的口径：
//   ① 逐题去向靠 passAt1（报告里唯一「这次算过」的布尔），修复/退步不能串位；
//   ② 套件版本 / 夹具指纹 / 留出标记任一不同 → 不可比，且原因可读；
//   ③ control 运行必须被认出来——「控制组 0/15 vs agent 15/15」要是被读成「改善」，
//      这个工具就比没有更糟。

import { describe, expect, it } from 'bun:test';
import { compareSuiteReports, isControlRun } from '../reportCompare';
import type { CodingTaskResult, CodingTaskStatus, CodingTaskSuiteReport } from '../codingTaskBaseline';

function task(id: string, status: CodingTaskStatus, overrides: Partial<CodingTaskResult> = {}): CodingTaskResult {
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
    ...overrides,
  };
}

interface ReportOptions {
  suite?: string;
  hash?: string;
  provider?: string;
  model?: string;
  revision?: string;
  heldOut?: boolean;
  cost?: number;
}

function report(tasks: CodingTaskResult[], options: ReportOptions = {}): CodingTaskSuiteReport {
  const passing = tasks.filter((entry) => entry.passAt1).length;
  const rate = tasks.length > 0 ? passing / tasks.length : 0;
  return {
    suiteVersion: options.suite ?? 'v5',
    generatedAt: '2026-10-16T00:00:00.000Z',
    fixtureHash: options.hash ?? 'hash-x',
    metadata: {
      provider: options.provider ?? 'glm',
      model: options.model ?? 'glm-5.3-flash',
      gitRevision: options.revision ?? 'abc1234',
      runtime: 'bun',
      platform: 'darwin',
      ...(options.heldOut === true ? { heldOut: true } : {}),
    },
    taskCount: tasks.length,
    passAt1: passing,
    successRate: rate,
    meanScore: rate,
    meanDurationMs: 100,
    estimatedCostUsd: options.cost ?? 0.1,
    tasks,
  };
}

describe('reportCompare：逐题去向与结论', () => {
  it('每题变过，且只有修复 → 改善', () => {
    const baseline = report([task('a', 'failed'), task('b', 'passed')]);
    const candidate = report([task('a', 'passed'), task('b', 'passed')]);
    const result = compareSuiteReports(baseline, candidate);
    expect(result.comparable).toBe(true);
    expect(result.verdict).toBe('improved');
    expect(result.fixes.map((delta) => delta.taskId)).toEqual(['a']);
    expect(result.regressions).toEqual([]);
    expect(result.metrics.passAt1).toEqual({ baseline: 1, candidate: 2, delta: 1 });
  });

  it('只有退步 → 退步（这是 --strict 唯一认的形态）', () => {
    const baseline = report([task('a', 'passed'), task('b', 'passed')]);
    const candidate = report([task('a', 'failed'), task('b', 'passed')]);
    const result = compareSuiteReports(baseline, candidate);
    expect(result.verdict).toBe('regressed');
    expect(result.regressions.map((delta) => delta.taskId)).toEqual(['a']);
    expect(result.regressions[0].baselineStatus).toBe('passed');
    expect(result.regressions[0].candidateStatus).toBe('failed');
  });

  it('有增有减 → 有增有减（不因一半变好就宣布胜利）', () => {
    const baseline = report([task('a', 'passed'), task('b', 'failed')]);
    const candidate = report([task('a', 'failed'), task('b', 'passed')]);
    const result = compareSuiteReports(baseline, candidate);
    expect(result.verdict).toBe('mixed');
    expect(result.regressions.map((delta) => delta.taskId)).toEqual(['a']);
    expect(result.fixes.map((delta) => delta.taskId)).toEqual(['b']);
  });

  it('没有任何变化 → 无变化', () => {
    const baseline = report([task('a', 'passed'), task('b', 'failed')]);
    const candidate = report([task('a', 'passed'), task('b', 'failed')]);
    expect(compareSuiteReports(baseline, candidate).verdict).toBe('unchanged');
  });

  it('agent_error 与 passed 的互换照常算退步/修复——它不是「没跑」', () => {
    const baseline = report([task('a', 'passed'), task('b', 'agent_error')]);
    const candidate = report([task('a', 'agent_error'), task('b', 'passed')]);
    const result = compareSuiteReports(baseline, candidate);
    expect(result.regressions.map((delta) => delta.taskId)).toEqual(['a']);
    expect(result.fixes.map((delta) => delta.taskId)).toEqual(['b']);
  });
});

describe('reportCompare：不可比的口径', () => {
  it('套件版本不同 → 不可比，原因可读', () => {
    const result = compareSuiteReports(report([task('a', 'passed')], { suite: 'v5' }), report([task('a', 'passed')], { suite: 'v6' }));
    expect(result.comparable).toBe(false);
    expect(result.verdict).toBe('incomparable');
    expect(result.reasons.join(' ')).toContain('套件版本不同');
  });

  it('夹具指纹不同 → 不可比（题目集变了，逐题对比没意义）', () => {
    const result = compareSuiteReports(report([task('a', 'passed')], { hash: 'h1' }), report([task('a', 'passed')], { hash: 'h2' }));
    expect(result.comparable).toBe(false);
    expect(result.reasons.join(' ')).toContain('夹具指纹不同');
  });

  it('留出集 vs 调优集 → 不可比（同一套报告结构，靠标记区分）', () => {
    const baseline = report([task('a', 'passed')]);
    const candidate = report([task('a', 'passed')], { heldOut: true });
    const result = compareSuiteReports(baseline, candidate);
    expect(result.comparable).toBe(false);
    expect(result.reasons.join(' ')).toContain('留出集');
  });
});

describe('reportCompare：口径变化不阻断，但要如实列出', () => {
  it('换了 provider / model / revision → 仍可比，逐条列出', () => {
    const baseline = report([task('a', 'passed')], { provider: 'glm', model: 'glm-5.3-flash', revision: 'aaa' });
    const candidate = report([task('a', 'passed')], { provider: 'deepseek-openai', model: 'deepseek-v4-flash', revision: 'bbb' });
    const result = compareSuiteReports(baseline, candidate);
    expect(result.comparable).toBe(true);
    const notes = result.metadataChanges.join(' ');
    expect(notes).toContain('provider');
    expect(notes).toContain('model');
    expect(notes).toContain('gitRevision');
  });

  it('control 运行被认出来，并阻止「控制组 → agent」被读成质量改善', () => {
    const control = report([task('a', 'control'), task('b', 'control')], { provider: '' });
    const run = report([task('a', 'passed'), task('b', 'passed')], { provider: 'glm' });
    expect(isControlRun(control)).toBe(true);
    expect(isControlRun(run)).toBe(false);
    const result = compareSuiteReports(control, run);
    expect(result.metadataChanges.join(' ')).toContain('control');
  });

  it('没有 provider 元数据一律当 control——「从没连上 provider 的运行不是基线」', () => {
    expect(isControlRun(report([task('a', 'passed')], { provider: '' }))).toBe(true);
  });
});

describe('reportCompare：新增/消失与空集', () => {
  it('候选独有的题归「新增」，不进修复；基线独有的归「消失」，不进退步', () => {
    const baseline = report([task('a', 'passed'), task('b', 'passed')]);
    const candidate = report([task('a', 'passed'), task('c', 'passed')]);
    const result = compareSuiteReports(baseline, candidate);
    expect(result.appeared.map((delta) => delta.taskId)).toEqual(['c']);
    expect(result.missing.map((delta) => delta.taskId)).toEqual(['b']);
    expect(result.fixes).toEqual([]);
    expect(result.regressions).toEqual([]);
    // 有增有失（题目集对不上）本身不该被读成「无变化」的沉默通过。
    expect(result.verdict).toBe('unchanged');
  });

  it('空任务列表不崩，指标归零', () => {
    const result = compareSuiteReports(report([]), report([]));
    expect(result.verdict).toBe('unchanged');
    expect(result.metrics.passAt1).toEqual({ baseline: 0, candidate: 0, delta: 0 });
  });

  it('坏数字字段当 0，不把 NaN 传下去', () => {
    const broken = report([task('a', 'passed')]) as unknown as { passAt1: unknown; meanDurationMs: unknown };
    broken.passAt1 = 'nonsense';
    broken.meanDurationMs = Number.NaN;
    const result = compareSuiteReports(report([task('a', 'passed')]), broken as unknown as CodingTaskSuiteReport);
    expect(result.metrics.passAt1.baseline).toBe(1);
    expect(result.metrics.passAt1.candidate).toBe(0);
    expect(result.metrics.meanDurationMs.candidate).toBe(0);
  });
});
