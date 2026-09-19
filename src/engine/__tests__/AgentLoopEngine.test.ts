// src/engine/__tests__/AgentLoopEngine.test.ts
// v0.4 — updated for new Engine behavior: BudgetWarning events, VERIFY_FAILED → loop back to THINK.

import { describe, it, expect } from 'bun:test';
import { AgentLoopEngine } from '../AgentLoopEngine';
import { DefaultHookRouter } from '../HookRouter';
import { DefaultFailurePolicy } from '../FailurePolicy';
import type {
  LLMAdapter,
  LLMChunk,
  Message,
  ToolAdapter,
  ToolDefinition,
  ToolResult,
  ToolCall,
  EngineContext,
  EngineEvent,
  BudgetConfig,
} from '../../shared/types';

const STD_BUDGET: BudgetConfig = {
  maxTurns: 30,
  maxTotalTokens: 200_000,
  maxExecutionTime: 600_000,
  warningThreshold: 0.8,
  graceTurns: 3,
  // The elastic default has no hard cap, so the engine only stops on completion /
  // failure policy / abort. Tests that previously terminated on the soft budget
  // cap still need a deterministic ceiling — provide one here.
  hardMaxTurns: 60,
  hardMaxTokens: 400_000,
  hardMaxTime: 1_200_000,
};

// ── Mock LLM factories ──

function textLLM(content: string): LLMAdapter {
  return {
    stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
      yield { type: 'content', content: content.slice(0, Math.ceil(content.length / 2)) };
      yield { type: 'done', content, toolCalls: [] };
    },
    complete: async () => ({ content, toolCalls: [] }),
  };
}

function toolThenTextLLM(toolName: string, toolArgs: string, finalText: string): LLMAdapter {
  let firstCall = true;
  return {
    stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
      if (firstCall) {
        firstCall = false;
        const tc: ToolCall = { id: 'call_1', index: 0, function: { name: toolName, arguments: toolArgs } };
        yield { type: 'tool_call_delta', index: 0, name: toolName, arguments: toolArgs };
        yield { type: 'tool_call', index: 0, id: 'call_1', name: toolName, arguments: toolArgs };
        yield { type: 'done', content: '', toolCalls: [tc] };
      } else {
        yield { type: 'content', content: finalText };
        yield { type: 'done', content: finalText, toolCalls: [] };
      }
    },
    complete: async () => ({ content: finalText, toolCalls: [] }),
  };
}

function reasoningThenTextLLM(reasoning: string, content: string): LLMAdapter {
  return {
    stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
      yield { type: 'reasoning', content: reasoning };
      yield { type: 'content', content };
      yield { type: 'done', content, toolCalls: [] };
    },
    complete: async () => ({ content, toolCalls: [] }),
  };
}

function errorLLM(message: string): LLMAdapter {
  return {
    stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
      throw new Error(message);
    },
    complete: async () => { throw new Error(message); },
  };
}

function multiRoundLLM(rounds: Array<{ toolName: string; toolArgs: string }>, finalText: string): LLMAdapter {
  let callIdx = 0;
  return {
    stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
      if (callIdx < rounds.length) {
        const r = rounds[callIdx++];
        const tc: ToolCall = { id: `call_${callIdx}`, index: 0, function: { name: r.toolName, arguments: r.toolArgs } };
        yield { type: 'tool_call_delta', index: 0, name: r.toolName, arguments: r.toolArgs };
        yield { type: 'done', content: '', toolCalls: [tc] };
      } else {
        yield { type: 'content', content: finalText };
        yield { type: 'done', content: finalText, toolCalls: [] };
      }
    },
    complete: async () => ({ content: finalText, toolCalls: [] }),
  };
}

// ── Mock ToolAdapter ──

function echoToolAdapter(tools: ToolDefinition[]): ToolAdapter {
  return {
    execute: async (tc: ToolCall): Promise<ToolResult> => ({
      id: tc.id,
      toolName: tc.function.name,
      result: `executed ${tc.function.name} with ${tc.function.arguments}`,
      success: true,
      duration: 5,
    }),
    getMetadata: (name: string) => ({ isWrite: name === 'write_file' || name === 'edit_file' }),
    getTools: () => tools,
  };
}

function failToolAdapter(tools: ToolDefinition[], failOn: string): ToolAdapter {
  return {
    execute: async (tc: ToolCall): Promise<ToolResult> => ({
      id: tc.id,
      toolName: tc.function.name,
      error: tc.function.name === failOn ? 'tool execution failed' : undefined,
      success: tc.function.name !== failOn,
      duration: 3,
    }),
    getMetadata: () => undefined,
    getTools: () => tools,
  };
}

/** Emits each round's calls in ONE assistant turn (distinct ids), then the
 * final text round — mirrors a model firing parallel (possibly duplicate)
 * calls in a single batch. */
function parallelRoundsLLM(rounds: Array<Array<{ toolName: string; toolArgs: string }>>, finalText: string): LLMAdapter {
  let roundIdx = 0;
  return {
    stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
      if (roundIdx < rounds.length) {
        const round = rounds[roundIdx++];
        const tcs: ToolCall[] = round.map((r, i) => ({
          id: `call_${roundIdx}_${i}`,
          index: i,
          function: { name: r.toolName, arguments: r.toolArgs },
        }));
        for (const tc of tcs) {
          yield { type: 'tool_call_delta', index: tc.index, name: tc.function.name, arguments: tc.function.arguments };
          yield { type: 'tool_call', index: tc.index, id: tc.id, name: tc.function.name, arguments: tc.function.arguments };
        }
        yield { type: 'done', content: '', toolCalls: tcs };
      } else {
        yield { type: 'content', content: finalText };
        yield { type: 'done', content: finalText, toolCalls: [] };
      }
    },
    complete: async () => ({ content: finalText, toolCalls: [] }),
  };
}

/** Echo adapter that records every real execution so tests can count how many
 * times the world was actually touched; optionally fails the first one. */
function countingToolAdapter(tools: ToolDefinition[], failFirstExecution = false): ToolAdapter & { executions: string[] } {
  const executions: string[] = [];
  const adapter: ToolAdapter = {
    execute: async (tc: ToolCall): Promise<ToolResult> => {
      executions.push(`${tc.function.name} ${tc.function.arguments}`);
      const fail = failFirstExecution && executions.length === 1;
      return {
        id: tc.id,
        toolName: tc.function.name,
        result: fail ? undefined : `executed ${tc.function.name} with ${tc.function.arguments}`,
        error: fail ? 'transient failure' : undefined,
        success: !fail,
        duration: 5,
      };
    },
    getMetadata: () => undefined,
    getTools: () => tools,
  };
  return Object.assign(adapter, { executions });
}

const READ_FILE_TOOL: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

const LIST_FILES_TOOL: ToolDefinition = {
  name: 'list_files',
  description: 'List directory contents',
  input_schema: { type: 'object', properties: { path: { type: 'string' } } },
};

