// src/ui/__tests__/thinkingCard.test.ts
// Covers collapseRepeatedReasoning: the guard against reasoning models looping
// internally and emitting the same sentence/paragraph over and over.

import { describe, it, expect } from 'bun:test';
import { collapseRepeatedReasoning } from '../thinkingCard';

describe('collapseRepeatedReasoning', () => {
  it('collapses a repeated two-sentence loop to a single period', () => {
    const a = "After calling sys_info(), I'll have the current date and day information.";
    const b = "I'll call sys_info() now:";
    const loop = [a, b, a, b, a, b, a, b].join('\n\n');
    const out = collapseRepeatedReasoning(loop);
    expect(out).toBe(`${a}\n\n${b}`);
    expect(out).not.toContain('I\'ll call sys_info() now:\n\nI\'ll call sys_info() now:');
  });

  it('collapses a single repeated paragraph', () => {
    const p = 'Let me verify the date first.';
    const out = collapseRepeatedReasoning([p, p, p, p].join('\n\n'));
    expect(out).toBe(p);
  });

  it('handles a partial trailing period', () => {
    const a = 'Step one.';
    const b = 'Step two.';
    const out = collapseRepeatedReasoning([a, b, a, b, a].join('\n\n'));
    expect(out).toBe(`${a}\n\n${b}`);
  });

  it('leaves varied reasoning untouched', () => {
    const varied = '先查日期。\n\n查到了，今天是周三。\n\n接下来给出星期几的结论。';
    expect(collapseRepeatedReasoning(varied)).toBe(varied);
  });

  it('does not collapse short text with no repetition', () => {
    expect(collapseRepeatedReasoning('只有一个段落。')).toBe('只有一个段落。');
    expect(collapseRepeatedReasoning('')).toBe('');
  });

  it('does not collapse a two-block text that is not a repeat', () => {
    const text = 'Block A.\n\nBlock B.';
    expect(collapseRepeatedReasoning(text)).toBe(text);
  });
});
