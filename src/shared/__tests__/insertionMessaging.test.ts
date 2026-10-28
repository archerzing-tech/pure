// src/shared/__tests__/insertionMessaging.test.ts
// 插话文本的单一事实来源（insertionMessaging.ts）的一致性契约。
//
// 2026-10-28 框架改革刀 2 重定收执纪律：收执 = 承接插话的模型现场写的
// receipt，唯一来源；模型缺席时引擎沉默（宁可无话，不出机械腔）。回应性
// 固定话术一族（branchStopReceipt / cancelBeforeDispatchReceipt /
// foldInReceipt / foldInEarlyReceipt / queuedReceipt / queuedUrgentReceipt /
// steerFallbackReceipt / holdReleaseReceipt / holdReleaseTurnReceipt /
// truePauseReceipt / selfCheckClearReceipt）已随本刀全部删除。本测试两件事：
//   ① 锁存留文本的方向——框架文本只描述机制事实不示范措辞；判例收执只说
//     场景里真实发生/真实在场的事；
//   ② 锁删除不回潮——已删的固定句按构就是机械腔（独立于语境的「收执」
//     是编造），宿主接线里不得再出现。
//
// 判定逻辑归 DynamicInsertionCoordinator / chat.ts / steerTargeting.ts，
// 各有自己的测试；这里只锁「同一规则的多处措辞必须同向」。

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { INSERTION_PROTOCOL_PROMPT } from '../promptLayers';
import * as mod from '../insertionMessaging';
import {
  steerFrameText,
  branchUncertainPauseReceipt,
  cancelFoldUnmatchedReceipt,
  cancelFoldInstruction,
  settledBranchCancelNote,
  foldInInstruction,
  foldInFollowUpText,
  queuedHandoffText,
  CANCELLATION_INVARIANTS as INV,
  branchResumeReceipt,
  treeResumeReceipt,
  RESUME_INVARIANTS as RESUME_INV,
  truePauseReentryText,
  frozenSideEffectReceipt,
  FROZEN_INVARIANTS as FROZEN_INV,
} from '../insertionMessaging';
import { expectNoDefaultParams } from './arityLock';

