// src/shared/__tests__/rewriteGate.test.ts

import { describe, expect, it } from 'bun:test';
import { REWRITE_GATE_MAX_CHANGED_RATIO, REWRITE_GATE_MIN_CHARS, classifyRewrite, rewriteRefusal } from '../rewriteGate';

const big = (marker = 'A') => `${marker}`.repeat(REWRITE_GATE_MIN_CHARS);

describe('classifyRewrite', () => {
  it('blocks a full write that only changes a small middle region', () => {
    const old = `${'head'.repeat(400)}OLD-PARAGRAPH${'tail'.repeat(400)}`;
    const next = old.replace('OLD-PARAGRAPH', 'NEW-PARAGRAPH');

    const verdict = classifyRewrite(old, next);

    expect(verdict.blocked).toBe(true);
    expect(verdict.changedChars).toBeLessThan(old.length * 0.05);
    expect(rewriteRefusal('src/a.ts', verdict)).toContain('edit_file');
  });

  it('allows a genuine whole-file rewrite', () => {
    const old = big('A');
    const next = big('B');

    expect(classifyRewrite(old, next).blocked).toBe(false);
  });

  it('blocks a one-line edit when the snapshot lost the trailing newline (GUI read_file trims)', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `// line ${String(i + 1).padStart(3, '0')}: alpha beta gamma delta epsilon zeta\n`);
    const old = lines.join('').trim();
    const next = `${old.replace('// line 001: alpha beta gamma delta epsilon zeta', '// CHANGED')}\n`;

    const verdict = classifyRewrite(old, next);

    expect(verdict.blocked).toBe(true);
    expect(verdict.changedChars).toBeLessThan(100);
  });

  it('allows a new file (no disk content to compare)', () => {
    expect(classifyRewrite(undefined, big('A')).blocked).toBe(false);
    expect(classifyRewrite('', big('A')).blocked).toBe(false);
  });

  it('ignores files below the minimum size', () => {
    expect(classifyRewrite('short', 'short!').blocked).toBe(false);
    expect(classifyRewrite(big('A'), `${big('A')}!`).blocked).toBe(true);
  });

  it('treats appending via a full write as a targeted change too (use append:true)', () => {
    const old = big('A');

    expect(classifyRewrite(old, `${old}extra`).blocked).toBe(true);
  });

  it('keeps the ratio boundary exclusive', () => {
    const old = 'a'.repeat(REWRITE_GATE_MIN_CHARS);
    const changed = Math.floor(old.length * REWRITE_GATE_MAX_CHANGED_RATIO);
    const next = `${'a'.repeat(old.length - changed)}${'b'.repeat(changed)}`;

    expect(classifyRewrite(old, next).blocked).toBe(true);
    expect(classifyRewrite(old, `${next}b`).blocked).toBe(false);
  });
});
