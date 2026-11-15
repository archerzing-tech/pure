#!/usr/bin/env bun
// scripts/sync-default-agents-md.ts
// 产品默认 AGENTS.md 的单一来源是 templates/default-agents.md，由本脚本派生两份生成物：
//   - src/shared/defaultAgentsMd.ts  内置默认（CLI/GUI 首次运行时 seed ~/.pure/AGENTS.md）
//   - src-tauri/AGENTS.md            打包资源（GUI 从 resourceDir 读的那份）
// 根 AGENTS.md 是**本仓库的开发约定**，不参与默认值——否则仓库规则会泄漏成所有用户的全局默认。
// 改过模板就必须跑一次，否则 `bun test` 里的 parity 断言会红。
//
// 用法：bun run agents:sync

import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url).pathname;
const TEMPLATE = `${ROOT}templates/default-agents.md`;
const OUT_TS = `${ROOT}src/shared/defaultAgentsMd.ts`;
const OUT_TAURI = `${ROOT}src-tauri/AGENTS.md`;

// 三侧都 trim：行尾/末尾换行的差异不该被当成内容变更。
const content = readFileSync(TEMPLATE, 'utf8').trim();
const b64 = Buffer.from(content, 'utf8').toString('base64');

const file = `// Baked-in baseline default AGENTS.md for the standalone CLI.
//
// Pure seeds \`~/.pure/AGENTS.md\` from this constant on first run so the global
// install works even when launched from a directory that ships no AGENTS.md.
// Generated from templates/default-agents.md — run \`bun run agents:sync\`;
// \`bun test\` asserts parity with the template. Do not hand-edit the project
// root AGENTS.md as a source for this: that file is this repo's own dev
// conventions, not the product default.
const B64 = "${b64}";
export const DEFAULT_AGENTS_MD: string = Buffer.from(B64, "base64").toString("utf8");
`;

writeFileSync(OUT_TS, file, 'utf8');
writeFileSync(OUT_TAURI, content + '\n', 'utf8');
console.log(
  `Wrote ${OUT_TS} (${content.length} chars → ${b64.length} base64) and ${OUT_TAURI}`,
);