describe('插话取消话术三处一致性', () => {
  it('① L1 协议（刀 2 薄指针）：五类标注块+点名具体的事+停支归宿主+幸存者合并', () => {
    // 协议已从逐场景长文瘦成薄指针（6.5k→632 字符）：只教模型认块、按块内
    // 指令配合、点名具体的事、停支归宿主、合并只覆盖幸存者。逐场景教导下放
    // 到五个标注块，协议层不再重复。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('<insertion_protocol>');
    // 五类标注块名一一在场（模型靠它们认块）。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('【用户插话·顺路带上】');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('【排队中的用户消息·现在轮到它】');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('【推倒重来·回到你的原话】');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('【中途取消，不是追加】');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('【中途追加的任务】');
    // 点名具体的事禁模板句：能在任何会话里成立的回复按构就是错的。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('in THIS conversation');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('wrong by construction');
    // 停支归宿主：宿主停或暂停，模型永不动手停。
    expect(INSERTION_PROTOCOL_PROMPT).toContain(INV.hostStops);
    expect(INSERTION_PROTOCOL_PROMPT).toContain('stopping it is never your move');
    // 幸存者合并：幸存照常，被收方向不进结果。
    expect(INSERTION_PROTOCOL_PROMPT).toContain(INV.survivorsMerge);
    expect(INSERTION_PROTOCOL_PROMPT).toContain('The cancelled direction stays out of the final result');
    // 旧口径不得回流：协议不再教模型自己去停任何在跑的东西、自己去回滚。
    expect(INSERTION_PROTOCOL_PROMPT).not.toMatch(/that includes stopping anything still running/);
    expect(INSERTION_PROTOCOL_PROMPT).not.toContain("the host's literal-stop fast path");
  });

  it('② steer 框架：取消口径与通用口径分流，取消口径不引导「计划照旧」', () => {
    const t = '知乎那路别查了';
    const cancel = steerFrameText(t, true);
    const normal = steerFrameText(t, false);

    // 取消口径：明说这是取消、不派工不进汇总；叙述规则按场景给——有分路
    // 数剩下的分路，没分路就不提分路（框架不预设场景里有几路）。
    expect(cancel).toContain(t);
    expect(cancel).toContain('取消，不是新任务');
    expect(cancel).toMatch(INV.staysOutOfResult);
    expect(cancel).toContain('没有分路就不要提分路');
    // 反漂移锁一：取消框架里绝不能出现「选最小动作，手头的活继续」——那是
    // 2026-09-26 把取消引导成「计划照旧」的元凶话术。
    expect(cancel).not.toContain('选最小动作');
    expect(cancel).not.toContain('手头的活继续');
    // 反漂移锁二（2026-09-28 事故）：不许再教模型「复述原规划几路…实际派出
    // 哪几路」——单任务游戏场景没有「几路」，教了就是对着一路编「几路」。
    expect(cancel).not.toContain('原规划几路');
    expect(cancel).not.toContain('只数实际会派的支');

    // 通用口径：引导读 <insertion_protocol>（协议与框架互为引用）。
    expect(normal).toContain(t);
    expect(normal).toContain('<insertion_protocol>');
    expect(normal).toContain('选最小动作');
    expect(normal).not.toContain('取消');
  });

  it('②→③ 模块导出面（刀 2 沉默化）：回应性收执一族已删且不得回潮', () => {
    // 删函数不是默删：名字一旦回潮（哪怕只是重新导出旧实现），引擎就有了
    // 再说机械腔的原料。导出面锁死——已删名不得重现。
    const names = Object.keys(mod);
    for (const dead of [
      'branchStopReceipt',
      'cancelBeforeDispatchReceipt',
      'foldInReceipt',
      'foldInEarlyReceipt',
      'queuedReceipt',
      'queuedUrgentReceipt',
      'steerFallbackReceipt',
      'holdReleaseReceipt',
      'holdReleaseTurnReceipt',
      'truePauseReceipt',
      'selfCheckClearReceipt',
    ]) {
      expect(names).not.toContain(dead);
    }
    // 存留名：框架文本（不示范措辞）+ 判例/事实播报收执。
    for (const live of [
      'steerFrameText',
      'branchUncertainPauseReceipt',
      'cancelFoldInstruction',
      'settledBranchCancelNote',
      'cancelFoldUnmatchedReceipt',
      'foldInInstruction',
      'foldInFollowUpText',
      'queuedHandoffText',
      'branchResumeReceipt',
      'treeResumeReceipt',
      'truePauseReentryText',
      'frozenSideEffectReceipt',
      'CANCELLATION_INVARIANTS',
      'RESUME_INVARIANTS',
      'FROZEN_INVARIANTS',
    ]) {
      expect(names).toContain(live);
    }
  });

  it('③ 存留收执只说真事：拿不准暂停如实交代，点名没停成明说没停', () => {
    // 拿不准暂停（2026-10-21 真机三连判例）：没拿准就明说没拿准+给出恢复口
    // ——绝不装「明白」。暂停是宿主已完成动作的汇报。
    const uncertain = branchUncertainPauseReceipt('竞品分析');
    expect(uncertain).toContain('竞品分析');
    expect(uncertain).toContain('没拿准');
    expect(uncertain).toContain('暂停了');
    // 产出剔除承诺：文案说「暂时不进汇总」（该收执在等用户发话，剔出是暂
    // 时的），语义与 INV.staysOutOfResult 同向但不咬同一正则——此处按字面锁。
    expect(uncertain).toContain('不进汇总');
    expect(uncertain).toContain('说一声');
    // 绝不装懂：没拿准的口径里不许出现「明白」。
    expect(uncertain).not.toContain('明白');

    // 点名停支没停成（2026-10-10 判例）：如实说「没停」，把能真停的说法
    // （点名）交给用户——收执纪律：只说真实发生的事。
    const unmatched = cancelFoldUnmatchedReceipt();
    expect(unmatched).toContain('这项不做了');
    expect(unmatched).toContain('先没停');
    expect(unmatched).toContain('停掉');
  });

  it('④ 引擎侧折入框架：取消与追加互为镜像，方向绝不互换', () => {
    const cancelText = '把知乎这项也收掉';
    const cancel = cancelFoldInstruction(cancelText);
    // 追加框架用中性样例——样例本身不带取消词，负向断言才锁得住框架口径。
    const append = foldInInstruction('把芒果TV也查一下');

    // 取消框架：禁止派新委派、产出出清、只合并幸存者——与协议幸存者口径一致。
    expect(cancel).toContain(cancelText);
    expect(cancel).toContain('不要');
    expect(cancel).toContain('派任何委派');
    expect(cancel).toContain('不写入最终汇总');
    expect(cancel).toContain('只覆盖剩下的对象');
    // 反漂移锁：取消框架绝不能带追加口径的「派出去做完/覆盖所有对象」。
    expect(cancel).not.toContain('派出去做完');
    expect(cancel).not.toContain('覆盖所有对象');

    // 追加框架：派出去做完 + 覆盖所有对象，且不能出现取消口径。
    expect(append).toContain('派出去做完');
    expect(append).toContain('覆盖所有对象');
    expect(append).not.toContain('收掉');
    expect(append).not.toContain('取消');
  });

  it('④ 已结算支的剔除墓碑：产出整体剔除，汇总不包含这一路（2026-10-15）', () => {
    const note = settledBranchCancelNote();
    // 墓碑三件事：标明已取消、禁止引用复述、汇总只交代不含这路。
    expect(note).toContain('已按用户要求取消');
    expect(note).toContain('不要引用或复述');
    expect(note).toContain('不包含这一路');
  });

  it('折入兜底口径（转排队）：保持追加合并方向，不夹带取消口径', () => {
    const follow = foldInFollowUpText('把芒果TV也查一下');
    expect(follow).toContain('（中途追加）');
    expect(follow).toContain('覆盖全部对象');
    expect(follow).not.toContain('取消');
    expect(follow).not.toContain('收掉');
  });

  it('锚点常量与实际文案同步（锚漂移即测试失败，提示改锚或改文案）', () => {
    // 锚是测试与文案之间的契约：改锚时这里必须一起改。
    expect(INV.hostStops).toBe('host stops or pauses that branch');
    // staysOutOfResult 是正则锚（锁语义方向，同族措辞都算同向）：锁其行为
    // ——三种真实变体都匹配，漂移写法（写成了「进最终汇总」）必须不匹配。
    expect(INV.staysOutOfResult.test('它已经查到的部分不进最终汇总')).toBe(true);
    expect(INV.staysOutOfResult.test('也不会进最终汇总')).toBe(true);
    expect(INV.staysOutOfResult.test('不写入最终汇总（用户没说要保留）')).toBe(true);
    expect(INV.staysOutOfResult.test('把它写进最终汇总')).toBe(false);
    expect(INV.survivorsMerge).toBe('the merge covers the survivors only');
    // absentMechanismWords 是负向锚：锁「出生前取消收执」不带机制词汇。
    // 断言对象 cancelBeforeDispatchReceipt 已随刀 2 删除，锚保留——后续任何
    // 引擎侧兜底话术回潮时仍用此锁（单任务场景一个机制词都嫌多）。
    expect(INV.absentMechanismWords.test('派出')).toBe(true);
    expect(INV.absentMechanismWords.test('汇总')).toBe(true);
    expect(INV.absentMechanismWords.test('那支')).toBe(true);
    expect(INV.absentMechanismWords.test('好——这项不做了。')).toBe(false);
  });
});

