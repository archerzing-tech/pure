// src/coding-agent/interjectOrchestrator.ts
// 插话架构 v2（2026-10-27）— 九类分发臂主刀：interject() 入口（到达即软暂停
// 闸 hold）与序列化链、classifyAndApply 的裁决序（软暂停 → 裁决 → 时机语义 →
// 置信门 → 思考窗吸收 → 九类处置表分发）、真暂停链（押账 + 掐流 + 产出清理 +
// 原话重入）、1a 定向投递匹配 / 覆盖去重 / 点名续跑的编排、思考窗寄存器。
//
// 此前这一整套焊死在 chat.ts（GUI 控制器）。S3 的前置硬约束：九类判定只有一
// 份、控制面是无宿主状态依赖的决策核——本模块把决策核搬出来，DOM（ack 行/
// 回显/收执/事件日志/控制台诊断）、LLM 产出（旁答/追问）、铺排（折入框架/
// 转向框架/队列卡）与引擎把手（abort/真停支）经依赖缝留给宿主。宿主读数
// （流态/在飞/分支视图/任务状态投影）全部注入，决策核不猜宿主状态。
//
// ack 句柄不透明（InterjectAck = unknown）：宿主给什么还什么——GUI 是
// HTMLElement，通道宿主可以是任何东西。收执话术的单一事实来源仍在
// insertionMessaging（本模块只引用，不内联第二份）。

import { DynamicInsertionCoordinator, type DynamicInsertionDecision } from './DynamicInsertionCoordinator';
import { needsClarification, isDestructiveAction, type InputAction, type InputTiming } from './inputDecision';
import { matchInFlightBranch, type SteerTarget, type InFlightBranch } from '../shared/steerTargeting';
// 收执纪律（2026-10-28 框架改革刀 2）：收执 = 裁决器现场写的 receipt 唯一来源，
// 缺席时引擎沉默。这里只保留判例背书的事实播报（branchUncertainPauseReceipt）
// 与续跑诚实二分（branchResumeReceipt，checkpoint 命中与否只有宿主知道）——
// 回应性固定话术（branchStopReceipt/cancelBeforeDispatchReceipt/queuedReceipt/
// queuedUrgentReceipt 一族）已删，调用点改为 receipt ?? null。
import { branchResumeReceipt, branchUncertainPauseReceipt } from '../shared/insertionMessaging';
import { priorityForLevel, type ProcessingLevel } from '../shared/scheduling';
import { PAUSE_ABORT_REASON } from '../shared/pauseSignal';
import type { HoldGate } from './holdGate';
import { affectedByChange, type SideEffectEntry, type TaskStateSnapshot } from './taskState';
import type { DelegationControlPlane } from './delegationControl';
import type { RoundClosePlane } from './roundClosePlane';
import type { MessageImage, LLMAdapter } from '../shared/types';
import { detectTaskKind, isFileMutating } from '../shared/taskKind';
import { appendTrace } from '../evolution/trace';

/** 插话临时回执句柄：不透明（宿主投影）。 */
export type InterjectAck = unknown;

/** 覆盖去重的匹配面：1a 同款字段 + 终态（已收工的支结果已在汇总里）。 */
export type CoveringBranch = InFlightBranch & { status: 'running' | 'done' };

export interface InterjectOrchestratorDeps {
  // ── 决策引擎与账本（宿主无关模块直连）─────────────────────────────
  decider: DynamicInsertionCoordinator;
  delegation: DelegationControlPlane;
  roundClose: RoundClosePlane;

  // ── 宿主读数（决策核不猜宿主状态）─────────────────────────────────
  isStreaming(): boolean;
  /** 判定落定前的硬停检查（abortController 信号）。 */
  isAborted(): boolean;
  /** decide 的取消信号与 LLM 档（judgeLlm ?? turnLlm ?? null 的宿主选择）。 */
  decideSignal(): AbortSignal | undefined;
  decideLlm(): LLMAdapter | null;
  /** 分类上下文投影（buildInsertionContext，读宿主账本——留宿主）。 */
  insertionContext(images: MessageImage[]): string;
  hasDelegationInFlight(): boolean;
  /** 1a 定向投递的匹配面：在飞支（名是代号，主题在任务书片段里）。 */
  runningBranches(): InFlightBranch[];
  /** 点名续跑的候选：已暂停/已停的支。 */
  stoppedBranches(): InFlightBranch[];
  /** 覆盖去重的匹配面：在飞 + 已收工（结果已在汇总里同样不重派）。 */
  coveringCandidates(): CoveringBranch[];
  /** 已收工支的匹配面（缺口②机械排除，2026-10-15）：产出已回、结果已在父
   *  上下文里的支（status=done；暂停/停掉的支结算不带产出，无从剔除）。 */
  settledBranches(): InFlightBranch[];
  /** 已收工支的产出剔除（宿主执行，返回 false = 上下文里没找到那路的
   *  结果——迟到/缺账，调用方按没剔处理，不预支收执）。 */
  stripSettledBranchOutput(callId: string): boolean;
  /** 登记一路已收工支进入「离场账」（缺口②机械排除，第 6 期）：callId 为
   *  durable key，topic 是用户点名原文（迟到/缺账时装配期二次匹配的依据）。
   *  登记与即时剔除解耦——同回合 settle 的支此刻结果还没进宿主 this.messages
   *  （即时剔会落空），靠回合收尾补剔与下一轮装配兜底兑现；登记不预支成功。 */
  registerStrippedBranch(callId: string, topic: string): void;
  /** 收执里引用支名时带同任务第几号（同名多支消歧）。 */
  branchLabel(name: string, callId: string): string;
  /** 阶段 C 窗口（2026-10-15 用户定调「冲突按样本执行」并行委派都收齐、汇总
   *  还没写完的整理窗）：此刻委派已存在但一支不在飞。追加/取消在这个窗口
   *  不排队——折入汇聚轮（补这项/剔除后再重整），改的是旧定稿「收齐就排队、
   *  先出已有汇总再补跑」——样本口径的「暂停汇总，补完重整一份完整输出」
   *  胜出（两段输出的取舍被明确推翻）。单任务流（本就没派过委派）不在此
   *  窗口，照旧排队。 */
  atAggregationWindow(): boolean;
  /** 续跑预检（第 2 期第三刀）：同参重派会不会命中 checkpoint（编排器
   *  probeResumeCheckpoint 的同口径读数）。无必填默认——凭据缺失会让收执
   *  退回「无脑许愿从断点续」，正是本刀要收掉的谎。 */
  probeResume(toolName: string, rawArgs: string): { hit: boolean; turns: number };

  // ── 软暂停 / 真暂停 / 任务状态（v2 §四 §七）──────────────────────
  /** 软暂停闸（holdGate）：interject() 到达即 close、处置完 open；宿主把
   *  引擎停顿点与写派发扣在这个闸后面。缺席 = 宿主没接闸（判定照走，只是
   *  不扣推进——单测/通道宿主的合法形态）。 */
  hold?: HoldGate;
  /** 任务状态投影（foldTaskState 的宿主快照，change 臂「先确定影响再行动」
   *  的读数）。null = 当前没有可折算的任务账（未挂任务脚本/单测），change
   *  臂退回真暂停链。 */
  taskStateSnapshot?(): TaskStateSnapshot | null;
  /** 已完成工作的副作用冻结（写操作标记 frozen，防后续补偿/引用踩到已被
   *  推翻前提的产出）。返回冻结到的条目（收执如实点名）。 */
  freezeSideEffects?(): SideEffectEntry[];
  /** 真暂停的中断产物清理（宿主执行）：把被掐流的半截 assistant 输出从
   *  上下文剔除、渲染留底（stripSettledBranchOutput 同范式推广）。缺席 =
   *  宿主没实现清理，押账重入照走（上下文里留半截话，不阻塞主链）。 */
  stripAbortedTurnPartial?(): void;

