// src/shared/__tests__/inputHistory.test.ts
// 输入历史内核：bash 口径的去重/封顶、坏文件容错、↑/↓ 状态机（首按存草稿、
// 到头不循环、↓ 越过最新回到草稿、空历史不接手）。

import { describe, it, expect } from 'bun:test';
import { MAX_INPUT_HISTORY, parseInputHistory, recallInput, rememberInput, resetRecall } from '../inputHistory';

describe('rememberInput', () => {
  it('keeps newest first and drops empty input', () => {
    let history = rememberInput([], '帮我跑测试');
    history = rememberInput(history, '  帮我跑测试  '); // 同一条 trim 后重复 → 不记
    history = rememberInput(history, '   '); // 空串不记
    history = rememberInput(history, '查一下依赖版本');
    expect(history).toEqual(['查一下依赖版本', '帮我跑测试']);
  });

  it('only dedupes against the most recent entry (bash behaviour)', () => {
    let history = rememberInput([], 'a');
    history = rememberInput(history, 'b');
    history = rememberInput(history, 'a');
    expect(history).toEqual(['a', 'b', 'a']);
  });

  it('caps at MAX_INPUT_HISTORY', () => {
    let history: string[] = [];
    for (let i = 0; i < MAX_INPUT_HISTORY + 20; i++) history = rememberInput(history, `task-${i}`);
    expect(history).toHaveLength(MAX_INPUT_HISTORY);
    expect(history[0]).toBe(`task-${MAX_INPUT_HISTORY + 19}`); // newest survives
  });
});

describe('parseInputHistory', () => {
  it('accepts a string array and rejects everything else', () => {
    expect(parseInputHistory(['a', 'b'])).toEqual(['a', 'b']);
    expect(parseInputHistory('not an array')).toEqual([]);
    expect(parseInputHistory(null)).toEqual([]);
    expect(parseInputHistory([1, 'a', '', '  '])).toEqual(['a']); // 非字符串/空白项剔除
  });

  it('caps a hand-edited oversized file', () => {
    const big = Array.from({ length: MAX_INPUT_HISTORY + 5 }, (_, i) => `x${i}`);
    expect(parseInputHistory(big)).toHaveLength(MAX_INPUT_HISTORY);
  });
});

describe('recallInput (↑/↓ 状态机)', () => {
  const history = ['third', 'second', 'first']; // newest-first

  it('starts at the newest entry and keeps the draft', () => {
    const next = recallInput(history, -1, 'my draft', 'up')!;
    expect(next.index).toBe(0);
    expect(next.value).toBe('third');
    expect(next.draft).toBe('my draft');
  });

  it('walks older on ↑ and stops at the oldest without wrapping', () => {
    expect(recallInput(history, 0, 'd', 'up')!.value).toBe('second');
    expect(recallInput(history, 1, 'd', 'up')!.value).toBe('first');
    const oldest = recallInput(history, 2, 'd', 'up')!;
    expect(oldest.index).toBe(2); // 到头停在原地——循环会让人找不到草稿
    expect(oldest.value).toBe('first');
  });

  it('walks newer on ↓ and returns to the draft past the newest', () => {
    expect(recallInput(history, 2, 'my draft', 'down')!.value).toBe('second');
    expect(recallInput(history, 1, 'my draft', 'down')!.value).toBe('third');
    const back = recallInput(history, 0, 'my draft', 'down')!;
    expect(back.index).toBe(-1);
    expect(back.value).toBe('my draft'); // 回到草稿
  });

  it('leaves ↓ alone when still on the live input', () => {
    expect(recallInput(history, -1, 'd', 'down')).toBeUndefined();
  });

  it('does nothing on an empty history', () => {
    expect(recallInput([], -1, 'd', 'up')).toBeUndefined();
    expect(recallInput([], -1, 'd', 'down')).toBeUndefined();
  });
});

describe('resetRecall', () => {
  it('clears the cycle state after a send', () => {
    expect(resetRecall()).toEqual({ index: -1, draft: '' });
  });
});
