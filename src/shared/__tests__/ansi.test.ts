// src/shared/__tests__/ansi.test.ts
import { describe, it, expect } from 'bun:test';
import { stripAnsi } from '../ansi';

describe('stripAnsi', () => {
  it('strips CSI color codes', () => {
    expect(stripAnsi('\x1b[31mERROR\x1b[0m: thing')).toBe('ERROR: thing');
  });

  it('strips multiple / cursor-motion / clear-line sequences', () => {
    expect(stripAnsi('\x1b[2K\x1b[1A\x1b[1;32mok\x1b[m')).toBe('ok');
  });

  it('strips OSC window-title sequences', () => {
    expect(stripAnsi('\x1b]0;my title\x07normal')).toBe('normal');
    expect(stripAnsi('\x1b]0;title\x1b\\x')).toBe('x');
  });

  it('strips DCS / APC / SOS / PM string sequences (terminated by BEL or ST)', () => {
    expect(stripAnsi('\x1bP1;2payload\x07after')).toBe('after');
    expect(stripAnsi('\x1b_payload\x1b\\after')).toBe('after');
    expect(stripAnsi('\x1b^sos\x07after')).toBe('after');
    expect(stripAnsi('\x1bXpm\x1b\\after')).toBe('after');
  });

  it('keeps real newlines and tabs', () => {
    expect(stripAnsi('line1\nline2\t\x1b[31mX\x1b[0m')).toBe('line1\nline2\tX');
  });

  it('passes plain text through unchanged', () => {
    const s = 'plain text with no escapes';
    expect(stripAnsi(s)).toBe(s);
  });

  it('handles empty and ansi-only input', () => {
    expect(stripAnsi('')).toBe('');
    expect(stripAnsi('\x1b[0m\x1b[1m')).toBe('');
  });
});