  // ── 引擎动作缝（宿主生命周期）─────────────────────────────────────
  send(text: string, images: MessageImage[], displayText: string): void;
  abort(reason?: string): void;
  /** 模型点名、宿主执行（2026-10-10 重构）：callId 由裁决器从花名册里指认，
   *  宿主只按这个确切 id 真停——不做任何自己的文本匹配（规则快路径随刀 1
   *  删除，「或规则路径的单支集合事实」旧路已清）。支不在飞/已结算返回
   *  null，调用方退回取消折入。 */
  stopBranchByCallId(callId: string, mode: 'abort' | 'pause'): string | null;
  /** 转向通道入队 + 收执（框架文本与收执口径留宿主）。receipt（2026-10-28
   *  刀 2 收执纪律）：裁决器现场写的收执是唯一来源，宿主优先转达；缺席 =
   *  引擎沉默（机制状态由 UI 呈现），绝不出固定话术。 */
  steerRunningTurn(text: string, images: MessageImage[], ack: InterjectAck, target: SteerTarget, cancel: boolean, receipt?: string): void;
  /** 排队不相关插话（roundClose.queueTask + 队列卡渲染 + 补调度）。第 5 期
   *  调度：priority 由调度级折算（见 shared/scheduling.ts）；缺省 = 队列级。 */
  queueInterjectTask(text: string, images: MessageImage[], displayText: string, priority?: number): void;
  /** 折入汇合轮的铺排（回显 + folds.add + 收执——铺排留宿主）。stopMissed
   *  （2026-10-10）：取消折入发生在「点名停支没停成」时置真——收执换诚实
   *  口径（在跑的支没停、给出能真停的说法），不说「其余照常」了事。
   *  receipt（2026-10-28 刀 2）：普通折入的收执优先用裁决器写的；stopMissed
   *  这类宿主事实修正压过它（收执纪律：只说真实发生的事），其余缺席 = 沉默。 */
  foldInScopeAddition(text: string, images: MessageImage[], displayText: string, mechanical: boolean, ack: InterjectAck, cancels: boolean, stopMissed?: boolean, receipt?: string): void;
  answerMidrunQuestion(text: string, images: MessageImage[]): Promise<void>;
  askMidrunClarification(decision: DynamicInsertionDecision, text: string, images: MessageImage[], ack: InterjectAck): Promise<void>;
  /** 输入自带执行时刻的排期 sink（false = 没接 sink 或拒收）。 */
  deferTimedInsert(timing: InputTiming, text: string, images: MessageImage[], displayText: string): boolean;

  // ── 投影缝（DOM/事件日志/控制台诊断；settleAck 系留宿主）─────────
  /** 插话临时回执行（GUI：addStatusBubble('插话处理中…') + 回执账登记）。 */
  createAck(): InterjectAck;
  /** 收执落定（2026-10-28 刀 2）：text=null = 引擎沉默——收执缺席时宁可无话，
   *  不出机械腔；机制状态由 UI（支状态卡/队列卡）呈现。宿主只做退场（临时行
   *  摘掉 + 账上销账），不进收执事件日志。非 null 时语义同旧：终稿转气泡、
   *  keepPending 占位照旧。 */
  settleAck(ack: InterjectAck, text: string | null, keepPending?: boolean, kind?: 'success' | 'warn' | 'info'): void;
  /** 临时回执的直接退场（行摘掉 + 账上销账）。 */
  discardAckRow(ack: InterjectAck): void;
  /** 用户原话回显（插队到 ack 行正前——转写对得上谁说了什么）。 */
  echoUser(ack: InterjectAck, displayText: string, images: MessageImage[]): void;
  /** 裁决落定的投影：会话事件日志（insertion_classified）+ 控制台诊断。 */
  logDecision(decision: DynamicInsertionDecision, text: string): void;
}

export class InterjectOrchestrator {
  /** Serializes mid-run insert classifications. A second insert typed while
   * the first is still being judged must WAIT its turn — the caller has
   * already cleared the input box, so dropping the call would lose the
   * user's words for good. */
  private chain: Promise<void> = Promise.resolve();

  // ── 软暂停闸生命周期（v2 §四：到达即扣，处置完解除）────────────────
  /** 当前在裁的插话数（序列化链保证实际 ≤1，计数器防嵌套泄漏）。 */
  private holdDepth = 0;
  /** 本轮处置是否走了真暂停链（hold 解除结论 paused 的依据）。 */
  private pauseRequested = false;

  // ── 思考窗寄存器（原 chat.ts 五件，S2 第六刀迁入）───────────────────
  /** 阶段感知的 scope 追加（2026-09-22 用户定稿）：并行委派还没收齐时插进
   * 来的追加活不走"收尾后排队"——那会先输出一份没有它的汇总。折入汇合轮：
   * 代执行回合在委派收齐后的第一个 THINK 边界把追加包成普通委派调用交还
   * 引擎；指令型折入仍走转向通道框架注入 + 水位核验。收尾核验兜底转排队，
   * 话绝不丢。（窗口与吸收账在本编排器；并账进请求正文与铺排留宿主。） */
  private planPreflightActive = false;
  private pendingPreflightSupplements: Array<{ text: string; images: MessageImage[] }> = [];
  /** 推倒重想（2026-09-27 用户定调）：吸收到的补充不是"旧思考继续用"，
   * 约束类的话必须长进构图里。吸收分支置位 + 掐掉在飞的思考流；宿主的
   * 重启循环用并账后的请求从头再想。 */
  private preflightAbort: AbortController | null = null;
  private preflightRestartRequested = false;
  /** 刀 3.1 事件驱动攒批：当前窗内已经并账重开过（在飞/即将在飞的思考轮
   * 是重想轮）——此间新到的补充只入暂存不掐流，在飞的重想流完后宿主一
   * 次带上全部。原思考轮（窗开后的第一轮）不在此列：它不含任何补充，想
   * 完也是白想，照旧早掐早省。开窗/清场归零。 */
  private preflightRethinkInFlight = false;
  /** 在飞思考的叙述尾（最近 ~400 个可见字符）：插话裁决的时机证据——裁决
   * 器看到"思考最新说到……"才能自己发现叙述里的错误前提（jev 案例）。
   * 每轮新思考开局清空（旧轮的尾巴对新轮是假证据）。 */
  private preflightNarrationTail = '';

  constructor(private readonly deps: InterjectOrchestratorDeps) {}

  /**
   * Handle a message the user typed while a turn is running (interrupt-and-
   * insert). 插话 v2（2026-10-27，《设想》§一）：时序倒转——**到达即软暂停，
   * 先判断关系，再决定怎么做**。入口第一步关上软暂停闸（holdGate：扣输出
   * 推进与写派发，只读放行，死线兜底绝不锁死），九类关系判完、处置做完，
   * finally 里按结论开闸。九类处置面（蓝图 §六）：
   *   - supplement / emphasize / meta → 不打断：转向通道顺路带上，活照干。
   *   - question → 侧路回答一句，主循环毫无感知。
   *   - unrelated → new_task 按阶段折入/排队；chatter 收下即可。
   *   - correction → 押账重入但不掐流：转向通道转达，模型在下一个边界自己
   *     回退理解；残留由收尾原话重入兜底。
   *   - misunderstanding → 先自查（当前输出忠实吗）：确认跑偏 → 真暂停链；
   *     自查坏了/没确证 → 降级为转达，绝不拿坏链路当暂停依据。
   *   - change → 先确定影响再行动：带专门信号（点名撤支）折入/停支；带
   *     targets_constraint 查任务状态（未开始拦截/进行中暂停/已完成冻结+
   *     询问）；推翻/改向/整停 → 真暂停链。
   *   - mixed → 原子分流：破坏性原子主导整消息，否则逐原子各归各臂。
   * 判定不可用时保守按 supplement 转达处理：话一定送到，活绝不推倒重来。
   */
  async interject(text: string, images: MessageImage[] = [], displayText = text): Promise<void> {
    if (!text.trim()) return;
    // Not mid-run → a normal send.
    if (!this.deps.isStreaming()) {
      this.deps.send(text, images, displayText);
      return;
    }
    // Serialize classifications instead of dropping concurrent inserts: the
    // old insertInFlight early-return silently discarded any message typed
    // while an earlier one was still being judged — and the caller has
    // already cleared the input box, so those words were gone.
    // The judge is an LLM round trip (seconds). During it the user's words
    // are deliberately not on screen yet (the abort classes re-enter through
    // send(), which renders its own bubble) — without an instant ack that
    // window reads as dead air: you said something and nobody reacted. The
    // ack is ONE pending status line that the final receipt REPLACES in
    // place, so the transcript never shows two lines for one insert.
    const ack = this.deps.createAck();
    try { appendTrace({ type: 'interject', snippet: text.slice(0, 80) }); } catch {}
    // 到达即软暂停（v2 §四）：闸在裁决期间扣住输出推进与写派发。死线在
    // holdGate 内兜底（超时强制解除 + 宿主收执），这里绝不吞异常——闸的
    // open 在 finally，判定链炸了也要放行主回合。
    this.pauseRequested = false;
    this.holdDepth += 1;
    this.deps.hold?.close(text.slice(0, 120));
    try {
      const run = this.chain.then(() => this.classifyAndApply(text, images, displayText, ack));
      // A rejected link must never poison the chain for later inserts.
      this.chain = run.catch(() => {
        this.deps.settleAck(ack, '未能处理这句插话；请重新发送。');
      });
      await run;
    } finally {
      this.holdDepth = Math.max(0, this.holdDepth - 1);
      if (this.holdDepth === 0) this.deps.hold?.open(this.pauseRequested ? 'paused' : 'released');
    }
  }

