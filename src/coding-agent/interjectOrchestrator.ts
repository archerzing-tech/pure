// src/coding-agent/interjectOrchestrator.ts
// 插话并线/另线改版（2026-10-28，docs/interjection-inline-sideline.md 刀 B）：
// classifyAndApply 从九类分发收缩为三臂——判定契约三值化（A 刀）后宿主不再
// 替模型做语义细分（转向/追加/纠正/取消一部分/改向全部原话直投，主线模型下
// 一轮自行消化），宿主保留的只是机械动作与核实：
//   - inline 臂：点名续支（resumes_branch 同参重派）→ 覆盖去重（call_id 核实
//     + 加活撞车复核）→ 点名停支（stop_branch 宿主暂停）→ 整树停（action:stop
//     掐流）→ 原话直投（思考流在飞掐流重入 / 工具期下一 THINK 边界消化）。
//   - sideline 臂：旁答管线（echo 已在入口；答不上原话按并线退化）。
//   - new_task 臂：排队（收尾后自动开新轮），撞车先过复核。
// 嘴/手分开（细化 1）：思考流在吐字 → abortReenter 掐流，插话入 steerBus，
// 新回合第一个 THINK 边界自然注入；工具/支在飞 → 不打断。
//
// holdGate 软暂停闸 / 真暂停押账重入（roundClose.holdInsert）/ 任务状态投影
// （change 臂③）/ selfCheckDrift 自查 / 九类处置表（change/correction/
// misunderstanding/mixed/newTaskArm/旧 steerArm/handleCancelFold）随本刀退役
// ——并线路流已断无闸可扣，取消的消化归主线模型。
//
// 此前这一整套焊死在 chat.ts（GUI 控制器）。S3 的前置硬约束：判定只有一
// 份、控制面是无宿主状态依赖的决策核——本模块把决策核搬出来，DOM（ack 行/
// 回显/收执/事件日志/控制台诊断）、LLM 产出（旁答/追问）、铺排（折入框架/
// 转向框架/队列卡）与引擎把手（abort/真停支）经依赖缝留给宿主。宿主读数
// （流态/在飞/分支视图）全部注入，决策核不猜宿主状态。
//
// ack 句柄不透明（InterjectAck = unknown）：宿主给什么还什么——GUI 是
// HTMLElement，通道宿主可以是任何东西。收执话术的单一事实来源仍在
// insertionMessaging（本模块只引用，不内联第二份）。

import { DynamicInsertionCoordinator, type DynamicInsertionDecision } from './DynamicInsertionCoordinator';
import { needsClarification, isDestructiveAction, type InputAction, type InputTiming } from './inputDecision';
import { matchInFlightBranch, type SteerTarget, type InFlightBranch } from '../shared/steerTargeting';
// 收执纪律（2026-10-28 框架改革刀 2）：收执 = 裁决器现场写的 receipt 唯一来源，
// 缺席时引擎沉默。这里只保留判例背书的事实播报（branchUncertainPauseReceipt）
// 与续跑诚实二分（branchResumeReceipt，checkpoint 命中与否只有宿主知道）。
import { branchResumeReceipt, branchUncertainPauseReceipt } from '../shared/insertionMessaging';
import { priorityForLevel, type ProcessingLevel } from '../shared/scheduling';
import type { DelegationControlPlane } from './delegationControl';
import type { MessageImage, LLMAdapter } from '../shared/types';
import { detectTaskKind, isFileMutating } from '../shared/taskKind';
import { appendTrace } from '../evolution/trace';
import type { InterjectionIngress } from './interjectionPort';

/** 插话临时回执句柄：不透明（宿主投影）。 */
export type InterjectAck = unknown;

/** 覆盖去重的匹配面：1a 同款字段 + 终态（已收工的支结果已在汇总里）。 */
export type CoveringBranch = InFlightBranch & { status: 'running' | 'done' };

