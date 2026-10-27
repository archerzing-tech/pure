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
import { QUEUED_PRIORITY } from '../shared/scheduling';

/** 排队/重入的一条指令（与原 chat.ts pendingTasks 元素同形）。 */
export interface QueuedTask {
  text: string;
  images: MessageImage[];
  displayText: string;
  ts: number;
  /** 第 5 期调度：队列优先级，数值越大越急（见 shared/scheduling.ts）。缺省
   *  = 队列级（QueuedTask 早于本字段诞生，旧快照与 rule/net 路径都不传它）。 */
  priority?: number;
  /** 重入时宿主要不要回显用户气泡（缺省要）。回合残留的 steer 与押账重入
   *  置假——插话时 echoUser 已显示过原话，重入只补历史账（2026-10-27 真
   *  机复验：再画一遍就是用户报的「重复显示两遍」）。队列任务照常显。 */
  echoUser?: boolean;
}

/** 一条账的优先级读数：没带 priority 的一律按队列级算（旧档兜底，唯一口径）。 */
function priorityOf(task: QueuedTask): number {
  return task.priority ?? QUEUED_PRIORITY;
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
  /** dispatch 空手而归（本趟没有任何重入）后的宿主钩子：这就是「真收尾」
   *  时刻——通知/托盘/侧栏把 streaming ∪ pending 活当「在跑」口径后，链轮
   *  间间隙（streaming=false）与队列交接都不是收尾边界，静默排空（如已照办
   *  的折入账清账）更没有流态事件，这一拍补上边界（2026-10-27 SettleNotifier
   *  判例）。可选缝：CLI 中性构造不接。 */
  onDispatchIdle?: () => void;
}

export class RoundClosePlane {
  private queue: QueuedTask[] = [];
  private heldInsert: QueuedTask | null = null;

  constructor(private readonly deps: RoundCloseDeps) {}

  /** 排队一件不相关插话（原 queueInterjectTask 的账半边；渲染与补调度留宿主）。
   *  第 5 期调度：按优先级**稳定插入**——数值大的排前面，同级保持到达序
   *  （后到的不越过先到的，folding/兜底残差与普通 task 同级时次序不变）。 */
  queueTask(task: QueuedTask): void {
    const p = priorityOf(task);
    const stamped: QueuedTask = { ...task, priority: p };
    let i = this.queue.length;
    while (i > 0 && priorityOf(this.queue[i - 1]) < p) i--;
    this.queue.splice(i, 0, stamped);
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
    // 本趟是否重入了新回合：重入的 dispatch 不是收尾边界（streaming 马上会
    // 亮起来），只有空手而归才轮到 onDispatchIdle 说话。
    let reentered = false;
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
      this.deps.reenter({ ...ri, echoUser: false });
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
      this.deps.reenter({ text, images: leftoverSteers.flatMap((entry) => entry.images ?? []), displayText: text, ts: Date.now(), echoUser: false });
      return;
    }
    if (this.queue.length > 0 && !this.deps.autoContinuePending()) {
      const t = this.takeHighest();
      // 交接先说一声再动手（队列卡同步收掉这项/空了撤卡）——用户的下一句
      // 话凭空开始跑，没有这句衔接读起来就是无中生有。
      this.deps.narrateHandoff(this.queue.length);
      this.deps.reenter(t);
      reentered = true;
    }
    // 空手而归 = 「真收尾」时刻：宿主据此广播 running 集合变更，通知器在
    // 这一拍才把会话记成收尾（重入路径提前 return，不会走到这里）。
    if (!reentered) this.deps.onDispatchIdle?.();
  }

  /** 第 5 期调度：取**最高优先级**的一项（同级 FIFO）。队列通常已按优先级
   *  降序排好（queueTask 稳定插入），但恢复的旧档可能乱序——这里按最大优先
   *  级扫一遍、并列取最靠前的一项，既不依赖排序前提也不破坏稳定语义。一次
   *  仍只取一件：dispatch 的 isStreaming 守卫保证开不出第二个并发回合。 */
  private takeHighest(): QueuedTask {
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (priorityOf(this.queue[i]) > priorityOf(this.queue[best])) best = i;
    }
    return this.queue.splice(best, 1)[0];
  }

  /** 新会话清场：待办队列与押账插话一并（clear() 用；DOM 卡的撤除留宿主）。 */
  reset(): void {
    this.queue = [];
    this.heldInsert = null;
  }

  /** 持久化快照（第 3 期最小核心，E6）：待办队列与押账插话的原话账，与
   *  SessionUiState.pendingQueue 同形。深拷贝出账——宿主落盘后还会继续改
   *  账，不能共享引用。 */
  snapshot(): { queue: QueuedTask[]; heldInsert: QueuedTask | null } {
    return {
      queue: this.queue.map((t) => ({ ...t })),
      heldInsert: this.heldInsert ? { ...this.heldInsert } : null,
    };
  }

  /** 从快照收账（会话恢复点调用）。只在空账上收：恢复发生在会话切换之后，
   *  reset 已清场；非空拒收——宁可丢一份旧话，不养双真相。恢复只装账不
   *  派发：重启的会话没有「回合收尾」这一刻，排队的活等下一个自然派发点
   *  （用户下一句话的收尾扫除接手）——被记得 ≠ 此刻抢跑；队列卡的 DOM
   *  重建同样留给宿主回放后的 restoreQueueAffordance（与「继续」条同拍）。
   *  第 5 期调度：逐条经 queueTask 装回——旧档缺 priority 的兜队列级、且
   *  恢复后的呈现顺序与实况一致（queueView 顺序即展示顺序）。 */
  restore(state: { queue: QueuedTask[]; heldInsert: QueuedTask | null }): void {
    if (this.queue.length > 0 || this.heldInsert !== null) return;
    for (const task of state.queue) this.queueTask(task);
    this.heldInsert = state.heldInsert ? { ...state.heldInsert } : null;
  }
}
