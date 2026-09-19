// src/shared/__tests__/asyncQueue.test.ts
// AsyncQueue/EventFanout — the bridge that lets the engine await tool results
// and subagent interior activity on the same generator. These tests pin the
// delivery contract the engine's runBatch relies on: nothing lost, nothing
// resurrected after close, readers pruned as they stop listening.

import { describe, expect, it } from 'bun:test';
import { AsyncQueue, EventFanout } from '../asyncQueue';

describe('AsyncQueue', () => {
  it('hands a push to a pending waiter immediately', async () => {
    const q = new AsyncQueue<number>();
    const pending = q.next();
    q.push(1);
    expect(await pending).toEqual({ value: 1, done: false });
  });

  it('buffers pushes that arrive before the consumer awaits', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    expect(await q.next()).toEqual({ value: 1, done: false });
    expect(await q.next()).toEqual({ value: 2, done: false });
  });

  it('drainAvailable() splices the buffer without touching waiters', () => {
    const q = new AsyncQueue<string>();
    q.push('a');
    q.push('b');
    expect(q.drainAvailable()).toEqual(['a', 'b']);
    expect(q.drainAvailable()).toEqual([]);
    // A push after a drain stays available for the next next()/drain.
    q.push('c');
    expect(q.drainAvailable()).toEqual(['c']);
  });

  it('close() resolves a dangling next() with done and drops later pushes', async () => {
    const q = new AsyncQueue<number>();
    const pending = q.next();
    q.close();
    expect((await pending).done).toBe(true);
    q.push(1); // late publisher must never resurrect the queue
    expect(q.drainAvailable()).toEqual([]);
    expect((await q.next()).done).toBe(true);
  });

  it('still delivers buffered items after close() (drain path)', async () => {
    const q = new AsyncQueue<number>();
    q.push(7);
    q.close();
    // Items pushed before close are buffered and remain readable...
    expect(await q.next()).toEqual({ value: 7, done: false });
    // ...only the tail is done.
    expect((await q.next()).done).toBe(true);
  });

  it('fail() rejects a dangling next()', async () => {
    const q = new AsyncQueue<number>();
    const pending = q.next();
    q.fail(new Error('boom'));
    await expect(pending).rejects.toThrow('boom');
  });
});

describe('EventFanout', () => {
  it('fans one publish out to every live reader', async () => {
    const fanout = new EventFanout<string>();
    const r1 = fanout.subscribe();
    const r2 = fanout.subscribe();
    fanout.publish('x');
    expect(await r1.next()).toEqual({ value: 'x', done: false });
    expect(await r2.next()).toEqual({ value: 'x', done: false });
  });

  it('keeps per-reader order and does not consume another reader\'s item', async () => {
    const fanout = new EventFanout<number>();
    const a = fanout.subscribe();
    const b = fanout.subscribe();
    fanout.publish(1);
    fanout.publish(2);
    // b reads first — a must still see both events, in order.
    expect((await b.next()).value).toBe(1);
    expect((await b.next()).value).toBe(2);
    expect((await a.next()).value).toBe(1);
    expect((await a.next()).value).toBe(2);
  });

  it('prunes closed readers on publish and stops tracking them', async () => {
    const fanout = new EventFanout<string>();
    const r1 = fanout.subscribe();
    const r2 = fanout.subscribe();
    r1.close();
    fanout.publish('x'); // prunes r1, delivers to r2
    expect(fanout.readerCount()).toBe(1);
    expect((await r2.next()).value).toBe('x');
  });
});
