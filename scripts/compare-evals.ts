#!/usr/bin/env bun
// scripts/compare-evals.ts
// B1 —— 把两份套件报告摆在一起看出「这次改动让 agent 变好还是变坏」。
//
// 用法：
//   bun run eval:compare -- --baseline evals/glm-5.3-flash.v5.json --candidate evals/model.latest.json
//   ... [--json <out.json>] [--strict]
//
// 退出码（**默认不阻断**是全部设计意图所在）：
//   0  正常出数（含「退步」——读数不是门）
//   1  仅当 --strict 且结论是「退步」（有退步、无修复）
//   2  用法错误 / 报告读不出 / 两份不可比（比不出结论就不给假结论）
//
// 逻辑全在 src/evaluation/reportCompare.ts（纯函数、有单测）；本脚本只做读文件、
// 排版与退出码。想把它接成 CI 的一道门时，先别急着改这里——按焊接计划红线，
// 阈值要有真实数据支撑再谈。

import { readFileSync, writeFileSync } from 'node:fs';
import type { CodingTaskSuiteReport } from '../src/evaluation/codingTaskBaseline';
import { compareSuiteReports, type ComparisonVerdict, type MetricDelta, type TaskDelta } from '../src/evaluation/reportCompare';

const argv = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

const baselinePath = flagValue('--baseline');
const candidatePath = flagValue('--candidate');
const jsonOut = flagValue('--json');
const strict = argv.includes('--strict');

if (!baselinePath || !candidatePath) {
  console.error('Usage: bun run eval:compare -- --baseline <report.json> --candidate <report.json> [--json <out.json>] [--strict]');
  process.exit(2);
}

function loadReport(path: string): CodingTaskSuiteReport {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`读不到报告 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`报告 ${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  // 只要能认出「这是套件报告」就行（suiteVersion + tasks 数组）；形状再往下由纯核
  // 逐字段容错，不在这里为一份坏报告编造默认值。
  const shape = parsed as Partial<CodingTaskSuiteReport> | null;
  if (!shape || typeof shape.suiteVersion !== 'string' || !Array.isArray(shape.tasks)) {
    throw new Error(`报告 ${path} 不是套件报告（缺 suiteVersion / tasks）——eval:compare 只比套件报告`);
  }
  return parsed as CodingTaskSuiteReport;
}

const VERDICT_TEXT: Record<ComparisonVerdict, string> = {
  improved: '改善',
  regressed: '退步',
  mixed: '有增有减',
  unchanged: '无变化',
  incomparable: '不可比',
};

function fmtDelta(delta: number, digits: number): string {
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(digits)}`;
}

function metricLine(label: string, delta: MetricDelta, digits: number): string {
  return `  ${label.padEnd(14)} ${delta.baseline.toFixed(digits)} → ${delta.candidate.toFixed(digits)}  (${fmtDelta(delta.delta, digits)})`;
}

function describeRun(report: CodingTaskSuiteReport, path: string): string {
  const provider = report.metadata?.provider || '(control)';
  const model = report.metadata?.model ? `/${report.metadata.model}` : '';
  const revision = report.metadata?.gitRevision || '(uncommitted)';
  const held = report.metadata?.heldOut === true ? '[留出集] ' : '';
  return `${path}\n      ${held}${report.suiteVersion} ${provider}${model} @ ${revision} — ${report.passAt1}/${report.taskCount}`;
}

function renderTask(delta: TaskDelta): string {
  const from = delta.baselineStatus ?? '—';
  const to = delta.candidateStatus ?? '—';
  return `    - ${delta.taskId} (${delta.category}/${delta.difficulty}): ${from} → ${to}`;
}

let baseline: CodingTaskSuiteReport;
let candidate: CodingTaskSuiteReport;
try {
  baseline = loadReport(baselinePath);
  candidate = loadReport(candidatePath);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const comparison = compareSuiteReports(baseline, candidate);

const lines: string[] = [];
lines.push('评测报告对比（候选相对基线）');
lines.push(`  基线  : ${describeRun(baseline, baselinePath)}`);
lines.push(`  候选  : ${describeRun(candidate, candidatePath)}`);
if (comparison.comparable) {
  lines.push(`  可比  : 是（套件 ${baseline.suiteVersion}，指纹 ${baseline.fixtureHash}）`);
} else {
  lines.push('  可比  : 否');
  for (const reason of comparison.reasons) lines.push(`    ✗ ${reason}`);
}
for (const note of comparison.metadataChanges) lines.push(`  口径变化: ${note}`);
lines.push('');
lines.push(metricLine('pass@1', comparison.metrics.passAt1, 0));
lines.push(metricLine('successRate', comparison.metrics.successRate, 3));
lines.push(metricLine('meanScore', comparison.metrics.meanScore, 3));
lines.push(metricLine('meanDurationMs', comparison.metrics.meanDurationMs, 0));
lines.push(metricLine('costUsd', comparison.metrics.estimatedCostUsd, 4));
lines.push('');
lines.push(`  退步 (${comparison.regressions.length}):`);
for (const delta of comparison.regressions) lines.push(renderTask(delta));
lines.push(`  修复 (${comparison.fixes.length}):`);
for (const delta of comparison.fixes) lines.push(renderTask(delta));
// 新增/消失：夹具指纹相同时这两栏该恒空；非空说明两份报告的题目集其实对不上，
// 不能沉默——它是「你以为在同一套题上比，其实不是」的唯一信号。
if (comparison.appeared.length > 0) {
  lines.push(`  新增 (${comparison.appeared.length}):`);
  for (const delta of comparison.appeared) lines.push(renderTask(delta));
}
if (comparison.missing.length > 0) {
  lines.push(`  消失 (${comparison.missing.length}):`);
  for (const delta of comparison.missing) lines.push(renderTask(delta));
}
lines.push('');
lines.push(`  结论: ${VERDICT_TEXT[comparison.verdict]}`);
console.log(lines.join('\n'));

if (jsonOut) {
  writeFileSync(
    jsonOut,
    `${JSON.stringify({ baseline: baselinePath, candidate: candidatePath, comparedAt: new Date().toISOString(), comparison }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\nJSON → ${jsonOut}`);
}

if (!comparison.comparable) process.exit(2);
if (strict && comparison.verdict === 'regressed') {
  console.error('\n--strict：有退步且无修复。');
  process.exit(1);
}
