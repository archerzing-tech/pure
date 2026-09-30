// src/channels/limits.ts
// 成本与滥用防护（设计文档 §6.5）：每 peer 速率限制（默认 5 条/分钟）+
// 每 peer / 全局每日 token 预算。超出后只回一句告知而不进 agent；
// 未配对消息只在入口挡下，不消耗预算（因为不进 agent）。
import type { TokenUsage } from '../shared/types';

export interface PeerRateLimiterOptions {
  perMinute: number;
  windowMs?: number;
  now?: () => number;
}

export interface RateDecision {
  allowed: boolean;
  /** 被拒时建议的等待毫秒数。 */
  retryAfterMs?: number;
}

export class PeerRateLimiter {
  private hits = new Map<string, number[]>();
  private readonly perMinute: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: PeerRateLimiterOptions) {
    this.perMinute = Math.max(0, options.perMinute);
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  check(key: string): RateDecision {
    if (this.perMinute <= 0) return { allowed: true };
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
    if (recent.length >= this.perMinute) {
      this.hits.set(key, recent);
      const oldest = recent[0];
      return { allowed: false, retryAfterMs: Math.max(1000, this.windowMs - (now - oldest)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true };
  }
}

export interface DailyTokenBudgetOptions {
  dailyTokens: number;
  /** 单 peer 的每日上限；省略则与全局同额。 */
  perPeerDailyTokens?: number;
  now?: () => number;
}

interface DayUsage {
  day: string;
  used: number;
}

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export class DailyTokenBudget {
  private global: DayUsage;
  private perPeer = new Map<string, DayUsage>();
  private readonly dailyTokens: number;
  private readonly perPeerDailyTokens: number;
  private readonly now: () => number;

  constructor(options: DailyTokenBudgetOptions) {
    this.dailyTokens = Math.max(0, options.dailyTokens);
    this.perPeerDailyTokens = Math.max(0, options.perPeerDailyTokens ?? options.dailyTokens);
    this.now = options.now ?? (() => Date.now());
    this.global = { day: dayKey(this.now()), used: 0 };
  }

  private resetIfNewDay(): string {
    const today = dayKey(this.now());
    if (this.global.day !== today) {
      this.global = { day: today, used: 0 };
      this.perPeer.clear();
    }
    return today;
  }

  private peerUsage(key: string): DayUsage {
    const today = this.resetIfNewDay();
    const existing = this.perPeer.get(key);
    if (existing && existing.day === today) return existing;
    const fresh: DayUsage = { day: today, used: 0 };
    this.perPeer.set(key, fresh);
    return fresh;
  }

  /** 是否还有额度（不预扣；真正消耗在 record）。 */
  canSpend(key: string): boolean {
    this.resetIfNewDay();
    if (this.dailyTokens > 0 && this.global.used >= this.dailyTokens) return false;
    if (this.perPeerDailyTokens > 0 && this.peerUsage(key).used >= this.perPeerDailyTokens) return false;
    return true;
  }

  record(key: string, usage: TokenUsage | undefined): void {
    if (!usage) return;
    const tokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    if (tokens <= 0) return;
    this.resetIfNewDay();
    this.global.used += tokens;
    this.peerUsage(key).used += tokens;
  }

  remaining(key: string): number {
    this.resetIfNewDay();
    const globalLeft = this.dailyTokens > 0 ? this.dailyTokens - this.global.used : Number.POSITIVE_INFINITY;
    const peerLeft = this.perPeerDailyTokens > 0 ? this.perPeerDailyTokens - this.peerUsage(key).used : Number.POSITIVE_INFINITY;
    return Math.max(0, Math.min(globalLeft, peerLeft));
  }
}

export function budgetExhaustedNotice(): string {
  return '今日额度已用完，暂时不再处理新请求。';
}

export function rateLimitedNotice(retryAfterMs?: number): string {
  const seconds = Math.ceil((retryAfterMs ?? 60_000) / 1000);
  return `消息太频繁了，请等约 ${seconds} 秒后再发。`;
}
