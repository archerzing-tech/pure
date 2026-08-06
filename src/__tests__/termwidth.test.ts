// src/__tests__/termwidth.test.ts
// Mirrors the CLI thinking-preview bug: a mixed Chinese/English preview
// truncated by UTF-16 length can exceed the terminal width and wrap, leaving
// unerasable redraw remnants. These helpers truncate by display columns.

import { describe, expect, test } from 'bun:test';
import { displayWidth, fitTail, sanitizeForTerminal } from '../termwidth';

describe('displayWidth', () => {
  test('ASCII is 1 column per char', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('')).toBe(0);
  });

  test('CJK and fullwidth chars are 2 columns', () => {
    expect(displayWidth('指定')).toBe(4);
    expect(displayWidth('，')).toBe(2);          // fullwidth comma U+FF0C
    expect(displayWidth('"')).toBe(1);           // ASCII quote stays narrow
    expect(displayWidth('（')).toBe(2);           // fullwidth paren U+FF08
  });

  test('mixed Chinese/English counts both correctly', () => {
    // 13 CJK/fullwidth chars ×2 = 26 (指定一个规划，从西安到上海) + ASCII:
    // `"` 1 + ` — ` 3 (em dash U+2014 is ambiguous → 1) + `"Make a travel plan fr` 22 = 26
    expect(displayWidth('指定一个规划，从西安到上海" — "Make a travel plan fr')).toBe(52);
  });

  test('emoji and astral-plane chars are 2 columns', () => {
    expect(displayWidth('💭')).toBe(2);
    expect(displayWidth('🚄')).toBe(2);
  });
});

describe('fitTail', () => {
  test('keeps the whole string when it already fits', () => {
    expect(fitTail('abc', 10)).toBe('abc');
    expect(fitTail('', 10)).toBe('');
  });

  test('returns the longest suffix that fits maxCols', () => {
    expect(fitTail('指定一个规划', 4)).toBe('规划');      // 2×2 = 4 cols
    expect(fitTail('指定一个规划', 5)).toBe('规划');      // next char would need 6
    expect(fitTail('指定一个规划', 6)).toBe('个规划');    // 3×2 = 6 cols
    expect(fitTail('指定一个规划', 8)).toBe('一个规划');  // 4×2 = 8 cols
    expect(fitTail('abc指定', 4)).toBe('指定');
  });

  test('never splits a surrogate pair (emoji stays whole)', () => {
    const s = 'x💭y';
    // width: x=1, 💭=2, y=1 → total 4
    expect(fitTail(s, 3)).toBe('💭y');   // 2+1 = 3 cols, emoji intact
    expect(fitTail(s, 2)).toBe('y');     // adding 💭 would need 3 > 2
    expect(fitTail(s, 1)).toBe('y');
  });

  test('degenerates to empty when even one char cannot fit', () => {
    expect(fitTail('中文', 1)).toBe('');  // any single CJK char needs 2 cols
  });
});

describe('sanitizeForTerminal', () => {
  test('strips CSI color/cursor sequences', () => {
    expect(sanitizeForTerminal('a\x1b[31mb\x1b[0mc')).toBe('abc');
    expect(sanitizeForTerminal('x\x1b[2K y')).toBe('x y');
  });

  test('strips OSC sequences (title / hyperlink) with BEL or ST terminator', () => {
    expect(sanitizeForTerminal('a\x1b]0;title\x07b')).toBe('ab');
    expect(sanitizeForTerminal('a\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\b')).toBe('alinkb');
  });

  test('strips C0 control chars but keeps newline and tab', () => {
    expect(sanitizeForTerminal('a\x00b\x08c\x1bd')).toBe('abcd');
    expect(sanitizeForTerminal('line1\nline2\ttab')).toBe('line1\nline2\ttab');
    expect(sanitizeForTerminal('bell\x07here')).toBe('bellhere');
  });

  test('leaves normal CJK and punctuation untouched', () => {
    const clean = '指定一个规划，从西安到上海';
    expect(sanitizeForTerminal(clean)).toBe(clean);
  });
});
