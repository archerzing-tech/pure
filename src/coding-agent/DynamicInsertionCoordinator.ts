import type { LLMAdapter, MessageImage } from '../shared/types';
import { classifyInsertion, type InsertionClassification } from './Planner';
import {
  applyConfidenceGate,
  parseInputTiming,
  type InputAction,
  type InputDecision,
  type InputScope,
} from './inputDecision';

/**
 * 插话重构（2026-09-19）：一个人在埋头干活时听到同事插话，只有三种情况
 * 值得停下手里的活——对方说"别干了"（stop），对方把方向掀了
 * （goal-change），或者对方纠正了手里这活所依据的事实（premise-change：
 * "其实我在西安"——目标没变，但按错误前提算出来的东西全都不值钱了，接着
 * 跑就是白烧）。其余一切都不值得推倒重来：提醒、约束、补充顺着下个动作
 * 带上就好（steer）；提问先答一句（question）；新活儿排到手里这单后面
 * （task）；寒暄点头收下（chatter）。
 */
export type DynamicInsertionKind = 'stop' | 'premise-change' | 'goal-change' | 'steer' | 'question' | 'task' | 'chatter';

export interface DynamicInsertion {
  text: string;
  images?: MessageImage[];
  displayText?: string;
}

/** The insert decision in the SHARED shape (inputDecision.ts): the kind is kept
 *  verbatim for the UI's switch, while action/confidence/timing/scope are what
 *  the rest of the app can reason about without knowing insertion vocabulary. */
export interface DynamicInsertionDecision extends InputDecision {
  source: 'mid-run-insert';
  kind: DynamicInsertionKind;
  /** True → the running turn must end so the insert can re-enter as a fresh
   *  send (stop / goal-change / premise-change only, and never while a
   *  low-confidence decision is waiting for the user's answer). False → the
   *  turn keeps running and the insert is handled out-of-band
   *  (steer / question / task / chatter). */
  shouldAbort: boolean;
}

/** What each kind does to the running work, and what it touches — the join
 *  between insertion vocabulary and the shared action/scope words. */
const KIND_POLICY: Record<DynamicInsertionKind, { action: InputAction; scope: InputScope[] }> = {
  stop:            { action: 'stop',   scope: ['plan', 'completed-steps'] },
  'goal-change':   { action: 'replan', scope: ['goal', 'plan', 'completed-steps'] },
  // The goal stands but the fact it is computed from is wrong: everything
  // derived from it is worthless, so the plan and the done steps are in scope.
  'premise-change': { action: 'replan', scope: ['plan', 'completed-steps'] },
  steer:           { action: 'apply',  scope: ['constraints'] },
  question:        { action: 'answer', scope: ['none'] },
  task:            { action: 'queue',  scope: ['plan'] },
  chatter:         { action: 'ignore', scope: ['none'] },
};

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
}

const STOP_RE = /^(?:停止|停下|取消|中止|别做了|先别做|abort|stop|cancel|halt|nevermind)(?:\b|$|[一-鿿])/i;
// 2026-09-28 降级为安全网（见 decide() 注）：推翻话不再由正则直判——
// "改成X"和"推翻重来"的分寸只有结合时机和内容才判得准，正则只在裁决器
// 倒下时兜底（netVerdict）。
const GOAL_CHANGE_RE = /(?:推翻|重新来|重做|从头来|换个方案|换一种思路|换个思路|start over|redo it|rethink|different approach|scrap (?:that|this|it))/i;
// 加活字面族，同样降级为安全网。2026-09-22 的两次丢失（"再加一个 爱奇艺
// 平台"）是 steer 的空头承诺（父任务阻塞收委派时没有"下个动作"可兑现），
// 排队是唯一保证跑完的投递。2026-09-28 重构把这个保证留在网里（裁决器
// 不可用 → 排队），主路让给裁决器：加的东西可能是往在飞的那一件产出物里
// 加（画鸟补云/五位加两位），只有看得到时机的裁决器分得清——正则分不清。
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
const BRANCH_STOP_RE = /(?:停掉|停了|掐掉|砍掉|终止|取消|停下)(?:帮?我?)(?:把)?[^。\n！!？?]{0,16}?(?:那支|那路|那一路|那条|那个分支)|(?:停掉|停了|掐掉|砍掉|终止|取消|停下)(?:把)?[^。\n！!？?]{0,16}?(?:那支|那路|那一路|那条|那个分支)|(?:那支|那路|那一路|那条|那个分支)[^。\n！!？?]{0,10}(?:停下来|别跑|停了|不用跑|停掉|掐掉|砍掉|终止|取消)/i;
// 分支级继续（第 2 期第三刀）：「把竞品那支接着跑完」「让报价那路继续」。
// 与 BRANCH_STOP_RE 同款：必须有分支锚（那支/那路/…），续跑动词前后皆可——
// 命中即由宿主按 callId 找到那支已暂停/已停的档案，用**原始参数**同参重派
// （稳定 sessionId 命中断点 → 引擎 continue）。没有点名锚的「继续」是整树
// 续跑（走「继续」条），绝不在这里赌。
export const RESUME_BRANCH_RE = /(?:继续|接着|续上|接续)(?:帮?我?)?[^。\n！!？?]{0,16}?(?:那支|那路|那一路|那条|那个分支)|(?:把)?[^。\n！!？?]{0,16}?(?:那支|那路|那一路|那条|那个分支)[^。\n！!？?]{0,12}?(?:接着|继续|续上|接着跑|继续跑|跑完|接着弄|继续弄|接着做|继续做|接着干|继续干)/i;

