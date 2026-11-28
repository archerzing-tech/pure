// src/ui/threadTime.ts
// M1 计量刀（engine-worker-migration-plan §9 停止条件 2 的取证面，2026-11-28）。
//
// 停止条件的原文是「M1（JS 自算）在真实卡死里占比很低 → P2 降级为可选」。
// 在此之前这条没有任何数字：Rust 侧有 `main_thread_stall`（主线程队列延迟）
// 与 `delta_stats`（Channel::send 自身成本），JS 侧只有 `frame_stall`（呈现
// 停帧）——三张表都不回答「主线程被谁占着」。
//
// 这里的口径只有一句话：**主线程忙时按已知锚点扣减，剩下的算 M1 上界**。
//   · 忙时（分母）用定时器滞后采样：`setTimeout(100)` 链每拍记「实际间隔 − 该窗口
//     惯常间隔」，超出的部分约等于这一拍内主线程被同步占住的时间。基准自校准是
//     必需的：后台/最小化窗口的 timer 会被系统节流（实测 209ms/拍、最小化时几乎
//     不跳），拿绝对值会把节流全算成忙时。采样不依赖 longtask（WKWebView 没有
//     Long Tasks API），也不用 `document.hasFocus()`（WKWebView 里拿不到真值）。
//   · 被扣减的锚点选同步、能夹住的两段：markdown 流式渲染（render）、快照构建
//     （persist）。都是「起止都在一个同步段里」的。流式分片解析没做桶——它
//     在 adapter 层，CLI 也在用，往那边塞 UI 探针会把两层绑死；那点成本本来
//     也可忽略，留在残余里。
//   · 引擎自算与未埋点的 UI 应用都落在残余里——所以残余是**上界**，不是
//     精确归属。配合 Rust 的 delta_stats 交叉判读：send 变慢 = M2，send 正常
//     而残余大 = M1 方向。
//
// 埋点纪律同 perfLog / frameWatchdog：失败静默、低频落盘（10s 一行）、
// 采样器自身不挂高频 timer（100ms 一拍、无分配）。

import { logPerfLine } from './perfLog';

export type ThreadBucket = 'render' | 'persist';

export const THREAD_BUCKETS: readonly ThreadBucket[] = ['render', 'persist'];
/** 采样周期：100ms 够分辨「几百 ms 的同步块」，又不至于自己成为负载。 */
export const THREAD_TICK_MS = 100;
/** 落盘窗口。 */
export const THREAD_WINDOW_MS = 10_000;
/** 滞后达到这个量级才单独落一条 breakdown（低于它的抖动没有归因价值）。 */
export const THREAD_STALL_MS = 250;
/** 区间环上限：10s 窗口内最多几百段，够覆盖两次窗口。 */
const MAX_INTERVALS = 4_096;

export interface ThreadInterval {
  bucket: ThreadBucket;
  start: number;
  end: number;
}

let intervals: ThreadInterval[] = [];

/** 记一段已知归属的同步区间。end ≤ start 丢弃（同毫秒的碎片没有信息）。 */
export function recordThreadInterval(bucket: ThreadBucket, start: number, end: number): void {
  if (!(end > start)) return;
  intervals.push({ bucket, start, end });
  if (intervals.length > MAX_INTERVALS) intervals.splice(0, intervals.length - MAX_INTERVALS);
}

/** 包住一个同步调用并自动记账（异常也记——失败帧同样占主线程）。 */
export function measureThreadTime<T>(bucket: ThreadBucket, fn: () => T): T {
  const start = Date.now();
  try {
    return fn();
  } finally {
    recordThreadInterval(bucket, start, Date.now());
  }
}

export interface ThreadBreakdown {
  /** 落在窗口内的区间总时长（同一桶互不重叠；跨桶可能重叠，理论上不该）。 */
  total: number;
  byBucket: Record<ThreadBucket, number>;
}

/** 区间与窗口 [from, to] 的交集求和（纯函数，测试缝）。 */
export function sumIntervals(
  list: readonly ThreadInterval[],
  from: number,
  to: number,
): ThreadBreakdown {
  const byBucket: Record<ThreadBucket, number> = { render: 0, persist: 0 };
  let total = 0;
  if (!(to > from)) return { total, byBucket };
  for (const item of list) {
    const start = Math.max(item.start, from);
    const end = Math.min(item.end, to);
    if (!(end > start)) continue;
    byBucket[item.bucket] += end - start;
    total += end - start;
  }
  return { total, byBucket };
}

