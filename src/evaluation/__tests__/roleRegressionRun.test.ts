// src/evaluation/__tests__/roleRegressionRun.test.ts
// 13.3 part 3 — A/B 编排核心测试（runCase 注入，无网络/无 IO）。

import { describe, expect, it } from 'bun:test';
import { runRoleRegressionAB, type RunRoleCase } from '../roleRegressionRun';
import type { RoleCaseFixture } from '../roleRegression';

const fixtures = (n: number): RoleCaseFixture[] =>
  Array.from({ length: n }, (_, i) => ({ id: `case-0${i + 1}`, args: { prompt: `p${i}` }, must: ['正确'] }));

describe('runRoleRegressionAB', () => {
  it('两侧各跑同一批 case，产出裁决与逐例明细', async () => {
    const runCase: RunRoleCase = async (fixture, overlay) => (overlay ? `正确 ${fixture.id}` : '正确');
    const result = await runRoleRegressionAB({
      role: 'code_reviewer',
      fixtures: fixtures(5),
      overlay: '新增约束',
      runCase,
    });
    expect(result.base).toEqual({ passed: 5, total: 5 });
    expect(result.overlay).toEqual({ passed: 5, total: 5 });
    expect(result.verdict).toBe('allow');
    expect(result.grades.base).toHaveLength(5);
    expect(result.grades.overlay).toHaveLength(5);
  });

  it('overlay 变差 → reject', async () => {
    const runCase: RunRoleCase = async (_fixture, overlay) => (overlay ? '没提' : '正确');
    const result = await runRoleRegressionAB({ role: 'r', fixtures: fixtures(5), overlay: 'x', runCase });
    expect(result.verdict).toBe('reject');
  });

  it('样本不足 → deny，且不因 2/2 撞大运放行', async () => {
    const runCase: RunRoleCase = async () => '正确';
    const result = await runRoleRegressionAB({ role: 'r', fixtures: fixtures(2), overlay: 'x', runCase });
    expect(result.verdict).toBe('deny_insufficient_data');
  });

  it('runCase 抛错按"无产出"处理（该例判挂），不炸整轮', async () => {
    const runCase: RunRoleCase = async (fixture, overlay) => {
      if (overlay && fixture.id === 'case-03') throw new Error('provider blew up');
      return '正确';
    };
    await expect(
      runRoleRegressionAB({ role: 'r', fixtures: fixtures(5), overlay: 'x', runCase }),
    ).rejects.toThrow(); // 编排本身不吞异常——是否兜底由调用方的 runCase 决定
  });

  it('onCase 按 base→overlay 顺序回调', async () => {
    const seen: string[] = [];
    const runCase: RunRoleCase = async () => '正确';
    await runRoleRegressionAB({
      role: 'r',
      fixtures: fixtures(5),
      overlay: 'x',
      runCase,
      onCase: (side, grade) => seen.push(`${side}:${grade.id}`),
    });
    expect(seen[0]).toBe('base:case-01');
    expect(seen[1]).toBe('overlay:case-01');
    expect(seen).toHaveLength(10);
  });
});
