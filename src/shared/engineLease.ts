// src/shared/engineLease.ts
// 会话引擎租约仲裁纯核（P2-d 决策缝，2026-11-27）。
//
// 场景（双窗口判例的延伸）：同一会话在两个窗口打开 = 一窗持引擎（writer），
// 另一窗只读投影。仲裁规则：
//   · 同一持有者重复声明 = 续约（epoch 不变——续约不产生新版本，迟到写判定不抖）；
//   · 他人声明且租约未过期 = 拒绝（拒绝语带当前持有者，UI 可显示「此会话在另一窗口运行」）；
//   · 他人声明且租约过期（持有者崩溃/强杀，心跳停了）= 接管，epoch +1——
//     旧持有者的迟到写按旧 epoch 丢弃。
//
// 纯核只做仲裁决策；租约文件的读写（~/.pure/sessions/<id>/engine.lock）与
// 心跳续约定时器在 P2-d 完整刀里接 Rust 命令。

export interface LeaseRecord {
  holder: string;
  epoch: number;
  /** 租约过期时刻（持有者崩溃后由此判定接管）。 */
  expiresAt: number;
}

/** 心跳续约间隔的一半即容错余量；过期 = 最后一次心跳后 TTL 内无人续。 */
export const LEASE_TTL_MS = 30_000;

export type LeaseVerdict =
  | { action: 'keep'; epoch: number }
  | { action: 'grant'; epoch: number }
  | { action: 'reject'; epoch: number; holder: string };

export function arbitrateLease(
  current: LeaseRecord | null,
  claimant: string,
  now: number,
): LeaseVerdict {
  if (!current || current.expiresAt <= now) {
    // 过期接管：epoch +1——旧持有者若诈尸（实际未死只是慢），它的写带旧
    // epoch，按 isWriteFresh 判定丢弃。
    const base = current?.epoch ?? 0;
    return { action: 'grant', epoch: base + 1 };
  }
  if (current.holder === claimant) {
    return { action: 'keep', epoch: current.epoch };
  }
  return { action: 'reject', epoch: current.epoch, holder: current.holder };
}

/** 迟到写判定：写入携带的 epoch 落后于当前 epoch = 来自已失去租约的旧持有者。 */
export function isWriteFresh(writeEpoch: number, currentEpoch: number): boolean {
  return writeEpoch === currentEpoch;
}

/** 心跳续约后的租约（持有者不变，过期时刻顺延）。 */
export function renewLease(current: LeaseRecord, now: number): LeaseRecord {
  return { ...current, expiresAt: now + LEASE_TTL_MS };
}