  /** One link of the interject chain: runs only after every earlier insert has
   * been judged. Re-checks isStreaming() because an earlier stop/goal-change
   * aborts the turn — by the time this link runs, the insert may belong to a
   * fresh send instead. */
  private async classifyAndApply(text: string, images: MessageImage[], displayText: string, ack: InterjectAck): Promise<void> {
    // 轻微 taskKind 提示（仅用于未来保守过滤，不改现有分发）
    const _taskKind = detectTaskKind(text);
    const _fileMutating = isFileMutating(text);
    if (!this.deps.isStreaming()) {
      // The turn is over; a normal send renders the user's own bubble, so the
      // provisional ack would only orphan a promise nobody keeps.
      try { appendTrace({ type: 'interject_block', reason: 'not_streaming', snippet: text.slice(0, 60) }); } catch {}
      this.deps.discardAckRow(ack);
      this.deps.send(text, images, displayText);
      return;
    }
    // Steer / question / chatter never re-render the user's words later, so the
    // echo here is the only chance for the transcript to show who said what.
    // The abort classes (goal-change / premise-change) are the exception: their
    // insert is HELD and re-enters through send(), which renders the bubble as
    // the fresh turn's opening line — echoing here too made the same message
    // appear twice (user-reported). The status label carries the instant
    // feedback while the abort drains.
    const echoUserBubble = (): void => this.deps.echoUser(ack, displayText, images);
    // 分类器不可用（LLM 还没立起来）也照走 decide(null)：协调器的兜底是
    // passthrough 原话直投（2026-10-28 刀 1：字面安全网 netVerdict 已删，不再
    // 猜 relation）——话绝不因没有裁决器而失踪（见下方 passthrough 消费分支）。
    // 决策本身不看关键词（2026-09-28 用户定调）：时机×内容×结果收益的综合
    // 判断全在裁决器（上下文带着当前阶段与思考叙述）。裁决走 judgeLlm（关暗
    // 推理）而不是 turnLlm：开着思考时 8s 预算几乎必然超时，判定会整批落到
    // passthrough。turnLlm 是兜底（judgeLlm 没立起来时它至少让 decide 拿到
    // 一个 llm）。档位选择留宿主（decideLlm 缝）。
    const insertionCtx = this.deps.insertionContext(images);
    const decision = await this.deps.decider.decide(this.deps.decideLlm(), insertionCtx, { text, images, displayText }, this.deps.decideSignal());
    this.deps.logDecision(decision, text);
    // 判定遥测（2026-10-21 刀 F）：真机插话失败三连无法取证——logDecision
    // 只进内存调试面，trace 在 WebView 里曾是静默 no-op。判定结果同拍落
    // observations，事后可直接对质裁决器回了什么（relation/关键信号/收执）。
    try {
      appendTrace({
        type: 'interject_decision',
        snippet: text.slice(0, 80),
        route: decision.relation,
        reason: decision.reason,
        // v2 判定面（2026-10-27）：九类 relation 是权威分类（kind 槽承载
        // 同值仅供旧日志对读），trace 直落 relation，不再经过折算层。
        kind: decision.relation,
        relation: decision.relation,
        via: decision.signals.via,
        cancelsPart: decision.signals.cancelsPart,
        coveredBranchCallId: decision.signals.coveredBranchCallId,
        stopBranchCallId: decision.signals.stopBranchCallId,
        receipt: typeof decision.signals.receipt === 'string' ? decision.signals.receipt.slice(0, 120) : undefined,
      });
    } catch { /* 遥测失败不碰主流程 */ }
    // 现场回应（2026-10-21 对话主导架构，用户拍板）：裁决器就是插话的对话
    // 枢纽——判的那一刻就在现场，回应用户与裁定路线是同一次判断的两面。除
    // chatter/question 外全 kind 必写（停/纠偏/改向也要先接住用户的话，不是
    // 机械播报）；规则与安全网路径没有裁决器在场，固定口径降为机械失败兜底。
    const receipt = typeof decision.signals.receipt === 'string' && decision.signals.receipt.trim()
      ? decision.signals.receipt
      : undefined;
    // 第 5 期调度：处理级随裁决信号过河（九类处置表折出），裁决器的 urgent
    // 再折成提级——两个入队点（分类期间硬停的兜底、unrelated 排队臂）共用
    // 同一个优先级读数，口径不漂。
    const urgent = decision.signals.urgent === true;
    const queuePriority = priorityForLevel(
      (decision.signals.processingLevel as ProcessingLevel | undefined) ?? 'queued',
      urgent,
    );
    if (this.deps.isAborted()) {
      // The turn was hard-stopped while we were classifying — don't drop the
      // insert; queue it so it still runs as a task. The queue card that
      // queueInterjectTask renders is the receipt; the provisional ack would
      // only duplicate it.
      try { appendTrace({ type: 'interject_block', reason: 'aborted_during_classify', snippet: text.slice(0, 60) }); } catch {}
      this.deps.discardAckRow(ack);
      this.deps.queueInterjectTask(text, images, displayText, queuePriority);
      return;
    }
    // 输入级时间语义先于 kind 生效：这句话自己报了执行时刻，那它现在就不该被
    // 执行——不管分类器把它读成什么（stop 除外：停是立即的，timing 恒为 now）。
    // 少了这一步，"下午三点再跑一遍"会被当成当场追加的活跑掉。
    if (decision.timing.mode === 'at' && this.deps.deferTimedInsert(decision.timing, text, images, displayText)) {
      this.deps.discardAckRow(ack);
      return;
    }
    // passthrough 直投（2026-10-28 刀 1，裁决器缺席/倒下时的唯一兜底形态）：
    // 没有任何语义判定发生（confidence=0.3 是投递策略的刻意标注），所以必须
    // 抢在置信门消费之前入队——置信门会把它降级 clarify，而「问用户」臂在这
    // 里无处可去（没判断发生，拿什么问？）。按 unrelated→queue 的入队路径走：
    // 原话进队列、回合收尾经 queuedHandoffText 框架重入，让在跑的模型带着
    // 现场自己消化，话绝不丢（不变量 §六.1）。无收执：引擎沉默，队列卡就是
    // 机制状态的呈现（与 aborted_during_classify 兜底同一投影形态，原话在
    // 重入时作为新回合开场气泡上屏，这里不 echo——队列任务重入照常显气泡）。
    if (decision.signals.via === 'passthrough') {
      this.deps.discardAckRow(ack);
      this.deps.queueInterjectTask(text, images, displayText, queuePriority);
      return;
    }
    // 置信门在这里兑现（此前门只改写决策、分发按 kind 照走——低置信的
    // goal-change 照样拆任务，"问而不赌"从未发生）：分类器明确报告没把握、
    // 且原判定是破坏性的（停/重开），先把问题问出来，手头的活照跑。不破坏的
    // 误判自己能愈（排队晚点跑、旁答只答一次），照旧分发，不拿问题烦人。
    const gatedFrom = decision.signals.gatedFrom;
    if (needsClarification(decision) && typeof gatedFrom === 'string' && isDestructiveAction(gatedFrom as InputAction)) {
      this.deps.settleAck(ack, '这句判定没把握，先问你一句…', true);
      echoUserBubble();
      void this.deps.askMidrunClarification(decision, text, images, ack);
      return;
    }
    // 思考窗吸收（v2 判据内联）：预检窗开着、插话是「改/补当前构图」类关系
    // （supplement/emphasize/meta/correction/change/mixed/misunderstanding），
    // 且不带专门宿主信号（点名撤支/停支/续支各有更精确的机械动作，不从这
    // 里过）——吸收进思考重开，不占独立处置。蓝图 §二「不再独立判定吸收」
    // 指旧独立吸收判定器退役，机制本身保留（成熟管道），判据从 kind 换
    // relation（supplementsCurrent 契约字段已退役，task 吸收条款随之撤销）。
    const hasDedicatedSignal = decision.signals.cancelsPart === true
      || typeof decision.signals.stopBranchCallId === 'string'
      || typeof decision.signals.resumesBranchCallId === 'string';
    const ABSORBABLE_RELATIONS: ReadonlySet<string> = new Set([
      'supplement', 'emphasize', 'meta', 'correction', 'change', 'mixed', 'misunderstanding',
    ]);
    if (this.planPreflightActive
      && ABSORBABLE_RELATIONS.has(decision.relation)
      && !hasDedicatedSignal) {
      echoUserBubble();
      this.pendingPreflightSupplements.push({ text, images });
      if (this.preflightRethinkInFlight) {
        // 刀 3.1 事件驱动攒批（附-5 事件版，非 debounce 时间窗——那会给单句
        // 插话白加一个等待窗）：重想已在飞，只入暂存不掐流。在飞的重想流完，
        // planByThinking 见暂存非空作废本轮产出发重启哨兵，宿主并账重开一
        // 轮一次带上全部——N 句补充不再 N 次废生成 N 次重启。宿主纯机械：
        // 攒不攒由「有没有重想在飞」这个流状态定，不判断、不计时。
      } else {
        // 原思考在飞（或轮间缝）：它不含任何补充，想完也是白想，照旧早掐早省。
        this.preflightRestartRequested = true;
        this.preflightAbort?.abort();
      }
      this.deps.settleAck(ack, isDestructiveAction(decision.action)
        ? '已按纠正重构思路，重新规划…'
        : '已并入补充，重新规划…');
      return;
    }
    // 范围确认去重（2026-10-21 对话主导架构刀 F，真机「调研必须包括优酷」
    // 判例二连反转刀 E）：范围确认话（「必须包括X」）若花名册里已有一支在
    // 做/做完了 X，该答「那路正在跑着，不重复」而不是再转达一遍。判据与点
    // 名全归裁决器（covered_branch 契约字段——它分类时看得见 <live_branches>
    // 与 <finished_branches>，与 stop_branch 点名同构）；宿主唯一做的是**核
    // 实**：点名的 callId 真在覆盖面（在飞/已收工）里。刀 E 的「抄对象名+
    // 宿主字面匹配」被真机否决（裁决器漏报新字段/字面对不上语义对应），刀
    // F 起宿主零文本匹配——模型判断、宿主执行的原样复用。点错/已结算（race）
    // = 核实不过，照旧路由，绝不拿错误的支回「不重复」；收执用宿主核实过的
    // 事实终稿，绕开裁决器的 receipt（它写的是转达口径，与去重事实矛盾）。
    // 专门臂优先同前：带取消/停支/续跑信号的话各有更精确的宿主动作。
    const coveredCallId = typeof decision.signals.coveredBranchCallId === 'string'
      ? decision.signals.coveredBranchCallId
      : '';
    if ((decision.relation === 'supplement' || decision.relation === 'unrelated')
      && coveredCallId
      && !hasDedicatedSignal) {
      const ensured = this.deps.coveringCandidates().find((item) => item.callId === coveredCallId);
      if (ensured) {
        const ensuredName = this.deps.branchLabel(ensured.name, ensured.callId);
        echoUserBubble();
        // 去重回执是终稿（没有后续在途）——转普通气泡，与 task 臂同一口径。
        this.deps.settleAck(ack, ensured.status === 'done'
          ? `这个刚才已经跑完了——「${ensuredName}」那路的结果就在汇总里，不重复派。`
          : `您说的这个正在「${ensuredName}」那路跑着，不重复派——收齐后一并汇总给您。`);
        return;
      }
      // 核实不过（模型点错/那支刚结算）：要求照常兑现，落下去走正常路由。
    }
    // ── 九类处置表分发（蓝图 §六）──────────────────────────────────────
    switch (decision.relation) {
      case 'supplement':
      case 'emphasize':
      case 'meta':
        // 不打断：转向通道顺路带上，活照干。三类共用同一落地形态——差别只在
        // 语义标注（约束补充/强调/过程说明），机械动作没有分别。
        await this.steerArm(text, images, displayText, ack, receipt, decision, echoUserBubble);
        return;
      case 'question':
        // 回答气泡马上就来（旁路一次 LLM 调用），临时回执不再留行。
        this.deps.discardAckRow(ack);
        echoUserBubble();
        void this.deps.answerMidrunQuestion(text, images);
        return;
      case 'unrelated': {
        // 收活先于排队：判成不相关却带着取消信号的，绝不能当新活跑（反向执行
        // ——排队一个"取消"等于把它当活跑）。
        if (decision.signals.cancelsPart === true) {
          await this.handleCancelFold(text, images, displayText, ack, receipt, decision, echoUserBubble);
          return;
        }
        if (decision.unrelatedKind === 'chatter') {
          // 收下了。同事埋头干活时说了句"哈哈"，你不会停下来回一句"收到"——
          // 气泡已上屏，这就够了，别再打扰干活的人。临时回执也一并收走。
          this.deps.discardAckRow(ack);
          echoUserBubble();
          return;
        }
        await this.newTaskArm(text, images, displayText, ack, receipt, decision, queuePriority, insertionCtx, echoUserBubble);
        return;
      }
      case 'change':
        await this.changeArm(text, images, displayText, ack, receipt, decision, echoUserBubble);
        return;
      case 'correction':
        this.correctionArm(text, images, ack, receipt, echoUserBubble);
        return;
      case 'misunderstanding':
        await this.misunderstandingArm(text, images, displayText, ack, receipt, decision, insertionCtx, echoUserBubble);
        return;
      case 'mixed':
        await this.mixedArm(text, images, displayText, ack, receipt, decision, queuePriority, insertionCtx, echoUserBubble);
        return;
    }
  }

