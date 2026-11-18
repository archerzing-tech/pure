// src/shared/detachedResume.ts
// 后台委派的崩溃恢复通告（2026-11-18 档二续）。
//
// 后台腿活在父进程的定时器与子引擎里：进程一死，在飞的支就没了，产出永远
// 不会到。但它在最后一份转录里留下了痕——受理收执的工具消息带着
// `deferred: true`。恢复会话时必须把这件事当事实说出来：沉默的收执会让模型
// 要么以为活干完了，要么以为还在跑，两种都会把汇总写成假的。子代理自己的断
// 点还在盘上，同参重派会从断点续跑，所以如实通告比自动重派更安全——重派花
// 的是用户的 token，而被中断的那部分活用户可能已经不要了。
//
// 通告就地改写那条工具结果，而不是另插一条 internal user 消息：工具结果是
// 配对契约的一部分，重写它不需要动消息时序，也不会在压缩/合并转录时被当作
// 「回合前历史」丢掉——落盘的是同一条消息。判据只认转录里的 durable 标记：
// 宿主内存（编排器的在飞表）跨进程不存在，另设存档字段会与转录分叉。

import type { Message } from './types';

export interface InterruptedDelegation {
  toolCallId: string;
  toolName: string;
}

/** 恢复通告的识别标记（模型面）：同一份转录反复加载时据此判定已通告。 */
export const DETACHED_RESUME_TAG = '[detached resume]';

/** 转录里仍挂着「已受理、未结算」的后台委派。 */
export function findInterruptedDelegations(messages: Message[]): InterruptedDelegation[] {
  const out: InterruptedDelegation[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool' || message.deferred !== true) continue;
    const toolCallId = message.toolCallId;
    if (!toolCallId || seen.has(toolCallId)) continue;
    seen.add(toolCallId);
    out.push({ toolCallId, toolName: message.toolName ?? 'delegate' });
  }
  return out;
}

/** 通告文本：说清三件事——没回来、别当完成、要就同参重派（断点续跑）。 */
export function renderDetachedResumeNotice(pending: InterruptedDelegation): string {
  return `${DETACHED_RESUME_TAG} 这次后台委派（${pending.toolName}，call_id=${pending.toolCallId}）在主进程退出时还没跑完，产出已经随进程没了（不会有结果自己回来）。它既没完成，也不算失败——别把它算进汇总，也别当成还在跑。要这部分活就按原 brief 用相同参数重派（子代理的断点还在，会从断点续跑），或者自己接手。`;
}

/**
 * 就地结算「上个进程丢掉的后台支」：把收执工具结果改写成通告并清掉
 * `deferred` 标记，返回被改写的支。幂等——标记清掉后第二次调用返回空。
 *
 * 就地改写是刻意的：宿主（GUI/CLI）把同一批 Message 对象当转录持有，落盘走
 * 的就是它们；返回新数组会让这次通告活不过下一次存档。
 */
export function resolveInterruptedDelegations(messages: Message[]): InterruptedDelegation[] {
  const pending = findInterruptedDelegations(messages);
  if (pending.length === 0) return [];
  const byId = new Map(pending.map((d) => [d.toolCallId, d]));
  for (const message of messages) {
    if (message.role !== 'tool' || message.deferred !== true) continue;
    const hit = message.toolCallId ? byId.get(message.toolCallId) : undefined;
    if (!hit) continue;
    message.content = renderDetachedResumeNotice(hit);
    message.deferred = false;
    byId.delete(hit.toolCallId);
  }
  return pending;
}
