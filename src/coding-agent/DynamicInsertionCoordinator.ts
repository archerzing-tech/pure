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
 *  - judge：裁决器（LLM）按「时机 × 内容对结果的影响」综合判的，正常路径
 *  - rule ：机械正则快路径（整停 / 点名停支 / 点名续支——命令不是判断）
 *  - net  ：字面安全网（裁决器不可用时的兜底，signals.netReason 说明原因）
 *  三者互斥且必填，决策日志（inputDecision.ts）据此对账。 */

/**
 * 插话架构 v2（2026-10-27）：判定面是九类 relation（Planner 的
 * InsertionRelation——supplement/change/emphasize/unrelated/correction/
 * question/mixed/meta/misunderstanding，蓝图 §五），处置臂按 relation 分发
 * （interjectOrchestrator §六处置表）。v1 的七类 kind 与它的折算层
 * （dispatchKindOf）随九类分发臂落地一并删除：decision.kind 现在直接承载
 * relation 值——它只是 InputDecision 的「producer 专属标签」槽（日志可读、
 * 旧消费者仍能 switch），权威语义在 relation。
 *
 * 三通道结构不变（2026-09-28 定调）：字面命令（整停/点名停支/点名续支）走
 * rule 快路径零往返；其余全走 judge 裁决器（时机×内容×结果收益的综合判断）；
 * judge 倒下时 net 字面网兜底，话绝不丢。
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

/** Confident by construction: a mechanical rule matched. */
const RULE_CONFIDENCE = 1;
/** Confident by policy: with no classifier, queueing is the chosen answer —
 *  it is the one destination that cannot lose the words (see decide()). */
const NO_CLASSIFIER_CONFIDENCE = 1;

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

