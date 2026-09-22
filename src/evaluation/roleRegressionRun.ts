// src/evaluation/roleRegressionRun.ts
// 北极星第 6 步 13.3（part 3）— A/B 编排核心（无 node/tauri 依赖，runCase 注入）。
//
// part 2 把 A/B 跑在 CLI 脚本里（SubagentOrchestrator + NodeToolAdapter）。part 3
// 的落盘门槛要在 GUI 里也跑同一套 A/B，所以把"两侧 × N 例 → 判卷 → 裁决"的编排
// 抽到这里，只依赖纯函数（roleRegression.ts），把"怎么跑一例"注入进来：
//   - CLI 注入 NodeToolAdapter + SubagentOrchestrator；
//   - GUI 注入 TauriToolAdapter + SubagentOrchestrator。
// 宿主差异止于 runCase，判卷与裁决只有一份定义。
//
// 三条护栏（2026-09-22 审查补）：① 样本数**硬上限** MAX_AB_CASES（一次点击最多
// 2×N 次真实子 agent 运行）；② `signal` 在每例前后检查，可取消（抛 AbortError）；
// ③ 运行失败（崩溃/超时/空产出）**重试**，不混同于断言失败——否则一次 provider
// 抖动就能把 ALLOW 翻成假 REJECT。

import {
  gradeRoleCase,
  isRunFailureOutput,
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

/** Hard cap on cases per side per A/B — a Settings click must not launch an
 *  unbounded number of real subagent runs. */
export const MAX_AB_CASES = 8;
/** Attempts per case (1 = no retry). A run failure retries; a graded miss does not. */
export const AB_MAX_ATTEMPTS = 2;

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
  /** Cap on cases per side (defaults to MAX_AB_CASES; never above it). */
  maxCases?: number;
  /** Attempts per case (defaults to AB_MAX_ATTEMPTS). */
  maxAttempts?: number;
  /** Cooperative cancellation, checked before each case and each side. */
  signal?: AbortSignal;
}

function abortError(): Error {
  const err = new Error('role A/B aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Run one case, retrying only when the run itself failed (never on a graded
 *  miss — that is the signal we are measuring). */
async function runCaseWithRetry(
  options: RunRoleRegressionOptions,
  fixture: RoleCaseFixture,
  overlay: string | undefined,
  attempts: number,
): Promise<string> {
  let output = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfAborted(options.signal);
    output = await options.runCase(fixture, overlay);
    if (!isRunFailureOutput(output) || attempt === attempts) return output;
  }
  return output;
}

/** Base and overlay each run the SAME fixtures; a side that produced no output
 *  (crash / timeout) fails every `must` by construction and counts as failed —
 *  after a bounded retry so transient failures do not read as regressions. */
export async function runRoleRegressionAB(options: RunRoleRegressionOptions): Promise<RoleRegressionResult> {
  const maxCases = Math.max(0, Math.min(options.maxCases ?? MAX_AB_CASES, MAX_AB_CASES));
  const attempts = Math.max(1, options.maxAttempts ?? AB_MAX_ATTEMPTS);
  const fixtures = options.fixtures.slice(0, maxCases);

  const baseGrades: RoleCaseGrade[] = [];
  const overlayGrades: RoleCaseGrade[] = [];
  for (const fixture of fixtures) {
    throwIfAborted(options.signal);
    const baseGrade = gradeRoleCase(await runCaseWithRetry(options, fixture, undefined, attempts), fixture);
    baseGrades.push(baseGrade);
    options.onCase?.('base', baseGrade);
    const overlayGrade = gradeRoleCase(await runCaseWithRetry(options, fixture, options.overlay, attempts), fixture);
    overlayGrades.push(overlayGrade);
    options.onCase?.('overlay', overlayGrade);
  }
  const base = roleSideScore(baseGrades);
  const overlay = roleSideScore(overlayGrades);
  const { verdict, reason } = roleRegressionVerdict(base, overlay, options.minCases ?? MIN_ROLE_CASES);
  return { role: options.role, base, overlay, verdict, reason, grades: { base: baseGrades, overlay: overlayGrades } };
}
