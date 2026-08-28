// src/engine/__tests__/BudgetManager.test.ts

import { describe, it, expect } from 'bun:test';
import { BudgetManager } from '../BudgetManager';
import type { BudgetConfig } from '../../shared/types';

const BASE: BudgetConfig = {
  maxTurns: 30,
  maxTotalTokens: 50_000,
  maxExecutionTime: 300_000,
  warningThreshold: 0.8,
  graceTurns: 3,
};

describe('BudgetManager', () => {
  it('returns ok when under limits', () => {
    const bm = new BudgetManager(BASE);
    bm.addTokens('hello');
    bm.incrementTurn();
    expect(bm.check()).toBe('ok');
  });

  it('returns warning at threshold', () => {
    const bm = new BudgetManager({ ...BASE, maxTurns: 10 });
    for (let i = 0; i < 8; i++) bm.incrementTurn();
    expect(bm.check()).toBe('warning');
  });

  it('returns exceeded when the HARD turn cap is hit after grace', () => {
    const bm = new BudgetManager({ ...BASE, maxTurns: 5, hardMaxTurns: 5, graceTurns: 1 });
    for (let i = 0; i < 5; i++) bm.incrementTurn();
    expect(bm.check()).toBe('warning'); // first grace turn
    bm.incrementTurn();
    expect(bm.check()).toBe('exceeded'); // grace exhausted
  });

  it('returns exceeded immediately when the HARD token cap is hit', () => {
    const bm = new BudgetManager({ ...BASE, maxTotalTokens: 100, hardMaxTokens: 100, graceTurns: 0 });
    bm.addTokens('x'.repeat(500)); // ~125 tokens > 100 → immediate exceed
    expect(bm.check()).toBe('exceeded');
  });

  it('respects grace turns when approaching the HARD turn cap', () => {
    const bm = new BudgetManager({ ...BASE, maxTurns: 3, hardMaxTurns: 3, graceTurns: 2, maxTotalTokens: 999_999 });
    for (let i = 0; i < 3; i++) bm.incrementTurn();
    expect(bm.check()).toBe('warning'); // grace 1/2
    expect(bm.check()).toBe('warning'); // grace 2/2
    expect(bm.check()).toBe('exceeded'); // grace exhausted
  });

  it('soft budget only warns and continues (elastic) when no hard cap is set', () => {
    const bm = new BudgetManager({ ...BASE, maxTurns: 3, graceTurns: 0 });
    for (let i = 0; i < 3; i++) bm.incrementTurn();
    expect(bm.check()).toBe('warning'); // warn once
    for (let i = 0; i < 20; i++) bm.incrementTurn();
    expect(bm.check()).toBe('ok'); // never hard-stops, keeps running
  });

  it('token counting approximates ~4 chars per token', () => {
    const bm = new BudgetManager(BASE);
    expect(bm.countTokens('1234')).toBe(1);
    expect(bm.countTokens('12345')).toBe(2);
    expect(bm.countTokens('')).toBe(0);
  });

  it('no duplicate warnings once warning has been issued', () => {
    const bm = new BudgetManager({ ...BASE, maxTurns: 10 });
    for (let i = 0; i < 8; i++) bm.incrementTurn();
    expect(bm.check()).toBe('warning');
    expect(bm.check()).toBe('ok'); // warning already issued
  });

  it('snapshot returns correct values', () => {
    const bm = new BudgetManager(BASE);
    bm.addTokens('hello world!');
    bm.incrementTurn();
    bm.incrementTurn();
    bm.incrementToolCall();
    bm.incrementToolCall();

    const snap = bm.snapshot();
    expect(snap.tokens.used).toBe(3);
    expect(snap.turns.used).toBe(2);
    expect(snap.toolCalls.used).toBe(2);
    expect(snap.tokens.max).toBe(BASE.maxTotalTokens);
    expect(snap.elapsed).toBeGreaterThanOrEqual(0);
  });
});
