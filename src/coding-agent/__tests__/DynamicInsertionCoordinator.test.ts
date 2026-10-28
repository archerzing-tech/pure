import { beforeEach, describe, expect, it } from 'bun:test';
import { DynamicInsertionCoordinator } from '../DynamicInsertionCoordinator';
import { clearInputDecisionLog, decisorOf, getInputDecisionLog } from '../inputDecision';
import type { InputAction } from '../inputDecision';
import type { InsertionClassification, InsertionVerdict } from '../Planner';
import type { LLMAdapter, Message } from '../../shared/types';

function llm(): LLMAdapter {
  return { complete: async (_messages: Message[]) => ({ content: '' } as never) } as unknown as LLMAdapter;
}

/** 三值判定契约（2026-10-28 并线/另线改版）：inline 并线原话直投（apply，
 *  模型自消化）；sideline 旁答（apply，判定落定即放闸，寒暄也回注一句——
 *  ignore 退役，插话不丢）；new_task 排队新轮。宿主唯一保留的机械动作是
 *  整树停（action:"stop"）；停支/续支由裁决器点名 call_id、宿主只核实执行。 */
describe('DynamicInsertionCoordinator', () => {
  it('aborts on a judged whole-run stop — action:"stop" is the one mechanical action left to the host', async () => {
    // 整树停是用户的明确命令：裁决器判 action:stop，宿主掐流（abortController），
    // 不重排不重想，已跑完的部分都留着。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: 'the user is done; nothing replaces it', confidence: 0.95, action: 'stop' }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '停止当前任务' });
    expect(decision.action).toBe('stop');
    expect(decision.verdict).toBe('inline');
    expect(decision.kind).toBe('inline');
    expect(decision.shouldAbort).toBe(true);
    expect(decision.signals.via).toBe('judge');
    expect(decision.scope).toEqual(['plan', 'completed-steps']);
    expect(decision.signals.processingLevel).toBe('interrupt');
  });

  it('keeps a soft stop riding inline when the judge did not call action:stop — the main line digests it', async () => {
    // 非字面的软停（"先缓一缓"）若裁决器没判 action:stop，就是并线一句话：
    // 原话直投，模型下一轮自己决定怎么收——宿主不再有 replan 臂。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: 'the user is done with this run', confidence: 0.9 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '先缓一缓，这个就到这儿吧' });
    expect(decision.verdict).toBe('inline');
    expect(decision.kind).toBe('inline');
    expect(decision.action).toBe('apply');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.signals.via).toBe('judge');
    expect(decision.signals.rule).toBeUndefined();
  });

  it('sends overturn phrasing to the judge and lands it inline — no replan arm exists anymore', async () => {
    // 推翻话归裁决器：并线直投后模型自己决定推倒重来还是顺势折——转向/
    // 追加/纠正的消化全在下一轮思考，宿主只管把原话送到模型面前。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { verdict: 'inline', reason: 'the whole approach is overturned', confidence: 1 }; } });
    const decision = await coordinator.decide(llm(), 'current task', { text: '推翻当前方案，从头重新来' });
    expect(decision.verdict).toBe('inline');
    expect(decision.kind).toBe('inline');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.signals.rule).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('hands scope-add phrasing to the judge; queues new_task for a unit of work that must come back', async () => {
    // 与任务无关但要回来一件自己的活：排队跑，当前回合收尾后开新轮，绝不丢。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => { calls++; return { verdict: 'new_task', reason: 'one more unit of work of its own', confidence: 0.9 }; },
    });
    for (const text of ['再加一个 爱奇艺平台', '顺便也查一下 芒果TV', '把爱奇艺也查一下', '芒果TV也来一份', 'also check Douban']) {
      const decision = await coordinator.decide(llm(), '正在并行调研 B站/腾讯/优酷 三个平台', { text });
      expect(decision.verdict).toBe('new_task');
      expect(decision.kind).toBe('new_task');
      expect(decision.action).toBe('queue');
      expect(decision.shouldAbort).toBe(false);
      expect(decision.signals.rule).toBeUndefined();
    }
    expect(calls).toBe(5); // 每句都过了裁决器
  });

  it('answers small talk on the sideline without dropping it — ignore is retired (插话不丢)', async () => {
    // 寒暄/反应话不再 ignore：旁答管线即时答、答案回注主流——插话不丢是
    // 最高不变量，最轻的处置也是「回一句」，不是沉默。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'sideline', reason: 'filler', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '哈哈 辛苦了' });
    expect(decision.verdict).toBe('sideline');
    expect(decision.kind).toBe('sideline');
    expect(decision.action).toBe('apply');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.scope).toEqual(['none']);
    expect(decision.signals.processingLevel).toBe('immediate-answer');
  });

  it('passes the named-branch call_id through from the judge (§一 细化 2 插话点名某支)', async () => {
    // 插话点名某支（范围确认/转向/问及）：裁决器拿花名册抄回确切 id，宿主
    // 只核实 id 真实在册——零文本匹配。没点名 = 信号不出现。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: 'scope confirmation, a branch already covers it', confidence: 0.9, branchCallId: 'call_youku' }),
    });
    const decision = await coordinator.decide(llm(), '正在并行调研各平台', { text: '调研必须包括优酷' });
    expect(decision.kind).toBe('inline');
    expect(decision.signals.branchCallId).toBe('call_youku');
    expect(decision.signals.via).toBe('judge');
    const plain = await new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: 'a constraint for the next step', confidence: 0.9 }),
    }).decide(llm(), '正在并行调研各平台', { text: '记得跑测试' });
    expect(plain.signals.branchCallId).toBeUndefined();
  });

  it('passes the words through verbatim when the judge falls over — no guessing (刀 1)', async () => {
    // 裁决器倒下的两个形状（内部 fallback 上报 fallbackUsed / 根本没有 llm）
    // 都不猜：统一原话直投（inline 投递），让在跑的模型带着现场自己消化；
    // netReason 只进日志。话绝不丢（不变量 §六.1）。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: 'internal fallback', confidence: 0.3, fallbackUsed: true }),
    });
    const overturn = await coordinator.decide(llm(), '', { text: '推翻重来' });
    expect(overturn.verdict).toBe('inline');
    expect(overturn.kind).toBe('inline');
    expect(overturn.signals.via).toBe('passthrough');
    expect(overturn.signals.netReason).toBe('judge-down');
    expect(overturn.confidence).toBe(0.3); // 0.3 = 投递策略，不是判断
    expect(overturn.signals.gatedFrom).toBe('apply'); // 置信门记得直投的落点
    expect(overturn.shouldAbort).toBe(false);
    const plain = await coordinator.decide(llm(), '', { text: '顺便问一下，跑完了吗' });
    expect(plain.verdict).toBe('inline');
    expect(plain.timing.mode).toBe('now');
    expect(plain.signals.via).toBe('passthrough');
    // 没有 llm 同样直投，且分类调用一次都不该发生。
    let calls = 0;
    const noLlm = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { verdict: 'inline', reason: '', confidence: 1, fallbackUsed: true }; } });
    const injected = await noLlm.decide(null, '', { text: '再加一个 爱奇艺平台' });
    expect(injected.verdict).toBe('inline');
    expect(injected.signals.via).toBe('passthrough');
    expect(injected.signals.netReason).toBe('no-judge');
    expect(injected.signals.rule).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('folds every verdict into its processing level (第 5 期调度显式化)', async () => {
    // 纯显式化：最终 action 一律折成处理级随信号下发——inline 边界消化、
    // sideline 即时旁答、new_task 排队、整停 interrupt。
    const cases: Array<[InsertionClassification, string]> = [
      [{ verdict: 'inline', reason: '', confidence: 1 }, 'boundary'],
      [{ verdict: 'sideline', reason: '', confidence: 1 }, 'immediate-answer'],
      [{ verdict: 'new_task', reason: '', confidence: 1 }, 'queued'],
      [{ verdict: 'inline', reason: '', confidence: 1, action: 'stop' }, 'interrupt'],
    ];
    for (const [verdict, level] of cases) {
      const coordinator = new DynamicInsertionCoordinator({ classify: async () => verdict });
      const decision = await coordinator.decide(llm(), 'current task', { text: '随便一句' });
      expect(decision.signals.processingLevel).toBe(level);
    }
  });

  it('threads judged stop_branch / resumes_branch targets into the signals (点名停支/续支保留成果)', async () => {
    // 停哪支/续哪支由裁决器对着花名册点名（确切 call_id），宿主只核实执行
    // ——零文本匹配。停支不是整停：turn 继续跑，其余支无感。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => { calls++; return { verdict: 'inline', reason: 'stop the competitor branch', confidence: 0.95, stopBranch: { callId: 'call_competitor' } }; },
    });
    const decision = await coordinator.decide(llm(), '正在并行调研竞品与各平台', { text: '停掉竞品那支' });
    expect(decision.verdict).toBe('inline');
    expect(decision.kind).toBe('inline');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.action).toBe('apply');
    expect(decision.signals.stopBranchCallId).toBe('call_competitor');
    expect(decision.signals.rule).toBeUndefined();
    expect(calls).toBe(1); // 每句都过裁决器——宿主零字面匹配
    // 点名续支：裁决器指认该接着跑完的那支 id，宿主核实后同参重派。
    const resume = await new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: 'the user wants this branch to finish', confidence: 0.95, resumesBranch: { callId: 'call_quote' } }),
    }).decide(llm(), '竞品已停，报价那路还停着', { text: '把竞品那支接着跑完' });
    expect(resume.kind).toBe('inline');
    expect(resume.signals.resumesBranchCallId).toBe('call_quote');
    expect(resume.signals.via).toBe('judge');
    // 没点名就没有字段——下游靠严格存在性判断，不容忍空串。
    const plain = await new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: 'plain encouragement', confidence: 0.9 }),
    }).decide(llm(), 'current task', { text: '继续加油' });
    expect(plain.signals.resumesBranchCallId).toBeUndefined();
    expect(plain.signals.stopBranchCallId).toBeUndefined();
  });

  it('delegates focused stop targeting to the injected resolver with the roster (2026-10-10)', async () => {
    // 要不要停由裁决器判，「停哪支」聚焦点名归窄问题：协调器必须把花名册
    // 原样递给 resolver、并原样带回它的指认（null 也照传——调用方退回保守
    // 消化，绝不误停）。
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

  it('carries the judge receipt through when the moment needs a confirmation', async () => {
    // 收执只在必须即时确认处出现（整停/停支/排队新任务）：现场措辞随信号
    // 过河，缺席 = 引擎沉默（§〇 呈现层契约：并线默认不出 receipt）。
    const withReceipt = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'new_task', reason: 'queued errand', confidence: 0.9, receipt: '这个跑完就弄。' }),
    });
    const d = await withReceipt.decide(llm(), 'current task', { text: '顺便查一下天气' });
    expect(d.signals.receipt).toBe('这个跑完就弄。');
    const silent = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: 'a constraint', confidence: 0.9 }),
    });
    expect((await silent.decide(llm(), 'current task', { text: '记得跑测试' })).signals.receipt).toBeUndefined();
  });

  it('still sends ordinary phrasings to the classifier, unqueued', async () => {
    // 常规并线话全走裁决器（唯一通路），宿主零字面匹配。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { verdict: 'inline', reason: '', confidence: 1 }; } });
    for (const text of ['不用再加知乎了', '把jev那个取消掉', '记得跑测试']) {
      const decision = await coordinator.decide(llm(), '正在并行调研三个平台', { text });
      expect(decision.kind).toBe('inline');
      expect(decision.shouldAbort).toBe(false);
    }
    expect(calls).toBe(3);
  });

  it('keeps the turn running for a sideline status question', async () => {
    // 进度问句归 sideline 旁答：判定落定即放闸，主线不停。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'sideline', reason: 'status check', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '现在跑到哪了？' });
    expect(decision.verdict).toBe('sideline');
    expect(decision.kind).toBe('sideline');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.action).toBe('apply');
  });

  it('queues an independent task without aborting', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'new_task', reason: 'separate lookup', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '查一下北京的天气' });
    expect(decision.verdict).toBe('new_task');
    expect(decision.kind).toBe('new_task');
    expect(decision.shouldAbort).toBe(false);
  });

  it('passes the words through when no classifier LLM is available (never drops, never aborts)', async () => {
    // 2026-10-28 刀 1：字面网删了，兜底统一为原话直投（passthrough）——原话
    // 进下一轮思考输入，让在跑的模型带着现场自己消化，话绝不丢。
    const coordinator = new DynamicInsertionCoordinator();
    const decision = await coordinator.decide(null, 'current task', { text: '顺便把标题也改了' });
    expect(decision.verdict).toBe('inline');
    expect(decision.signals.via).toBe('passthrough');
    expect(decision.signals.netReason).toBe('no-judge');
    expect(decision.shouldAbort).toBe(false);
  });

  it('sends the exact phrasing that was lost in the field ("增加一个平台") through the judge', async () => {
    // 用户实测第三例："增加一个平台 爱奇艺"——往在飞的产出物里加还是第二件
    // 活，由裁决器判；判 new_task 就排队，收尾后必跑。
    let calls = 0;
    const coordinator = new DynamicInsertionCoordinator({ classify: async () => { calls++; return { verdict: 'new_task', reason: 'a second platform to research', confidence: 0.9 }; } });
    const decision = await coordinator.decide(llm(), '正在并行调研 B站/腾讯/优酷', { text: '增加一个平台  爱奇艺' });
    expect(decision.kind).toBe('new_task');
    expect(decision.shouldAbort).toBe(false);
    expect(calls).toBe(1);
  });

  // ── The shared decision shape (inputDecision.ts) ──
  // The verdict is the judge's own word; the ACTION follows the shared
  // vocabulary, and the confidence gate runs last so no path can bypass it.

  it('asks instead of aborting when the judge reports low confidence on a whole-run stop', async () => {
    // 低置信 + 破坏性动作（整停）：先问一句，绝不赌——问的成本低于误拆在跑
    // 的活。gatedFrom 记得原始动作，回收窗口按同族判定。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: 'reads like a stop but could be a nudge', confidence: 0.4, action: 'stop' }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '先这样吧……还是算了，你定' });
    expect(decision.verdict).toBe('inline');
    expect(decision.action).toBe('clarify');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.signals.gatedFrom).toBe('stop');
  });

  it('downgrades a doubtful sideline to clarify — sideline must be a high-confidence call (置信偏置)', async () => {
    // 低置信一律 inline 是裁决器的职责（提示词约束）；置信门是最后一道闸：
    // 拿不准的旁答先问，绝不把可能相关的话引去旁线。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'sideline', reason: 'maybe unrelated', confidence: 0.4 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '这个先放放' });
    expect(decision.action).toBe('clarify');
    expect(decision.signals.gatedFrom).toBe('apply');
    expect(decision.shouldAbort).toBe(false);
  });

  it('keeps a confident verdict — the gate is for doubt, not for caution', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: 'clear overturn', confidence: 0.95 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '不要了，全部重来' });
    expect(decision.action).toBe('apply');
    expect(decision.shouldAbort).toBe(false);
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
      stream: async function* () { yield { type: 'content', content: '{"verdict":"new_task","reason":"independent lookup"}' }; },
    } as unknown as LLMAdapter;
    const decision = await realPipeline.decide(noConfidence, 'current task', { text: '顺便查一下汇率' });
    expect(decision.verdict).toBe('new_task');
    expect(decision.action).toBe('queue');
    expect(decision.confidence).toBeGreaterThan(0.6);
    expect(decision.signals.confidenceDefaulted).toBe(true);
    expect(decision.shouldAbort).toBe(false);
  });

  it('holds a timed insert until its moment regardless of the verdict', async () => {
    // 契约没有 when 字段：时机意图从用户原话推导（TIMING_CUE 兜底）——
    // "10 分钟后"落在文本里，parseInputTiming 照样算出 at。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: 'a constraint', confidence: 1 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '10 分钟后把标题改成 X' });
    // A timed insert is not applied NOW — it is a queued turn that starts at
    // its moment. Applying it to the running turn would run the work ten
    // minutes early.
    expect(decision.verdict).toBe('inline');
    expect(decision.kind).toBe('inline');
    expect(decision.timing.mode).toBe('at');
    expect(decision.action).toBe('queue');
    expect(decision.shouldAbort).toBe(false);
  });

  it('carries the confidence the model reported', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'sideline', reason: 'status check', confidence: 0.85 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '现在跑哪一步了' });
    expect(decision.action).toBe('apply');
    expect(decision.confidence).toBe(0.85);
  });

  it('routes an unreportable confidence through the gate to clarify', async () => {
    // A mock classifier that skips `confidence` hands the gate an undefined
    // number (the real classifyInsertion would have defaulted it upstream —
    // that contract is asserted in Planner's tests). The gate reads "no number"
    // as "no confidence" and asks instead of acting.
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'sideline', reason: 'filler' }),
    } as never);
    const decision = await coordinator.decide(llm(), 'current task', { text: '哈哈' });
    expect(decision.kind).toBe('sideline');
    expect(decision.action).toBe('clarify');
    expect(decision.shouldAbort).toBe(false);
    expect(decision.signals.gatedFrom).toBe('apply');
  });

  it('derives the timing from the user text when the contract has no when field', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'new_task', reason: 'follow-up work', confidence: 0.9 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '下午三点再跑一遍完整测试' });
    expect(decision.timing.mode).toBe('at');
    expect(decision.action).toBe('queue');
    expect(decision.signals.when).toBeUndefined(); // when 字段已从契约移除
  });
});

