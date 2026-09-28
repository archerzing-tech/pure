// 本文件由收割管线生成——手改会在下次收割时被覆盖（有测试锁逐字一致）。
//
// 内容：从插话决策日志（设置 → 通用 →「插话决策日志」）里，由事后审计
// （insertionAudit.ts）标出疑点的句子，自动并入的回归语料。每条的期望只从
// 「它为何被标疑点」推出，标 `expectation: 'suspected'`——未经人工复核，
// 统计时与人工断言的语料分开算。
//
// 两个收割入口，产物格式由 insertionHarvest.ts 的 renderHarvestedModule 统一：
//   - 设置页：「收割」按钮——整份文件复制到剪贴板，粘贴覆盖本文件即生效
//   - 命令行：bun scripts/harvest-insertion-corpus.ts <导出的 JSONL 文件>
// 复核后想升格为断言语料，手工搬到 insertionCorpus.ts 的 CASES 里。

import type { Case } from './insertionCorpus';

export const HARVESTED_CASES: Case[] = [];
