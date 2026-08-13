// src/harness/__tests__/Harness.test.ts
// P1-7 — resume: run() must feed checkpoint messages as the initial context
// (previously loaded messages were only reused for checkpoint saving, so
// --resume runs restarted from a blank [system, user] context).

import { describe, it, expect } from 'bun:test';
import { Harness } from '../Harness';
import { PromptAssembler } from '../../shared/PromptAssembler';
import { DefaultHookRouter } from '../../engine/HookRouter';
import { DefaultFailurePolicy } from '../../engine/FailurePolicy';
import type {
  AgentLoopState,
  BudgetConfig,
  Checkpoint,
  EngineEvent,
  FailureRecord,
  IMemoryStore,
  IStateStore,
  LLMAdapter,
  LLMChunk,
  MemoryEntry,
  Message,
  ToolAdapter,
  ToolResult,
} from '../../shared/types';

const STD_BUDGET: BudgetConfig = {
  maxTurns: 30,
  maxTotalTokens: 200_000,
  maxExecutionTime: 600_000,
  warningThreshold: 0.8,
  graceTurns: 3,
};

// ── In-memory state store ──

class MemoryStore implements IStateStore {
  private sessions = new Map<string, { state: AgentLoopState; checkpoints: Checkpoint[] }>();

  loadSession(sessionId: string): { state: AgentLoopState; checkpoints: Checkpoint[] } | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.checkpoints.push(checkpoint);
      existing.state = checkpoint.state;
    } else {
      this.sessions.set(sessionId, { state: checkpoint.state, checkpoints: [checkpoint] });
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

// ── Recording mock LLM: captures every messages array it is streamed ──

function recordingLLM(finalText: string): LLMAdapter & { received: Message[][] } {
  const received: Message[][] = [];
  return {
    received,
    stream: async function* (messages: Message[]): AsyncGenerator<LLMChunk, void, void> {
      received.push(messages.map(m => ({ ...m })));
      yield { type: 'content', content: finalText };
      yield { type: 'done', content: finalText, toolCalls: [] };
    },
    complete: async () => ({ content: finalText, toolCalls: [] }),
  };
}

const roles = (msgs: Message[]) => msgs.map(m => m.role);
const contents = (msgs: Message[]) => msgs.map(m => m.content);

async function collect(gen: AsyncGenerator<EngineEvent, void, void>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

// ── In-memory IMemoryStore for memory integration tests ──

class FakeMemoryStore implements IMemoryStore {
  entries: MemoryEntry[] = [];
  decayCalls = 0;
  async add(entry: Omit<MemoryEntry, 'id'>): Promise<string> {
    const id = `mem_${this.entries.length}`;
    this.entries.push({ ...entry, id, decayScore: 1 });
    return id;
  }
  async search(query: string, opts?: { type?: MemoryEntry['type']; k?: number; projectPath?: string }): Promise<MemoryEntry[]> {
    const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    return this.entries
      .filter(e => (opts?.projectPath === undefined || e.projectPath === opts.projectPath))
      .filter(e => (opts?.type === undefined || e.type === opts.type))
      .filter(e => tokens.some(t => e.content.toLowerCase().includes(t)))
      .slice(0, opts?.k ?? 5);
  }
  async forget(sessionId: string): Promise<void> {
    this.entries = this.entries.filter(e => e.sessionId !== sessionId);
  }
  async decay(_olderThan: number): Promise<void> {
    this.decayCalls++;
  }
  async recordHits(entries: MemoryEntry[]): Promise<void> {
    const byId = new Map(this.entries.map(e => [e.id, e]));
    for (const e of entries) {
      const t = byId.get(e.id);
      if (t) {
        t.hitCount = (t.hitCount ?? 0) + 1;
        t.lastUsedAt = Date.now();
      }
    }
  }
}

describe('Harness cross-session memory (v0.10)', () => {
  it('uses the shared PromptAssembler for retrieved context', async () => {
    const memStore = new FakeMemoryStore();
    await memStore.add({
      type: 'user_preference',
      content: 'Use the shared assembler path',
      timestamp: Date.now(),
      sessionId: 'old-session',
      projectPath: '/ws',
    });
    class RecordingAssembler extends PromptAssembler {
      calls = 0;
      override composeMemoryPrompt(input: Parameters<PromptAssembler['composeMemoryPrompt']>[0]): string {
        this.calls++;
        return super.composeMemoryPrompt(input);
      }
    }
    const assembler = new RecordingAssembler();
    const llm = recordingLLM('answer');
    const harness = new Harness({
      sessionId: 'sess-shared-assembler',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
      promptAssembler: assembler,
    });

    await collect(harness.run('BASE SYSTEM', 'use the shared assembler path'));

    expect(assembler.calls).toBe(1);
    expect(llm.received[0][0].content).toContain('Use the shared assembler path');
  });

  it('injects a runtime strategy through Harness even without a memory store', async () => {
    const llm = recordingLLM('answer');
    const harness = new Harness({
      sessionId: 'sess-adaptive',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      projectPath: '/ws',
    });

    await collect(harness.run('BASE SYSTEM', 'inspect the project'));

    expect(llm.received[0][0].content).toContain('<adaptive_strategy>');
    expect(llm.received[0][0].content).toContain('Runtime-selected strategy');
  });

  it('injects relevant memories into the system prompt at session start', async () => {
    const memStore = new FakeMemoryStore();
    await memStore.add({
      type: 'user_preference',
      content: 'User prefers the TypeScript language',
      timestamp: Date.now(),
      sessionId: 'old-session',
      projectPath: '/ws',
    });
    await memStore.add({
      type: 'error_pattern',
      content: 'Error TS2307 fixed by adding missing import',
      timestamp: Date.now(),
      sessionId: 'old-session',
      projectPath: '/ws',
    });

    const llm = recordingLLM('answer');
    const harness = new Harness({
      sessionId: 'sess-mem',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    await collect(harness.run('BASE SYSTEM', 'fix the TS error in my project'));

    const sys = llm.received[0][0].content;
    expect(sys).toContain('BASE SYSTEM');
    expect(sys).toContain('<session_memory>');
    expect(sys).toContain('User prefers the TypeScript language');
    expect(sys).toContain('Error TS2307 fixed by adding missing import');
    expect(llm.received[0].length).toBeGreaterThanOrEqual(2); // system + user
  });

  it('writes a successful_pattern when a session completes', async () => {
    const memStore = new FakeMemoryStore();
    const llm = recordingLLM('final output here');
    const harness = new Harness({
      sessionId: 'sess-mem2',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    await collect(harness.run('SYS', 'refactor auth module'));

    const written = memStore.entries.filter(e => e.type === 'successful_pattern');
    expect(written).toHaveLength(1);
    expect(written[0].projectPath).toBe('/ws');
    expect(written[0].sessionId).toBe('sess-mem2');
    expect(written[0].content).toContain('refactor auth module');
    expect(written[0].content).toContain('No project-level verification evidence was recorded');
    expect(written[0].lesson?.symptom).toContain('refactor auth module');
    expect(written[0].lesson?.verification).toContain('No project-level verification evidence was recorded');
    expect(memStore.entries.filter(e => e.type === 'procedure')).toHaveLength(0);
  });

  it('promotes the adaptive strategy only when structured verification passes', async () => {
    const memStore = new FakeMemoryStore();
    const llm = recordingLLM('verified output');
    const harness = new Harness({
      sessionId: 'sess-verified-strategy',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
      verifier: {
        evaluate: async () => ({
          passed: true,
          evidence: [{
            id: 'check-1',
            checkName: 'focused check',
            status: 'passed',
            summary: 'focused check passed',
            source: 'command',
            timestamp: Date.now(),
          }],
        }),
      },
    });

    await collect(harness.run('SYS', 'learn from the verified change'));

    expect(memStore.entries.filter(e => e.type === 'procedure')).toHaveLength(1);
    expect(memStore.entries.find(e => e.type === 'procedure')?.content).toContain('Runtime strategy selected from live signals');
  });

  it('does not duplicate a lesson when the same prompt is completed twice in one session', async () => {
    const memStore = new FakeMemoryStore();
    const llm = recordingLLM('same answer');
    const harness = new Harness({
      sessionId: 'sess-dedupe',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    const first = await collect(harness.run('SYS', 'same task'));
    const completed = first.find(e => e.type === 'Completed');
    expect(completed?.payload.messages).toBeDefined();
    await collect(harness.continueTurn('SYS', completed!.payload.messages!, 'same task'));

    expect(memStore.entries.filter(e => e.type === 'successful_pattern')).toHaveLength(1);
  });

  it('does not inject memory when no store is configured', async () => {
    const llm = recordingLLM('plain answer');
    const harness = new Harness({
      sessionId: 'sess-nomem',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
    });
    await collect(harness.run('SYS', 'hello'));
    expect(llm.received[0][0].content).toContain('SYS');
    expect(llm.received[0][0].content).toContain('<adaptive_strategy>');
    expect(llm.received[0][0].content).not.toContain('User prefers');
    expect(llm.received[0][0].content).not.toContain('Known error patterns:');
  });

  it('throttles memory decay to once per interval even across turns (v0.13)', async () => {
    const memStore = new FakeMemoryStore();
    const llm = recordingLLM('answer');
    const harness = new Harness({
      sessionId: 'sess-decay',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    // Two runs in quick succession (well inside the hourly window) must not
    // decay twice — decay() scans every project's memory file on disk, so the
    // throttle keeps the per-turn overhead at zero for back-to-back turns.
    await collect(harness.run('BASE SYSTEM', 'first turn'));
    await collect(harness.run('BASE SYSTEM', 'second turn'));

    expect(memStore.decayCalls).toBe(1);
  });

  it('writes an error_pattern when the failure policy stops the session (§12.3)', async () => {
    const memStore = new FakeMemoryStore();
    const failingLLM: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        throw new Error('model overloaded');
      },
      complete: async () => { throw new Error('model overloaded'); },
    };
    const stopPolicy = {
      decide: () => ({ kind: 'stop' as const, reason: 'too many failures, giving up' }),
    };
    const harness = new Harness({
      sessionId: 'sess-stop',
      llm: failingLLM,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
      failurePolicy: stopPolicy,
    });

    const events = await collect(harness.run('SYS', 'do the thing'));
    expect(events.find(e => e.type === 'Interrupted')).toBeDefined();

    const patterns = memStore.entries.filter(e => e.type === 'error_pattern');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].content).toContain('model overloaded');
    expect(patterns[0].content).toContain('too many failures');
    expect(patterns[0].sessionId).toBe('sess-stop');
    expect(patterns[0].projectPath).toBe('/ws');
  });

  it('writes an error_pattern when a retried failure is eventually overcome (§12.3)', async () => {
    const memStore = new FakeMemoryStore();
    let calls = 0;
    const flakyLLM: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        calls++;
        if (calls === 1) throw new Error('transient tool auth failure');
        yield { type: 'content', content: 'done it' };
        yield { type: 'done', content: 'done it', toolCalls: [] };
      },
      complete: async () => ({ content: 'done it', toolCalls: [] }),
    };
    const retryPolicy = {
      decide: () => ({ kind: 'retry' as const, hint: 'try again' }),
    };
    const harness = new Harness({
      sessionId: 'sess-retry',
      llm: flakyLLM,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
      failurePolicy: retryPolicy,
    });

    const events = await collect(harness.run('SYS', 'deploy it'));
    const completed = events.find(e => e.type === 'Completed');
    expect(completed?.payload.isComplete).toBe(true);

    // successful_pattern (session completed) + error_pattern (retry overcame it)
    const patterns = memStore.entries.filter(e => e.type === 'error_pattern');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].content).toContain('transient tool auth failure');
    expect(patterns[0].content).toContain('Recovered after retry');
    expect(memStore.entries.some(e => e.type === 'successful_pattern')).toBe(true);
  });

  it('writes an error_pattern mid-session when the SAME call fails repeatedly (v0.11)', async () => {
    const memStore = new FakeMemoryStore();
    // The tool keeps failing with the SAME message (e.g. web_fetch content
    // type). The repeated-error policy stops after 3 identical repeats; the
    // Harness must persist a "Repeated failure" error_pattern (flushed at
    // session end) so the lesson survives even an interrupted session.
    const failTool: ToolAdapter = {
      execute: async (): Promise<ToolResult> => ({
        id: 'call_1',
        toolName: 'web_fetch',
        error: 'Unsupported content type: application/json',
        success: false,
        duration: 3,
      }),
      getMetadata: () => ({ isWrite: false }),
      getTools: () => [{ name: 'web_fetch', description: 'fetch', input_schema: {} }],
    };
    let call = 0;
    const repeatToolLLM: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        call++;
        if (call <= 3) {
          const tc = { id: `call_${call}`, index: 0, function: { name: 'web_fetch', arguments: '{"url":"https://x/api"}' } };
          yield { type: 'tool_call', index: 0, id: tc.id, name: 'web_fetch', arguments: tc.function.arguments };
          yield { type: 'done', content: '', toolCalls: [tc] };
        } else {
          yield { type: 'content', content: 'final answer' };
          yield { type: 'done', content: 'final answer', toolCalls: [] };
        }
      },
      complete: async () => ({ content: 'final answer', toolCalls: [] }),
    };
    const harness = new Harness({
      sessionId: 'sess-repeat',
      llm: repeatToolLLM,
      tools: failTool,
      toolsDefs: [{ name: 'web_fetch', description: 'fetch', input_schema: {} }],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
      failurePolicy: new DefaultFailurePolicy(),
    });

    const events = await collect(harness.run('SYS', 'get the data'));
    // Policy stops after 3 identical repeats → session interrupted.
    expect(events.find(e => e.type === 'Interrupted')).toBeDefined();

    const repeated = memStore.entries.filter(e => e.type === 'error_pattern' && e.content.includes('Repeated failure'));
    // pendingRepeats guarantees exactly one "Repeated failure" memory per failure key.
    expect(repeated).toHaveLength(1);
    expect(repeated[0].content).toContain('Unsupported content type');
    expect(repeated[0].content).toContain('web_fetch');
    expect(repeated[0].content).toContain('Do not make this exact call again');
    expect(repeated[0].projectPath).toBe('/ws');
  });

  it('skips the do-not-retry memory when a repeated failure is later overcome (v0.12 transient exemption)', async () => {
    const memStore = new FakeMemoryStore();
    // The SAME web_fetch call fails twice with the identical error (which
    // would normally write a "Repeated failure: ... Do not make this exact
    // call again" memory) but the 3rd retry SUCCEEDS — a transient fault, not
    // a dead-end. The Harness must NOT persist the "勿重试" memory; only the
    // "Recovered after retry" error_pattern remains.
    let attempts = 0;
    const transientTool: ToolAdapter = {
      execute: async (): Promise<ToolResult> => {
        attempts++;
        if (attempts <= 2) {
          return { id: `call_${attempts}`, toolName: 'web_fetch', error: 'Unsupported content type: application/json', success: false, duration: 3 };
        }
        return { id: `call_${attempts}`, toolName: 'web_fetch', result: '{"data":"ok"}', success: true, duration: 3 };
      },
      getMetadata: () => ({ isWrite: false }),
      getTools: () => [{ name: 'web_fetch', description: 'fetch', input_schema: {} }],
    };
    let call = 0;
    const transientLLM: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        call++;
        if (call <= 3) {
          const tc = { id: `call_${call}`, index: 0, function: { name: 'web_fetch', arguments: '{"url":"https://x/api"}' } };
          yield { type: 'tool_call', index: 0, id: tc.id, name: 'web_fetch', arguments: tc.function.arguments };
          yield { type: 'done', content: '', toolCalls: [tc] };
        } else {
          yield { type: 'content', content: 'final answer' };
          yield { type: 'done', content: 'final answer', toolCalls: [] };
        }
      },
      complete: async () => ({ content: 'final answer', toolCalls: [] }),
    };
    const harness = new Harness({
      sessionId: 'sess-transient',
      llm: transientLLM,
      tools: transientTool,
      toolsDefs: [{ name: 'web_fetch', description: 'fetch', input_schema: {} }],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
      failurePolicy: new DefaultFailurePolicy(),
    });

    const events = await collect(harness.run('SYS', 'get the data'));
    const completed = events.find(e => e.type === 'Completed');
    expect(completed?.payload.isComplete).toBe(true);

    // No "勿重试" memory: the 3rd retry succeeded → transient fault, not a dead-end.
    const repeated = memStore.entries.filter(e => e.type === 'error_pattern' && e.content.includes('Repeated failure'));
    expect(repeated).toHaveLength(0);
    // Only the "Recovered after retry" memory remains.
    const recovered = memStore.entries.filter(e => e.type === 'error_pattern' && e.content.includes('Recovered after retry'));
    expect(recovered).toHaveLength(1);
    expect(recovered[0].content).toContain('Unsupported content type');
    expect(recovered[0].content).toContain('web_fetch');
  });

  it('does NOT write a retry error_pattern when the session ends interrupted', async () => {
    const memStore = new FakeMemoryStore();
    // First call fails (policy retries), second call ALSO fails but the policy
    // now stops → session interrupted → no "recovered" memory.
    let calls = 0;
    const alwaysFailLLM: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        calls++;
        throw new Error(`failure #${calls}`);
      },
      complete: async () => { throw new Error('failure'); },
    };
    const escalatePolicy = {
      decide: (failures: FailureRecord[]) =>
        failures.length >= 2
          ? ({ kind: 'stop' as const, reason: 'giving up' })
          : ({ kind: 'retry' as const, hint: 'try again' }),
    };
    const harness = new Harness({
      sessionId: 'sess-int',
      llm: alwaysFailLLM,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
      failurePolicy: escalatePolicy,
    });

    await collect(harness.run('SYS', 'retry me'));

    // The retry failure should NOT produce a "recovered" error_pattern because
    // the session never succeeded — only the stop decision writes one.
    const recovered = memStore.entries.filter(e => e.type === 'error_pattern' && e.content.includes('Recovered after retry'));
    expect(recovered).toHaveLength(0);
    const stopped = memStore.entries.filter(e => e.type === 'error_pattern' && e.content.includes('Stopped by failure policy'));
    expect(stopped).toHaveLength(1);
  });
});

