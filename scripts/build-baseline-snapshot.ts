#!/usr/bin/env bun
// scripts/build-baseline-snapshot.ts
// 把 evals/ 下的真实 provider 报告折成仪表盘用的快照模块：
//
//   1. 只收**当前套件**的报告（suiteVersion 与 fixtureHash 都对得上）——旧套件的
//      数字与新套件不可比，混在一起会给出错误结论；被排除的报告如实列在
//      excluded 里，页面会说明为什么；
//   2. 产出 src/shared/baselineSnapshotData.ts（提交进仓库），所以设置页在浏览器
//      模式下也能显示发布口径的成绩——不需要读文件系统、不依赖 Tauri。
//
// 用法：bun run eval:snapshot

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASELINE_SUITE_VERSION, type BaselineProviderRow, type BaselineSnapshot } from '../src/shared/baseline';
import { codingTaskFixtureHash } from '../src/evaluation/codingTaskBaseline';

const EVALS_DIR = 'evals';
const OUT_PATH = 'src/shared/baselineSnapshotData.ts';

interface RawReport {
  suiteVersion?: unknown;
  fixtureHash?: unknown;
  metadata?: { provider?: unknown; model?: unknown; gitRevision?: unknown };
  taskCount?: unknown;
  passAt1?: unknown;
  meanDurationMs?: unknown;
  estimatedCostUsd?: unknown;
  totalUsage?: { promptTokens?: unknown; cacheHitTokens?: unknown };
  tasks?: unknown;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const rows: BaselineProviderRow[] = [];
const excluded: BaselineSnapshot['excluded'] = [];

for (const name of readdirSync(EVALS_DIR).filter((entry) => entry.endsWith('.json')).sort()) {
  const reportPath = `evals/${name}`;
  let report: RawReport;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8')) as RawReport;
  } catch {
    excluded.push({ report: reportPath, suiteVersion: 'unreadable' });
    continue;
  }
  // 只认套件报告：其它 JSON（记忆对照、临时产物）没有 suiteVersion + tasks。
  if (typeof report.suiteVersion !== 'string' || !Array.isArray(report.tasks)) continue;
  if (report.suiteVersion !== BASELINE_SUITE_VERSION) {
    excluded.push({ report: reportPath, suiteVersion: report.suiteVersion });
    continue;
  }
  rows.push({
    provider: str(report.metadata?.provider) || 'unknown',
    model: str(report.metadata?.model),
    gitRevision: str(report.metadata?.gitRevision) || '(uncommitted)',
    passAt1: num(report.passAt1),
    taskCount: num(report.taskCount),
    meanDurationMs: num(report.meanDurationMs),
    estimatedCostUsd: num(report.estimatedCostUsd),
    promptTokens: num(report.totalUsage?.promptTokens),
    cacheHitTokens: num(report.totalUsage?.cacheHitTokens),
    report: reportPath,
  });
}

// 便宜的在最前：一眼看出哪个模型/网关更省。
rows.sort((a, b) => a.estimatedCostUsd - b.estimatedCostUsd || a.provider.localeCompare(b.provider));

const snapshot: BaselineSnapshot = {
  suiteVersion: BASELINE_SUITE_VERSION,
  fixtureHash: codingTaskFixtureHash(),
  generatedAt: new Date().toISOString(),
  rows,
  excluded,
};

const header = `// src/shared/baselineSnapshotData.ts
// 由 \`bun run eval:snapshot\` 生成，不要手改。
// 数据源：evals/ 下与套件 ${BASELINE_SUITE_VERSION} 匹配的真实 provider 报告。
// 重新生成：跑完 \`bun run eval:baseline -- --agent <provider> --report evals/<name>.json\`
// 之后执行 \`bun run eval:snapshot\`（发布流程的一部分，见 evals/BASELINE.md）。

import type { BaselineSnapshot } from './baseline';

`;

writeFileSync(OUT_PATH, `${header}export const BASELINE_SNAPSHOT: BaselineSnapshot = ${JSON.stringify(snapshot, null, 2)};\n`, 'utf8');

console.log(`Wrote ${OUT_PATH}`);
console.log(`  ${rows.length} row(s) for ${BASELINE_SUITE_VERSION} (fixtureHash ${snapshot.fixtureHash})`);
for (const row of rows) {
  console.log(`  - ${row.provider}/${row.model} ${row.passAt1}/${row.taskCount} @ ${row.gitRevision} ($${row.estimatedCostUsd.toFixed(4)})`);
}
if (excluded.length > 0) {
  console.log(`  excluded ${excluded.length} report(s) from other suites:`);
  for (const entry of excluded) console.log(`  - ${entry.report} (${entry.suiteVersion})`);
}
