import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FilePromptObservationStore } from '../FilePromptObservationStore';
import { InMemoryPromptObservationStore, parsePromptObservations, PromptObservability } from '../promptObservability';
import type { EngineEvent } from '../types';

describe('PromptObservability', () => {
  it('stores prompt and tool observations without raw content', () => {
    const observability = new PromptObservability({}, new InMemoryPromptObservationStore());
    const traceId = observability.recordAssembly({
      sessionId: 'session-1',
      surface: 'cli',
      provider: 'test',
      model: 'model',
      systemPrompt: 'Authorization: Bearer super-secret-token',
      userPrompt: 'password=hunter2',
      promptVersion: 'prompt_test',
      budget: {
        contextWindowTokens: 1000,
        outputReserveTokens: 100,
        safetyMarginTokens: 20,
        availableInputTokens: 880,
        estimatedInputTokens: 20,
        estimatedToolTokens: 0,
        includedFragmentIds: ['system_core'],
        omittedFragmentIds: [],
        overBudget: false,
      },
    });
    const runId = observability.startRun({ sessionId: 'session-1' });
    const toolEvent: EngineEvent = {
      type: 'ToolResult',
      timestamp: Date.now(),
      payload: {
        toolName: 'read_file',
        duration: 4,
        toolCallId: 'call-1',
        result: {
          id: 'call-1',
          toolName: 'read_file',
          success: true,
          result: 'secret=top-secret',
          duration: 4,
        },
      },
    };
    observability.recordEvent(runId, toolEvent);
    observability.finishRun(runId);

    const serialized = observability.toJsonl();
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('top-secret');
    expect(serialized).toContain(traceId);
    expect(observability.records()).toHaveLength(2);
  });

  it('redacts verification summaries, commands, and output while retaining hashes and status', () => {
    const observability = new PromptObservability();
    const traceId = observability.startRun();
    const event: EngineEvent = {
      type: 'Completed',
      timestamp: Date.now(),
      payload: {
        finalOutput: 'done',
        isComplete: true,
        interrupted: false,
        turnCount: 1,
        verification: {
          status: 'failed',
          evidence: [{
            id: 'check-1',
            checkName: 'tests',
            status: 'failed',
            summary: 'API_KEY=hidden',
            command: 'bun test --token hidden',
            output: 'private failure output',
            source: 'command',
            timestamp: Date.now(),
          }],
        },
      },
    };
    observability.recordEvent(traceId, event);
    observability.finishRun(traceId);

    const record = observability.records().find((item) => item.type === 'agent_run');
    expect(record?.type).toBe('agent_run');
    if (record?.type === 'agent_run') {
      expect(record.verification?.status).toBe('failed');
      expect(record.verification?.evidence[0].summary.hash).toBeDefined();
      expect(record.verification?.evidence[0].command?.hash).toBeDefined();
      expect(record.verification?.evidence[0].output?.hash).toBeDefined();
    }
    expect(observability.toJsonl()).not.toContain('API_KEY=hidden');
    expect(observability.toJsonl()).not.toContain('private failure output');
  });

  it('writes the provider cache split onto the run record as a marker (8.3)', () => {
    const observability = new PromptObservability();
    const traceId = observability.startRun();
    const event: EngineEvent = {
      type: 'Completed',
      timestamp: Date.now(),
      payload: {
        finalOutput: 'done',
        isComplete: true,
        interrupted: false,
        turnCount: 1,
        usage: { promptTokens: 850, completionTokens: 20, cacheHitTokens: 700, cacheMissTokens: 150 },
      },
    };
    observability.recordEvent(traceId, event);
    observability.finishRun(traceId);

    const record = observability.records().find((item) => item.type === 'agent_run');
    if (record?.type !== 'agent_run') throw new Error('missing agent_run record');
    // 700 / 850 = 82.35… → one decimal.
    expect(record.cache).toEqual({ hitTokens: 700, missTokens: 150, hitRate: 82.4 });
  });

  it('omits the cache marker when the provider reports no split, and nulls the rate on an empty one', () => {
    const observability = new PromptObservability();

    const noCacheRun = observability.startRun();
    observability.recordEvent(noCacheRun, {
      type: 'Completed',
      timestamp: Date.now(),
      payload: { finalOutput: '', isComplete: true, interrupted: false, turnCount: 1, usage: { promptTokens: 10, completionTokens: 5 } },
    });
    observability.finishRun(noCacheRun);

    const emptySplitRun = observability.startRun();
    observability.recordEvent(emptySplitRun, {
      type: 'Completed',
      timestamp: Date.now(),
      payload: { finalOutput: '', isComplete: true, interrupted: false, turnCount: 1, usage: { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 0 } },
    });
    observability.finishRun(emptySplitRun);

    const runs = observability.records().filter((record) => record.type === 'agent_run');
    expect(runs).toHaveLength(2);
    if (runs[0].type === 'agent_run' && runs[1].type === 'agent_run') {
      expect(runs[0].cache).toBeUndefined();
      expect(runs[1].cache).toEqual({ hitRate: null });
    }
  });

  it('correlates a Harness run with the matching assembly trace', () => {
    const observability = new PromptObservability();
    const systemPrompt = 'system';
    const userPrompt = 'user';
    const assemblyTrace = observability.recordAssembly({
      sessionId: 'session-correlated',
      systemPrompt,
      userPrompt,
      promptVersion: 'prompt_test',
      budget: {
        contextWindowTokens: 100,
        outputReserveTokens: 10,
        safetyMarginTokens: 5,
        availableInputTokens: 85,
        estimatedInputTokens: 2,
        estimatedToolTokens: 0,
        includedFragmentIds: [],
        omittedFragmentIds: [],
        overBudget: false,
      },
    });
    const runTrace = observability.startRun({
      traceId: observability.findAssemblyTrace({ sessionId: 'session-correlated', systemPrompt, userPrompt }),
    });
    expect(runTrace).toBe(assemblyTrace);
    observability.finishRun(runTrace);
    expect(observability.records().filter((record) => record.type !== 'advice_applied' && record.traceId === assemblyTrace)).toHaveLength(2);
  });

  it('can be disabled without changing trace ids or retaining records', () => {
    const observability = new PromptObservability({ enabled: false });
    const traceId = observability.startRun({ sessionId: 'disabled' });
    observability.finishRun(traceId, { isComplete: true, interrupted: false });
    expect(traceId).toMatch(/^run_/);
    expect(observability.records()).toEqual([]);
  });

  it('persists bounded JSONL records and ignores a corrupt line', async () => {
    const directory = await mkdtemp('/tmp/pure-observability-test-');
    try {
      const path = join(directory, 'traces.jsonl');
      const store = new FilePromptObservationStore(path, 2);
      await writeFile(path, '{not-json}\\n', 'utf8');
      const observability = new PromptObservability({}, store);
      for (let index = 0; index < 3; index++) {
        const traceId = observability.startRun({ sessionId: `s-${index}` });
        observability.finishRun(traceId);
      }
      expect(store.list()).toHaveLength(2);
      expect(store.list().every((record) => record.type === 'agent_run')).toBe(true);
      expect(observability.records().every((record) => record.type !== 'prompt_assembly' || !JSON.stringify(record).includes('{not-json}'))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('compacts the file once the size budget is exceeded, keeping recent records', async () => {
    const directory = await mkdtemp('/tmp/pure-observability-rotate-');
    try {
      const path = join(directory, 'traces.jsonl');
      // 1-byte budget → every append after the first trips the compacting pass.
      const store = new FilePromptObservationStore(path, 2, 1);
      for (let index = 0; index < 4; index++) {
        store.append({ type: 'agent_run', traceId: `run-${index}`, startedAt: Date.now(), eventCounts: {}, toolCalls: [], reasoningChars: 0, outputChars: 0 });
      }
      const retained = store.list();
      expect(retained.filter((record) => record.type !== 'advice_applied').map((record) => record.traceId)).toEqual(['run-2', 'run-3']);
      expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds stored records and clears active runs', () => {
    const store = new InMemoryPromptObservationStore(2);
    const observability = new PromptObservability({}, store);
    for (let index = 0; index < 3; index++) {
      const traceId = observability.startRun();
      observability.finishRun(traceId);
    }
    expect(observability.records()).toHaveLength(2);
    observability.clear();
    expect(observability.records()).toEqual([]);
  });

  it('mirrors every persisted record to the sink (E0.1 durability)', () => {
    const sunk: string[] = [];
    const observability = new PromptObservability({ sink: { append: (record) => { if (record.type !== 'advice_applied') sunk.push(record.traceId); } } });
    const assemblyTrace = observability.recordAssembly({
      sessionId: 's',
      systemPrompt: 'system',
      promptVersion: 'prompt_test',
      budget: {
        contextWindowTokens: 100, outputReserveTokens: 10, safetyMarginTokens: 5, availableInputTokens: 85,
        estimatedInputTokens: 2, estimatedToolTokens: 0, includedFragmentIds: [], omittedFragmentIds: [], overBudget: false,
      },
    });
    const runTrace = observability.startRun({ sessionId: 's' });
    observability.finishRun(runTrace, { isComplete: true, interrupted: false });
    expect(sunk).toEqual([assemblyTrace, runTrace]);
  });

  it('keeps recording when the sink fails — persistence must not break a run', () => {
    const observability = new PromptObservability({ sink: { append: () => { throw new Error('disk on fire'); } } });
    const traceId = observability.startRun({ sessionId: 's' });
    expect(() => observability.finishRun(traceId, { isComplete: true, interrupted: false })).not.toThrow();
    expect(observability.records()).toHaveLength(1);
  });

  it('can attach and detach the sink after construction', () => {
    const sunk: string[] = [];
    const observability = new PromptObservability();
    const traceId = observability.startRun({ sessionId: 's' });
    observability.finishRun(traceId);
    observability.setSink({ append: (record) => { if (record.type !== 'advice_applied') sunk.push(record.traceId); } });
    const second = observability.startRun({ sessionId: 's' });
    observability.finishRun(second);
    observability.setSink(undefined);
    const third = observability.startRun({ sessionId: 's' });
    observability.finishRun(third);
    expect(sunk).toEqual([second]);
  });
});

describe('delegation observations (T1)', () => {
  const delegationEvent = (overrides: Record<string, unknown> = {}): EngineEvent => ({
    type: 'ToolResult',
    timestamp: Date.now(),
    payload: {
      toolName: 'researcher',
      duration: 1200,
      toolCallId: 'call-r1',
      result: {
        id: 'call-r1',
        toolName: 'researcher',
        success: true,
        duration: 1200,
        result: {
          id: 'call-r1',
          agentId: 'ag-deadbeef',
          agentName: 'researcher',
          success: true,
          output: 'findings so far'.repeat(10),
          tokensUsed: 42,
          usage: { promptTokens: 100, completionTokens: 20, cacheHitTokens: 60, cacheMissTokens: 40 },
        },
        ...overrides,
      },
    },
  } as unknown as EngineEvent);

  it('writes nothing without a predicate — pre-T1 behavior byte-identical', () => {
    const observability = new PromptObservability({}, new InMemoryPromptObservationStore());
    const run = observability.startRun();
    observability.recordEvent(run, delegationEvent());
    observability.finishRun(run);
    const record = observability.records().find((r) => r.type === 'agent_run');
    expect(record && 'delegations' in record ? record.delegations : undefined).toBeUndefined();
    expect(record && record.type === 'agent_run' ? record.toolCalls : []).toHaveLength(1);
  });

  it('lands a delegation with identity, usage split, and derived startedAt', () => {
    const observability = new PromptObservability({}, new InMemoryPromptObservationStore());
    observability.setDelegationRolePredicate((name) => name === 'researcher');
    const run = observability.startRun();
    observability.recordEvent(run, delegationEvent());
    observability.finishRun(run);
    const record = observability.records().find((r) => r.type === 'agent_run');
    expect(record && record.type === 'agent_run' ? record.delegations : undefined).toHaveLength(1);
    const delegation = record && record.type === 'agent_run' ? record.delegations![0] : undefined;
    expect(delegation?.agentId).toBe('ag-deadbeef');
    expect(delegation?.role).toBe('researcher');
    expect(delegation?.success).toBe(true);
    expect(delegation?.outputChars).toBe(150);
    expect(delegation?.usage?.cacheHitTokens).toBe(60);
    expect(delegation?.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it('records the failure path with an error kind and no output size', () => {
    const observability = new PromptObservability({}, new InMemoryPromptObservationStore());
    observability.setDelegationRolePredicate(() => true);
    const run = observability.startRun();
    observability.recordEvent(run, delegationEvent({ success: false, result: { agentId: 'ag-failed1' }, error: 'Connection reset while fetching' }));
    observability.finishRun(run);
    const record = observability.records().find((r) => r.type === 'agent_run');
    const delegation = record && record.type === 'agent_run' ? record.delegations![0] : undefined;
    expect(delegation?.success).toBe(false);
    expect(delegation?.agentId).toBe('ag-failed1');
    expect(delegation?.errorKind).toBe('network');
    expect(delegation?.outputChars).toBeUndefined();
    expect(delegation?.usage).toBeUndefined();
  });

  it('keeps a stable fallback id when the result carries no agentId', () => {
    const observability = new PromptObservability({}, new InMemoryPromptObservationStore());
    observability.setDelegationRolePredicate(() => true);
    const run = observability.startRun();
    observability.recordEvent(run, delegationEvent({ result: 'plain string result' }));
    observability.finishRun(run);
    const record = observability.records().find((r) => r.type === 'agent_run');
    const delegation = record && record.type === 'agent_run' ? record.delegations![0] : undefined;
    expect(delegation?.agentId).toMatch(/^ag-unknown-[0-9a-f]{8}$/);
  });

  it('parser keeps pre-T1 records (no delegations field) readable', () => {
    const jsonl = JSON.stringify({ type: 'agent_run', traceId: 'old', startedAt: 1, eventCounts: {}, toolCalls: [], reasoningChars: 0, outputChars: 0 });
    const parsed = parsePromptObservations(jsonl);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.type === 'agent_run' ? parsed[0]!.delegations : undefined).toBeUndefined();
  });
});

describe('parsePromptObservations (E4.2 shared reader)', () => {
  it('keeps only readable run/assembly lines and skips garbage', () => {
    const jsonl = [
      JSON.stringify({ type: 'agent_run', traceId: 'a', startedAt: 1, eventCounts: {}, toolCalls: [], reasoningChars: 0, outputChars: 0 }),
      '{not-json}',
      '',
      JSON.stringify({ type: 'prompt_assembly', traceId: 'b', timestamp: 2 }),
      JSON.stringify({ type: 'something_else', traceId: 'c' }),
    ].join('\n');
    expect(parsePromptObservations(jsonl).filter((record) => record.type !== 'advice_applied').map((record) => record.traceId)).toEqual(['a', 'b']);
  });

  it('reads advice_applied records through (13.1) and still skips unknown types', () => {
    const jsonl = [
      JSON.stringify({ type: 'advice_applied', appliedAt: 10, kind: 'skill-gate', target: 'researcher', detail: 'web-research', evidence: { delegations: 4, failures: 3, failureRate: 75 } }),
      JSON.stringify({ type: 'advice_applied', appliedAt: 20, kind: 'tool-note', target: 'web_fetch' }),
      JSON.stringify({ type: 'advice_applied_noth', appliedAt: 30 }),
    ].join('\n');
    const parsed = parsePromptObservations(jsonl);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ type: 'advice_applied', kind: 'skill-gate', target: 'researcher', detail: 'web-research' });
    expect(parsed[1]).toMatchObject({ type: 'advice_applied', kind: 'tool-note', target: 'web_fetch' });
  });

  it('returns nothing for an empty dump', () => {
    expect(parsePromptObservations('')).toEqual([]);
    expect(parsePromptObservations('\n\n')).toEqual([]);
  });
});
