// src/ui/heartbeat.ts
// 共享心跳（2026-11-13 性能审计 P2-4）：toolRow 秒表 / thinkingCard 计时 /
// plan refining 徽标原本各自起独立 setInterval——N 个并发子 agent 就是 N 个
// interval 各自排队唤醒主线程。合并为单一底层 interval + 订阅表：每个订阅
// 带 nextDueAt 相位，pump 里到点才触发，节奏与独立 interval 逐字节等价；
// 最后一个订阅者离开即停表，空闲态零 interval。底层节拍取全体订阅的最小
// 周期（保证最快订阅者按时触发，慢订阅靠 nextDueAt 对齐），生产里三处都是
// 1s/3s，实际就是一个 1s 表。

type Subscription = {
  intervalMs: number;
  nextDueAt: number;
  callback: () => void;
};

const subscriptions = new Set<Subscription>();
let timer: ReturnType<typeof setInterval> | undefined;

function pump(): void {
  // 后台 webview 无渲染：秒表是 Date.now 绝对计算、hint 是轮换文案，跳过
  // 这几拍不丢任何状态（回到前台下一拍自动补上正确值）。
  if (typeof document !== 'undefined' && document.hidden) return;
  const now = Date.now();
  for (const sub of Array.from(subscriptions)) {
    if (now < sub.nextDueAt) continue;
    sub.nextDueAt = Math.max(sub.nextDueAt + sub.intervalMs, now + sub.intervalMs);
    // 回调自清理（isConnected / pending 检查）是三处旧 ticker 的既有契约：
    // 回调里调 cancel() 从 Set 删除是安全的——遍历的是 Array.from 快照。
    sub.callback();
  }
}

function reschedule(): void {
  // window 守卫同三处旧 ticker：bun DOM 测试环境无 window 不起表。
  if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return;
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  if (subscriptions.size === 0) return;
  let fastest = Number.POSITIVE_INFINITY;
  for (const sub of subscriptions) fastest = Math.min(fastest, sub.intervalMs);
  timer = setInterval(pump, Math.max(1, fastest));
}

/** Start a periodic callback on the shared heartbeat. Returns an idempotent
 *  cancel function (same shape the three former per-item intervals expose). */
export function startHeartbeat(intervalMs: number, callback: () => void): () => void {
  const sub: Subscription = { intervalMs, nextDueAt: Date.now() + intervalMs, callback };
  subscriptions.add(sub);
  reschedule();
  let cancelled = false;
  return () => {
    if (cancelled) return;
    cancelled = true;
    if (subscriptions.delete(sub)) reschedule();
  };
}
