// src/engine/BudgetManager.ts
// v0.3 — tracks token usage, turn count, and elapsed time.
// Exposes remaining() and gracePeriodEnd for BudgetWarning events.

import type { BudgetConfig, BudgetSnapshot } from '../shared/types';

export type BudgetStatus = 'ok' | 'warning' | 'exceeded';

// CJK token estimator range: Hiragana/Katakana, CJK Ext A + unified
// ideographs, Hangul syllables, and CJK compatibility. All BMP, so each
// matched code point is exactly one UTF-16 unit in `text.length`.
const CJK_CHAR_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;

export class BudgetManager {
  private config: BudgetConfig;
  private tokensUsed = 0;
  private turnCount = 0;
  private toolCallCount = 0;
  private startTime: number;
  private warningIssued = false;
  private exceededWarned = false;
  private graceTurnsUsed = 0;
  public readonly gracePeriodEnd: number;

  constructor(config: BudgetConfig) {
    this.config = config;
    this.startTime = Date.now();
    this.gracePeriodEnd = this.startTime + config.maxExecutionTime + 60000;
  }

  countTokens(text: string): number {
    if (!text) return 0;
    // CJK characters are dense: most tokenizers spend ~1 token per CJK char
    // while Latin text averages ~4 chars/token. A flat length/4 estimate
    // UNDERCOUNTS CJK by ~4×, so long Chinese or symbol-heavy code silently
    // blows past the token budget before the soft/hard limits fire. Weight
    // CJK-range code points at 1 token/char, everything else (Latin, digits,
    // ASCII symbols) at the historical ~1/4 token/char.
    let cjk = 0;
    for (const ch of text) {
      if (CJK_CHAR_RE.test(ch)) cjk++;
    }
    return Math.ceil(cjk + (text.length - cjk) / 4);
  }

  addTokens(text: string) {
    this.tokensUsed += this.countTokens(text);
  }

  incrementTurn() {
    this.turnCount++;
  }

  incrementToolCall() {
    this.toolCallCount++;
  }

  check(): BudgetStatus {
    const elapsed = Date.now() - this.startTime;

    // HARD caps (opt-in). When none are set the run is elastic and never stops
    // on its own — only a user abort or a hard cap can end it.
    const hardTurns = this.config.hardMaxTurns ?? 0;
    const hardTokens = this.config.hardMaxTokens ?? 0;
    const hardTime = this.config.hardMaxTime ?? 0;
    const hardHit =
      (hardTurns > 0 && this.turnCount >= hardTurns) ||
      (hardTokens > 0 && this.tokensUsed >= hardTokens) ||
      (hardTime > 0 && elapsed >= hardTime);
    if (hardHit) {
      if (this.graceTurnsUsed < this.config.graceTurns) {
        this.graceTurnsUsed++;
        return 'warning';
      }
      return 'exceeded';
    }

    // SOFT limits: warn once, then continue. The agent is never hard-stopped by
    // the soft budget, so a long but productive task runs to completion.
    const turnRatio = this.turnCount / this.config.maxTurns;
    const tokenRatio = this.tokensUsed / this.config.maxTotalTokens;
    const timeRatio = elapsed / this.config.maxExecutionTime;

    if (turnRatio >= 1 || tokenRatio >= 1 || timeRatio >= 1) {
      if (!this.exceededWarned) {
        this.exceededWarned = true;
        return 'warning';
      }
      return 'ok';
    }

    if (turnRatio >= this.config.warningThreshold || tokenRatio >= this.config.warningThreshold || timeRatio >= this.config.warningThreshold) {
      if (!this.warningIssued) {
        this.warningIssued = true;
        return 'warning';
      }
    }

    return 'ok';
  }

  /** Returns remaining budget across all dimensions. */
  remaining(): { turns: number; tokens: number; time: number } {
    return {
      turns: Math.max(0, this.config.maxTurns - this.turnCount),
      tokens: Math.max(0, this.config.maxTotalTokens - this.tokensUsed),
      time: Math.max(0, this.config.maxExecutionTime - (Date.now() - this.startTime)),
    };
  }

  snapshot(): BudgetSnapshot {
    return {
      turns: { used: this.turnCount, max: this.config.maxTurns },
      tokens: { used: this.tokensUsed, max: this.config.maxTotalTokens },
      // The engine has a single loop counter (turnCount) — "iterations" is the
      // same counter, so its max is the turn budget, not a fabricated ×3.
      iterations: { used: this.turnCount, max: this.config.maxTurns },
      // No tool-call budget is configured; max is an order-of-magnitude display
      // estimate derived from the turn cap (not a real limit).
      toolCalls: { used: this.toolCallCount, max: this.config.maxTurns * 10 },
      elapsed: Date.now() - this.startTime,
    };
  }
}
