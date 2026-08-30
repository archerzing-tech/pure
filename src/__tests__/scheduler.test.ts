// src/__tests__/scheduler.test.ts
// Scheduler time math (parseHhMm / nextFireTime / nextFireMs) plus the fire
// state machine, driven deterministically via injected now()/setTimer()/clearTimer()
// seams and a real TaskQueue backed by a fake chat + fake storage.

import { beforeEach, describe, expect, it } from 'bun:test';
import { TaskQueue } from '../ui/taskQueue';
import {
  nextFireMs,
  nextFireTime,
  parseHhMm,
  Scheduler,
  type SchedulerOptions,
} from '../ui/scheduler';
import type { ScheduleDef } from '../ui/config';

const MS_MIN = 60_000;

/** Parked send resolves on demand (or immediately when autoResolve). */
class FakeChat {
  calls: string[] = [];
  private readonly autoResolve: boolean;
  private deferred: Array<{ resolve: () => void }> = [];

  constructor(autoResolve = false) {
    this.autoResolve = autoResolve;
  }

  send(text: string): Promise<void> {
    this.calls.push(text);
    return new Promise((resolve) => {
      if (this.autoResolve) {
        queueMicrotask(resolve);
        return;
      }
      this.deferred.push({ resolve });
    });
  }
}

function installFakeStorage(): void {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
  Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true, configurable: true });
}

function sched(partial: Partial<ScheduleDef> & { text: string }): ScheduleDef {
  return { id: 's1', kind: 'interval', minutes: 10, enabled: true, time: undefined, ...partial };
}

/** Deterministic fake timer + clock for a Scheduler. */
function makeRig(schedules: ScheduleDef[], extra?: Partial<SchedulerOptions>) {
  const clock = { now: 1_000_000 };
  const timer = { fn: undefined as (() => void) | undefined, ms: 0, cleared: 0 };
  const queue = new TaskQueue({ chat: new FakeChat(true), storageKey: 'k' });
  const scheduler = new Scheduler({
    queue,
    getSchedules: () => schedules,
    now: () => clock.now,
    setTimer: (fn, ms) => {
      timer.fn = fn;
      timer.ms = ms;
      return { token: 1 };
    },
    clearTimer: () => {
      timer.cleared++;
      timer.fn = undefined;
    },
    ...extra,
  });
  const fireNow = (): void => {
    const fn = timer.fn;
    timer.fn = undefined;
    fn?.();
  };
  return { clock, timer, queue, scheduler, fireNow };
}

/** Let an auto-resolving queue drain (microtask + timer tick). */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  installFakeStorage();
});

describe('parseHhMm', () => {
  it('parses valid HH:MM and H:MM', () => {
    expect(parseHhMm('09:30')).toEqual({ h: 9, m: 30 });
    expect(parseHhMm('9:05')).toEqual({ h: 9, m: 5 });
    expect(parseHhMm('23:59')).toEqual({ h: 23, m: 59 });
  });

  it('rejects out-of-range or malformed input', () => {
    expect(parseHhMm('24:00')).toBeNull();
    expect(parseHhMm('09:60')).toBeNull();
    expect(parseHhMm('abc')).toBeNull();
    expect(parseHhMm('9:5')).toBeNull();
  });
});

describe('nextFireTime / nextFireMs', () => {
  // Aug 30 2026 10:00:00.000 local.
  const at10 = new Date(2026, 7, 30, 10, 0, 0, 0).getTime();

  it('interval returns N minutes regardless of wall clock', () => {
    expect(nextFireMs(sched({ text: 'x', kind: 'interval', minutes: 15 }), at10)).toBe(15 * MS_MIN);
    expect(nextFireMs(sched({ text: 'x', kind: 'interval', minutes: 0 }), at10)).toBe(1 * MS_MIN);
  });

  it('daily HH:MM later today fires today; earlier fires tomorrow', () => {
    // 11:00 is 1h after now; 09:00 is 23h after now (tomorrow).
    expect(nextFireMs(sched({ text: 'x', kind: 'daily', time: '11:00' }), at10)).toBe(1 * 3600_000);
    expect(nextFireMs(sched({ text: 'x', kind: 'daily', time: '09:00' }), at10)).toBe(23 * 3600_000);
  });

  it('daily exactly on the hour rolls to tomorrow', () => {
    expect(nextFireTime(sched({ text: 'x', kind: 'daily', time: '10:00' }), at10)).toBe(at10 + 24 * 3600_000);
    expect(nextFireMs(sched({ text: 'x', kind: 'daily', time: '10:00' }), at10)).toBe(24 * 3600_000);
  });

  it('malformed daily time yields Infinity', () => {
    expect(nextFireMs(sched({ text: 'x', kind: 'daily', time: 'oops' }), at10)).toBe(Infinity);
  });
});

