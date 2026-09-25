// src/coding-agent/branchLifecycle.ts
// 对话智能升格第 2 期（分支中断）：子代理生命周期状态机。
//
// 设计定稿（2026-09-25，用户设想 + 评审细化）：四个主状态其实是四个**动作**
// （启动/暂停/继续/收尾），中间态才是状态机的**状态**——每个状态只接受合法
// 动作，幂等与竞态在转移表里有唯一答案。终态三个：已完成（产出入账）、已
// 中止（用户叫停：产出不入账、断点照存）、已失败（挂原因元数据：error/
// timeout/stalled，父按原因选下一步）。异常与重试分两层：子代理内部的自愈
// 重试不迁移状态（父不管，卡片亮灯）；重试耗尽落已失败，失败后的重跑是父
// 的决策（新一次启动），不是状态机内的边。
//
// 纪律：转移规则是纯函数口径（本文件），编排器是唯一持有者，宿主与 GUI 都
// 只读投影（观测单向，防缠三原则）。describe() 把状态映射回既有活动词汇
// （SubagentStatus/lifecycle），第一阶段卡片零改动即可吃到真状态。

/** 分支生命周期的状态：三个中间态 + 三个终态。中间态永不驻留——暂停收尾
 * 有宽限兜底，委派中有 spawn 超时兜底（编排器挂表，状态机只认转移）。 */
export type BranchState =
  | 'delegating' // 委派中：调用已受理，子引擎还没吐第一个事件
  | 'running'    // 运行中：子引擎在跑（THINK/ACT/OBSERVE 都算）
  | 'pausing'    // 暂停收尾：暂停/中止信号已发，在飞工具宽限期内
  | 'paused'     // 暂停中：断点已存，引擎停泊
  | 'completed'  // 已完成：产出入账
  | 'aborted'    // 已中止：用户叫停（单支/整树），产出不入账，断点照存
  | 'failed';    // 已失败：挂 cause（error/timeout/stalled），父决策重跑或放弃

/** 合法动作。settle 类（spawned/pauseSettled/complete/fail）是运行结果的
 * 地面真相——从任何非终态都可接受（状态机对齐到结果）；control 类（pause/
 * abort）才查合法性。 */
export type BranchAction =
  | 'spawned'      // 子引擎吐出第一个事件
  | 'pause'        // 暂停请求（整树或单支）
  | 'pauseSettled' // 运行以暂停存档落定（checkpoint 已 persist）
  | 'complete'     // 运行以交付落定
  | 'fail'         // 运行以失败落定（挂 cause）
  | 'abort';       // 中止请求（单支叫停 / 整树取消）

/** 已失败的原因元数据：timeout/stalled 的父面语义是「没跑完，可续跑重派」，
 * error 是「真的出了问题」。中止的原因单独记在 cause（user-branch / tree）。 */
export type BranchFailCause = 'error' | 'timeout' | 'stalled';

export type BranchAbortCause = 'user-branch' | 'tree-cancel';

export interface BranchTransition {
  from: BranchState;
  to: BranchState;
  action: BranchAction;
  at: number;
}

export type BranchApplyResult =
  | { ok: true; transition: BranchTransition }
  | { ok: false; reason: string };

/** 控制动作的合法性 + 终态不可再动 + 结算对齐结果，全在这张表/这两个函数里。 */
export function applyBranchAction(
  state: BranchState,
  action: BranchAction,
): { to: BranchState } | { rejected: string } {
  if (state === 'completed' || state === 'aborted' || state === 'failed') {
    // 终态之后的一切动作都不再改变状态。控制动作明确拒绝；结算动作静默
    // 忽略（sequence 单调号在事件面上挡旧消息，状态机在这里挡旧语义）。
    if (action === 'pause' || action === 'abort') return { rejected: `already ${state}` };
    return { rejected: `settled as ${state}; late ${action} ignored` };
  }
  switch (action) {
    case 'spawned':
      return { to: 'running' };
    case 'pause':
      if (state === 'pausing') return { rejected: 'pause idempotent (already pausing)' };
      if (state === 'paused') return { rejected: 'already paused' };
      return { to: 'pausing' };
    case 'abort':
      return { to: 'aborted' };
    case 'pauseSettled':
      return { to: 'paused' };
    case 'complete':
      return { to: 'completed' };
    case 'fail':
      return { to: 'failed' };
  }
}

/** 单支生命周期账本。编排器每受理一个委派调用就建一个，随结算出账后销毁
 * （暂停支的续跑 = 同参重派新调用，血缘认账是新账本的事）。 */
export class BranchLifecycle {
  private st: BranchState = 'delegating';
  private why?: string;

  constructor(
    readonly callId: string,
    readonly agentName: string,
  ) {}

  state(): BranchState {
    return this.st;
  }

  /** 已失败的原因（error/timeout/stalled）或已中止的原因（user-branch/tree）。 */
  cause(): string | undefined {
    return this.why;
  }

  isTerminal(): boolean {
    return this.st === 'completed' || this.st === 'aborted' || this.st === 'failed';
  }

  apply(action: BranchAction, detail?: { failCause?: BranchFailCause; abortCause?: BranchAbortCause }): BranchApplyResult {
    const result = applyBranchAction(this.st, action);
    if ('rejected' in result) return { ok: false, reason: result.rejected };
    const transition: BranchTransition = { from: this.st, to: result.to, action, at: Date.now() };
    this.st = result.to;
    if (result.to === 'failed') this.why = detail?.failCause ?? 'error';
    if (result.to === 'aborted') this.why = detail?.abortCause ?? 'user-branch';
    if (result.to !== 'failed' && result.to !== 'aborted') this.why = undefined;
    return { ok: true, transition };
  }

  /** 映射回既有活动词汇（SubagentStatus / lifecycle）：第一阶段卡片与账目
   * 零改动。中间态在卡片上仍是 running（它确实还在跑）；pausing 不单独立
   * 相——结算（paused/cancelled）在宽限语义下毫秒级跟到。 */
  describe(): {
    status: 'running' | 'paused' | 'done' | 'cancelled' | 'timed_out' | 'failed';
    lifecycle: 'started' | 'paused' | 'done' | 'cancelled' | 'timed_out' | 'failed';
  } {
    switch (this.st) {
      case 'delegating':
      case 'running':
      case 'pausing':
        return { status: 'running', lifecycle: 'started' };
      case 'paused':
        return { status: 'paused', lifecycle: 'paused' };
      case 'completed':
        return { status: 'done', lifecycle: 'done' };
      case 'aborted':
        return { status: 'cancelled', lifecycle: 'cancelled' };
      case 'failed':
        return this.why === 'timeout' || this.why === 'stalled'
          ? { status: 'timed_out', lifecycle: 'timed_out' }
          : { status: 'failed', lifecycle: 'failed' };
    }
  }
}