/** 三值 verdict → 处置表投影契约：kind 槽承载 verdict 值（日志可读），权威
 *  语义在 verdict；action/scope 走 VERDICT_DISPOSITION，processingLevel 走
 *  LEVEL_BY_VERDICT。三值都没有拆树动作——shouldAbort 只在整树停
 *  （action:stop 压表）为真。 */
describe('DynamicInsertionCoordinator — verdict disposition table', () => {
  const table: Array<{ verdict: InsertionClassification; action: InputAction; abort: boolean }> = [
    { verdict: { verdict: 'inline', reason: '', confidence: 1 }, action: 'apply', abort: false },
    { verdict: { verdict: 'sideline', reason: '', confidence: 1 }, action: 'apply', abort: false },
    { verdict: { verdict: 'new_task', reason: '', confidence: 1 }, action: 'queue', abort: false },
  ];
  for (const { verdict, action, abort } of table) {
    it(`maps ${verdict.verdict} → ${action}`, async () => {
      const coordinator = new DynamicInsertionCoordinator({ classify: async () => verdict });
      const decision = await coordinator.decide(llm(), 'current task', { text: '随便一句' });
      expect(decision.verdict).toBe(verdict.verdict);
      expect(decision.kind).toBe(verdict.verdict); // kind 槽承载 verdict 值
      expect(decision.action).toBe(action);
      expect(decision.shouldAbort).toBe(abort);
    });
  }

  it('a named-branch stop never tears down the turn — only the whole-run stop aborts', async () => {
    // 停支是支级粒度：点名支消化，其余无感（细化 1「手」不打断）。verdict
    // 面没有 replan——不存在「因撤一支而整树重排」的臂。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: '', confidence: 1, stopBranch: { callId: 'call_x' } }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: 'X 那支不要了' });
    expect(decision.verdict).toBe('inline');
    expect(decision.action).toBe('apply');
    expect(decision.shouldAbort).toBe(false);
  });

  it('every judge verdict lands in the three-value face, no legacy word leaks', async () => {
    // 三值名录之外的判定词（旧九类 relation、更旧的七类 kind）进不了决策——
    // classifyInsertion 在解析层已拒，这里锁协调器面：decision.verdict 只能
    // 是三值之一，kind 槽与兼容槽 relation 承载同值。
    const VERDICTS: readonly InsertionVerdict[] = ['inline', 'sideline', 'new_task'];
    for (const verdict of VERDICTS) {
      const coordinator = new DynamicInsertionCoordinator({ classify: async () => ({ verdict, reason: '', confidence: 1 }) });
      const decision = await coordinator.decide(llm(), 'current task', { text: '随便一句' });
      expect(VERDICTS).toContain(decision.verdict);
      expect(decision.kind).toBe(decision.verdict); // kind 槽镜像 verdict
    }
  });
});