// ── 判例收执的场景纪律（2026-10-01 泛化排查存留部分）──
// 回应性固定话术一族已删（刀 2），场景矩阵只剩有判例背书的
// cancelFoldUnmatchedReceipt：它的场景机制真实在场（委派在飞），机制词允许；
// 纪律是「只说真实发生的事」——没停成必须明说没停。

describe('判例收执（存留）', () => {
  it('A4 委派在飞但点名停支没停成 → 收执如实说「没停」，把真停的说法交给用户（2026-10-10）', () => {
    // 旧收执「这项不做了；其余照常」在这个场景失实：支一个没停，用户以为
    // 已停。新口径只说真实发生的事：产出剔除在生效、在飞支没动、点名可停。
    const receipt = cancelFoldUnmatchedReceipt();
    expect(receipt).toContain('这项不做了');
    expect(receipt).toContain('先没停');
    expect(receipt).toContain('停掉');
    // 委派真实在飞的场景，「那支」这类机制词允许在场。
  });

  // footgun 回归锁：本模块每个函数都绝不能带默认形参。带默认值时 caller
  // 忘传会静默落到默认场景——收执话术一旦按默认场景说话，说的就不是这个
  // 场景的真话。JS 的 Function.length 只数「首个默认参数之前」的形参，所以
  // length 等于形参总数就是「每个形参都必须显式给」的运行时证据——一旦
  // 有人给任一函数偷偷加回 `= ...`，length 掉下来，这条立刻红。
  it('footgun 回归：全模块函数都无默认形参（arity 回归锁）', () => {
    expectNoDefaultParams([
      ['steerFrameText（cancel 场景开关必填）', 2, steerFrameText],
      ['branchUncertainPauseReceipt', 1, branchUncertainPauseReceipt],
      ['cancelFoldInstruction', 1, cancelFoldInstruction],
      ['settledBranchCancelNote', 0, settledBranchCancelNote],
      ['cancelFoldUnmatchedReceipt', 0, cancelFoldUnmatchedReceipt],
      ['foldInInstruction', 1, foldInInstruction],
      ['foldInFollowUpText', 1, foldInFollowUpText],
      ['queuedHandoffText', 1, queuedHandoffText],
      ['branchResumeReceipt（pending 时序开关必填）', 3, branchResumeReceipt],
      ['truePauseReentryText（纠偏可空但必填）', 2, truePauseReentryText],
      ['frozenSideEffectReceipt', 1, frozenSideEffectReceipt],
    ]);
  });
});

