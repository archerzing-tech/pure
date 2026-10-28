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
// 两条疑点对应两种不对称的代价：
//   - cancels-missed   ：话里有取消味，裁决器却没报 cancels_part——这句到了
//                        宿主手里会按 relation 走（多半是排队），把一个"取消"
//                        跑成一件新活（反向执行）。
//   - adds-along-missed：报了取消，但同一句还在加活，却没报 adds_along——宿
//                        主会真去停那支，把刚要求加进来的活一并停掉。
//                        （2026-10-28 刀 1 后不再产生，见下——类型值保留供
//                        诊断面板全键 Record 兼容。）
//
// 2026-10-28 框架改革刀 1/2：裁决器契约已含整树停（action=stop）与点名停支
// （stop_branch.call_id），七条字面快路径正则整族删除。本审计的两处字面比对
// 随之收缩：
//   - SCOPE_ADD_RE 已删（它在决策路径本就是死代码）：adds-along-missed 不再
//     可检。类型值保留——settings 诊断面板的 INSERTION_ANOMALY_KEYS 按全键
//     Record 消费本类型，删值会烧到边界外文件；该疑点只是从此不再产生。
//   - CANCEL_PART_RE 的并集引用撤除：那张决策路径的字面安全网已死，事后审
//     计不再蹭它。漏报筛查只靠本模块自有的 CANCEL_SMELL 词族（仍只标疑点，
//     绝不参与决策）。
// 运行时语义判断归裁决器；宿主侧字面匹配只剩「事后挑疑点给人看」这一层。

import type { InputDecision } from './inputDecision';

export type InsertionAnomaly = 'cancels-missed' | 'adds-along-missed';

export interface InsertionAudit {
  anomalies: InsertionAnomaly[];
}

/**
 * 取消味词族——**只用于事后审计**。它就是被删掉的 CANCELISH_RE 原样搬过来：
 * 当年它当决策用出了两次事故（同一个句子在裁决器与宿主两边被读成相反的两件
 * 事），但作为"事后挑可疑句子"的网，它的宽口径正合适。
 */
const CANCEL_SMELL = /(?:不需|不用|不要|先不|别(?!的)|莫|取消|终止|中止|停[掉下来了]|暂停|去掉|剔除|砍掉|掐掉)/;

/**
 * 排他性标记（2026-09-28）：「不要只查均价」说的是**不要仅限于**，均值仍被需要
 * ——没有任何东西被移除。先把这类标记抹掉再问"有东西被取消吗"，否则审计会对
 * 每一次"不要只 X"大喊漏报（假阳性多了人就学会无视它了）。
 *
 * 注意它只抹标记、不抹动词："不要只查均价，把区间也取消掉" 抹完还剩"…取消掉"，
 * 该报的照旧报。
 */
const EXCLUSIVITY = /(?:不要|别|不用|无需|不是|并非)?只(?:是|要|会|能|需|想|看|查|算|做|管)?/g;

/**
 * 只靠 CANCEL_SMELL 会漏掉本项目**最经典**的取消形状（"X 就不调研了"——裸
 * 否定标记 + 动词，正是 2026-09-24 那场事故的原句）：CANCEL_SMELL 的标记表
 * 里没有裸"不"，所以它不命中。旧版在这里并上 CANCEL_PART_RE（决策路径的字
 * 面安全网）补这个形状——2026-10-28 刀 1 那张网已整体删除，宿主不再做任何
 * 取消意图的决策级字面匹配；裸"不"形状的疑点改由真机判例与回放覆盖（审计
 * 的假阴性由裁决器回放对照兜住，不再由字面网兜）。审计只回答「裁决器该报
 * 的报了吗」，语义判断始终归裁决器。
 */
/** 「这句话有取消味吗」(抹排他性标记后测)。纯事后审计用——只产出给人看的
 *  疑点标签（诊断区高亮 + 回放语料收割），绝不参与决策。（旧注里「interjectOrchestrator
 *  的去重终稿闸也用它」已过时：那道闸 2026-10-21 刀 F 起消费裁决器的
 *  covered_branch 点名 + 宿主核实，与字面网无关。） */
export function looksLikeRemoval(text: string): boolean {
  const meaningful = text.replace(EXCLUSIVITY, '');
  return CANCEL_SMELL.test(meaningful);
}

export function auditInsertionDecision(decision: InputDecision): InsertionAudit {
  const anomalies: InsertionAnomaly[] = [];
  const text = (decision.inputText ?? '').trim();
  if (!text) return { anomalies };
  // 没经过裁决器判词的决策（旧规则快路径的 rule、刀 1 后的原话直投
  // passthrough），契约字段本来就不适用——"该报没报"无从谈起，审计它只会
  // 制造噪音（passthrough 尤其：裁决器缺席时整批插话都会被误标漏报）。
  if (decision.signals.via === 'rule' || decision.signals.via === 'passthrough') return { anomalies };

  const cancels = decision.signals.cancelsPart === true;
  if (!cancels && looksLikeRemoval(text)) anomalies.push('cancels-missed');
  // adds-along-missed 的判据 SCOPE_ADD_RE 随刀 1 删除（决策路径死代码），
  // 该疑点不再产生——类型值保留供诊断面板全键 Record 兼容（见头注）。
  return { anomalies };
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
