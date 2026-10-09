// src/coding-agent/__tests__/defaultHarnessConfig.test.ts
// 9.1 — this factory is the single place BOTH entrypoints (the CLI's Harness
// and the GUI's CodingAgent) pick up their ContextEngine. Rehydration hooks
// are host-specific by nature, so they must be forwarded here or a host could
// silently compact without restoring the workspace/plan state — the exact
// class of "wired at one call site, forgotten at the other" drift this file
// exists to catch.

import { describe, it, expect } from 'bun:test';
import { createDefaultHarnessConfig } from '../defaultHarnessConfig';
import type { LLMAdapter, Message } from '../../shared/types';

const llm: LLMAdapter = {
  stream: async function* () {
    yield { type: 'done' as const, content: '', toolCalls: [] };
  },
  complete: async () => ({ content: 'summary', toolCalls: [] }),
};

/** A read pair with a `chars`-long tool result. */
function pair(id: string, chars: number): Message[] {
  return [
    { role: 'assistant', content: '', toolCalls: [{ id, index: 0, function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', content: 'x'.repeat(chars), toolCallId: id, toolName: 'read_file' },
  ];
}

/** 900 input tokens — small enough to force an eviction from a few messages. */
const SMALL_BUDGET = { contextWindowTokens: 900, outputReserveTokens: 0, safetyMarginTokens: 0 };

describe('createDefaultHarnessConfig — 9.1 rehydration forwarding', () => {
  it('forwards the host hooks into the ContextEngine it builds', async () => {
    const plumbing = createDefaultHarnessConfig({
      llm,
      promptBudget: SMALL_BUDGET,
      toolsProvider: () => [],
      rehydration: {
        readFile: async () => 'RESTORED FILE BODY',
        todos: () => '[>] wire the parser',
      },
    });
    const write: Message[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'w1', index: 0, function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/app.ts', content: 'x' }) } }] },
      { role: 'tool', content: 'ok', toolCallId: 'w1', toolName: 'write_file' },
    ];

    const result = await plumbing.contextEngine.compact([...write, ...pair('a', 4000), ...pair('b', 4000)]);

    expect(result.evictedMessages).toBeGreaterThan(0);
    expect(result.rehydratedFiles).toBe(1);
    expect(result.restoredPlan).toBe(true);
    const block = result.messages.find(m => m.content.startsWith('State restored after context compaction'));
    expect(block).toBeDefined();
    expect(block!.content).toContain('RESTORED FILE BODY');
    expect(block!.content).toContain('wire the parser');
  });

  it('builds a host-agnostic engine when no rehydration hooks are supplied', async () => {
    const plumbing = createDefaultHarnessConfig({
      llm,
      promptBudget: SMALL_BUDGET,
      toolsProvider: () => [],
    });

    const result = await plumbing.contextEngine.compact([...pair('a', 5000), ...pair('b', 5000)]);

    expect(result.evictedMessages).toBeGreaterThan(0);
    expect(result.rehydratedFiles).toBe(0);
    expect(result.restoredPlan).toBe(false);
    expect(result.messages.some(m => m.content.startsWith('State restored after context compaction'))).toBe(false);
  });
});