describe('续跑收执诚实二分（第 2 期第三刀，判例 14）', () => {
  // 判例 14 验收语：「同参重派命中断点，从断点续不从头来；回执说清从哪
  // 轮接的」「resume 找不到断点不许悄悄从头跑——明说『没找到存档，重新
  // 跑了』」。收执不能比机制许的愿更多：命中说轮数，没命中明说重跑。
  it('hit：说清从存档断点第几轮接上；pending 时补尾巴，miss 语绝不出现', () => {
    const t = branchResumeReceipt('竞品分析员', { hit: true, turns: 7 }, true);
    expect(t).toContain('续跑：「竞品分析员」');
    expect(t).toMatch(RESUME_INV.hitSaysFromCheckpoint);
    expect(t).toContain('第 7 轮');
    expect(t).toContain('等手头这批收齐接上。');
    expect(t).not.toContain('没找到存档');
    // 正则锚必须真咬住轮数——正则里没有 \d 的话锚就只剩装饰作用。
    expect(RESUME_INV.hitSaysFromCheckpoint.test('从存档断点（第 12 轮）接上')).toBe(true);
    expect(RESUME_INV.hitSaysFromCheckpoint.test('没找到存档，会重新跑一遍')).toBe(false);
  });

  it('miss：明说没找到存档会重新跑，绝不预支「断点」承诺', () => {
    const t = branchResumeReceipt('竞品分析员', { hit: false, turns: 0 }, false);
    expect(t).toContain('续跑：「竞品分析员」');
    expect(t).toMatch(RESUME_INV.missAdmitsNoArchive);
    expect(t).toContain('会重新跑一遍');
    expect(t).not.toContain('断点');
    expect(t).not.toContain('等手头这批收齐接上'); // pending=false 无尾巴
  });
});

