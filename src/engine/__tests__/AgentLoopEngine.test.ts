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
    expect(tokens.length).toBeGreaterThan(0);
  });

  // ═══ ReAct loop: THINK → ACT → OBSERVE → THINK → VERIFY → TERMINATE ═══

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
    const completed = events.find(e => e.type === 'Completed');

    const transitions = stateChanges.map(e => `${e.payload.from}→${e.payload.to}`);
    expect(transitions).toContain('THINK→ACT');
    expect(transitions).toContain('ACT→OBSERVE');
    expect(transitions).toContain('OBSERVE→THINK');
    expect(transitions).toContain('THINK→VERIFY');
    expect(transitions).toContain('VERIFY→TERMINATE');

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
  });

  // ═══ BudgetManager: check() override via tiny budget ═══

  it('emits Interrupted when token budget is exceeded', async () => {
    const engine = new AgentLoopEngine();
    const ctx = baseCtx({
      llm: textLLM('A'.repeat(500)),
      budget: { ...STD_BUDGET, maxTotalTokens: 10, graceTurns: 0 },
    });

    const events = await collect(engine.run(
      { sessionId: 's5', systemPrompt: 'X', userPrompt: 'A'.repeat(200), budget: ctx.budget },
      ctx,
    ));

    const interrupted = events.find(e => e.type === 'Interrupted');
    expect(interrupted).toBeDefined();
    expect(interrupted!.payload.reason).toBe('Budget exceeded');
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
      budget: { ...STD_BUDGET, maxTurns: 2, graceTurns: 0 },
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
  });

  it('emits VERIFY_FAILED error and loops back to THINK', async () => {
    const engine = new AgentLoopEngine();
    let verifyCount = 0;
    const ctx = baseCtx({
      llm: textLLM('buggy code'),
      verifier: {
        evaluate: async () => {
          verifyCount++;
          return { passed: false, feedback: 'missing null check' };
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
    // with the escalating policy it retries/reflects first and only stops
    // after 6 consecutive failures.
    const llmErrors = events.filter(e => e.type === 'Error' && e.payload.code === 'LLM_STREAM_ERROR');
    expect(llmErrors.length).toBe(0);
    const interrupted = events.find(e => e.type === 'Interrupted');
    expect(interrupted).toBeDefined();
    expect(interrupted!.payload.reason).toContain('consecutive failures');
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
    // survives across rounds → after 6 consecutive tool failures the policy
    // stops the run.
    const interrupted = events.find(e => e.type === 'Interrupted');
    expect(interrupted).toBeDefined();
    expect(interrupted!.payload.reason).toContain('consecutive failures');
  });
});
