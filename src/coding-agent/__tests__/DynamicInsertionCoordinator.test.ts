import { describe, expect, it } from 'bun:test';
import { DynamicInsertionCoordinator } from '../DynamicInsertionCoordinator';
import type { LLMAdapter, Message } from '../../shared/types';

function llm(): LLMAdapter {
  return { complete: async (_messages: Message[]) => ({ content: '{"related":true,"reason":"new requirement"}' } as never) } as unknown as LLMAdapter;
}

describe('DynamicInsertionCoordinator', () => {
  it('queues unrelated inserts without aborting the current run', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ related: false, reason: 'separate request' }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: 'check the weather' });
    expect(decision.kind).toBe('unrelated');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.requiresReplan).toBe(false);
  });

  it('requests replanning for a goal change', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ related: true, reason: 'goal changed' }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '推翻当前方案，从头重新来' });
    expect(decision.kind).toBe('goal-change');
    expect(decision.shouldAbort).toBe(true);
    expect(decision.requiresReplan).toBe(true);
  });

  it('recognizes an explicit stop request without calling the classifier', async () => {
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { related: true, reason: '' }; } });
    const decision = await coordinator.decide(llm(), 'current task', { text: '停止当前任务' });
    expect(decision.kind).toBe('stop');
    expect(decision.shouldAbort).toBe(true);
    expect(calls).toBe(0);
  });
});
