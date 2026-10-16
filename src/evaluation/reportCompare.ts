// src/evaluation/reportCompare.ts
// B1 ——「这次改动让 agent 变好还是变坏」的读数。
//
// 进化系统已经能改自己（技能 / 角色 / overlay / 工具），但此前没有任何一处能把
// 「改之前」与「改之后」的两份评测报告摆在一起做逐题对比：基线是发布时人工重测
// 的，一次提示词/路由/产物的改动是否让 agent 退化，构建不会红。本模块把这件事
// 做成**纯函数**——两份套件报告进，逐题去向（修复 / 退步 / 未变 / 新增 / 消失）
// ＋聚合指标增减 ＋一个结论出。零 IO，因此可单测、可被任意宿主调用。
//
// 立场（与焊接计划红线、README 的「control 不是成绩」逐条对齐）：
//   - **默认不阻断**：这里产出的是读数不是门。要当门用（`--strict`）只认一条
//     ——有退步且无修复；不设数值阈值，阈值要么有真实数据支撑，要么先不要。
//   - **不可比就不比**：套件版本、夹具指纹、留出标记三者任一不同，两份数字说的
//     就不是同一件事——如实报「不可比」，而不是硬比出一个假结论。
//   - 只读报告里的状态与元数据，不碰源码、提示词、命令行——与报告本身的纪律同款。

import type { CodingTaskResult, CodingTaskStatus, CodingTaskSuiteReport } from './codingTaskBaseline';

export type TaskChange = 'fixed' | 'regressed' | 'unchanged' | 'appeared' | 'missing';

export type ComparisonVerdict = 'improved' | 'regressed' | 'mixed' | 'unchanged' | 'incomparable';

export interface TaskDelta {
  taskId: string;
  category: string;
  difficulty: string;
  change: TaskChange;
  baselineStatus?: CodingTaskStatus;
  candidateStatus?: CodingTaskStatus;
}

export interface MetricDelta {
  baseline: number;
  candidate: number;
  /** candidate − baseline；耗时/成本增大为正（即“变贵了”）。 */
  delta: number;
}

export interface ReportComparison {
  comparable: boolean;
  /** 不可比的原因（空数组 = 可比）。每条都能独立读懂。 */
  reasons: string[];
  /** 可比、但口径变了（provider / model / prompt 版本 / revision）——不影响逐题
   *  对比，但读者必须知道自己在比什么。 */
  metadataChanges: string[];
  verdict: ComparisonVerdict;
  /** 全量逐题去向（含 unchanged），顺序 = 基线出现序在前、候选独有者在后。 */
  tasks: TaskDelta[];
  regressions: TaskDelta[];
  fixes: TaskDelta[];
  appeared: TaskDelta[];
  missing: TaskDelta[];
  metrics: {
    taskCount: MetricDelta;
    passAt1: MetricDelta;
    successRate: MetricDelta;
    meanScore: MetricDelta;
    meanDurationMs: MetricDelta;
    estimatedCostUsd: MetricDelta;
  };
}

/** 报告里的数字字段可能是坏的（旧报告 / 手改）——坏值当 0，不做猜测。 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function metricDelta(baseline: unknown, candidate: unknown): MetricDelta {
  const from = num(baseline);
  const to = num(candidate);
  return { baseline: from, candidate: to, delta: to - from };
}

/** 逐题「这次算过」的唯一口径：passAt1。control / agent_error / fixture_error 都是 false。 */
function passed(task: CodingTaskResult): boolean {
  return task.passAt1 === true;
}

function taskIndex(report: CodingTaskSuiteReport): Map<string, CodingTaskResult> {
  const index = new Map<string, CodingTaskResult>();
  for (const task of report.tasks ?? []) {
    // 同 id 撞车保留第一条：报告不该有重复，有也不该在这里编造合并语义。
    if (!index.has(task.taskId)) index.set(task.taskId, task);
  }
  return index;
}

/**
 * control 运行 = 没有 agent 介入的那次（README：它该在每题拿 0，是夹具自检，
 * 不是 agent 成绩）。识别口径：没有 provider 元数据，或所有题都停在 `control`。
 * 用来防止「控制组 vs agent」被读成一次质量变化。
 */
export function isControlRun(report: CodingTaskSuiteReport): boolean {
  if (!report.metadata?.provider) return true;
  const tasks = report.tasks ?? [];
  return tasks.length > 0 && tasks.every((task) => task.status === 'control');
}

