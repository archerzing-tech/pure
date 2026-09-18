// src/shared/__tests__/strategyEffect.test.ts
// E4.1 — the slice-ability acceptance lives here: records that carry a
// strategy must aggregate cleanly per strategy dimension and per subagent
// role; records without one must not pollute the strategy slices (but their
// delegations still count per role — role stats don't need a strategy).

import { describe, it, expect } from 'bun:test';
import type { AgentRunObservation, PromptObservation, StrategyObservation } from '../promptObservability';
import {
  summarizeByDimension,
  summarizeByRole,
  summarizeStrategyEffects,
} from '../strategyEffect';

function strategy(overrides: Partial<StrategyObservation> = {}): StrategyObservation {
  return {
    exploration: 'targeted',
    verification: 'focused',
    delegation: 'none',
    recovery: 'continue-with-evidence',
    autonomy: 'unattended-local',
    complexity: 'trivial',
    confidence: 0.5,
    intentTags: ['quick'],
    recommendedRoles: [],
    parallelRoles: [],
    priorArtHint: false,
    ...overrides,
  };
}

function run(overrides: Partial<AgentRunObservation> = {}): AgentRunObservation {
  return {
    type: 'agent_run',
    traceId: `run_${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.parse('2026-09-18T12:00:00Z'),
    eventCounts: {},
    toolCalls: [],
    reasoningChars: 0,
    outputChars: 0,
    ...overrides,
  };
}

const records: PromptObservation[] = [
  // focused / none: completed, verified, one clean tool call.
  run({
    strategy: strategy({ verification: 'focused' }),
    outcome: { isComplete: true, interrupted: false },
    verification: { status: 'passed', evidence: [] },
    toolCalls: [{ toolName: 'read_file', success: true, durationMs: 10 }],
    durationMs: 100,
  }),
  // thorough / parallel: interrupted, failed verification, one role success
  // + one failed write.
  run({
    strategy: strategy({
      verification: 'thorough',
      exploration: 'broad',
      delegation: 'parallel',
      recovery: 'switch-approach',
      complexity: 'complex',
      intentTags: ['research'],
      recommendedRoles: ['researcher'],
      parallelRoles: ['researcher'],
      priorArtHint: true,
    }),
    outcome: { isComplete: false, interrupted: true },
    verification: { status: 'failed', evidence: [] },
    toolCalls: [
      { toolName: 'researcher', success: true, durationMs: 1200 },
      { toolName: 'write_file', success: false, durationMs: 5 },
    ],
    durationMs: 3000,
  }),
  // thorough / targeted: completed, NO verification evidence, failed role call.
  run({
    strategy: strategy({ verification: 'thorough', delegation: 'targeted' }),
    outcome: { isComplete: true, interrupted: false },
    toolCalls: [{ toolName: 'researcher', success: false, durationMs: 800 }],
    durationMs: 500,
  }),
  // Pre-E4.1 record: no strategy — strategy slices must skip it, role slices
  // must still count its delegation.
  run({
    toolCalls: [{ toolName: 'researcher', success: true, durationMs: 100 }],
  }),
  // prompt_assembly records are not runs — ignored everywhere.
  {
    type: 'prompt_assembly',
    traceId: 'prompt_x',
    timestamp: Date.parse('2026-09-18T12:00:00Z'),
    promptVersion: 'prompt_abc',
    system: { chars: 10, hash: 'aaaa' },
    budget: {
      contextWindowTokens: 0,
      outputReserveTokens: 0,
      safetyMarginTokens: 0,
      availableInputTokens: 0,
      estimatedInputTokens: 0,
      estimatedToolTokens: 0,
      includedFragmentIds: [],
      omittedFragmentIds: [],
      overBudget: false,
    },
  },
];

describe('summarizeStrategyEffects', () => {
  const summary = summarizeStrategyEffects(records);

  it('aggregates the overall slice across strategy-carrying runs only', () => {
    expect(summary.overall.runs).toBe(3);
    expect(summary.overall.completed).toBe(2);
    expect(summary.overall.interrupted).toBe(1);
    expect(summary.overall.totalDurationMs).toBe(3600);
    expect(summary.overall.avgDurationMs).toBe(1200);
    expect(summary.overall.toolCalls).toBe(4);
    expect(summary.overall.toolFailures).toBe(2);
  });

  it('buckets verification into the three mutually exclusive outcomes', () => {
    expect(summary.overall.verificationPassed).toBe(1);
    expect(summary.overall.verificationFailed).toBe(1);
    expect(summary.overall.verificationAbsent).toBe(1);
  });

  it('slices by each strategy dimension, skipping records without strategy', () => {
    expect(summary.byDimension.verification.focused.runs).toBe(1);
    expect(summary.byDimension.verification.thorough.runs).toBe(2);
    expect(summary.byDimension.verification.thorough.completed).toBe(1);
    expect(summary.byDimension.delegation.none.runs).toBe(1);
    expect(summary.byDimension.delegation.parallel.runs).toBe(1);
    expect(summary.byDimension.complexity.complex.runs).toBe(1);
    expect(summary.byDimension.exploration.broad.runs).toBe(1);
    expect(summary.byDimension.recovery['switch-approach'].runs).toBe(1);
    // Buckets partition exactly: no run counted twice, none dropped.
    for (const dimension of Object.keys(summary.byDimension) as (keyof typeof summary.byDimension)[]) {
      const total = Object.values(summary.byDimension[dimension])
        .reduce((sum, slice) => sum + slice.runs, 0);
      expect(total).toBe(summary.overall.runs);
    }
  });

  it('slices per subagent role across all runs, with or without strategy', () => {
    expect(summary.byRole.researcher).toEqual({
      delegations: 3,
      successes: 2,
      totalDurationMs: 2100,
      avgDurationMs: 700,
    });
    // Ordinary tools are not roles — they never appear in byRole.
    expect(summary.byRole.read_file).toBeUndefined();
    expect(summary.byRole.write_file).toBeUndefined();
  });
});

describe('summarizeByDimension / summarizeByRole standalone', () => {
  it('returns an empty slice set for records without any strategy', () => {
    const noStrategy = [run({}), { type: 'prompt_assembly' } as PromptObservation];
    expect(summarizeByDimension(noStrategy, 'verification')).toEqual({});
    expect(summarizeByRole(noStrategy)).toEqual({});
  });

  it('omits avgDurationMs when no call carried a positive duration', () => {
    const roles = summarizeByRole([run({
      toolCalls: [{ toolName: 'researcher', success: true, durationMs: 0 }],
    })]);
    expect(roles.researcher).toEqual({ delegations: 1, successes: 1, totalDurationMs: 0 });
  });
});