/** 残余（M1 上界）：忙时扣掉可归因部分，不做负数。 */
export function residualOf(busyMs: number, attributableMs: number): number {
  return Math.max(0, Math.round(busyMs - attributableMs));
}

/** 只用来清场：测试与「会话切换后重新计数」都走它。 */
export function resetThreadIntervals(): void {
  intervals = [];
}

/** 当前环里存了多少段（内存上限的测试缝）。 */
export function threadIntervalCount(): number {
  return intervals.length;
}

function prune(before: number): void {
  if (intervals.length === 0) return;
  if (intervals[0].start >= before) return;
  intervals = intervals.filter(item => item.end >= before);
}

/**
 * 启动采样器。返回停止函数（测试与热重启用）。
 *
 * 一次滞后采样做两件事：累计窗口忙时；滞后够大时把 [预期, 现在] 这段当成
 * 一次停顿，落一条带分桶的 breakdown——「卡的时候在干什么」比「总共忙多久」
 * 更接近停止条件要的答案。
 */
export function startThreadTimeProbe(): () => void {
  if (typeof window === 'undefined') return () => {};

  let stopped = false;
  let timer: number | undefined;
  let lastTick = Date.now();
  // 自校准基准：后台窗口的 timer 会被系统节流（实测 setTimeout(100) 跑到
  // 209ms/拍、beats 49/10s），按时长直接算「迟到」会把节流当成主线程被占。
  // 所以以「本窗口惯常间隔」为基准，只把**超出基准**的部分算忙时——节流是
  // 均匀的，基准会跟上去，忙时归零；真正的同步块是突刺，立刻计满。
  // （没用 document.hasFocus()：WKWebView 里它拿不到可靠真值。）
  let baseline = THREAD_TICK_MS;
  let windowStart = Date.now();
  let busyMs = 0;
  let maxLagMs = 0;
  let beats = 0;

  const tick = (): void => {
    if (stopped) return;
    const now = Date.now();
    const delay = now - lastTick;
    lastTick = now;
    const lag = Math.max(0, delay - Math.max(THREAD_TICK_MS, baseline));
    // 基准只跟随「正常拍」：拿迟到值直接训练会被停顿自己抬高（下一次就少计）。
    baseline += (Math.min(delay, THREAD_TICK_MS * 2) - baseline) * 0.1;
    busyMs += lag;
    beats += 1;
    if (lag > maxLagMs) maxLagMs = lag;

    if (lag >= THREAD_STALL_MS) {
      const breakdown = sumIntervals(intervals, now - lag, now);
      void logPerfLine({
        kind: 'thread_stall',
        lagMs: Math.round(lag),
        renderMs: breakdown.byBucket.render,
        persistMs: breakdown.byBucket.persist,
        residualMs: residualOf(lag, breakdown.total),
      });
    }

    if (now - windowStart >= THREAD_WINDOW_MS) {
      const breakdown = sumIntervals(intervals, windowStart, now);
      // 理论上 beats 不会为 0（计时器一启动就在计数），留着兜底。
      if (beats > 0) void logPerfLine({
        kind: 'thread_time',
        windowMs: now - windowStart,
        tickMs: Math.round(baseline),
        beats,
        busyMs: Math.round(busyMs),
        maxLagMs: Math.round(maxLagMs),
        renderMs: breakdown.byBucket.render,
        persistMs: breakdown.byBucket.persist,
        // 上界口径：残余里既有引擎自算，也有未埋点的 UI 应用与 GC。
        residualMs: residualOf(busyMs, breakdown.total),
      });
      prune(now - THREAD_WINDOW_MS * 2);
      windowStart = now;
      busyMs = 0;
      maxLagMs = 0;
      beats = 0;
    }

    timer = window.setTimeout(tick, THREAD_TICK_MS);
  };

  timer = window.setTimeout(tick, THREAD_TICK_MS);
  return () => {
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
}
