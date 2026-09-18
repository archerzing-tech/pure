// src/shared/__tests__/subagentAdvisory.test.ts
// E1.4 — 角色建议的门槛与归因：样本不足不开口、超时占多数指向"任务体量不对"、
// 普通失败指向"失败率高"、非角色工具（read_file / bash_executor）永不进表、
// 窗口外的旧记录不算数。

import { describe, it, expect } from 'bun:test';
import type { AgentRunObservation, PromptObservation, ToolObservation } from '../promptObservability';
import {
  scanSubagentAdvice,
  SUBAGENT_MAX_ADVICE,
  SUBAGENT_MIN_DELEGATIONS,
} from '../subagentAdvisory';

const NOW = Date.now();
const RECENT = NOW - 3600_000;

function roleCall(role: string, success: boolean, overrides: Partial<ToolObservation> = {}): ToolObservation {
  return {
    toolName: role,
    success,
    durationMs: 1000,
    ...(success ? {} : { error: { kind: 'tool_error', hash: 'h', chars: 5 } }),
    ...overrides,
  };
}

function run(calls: ToolObservation[], startedAt = RECENT): AgentRunObservation {
  return {
    type: 'agent_run',
    traceId: `run_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 's1',
    startedAt,
    endedAt: startedAt + 1000,
    eventCounts: {},
    toolCalls: calls,
    reasoningChars: 0,
    outputChars: 0,
  };
}

/** 造 N 次派发，其中 failures 次失败（失败的错误类可选）。 */
function delegations(role: string, total: number, failures: number, kind = 'tool_error', startedAt = RECENT): PromptObservation[] {
  const calls: ToolObservation[] = [];
  for (let i = 0; i < total; i++) {
    const failed = i < failures;
    calls.push(roleCall(role, !failed, failed ? { error: { kind, hash: `h${i}`, chars: 5 } } : {}));
  }
  return [run(calls, startedAt)];
}

describe('scanSubagentAdvice', () => {
  it('stays silent below the sample-size floor', () => {
    // 2 次派发 2 次失败：失败率 100% 但样本不够 —— 不构成"持续"。
    expect(scanSubagentAdvice(delegations('researcher', 2, 2), { now: NOW })).toEqual([]);
  });

  it('stays silent when the failure rate is below the threshold', () => {
    // 5 次派发 1 次失败（20%）：不值得让用户动配置。
    expect(scanSubagentAdvice(delegations('researcher', 5, 1), { now: NOW })).toEqual([]);
  });

  it('reports a timeout-dominated role as a timeout problem, pointing at its skill gate', () => {
    const advice = scanSubagentAdvice(delegations('researcher', 4, 3, 'timeout'), { now: NOW });
    expect(advice).toHaveLength(1);
    expect(advice[0]).toMatchObject({
      role: 'researcher',
      reason: 'timeout',
      severity: 'high', // 3 次超时
      delegations: 4,
      failures: 3,
      failureRate: 75,
      timeoutCount: 3,
      dominantKind: 'timeout',
      action: 'skill-gate',
      skillId: 'web-research',
    });
    expect(advice[0].avgDurationMs).toBe(1000);
    expect(advice[0].lastFailureAt).toBeGreaterThan(0);
  });

  it('classifies mixed failures as a generic failure-rate problem', () => {
    const records = [
      ...delegations('code_reviewer', 2, 1, 'timeout'),
      ...delegations('code_reviewer', 2, 2, 'tool_error'),
    ];
    const advice = scanSubagentAdvice(records, { now: NOW });
    expect(advice).toHaveLength(1);
    // 4 次派发 3 次失败，其中超时 1 次（未过半）→ 泛化失败率；同技能门的另一个角色
    // 也在（code_reviewer ↔ code-review），这里只断言归因与严重度。
    expect(advice[0]).toMatchObject({
      role: 'code_reviewer',
      reason: 'failure',
      severity: 'high', // 75%
      timeoutCount: 1,
      dominantKind: 'tool_error',
      skillId: 'code-review',
    });
  });

  it('marks roles without a skill switch as prompt-only actions', () => {
    const advice = scanSubagentAdvice(delegations('deep_thinker', 3, 2), { now: NOW });
    expect(advice).toHaveLength(1);
    expect(advice[0].action).toBe('prompt');
    expect(advice[0].skillId).toBeUndefined();
  });

  it('gives a medium severity to a mid-range failure rate', () => {
    // 5 次派发 2 次失败 = 40%（刚过门槛）→ medium。
    const advice = scanSubagentAdvice(delegations('ui_designer', 5, 2), { now: NOW });
    expect(advice[0]).toMatchObject({ severity: 'medium', failureRate: 40, reason: 'failure' });
  });

  it('never reports non-role tools (read_file) or bash_executor as roles', () => {
    const records = [
      ...delegations('read_file', 6, 6),
      ...delegations('bash_executor', 6, 6),
    ];
    expect(scanSubagentAdvice(records, { now: NOW })).toEqual([]);
  });

  it('ignores records outside the window and future-dated ones', () => {
    const old = delegations('researcher', 5, 4, 'timeout', NOW - 60 * 86_400_000);
    expect(scanSubagentAdvice(old, { now: NOW })).toEqual([]);
    const future = delegations('researcher', 5, 4, 'timeout', NOW + 86_400_000);
    expect(scanSubagentAdvice(future, { now: NOW })).toEqual([]);
  });

  it('sorts by failure count and caps the list', () => {
    const roles = ['researcher', 'code_reviewer', 'project_auditor', 'task_planner', 'deep_thinker', 'ui_designer', 'code_editor'];
    const records: PromptObservation[] = [];
    roles.forEach((role, index) => {
      // 7 个角色都够门槛（4 次派发 / 2 次失败 = 50%），首个多一次失败用来验排序。
      records.push(...delegations(role, 4, index === 0 ? 3 : 2));
    });
    const advice = scanSubagentAdvice(records, { now: NOW });
    expect(advice.length).toBe(SUBAGENT_MAX_ADVICE);
    expect(advice[0].failures).toBe(3);
    expect(advice[0].failures).toBeGreaterThanOrEqual(advice[advice.length - 1].failures);
    expect(advice[0].failureRate).toBeGreaterThanOrEqual(advice[1].failureRate);
  });

  it('returns nothing for an empty or run-free input', () => {
    expect(scanSubagentAdvice([], { now: NOW })).toEqual([]);
    const assembly: PromptObservation = {
      type: 'prompt_assembly',
      traceId: 'p1',
      timestamp: NOW,
      promptVersion: 'prompt_x',
      system: { chars: 1, hash: 'a' },
      budget: {
        contextWindowTokens: 0, outputReserveTokens: 0, safetyMarginTokens: 0, availableInputTokens: 0,
        estimatedInputTokens: 0, estimatedToolTokens: 0, includedFragmentIds: [], omittedFragmentIds: [], overBudget: false,
      },
    };
    expect(scanSubagentAdvice([assembly], { now: NOW })).toEqual([]);
  });

  it('counts one role once per call, aggregating across sessions', () => {
    const records = [
      run([roleCall('researcher', false, { error: { kind: 'timeout', hash: 'a', chars: 1 } })]),
      { ...run([roleCall('researcher', false, { error: { kind: 'timeout', hash: 'b', chars: 1 } })]), sessionId: 's2' },
      run([roleCall('researcher', true)]),
    ];
    const advice = scanSubagentAdvice(records, { now: NOW });
    // 2/3 = 66.7% 已够高严重度；超时占失败过半 → 归因超时。
    expect(advice[0]).toMatchObject({ delegations: 3, failures: 2, timeoutCount: 2, reason: 'timeout', severity: 'high' });
    expect(SUBAGENT_MIN_DELEGATIONS).toBe(3);
  });
});
