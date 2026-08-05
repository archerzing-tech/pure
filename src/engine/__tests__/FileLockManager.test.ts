// src/engine/__tests__/FileLockManager.test.ts

import { describe, it, expect } from 'bun:test';
import { FileLockManager } from '../FileLockManager';

const flush = () => new Promise(r => setImmediate(r));

describe('FileLockManager', () => {
  it('allows a single writer exclusively', async () => {
    const lm = new FileLockManager();
    await lm.acquireWrite('a.txt');
    let second = false;
    const p = lm.acquireWrite('a.txt').then(() => { second = true; });
    await flush();
    expect(second).toBe(false);
    lm.release('a.txt');
    await p;
    expect(second).toBe(true);
  });

  it('grants concurrent readers together', async () => {
    const lm = new FileLockManager();
    const reads: string[] = [];
    const p1 = lm.acquireRead('f').then(() => { reads.push('r1'); });
    const p2 = lm.acquireRead('f').then(() => { reads.push('r2'); });
    await flush();
    // Both reads granted immediately (no writer waiting).
    expect(reads.sort()).toEqual(['r1', 'r2']);
    await Promise.all([p1, p2]);
  });

  it('blocks a reader while a writer holds the lock', async () => {
    const lm = new FileLockManager();
    await lm.acquireWrite('f');
    let r = false;
    const p = lm.acquireRead('f').then(() => { r = true; });
    await flush();
    expect(r).toBe(false);
    lm.release('f');
    await p;
    expect(r).toBe(true);
  });

  it('reader behind a queued writer does not starve the writer', async () => {
    // Writer-preference: once a writer queues, later readers queue behind it.
    const lm = new FileLockManager();
    await lm.acquireRead('f');
    let writerDone = false;
    const wp = lm.acquireWrite('f').then(() => { writerDone = true; });
    await flush();
    // A reader arriving after the writer queued must NOT jump the queue.
    let readerDone = false;
    const rp = lm.acquireRead('f').then(() => { readerDone = true; });
    await flush();
    expect(writerDone).toBe(false);
    expect(readerDone).toBe(false);
    // Releasing the initial reader wakes the writer (FIFO head).
    lm.release('f');
    await wp;
    expect(writerDone).toBe(true);
    expect(readerDone).toBe(false);
    // Writer releases → queued reader granted.
    lm.release('f');
    await rp;
    expect(readerDone).toBe(true);
  });

  it('sustained reader traffic cannot starve a waiting writer', async () => {
    const lm = new FileLockManager();
    // Writer waits behind an existing reader.
    await lm.acquireRead('f');
    let writerDone = false;
    const wp = lm.acquireWrite('f').then(() => { writerDone = true; });
    await flush();
    // Storm of late readers: none may acquire while the writer is queued.
    const lateReaders: boolean[] = [];
    const latePs = Array.from({ length: 10 }, () =>
      lm.acquireRead('f').then(() => { lateReaders.push(true); }));
    await flush();
    expect(lateReaders.length).toBe(0);
    // Initial reader releases → writer granted, late readers still queued.
    lm.release('f');
    await wp;
    expect(writerDone).toBe(true);
    expect(lateReaders.length).toBe(0);
    // Writer releases → ALL queued readers granted in one batch.
    lm.release('f');
    await Promise.all(latePs);
    expect(lateReaders.length).toBe(10);
  });

  it('wakes the full consecutive reader batch on writer release (FIFO)', async () => {
    const lm = new FileLockManager();
    await lm.acquireWrite('f');
    const order: string[] = [];
    // Queue: writer1, reader1, reader2, writer2, reader3
    const w1 = lm.acquireWrite('f').then(() => order.push('w1'));
    const r1 = lm.acquireRead('f').then(() => order.push('r1'));
    const r2 = lm.acquireRead('f').then(() => order.push('r2'));
    const w2 = lm.acquireWrite('f').then(() => order.push('w2'));
    const r3 = lm.acquireRead('f').then(() => order.push('r3'));
    await flush();
    expect(order).toEqual([]);
    // Free: w1 granted alone.
    lm.release('f');
    await w1;
    expect(order).toEqual(['w1']);
    // Free: r1+r2 granted together as a batch (count becomes 2).
    lm.release('f');
    await Promise.all([r1, r2]);
    expect(order).toEqual(['w1', 'r1', 'r2']);
    // Both readers must release before the queued writer can proceed.
    lm.release('f');
    lm.release('f');
    await w2;
    expect(order).toEqual(['w1', 'r1', 'r2', 'w2']);
    // Free: r3 granted.
    lm.release('f');
    await r3;
    expect(order).toEqual(['w1', 'r1', 'r2', 'w2', 'r3']);
  });

  it('release on an unheld path is a no-op', () => {
    const lm = new FileLockManager();
    expect(() => lm.release('never-held')).not.toThrow();
  });
});
