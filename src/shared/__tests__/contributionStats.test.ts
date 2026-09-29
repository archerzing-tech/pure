// src/shared/__tests__/contributionStats.test.ts
// P0 棘轮 — 注入贡献聚合的切片性验收：带 memoryInjection 的 run 必须按条目
// （记忆 id / skill: 前缀）干净切片；字段缺席的旧记录、无裁决的 run、以及
// injected === false（片段没活过预算）的 run 都不得污染切片。

import { describe, it, expect } from 'bun:test';
import type { AgentRunObservation, MemoryInjectionObservation, PromptObservation } from '../promptObservability';
import { SKILL_CONTRIBUTION_PREFIX, summarizeInjectionContributions } from '../contributionStats';

function injection(overrides: Partial<MemoryInjectionObservation> = {}): MemoryInjectionObservation {
  return {
    entryIds: [],
    ...overrides,
  };
}

function run(overrides: Partial<AgentRunObservation> = {}): AgentRunObservation {
  return {
    type: 'agent_run',
    traceId: `run_${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.parse('2026-09-28T12:00:00Z'),
    eventCounts: {},
    toolCalls: [],
    reasoningChars: 0,
    outputChars: 0,
    ...overrides,
  };
}

describe('summarizeInjectionContributions', () => {
  it('slices completed/failed runs per entry id and per skill name', () => {
    const records: PromptObservation[] = [
      run({
        memoryInjection: injection({ entryIds: ['m1', 'm2'], skills: ['auto-deploy'] }),
        outcome: { isComplete: true, interrupted: false },
      }),
      run({
        memoryInjection: injection({ entryIds: ['m1'], skills: ['auto-deploy'] }),
        outcome: { isComplete: false, interrupted: true },
      }),
      run({
        memoryInjection: injection({ entryIds: ['m3'] }),
        outcome: { isComplete: true, interrupted: false },
      }),
    ];
    const slices = summarizeInjectionContributions(records);
    expect(slices.get('m1')).toMatchObject({ runs: 2, completions: 1, failures: 1, failureRate: 0.5 });
    expect(slices.get('m2')).toMatchObject({ runs: 1, completions: 1, failures: 0 });
    expect(slices.get('m3')).toMatchObject({ runs: 1, completions: 1, failures: 0 });
    const skill = slices.get(`${SKILL_CONTRIBUTION_PREFIX}auto-deploy`);
    expect(skill).toMatchObject({ runs: 2, completions: 1, failures: 1, failureRate: 0.5 });
  });

  it('treats pre-attribution records (no memoryInjection) as no data, never zero', () => {
    const records: PromptObservation[] = [
      run({ outcome: { isComplete: true, interrupted: false } }),
      run({ memoryInjection: injection({ entryIds: ['m1'] }), outcome: { isComplete: false, interrupted: false } }),
    ];
    const slices = summarizeInjectionContributions(records);
    expect(slices.size).toBe(1);
    expect(slices.get('m1')).toMatchObject({ runs: 1, completions: 0, failures: 1, failureRate: 1 });
  });

  it('skips runs without an outcome verdict', () => {
    const records: PromptObservation[] = [
      run({ memoryInjection: injection({ entryIds: ['m1'] }) }),
      run({ memoryInjection: injection({ entryIds: ['m1'] }), outcome: { isComplete: true, interrupted: false } }),
    ];
    const slices = summarizeInjectionContributions(records);
    expect(slices.get('m1')).toMatchObject({ runs: 1, completions: 1, failures: 0 });
  });

  it('counts nothing when the memory fragment lost the token budget (injected: false)', () => {
    const records: PromptObservation[] = [
      run({
        memoryInjection: injection({ entryIds: ['m1'], skills: ['auto-deploy'], injected: false }),
        outcome: { isComplete: true, interrupted: false },
      }),
    ];
    expect(summarizeInjectionContributions(records).size).toBe(0);
  });

  it('tracks lastRunAt as the max startedAt across attributed runs', () => {
    const early = Date.parse('2026-09-27T08:00:00Z');
    const late = Date.parse('2026-09-28T09:30:00Z');
    const records: PromptObservation[] = [
      run({ memoryInjection: injection({ entryIds: ['m1'] }), startedAt: late, outcome: { isComplete: true, interrupted: false } }),
      run({ memoryInjection: injection({ entryIds: ['m1'] }), startedAt: early, outcome: { isComplete: true, interrupted: false } }),
    ];
    expect(summarizeInjectionContributions(records).get('m1')?.lastRunAt).toBe(late);
  });

  it('deduplicates an entry id that arrives twice within one run', () => {
    const records: PromptObservation[] = [
      run({ memoryInjection: injection({ entryIds: ['m1', 'm1'] }), outcome: { isComplete: true, interrupted: false } }),
    ];
    // Harness 侧已按 id 去重；这里防御聚合端自身的 double-count。
    expect(summarizeInjectionContributions(records).get('m1')).toMatchObject({ runs: 1 });
  });
});
