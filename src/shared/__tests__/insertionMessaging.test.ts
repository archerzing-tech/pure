// src/shared/__tests__/insertionMessaging.test.ts
// 取消话术三处一致性契约（2026-09-28）：取消这件事在系统里有三处教导/呈现
// ——① L1 协议（教模型）；② steer 框架（宿主投递正文）；③ 宿主收执（用户
// 当场看到的）。三处各自改文案就会漂移（收执说「暂停了」而协议说「别停」
// 是用户可见的自相矛盾），这里一次锁住三处的口径方向。
//
// 本测试锁的是「同一规则的多处措辞必须同向」，不是判定逻辑——判定归
// DynamicInsertionCoordinator / chat.ts / steerTargeting.ts，各有自己的测试。
//
// 2026-09-28 收执纪律并入本契约：收执（用户当场看到的）只说场景里真实
// 发生/真实在场的事——可能在单任务场景发出的收执（出生前取消）一个机制
// 词汇都不带；机制承诺（不派工/不进汇总/只合并幸存者）住在协议与框架里。

import { describe, it, expect } from 'bun:test';
import { INSERTION_PROTOCOL_PROMPT } from '../promptLayers';
import {
  steerFrameText,
  branchStopReceipt,
  cancelBeforeDispatchReceipt,
  foldInReceipt,
  cancelFoldInstruction,
  foldInInstruction,
  foldInFollowUpText,
  CANCELLATION_INVARIANTS as INV,
  branchResumeReceipt,
  RESUME_INVARIANTS as RESUME_INV,
} from '../insertionMessaging';
import { expectNoDefaultParams } from './arityLock';

