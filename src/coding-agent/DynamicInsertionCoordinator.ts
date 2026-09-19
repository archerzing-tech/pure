import type { LLMAdapter, MessageImage } from '../shared/types';
import { classifyInsertion, type InsertionClassification } from './Planner';

/**
 * 插话重构（2026-09-19）：一个人在埋头干活时听到同事插话，只有两种情况
 * 值得停下手里的活——对方说"别干了"（stop），或者对方把方向掀了
 * （goal-change）。其余一切都不值得推倒重来：提醒、约束、补充顺着下个动作
 * 带上就好（steer）；提问先答一句（question）；新活儿排到手里这单后面
 * （task）；寒暄点头收下（chatter）。
 */
export type DynamicInsertionKind = 'stop' | 'goal-change' | 'steer' | 'question' | 'task' | 'chatter';

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
    if (!llm) {
      // No classifier available: deliver the words as a steer. The engine
      // reconciles them at the next THINK boundary — working with more
      // information is the safe default, aborting is not.
      return { kind: 'steer', reason: 'classification unavailable; delivered as a steer', shouldAbort: false };
    }
    const result = await this.classify(llm, context, text, signal, insertion.images);
    return { kind: result.kind, reason: result.reason, shouldAbort: result.kind === 'goal-change' };
  }
}
