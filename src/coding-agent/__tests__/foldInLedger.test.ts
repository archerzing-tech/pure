// S2 第四刀 — FoldInLedger：折入的闸（在飞不可交付）、账（投递水位、代执行
// 凭据）、核验（机械兑现/水位新增/取消型恒残差）。语义锁从 chat.ts 原样迁移
// （不发明第二种语义）；宿主读数全部注入，账本不猜宿主状态。
import { describe, expect, it } from 'bun:test';
import { FoldInLedger } from '../foldInLedger';

const IMG: never[] = [];

function env(over: Partial<{ delegationInFlight: boolean; activityCount: number; lastAgentRole: () => string | undefined }> = {}) {
  return { delegationInFlight: false, activityCount: 2, lastAgentRole: () => 'researcher' as string | undefined, ...over };
}

describe('FoldInLedger beginDelivery', () => {
  it('delivers nothing while a delegation is in flight (gate, no consumption)', () => {
    const l = new FoldInLedger();
    l.add('加一个爱奇艺', IMG, '加一个爱奇艺', false, false);
    expect(l.beginDelivery(env({ delegationInFlight: true }))).toEqual([]);
    // 闸门不消费：收齐后第一次投递照常出。
    const plans = l.beginDelivery(env());
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual({ kind: 'instruction', fold: expect.objectContaining({ delivered: true }) });
  });

  it('delivers instruction folds with the watermark recorded at delivery time', () => {
    const l = new FoldInLedger();
    l.add('加一个爱奇艺', IMG, '加一个爱奇艺', false, false);
    const plans = l.beginDelivery(env({ activityCount: 3 }));
    expect(plans[0].kind).toBe('instruction');
    expect((plans[0] as { fold: { activityCountAtDelivery: number } }).fold.activityCountAtDelivery).toBe(3);
  });

  it('lays the merge frame for mechanical additions exactly once', () => {
    const l = new FoldInLedger();
    l.add('再加一个平台', IMG, '再加一个平台', true, false);
    const first = l.beginDelivery(env());
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual({ kind: 'mergeFrame', fold: expect.objectContaining({ mergeFramed: true }), role: 'researcher' });
    // 第二轮不再铺（mergeFramed 一次性）。
    expect(l.beginDelivery(env())).toEqual([]);
  });

  it('skips the merge frame without consuming when no last role exists yet', () => {
    const l = new FoldInLedger();
    l.add('再加一个平台', IMG, '再加一个平台', true, false);
    expect(l.beginDelivery(env({ lastAgentRole: () => undefined }))).toEqual([]);
    // 下一轮有角色了照常铺——跳过不是消费。
    expect(l.beginDelivery(env()).map((p) => p.kind)).toEqual(['mergeFrame']);
  });
});

describe('FoldInLedger claimForSynthetic', () => {
  it('claims mechanical additions with delivery marking, watermark and synthetic id', () => {
    const l = new FoldInLedger();
    l.add('再加一个平台', IMG, '再加一个平台', true, false);
    const claimed = l.claimForSynthetic({ activityCount: 4, lastAgentRole: () => 'researcher', assignId: () => 'foldin_1' });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].role).toBe('researcher');
    expect(claimed[0].callId).toBe('foldin_1');
    expect(claimed[0].fold.delivered).toBe(true);
    expect(claimed[0].fold.activityCountAtDelivery).toBe(4);
    expect(claimed[0].fold.syntheticCallId).toBe('foldin_1');
    // 已领用的不再被 beginDelivery 碰（机械型不铺指令框架）。
    expect(l.beginDelivery(env())).toEqual([]);
  });

  it('skips without consuming when no last role exists', () => {
    const l = new FoldInLedger();
    l.add('再加一个平台', IMG, '再加一个平台', true, false);
    expect(l.claimForSynthetic({ activityCount: 1, lastAgentRole: () => undefined, assignId: () => 'x' })).toEqual([]);
    expect(l.entries()[0].delivered).toBe(false);
  });
});

describe('FoldInLedger settle', () => {
  it('honors a mechanical fold once its synthetic call reported success', () => {
    const l = new FoldInLedger();
    l.add('再加一个平台', IMG, '再加一个平台', true, false);
    l.claimForSynthetic({ activityCount: 4, lastAgentRole: () => 'researcher', assignId: () => 'foldin_9' });
    l.markMechanicallyDone('foldin_9');
    expect(l.settle(4)).toEqual([]); // 机器核验兑现，无残差
  });

  it('honors an instruction fold only when new delegation activity followed delivery', () => {
    const l = new FoldInLedger();
    l.add('加一个爱奇艺', IMG, '加一个爱奇艺', false, false);
    l.beginDelivery(env({ activityCount: 3 }));
    expect(l.settle(3)).toHaveLength(1); // 水位无新增 ⇒ 没照办 → 残差
    const l2 = new FoldInLedger();
    l2.add('加一个爱奇艺', IMG, '加一个爱奇艺', false, false);
    l2.beginDelivery(env({ activityCount: 3 }));
    expect(l2.settle(4)).toEqual([]); // 投递后发起新委派 ⇒ 照办
  });

  it('returns an undelivered fold as residual when the turn ended early', () => {
    const l = new FoldInLedger();
    l.add('加一个爱奇艺', IMG, '加一个爱奇艺', false, false);
    expect(l.settle(9)).toHaveLength(1); // 根本没投递 ⇒ 残差
  });

  it('never re-queues a cancellation as work (2026-09-24 取消案例) and settles exactly once', () => {
    const l = new FoldInLedger();
    l.add('jev 这个就不调研了', IMG, 'jev 这个就不调研了', false, true);
    // 取消型即使没投递、水位无变化，也不进残差——转排队会把「取消」当活重跑。
    expect(l.settle(0)).toEqual([]);
    // 核验即清账：第二次 settle 无账可核。
    expect(l.entries()).toHaveLength(0);
  });

  it('mixes cancels and additions: only un-honored additions come back', () => {
    const l = new FoldInLedger();
    l.add('砍掉 jev', IMG, '砍掉 jev', false, true);
    l.add('补一个知乎', IMG, '补一个知乎', false, false);
    l.beginDelivery(env({ activityCount: 1 }));
    const residuals = l.settle(1);
    expect(residuals).toHaveLength(1);
    expect(residuals[0].text).toBe('补一个知乎');
    expect(residuals[0].cancels).toBe(false);
  });
});

describe('FoldInLedger lifecycle', () => {
  it('reset clears the ledger (new chat leaves nothing behind)', () => {
    const l = new FoldInLedger();
    l.add('加一个', IMG, '加一个', false, false);
    l.reset();
    expect(l.entries()).toHaveLength(0);
    expect(l.beginDelivery(env())).toEqual([]);
  });
});