  /**
   * 真暂停链（v2 §七）：中断输出（abort，委派在飞走 PAUSE 存档口径）→
   * 产出清理（宿主把被掐流的半截输出剔出上下文、渲染留底）→ 押账重入
   * （roundClose.holdInsert，新回合开场 = 用户上一句原话 + 纠偏插话，
   * RoundClosePlane 派发序保证押账优先）。只由双重触发确认的臂进入：
   * change 的推翻/改向判词、misunderstanding 的自查确认。
   */
  private truePause(text: string, images: MessageImage[], displayText: string, ack: InterjectAck, receipt?: string): void {
    this.pauseRequested = true;
    this.deps.roundClose.holdInsert({ text, images, displayText, ts: Date.now() });
    // 先落押账再 abort：abort 是异步排空，押账先入账保证收尾派发点有话可派。
    // 在飞支会结算成已暂停·进度已存档（可续跑的事实，见下方 PAUSE 分支），
    // 机制事实由支状态卡呈现；收执沉默（2026-10-28 框架改革刀 2）——裁决器
    // 现场写的 receipt 是唯一话语来源，宿主不替模型编话。
    this.deps.settleAck(ack, receipt ?? null, true, 'info');
    this.deps.stripAbortedTurnPartial?.();
    if (this.deps.hasDelegationInFlight()) {
      // 活动期整树走 PAUSE 原因 → 在飞支结算成「已暂停·进度已存档」（灰 ⏸、
      // success:true，checkpoint 照存）——重入回合看到的是可续跑的事实，
      // 不是失败证据（2026-09-29 三路调研判例）。
      this.deps.abort(PAUSE_ABORT_REASON);
    } else {
      // 无在飞可暂停：裸 abort（对已收尾的回合是 no-op），押账插话照常派发。
      this.deps.abort();
    }
    // 迟到判定风险：裁决期间回合已收尾的话，没人派发押账插话——重 arm 派发点。
    if (!this.deps.isStreaming()) this.deps.roundClose.scheduleDispatch();
  }

  /**
   * supplement / emphasize / meta 臂：不打断的转达。分支级续跑/点名停支/
   * 取消折入等专门信号优先（各有更精确的机械动作），普通话走 1a 定向投递
   * （委派在飞按点名直达某支，没点名广播），委派不在飞转达父引擎。
   */
  private async steerArm(
    text: string,
    images: MessageImage[],
    displayText: string,
    ack: InterjectAck,
    receipt: string | undefined,
    decision: DynamicInsertionDecision,
    echoUserBubble: () => void,
  ): Promise<void> {
    // 分支级继续（第 2 期第三刀；2026-10-28 刀 1 后点名归裁决器）：点名把
    // 一支**已暂停/已停**的委派接着跑完——用原始参数同参重派（稳定 sessionId
    // 命中 checkpoint → 子引擎 continue），排在停支/取消/普通 steer 之前
    // （带点名锚的「接着跑」比整树续跑、加活都具体）。宿主只核实执行：裁决
    // 器从花名册点 resumesBranchCallId，callId 点不到停止面花名册/原始参数
    // 缺席/重复点名 = 核实不过，按普通插话处理（落回下面的 stopish/普通
    // steer），宿主不猜、不越权改判。
    const resumeCallId = typeof decision.signals.resumesBranchCallId === 'string'
      ? decision.signals.resumesBranchCallId.trim()
      : '';
    if (resumeCallId) {
      const resumed = this.resumeNamedBranch(resumeCallId, text);
      if (resumed) {
        echoUserBubble();
        // 续跑由机制保证（同参重派在委派收齐后的代执行回合落定），收执
        // 是终稿——转普通气泡（与停支/暂停收执同一形态）。命中说从第 N
        // 轮接 / 没命中明说从头跑，口径单一出处（branchResumeReceipt，
        // 判例保留的事实播报：checkpoint 命中与否只有宿主知道），与派工
        // 收执、兜底指令三处同源。
        this.deps.settleAck(ack, branchResumeReceipt(resumed.label, resumed.checkpoint, this.deps.hasDelegationInFlight()));
        return;
      }
    }
    // 第 2 期分支中断：取消型话里裁决器点得出具体支的——真停那一支
    // （abortBranch，产出不入账、断点照存），其余照跑。点不出具体支时
    // 退回原路：取消口径折入 / 普通 steer。（branchStop 布尔信号随
    // BRANCH_STOP_RE 快路径删除，stopish 的唯一触发源是 cancelsPart。）
    const stopish = decision.signals.cancelsPart === true;
    if (stopish) {
      await this.stopishArm(text, images, displayText, ack, receipt, decision, echoUserBubble);
      return;
    }
    echoUserBubble();
    // 非取消、非停支的转达走 1a 定向投递：委派在飞时按点名找收件人
    // ——点到某一支就直达那一支（其余照跑），没点名就广播给所有在飞的
    // 活。委派不在飞时照旧：父引擎下个 THINK 边界顺路带上。
    if (this.deps.hasDelegationInFlight()) {
      this.deps.steerRunningTurn(text, images, ack, this.matchSteerRecipient(text), false, receipt);
    } else {
      this.deps.steerRunningTurn(text, images, ack, 'parent', false, receipt);
    }
  }

