import type { LLMAdapter, MessageImage } from '../shared/types';
import { classifyInsertion, type InsertionClassification } from './Planner';

export type DynamicInsertionKind = 'unrelated' | 'supplement' | 'constraint-change' | 'goal-change' | 'stop';

export interface DynamicInsertion {
  text: string;
  images?: MessageImage[];
  displayText?: string;
}

export interface DynamicInsertionDecision {
  kind: DynamicInsertionKind;
  related: boolean;
  reason: string;
  requiresReplan: boolean;
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

const STOP_RE = /^(?:停止|停下|取消|中止|别做了|先别做|abort|stop|cancel|halt|nevermind)(?:\b|$|[\u4e00-\u9fff])/i;
const GOAL_CHANGE_RE = /(?:改成|改为|换成|不要再|推翻|重新来|重做|从头|换个方案|换一种思路|instead|replace|start over|redo|rethink|different approach)/i;
const CONSTRAINT_CHANGE_RE = /(?:必须|不要|不能|不允许|限制|要求|兼容|支持|改为|改成|加上|去掉|remove|require|must|should|constraint|support)/i;

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
      return { kind: 'stop', related: true, reason: 'user requested the current run to stop', requiresReplan: false, shouldAbort: true };
    }
    if (!llm) {
      return this.heuristicDecision(text, 'classification unavailable; queued as unrelated');
    }
    const result = await this.classify(llm, context, text, signal, insertion.images);
    if (!result.related) {
      return { kind: 'unrelated', related: false, reason: result.reason, requiresReplan: false, shouldAbort: false };
    }
    const kind = this.relatedKind(text);
    return {
      kind,
      related: true,
      reason: result.reason,
      requiresReplan: kind === 'constraint-change' || kind === 'goal-change',
      shouldAbort: true,
    };
  }

  private relatedKind(text: string): Exclude<DynamicInsertionKind, 'unrelated' | 'stop'> {
    if (GOAL_CHANGE_RE.test(text)) return 'goal-change';
    if (CONSTRAINT_CHANGE_RE.test(text)) return 'constraint-change';
    return 'supplement';
  }

  private heuristicDecision(text: string, reason: string): DynamicInsertionDecision {
    if (GOAL_CHANGE_RE.test(text)) return { kind: 'goal-change', related: true, reason, requiresReplan: true, shouldAbort: true };
    if (CONSTRAINT_CHANGE_RE.test(text)) return { kind: 'constraint-change', related: true, reason, requiresReplan: true, shouldAbort: true };
    return { kind: 'unrelated', related: false, reason, requiresReplan: false, shouldAbort: false };
  }
}
