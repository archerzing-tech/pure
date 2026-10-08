// src/ui/__tests__/bottleneckSummary.test.ts
import { describe, expect, test } from 'bun:test';
import type { PromptObservation, DelegationObservation } from '../../shared/promptObservability';
import { computeBottleneckSummary, topBottleneckRoles, type BottleneckRow } from '../../shared/bottleneckSummary';
import { KNOWN_SUBAGENT_ROLES } from '../../shared/adaptiveControl';
import { NON_ROLE_SUBAGENTS } from '../../shared/subagentAdvisory';

const ROLES = [...KNOWN_SUBAGENT_ROLES].filter((r) => !NON_ROLE_SUBAGENTS.has(r));

function del(role: string, o: { s?: boolean; ms?: number; kind?: string; at?: number } = {}): DelegationObservation {
  return { agentId: `ag-${role}`, role, startedAt: o.at ?? Date.now() - 3600_000, durationMs: o.ms, success: o.s ?? true, errorKind: o.kind };
}
function rec(dels: DelegationObservation[], at?: number): PromptObservation {
  return { type: 'agent_run', startedAt: at ?? Date.now() - 3600_000, durationMs: 60_000, delegations: dels } as PromptObservation;
}

describe('bottleneckSummary', () => {
  test('empty window → no rows', () => {
    const s = computeBottleneckSummary([], { roles: ROLES, windowDays: 7 });
    expect(s.roles).toHaveLength(0);
  });

  test('drops roles with zero delegations', () => {
    const limited = ['planner', 'coder'];
    const s = computeBottleneckSummary([rec([del('planner')])], { roles: limited, windowDays: 30 });
    expect(s.roles.find((r) => r.role === 'planner')).toBeDefined();
    expect(s.roles.find((r) => r.role === 'coder')).toBeUndefined();
  });

  test('critical', () => {
    const s = computeBottleneckSummary([rec([
      del('coder', { s: false, kind: 'timeout' }),
      del('coder', { s: false }),
      del('coder', { s: true }),
      del('coder', { s: false }),
      del('coder', { s: false }),
    ])], { roles: ['coder'], windowDays: 30 });
    expect(s.critical).toBeDefined();
    const c = s.roles.find((r) => r.role === 'coder')!;
    expect(c.failureRate).toBe(80);
    expect(s.critical.some((r) => r.role === 'coder')).toBe(true);
  });

  test('warning', () => {
    const s = computeBottleneckSummary([rec([
      del('researcher', { s: false }),
      del('researcher'),
      del('researcher'),
      del('researcher'),
      del('researcher'),
    ])], { roles: ['researcher'], windowDays: 30 });
    const r = s.roles.find((r) => r.role === 'researcher')!;
    expect(r.failureRate).toBe(20);
    expect(s.warning.some((r) => r.role === 'researcher')).toBe(true);
  });

  test('ok', () => {
    const s = computeBottleneckSummary([rec([
      del('editor', { s: true }),
      del('editor'),
      del('editor'),
      del('editor'),
      del('editor'),
    ])], { roles: ['editor'], windowDays: 30 });
    const e = s.roles.find((r) => r.role === 'editor')!;
    expect(e.failureRate).toBe(0);
    expect(s.critical).toHaveLength(0);
    expect(s.warning).toHaveLength(0);
  });

  test('filters by windowDays', () => {
    const now = Date.now();
    const oneDayMs = 24 * 3600_000;
    const oldAt = now - 40 * oneDayMs;
    const freshAt = now - 3 * oneDayMs;
    const rec: PromptObservation = { type: 'agent_run', startedAt: freshAt, durationMs: 60_000, traceId: 't1', eventCounts: {}, toolCalls: [], reasoningChars: 0, outputChars: 0, delegations: [
      del('planner', { at: oldAt, s: false, ms: 5_000 }),
      del('planner', { at: oldAt, s: false, ms: 5_000 }),
      del('planner', { at: freshAt, s: true, ms: 5_000 }),
    ] };
    const s = computeBottleneckSummary([rec], { roles: ['planner'], windowDays: 7, now });
    const p = s.roles.find((r) => r.role === 'planner')!;
    expect(p.delegations).toBe(1);
  });

  // 这条夹具要验的是**排序**（失败率降序，同率比派发量），顺手断言 critical 为空。
  // 原夹具用 50% 与 100% 的失败率，而 50% 正好撞上 CRITICAL_FAILURE_RATE=50 被判
  // critical——于是断言与被测的排序行为无关，却让这条测试永远红着。改成两个都落在
  // warning 档的失败率（b 30% > a 10%）：排序信号保留，critical 自然为空。
  test('topBottleneckRoles sorted', () => {
    const s = computeBottleneckSummary([
      rec([del('a', { s: false }), ...Array.from({ length: 9 }, () => del('a'))]),
      rec([del('b', { s: false }), del('b', { s: false }), del('b', { s: false }), ...Array.from({ length: 7 }, () => del('b'))]),
    ], { roles: ['a', 'b'], windowDays: 30 });
    expect(s.roles.find((r) => r.role === 'a')!.failureRate).toBe(10);
    expect(s.roles.find((r) => r.role === 'b')!.failureRate).toBe(30);
    expect(s.critical).toHaveLength(0);
    const top: BottleneckRow[] = topBottleneckRoles(s);
    expect(top.map((r) => r.role)).toEqual(['b', 'a']);
  });

  // 失败率落在 (30, 50)：不够 critical，也进不了 warning（successRate < 70），
  // 被归成 ok。这条把「三成失败显示 ok」这个已知设计问题钉成**当前口径**——
  // 口径一旦改动（例如把 WARNING_HIGH 抬到 50），这条会先红，提醒同步更新注释。
  test('failureRate 30–50% currently classifies as ok (known threshold gap)', () => {
    // 4/10 = 40%：不够 critical（< 50），successRate 60 也低于 warning 下界 70。
    const s = computeBottleneckSummary([
      rec([del('mid', { s: false }), del('mid', { s: false }), del('mid', { s: false }), del('mid', { s: false }), ...Array.from({ length: 6 }, () => del('mid'))]),
    ], { roles: ['mid'], windowDays: 30 });
    const row = s.roles.find((r) => r.role === 'mid')!;
    expect(row.failureRate).toBe(40);
    expect(row.classification).toBe('ok');
    expect(s.critical).toHaveLength(0);
    expect(s.warning).toHaveLength(0);
  });

  test('lastFailureAt tracks the newest failure and is absent when none failed', () => {
    const now = Date.now();
    const hour = 3600_000;
    const s = computeBottleneckSummary([
      rec([del('x', { s: false, at: now - 5 * hour }), del('x', { s: false, at: now - hour }), del('x')]),
      rec([del('y')]),
    ], { roles: ['x', 'y'], windowDays: 30, now });
    expect(s.roles.find((r) => r.role === 'x')!.lastFailureAt).toBe(now - hour);
    expect(s.roles.find((r) => r.role === 'y')!.lastFailureAt).toBeUndefined();
  });
});
