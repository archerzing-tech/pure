import type { LLMAdapter, MessageImage } from '../shared/types';
import {
  classifyInsertion,
  resolveStopBranchTarget,
  recheckCoveredInsertion,
  type InsertionClassification,
  type InsertionVerdict,
} from './Planner';
import { type ProcessingLevel } from '../shared/scheduling';
import {
  applyConfidenceGate,
  parseInputTiming,
  recordInputDecision,
  type InputAction,
  type InputDecision,
  type InputScope,
} from './inputDecision';

/** 这条决策是谁定的——用户要看的就是这一个字段（读法见 inputDecision.ts
 *  的 decisorOf）：
 *  - judge      ：裁决器（LLM）按「时机 × 内容对结果的影响」综合判的——唯一
 *                 判定路径，停/停支/续支的语义也归它，宿主只核实执行
 *  - passthrough：裁决器缺席/倒下时的原话直投（不猜，signals.netReason
 *                 说明原因；inputDecision.decisorOf 暂把它读作 judge）
 *  决策日志（inputDecision.ts）据此对账。 */

/**
 * 插话判定契约三值化（2026-10-28 并线/另线改版，docs/interjection-inline-
 * sideline.md §一 细化 2）：判定面从九类 relation 压缩为三值 verdict
 * （Planner 的 InsertionVerdict——inline/sideline/new_task）。宿主不再替模型
 * 做语义细分（转向/追加/纠正/强调/停怎么消化，原话直投后由主线模型自行
 * 决定）；宿主唯一保留的机械动作是 stop 掐流（引擎手脚）。停支
 * （stop_branch.call_id）/续支（resumes_branch.call_id）的裁决器三分与
 * call_id 点名机制是既有成果，保留。混合插话不再原子拆分（atoms 退役）——
 * 原话全文到主线模型面前，多意图由它消化。
 *
 * 通路唯一形态（2026-10-28 框架改革刀 1）：判定归裁决器（LLM），宿主只核实
 * 执行。七条字面快路径正则已删：语义判断还给人肉正则是替模型做决策，而
 * 1–2s 裁决往返可接受，误停/误判的代价远大于延迟。裁决器缺席/倒下时不再
 * 猜，原话直投（passthroughVerdict），让在跑的模型带着现场自己消化。
 */
export interface DynamicInsertion {
  text: string;
  images?: MessageImage[];
  displayText?: string;
}

/** The insert decision in the SHARED shape (inputDecision.ts): action/
 *  confidence/timing/scope are what the rest of the app can reason about
 *  without knowing insertion vocabulary. */
export interface DynamicInsertionDecision extends InputDecision {
  source: 'mid-run-insert';
  /** 三值判定——权威分类面（inline 并线 / sideline 旁答 / new_task 排队），
   *  处置与置信门的真正依据。 */
  verdict: InsertionVerdict;
  /** InputDecision 的 producer 专属标签槽：承载 verdict 值（日志可读性，
   *  见模块头注）。别在它身上写新逻辑——语义以 verdict 为准。 */
  kind: string;
  /** True → the running turn must end so the insert can re-enter as a fresh
   *  send（只发生在整树停 action=stop；低置信等用户回答时绝不真停）。
   *  False → the turn keeps running and the insert is handled out-of-band
   *  (inline 注入 / sideline 旁答 / new_task 排队). */
  shouldAbort: boolean;
}

/** 三值 → 处置动作与影响范围（§二 两路管线）。这张表喂的是置信门
 *  （低置信 → 先问）与 shouldAbort/日志，不是分发本身——分发臂按 verdict +
 *  专门信号（stop_branch/resumes_branch/call_id）细分。
 *  - inline → apply：原话直投注入流，模型自消化——转向/追加/纠正/停的消化
 *    全在下一轮思考，宿主不再有 replan 臂。
 *  - sideline → apply（scope none=旁答）：判定落定即放闸，旁答管线并行，
 *    答案一行回注主流——寒暄也回注一句，不留 ignore（插话不丢，§五）。
 *  - new_task → queue：要回来的活排队跑，当前回合收尾后开新轮。 */