/** 决策通道 + 决策日志（2026-09-28 定调的可见性半边）：每条插话决策都要
 *  标明「谁定的」，并进共享日志——用户要在设置页看到这次是裁决器按时机×
 *  内容判的，还是兜底直投接的。两个生产值：judge（裁决器）、passthrough
 *  （缺席/倒下的原话直投）；rule/net 只留在类型里供旧日志回放。 */
describe('DynamicInsertionCoordinator — decisor channel + decision log', () => {
  beforeEach(() => clearInputDecisionLog());

  /** 只看插话那一类账（日志里还有 turn-route / host-schedule 的条目）。 */
  const inserts = () => getInputDecisionLog().filter((entry) => entry.source === 'mid-run-insert');

  it('marks the two production channels: judge decides, passthrough delivers verbatim (刀 1)', async () => {
    // 快路径正则族已删：生产通路只剩 judge（裁决器判词）与 passthrough（缺席/
    // 倒下的原话直投）。rule 值留在类型里只供旧日志回放，新账不再产生——
    // 「决策不看关键词」由「根本没有 rule 通道」兑现。
    const judge = new DynamicInsertionCoordinator({ classify: async () => ({ verdict: 'inline', reason: '', confidence: 0.9 }) });
    const steered = await judge.decide(llm(), '', { text: '记得跑测试' });
    expect(steered.signals.via).toBe('judge');
    const noJudge = new DynamicInsertionCoordinator();
    const passed = await noJudge.decide(null, '', { text: '把竞品那支接着跑完' });
    expect(passed.signals.via).toBe('passthrough');
    expect(passed.signals.rule).toBeUndefined();
  });

  it('logs the scene the decision was made in — 判错了要能看到在什么场景下判的', async () => {
    // 场景就是喂给裁决器的那段上下文（时机×内容里的"时机"）。它是事后诊断唯一
    // 能把"判错了"与"在错场景里判的"分开的东西——同一句换场景能从错到对。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: 'a constraint', confidence: 0.9 }),
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
      classify: async () => ({ verdict: 'inline', reason: 'a constraint', confidence: 0.9 }),
    });
    const decision = await coordinator.decide(llm(), 'current task', { text: '记得跑测试' });
    expect(decision.signals.via).toBe('judge');
    expect(decisorOf(decision)).toBe('judge');
  });

  it('marks passthrough and says WHICH failure sent it there', async () => {
    // 没有裁决器（no-judge）和裁决器倒下（judge-down）是两件不同的事故：前者
    // 是宿主还没立起 LLM，后者是模型超时/网络/解析失败——诊断区必须分得
    // 开，否则「今天怎么这么多兜底」查不出方向。刀 1 后两者都原话直投，
    // netReason 进日志说明原因。
    const noJudge = new DynamicInsertionCoordinator();
    const queued = await noJudge.decide(null, '', { text: '顺便把标题也改了' });
    expect(queued.signals.via).toBe('passthrough');
    expect(queued.signals.netReason).toBe('no-judge');

    const judgeDown = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'inline', reason: 'internal fallback', confidence: 0.3, fallbackUsed: true }),
    });
    const netted = await judgeDown.decide(llm(), '', { text: '推翻重来' });
    expect(netted.signals.via).toBe('passthrough');
    expect(netted.signals.netReason).toBe('judge-down');
  });

  it('writes every decision to the shared log together with the user\'s own words', async () => {
    // 日志是设置页诊断区的数据源；没记上原话，用户就没法把它跟对话对上。
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'sideline', reason: 'status check', confidence: 0.9 }),
    });
    await coordinator.decide(llm(), 'current task', { text: '  现在跑到哪一步了  ' });
    const entries = inserts();
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('sideline'); // kind 槽承载 verdict 值
    expect(entries[0].inputText).toBe('现在跑到哪一步了');
    expect(decisorOf(entries[0])).toBe('judge');
  });

  it('caps the logged input so one pasted essay cannot bloat the diagnostics pane', async () => {
    const coordinator = new DynamicInsertionCoordinator({
      classify: async () => ({ verdict: 'new_task', reason: 'a second errand', confidence: 0.9 }),
    });
    await coordinator.decide(llm(), '', { text: 'x'.repeat(400) });
    expect(inserts()[0].inputText).toHaveLength(160);
  });
});
