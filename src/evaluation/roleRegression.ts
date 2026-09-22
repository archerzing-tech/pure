// src/evaluation/roleRegression.ts
// 北极星第 6 步 13.3（part 2）— 角色级回归集 + A/B 准入门槛。
// persona overlay 改的是子 agent 的 system prompt，产出是文本，v5 基线那套
// 命令验证（VerificationCommand）套不上；这里用内容断言（must / mustNot）
// 判卷。A/B 裁决：overlay 通过率 ≥ base 通过率（不输）→ ALLOW；任一侧样本
// 不足（< MIN_ROLE_CASES）→ DENY —— 对应验收口径"overlay 仅在有 A/B 数据
// 支撑时落盘"。本模块是纯函数，无 IO：fixture 读取与编排器驱动在
// scripts/run-role-regression.ts。

import type { ToolResult } from '../shared/types';

/** One regression case for one role. `args` mirrors a real delegation's
 *  arguments verbatim (each role has its own input_schema — prompt vs task
 *  vs topic), so fixtures collected from 历史真实派发 drop in unchanged. */
export interface RoleCaseFixture {
  id: string;
  /** Human-readable note on what this case probes — never sent to the model. */
  description?: string;
  /** Delegation arguments exactly as the parent agent would pass them. */
  args: Record<string, unknown>;
  /** Substrings that must appear in the subagent's final output
   *  (compared case-insensitively with whitespace collapsed). */
  must: string[];
  /** Substrings that must NOT appear in the output. */
  mustNot?: string[];
}

export interface RoleCaseGrade {
  id: string;
  passed: boolean;
  /** Human-readable reason per failed assertion (empty when passed). */
  failures: string[];
}

export type RoleRegressionVerdict = 'allow' | 'reject' | 'deny_insufficient_data';

/** Minimum cases per side before its pass rate means anything. Below this
 *  the gate denies — a 2/2 overlay would "not lose" by luck. */
export const MIN_ROLE_CASES = 5;

export interface RoleSideScore {
  passed: number;
  total: number;
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Grade one output against one fixture's content assertions. A run that
 *  produced no output (crash, timeout) fails every must by construction. */
export function gradeRoleCase(output: string, fixture: RoleCaseFixture): RoleCaseGrade {
  const haystack = normalize(output);
  const failures: string[] = [];
  for (const needle of fixture.must) {
    if (!haystack.includes(normalize(needle))) failures.push(`must 缺失: ${needle}`);
  }
  for (const needle of fixture.mustNot ?? []) {
    if (haystack.includes(normalize(needle))) failures.push(`mustNot 出现: ${needle}`);
  }
  return { id: fixture.id, passed: failures.length === 0, failures };
}

/** Pass rate of one side; 0 when there are no cases (never divide by zero). */
export function rolePassRate(side: RoleSideScore): number {
  return side.total > 0 ? side.passed / side.total : 0;
}

/** The A/B gate behind "overlay 仅在有 A/B 数据支撑时落盘": allow only when
 *  the overlaid persona does not regress the base one on the same cases. */
export function roleRegressionVerdict(
  base: RoleSideScore,
  overlay: RoleSideScore,
  minCases: number = MIN_ROLE_CASES,
): { verdict: RoleRegressionVerdict; reason: string } {
  if (base.total < minCases || overlay.total < minCases) {
    return {
      verdict: 'deny_insufficient_data',
      reason: `样本不足（base ${base.total}/${minCases}，overlay ${overlay.total}/${minCases}）— overlay 不落盘`,
    };
  }
  const pct = (rate: number): string => `${(rate * 100).toFixed(0)}%`;
  const overlayRate = rolePassRate(overlay);
  const baseRate = rolePassRate(base);
  if (overlayRate >= baseRate) {
    return {
      verdict: 'allow',
      reason: `overlay 通过率 ${pct(overlayRate)} ≥ base ${pct(baseRate)}（不输）`,
    };
  }
  return {
    verdict: 'reject',
    reason: `overlay 通过率 ${pct(overlayRate)} < base ${pct(baseRate)} — 角色回归`,
  };
}

/** Pull the subagent's final text out of a delegation ToolResult. A failed
 *  delegation (crash / timeout / budget) yields whatever text exists, or a
 *  visible RUN_FAILED marker so it grades as a failed case instead of an empty
 *  string. Shared by the A/B runner and the sample harvest script. */
export function extractSubagentOutput(result: ToolResult): string {
  const payload = result.result as { output?: unknown; finalOutput?: unknown } | undefined;
  if (typeof payload?.output === 'string' && payload.output.trim()) return payload.output;
  if (typeof payload?.finalOutput === 'string' && payload.finalOutput.trim()) return payload.finalOutput;
  return result.error ? `[RUN_FAILED] ${result.error}` : '';
}

/** Does an output indicate the RUN failed (crash / timeout / budget) rather
 *  than the assertions failing? `extractSubagentOutput` emits the [RUN_FAILED]
 *  marker; a blank output means the delegation produced nothing. The A/B
 *  retries these instead of counting a transient provider hiccup as a
 *  regression — otherwise a single stall can flip ALLOW into a false REJECT. */
export function isRunFailureOutput(output: string): boolean {
  const trimmed = output.trim();
  return trimmed.length === 0 || trimmed.startsWith('[RUN_FAILED]');
}

/** Tally graded cases into a side score (kept next to the verdict so the
 *  runner and future reflector share one definition of "通过率"). */
export function roleSideScore(grades: RoleCaseGrade[]): RoleSideScore {
  return { passed: grades.filter((g) => g.passed).length, total: grades.length };
}
