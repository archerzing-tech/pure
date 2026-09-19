// src/shared/baseline.ts
// 评测基线的共享口径：套件版本常量 + 快照结构。
//
// 放在 shared 下是因为两边都要用：评测侧（src/evaluation）产出报告，进化仪表盘
// （src/ui）把发布口径的成绩显示出来。仪表盘不能 import 评测侧的模块——那边
// 依赖 node:fs / node:path，会把设置页的懒加载 chunk 拖成 node 代码。

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

export interface BaselineSnapshot {
  /** 快照取自哪个套件版本/指纹（只收当前套件的报告）。 */
  suiteVersion: string;
  fixtureHash: string;
  generatedAt: string;
  rows: BaselineProviderRow[];
  /** 被排除的旧套件报告：套件对不上，数字不可比。 */
  excluded: Array<{ report: string; suiteVersion: string }>;
}
