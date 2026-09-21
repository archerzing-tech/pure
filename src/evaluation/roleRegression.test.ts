// src/evaluation/roleRegression.test.ts
// 13.3 part 2 — 内容断言判卷 + A/B 准入裁决的纯函数测试（无网络、无 IO）。

import { describe, expect, it } from 'bun:test';
import {
  gradeRoleCase,
  MIN_ROLE_CASES,
  rolePassRate,
  roleRegressionVerdict,
  roleSideScore,
  type RoleCaseFixture,
} from './roleRegression';

const fixture = (overrides: Partial<RoleCaseFixture> = {}): RoleCaseFixture => ({
  id: 'case-01',
  args: { prompt: 'review this' },
  must: ['正确性'],
  ...overrides,
});

describe('gradeRoleCase', () => {
  it('must 全中且 mustNot 不出现 → 通过', () => {
    const grade = gradeRoleCase('## 正确性\n第 3 行越界。', fixture({ must: ['正确性'], mustNot: ['通过'] }));
    expect(grade.passed).toBe(true);
    expect(grade.failures).toEqual([]);
  });

  it('must 缺失 → 不通过，且逐条给出原因', () => {
    const grade = gradeRoleCase('看起来没问题。', fixture({ must: ['正确性', '安全'] }));
    expect(grade.passed).toBe(false);
    expect(grade.failures).toHaveLength(2);
    expect(grade.failures[0]).toContain('正确性');
    expect(grade.failures[1]).toContain('安全');
  });

  it('mustNot 出现 → 不通过', () => {
    const grade = gradeRoleCase('结论：直接通过。', fixture({ must: ['结论'], mustNot: ['直接通过'] }));
    expect(grade.passed).toBe(false);
    expect(grade.failures[0]).toContain('mustNot');
  });

  it('大小写与空白不敏感（跨行、多空格、大小写差异都算命中）', () => {
    const grade = gradeRoleCase('Section:  CORRECTNESS\n—   the loop is off by one.', fixture({ must: ['correctness', 'off   by\none'] }));
    expect(grade.passed).toBe(true);
  });

  it('空输出（崩溃/超时）必然未过 — 每个 must 都缺失', () => {
    const grade = gradeRoleCase('', fixture({ must: ['anything'] }));
    expect(grade.passed).toBe(false);
  });
});

describe('roleRegressionVerdict (A/B 准入门槛)', () => {
  it(`任一侧样本 < ${MIN_ROLE_CASES} → deny_insufficient_data（即使全过）`, () => {
    const few = { passed: 3, total: 3 };
    const plenty = { passed: 5, total: 5 };
    expect(roleRegressionVerdict(few, plenty).verdict).toBe('deny_insufficient_data');
    expect(roleRegressionVerdict(plenty, few).verdict).toBe('deny_insufficient_data');
    expect(roleRegressionVerdict({ passed: 0, total: 0 }, plenty).verdict).toBe('deny_insufficient_data');
  });

  it('overlay 通过率更高 → allow', () => {
    const result = roleRegressionVerdict({ passed: 4, total: MIN_ROLE_CASES }, { passed: 5, total: MIN_ROLE_CASES });
    expect(result.verdict).toBe('allow');
  });

  it('打平也算不输 → allow', () => {
    const result = roleRegressionVerdict(
      { passed: 4, total: MIN_ROLE_CASES },
      { passed: 4, total: MIN_ROLE_CASES },
    );
    expect(result.verdict).toBe('allow');
  });

  it('overlay 通过率更低 → reject', () => {
    const result = roleRegressionVerdict({ passed: 5, total: MIN_ROLE_CASES }, { passed: 3, total: MIN_ROLE_CASES });
    expect(result.verdict).toBe('reject');
    expect(result.reason).toContain('回归');
  });

  it('自定义阈值生效（用于小样本 dry-run）', () => {
    const result = roleRegressionVerdict({ passed: 2, total: 2 }, { passed: 2, total: 2 }, 2);
    expect(result.verdict).toBe('allow');
  });
});

describe('roleSideScore / rolePassRate', () => {
  it('按 passed 计数；空集通过率为 0（不除零）', () => {
    const grades = [
      { id: 'a', passed: true, failures: [] },
      { id: 'b', passed: false, failures: ['must 缺失: x'] },
      { id: 'c', passed: true, failures: [] },
    ];
    expect(roleSideScore(grades)).toEqual({ passed: 2, total: 3 });
    expect(rolePassRate(roleSideScore(grades))).toBeCloseTo(2 / 3);
    expect(rolePassRate({ passed: 0, total: 0 })).toBe(0);
  });
});
