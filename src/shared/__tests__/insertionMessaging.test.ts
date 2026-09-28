// src/shared/__tests__/insertionMessaging.test.ts
// 取消话术三处一致性契约（2026-09-28）：取消这件事在系统里有三处教导/呈现
// ——① L1 协议（教模型）；② steer 框架（宿主投递正文）；③ 宿主收执（用户
// 当场看到的）。三处各自改文案就会漂移（收执说「暂停了」而协议说「别停」
// 是用户可见的自相矛盾），这里一次锁住三处的口径方向。
//
// 本测试锁的是「同一规则的多处措辞必须同向」，不是判定逻辑——判定归
// DynamicInsertionCoordinator / chat.ts / steerTargeting.ts，各有自己的测试。

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
} from '../insertionMessaging';

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

    // 取消口径：明说这是取消、不进计划不派工不进汇总、只数会派的支。
    expect(cancel).toContain(t);
    expect(cancel).toContain('取消，不是新任务');
    expect(cancel).toMatch(INV.staysOutOfResult);
    expect(cancel).toContain('只数实际会派的支');
    // 反漂移锁：取消框架里绝不能出现「选最小动作，手头的活继续」——那是
    // 2026-09-26 把取消引导成「计划照旧」的元凶话术。
    expect(cancel).not.toContain('选最小动作');
    expect(cancel).not.toContain('手头的活继续');

    // 通用口径：引导读 <insertion_protocol>（协议与框架互为引用）。
    expect(normal).toContain(t);
    expect(normal).toContain('<insertion_protocol>');
    expect(normal).toContain('选最小动作');
    expect(normal).not.toContain('取消');
  });

  it('②→③ steer 框架与收执同一方向：收执汇报宿主动作，承诺产出出清', () => {
    // 停支收执（pause/abort）都以宿主第一人称汇报「已完成」的动作，
    // 且承诺与协议/框架同一件事：被收掉的部分不进最终汇总。
    const pause = branchStopReceipt('竞品', 'pause');
    const abort = branchStopReceipt('竞品', 'abort');
    expect(pause).toContain('我先暂停了');
    expect(pause).toMatch(INV.staysOutOfResult);
    expect(pause).toContain('其余照常跑');
    expect(abort).toContain('已停掉');
    expect(abort).toContain('其余照常');

    // 出生前取消收执：没派的不会派 + 不进最终汇总（与框架「不派工」同向）。
    const named = cancelBeforeDispatchReceipt('知乎');
    const bare = cancelBeforeDispatchReceipt(null);
    expect(named).toContain('知乎');
    expect(named).toContain('还没派的不会派出去');
    expect(named).toMatch(INV.staysOutOfResult);
    expect(bare).toContain('还没派的不会派出去');
    expect(bare).toMatch(INV.staysOutOfResult);

    // 折入收执：取消型与追加型方向相反，且取消型必含出清承诺。
    const cancelFold = foldInReceipt(true);
    const appendFold = foldInReceipt(false);
    expect(cancelFold).toContain('收掉了');
    expect(cancelFold).toMatch(INV.staysOutOfResult);
    expect(appendFold).toContain('先补这项');
    expect(cancelFold).not.toContain('先补这项');
    expect(appendFold).not.toContain('收掉了');
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
  });
});
