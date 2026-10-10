// src/coding-agent/foldInLedger.ts
// S2 第四刀（P3-2 控制面抽出）— 折入账本：折入的「闸 · 账 · 核验」宿主无关化。
//
// 此前 pendingFoldIns 的三条裁决散在 chat.ts 的 deliverDueFoldIns /
// takeSyntheticToolCalls / settleFoldIns：委派在飞时不可交付（闸）、投递时记
// 活动水位（账）、收尾核验「没被照办就转排队」（核验）。CLI/通道宿主没有等
// 价物——远端「追加一件事」无从记账。本模块把这三条原样抽出，不发明第二种
// 语义。
//
// 分家判据与 SteerBus 同款：决策核不猜宿主状态——在飞与否、活动水位、末位
// 活动角色全部由宿主在调用点注入；宿主投影不藏裁决——指令框架/取消框架/
// 合并口径文案与代执行任务书构造留在宿主（foldInInstruction 系文案在
// insertionMessaging，任务书拼装在宿主闭包）。铺排语义（哪条折入走哪种框
// 架、每条合并口径只铺一次）由 FoldDeliveryPlan 的形状保证。

import type { MessageImage } from '../shared/types';

/** 一条折入的账：从挂号到核验的全生命周期字段（与原 chat.ts 字段逐字段一致）。 */
export interface FoldInRecord {
  text: string;
  images: MessageImage[];
  displayText: string;
  delivered: boolean;
  /** 投递时刻的活动水位——收尾核验「投递后有没有新委派活动」的基线。 */
  activityCountAtDelivery: number;
  /** true = scope 追加（代执行回合跑完喂汇总）；false = steer 类（框架指令注入）。 */
  mechanical: boolean;
  /** 取消型折入（2026-09-24 取消案例）：核验恒算残差，绝不转排队。 */
  cancels?: boolean;
  /** 代执行调用成功结束 ⇒ 机器核验完成，settle 直接放行。 */
  mechanicallyDone?: boolean;
  /** 代执行调用 id（ToolResult 事件据此回写 mechanicallyDone）。 */
  syntheticCallId?: string;
  /** 合并口径框架每条只铺一次。 */
  mergeFramed?: boolean;
}

/** beginDelivery 产出的铺排指令，宿主照型铺消息（文案留宿主）：
 *  - instruction：指令型/取消型折入，宿主铺 foldInInstruction/cancelFoldInstruction；
 *  - mergeFrame：机械追加的合并口径，宿主铺自己的口径文案（带角色名）。 */
export type FoldDeliveryPlan =
  | { kind: 'instruction'; fold: FoldInRecord }
  | { kind: 'mergeFrame'; fold: FoldInRecord; role: string };

/** 宿主在调用点注入的环境读数。 */
export interface FoldEnvInput {
  /** 有在飞委派时整体不可交付（闸门在账本，读数由宿主给——决策核不猜宿主）。 */
  delegationInFlight: boolean;
  /** 当前活动水位（agentActivities.length）。 */
  activityCount: number;
  /** 末位活动角色名（合并口径/代执行要指名委派给谁）；无活动返回 undefined。 */
  lastAgentRole: () => string | undefined;
}

export class FoldInLedger {
  private queue: FoldInRecord[] = [];

  /** 挂号一条折入（foldInScopeAddition 的账本半边；气泡与收执在宿主）。 */
  add(text: string, images: MessageImage[], displayText: string, mechanical: boolean, cancels: boolean): void {
    this.queue.push({ text, images, displayText, delivered: false, activityCountAtDelivery: -1, mechanical, cancels });
  }

  /**
   * 汇合轮投递闸（原 deliverDueFoldIns 的裁决半边）。委派在飞时整体不可
   * 交付（返回空，宿主什么都不铺）；否则指令型直接标记投递并记水位，机械
   * 追加只铺一次合并口径（无末位角色时跳过且不消费——下一轮再铺）。
   * 返回的铺排指令由宿主铺成消息；本方法不产任何文案。
   */
  beginDelivery(input: FoldEnvInput): FoldDeliveryPlan[] {
    if (input.delegationInFlight) return [];
    const plans: FoldDeliveryPlan[] = [];
    for (const fold of this.queue) {
      if (fold.delivered || fold.mechanical) continue;
      fold.delivered = true;
      fold.activityCountAtDelivery = input.activityCount;
      plans.push({ kind: 'instruction', fold });
    }
    for (const fold of this.queue) {
      if (fold.delivered || !fold.mechanical || fold.mergeFramed) continue;
      const role = input.lastAgentRole();
      if (!role) continue;
      fold.mergeFramed = true;
      plans.push({ kind: 'mergeFrame', fold, role });
    }
    return plans;
  }

