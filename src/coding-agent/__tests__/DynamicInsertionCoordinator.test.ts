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
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'steer', reason: '', confidence: 1 }; } });
    const decision = await coordinator.decide(llm(), 'current task', { text: '停止当前任务' });
    expect(decision.kind).toBe('stop');
    expect(decision.shouldAbort).toBe(true);
    expect(calls).toBe(0); // 停止等不起一次分类往返
  });

  it('aborts on overturn phrasing via the fast path', async () => {
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'steer', reason: '', confidence: 1 }; } });
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
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'steer', reason: '', confidence: 1 }; } });
    for (const text of ['再加一个 爱奇艺平台', '顺便也查一下 芒果TV', '把爱奇艺也查一下', '芒果TV也来一份', 'also check Douban']) {
      const decision = await coordinator.decide(llm(), '正在并行调研 B站/腾讯/优酷 三个平台', { text });
      expect(decision.kind).toBe('task');
      expect(decision.shouldAbort).toBe(false); // 排队不打断，收尾后必跑
    }
    expect(calls).toBe(0);
  });

  it('routes partial cancellation of a named part to steer via the fast path (2026-09-24 取消案例)', async () => {
    // 真实事故：三方并行调研中"jev 这个就不调研了"被判成加活折入（回执
    // "先补这项，再合并出一份覆盖全部的汇总"）——与意图正好相反。取消一
    // 部分的字面族直判 steer + cancelsPart，不进分类赌局：判成 task 等于
    // 把"取消"当活跑，反向执行。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'task', reason: '', confidence: 1 }; } });
    for (const text of ['jev 这个就不调研了', '知乎那个不用查了', '先别查了', 'RSIAgent 那部分别调研了吧', '芒果TV 就不用翻译了']) {
      const decision = await coordinator.decide(llm(), '正在并行调研 RSIAgent、jev 不聊天的模型、LLM 未来趋势', { text });
      expect(decision.kind).toBe('steer');
      expect(decision.shouldAbort).toBe(false);
      expect(decision.timing.mode).toBe('now');
      expect(decision.signals.cancelsPart).toBe(true);
      expect(decision.signals.rule).toBe('CANCEL_PART_RE');
    }
    expect(calls).toBe(0); // 与 STOP/加活同款：取消等不起、也赌不起一次分类往返
  });

  it('routes imperative branch-stop to the fast path when a branch anchor is present (第 2 期分支中断)', async () => {
    // 「停掉竞品那支」是现在就叫那一支停：不是收掉一项等汇合（CANCEL_PART），
    // 更不是整树 abort（STOP）。判定次序上 BRANCH_STOP_RE 最先——「停下竞品
    // 那支」不能被 STOP_RE 当整树停，「竞品那支别跑了」不能被 CANCEL_PART_RE
    // 折进汇合轮；点不出具体支时由宿主退回取消折入（见 conversationSamples）。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'steer', reason: '', confidence: 1 }; } });
    for (const text of ['停掉竞品那支', '停下竞品那支', '把调研那路掐掉', '竞品那支别跑了', '分析那个分支停下来']) {
      const decision = await coordinator.decide(llm(), '正在并行调研竞品与各平台', { text });
      expect(decision.kind).toBe('steer');
      expect(decision.shouldAbort).toBe(false);
      expect(decision.timing.mode).toBe('now');
      expect(decision.signals.branchStop).toBe(true);
      expect(decision.signals.rule).toBe('BRANCH_STOP_RE');
    }
    expect(calls).toBe(0); // 点名停与 STOP 同款：等不起、也赌不起一次分类往返
    // 边界：否定将来时（就不用查了）仍是收活折入，不是真停；无锚的停下仍
    // 是整树 stop；「先别停」是反义，锚在场也绝不误触。
    const cancelish = await coordinator.decide(llm(), '', { text: '竞品那支就不用查了' });
    expect(cancelish.signals.cancelsPart).toBe(true);
    expect(cancelish.signals.branchStop).toBeUndefined();
    const wholeTree = await coordinator.decide(llm(), '', { text: '停下来歇会' });
    expect(wholeTree.kind).toBe('stop');
    expect(wholeTree.signals.branchStop).toBeUndefined();
    const keepGoing = await coordinator.decide(llm(), '', { text: '那支先别停' });
    expect(keepGoing.signals.branchStop).toBeUndefined();
  });

  it('still sends non-cancellation shapes to the classifier, unqueued', async () => {
    // 否定式加活（不用再加）、"取消"动词但无否定标记（把X取消掉）、无动
    // 词的"X 就先不用了"都不在快路径字面族里——交给 LLM 结合上下文裁决。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'steer', reason: '', confidence: 1 }; } });
    for (const text of ['不用再加知乎了', '把jev那个取消掉', '搜索就先不用了']) {
      const decision = await coordinator.decide(llm(), '正在并行调研三个平台', { text });
      expect(decision.kind).toBe('steer');
      expect(decision.shouldAbort).toBe(false);
      expect(decision.signals.cancelsPart).toBeUndefined(); // 只有 LLM 明说才带
    }
    expect(calls).toBe(3);
  });

  it('threads a classifier cancelsPart verdict into the decision signals', async () => {
    // 字面族之外的取消改写（"第二个不要了"）靠分类器明说 cancels_part；
    // 宿主只认 signals.cancelsPart 这一个读取点。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'steer', reason: 'removes one branch', confidence: 0.9, cancelsPart: true }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '第二个不要了' });
    expect(decision.kind).toBe('steer');
    expect(decision.signals.cancelsPart).toBe(true);
  });

  it('lets negated additions fall through to the classifier', async () => {
    // 否定前置（不用加/别再加/不要再加）不是加活——绝不能误送排队。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'steer', reason: 'not actually adding work', confidence: 1 }),
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
      classify: async () => ({ kind: 'steer', reason: 'constraint on current task', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '不要再加注释' });
    expect(decision.kind).toBe('steer');
    expect(decision.shouldAbort).toBe(false);
  });

  it('keeps the turn running for a question', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'question', reason: 'status check', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '现在跑到哪了？' });
    expect(decision.kind).toBe('question');
    expect(decision.shouldAbort).toBe(false);
  });

  it('queues an independent task without aborting', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'task', reason: 'separate lookup', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '查一下北京的天气' });
    expect(decision.kind).toBe('task');
    expect(decision.shouldAbort).toBe(false);
  });

  it('acknowledges chatter without aborting', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'chatter', reason: 'filler', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '哈哈 辛苦了' });
    expect(decision.kind).toBe('chatter');
    expect(decision.shouldAbort).toBe(false);
  });

  it('queues as a task when no classifier LLM is available (never drops, never aborts)', async () => {
    // 2026-09-22 重新设计：没有分类器时兜底从 steer 换成 task——委派在飞时
    // steer 的承诺不可兑现（没有可兑现的 THINK 边界），排队才保真。
    const coordinator = new DynamicInsertionCoordinator();
    const decision = await coordinator.decide(null, 'current task', { text: '顺便把标题也改了' });
    expect(decision.kind).toBe('task');
    expect(decision.shouldAbort).toBe(false);
  });

  it('fast-paths the exact phrasing that was lost in the field ("增加一个平台")', async () => {
    // 用户实测第三例："增加一个平台 爱奇艺"——此前字面族只有"再加"没有
    // "增加"，快速路漏过、LLM 又判 steer，话被转达后丢失。这次进快速路。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'steer', reason: '', confidence: 1 }; } });
    const decision = await coordinator.decide(llm(), '正在并行调研 B站/腾讯/优酷', { text: '增加一个平台  爱奇艺' });
    expect(decision.kind).toBe('task');
    expect(decision.shouldAbort).toBe(false);
    expect(calls).toBe(0);
  });

  it('passes the LLM kind through and aborts only on a judged goal-change', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'goal-change', reason: 'user replaced the approach', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '这个方向走不通，换个做法吧' });
    expect(decision.kind).toBe('goal-change');
    expect(decision.shouldAbort).toBe(true);
  });

  it('aborts on a judged premise-change — in-flight work under a wrong fact is a loss to cut (2026-09-22)', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'premise-change', reason: 'origin city is wrong', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), '正在规划从广东到广西的旅游', { text: '我现在在西安' });
    expect(decision.kind).toBe('premise-change');
    expect(decision.shouldAbort).toBe(true);
  });

  // ── The shared decision shape (inputDecision.ts) ──
  // The kind is the classifier's own word; the ACTION follows the shared
  // vocabulary, and the confidence gate runs last so no path can bypass it.

  it('asks instead of aborting when the classifier reports low confidence', async () => {
    // Phrasing that does NOT match the GOAL_CHANGE_RE fast path — the gate is
    // being tested, and the fast path is a different (mechanical) producer.
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'goal-change', reason: 'reads two ways', confidence: 0.4 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '这节内容好像都不对了，要不要重新整理一下这一部分' });
    // A doubtful destructive verdict must not tear down the running work —
    // asking the user one short question is cheaper than a wrong restart.
    expect(decision.kind).toBe('goal-change');
    expect(decision.action).toBe('clarify');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.signals.gatedFrom).toBe('replan');
  });

  it('keeps a confident destructive verdict — the gate is for doubt, not for caution', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'goal-change', reason: 'clear overturn', confidence: 0.95 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '不要了，全部重来' });
    expect(decision.action).toBe('replan');
    expect(decision.shouldAbort).toBe(true);
  });

  it('defaults a classifier that never reported confidence, without gating on it', async () => {
    // INPUT_DEFAULT_CONFIDENCE sits ABOVE the gate on purpose (see
    // inputDecision.ts): the gate exists for reported doubt, not for providers
    // that drop the field. The confidenceDefaulted FLAG is added upstream by
    // classifyInsertion — a mock here bypasses it, which is why it is absent.
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'task', reason: 'independent lookup' }),
    } as never);
    const decision = await coordinator.decide(llm(), 'current task', { text: '顺便查一下汇率' });
    expect(decision.action).toBe('queue');
    expect(decision.confidence).toBeGreaterThan(0.6);
    expect(decision.shouldAbort).toBe(false);
  });

  it('holds a timed insert until its moment regardless of the judged kind', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'steer', reason: 'a constraint', confidence: 1, when: '10 分钟后' }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '10 分钟后把标题改成 X' });
    // A steer the user scheduled is not a steer NOW — it is a queued turn that
    // starts at its moment. Applying it to the running turn would run the work
    // ten minutes early.
    expect(decision.kind).toBe('steer');
    expect(decision.timing.mode).toBe('at');
    expect(decision.action).toBe('queue');
    expect(decision.shouldAbort).toBe(false);
  });

  it('carries the confidence the model reported', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'question', reason: 'status check', confidence: 0.85 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '现在跑哪一步了' });
    expect(decision.action).toBe('answer');
    expect(decision.confidence).toBe(0.85);
  });

  it('routes an unreportable confidence through the gate to clarify', async () => {
    // A mock classifier that skips `confidence` hands the gate an undefined
    // number (the real classifyInsertion would have defaulted it upstream —
    // that contract is asserted in Planner's tests). The gate reads "no number"
    // as "no confidence" and asks instead of acting.
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'chatter', reason: 'filler' }),
    } as never);
    const decision = await coordinator.decide(llm(), 'current task', { text: '哈哈' });
    expect(decision.kind).toBe('chatter');
    expect(decision.action).toBe('clarify');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.signals.gatedFrom).toBe('ignore');
  });

  it('passes a reported timing through verbatim for the caller to parse', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'task', reason: 'follow-up work', confidence: 0.9, when: '下午三点' }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '下午三点再跑一遍完整测试' });
    expect(decision.signals.when).toBe('下午三点');
    expect(decision.timing.mode).toBe('at');
    expect(decision.action).toBe('queue');
  });
});
