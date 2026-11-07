// src/shared/__tests__/memory.test.ts
// v0.11 — harvestUserPreferences is an explicit-instruction channel only:
// mention-inference pattern tables were retired (decision-boundary 2026-11
// A6 — mentioning is not preferring, that semantic call belongs to the model).
// What survives honors explicit "记住用 X" / "remember X" asks as typed
// `tool_preference` MemoryEntry fragments that the IMemoryStore persists.

import { describe, it, expect } from 'bun:test';
import { harvestUserPreferences } from '../memory';
import { GLOBAL_MEMORY_SCOPE } from '../types';

const ctx = { sessionId: 's1', projectPath: '/proj/x' };

describe('harvestUserPreferences', () => {
  it('returns empty for empty / too-short input', () => {
    expect(harvestUserPreferences('', ctx)).toHaveLength(0);
    expect(harvestUserPreferences('ab', ctx)).toHaveLength(0);
  });

  it('no longer infers preferences from bare mentions (A6: that call belongs to the model)', () => {
    // A one-off task description must not harden into a cross-project prompt line.
    const entries = harvestUserPreferences('I want a React app using TypeScript and pnpm', ctx);
    expect(entries).toHaveLength(0);
    expect(harvestUserPreferences('writing javascript and python, use tabs and no semicolons', ctx)).toHaveLength(0);
    expect(harvestUserPreferences('TypeScript TypeScript TypeScript', ctx)).toHaveLength(0);
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

  it('dedupes when several explicit asks name the same tool in one message', () => {
    const entries = harvestUserPreferences('记住用 pnpm，pnpm 比 npm 快', ctx);
    const pnpm = entries.filter(e => e.content === 'User wants to use the pnpm tool');
    expect(pnpm).toHaveLength(1);
  });

  it('does not treat non-tool “remember this idea” as a tool preference', () => {
    const entries = harvestUserPreferences('记住这个思路，下次用', ctx);
    expect(entries.some(e => e.type === 'tool_preference')).toBe(false);
  });
});
