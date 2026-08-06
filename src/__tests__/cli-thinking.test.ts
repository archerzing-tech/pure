// src/__tests__/cli-thinking.test.ts
// Unit tests for the CLI thinking card (src/cli-thinking.ts): CJK-aware
// wrapping/padding and the boxed card's height cap, tail-following scroll
// window, plain-text rendering, and in-place ANSI redraw/clear behavior.

import { describe, it, expect } from 'bun:test';
import { ThinkingCard, wrapLine, padCols } from '../cli-thinking';
import { displayWidth } from '../termwidth';

describe('wrapLine', () => {
  it('wraps ASCII text at the column width', () => {
    expect(wrapLine('abcdef', 3)).toEqual(['abc', 'def']);
    expect(wrapLine('hello world', 5)).toEqual(['hello', 'world']);
    expect(wrapLine('hello world', 6)).toEqual(['hello', 'world']);
  });

  it('breaks at word boundaries — never cuts a word that fits on a line', () => {
    expect(wrapLine('across multiple rows', 12)).toEqual(['across', 'multiple', 'rows']);
    expect(wrapLine('你好 世界 高铁', 6)).toEqual(['你好', '世界', '高铁']);
  });

  it('is CJK-aware (full-width chars count as 2 columns)', () => {
    // Each 全角 char is 2 columns → a 4-col line holds exactly 2 CJK chars.
    expect(wrapLine('西安到重庆', 4)).toEqual(['西安', '到重', '庆']);
    expect(wrapLine('西安到重庆', 6)).toEqual(['西安到', '重庆']);
  });

  it('wraps over-long words into multiple lines (nothing overflows the box)', () => {
    const lines = wrapLine('a'.repeat(10), 4);
    expect(lines).toEqual(['aaaa', 'aaaa', 'aa']);
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(4);
  });
});

describe('padCols', () => {
  it('pads by display columns, not UTF-16 code units', () => {
    expect(padCols('ab', 6)).toBe('ab    ');
    expect(padCols('西安', 6)).toBe('西安  ');
  });

  it('never truncates content wider than the target', () => {
    expect(padCols('abcdef', 4)).toBe('abcdef');
    expect(padCols('西安到', 4)).toBe('西安到');
  });
});

describe('ThinkingCard', () => {
  function makeCard(text = '', maxRows = 3): { card: ThinkingCard; out: string[] } {
    const out: string[] = [];
    const card = new ThinkingCard({
      maxRows,
      write: (s) => out.push(s),
      columns: () => 40,
    });
    card.append(text);
    return { card, out };
  }

  it('renders a boxed card with header and footer borders', () => {
    const { card } = makeCard('thinking text');
    const rows = card.buildRows();
    expect(rows.length).toBe(3); // header + 1 content + footer
    expect(rows[0].startsWith('┌─ 💭 thinking')).toBe(true);
    expect(rows[0].endsWith('┐')).toBe(true);
    expect(rows[1].startsWith('│')).toBe(true);
    expect(rows[1].endsWith('│')).toBe(true);
    expect(rows[2].startsWith('└')).toBe(true);
    expect(rows[2].endsWith('┘')).toBe(true);
  });

  it('caps content height and shows a truncation row when text overflows', () => {
    const { card } = makeCard('line1\nline2\nline3\nline4\nline5', 3);
    const rows = card.buildRows();
    // header + 3 content + footer — the card height is capped
    expect(rows.length).toBe(5);
    expect(rows[1]).toContain('… 3 more lines');
  });

  it('keeps the most recent lines in the tail-following scroll window', () => {
    const { card } = makeCard('a\nb\nc\nd\ne', 3);
    const rows = card.buildRows();
    const content = rows.slice(1, -1).join('\n');
    expect(content).toContain('d');
    expect(content).toContain('e');
  });

  it('shows text verbatim — no bold/markdown/ANSI interpretation', () => {
    const { card } = makeCard('**bold** and `code` and ==hl==', 3);
    const rows = card.buildRows();
    const body = rows.slice(1, -1).join('\n');
    expect(body).toContain('**bold**');
    expect(body).toContain('`code`');
    expect(body).toContain('==hl==');
  });

  it('redraw() erases every row in place (no ghost rows on height change)', () => {
    const { card, out } = makeCard('one');
    card.redraw();
    const firstPass = out.join('');
    expect(firstPass.split('\x1b[2K').length - 1).toBe(3); // header+content+footer

    // Height grows 3 → 5 rows: the second redraw must move up and erase
    // 5 rows (the max of old/new height) so no stale row survives.
    out.length = 0;
    card.append('\ntwo\nthree');
    card.redraw();
    const secondPass = out.join('');
    expect(secondPass.includes('\r\x1b[2A')).toBe(true); // cursor up to old top
    expect(secondPass.split('\x1b[2K').length - 1).toBe(5);
  });

  it('clear() erases the card entirely and allows reuse', () => {
    const { card, out } = makeCard('x');
    card.redraw();
    card.clear();
    const s = out.join('');
    expect(s.split('\x1b[2K').length - 1).toBe(6); // 3 redraw + 3 clear
    // clear() must DELETE the card rows (DL = ESC[{n}M) after blanking them,
    // so no empty rows are left on screen when the summary replaces the card.
    expect(s.includes('\x1b[3M')).toBe(true); // 3 rows deleted
    expect(s.includes('\r\x1b[2A')).toBe(true); // cursor back to card top
    // After clear the card can be redrawn from scratch without ghost rows.
    out.length = 0;
    card.append('y');
    card.redraw();
    expect(out.join('').split('\x1b[2K').length - 1).toBe(3);
  });

  it('collapse() returns a one-line summary and clears the card', () => {
    const { card } = makeCard('planning a trip');
    card.redraw();
    const summary = card.collapse();
    expect(summary).toContain('💭');
    expect(summary).toContain('15 chars'); // 'planning a trip' = 15 chars
  });
});
