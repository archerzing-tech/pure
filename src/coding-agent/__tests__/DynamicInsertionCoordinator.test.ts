import { describe, expect, it } from 'bun:test';
import { DynamicInsertionCoordinator } from '../DynamicInsertionCoordinator';
import type { LLMAdapter, Message } from '../../shared/types';

function llm(): LLMAdapter {
  return { complete: async (_messages: Message[]) => ({ content: '' } as never) } as unknown as LLMAdapter;
}

/** 插话重构后的决策矩阵：只有 stop / goal-change 停下手里
 * 的活；其余一切不打断——steer 进转向通道、question 侧路回答、task 排队、
 * chatter 收下即可。 */
describe('DynamicInsertionCoordinator', () => {
  it('aborts on an explicit stop without calling the classifier', async () => {
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'steer', reason: '' }; } });
    const decision = await coordinator.decide(llm(), 'current task', { text: '停止当前任务' });
    expect(decision.kind).toBe('stop');
    expect(decision.shouldAbort).toBe(true);
    expect(calls).toBe(0); // 停止等不起一次分类往返
  });

  it('aborts on overturn phrasing via the fast path', async () => {
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'steer', reason: '' }; } });
    const decision = await coordinator.decide(llm(), 'current task', { text: '推翻当前方案，从头重新来' });
    expect(decision.kind).toBe('goal-change');
    expect(decision.shouldAbort).toBe(true);
    expect(calls).toBe(0);
  });

  it('does NOT abort on a constraint phrased with 不要 — the LLM judges it a steer', async () => {
    // 老世界里 CONSTRAINT_CHANGE_RE 会把"不要再加注释"判成 abort + 重规划；
    // 现在约束只是顺路带上的话。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'steer', reason: 'constraint on current task' }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '不要再加注释' });
    expect(decision.kind).toBe('steer');
    expect(decision.shouldAbort).toBe(false);
  });

  it('keeps the turn running for a question', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'question', reason: 'status check' }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '现在跑到哪了？' });
    expect(decision.kind).toBe('question');
    expect(decision.shouldAbort).toBe(false);
  });

  it('queues an independent task without aborting', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'task', reason: 'separate lookup' }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '查一下北京的天气' });
    expect(decision.kind).toBe('task');
    expect(decision.shouldAbort).toBe(false);
  });

  it('acknowledges chatter without aborting', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'chatter', reason: 'filler' }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '哈哈 辛苦了' });
    expect(decision.kind).toBe('chatter');
    expect(decision.shouldAbort).toBe(false);
  });

  it('delivers as a steer when no classifier LLM is available (never drops, never aborts)', async () => {
    const coordinator = new DynamicInsertionCoordinator();
    const decision = await coordinator.decide(null, 'current task', { text: '顺便把标题也改了' });
    expect(decision.kind).toBe('steer');
    expect(decision.shouldAbort).toBe(false);
  });

  it('passes the LLM kind through and aborts only on a judged goal-change', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'goal-change', reason: 'user replaced the approach' }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '这个方向走不通，换个做法吧' });
    expect(decision.kind).toBe('goal-change');
    expect(decision.shouldAbort).toBe(true);
  });
});
