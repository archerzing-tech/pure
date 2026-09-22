// src/shared/baseline.ts
// 评测基线的共享口径：套件版本常量 + 快照结构。
//
// 放在 shared 下是因为两边都要用：评测侧（src/evaluation）产出报告，进化仪表盘
// （src/ui）把发布口径的成绩显示出来。仪表盘不能 import 评测侧的模块——那边
// 依赖 node:fs / node:path，会把设置页的懒加载 chunk 拖成 node 代码。

import { priceFor } from './usage';

/** 当前评测套件的版本号。fixture 集合一变，这个常量与 fixtureHash 都必须跟着变。 */
export const BASELINE_SUITE_VERSION = 'pure-coding-baseline-v5';

export interface BaselineProviderRow {
  provider: string;
  model: string;
  /** 产出报告时的 git revision——"这次发布跑的是哪个 commit"。 */
  gitRevision: string;
  passAt1: number;
  taskCount: number;
  meanDurationMs: number;
  estimatedCostUsd: number;
  promptTokens: number;
  cacheHitTokens: number;
  /** 相对仓库根的报告文件，方便回溯原始数据。 */
  report: string;
}

/**
 * 这一行的成本是**量出来的**，还是「没数据」？
 *
 * 两种情况都会让 `estimatedCostUsd` 落在 0：provider 不回 usage（NVIDIA NIM 那列
 * 就是这样），或者 usage.ts 的价目表里没有这家。0 是缺口，不是「不要钱」——它
 * 不能去占「谁更省」的头名。
 */
export function isBaselineCostPriced(row: BaselineProviderRow): boolean {
  if (!(row.promptTokens > 0)) return false;
  const price = priceFor(row.provider);
  return price.inputPerM > 0 || price.cacheHitPerM > 0 || price.outputPerM > 0;
}

/**
 * 基线行的展示/落盘顺序：**有价的行按成本升序在前**，未定价的行按 provider/model
 * 排在最后。评测脚本（eval:snapshot）与仪表盘共用这一份定义，所以排序在两边一致
 * ——快照里存的就是页面上的顺序。
 */
export function orderBaselineRows(rows: readonly BaselineProviderRow[]): BaselineProviderRow[] {
  return [...rows].sort((a, b) => {
    const pricedA = isBaselineCostPriced(a);
    const pricedB = isBaselineCostPriced(b);
    if (pricedA !== pricedB) return pricedA ? -1 : 1;
    const byName = a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
    return pricedA ? a.estimatedCostUsd - b.estimatedCostUsd || byName : byName;
  });
}

export interface BaselineSnapshot {
  /** 快照取自哪个套件版本/指纹（只收当前套件的报告）。 */
  suiteVersion: string;
  fixtureHash: string;
  generatedAt: string;
  rows: BaselineProviderRow[];
  /** 被排除的旧套件报告：套件对不上，数字不可比。 */
  excluded: Array<{ report: string; suiteVersion: string }>;
}
