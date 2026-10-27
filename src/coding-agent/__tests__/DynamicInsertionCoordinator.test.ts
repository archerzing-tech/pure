import { beforeEach, describe, expect, it } from 'bun:test';
import { DynamicInsertionCoordinator } from '../DynamicInsertionCoordinator';
import { clearInputDecisionLog, decisorOf, getInputDecisionLog } from '../inputDecision';
import type { InputAction } from '../inputDecision';
import type { InsertionClassification, InsertionRelation } from '../Planner';
import type { LLMAdapter, Message } from '../../shared/types';

function llm(): LLMAdapter {
  return { complete: async (_messages: Message[]) => ({ content: '' } as never) } as unknown as LLMAdapter;
}

/** 插话架构 v2 的决策矩阵（九类 relation → action 的处置矩阵（v2））：撤改类
 * （change/correction/misunderstanding/mixed）止损重排；承接类
 * （supplement/emphasize/meta）顺路带上；question 侧路回答；unrelated/new_task
 * 排队、chatter 收下。专门信号（cancels_part/branch_stop）优先——点名撤一支
 * 折入汇合，绝不整树重排（2026-09-24 口径）。 */
describe('DynamicInsertionCoordinator', () => {
  it('aborts on an explicit stop without calling the classifier', async () => {
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { relation: 'supplement', reason: '', confidence: 1 }; } });
    const decision = await coordinator.decide(llm(), 'current task', { text: '停止当前任务' });
    expect(decision.action).toBe('stop');
    expect(decision.relation).toBe('change'); // 整停特例：relation 面归 change（蓝图 §十.5）
    expect(decision.shouldAbort).toBe(true);
    expect(calls).toBe(0); // 停止等不起一次分类往返
  });

  it('folds a judged soft stop into change — the whole-run stop rides the relation face (v2)', async () => {
    // v2 契约里 stop 档退役：非字面的停（"先缓一缓""这个就到这儿"）由裁决器
    // 判 relation=change（全停特例，蓝图 §十.5），宿主按 replan 止损重排。
    // 过渡语义：abort + 从用户原话重推——字面停（STOP_RE）仍直落 stop 不重排。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'change', reason: 'the user is done with this run', confidence: 0.9 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '先缓一缓，这个就到这儿吧' });
    expect(decision.relation).toBe('change');
    expect(decision.kind).toBe('change'); // kind 槽承载 relation 值（v2：折算层已删）
    expect(decision.action).toBe('replan');
    expect(decision.shouldAbort).toBe(true);
    expect(decision.signals.via).toBe('judge'); // 来自裁决，不是正则快路径
    expect(decision.signals.rule).toBeUndefined();
  });

  it('hands overturn phrasing to the judge — the literal net only answers when the judge falls over (2026-09-28 用户定调)', async () => {
    // 推翻话不再由正则直判（GOAL_CHANGE_RE 降级为安全网）：是推倒重想还是
    // 整树重开、推的是哪一层，只有看得到时机（思考中？执行中？）和上下文
    // 的裁决器分得清。裁决器倒下时 netVerdict 按字面族重开——绝不丢话。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { relation: 'change', reason: 'the whole approach is overturned', confidence: 1 }; } });
    const decision = await coordinator.decide(llm(), 'current task', { text: '推翻当前方案，从头重新来' });
    expect(decision.relation).toBe('change');
    expect(decision.kind).toBe('change');
    expect(decision.shouldAbort).toBe(true);
    expect(decision.signals.rule).toBeUndefined(); // 不是命令快路径接的
    expect(calls).toBe(1);
  });

  it('hands scope-add phrasing to the judge; queues new_task when the judge says unrelated', async () => {
    // 加活的字面族（SCOPE_ADD_RE）降级为安全网：加的东西可能是往在飞的那
    // 件产出物里加（画鸟补云/五位加两位），只有看得到时机的裁决器分得清
    // ——正则分不清。裁决器判 unrelated/new_task → 排队跑，绝不丢。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => { calls++; return { relation: 'unrelated', unrelatedKind: 'new_task', reason: 'one more unit of work of its own', confidence: 0.9 }; },
    });
    for (const text of ['再加一个 爱奇艺平台', '顺便也查一下 芒果TV', '把爱奇艺也查一下', '芒果TV也来一份', 'also check Douban']) {
      const decision = await coordinator.decide(llm(), '正在并行调研 B站/腾讯/优酷 三个平台', { text });
      expect(decision.relation).toBe('unrelated');
      expect(decision.unrelatedKind).toBe('new_task');
      expect(decision.kind).toBe('unrelated');
      expect(decision.action).toBe('queue');
      expect(decision.shouldAbort).toBe(false);
      expect(decision.signals.rule).toBeUndefined();
    }
    expect(calls).toBe(5); // 每句都过了裁决器
  });

  it('passes the self-check request through from the judge (v2 §5.1 misunderstanding 双重触发)', async () => {
    // 疑似理解纠偏：裁决器只发请求（self_check_needed），宿主跑「当前输出
    // 是否忠实于用户上一句」的自查，确认才真暂停。过渡映射：
    // misunderstanding → premise-change 臂（押账重入的旧机制接住）。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'misunderstanding', reason: 'output drifted from the last message', confidence: 0.9, selfCheckNeeded: true }),
    });
    const decision = await coordinator.decide(llm(), '正在流式输出一份长报告', { text: '不是这个意思——我让你查的是价格，不是成本' });
    expect(decision.relation).toBe('misunderstanding');
    expect(decision.kind).toBe('misunderstanding');
    expect(decision.signals.selfCheckNeeded).toBe(true);
    expect(decision.signals.via).toBe('judge');
    // 没请求就没有这个字段——宿主只认严格存在性。
    const plain = await new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'correction', reason: 'the user fixed their own wording', confidence: 0.9 }),
    }).decide(llm(), 'current task', { text: '我前面说错了，不是周三是周四' });
    expect(plain.signals.selfCheckNeeded).toBeUndefined();
    expect(plain.kind).toBe('correction'); // kind 槽 = relation
  });

  it('passes the covered-branch id through from the judge (2026-10-21 刀 F 覆盖点名)', async () => {
    // 对话主导架构刀 F（真机「必须包括优酷」判例二连反转刀 E）：裁决器拿花
    // 名册点名已覆盖那支的确切 id，随信号走——编排器只核实 id 真实在跑/已
    // 收工就回「那路正在跑着，不重复」，语义判断归模型、宿主零文本匹配。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'supplement', reason: 'scope confirmation, a branch already covers it', confidence: 0.9, coveredBranch: { callId: 'call_youku' } }),
    });
    const decision = await coordinator.decide(llm(), '正在并行调研各平台', { text: '调研必须包括优酷' });
    expect(decision.kind).toBe('supplement');
    expect(decision.signals.coveredBranchCallId).toBe('call_youku');
    expect(decision.signals.via).toBe('judge');
    // 裁决器没点名 = 信号不出现，普通 steer 绝不触发去重臂。
    const plain = await new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'supplement', reason: 'a constraint for the next step', confidence: 0.9 }),
    }).decide(llm(), '正在并行调研各平台', { text: '记得跑测试' });
    expect(plain.signals.coveredBranchCallId).toBeUndefined();
  });

  it('catches the words with the literal net only when the judge falls over (2026-09-28 用户定调)', async () => {
    // 裁决器倒下的两个形状：内部 fallback（超时/网络/解析失败，以
    // fallbackUsed 上报）和根本没有 llm。netVerdict 按字面族挑一个**不丢
    // 话**的目的地——推翻重开（change）、收活折入（change+cancels_part）、
    // 其余注入（supplement）——绝不冒充判断。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'unrelated', unrelatedKind: 'new_task', reason: 'internal fallback', confidence: 0.3, fallbackUsed: true }),
    });
    const overturn = await coordinator.decide(llm(), '', { text: '推翻重来' });
    expect(overturn.relation).toBe('change');
    expect(overturn.kind).toBe('change');
    expect(overturn.shouldAbort).toBe(true);
    expect(overturn.signals.fallback).toBe('literal-net');
    const cancelish = await coordinator.decide(llm(), '', { text: 'jev 这个就不调研了' });
    expect(cancelish.kind).toBe('change'); // kind 槽 = relation；折入由 cancelsPart 信号驱动
    expect(cancelish.relation).toBe('change'); // 收活=change 的点名特写，靠信号折入
    expect(cancelish.signals.cancelsPart).toBe(true); // 收活，绝不反向执行
    expect(cancelish.shouldAbort).toBe(false); // 点名撤一支，不整树重排
    expect(cancelish.signals.fallback).toBe('literal-net');
    const plain = await coordinator.decide(llm(), '', { text: '顺便问一下，跑完了吗' });
    // 2026-10-21 刀 D 反转：其余不再一律排队——注入引擎 THINK 边界，模型带
    // 现场自己判它是什么；没被带走的残留由收尾 settleRound 原话重入，话照样
    // 丢不了。排队留给了真正需要队列语义的加急件。
    expect(plain.relation).toBe('supplement');
    expect(plain.kind).toBe('supplement');
    expect(plain.timing.mode).toBe('now');
    expect(plain.signals.fallback).toBe('literal-net');
    // 没有 llm 同样落网，且分类调用一次都不该发生。
    let calls = 0;
    const noLlm = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { relation: 'unrelated', reason: '', confidence: 1, fallbackUsed: true }; } });
    const injected = await noLlm.decide(null, '', { text: '再加一个 爱奇艺平台' });
    expect(injected.kind).toBe('supplement');
    expect(injected.timing.mode).toBe('now');
    expect(injected.shouldAbort).toBe(false);
    expect(injected.signals.fallback).toBe('literal-net');
    expect(injected.signals.rule).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('folds every relation into its processing level (第 5 期调度显式化，v2 面)', async () => {
    // 纯显式化：最终 action 一律折成处理级随信号下发，把原本藏在 switch 顺序
    // 里的调度策略写成可读、可测、可下发的一枚事实——不改任何分发行为。
    const cases: Array<[InsertionClassification, string]> = [
      [{ relation: 'change', reason: '', confidence: 1 }, 'interrupt'],
      [{ relation: 'correction', reason: '', confidence: 1 }, 'interrupt'],
      [{ relation: 'misunderstanding', reason: '', confidence: 1 }, 'interrupt'],
      [{ relation: 'mixed', reason: '', confidence: 1 }, 'interrupt'],
      [{ relation: 'supplement', reason: '', confidence: 1 }, 'boundary'],
      [{ relation: 'emphasize', reason: '', confidence: 1 }, 'boundary'],
      [{ relation: 'meta', reason: '', confidence: 1 }, 'boundary'],
      [{ relation: 'question', reason: '', confidence: 1 }, 'immediate-answer'],
      [{ relation: 'unrelated', unrelatedKind: 'new_task', reason: '', confidence: 1 }, 'queued'],
      [{ relation: 'unrelated', unrelatedKind: 'chatter', reason: '', confidence: 1 }, 'companion'],
    ];
    for (const [verdict, level] of cases) {
      const coordinator = new DynamicInsertionCoordinator({ classify: async () => verdict });
      const decision = await coordinator.decide(llm(), 'current task', { text: '随便一句' });
      expect(decision.signals.processingLevel).toBe(level);
    }
  });

  it('裁决器的 urgent 透进信号，缺省绝不自己补（第 5 期「这个急」）', async () => {
    const urgent = new DynamicInsertionCoordinator({ classify: async () => ({ relation: 'unrelated', unrelatedKind: 'new_task', reason: '', confidence: 0.9, urgent: true }) });
    const d = await urgent.decide(llm(), 'current task', { text: '这个急，先办' });
    expect(d.signals.urgent).toBe(true);
    expect(d.signals.processingLevel).toBe('queued');
    const plain = new DynamicInsertionCoordinator({ classify: async () => ({ relation: 'unrelated', unrelatedKind: 'new_task', reason: '', confidence: 0.9 }) });
    expect((await plain.decide(llm(), 'current task', { text: '查一下天气' })).signals.urgent).toBeUndefined();
  });

  it('裁决器倒下时字面网兜住「这个急」，且否定前视不许读成加急（第 5 期）', async () => {
    // 提级只改队列次序、不涉破坏性动作，所以字面网在这里用是安全的——它
    // 只保证一句明确的加急不会被默默降级成普通排队。否定前视挡掉「不着急」。
    const net = new DynamicInsertionCoordinator({ classify: async () => { throw new Error('judge must not be called'); } });
    const urgent = await net.decide(null, '', { text: '这个活加急办一下' });
    expect(urgent.kind).toBe('unrelated');
    expect(urgent.relation).toBe('unrelated');
    expect(urgent.signals.fallback).toBe('literal-net');
    expect(urgent.signals.urgent).toBe(true);
    const notUrgent = await net.decide(null, '', { text: '这个不着急，慢慢来' });
    expect(notUrgent.signals.fallback).toBe('literal-net');
    expect(notUrgent.signals.urgent).toBeUndefined();
  });

  it('hands partial-cancellation phrasing to the judge; cancelsPart comes from the verdict, not the regex (2026-09-24 案例 + 2026-09-28 降级)', async () => {
    // 真实事故：三方并行调研中"jev 这个就不调研了"被判成加活折入——取消
    // 的字面族（CANCEL_PART_RE）当年为此而生、直判折入。2026-09-28 起降级
    // 为安全网：收一支还是整树停、收掉的进不进结果，只有看得到时机和上下文
    // 的裁决器分得清。v2 面：收活=change+cancels_part → 专门信号把它折成
    // steer/apply——既不排队也不整树重排（2026-09-24 口径原样保留）。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { relation: 'change', reason: 'removes one named part from the join', confidence: 0.95, cancelsPart: true }; } });
    for (const text of ['jev 这个就不调研了', '知乎那个不用查了', '先别查了', 'RSIAgent 那部分别调研了吧', '芒果TV 就不用翻译了']) {
      const decision = await coordinator.decide(llm(), '正在并行调研 RSIAgent、jev 不聊天的模型、LLM 未来趋势', { text });
      expect(decision.kind).toBe('change');
      expect(decision.relation).toBe('change');
      expect(decision.shouldAbort).toBe(false);
      // 裁决没说时刻 → parseInputTiming 的默认（折入由 cancelsPart 驱动，
      // 不靠 timing）。
      expect(decision.timing.mode).toBe('after-current');
      expect(decision.signals.cancelsPart).toBe(true); // 来自裁决，不是正则
      expect(decision.signals.rule).toBeUndefined();
    }
    expect(calls).toBe(5);
    // 裁决器倒下：字面网兜底——收活折入，话绝不丢、绝不反向执行。
    const net = await new DynamicInsertionCoordinator({ classify: async () => { throw new Error('judge must not be called'); } }).decide(null, '', { text: 'jev 这个就不调研了' });
    expect(net.kind).toBe('change');
    expect(net.signals.cancelsPart).toBe(true);
    expect(net.signals.fallback).toBe('literal-net');
  });

  it('routes imperative branch-stop to the fast path when a branch anchor is present (第 2 期分支中断)', async () => {
    // 「停掉竞品那支」是现在就叫那一支停：不是收掉一项等汇合（CANCEL_PART），
    // 更不是整树 abort（STOP）。判定次序上 BRANCH_STOP_RE 最先——「停下竞品
    // 那支」不能被 STOP_RE 当整树停，「竞品那支别跑了」不能被 CANCEL_PART_RE
    // 折进汇合轮；点不出具体支时由宿主退回取消折入。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { relation: 'supplement', reason: '', confidence: 1 }; } });
    for (const text of ['停掉竞品那支', '停下竞品那支', '把调研那路掐掉', '竞品那支别跑了', '分析那个分支停下来']) {
      const decision = await coordinator.decide(llm(), '正在并行调研竞品与各平台', { text });
      expect(decision.relation).toBe('change'); // 撤掉正在跑的一部分
      expect(decision.kind).toBe('change'); // kind 槽 = relation；停支臂按 branchStop 信号接走
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
    expect(wholeTree.action).toBe('stop'); // 字面停压 stop，不重排
    expect(wholeTree.signals.branchStop).toBeUndefined();
    const keepGoing = await coordinator.decide(llm(), '', { text: '那支先别停' });
    expect(keepGoing.signals.branchStop).toBeUndefined();
    expect(calls).toBe(2); // 两条边界话都过了裁决器
  });

  it('still sends non-cancellation shapes to the classifier, unqueued', async () => {
    // 否定式加活（不用再加）、"取消"动词但无否定标记（把X取消掉）、无动
    // 词的"X 就先不用了"都不在快路径字面族里——交给 LLM 结合上下文裁决。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { relation: 'supplement', reason: '', confidence: 1 }; } });
    for (const text of ['不用再加知乎了', '把jev那个取消掉', '搜索就先不用了']) {
      const decision = await coordinator.decide(llm(), '正在并行调研三个平台', { text });
      expect(decision.kind).toBe('supplement');
      expect(decision.shouldAbort).toBe(false);
      expect(decision.signals.cancelsPart).toBeUndefined(); // 只有 LLM 明说才带
    }
    expect(calls).toBe(3);
  });

  it('threads a classifier cancelsPart verdict into the decision signals and folds instead of replanning', async () => {
    // 字面族之外的取消改写（"第二个不要了"）靠分类器明说 cancels_part；
    // 宿主只认 signals.cancelsPart 这一个读取点，且专门信号优先于 change
    // 的 replan 本义——点名撤一支，其余照跑。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'change', reason: 'removes one branch', confidence: 0.9, cancelsPart: true }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '第二个不要了' });
    expect(decision.kind).toBe('change');
    expect(decision.action).toBe('apply');
    expect(decision.signals.cancelsPart).toBe(true);
  });

  it('threads the judge stop_branch target into the decision signals (2026-10-10 模型点名)', async () => {
    // 模型判断、宿主执行：裁决器指认的被停支 id 随 signals 过河，编排器只
    // 按它执行真停——宿主不再做任何文本匹配。缺省绝不自己造 id。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({
        relation: 'change', reason: 'stop the review branch', confidence: 0.95,
        cancelsPart: true, stopBranch: { callId: 'call_review' },
      }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '不要评审了' });
    expect(decision.signals.stopBranchCallId).toBe('call_review');
    expect(decision.signals.cancelsPart).toBe(true);
    expect(decision.kind).toBe('change'); // kind 槽 = relation；停支按 stopBranchCallId 执行
    // 没点名就没有这个字段——下游靠严格存在性判断，不容忍空串。
    const plain = await new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'change', reason: 'generic removal', confidence: 0.9, cancelsPart: true }),
    }).decide(llm(), 'current task', { text: 'X 那支先放放' });
    expect(plain.signals.stopBranchCallId).toBeUndefined();
  });

  it('delegates focused stop targeting to the injected resolver with the roster (2026-10-10)', async () => {
    // 规则快路径只裁「要不要停」，「停哪支」聚焦点名归裁决器：协调器必须
    // 把花名册原样递给 resolver、并原样带回它的指认（null 也照传——调用方
    // 退回取消折入，宁可折叠不误杀）。
    const roster = [{ callId: 'call_a', name: '调研员', snippet: '调研竞品' }];
    let seen: unknown;
    const coordinator = new DynamicInsertionCoordinator({
      resolveStopBranchTarget: async (_llm, _context, text, given) => {
        seen = { text, roster: given };
        return { callId: 'call_a' };
      },
    });
    expect(await coordinator.resolveStopBranchTarget(null, 'ctx', { text: '停掉竞品那支' }, roster)).toEqual({ callId: 'call_a' });
    expect(seen).toEqual({ text: '停掉竞品那支', roster });
    const decline = new DynamicInsertionCoordinator({ resolveStopBranchTarget: async () => null });
    expect(await decline.resolveStopBranchTarget(null, 'ctx', { text: '停掉那支' }, roster)).toBeNull();
  });

  it('threads a classifier addsAlong verdict — the gate that refuses a branch stop (2026-09-28)', async () => {
    // 混着加活的取消：「B站那支别查了，再加一个爱奇艺」——撤改占主导
    // （relation=change），两个标记都得到宿主，少一个就会把要加的活一并停掉
    // （停支闸已从宿主关键词改成这个）。不用「不要只查均价了」："只"限定的
    // 是排他性，那句根本不是收活（2026-09-28）。
    const mixed = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'change', reason: 'removes one part while adding another', confidence: 0.9, cancelsPart: true, addsAlong: true }),
    });
    const decision = await mixed.decide(llm(), 'current task', { text: 'B站那支别查了，再加一个爱奇艺' });
    expect(decision.signals.cancelsPart).toBe(true);
    expect(decision.signals.addsAlong).toBe(true);
    expect(decision.kind).toBe('change'); // kind 槽 = relation；折入汇合，不排队（排队=反向执行删除）
    // 纯取消不带它——缺省绝不自己补。
    const pure = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'change', reason: 'removes one branch', confidence: 0.9, cancelsPart: true }),
    });
    const plain = await pure.decide(llm(), 'current task', { text: 'X 就不调研了' });
    expect(plain.signals.cancelsPart).toBe(true);
    expect(plain.signals.addsAlong).toBeUndefined();
  });

  it('threads the replaced-condition fragment through (v2 §5.1 targets_constraint)', async () => {
    // change 换掉的不是活、而是活所依据的条件（"其实我在西安"→"从广东
    // 出发"）：裁决器把条件原文抄回来随信号过河——处置管线据此定位挂在
    // 死条件上的节点；缺省绝不自己造。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'change', reason: 'origin city is wrong', confidence: 0.9, targetsConstraint: '从广东出发' }),
    });
    const decision = await coordinator.decide(llm(), '正在规划从广东到广西的旅游', { text: '其实我在西安，不是广东' });
    expect(decision.relation).toBe('change');
    expect(decision.signals.targetsConstraint).toBe('从广东出发');
    const plain = await new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'change', reason: 'plain removal', confidence: 0.9 }),
    }).decide(llm(), 'current task', { text: 'X 就不调研了' });
    expect(plain.signals.targetsConstraint).toBeUndefined();
  });

  it('lets negated additions fall through to the classifier', async () => {
    // 否定前置（不用加/别再加/不要再加）不是加活——绝不能误送排队。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'supplement', reason: 'not actually adding work', confidence: 1 }),
    });
    for (const text of ['不用再加了，就这样', '别再加新平台了', '不要再加注释了', '顺便问一下，跑完了吗']) {
      const decision = await coordinator.decide(llm(), 'current task', { text });
      expect(decision.kind).toBe('supplement');
      expect(decision.shouldAbort).toBe(false);
    }
  });

  it('does NOT abort on a constraint phrased with 不要 — the LLM judges it a supplement', async () => {
    // 老世界里 CONSTRAINT_CHANGE_RE 会把"不要再加注释"判成 abort + 重规划；
    // 现在约束只是顺路带上的话。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'supplement', reason: 'constraint on current task', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '不要再加注释' });
    expect(decision.kind).toBe('supplement');
    expect(decision.shouldAbort).toBe(false);
  });

  it('keeps the turn running for a question', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'question', reason: 'status check', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '现在跑到哪了？' });
    expect(decision.relation).toBe('question');
    expect(decision.kind).toBe('question');
    expect(decision.shouldAbort).toBe(false);
  });

  it('queues an independent task without aborting', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'unrelated', unrelatedKind: 'new_task', reason: 'separate lookup', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '查一下北京的天气' });
    expect(decision.relation).toBe('unrelated');
    expect(decision.kind).toBe('unrelated');
    expect(decision.shouldAbort).toBe(false);
  });

  it('acknowledges chatter without aborting', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'unrelated', unrelatedKind: 'chatter', reason: 'filler', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '哈哈 辛苦了' });
    expect(decision.kind).toBe('unrelated'); // chatter 是 unrelatedKind 细分
    expect(decision.action).toBe('ignore');
    expect(decision.shouldAbort).toBe(false);
  });

  it('hands the words to the running turn when no classifier LLM is available (never drops, never aborts)', async () => {
    // 2026-09-22 重新设计：没有分类器时兜底从 steer 换成 task——委派在飞时
    // steer 的承诺不可兑现（没有可兑现的 THINK 边界），排队才保真。
    // 2026-09-28 起由 netVerdict 兑现：字面网只挑不丢话的目的地。
    // 2026-10-21 刀 D 反转：收尾 settleRound 残留重入补上了「没被边界带走」
    // 的缺口——注入通道加上它，话同样丢不了，且语境不断裂。
    const coordinator = new DynamicInsertionCoordinator();
    const decision = await coordinator.decide(null, 'current task', { text: '顺便把标题也改了' });
    expect(decision.relation).toBe('supplement');
    expect(decision.kind).toBe('supplement');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.signals.fallback).toBe('literal-net');
  });

  it('sends the exact phrasing that was lost in the field ("增加一个平台") through the judge', async () => {
    // 用户实测第三例："增加一个平台 爱奇艺"——字面族当年为此补上"增加"，
    // 2026-09-28 起它的角色只剩安全网：裁决器在场就走裁决（往在飞的产出物
    // 里加还是第二件活，由裁决定）；裁决器倒下才由网接住。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { relation: 'unrelated', unrelatedKind: 'new_task', reason: 'a second platform to research', confidence: 0.9 }; } });
    const decision = await coordinator.decide(llm(), '正在并行调研 B站/腾讯/优酷', { text: '增加一个平台  爱奇艺' });
    expect(decision.kind).toBe('unrelated');
    expect(decision.shouldAbort).toBe(false);
    expect(calls).toBe(1);
  });

  it('aborts only on a judged change', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'change', reason: 'user replaced the approach', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '这个方向走不通，换个做法吧' });
    expect(decision.relation).toBe('change');
    expect(decision.kind).toBe('change');
    expect(decision.shouldAbort).toBe(true);
  });

  it('aborts on a judged correction — work under an ambiguous premise is a loss to cut (v2 §5.1)', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'correction', reason: 'the user fixed their own wording', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), '正在整理周三的日程', { text: '哦我前面说错了，不是周三是周四' });
    expect(decision.relation).toBe('correction');
    expect(decision.kind).toBe('correction');
    expect(decision.shouldAbort).toBe(true);
  });

  // ── The shared decision shape (inputDecision.ts) ──
  // The relation is the classifier's own word; the ACTION follows the shared
  // vocabulary, and the confidence gate runs last so no path can bypass it.

  it('asks instead of aborting when the classifier reports low confidence on a destructive relation', async () => {
    // Phrasing that no command fast path would claim — the gate is being
    // tested, and the literal nets only answer when the judge is unreachable.
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'change', reason: 'reads two ways', confidence: 0.4 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '这节内容好像都不对了，要不要重新整理一下这一部分' });
    // A doubtful destructive verdict must not tear down the running work —
    // asking the user one short question is cheaper than a wrong restart.
    expect(decision.relation).toBe('change');
    expect(decision.action).toBe('clarify');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.signals.gatedFrom).toBe('replan');
  });

  it('keeps a confident destructive verdict — the gate is for doubt, not for caution', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'change', reason: 'clear overturn', confidence: 0.95 }),
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
      stream: async function* () { yield { type: 'content', content: '{"relation":"unrelated","unrelated_kind":"new_task","reason":"independent lookup"}' }; },
    } as unknown as LLMAdapter;
    const decision = await realPipeline.decide(noConfidence, 'current task', { text: '顺便查一下汇率' });
    expect(decision.relation).toBe('unrelated');
    expect(decision.action).toBe('queue');
    expect(decision.confidence).toBeGreaterThan(0.6);
    expect(decision.signals.confidenceDefaulted).toBe(true);
    expect(decision.shouldAbort).toBe(false);
  });

  it('holds a timed insert until its moment regardless of the judged relation', async () => {
    // v2 契约没有 when 字段：时机意图从用户原话推导（TIMING_CUE 兜底）——
    // "10 分钟后"落在文本里，parseInputTiming 照样算出 at。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'supplement', reason: 'a constraint', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '10 分钟后把标题改成 X' });
    // A supplement the user scheduled is not applied NOW — it is a queued turn
    // that starts at its moment. Applying it to the running turn would run the
    // work ten minutes early.
    expect(decision.relation).toBe('supplement');
    expect(decision.kind).toBe('supplement');
    expect(decision.timing.mode).toBe('at');
    expect(decision.action).toBe('queue');
    expect(decision.shouldAbort).toBe(false);
  });

  it('carries the confidence the model reported', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'question', reason: 'status check', confidence: 0.85 }),
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
      classify: async () => ({ relation: 'unrelated', unrelatedKind: 'chatter', reason: 'filler' }),
    } as never);
    const decision = await coordinator.decide(llm(), 'current task', { text: '哈哈' });
    expect(decision.kind).toBe('unrelated'); // chatter 是 unrelatedKind 细分
    expect(decision.action).toBe('clarify');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.signals.gatedFrom).toBe('ignore');
  });

  it('derives the timing from the user text when the contract has no when field', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'unrelated', unrelatedKind: 'new_task', reason: 'follow-up work', confidence: 0.9 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '下午三点再跑一遍完整测试' });
    expect(decision.timing.mode).toBe('at');
    expect(decision.action).toBe('queue');
    expect(decision.signals.when).toBeUndefined(); // when 字段已从契约移除
  });
});
/** 九类 relation → 处置表投影契约（v2，蓝图 §六）：kind 槽承载 relation 值
 *  （日志可读），权威语义在 relation；action/scope 走 RELATION_DISPOSITION，
 *  processingLevel 走 LEVEL_BY_RELATION。专门信号（cancels_part/branch_stop/
 *  stop_branch）优先——点名撤一支折入汇合（action=apply），绝不整树重排
 *  （2026-09-24 口径）；unrelated+cancels_part 保持排队投影（编排器
 *  unrelated 臂的 cancelish 检查先于排队接手，删除语义受保护）。 */