describe('Scheduler fire loop', () => {
  it('fires an interval schedule when due and re-arms for the next', async () => {
    const schedules = [sched({ id: 'a', text: 'check status', kind: 'interval', minutes: 1 })];
    const rig = makeRig(schedules);

    rig.scheduler.start();
    expect(rig.timer.ms).toBe(MS_MIN); // armed for the first fire

    rig.clock.now += MS_MIN;
    rig.fireNow();
    await flush();
    expect(rig.queue.getTasks().map((x) => x.text)).toEqual(['check status']);
    expect(rig.timer.ms).toBe(MS_MIN); // re-armed N minutes after the fire

    rig.clock.now += MS_MIN;
    rig.fireNow();
    await flush();
    expect(rig.queue.getTasks().filter((x) => x.text === 'check status')).toHaveLength(2);
  });

  it('skips firing while a chat turn is active, then fires once the queue is free', async () => {
    let busy = true;
    const schedules = [sched({ id: 'a', text: 'nightly', kind: 'daily', time: '10:00' })];
    const rig = makeRig(schedules, { isBusy: () => busy });

    // Seed at 09:59 so the schedule is armed for 10:00 today.
    const at0959 = new Date(2026, 7, 30, 9, 59, 0, 0).getTime();
    rig.clock.now = at0959;
    rig.scheduler.start();
    expect(rig.timer.ms).toBe(MS_MIN); // armed for 10:00

    // Tick lands exactly at 10:00 while a chat turn is active.
    const at10 = new Date(2026, 7, 30, 10, 0, 0, 0).getTime();
    rig.clock.now = at10;
    rig.fireNow();
    await flush();
    expect(rig.queue.getTasks()).toHaveLength(0); // busy → skipped

    // The entry advanced to tomorrow; when idle, tomorrow's fire works.
    busy = false;
    rig.clock.now = at10 + 24 * 3600_000;
    rig.fireNow();
    await flush();
    expect(rig.queue.getTasks().map((x) => x.text)).toEqual(['nightly']);
  });

  it('fires a daily schedule once on a late tick, then advances a full day', () => {
    const schedules = [sched({ id: 'a', text: 'daily task', kind: 'daily', time: '09:00' })];
    const rig = makeRig(schedules);

    const at08 = new Date(2026, 7, 30, 8, 0, 0, 0).getTime();
    rig.clock.now = at08;
    rig.scheduler.start();
    expect(rig.timer.ms).toBe(3600_000); // armed for 09:00

    // Wake late: the machine was asleep through 09:00, tick lands at 11:00.
    rig.clock.now = at08 + 3 * 3600_000;
    rig.fireNow();
    expect(rig.queue.getTasks().map((x) => x.text)).toEqual(['daily task']); // fired ONCE
    expect(rig.timer.ms).toBe(22 * 3600_000); // next fire = tomorrow 09:00
  });

  it('reschedule() re-arms when the schedule list changes', async () => {
    const schedules = [sched({ id: 'a', text: 'old', kind: 'interval', minutes: 5 })];
    const rig = makeRig(schedules);

    rig.scheduler.start();
    expect(rig.timer.ms).toBe(5 * MS_MIN);

    // User edits: 5-min → 30-min interval.
    schedules[0] = sched({ id: 'a', text: 'old', kind: 'interval', minutes: 30 });
    rig.scheduler.reschedule();
    expect(rig.timer.ms).toBe(30 * MS_MIN);

    // Cadence uses the new value when it fires.
    rig.clock.now += 30 * MS_MIN;
    rig.fireNow();
    await flush();
    expect(rig.queue.getTasks()).toHaveLength(1);
  });

  it('stop() cancels the pending timer', () => {
    const rig = makeRig([sched({ id: 'a', text: 'x', kind: 'interval', minutes: 5 })]);
    rig.scheduler.start();
    expect(rig.timer.fn).toBeDefined();
    rig.scheduler.stop();
    expect(rig.timer.fn).toBeUndefined();
    expect(rig.timer.cleared).toBeGreaterThan(0);
  });
});
