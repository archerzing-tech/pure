// 疑点句收割（2026-09-28）：把诊断区事后审计标出来的句子**变成语料**，而不是
// 让它随会话日志一起被清掉。
//
// 为什么需要它：决策路径上的关键词全撤了（CANCELISH_RE / SCOPE_ADD_RE），宿主
// 不再嗅措辞——于是「裁决器漏报了契约字段」这件事只有事后审计看得见（
// insertionAudit.ts）。看得见还不够：见过一次、下次还错，等于没看见。收割把
// 「看得见」接成「跑得到」——疑点句落进语料，之后每次回放都要重新判一遍。
//
// 期望怎么来：只由「它当初为什么被标疑点」反推，这是唯一有依据的部分——
//   cancels-missed   ⇒ 该报 cancels_part（本项目分类里收掉具名一支 = steer）
//   adds-along-missed⇒ 该报 cancels_part + adds_along
// 所以收割出来的用例一律标 `expectation: 'suspected'`：审计网的假阳性是可接受
// 的（见 insertionAudit 注），未经人复核的期望不能混进断言段的准确率。

import { auditInsertionDecision, type InsertionAnomaly } from './insertionAudit';
import type { InputDecision } from './inputDecision';
import type { Case } from './insertionCorpus';

export interface HarvestResult {
  /** 新收割的用例（未与既有语料去重前不会出现的重复）。 */
  added: Case[];
  /** 看过的句子去哪了——收割报告要能解释「为什么只多了 2 句」。 */
  skipped: Array<{ text: string; why: 'no-text' | 'duplicate' | 'clean' }>;
}

/** 出处前缀：诊断区审计 + 收割日期，回看时能对上是哪一轮的日志。 */
export const HARVEST_SOURCE_PREFIX = '诊断区审计';

/**
 * 从一段决策日志里收割疑点句。
 *
 * `existing` 传全量语料（人工 + 已收割），去重按句子原文——同一句被标两次疑点
 * 只该进一次回归集。
 */
export function harvestCasesFromLog(
  entries: readonly InputDecision[],
  existing: readonly Case[],
  stamp: string,
): HarvestResult {
  const seen = new Set(existing.map((c) => c.text.trim()));
  const added: Case[] = [];
  const skipped: HarvestResult['skipped'] = [];

  for (const entry of entries) {
    const text = (entry.inputText ?? '').trim();
    if (!text) {
      skipped.push({ text, why: 'no-text' });
      continue;
    }
    if (seen.has(text)) {
      skipped.push({ text, why: 'duplicate' });
      continue;
    }
    const { anomalies } = auditInsertionDecision(entry);
    if (anomalies.length === 0) {
      skipped.push({ text, why: 'clean' });
      continue;
    }
    added.push(caseFromAnomalies(text, anomalies, stamp));
    seen.add(text);
  }

  return { added, skipped };
}

export interface HarvestRound {
  ts: number;
  /** 这一轮收进去几句。 */
  harvested: number;
  /** 收割那一刻的可审计疑点率——下一轮与它对照，才看得出收割有没有在起作用。 */
  rate: number;
  /** 那一刻可审计的决策条数（率的分母）。 */
  total: number;
}

/** 收割轮次的落盘位置（设置页诊断区的趋势读数）。 */
export const HARVEST_ROUNDS_KEY = 'pure.insertionHarvestRounds.v1';
/** 只留最近这些轮：趋势看的是走势，不是档案。 */
export const HARVEST_ROUNDS_LIMIT = 20;

/** localStorage 的最小面（传入只为可测：bun 下没有 window.localStorage）。 */
export interface HarvestRoundStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): HarvestRoundStore | null {
  const ls = (globalThis as { localStorage?: HarvestRoundStore }).localStorage;
  return ls ?? null;
}

