// src/coding-agent/steerBus.ts
// S2 第一刀（P3-2 控制面抽出 / 蓝图第 8 期前半）— 插话转向队列的宿主无关形态。
//
// 此前这具队列住在 chat.ts 的闭包与字段里（pendingSteers + takeSteerMessages
// 闭包），CLI/通道宿主没有等价物——「手机遥控」因此没有地基。本模块把队列与
// 它的投递/消费语义原样抽出：语义的单一口径本来就在 steerTargeting（广播人人
// 可读、只有父边界收走；点名只给被点名的那支、也只有它取走），bus 只是这组
// 纯函数之上的有状态容器——不发明第二种语义。
//
// 折入的闸/账/核验现住 FoldInLedger（S2 第四刀，宿主无关）；铺排（指令框架、
// 活动面板联动）仍在宿主——bus 只留一个父边界回调缝（folds），宿主在回调里
// 注入在飞读数并铺指令——「bus 不猜宿主的状态」。

import type { Message, MessageImage } from '../shared/types';
import { steerConsumedBy, steerDeliversTo, type SteerRecipient, type SteerTarget } from '../shared/steerTargeting';

export interface SteerQueueEntry {
  message: Message;
  target: SteerTarget;
  /** 用户原话（渲染一致性：残留重入用原话，不是引擎框架文）。 */
  displayText: string;
  images?: MessageImage[];
}

export class SteerBus {
  private queue: SteerQueueEntry[] = [];

  enqueue(entry: SteerQueueEntry): void {
    this.queue.push(entry);
  }

  /** 只读视图（诊断/收执叙述用，不动队列）。 */
  entries(): readonly SteerQueueEntry[] {
    return this.queue;
  }

  /**
   * THINK 边界拉取。投递/消费语义与 steerTargeting 单一口径：
   *   - 点名条目只投被点名的那支、也只有它取走；
   *   - 广播条目在飞分支人人可读（复制进 drained），只有父边界能收走
   *     （话在回合收尾仍归父处置，绝不因分支读过就丢）。
   * `folds` 只在父边界（非分支拉取）被调用——宿主在回调里自己判「无在飞
   * 委派」再铺折入指令；bus 不猜在飞状态。
   */
  drain(recipient: SteerRecipient | undefined, folds?: () => Message[]): Message[] {
    const drained: Message[] = [];
    const remaining: SteerQueueEntry[] = [];
    for (const entry of this.queue) {
      if (steerDeliversTo(entry.target, recipient)) drained.push(entry.message);
      if (!steerConsumedBy(entry.target, recipient)) remaining.push(entry);
    }
    this.queue = remaining;
    const isBranch = Boolean(recipient?.branchCallId);
    if (!isBranch && folds) drained.push(...folds());
    return drained;
  }

  /**
   * 回合收尾：取残留、清空队列。残留 = 没被任何边界带走的话（点名的那支
   * 已收工、插话落在回合结束后）——宿主以用户原话重入下一回合，话不丢。
   * 内部标志且无原话的条目（已答上的旁答记录，账已清）直接弃。
   */
  settleRound(): SteerQueueEntry[] {
    const leftover = this.queue.filter((entry) => !entry.message.internal || entry.displayText);
    this.queue = [];
    return leftover;
  }
}
