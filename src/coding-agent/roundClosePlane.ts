// src/coding-agent/roundClosePlane.ts
// S2 第五刀（P3-2 控制面抽出）— 回合收尾派发序 + 待办账的宿主无关状态机：
// 排队的不相关插话（待办队列）、押账的相关插话（重入续跑）、收尾裁决序
// （回执结算 → 折入核验 → 续跑兜底 → 押账插话优先 → 残留 steer 重入 →
// 队列派发）。
//
// 此前这套序住在 chat.ts 的 dispatchDeferred 里，待办账（pendingTasks）与
// 押账（relatedInsert）是它的字段——CLI/通道宿主没有等价物，S3 也无从把
// 收尾决策搬进网关进程。本模块只管账与序：队列卡渲染、交接叙述、回执行
// 结算的 DOM 投影、autoContinue/引擎生命周期都经依赖缝留给宿主。宿主读数
// （活动数/流态/续跑链）全部注入，决策核不猜宿主状态。
//
// isStreaming 守卫使重叠调度安全（原 dispatchDeferred 注释逐字保留）：第一
// 个 dispatch 进入 send() 后流态同步置真，第二个变成 no-op，开不出第二个
// 并发回合。

import type { SteerQueueEntry } from './steerBus';
import type { MessageImage } from '../shared/types';

/** 排队/重入的一条指令（与原 chat.ts pendingTasks 元素同形）。 */
export interface QueuedTask {
  text: string;
  images: MessageImage[];
  displayText: string;
  ts: number;
}

export interface RoundCloseDeps {
  // ── 宿主读数（决策核不猜宿主状态）─────────────────────────────────
  /** 回合内委派活动数（折入水位核验的基准）。 */
  activityCount: () => number;
  /** 流态：真 = 回合还在跑，收尾派发必须让路（防重入守卫）。 */
  isStreaming: () => boolean;
  /** 「继续」链是否挂着：队列派发必须让位于它（押账插话/残留 steer 不让
   *  ——用户自己的话优先于自动续跑）。 */
  autoContinuePending: () => boolean;

  // ── 账本接缝（收尾序的上游账，S2 前几刀已各自成模块）───────────────
  /** steer 账回合结算：残留（没赶上 THINK 边界）原话返回，旁答记录按账弃。 */
  steerSettleRound: () => SteerQueueEntry[];
  /** 起飞闸挂号随回合清空（残留挂号无权否决下回合的新指令）。 */
  delegationSettleRound: () => void;
  /** 折入收尾核验：返回没被照办的追加（宿主按合并口径转成新指令）。 */
  foldSettle: (activityCount: number) => QueuedTask[];
  /** 分支级继续兜底：没赶上 THINK 边界的同参重派转成排队新指令；null = 无。 */
  resumeFallback: () => QueuedTask | null;

  // ── 宿主动作缝（DOM/引擎生命周期投影）─────────────────────────────
  /** 插话回执行结算：收尾派发点就是「承诺的动作已兑现」的时刻。 */
  settleReceipts: () => void;
  /** 押账插话/残留 steer 重入前取消「继续」链——用户自己的话优先于自动续跑。 */
  supersedeAutoContinue: () => void;
  /** 重入：把一条指令作为新回合发出去（宿主接 send）。 */
  reenter: (task: QueuedTask) => void;
  /** 队列交接叙述：先说一声再动手（宿主渲染队列卡 + 状态气泡）。 */
  narrateHandoff: (remaining: number) => void;
  /** 收尾派发的延时器（GUI 注入 window.setTimeout 包装；ui 层依赖不内传）。 */
  timer: (fn: () => void, ms: number) => unknown;
}

export class RoundClosePlane {
  private queue: QueuedTask[] = [];
  private heldInsert: QueuedTask | null = null;

  constructor(private readonly deps: RoundCloseDeps) {}

  /** 排队一件不相关插话（原 queueInterjectTask 的账半边；渲染与补调度留宿主）。 */
  queueTask(task: QueuedTask): void {
    this.queue.push(task);
  }

  /** 只读视图（宿主渲染队列卡用，不留双真相）。 */
  queueView(): readonly QueuedTask[] {
    return this.queue;
  }

