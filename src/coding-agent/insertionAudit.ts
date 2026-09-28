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
//                        宿主手里会按 kind 走（多半是排队），把一个"取消"跑成
//                        一件新活（反向执行）。
//   - adds-along-missed：报了取消，但同一句还在加活（SCOPE_ADD_RE 命中），却
//                        没报 adds_along——宿主会真去停那支，把刚要求加进来的
//                        活一并停掉。

import { CANCEL_PART_RE, SCOPE_ADD_RE } from './DynamicInsertionCoordinator';
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
const CANCEL_SMELL = /(?:不需|不用|不要|先不|别(?!的)|莫|取消|终止|中止|停[掉下来了]|砍掉|掐掉)/;

/**
 * 只留 CANCEL_SMELL 会漏掉本项目**最经典**的取消形状（"X 就不调研了"——裸
 * 否定标记 + 动词，正是 2026-09-24 那场事故的原句）：CANCELISH_RE 的标记表里
 * 没有裸"不"，所以它不命中。而"取消"与"普通事"之间的灰度已经被 LATTER 的
 * 近邻样本撑起来了：裁决器告急时接住收活的就是 CANCEL_PART_RE（字面安全网），
 * 那句话是漏报时反向执行的真实受害者，审计必须看得见它。两族取并集：审计的
 * 假阳性由人一眼扫掉，假阴性才会让一个反向执行静默溜过。
 */
function looksLikeRemoval(text: string): boolean {
  return CANCEL_SMELL.test(text) || CANCEL_PART_RE.test(text);
}

export function auditInsertionDecision(decision: InputDecision): InsertionAudit {
  const anomalies: InsertionAnomaly[] = [];
  const text = (decision.inputText ?? '').trim();
  if (!text) return { anomalies };
  // 机械命令快路径不经过裁决器，契约字段本来就不适用（"停掉那支"是整树/分支
  // 动作，不是收活）——审计它只会制造噪音。
  if (decision.signals.via === 'rule') return { anomalies };

  const cancels = decision.signals.cancelsPart === true;
  if (!cancels && looksLikeRemoval(text)) anomalies.push('cancels-missed');
  if (cancels && decision.signals.addsAlong !== true && SCOPE_ADD_RE.test(text)) anomalies.push('adds-along-missed');
  return { anomalies };
}

export function hasInsertionAnomaly(decision: InputDecision): boolean {
  return auditInsertionDecision(decision).anomalies.length > 0;
}