// ── 插话架构 v2 存留文本（2026-10-27 软暂停/真暂停链）─────────────────────
// v2 的放行/转向/真暂停/自查收执已随框架改革刀 2 删除（模型现场 receipt
// 唯一来源，引擎沉默兜底）；留下的是真暂停的引擎侧重入框架与已完成副作用的
// 冻结收执。收执纪律不变：只说这个场景里真实发生/真实在场的事。
describe('插话 v2 存留文本（真暂停重入/冻结）', () => {
  it('真暂停重入框架：带原话+纠偏+不当既成事实三件事；幂等且无纠偏时裸发', () => {
    const framed = truePauseReentryText('做一个记账 App', '不用登录，单机就行');
    expect(framed).toContain('做一个记账 App');
    expect(framed).toContain('不用登录，单机就行');
    expect(framed).toContain('已从上下文清出');
    expect(framed).toContain('不要当既成事实');
    // 幂等：已带框架的原话不再二次包装；纠偏为空退回裸原话。
    expect(truePauseReentryText(framed, '再改一句')).toBe(framed);
    expect(truePauseReentryText('原话', '')).toBe('原话');
    expect(truePauseReentryText('原话', '   ')).toBe('原话');
  });

  it('冻结收执：说已完成+冻住+问用户发话，绝不预支「已撤销」', () => {
    const t = frozenSideEffectReceipt('生成报表');
    expect(t).toContain('生成报表');
    expect(t).toContain('已经做完');
    expect(t).toMatch(FROZEN_INV.frozenNamesFreeze);
    expect(t).toMatch(FROZEN_INV.frozenAsksUser);
    // 一期没有自动补偿：收执不许说补偿已发生。
    expect(t).not.toContain('已撤销');
    expect(t).not.toContain('补偿');
  });

  it('冻结锚同步：冻字必在场、必须开口问用户（锚漂移即失败）', () => {
    expect(FROZEN_INV.frozenNamesFreeze.test('我先把它冻住')).toBe(true);
    expect(FROZEN_INV.frozenAsksUser.test('你说一声')).toBe(true);
    expect(FROZEN_INV.frozenAsksUser.test('要不要撤掉')).toBe(true);
    // 不开口问的冻结收执漂了锚。
    expect(FROZEN_INV.frozenAsksUser.test('已经冻住了。')).toBe(false);
  });
});

describe('整树续跑回执判定（第 3 期刀 3）', () => {
  // send('继续') 引导的恢复回合里，每个重派支起飞时宿主问一次判定：命中
  // 带轮数、旧支存档丢失明说重跑、新委派闭嘴。话术与分支级继续同源
  // （branchResumeReceipt）——漂移即打回。
  const resuming = { resumingPausedTurn: true, pausedBranches: new Set(['竞品分析员']) };

  it('命中存档：说从第几轮接上（轮数缺失兜 0 也要咬住 hit 语）', () => {
    const t = treeResumeReceipt({ agentName: '竞品分析员', resumed: true, resumedTurns: 7 }, resuming);
    expect(t).toMatch(RESUME_INV.hitSaysFromCheckpoint);
    expect(t).toContain('第 7 轮');
    expect(t).not.toContain('没找到存档');
    // resumedTurns 没上报（旧宿主/旧事件）时 hit 语义不能丢。
    expect(treeResumeReceipt({ agentName: '竞品分析员', resumed: true }, resuming))
      .toMatch(RESUME_INV.hitSaysFromCheckpoint);
  });

  it('恢复回合 + 停着的旧支存档丢失：明说重跑，不预支断点', () => {
    const t = treeResumeReceipt({ agentName: '竞品分析员', resumed: false }, resuming);
    expect(t).toMatch(RESUME_INV.missAdmitsNoArchive);
    expect(t).toContain('会重新跑一遍');
    expect(t).not.toContain('断点');
  });

  it('恢复回合 + 名单外的新委派：null，不出声', () => {
    expect(treeResumeReceipt({ agentName: '新调研员', resumed: false }, resuming)).toBeNull();
  });

  it('非恢复回合：一律 null——回执只随恢复回合出，防噪音', () => {
    const notResuming = { resumingPausedTurn: false, pausedBranches: new Set(['竞品分析员']) };
    expect(treeResumeReceipt({ agentName: '竞品分析员', resumed: false }, notResuming)).toBeNull();
  });
});