  /** 押账一条相关插话（原 relatedInsert 赋值；goal-change/premise-change 用）。
   *  押着时 send() 的收尾要取消「继续」链——重入马上就来，挂续跑条是误导。 */
  holdInsert(task: QueuedTask): void {
    this.heldInsert = task;
  }

  hasHeldInsert(): boolean {
    return this.heldInsert !== null;
  }

  /** Schedule the deferred dispatch just after a turn fully finalizes.
   *  40ms 让出当前同步栈（收尾/分类落地），下一拍派发。 */
  scheduleDispatch(): void {
    this.deps.timer(() => this.dispatch(), 40);
  }

  /** After the current turn is over:
   *  - a goal-change insert → immediately re-enter the same task with it (fold in).
   *  - else, steers that never reached a THINK boundary (queued in the turn's
   *    final seconds) → send them as a normal message, so nothing typed is lost.
   *  - else, if a queued task waits AND the task is terminal (no auto-continue
   *    pending) → start it as a fresh task.
   * The isStreaming guard makes overlapping schedules (turn finalize + a late
   * interject classification) safe: the first dispatch enters send(), which
   * flips streaming on synchronously, and the second becomes a no-op instead
   * of starting a second concurrent turn. */
  dispatch(): void {
    if (this.deps.isStreaming()) return;
    // 回执的账在这里结：收尾派发点就是"承诺的动作已兑现"的时刻——停的收尾
    // 落定、被留下的插话正要重入、排队的活开始交接，微光都该停了。
    this.deps.settleReceipts();
    // 折入追加的收尾核验先行：没被照办的转进待办账，下面同一趟 dispatch
    // 就会把它们作为新指令派发出去。
    for (const task of this.deps.foldSettle(this.deps.activityCount())) this.queueTask(task);
    // 分支级继续的兜底同拍：没赶上 THINK 边界的同参重派转成排队的新指令。
    const fallback = this.deps.resumeFallback();
    if (fallback) this.queueTask(fallback);
    if (this.heldInsert) {
      const ri = this.heldInsert;
      this.heldInsert = null;
      this.deps.supersedeAutoContinue(); // folding in supersedes the '继续' chain
      this.deps.reenter(ri);
      return;
    }
    // 插话重构 — steers left over when the turn already ended never reached a
    // THINK boundary. A colleague would just say them out loud as the next
    // thing to do; so does pure: they open the next turn as the user's words.
    // 1a 定向投递 + 渲染一致性：重入用用户原话（displayText），不是引擎框架
    // 文——开场气泡、存档、重载看到的都是用户自己说的话。点名某支但那支已
    // 收工的也一样：话不丢，作为用户的新指令重开。1b 旁答记录按账处置：答
    // 上的（displayText 空）账已清，残留即弃；没答上的把问题原话重入。
    const leftoverSteers = this.deps.steerSettleRound(); // 没被带走的只剩「已答上的旁答记录」——账已清，弃
    // 起飞闸挂号随回合清空：残留的取消挂号若跨回合，会拦下用户后来明确
    // 要「继续/再跑」的那支——那是新指令，挂号没资格否决它。点名停支的
    // 挂号同理：下一回合的重派是新指令，本轮的门闩不该越回合生效。
    this.deps.delegationSettleRound();
    if (leftoverSteers.length > 0) {
      this.deps.supersedeAutoContinue(); // the user's own words supersede '继续'
      const text = leftoverSteers.map((entry) => entry.displayText || entry.message.content).join('\n');
      this.deps.reenter({ text, images: leftoverSteers.flatMap((entry) => entry.images ?? []), displayText: text, ts: Date.now() });
      return;
    }
    if (this.queue.length > 0 && !this.deps.autoContinuePending()) {
      const t = this.queue.shift()!;
      // 交接先说一声再动手（队列卡同步收掉这项/空了撤卡）——用户的下一句
      // 话凭空开始跑，没有这句衔接读起来就是无中生有。
      this.deps.narrateHandoff(this.queue.length);
      this.deps.reenter(t);
    }
  }

  /** 新会话清场：待办队列与押账插话一并（clear() 用；DOM 卡的撤除留宿主）。 */
  reset(): void {
    this.queue = [];
    this.heldInsert = null;
  }
}
