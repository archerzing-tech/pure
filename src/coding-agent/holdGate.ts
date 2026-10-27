// src/coding-agent/holdGate.ts
// 插话架构 v2 — 软暂停闸（docs/insertion-redesign-v2.md §四）。
//
// 为什么要有这一层：v1 的判定窗口是「旁观」——插话裁决期间主回合照常推进，
// 判完才动手；《设想》§一定死了新时序：**到达即软暂停 → 先判断关系 → 再决定
// 怎么做**。holdGate 就是这个「到达即扣」的宿主机制：
//   - 扣什么：输出推进（模型 token 流在下一停顿点挂起）+ 写操作派发；
//   - 不扣什么：只读调用派发与在飞完成（宿主按工具元数据 isWrite 判定，
//     判定本身不看这个闸——裁决跑在 LLM 上，不是跑在主回合里）；
//   - 死线：hold 最长 = judge 预算（≤8s）+ 处置预算（自查/复核各一次窄 LLM
//     调用）。到点强制解除 + 宿主如实收执——**绝无永久扣死路径**：判得再慢、
//     处置链再长，闸也只会松，不会把回合锁死。
//
// 执行者=宿主（蓝图 §十.4 铁律）：闸只挂状态与等待，谁扣、扣多久、何时放，
// 全由宿主侧（interjectOrchestrator 的生命周期 + chat.ts 的引擎缝）驱动，
// 模型对闸零感知、零判定。

/** hold 解除时的处置结论（如实收执的素材）。 */
export type HoldOutcome = 'released' | 'redirected' | 'paused' | 'timeout';

/** judge 预算（classifyInsertion 的缺省超时）。死线的第一段。 */
export const JUDGE_BUDGET_MS = 8_000;

/**
 * hold 总死线：judge 8s + 处置预算。处置预算按最坏处置链留——自查（12s，
 * 与 recheckCovered 同档）+ 处置动作落账。死线不是倒计时竞速：它只在「处置
 * 链意外卡死」时兜底强制解除，正常路径处置完就 open，远早于死线。
 */
export const DEFAULT_HOLD_DEADLINE_MS = 30_000;

export interface HoldGateOptions {
  /** hold 最长时长；缺省 DEFAULT_HOLD_DEADLINE_MS。测试可给毫秒级值。 */
  deadlineMs?: number;
  /** 死线强制解除时回调（宿主在此如实收执）。reason 是 close 时登记的
   *  插话原文片段——收执要点名具体的事，不给片段就只能说空话。 */
  onDeadline?: (reason: string) => void;
}

export class HoldGate {
  private closed = false;
  private reason = '';
  private outcome: HoldOutcome | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly opts: HoldGateOptions = {}) {}

  /** 到达即扣（interject 入口第一步）。幂等：闸已关时**不重置死线**——
   *  连续多条插话排队裁决时，第二条的到达不许给第一条的死线续命，否则
   *  N 句连发就是 N 倍扣压（死线必须从第一句到达起算）。 */
  close(reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.reason = reason;
    this.outcome = null;
    this.clearTimer();
    this.timer = setTimeout(() => this.forceOpen(), this.opts.deadlineMs ?? DEFAULT_HOLD_DEADLINE_MS);
  }

  /** 处置完成按结论解除：放行（released）/ 转向（redirected）/ 交棒真暂停
   *  （paused）。幂等安全：闸已开时是 no-op（真暂停路径 abort 已掐流，处置
   *  完的 open 不需要也不产生第二个动作）。 */
  open(outcome: HoldOutcome): void {
    if (!this.closed) return;
    this.closed = false;
    this.outcome = outcome;
    this.clearTimer();
    this.releaseWaiters();
  }

  /** 闸是否关着（= 主回合该被扣住）。 */
  isOpen(): boolean {
    return this.closed;
  }

  /** close 时登记的插话原文片段（收执/诊断用）。 */
  heldReason(): string {
    return this.reason;
  }

  /** 最近一次解除的结论；未解除过 = null。 */
  lastOutcome(): HoldOutcome | null {
    return this.outcome;
  }

  /**
   * 派发点的等待面：闸开着立即返回；关着就等到 open（含死线强制解除）。
   * signal 中止同样放行——abort 管道接管后执行层自会掐掉调用，等待面不该
   * 比它自己还固执。
   */
  async waitUntilOpen(signal?: AbortSignal): Promise<void> {
    if (!this.closed || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = (): void => done();
      const done = (): void => {
        this.waiters.delete(done);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.add(done);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 新会话清场：状态、死线、等待者一并放掉（等待者被释放而非悬挂——
   *  清场往往意味着回合已经没了，挂着的派发点不该陪葬）。 */
  reset(): void {
    this.closed = false;
    this.reason = '';
    this.outcome = null;
    this.clearTimer();
    this.releaseWaiters();
  }

  /** 死线到点：强制解除 + 宿主收执回调。先放行等待的派发、再回调——
   *  回调里的收执慢一步不该拖住已经该跑的写操作。 */
  private forceOpen(): void {
    this.clearTimer();
    this.closed = false;
    this.outcome = 'timeout';
    this.releaseWaiters();
    this.opts.onDeadline?.(this.reason);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private releaseWaiters(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const w of waiters) w();
  }
}
