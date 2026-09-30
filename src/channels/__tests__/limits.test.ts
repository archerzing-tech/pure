import { describe, it, expect } from 'bun:test';
import { DailyTokenBudget, PeerRateLimiter, budgetExhaustedNotice, rateLimitedNotice } from '../limits';

describe('PeerRateLimiter', () => {
  it('allows up to the per-minute quota then denies with a retry hint', () => {
    let now = 0;
    const limiter = new PeerRateLimiter({ perMinute: 2, now: () => now });
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(true);
    const denied = limiter.check('k');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('slides the window so old hits expire', () => {
    let now = 0;
    const limiter = new PeerRateLimiter({ perMinute: 1, windowMs: 1000, now: () => now });
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(false);
    now = 1500;
    expect(limiter.check('k').allowed).toBe(true);
  });

  it('keeps peers independent', () => {
    const limiter = new PeerRateLimiter({ perMinute: 1, now: () => 0 });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('treats a zero quota as unlimited', () => {
    const limiter = new PeerRateLimiter({ perMinute: 0, now: () => 0 });
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(true);
  });
});

describe('DailyTokenBudget', () => {
  it('spends down the global budget and refuses once exhausted', () => {
    const budget = new DailyTokenBudget({ dailyTokens: 100, now: () => Date.parse('2026-09-30T01:00:00Z') });
    expect(budget.canSpend('peer')).toBe(true);
    budget.record('peer', { promptTokens: 60, completionTokens: 30 });
    expect(budget.remaining('peer')).toBe(10);
    budget.record('peer', { promptTokens: 5, completionTokens: 5 });
    expect(budget.canSpend('peer')).toBe(false);
  });

  it('caps a single peer independently of the global pool', () => {
    const budget = new DailyTokenBudget({ dailyTokens: 1000, perPeerDailyTokens: 50, now: () => 0 });
    budget.record('a', { promptTokens: 50 });
    expect(budget.canSpend('a')).toBe(false);
    expect(budget.canSpend('b')).toBe(true);
  });

  it('resets at the day boundary', () => {
    let now = Date.parse('2026-09-30T23:00:00Z');
    const budget = new DailyTokenBudget({ dailyTokens: 10, now: () => now });
    budget.record('a', { promptTokens: 10 });
    expect(budget.canSpend('a')).toBe(false);
    now = Date.parse('2026-10-01T01:00:00Z');
    expect(budget.canSpend('a')).toBe(true);
    expect(budget.remaining('a')).toBe(10);
  });

  it('ignores empty usage records', () => {
    const budget = new DailyTokenBudget({ dailyTokens: 10, now: () => 0 });
    budget.record('a', undefined);
    budget.record('a', {});
    expect(budget.remaining('a')).toBe(10);
  });
});

describe('limit notices', () => {
  it('states the wait and the exhausted state plainly', () => {
    expect(rateLimitedNotice(30_000)).toContain('30 秒');
    expect(budgetExhaustedNotice()).toContain('今日额度已用完');
  });
});
