import { describe, expect, it } from 'bun:test';
import { DynamicInsertionCoordinator } from '../DynamicInsertionCoordinator';
import type { LLMAdapter, Message } from '../../shared/types';

function llm(): LLMAdapter {
  return { complete: async (_messages: Message[]) => ({ content: '' } as never) } as unknown as LLMAdapter;
}

/** 插话重构后的决策矩阵：stop / goal-change / premise-change 停下手里
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

  it('queues scope additions via the fast path, classifier never consulted', async () => {
    // 用户两次实测暴露：委派在飞时"再加一个 X"被判 steer，而父任务阻塞等
    // 子 agent 返回根本没有"下个动作"可带上——话被收下然后忘掉。加活的量
    // 不进分类赌局：字面命中直送排队（唯一保证跑完的投递），与 STOP 同款
    // 机制。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'steer', reason: '' }; } });
    for (const text of ['再加一个 爱奇艺平台', '顺便也查一下 芒果TV', '把爱奇艺也查一下', '芒果TV也来一份', 'also check Douban']) {
      const decision = await coordinator.decide(llm(), '正在并行调研 B站/腾讯/优酷 三个平台', { text });
      expect(decision.kind).toBe('task');
      expect(decision.shouldAbort).toBe(false); // 排队不打断，收尾后必跑
    }
    expect(calls).toBe(0);
  });

  it('lets negated additions fall through to the classifier', async () => {
    // 否定前置（不用加/别再加/不要再加）不是加活——绝不能误送排队。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'steer', reason: 'not actually adding work' }),
    });
    for (const text of ['不用再加了，就这样', '别再加新平台了', '不要再加注释了', '顺便问一下，跑完了吗']) {
      const decision = await coordinator.decide(llm(), 'current task', { text });
      expect(decision.kind).toBe('steer');
      expect(decision.shouldAbort).toBe(false);
    }
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

  it('aborts on a judged premise-change — in-flight work under a wrong fact is a loss to cut (2026-09-22)', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'premise-change', reason: 'origin city is wrong' }),
    });
    const decision = await coordinator.decide(llm(), '正在规划从广东到广西的旅游', { text: '我现在在西安' });
    expect(decision.kind).toBe('premise-change');
    expect(decision.shouldAbort).toBe(true);
  });
});
