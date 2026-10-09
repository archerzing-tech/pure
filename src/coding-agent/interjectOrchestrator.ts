// src/coding-agent/interjectOrchestrator.ts
// S2 第六刀（P3-2 控制面抽出）— 插话分类编排主刀：interject() 入口与序列化
// 链、classifyAndApply 的裁决序（时机语义 → 置信门 → 思考窗吸收 → 五类分
// 发）、1a 定向投递匹配 / 覆盖去重 / 点名续跑的编排、思考窗寄存器。
//
// 此前这一整套焊死在 chat.ts（GUI 控制器）。S3 的前置硬约束：五分类只有一
// 份、控制面是无宿主状态依赖的决策核——本模块把决策核搬出来，DOM（ack 行/
// 回显/收执/事件日志/控制台诊断）、LLM 产出（旁答/追问）、铺排（折入框架/
// 转向框架/队列卡）与引擎把手（abort/真停支）经依赖缝留给宿主。宿主读数
// （流态/在飞/分支视图）全部注入，决策核不猜宿主状态。
//
// ack 句柄不透明（InterjectAck = unknown）：宿主给什么还什么——GUI 是
// HTMLElement，通道宿主可以是任何东西。收执话术的单一事实来源仍在
// insertionMessaging（本模块只引用，不内联第二份）。

