#!/usr/bin/env bun
// scripts/sync-default-agents-md.ts
// 把项目根 AGENTS.md 折回 src/shared/defaultAgentsMd.ts（CLI 首次运行时给
// ~/.pure/AGENTS.md 用的内置默认）。改过 AGENTS.md 就必须跑一次，
// 否则 `bun test` 里的 DEFAULT_AGENTS_MD parity 断言会红。
//
// 用法：bun run agents:sync

import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url).pathname;
const OUT_PATH = 'src/shared/defaultAgentsMd.ts';

// 两侧都 trim：行尾/末尾换行的差异不该被当成内容变更。
const content = readFileSync(`${ROOT}AGENTS.md`, 'utf8').trim();
const b64 = Buffer.from(content, 'utf8').toString('base64');

const file = `// Baked-in baseline default AGENTS.md for the standalone CLI.
//
// Pure seeds \`~/.pure/AGENTS.md\` from this constant on first run so the global
// install works even when launched from a directory that ships no AGENTS.md.
// Keep it in sync with the project-root AGENTS.md — \`bun test\` asserts parity.
const B64 = "${b64}";
export const DEFAULT_AGENTS_MD: string = Buffer.from(B64, "base64").toString("utf8");
`;

writeFileSync(OUT_PATH, file, 'utf8');
console.log(`Wrote ${OUT_PATH} (${content.length} chars of AGENTS.md → ${b64.length} base64 chars)`);