  /**
   * 点名停支/取消的落地（委派在飞与否两窗口）。祈使「停掉那支」= 中止
   * （判例 13 口径）；收掉一项「先停下」= 暂停（复测案例二口径：立即止损
   * 不烧完，活口比中止更大）。addsAlong 闸：同一句里还要求加活的话永不
   * 停支——停掉那支会把刚要求加进来的活一并杀掉，只取消折入（砍与加都在
   * 汇合轮兑清）。没停成退回取消折入——绝不 1a 广播（「停掉那支」广播给
   * 所有在飞支，每支都可能把自己当成"那支"自己停，反向执行最伤）。
   */
  private async stopishArm(
    text: string,
    images: MessageImage[],
    displayText: string,
    ack: InterjectAck,
    receipt: string | undefined,
    decision: DynamicInsertionDecision,
    echoUserBubble: () => void,
  ): Promise<void> {
    if (this.deps.hasDelegationInFlight()) {
      // mode 折算：祈使中止（abort）的触发源是已删的 BRANCH_STOP_RE 字面快
      // 路径，裁决器契约不携带 mode——点名停支一律按「收掉一项=暂停」落地
      // （复测案例二口径：活口比中止大，误停可逆、说一声就续上）。
      const target = decision.signals.addsAlong === true
        ? null
        : this.resolveStopTarget(decision);
      const stopped = target ? this.deps.stopBranchByCallId(target, 'pause') : null;
      if (stopped) {
        echoUserBubble();
        // 停/暂停是宿主已完成的动作（sync 已落），结果由支状态卡呈现
        // （2026-10-28 刀 2：branchStopReceipt 固定话术已删）——裁决器现
        // 场写了 receipt 就转达，缺席沉默，绝不出机械腔。
        this.deps.settleAck(ack, receipt ?? null);
        return;
      }
      // 没停成（裁决器没指认/指认已结算/执行缝缺席）：退回取消折入——
      // 宁可折叠不误杀。折入只守汇报步；同回合父若再为这个话题派工，
      // 起飞闸（挂号簿）在出生点拦下。
      this.deps.delegation.registerCancel(text);
      // 缺口②扩窗：没停成的取消臂也点名了话题——若它同时命中某支**已收
      // 工**的支，登记进离场账（在飞支停没停成不影响已收工支的产出离场）。
      this.stripSettledTarget(text);
      // stopMissed=true：支还在飞、但没停成（没指认/闸生效/编排器缺位）
      // ——收执必须如实说「没停」，不许说「其余照常」了事（收执纪律）。
      this.deps.foldInScopeAddition(text, images, displayText, false, ack, true, true);
      return;
    }
    // 整理窗（委派收齐、汇总未完）的取消：无支可停，但「不进最终汇总」
    // 这个承诺此刻真实在场——折 cancelFoldInstruction 进汇聚轮（剔除后
    // 重整）。收执只说砍了什么——foldInScopeAddition 自带收执；起飞闸照挂。
    // 回显挪进 else 臂：foldInScopeAddition 自带用户气泡回显，臂头统一
    // echo 会让整理窗分支出双气泡（2026-10-20 真机「不要优酷了」×2）。
    this.deps.delegation.registerCancel(text);
    // 缺口②扩窗（第 6 期）：不再只在整理窗剔——任何取消臂只要点名命中
    // 已收工支就登记（登记保证回合收尾补剔与下一轮装配兜底）。
    this.stripSettledTarget(text);
    if (this.deps.atAggregationWindow()) {
      this.deps.foldInScopeAddition(text, images, displayText, false, ack, true, false, receipt);
    } else {
      echoUserBubble();
      // 插话落在委派出生之前（2026-09-26 用户实测）：此刻无支可停，话
      // 挂上起飞闸——委派批次出生时按区分词拦下被取消的那支；同时照旧
      // 转达父引擎，父在派工前读到的话计划本身就会少这一路（闸是保底，
      // 不是唯一手段）。收执（2026-10-28 刀 2）：cancelBeforeDispatchReceipt
      // 固定话术已删——机制承诺（可能压根没有委派可派）不进收执，裁决
      // 器现场写了就转达，缺席沉默。
      try { appendTrace({ type: 'cancel_before_dispatch', snippet: text.slice(0, 80) }); } catch {}
      this.deps.steerRunningTurn(text, images, null, 'parent', true);
      this.deps.settleAck(ack, receipt ?? null);
    }
  }

  /**
   * change 臂（推翻/改向/整停，蓝图 §六）：先确定影响再行动（《设想》§一）。
   * ① 字面整停（rule 通道，action=stop）：停手不重排，不押账（用户说的是
   *    「停」，不是「重来」）。
   * ② 专门信号（点名撤支/停支）：机械动作比整树重排精细，走 stopish 落地。
   * ③ targets_constraint 在场且任务状态可折：对着状态投影定位被替换条件
   *    挂着的节点，按节点态拆——进行中暂停、已完成冻结、未开始不再启动；
   *    机械处置不了的（定位不到/投影缺席）宁停不猜。
   * ④ 其余（推翻/改向判词）：真暂停链——押账重入，新回合开场 = 用户原话。
   */
  private async changeArm(
    text: string,
    images: MessageImage[],
    displayText: string,
    ack: InterjectAck,
    receipt: string | undefined,
    decision: DynamicInsertionDecision,
    echoUserBubble: () => void,
  ): Promise<void> {
    // ① 整树停：裁决器判 action=stop（2026-10-28 刀 1：STOP_RE 字面快路径
    // 已删，「停」的语义判断归裁决器，宿主只留 abort 掐流的机械动作）——
    // 停手，不重排。整树停不重入 send()（没有 held insert），原话回显补在
    // 这里，别让转写对不上谁说了什么。
    if (decision.action === 'stop') {
      echoUserBubble();
      // 停的收执随裁决走（receipt 缺席沉默）——abort 掐流本身由状态呈现。
      this.deps.settleAck(ack, receipt ?? null, true, 'info');
      this.deps.abort();
      return;
    }
    // ② 专门信号：点名撤一支/停一支——宿主执行比整树暂停精确。
    const dedicated = decision.signals.cancelsPart === true
      || typeof decision.signals.stopBranchCallId === 'string';
    if (dedicated) {
      await this.stopishArm(text, images, displayText, ack, receipt, decision, echoUserBubble);
      return;
    }
    // ③ targets_constraint：对着任务状态投影定位影响面。
    const targets = typeof decision.signals.targetsConstraint === 'string'
      ? decision.signals.targetsConstraint.trim()
      : '';
    const snapshot = targets ? this.deps.taskStateSnapshot?.() ?? null : null;
    if (targets && snapshot) {
      const affected = this.locateAffected(snapshot, targets);
      if (affected.length > 0 && await this.disposeAffected(affected, text, images, ack, receipt, echoUserBubble)) {
        return;
      }
      // 定位不到（约束对不上账/节点无支可停可冻）：落到真暂停，宁停不猜。
    }
    // ④ 推翻/改向判词：真暂停链。不在这里回显——held insert 从 send() 重入
    // 时会作为新回合开场气泡上屏，先回显再重入 = 同一句话上两遍。收执交给
    // truePause 按在飞事实二分（PAUSE 说「暂停存档」，直路说止损）。
    this.truePause(text, images, displayText, ack, receipt);
  }

  /**
   * 约束定位（change 臂 ③ 的第一步）：targets_constraint 是被替换条件的
   * 原文片段，任务状态账里的约束条目也记着原文——按文本包含关系对上号
   * （约束记账本来就摘自用户/计划原话，此处是账本对账，不是语义判断）。
   * 对不上号返回空集，调用方宁停不猜。
   */
  private locateAffected(snapshot: TaskStateSnapshot, targets: string): ReturnType<typeof affectedByChange> {
    const ids = snapshot.constraints
      .filter((c) => {
        const ct = c.text.trim();
        return ct.length > 0 && (targets.includes(ct) || ct.includes(targets));
      })
      .map((c) => c.id);
    return affectedByChange(snapshot, { constraintIds: ids });
  }