// 导出只为可测/可回放（见 scripts/replay-insertion-decisor.ts）：这些常量
// 是「哪些话会被机械路径抢答」的唯一事实来源，回放脚本不能复制一份。
export const STOP_RE = /^(?:停止|停下|取消|中止|别做了|先别做|abort|stop|cancel|halt|nevermind)(?:\b|$|[一-鿿])/i;
// 2026-09-28 降级为安全网（见 decide() 注）：推翻话不再由正则直判——
// "改成X"和"推翻重来"的分寸只有结合时机和内容才判得准，正则只在裁决器
// 倒下时兜底（netVerdict）。
export const GOAL_CHANGE_RE = /(?:推翻|重新来|重做|从头来|换个方案|换一种思路|换个思路|start over|redo it|rethink|different approach|scrap (?:that|this|it))/i;
// 加活字面族，同样降级为安全网。2026-09-22 的两次丢失（"再加一个 爱奇艺
// 平台"）是 steer 的空头承诺（父任务阻塞收委派时没有"下个动作"可兑现），
// 排队是唯一保证跑完的投递。2026-09-28 重构把这个保证留在网里（裁决器
// 不可用 → 排队），主路让给裁决器：加的东西可能是往在飞的那一件产出物里
// 加（画鸟补云/五位加两位），只有看得到时机的裁决器分得清——正则分不清。
// 2026-09-28 二段：连"安全网里的一个分支"也算不上了——netVerdict 的默认
// 目的地本来就是排队 task，"加活"与"其余"合并成同一条，所以这个字面族
// 不再参与任何生产判定（留着只作两用：给回放脚本标注"加活族"，以及记着
// 当年丢话事故的原句形状）。
export const SCOPE_ADD_RE = /(?<!别)(?<!不)(?<!不用)(?<!不要)(?<!无需)(?<!先不)(?<!莫)(?:再加(?!一?句)|增加|增添|再添|再补(?!一?句)|再算上|再算一个|顺便(?!问|说|提|聊)(?:也)?(?:查|调研|研究|搜|分析|做|跑|处理|加)|也帮?我?(?:查|调研|研究|搜|分析|处理|跑)(?:一?下|一遍)?|把.{1,16}也(?:查|调研|研究|搜|分析|处理|跑|做|算)(?:一?下|一遍)?|同样(?:处理|调研|分析|跑|做)|也来一?份|add (?:one more|another)|also (?:add|check|research|look into|run|include))/i;
// 收掉一部分（"X 就不调研了"，"Y 那个不用查了"）：steer 的删除语义，
// 2026-09-24 真实事故的字面形状——并行调研中砍一支被判成加活折入（"先补
// 这项"），与意图正好相反。同样降级为安全网：主路由裁决器判 cancels_part，
// 网只在裁决器倒下时接手。词族刻意窄：动词族不含裸做（"别做了"是整树停
// 还收一支只有看得到上下文才分得清）、否定标记必须、了/吧 尾巴挡住纯保留
// 约束（"不用改"）——更软的话全归裁决器，含否定式加活（"不用再加知乎了"）。
export const CANCEL_PART_RE = /[^\n。！!？?]{0,24}(?:(?:不需|不用|不)要?再?|先不|别|莫)(?:帮?我?)?(?:查|调研|研究|分析|搜|跑|处理|翻译|改|写|画|生成)[^。，,；\n]{0,12}?(?:了|吧)(?![一-鿿A-Za-z])/i;
// 祈使式「停掉某一支」（第 2 期分支中断快路径）：「停掉竞品那支」「把调研
// 那路掐掉」「分析那条路停下来」。与 CANCEL_PART_RE（"X 就不调研了"——收
// 掉一项出结果）的差别在时态：这是**现在就叫它停**，宿主点名寻址后直接
// abortBranch，不等汇合轮。锚定词必须是 那支/那路/那一路/那条/分支——没有
// 点名锚的「停掉」是整树 stop（STOP_RE 管）或该归分类器的话，宁可慢不可错。
// 动词前置（停掉X那支，含「停下」）、把字句（把X那路掐掉）、锚后追停
// （X那支别跑了/那个分支停下来）三种语序都收。判定次序上它排在 STOP_RE
// 和 CANCEL_PART_RE 之前：带点名锚的停比整树停、收活都具体——「停下竞品
// 那支」不能被整树 abort，「那路别跑了」不能被折进汇合轮。
export const BRANCH_STOP_RE = /(?:停掉|停了|掐掉|砍掉|终止|取消|停下)(?:帮?我?)(?:把)?[^。\n！!？?]{0,16}?(?:那支|那路|那一路|那条|那个分支)|(?:停掉|停了|掐掉|砍掉|终止|取消|停下)(?:把)?[^。\n！!？?]{0,16}?(?:那支|那路|那一路|那条|那个分支)|(?:那支|那路|那一路|那条|那个分支)[^。\n！!？?]{0,10}(?:停下来|别跑|停了|不用跑|停掉|掐掉|砍掉|终止|取消)/i;
// 分支级继续（第 2 期第三刀）：「把竞品那支接着跑完」「让报价那路继续」。
// 与 BRANCH_STOP_RE 同款：必须有分支锚（那支/那路/…），续跑动词前后皆可——
// 命中即由宿主按 callId 找到那支已暂停/已停的档案，用**原始参数**同参重派
// （稳定 sessionId 命中断点 → 引擎 continue）。没有点名锚的「继续」是整树
// 续跑（走「继续」条），绝不在这里赌。
export const RESUME_BRANCH_RE = /(?:继续|接着|续上|接续)(?:帮?我?)?[^。\n！!？?]{0,16}?(?:那支|那路|那一路|那条|那个分支)|(?:把)?[^。\n！!？?]{0,16}?(?:那支|那路|那一路|那条|那个分支)[^。\n！!？?]{0,12}?(?:接着|继续|续上|接着跑|继续跑|跑完|接着弄|继续弄|接着做|继续做|接着干|继续干)/i;

