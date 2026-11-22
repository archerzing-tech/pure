import { describe, expect, it } from 'bun:test';
import {
  formatEditHunk,
  formatNumberedLines,
  lineRangeAt,
  stripLineNumberGutter,
  totalLineCount,
} from '../lineGutter';

describe('lineGutter', () => {
  it('numbers from the given 1-based start line', () => {
    expect(formatNumberedLines(['a', 'b'], 4)).toBe('4→a\n5→b');
  });

  it('strips a fully numbered block', () => {
    expect(stripLineNumberGutter('12→const a = 1;\n13→  return a;')).toBe('const a = 1;\n  return a;');
  });

  it('keeps indentation that follows the gutter', () => {
    expect(stripLineNumberGutter('7→    nested();')).toBe('    nested();');
  });

  it('refuses a block where any non-empty line lacks a gutter', () => {
    expect(stripLineNumberGutter('1→a\nplain')).toBeNull();
    // 真实内容以「12→」开头但只有一行：整块不是编号块，原样保留。
    expect(stripLineNumberGutter('12→literal arrow')).toBe('literal arrow');
  });

  it('returns null when nothing is numbered', () => {
    expect(stripLineNumberGutter('a\nb')).toBeNull();
    expect(stripLineNumberGutter('')).toBeNull();
  });

  it('computes the replacement line range', () => {
    const text = 'a\nb\nc\nd';
    expect(lineRangeAt(text, 0, 'x')).toEqual({ startLine: 1, endLine: 1 });
    expect(lineRangeAt(text, 4, 'x\ny')).toEqual({ startLine: 3, endLine: 4 });
  });

  it('echoes a bounded window around the change', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n');
    const hunk = formatEditHunk(text, 20, 20);
    const lines = hunk.split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe('17→line-17');
    expect(lines[6]).toBe('23→line-23');
  });

  it('caps a multi-line change at maxLines from the change start', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n');
    const lines = formatEditHunk(text, 20, 30).split('\n');
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe('17→line-17');
  });

  it('counts lines the same way read_file numbers them', () => {
    expect(totalLineCount('a')).toBe(1);
    expect(totalLineCount('a\n')).toBe(2);
  });
});