  /**
   * 影响面机械处置（change 臂 ③ 的第二步）：按节点态拆——进行中的支暂停
   * （checkpoint 照存）、已完成的产出冻结（不进后续请求）、未开始的拦截
   * （起飞闸 + 转达父引擎）。返回 false = 没有任何机械动作可做（定位到的
   * 节点都无支可停/无账可冻），调用方落到真暂停。收执逐项如实点名。
   */
  private async disposeAffected(
    affected: ReturnType<typeof affectedByChange>,
    text: string,
    images: MessageImage[],
    ack: InterjectAck,
    receipt: string | undefined,
    echoUserBubble: () => void,
  ): Promise<boolean> {
    const running = affected.filter((n) => n.state === 'running' && typeof n.branchCallId === 'string' && n.branchCallId.length > 0);
    const done = affected.filter((n) => n.state === 'done');
    const pending = affected.filter((n) => n.state === 'pending');
    if (running.length === 0 && done.length === 0 && pending.length === 0) return false;
    echoUserBubble();
    // 进行中：逐支暂停（活口比中止大——说一声就能续）。
    const stoppedLabels: string[] = [];
    for (const node of running) {
      const stopped = this.deps.stopBranchByCallId(node.branchCallId as string, 'pause');
      if (stopped) stoppedLabels.push(stopped);
    }
    // 已完成：副作用冻结（写操作标记 frozen，产出不再被后续引用/补偿踩到）。
    const frozen = done.length > 0 ? this.deps.freezeSideEffects?.() ?? [] : [];
    // 未开始：挂起飞闸（同回合再为这个话题派工时出生点拦下）+ 转达父引擎。
    if (pending.length > 0) this.deps.delegation.registerCancel(text);
    this.deps.steerRunningTurn(text, images, null, 'parent', pending.length > 0,
      typeof receipt === 'string' ? receipt : undefined);
    const parts: string[] = [];
    if (stoppedLabels.length > 0) parts.push(`「${stoppedLabels.join('」「')}」先暂停了，断点都存着`);
    if (frozen.length > 0) parts.push(`已完成的 ${frozen.length} 项产出先冻结，不进后续`);
    if (pending.length > 0) parts.push('还没开工的部分不再启动');
    // parts 是宿主独有的机制账（停了哪些支/冻几项/不启动几件），模型 receipt
    // 写不出——保留为最小事实句；「收到——/按调整后的来」应答包装随刀 2 删。
    this.deps.settleAck(ack, receipt ?? (parts.length > 0 ? `${parts.join('；')}。` : null), true, 'info');
    return true;
  }

  /**
   * correction 臂（理解纠偏）：押账重入但**不掐流**——纠偏经转向通道转达，
   * 模型在下一个 THINK 边界自己回退理解，手头的活不停（纠偏错一层就该在
   * 执行里修，不值得整树暂停）；整段重入的兜底由回合收尾 settleRound 的
   * 残留原话重入承担，回合已收尾则它自然成为重入开场。
   */
  private correctionArm(
    text: string,
    images: MessageImage[],
    ack: InterjectAck,
    receipt: string | undefined,
    echoUserBubble: () => void,
  ): void {
    echoUserBubble();
    if (this.deps.hasDelegationInFlight()) {
      this.deps.steerRunningTurn(text, images, ack, this.matchSteerRecipient(text), false, receipt);
    } else {
      this.deps.steerRunningTurn(text, images, ack, 'parent', false, receipt);
    }
    this.deps.settleAck(ack, receipt ?? null, true, 'info');
  }

  /**
   * misunderstanding 臂（方向理解错了）：真暂停的双重触发之二——先自查
   * （当前输出忠实于用户上一句吗），**确认跑偏才真暂停**；自查链路坏了或
   * 没确证 → 降级为转达，绝不拿坏链路当暂停依据（错杀整树比错跑一段代价
   * 大）。自查判词来自 checkOutputFaithfulness（三要素现场 + 窄问题）。
   */
  private async misunderstandingArm(
    text: string,
    images: MessageImage[],
    displayText: string,
    ack: InterjectAck,
    receipt: string | undefined,
    decision: DynamicInsertionDecision,
    insertionCtx: string,
    echoUserBubble: () => void,
  ): Promise<void> {
    const verdict = await this.deps.decider.selfCheckDrift(
      this.deps.decideLlm(), insertionCtx, text, this.deps.decideSignal(),
    );
    if (verdict?.drifting === true) {
      // 自查坐实跑偏→真暂停。收执随裁决走（receipt 缺席沉默）：drift 理由
      // 是模型侧信息，裁决器 receipt 契约会带；宿主不再拼固定腔。
      this.truePause(text, images, displayText, ack, receipt);
      return;
    }
    // 降级：按普通转达走（自查没确证 = 不配整树暂停）。
    try {
      appendTrace({
        type: 'self_check_unconfirmed',
        snippet: text.slice(0, 80),
        verdict: verdict ? (verdict.drifting ? 'drift' : 'faithful') : 'unavailable',
      });
    } catch { /* 遥测失败不碰主流程 */ }
    echoUserBubble();
    if (this.deps.hasDelegationInFlight()) {
      this.deps.steerRunningTurn(text, images, ack, this.matchSteerRecipient(text), false, receipt);
    } else {
      this.deps.steerRunningTurn(text, images, ack, 'parent', false, receipt);
    }
    this.deps.settleAck(ack, receipt ?? null, true, 'info');
  }

  /**
   * mixed 臂（一句话多个关系）：原子分流。破坏性原子主导（change/
   * misunderstanding/correction 任一在场）→ 整条消息按该关系的处置臂走
   * （原子文本是片段，拆开执行会丢上下文；破坏优先保命）；无破坏性 →
   * 转达类合并为一次转达（整句原文带现场），排队类逐条入队，提问逐条旁答。
   * 全都认不出 → 按普通转达兜底，话不丢。
   */
  private async mixedArm(
    text: string,
    images: MessageImage[],
    displayText: string,
    ack: InterjectAck,
    receipt: string | undefined,
    decision: DynamicInsertionDecision,
    queuePriority: number,
    insertionCtx: string,
    echoUserBubble: () => void,
  ): Promise<void> {
    const atoms = decision.atoms ?? [];
    const dominant = (['change', 'misunderstanding', 'correction'] as const)
      .find((r) => atoms.some((a) => a.relation === r));
    if (dominant) {
      const dominantDecision: DynamicInsertionDecision = { ...decision, relation: dominant };
      if (dominant === 'change') {
        await this.changeArm(text, images, displayText, ack, receipt, dominantDecision, echoUserBubble);
      } else if (dominant === 'misunderstanding') {
        await this.misunderstandingArm(text, images, displayText, ack, receipt, dominantDecision, insertionCtx, echoUserBubble);
      } else {
        this.correctionArm(text, images, ack, receipt, echoUserBubble);
      }
      return;
    }
    // 无破坏性：逐原子各归各臂。转达类有 → 整句转达（带着全话转，模型自己
    // 对应到各原子）；排队类逐条入队；提问逐条旁答。
    const steerish = atoms.some((a) => a.relation === 'supplement' || a.relation === 'emphasize' || a.relation === 'meta');
    const newTasks = atoms.filter((a) => a.relation === 'unrelated');
    const questions = atoms.filter((a) => a.relation === 'question');
    if (!steerish && newTasks.length === 0 && questions.length === 0) {
      // 原子缺席/全认不出：按普通转达兜底。
      await this.steerArm(text, images, displayText, ack, receipt, decision, echoUserBubble);
      return;
    }
    echoUserBubble();
    if (steerish) {
      if (this.deps.hasDelegationInFlight()) {
        this.deps.steerRunningTurn(text, images, ack, this.matchSteerRecipient(text), false, receipt);
      } else {
        this.deps.steerRunningTurn(text, images, ack, 'parent', false, receipt);
      }
    }
    for (const q of questions) {
      void this.deps.answerMidrunQuestion(q.text, images);
    }
    for (const t of newTasks) {
      this.deps.queueInterjectTask(t.text, images, t.text, queuePriority);
    }
    const parts: string[] = [];
    if (steerish) parts.push('要调整的已带上');
    if (newTasks.length > 0) parts.push(`新派的 ${newTasks.length} 件排上队了`);
    if (questions.length > 0) parts.push('问题这就答');
    // mixed 臂的 parts 同 changeArm：宿主独有机制账留最小事实句，应答包装删。
    this.deps.settleAck(ack, receipt ?? (parts.length > 0 ? `${parts.join('，')}。` : null), true, 'info');
  }

