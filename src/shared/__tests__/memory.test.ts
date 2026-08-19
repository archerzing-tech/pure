// src/shared/__tests__/memory.test.ts
// v0.10 — harvestUserPreferences replaces the old regex MemoryEngine: the same
// pattern lists now emit typed `user_preference` MemoryEntry fragments that the
// IMemoryStore persists across sessions.

import { describe, it, expect } from 'bun:test';
import { harvestUserPreferences } from '../memory';
import { GLOBAL_MEMORY_SCOPE } from '../types';

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

  it('honors explicit “remember <tool>” asks as tool_preference', () => {
    const entries = harvestUserPreferences('记住用 pnpm，以后都用它', ctx);
    const tool = entries.find(e => e.type === 'tool_preference');
    expect(tool).toBeDefined();
    expect(tool!.content).toBe('User wants to use the pnpm tool');
    expect(tool!.platform).toBeUndefined(); // user-stated preference is platform-agnostic
    // 机器级全局作用域："这台机器上用 pnpm"在任何项目都成立。
    expect(tool!.projectPath).toBe(GLOBAL_MEMORY_SCOPE);
  });

  it('honors English remember / comparison / “use X instead” asks', () => {
    const zh = harvestUserPreferences('remember uv', ctx);
    expect(zh.find(e => e.type === 'tool_preference')?.content).toBe('User wants to use the uv tool');

    const cmp = harvestUserPreferences('pnpm 比 npm 快很多', ctx);
    expect(cmp.find(e => e.type === 'tool_preference')?.content).toBe('User wants to use the pnpm tool');

    const better = harvestUserPreferences('用 uv 更快', ctx);
    expect(better.find(e => e.type === 'tool_preference')?.content).toBe('User wants to use the uv tool');
  });

  it('does not treat non-tool “remember this idea” as a tool preference', () => {
    const entries = harvestUserPreferences('记住这个思路，下次用', ctx);
    expect(entries.some(e => e.type === 'tool_preference')).toBe(false);
  });
});