const VERDICT_DISPOSITION: Record<InsertionVerdict, { action: InputAction; scope: InputScope[] }> = {
  inline:   { action: 'apply', scope: ['constraints'] },
  sideline: { action: 'apply', scope: ['none'] },
  new_task: { action: 'queue', scope: ['plan'] },
};

/** 三值 → 处理级（第 5 期调度投影，与处置表同源定案）。队列优先级从它折。
 *  inline 在下一 THINK 边界消化（boundary）；sideline 旁答即时答
 *  （immediate-answer）；new_task 排队（queued）。 */
const LEVEL_BY_VERDICT: Record<InsertionVerdict, ProcessingLevel> = {
  inline:   'boundary',
  sideline: 'immediate-answer',
  new_task: 'queued',
};

export interface DynamicInsertionCoordinatorOptions {
  classify?: (
    llm: LLMAdapter,
    context: string,
    prompt: string,
    signal?: AbortSignal,
    images?: MessageImage[],
  ) => Promise<InsertionClassification>;
  resolveStopBranchTarget?: typeof resolveStopBranchTarget;
  recheckCoveredInsertion?: typeof recheckCoveredInsertion;
}

// 七条字面快路径正则已随框架改革删除（2026-10-28 蓝图刀 1）：STOP_RE（整停
// 快路径，已裁定：停的语义判断归还模型，引擎只留 abortController 掐流的机械
// 动作）、BRANCH_STOP_RE / RESUME_BRANCH_RE（点名停支/续支——点名寻址归裁决
// 器，模型拿花名册点 id，宿主只核实执行，零字面匹配）、GOAL_CHANGE_RE /
// CANCEL_PART_RE / URGENT_RE（netVerdict 字面族兜底——裁决器缺席/倒下时不再
// 猜，原话直投）、SCOPE_ADD_RE（死代码）。停/停支/续支由裁决器判定
// （INSERTION_CLASSIFY_PROMPT 的 action/stop_branch/resumes_branch 契约），
// 宿主只核实执行。

export class DynamicInsertionCoordinator {
  private readonly classify: NonNullable<DynamicInsertionCoordinatorOptions['classify']>;
  private readonly resolveStop: NonNullable<DynamicInsertionCoordinatorOptions['resolveStopBranchTarget']>;
  private readonly recheck: NonNullable<DynamicInsertionCoordinatorOptions['recheckCoveredInsertion']>;

  constructor(options: DynamicInsertionCoordinatorOptions = {}) {
    this.classify = options.classify ?? classifyInsertion;
    this.resolveStop = options.resolveStopBranchTarget ?? resolveStopBranchTarget;
    this.recheck = options.recheckCoveredInsertion ?? recheckCoveredInsertion;
  }

  async decide(
    llm: LLMAdapter | null,
    context: string,
    insertion: DynamicInsertion,
    signal?: AbortSignal,
  ): Promise<DynamicInsertionDecision> {
    // 唯一通路（刀 1）：判定全归裁决器；passthrough 只是裁决器缺席/倒下时
    // 的原话直投兜底，不参与判定。
    const decision = await this.decideInner(llm, context, insertion, signal);
    // 每条插话决策都进共享日志（inputDecision.ts 的 recordInputDecision）：
    // 「这次是裁决器判的，还是兜底接的」变成可查的数据（signals.via），
    // 设置页诊断区读它，formatInputDecisionLog() 还能整段导出回放。记录点在
    // 唯一出口，所以两条生产路径（judge / passthrough）都不可能绕过。
    // 连同**判它时的场景**一起入账（2026-09-28）："判错了"只有配上"在什么场景
    // 下判的"才可行动——同一句换场景能从错到对，看不到场景就只能归咎于模型。
    recordInputDecision({
      ...decision,
      inputText: insertion.text.trim().slice(0, 160),
      inputContext: context.trim().slice(0, 600),
    });
    return decision;
  }