  /**
   * unrelated/new_task 臂（要回来的新活）：取消复核撞车 → 阶段感知折入/
   * 排队。整段自旧 task 臂原样迁移，判定面换成 relation（kind 不再参与）。
   */
  private async newTaskArm(
    text: string,
    images: MessageImage[],
    displayText: string,
    ack: InterjectAck,
    receipt: string | undefined,
    decision: DynamicInsertionDecision,
    queuePriority: number,
    insertionCtx: string,
    echoUserBubble: () => void,
  ): Promise<void> {
    // 不重复做（2026-09-25 复测案例一）：加的活若某支在飞/已收工的支已
    // 经覆盖（「新增一个平台，爱奇艺」而爱奇艺那路正在跑），如实回「已
    // 经在跑/已在汇总里」，不重复派也不折入——重复派一支是白烧算力还
    // 污染汇总。只认区分性命中（1a 同款纪律）：打平认不出 = 宁可照旧
    // 折入，绝不拿"可能重复"当理由吞用户的活。
    const covered = this.findCoveringBranch(text);
    if (covered) {
      // 2026-10-20 真机三连击的复核裁决（替换当日试过的词表闸——用户指
      // 得对：取消的措辞穷举不尽，词表永远追着漏网跑）。判成新活却撞
      // 上"已在跑"本身就是矛盾信号——谁会要求加一个正在跑的东西？最可
      // 能的解释恰是漏报的取消。宿主不猜措辞，把现场事实喂回复核单独问
      // 一遍。2026-10-21 真机二连：同一 system 下重问仍判新活（<dedupe_
      // conflict> 块在 system 里零契约被当噪声，二次锚定原判）——复核改
      // 走独立窄问题提示词（decider.recheckCovered），<dedupe_conflict>
      // 升为顶层块进 system 契约，举证责任倒置。报了取消走同一条取消落
      // 地臂（点名还能精确停支）；复核失败/不报才回终稿——真加活照旧秒
      // 回。语义判断全程归模型，宿主零词表。
      const coveredName = this.deps.branchLabel(covered.name, covered.callId);
      const conflictNote = `你刚把这句话判成「新增任务」，但它点到的活已有一支在跑：「${coveredName}」（call_id=${covered.callId}）。没人会要求加一个正在跑的东西——复核这句话是不是其实在收掉/暂停这支在跑的活。`;
      const recheck = await this.deps.decider.recheckCovered(this.deps.decideLlm(), insertionCtx, conflictNote, { text, images, displayText }, this.deps.decideSignal());
      if (recheck) this.deps.logDecision(recheck, `(复核)${text}`);
      if (recheck?.signals.cancelsPart === true) {
        // 收执只取复核现场写的（它见到的是矛盾现场）；原判是「新活」时
        // 它写的收执是加活口径，用在取消臂就是说谎——宁缺，fold 臂有固
        // 定兜底。
        const recheckReceipt = typeof recheck.signals.receipt === 'string' && recheck.signals.receipt.trim()
          ? recheck.signals.receipt
          : undefined;
        await this.handleCancelFold(text, images, displayText, ack, recheckReceipt, recheck, echoUserBubble);
        return;
      }
      if (recheck === null && covered.status === 'running') {
        // 2026-10-21 真机三连（用户定调「方向性问题，大 bug」）：复核超
        // 时/失败 = 没结论，旧兜底「宁可照旧」在取消场景方向反了——用户
        // 说了「不需要」却被任其继续跑，等于当着用户的面背叛，且不可逆；
        // 误停一支是可逆的（说一声就续上）。拿不准时选可逆的一边：直接
        // 暂停 covered 那支（callId 是 covered 命中给的宿主事实，不需要
        // 模型点名），收执诚实交代没拿准+给出恢复口。只有复核**明确判
        // 加活**（recheck 非 null 且不报取消）才配「不重复派」终稿。
        const stopped = this.deps.stopBranchByCallId(covered.callId, 'pause');
        if (stopped) {
          try { appendTrace({ type: 'covered_recheck_unresolved_pause', snippet: text.slice(0, 80) }); } catch {}
          echoUserBubble();
          this.deps.settleAck(ack, branchUncertainPauseReceipt(coveredName));
          return;
        }
        // 停不成（窗口刚好收尾）→ 落到下方终稿：活已不在跑，无方向性伤害。
      }
      echoUserBubble();
      // 去重回执是终稿（没有后续在途）——转普通气泡。
      this.deps.settleAck(ack, covered.status === 'done'
        ? `这个刚才已经跑完了——「${coveredName}」那路的结果就在汇总里，不重复派。`
        : `您说的这个正在「${coveredName}」那路跑着，不重复派——收齐后一并汇总给您。`);
      return;
    }
    // 阶段感知（2026-09-22 用户定稿；整理窗口 2026-10-15 用户定调改派）：
    // ① B 窗（并行委派在飞）：插进来的追加活不进"当前任务完成后处理"的
    //   队列——那会先输出一份没有它的汇总。折入汇合轮：收齐后先补这项，
    //   再合并输出一份覆盖全部的汇总。
    // ② C 窗（委派收齐、汇总还在整理）：追加折入汇聚轮——暂停汇总、保留
    //   中间结果，把这项像其他委派一样补跑，返回后重整一份覆盖全部的
    //   输出（样本「新增平台」C 档口径；旧定稿「先出已有汇总再补跑」的
    //   两段输出被明确推翻）。收尾核验没折入就转排队兜底，机制已有。
    // ③ 单任务流（本就没派过委派）：没有汇合轮可折，照旧排队。
    if (this.deps.hasDelegationInFlight() || this.deps.atAggregationWindow()) {
      this.deps.foldInScopeAddition(text, images, displayText, true, ack, false, false, receipt); // scope 追加：机械执行
    } else {
      // 排队沉默（2026-10-28 刀 2）：queuedReceipt/queuedUrgentReceipt 固定
      // 话术已删——队列卡逐条可见（原话在卡上），重入时 queuedHandoffText
      // 交接框架带语境，引擎不再发音讯。urgent 提级信号照旧随 queuePriority
      // 过河（急件排队头、带「急」标），只是不出声。
      this.deps.discardAckRow(ack);
      this.deps.queueInterjectTask(text, images, displayText, queuePriority);
    }
  }

  /** 1a 定向投递 — 宿主供在飞分支视图（agentActivities 投影，观测单向，
   * 不另立注册表），纯匹配器判断用户这句话点名了哪一支。返回 'all' =
   * 没点名，按广播处理。 */
  private matchSteerRecipient(text: string): SteerTarget {
    const matched = matchInFlightBranch(text, this.deps.runningBranches());
    return matched ? { branchCallId: matched.callId, branchName: matched.name } : 'all';
  }

  /**
   * 停支目标指认（模型判断、宿主执行，2026-10-10）。「停哪支」是理解，
   * 归裁决器；宿主只核实执行：分类时上下文带着 <live_branches> 花名册，
   * 裁决器点 stopBranchCallId 确切 id——这里只校验它还在飞（否则当没指
   * 认）。裁决器**没**指认 = 它的判断就是「无所指/真模糊」，宿主不越权改
   * 判。旧的单支集合兜底与聚焦点名窄问（resolveStopBranchTarget）是
   * STOP_RE/BRANCH_STOP_RE 规则快路径的宿主侧残留，随刀 1 一并清。
   * 返回 null = 没指认出来，调用方退回取消折入（宁可折叠不误杀）。
   */
  private resolveStopTarget(decision: DynamicInsertionDecision): string | null {
    // 没有确切 callId 的投影条目（迟到事件/缺字段）不进指认面——宁可不指认。
    const live = this.deps.runningBranches().filter((b) => typeof b.callId === 'string' && b.callId.length > 0);
    const named = decision.signals.stopBranchCallId;
    return typeof named === 'string' && live.some((b) => b.callId === named) ? named : null;
  }

  /** 分支级继续（第 2 期第三刀；2026-10-28 刀 1 重构触发面）：裁决器从花名
   *  册点名一支**已暂停/已停**的委派（signals.resumesBranchCallId），宿主只
   *  核实执行——callId 真实在停止面（stoppedBranches 投影）里、原始参数还
   *  押在账上（delegationArgs），就按**原始参数**排队同参重派：稳定 sessionId
   *  命中 checkpoint，子引擎走 continue 而不是从头 run。旧的 1a 区分词点名
   *  是 RESUME_BRANCH_RE 快路径的宿主侧残件，随刀 1 拆除——点名的理解归裁
   *  决器，宿主零字面匹配。候选 = 已暂停/已取消的支（在飞的支走 steer，已
   *  完成的支结果已在汇总，无需重跑）。核实不过（点错 id/参数缺失/重复点
   *  名）返回 null，调用方按普通插话处理（落回普通 steer），绝不猜。返回被
   *  续支的展示名（含同名序号）+ checkpoint 预检凭据（收执诚实二分用）。凭
   *  据与去重记账在 DelegationControlPlane。 */
  private resumeNamedBranch(callId: string, text: string): { label: string; checkpoint: { hit: boolean; turns: number } } | null {
    const matched = this.deps.stoppedBranches().find((b) => b.callId === callId);
    if (!matched) return null;
    const original = this.deps.delegation.delegationArgs.get(matched.callId);
    if (!original) return null;
    const label = this.deps.branchLabel(matched.name, matched.callId);
    // 预检先行、凭据随记录走：排队收执、派工收执、兜底指令三处按同一份
    // 预检二分——命中说从第 N 轮接，没命中明说从头跑，绝不预支断点承诺。
    const checkpoint = this.deps.probeResume(original.name, original.args);
    // 排队同参重派：同一支只排一次——重复点名按「点不出」退回，调用方
    // 落回普通 steer。
    if (!this.deps.delegation.queueResume({ callId, name: original.name, args: original.args, label, text, images: [], checkpoint })) return null;
    return { label, checkpoint };
  }