export interface InterjectOrchestratorDeps {
  // ── 决策引擎与账本（宿主无关模块直连）─────────────────────────────
  decider: DynamicInsertionCoordinator;
  delegation: DelegationControlPlane;

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
  /** 阶段 C 窗口（并行委派都收齐、汇总还没写完的整理窗）：取消在这个窗口
   *  不排队——折入汇聚轮（剔除后再重整）。单任务流不在此窗口。 */
  atAggregationWindow(): boolean;
  /** 续跑预检（第 2 期第三刀）：同参重派会不会命中 checkpoint（编排器
   *  probeResumeCheckpoint 的同口径读数）。凭据缺失会让收执退回「无脑许愿
   *  从断点续」，正是要收掉的谎。 */
  probeResume(toolName: string, rawArgs: string): { hit: boolean; turns: number };

  // ── 嘴/手分开的引擎读数与把手（细化 1）────────────────────────────
  /** 主流 THINK 流式请求是否在飞（模型正在吐字）。真 = 掐流重入（原话经
   *  steerBus 在新回合边界注入）；假 = 工具/支在飞，不打断，下一 THINK 边界
   *  消化。口径：只数主流 THINK 流（llmForPhase('THINK') 适配器的流式请求），
   *  旁答/judge 等非流式调用不计。 */
  isThinkingStreamActive(): boolean;
  /** 掐流重入（INTERJECT_REENTER_REASON abort）：引擎在 THINK 边界 yield
   *  Interrupted(reason='reenter')，宿主立即带 steer 队列重开思考。不落暂停
   *  账、不渲染停止态。 */
  abortReenter(): void;

  // ── 引擎动作缝（宿主生命周期）─────────────────────────────────────
  send(text: string, images: MessageImage[], displayText: string): void;
  abort(reason?: string): void;
  /** 模型点名、宿主执行（2026-10-10 重构）：callId 由裁决器从花名册里指认，
   *  宿主只按这个确切 id 真停——不做任何自己的文本匹配。支不在飞/已结算返回
   *  null，调用方退回取消折入。 */
  stopBranchByCallId(callId: string, mode: 'abort' | 'pause'): string | null;
  /** 转向通道入队 + 收执（框架文本与收执口径留宿主）。receipt（2026-10-28
   *  刀 2 收执纪律）：裁决器现场写的收执是唯一来源，宿主优先转达；缺席 =
   *  引擎沉默（机制状态由 UI 呈现），绝不出固定话术。 */
  steerRunningTurn(text: string, images: MessageImage[], ack: InterjectAck, target: SteerTarget, cancel: boolean, receipt?: string): void;
  /** 排队不相关插话（roundClose.queueTask + 补调度）。第 5 期调度：priority
   *  由调度级折算（见 shared/scheduling.ts）；缺省 = 队列级。 */
  queueInterjectTask(text: string, images: MessageImage[], displayText: string, priority?: number): void;
  /** 折入汇合轮的铺排（回显 + folds.add + 收执——铺排留宿主）。取消落地臂
   *  专用：点名停支没停成时折入守汇报步（stopMissed=true 收执如实说没停），
   *  或整理窗折入汇聚轮。加活不再走这里（原话直投/排队）。 */
  foldInScopeAddition(text: string, images: MessageImage[], displayText: string, mechanical: boolean, ack: InterjectAck, cancels: boolean, stopMissed?: boolean, receipt?: string): void;
  answerMidrunQuestion(text: string, images: MessageImage[]): Promise<void>;
  askMidrunClarification(decision: DynamicInsertionDecision, text: string, images: MessageImage[], ack: InterjectAck): Promise<void>;
  /** 输入自带执行时刻的排期 sink（false = 没接 sink 或拒收）。 */
  deferTimedInsert(timing: InputTiming, text: string, images: MessageImage[], displayText: string): boolean;

