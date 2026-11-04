// 历史收割来的语料资产（2026-11-05 收割管线退役后保留的存量段）。
//
// 出处：2026-09-28 起的收割管线（设置页「收割」按钮 + 命令行脚本）曾把插话
// 决策日志里被事后审计（insertionAudit.ts）标疑点的句子自动并到这里。2026-10-28
// 框架改革把宿主侧字面嗅探整链删掉——审计疑点恒空，管线成了恒收 0 的死骨架，
// 随整链退役（面板按钮/趋势区/脚本/模块全撤）。存量句子保留：它们的期望仍标
// `expectation: 'suspected'`（未经人工复核，统计时与人工断言的语料分开算，
// 见 insertionCorpus.test.ts 的收割段锁）。
//
// 复核后想升格为断言语料，手工搬到 insertionCorpus.ts 的 CASES 里。

import type { Case } from './insertionCorpus';

export const HARVESTED_CASES: Case[] = [];