describe('Harness resume (P1-7)', () => {
  it('feeds the checkpoint history as initial context on resume', async () => {
    const store = new MemoryStore();
    // Pre-populate a checkpoint: old system message + conversation history
    await store.saveCheckpoint('sess-resume', {
      version: 0,
      label: 'turn_completed',
      state: {
        messages: [
          { role: 'system', content: 'OLD SYSTEM' },
          { role: 'user', content: 'v1' },
          { role: 'assistant', content: 'a1' },
        ],
        turnCount: 2,
      },
      createdAt: Date.now(),
    });

    const llm = recordingLLM('resumed answer');
    const harness = new Harness({
      sessionId: 'sess-resume',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      stateStore: store,
    });

    const events = await collect(harness.run('NEW SYSTEM', 'continue here'));

    expect(events.find(e => e.type === 'Completed')).toBeDefined();
    expect(llm.received).toHaveLength(1);

    const msgs = llm.received[0];
    // Current system prompt swapped in, history preserved, new prompt appended
    expect(contents(msgs)[0]).toContain('NEW SYSTEM');
    expect(contents(msgs)[0]).toContain('<adaptive_strategy>');
    expect(contents(msgs).slice(1)).toEqual(['v1', 'a1', 'continue here']);
  });

  it('runs fresh from [system, user] when no checkpoint exists', async () => {
    const llm = recordingLLM('fresh answer');
    const harness = new Harness({
      sessionId: 'sess-fresh',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      stateStore: new MemoryStore(),
    });

    const events = await collect(harness.run('SYS', 'hello'));

    expect(events.find(e => e.type === 'Completed')).toBeDefined();
    expect(llm.received).toHaveLength(1);
    expect(contents(llm.received[0])[0]).toContain('SYS');
    expect(contents(llm.received[0])[0]).toContain('<adaptive_strategy>');
    expect(contents(llm.received[0]).slice(1)).toEqual(['hello']);
  });

  it('replaces the checkpoint system message with the current systemPrompt', async () => {
    const store = new MemoryStore();
    await store.saveCheckpoint('sess-sys', {
      version: 0,
      label: 'turn_completed',
      state: {
        messages: [
          { role: 'system', content: 'STALE instructions' },
          { role: 'user', content: 'v1' },
        ],
        turnCount: 1,
      },
      createdAt: Date.now(),
    });

    const llm = recordingLLM('answer');
    const harness = new Harness({
      sessionId: 'sess-sys',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      stateStore: store,
    });

    await collect(harness.run('FRESH instructions + memory', 'next'));

    const msgs = llm.received[0];
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('FRESH instructions + memory');
    expect(msgs[0].content).toContain('<adaptive_strategy>');
    expect(msgs[1]).toEqual({ role: 'user', content: 'v1' });
    // No stale system message remains anywhere in the history
    expect(contents(msgs).filter(c => c === 'STALE instructions')).toHaveLength(0);
  });

  it('prepends a system message when the checkpoint history has none', async () => {
    const store = new MemoryStore();
    await store.saveCheckpoint('sess-nosys', {
      version: 0,
      label: 'turn_completed',
      state: {
        messages: [
          { role: 'user', content: 'v1' },
          { role: 'assistant', content: 'a1' },
        ],
        turnCount: 2,
      },
      createdAt: Date.now(),
    });

    const llm = recordingLLM('answer');
    const harness = new Harness({
      sessionId: 'sess-nosys',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      stateStore: store,
    });

    await collect(harness.run('SYS v2', 'next'));

    const msgs = llm.received[0];
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('SYS v2');
    expect(msgs[0].content).toContain('<adaptive_strategy>');
    expect(contents(msgs).slice(1)).toEqual(['v1', 'a1', 'next']);
  });

  it('saves an interrupted checkpoint with live messages (P0 fix)', async () => {
    const store = new MemoryStore();
    const llm = recordingLLM('partial answer');
    const harness = new Harness({
      sessionId: 'sess-int',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      stateStore: store,
    });

    const controller = new AbortController();
    controller.abort(); // abort before the run starts

    const events = await collect(harness.run('SYS', 'hello', controller.signal));

    expect(events.find(e => e.type === 'Interrupted')).toBeDefined();
    const session = store.loadSession('sess-int');
    expect(session).not.toBeNull();
    const cp = session!.checkpoints.find(c => c.label === 'interrupted');
    expect(cp).toBeDefined();
    // Live messages (system + user) persisted, not an empty array.
    expect(cp!.state.messages.length).toBeGreaterThanOrEqual(2);
    expect(cp!.state.messages[1]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('trims trailing unresolved toolCalls from interrupted checkpoint', async () => {
    const store = new MemoryStore();
    // LLM yields a tool call on the first turn; a before_act hook then aborts
    // the run — leaving the assistant toolCalls message without tool results.
    const toolLLM: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        yield { type: 'tool_call', index: 0, id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' };
        yield { type: 'done', content: '', toolCalls: [{ id: 'call_1', index: 0, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] };
      },
      complete: async () => ({ content: '', toolCalls: [] }),
    };
    const tools = {
      execute: async (): Promise<any> => ({ id: 'call_1', toolName: 'read_file', result: 'x', success: true, duration: 1 }),
      getMetadata: () => ({ isWrite: false }),
      getTools: () => [{ name: 'read_file', description: 'r', input_schema: {} }],
    };
    const hooks = new DefaultHookRouter();
    hooks.register('before_act', () => ({ action: 'abort' as const, reason: 'test abort' }));
    const harness = new Harness({
      sessionId: 'sess-int2',
      llm: toolLLM,
      tools,
      toolsDefs: [{ name: 'read_file', description: 'r', input_schema: {} }],
      budget: STD_BUDGET,
      stateStore: store,
      hooks,
    });

    const events = await collect(harness.run('SYS', 'read a.ts'));
    expect(events.find(e => e.type === 'Interrupted')).toBeDefined();

    const session = store.loadSession('sess-int2');
    expect(session).not.toBeNull();
    const cp = session!.checkpoints.find(c => c.label === 'interrupted');
    expect(cp).toBeDefined();
    const last = cp!.state.messages[cp!.state.messages.length - 1];
    // No trailing assistant message with dangling toolCalls survived the trim.
    expect(last.role === 'assistant' && !!last.toolCalls?.length).toBe(false);
  });

  it('can replace a compacted engine checkpoint with the full transcript', async () => {
    const store = new MemoryStore();
    const harness = new Harness({
      sessionId: 'sess-transcript-checkpoint',
      llm: recordingLLM('answer'),
      toolsDefs: [],
      budget: STD_BUDGET,
      stateStore: store,
    });

    const compacted: Message[] = [
      { role: 'system', content: 'SYS' },
      { role: 'system', content: 'Earlier conversation summary: old' },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: 'answer' },
    ];
    const fullTranscript: Message[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old answer' },
      ...compacted.slice(2),
    ];

    await harness.saveTranscriptCheckpoint(compacted, 2);
    await harness.saveTranscriptCheckpoint(fullTranscript, 2);

    expect(store.loadSession('sess-transcript-checkpoint')?.state.messages).toEqual(fullTranscript);
  });

  it('saves a turn_completed checkpoint on completion', async () => {
    const store = new MemoryStore();
    const llm = recordingLLM('done');
    const harness = new Harness({
      sessionId: 'sess-save',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      stateStore: store,
    });

    await collect(harness.run('SYS', 'go'));

    const session = store.loadSession('sess-save');
    expect(session).not.toBeNull();
    expect(session!.checkpoints.some(cp => cp.label === 'turn_completed')).toBe(true);
    // The saved history includes the assistant reply
    const savedMsgs = session!.state.messages;
    expect(roles(savedMsgs)).toContain('assistant');
    expect(savedMsgs[savedMsgs.length - 1].content).toBe('done');
  });
});