// 对话主导架构刀 C（2026-10-21，用户拍板）：排队插话重入裸发原话 = 模型把
// 它当凭空而来的新请求——用户报的「说出来的话和语境不搭」的直接机制。交接
// 框架交给模型三个事实（你忙时说的/排到了现在/现在接上结合现场消化），屏幕
// 仍显示原话（displayText 与框架分离，send 的双文本缝原生支持）。
describe('队列交接框架（2026-10-21 刀 C）', () => {
  it('框架带原话+三个事实：忙时说的、排到了现在、结合刚做的消化', () => {
    const framed = queuedHandoffText('再加一个爱奇艺平台');
    expect(framed).toContain('【排队中的用户消息');
    expect(framed).toContain('再加一个爱奇艺平台');
    expect(framed).toContain('忙于前一件事时');
    expect(framed).toContain('排进了队列');
    expect(framed).toContain('结合刚做完的事');
    // 教它别从零开始——语境断裂的解药在这半句。
    expect(framed).toContain('不要当成凭空而来的新请求从零开始');
  });

  it('幂等：已带框架的原样返回，空话原样返回（恢复旧档不二次包装）', () => {
    const once = queuedHandoffText('顺便查一下汇率');
    expect(queuedHandoffText(once)).toBe(once);
    expect(queuedHandoffText('')).toBe('');
    expect(queuedHandoffText('  ')).toBe('  ');
  });

  it('宿主接线：queueInterjectTask 入队时框架化引擎文本，displayText 保持原话', () => {
    const src = readFileSync(new URL('../../ui/chat.ts', import.meta.url), 'utf8');
    const at = src.indexOf('private queueInterjectTask(');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('hasPendingCloseWork(', at));
    expect(body).toContain('queuedHandoffText(text)');
    // displayText 原样进账——队列卡与重入上屏都是原话。
    expect(body).toContain('displayText, ts: Date.now()');
  });
});

// ── 刀 2 沉默化接线锁：模型现场 receipt 唯一来源，引擎沉默兜底 ─────────────
// 回应性固定话术已全删。沉默不是「换个说法」：任何独立于语境的固定句按构
// 就是编造（它不知道场景里真实发生了什么），宿主接线里出现即回潮。
describe('收执沉默化接线（2026-10-28 刀 2）', () => {
  it('steerRunningTurn 收执位：receipt 缺席即沉默 settleAck(…, null)', () => {
    const src = readFileSync(new URL('../../ui/chat.ts', import.meta.url), 'utf8');
    // 兜底唯一形态：模型 receipt 优先，缺席转 null（沉默），绝不落到固定句。
    expect(src).toContain('this.settleAck(ack, receipt?.trim() || null);');
    // 固定句与兜底函数零存活（chat.ts 注释里的历史提及其名不算回潮，
    // 锁的是调用形态）。
    expect(src).not.toContain('?? steerFallbackReceipt');
    expect(src).not.toContain('steerFallbackReceipt(');
    expect(src).not.toContain('收到——活不停，下个动作就带上这句');
    expect(src).not.toContain('已直接转给「${target.branchName}」那一路');
    expect(src).not.toContain('路都收到了——各自下个动作就带上');
  });

  it('排期收执固定句零存活：排上了/插队了不再由引擎说出（队列卡就地呈现）', () => {
    const chat = readFileSync(new URL('../../ui/chat.ts', import.meta.url), 'utf8');
    const orch = readFileSync(new URL('../../coding-agent/interjectOrchestrator.ts', import.meta.url), 'utf8');
    expect(chat).not.toContain('排上了');
    expect(chat).not.toContain('插队了');
    expect(orch).not.toContain("排上了'");
    expect(orch).not.toContain("插队了'");
  });

  it('编排器折入/停支收执位：receipt 缺席即 null，固定句零存活', () => {
    const orch = readFileSync(new URL('../../coding-agent/interjectOrchestrator.ts', import.meta.url), 'utf8');
    // 停成/出生前两处停支收执：receipt ?? null——沉默退场。
    expect(orch).toContain('settleAck(ack, receipt ?? null)');
    // 折入固定句族不得回流（锁固定句本体；注释里的历史提及其片段不算——
    // 锁的是会被说出口的字符串字面量）。
    expect(orch).not.toContain('这项不做了；其余照常。');
    expect(orch).not.toContain('已收到——收齐后先补这项');
    expect(orch).not.toContain('做完手头的就带上这句');
  });
});
