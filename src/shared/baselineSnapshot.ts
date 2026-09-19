// src/shared/baselineSnapshot.ts
// 发布口径的评测基线：读取由 `bun run eval:snapshot` 生成的快照，给出仪表盘需要的
// 判断（是否落后于当前套件、缓存命中率）。纯函数，可在 bun 里直接断言。

import { BASELINE_SNAPSHOT } from './baselineSnapshotData';
import { BASELINE_SUITE_VERSION, type BaselineProviderRow, type BaselineSnapshot } from './baseline';

export { BASELINE_SNAPSHOT };
export type { BaselineProviderRow, BaselineSnapshot };

/** 快照是否落后于当前套件：套件版本变了却没重新生成快照时，页面必须说出来。 */
export function isBaselineStale(snapshot: BaselineSnapshot): boolean {
  return snapshot.suiteVersion !== BASELINE_SUITE_VERSION;
}

/** 缓存命中率（0–100，一位小数）。没有 prompt 数据时返回 null——不是 0：
 *  "没测到" 和 "一次都没命中" 是两回事。 */
export function baselineCacheHitRate(row: BaselineProviderRow): number | null {
  if (!(row.promptTokens > 0)) return null;
  return (row.cacheHitTokens / row.promptTokens) * 100;
}