  // ── 投影缝（DOM/事件日志/控制台诊断；settleAck 系留宿主）─────────
  /** 插话回显气泡引用（C 刀后无临时状态行——ack 即回显锚与销账把手）。 */
  createAck(): InterjectAck;
  /** 收执落定：text=null = 引擎沉默——收执缺席时宁可无话，不出机械腔；
   *  机制状态由 UI（支状态卡）呈现。宿主只做退场（行摘掉 + 账上销账）。 */
  settleAck(ack: InterjectAck, text: string | null): void;
  /** 临时回执的直接退场（行摘掉 + 账上销账）。 */
  discardAckRow(ack: InterjectAck): void;
  /** 用户原话回显（插队到 ack 行正前——转写对得上谁说了什么）。 */
  echoUser(ack: InterjectAck, displayText: string, images: MessageImage[]): void;
  /** 裁决落定的投影：会话事件日志（insertion_classified）+ 控制台诊断。 */
  logDecision(decision: DynamicInsertionDecision, text: string): void;
}

// 插话端口契约见 interjectionPort.ts：本类是对接点（interject）与 P3 插入点
// （takePreflightSupplements）的持有者；类内裁决序/三臂分发/收执纪律全部属于
// 契约标注的「边界内可替换」面——后续换队列+注入式实现时端口签名不动。
export class InterjectOrchestrator implements InterjectionIngress {
  /** Serializes mid-run insert classifications. A second insert typed while
   * the first is still being judged must WAIT its turn — the caller has
   * already cleared the input box, so dropping the call would lose the
   * user's words for good. */
  private chain: Promise<void> = Promise.resolve();

