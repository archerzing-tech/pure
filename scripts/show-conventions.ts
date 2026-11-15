#!/usr/bin/env bun
// scripts/show-conventions.ts
// 打印 AGENTS.md 三层合并的来龙去脉：每层从哪来、多少节、哪些节被谁覆盖、
// 哪些节是子层新加的；以及默认约定的版本与用户文件的 seed 基线版本
// （v 号不一致说明升级逻辑会动到未被用户改过的节）。
// 加载逻辑与运行时同源（conventions.ts），所以这里的输出就是模型实际收到
// 的那份约定的来源账。
//
// 用法：
//   bun run agents:show               # 当前目录 + ~/.pure
//   bun run agents:show --workspace X # 指定工作区
//   bun run agents:show --json        # 机器可读

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  defaultVersionOf,
  formatConventionsDiagnostics,
  loadMergedConventionsWithDiagnostics,
  parseSeedState,
} from '../src/shared/conventions';
import { DEFAULT_AGENTS_MD } from '../src/shared/defaultAgentsMd';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const wsFlag = argv.indexOf('--workspace');
const workspace = wsFlag >= 0 ? argv[wsFlag + 1] : process.cwd();
const globalRoot = join(homedir(), '.pure');

const merged = await loadMergedConventionsWithDiagnostics({
  appText: DEFAULT_AGENTS_MD,
  globalUserRoot: globalRoot,
  userSpaceRoot: workspace,
});

const defaultVersion = defaultVersionOf(DEFAULT_AGENTS_MD);
let seedRaw: string | null = null;
try {
  seedRaw = readFileSync(join(globalRoot, 'AGENTS.default.json'), 'utf8');
} catch {
  /* no baseline yet — first run seeds it */
}
const seed = parseSeedState(seedRaw);

if (json) {
  console.log(
    JSON.stringify(
      { defaultVersion, seedVersion: seed?.version ?? null, ...merged.diagnostics },
      null,
      2,
    ),
  );
} else {
  console.log(formatConventionsDiagnostics(merged.diagnostics));
  const seedLine = seed
    ? `默认约定 v${defaultVersion}，用户文件基线 v${seed.version}（${seed.version === defaultVersion ? '已同步' : '下次启动会升级未被改过的节'}）`
    : `默认约定 v${defaultVersion}，用户文件无基线（首次 seed 时建立）`;
  console.log(`  ${seedLine}`);
}