// 第 5 期「这个急」提级的安全网（对称于 STOP_RE，但**只在裁决器倒下时**由
// netVerdict 使用，绝不抢在裁决器前面抢答）：用户口头声明这件活加急/优先。
// 窄词族——「加急/优先(办)/先办/插队/urgent/asap」与「这个(很/挺…)急」，
// 且用否定前视挡掉「不着急/不急/别急」（把一句"不慌"读成"加急"就是反向
// 调度）。主路径是裁决器把 urgent 判进分类（见 INSERTION_CLASSIFY_PROMPT），
// 正则只负责裁决器不可用时不把急件默默降级成普通排队。
export const URGENT_RE = /(?:加急|优先(?:办|做|处理|安排)?|插队|先(?:办|做|处理)|urgent|asap|high\s*priority|(?:这个|这件|这项|这句|这活|它)(?:非常|很|特别|比较|挺|有点|真)*(?<!不|别|没|莫)急)/i;

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
    // 先后：命令（字面停/点名停支/点名续支）由 decideInner 最先的几条正则
    // 接走，不进裁决器；其余（含裁决器的 stop 档）走判断。
    const decision = await this.decideInner(llm, context, insertion, signal);
    // 每条插话决策都进共享日志（inputDecision.ts 的 recordInputDecision）：
    // 「这次是裁决器判的，还是正则/安全网接的」变成可查的数据（signals.via），
    // 设置页诊断区读它，formatInputDecisionLog() 还能整段导出回放。记录点在
    // 唯一出口，所以四条生产路径（rule / judge / net-no-judge / net-down）
    // 都不可能绕过。
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
    if (BRANCH_STOP_RE.test(text)) {
      // 祈使式停一支（第 2 期）：宿主点名寻址后直接 abortBranch 真停。排在
      // 一切整树/收活规则之前（理由见 BRANCH_STOP_RE 注）。点不到具体支时
      // 宿主退回取消折入——宁可折叠不误杀（快路径只负责快，不负责赌）。
      // relation 面：点名停支=change 的一个特写（撤掉正在跑的一部分），但
      // 带分支锚的命令由专门臂接走，不落整树 replan。
      return this.build('change', 'imperative branch-stop matched the fast path; the named branch is aborted now', {
        confidence: RULE_CONFIDENCE,
        timing: { mode: 'now' },
        signals: { via: 'rule', rule: 'BRANCH_STOP_RE', branchStop: true },
      }, { action: 'apply', scope: ['constraints'] });
    }
    if (RESUME_BRANCH_RE.test(text)) {
      // 分支级继续（第 2 期第三刀）：点名把某一支接着跑完。宿主按区分词找到
      // 那支已暂停/已停的档案，用原始参数同参重派——稳定 sessionId 命中
      // checkpoint 续跑，不从头做。排在 STOP/收活/加活之前：带点名锚的
      // 「接着跑」比整树续跑、加活都具体。relation=supplement（让既有工作
      // 继续产出，无撤无改）。
      return this.build('supplement', 'named-branch resume matched the fast path; the branch is re-delegated from its checkpoint', {
        confidence: RULE_CONFIDENCE,
        timing: { mode: 'now' },
        signals: { via: 'rule', rule: 'RESUME_BRANCH_RE', resumesBranch: true },
      }, { action: 'apply', scope: ['constraints'] });
    }
    if (STOP_RE.test(text)) {
      // Mechanical, high-precision, and latency-free: a stop must not wait on
      // (or be misread by) a classification round-trip. relation=change（整停
      // 特例，蓝图 §十.5），action 压在 stop——字面停不重排不重想。
      return this.build('change', 'user requested the current run to stop', {
        confidence: RULE_CONFIDENCE,
        timing: { mode: 'now' },
        signals: { via: 'rule', rule: 'STOP_RE' },
      }, { action: 'stop', scope: ['plan', 'completed-steps'] });
    }
    // 2026-09-28 用户定调：决策不看关键词——正则只配做裁决器倒下时的安全网。
    // 上面的三类（整停/点名停支/点名续支）是**命令**不是判断：人对"停"字
    // 不需要 deliberation，等一次裁决往返反而是抗命。其余一切（加活/收活/
    // 推翻/约束/纠错/提问/寒暄/**非字面的停**）全走裁决器——时机×内容×
    // 结果收益的综合判断；字面族（SCOPE_ADD/CANCEL_PART/GOAL_CHANGE）只在
    // 裁决不可用时兜底（netVerdict），绝不再抢在判断前面。
    if (!llm) {
      return this.netVerdict(text, 'classification unavailable', 'no-judge');
    }
    const result = await this.classify(llm, context, text, signal, insertion.images);
    if (result.fallbackUsed) {
      // 裁决器倒下（超时/网络/解析失败）：字面网兜底，话绝不丢。
      return this.netVerdict(text, 'judge unreachable', 'judge-down');
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
    }, { unrelatedKind: result.unrelatedKind, ...(result.atoms?.length ? { atoms: result.atoms } : {}) });
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
   * 规则快路径的聚焦点名：BRANCH_STOP_RE 只裁「要不要停」（命令零延迟），
   * 不裁「停哪支」——指认是理解，归裁决器。裁决器不可用或指认不出返回
   * null，调用方退回取消折入（宁可折叠不误杀）。
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

  /** 安全网（2026-09-28 降级；2026-10-21 刀 D 反转默认投递）：只裁决器倒下
   *  时用它——按字面族挑目的地，绝不冒充判断。推翻话重开、收活折入不变；
   *  **其余从「一律排队」反转为「能注入就注入」**：steer 通道的话落引擎
   *  THINK 边界、进会话历史——模型带着现场自己判它是什么、怎么接（freebuff
   *  无分类器的同款哲学：把「怎么处置」交给带现场的模型，烂天气也不该把
   *  话冻结到回合外）；没被边界带走的残留由回合收尾 settleRound 原话重入，
   *  话照样丢不了——「排队是唯一不丢话的投递」这个旧前提已不成立。排队
   *  的真正代价（2026-10-21 用户报的病根）是语境断裂：重入时现场已散。
   *  加急件例外：提级的落点只在队列（插到队头），注入反而把它不排队。 */
  private netVerdict(text: string, why: string, netReason: 'no-judge' | 'judge-down'): DynamicInsertionDecision {
    if (GOAL_CHANGE_RE.test(text)) {
      // 推翻话重开：relation=change → replan。
      return this.build('change', `${why}; overturn phrasing caught by the literal net`, {
        confidence: NO_CLASSIFIER_CONFIDENCE,
        timing: { mode: 'now' },
        signals: { via: 'net', netReason, fallback: 'literal-net' },
      });
    }
    if (CANCEL_PART_RE.test(text)) {
      // 收活折入：relation=change + cancels_part 专门信号 → 折入而非整树重排
      // （点名撤一支，其余照跑——2026-09-24 口径）。
      return this.build('change', `${why}; partial-cancellation caught by the literal net — the named part leaves the result`, {
        confidence: NO_CLASSIFIER_CONFIDENCE,
        timing: { mode: 'now' },
        signals: { via: 'net', netReason, fallback: 'literal-net', cancelsPart: true },
      });
    }
    if (URGENT_RE.test(text)) {
      // 「这个急」的字面安全网：裁决器不可用时，别把一句明确的加急请求默默
      // 降级成普通排队（提级只改队列次序，不涉破坏性动作，网在这里用是安全的）。
      return this.build('unrelated', `${why}; queued ahead (urgent) so the words can never be lost`, {
        confidence: NO_CLASSIFIER_CONFIDENCE,
        timing: { mode: 'after-current' },
        signals: { via: 'net', netReason, fallback: 'literal-net', urgent: true },
      }, { unrelatedKind: 'new_task' });
    }
    // 默认投递：能注入就注入（relation=supplement → apply）。steer 通道的话
    // 落引擎 THINK 边界、进会话历史——模型带着现场自己判它是什么、怎么接；
    // 残留由回合收尾 settleRound 原话重入，话照样丢不了。
    return this.build('supplement', `${why}; handed to the running turn at its next boundary — the words land in the conversation, and close sweeps any leftovers back in`, {
      confidence: NO_CLASSIFIER_CONFIDENCE,
      timing: { mode: 'now' },
      signals: { via: 'net', netReason, fallback: 'literal-net' },
    });
  }

  /**
   * Assemble the shared decision shape and run the confidence gate as the LAST
   * step, so no producer path can bypass it.
   *
   * v2：action/scope 以九类处置表（RELATION_DISPOSITION）为底；专门信号
   * （cancels_part/branch_stop/stop_branch）在场时改写——点名撤一支既不排队
   * 也不整树重排，折入汇合（编排器按专门信号细分）。opts 供 rule 通道显式压
   * action/scope（命令不是判断，不该被处置表覆盖），judge 通道透传 mixed 的
   * atoms。
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