export class DynamicInsertionCoordinator {
  private readonly classify: NonNullable<DynamicInsertionCoordinatorOptions['classify']>;

  constructor(options: DynamicInsertionCoordinatorOptions = {}) {
    this.classify = options.classify ?? classifyInsertion;
  }

  async decide(
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
      return this.build('steer', 'imperative branch-stop matched the fast path; the named branch is aborted now', {
        confidence: RULE_CONFIDENCE,
        timing: { mode: 'now' },
        signals: { rule: 'BRANCH_STOP_RE', branchStop: true },
      });
    }
    if (RESUME_BRANCH_RE.test(text)) {
      // 分支级继续（第 2 期第三刀）：点名把某一支接着跑完。宿主按区分词找到
      // 那支已暂停/已停的档案，用原始参数同参重派——稳定 sessionId 命中
      // checkpoint 续跑，不从头做。排在 STOP/收活/加活之前：带点名锚的
      // 「接着跑」比整树续跑、加活都具体。
      return this.build('steer', 'named-branch resume matched the fast path; the branch is re-delegated from its checkpoint', {
        confidence: RULE_CONFIDENCE,
        timing: { mode: 'now' },
        signals: { rule: 'RESUME_BRANCH_RE', resumesBranch: true },
      });
    }
    if (STOP_RE.test(text)) {
      // Mechanical, high-precision, and latency-free: a stop must not wait on
      // (or be misread by) a classification round-trip.
      return this.build('stop', 'user requested the current run to stop', {
        confidence: RULE_CONFIDENCE,
        timing: { mode: 'now' },
        signals: { rule: 'STOP_RE' },
      });
    }
    // 2026-09-28 用户定调：决策不看关键词——正则只配做裁决器倒下时的安全网。
    // 上面的三类（整停/点名停支/点名续支）是**命令**不是判断：人对"停"字
    // 不需要 deliberation，等一次裁决往返反而是抗命。其余一切（加活/收活/
    // 推翻/约束/纠错/提问/寒暄）全走裁决器——时机×内容×结果收益的综合
    // 判断；字面族（SCOPE_ADD/CANCEL_PART/GOAL_CHANGE）只在裁决不可用时
    // 兜底（netVerdict），绝不再抢在判断前面。
    if (!llm) {
      return this.netVerdict(text, 'classification unavailable');
    }
    const result = await this.classify(llm, context, text, signal, insertion.images);
    if (result.fallbackUsed) {
      // 裁决器倒下（超时/网络/解析失败）：字面网兜底，话绝不丢。
      return this.netVerdict(text, 'judge unreachable');
    }
    // premise-change 与 goal-change 同判：前提错了的在飞委派不会因为"下个
    // 动作带上"就变对——止损要趁早，停掉重排比跑完再改便宜（KIND_POLICY）。
    const timing = parseInputTiming(result.when, text, Date.now());
    return this.build(result.kind, result.reason, {
      confidence: result.confidence,
      timing,
      signals: {
        classifier: 'llm',
        ...(result.cancelsPart ? { cancelsPart: true } : {}),
        ...(result.resumesPart ? { resumesBranch: true } : {}),
        ...(result.supplementsCurrent ? { supplementsCurrent: true } : {}),
        ...(result.confidenceDefaulted ? { confidenceDefaulted: true } : {}),
        ...(result.when ? { when: result.when } : {}),
      },
    });
  }

  /** 安全网（2026-09-28 降级）：只裁决器倒下时用它——按字面族挑一个**不丢
   * 话**的目的地，绝不冒充判断。推翻话重开、收活折入、其余一律排队（唯一
   * 保证跑完的投递）。 */
  private netVerdict(text: string, why: string): DynamicInsertionDecision {
    if (GOAL_CHANGE_RE.test(text)) {
      return this.build('goal-change', `${why}; overturn phrasing caught by the literal net`, {
        confidence: NO_CLASSIFIER_CONFIDENCE,
        timing: { mode: 'now' },
        signals: { fallback: 'literal-net' },
      });
    }
    if (CANCEL_PART_RE.test(text)) {
      return this.build('steer', `${why}; partial-cancellation caught by the literal net — the named part leaves the result`, {
        confidence: NO_CLASSIFIER_CONFIDENCE,
        timing: { mode: 'now' },
        signals: { fallback: 'literal-net', cancelsPart: true },
      });
    }
    return this.build('task', `${why}; queued so the words can never be lost`, {
      confidence: NO_CLASSIFIER_CONFIDENCE,
      timing: { mode: 'after-current' },
      signals: { fallback: 'literal-net' },
    });
  }

  /**
   * Assemble the shared decision shape and run the confidence gate as the LAST
   * step, so no producer path can bypass it.
   */
  private build(
    kind: DynamicInsertionKind,
    reason: string,
    fields: Pick<DynamicInsertionDecision, 'confidence' | 'timing' | 'signals'>,
  ): DynamicInsertionDecision {
    const policy = KIND_POLICY[kind];
    // A timed input cannot be applied to the running turn — it has to be HELD
    // until its moment arrives, whatever the classifier thought of its content.
    const action: InputAction = fields.timing.mode === 'at' && policy.action !== 'stop' ? 'queue' : policy.action;
    const decision: DynamicInsertionDecision = {
      source: 'mid-run-insert',
      kind,
      action,
      confidence: fields.confidence,
      timing: fields.timing,
      scope: policy.scope,
      shouldAbort: action === 'stop' || action === 'replan',
      reason,
      signals: fields.signals,
    };
    // The gate can downgrade the action to `clarify` and clears shouldAbort with
    // it: asking the user must never tear down the running work first.
    return applyConfidenceGate(decision) as DynamicInsertionDecision;
  }
}
