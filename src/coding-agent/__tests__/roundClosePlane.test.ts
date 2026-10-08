// S2 第五刀 — RoundClosePlane：收尾裁决序逐拍断言（回执结算 → 折入核验 →
// 续跑兜底 → 押账插话优先 → 残留 steer 重入 → 队列派发）、让位规则
// （isStreaming / autoContinue.pending）、调度（注入 timer、重叠调度安全）。
// 语义锁从 chat.ts dispatchDeferred 原样迁移（不发明第二种语义）。
import { describe, expect, it } from 'bun:test';
import { RoundClosePlane, type QueuedTask, type RoundCloseDeps } from '../roundClosePlane';
import type { SteerQueueEntry } from '../steerBus';

const IMG: never[] = [];
const task = (text: string, over: Partial<QueuedTask> = {}): QueuedTask => ({ text, images: IMG, displayText: text, ts: 1, ...over });

function steer(text: string, displayText = ''): SteerQueueEntry {
  return { message: { role: 'user', content: text }, target: 'parent', displayText, images: IMG } as unknown as SteerQueueEntry;
}

/** 全录依赖缝：每拍调用按序记进 calls，返回 plane 与账本供断言。 */
function rig(over: Partial<RoundCloseDeps> = {}) {
  const calls: string[] = [];
  const reentered: QueuedTask[] = [];
  let streaming = false;
  let autoContinuePending = false;
  const deps: RoundCloseDeps = {
    activityCount: () => 0,
    isStreaming: () => streaming,
    autoContinuePending: () => autoContinuePending,
    steerSettleRound: () => { calls.push('steerSettle'); return []; },
    delegationSettleRound: () => { calls.push('delegationSettle'); },
    foldSettle: () => { calls.push('foldSettle'); return []; },
    resumeFallback: () => { calls.push('resumeFallback'); return null; },
    settleReceipts: () => { calls.push('settleReceipts'); },
    supersedeAutoContinue: () => { calls.push('supersede'); },
    reenter: (t) => { calls.push('reenter'); reentered.push(t); },
    narrateHandoff: (remaining) => { calls.push(`narrate:${remaining}`); },
    timer: () => {},
    ...over,
  };
  const plane = new RoundClosePlane(deps);
  return { plane, calls, reentered, setStreaming: (v: boolean) => { streaming = v; }, setPending: (v: boolean) => { autoContinuePending = v; } };
}

describe('RoundClosePlane dispatch 裁决序', () => {
  it('walks the five beats in order: receipts → folds → resumes → steers → queue', () => {
    const r = rig({
      foldSettle: () => { r.calls.push('foldSettle'); return [task('补一个知乎')]; },
      resumeFallback: () => { r.calls.push('resumeFallback'); return task('【分支级继续】接着跑'); },
      steerSettleRound: () => { r.calls.push('steerSettle'); return []; },
    });
    r.plane.queueTask(task('排队的活'));
    r.plane.dispatch();
    // 逐拍：回执 → 折入 → 续跑兜底 → steer 结算 → 起飞闸清空 → 队列交接 + 重入。
    expect(r.calls).toEqual(['settleReceipts', 'foldSettle', 'resumeFallback', 'steerSettle', 'delegationSettle', 'narrate:2', 'reenter']);
    // 折入残差/兜底先入队，队头的排队任务先派（shift 语义）；一趟能只派
    // 一件，剩下的等下一次调度。
    expect(r.reentered[0].text).toBe('排队的活');
    expect(r.plane.queueView().map((t) => t.text)).toEqual(['补一个知乎', '【分支级继续】接着跑']);
  });

  it('re-enters a held insert first, superseding the 继续 chain, consuming it exactly once', () => {
    const r = rig();
    r.plane.holdInsert(task('换个方向', { displayText: '换个方向（原话）' }));
    r.plane.dispatch();
    expect(r.calls).toEqual(['settleReceipts', 'foldSettle', 'resumeFallback', 'supersede', 'reenter']);
    expect(r.reentered).toEqual([task('换个方向', { displayText: '换个方向（原话）' })]);
    // 押账即消费：第二趟不再重入（旧插话不重放）。
    r.calls.length = 0;
    r.reentered.length = 0;
    r.plane.dispatch();
    expect(r.reentered).toEqual([]);
    expect(r.calls).not.toContain('supersede');
  });

  it('held insert outranks fold residuals queued in the same dispatch', () => {
    const r = rig({ foldSettle: () => [task('残差')] });
    r.plane.holdInsert(task('方向变了'));
    r.plane.queueTask(task('排队的活'));
    r.plane.dispatch();
    // 押账优先级最高：残差只入队，等下一趟。
    expect(r.reentered.map((t) => t.text)).toEqual(['方向变了']);
    expect(r.plane.queueView().map((t) => t.text)).toEqual(['排队的活', '残差']);
  });

  it('re-enters leftover steers as the user’s own words and settles the gate ledger every round', () => {
    const r = rig({ steerSettleRound: () => { r.calls.push('steerSettle'); return [steer('框架文A', '原话A'), steer('框架文B')]; } });
    r.plane.dispatch();
    expect(r.calls).toEqual(['settleReceipts', 'foldSettle', 'resumeFallback', 'steerSettle', 'delegationSettle', 'supersede', 'reenter']);
    // 拼接重入：displayText 空的回落 message.content；重入话与展示话同源
    //（原 chat 语义：send(text) 的 displayUserText 缺省 = userText）；图片随行。
    expect(r.reentered[0].text).toBe('原话A\n框架文B');
    expect(r.reentered[0].displayText).toBe('原话A\n框架文B');
  });

  it('settles the delegation gate ledger even with no steers (挂 号不跨回合)', () => {
    const r = rig();
    r.plane.dispatch();
    expect(r.calls).toContain('delegationSettle');
  });
});

