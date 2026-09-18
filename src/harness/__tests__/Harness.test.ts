// src/harness/__tests__/Harness.test.ts
// P1-7 — resume: run() must feed checkpoint messages as the initial context
// (previously loaded messages were only reused for checkpoint saving, so
// --resume runs restarted from a blank [system, user] context).

import { describe, it, expect } from 'bun:test';
import { Harness } from '../Harness';
import { buildTurnEvidence } from '../LessonReflector';
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
import { GLOBAL_MEMORY_SCOPE } from '../../shared/types';
import { approveToolCorrection, scanToolCorrections } from '../../adapter/memory/toolCorrections';

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
  searchCalls = 0;
  async add(entry: Omit<MemoryEntry, 'id'>): Promise<string> {
    const id = `mem_${this.entries.length}`;
    this.entries.push({ ...entry, id, decayScore: 1 });
    return id;
  }
  async search(query: string, opts?: { type?: MemoryEntry['type']; k?: number; projectPath?: string }): Promise<MemoryEntry[]> {
    this.searchCalls++;
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
  async removeById(id: string): Promise<boolean> {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.id !== id);
    return this.entries.length !== before;
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
  list(opts?: { projectPath?: string; type?: MemoryEntry['type']; platform?: string; activeOnly?: boolean }): MemoryEntry[] {
    const project = opts?.projectPath;
    return this.entries
      .filter(e => (project === undefined || e.projectPath === project))
      .filter(e => (opts?.type === undefined || e.type === opts.type))
      .filter(e => (opts?.platform === undefined || e.platform === opts.platform))
      .filter(e => !opts?.activeOnly || e.lifecycle !== 'dormant');
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
});

// ── E0.2 §2.1 — system-prompt cache freeze ──
// <session_memory> (and the adaptive directive) are composed once at run()
// and reused verbatim for every continuation: a re-searched memory block
// rewrites the system prefix mid-session and invalidates provider-side
// prompt-cache breakpoints that assume an identical system prompt.

