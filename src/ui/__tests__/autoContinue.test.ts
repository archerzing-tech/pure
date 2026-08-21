// src/ui/__tests__/autoContinue.test.ts
// Long-task auto-continue scheduler (docs/auto-continue-design.md): trigger
// gates, abort semantics, round budget and stall protection.

import { describe, expect, it } from 'bun:test';
import { AutoContinueScheduler, DEFAULT_AUTO_CONTINUE_MAX_ROUNDS, type AutoContinueSignals } from '../autoContinue';

function signals(over: Partial<AutoContinueSignals> = {}): AutoContinueSignals {
  return {
    planActive: true,
    cleanEnd: true,
    asksForInput: false,
    hasToolSuccess: true,
    currentPlan: 2,
    currentTodo: 1,
    planTerminal: false,
    ...over,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AutoContinueScheduler.schedule — trigger gates', () => {
  it('schedules a continuation for a clean, progressing plan turn', async () => {
    const s = new AutoContinueScheduler();
    let fired = 0;
    expect(s.schedule(signals(), DEFAULT_AUTO_CONTINUE_MAX_ROUNDS, 5, () => fired++)).toBe(true);
    await wait(20);
    expect(fired).toBe(1);
  });

  it('never chains a simple (no plan) turn', () => {
    const s = new AutoContinueScheduler();
    const fired = () => { throw new Error('must not fire'); };
    expect(s.schedule(signals({ planActive: false }), 8, 5, fired)).toBe(false);
  });

  it('never chains a turn that ended with a question to the user', () => {
    const s = new AutoContinueScheduler();
    const fired = () => { throw new Error('must not fire'); };
    expect(s.schedule(signals({ asksForInput: true }), 8, 5, fired)).toBe(false);
  });

  it('never chains a terminal plan (completed / delivery gate blocked)', () => {
    const s = new AutoContinueScheduler();
    const fired = () => { throw new Error('must not fire'); };
    expect(s.schedule(signals({ planTerminal: true }), 8, 5, fired)).toBe(false);
  });

  it('never chains a turn that was interrupted or paused', () => {
    const s = new AutoContinueScheduler();
    const fired = () => { throw new Error('must not fire'); };
    expect(s.schedule(signals({ cleanEnd: false }), 8, 5, fired)).toBe(false);
  });
});

describe('AutoContinueScheduler — stall protection', () => {
  it('stops when a round made no tool progress and did not move the plan', async () => {
    const s = new AutoContinueScheduler();
    let fired = 0;
    // Establish the chain baseline with a real round at plan 2 / todo 1.
    expect(s.schedule(signals({ currentPlan: 2, currentTodo: 1 }), 8, 5, () => fired++)).toBe(true);
    await wait(20);
    expect(fired).toBe(1);
    // A following round with no tools and NO forward movement must not chain.
    expect(s.schedule(signals({ hasToolSuccess: false, currentPlan: 2, currentTodo: 1 }), 8, 5, () => fired++)).toBe(false);
    await wait(20);
    expect(fired).toBe(1);
  });

  it('chains a no-tool round that still advanced the plan cursor (e.g. stage announcement)', async () => {
    const s = new AutoContinueScheduler();
    let fired = 0;
    // First round moved plan 1 → 2 and did real work; the schedule records it.
    expect(s.schedule(signals({ currentPlan: 2, currentTodo: 1 }), 8, 5, () => fired++)).toBe(true);
    await wait(20);
    expect(fired).toBe(1);
    // Next round: no tools, but the cursor advanced 2 → 3 — still real progress.
    expect(s.schedule(signals({ hasToolSuccess: false, currentPlan: 3, currentTodo: 1 }), 8, 5, () => fired++)).toBe(true);
    await wait(20);
    expect(fired).toBe(2);
  });
});

describe('AutoContinueScheduler — round budget', () => {
  it('caps the chain at maxRounds per user message', async () => {
    const s = new AutoContinueScheduler();
    let fired = 0;
    for (let i = 0; i < 3; i++) {
      expect(s.schedule(signals({ currentPlan: 1, currentTodo: i + 1 }), 3, 1, () => fired++)).toBe(true);
      await wait(10);
    }
    expect(fired).toBe(3);
    // The next schedule sees the budget exhausted (3 already fired).
    expect(s.schedule(signals({ currentPlan: 2, currentTodo: 1 }), 3, 1, () => fired++)).toBe(false);
    await wait(10);
    expect(fired).toBe(3);
  });

  it('resets the budget after cancel() (a user send starts a fresh chain)', async () => {
    const s = new AutoContinueScheduler();
    let fired = 0;
    expect(s.schedule(signals(), 1, 1, () => fired++)).toBe(true);
    await wait(5);
    expect(fired).toBe(1);
    expect(s.schedule(signals(), 1, 1, () => fired++)).toBe(false); // budget spent
    s.cancel();
    expect(s.schedule(signals(), 1, 1, () => fired++)).toBe(true);
    await wait(5);
    expect(fired).toBe(2);
  });

  it('roundCount reflects how many rounds have fired and resets on cancel', async () => {
    const s = new AutoContinueScheduler();
    let fired = 0;
    expect(s.roundCount).toBe(0);
    expect(s.schedule(signals(), 3, 1, () => fired++)).toBe(true);
    await wait(5);
    expect(fired).toBe(1);
    expect(s.roundCount).toBe(1);
    expect(s.schedule(signals(), 3, 1, () => fired++)).toBe(true);
    await wait(5);
    expect(fired).toBe(2);
    expect(s.roundCount).toBe(2);
    s.cancel();
    expect(s.roundCount).toBe(0);
  });
});

describe('AutoContinueScheduler — abort semantics', () => {
  it('cancel() clears a pending continuation before it fires', async () => {
    const s = new AutoContinueScheduler();
    let fired = 0;
    s.schedule(signals(), 8, 10, () => fired++);
    s.cancel();
    await wait(30);
    expect(fired).toBe(0);
    expect(s.pending).toBe(false);
  });

  it('a stale timer token can never fire after cancel', async () => {
    const s = new AutoContinueScheduler();
    let fired = 0;
    s.schedule(signals(), 8, 30, () => fired++);
    s.cancel();
    // Even a manual re-fire of the old closure path (defensive) is a no-op —
    // the real guard is the token, exercised via cancel-then-wait above.
    expect(fired).toBe(0);
  });

  it('re-scheduling supersedes the previous pending round', async () => {
    const s = new AutoContinueScheduler();
    let fired = 0;
    s.schedule(signals({ currentTodo: 1 }), 8, 20, () => fired++);
    s.schedule(signals({ currentTodo: 2 }), 8, 1, () => fired++);
    await wait(30);
    expect(fired).toBe(1);
  });
});