  private async decideInner(
    llm: LLMAdapter | null,
    context: string,
    insertion: DynamicInsertion,
    signal?: AbortSignal,
  ): Promise<DynamicInsertionDecision> {
    const text = insertion.text.trim();
    // 快路径正则已随框架改革删除（2026-10-28 蓝图刀 1）：停/停支/续支由裁
    // 决器判定（INSERTION_CLASSIFY_PROMPT 的 action/stop_branch/resumes_branch
    // 契约），宿主只核实执行。裁决器缺席/倒下时不再猜，原话直投。
    if (!llm) {
      return this.passthroughVerdict('no-judge');
    }
    const result = await this.classify(llm, context, text, signal, insertion.images);
    if (result.fallbackUsed) {
      // 裁决器倒下（超时/网络/解析失败）：同样原话直投，不猜。
      return this.passthroughVerdict('judge-down');
    }
    // 契约里没有 when 字段：时机意图从用户原话文本推导（parseInputTiming 的
    // TIMING_CUE 兜底），裁决器只管走哪条线。
    const timing = parseInputTiming(undefined, text, Date.now());
    return this.build(result.verdict, result.reason, {
      confidence: result.confidence,
      timing,
      signals: {
        via: 'judge',
        classifier: 'llm',
        // 点名支 id 三形随信号过河（branchCallId=插话点名/范围确认，
        // stopBranch/resumesBranch=点名停/续），宿主只核实 id 真实在册——
        // 语义判断全程归模型，宿主零文本匹配。
        ...(result.branchCallId ? { branchCallId: result.branchCallId } : {}),
        ...(result.stopBranch ? { stopBranchCallId: result.stopBranch.callId } : {}),
        ...(result.resumesBranch ? { resumesBranchCallId: result.resumesBranch.callId } : {}),
        ...(result.confidenceDefaulted ? { confidenceDefaulted: true } : {}),
        // 现场收执（§〇 呈现层契约）：裁决器结合现场写的那句随信号走——
        // 只有必须即时确认处才有；缺席 = 引擎沉默。
        ...(result.receipt ? { receipt: result.receipt } : {}),
      },
    }, {
      // 整树停（保留成果）：裁决器判 action=stop 时压过处置表——宿主唯一
      // 保留的机械动作（abortController 掐流），不重排不重想，signals.via
      // 据实仍是 judge。
      ...(result.action === 'stop'
        ? { action: 'stop' as InputAction, scope: ['plan', 'completed-steps'] as InputScope[] }
        : {}),
    });
  }

  /** 去重撞车的复核（2026-10-21）：宿主发现「判成要加活却撞上已在跑」的矛盾
   *  后，把事实喂回来单独问一遍——不走 decide()（同一个 system 重问会被锚定
   *  拉回原判，真机「停掉优酷这一调研」二次判 task 实证），走
   *  recheckCoveredInsertion 的独立窄问题提示词（举证责任倒置：谁会要求加
   *  一个正在跑的东西）。判定折回三值面：cancelsPart=收掉一支（inline 原话
   *  直投 + stop_branch 信号，宿主核实执行）；否则=要回来的新活排队
   *  （new_task）。LLM 缺席或复核失败返回 null——调用方回终稿，宁可照旧不可
   *  误停。 */
  async recheckCovered(
    llm: LLMAdapter | null,
    context: string,
    conflictNote: string,
    insertion: DynamicInsertion,
    signal?: AbortSignal,
  ): Promise<DynamicInsertionDecision | null> {
    if (!llm) return null;
    const verdict = await this.recheck(llm, context, conflictNote, insertion.text, signal, insertion.images);
    if (!verdict) return null;
    return verdict.cancelsPart
      ? this.build('inline', verdict.reason || 'covered recheck', {
        confidence: verdict.confidence,
        timing: { mode: 'now' },
        signals: {
          via: 'judge',
          classifier: 'llm',
          ...(verdict.stopBranchCallId ? { stopBranchCallId: verdict.stopBranchCallId } : {}),
          ...(verdict.receipt ? { receipt: verdict.receipt } : {}),
        },
      })
      : this.build('new_task', verdict.reason || 'covered recheck', {
        confidence: verdict.confidence,
        timing: { mode: 'now' },
        signals: {
          via: 'judge',
          classifier: 'llm',
          ...(verdict.receipt ? { receipt: verdict.receipt } : {}),
        },
      });
  }