/** 读历史轮次；没有/坏了/存不了都当空——诊断区绝不为一个读数报错。 */
export function loadHarvestRounds(store: HarvestRoundStore | null = defaultStore()): HarvestRound[] {
  if (!store) return [];
  try {
    const raw = store.getItem(HARVEST_ROUNDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is HarvestRound =>
      typeof r === 'object' && r !== null && Number.isFinite((r as HarvestRound).ts));
  } catch {
    return [];
  }
}

/** 追加一轮并落盘，返回新的完整列表（写入失败也不影响收割本身）。 */
export function recordHarvestRound(
  round: HarvestRound,
  store: HarvestRoundStore | null = defaultStore(),
): HarvestRound[] {
  const next = [...loadHarvestRounds(store), round].slice(-HARVEST_ROUNDS_LIMIT);
  if (!store) return next;
  try {
    store.setItem(HARVEST_ROUNDS_KEY, JSON.stringify(next));
  } catch {
    // 存不下就只留在本次会话——趋势丢一轮好过收割失败。
  }
  return next;
}

/**
 * 渲染生成的语料模块（`insertionCorpusHarvested.ts` 的全文）。
 *
 * 两个收割入口共用它，所以产物格式只有一份事实来源——设置页的「收割」按钮
 * （浏览器里写不了源文件，把整份文件复制出来让人粘贴）与命令行脚本（直接写盘）
 * 给出的是逐字相同的东西。有一条测试锁住「磁盘上的文件 === 该函数的输出」，
 * 所以手改生成文件会在 CI 里当场现形。
 */
export function renderHarvestedModule(cases: readonly Case[]): string {
  const body = cases
    .map((c) => [
      '  {',
      `    text: ${JSON.stringify(c.text)},`,
      `    kind: ${JSON.stringify(c.kind)},`,
      ...(c.cancels ? ['    cancels: true,'] : []),
      ...(c.addsAlong ? ['    addsAlong: true,'] : []),
      "    expectation: 'suspected',",
      `    source: ${JSON.stringify(c.source)},`,
      '  },',
    ].join('\n'))
    .join('\n');
  return `${HARVESTED_HEADER}${body ? `[\n${body}\n]` : '[]'};\n`;
}

const HARVESTED_HEADER = `// 本文件由收割管线生成——手改会在下次收割时被覆盖（有测试锁逐字一致）。
//
// 内容：从插话决策日志（设置 → 通用 →「插话决策日志」）里，由事后审计
// （insertionAudit.ts）标出疑点的句子，自动并入的回归语料。每条的期望只从
// 「它为何被标疑点」推出，标 \`expectation: 'suspected'\`——未经人工复核，
// 统计时与人工断言的语料分开算。
//
// 两个收割入口，产物格式由 insertionHarvest.ts 的 renderHarvestedModule 统一：
//   - 设置页：「收割」按钮——整份文件复制到剪贴板，粘贴覆盖本文件即生效
//   - 命令行：bun scripts/harvest-insertion-corpus.ts <导出的 JSONL 文件>
// 复核后想升格为断言语料，手工搬到 insertionCorpus.ts 的 CASES 里。

import type { Case } from './insertionCorpus';

export const HARVESTED_CASES: Case[] = `;

/** 疑点 → 用例。收掉具名一支在本项目的分类里就是 steer（见语料收活族），
 *  所以收割的期望 kind 也是 steer——这是从审计结论推出来的，不是猜的。 */
export function caseFromAnomalies(text: string, anomalies: readonly InsertionAnomaly[], stamp: string): Case {
  const cancels = anomalies.includes('cancels-missed') || anomalies.includes('adds-along-missed');
  const addsAlong = anomalies.includes('adds-along-missed');
  return {
    text,
    kind: 'steer',
    ...(cancels ? { cancels: true } : {}),
    ...(addsAlong ? { addsAlong: true } : {}),
    expectation: 'suspected',
    source: `${HARVEST_SOURCE_PREFIX} ${stamp}（${anomalies.join(' + ')}）`,
  };
}