  /**
   * 代执行回合领用（原 takeSyntheticToolCalls 的裁决半边）：把可执行的机械
   * 追加逐条标记投递、记水位、发 syntheticCallId。无末位角色时跳过且不消
   * 费。返回领用清单（fold 供宿主拼任务书，callId/role 供宿主构造调用与
   * 因果叙述）；宿主的在飞闸在调用本方法之前。
   */
  claimForSynthetic(input: {
    activityCount: number;
    lastAgentRole: () => string | undefined;
    assignId: (fold: FoldInRecord) => string;
  }): Array<{ fold: FoldInRecord; callId: string; role: string }> {
    const claimed: Array<{ fold: FoldInRecord; callId: string; role: string }> = [];
    for (const fold of this.queue) {
      if (fold.delivered || !fold.mechanical) continue;
      const role = input.lastAgentRole();
      if (!role) continue;
      fold.delivered = true;
      fold.activityCountAtDelivery = input.activityCount;
      const callId = input.assignId(fold);
      fold.syntheticCallId = callId;
      claimed.push({ fold, callId, role });
    }
    return claimed;
  }

  /**
   * 早派领用（刀 2.2 早派版，2026-10-10）：机械追加挂号即由宿主直接派出、
   * 与在飞兄弟支并行——不等汇合轮串行补跑。核验链与汇合路由共用一份账：
   * 投递 + 水位 + 发 syntheticCallId，兑现回写仍走 markMechanicallyDone，
   * claimForSynthetic 的 delivered 跳过保证不会二次派发。只认「最新一条未
   * 投递的机械非取消折入」——取消型永不早派（停活没有「并行补跑」可言，
   * 指令型是给模型的框架不是活）；无匹配返回 null，宿主回落汇合路由
   * （调用点闸门：在飞 + 有编排器 + 有末位角色）。
   */
  claimImmediate(input: { activityCount: number; syntheticCallId: string }): FoldInRecord | null {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const fold = this.queue[i];
      if (fold.delivered || !fold.mechanical || fold.cancels) continue;
      fold.delivered = true;
      fold.activityCountAtDelivery = input.activityCount;
      fold.syntheticCallId = input.syntheticCallId;
      return fold;
    }
    return null;
  }

  /** 代执行回写的机器核验（ToolResult 事件按 syntheticCallId 找账）。 */
  markMechanicallyDone(callId: string): void {
    const fold = this.queue.find((f) => f.syntheticCallId === callId);
    if (fold) fold.mechanicallyDone = true;
  }

  /**
   * 收尾核验（原 settleFoldIns 的裁决半边），核验即清账（原 splice(0) 语义）。
   * 返回「没被照办」的追加清单，转排队由宿主做（兜底话术在宿主）：
   *  - 取消型恒算残差（2026-09-24 取消案例）：排除一项永远不会产生新委派
   *    活动，按追加的水位核验它恒算「没照办」；而取消一旦错过汇合轮也无
   *    法事后补——转排队只会把「取消」当活重跑（反向伤害）。未照办的取消
   *    接受为残差（与轻转向同款），靠汇合轮框架 + 协议文本保证。
   *  - 机械执行成功的直接算数；指令注入的看投递后活动水位有没有新增（真
   *    的发起了新委派）。都没有（模型直奔汇总）或根本没投递（回合提前终
   *    止）→ 列入残差。
   */
  settle(activityCount: number): FoldInRecord[] {
    const settled = this.queue.splice(0);
    const residuals: FoldInRecord[] = [];
    for (const fold of settled) {
      if (fold.cancels) continue;
      const honored = fold.mechanicallyDone || (fold.delivered && activityCount > fold.activityCountAtDelivery);
      if (honored) continue;
      residuals.push(fold);
    }
    return residuals;
  }

  /** new chat 清账（旧会话的折入不闯新会话）。 */
  reset(): void {
    this.queue = [];
  }

  /** 只读视图（测试与宿主读数用；steerBus.entries() 同款）。 */
  entries(): readonly FoldInRecord[] {
    return this.queue;
  }
}
