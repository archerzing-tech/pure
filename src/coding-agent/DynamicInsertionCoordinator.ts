import type { LLMAdapter, MessageImage } from '../shared/types';
import {
  checkOutputFaithfulness,
  classifyInsertion,
  resolveStopBranchTarget,
  recheckCoveredInsertion,
  type FaithfulnessVerdict,
  type InsertionAtom,
  type InsertionClassification,
  type InsertionRelation,
  type UnrelatedKind,
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
 *  - passthrough：裁决器缺席/倒下时的原话直投（不猜 relation，signals.netReason
 *                 说明原因；inputDecision.decisorOf 暂把它读作 judge）
 *  决策日志（inputDecision.ts）据此对账。 */

/**
 * 插话架构 v2（2026-10-27）：判定面是九类 relation（Planner 的
 * InsertionRelation——supplement/change/emphasize/unrelated/correction/
 * question/mixed/meta/misunderstanding，蓝图 §五），处置臂按 relation 分发
 * （interjectOrchestrator §六处置表）。v1 的七类 kind 与它的折算层
 * （dispatchKindOf）随九类分发臂落地一并删除：decision.kind 现在直接承载
 * relation 值——它只是 InputDecision 的「producer 专属标签」槽（日志可读、
 * 旧消费者仍能 switch），权威语义在 relation。
 *
 * 通路唯一形态（2026-10-28 框架改革刀 1）：判定归裁决器（LLM），宿主只核实
 * 执行——整树停（action=stop）、点名停支（stop_branch.call_id）、点名续支
 * （resumes_branch.call_id）都是裁决器的输出。七条字面快路径正则与 net 字面
 * 族已删：语义判断还给人肉正则是替模型做决策，而 1–2s 裁决往返可接受，误停
 * /误判的代价远大于延迟。裁决器缺席/倒下时不再猜 relation，原话直投队列
 * （passthroughVerdict），让在跑的模型带着现场自己消化。
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
  /** 九类关系——权威分类面（蓝图 §5.1），处置与置信门的真正依据。 */
  relation: InsertionRelation;
  /** relation=unrelated 时的细分（new_task=排队跑，chatter=收下）。 */
  unrelatedKind?: UnrelatedKind;
  /** relation=mixed 时的原子拆分（§5.1）：处置臂按原子分流。 */
  atoms?: InsertionAtom[];
  /** InputDecision 的 producer 专属标签槽：承载 relation 值（日志可读性，
   *  见模块头注）。别在它身上写新逻辑——语义以 relation 为准。 */
  kind: string;
  /** True → the running turn must end so the insert can re-enter as a fresh
   *  send (replan/stop actions only, and never while a low-confidence decision
   *  is waiting for the user's answer). False → the turn keeps running and the
   *  insert is handled out-of-band (apply / answer / queue / ignore). */
  shouldAbort: boolean;
}

/** 九类 → 处置动作与影响范围（蓝图 §六处置表的粗投影）。这张表喂的是置信门
 *  （低置信且破坏性 → 先问）与 shouldAbort/日志，不是分发本身——分发臂按
 *  relation + 专门信号（cancels_part/stop_branch/…）+ 任务状态细分。
 *  - supplement/emphasize/meta → apply：不中断不清理，纳入执行。
 *  - change/correction/misunderstanding/mixed → replan：撤改类先止损的保守
 *    底线；「未开始→拦截 / 进行中→中断 / 已完成→冻结+询问 / 真暂停」由处置
 *    臂按任务状态拆开。
 *  - question → answer（旁答）；unrelated → queue（chatter 特例 ignore，
 *    见 dispositionOf）——要回来的活排队跑，绝不丢。 */
const RELATION_DISPOSITION: Record<InsertionRelation, { action: InputAction; scope: InputScope[] }> = {
  supplement:        { action: 'apply',  scope: ['constraints'] },
  emphasize:         { action: 'apply',  scope: ['constraints'] },
  meta:              { action: 'apply',  scope: ['constraints'] },
  change:            { action: 'replan', scope: ['goal', 'plan', 'completed-steps'] },
  correction:        { action: 'replan', scope: ['plan', 'completed-steps'] },
  misunderstanding:  { action: 'replan', scope: ['plan', 'completed-steps'] },
  mixed:             { action: 'replan', scope: ['goal', 'plan', 'completed-steps'] },
  question:          { action: 'answer', scope: ['none'] },
  unrelated:         { action: 'queue',  scope: ['plan'] },
};

