// src/shared/__tests__/engineLease.test.ts
// 租约仲裁纯核：续约/拒绝/接管/迟到写四类判定。

import { describe, expect, it } from 'bun:test';
import { arbitrateLease, isWriteFresh, LEASE_TTL_MS, renewLease } from '../engineLease';

const held = (holder: string, epoch: number, expiresAt: number) => ({ holder, epoch, expiresAt });

describe('arbitrateLease', () => {
  const now = 1_000_000;

  it('empty lease grants epoch 1', () => {
    expect(arbitrateLease(null, 'winA', now)).toEqual({ action: 'grant', epoch: 1 });
  });

  it('same holder renews without bumping epoch', () => {
    const r = arbitrateLease(held('winA', 3, now + LEASE_TTL_MS), 'winA', now);
    expect(r).toEqual({ action: 'keep', epoch: 3 });
  });

  it('rejects another claimant while unexpired', () => {
    const r = arbitrateLease(held('winA', 3, now + LEASE_TTL_MS), 'winB', now);
    expect(r).toEqual({ action: 'reject', epoch: 3, holder: 'winA' });
  });

  it('expired lease is taken over with epoch + 1（旧持有者诈尸的写按 epoch 丢弃）', () => {
    const r = arbitrateLease(held('winA', 3, now - 1), 'winB', now);
    expect(r).toEqual({ action: 'grant', epoch: 4 });
  });
});

describe('isWriteFresh', () => {
  it('accepts writes from the current epoch only', () => {
    expect(isWriteFresh(4, 4)).toBe(true);
    expect(isWriteFresh(3, 4)).toBe(false);
  });
});

describe('renewLease', () => {
  it('extends expiry without touching holder or epoch', () => {
    const r = renewLease(held('winA', 3, 500), 1_000_000);
    expect(r).toEqual({ holder: 'winA', epoch: 3, expiresAt: 1_000_000 + LEASE_TTL_MS });
  });
});
