// src/evaluation/roleRegressionRun.ts
// 北极星第 6 步 13.3（part 3）— A/B 编排核心（无 node/tauri 依赖，runCase 注入）。
//
// part 2 把 A/B 跑在 CLI 脚本里（SubagentOrchestrator + NodeToolAdapter）。part 3
// 的落盘门槛要在 GUI 里也跑同一套 A/B，所以把"两侧 × N 例 → 判卷 → 裁决"的编排
// 抽到这里，只依赖纯函数（roleRegression.ts），把"怎么跑一例"注入进来：
//   - CLI 注入 NodeToolAdapter + SubagentOrchestrator；
//   - GUI 注入 TauriToolAdapter + SubagentOrchestrator。
// 宿主差异止于 runCase，判卷与裁决只有一份定义。

import {
  gradeRoleCase,
  MIN_ROLE_CASES,
  roleRegressionVerdict,
  roleSideScore,
  type RoleCaseFixture,
  type RoleCaseGrade,
  type RoleRegressionVerdict,
  type RoleSideScore,
} from './roleRegression';

export type RoleRegressionSide = 'base' | 'overlay';

/** Run ONE case under one side and return the subagent's final output text.
 *  `overlay` is undefined for the base side. */
export type RunRoleCase = (fixture: RoleCaseFixture, overlay: string | undefined) => Promise<string>;

export interface RoleRegressionResult {
  role: string;
  base: RoleSideScore;
  overlay: RoleSideScore;
  verdict: RoleRegressionVerdict;
  reason: string;
  grades: { base: RoleCaseGrade[]; overlay: RoleCaseGrade[] };
}

export interface RunRoleRegressionOptions {
  role: string;
  fixtures: readonly RoleCaseFixture[];
  /** The drafted overlay text under test (base side runs without it). */
  overlay: string;
  runCase: RunRoleCase;
  /** Reports each graded case as it completes (progress UI in the GUI). */
  onCase?: (side: RoleRegressionSide, grade: RoleCaseGrade) => void;
  minCases?: number;
}

/** Base and overlay each run the SAME fixtures; a side that produced no output
 *  (crash / timeout) fails every `must` by construction and counts as failed. */
export async function runRoleRegressionAB(options: RunRoleRegressionOptions): Promise<RoleRegressionResult> {
  const baseGrades: RoleCaseGrade[] = [];
  const overlayGrades: RoleCaseGrade[] = [];
  for (const fixture of options.fixtures) {
    const baseGrade = gradeRoleCase(await options.runCase(fixture, undefined), fixture);
    baseGrades.push(baseGrade);
    options.onCase?.('base', baseGrade);
    const overlayGrade = gradeRoleCase(await options.runCase(fixture, options.overlay), fixture);
    overlayGrades.push(overlayGrade);
    options.onCase?.('overlay', overlayGrade);
  }
  const base = roleSideScore(baseGrades);
  const overlay = roleSideScore(overlayGrades);
  const { verdict, reason } = roleRegressionVerdict(base, overlay, options.minCases ?? MIN_ROLE_CASES);
  return { role: options.role, base, overlay, verdict, reason, grades: { base: baseGrades, overlay: overlayGrades } };
}
