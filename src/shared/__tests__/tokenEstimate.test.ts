import { describe, expect, it } from 'bun:test';
import { countCjkChars, estimateTextTokens } from '../tokenEstimate';

describe('CJK-aware token estimation', () => {
  it('counts pure CJK text at ~1 token per char, not length/4', () => {
    // 14 CJK chars (14 tokens) + "token" (5 Latin chars → 2 tokens) = 16
    const text = '这是一段中文内容用于验证token估算';
    expect(estimateTextTokens(text)).toBe(16);
    // The old flat length/4 estimate would have said 5 — a 3×+ undercount.
    expect(Math.ceil(text.length / 4)).toBe(5);
  });

  it('counts pure Latin text at ~4 chars per token', () => {
    const text = 'abcdefgh'; // 8 chars → 2 tokens
    expect(estimateTextTokens(text)).toBe(2);
  });

  it('weights mixed CJK/Latin text additively', () => {
    // 4 CJK chars (4 tokens) + 8 Latin chars (2 tokens) = 6
    expect(estimateTextTokens('中文内容abcdefgh')).toBe(6);
  });

  it('counts Japanese kana and Korean hangul as dense chars', () => {
    expect(estimateTextTokens('かなカナ')).toBe(4);
    expect(estimateTextTokens('한국어텍스트')).toBe(6);
  });

  it('handles empty and whitespace-only input', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('    ')).toBe(1);
  });

  it('counts CJK chars including extension ranges', () => {
    expect(countCjkChars('中文')).toBe(2);
    expect(countCjkChars('abc')).toBe(0);
  });
});
