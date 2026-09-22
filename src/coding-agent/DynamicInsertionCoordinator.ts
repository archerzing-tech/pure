import type { LLMAdapter, MessageImage } from '../shared/types';
import { classifyInsertion, type InsertionClassification } from './Planner';

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

export interface DynamicInsertionDecision {
  kind: DynamicInsertionKind;
  reason: string;
  /** True → the running turn must end so the insert can re-enter as a fresh
   *  send (stop / goal-change only). False → the turn keeps running and the
   *  insert is handled out-of-band (steer / question / task / chatter). */
  shouldAbort: boolean;
}

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
const SCOPE_ADD_RE = /(?<!别)(?<!不)(?<!不用)(?<!不要)(?<!无需)(?<!先不)(?<!莫)(?:再加(?!一?句)|再添|再补(?!一?句)|再算上|再算一个|顺便(?!问|说|提|聊)(?:也)?(?:查|调研|研究|搜|分析|做|跑|处理|加)|也帮?我?(?:查|调研|研究|搜|分析|处理|跑)(?:一?下|一遍)?|把.{1,16}也(?:查|调研|研究|搜|分析|处理|跑|做|算)(?:一?下|一遍)?|同样(?:处理|调研|分析|跑|做)|也来一?份|add (?:one more|another)|also (?:add|check|research|look into|run|include))/i;

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
    if (STOP_RE.test(text)) {
      // Mechanical, high-precision, and latency-free: a stop must not wait on
      // (or be misread by) a classification round-trip.
      return { kind: 'stop', reason: 'user requested the current run to stop', shouldAbort: true };
    }
    if (GOAL_CHANGE_RE.test(text)) {
      // Same rationale as STOP_RE: these verbs leave no room for "keep
      // going with a tweak", so restart without burning a classify call.
      return { kind: 'goal-change', reason: 'overturn phrasing matched the fast path', shouldAbort: true };
    }
    if (SCOPE_ADD_RE.test(text)) {
      // 加活的量不走分类赌局：排队是唯一保证跑完的投递（见 SCOPE_ADD_RE 注）。
      return { kind: 'task', reason: 'scope-addition phrasing matched the fast path; queued so it cannot be forgotten', shouldAbort: false };
    }
    if (!llm) {
      // No classifier available: deliver the words as a steer. The engine
      // reconciles them at the next THINK boundary — working with more
      // information is the safe default, aborting is not.
      return { kind: 'steer', reason: 'classification unavailable; delivered as a steer', shouldAbort: false };
    }
    const result = await this.classify(llm, context, text, signal, insertion.images);
    // premise-change 与 goal-change 同判：前提错了的在飞委派不会因为"下个
    // 动作带上"就变对——止损要趁早，停掉重排比跑完再改便宜。
    return { kind: result.kind, reason: result.reason, shouldAbort: result.kind === 'goal-change' || result.kind === 'premise-change' };
  }
}
