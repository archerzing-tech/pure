// src/coding-agent/__tests__/holdGate.test.ts
// 软暂停闸（v2 §四）的行为契约：到达即扣、处置完放行、死线兜底绝不锁死、
// 连续插话不续命、等待面响应 abort。宿主负责扣——这里只锁闸本体。

import { describe, expect, it } from 'bun:test';
import { HoldGate } from '../holdGate';

describe('HoldGate', () => {
  it('starts open; close holds, open releases with the outcome', () => {
    const gate = new HoldGate();
    expect(gate.isOpen()).toBe(false);
    gate.close('用户插话');
    expect(gate.isOpen()).toBe(true);
    expect(gate.heldReason()).toBe('用户插话');
    gate.open('released');
    expect(gate.isOpen()).toBe(false);
    expect(gate.lastOutcome()).toBe('released');
  });

  it('close is idempotent and does NOT reset the deadline — consecutive inserts must not extend the hold', async () => {
    // N 句连发不许 N 倍扣压：死线从第一句到达起算，第二条 close 是 no-op。
    let deadlines = 0;
    const gate = new HoldGate({ deadlineMs: 20, onDeadline: () => { deadlines += 1; } });
    gate.close('第一句');
    await Bun.sleep(10);
    gate.close('第二句'); // 不重置死线
    await Bun.sleep(30);
    expect(gate.isOpen()).toBe(false);
    expect(gate.lastOutcome()).toBe('timeout');
    expect(deadlines).toBe(1);
  });

  it('force-open releases waiters before calling onDeadline, and open afterwards is a no-op', async () => {
    const seen: string[] = [];
    const gate = new HoldGate({ deadlineMs: 15, onDeadline: () => { seen.push(`deadline:${gate.lastOutcome()}`); } });
    gate.close('reason');
    const released = gate.waitUntilOpen();
    let releasedSync = false;
    void released.then(() => { releasedSync = true; });
    await Bun.sleep(40);
    expect(gate.isOpen()).toBe(false);
    expect(releasedSync).toBe(true);
    // 死线到点后的显式 open 是 no-op，不许覆盖 timeout 结论（如实收执）。
    gate.open('released');
    expect(gate.lastOutcome()).toBe('timeout');
    expect(seen).toEqual(['deadline:timeout']);
  });

  it('waitUntilOpen resolves on abort signal without waiting for the deadline', async () => {
    const gate = new HoldGate({ deadlineMs: 60_000 });
    gate.close('judging');
    const controller = new AbortController();
    const pending = gate.waitUntilOpen(controller.signal);
    controller.abort();
    await pending; // 不抛不挂——abort 放行，执行层自会掐调用
    // 闸本体仍关着（abort 放行的是等待者，不是处置结论）。
    expect(gate.isOpen()).toBe(true);
    gate.open('redirected');
    expect(gate.lastOutcome()).toBe('redirected');
  });

  it('waitUntilOpen returns immediately when the gate is open', async () => {
    const gate = new HoldGate();
    await gate.waitUntilOpen(); // 未关闸 = 直通
    gate.close('x');
    gate.open('paused');
    await gate.waitUntilOpen();
    expect(gate.lastOutcome()).toBe('paused');
  });

  it('reset clears state, deadline and waiters — session teardown must not leave traps', async () => {
    const gate = new HoldGate({ deadlineMs: 5, onDeadline: () => { throw new Error('deadline after reset'); } });
    gate.close('stale');
    const pending = gate.waitUntilOpen();
    gate.reset();
    await pending; // 等待者被释放而非悬挂
    expect(gate.isOpen()).toBe(false);
    expect(gate.heldReason()).toBe('');
    await Bun.sleep(15); // 死线已清——不许再触发 onDeadline
    expect(gate.isOpen()).toBe(false);
  });
});
