// src/shared/timing.ts
// 限时等待的两个统一入口。病根（2026-10 审计批 3）：手写
// `Promise.race([work, new Promise(r => setTimeout(r, ms))])` 从不清理
// 输掉竞速的定时器——work 先落定后，这个孤儿 timer 仍攥着事件循环，
// 进程要白等到超时满额才退（审计实测：settleReflections 立即返回，
// CLI 进程仍停 30.00 秒；roleAssertionDraft 的孤儿更是 300 秒）。
// 本文件保证：work 与定时器无论谁先落定，输家的句柄必被清掉。

/**
 * Bounded wait: resolve with `promise`'s value if it settles within `ms`,
 * otherwise resolve with `fallback()` (or `undefined` when no fallback is
 * given). A rejection from `promise` always propagates, timeout or not.
 * The timeout is a normal outcome here, not an error — use for drains and
 * soft-waits where "gave up waiting" is the designed degradation path.
 */
export function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined>;
export function settleWithin<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T>;
export function settleWithin<T>(promise: Promise<T>, ms: number, fallback?: () => T): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!fallback) {
        resolve(undefined);
        return;
      }
      try {
        resolve(fallback());
      } catch (err) {
        reject(err);
      }
    }, ms);
    // 两个分支都先清定时器再结算；timeout 之后 work 才 reject 也走这里，
    // 落在已结算的 promise 上是 no-op，不会变成 unhandled rejection。
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Bounded wait where timeout IS an error: rejects with
 * `${label} timed out after ${ms}ms` when `promise` doesn't settle in time.
 * Promoted from Harness's private implementation (the audit's one correct
 * sample) — same observable semantics, single cleanup mechanism shared with
 * settleWithin.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return settleWithin(promise, ms, () => {
    throw new Error(`${label} timed out after ${ms}ms`);
  });
}
