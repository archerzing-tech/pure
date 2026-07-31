// src/harness/__tests__/Harness.test.ts
// P1-7 — resume: run() must feed checkpoint messages as the initial context
// (previously loaded messages were only reused for checkpoint saving, so
// --resume runs restarted from a blank [system, user] context).

import { describe, it, expect } from 'bun:test';
import { Harness } from '../Harness';
import type {
  AgentLoopState,
  BudgetConfig,
  Checkpoint,
  EngineEvent,
  IStateStore,
  LLMAdapter,
  LLMChunk,
  Message,
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
    expect(contents(msgs)).toEqual(['NEW SYSTEM', 'v1', 'a1', 'continue here']);
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
    expect(contents(llm.received[0])).toEqual(['SYS', 'hello']);
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
    expect(msgs[0]).toEqual({ role: 'system', content: 'FRESH instructions + memory' });
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
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS v2' });
    expect(contents(msgs)).toEqual(['SYS v2', 'v1', 'a1', 'next']);
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
