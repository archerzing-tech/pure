// src/ui/scheduler.ts
// 定时任务（前端调度）: schedules from config fire at a daily HH:MM or every
// N minutes and enqueue their text into the TaskQueue. Frontend-only — nothing
// survives the app being closed; while running, a due task that the user is
// mid-turn over is skipped for that cycle (never hijacks the chat).
//
// Design:
//   • nextFireMs / nextFireTime are pure time math (unit-testable).
//   • The Scheduler keeps an absolute next-fire timestamp per schedule id, so
//     multiple schedules coexist and interval cadence survives another
//     schedule's fire. On a tick every reached entry fires ONCE then advances
//     (no double-fire, no catch-up storm after sleep/wake).
//   • Recursive setTimeout chain, same shape as memoryDecayTimer.ts: re-reads
//     config each cycle and re-arms for the soonest due schedule; config edits
//     (settings save) call reschedule() to re-arm immediately.

import { loadConfig, type ScheduleDef } from './config';
import type { TaskQueue } from './taskQueue';

export const MS_MIN = 60_000;

/** Parse "HH:MM" (24h) → {h, m}, or null when malformed/out of range. */
export function parseHhMm(time: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/**
 * Absolute ms of the next occurrence of a daily schedule's HH:MM strictly
 * after `after`. Infinity when the time is malformed.
 */
export function nextFireTime(schedule: ScheduleDef, after: number): number {
  const parsed = parseHhMm(schedule.time ?? '');
  if (!parsed) return Infinity;
  const d = new Date(after);
  d.setHours(parsed.h, parsed.m, 0, 0);
  let t = d.getTime();
  if (t <= after) t += 24 * 3600_000;
  return t;
}

/** Delay (ms) until `schedule` next fires relative to `now`. */
export function nextFireMs(schedule: ScheduleDef, now = Date.now()): number {
  if (schedule.kind === 'interval') {
    const minutes = Math.max(1, Math.floor(schedule.minutes ?? 0));
    return minutes * MS_MIN;
  }
  const t = nextFireTime(schedule, now);
  return t === Infinity ? Infinity : t - now;
}

interface NextEntry {
  /** Absolute ms the schedule is due next. */
  at: number;
  /** Snapshot of the trigger fields — a config edit invalidates the entry. */
  fp: string;
}

function fingerprint(s: ScheduleDef): string {
  return `${s.kind}|${s.time ?? ''}|${s.minutes ?? ''}`;
}

export interface SchedulerOptions {
  queue: TaskQueue;
  /** Where schedules come from; defaults to the persisted config. */
  getSchedules?: () => ScheduleDef[];
  /** True while a chat turn is active — a due schedule then skips its cycle. */
  isBusy?: () => boolean;
  /** Test seam: current time in ms (default Date.now()). */
  now?: () => number;
  /** Test seam: schedule a callback (default setTimeout). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Test seam: cancel a scheduled callback (default clearTimeout). */
  clearTimer?: (handle: unknown) => void;
}

export class Scheduler {
  private readonly queue: TaskQueue;
  private readonly getSchedules: () => ScheduleDef[];
  private readonly isBusy: () => boolean;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private next = new Map<string, NextEntry>();
  private timer: unknown = undefined;
  private started = false;

  constructor(opts: SchedulerOptions) {
    this.queue = opts.queue;
    this.getSchedules = opts.getSchedules ?? (() => loadConfig()?.schedules ?? []);
    this.isBusy = opts.isBusy ?? (() => false);
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Start the recursive timer chain (idempotent). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.resync();
    this.arm();
  }

  /** Stop the timer and forget per-schedule state (cleanup / tests). */
  stop(): void {
    this.started = false;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.next.clear();
  }

  /** Re-arm now — call after any config save that may change schedules. */
  reschedule(): void {
    if (!this.started) return;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.resync();
    this.arm();
  }

  /** Reconcile per-schedule next-fire entries with the current schedule list. */
  private resync(): void {
    const now = this.now();
    const live = new Set<string>();
    for (const s of this.getSchedules()) {
      if (!s.enabled) continue;
      live.add(s.id);
      const entry = this.next.get(s.id);
      const fp = fingerprint(s);
      if (entry && entry.fp === fp) continue; // unchanged → keep cadence
      this.next.delete(s.id);
      const delay = nextFireMs(s, now);
      if (delay !== Infinity) this.next.set(s.id, { at: now + delay, fp });
    }
    for (const id of [...this.next.keys()]) {
      if (!live.has(id)) this.next.delete(id);
    }
  }

  private arm(): void {
    if (!this.started) return;
    let soonest = Infinity;
    for (const entry of this.next.values()) soonest = Math.min(soonest, entry.at);
    const delay = Math.max(0, soonest - this.now());
    this.timer = this.setTimer(() => this.fire(), delay);
  }

  private fire(): void {
    if (!this.started) return;
    const now = this.now();
    const busy = this.isBusy() || !this.queue.isIdle();
    for (const s of this.getSchedules()) {
      if (!s.enabled) continue;
      const entry = this.next.get(s.id);
      if (!entry || entry.at > now) continue;
      // Always advance first: firing is idempotent and skipped cycles never
      // retry (a daily task due while the app sleeps fires once on wake).
      this.next.set(
        s.id,
        s.kind === 'interval'
          ? { at: now + Math.max(1, Math.floor(s.minutes ?? 0)) * MS_MIN, fp: entry.fp }
          : { at: nextFireTime(s, now), fp: entry.fp },
      );
      if (!busy) this.queue.enqueue([s.text]);
    }
    this.resync();
    this.arm();
  }
}