describe('RoundClosePlane 让位规则', () => {
  it('no-ops while streaming (nothing settles, nothing re-enters)', () => {
    const r = rig();
    r.plane.queueTask(task('排队的活'));
    r.plane.holdInsert(task('押账'));
    r.setStreaming(true);
    r.plane.dispatch();
    expect(r.calls).toEqual([]);
    // 账原封不动：流态落 false 后同一趟照派。
    r.setStreaming(false);
    r.plane.dispatch();
    expect(r.reentered.map((t) => t.text)).toEqual(['押账']);
  });

  it('queue dispatch yields to a pending 继续 chain but held inserts do not', () => {
    const r = rig();
    r.plane.queueTask(task('排队的活'));
    r.plane.holdInsert(task('方向变了'));
    r.setPending(true);
    r.plane.dispatch();
    expect(r.reentered.map((t) => t.text)).toEqual(['方向变了']); // 用户自己的话优先于续跑链
    r.calls.length = 0;
    r.reentered.length = 0;
    r.plane.dispatch(); // 续跑链还挂着：队列让位，活留账上
    expect(r.reentered).toEqual([]);
    expect(r.plane.queueView()).toHaveLength(1);
    r.setPending(false);
    r.plane.dispatch();
    expect(r.reentered.map((t) => t.text)).toEqual(['排队的活']);
  });

  it('narrates the handoff with the remaining count before re-entering', () => {
    const r = rig();
    r.plane.queueTask(task('第一件'));
    r.plane.queueTask(task('第二件'));
    r.plane.dispatch();
    expect(r.calls).toContain('narrate:1');
    expect(r.reentered[0].text).toBe('第一件');
  });
});

describe('RoundClosePlane 调度与清场', () => {
  it('arms the injected timer at 40ms and the tick runs the dispatch', () => {
    const armed: Array<{ fn: () => void; ms: number }> = [];
    const r = rig({ timer: (fn, ms) => { armed.push({ fn, ms }); } });
    r.plane.scheduleDispatch();
    expect(armed).toHaveLength(1);
    expect(armed[0].ms).toBe(40);
    armed[0].fn();
    expect(r.calls).toContain('settleReceipts');
  });

  it('is idempotent under overlapping schedules: the second dispatch finds no work', () => {
    const r = rig();
    r.plane.dispatch();
    r.plane.dispatch();
    // 两趟都走完整序（回执结算每趟都要），但只重入零件——无账无害。
    expect(r.calls.filter((c) => c === 'reenter')).toHaveLength(0);
  });

  it('reset clears both the queue and the held insert (new chat leaves nothing behind)', () => {
    const r = rig();
    r.plane.queueTask(task('排队的活'));
    r.plane.holdInsert(task('押账'));
    r.plane.reset();
    expect(r.plane.queueView()).toHaveLength(0);
    expect(r.plane.hasHeldInsert()).toBe(false);
    r.plane.dispatch();
    expect(r.reentered).toEqual([]);
  });
});