  // ── 思考窗寄存器（原 chat.ts 五件，S2 第六刀迁入）───────────────────
  /** 阶段感知的吸收窗：预检思考（planByThinking）还在流式进行时，「改/补当前
   * 构图」的并线插话不占独立处置——并进请求推倒重想（约束长进构图里，不是旧
   * 思考上后贴）。吸收判据：verdict=inline 且无专门宿主信号。（窗口与吸收账
   * 在本编排器；并账进请求正文与铺排留宿主。） */
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
   * insert). 判完三值 verdict 后各归各臂（inline 消化 / sideline 旁答 /
   * new_task 排队）；专门宿主信号（点名停支/续支、整树停）在任何臂之前先
   * 消费——机械动作比语义分流精确。裁决不可用时协调器兜底 passthrough 原话
   * 直投：话一定送到，绝不猜。
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
    const ack = this.deps.createAck();
    try { appendTrace({ type: 'interject', snippet: text.slice(0, 80) }); } catch {}
    try {
      const run = this.chain.then(() => this.classifyAndApply(text, images, displayText, ack));
      // A rejected link must never poison the chain for later inserts.
      this.chain = run.catch(() => {
        this.deps.settleAck(ack, '未能处理这句插话；请重新发送。');
      });
      await run;
    } finally {
      // 判定链的异常不允许留悬账——ack 的退场由各分支负责，这里只兜底。
    }
  }

  /** One link of the interject chain: runs only after every earlier insert has
   * been judged. Re-checks isStreaming() because an earlier stop aborts the
   * turn — by the time this link runs, the insert may belong to a fresh send
   * instead. */
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
    // 插话确认的唯一形态是回显气泡（§〇 呈现层契约）：话已入流，静静躺在
    // 那。所有不重入 send() 的臂都在这里之前回显；收执按裁决纪律（receipt
    // 缺席 = 沉默）。
    const echoUserBubble = (): void => this.deps.echoUser(ack, displayText, images);
    // 分类器不可用（LLM 还没立起来）也照走 decide(null)：协调器的兜底是
    // passthrough 原话直投——话绝不因没有裁决器而失踪。裁决走 judgeLlm（关暗
    // 推理）而不是 turnLlm：开着思考时 8s 预算几乎必然超时，判定会整批落到
    // passthrough。turnLlm 是兜底（judgeLlm 没立起来时它至少让 decide 拿到
    // 一个 llm）。档位选择留宿主（decideLlm 缝）。
    const insertionCtx = this.deps.insertionContext(images);
    const decision = await this.deps.decider.decide(this.deps.decideLlm(), insertionCtx, { text, images, displayText }, this.deps.decideSignal());
    this.deps.logDecision(decision, text);
    // 判定遥测（2026-10-21 刀 F）：真机插话失败三连无法取证——logDecision
    // 只进内存调试面，trace 在 WebView 里曾是静默 no-op。判定结果同拍落
    // observations，事后可直接对质裁决器回了什么（verdict/关键信号/收执）。
    try {
      appendTrace({
        type: 'interject_decision',
        snippet: text.slice(0, 80),
        route: decision.verdict,
        reason: decision.reason,
        kind: decision.verdict,
        relation: decision.verdict,
        via: decision.signals.via,
        branchCallId: decision.signals.branchCallId,
        stopBranchCallId: decision.signals.stopBranchCallId,
        resumesBranchCallId: decision.signals.resumesBranchCallId,
        receipt: typeof decision.signals.receipt === 'string' ? decision.signals.receipt.slice(0, 120) : undefined,
      });
    } catch { /* 遥测失败不碰主流程 */ }
    // 现场收执：裁决器结合现场写的那句随信号走；缺席 = 引擎沉默（§〇）。
    const receipt = typeof decision.signals.receipt === 'string' && decision.signals.receipt.trim()
      ? decision.signals.receipt
      : undefined;
    // 第 5 期调度：处理级随裁决信号过河（三值处置表折出），裁决器的 urgent
    // 再折成提级——两个入队点共用同一个优先级读数，口径不漂。
    const urgent = decision.signals.urgent === true;
    const queuePriority = priorityForLevel(
      (decision.signals.processingLevel as ProcessingLevel | undefined) ?? 'queued',
      urgent,
    );
    if (this.deps.isAborted()) {
      // The turn was hard-stopped while we were classifying — don't drop the
      // insert; queue it so it still runs as a task.
      try { appendTrace({ type: 'interject_block', reason: 'aborted_during_classify', snippet: text.slice(0, 60) }); } catch {}
      this.deps.discardAckRow(ack);
      this.deps.queueInterjectTask(text, images, displayText, queuePriority);
      return;
    }
    // 输入级时间语义先于 verdict 生效：这句话自己报了执行时刻，那它现在就
    // 不该被执行——不管裁决器把它读成什么（stop 除外：停是立即的，timing 恒
    // 为 now）。少了这一步，"下午三点再跑一遍"会被当成当场追加的活跑掉。
    if (decision.timing.mode === 'at' && this.deps.deferTimedInsert(decision.timing, text, images, displayText)) {
      this.deps.discardAckRow(ack);
      return;
    }
    // 置信门消费（细化 5 置信偏置的宿主半边）：分类器明确报告没把握、且原始
    // 判定是破坏性的（只剩整树停），先把问题问出来，手头的活照跑。其余低置信
    // 一律按原 verdict 直投/排队——不破坏的误判自己能愈（排队晚点跑、旁答只
    // 答一次、并线下轮消化），照旧分发，不拿问题烦人；passthrough（via 标注
    // 投递策略）也在这里自然落进直投。
    const gatedFrom = decision.signals.gatedFrom;
    if (needsClarification(decision) && typeof gatedFrom === 'string' && isDestructiveAction(gatedFrom as InputAction)) {
      // 问询气泡接管对话（呈现层契约：无占位系统话），ack 由问询收编。
      echoUserBubble();
      void this.deps.askMidrunClarification(decision, text, images, ack);
      return;
    }
    // 专门宿主信号：点名续支/停支、整树停。机械动作比语义分流精确——三个
    // verdict 里带着这些信号的话都先走机械臂（串台形态：取消话被误判成
    // new_task 但报了 stop_branch，仍真停，绝不排队）。
    const hasDedicatedSignal = typeof decision.signals.stopBranchCallId === 'string'
      || typeof decision.signals.resumesBranchCallId === 'string'
      || decision.action === 'stop';
    if (hasDedicatedSignal) {
      await this.inlineArm(text, images, displayText, ack, receipt, decision, insertionCtx, echoUserBubble);
      return;
    }
    // 思考窗吸收：预检窗开着、插话是并线（改/补当前构图）且不带专门信号——
    // 吸收进思考重开，不占独立处置。判定落旁线/排队的话照走原臂（吸收集合
    // 是封闭的：误路由成新活就照排队，绝不静默吞进思考窗）。
    if (this.planPreflightActive && decision.verdict === 'inline') {
      echoUserBubble();
      this.pendingPreflightSupplements.push({ text, images });
      if (this.preflightRethinkInFlight) {
        // 刀 3.1 事件驱动攒批：重想已在飞，只入暂存不掐流。在飞的重想流完，
        // planByThinking 见暂存非空作废本轮产出发重启哨兵，宿主并账重开一
        // 轮一次带上全部——N 句补充不再 N 次废生成 N 次重启。宿主纯机械：
        // 攒不攒由「有没有重想在飞」这个流状态定，不判断、不计时。
      } else {
        // 原思考在飞（或轮间缝）：它不含任何补充，想完也是白想，照旧早掐早省。
        this.preflightRestartRequested = true;
        this.preflightAbort?.abort();
      }
      // 吸收进思考重想：约束长进构图里（收执一句机制事实——重想请求已在
      // 途，这是用户唯一需要知道的事）。
      this.deps.settleAck(ack, '已并入补充，重新规划…');
      return;
    }
    // 三臂分流（§二 两路管线）。
    if (decision.verdict === 'sideline') {
      // 旁答：答案气泡马上就来（旁路一次调用），临时回执不留行。判定落定
      // 即放闸——主流不停嘴，旁答并行（细化 1）。
      this.deps.discardAckRow(ack);
      echoUserBubble();
      void this.deps.answerMidrunQuestion(text, images);
      return;
    }
    if (decision.verdict === 'new_task') {
      // 要回来的新活：撞车先过覆盖去重/复核（不重复派、漏报取消精确落地），
      // 干净的排队——当前回合收尾后自动开新轮消化。收执随裁决（缺席沉默，
      // 原话回显即确认）。
      const covered = this.findCoveringBranch(text);
      if (covered) {
        await this.coveredConflict(text, images, displayText, ack, covered, insertionCtx, echoUserBubble);
        return;
      }
      echoUserBubble();
      this.deps.queueInterjectTask(text, images, displayText, queuePriority);
      this.deps.settleAck(ack, receipt ?? null);
      return;
    }
    // inline：宿主唯一保留机械动作之外的，全是原话直投。
    await this.inlineArm(text, images, displayText, ack, receipt, decision, insertionCtx, echoUserBubble);
  }

  /**
   * inline 臂（§二 并线管线）：原话直投注入流，主线模型下一轮自己消化。
   * 顺序 = 精确度递减：点名续支 → 覆盖去重（call_id 核实）→ 点名停支 →
   * 整树停 → 原话直投。收执 receipt 缺席一律沉默（null）。
   */
  private async inlineArm(
    text: string,
    images: MessageImage[],
    displayText: string,
    ack: InterjectAck,
    receipt: string | undefined,
    decision: DynamicInsertionDecision,
    insertionCtx: string,
    echoUserBubble: () => void,
  ): Promise<void> {
    // 1) 分支级继续（第 2 期第三刀）：点名把一支**已暂停/已停**的委派接着
    // 跑完——用原始参数同参重派（稳定 sessionId 命中 checkpoint → 子引擎
    // continue）。宿主只核实执行：callId 点不到停止面花名册/原始参数缺席/
    // 重复点名 = 核实不过，按普通插话继续往下走，宿主不猜、不越权改判。
    const resumeCallId = typeof decision.signals.resumesBranchCallId === 'string'
      ? decision.signals.resumesBranchCallId.trim()
      : '';
    if (resumeCallId) {
      const resumed = this.resumeNamedBranch(resumeCallId, text);
      if (resumed) {
        echoUserBubble();
        // 续跑由机制保证（同参重派在委派收齐后的代执行回合落定），收执
        // 是终稿——转普通气泡。命中说从第 N 轮接 / 没命中明说从头跑，
        // 口径单一出处（branchResumeReceipt，checkpoint 命中与否只有宿主
        // 知道的判例播报）。
        this.deps.settleAck(ack, branchResumeReceipt(resumed.label, resumed.checkpoint, this.deps.hasDelegationInFlight()));
        return;
      }
    }
    // 2) 覆盖去重（裁决器 call_id 命中核实）：范围确认话（「必须包括优酷」）
    // 若花名册里已有一支在做/做完了，该答「那路正在跑着，不重复」而不是再
    // 转达一遍。点名全归裁决器（covered 事实从 <live_branches> 抄回），宿主
    // 唯一做的是**核实**：callId 真在覆盖面里。点错/已结算（race）= 核实
    // 不过，照旧路由，绝不拿错误的支回「不重复」。
    const coveredCallId = typeof decision.signals.branchCallId === 'string'
      ? decision.signals.branchCallId
      : '';
    if (coveredCallId && decision.action !== 'stop') {
      const ensured = this.deps.coveringCandidates().find((item) => item.callId === coveredCallId);
      if (ensured) {
        await this.coveredConflict(text, images, displayText, ack, { name: ensured.name, callId: ensured.callId, status: ensured.status }, insertionCtx, echoUserBubble);
        return;
      }
      // 核实不过（模型点错/那支刚结算）：要求照常兑现，落下去走正常路由。
    }
    // 3) 点名停支（模型判断、宿主执行）：裁决器从花名册点 stopBranchCallId
    // 确切 id，宿主核实后真停——停不成退回取消折入（宁可折叠不误杀）。
    const stopish = typeof decision.signals.stopBranchCallId === 'string';
    if (stopish) {
      await this.stopishArm(text, images, displayText, ack, receipt, decision, echoUserBubble);
      return;
    }
    // 4) 整树停（宿主唯一保留的机械动作）：裁决器判 action=stop——停手，
    // 不重排不重想。停的收执随裁决走（缺席沉默），abort 掐流本身由状态呈现。
    if (decision.action === 'stop') {
      echoUserBubble();
      this.deps.settleAck(ack, receipt ?? null);
      this.deps.abort();
      return;
    }
    // 5) 原话直投：嘴/手分开（细化 1）。思考流在吐字 → 掐流重入（原话先进
    // steerBus 再 abort——重入循环到 THINK 边界时话已在队列）；工具/支在飞
    // → 不打断，下一 THINK 边界消化。转达目标：委派在飞按点名直达某支
    // （没点名广播），否则父引擎。
    echoUserBubble();
    const target: SteerTarget = this.deps.hasDelegationInFlight()
      ? this.matchSteerRecipient(text)
      : 'parent';
    this.deps.steerRunningTurn(text, images, ack, target, false, receipt);
    if (this.deps.isThinkingStreamActive()) this.deps.abortReenter();
  }

  /**
   * 覆盖撞车的裁决（2026-09-25 复测案例一 + 2026-10-20/21 真机三连）：加活
   * /范围确认撞上"已在跑/已跑完"本身就是矛盾信号——没人会要求加一个正在跑
   * 的东西，最可能的解释恰是漏报的取消。宿主不猜措辞，把现场事实喂回复核
   * 单独问一遍（decider.recheckCovered，独立窄问题提示词）。复核报取消 →
   * stopishArm 落地（点名还能精确停支）；复核没结论 + 那支还在跑 → 拿不准
   * 选可逆的一边（暂停那支，收执诚实交代）；复核明确判加活 → 「不重复派」
   * 终稿。语义判断全程归模型，宿主零词表。
   */
  private async coveredConflict(
    text: string,
    images: MessageImage[],
    displayText: string,
    ack: InterjectAck,
    covered: { name: string; callId: string; status: 'running' | 'done' },
    insertionCtx: string,
    echoUserBubble: () => void,
  ): Promise<void> {
    const coveredName = this.deps.branchLabel(covered.name, covered.callId);
    const conflictNote = `你刚把这句话判成「新增任务」，但它点到的活已有一支在跑：「${coveredName}」（call_id=${covered.callId}）。没人会要求加一个正在跑的东西——复核这句话是不是其实在收掉/暂停这支在跑的活。`;
    const recheck = await this.deps.decider.recheckCovered(this.deps.decideLlm(), insertionCtx, conflictNote, { text, images, displayText }, this.deps.decideSignal());
    if (recheck) this.deps.logDecision(recheck, `(复核)${text}`);
    // 复核的取消判定在 A 刀映射里落 verdict='inline'（原话直投+点名停支），
    // 加活落 'new_task'——宿主按 verdict 分流，不读退役信号。
    if (recheck && recheck.verdict === 'inline') {
      // 复核判取消：收执只取复核现场写的（它见到的是矛盾现场）。
      const recheckReceipt = typeof recheck.signals.receipt === 'string' && recheck.signals.receipt.trim()
        ? recheck.signals.receipt
        : undefined;
      await this.stopishArm(text, images, displayText, ack, recheckReceipt, recheck, echoUserBubble);
      return;
    }
    if (recheck === null && covered.status === 'running') {
      // 复核超时/失败 = 没结论：旧兜底「宁可照旧」在取消场景方向反了——
      // 用户说了「不需要」却被任其继续跑，等于当着用户的面背叛，且不可逆；
      // 误停一支是可逆的（说一声就续上）。直接暂停 covered 那支（callId 是
      // covered 命中给的宿主事实，不需要模型点名）。
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
    // 去重回执是终稿（没有后续在途）——转普通气泡（宿主核实过的事实话术）。
    this.deps.settleAck(ack, covered.status === 'done'
      ? `这个刚才已经跑完了——「${coveredName}」那路的结果就在汇总里，不重复派。`
      : `您说的这个正在「${coveredName}」那路跑着，不重复派——收齐后一并汇总给您。`);
  }

  /**
   * 点名停支/取消的落地（委派在飞与否两窗口）。收掉一项「先停下」= 暂停
   * （复测案例二口径：立即收手不烧完，活口比中止更大）。没停成退回取消
   * 折入——绝不 1a 广播（「停掉那支」广播给所有在飞支，每支都可能把自己
   * 当成"那支"自己停，反向执行最伤）。
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
      const target = this.resolveStopTarget(decision);
      const stopped = target ? this.deps.stopBranchByCallId(target, 'pause') : null;
      if (stopped) {
        echoUserBubble();
        // 停/暂停是宿主已完成的动作（sync 已落），结果由支状态卡呈现
        // ——裁决器现场写了 receipt 就转达，缺席沉默，绝不出机械腔。
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
      // stopMissed=true：支还在飞、但没停成（没指认/编排器缺位）——收执
      // 必须如实说「没停」，不许说「其余照常」了事（收执纪律）。
      this.deps.foldInScopeAddition(text, images, displayText, false, ack, true, true);
      return;
    }
    // 整理窗（委派收齐、汇总未完）的取消：无支可停，但「不进最终汇总」
    // 这个承诺此刻真实在场——折 cancelFoldInstruction 进汇聚轮（剔除后
    // 重整）。起飞闸照挂。回显挪进 else 臂：foldInScopeAddition 自带用户
    // 气泡回显，臂头统一 echo 会让整理窗分支出双气泡（2026-10-20 真机）。
    this.deps.delegation.registerCancel(text);
    // 缺口②扩窗（第 6 期）：任何取消臂只要点名命中已收工支就登记。
    this.stripSettledTarget(text);
    if (this.deps.atAggregationWindow()) {
      this.deps.foldInScopeAddition(text, images, displayText, false, ack, true, false, receipt);
    } else {
      echoUserBubble();
      // 插话落在委派出生之前：此刻无支可停，话挂上起飞闸——委派批次出生
      // 时按区分词拦下被取消的那支；同时照旧转达父引擎，父在派工前读到的
      // 话计划本身就会少这一路（闸是保底，不是唯一手段）。收执：裁决器现
      // 场写了就转达，缺席沉默——机制承诺（可能压根没有委派可派）不进收执。
      try { appendTrace({ type: 'cancel_before_dispatch', snippet: text.slice(0, 80) }); } catch {}
      this.deps.steerRunningTurn(text, images, null, 'parent', true);
      this.deps.settleAck(ack, receipt ?? null);
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
   * 停支目标核实（模型判断、宿主执行，2026-10-10）。「停哪支」是理解，
   * 归裁决器；宿主只核实执行：分类时上下文带着 <live_branches> 花名册，
   * 裁决器点 stopBranchCallId 确切 id——这里只校验它还在飞（否则当没指
   * 认）。裁决器**没**指认 = 它的判断就是「无所指/真模糊」，宿主不越权改
   * 判。返回 null = 没指认出来，调用方退回取消折入（宁可折叠不误杀）。
   */
  private resolveStopTarget(decision: DynamicInsertionDecision): string | null {
    // 没有确切 callId 的投影条目（迟到事件/缺字段）不进指认面——宁可不指认。
    const live = this.deps.runningBranches().filter((b) => typeof b.callId === 'string' && b.callId.length > 0);
    const named = decision.signals.stopBranchCallId;
    return typeof named === 'string' && live.some((b) => b.callId === named) ? named : null;
  }

  /** 分支级继续（第 2 期第三刀）：裁决器从花名册点名一支**已暂停/已停**的
   *  委派（signals.resumesBranchCallId），宿主只核实执行——callId 真实在停
   *  止面（stoppedBranches 投影）里、原始参数还押在账上（delegationArgs），
   *  就按**原始参数**排队同参重派：稳定 sessionId 命中 checkpoint，子引擎走
   *  continue 而不是从头 run。核实不过（点错 id/参数缺失/重复点名）返回
   *  null，调用方按普通插话处理，绝不猜。返回被续支的展示名（含同名序号）
   *  + checkpoint 预检凭据（收执诚实二分用）。凭据与去重记账在
   *  DelegationControlPlane。 */
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
    // 落回普通插话。
    if (!this.deps.delegation.queueResume({ callId, name: original.name, args: original.args, label, text, images: [], checkpoint })) return null;
    return { label, checkpoint };
  }

  /** 不重复做（2026-09-25 复测案例一）：这句加活是否已被某支覆盖。匹配面
   * 与点名停同源（1a 区分词匹配器：名+角色+任务书片段，只认区分性命中），
   * 范围扩到已收工的支（结果已经在汇总里的，同样不重派）。返回 null =
   * 没认出覆盖，照旧排队——宁可重复问一句，绝不吞用户的活。 */
  private findCoveringBranch(text: string): { name: string; callId: string; status: 'running' | 'done' } | null {
    const candidates = this.deps.coveringCandidates();
    if (candidates.length === 0) return null;
    const matched = matchInFlightBranch(text, candidates);
    if (!matched) return null;
    const hit = candidates.find((item) => item.callId === matched.callId);
    return hit ? { name: hit.name, callId: hit.callId, status: hit.status } : null;
  }

  /** 缺口②机械排除（2026-10-15，第 6 期扩窗）：点名取消点中了某支**已收工**
   *  的支时，把那路的产出从父上下文里整体剔除（换墓碑），并把它的 callId 登
   *  记进宿主的离场账——「不进后续请求」升格为数据不在场，与在飞停支「结算
   *  体不带产出」的机制强制抹平不对称。匹配纪律复用点名续跑的先例（1a 区分
   *  词匹配器：只认区分性命中，打平/认不出 = 宁可漏剔不误剔）；候选只认产
   *  出已回的支。登记与即时剔除解耦：同回合 settle 的支此刻结果还没进
   *  this.messages，即时剔除落空（返回 false），登记让回合收尾补剔与下一轮
   *  装配兜底兑现。返回是否即时剔中——调用方**不得**据此预支「已剔除」收执。 */
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
