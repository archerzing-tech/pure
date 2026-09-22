// src/shared/__tests__/adviceApplication.test.ts
// 13.1 — 已应用建议回看读模型的单元测试：collectAppliedAdvice 的排序与封顶、
// postApplyStats 的窗口边界（appliedAt 起点、now 终点、未来应用记零）。
// 顺带钉死一个口径：postApplyStats 只读 toolCalls，不依赖 T1 的 delegations
// 字段——旧记录（T1 之前落的盘）也回看得动。

import { describe, it, expect } from 'bun:test';
import type { AgentRunObservation, AdviceAppliedObservation, PromptObservation, ToolObservation } from '../promptObservability';
import { collectAppliedAdvice, MAX_APPLIED_ADVICE_ROWS, postApplyStats } from '../adviceApplication';

const NOW = Date.parse('2026-09-22T12:00:00Z');
const T0 = NOW - 3 * 86_400_000;

function appliedRecord(kind: 'skill-gate' | 'tool-note', target: string, appliedAt: number): AdviceAppliedObservation {
  return { type: 'advice_applied', appliedAt, kind, target };
}

function roleCall(toolName: string, success: boolean): ToolObservation {
  return {
    toolName,
    success,
    durationMs: 1000,
    ...(success ? {} : { error: { kind: 'timeout', hash: 'h', chars: 5 } }),
  };
}

function agentRun(calls: ToolObservation[], startedAt: number): AgentRunObservation {
  return {
    type: 'agent_run',
    traceId: `run_${Math.random().toString(36).slice(2, 8)}`,
    startedAt,
    endedAt: startedAt + 1000,
    eventCounts: {},
    toolCalls: calls,
    reasoningChars: 0,
    outputChars: 0,
  };
}

describe('collectAppliedAdvice', () => {
  it('returns only advice_applied records, newest first', () => {
    const records: PromptObservation[] = [
      agentRun([], T0),
      appliedRecord('skill-gate', 'researcher', T0 + 1000),
      { type: 'prompt_assembly', traceId: 'p1', timestamp: T0, promptVersion: 'v', system: { chars: 1, hash: 'h' }, budget: {
        contextWindowTokens: 0, outputReserveTokens: 0, safetyMarginTokens: 0, availableInputTokens: 0,
        estimatedInputTokens: 0, estimatedToolTokens: 0, includedFragmentIds: [], omittedFragmentIds: [], overBudget: false,
      } },
      appliedRecord('tool-note', 'web_fetch', T0 + 3000),
      appliedRecord('skill-gate', 'task_planner', T0 + 2000),
    ];
    const applied = collectAppliedAdvice(records);
    expect(applied.map((record) => record.appliedAt)).toEqual([T0 + 3000, T0 + 2000, T0 + 1000]);
  });

  it('caps at MAX_APPLIED_ADVICE_ROWS keeping the newest', () => {
    const records: PromptObservation[] = [];
    for (let i = 0; i < MAX_APPLIED_ADVICE_ROWS + 3; i++) {
      records.push(appliedRecord('tool-note', `tool_${i}`, T0 + i));
    }
    const applied = collectAppliedAdvice(records);
    expect(applied).toHaveLength(MAX_APPLIED_ADVICE_ROWS);
    expect(applied[0].appliedAt).toBe(T0 + MAX_APPLIED_ADVICE_ROWS + 2); // newest survives
  });

  it('returns empty for a log without applied advice', () => {
    expect(collectAppliedAdvice([agentRun([], T0)])).toEqual([]);
    expect(collectAppliedAdvice([])).toEqual([]);
  });
});

describe('postApplyStats', () => {
  it('counts only agent_run calls after appliedAt, splitting by kind', () => {
    const applied = appliedRecord('skill-gate', 'researcher', T0);
    const records: PromptObservation[] = [
      // 应用前：不计
      agentRun([roleCall('researcher', false), roleCall('researcher', true)], T0 - 1000),
      // 应用后：2 次派发，1 次失败
      agentRun([roleCall('researcher', true), roleCall('researcher', false), roleCall('web_fetch', false)], T0 + 500),
      // 别的角色/工具不计入 delegations（但同目标的失败才计）
      agentRun([roleCall('task_planner', false)], T0 + 600),
    ];
    expect(postApplyStats(records, applied, NOW)).toEqual({ delegations: 2, failures: 1 });
  });

  it('counts tool-note failures per tool across classes (observations lack error text)', () => {
    const applied = appliedRecord('tool-note', 'web_fetch', T0);
    const records: PromptObservation[] = [
      agentRun([roleCall('web_fetch', false), roleCall('web_fetch', true)], T0 + 500),
      agentRun([roleCall('web_fetch', false)], T0 + 600),
    ];
    // 失败 2 次：观测里没有错误原文，分不了错误类，只按工具计。
    expect(postApplyStats(records, applied, NOW)).toEqual({ delegations: 0, failures: 2 });
  });

  it('respects the now boundary and zeroes a future-dated apply', () => {
    const future = appliedRecord('skill-gate', 'researcher', NOW + 86_400_000);
    const records: PromptObservation[] = [agentRun([roleCall('researcher', false)], T0)];
    expect(postApplyStats(records, future, NOW)).toEqual({ delegations: 0, failures: 0 });

    const applied = appliedRecord('skill-gate', 'researcher', T0);
    // now 之前的 run 照算；now 之后的（时钟偏斜写进来的未来记录）不算。
    expect(postApplyStats([agentRun([roleCall('researcher', true)], NOW + 500)], applied, NOW))
      .toEqual({ delegations: 0, failures: 0 });
  });

  it('works on pre-T1 records (no delegations array) — reads toolCalls only', () => {
    const applied = appliedRecord('skill-gate', 'researcher', T0);
    const preT1: AgentRunObservation = { ...agentRun([roleCall('researcher', false)], T0 + 100) };
    delete (preT1 as { delegations?: unknown }).delegations;
    expect(postApplyStats([preT1], applied, NOW)).toEqual({ delegations: 1, failures: 1 });
  });

  it('returns zeros for an empty log', () => {
    expect(postApplyStats([], appliedRecord('tool-note', 'web_fetch', T0), NOW)).toEqual({ delegations: 0, failures: 0 });
  });
});