describe('DynamicInsertionCoordinator — relation disposition table (v2)', () => {
  const table: Array<{ verdict: InsertionClassification; action: InputAction; abort: boolean }> = [
    { verdict: { relation: 'supplement', reason: '', confidence: 1 }, action: 'apply', abort: false },
    { verdict: { relation: 'emphasize', reason: '', confidence: 1 }, action: 'apply', abort: false },
    { verdict: { relation: 'meta', reason: '', confidence: 1 }, action: 'apply', abort: false },
    { verdict: { relation: 'change', reason: '', confidence: 1 }, action: 'replan', abort: true },
    { verdict: { relation: 'correction', reason: '', confidence: 1 }, action: 'replan', abort: true },
    { verdict: { relation: 'misunderstanding', reason: '', confidence: 1 }, action: 'replan', abort: true },
    { verdict: { relation: 'mixed', reason: '', confidence: 1 }, action: 'replan', abort: true },
    { verdict: { relation: 'question', reason: '', confidence: 1 }, action: 'answer', abort: false },
    { verdict: { relation: 'unrelated', unrelatedKind: 'new_task', reason: '', confidence: 1 }, action: 'queue', abort: false },
    { verdict: { relation: 'unrelated', unrelatedKind: 'chatter', reason: '', confidence: 1 }, action: 'ignore', abort: false },
  ];
  for (const { verdict, action, abort } of table) {
    it(`maps ${verdict.relation}${verdict.unrelatedKind ? `(${verdict.unrelatedKind})` : ''} → ${action}`, async () => {
      const coordinator = new DynamicInsertionCoordinator({ classify: async () => verdict });
      const decision = await coordinator.decide(llm(), 'current task', { text: '随便一句' });
      expect(decision.relation).toBe(verdict.relation);
      expect(decision.kind).toBe(verdict.relation); // kind 槽承载 relation 值
      expect(decision.action).toBe(action);
      expect(decision.shouldAbort).toBe(abort);
    });
  }

  it('dedicated signals outrank the change policy: a named removal folds, it never replans', async () => {
    // 点名撤一支/停一支（cancels_part / stop_branch.call_id）既不排队也不整
    // 树重排（2026-09-24 取消案例口径）。branch_stop 作为信号面只由规则通道
    // 产生（BRANCH_STOP_RE 快路径另有专测）；judge 通道的点名形态是 stop_branch。
    for (const verdict of [
      { relation: 'change', reason: '', confidence: 1, cancelsPart: true } as InsertionClassification,
      { relation: 'change', reason: '', confidence: 1, stopBranch: { callId: 'call_x' } } as InsertionClassification,
    ]) {
      const coordinator = new DynamicInsertionCoordinator({ classify: async () => verdict });
      const decision = await coordinator.decide(llm(), 'current task', { text: 'X 那支不要了' });
      expect(decision.relation).toBe('change');
      expect(decision.action).toBe('apply');
      expect(decision.shouldAbort).toBe(false);
    }
  });

  it('unrelated + cancels_part keeps the queue projection — the unrelated arm owns the cancelish check', async () => {
    // 裁决器可以一面判 new_task 一面报 cancels_part（契约透传纪律）；
    // 处置表不因信号改写 unrelated 的投影——编排器 unrelated 臂的 cancelish
    // 先序接手，删除语义永远到不了队列。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'unrelated', unrelatedKind: 'new_task', reason: '', confidence: 1, cancelsPart: true }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '再加一个爱奇艺平台' });
    expect(decision.kind).toBe('unrelated');
    expect(decision.signals.cancelsPart).toBe(true);
    expect(decision.action).toBe('queue');
  });

  it('every judge verdict lands in the nine-relation face, no legacy kind leaks', async () => {
    // 九类名录之外的判定词（旧七类 kind）进不了决策——classifyInsertion 在
    // 解析层已拒，这里锁协调器面：decision.relation 只能是九类之一，kind 槽
    // 承载同值。
    const RELATIONS: readonly InsertionRelation[] = ['supplement', 'change', 'emphasize', 'unrelated', 'correction', 'question', 'mixed', 'meta', 'misunderstanding'];
    for (const relation of RELATIONS) {
      const coordinator = new DynamicInsertionCoordinator({ classify: async () => ({ relation, reason: '', confidence: 1 }) });
      const decision = await coordinator.decide(llm(), 'current task', { text: '随便一句' });
      expect(RELATIONS).toContain(decision.relation);
    }
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
    expect(resume.relation).toBe('supplement'); // 续支=让既有工作继续产出
  });

  it('logs the scene the decision was made in — 判错了要能看到在什么场景下判的', async () => {
    // 场景就是喂给裁决器的那段上下文（时机×内容里的"时机"）。它是事后诊断唯一
    // 能把"判错了"与"在错场景里判的"分开的东西——同一句换场景能从错到对。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'supplement', reason: 'a constraint', confidence: 0.9 }),
    });
    const context = '用户当前诉求：帮我调研三个平台的会员价格\n并行委派：共 3 个，在飞 3 个';
    await coordinator.decide(llm(), context, { text: '记得跑测试' });
    expect(inserts()[0].inputContext).toBe(context);
    // 长上下文截断：日志是给人读的，不是存证全文。
    await coordinator.decide(llm(), 'x'.repeat(900), { text: '记得跑测试' });
    expect(inserts()[1].inputContext).toHaveLength(600);
  });

  it('marks a verdict from the judge as judge', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'supplement', reason: 'a constraint', confidence: 0.9 }),
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
      classify: async () => ({ relation: 'unrelated', reason: 'internal fallback', confidence: 0.3, fallbackUsed: true }),
    });
    const netted = await judgeDown.decide(llm(), '', { text: '推翻重来' });
    expect(netted.signals.via).toBe('net');
    expect(netted.signals.netReason).toBe('judge-down');
  });

  it('writes every decision to the shared log together with the user\'s own words', async () => {
    // 日志是设置页诊断区的数据源；没记上原话，用户就没法把它跟对话对上。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'question', reason: 'status check', confidence: 0.9 }),
    });
    await coordinator.decide(llm(), 'current task', { text: '  现在跑到哪一步了  ' });
    const entries = inserts();
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('question');
    expect(entries[0].relation).toBe('question');
    expect(entries[0].inputText).toBe('现在跑到哪一步了');
    expect(decisorOf(entries[0])).toBe('judge');
  });

  it('caps the logged input so one pasted essay cannot bloat the diagnostics pane', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ relation: 'unrelated', unrelatedKind: 'new_task', reason: 'a second errand', confidence: 0.9 }),
    });
    await coordinator.decide(llm(), '', { text: 'x'.repeat(400) });
    expect(inserts()[0].inputText).toHaveLength(160);
  });
});