import { DynamicInsertionCoordinator, type DynamicInsertionDecision } from './DynamicInsertionCoordinator';
import { needsClarification, isDestructiveAction, shouldAbsorbIntoThinkingWindow, type InputAction, type InputTiming } from './inputDecision';
import { matchInFlightBranch, cancelReceiptTopic, type SteerTarget, type InFlightBranch } from '../shared/steerTargeting';
import { branchStopReceipt, branchResumeReceipt, cancelBeforeDispatchReceipt } from '../shared/insertionMessaging';
import { PAUSE_ABORT_REASON } from '../shared/pauseSignal';
import type { DelegationControlPlane } from './delegationControl';
import type { RoundClosePlane } from './roundClosePlane';
import type { MessageImage, LLMAdapter } from '../shared/types';

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
  /** 收执里引用支名时带同任务第几号（同名多支消歧）。 */
  branchLabel(name: string, callId: string): string;
  /** 续跑预检（第 2 期第三刀）：同参重派会不会命中 checkpoint（编排器
   *  probeResumeCheckpoint 的同口径读数）。无必填默认——凭据缺失会让收执
   *  退回「无脑许愿从断点续」，正是本刀要收掉的谎。 */
  probeResume(toolName: string, rawArgs: string): { hit: boolean; turns: number };

  // ── 引擎动作缝（宿主生命周期）─────────────────────────────────────
  send(text: string, images: MessageImage[], displayText: string): void;
  abort(reason?: string): void;
  /** 点名真停支（匹配/挂闸在 DelegationControlPlane，引擎把手留宿主）。 */
  stopNamedBranch(text: string, mode: 'abort' | 'pause'): string | null;
  /** 转向通道入队 + 收执（框架文本与收执口径留宿主）。 */
  steerRunningTurn(text: string, images: MessageImage[], ack: InterjectAck, target: SteerTarget, cancel: boolean): void;
  /** 排队不相关插话（roundClose.queueTask + 队列卡渲染 + 补调度）。 */
  queueInterjectTask(text: string, images: MessageImage[], displayText: string): void;
  /** 折入汇合轮的铺排（回显 + folds.add + 收执——铺排留宿主）。 */
  foldInScopeAddition(text: string, images: MessageImage[], displayText: string, mechanical: boolean, ack: InterjectAck, cancels: boolean): void;
  answerMidrunQuestion(text: string, images: MessageImage[]): Promise<void>;
  askMidrunClarification(decision: DynamicInsertionDecision, text: string, images: MessageImage[], ack: InterjectAck): Promise<void>;
  /** 输入自带执行时刻的排期 sink（false = 没接 sink 或拒收）。 */
  deferTimedInsert(timing: InputTiming, text: string, images: MessageImage[], displayText: string): boolean;

  // ── 投影缝（DOM/事件日志/控制台诊断；settleAck 系留宿主）─────────
  /** 插话临时回执行（GUI：addStatusBubble('插话处理中…') + 回执账登记）。 */
  createAck(): InterjectAck;
  settleAck(ack: InterjectAck, text: string, keepPending?: boolean, kind?: 'success' | 'warn' | 'info'): void;
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
  /** 在飞思考的叙述尾（最近 ~400 个可见字符）：插话裁决的时机证据——裁决
   * 器看到"思考最新说到……"才能自己发现叙述里的错误前提（jev 案例）。
   * 每轮新思考开局清空（旧轮的尾巴对新轮是假证据）。 */
  private preflightNarrationTail = '';

  constructor(private readonly deps: InterjectOrchestratorDeps) {}

  /**
   * Handle a message the user typed while a turn is running (interrupt-and-
   * insert). 插话重构 — 判定的依据从"相不相关"换成了"一个埋头干活的人听到
   * 这句话会怎么处理"，只有两种情况值得停下手里的活：
   *   - stop        → 用户叫停，结束当前任务（正则直判，不占分类往返）。
   *   - goal-change → 方向被掀掉，停下并把这句话作为新指令重新出发。
   * 其余全部不打断：
   *   - steer   → 进引擎转向通道（takeSteerMessages），下一个 THINK 轮顺路
   *               带上，手头的活继续干。
   *   - question → 侧路回答一句，主循环毫无感知。
   *   - task    → 阶段感知：委派还在飞 → 折入汇合轮（foldInScopeAddition，
   *               先补这项再合并汇总，收尾核验没折入就转排队兜底）；
   *               委派收齐 → 排队（RoundClosePlane 待办账），收尾后作为新任务启动。
   *   - chatter → 收下即可，用户的话以自己的气泡上屏，不打扰干活的人。
   * 分类不可用时保守按 steer 处理：话一定送到，活绝不推倒重来。
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
    const run = this.chain.then(() => this.classifyAndApply(text, images, displayText, ack));
    // A rejected link must never poison the chain for later inserts.
    this.chain = run.catch(() => {
      this.deps.settleAck(ack, '未能处理这句插话；请重新发送。');
    });
    await run;
  }

  /** One link of the interject chain: runs only after every earlier insert has
   * been judged. Re-checks isStreaming() because an earlier stop/goal-change
   * aborts the turn — by the time this link runs, the insert may belong to a
   * fresh send instead. */
  private async classifyAndApply(text: string, images: MessageImage[], displayText: string, ack: InterjectAck): Promise<void> {
    if (!this.deps.isStreaming()) {
      // The turn is over; a normal send renders the user's own bubble, so the
      // provisional ack would only orphan a promise nobody keeps.
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
    // 分类器不可用（LLM 还没立起来）也照走 decide(null)：协调器的兜底
    // 是字面安全网（netVerdict——推翻重开/收活折入/其余排队）——话绝不因
    // 没有裁决器而失踪。决策本身不看关键词（2026-09-28 用户定调）：时机
    // ×内容×结果收益的综合判断全在裁决器（上下文带着当前阶段与思考叙述）。
    // 裁决走 judgeLlm（关暗推理）而不是 turnLlm：开着思考时 8s 预算几乎必然
    // 超时，判定会整批落到字面安全网。turnLlm 是兜底（judgeLlm 没立起来时
    // 它至少让 decide 拿到一个 llm）。档位选择留宿主（decideLlm 缝）。
    const decision = await this.deps.decider.decide(this.deps.decideLlm(), this.deps.insertionContext(images), { text, images, displayText }, this.deps.decideSignal());
    this.deps.logDecision(decision, text);
    if (this.deps.isAborted()) {
      // The turn was hard-stopped while we were classifying — don't drop the
      // insert; queue it so it still runs as a task. The queue card that
      // queueInterjectTask renders is the receipt; the provisional ack would
      // only duplicate it.
      this.deps.discardAckRow(ack);
      this.deps.queueInterjectTask(text, images, displayText);
      return;
    }
    // 输入级时间语义先于 kind 生效：这句话自己报了执行时刻，那它现在就不该被
    // 执行——不管分类器把它读成什么（stop 除外：停是立即的，timing 恒为 now）。
    // 少了这一步，"下午三点再跑一遍"会被当成当场追加的活跑掉。
    if (decision.timing.mode === 'at' && this.deps.deferTimedInsert(decision.timing, text, images, displayText)) {
      this.deps.discardAckRow(ack);
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
    // 思考窗吸收（判据在 shouldAbsorbIntoThinkingWindow，纯函数）。
    if (shouldAbsorbIntoThinkingWindow(decision, this.planPreflightActive)) {
      echoUserBubble();
      this.pendingPreflightSupplements.push({ text, images });
      this.preflightRestartRequested = true;
      this.preflightAbort?.abort();
      const isCorrection = decision.kind === 'premise-change' || decision.kind === 'goal-change';
      this.deps.settleAck(ack, isCorrection
        ? '已按纠正重构思路，重新规划…'
        : '已并入补充，重新规划…');
      return;
    }
    switch (decision.kind) {
      case 'stop':
        // 这条可能来自正则快路径（"停止""停下"——字面命令）也可能来自裁决
        // 器的 stop 档（"先缓一缓""这个就到这儿"——正则覆盖不到的软停）。
        // 两条路落到同一个分支，因为要做的事一样：停手，不重排。
        // 整树停不重入 send()（没有 held insert），用户的原话不会在别处上屏
        // ——补上回显，别让转写里只剩 pure 的一句话（插话没有回执时 transcript
        // 必须仍能对上「谁说了什么」）。
        echoUserBubble();
        this.deps.settleAck(ack, '收到，停——正在收尾当前任务，已经跑完的部分都留着。', true, 'info');
        this.deps.abort();
        return;
      case 'goal-change':
        // 不在这里回显——held insert 从 send() 重入时会作为新回合开场气泡上屏，
        // 先回显再重入 = 同一句话上两遍。
        this.deps.roundClose.holdInsert({ text, images, displayText, ts: Date.now() });
        this.deps.settleAck(ack, '方向变了——在跑的先停下止损，已完成的不丢，马上按新的方向来。', true, 'info');
        this.deps.abort();
        // Same late-classification hazard as queueInterjectTask: if the turn
        // already finished while we were judging, no finalize will dispatch
        // the held insert — re-arm the deferred dispatch here.
        if (!this.deps.isStreaming()) this.deps.roundClose.scheduleDispatch();
        return;
      case 'premise-change': {
        // 前提被推翻（"其实我在西安"）：目标没变，但在飞的委派按错误前提算
        // 下去全是白跑——先止损。
        // 2026-09-29 用户反馈重构（三路调研 + "现在的年份是2026年9月"案例）：
        // 旧实现裸 abort 整树，在飞支被结算成 success:false 的假失败——重入
        // 回合的模型看见三个失败，不敢再派 agent，降级成自己派工具。现在：
        // ① 活动期整树走 PAUSE 原因 → 在飞支结算成「已暂停·进度已存档」
        //   （灰 ⏸、success:true，checkpoint 照存），父模型看到的是可续跑
        //   的事实，不是失败证据；
        // ② held insert 在收尾派发点重入 → 新回合自主决策：从断点重派原
        //   支（同参重派命中 checkpoint）、改派、换方案都由它按纠正后的
        //   前提权衡——用户的插话被接纳后重决策，而不是整树报废。
        // ③ 已收齐委派、无在飞可暂停时，维持旧路：直接重入（abort 对已
        //   收尾的回合是 no-op，押账插话照常派发）。
        this.deps.roundClose.holdInsert({ text, images, displayText, ts: Date.now() });
        if (this.deps.hasDelegationInFlight()) {
          this.deps.settleAck(ack, '收到——先把手头的活暂停存档，带着这个纠正重新安排；已完成的不丢。', true, 'info');
          this.deps.abort(PAUSE_ABORT_REASON);
        } else {
          this.deps.settleAck(ack, '前提变了——按纠正后的事实重新来；已完成的不丢。', true, 'info');
          this.deps.abort();
        }
        // Same late-classification hazard as queueInterjectTask: if the turn
        // already finished while we were judging, no finalize will dispatch
        // the held insert — re-arm the deferred dispatch here.
        if (!this.deps.isStreaming()) this.deps.roundClose.scheduleDispatch();
        return;
      }
      case 'steer': {
        // 分支级继续（第 2 期第三刀）：点名把一支**已暂停/已停**的委派接着
        // 跑完——用原始参数同参重派（稳定 sessionId 命中 checkpoint → 子引
        // 擎 continue），排在停支/取消/普通 steer 之前（带点名锚的「接着跑」
        // 比整树续跑、加活都具体）。点不出具体支或拿不到原参，落下去走普通
        // steer——让父模型从上下文重派（旧会话的兜底，可能从头跑）。
        if (decision.signals.resumesBranch === true) {
          const resumed = this.resumeNamedBranch(text);
          if (resumed) {
            echoUserBubble();
            // 续跑由机制保证（同参重派在委派收齐后的代执行回合落定），收执
            // 是终稿——转普通气泡（与停支/暂停收执同一形态）。命中说从第 N
            // 轮接 / 没命中明说从头跑，口径单一出处（branchResumeReceipt），
            // 与派工收执、兜底指令三处同源。
            this.deps.settleAck(ack, branchResumeReceipt(resumed.label, resumed.checkpoint, this.deps.hasDelegationInFlight()));
            return;
          }
        }
        // 第 2 期分支中断：祈使式「停掉 X 那支」或取消型话里点得出具体支的
        // ——真停那一支（abortBranch，产出不入账、断点照存），其余照跑。
        // 点不出具体支时退回原路：取消口径折入 / 普通 steer。
        const stopish = decision.signals.branchStop === true || decision.signals.cancelsPart === true;
        if (stopish && this.deps.hasDelegationInFlight()) {
          // 祈使「停掉那支」= 中止（判例 13 口径）；收掉一项「先停下」= 暂停
          // （复测案例二口径：立即止损不烧完，活口比中止更大）。
          const pause = decision.signals.branchStop !== true;
          const stopped = this.deps.stopNamedBranch(text, pause ? 'pause' : 'abort');
          if (stopped) {
            echoUserBubble();
            // 停/暂停是宿主已完成的动作（sync 已落），收执是终稿——转普通
            // 气泡（settleAck 终稿语义），不必等收尾扫除摘微光。
            this.deps.settleAck(ack, branchStopReceipt(stopped, pause ? 'pause' : 'abort'));
            return;
          }
          // 点不出具体支（或它刚好结算了）：退回取消折入——宁可折叠不误杀。
          // 绝不能往下走 1a 广播：「停掉那支」广播给所有在飞支，每支都可能
          // 把自己当成"那支"自己停（反向执行最伤，2026-09-24 取消案例同源）。
          // 折入只守汇报步；同回合父若再为这个话题派工，起飞闸（挂号簿）
          // 在出生点拦下。
          this.deps.delegation.registerCancel(text);
          this.deps.foldInScopeAddition(text, images, displayText, false, ack, true);
          return;
        }
        // 非取消、非停支的 steer 走 1a 定向投递：委派在飞时按点名找收件人
        // ——点到某一支就直达那一支（其余照跑），没点名就广播给所有在飞的
        // 活。委派不在飞时照旧：父引擎下个 THINK 边界顺路带上。
        if (stopish && !this.deps.hasDelegationInFlight()) {
          // 插话落在委派出生之前（2026-09-26 用户实测）：此刻无支可停，话
          // 挂上起飞闸——委派批次出生时按区分词拦下被取消的那支；同时照旧
          // 转达父引擎，父在派工前读到的话计划本身就会少这一路（闸是保底，
          // 不是唯一手段）。收执点名说砍了什么——机制承诺不进收执
          // （2026-09-28：这个窗口可能压根没有委派可派）。
          echoUserBubble();
          this.deps.delegation.registerCancel(text);
          this.deps.steerRunningTurn(text, images, null, 'parent', true);
          this.deps.settleAck(ack, cancelBeforeDispatchReceipt(cancelReceiptTopic(text)));
          return;
        }
        echoUserBubble();
        if (this.deps.hasDelegationInFlight()) {
          this.deps.steerRunningTurn(text, images, ack, this.matchSteerRecipient(text), false);
        } else {
          this.deps.steerRunningTurn(text, images, ack, 'parent', false);
        }
        return;
      }
      case 'question':
        // 回答气泡马上就来（旁路一次 LLM 调用），临时回执不再留行。
        this.deps.discardAckRow(ack);
        echoUserBubble();
        void this.deps.answerMidrunQuestion(text, images);
        return;
      case 'task': {
        // 取消不是活（2026-09-24 取消案例）：分类器把收掉一项判成 task 时，
        // 只要它带上了 cancels_part，就绝不能走去重、排队或机械折入——排队
        // 一个"取消"等于把它当活跑（反向执行），送去重会回出"已经在调研着
        // 了"这种答非所问。
        // 2026-09-28：宿主不再自己嗅关键词（CANCELISH_RE 已删），只看这个
        // 契约字段。可靠性靠提示词的硬要求兑现——「即使判成 task 也必须报」
        // ——而不是靠宿主当场猜措辞：一个句子在裁决器与宿主两边被读成相反的
        // 两件事，就是两条反向执行的来路。
        // 停支的闸 2026-09-28 起由契约字段驱动（adds_along），不再嗅关键词：
        // 同一句里还要求加活的话——「B站那支别查了，再加一个爱奇艺」——永不
        // 停支，因为停掉那支会把刚要求加进来的活一并杀掉，只取消折入。
        // 停不了/点不到具体支按取消型 steer 折入；委派不在飞交给在跑的回合
        // 自己消化。
        const cancelish = decision.signals.cancelsPart === true;
        if (cancelish) {
          if (this.deps.hasDelegationInFlight()) {
            const stopped = decision.signals.addsAlong === true ? null : this.deps.stopNamedBranch(text, 'pause');
            if (stopped) {
              echoUserBubble();
              // 宿主已完成暂停（sync 已落），收执是终稿——转普通气泡。
              this.deps.settleAck(ack, branchStopReceipt(stopped, 'pause'));
              return;
            }
            // 点不出支的取消折入：折入守汇报步，挂号守同回合再出生的支。
            this.deps.delegation.registerCancel(text);
            this.deps.foldInScopeAddition(text, images, displayText, false, ack, true);
            return;
          }
          // 委派还没出生（2026-09-26 用户实测窗口）：话挂起飞闸 + 转达父引擎。
          echoUserBubble();
          this.deps.delegation.registerCancel(text);
          this.deps.steerRunningTurn(text, images, null, 'parent', true);
          this.deps.settleAck(ack, cancelBeforeDispatchReceipt(cancelReceiptTopic(text)));
          return;
        }
        // 不重复做（2026-09-25 复测案例一）：加的活若某支在飞/已收工的支已
        // 经覆盖（「新增一个平台，爱奇艺」而爱奇艺那路正在跑），如实回「已
        // 经在跑/已在汇总里」，不重复派也不折入——重复派一支是白烧算力还
        // 污染汇总。只认区分性命中（1a 同款纪律）：打平认不出 = 宁可照旧
        // 折入，绝不拿"可能重复"当理由吞用户的活。
        const covered = this.findCoveringBranch(text);
        if (covered) {
          echoUserBubble();
          const coveredName = this.deps.branchLabel(covered.name, covered.callId);
          // 去重回执是终稿（没有后续在途）——转普通气泡。
          this.deps.settleAck(ack, covered.status === 'done'
            ? `这个刚才已经跑完了——「${coveredName}」那路的结果就在汇总里，不重复派。`
            : `您说的这个正在「${coveredName}」那路跑着，不重复派——收齐后一并汇总给您。`);
          return;
        }
        // 阶段感知（2026-09-22 用户定稿）：并行委派还没收齐时插进来的追加活，
        // 不进"当前任务完成后处理"的队列——那会先输出一份没有它的汇总。折入
        // 汇合轮：正在跑的收齐后先补这项，再合并输出一份覆盖全部的汇总。
        // 委派都收齐了才插的，照旧排队（先出已有结果，再单独补跑）。
        if (this.deps.hasDelegationInFlight()) {
          this.deps.foldInScopeAddition(text, images, displayText, true, ack, false); // scope 追加：机械执行
        } else {
          // 队列卡本身就是回执（逐条可见、就地更新），临时回执不再留行。
          this.deps.discardAckRow(ack);
          this.deps.queueInterjectTask(text, images, displayText);
        }
        return;
      }
      case 'chatter':
        // 收下了。同事埋头干活时说了句"哈哈"，你不会停下来回一句"收到"——
        // 气泡已上屏，这就够了，别再打扰干活的人。临时回执也一并收走。
        this.deps.discardAckRow(ack);
        echoUserBubble();
        return;
    }
  }

  /** 1a 定向投递 — 宿主供在飞分支视图（agentActivities 投影，观测单向，
   * 不另立注册表），纯匹配器判断用户这句话点名了哪一支。返回 'all' =
   * 没点名，按广播处理。 */
  private matchSteerRecipient(text: string): SteerTarget {
    const matched = matchInFlightBranch(text, this.deps.runningBranches());
    return matched ? { branchCallId: matched.callId, branchName: matched.name } : 'all';
  }

  /** 分支级继续（第 2 期第三刀）：从用户话里点名一支**已暂停/已停**的委
   * 派，用**原始参数**排队同参重派——稳定 sessionId 命中 checkpoint，子引
   * 擎走 continue 而不是从头 run。点名复用 1a 区分词匹配器（只认只被一支
   * 含有的词，打平宁可续不了也不赌）；候选 = 已暂停/已取消的支（在飞的支
   * 走 steer，已完成的支结果已在汇总，无需重跑）。拿不到原始参数（旧会话/
   * 非本会话捕获）返回 null，调用方落回普通 steer 让父模型重派。返回被续
   * 支的展示名（含同名序号）+ checkpoint 预检凭据（收执诚实二分用）。凭据
   * 与去重记账在 DelegationControlPlane。 */
  private resumeNamedBranch(text: string): { label: string; checkpoint: { hit: boolean; turns: number } } | null {
    const matched = matchInFlightBranch(text, this.deps.stoppedBranches());
    if (!matched) return null;
    const original = this.deps.delegation.delegationArgs.get(matched.callId);
    if (!original) return null;
    const label = this.deps.branchLabel(matched.name, matched.callId);
    // 预检先行、凭据随记录走：排队收执、派工收执、兜底指令三处按同一份
    // 预检二分——命中说从第 N 轮接，没命中明说从头跑，绝不预支断点承诺。
    const checkpoint = this.deps.probeResume(original.name, original.args);
    // 排队同参重派：同一支只排一次——重复点名按「点不出」退回，调用方
    // 落回普通 steer。
    if (!this.deps.delegation.queueResume({ callId: matched.callId, name: original.name, args: original.args, label, text, images: [], checkpoint })) return null;
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

  // ── 思考窗寄存器的宿主面（send() 重启循环 / planByThinking / 上下文投影用）─

  /** 窗开在 planByThinking 前、关在 finally（抛了也关）——整个预检循环期间
   * 吸收分支都能接住新插话。 */
  openPreflightWindow(): void {
    this.planPreflightActive = true;
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

  /** 新会话清场：窗、暂存、在飞把手、重启请求、叙述尾一并归零。 */
  resetPreflight(): void {
    this.pendingPreflightSupplements = [];
    this.planPreflightActive = false;
    this.preflightAbort = null;
    this.preflightRestartRequested = false;
    this.preflightNarrationTail = '';
  }
}