describe('插话取消话术三处一致性', () => {
  it('① L1 协议：停/暂停分支是宿主动作，模型永不亲自动手停', () => {
    // 分支取消：宿主停，模型只管叙述/排除产出/合并幸存者。
    expect(INSERTION_PROTOCOL_PROMPT).toContain(INV.hostStops);
    expect(INSERTION_PROTOCOL_PROMPT).toContain('stopping it is never your move');
    expect(INSERTION_PROTOCOL_PROMPT).toContain(INV.survivorsMerge);
    // 方向推翻：停旧方向的活也是宿主的动作，模型只保证不再为旧方向派工。
    expect(INSERTION_PROTOCOL_PROMPT).toContain("the host has been asked to stop the old direction");
    expect(INSERTION_PROTOCOL_PROMPT).toContain("is the host's move");
    expect(INSERTION_PROTOCOL_PROMPT).toContain('never dispatch for the old direction again');
    // 前提失效：止损（停下与 pending call）也归宿主，模型负责重算与不抢救。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('the host stops that step and its pending calls NOW');
    // 旧口径不得回流：协议不再教模型自己去停任何在跑的东西、自己去回滚。
    expect(INSERTION_PROTOCOL_PROMPT).not.toMatch(/that includes stopping anything still running/);
    expect(INSERTION_PROTOCOL_PROMPT).not.toContain('stop that step and its pending calls NOW instead of letting them finish and patching afterwards — roll back to the last checkpoint');
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

  it('②→③ steer 框架与收执同一方向：收执汇报宿主动作，只说场景里真实在场的机制', () => {
    // 停支收执（pause/abort）都以宿主第一人称汇报「已完成」的动作。这条
    // 路径上委派确实在飞（stopNamedBranch 只在 hasDelegationInFlight 时可达），
    // 「支/汇总」词汇场景真实；出清承诺与框架同向。措辞不预设这支在干
    // 调研还是写码——「产出」兼指两者。
    const pause = branchStopReceipt('竞品', 'pause');
    const abort = branchStopReceipt('竞品', 'abort');
    expect(pause).toContain('我先暂停了');
    expect(pause).toMatch(INV.staysOutOfResult);
    expect(pause).toContain('其余照常跑');
    expect(abort).toContain('已停掉');
    expect(abort).toContain('其余照常');

    // 出生前取消收执（2026-09-28 事故原文重写）：这个收执可能在没有任何
    // 委派、没有任何汇总的单任务场景发出——「还没派的不会派出去，也不会
    // 进最终汇总」两头都是编造（用户实测原话：「我在做游戏，哪来的需要
    // 汇总」）。所以只说砍了什么，一个机制词汇都不带（INV.absentMechanismWords
    // 负向锁）；机制承诺住在框架与协议里，那里才面向模型、才该说机制。
    const named = cancelBeforeDispatchReceipt('测试');
    const bare = cancelBeforeDispatchReceipt(null);
    expect(named).toContain('测试');
    expect(named).toContain('这项不做了');
    expect(bare).toContain('这项不做了');
    expect(named).not.toMatch(INV.absentMechanismWords);
    expect(bare).not.toMatch(INV.absentMechanismWords);

    // 折入收执：取消型与追加型方向相反，且取消型必含出清承诺。这条路径
    // 有委派在飞（折入只在 hasDelegationInFlight 时可达），汇总/合并词汇
    // 场景真实。
    const cancelFold = foldInReceipt(true, true);
    const appendFold = foldInReceipt(false, true);
    expect(cancelFold).toContain('不做了');
    expect(appendFold).toContain('先补这项');
    expect(cancelFold).not.toContain('先补这项');
    expect(appendFold).not.toContain('不做了');
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
    // absentMechanismWords 是负向锚：锁「出生前取消收执」不带机制词汇，
    // 三个机制词都要命中（收执安全线，2026-09-28 事故立）。
    expect(INV.absentMechanismWords.test('派出')).toBe(true);
    expect(INV.absentMechanismWords.test('汇总')).toBe(true);
    expect(INV.absentMechanismWords.test('那支')).toBe(true);
    expect(INV.absentMechanismWords.test('好——这项不做了。')).toBe(false);
  });
});

// ── 2026-10-01 用户要求泛化排查：收执话术的场景矩阵 ──
// 用户场景："我让你做 3 件事，中途说 xxx 不做了"——3 件事有三种形态
// （3 路并行委派 / 委派未出生 / 单任务 3 步），每种形态的收执必须是那个
// 场景里的真话。不变式：**无委派的收执绝不带机制词汇**（汇总/合并/收齐/
// 派工/支/路）——那些词只属于多路调研的世界（续八收执纪律的泛化）。

/** 机制词汇黑名单——单任务收执中出现任何一个都是编造。 */
const MECHANISM_WORDS = /汇总|合并|收齐|派工|那路|那支|调研/;

describe('收执场景矩阵（2026-10-01 泛化排查）', () => {
  // 用户场景：做 3 件事，中途说「xxx 不做了」

  it('A1 三路并行委派在飞，收掉 1 路 → 机制词真实在场，允许说「其余照常」', () => {
    const receipt = foldInReceipt(true, true);
    expect(receipt).toBe('收到——这项不做了；其余照常。');
    // 有委派在飞，「照常」有真实所指
    expect(receipt).not.toMatch(MECHANISM_WORDS); // 简洁版也不编造细节
  });

  it('A2 三件事在一个单任务里（无委派）→ 一个机制词都不带', () => {
    const receipt = foldInReceipt(true, false);
    expect(receipt).toBe('好——这步不做了。');
    expect(receipt).not.toMatch(MECHANISM_WORDS);
  });

  it('A3 三件事刚下单就反悔一件（委派未出生）→ 只说砍了什么', () => {
    const receipt = cancelBeforeDispatchReceipt('排行榜');
    expect(receipt).toBe('好——“排行榜”这项不做了。');
    expect(receipt).not.toMatch(MECHANISM_WORDS);
    const noTopic = cancelBeforeDispatchReceipt(null);
    expect(noTopic).toBe('好——这项不做了。');
    expect(noTopic).not.toMatch(MECHANISM_WORDS);
  });

  // 追加类的对称场景

  it('B1 单任务中途加活 → 不预支「汇总」', () => {
    const receipt = foldInReceipt(false, false);
    expect(receipt).toBe('收到——做完手头的就带上这句。');
    expect(receipt).not.toMatch(MECHANISM_WORDS);
  });

  it('B2 多路在飞加活 → 「先补这项」有真实所指', () => {
    const receipt = foldInReceipt(false, true);
    expect(receipt).toBe('已收到——收齐后先补这项。');
  });

  // 泛化不变式：无委派口径对任意取消/追加组合都不带机制词。"无委派"只是
  // 这一侧的安全口径——安全默认靠类型系统锁（见下一条），不靠参数默认值。

  it('不变式：无委派口径对任意取消/追加组合都无机制词', () => {
    for (const cancels of [true, false]) {
      const receipt = foldInReceipt(cancels, false);
      expect(receipt).not.toMatch(MECHANISM_WORDS);
    }
  });

  // footgun 回归锁：本模块每个函数都绝不能带默认形参。带默认值时 caller
  // 忘传会静默落到默认场景——foldInReceipt 的 hasDelegation 曾经默认为
  // true，单任务里就会说「其余照常」这类多路黑话；去掉默认值后，忘传是
  // 编译错误。JS 的 Function.length 只数「首个默认参数之前」的形参，所以
  // length 等于形参总数就是「每个形参都必须显式给」的运行时证据——一旦
  // 有人给任一函数偷偷加回 `= ...`，length 掉下来，这条立刻红。
  it('footgun 回归：全模块函数都无默认形参（arity 回归锁）', () => {
    expectNoDefaultParams([
      ['steerFrameText（cancel 场景开关必填）', 2, steerFrameText],
      ['branchStopReceipt（pause/abort 口径必填）', 2, branchStopReceipt],
      ['cancelBeforeDispatchReceipt（topic 必填，显式传 null）', 1, cancelBeforeDispatchReceipt],
      ['foldInReceipt（cancels + hasDelegation 场景必填）', 2, foldInReceipt],
      ['cancelFoldInstruction', 1, cancelFoldInstruction],
      ['foldInInstruction', 1, foldInInstruction],
      ['foldInFollowUpText', 1, foldInFollowUpText],
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
