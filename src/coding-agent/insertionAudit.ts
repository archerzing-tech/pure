// 插话决策的事后审计（2026-09-28）。
//
// 2026-09-28 把决策路径上的关键词全撤了（CANCELISH_RE 取消粗筛、SCOPE_ADD_RE
// 停支闸都改读裁决器的契约字段）。撤掉之后有个新问题：**该报的契约字段没报，
// 宿主看不出来**——它已经不再嗅措辞了。解决办法不是在决策路径上加回来，而是
// **把词族搬到事后审计**：读一条已经落账的决策，用只读的词族比对，标出疑点。
//
// 两条铁律：
//   1. 审计绝不参与决策，也绝不改写决策——它只产出给人看的疑点标签（诊断区
//      高亮），供人工复核与回放语料收割。
//   2. 审计的假阳性是可接受的（人一眼扫过），假阴性不可接受——宁可多标。
//
// 疑点家族的终态（2026-10-28 两刀全退）：两个疑点都不再产生。
//   - adds-along-missed：判据 SCOPE_ADD_RE 随刀 1 删除（它在决策路径本就是
//     死代码）。
//   - cancels-missed   ：二分改版（docs/interjection-inline-sideline.md）把
//     旧前提「裁决器没报 cancels_part，取消话会按 relation 跑成新活」连根
//     拔掉——取消话 inline 直投主线模型自行消化，停支/整停各有
//     stop_branch.call_id / action:stop 契约承载，CANCEL_SMELL/EXCLUSIVITY/
//     looksLikeRemoval 字面嗅探随之整删。
//   类型值保留——settings 诊断面板的 INSERTION_ANOMALY_KEYS 按全键 Record
//   消费本类型，删值会烧到边界外文件；auditInsertionDecision 从此恒空，
//   summary/trend 随之恒零，模块只剩分母口径与趋势骨架供面板照常消费。
// 运行时语义判断归裁决器；宿主侧不再有任何字面匹配。

import type { InputDecision } from './inputDecision';

export type InsertionAnomaly = 'cancels-missed' | 'adds-along-missed';

export interface InsertionAudit {
  anomalies: InsertionAnomaly[];
}

/** 两个疑点的退役记录见头注：本函数恒空，签名与类型保留供调用面不动。 */
export function auditInsertionDecision(_decision: InputDecision): InsertionAudit {
  return { anomalies: [] };
}

export function hasInsertionAnomaly(decision: InputDecision): boolean {
  return auditInsertionDecision(decision).anomalies.length > 0;
}

/**
 * 契约字段的"遵守率"口径（2026-09-28）：只看**可审计**的决策——没经过裁决
 * 器判词的（rule/passthrough）不算（契约字段对它们本来就不适用），没有原话
 * 的也不算（无从比对）。把这些决策当作分母，疑点当作分子：这才是"裁决器该
 * 报的报了吗"的遵守率。
 */
function isAuditable(decision: InputDecision): boolean {
  const via = decision.signals.via;
  return (decision.inputText ?? '').trim().length > 0 && via !== 'rule' && via !== 'passthrough';
}

export interface AuditSummary {
  total: number;
  anomalies: number;
  /** 疑点率 = anomalies / total（无条目时为 0）。 */
  rate: number;
}

export function auditSummary(entries: readonly InputDecision[]): AuditSummary {
  const auditable = entries.filter(isAuditable);
  const anomalies = auditable.filter(hasInsertionAnomaly).length;
  return { total: auditable.length, anomalies, rate: auditable.length > 0 ? anomalies / auditable.length : 0 };
}

export interface AuditBatch extends AuditSummary {
  /** 1 起的批次序号，按传入顺序（日志是时间序，所以这是时间上的先后）。 */
  index: number;
}

/**
 * 逐批的疑点率——单看总数会把"一直就这样"与"最近才变坏"混成一句"有几个
 * 疑点"。趋势才看得出收割有没有在改善问题，以及哪一批插话开始变章。
 *
 * 批次是**顺序**切分（每 batchSize 条可审计决策一批），不按时间刻度：插话的
 * 密度本来就不可控，按条数切每批才可比。空日志返回空数组（面板据此显示"还没
 * 有数据"而不是一条平线）。
 */
export function auditTrend(entries: readonly InputDecision[], batchSize = 20): AuditBatch[] {
  const auditable = entries.filter(isAuditable);
  const size = Math.max(1, Math.floor(batchSize));
  const batches: AuditBatch[] = [];
  for (let start = 0; start < auditable.length; start += size) {
    const slice = auditable.slice(start, start + size);
    const anomalies = slice.filter(hasInsertionAnomaly).length;
    batches.push({
      index: batches.length + 1,
      total: slice.length,
      anomalies,
      rate: anomalies / slice.length,
    });
  }
  return batches;
}
