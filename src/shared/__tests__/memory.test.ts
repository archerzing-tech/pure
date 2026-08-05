// src/shared/__tests__/memory.test.ts
// v0.10 — harvestUserPreferences replaces the old regex MemoryEngine: the same
// pattern lists now emit typed `user_preference` MemoryEntry fragments that the
// IMemoryStore persists across sessions.

import { describe, it, expect } from 'bun:test';
import { harvestUserPreferences } from '../memory';

const ctx = { sessionId: 's1', projectPath: '/proj/x' };

describe('harvestUserPreferences', () => {
  it('returns empty for empty / too-short input', () => {
    expect(harvestUserPreferences('', ctx)).toHaveLength(0);
    expect(harvestUserPreferences('ab', ctx)).toHaveLength(0);
  });

  it('extracts language, framework, and tool preferences', () => {
    const entries = harvestUserPreferences('I want a React app using TypeScript and pnpm', ctx);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.some(e => e.content.includes('TypeScript'))).toBe(true);
    expect(entries.some(e => e.content.includes('React'))).toBe(true);
    expect(entries.some(e => e.content.includes('pnpm'))).toBe(true);
    for (const e of entries) {
      expect(e.type).toBe('user_preference');
      expect(e.sessionId).toBe('s1');
      expect(e.projectPath).toBe('/proj/x');
      expect(e.timestamp).toBeGreaterThan(0);
      expect('id' in e).toBe(false); // store assigns id
    }
  });

  it('detects code-style preferences', () => {
    const entries = harvestUserPreferences('use tabs and no semicolons', ctx);
    expect(entries.some(e => e.content.includes('tabs'))).toBe(true);
    expect(entries.some(e => e.content.includes('semicolons'))).toBe(true);
  });

  it('dedupes repeated mentions within one message', () => {
    const entries = harvestUserPreferences('TypeScript TypeScript TypeScript', ctx);
    const ts = entries.filter(e => e.content.includes('TypeScript'));
    expect(ts).toHaveLength(1);
  });

  it('does not fire on substring false positives (javascript vs java)', () => {
    const entries = harvestUserPreferences('writing javascript', ctx);
    expect(entries.some(e => e.content.includes('Java language'))).toBe(false);
    expect(entries.some(e => e.content.includes('JavaScript'))).toBe(true);
  });
});
