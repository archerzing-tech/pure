import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FilePromptObservationStore } from '../FilePromptObservationStore';
import { InMemoryPromptObservationStore, PromptObservability } from '../promptObservability';
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
    expect(observability.records().filter((record) => record.traceId === assemblyTrace)).toHaveLength(2);
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
});
