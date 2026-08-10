// src/__tests__/cli_toolrow.test.ts
// Unit tests for the CLI tool-failure reason line (src/cli_toolrow.ts):
// sanitization, newline collapsing, truncation.

import { describe, it, expect } from 'bun:test';
import { formatToolErrorLine, logoRowPlan, LOGO_WORDMARK_W, TOOL_ERROR_MAX } from '../cli_toolrow';

describe('formatToolErrorLine', () => {
  it('passes a plain one-line error through', () => {
    expect(formatToolErrorLine('Directory not found: .')).toBe('Directory not found: .');
  });

  it('strips ANSI escapes from command stderr', () => {
    expect(formatToolErrorLine('\x1b[31mboom\x1b[0m: exit code 3')).toBe('boom: exit code 3');
    // OSC hyperlink payloads too (the link text between the two OSC wraps
    // survives — only the escape sequences themselves are removed).
    expect(formatToolErrorLine('failed \x1b]8;;http://x\x07link\x1b]8;;\x07here')).toBe('failed linkhere');
  });

  it('collapses newlines and runs of whitespace into a single line', () => {
    expect(formatToolErrorLine('line one\nline two\n  line three')).toBe('line one line two line three');
    expect(formatToolErrorLine('tab\there  and  spaces')).toBe('tab here and spaces');
  });

  it('truncates long errors so the printed line never exceeds TOOL_ERROR_MAX', () => {
    const long = 'x'.repeat(TOOL_ERROR_MAX + 100);
    const out = formatToolErrorLine(long);
    expect(out.length).toBe(TOOL_ERROR_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, TOOL_ERROR_MAX - 1)).toBe('x'.repeat(TOOL_ERROR_MAX - 1));
  });

  it('does not truncate errors that fit', () => {
    const fits = 'y'.repeat(TOOL_ERROR_MAX - 1);
    const out = formatToolErrorLine(fits);
    expect(out).toBe(fits);
    expect(out.endsWith('…')).toBe(false);
  });

  it('returns an empty string for empty / whitespace-only / control-only input', () => {
    expect(formatToolErrorLine('')).toBe('');
    expect(formatToolErrorLine('   \n\t  ')).toBe('');
    expect(formatToolErrorLine('\x1b[31m\x1b[0m')).toBe('');
  });
});

describe('logoRowPlan (narrow-terminal logo regression)', () => {
  it('uses the full wordmark once the box fits it (inner >= 45)', () => {
    expect(logoRowPlan(LOGO_WORDMARK_W)).toEqual([true, true, true, true, true, true]);
    expect(logoRowPlan(76)).toEqual([true, true, true, true, true, true]);
  });

  it('falls back to a compact mark when the wordmark would overflow the box', () => {
    // inner clamped at 40 — the wordmark (45) cannot fit → blank rows with a
    // single mark row in the middle (old bug: the row overflowed the border).
    expect(logoRowPlan(40)).toEqual([false, false, 'mark', false, false, false]);
    expect(logoRowPlan(44)).toEqual([false, false, 'mark', false, false, false]);
  });

  it('every plan keeps all rows within the box width', () => {
    for (const inner of [40, 41, 44, 45, 60, 76, 120]) {
      for (const row of logoRowPlan(inner)) {
        // true/mark rows are ≤ wordmark width; the box is ≥ inner ≥ 40, so a
        // mark (4 cols) and wordmark rows (45) only render when they fit.
        if (row === true) expect(inner).toBeGreaterThanOrEqual(LOGO_WORDMARK_W);
      }
    }
  });
});
