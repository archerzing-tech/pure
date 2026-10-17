// src/shared/__tests__/parallelismSummary.test.ts
// B5 —— 并行机会读数的行为判例。
//
// 要锁的三条口径：①「重叠」按区间扫描判，首尾相接不算重叠、缺时长的零长区间不抬高
// 并发；②串行扇出（≥2 支却从不重叠）必须被认出来——这正是「本可并行却串了」的形状；
// ③没有委派 / 非 agent_run 一律是「无数据」而不是 0，否则空窗口会被读成「并行为 0」。

import { describe, expect, it } from 'bun:test';
import { maxOverlap, runParallelism, summarizeParallelism } from '../parallelismSummary';
import type { AgentRunObservation, DelegationObservation, PromptObservation } from '../promptObservability';

const DAY = 24 * 60 * 60 * 1000;

function delegation(startedAt: number, durationMs?: number): DelegationObservation {
  return { agentId: `ag-${startedAt}-${Math.random().toString(36).slice(2, 6)}`, role: 'researcher', startedAt, ...(durationMs === undefined ? {} : { durationMs }) };
}

function run(traceId: string, startedAt: number, delegations?: DelegationObservation[]): AgentRunObservation {
  return {
    type: 'agent_run',
    traceId,
    startedAt,
    eventCounts: {},
    toolCalls: [],
    reasoningChars: 0,
    outputChars: 0,
    ...(delegations ? { delegations } : {}),
  };
}

describe('maxOverlap', () => {
  it('不重叠 → 1；首尾相接不算重叠', () => {
    expect(maxOverlap([{ start: 0, end: 10 }])).toBe(1);
    expect(maxOverlap([{ start: 0, end: 10 }, { start: 10, end: 20 }])).toBe(1);
    expect(maxOverlap([{ start: 0, end: 10 }, { start: 11, end: 20 }])).toBe(1);
  });

  it('真重叠 → 计出同时在跑的支数', () => {
    expect(maxOverlap([{ start: 0, end: 10 }, { start: 5, end: 15 }])).toBe(2);
    expect(maxOverlap([{ start: 0, end: 10 }, { start: 2, end: 12 }, { start: 4, end: 6 }])).toBe(3);
  });

  it('缺时长（零长区间）按最小占位 1ms：保住它自己，也不把相邻的支误判成重叠', () => {
    expect(maxOverlap([{ start: 5, end: 5 }])).toBe(1);
    // 另有一支正跑在 5ms 那一刻 → 这是"同时在跑"的证据，该算 2。
    expect(maxOverlap([{ start: 0, end: 10 }, { start: 5, end: 5 }])).toBe(2);
  });
});

describe('runParallelism：单轮形状', () => {
  it('两支不重叠 → 串行扇出（本可并行却没并行）', () => {
    const shape = runParallelism(run('t1', 1000, [delegation(1000, 500), delegation(2000, 500)]));
    expect(shape).not.toBeNull();
    expect(shape!.delegations).toBe(2);
    expect(shape!.maxConcurrency).toBe(1);
    expect(shape!.sequential).toBe(true);
  });

  it('两支重叠 → 不是串行，且同时数为 2', () => {
    const shape = runParallelism(run('t2', 1000, [delegation(1000, 500), delegation(1200, 500)]));
    expect(shape!.maxConcurrency).toBe(2);
    expect(shape!.sequential).toBe(false);
  });

  it('单支不叫「串行扇出」——没有并行机会可言', () => {
    const shape = runParallelism(run('t3', 1000, [delegation(1000, 500)]));
    expect(shape!.sequential).toBe(false);
    expect(shape!.exceedsCap).toBe(false);
  });

  it('扇出超过并发上限 → exceedsCap（多出来的只能排队）', () => {
    const six = Array.from({ length: 6 }, (_, i) => delegation(1000 + i, 500));
    expect(runParallelism(run('t4', 1000, six), 5)!.exceedsCap).toBe(true);
    expect(runParallelism(run('t5', 1000, six), 6)!.exceedsCap).toBe(false);
  });

  it('没有委派 / 非 agent_run → null（无数据，不是 0）', () => {
    expect(runParallelism(run('t6', 1000))).toBeNull();
    const advice: PromptObservation = { type: 'advice_applied', appliedAt: 1, kind: 'skill-gate', target: 'code_reviewer' };
    expect(runParallelism(advice)).toBeNull();
  });
});

describe('summarizeParallelism：窗口聚合', () => {
  const now = 100 * DAY;

  it('只数窗口内的运行，窗口外的忽略', () => {
    const summary = summarizeParallelism(
      [run('in', now - DAY, [delegation(now - DAY, 100), delegation(now - DAY + 200, 100)]), run('out', now - 40 * DAY, [delegation(now - 40 * DAY, 100), delegation(now - 40 * DAY + 500, 100)])],
      { now, windowDays: 30 },
    );
    expect(summary.runs).toBe(1);
    expect(summary.rows.map((row) => row.traceId)).toEqual(['in']);
  });

  it('汇总串行 / 超限 / 最大同时数，rows 只列扇出 ≥2 的轮', () => {
    const records: PromptObservation[] = [
      run('a', now - DAY, [delegation(now - DAY, 100), delegation(now - DAY + 1000, 100)]),          // 串行 2 支
      run('b', now - 2 * DAY, [delegation(now - 2 * DAY, 100), delegation(now - 2 * DAY + 50, 100)]), // 并行 2 支
      run('c', now - 3 * DAY, [delegation(now - 3 * DAY, 100)]),                                       // 单支，不进 rows
      run('d', now - 4 * DAY, Array.from({ length: 7 }, (_, i) => delegation(now - 4 * DAY + i * 10, 100))), // 扇出 7 支
    ];
    const summary = summarizeParallelism(records, { now, windowDays: 30, cap: 5 });
    expect(summary.runs).toBe(4);
    expect(summary.multiDelegationRuns).toBe(3);
    expect(summary.sequentialRuns).toBe(1);
    expect(summary.exceedingRuns).toBe(1);
    expect(summary.maxConcurrencySeen).toBe(7);
    expect(summary.rows.map((row) => row.traceId).sort()).toEqual(['a', 'b', 'd']);
  });

  it('空窗口 → 全零、rows 为空（不是撒谎的 0 并发）', () => {
    const summary = summarizeParallelism([], { now, windowDays: 30 });
    expect(summary.runs).toBe(0);
    expect(summary.multiDelegationRuns).toBe(0);
    expect(summary.maxConcurrencySeen).toBe(0);
    expect(summary.rows).toEqual([]);
  });
});