// ── Helpers ──

async function collect(gen: AsyncGenerator<EngineEvent, void, void>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function baseCtx(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    llm: textLLM('hello'),
    toolsDefs: [],
    budget: STD_BUDGET,
    ...overrides,
  };
}

/** A conversation is sendable only if every assistant message carrying
 * toolCalls is followed by tool results for EVERY call id before the next
 * assistant message — providers reject an unpaired tail with 400. */
function transcriptIsPaired(messages: Message[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const needed = new Set(m.toolCalls.map((t) => t.id));
      for (let j = i + 1; j < messages.length && needed.size > 0; j++) {
        if (messages[j].role === 'assistant') break;
        if (messages[j].role === 'tool' && needed.has(messages[j].toolCallId!)) {
          needed.delete(messages[j].toolCallId!);
        }
      }
      if (needed.size > 0) return false;
    }
  }
  return true;
}

// ── Tests ──

describe('AgentLoopEngine', () => {
  // ═══ No-tool path: THINK → VERIFY → TERMINATE ═══

  it('completes a simple text response without tools', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({ llm: textLLM('Hello, world!') });

    const events = await collect(engine.run(
      { sessionId: 's1', systemPrompt: 'You are helpful.', userPrompt: 'Hi', budget: STD_BUDGET },
      ctx,
    ));

    const stateChanges = events.filter(e => e.type === 'StateChange');
    const completed = events.find(e => e.type === 'Completed');
    const tokens = events.filter(e => e.type === 'TokenDelta');

    expect(stateChanges).toHaveLength(3);
    expect(stateChanges[0].payload).toMatchObject({ from: 'THINK', to: 'THINK' });
    expect(stateChanges[1].payload).toMatchObject({ from: 'THINK', to: 'VERIFY' });
    const terminate = events.find(e => e.type === 'StateChange' && (e as any).payload?.to === 'TERMINATE');
    expect(terminate).toBeDefined();
    expect(completed).toBeDefined();
    expect(completed!.payload.finalOutput).toBe('Hello, world!');
    expect(completed!.payload.isComplete).toBe(true);
    expect(completed!.payload.verification).toMatchObject({ status: 'not_run', evidence: [] });
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('surfaces reasoning deltas as ReasoningDelta and keeps them out of the answer', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({ llm: reasoningThenTextLLM('First inspect the file layout.', 'Done.') });

    const events = await collect(engine.run(
      { sessionId: 's2', systemPrompt: 'You are helpful.', userPrompt: 'Hi', budget: STD_BUDGET },
      ctx,
    ));

    const reasoning = events.filter(e => e.type === 'ReasoningDelta');
    expect(reasoning.length).toBeGreaterThan(0);
    expect(reasoning.map(e => (e as any).payload.content).join('')).toBe('First inspect the file layout.');

    // Reasoning must never leak into the visible answer / stored messages.
    const completed = events.find(e => e.type === 'Completed') as any;
    expect(completed.payload.finalOutput).toBe('Done.');
    const assistantMsg = completed.payload.messages?.find((m: Message) => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('Done.');
    expect(assistantMsg?.content).not.toContain('file layout');
  });

  // ═══ ReAct loop: THINK → ACT → OBSERVE → THINK → VERIFY → TERMINATE ═══

  it('counts every tool call in the budget snapshot', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm: toolThenTextLLM('read_file', '{"path":"src/a.ts"}', 'done'),
      tools: echoToolAdapter([READ_FILE_TOOL]),
      toolsDefs: [READ_FILE_TOOL],
    });

    const events = await collect(engine.run(
      { sessionId: 's-tool-budget', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    const controls = events.filter(e => e.type === 'YieldControl');
    const first = controls[0];
    expect(first?.type).toBe('YieldControl');
    if (first?.type === 'YieldControl') expect(first.payload.budget.toolCalls.used).toBe(1);
  });

  it('executes the full ReAct loop with tool calls', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm: toolThenTextLLM('read_file', '{"path":"src/a.ts"}', 'The file contains TypeScript.'),
      tools: echoToolAdapter([READ_FILE_TOOL]),
      toolsDefs: [READ_FILE_TOOL],
    });

    const events = await collect(engine.run(
      { sessionId: 's2', systemPrompt: 'You are a coder.', userPrompt: 'Read src/a.ts', budget: STD_BUDGET },
      ctx,
    ));

    const stateChanges = events.filter(e => e.type === 'StateChange');
    const toolResults = events.filter(e => e.type === 'ToolResult');
    const toolStarts = events.filter(e => e.type === 'ToolStarted');
    const completed = events.find(e => e.type === 'Completed');

    const transitions = stateChanges.map(e => `${e.payload.from}→${e.payload.to}`);
    expect(transitions).toContain('THINK→ACT');
    expect(transitions).toContain('ACT→OBSERVE');
    expect(transitions).toContain('OBSERVE→THINK');
    expect(transitions).toContain('THINK→VERIFY');
    expect(transitions).toContain('VERIFY→TERMINATE');

    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0]).toMatchObject({ type: 'ToolStarted', payload: { toolName: 'read_file', toolCallId: 'call_1' } });
    expect(events.indexOf(toolStarts[0])).toBeLessThan(events.indexOf(toolResults[0]));
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].payload.toolName).toBe('read_file');
    expect(toolResults[0].payload.result.success).toBe(true);

    expect(completed).toBeDefined();
    expect(completed!.payload.finalOutput).toBe('The file contains TypeScript.');
  });

  it('handles multiple tool-call rounds', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm: multiRoundLLM(
        [
          { toolName: 'read_file', toolArgs: '{"path":"a.ts"}' },
          { toolName: 'list_files', toolArgs: '{"path":"src"}' },
        ],
        'Done analyzing.',
      ),
      tools: echoToolAdapter([READ_FILE_TOOL, LIST_FILES_TOOL]),
      toolsDefs: [READ_FILE_TOOL, LIST_FILES_TOOL],
    });

    const events = await collect(engine.run(
      { sessionId: 's3', systemPrompt: 'Code.', userPrompt: 'Analyze', budget: STD_BUDGET },
      ctx,
    ));

    const toolResults = events.filter(e => e.type === 'ToolResult');
    const completed = events.find(e => e.type === 'Completed');

    expect(toolResults).toHaveLength(2);
    expect(toolResults[0].payload.toolName).toBe('read_file');
    expect(toolResults[1].payload.toolName).toBe('list_files');
    expect(completed!.payload.finalOutput).toBe('Done analyzing.');
    expect(completed!.payload.turnCount).toBe(3); // initial + 2 tool rounds
  });

  // 插话重构 — mid-run steering lands at the THINK boundary, not mid-ACT.

  it('injects queued steering at the next THINK boundary, after every tool result', async () => {
    const engine = new AgentLoopEngine();
    const steerQueue: Message[] = [];
    const seenRounds: Message[][] = [];
    let drains = 0;
    let round = 0; // per-adapter: stream() is called once per THINK round
    const steeringLLM: LLMAdapter = {
      stream: (messages) => {
        return (async function* (): AsyncGenerator<LLMChunk, void, void> {
          seenRounds.push([...messages]);
          if (round++ === 0) {
            const tc: ToolCall = { id: 'call_s1', index: 0, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } };
            yield { type: 'tool_call_delta', index: 0, name: 'read_file', arguments: '{"path":"a.ts"}' };
            yield { type: 'done', content: '', toolCalls: [tc] };
          } else {
            yield { type: 'content', content: 'Steered and done.' };
            yield { type: 'done', content: 'Steered and done.', toolCalls: [] };
          }
        })();
      },
      complete: async () => ({ content: 'Steered and done.', toolCalls: [] }),
    };
    const ctx = baseCtx({
      llm: steeringLLM,
      tools: {
        // The user types WHILE round 1's tool executes — the queue is empty at
        // the first THINK boundary and holds the words by the second.
        execute: async (tc: ToolCall): Promise<ToolResult> => {
          steerQueue.push({ role: 'user', content: '记得跑测试' });
          return {
            id: tc.id,
            toolName: tc.function.name,
            result: `executed ${tc.function.name}`,
            success: true,
            duration: 5,
          };
        },
        getMetadata: () => undefined,
        getTools: () => [READ_FILE_TOOL],
      },
      toolsDefs: [READ_FILE_TOOL],
      // Drained by the engine at every THINK boundary.
      takeSteerMessages: () => {
        drains++;
        return steerQueue.splice(0);
      },
    });

    const events = await collect(engine.run(
      { sessionId: 's-steer', systemPrompt: 'Code.', userPrompt: 'do the thing', budget: STD_BUDGET },
      ctx,
    ));

    const steerEvents = events.filter(e => e.type === 'SteerInjected');
    expect(steerEvents).toHaveLength(1);
    // turnCount increments at round END, so the drain inside round 2's THINK
    // still reports the in-flight round (1) — assert only the count here.
    expect(steerEvents[0].payload.count).toBe(1);
    // Drained on every THINK round (round 1 empty, round 2 delivers).
    expect(drains).toBe(2);
    // Protocol-safe placement: the steer sits AFTER the tool result it
    // followed, and the whole round-2 transcript stays paired.
    const round2 = seenRounds[1];
    const steerIdx = round2.findIndex((m) => m.role === 'user' && m.content === '记得跑测试');
    const toolResultIdx = round2.findIndex((m) => m.role === 'tool');
    expect(steerIdx).toBeGreaterThan(toolResultIdx);
    expect(transcriptIsPaired(round2)).toBe(true);
    expect(events.find(e => e.type === 'Completed')?.payload.isComplete).toBe(true);
  });

  it('never drains when no steering channel is wired (byte-identical legacy path)', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({ llm: textLLM('plain completion') });
    const events = await collect(engine.run(
      { sessionId: 's-nosteer', systemPrompt: 'Code.', userPrompt: 'hi', budget: STD_BUDGET },
      ctx,
    ));
    expect(events.some(e => e.type === 'SteerInjected')).toBe(false);
    expect(events.find(e => e.type === 'Completed')?.payload.finalOutput).toBe('plain completion');
  });

  it('injects a wrap-up directive after consecutive web-research rounds', async () => {
    const engine = new AgentLoopEngine();
    const tools: ToolDefinition[] = [
      { name: 'web_search', description: 'search', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
      { name: 'researcher_web', description: 'research', input_schema: { type: 'object', properties: { prompt: { type: 'string' } } } },
      { name: 'web_fetch', description: 'fetch', input_schema: { type: 'object', properties: { url: { type: 'string' } } } },
    ];
    const ctx = baseCtx({
      llm: multiRoundLLM(
        [
          { toolName: 'web_search', toolArgs: '{"query":"a"}' },
          { toolName: 'web_search', toolArgs: '{"query":"b"}' },
          { toolName: 'researcher_web', toolArgs: '{"prompt":"c"}' },
          { toolName: 'web_fetch', toolArgs: '{"url":"https://x"}' },
        ],
        'Final answer.',
      ),
      tools: echoToolAdapter(tools),
      toolsDefs: tools,
    });

    const events = await collect(engine.run(
      { sessionId: 's-research-cap', systemPrompt: 'You are helpful.', userPrompt: 'Research this', budget: STD_BUDGET },
      ctx,
    ));

    const completed = events.find(e => e.type === 'Completed') as any;
    expect(completed).toBeDefined();
    const messages = completed.payload.messages as Message[];
    const wrapUp = messages.find((m) => m.role === 'user' && m.content.includes('consecutive web research rounds'));
    expect(wrapUp).toBeDefined();
    expect(wrapUp!.content).toContain('Stop issuing more searches');
  });

  // ═══ LLM error handling ═══

  it('emits Error event when LLM stream throws', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({ llm: errorLLM('connection refused') });

    const events = await collect(engine.run(
      { sessionId: 's4', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    const err = events.find(e => e.type === 'Error');
    const completed = events.find(e => e.type === 'Completed');

    expect(err).toBeDefined();
    if (err && err.type === 'Error') {
      expect(err.payload.code).toBe('LLM_STREAM_ERROR');
      expect(err.payload.message).toContain('connection refused');
      expect(err.payload.recoverable).toBe(false);
    }
    expect(completed).toBeUndefined();
    // Terminal-event guarantee: consumers (chat.ts) key cleanup on Completed
    // OR Interrupted — a bare Error used to strand them with empty state.
    const interrupted = events.find(e => e.type === 'Interrupted');
    expect(interrupted).toBeDefined();
    if (interrupted && interrupted.type === 'Interrupted') {
      expect(interrupted.payload.reason).toContain('llm_stream_error');
    }
  });

  // ═══ continueGuard: premature text-only stops are recovered ═══

  it('re-enters THINK when the guard says plan work remains', async () => {
    let calls = 0;
    const llm: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        calls++;
        yield { type: 'done', content: calls === 1 ? 'progress report' : 'all done', toolCalls: [] };
      },
      complete: async () => ({ content: 'all done', toolCalls: [] }),
    };
    let consultations = 0;
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm,
      continueGuard: ({ guardContinues }) => {
        consultations++;
        return guardContinues === 0 ? 'continue: stage 2 remains' : false;
      },
    });

    const events = await collect(engine.run(
      { sessionId: 'guard-1', systemPrompt: 'X', userPrompt: 'build it', budget: STD_BUDGET },
      ctx,
    ));

    expect(calls).toBe(2); // premature stop → nudge → real finish
    // Consulted at the premature stop AND once more at the real ending —
    // but only ONE nudge was injected.
    expect(consultations).toBe(2);
    const completed = events.find(e => e.type === 'Completed');
    expect(completed).toBeDefined();
    if (completed && completed.type === 'Completed') {
      expect(completed.payload.finalOutput).toBe('all done');
    }
    // The nudge rode into the model context as an internal user message.
    const completedMsgs = completed && completed.type === 'Completed' ? (completed.payload.messages ?? []) : [];
    expect(completedMsgs.some(m => m.role === 'user' && m.internal && m.content?.includes('stage 2 remains'))).toBe(true);
  });

  it('caps guard re-entries at three even when the guard always wants more', async () => {
    let calls = 0;
    const llm: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        calls++;
        yield { type: 'done', content: `report ${calls}`, toolCalls: [] };
      },
      complete: async () => ({ content: 'report', toolCalls: [] }),
    };
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({ llm, continueGuard: () => 'keep going' });

    const events = await collect(engine.run(
      { sessionId: 'guard-2', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    // 1 initial + 3 nudged rounds, then the guard budget is exhausted.
    expect(calls).toBe(4);
    const completed = events.find(e => e.type === 'Completed');
    expect(completed).toBeDefined();
  });

  it('ends immediately when the guard returns false', async () => {
    let calls = 0;
    const llm: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        calls++;
        yield { type: 'done', content: 'final', toolCalls: [] };
      },
      complete: async () => ({ content: 'final', toolCalls: [] }),
    };
    let consulted = 0;
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm,
      continueGuard: () => { consulted++; return false; },
    });

    const events = await collect(engine.run(
      { sessionId: 'guard-3', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    expect(calls).toBe(1);
    expect(consulted).toBe(1);
    expect(events.find(e => e.type === 'Completed')).toBeDefined();
  });

  it('nudges an empty final round through the guard budget', async () => {
    let calls = 0;
    const llm: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        calls++;
        yield { type: 'done', content: '', toolCalls: [] };
      },
      complete: async () => ({ content: '', toolCalls: [] }),
    };
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({ llm, continueGuard: () => false }); // guard declines; empty-output nudge applies

    const events = await collect(engine.run(
      { sessionId: 'guard-4', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    // 1 empty round + 3 empty-output nudges (shared guard budget), then the
    // turn terminates instead of "completing" on silence.
    expect(calls).toBe(4);
    const completed = events.find(e => e.type === 'Completed');
    expect(completed).toBeDefined();
  });

  it('recovers a tool call whose stream was cut off before done', async () => {
    let calls = 0;
    const llm: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        calls++;
        if (calls === 1) {
          // Tool call starts streaming, then the stream dies with NO done
          // chunk — the legacy path silently dropped this call.
          yield { type: 'tool_call_delta', index: 0, name: 'write_file', arguments: '{"path"' };
          return;
        }
        yield { type: 'done', content: 'recovered and finished', toolCalls: [] };
      },
      complete: async () => ({ content: 'recovered and finished', toolCalls: [] }),
    };
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({ llm });

    const events = await collect(engine.run(
      { sessionId: 'guard-5', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    expect(calls).toBe(2); // cut-off call re-issued instead of dropped
    const completed = events.find(e => e.type === 'Completed');
    expect(completed).toBeDefined();
    const completedMsgs = completed && completed.type === 'Completed' ? (completed.payload.messages ?? []) : [];
    expect(completedMsgs.some(m => m.role === 'user' && m.internal && m.content?.includes('cut off mid-stream'))).toBe(true);
  });

  // ═══ BudgetManager: check() override via tiny budget ═══

  it('emits Interrupted when token budget is exceeded', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm: textLLM('A'.repeat(500)),
      budget: { ...STD_BUDGET, maxTotalTokens: 10, hardMaxTokens: 10, graceTurns: 0 },
    });

    const events = await collect(engine.run(
      { sessionId: 's5', systemPrompt: 'X', userPrompt: 'A'.repeat(200), budget: ctx.budget },
      ctx,
    ));

    const interrupted = events.find(e => e.type === 'Interrupted');
    expect(interrupted).toBeDefined();
    expect(interrupted!.payload.reason).toBe('Budget exceeded');
  });

  it('preserves in-flight partial answer on aborted (Ctrl+C) interrupt', async () => {
    const ac = new AbortController();
    // A transport that streams a partial answer, then waits for the consumer to
    // abort and surfaces the interruption — mirroring a real stream cut mid-text.
    // Regression: the partial text must be persisted in the interrupted
    // checkpoint, otherwise interrupted turns vanish from history.
    const partialLLM: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        yield { type: 'content', content: 'partial answer that was still streaming' };
        while (!ac.signal.aborted) {
          await new Promise((r) => setTimeout(r, 1));
        }
        throw new Error('aborted');
      },
      complete: async () => ({ content: 'x', toolCalls: [] }),
    };
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({ llm: partialLLM, signal: ac.signal });
    const gen = engine.run(
      { sessionId: 's-partial', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    );
    const collected = collect(gen);
    // Abort only AFTER the stream has emitted its partial answer, mirroring a
    // real Ctrl+C mid-response — so the engine's aborted-branch must persist the
    // in-flight text rather than aborting before the stream even starts.
    const abortTimer = setTimeout(() => ac.abort(), 0);
    const events = await collected;
    clearTimeout(abortTimer);

    const interrupted = events.find((e) => e.type === 'Interrupted');
    expect(interrupted).toBeDefined();
    expect(interrupted!.payload.reason).toBe('aborted');
    const msgs = interrupted!.payload.messages ?? [];
    const last = msgs[msgs.length - 1];
    expect(last?.role).toBe('assistant');
    expect(String((last as any).content)).toContain('partial answer that was still streaming');
  });

  it('emits Interrupted when turn budget is exceeded', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm: multiRoundLLM(
        Array.from({ length: 5 }, (_, i) => ({ toolName: 'read_file', toolArgs: `{"path":"f${i}.ts"}` })),
        'final',
      ),
      tools: echoToolAdapter([READ_FILE_TOOL]),
      toolsDefs: [READ_FILE_TOOL],
      budget: { ...STD_BUDGET, maxTurns: 2, hardMaxTurns: 2, graceTurns: 0 },
    });

    const events = await collect(engine.run(
      { sessionId: 's6', systemPrompt: 'X', userPrompt: 'Y', budget: ctx.budget },
      ctx,
    ));

    const interrupted = events.find(e => e.type === 'Interrupted');
    expect(interrupted).toBeDefined();
    // With maxTurns=2 and the tool loop taking multiple turns, max_turns fires first
    expect(['Budget exceeded', 'max_turns']).toContain(interrupted!.payload.reason);
  });

  // ═══ Verifier integration ═══

  it('calls verifier and passes through on success', async () => {
    const engine = new AgentLoopEngine();
    let wasVerified = false;
    const ctx = baseCtx({
      llm: textLLM('optimised code'),
      verifier: {
        evaluate: async (params) => {
          wasVerified = true;
          return { passed: true };
        },
      },
    });

    const events = await collect(engine.run(
      { sessionId: 's7', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    expect(wasVerified).toBe(true);
    const completed = events.find(e => e.type === 'Completed');
    expect(completed).toBeDefined();
    expect(completed!.payload.verification?.status).toBe('passed');
    expect(completed!.payload.verification?.evidence[0].checkName).toBe('verifier');
  });

  it('emits VERIFY_FAILED error and loops back to THINK', async () => {
    const engine = new AgentLoopEngine();
    let verifyCount = 0;
    const ctx = baseCtx({
      llm: textLLM('buggy code'),
      verifier: {
        evaluate: async () => {
          verifyCount++;
          return { passed: false, feedback: 'missing null check', evidence: [{ id: 'check-1', checkName: 'null-check', status: 'failed', summary: 'missing null check', source: 'engine', timestamp: Date.now() }] };
        },
      },
    });

    const events = await collect(engine.run(
      { sessionId: 's8', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    const verifyErrors = events.filter(e => e.type === 'Error' && e.payload.code === 'VERIFY_FAILED');
    const completed = events.find(e => e.type === 'Completed');

    // VERIFY_FAILED should be emitted each time verify runs
    expect(verifyErrors.length).toBeGreaterThan(0);
    if (verifyErrors[0] && verifyErrors[0].type === 'Error') {
      expect(verifyErrors[0].payload.message).toContain('missing null check');
    }

    // Eventually budget is exceeded and we get Completed with interrupted: true
    expect(completed).toBeDefined();
    // The loop should have tried verification > 1 time
    expect(verifyCount).toBeGreaterThan(1);
    expect(completed!.payload.verification?.status).toBe('failed');
    expect(completed!.payload.verification?.evidence[0].checkName).toBe('null-check');
  });

  it('handles verifier throwing', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm: textLLM('code'),
      verifier: {
        evaluate: async () => { throw new Error('verifier crash'); },
      },
    });

    const events = await collect(engine.run(
      { sessionId: 's9', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    const verifyError = events.find(e => e.type === 'Error' && e.payload.code === 'VERIFIER_ERROR');
    const completed = events.find(e => e.type === 'Completed');
    expect(verifyError).toBeDefined();
    if (verifyError && verifyError.type === 'Error') {
      expect(verifyError.payload.message).toContain('verifier crash');
    }
    // Still completes gracefully
    expect(completed).toBeDefined();
  });

  // ═══ Tool failure handling ═══

  it('records failed tool results and continues', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm: toolThenTextLLM('read_file', '{"path":"missing.ts"}', 'File not readable.'),
      tools: failToolAdapter([READ_FILE_TOOL], 'read_file'),
      toolsDefs: [READ_FILE_TOOL],
    });

    const events = await collect(engine.run(
      { sessionId: 's10', systemPrompt: 'X', userPrompt: 'Read missing.ts', budget: STD_BUDGET },
      ctx,
    ));

    const toolResults = events.filter(e => e.type === 'ToolResult');
    const completed = events.find(e => e.type === 'Completed');

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].payload.result.success).toBe(false);
    expect(toolResults[0].payload.result.error).toBe('tool execution failed');
    expect(completed).toBeDefined();
  });

  // ═══ v1.9.7 — every failed execution degrades subsequent thinking ═══

  it('injects a degradation note after a failed tool call (no policy)', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm: toolThenTextLLM('read_file', '{"path":"missing.ts"}', 'File not readable.'),
      tools: failToolAdapter([READ_FILE_TOOL], 'read_file'),
      toolsDefs: [READ_FILE_TOOL],
    });

    const events = await collect(engine.run(
      { sessionId: 's10b', systemPrompt: 'X', userPrompt: 'Read missing.ts', budget: STD_BUDGET },
      ctx,
    ));

    const completed = events.find(e => e.type === 'Completed');
    expect(completed).toBeDefined();
    const note = completed!.payload.messages!.find(
      m => m.role === 'user' && m.content.includes('Degrade this approach'),
    );
    expect(note).toBeDefined();
    expect(note!.content).toContain('read_file');
    expect(note!.content).toContain('tool execution failed');
    expect(note!.content).toContain('do NOT repeat the exact same call');
    expect(note!.content).toContain('Prefer approaches that have already proven successful this session');
  });

  it('injects the degradation note alongside the policy hint on retry', async () => {
    const engine = new AgentLoopEngine();
    const retryPolicy = { decide: () => ({ kind: 'retry' as const, hint: 'try again, simpler' }) };
    const ctx = baseCtx({
      llm: toolThenTextLLM('read_file', '{"path":"missing.ts"}', 'File not readable.'),
      tools: failToolAdapter([READ_FILE_TOOL], 'read_file'),
      toolsDefs: [READ_FILE_TOOL],
      failurePolicy: retryPolicy,
    });

    const events = await collect(engine.run(
      { sessionId: 's10c', systemPrompt: 'X', userPrompt: 'Read missing.ts', budget: STD_BUDGET },
      ctx,
    ));

    const completed = events.find(e => e.type === 'Completed');
    expect(completed).toBeDefined();
    const userContents = completed!.payload.messages!
      .filter(m => m.role === 'user')
      .map(m => m.content);
    expect(userContents.some(c => c.includes('Degrade this approach'))).toBe(true);
    expect(userContents.some(c => c.includes('try again, simpler'))).toBe(true);
  });

  // ═══ Continue mode ═══

  it('continue() starts from previous messages', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({ llm: textLLM('Rust is great!') });

    const prevMessages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'I like Rust.' },
      { role: 'assistant', content: 'Noted!' },
    ];

    const events = await collect(engine.continue(
      { sessionId: 's11', messages: prevMessages, newUserPrompt: 'What did I say?', budget: STD_BUDGET },
      ctx,
    ));

    const completed = events.find(e => e.type === 'Completed');
    expect(completed).toBeDefined();
    expect(completed!.payload.finalOutput).toBe('Rust is great!');
  });

  // ═══ YieldControl event (G-5 fix) ═══

  it('emits YieldControl with turnNumber and budget snapshot after tool rounds', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm: multiRoundLLM(
        [
          { toolName: 'read_file', toolArgs: '{"path":"a.ts"}' },
          { toolName: 'list_files', toolArgs: '{"path":"src"}' },
        ],
        'Done.',
      ),
      tools: echoToolAdapter([READ_FILE_TOOL, LIST_FILES_TOOL]),
      toolsDefs: [READ_FILE_TOOL, LIST_FILES_TOOL],
    });

    const events = await collect(engine.run(
      { sessionId: 's-yc', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    const controls = events.filter(e => e.type === 'YieldControl');
    // One YieldControl per completed turn (initial + 2 tool rounds → 3 yields)
    expect(controls.length).toBe(3);
    const first = controls[0];
    if (first.type === 'YieldControl') {
      expect(first.payload.turnNumber).toBeGreaterThan(0);
      expect(first.payload.budget.turns.max).toBe(STD_BUDGET.maxTurns);
      expect(typeof first.payload.budget.elapsed).toBe('number');
    }
  });

  it('emits YieldControl on the verify-retry path', async () => {
    const engine = new AgentLoopEngine();
    let verifyCount = 0;
    const ctx = baseCtx({
      llm: textLLM('code'),
      verifier: {
        evaluate: async () => {
          verifyCount++;
          return { passed: verifyCount > 1, feedback: 'needs fix' };
        },
      },
    });

    const events = await collect(engine.run(
      { sessionId: 's-yc2', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    const controls = events.filter(e => e.type === 'YieldControl');
    // First verify fails → retry turn yields a YieldControl; second passes.
    expect(controls.length).toBeGreaterThanOrEqual(1);
  });

  // ═══ BudgetWarning event ═══

  it('emits BudgetWarning when approaching limits', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm: toolThenTextLLM('read_file', '{"path":"a.ts"}', 'done'),
      tools: echoToolAdapter([READ_FILE_TOOL]),
      toolsDefs: [READ_FILE_TOOL],
      budget: { ...STD_BUDGET, maxTurns: 2, warningThreshold: 0.5, graceTurns: 3 },
    });

    const events = await collect(engine.run(
      { sessionId: 's12', systemPrompt: 'X', userPrompt: 'Y', budget: ctx.budget },
      ctx,
    ));

    const warnings = events.filter(e => e.type === 'BudgetWarning');
    // With maxTurns=2 and warningThreshold=0.5, after 1 turn (50%) warning fires
    // Then after turn exceeds max, grace kicks in with another warning
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  // ═══ Hooks integration (P1-5) ═══

  it('aborts the run via a before_think hook', async () => {
    const engine = new AgentLoopEngine();
    const hooks = new DefaultHookRouter();
    hooks.register('before_think', () => ({ action: 'abort' as const, reason: 'policy block' }));
    const ctx = baseCtx({ hooks });

    const events = await collect(engine.run(
      { sessionId: 's13', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    const interrupted = events.find(e => e.type === 'Interrupted');
    expect(interrupted).toBeDefined();
    expect(interrupted!.payload.reason).toBe('Hook aborted before think');
    const completed = events.find(e => e.type === 'Completed');
    expect(completed!.payload.interrupted).toBe(true);
  });

  // ═══ Failure policy integration (P1-5) ═══

  it('escalates consecutive LLM failures until the policy stops the run', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm: errorLLM('boom'),
      failurePolicy: new DefaultFailurePolicy(),
      budget: { ...STD_BUDGET, maxTurns: 12, graceTurns: 0 },
    });

    const events = await collect(engine.run(
      { sessionId: 's14', systemPrompt: 'X', userPrompt: 'Y', budget: ctx.budget },
      ctx,
    ));

    // Without a policy this would emit LLM_STREAM_ERROR and stop at once;
    // with the escalating policy it retries/reflects first. The identical
    // error repeats ('boom' every time) → v0.11 repeated-error detection
    // stops after 3 identical repeats (not the generic 6-failure ceiling).
    const llmErrors = events.filter(e => e.type === 'Error' && e.payload.code === 'LLM_STREAM_ERROR');
    expect(llmErrors.length).toBe(0);
    const interrupted = events.find(e => e.type === 'Interrupted');
    expect(interrupted).toBeDefined();
    expect(interrupted!.payload.reason).toContain('consecutive failures');
  });

  // ═══ FailurePolicyDecision event (v0.10 §12.3 memory writes) ═══

  it('emits FailurePolicyDecision on every policy decision', async () => {
    const engine = new AgentLoopEngine();
    const policy = {
      decide: (failures: Array<{ type: string; message: string; turnNumber: number }>) => {
        return { kind: 'retry' as const, hint: `retry ${failures.length}` };
      },
    };
    // Two failures → two decisions, then a success stops the retry loop.
    let calls = 0;
    const flakyLLM: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        calls++;
        if (calls <= 2) throw new Error('transient llm error');
        yield { type: 'content', content: 'finally ok' };
        yield { type: 'done', content: 'finally ok', toolCalls: [] };
      },
      complete: async () => ({ content: 'ok', toolCalls: [] }),
    };
    const ctx = baseCtx({ llm: flakyLLM, failurePolicy: policy });

    const events = await collect(engine.run(
      { sessionId: 's-policy', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    const decisions = events.filter(e => e.type === 'FailurePolicyDecision');
    expect(decisions).toHaveLength(2);
    if (decisions[0]?.type === 'FailurePolicyDecision') {
      expect(decisions[0].payload.action.kind).toBe('retry');
      expect(decisions[0].payload.failure.type).toBe('llm_error');
      expect(decisions[0].payload.failure.message).toContain('transient llm error');
      expect(decisions[0].payload.turnNumber).toBeGreaterThan(0);
    }
    // Session recovered and completed.
    const completed = events.find(e => e.type === 'Completed');
    expect(completed?.payload.isComplete).toBe(true);
  });

  it('emits FailurePolicyDecision with stop action when policy stops', async () => {
    const engine = new AgentLoopEngine();
    const policy = {
      decide: () => ({ kind: 'stop' as const, reason: 'too many failures, giving up' }),
    };
    const ctx = baseCtx({ llm: errorLLM('fatal boom'), failurePolicy: policy });

    const events = await collect(engine.run(
      { sessionId: 's-policy-stop', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    const decision = events.find(e => e.type === 'FailurePolicyDecision');
    expect(decision).toBeDefined();
    if (decision?.type === 'FailurePolicyDecision') {
      expect(decision.payload.action.kind).toBe('stop');
      if (decision.payload.action.kind === 'stop') {
        expect(decision.payload.action.reason).toContain('too many failures');
      }
    }
    const interrupted = events.find(e => e.type === 'Interrupted');
    expect(interrupted).toBeDefined();
  });

  it('pairs tool results into the transcript BEFORE a failure-policy stop lands', async () => {
    // Tool fails on round 1 and the policy stops immediately. The old order —
    // emitHandover/Interrupted FIRST, tool results pushed only on the retry
    // path — sent the handover request and the interrupted checkpoint with an
    // UNPAIRED assistant.toolCalls tail (providers answer 400), so the
    // "graceful handover" silently never worked in the most common stop
    // scenario and the persisted transcript stayed malformed.
    const handoverRequests: Message[][] = [];
    let round = 0;
    const llm: LLMAdapter = {
      stream: async function* (messages: Message[]): AsyncGenerator<LLMChunk, void, void> {
        round++;
        if (round === 1) {
          const tc: ToolCall = { id: 'call_1', index: 0, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } };
          yield { type: 'tool_call', index: 0, id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' };
          yield { type: 'done', content: '', toolCalls: [tc] };
          return;
        }
        handoverRequests.push(messages.map(m => ({ ...m }) as Message));
        yield { type: 'content', content: 'Blocked: the read failed.' };
        yield { type: 'done', content: 'Blocked: the read failed.', toolCalls: [] };
      },
      complete: async () => ({ content: 'Blocked: the read failed.', toolCalls: [] }),
    };
    const engine = new AgentLoopEngine();

    const events = await collect(engine.run(
      { sessionId: 's-stop-pairing', systemPrompt: 'SYS', userPrompt: 'read a.ts', budget: STD_BUDGET },
      baseCtx({
        llm,
        tools: failToolAdapter([READ_FILE_TOOL], 'read_file'),
        toolsDefs: [READ_FILE_TOOL],
        failurePolicy: { decide: () => ({ kind: 'stop' as const, reason: 'tool keeps failing' }) },
      }),
    ));

    const interrupted = events.find(e => e.type === 'Interrupted') as Extract<EngineEvent, { type: 'Interrupted' }>;
    expect(interrupted).toBeDefined();
    expect(interrupted.payload.messages).toBeDefined();
    // The interrupted transcript is a sendable conversation: every assistant
    // toolCalls has its tool results.
    expect(transcriptIsPaired(interrupted.payload.messages!)).toBe(true);
    // The handover LLM call actually happened AND received a paired transcript.
    expect(handoverRequests).toHaveLength(1);
    expect(transcriptIsPaired(handoverRequests[0])).toBe(true);
    // The final Completed (interrupted=true) carries the same well-formed tail.
    const completed = events.find(e => e.type === 'Completed') as Extract<EngineEvent, { type: 'Completed' }>;
    expect(completed.payload.interrupted).toBe(true);
    expect(completed.payload.messages).toBeDefined();
    expect(transcriptIsPaired(completed.payload.messages!)).toBe(true);
  });

  // ═══ Lock release on tool throw (P0 fix) ═══

  it('releases the path lock when a tool throws (no deadlock on retry)', async () => {
    const engine = new AgentLoopEngine();
    let calls = 0;
    const throwingToolAdapter: ToolAdapter = {
      execute: async (): Promise<ToolResult> => {
        calls++;
        if (calls === 1) throw new Error('tool exploded');
        return { id: 'x', toolName: 'read_file', result: 'recovered', success: true, duration: 1 };
      },
      getMetadata: (name: string) => ({ isWrite: name === 'write_file' }),
      getTools: () => [READ_FILE_TOOL],
    };
    // Track acquire/release pairing on a custom lock manager.
    const released: string[] = [];
    const lockManager = {
      acquireRead: async (p: string) => {},
      acquireWrite: async (p: string) => {},
      release: (p: string) => { released.push(p); },
    };
    const ctx = baseCtx({
      llm: multiRoundLLM([{ toolName: 'read_file', toolArgs: '{"path":"a.ts"}' }], 'done'),
      tools: throwingToolAdapter,
      toolsDefs: [READ_FILE_TOOL],
      lockManager,
    });

    const events = await collect(engine.run(
      { sessionId: 's-lock', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    // The thrown tool error was caught → error result, not a crash.
    expect(events.find(e => e.type === 'ToolResult')).toBeDefined();
    // The lock for a.ts must have been released even though execute threw.
    expect(released).toContain('a.ts');
  });

  it('escalates consecutive TOOL failures (validates the failure-streak reset fix)', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm: multiRoundLLM(
        Array.from({ length: 8 }, (_, i) => ({ toolName: 'read_file', toolArgs: `{"path":"f${i}.ts"}` })),
        'final',
      ),
      tools: failToolAdapter([READ_FILE_TOOL], 'read_file'),
      toolsDefs: [READ_FILE_TOOL],
      failurePolicy: new DefaultFailurePolicy(),
    });

    const events = await collect(engine.run(
      { sessionId: 's15', systemPrompt: 'X', userPrompt: 'Read missing.ts', budget: STD_BUDGET },
      ctx,
    ));

    // Before the reset fix, tool failures were wiped after every THINK, so the
    // policy always saw a count of 1 (retry forever). With the fix the streak
    // survives across rounds → the identical 'tool execution failed' repeats
    // trigger v0.11 repeated-error detection and stop after 3.
    const interrupted = events.find(e => e.type === 'Interrupted');
    expect(interrupted).toBeDefined();
    expect(interrupted!.payload.reason).toContain('consecutive failures');
  });

  // ═══ Consecutive-identical dedupe (same round) ═══
  // A parallel batch containing the very same call twice used to execute both
  // copies: the dedupe cursor only covered the PREVIOUS round's last call, so
  // in-round duplicates slipped through and touched the world twice.

  it('executes a back-to-back duplicate call once and reuses the result', async () => {
    const engine = new AgentLoopEngine();
    const adapter = countingToolAdapter([READ_FILE_TOOL]);
    const ctx = baseCtx({
      llm: parallelRoundsLLM([[
        { toolName: 'read_file', toolArgs: '{"path":"src/a.ts"}' },
        { toolName: 'read_file', toolArgs: '{"path":"src/a.ts"}' },
      ]], 'done'),
      tools: adapter,
      toolsDefs: [READ_FILE_TOOL],
    });

    const events = await collect(engine.run(
      { sessionId: 's-dedupe-ok', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    // The world was touched once; the repeat carries the anchor's result plus
    // the dedupe note instead of a second execution.
    expect(adapter.executions).toHaveLength(1);
    const results = events.filter(e => e.type === 'ToolResult');
    expect(results).toHaveLength(2);
    expect(results[0]!.payload.toolCallId).toBe('call_1_0');
    expect(results[1]!.payload.toolCallId).toBe('call_1_1');
    expect(results[0]!.payload.result.success).toBe(true);
    expect(String(results[0]!.payload.result.result)).not.toContain('[dedupe]');
    expect(results[1]!.payload.result.success).toBe(true);
    expect(String(results[1]!.payload.result.result)).toContain('executed read_file with {"path":"src/a.ts"}');
    expect(String(results[1]!.payload.result.result)).toContain('[dedupe]');
  });

  it('re-executes a duplicate when the anchor execution failed', async () => {
    const engine = new AgentLoopEngine();
    const adapter = countingToolAdapter([READ_FILE_TOOL], true);
    const ctx = baseCtx({
      llm: parallelRoundsLLM([[
        { toolName: 'read_file', toolArgs: '{"path":"src/a.ts"}' },
        { toolName: 'read_file', toolArgs: '{"path":"src/a.ts"}' },
      ]], 'done'),
      tools: adapter,
      toolsDefs: [READ_FILE_TOOL],
    });

    const events = await collect(engine.run(
      { sessionId: 's-dedupe-fail', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    // A failed call is never deduped — the repeat ran for real (the retry
    // succeeds here) and its own result is used verbatim, no dedupe note.
    expect(adapter.executions).toHaveLength(2);
    const results = events.filter(e => e.type === 'ToolResult');
    expect(results).toHaveLength(2);
    expect(results[0]!.payload.result.success).toBe(false);
    expect(results[1]!.payload.result.success).toBe(true);
    expect(String(results[1]!.payload.result.result)).not.toContain('[dedupe]');
  });

  it('still executes an identical call that follows a different call', async () => {
    // [read(a), read(b), read(a)]: the second read(a) is NOT back-to-back —
    // the round itself may have changed the world in between, so deduping it
    // would feed the model stale data. Every call runs for real.
    const engine = new AgentLoopEngine();
    const adapter = countingToolAdapter([READ_FILE_TOOL]);
    const ctx = baseCtx({
      llm: parallelRoundsLLM([[
        { toolName: 'read_file', toolArgs: '{"path":"a.ts"}' },
        { toolName: 'read_file', toolArgs: '{"path":"b.ts"}' },
        { toolName: 'read_file', toolArgs: '{"path":"a.ts"}' },
      ]], 'done'),
      tools: adapter,
      toolsDefs: [READ_FILE_TOOL],
    });

    const events = await collect(engine.run(
      { sessionId: 's-dedupe-gap', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      ctx,
    ));

    expect(adapter.executions).toHaveLength(3);
    const results = events.filter(e => e.type === 'ToolResult');
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.type === 'ToolResult' && r.payload.result.success).toBe(true);
      expect(String(r.type === 'ToolResult' && r.payload.result.result)).not.toContain('[dedupe]');
    }
  });
});

describe('AgentLoopEngine per-phase adapter routing (E0.3)', () => {
  /** Wrap an adapter so the test can count how many times the engine streamed from it. */
  function countingLLM(inner: LLMAdapter, counter: { count: number }): LLMAdapter {
    return {
      stream(messages, tools, signal) {
        counter.count++;
        return inner.stream(messages, tools, signal);
      },
      complete: (messages, tools, signal) => inner.complete(messages, tools, signal),
    };
  }

  it('streams THINK through the phase adapter and never touches the default', async () => {
    const thinkCalls = { count: 0 };
    const defaultCalls = { count: 0 };
    const engine = new AgentLoopEngine();
    const events = await collect(engine.run(
      { sessionId: 's-phase-think', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      baseCtx({
        llm: countingLLM(textLLM('default adapter answered'), defaultCalls),
        llmFor: (phase) => (phase === 'THINK' ? countingLLM(textLLM('phase adapter answered'), thinkCalls) : undefined),
      }),
    ));

    expect(thinkCalls.count).toBe(1);
    expect(defaultCalls.count).toBe(0);
    const completed = events.find(e => e.type === 'Completed');
    expect(completed?.type === 'Completed' && completed.payload.finalOutput).toBe('phase adapter answered');
  });

  it('serves the HANDOVER wrap-up from its own adapter on a policy stop', async () => {
    const handoverCalls = { count: 0 };
    const engine = new AgentLoopEngine();
    // THINK explodes on the first round; the policy stops immediately, which
    // triggers the graceful-handover LLM round — routed to the HANDOVER
    // adapter, not back to the (dead) THINK one.
    const events = await collect(engine.run(
      { sessionId: 's-phase-handover', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      baseCtx({
        llm: errorLLM('provider down'),
        failurePolicy: { decide: () => ({ kind: 'stop', reason: 'stop now' }) },
        llmFor: (phase) => (phase === 'HANDOVER' ? countingLLM(textLLM('handover summary'), handoverCalls) : undefined),
      }),
    ));

    expect(handoverCalls.count).toBe(1);
    const interrupted = events.find(e => e.type === 'Interrupted');
    expect(interrupted?.type === 'Interrupted' && interrupted.payload.reason).toBe('stop now');
    // The handover summary the user actually sees comes from the phase adapter.
    const completed = events.find(e => e.type === 'Completed');
    const messages = completed?.type === 'Completed' ? completed.payload.messages : undefined;
    const lastAssistant = messages
      ? [...messages].reverse().find(m => m.role === 'assistant')
      : undefined;
    expect(lastAssistant?.content).toContain('handover');
  });

  it('keeps the single-adapter behavior when llmFor is absent', async () => {
    const defaultCalls = { count: 0 };
    const engine = new AgentLoopEngine();
    await collect(engine.run(
      { sessionId: 's-phase-default', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      baseCtx({ llm: countingLLM(textLLM('only adapter'), defaultCalls) }),
    ));

    expect(defaultCalls.count).toBe(1);
  });

  it('falls back to the default adapter for phases the resolver leaves undefined (single-model config)', async () => {
    const defaultCalls = { count: 0 };
    const engine = new AgentLoopEngine();
    const events = await collect(engine.run(
      { sessionId: 's-phase-partial', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      baseCtx({
        llm: countingLLM(textLLM('default adapter'), defaultCalls),
        // Only THINK got a dedicated model — and it is down. HANDOVER has no
        // dedicated model: it must fall back to the default adapter.
        llmFor: (phase) => (phase === 'THINK' ? errorLLM('dedicated think model is down') : undefined),
        failurePolicy: { decide: () => ({ kind: 'stop', reason: 'stop now' }) },
      }),
    ));

    // The policy stop fires, and the HANDOVER wrap-up streams through the
    // DEFAULT adapter — the user still gets a graceful summary even though
    // their dedicated THINK model just died.
    const interrupted = events.find(e => e.type === 'Interrupted');
    expect(interrupted?.type === 'Interrupted' && interrupted.payload.reason).toBe('stop now');
    const completed = events.find(e => e.type === 'Completed');
    const messages = completed?.type === 'Completed' ? completed.payload.messages : undefined;
    const lastAssistant = messages ? [...messages].reverse().find(m => m.role === 'assistant') : undefined;
    expect(lastAssistant?.content).toContain('default');
    expect(defaultCalls.count).toBe(1);
  });

  it('survives a throwing resolver by falling back to the default adapter', async () => {
    const defaultCalls = { count: 0 };
    const engine = new AgentLoopEngine();
    const events = await collect(engine.run(
      { sessionId: 's-phase-throwing', systemPrompt: 'X', userPrompt: 'Y', budget: STD_BUDGET },
      baseCtx({
        llm: countingLLM(textLLM('default adapter saved the run'), defaultCalls),
        llmFor: () => {
          throw new Error('misconfigured per-phase routing');
        },
      }),
    ));

    expect(defaultCalls.count).toBe(1);
    const completed = events.find(e => e.type === 'Completed');
    expect(completed?.type === 'Completed' && completed.payload.finalOutput).toBe('default adapter saved the run');
  });
});
