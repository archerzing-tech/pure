#!/usr/bin/env bun
// scripts/show-conventions.ts
// 打印 AGENTS.md 三层合并的来龙去脉：每层从哪来、多少节、哪些节被谁覆盖、
// 哪些节是子层新加的。加载逻辑与运行时同源（conventions.ts），所以这里的
// 输出就是模型实际收到的那份约定的来源账。
//
// 用法：
//   bun run agents:show               # 当前目录 + ~/.pure
//   bun run agents:show --workspace X # 指定工作区
//   bun run agents:show --json        # 机器可读

import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatConventionsDiagnostics, loadMergedConventionsWithDiagnostics } from '../src/shared/conventions';
import { DEFAULT_AGENTS_MD } from '../src/shared/defaultAgentsMd';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const wsFlag = argv.indexOf('--workspace');
const workspace = wsFlag >= 0 ? argv[wsFlag + 1] : process.cwd();

const merged = await loadMergedConventionsWithDiagnostics({
  appText: DEFAULT_AGENTS_MD,
  globalUserRoot: join(homedir(), '.pure'),
  userSpaceRoot: workspace,
});

if (json) {
  console.log(JSON.stringify(merged.diagnostics, null, 2));
} else {
  console.log(formatConventionsDiagnostics(merged.diagnostics));
}
