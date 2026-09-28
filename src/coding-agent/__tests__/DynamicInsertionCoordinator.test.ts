import { beforeEach, describe, expect, it } from 'bun:test';
import { DynamicInsertionCoordinator } from '../DynamicInsertionCoordinator';
import { clearInputDecisionLog, decisorOf, getInputDecisionLog } from '../inputDecision';
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

  it('aborts on a judged stop — the soft stops the literal fast path cannot see (2026-09-28)', async () => {
    // "先缓一缓"没有任何命令词，STOP_RE 不碰它（BRANCH/RESUME 也都要点名锚）。
    // 补 stop 档之前，这类话会被判 steer（下个动作带上）或 task（排队）——
    // 都是"继续干"，与用户意思相反。现在由裁决器判 stop：停手，不重排。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'stop', reason: 'the user is done with this run', confidence: 0.9 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '先缓一缓，这个就到这儿吧' });
    expect(decision.kind).toBe('stop');
    expect(decision.action).toBe('stop');
    expect(decision.shouldAbort).toBe(true);
    expect(decision.signals.via).toBe('judge'); // 来自裁决，不是正则快路径
    expect(decision.signals.rule).toBeUndefined();
  });

  it('hands overturn phrasing to the judge — the literal net only answers when the judge falls over (2026-09-28 用户定调)', async () => {
    // 推翻话不再由正则直判（GOAL_CHANGE_RE 降级为安全网）：是推倒重想还是
    // 整树重开、推的是哪一层，只有看得到时机（思考中？执行中？）和上下文
    // 的裁决器分得清。裁决器倒下时 netVerdict 按字面族重开——绝不丢话。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'goal-change', reason: 'the whole approach is overturned', confidence: 1 }; } });
    const decision = await coordinator.decide(llm(), 'current task', { text: '推翻当前方案，从头重新来' });
    expect(decision.kind).toBe('goal-change');
    expect(decision.shouldAbort).toBe(true);
    expect(decision.signals.rule).toBeUndefined(); // 不是命令快路径接的
    expect(calls).toBe(1);
  });

  it('hands scope-add phrasing to the judge; queues only when the judge is unreachable (2026-09-28 用户定调)', async () => {
    // 加活的字面族（SCOPE_ADD_RE）降级为安全网：加的东西可能是往在飞的那
    // 件产出物里加（画鸟补云/五位加两位），只有看得到时机的裁决器分得清
    // ——正则分不清。裁决器在场时字面命中绝不抢答；裁决器倒下（无 llm
    // 或 classify 上报 fallbackUsed）才由 netVerdict 接手，按"唯一保证跑
    // 完的投递"排队兜底——2026-09-22 防丢保证由网兑现，不再抢在判断前。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'steer', reason: 'grows the one list being assembled', confidence: 0.9, supplementsCurrent: true }; } });
    for (const text of ['再加一个 爱奇艺平台', '顺便也查一下 芒果TV', '把爱奇艺也查一下', '芒果TV也来一份', 'also check Douban']) {
      const decision = await coordinator.decide(llm(), '正在并行调研 B站/腾讯/优酷 三个平台', { text });
      expect(decision.kind).toBe('steer'); // 裁决说了算，不再直送排队
      expect(decision.signals.supplementsCurrent).toBe(true);
      expect(decision.signals.rule).toBeUndefined();
    }
    expect(calls).toBe(5); // 每句都过了裁决器
  });

  it('catches the words with the literal net only when the judge falls over (2026-09-28 用户定调)', async () => {
    // 裁决器倒下的两个形状：内部 fallback（超时/网络/解析失败，以
    // fallbackUsed 上报）和根本没有 llm。netVerdict 按字面族挑一个**不丢
    // 话**的目的地——推翻话重开、收活折入、其余一律排队——绝不冒充判断
    // （signals.fallback = 'literal-net'，confidence 恒为兜底值）。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'task', reason: 'internal fallback', confidence: 0.3, fallbackUsed: true }),
    });
    const overturn = await coordinator.decide(llm(), '', { text: '推翻重来' });
    expect(overturn.kind).toBe('goal-change');
    expect(overturn.shouldAbort).toBe(true);
    expect(overturn.signals.fallback).toBe('literal-net');
    const cancelish = await coordinator.decide(llm(), '', { text: 'jev 这个就不调研了' });
    expect(cancelish.kind).toBe('steer');
    expect(cancelish.signals.cancelsPart).toBe(true); // 收活，绝不反向执行
    expect(cancelish.signals.fallback).toBe('literal-net');
    const plain = await coordinator.decide(llm(), '', { text: '顺便问一下，跑完了吗' });
    expect(plain.kind).toBe('task');
    expect(plain.timing.mode).toBe('after-current');
    expect(plain.signals.fallback).toBe('literal-net');
    // 没有 llm 同样落网，且分类调用一次都不该发生。
    let calls = 0;
    const noLlm = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'task', reason: '', confidence: 1, fallbackUsed: true }; } });
    const queued = await noLlm.decide(null, '', { text: '再加一个 爱奇艺平台' });
    expect(queued.kind).toBe('task');
    expect(queued.timing.mode).toBe('after-current');
    expect(queued.signals.fallback).toBe('literal-net');
    expect(queued.signals.rule).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('hands partial-cancellation phrasing to the judge; cancelsPart comes from the verdict, not the regex (2026-09-24 案例 + 2026-09-28 降级)', async () => {
    // 真实事故：三方并行调研中"jev 这个就不调研了"被判成加活折入——取消
    // 的字面族（CANCEL_PART_RE）当年为此而生、直判 steer+cancelsPart。
    // 2026-09-28 起降级为安全网：收一支还是整树停、收掉的进不进结果，只有
    // 看得到时机和上下文的裁决器分得清。字面保证（绝不把"取消"当活跑）
    // 由网兑现：裁决器倒下时 netVerdict 仍按字面族折入 steer+cancelsPart。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'steer', reason: 'removes one named part from the join', confidence: 0.95, cancelsPart: true }; } });
    for (const text of ['jev 这个就不调研了', '知乎那个不用查了', '先别查了', 'RSIAgent 那部分别调研了吧', '芒果TV 就不用翻译了']) {
      const decision = await coordinator.decide(llm(), '正在并行调研 RSIAgent、jev 不聊天的模型、LLM 未来趋势', { text });
      expect(decision.kind).toBe('steer');
      expect(decision.shouldAbort).toBe(false);
      // 裁决没说时刻 → parseInputTiming 的默认（折入由 cancelsPart 驱动，
      // 不靠 timing）——旧 fast path 的 'now' 不再由正则凭空捏造。
      expect(decision.timing.mode).toBe('after-current');
      expect(decision.signals.cancelsPart).toBe(true); // 来自裁决，不是正则
      expect(decision.signals.rule).toBeUndefined();
    }
    expect(calls).toBe(5);
    // 裁决器倒下：字面网兜底——收活折入，话绝不丢、绝不反向执行。
    const net = await new DynamicInsertionCoordinator({ classify: async () => { throw new Error('judge must not be called'); } }).decide(null, '', { text: 'jev 这个就不调研了' });
    expect(net.kind).toBe('steer');
    expect(net.signals.cancelsPart).toBe(true);
    expect(net.signals.fallback).toBe('literal-net');
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
    // 边界：否定将来时（就不用查了）不碰点名停支——交给裁决器；无锚的停
    // 下仍是整树 stop（命令，立即生效）；「先别停」是反义，锚在场也绝不误触。
    const cancelish = await coordinator.decide(llm(), '', { text: '竞品那支就不用查了' });
    expect(cancelish.signals.branchStop).toBeUndefined();
    expect(cancelish.signals.rule).toBeUndefined(); // 没被任何命令快路径接走
    const wholeTree = await coordinator.decide(llm(), '', { text: '停下来歇会' });
    expect(wholeTree.kind).toBe('stop');
    expect(wholeTree.signals.branchStop).toBeUndefined();
    const keepGoing = await coordinator.decide(llm(), '', { text: '那支先别停' });
    expect(keepGoing.signals.branchStop).toBeUndefined();
    expect(calls).toBe(2); // 两条边界话都过了裁决器
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

  it('threads a classifier addsAlong verdict — the gate that refuses a branch stop (2026-09-28)', async () => {
    // 混着加活的取消：「不要只查均价了，把区间也查一下」——两个标记都得
    // 到宿主，少一个就会把要加的活一并停掉（停支闸已从宿主关键词改成这个）。
    const mixed = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'task', reason: 'removes one part while adding another', confidence: 0.9, cancelsPart: true, addsAlong: true }),
    });
    const decision = await mixed.decide(llm(), 'current task', { text: '不要只查均价了，把区间也查一下' });
    expect(decision.signals.cancelsPart).toBe(true);
    expect(decision.signals.addsAlong).toBe(true);
    // 纯取消不带它——缺省绝不自己补。
    const pure = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'steer', reason: 'removes one branch', confidence: 0.9, cancelsPart: true }),
    });
    const plain = await pure.decide(llm(), 'current task', { text: 'X 就不调研了' });
    expect(plain.signals.cancelsPart).toBe(true);
    expect(plain.signals.addsAlong).toBeUndefined();
  });

  it('threads a classifier supplementsCurrent verdict into the decision signals (2026-09-27 思考窗吸收)', async () => {
    // 画鸟时补云被排队、队列又丢——宿主的吸收分支只认 signals.supplementsCurrent
    // 这一个读取点；分类器的判定必须原样过河，不能在协调器里沉底。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'task', reason: 'misrouted by an older prompt', confidence: 0.9, supplementsCurrent: true }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '背景上加一些会动的云朵' });
    expect(decision.kind).toBe('task');
    expect(decision.signals.supplementsCurrent).toBe(true);
    // 没给的判定不带标记——宿主只认严格 === true。
    const plain = await new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'task', reason: 'unrelated errand', confidence: 0.9 }),
    }).decide(llm(), 'current task', { text: '明天北京天气怎么样' });
    expect(plain.signals.supplementsCurrent).toBeUndefined();
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
    // 2026-09-28 起由 netVerdict 兑现：字面网只挑不丢话的目的地。
    const coordinator = new DynamicInsertionCoordinator();
    const decision = await coordinator.decide(null, 'current task', { text: '顺便把标题也改了' });
    expect(decision.kind).toBe('task');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.signals.fallback).toBe('literal-net');
  });

  it('sends the exact phrasing that was lost in the field ("增加一个平台") through the judge', async () => {
    // 用户实测第三例："增加一个平台 爱奇艺"——字面族当年为此补上"增加"，
    // 2026-09-28 起它的角色只剩安全网：裁决器在场就走裁决（往在飞的产出物
    // 里加还是第二件活，由裁决定）；裁决器倒下才由网接住排队。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { kind: 'task', reason: 'a second platform to research', confidence: 0.9 }; } });
    const decision = await coordinator.decide(llm(), '正在并行调研 B站/腾讯/优酷', { text: '增加一个平台  爱奇艺' });
    expect(decision.kind).toBe('task');
    expect(decision.shouldAbort).toBe(false);
    expect(calls).toBe(1);
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
    // Phrasing that no command fast path would claim — the gate is being
    // tested, and the literal nets only answer when the judge is unreachable.
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

  it('defaults a provider that dropped the confidence field — upstream, not by the gate', async () => {
    // INPUT_DEFAULT_CONFIDENCE sits ABOVE the gate on purpose (see
    // inputDecision.ts): the gate exists for reported doubt, not for providers
    // that drop the field. The defaulting lives in classifyInsertion
    // (confidence = INPUT_DEFAULT_CONFIDENCE + the confidenceDefaulted flag),
    // so this runs the REAL classifier over a confidence-less reply — a raw
    // mock without the number would (correctly) be gated to clarify.
    const realPipeline = new DynamicInsertionCoordinator();
    const noConfidence = {
      stream: async function* () { yield { type: 'content', content: '{"kind":"task","reason":"independent lookup"}' }; },
    } as unknown as LLMAdapter;
    const decision = await realPipeline.decide(noConfidence, 'current task', { text: '顺便查一下汇率' });
    expect(decision.action).toBe('queue');
    expect(decision.confidence).toBeGreaterThan(0.6);
    expect(decision.signals.confidenceDefaulted).toBe(true);
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

/** 决策通道 + 决策日志（2026-09-28 定调的可见性半边）：每条插话决策都要
 *  标明「谁定的」，并进共享日志——用户要在设置页看到这次是裁决器按时机×
 *  内容判的，还是机械正则/字面安全网接的。三个值互斥：rule（命令快路径）、
 *  judge（裁决器）、net（裁决器不可用时的安全网，netReason 说明原因）。
 *  正则接管的次数一眼可见，就是「决策不看关键词」这条定调的验收窗口。 */
describe('DynamicInsertionCoordinator — decisor channel + decision log', () => {
  beforeEach(() => clearInputDecisionLog());

  /** 只看插话那一类账（日志里还有 turn-route / host-schedule 的条目）。 */
  const inserts = () => getInputDecisionLog().filter((entry) => entry.source === 'mid-run-insert');

  it('marks the mechanical fast paths as rule, and names which rule decided', async () => {
    const coordinator = new DynamicInsertionCoordinator();
    const stop = await coordinator.decide(llm(), '', { text: '停止当前任务' });
    expect(stop.signals.via).toBe('rule');
    expect(stop.signals.rule).toBe('STOP_RE');
    const branchStop = await coordinator.decide(llm(), '', { text: '停掉竞品那支' });
    expect(branchStop.signals.via).toBe('rule');
    expect(branchStop.signals.rule).toBe('BRANCH_STOP_RE');
    const resume = await coordinator.decide(llm(), '', { text: '把竞品那支接着跑完' });
    expect(resume.signals.via).toBe('rule');
    expect(resume.signals.rule).toBe('RESUME_BRANCH_RE');
  });

  it('marks a verdict from the judge as judge', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'steer', reason: 'a constraint', confidence: 0.9 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '记得跑测试' });
    expect(decision.signals.via).toBe('judge');
    expect(decisorOf(decision)).toBe('judge');
  });

  it('marks the literal net as net and says WHICH failure sent it there', async () => {
    // 没有裁决器（no-judge）和裁决器倒下（judge-down）是两件不同的事故：前
    // 者是宿主还没立起 LLM，后者是模型超时/网络/解析失败——诊断区必须分得
    // 开，否则「今天怎么这么多兜底」查不出方向。
    const noJudge = new DynamicInsertionCoordinator();
    const queued = await noJudge.decide(null, '', { text: '顺便把标题也改了' });
    expect(queued.signals.via).toBe('net');
    expect(queued.signals.netReason).toBe('no-judge');
    expect(decisorOf(queued)).toBe('net');

    const judgeDown = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'task', reason: 'internal fallback', confidence: 0.3, fallbackUsed: true }),
    });
    const netted = await judgeDown.decide(llm(), '', { text: '推翻重来' });
    expect(netted.signals.via).toBe('net');
    expect(netted.signals.netReason).toBe('judge-down');
  });

  it('writes every decision to the shared log together with the user\'s own words', async () => {
    // 日志是设置页诊断区的数据源；没记上原话，用户就没法把它跟对话对上。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'question', reason: 'status check', confidence: 0.9 }),
    });
    await coordinator.decide(llm(), 'current task', { text: '  现在跑到哪一步了  ' });
    const entries = inserts();
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('question');
    expect(entries[0].inputText).toBe('现在跑到哪一步了');
    expect(decisorOf(entries[0])).toBe('judge');
  });

  it('caps the logged input so one pasted essay cannot bloat the diagnostics pane', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ kind: 'task', reason: 'a second errand', confidence: 0.9 }),
    });
    await coordinator.decide(llm(), '', { text: 'x'.repeat(400) });
    expect(inserts()[0].inputText).toHaveLength(160);
  });
});
