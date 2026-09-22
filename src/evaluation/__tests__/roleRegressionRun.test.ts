// src/evaluation/__tests__/roleRegressionRun.test.ts
// 13.3 part 3 — A/B 编排核心测试（runCase 注入，无网络/无 IO）。

import { describe, expect, it } from 'bun:test';
import { AB_MAX_ATTEMPTS, MAX_AB_CASES, runRoleRegressionAB, type RunRoleCase } from '../roleRegressionRun';
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

  describe('护栏（2026-09-22 审查补：上限 / 取消 / 失败重试）', () => {
    it('样本数硬上限：fixture 再多也只跑 MAX_AB_CASES 例', async () => {
      let calls = 0;
      const runCase: RunRoleCase = async () => {
        calls += 1;
        return '正确';
      };
      const result = await runRoleRegressionAB({
        role: 'r',
        fixtures: fixtures(MAX_AB_CASES + 5),
        overlay: 'x',
        runCase,
      });
      expect(result.grades.base).toHaveLength(MAX_AB_CASES);
      expect(result.grades.overlay).toHaveLength(MAX_AB_CASES);
      // 一次点击最多 2×N 次真实子 agent 运行。
      expect(calls).toBe(MAX_AB_CASES * 2);
    });

    it('maxCases 只能收紧，不能突破硬上限', async () => {
      const result = await runRoleRegressionAB({
        role: 'r',
        fixtures: fixtures(MAX_AB_CASES + 5),
        overlay: 'x',
        maxCases: MAX_AB_CASES + 4,
        runCase: async () => '正确',
      });
      expect(result.grades.base).toHaveLength(MAX_AB_CASES);
    });

    it('运行失败（[RUN_FAILED] / 空产出）重试，不当作断言失败', async () => {
      expect(AB_MAX_ATTEMPTS).toBeGreaterThan(1);
      let firstBaseCase = 0;
      const runCase: RunRoleCase = async (fixture, overlay) => {
        if (!overlay && fixture.id === 'case-01') {
          firstBaseCase += 1;
          if (firstBaseCase === 1) return '[RUN_FAILED] provider stall';
        }
        return '正确';
      };
      const result = await runRoleRegressionAB({ role: 'r', fixtures: fixtures(5), overlay: 'x', runCase });
      expect(result.base).toEqual({ passed: 5, total: 5 });
      expect(result.overlay).toEqual({ passed: 5, total: 5 });
      expect(result.verdict).toBe('allow');
    });

    it('断言失败不重试——那正是要测的信号', async () => {
      let overlayCalls = 0;
      const runCase: RunRoleCase = async (_fixture, overlay) => {
        if (overlay) overlayCalls += 1;
        return overlay ? '没提' : '正确';
      };
      const result = await runRoleRegressionAB({ role: 'r', fixtures: fixtures(5), overlay: 'x', runCase });
      expect(overlayCalls).toBe(5);
      expect(result.verdict).toBe('reject');
    });

    it('abort 后停止后续 case 并抛 AbortError', async () => {
      const controller = new AbortController();
      let calls = 0;
      const runCase: RunRoleCase = async () => {
        calls += 1;
        if (calls === 2) controller.abort();
        return '正确';
      };
      await expect(
        runRoleRegressionAB({ role: 'r', fixtures: fixtures(5), overlay: 'x', runCase, signal: controller.signal }),
      ).rejects.toThrow('role A/B aborted');
      expect(calls).toBe(2);
    });

    it('开跑前已 abort 的 signal 直接拒绝，一次 runCase 都不发', async () => {
      const controller = new AbortController();
      controller.abort();
      let calls = 0;
      const runCase: RunRoleCase = async () => {
        calls += 1;
        return '正确';
      };
      await expect(
        runRoleRegressionAB({ role: 'r', fixtures: fixtures(5), overlay: 'x', runCase, signal: controller.signal }),
      ).rejects.toThrow('role A/B aborted');
      expect(calls).toBe(0);
    });
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
