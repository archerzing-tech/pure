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
// Fast path limited to unambiguous overturn verbs: anything softer ("改成X",
// "不要再Y") is judged by the LLM with the task in view — a constraint phrased
// as 不要 is still just a steer, and aborting on it used to restart work the
// user never asked to restart.
const GOAL_CHANGE_RE = /(?:推翻|重新来|重做|从头来|换个方案|换一种思路|换个思路|start over|redo it|rethink|different approach|scrap (?:that|this|it))/i;
// Scope additions take the SAME deterministic road into the task queue. Both
// 2026-09-22 losses ("再加一个 爱奇艺平台") were acknowledged as steer and then
// forgotten: the LLM kept judging additions steerable, and steer's promise
// ("the next step carries it") is uncashable while the parent is blocked
// collecting parallel delegations — the engine drains the words at the final
// summary round, nothing acts on them, and the leftover-drain net only catches
// steers the engine never took. Queuing makes no promise it can't keep: the
// item runs to completion right after the current task. So obvious additions
// skip the classifier entirely (like STOP_RE), conservative high-precision
// family only, negated forms fall through to the LLM.
const SCOPE_ADD_RE = /(?<!别)(?<!不)(?<!不用)(?<!不要)(?<!无需)(?<!先不)(?<!莫)(?:再加(?!一?句)|增加|增添|再添|再补(?!一?句)|再算上|再算一个|顺便(?!问|说|提|聊)(?:也)?(?:查|调研|研究|搜|分析|做|跑|处理|加)|也帮?我?(?:查|调研|研究|搜|分析|处理|跑)(?:一?下|一遍)?|把.{1,16}也(?:查|调研|研究|搜|分析|处理|跑|做|算)(?:一?下|一遍)?|同样(?:处理|调研|分析|跑|做)|也来一?份|add (?:one more|another)|also (?:add|check|research|look into|run|include))/i;
// Cancelling ONE PART of the running work ("X 就不调研了", "Y 那个不用查了"):
// a steer with removal semantics, decided mechanically like the families
// above. The 2026-09-24 real-world loss had exactly this shape — a branch of
// a three-way parallel research cancelled mid-run was read as a scope
// ADDITION and folded into the merge as "先补这项", the exact reverse of what
// was asked. Deliberately narrow: the verb family excludes bare 做 (whether
// "别做了" ends the whole run or one branch is context only the classifier
// has), a negation marker is mandatory, and the 了/吧 tail keeps pure
// keep-constraints ("不用改") out — anything softer falls through to the LLM,
// including negated additions ("不用再加知乎了"), which stay unqueued.
const CANCEL_PART_RE = /[^\n。！!？?]{0,24}(?:(?:不需|不用|不)要?再?|先不|别|莫)(?:帮?我?)?(?:查|调研|研究|分析|搜|跑|处理|翻译|改|写|画|生成)[^。，,；\n]{0,12}?(?:了|吧)(?![一-鿿A-Za-z])/i;

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
    now = Date.now(),
  ): Promise<DynamicInsertionDecision> {
    const text = insertion.text.trim();
    if (STOP_RE.test(text)) {
      // Mechanical, high-precision, and latency-free: a stop must not wait on
      // (or be misread by) a classification round-trip.
      return this.build('stop', 'user requested the current run to stop', {
        confidence: RULE_CONFIDENCE,
        timing: { mode: 'now' },
        signals: { rule: 'STOP_RE' },
      });
    }
    if (GOAL_CHANGE_RE.test(text)) {
      // Same rationale as STOP_RE: these verbs leave no room for "keep
      // going with a tweak", so restart without burning a classify call.
      return this.build('goal-change', 'overturn phrasing matched the fast path', {
        confidence: RULE_CONFIDENCE,
        timing: { mode: 'now' },
        signals: { rule: 'GOAL_CHANGE_RE' },
      });
    }
    if (CANCEL_PART_RE.test(text)) {
      // 收掉的是活的一部分，不是全部：走 steering 通道（不打断、不重排），
      // cancelsPart 让宿主按"该项出结果、不进汇总"折入/注入，绝不排队。
      return this.build('steer', 'partial-cancellation phrasing matched the fast path; the named part leaves the result', {
        confidence: RULE_CONFIDENCE,
        timing: { mode: 'now' },
        signals: { rule: 'CANCEL_PART_RE', cancelsPart: true },
      });
    }
    if (SCOPE_ADD_RE.test(text)) {
      // 加活的量不走分类赌局：排队是唯一保证跑完的投递（见 SCOPE_ADD_RE 注）。
      return this.build('task', 'scope-addition phrasing matched the fast path; queued so it cannot be forgotten', {
        confidence: RULE_CONFIDENCE,
        timing: { mode: 'after-current' },
        signals: { rule: 'SCOPE_ADD_RE' },
      });
    }
    if (!llm) {
      // No classifier available: queue as a task, never steer. The old steer
      // default trusted the engine to reconcile the words at the next THINK
      // boundary — but a parent blocked on parallel delegations has no such
      // boundary until the aggregation round, where remarks silently drop
      // (user-reported three times). Queueing waits its turn and runs
      // deterministically; the words can never be lost.
      return this.build('task', 'classification unavailable; queued so the words can never be lost', {
        confidence: NO_CLASSIFIER_CONFIDENCE,
        timing: { mode: 'after-current' },
        signals: { fallback: 'no-classifier' },
      });
    }
    const result = await this.classify(llm, context, text, signal, insertion.images);
    // premise-change 与 goal-change 同判：前提错了的在飞委派不会因为"下个
    // 动作带上"就变对——止损要趁早，停掉重排比跑完再改便宜（KIND_POLICY）。
    const timing = parseInputTiming(result.when, text, now);
    return this.build(result.kind, result.reason, {
      confidence: result.confidence,
      timing,
      signals: {
        classifier: 'llm',
        ...(result.cancelsPart ? { cancelsPart: true } : {}),
        ...(result.confidenceDefaulted ? { confidenceDefaulted: true } : {}),
        ...(result.when ? { when: result.when } : {}),
      },
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
