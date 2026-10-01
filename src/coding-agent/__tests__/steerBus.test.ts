// S2 第一刀 — SteerBus 的投递/消费语义：与 chat.ts 闭包原实现逐条对齐
// （广播复制/父收走、点名独占、折入父边界缝、残留结算）。
import { describe, expect, it } from 'bun:test';
import { SteerBus, type SteerQueueEntry } from '../steerBus';
import type { Message } from '../../shared/types';
import type { SteerRecipient } from '../../shared/steerTargeting';

function entry(target: SteerQueueEntry['target'], text: string, extra: Partial<SteerQueueEntry> = {}): SteerQueueEntry {
  return { message: { role: 'user', content: text }, target, displayText: text, ...extra };
}

const BRANCH_A: SteerRecipient = { branchCallId: 'call_a', branchName: 'researcher' };
const BRANCH_B: SteerRecipient = { branchCallId: 'call_b', branchName: 'code_reviewer' };

describe('SteerBus drain semantics', () => {
  it('named entries deliver ONLY to the named branch and are consumed by it alone', () => {
    const bus = new SteerBus();
    bus.enqueue(entry({ branchCallId: 'call_a', branchName: 'researcher' }, '方向偏了看 X'));
    expect(bus.drain(BRANCH_B)).toEqual([]);            // 别的支拿不到
    const got = bus.drain(BRANCH_A);                     // 被点名的支取走
    expect(got).toHaveLength(1);
    expect(bus.drain(BRANCH_A)).toEqual([]);             // 一次性消费
    expect(bus.entries()).toHaveLength(0);
  });

  it('broadcast entries are readable (copied) by every branch, consumed only by the parent boundary', () => {
    const bus = new SteerBus();
    bus.enqueue(entry('all', '都注意一下时间基准'));
    const a = bus.drain(BRANCH_A);
    const b = bus.drain(BRANCH_B);
    expect(a).toHaveLength(1); // 分支读到的是复制
    expect(b).toHaveLength(1);
    expect(bus.entries()).toHaveLength(1); // 还没收走
    const parent = bus.drain(undefined);
    expect(parent).toHaveLength(1); // 只有父边界收走
    expect(bus.entries()).toHaveLength(0);
  });

  it('parent entries deliver at the parent boundary and are consumed there', () => {
    const bus = new SteerBus();
    bus.enqueue(entry('parent', '重点看第二个主题'));
    expect(bus.drain(BRANCH_A)).toEqual([]); // 分支拿不到父级话
    expect(bus.drain(undefined)).toHaveLength(1);
    expect(bus.entries()).toHaveLength(0);
  });

  it('invokes the folds hook only at the parent boundary, never on a branch pull', () => {
    const bus = new SteerBus();
    let calls = 0;
    const folds = (): Message[] => { calls++; return [{ role: 'user', content: '【合并口径】' }]; };
    bus.drain(BRANCH_A, folds);
    expect(calls).toBe(0);          // 分支拉取绝不触发折入（身份检查结构性排除）
    const parent = bus.drain(undefined, folds);
    expect(calls).toBe(1);
    expect(parent.some((m) => m.content === '【合并口径】')).toBe(true);
  });

  it('the host can decline folds inside the hook (its own in-flight check)', () => {
    const bus = new SteerBus();
    bus.enqueue(entry('parent', 'x'));
    const drained = bus.drain(undefined, () => []); // 宿主判在飞 ⇒ 不铺
    expect(drained).toHaveLength(1);                 // steer 照常，折入为零
  });
});

describe('SteerBus settleRound', () => {
  it('returns unconsumed entries and clears the queue', () => {
    const bus = new SteerBus();
    bus.enqueue(entry({ branchCallId: 'call_gone', branchName: 'researcher' }, '停掉那支'));
    bus.enqueue(entry('all', '都看到了吧'));
    const leftover = bus.settleRound();
    expect(leftover).toHaveLength(2);
    expect(bus.entries()).toHaveLength(0);
  });

  it('drops internal entries without displayText (already-answered side answers, account settled)', () => {
    const bus = new SteerBus();
    bus.enqueue(entry('parent', '已答上的旁答', { displayText: '', message: { role: 'user', content: '已答上的旁答', internal: true } }));
    bus.enqueue(entry('parent', '没答上的问题'));
    const leftover = bus.settleRound();
    expect(leftover).toHaveLength(1);
    expect(leftover[0].displayText).toBe('没答上的问题');
  });
});