function comparabilityReasons(baseline: CodingTaskSuiteReport, candidate: CodingTaskSuiteReport): string[] {
  const reasons: string[] = [];
  if (baseline.suiteVersion !== candidate.suiteVersion) {
    reasons.push(`套件版本不同：${baseline.suiteVersion} vs ${candidate.suiteVersion}`);
  }
  if (baseline.fixtureHash !== candidate.fixtureHash) {
    reasons.push(`夹具指纹不同：${baseline.fixtureHash} vs ${candidate.fixtureHash}——题目集变了，逐题对比没有意义`);
  }
  const baselineHeld = baseline.metadata?.heldOut === true;
  const candidateHeld = candidate.metadata?.heldOut === true;
  if (baselineHeld !== candidateHeld) {
    reasons.push(`一边是留出集一边是调优集（heldOut ${baselineHeld} vs ${candidateHeld}）——两套题目不可比`);
  }
  return reasons;
}

function metadataChanges(baseline: CodingTaskSuiteReport, candidate: CodingTaskSuiteReport): string[] {
  const out: string[] = [];
  const fields: Array<[string, string, string]> = [
    ['provider', baseline.metadata?.provider ?? '', candidate.metadata?.provider ?? ''],
    ['model', baseline.metadata?.model ?? '', candidate.metadata?.model ?? ''],
    ['promptVersion', baseline.metadata?.promptVersion ?? '', candidate.metadata?.promptVersion ?? ''],
    ['gitRevision', baseline.metadata?.gitRevision ?? '', candidate.metadata?.gitRevision ?? ''],
  ];
  for (const [name, before, after] of fields) {
    if (before !== after) out.push(`${name}: ${before || '(空)'} → ${after || '(空)'}`);
  }
  const baselineControl = isControlRun(baseline);
  const candidateControl = isControlRun(candidate);
  if (baselineControl && !candidateControl) {
    out.push('基线是 control 运行（无 provider）——它测的是夹具/验证链路，不是 agent 质量；delta 主要反映「有没有 agent」');
  } else if (!baselineControl && candidateControl) {
    out.push('候选是 control 运行（无 provider）——同上，delta 不可当作 agent 退化');
  }
  return out;
}

/**
 * 两份套件报告 → 一份对比结论。纯函数，无副作用；候选相对基线。
 */
export function compareSuiteReports(
  baseline: CodingTaskSuiteReport,
  candidate: CodingTaskSuiteReport,
): ReportComparison {
  const reasons = comparabilityReasons(baseline, candidate);
  const comparable = reasons.length === 0;

  const left = taskIndex(baseline);
  const right = taskIndex(candidate);
  const ids: string[] = [...left.keys()];
  for (const id of right.keys()) if (!left.has(id)) ids.push(id);

  const tasks: TaskDelta[] = [];
  for (const id of ids) {
    const before = left.get(id);
    const after = right.get(id);
    if (before && after) {
      const wasPassing = passed(before);
      const nowPassing = passed(after);
      tasks.push({
        taskId: id,
        category: after.category,
        difficulty: after.difficulty,
        change: wasPassing === nowPassing ? 'unchanged' : nowPassing ? 'fixed' : 'regressed',
        baselineStatus: before.status,
        candidateStatus: after.status,
      });
    } else if (after) {
      tasks.push({ taskId: id, category: after.category, difficulty: after.difficulty, change: 'appeared', candidateStatus: after.status });
    } else if (before) {
      tasks.push({ taskId: id, category: before.category, difficulty: before.difficulty, change: 'missing', baselineStatus: before.status });
    }
  }

  const regressions = tasks.filter((task) => task.change === 'regressed');
  const fixes = tasks.filter((task) => task.change === 'fixed');
  const appeared = tasks.filter((task) => task.change === 'appeared');
  const missing = tasks.filter((task) => task.change === 'missing');

  const verdict: ComparisonVerdict = !comparable
    ? 'incomparable'
    : regressions.length > 0 && fixes.length === 0
      ? 'regressed'
      : fixes.length > 0 && regressions.length === 0
        ? 'improved'
        : regressions.length > 0 && fixes.length > 0
          ? 'mixed'
          : 'unchanged';

  return {
    comparable,
    reasons,
    metadataChanges: metadataChanges(baseline, candidate),
    verdict,
    tasks,
    regressions,
    fixes,
    appeared,
    missing,
    metrics: {
      taskCount: metricDelta(baseline.taskCount, candidate.taskCount),
      passAt1: metricDelta(baseline.passAt1, candidate.passAt1),
      successRate: metricDelta(baseline.successRate, candidate.successRate),
      meanScore: metricDelta(baseline.meanScore, candidate.meanScore),
      meanDurationMs: metricDelta(baseline.meanDurationMs, candidate.meanDurationMs),
      estimatedCostUsd: metricDelta(baseline.estimatedCostUsd, candidate.estimatedCostUsd),
    },
  };
}
