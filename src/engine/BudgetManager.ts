// src/engine/BudgetManager.ts
// v0.3 — tracks token usage, turn count, and elapsed time.
// Exposes remaining() and gracePeriodEnd for BudgetWarning events.

import type { BudgetConfig, BudgetSnapshot } from '../shared/types';

export type BudgetStatus = 'ok' | 'warning' | 'exceeded';

export class BudgetManager {
  private config: BudgetConfig;
  private tokensUsed = 0;
  private turnCount = 0;
  private toolCallCount = 0;
  private startTime: number;
  private warningIssued = false;
  private graceTurnsUsed = 0;
  public readonly gracePeriodEnd: number;

  constructor(config: BudgetConfig) {
    this.config = config;
    this.startTime = Date.now();
    this.gracePeriodEnd = this.startTime + config.maxExecutionTime + 60000;
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
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

    if (elapsed > this.config.maxExecutionTime) return 'exceeded';
    if (this.tokensUsed > this.config.maxTotalTokens) return 'exceeded';

    const turnRatio = this.turnCount / this.config.maxTurns;
    const tokenRatio = this.tokensUsed / this.config.maxTotalTokens;

    if (turnRatio >= 1 || tokenRatio >= 1) {
      if (this.graceTurnsUsed < this.config.graceTurns) {
        this.graceTurnsUsed++;
        return 'warning';
      }
      return 'exceeded';
    }

    if (turnRatio >= this.config.warningThreshold || tokenRatio >= this.config.warningThreshold) {
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
      iterations: { used: this.turnCount, max: this.config.maxTurns * 3 },
      toolCalls: { used: this.toolCallCount, max: this.config.maxTurns * 10 },
      elapsed: Date.now() - this.startTime,
    };
  }
}