  /**
   * 聚焦点名（模型判断、宿主执行）：要不要停由裁决器判，这里的窄问题只裁
   * 「停哪支」——只要一个确切 id。裁决器不可用或指认不出返回 null，调用方
   * 退回保守消化（原话直投主线，绝不误停）。
   */
  resolveStopBranchTarget(
    llm: LLMAdapter | null,
    context: string,
    insertion: DynamicInsertion,
    roster: Array<{ callId: string; name: string; role?: string; snippet?: string }>,
    signal?: AbortSignal,
  ): Promise<{ callId: string } | null> {
    return this.resolveStop(llm, context, insertion.text, roster, signal);
  }

  /** 原话直投（2026-10-28 框架改革刀 1）：裁决器缺席或倒下时的唯一兜底——
   *  不猜走哪条线，统一按并线直投（verdict=inline）：原话进下一轮思考输入，
   *  让在跑的模型带着现场自己消化，话绝不丢（不变量 §六.1）。confidence=0.3：
   *  这不是判断，是投递策略——刻意标明「这里没有任何语义判定发生」；置信门
   *  会把它降级为 clarify（gatedFrom 记得原始动作），宿主读 signals.via=
   *  passthrough 自行择路。netReason 只进日志（no-judge=没有裁决器；
   *  judge-down=超时/网络/解析失败），不参与处置。 */
  private passthroughVerdict(netReason: 'no-judge' | 'judge-down'): DynamicInsertionDecision {
    return this.build('inline', 'judge unavailable; inserting the user\'s words verbatim into the queue', {
      confidence: 0.3,
      timing: { mode: 'now' },
      signals: { via: 'passthrough', netReason },
    }, { action: 'apply', scope: [] });
  }

  /**
   * Assemble the shared decision shape and run the confidence gate as the LAST
   * step, so no producer path can bypass it.
   *
   * 三值化后没有 replan 臂：action/scope 直接从 VERDICT_DISPOSITION 取；
   * opts 只供两类非判断压表——裁决器的整树停（action=stop，宿主的机械动作）
   * 与 passthrough 的原话直投（投递策略不是判断，不该被处置表覆盖）。
   */
  private build(
    verdict: InsertionVerdict,
    reason: string,
    fields: Pick<DynamicInsertionDecision, 'confidence' | 'timing' | 'signals'>,
    opts: { action?: InputAction; scope?: InputScope[] } = {},
  ): DynamicInsertionDecision {
    const disposition = VERDICT_DISPOSITION[verdict];
    // A timed input cannot be applied to the running turn — it has to be HELD
    // until its moment arrives, whatever the verdict thought of its content.
    // 唯独整树停例外：stop 是用户的明确命令，压过定时。
    const baseAction: InputAction = opts.action ?? disposition.action;
    const action: InputAction = fields.timing.mode === 'at' && baseAction !== 'stop' ? 'queue' : baseAction;
    const decision: DynamicInsertionDecision = {
      source: 'mid-run-insert',
      verdict,
      // kind 槽承载 verdict 值（日志可读/事件面镜像），语义以 verdict 为准。
      kind: verdict,
      action,
      confidence: fields.confidence,
      timing: fields.timing,
      scope: opts.scope ?? disposition.scope,
      shouldAbort: action === 'stop',
      reason,
      // 第 5 期调度显式化：处理级从三值处置表折（与 action 同源），随信号
      // 过河——宿主/队列按它分轻重缓急。唯独整树停压成 interrupt：拆树的
      // 优先级必须盖过一切排队的活。
      signals: { ...fields.signals, processingLevel: action === 'stop' ? 'interrupt' : LEVEL_BY_VERDICT[verdict] },
    };
    // The gate can downgrade the action to `clarify` and clears shouldAbort with
    // it: asking the user must never tear down the running work first.
    return applyConfidenceGate(decision) as DynamicInsertionDecision;
  }
}