function dispositionOf(relation: InsertionRelation, unrelatedKind: UnrelatedKind | undefined): { action: InputAction; scope: InputScope[] } {
  if (relation === 'unrelated' && unrelatedKind === 'chatter') return { action: 'ignore', scope: ['none'] };
  return RELATION_DISPOSITION[relation];
}

/** 九类 → 处理级（第 5 期调度投影，随处置表同源定案；unrelated 的 chatter
 *  细分降陪伴级）。队列优先级从它折，不再经过 v1 kind 词表。 */
const LEVEL_BY_RELATION: Record<InsertionRelation, ProcessingLevel> = {
  supplement: 'boundary',
  emphasize: 'boundary',
  meta: 'boundary',
  question: 'immediate-answer',
  unrelated: 'queued',
  change: 'interrupt',
  correction: 'interrupt',
  misunderstanding: 'interrupt',
  mixed: 'interrupt',
};

function levelOf(relation: InsertionRelation, unrelatedKind: UnrelatedKind | undefined): ProcessingLevel {
  if (relation === 'unrelated' && unrelatedKind === 'chatter') return 'companion';
  return LEVEL_BY_RELATION[relation];
}

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
// 器，covered_branch 同款：模型拿花名册点 id，宿主只核实执行，零字面匹配）、
// GOAL_CHANGE_RE / CANCEL_PART_RE / URGENT_RE（netVerdict 字面族兜底——裁决
// 器缺席/倒下时不再猜 relation，原话直投队列）、SCOPE_ADD_RE（死代码）。
// 停/停支/续支由裁决器判定（INSERTION_CLASSIFY_PROMPT 的 action/stop_branch/
// resumes_branch 契约），宿主只核实执行。

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
    // 「这次是裁决器判的，还是正则/安全网接的」变成可查的数据（signals.via），
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
    // 契约），宿主只核实执行。裁决器缺席/倒下时不再猜 relation，原话直投。
    if (!llm) {
      return this.passthroughVerdict('no-judge');
    }
    const result = await this.classify(llm, context, text, signal, insertion.images);
    if (result.fallbackUsed) {
      // 裁决器倒下（超时/网络/解析失败）：同样原话直投，不猜。
      return this.passthroughVerdict('judge-down');
    }
    // 契约里不再有 when 字段（v2 §5.1）：时机意图从用户原话文本推导
    // （parseInputTiming 的 TIMING_CUE 兜底），裁决器只管关系。
    const timing = parseInputTiming(undefined, text, Date.now());
    return this.build(result.relation, result.reason, {
      confidence: result.confidence,
      timing,
      signals: {
        via: 'judge',
        classifier: 'llm',
        ...(result.unrelatedKind ? { unrelatedKind: result.unrelatedKind } : {}),
        ...(result.cancelsPart ? { cancelsPart: true } : {}),
        ...(result.addsAlong ? { addsAlong: true } : {}),
        // 范围确认去重（2026-10-21 刀 F）：裁决器拿花名册点名已覆盖那支的
        // 确切 id，随信号走——编排器只核实 id 真实在跑/已收工就回「那路正在
        // 跑着，不重复」，语义判断全程归模型，宿主零文本匹配。
        ...(result.coveredBranch ? { coveredBranchCallId: result.coveredBranch.callId } : {}),
        // 模型点名（2026-10-10 模型判断、宿主执行）：裁决器指认的被停支 id
        // 随信号走，编排器只按它执行真停——宿主自己不再做任何文本匹配。
        ...(result.stopBranch ? { stopBranchCallId: result.stopBranch.callId } : {}),
        // 点名续支（2026-10-28 刀 1，RESUME_BRANCH_RE 快路径的接棒者）：裁决
        // 器从花名册指认该接着跑完的那支 id，宿主只核实执行（covered_branch
        // 同款，零字面匹配）。
        ...(result.resumesBranch ? { resumesBranchCallId: result.resumesBranch.callId } : {}),
        // 被替换条件的原文片段（v2 §5.1 targets_constraint）：处置管线据此
        // 对着任务状态定位挂在死条件上的节点。过渡期随信号透传。
        ...(result.targetsConstraint ? { targetsConstraint: result.targetsConstraint } : {}),
        // 疑似 misunderstanding 的自查请求（《设想》§五.2 双重触发）：宿主
        // 据此跑「当前输出是否忠实于用户上一句」的自查，确认才真暂停。
        ...(result.selfCheckNeeded ? { selfCheckNeeded: true } : {}),
        ...(result.confidenceDefaulted ? { confidenceDefaulted: true } : {}),
        // 第 5 期「这个急」提级：裁决器判定这件活加急（只对排队新活有意义）
        // ——宿主据此在队列里插队并换提级收执。缺省绝不自己补。
        ...(result.urgent === true ? { urgent: true } : {}),
        // 现场收执（2026-10-15 定调，2026-10-27 扩为凡处置必写）：裁决器
        // 结合现场写的那两句随信号走——编排器优先转达给宿主，缺席才兜底。
        ...(result.receipt ? { receipt: result.receipt } : {}),
      },
    }, {
      unrelatedKind: result.unrelatedKind,
      ...(result.atoms?.length ? { atoms: result.atoms } : {}),
      // 整树停（刀 1）：裁决器判 action=stop 时压过处置表——落点与被删的
      // STOP_RE 快路径一致（整停不重排不重想），signals.via 据实仍是 judge。
      ...(result.action === 'stop'
        ? { action: 'stop' as InputAction, scope: ['plan', 'completed-steps'] as InputScope[] }
        : {}),
    });
  }

  /** 去重撞车的复核（2026-10-21）：宿主发现「判成 task 却撞上已在跑」的矛盾
   *  后，把事实喂回来单独问一遍——不走 decide()（同一个 system 重问会被锚定
   *  拉回原判，真机「停掉优酷这一调研」二次判 task 实证），走
   *  recheckCoveredInsertion 的独立窄问题提示词（举证责任倒置：谁会要求加
   *  一个正在跑的东西）。判定仍折成 DynamicInsertionDecision（收掉=steer/
   *  真加活=task），宿主按同一套信号消费。LLM 缺席或复核失败返回 null——
   *  调用方回终稿，宁可照旧不可误停。 */
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
    // 复核判定折回 relation 面：cancelsPart=收掉一支（change + 专门信号 →
    // 折入而非整树重排）；否则按「要回来的新活」排队（unrelated/new_task）。
    return verdict.cancelsPart
      ? this.build('change', verdict.reason || 'covered recheck', {
        confidence: verdict.confidence,
        timing: { mode: 'now' },
        signals: {
          via: 'judge',
          classifier: 'llm',
          cancelsPart: true,
          ...(verdict.stopBranchCallId ? { stopBranchCallId: verdict.stopBranchCallId } : {}),
          ...(verdict.receipt ? { receipt: verdict.receipt } : {}),
        },
      })
      : this.build('unrelated', verdict.reason || 'covered recheck', {
        confidence: verdict.confidence,
        timing: { mode: 'now' },
        signals: {
          via: 'judge',
          classifier: 'llm',
          ...(verdict.receipt ? { receipt: verdict.receipt } : {}),
        },
      }, { unrelatedKind: 'new_task' });
  }

  /**
   * 聚焦点名（模型判断、宿主执行）：要不要停由裁决器判，这里的窄问题只裁
   * 「停哪支」——只要一个确切 id。裁决器不可用或指认不出返回 null，调用方
   * 退回取消折入（宁可折叠不误杀）。
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
   *  不再按字面族猜 relation（旧 GOAL_CHANGE/CANCEL_PART/URGENT 网已删），
   *  统一按「用户原话进队列」投递：relation=unrelated → 编排器走 queue 处置
   *  =原话入队、回合收尾重入，让在跑的模型带着现场自己消化，话绝不丢
   *  （不变量 §六.1）。confidence=0.3：这不是判断，是投递策略——刻意标明
   *  「这里没有任何语义判定发生」；置信门会把它降级为 clarify（gatedFrom
   *  记得原始动作），宿主读 signals.via=passthrough 自行择路。netReason 只
   *  进日志（no-judge=没有裁决器；judge-down=超时/网络/解析失败），不参与
   *  处置。 */
  private passthroughVerdict(netReason: 'no-judge' | 'judge-down'): DynamicInsertionDecision {
    return this.build('unrelated', 'judge unavailable; inserting the user\'s words verbatim into the queue', {
      confidence: 0.3,
      timing: { mode: 'now' },
      signals: { via: 'passthrough', netReason },
    }, { action: 'apply', scope: [] });
  }

  /**
   * Assemble the shared decision shape and run the confidence gate as the LAST
   * step, so no producer path can bypass it.
   *
   * v2：action/scope 以九类处置表（RELATION_DISPOSITION）为底；专门信号
   * （cancels_part/branch_stop/stop_branch）在场时改写——点名撤一支既不排队
   * 也不整树重排，折入汇合（编排器按专门信号细分）。opts 供裁决器的整树停
   * （action=stop）与 passthrough 显式压 action/scope（命令与投递策略都不是
   * 判断，不该被处置表覆盖），judge 通道透传 mixed 的 atoms。
   */
  private build(
    relation: InsertionRelation,
    reason: string,
    fields: Pick<DynamicInsertionDecision, 'confidence' | 'timing' | 'signals'>,
    opts: { unrelatedKind?: UnrelatedKind; action?: InputAction; scope?: InputScope[]; atoms?: InsertionAtom[] } = {},
  ): DynamicInsertionDecision {
    const disposition = dispositionOf(relation, opts.unrelatedKind);
    // 专门信号三形：cancels_part（点名撤一部分）、branch_stop（规则通道的
    // 停支闸）、stop_branch.call_id（裁决器指认的被停支 id，judge 通道把它
    // 从 signals.stopBranchCallId 过河）。任一在场=点名撤一支：折入汇合，
    // 绝不整树重排。
    const dedicated =
      relation === 'change' &&
      (fields.signals.cancelsPart === true ||
        fields.signals.branchStop === true ||
        typeof fields.signals.stopBranchCallId === 'string' && fields.signals.stopBranchCallId.length > 0);
    const baseAction: InputAction = dedicated ? 'apply' : disposition.action;
    const baseScope: InputScope[] = dedicated ? ['constraints'] : disposition.scope;
    // A timed input cannot be applied to the running turn — it has to be HELD
    // until its moment arrives, whatever the classifier thought of its content.
    const action: InputAction = fields.timing.mode === 'at' && baseAction !== 'stop' ? 'queue' : opts.action ?? baseAction;
    const decision: DynamicInsertionDecision = {
      source: 'mid-run-insert',
      relation,
      ...(opts.unrelatedKind ? { unrelatedKind: opts.unrelatedKind } : {}),
      ...(opts.atoms?.length ? { atoms: opts.atoms } : {}),
      kind: relation,
      action,
      confidence: fields.confidence,
      timing: fields.timing,
      scope: opts.scope ?? baseScope,
      shouldAbort: action === 'stop' || action === 'replan',
      reason,
      // 第 5 期调度显式化：处理级从九类处置表折（与 action 同源），随信号
      // 过河——宿主/队列按它分轻重缓急，不再经过 v1 kind 词表。
      signals: { ...fields.signals, processingLevel: levelOf(relation, opts.unrelatedKind) },
    };
    // The gate can downgrade the action to `clarify` and clears shouldAbort with
    // it: asking the user must never tear down the running work first.
    return applyConfidenceGate(decision) as DynamicInsertionDecision;
  }

  /**
   * 自查降级（v2 §七 真暂停的双重触发之二）：疑似 misunderstanding 时宿主
   * 拿三要素现场问一遍「当前输出是否忠实于用户上一句」——判词是模型的，宿主
   * 只执行（verdict.drifting=true 才走真暂停链；null=自查链路坏了，降级为
   * 普通 steer 转达，绝不拿坏链路当暂停依据）。
   */
  selfCheckDrift(
    llm: LLMAdapter | null,
    context: string,
    insertText: string,
    signal?: AbortSignal,
  ): Promise<FaithfulnessVerdict | null> {
    return checkOutputFaithfulness(llm, context, insertText, signal);
  }
}