describe('Harness system-prompt cache freeze (E0.2 §2.1)', () => {
  it('reuses the run()-composed system prompt on continueTurn instead of re-searching memory', async () => {
    const memStore = new FakeMemoryStore();
    await memStore.add({
      type: 'user_preference',
      content: 'User prefers the TypeScript language',
      timestamp: Date.now(),
      sessionId: 'old-session',
      projectPath: '/ws',
    });
    const llm = recordingLLM('first answer');
    const harness = new Harness({
      sessionId: 'sess-freeze',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    await collect(harness.run('BASE SYSTEM', 'write the module in typescript'));
    expect(memStore.searchCalls).toBe(1);
    const coldSystem = llm.received[0][0].content;

    // A session-end write lands a NEW memory the follow-up would match.
    // Pre-freeze, continueTurn re-searched and rewrote the system prompt —
    // exactly what invalidates the provider cache breakpoint.
    await memStore.add({
      type: 'error_pattern',
      content: 'typescript build fails without a tsconfig module setting',
      timestamp: Date.now(),
      sessionId: 'sess-freeze',
      projectPath: '/ws',
    });

    const messages: Message[] = [
      { role: 'system', content: coldSystem },
      { role: 'user', content: 'write the module in typescript' },
      { role: 'assistant', content: 'first answer' },
    ];
    await collect(harness.continueTurn('BASE SYSTEM', messages, 'the typescript build now fails, fix it'));

    expect(memStore.searchCalls).toBe(1); // frozen — continuation does not re-search
    expect(llm.received[1][0].content).toBe(coldSystem); // byte-identical system prompt
  });

  it('composes once on a restored session and freezes that prompt for later turns', async () => {
    const memStore = new FakeMemoryStore();
    await memStore.add({
      type: 'user_preference',
      content: 'User prefers the TypeScript language',
      timestamp: Date.now(),
      sessionId: 'old-session',
      projectPath: '/ws',
    });
    const llm = recordingLLM('restored answer');
    const harness = new Harness({
      sessionId: 'sess-freeze-restored',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    // Session restored from a checkpoint: the first continueTurn in this
    // process has no run()-composed prompt, so it composes (and freezes) one.
    const messages: Message[] = [
      { role: 'system', content: 'BASE SYSTEM' },
      { role: 'user', content: 'write the module in typescript' },
    ];
    await collect(harness.continueTurn('BASE SYSTEM', messages, 'the typescript build now fails, fix it'));
    expect(memStore.searchCalls).toBe(1);

    await memStore.add({
      type: 'error_pattern',
      content: 'typescript build fails without a tsconfig module setting',
      timestamp: Date.now(),
      sessionId: 'sess-freeze-restored',
      projectPath: '/ws',
    });
    const followUp: Message[] = [
      { role: 'system', content: llm.received[0][0].content },
      { role: 'user', content: 'write the module in typescript' },
      { role: 'assistant', content: 'restored answer' },
    ];
    await collect(harness.continueTurn('BASE SYSTEM', followUp, 'one more typescript question'));

    expect(memStore.searchCalls).toBe(1); // still frozen
    expect(llm.received[1][0].content).toBe(llm.received[0][0].content);
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
    // type). The repeated-error policy DEGRADES after 3 identical repeats —
    // the turn stays alive (skip + continue) and the mock LLM then answers —
    // but the Harness must still persist the "Repeated failure" error_pattern
    // immediately so the lesson survives the successful session.
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
    // Policy degrades after 3 identical repeats → the turn CONTINUES (the
    // skip directive reaches the model) and completes normally.
    expect(events.find(e => e.type === 'Interrupted')).toBeUndefined();
    expect(events.find(e => e.type === 'Completed')).toBeDefined();

    const repeated = memStore.entries.filter(e => e.type === 'error_pattern' && e.content.includes('Stopped by failure policy'));
    // Exactly one dead-end lesson per failure key, written on the degrade
    // decision itself (the session-end flush skips already-written keys).
    expect(repeated).toHaveLength(1);
    expect(repeated[0].content).toContain('Unsupported content type');
    expect(repeated[0].content).toContain('web_fetch');
    expect(repeated[0].content).toContain('SKIP it now');
    expect(repeated[0].projectPath).toBe('/ws');
  });

  it('persists platform-bound tool preferences from executed commands (auto-discovery)', async () => {
    const memStore = new FakeMemoryStore();
    const execTool: ToolAdapter = {
      execute: async (): Promise<ToolResult> => ({
        id: 'call_1',
        toolName: 'execute_command',
        result: { exitCode: 0, stdout: 'added 1 package', stderr: '' },
        success: true,
        duration: 3,
      }),
      getMetadata: () => ({ isWrite: false }),
      getTools: () => [{ name: 'execute_command', description: 'run', input_schema: {} }],
    };
    let call = 0;
    const toolLLM: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        call++;
        if (call === 1) {
          const tc = { id: 'call_1', index: 0, function: { name: 'execute_command', arguments: '{"command":"pnpm install"}' } };
          yield { type: 'tool_call', index: 0, id: tc.id, name: 'execute_command', arguments: tc.function.arguments };
          yield { type: 'done', content: '', toolCalls: [tc] };
        } else {
          yield { type: 'content', content: 'done' };
          yield { type: 'done', content: 'done', toolCalls: [] };
        }
      },
      complete: async () => ({ content: 'done', toolCalls: [] }),
    };
    const harness = new Harness({
      sessionId: 'sess-tools',
      llm: toolLLM,
      tools: execTool,
      toolsDefs: [{ name: 'execute_command', description: 'run', input_schema: {} }],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    await collect(harness.run('SYS', 'install deps'));

    const tools = memStore.entries.filter(e => e.type === 'tool_preference');
    expect(tools.some(t => t.content.includes('pnpm'))).toBe(true);
    expect(tools[0].platform).toBe(process.platform);
    expect(tools[0].dedupeKey).toBe(`tool:${process.platform}:pnpm`);
    // 机器级全局作用域：跨项目可见，不归属当前项目。
    expect(tools[0].projectPath).toBe(GLOBAL_MEMORY_SCOPE);
  });

  it('persists [remember] markers the model emitted (tool vs insight)', async () => {
    const memStore = new FakeMemoryStore();
    const llm = recordingLLM('Answer here\n[remember] uv\n[remember] 用缓存思路减少重复请求');
    const harness = new Harness({
      sessionId: 'sess-rem',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    await collect(harness.run('SYS', 'do the thing'));

    const tools = memStore.entries.filter(e => e.type === 'tool_preference');
    expect(tools.some(t => t.content.includes('uv'))).toBe(true);
    expect(tools[0].platform).toBe(process.platform);
    // 工具偏好机器级全局；思路（successful_pattern）保持项目作用域。
    expect(tools[0].projectPath).toBe(GLOBAL_MEMORY_SCOPE);
    const insights = memStore.entries.filter(e => e.type === 'successful_pattern' && e.content.startsWith('Effective approach'));
    expect(insights.some(i => i.content.includes('缓存思路'))).toBe(true);
    expect(insights[0].projectPath).toBe('/ws');
  });

  it('injects only current-platform tool preferences into the system prompt', async () => {
    const memStore = new FakeMemoryStore();
    const now = Date.now();
    // Seed THIS runner's platform plus a foreign one — CI runs on linux where
    // hardcoded darwin/win32 pairs would inject nothing and fail the section
    // assertion below.
    const mine = process.platform;
    const other = mine === 'darwin' ? 'win32' : 'darwin';
    await memStore.add({ type: 'tool_preference', content: `Verified on ${mine}: the pnpm tool works on this machine`, timestamp: now, sessionId: 's1', projectPath: '/ws', platform: mine });
    await memStore.add({ type: 'tool_preference', content: `Verified on ${other}: the choco tool works on this machine`, timestamp: now, sessionId: 's1', projectPath: '/ws', platform: other });
    const llm = recordingLLM('answer');
    const harness = new Harness({
      sessionId: 'sess-inj',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    await collect(harness.run('BASE SYSTEM', 'tool works on this machine'));

    const sys = llm.received[0][0].content;
    expect(sys).toContain('Platform-verified tools');
    expect(sys).toContain('pnpm');
    expect(sys).not.toContain('choco');
  });

  it('always injects machine-global tool preferences for the current platform', async () => {
    const memStore = new FakeMemoryStore();
    const now = Date.now();
    const mine = process.platform;
    const other = mine === 'darwin' ? 'win32' : 'darwin';
    await memStore.add({ type: 'tool_preference', content: `Verified on ${mine}: the brew tool works on this machine`, timestamp: now, sessionId: 's1', projectPath: GLOBAL_MEMORY_SCOPE, platform: mine });
    await memStore.add({ type: 'tool_preference', content: `Verified on ${other}: the choco tool works on this machine`, timestamp: now, sessionId: 's1', projectPath: GLOBAL_MEMORY_SCOPE, platform: other });
    // 休眠的全局条目不参与常驻注入（进化生命周期：睡着 ≠ 没了）。
    await memStore.add({ type: 'tool_preference', content: `Verified on ${mine}: the stale tool works on this machine`, timestamp: now, sessionId: 's1', projectPath: GLOBAL_MEMORY_SCOPE, platform: mine, lifecycle: 'dormant' });
    const llm = recordingLLM('answer');
    const harness = new Harness({
      sessionId: 'sess-global-inj',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    // 用户提示与工具名零 token 重叠 —— 语义检索命中不了，常驻注入必须仍能看到。
    await collect(harness.run('BASE SYSTEM', 'unrelated question about math'));

    const sys = llm.received[0][0].content;
    expect(sys).toContain('Platform-verified tools');
    expect(sys).toContain('brew');
    expect(sys).not.toContain('choco');
    expect(sys).not.toContain('stale');
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

  it('persists a single abandoned failed call as an error_pattern (v1.9.7)', async () => {
    const memStore = new FakeMemoryStore();
    // web_fetch fails ONCE with a dead-end error; the model abandons that
    // approach (no failurePolicy here, so no retry hint) and the session
    // completes via a different path. The single failure must still be
    // persisted — degradation has to survive into new sessions, not just for
    // repeated or fatal failures.
    const deadEndTool: ToolAdapter = {
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
    let llmCalls = 0;
    const llm: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        llmCalls++;
        if (llmCalls === 1) {
          const tc = { id: 'call_1', index: 0, function: { name: 'web_fetch', arguments: '{"url":"https://x/api"}' } };
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
      sessionId: 'sess-single-fail',
      llm,
      tools: deadEndTool,
      toolsDefs: [{ name: 'web_fetch', description: 'fetch', input_schema: {} }],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    const events = await collect(harness.run('SYS', 'get the data'));
    const completed = events.find(e => e.type === 'Completed');
    expect(completed?.payload.isComplete).toBe(true);

    const singles = memStore.entries.filter(e => e.type === 'error_pattern' && e.content.includes('Failed during execution'));
    expect(singles).toHaveLength(1);
    expect(singles[0].content).toContain('Unsupported content type');
    expect(singles[0].content).toContain('web_fetch');
    expect(singles[0].content).toContain('Do not make this exact call again');
    // The original request is anchored as Symptom so a future session asking
    // a similar question can retrieve the lesson by keyword overlap.
    expect(singles[0].content).toContain('Symptom: get the data');
    expect(singles[0].projectPath).toBe('/ws');
  });

  it('skips the single-failure memory when the same tool later succeeds (v1.9.7 transient exemption)', async () => {
    const memStore = new FakeMemoryStore();
    let attempts = 0;
    const flakyTool: ToolAdapter = {
      execute: async (): Promise<ToolResult> => {
        attempts++;
        if (attempts === 1) {
          return { id: 'call_1', toolName: 'web_fetch', error: 'Timeout after 10s', success: false, duration: 3 };
        }
        return { id: 'call_2', toolName: 'web_fetch', result: '{"data":"ok"}', success: true, duration: 3 };
      },
      getMetadata: () => ({ isWrite: false }),
      getTools: () => [{ name: 'web_fetch', description: 'fetch', input_schema: {} }],
    };
    let call = 0;
    const transientLLM: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        call++;
        if (call <= 2) {
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
      sessionId: 'sess-transient-single',
      llm: transientLLM,
      tools: flakyTool,
      toolsDefs: [{ name: 'web_fetch', description: 'fetch', input_schema: {} }],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    await collect(harness.run('SYS', 'get the data'));

    const singles = memStore.entries.filter(e => e.type === 'error_pattern' && e.content.includes('Failed during execution'));
    expect(singles).toHaveLength(0);
  });

  it('injects verified successful patterns before error patterns (v1.9.7)', async () => {
    const memStore = new FakeMemoryStore();
    await memStore.add({
      type: 'successful_pattern',
      content: 'Successful lesson: fixed TS2307 by adding the missing import to tsconfig',
      timestamp: Date.now(),
      sessionId: 'old-session',
      projectPath: '/ws',
    });
    await memStore.add({
      type: 'error_pattern',
      content: 'Error TS2307 was fixed by adding missing import',
      timestamp: Date.now(),
      sessionId: 'old-session',
      projectPath: '/ws',
    });

    const llm = recordingLLM('answer');
    const harness = new Harness({
      sessionId: 'sess-success',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    await collect(harness.run('BASE SYSTEM', 'fix the TS error in my project'));

    const sys = llm.received[0][0].content;
    expect(sys).toContain('Proven successful approaches');
    expect(sys).toContain('Successful lesson: fixed TS2307');
    expect(sys).toContain('Known error patterns');
    expect(sys.indexOf('Proven successful approaches')).toBeLessThan(sys.indexOf('Known error patterns'));
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

  it('trims the follow-up turn_completed checkpoint too — it shadows the interrupted one', async () => {
    // The engine emits Interrupted AND then a final Completed(interrupted=true)
    // for the same round. The Completed handler used to persist the raw
    // messages as 'turn_completed', which becomes the LATEST checkpoint —
    // resume reads the latest, so the unpaired tool_use the 'interrupted' trim
    // removed came right back on the next request (provider 400).
    const store = new MemoryStore();
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
      sessionId: 'sess-int3',
      llm: toolLLM,
      tools,
      toolsDefs: [{ name: 'read_file', description: 'r', input_schema: {} }],
      budget: STD_BUDGET,
      stateStore: store,
      hooks,
    });

    await collect(harness.run('SYS', 'read a.ts'));

    const session = store.loadSession('sess-int3');
    expect(session).not.toBeNull();
    const latest = session!.checkpoints[session!.checkpoints.length - 1];
    expect(latest.label).toBe('turn_completed');
    const latestLast = latest.state.messages[latest.state.messages.length - 1];
    expect(latestLast.role === 'assistant' && !!latestLast.toolCalls?.length).toBe(false);
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

  it('persists checkpoint + memory when the consumer breaks on Completed', async () => {
    const store = new MemoryStore();
    const memStore = new FakeMemoryStore();
    const llm = recordingLLM('final answer');
    const harness = new Harness({
      sessionId: 'sess-break',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      stateStore: store,
      memory: memStore,
      projectPath: '/ws',
    });

    // Consume only until Completed, then break without resuming the generator —
    // the checkpoint + memory side effects must have run before the yield.
    let completed = false;
    for await (const event of harness.run('SYS', 'do the thing')) {
      if (event.type === 'Completed') {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);

    const session = store.loadSession('sess-break');
    expect(session).not.toBeNull();
    expect(session!.checkpoints.some(cp => cp.label === 'turn_completed')).toBe(true);
    expect(memStore.entries.some(e => e.type === 'successful_pattern')).toBe(true);
  });
});

// ── E1.1 — lesson reflector at the Completed seam ──

describe('Harness lesson reflector (E1.1)', () => {
  /** Main-turn LLM that makes `steps` DISTINCT tool calls, then answers —
   *  enough evidence to cross the multi-step reflection threshold. */
  function multiStepLLM(steps: number, finalText: string): LLMAdapter {
    let call = 0;
    return {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        call++;
        if (call <= steps) {
          const tc = { id: `call_${call}`, index: 0, function: { name: 'read_file', arguments: `{"path":"f${call}.ts"}` } };
          yield { type: 'tool_call', index: 0, id: tc.id, name: 'read_file', arguments: tc.function.arguments };
          yield { type: 'done', content: '', toolCalls: [tc] };
        } else {
          yield { type: 'content', content: finalText };
          yield { type: 'done', content: finalText, toolCalls: [] };
        }
      },
      complete: async () => ({ content: finalText, toolCalls: [] }),
    };
  }

  function reflectLLM(reply: () => Promise<{ content: string }>): LLMAdapter & { calls: number } {
    const adapter = {
      calls: 0,
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> { yield { type: 'done', content: '', toolCalls: [] }; },
      complete: async () => { adapter.calls++; return reply(); },
    };
    return adapter;
  }

  function harnessWith(opts: {
    memStore: FakeMemoryStore;
    llm: LLMAdapter;
    reflect?: LLMAdapter;
    reflection?: { enabled?: boolean; dailyCap?: number };
  }): Harness {
    // A working read_file adapter so the engine actually executes the tool
    // rounds — without one it abandons the loop after the first call and the
    // turn never accumulates multi-step evidence.
    const okTool: ToolAdapter = {
      execute: async (call): Promise<ToolResult> => ({
        id: call.id,
        toolName: call.function.name,
        result: 'file body',
        success: true,
        duration: 1,
      }),
      getMetadata: () => ({ isWrite: false }),
      getTools: () => [{ name: 'read_file', description: 'read', input_schema: {} }],
    };
    return new Harness({
      sessionId: 'sess-reflect',
      llm: opts.llm,
      tools: okTool,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: opts.memStore,
      projectPath: '/ws',
      llmFor: (phase) => (phase === 'REFLECT' ? opts.reflect : undefined),
      reflection: opts.reflection,
    });
  }

  it('reflects a multi-step turn and lands the structured lesson instead of the template', async () => {
    const memStore = new FakeMemoryStore();
    const main = multiStepLLM(3, 'all done');
    const reflect = reflectLLM(async () => ({
      content: JSON.stringify({
        symptom: 'multi-step inspection task',
        rootCause: 'plain reading sufficed',
        prevention: 'batch the reads',
        recovery: 'not needed',
        evidence: ['whatever-id'], // validated below against the REAL catalog
      }),
    }));
    const harness = harnessWith({ memStore, llm: main, reflect });

    await collect(harness.run('SYS', 'inspect several files'));
    // Fire-and-forget: the Completed event is already in the caller's hands.
    await harness.settleReflections();

    const reflected = memStore.entries.filter(e => e.dedupeKey?.startsWith('reflect:'));
    expect(reflected).toHaveLength(1);
    // Evidence ids are validated against the turn's real catalog — the model's
    // invented id is stripped, so nothing citable remains → confidence low.
    expect(reflected[0].confidence).toBe('low');
    expect(reflected[0].lesson?.evidence).toBeUndefined();
    expect(reflected[0].content).toContain('Reflected lesson');
    expect(reflect.calls).toBe(1);
    // The template lesson is NOT written when reflection succeeded.
    expect(memStore.entries.some(e => e.content.startsWith('Reusable lesson'))).toBe(false);
  });

  it('cites real evidence ids as high confidence when the model uses the catalog', async () => {
    const memStore = new FakeMemoryStore();
    const main = multiStepLLM(3, 'done');
    // Evidence ids are content hashes of (toolName, args) — the exact ids the
    // turn will produce are computable up front, so the reflection reply can
    // cite a REAL catalog id from the moment the reflection fires (it starts
    // inside run(), before Completed reaches the caller).
    const ids = buildTurnEvidence(Array.from({ length: 3 }, (_, i) => ({
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: `c${i}`, index: 0, function: { name: 'read_file', arguments: `{"path":"f${i + 1}.ts"}` } }],
    }))).map(e => e.id);
    const reflect = reflectLLM(async () => ({
      content: JSON.stringify({
        symptom: 's',
        rootCause: 'r',
        prevention: 'p',
        recovery: 'r',
        evidence: [ids[0]],
      }),
    }));
    const harness = harnessWith({ memStore, llm: main, reflect });

    const events = await collect(harness.run('SYS', 'inspect several files'));
    // Cross-check: the precomputed ids really are the transcript's ids.
    const completed = events.find(e => e.type === 'Completed')!;
    expect(buildTurnEvidence(completed.payload.messages ?? []).map(e => e.id)).toEqual(ids);
    await harness.settleReflections();

    const reflected = memStore.entries.find(e => e.dedupeKey?.startsWith('reflect:'));
    expect(reflected?.confidence).toBe('high');
    expect(reflected?.lesson?.evidence).toEqual([ids[0]]);
  });

  it('falls back to the template write when the reflector fails', async () => {
    const memStore = new FakeMemoryStore();
    const main = multiStepLLM(3, 'done');
    const reflect = reflectLLM(async () => { throw new Error('provider down'); });
    const harness = harnessWith({ memStore, llm: main, reflect });

    await collect(harness.run('SYS', 'inspect several files'));
    await harness.settleReflections();

    expect(memStore.entries.filter(e => e.dedupeKey?.startsWith('reflect:'))).toHaveLength(0);
    expect(memStore.entries.some(e => e.content.startsWith('Reusable lesson'))).toBe(true);
  });

  it('keeps the plain template path when reflection is disabled', async () => {
    const memStore = new FakeMemoryStore();
    const main = multiStepLLM(3, 'done');
    const reflect = reflectLLM(async () => ({ content: '{}' }));
    const harness = harnessWith({ memStore, llm: main, reflect, reflection: { enabled: false } });

    await collect(harness.run('SYS', 'inspect several files'));
    await harness.settleReflections();

    expect(reflect.calls).toBe(0);
    expect(memStore.entries.some(e => e.content.startsWith('Reusable lesson'))).toBe(true);
  });

  it('stops reflecting once the daily cap is reached', async () => {
    const memStore = new FakeMemoryStore();
    for (let i = 0; i < 20; i++) {
      await memStore.add({
        type: 'successful_pattern',
        content: `earlier reflected lesson ${i}`,
        timestamp: Date.now(),
        sessionId: `old-${i}`,
        projectPath: '/ws',
        dedupeKey: `reflect:old-${i}:task`,
      });
    }
    const main = multiStepLLM(3, 'done');
    const reflect = reflectLLM(async () => ({ content: '{}' }));
    const harness = harnessWith({ memStore, llm: main, reflect, reflection: { dailyCap: 20 } });

    await collect(harness.run('SYS', 'inspect several files'));
    await harness.settleReflections();

    expect(reflect.calls).toBe(0);
    expect(memStore.entries.some(e => e.content.startsWith('Reusable lesson'))).toBe(true);
  });

  it('never injects low-confidence lessons into the system prompt (default)', async () => {
    const memStore = new FakeMemoryStore();
    await memStore.add({
      type: 'successful_pattern',
      content: 'grounded lesson about flaky deploy scripts',
      timestamp: Date.now(),
      sessionId: 'old-a',
      projectPath: '/ws',
      confidence: 'high',
    });
    await memStore.add({
      type: 'successful_pattern',
      content: 'speculative lesson about lunar retrograde deploys',
      timestamp: Date.now(),
      sessionId: 'old-b',
      projectPath: '/ws',
      confidence: 'low',
    });
    const llm = recordingLLM('answer');
    const harness = new Harness({
      sessionId: 'sess-inject',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });

    await collect(harness.run('SYS', 'how do I fix the deploy scripts'));

    const sys = llm.received[0][0].content;
    expect(sys).toContain('grounded lesson about flaky deploy scripts');
    expect(sys).not.toContain('speculative lesson about lunar retrograde deploys');
  });
});

describe('Harness tool-correction notes (E1.3)', () => {
  it('injects an approved correction note into every later session prompt', async () => {
    const memStore = new FakeMemoryStore();
    const now = Date.now();
    const fail = 'Stopped by failure policy: error sending request to https://api.example.com: connection refused (tool: web_fetch). giving up';
    for (let i = 0; i < 3; i++) {
      await memStore.add({
        type: 'error_pattern',
        content: fail,
        timestamp: now - i * 60_000,
        sessionId: `s-${i}`,
        projectPath: i === 2 ? '/other-project' : '/ws',
      });
    }
    const [suggestion] = scanToolCorrections(memStore.list());
    expect(suggestion.toolName).toBe('web_fetch');

    // 用户点「采纳」→ 写入机器级 tool_preference；之后每个会话都该看到。
    await approveToolCorrection(memStore, suggestion, process.platform);

    const llm = recordingLLM('answer');
    const harness = new Harness({
      sessionId: 'sess-tool-note',
      llm,
      toolsDefs: [],
      budget: STD_BUDGET,
      memory: memStore,
      projectPath: '/ws',
    });
    // 与工具名零 token 重叠的提示词 —— 常驻注入必须仍然带上这张卡。
    await collect(harness.run('SYS', 'unrelated question about mathematics'));

    const sys = llm.received[0][0].content;
    expect(sys).toContain('Platform-verified tools');
    expect(sys).toContain(suggestion.note);
  });
});