  /** 不重复做（2026-09-25 复测案例一）：这句加活是否已被某支覆盖。匹配面
   * 与点名停同源（1a 区分词匹配器：名+角色+任务书片段，只认区分性命中），
   * 范围扩到已收工的支（结果已经在汇总里的，同样不重派）。返回 null =
   * 没认出覆盖，照旧折入/排队——宁可重复问一句，绝不吞用户的活。 */
  private findCoveringBranch(text: string): { name: string; callId: string; status: 'running' | 'done' } | null {
    const candidates = this.deps.coveringCandidates();
    const matched = matchInFlightBranch(text, candidates);
    if (!matched) return null;
    const hit = candidates.find((item) => item.callId === matched.callId);
    return hit ? { name: hit.name, callId: hit.callId, status: hit.status } : null;
  }

  /** 取消话的落地臂（2026-09-24 取消案例口径，2026-10-20 抽出共用）：点名
   *  点得中就真停（pause），停不了按取消型折入守汇报步；委派不在飞交给
   *  在跑的回合自己消化，整理窗折入汇聚轮，出生前挂起飞闸+转达父引擎。
   *  case 'task' 的 cancelish 主路与去重复核（2026-10-20 三连击）共用——
   *  复核判定报了 cancels_part 就走同一条落地路，不另起分支。 */
  private async handleCancelFold(
    text: string,
    images: MessageImage[],
    displayText: string,
    ack: InterjectAck,
    receipt: string | undefined,
    decision: DynamicInsertionDecision,
    echoUserBubble: () => void,
  ): Promise<void> {
    if (this.deps.hasDelegationInFlight()) {
      const target = decision.signals.addsAlong === true ? null : this.resolveStopTarget(decision);
      const stopped = target ? this.deps.stopBranchByCallId(target, 'pause') : null;
      if (stopped) {
        echoUserBubble();
        // 宿主已完成暂停（sync 已落），结果由支状态卡呈现（2026-10-28 刀 2：
        // branchStopReceipt 固定话术已删）——裁决器现场写了 receipt 就转达，
        // 缺席沉默，绝不出机械腔。
        this.deps.settleAck(ack, receipt ?? null);
        return;
      }
      // 没指认出来的取消折入：折入守汇报步，挂号守同回合再出生的支。
      // stopMissed=true（同 steer 分支）：收执如实说「没停」。
      this.deps.delegation.registerCancel(text);
      // 缺口②扩窗：同 steer 没停成臂——点名也可能命中一支已收工支，
      // 登记进离场账（在飞支没停成不挡已收工支的产出离场）。
      this.stripSettledTarget(text);
      this.deps.foldInScopeAddition(text, images, displayText, false, ack, true, true);
      return;
    }
    // 整理窗的取消折入汇聚轮（同 steer 取消口径，2026-10-15 样本
    // 「剔除并继续」）；委派还没出生（2026-09-26 用户实测窗口）：话挂
    // 起飞闸 + 转达父引擎。
    // 回显挪进 else 臂（同 steer 整理窗臂）：fold 自带用户气泡，臂头
    // 统一 echo 让整理窗分支出双气泡（2026-10-20 真机）。
    this.deps.delegation.registerCancel(text);
    // 缺口②扩窗（第 6 期）：与上方 steer 取消臂同形——不再只在整理窗
    // 剔，任何取消臂都先登记已收工支的离场。
    this.stripSettledTarget(text);
    if (this.deps.atAggregationWindow()) {
      this.deps.foldInScopeAddition(text, images, displayText, false, ack, true, false, receipt);
    } else {
      echoUserBubble();
      // 出生前取消（同 stopishArm 同名臂，2026-10-28 刀 2）：固定话术已删，
      // 裁决器现场写了 receipt 就转达，缺席沉默——起飞闸 + 转达是机制事实，
      // 不进收执。
      try { appendTrace({ type: 'cancel_before_dispatch', snippet: text.slice(0, 80) }); } catch {}
      this.deps.steerRunningTurn(text, images, null, 'parent', true);
      this.deps.settleAck(ack, receipt ?? null);
    }
  }

  /** 缺口②机械排除（2026-10-15，第 6 期扩窗）：点名取消点中了某支**已收工**
   *  的支时，把那路的产出从父上下文里整体剔除（换墓碑），并把它的 callId 登
   *  记进宿主的离场账——「不进后续请求」从 cancelFoldInstruction 的劝阻升格
   *  为数据不在场，与在飞停支「结算体不带产出」的机制强制抹平不对称。匹配
   *  纪律复用点名续跑的先例（1a 区分词匹配器：只认区分性命中，打平/认不出
   *  = 宁可漏剔不误剔，fold 的提示词约束照旧兜底）；候选只认产出已回的支
   *  （settledBranches——暂停/停掉的支结算不带产出，无从剔除）。
   *  登记与即时剔除解耦：同回合 settle 的支此刻结果还没进 this.messages，
   *  即时剔除落空（返回 false），登记让回合收尾补剔与下一轮装配兜底兑现。
   *  fold 不因此省：最终汇总宣布「已取消」的职责仍在框架文本里。返回是否即
   *  时剔中——调用方**不得**据此预支「已剔除」收执（收执链本就不声称剔除，
   *  扩窗后也不加）。 */
  private stripSettledTarget(text: string): boolean {
    const matched = matchInFlightBranch(text, this.deps.settledBranches());
    if (!matched) return false;
    this.deps.registerStrippedBranch(matched.callId, text);
    if (this.deps.stripSettledBranchOutput(matched.callId)) {
      try { appendTrace({ type: 'cancel_strip_settled', snippet: text.slice(0, 80) }); } catch {}
      return true;
    }
    return false;
  }

  // ── 思考窗寄存器的宿主面（send() 重启循环 / planByThinking / 上下文投影用）─

  /** 窗开在 planByThinking 前、关在 finally（抛了也关）——整个预检循环期间
   * 吸收分支都能接住新插话。新窗的第一轮是原思考轮：攒批寄存器归零。 */
  openPreflightWindow(): void {
    this.planPreflightActive = true;
    this.preflightRethinkInFlight = false;
  }

  /** 刀 3.1：宿主并账重开时挂号——接下来在飞的思考轮是重想轮，此间新到
   * 的补充走攒批（只入暂存不掐流）。 */
  markPreflightRethink(): void {
    this.preflightRethinkInFlight = true;
  }

  closePreflightWindow(): void {
    this.planPreflightActive = false;
  }

  /** 每轮新思考开局：挂上在飞流把手（吸收分支掐它）、清重启请求与叙述尾
   * （旧轮的尾巴对新轮是假证据）。 */
  beginPreflightThought(ac: AbortController): void {
    this.preflightAbort = ac;
    this.preflightRestartRequested = false;
    this.preflightNarrationTail = '';
  }

  endPreflightThought(): void {
    this.preflightAbort = null;
  }

  wasPreflightRestarted(): boolean {
    return this.preflightRestartRequested;
  }

  clearPreflightRestart(): void {
    this.preflightRestartRequested = false;
  }

  setPreflightNarrationTail(tail: string): void {
    this.preflightNarrationTail = tail;
  }

  preflightNarrationTailView(): string {
    return this.preflightNarrationTail;
  }

  preflightWindowActive(): boolean {
    return this.planPreflightActive;
  }

  pendingPreflightCount(): number {
    return this.pendingPreflightSupplements.length;
  }

  /** 并账消费（splice 语义）：宿主把取走的补充并进请求正文（【你在思考时
   * 补充】块，图随文走）。 */
  takePreflightSupplements(): Array<{ text: string; images: MessageImage[] }> {
    return this.pendingPreflightSupplements.splice(0);
  }

  /** 只读视图（分类上下文投影用——连续插话不丢账）。 */
  pendingPreflightView(): ReadonlyArray<{ text: string; images: MessageImage[] }> {
    return this.pendingPreflightSupplements;
  }

  /** 新会话清场：窗、暂存、在飞把手、重启请求、攒批寄存器、叙述尾一并归零。 */
  resetPreflight(): void {
    this.pendingPreflightSupplements = [];
    this.planPreflightActive = false;
    this.preflightAbort = null;
    this.preflightRestartRequested = false;
    this.preflightRethinkInFlight = false;
    this.preflightNarrationTail = '';
  }
}
