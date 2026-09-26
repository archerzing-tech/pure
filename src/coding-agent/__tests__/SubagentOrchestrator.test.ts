// src/coding-agent/__tests__/SubagentOrchestrator.test.ts
// Coverage for the multi-agent delegation path:
//  1. SubagentOrchestrator spawns a real AgentLoopEngine per subagent call,
//     streams progress, and returns a structured result to the parent.
//  2. ToolRegistry exposes subagent tools to the model (getSubagentTools) and
//     routes AGENT-tagged calls to the orchestrator.
// The LLM is mocked (no tool calls) so the subagent engine runs its loop to a
// clean Completed event — no network, no real provider.

import { describe, expect, it } from 'bun:test';
import { SubagentOrchestrator, deriveSubagentBudget, makeAgentId, BUILT_IN_SUBAGENTS, CODING_AGENT_ROLES, type SubagentActivity, type SubagentProgress } from '../SubagentOrchestrator';
import { Verifier } from '../Verifier';
import { Tags, ToolRegistry } from '../ToolRegistry';
import { MULTI_AGENT_PROTOCOL } from '../../shared/promptLayers';
import { MockLLMAdapter } from '../../adapter/mock/MockLLMAdapter';
import { abortPaused } from '../../shared/pauseSignal';
import type { BudgetConfig, Checkpoint, IStateStore, LLMAdapter, LLMChunk, Message, ToolAdapter, ToolCall, ToolDefinition, ToolResult } from '../../shared/types';
import type { SubagentDefinition, SubagentResult } from '../types';

const BUDGET: BudgetConfig = {
  maxTurns: 5,
  maxTotalTokens: 10000,
  maxExecutionTime: 60000,
  warningThreshold: 0.8,
  graceTurns: 1,
};

/** A ToolAdapter stub — the subagent uses the MockLLM (no tool calls), so this
 * never executes anything. */
const stubAdapter: ToolAdapter = {
  getTools: () => [],
  getMetadata: () => undefined,
  execute: async (tc: ToolCall): Promise<ToolResult> => ({
    id: tc.id,
    toolName: tc.function.name,
    success: false,
    error: 'stub should not be reached',
    duration: 0,
  }),
};

function subagentDef(name: string): SubagentDefinition {
  return {
    name,
    description: `Test subagent ${name}`,
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    },
    tags: [Tags.AGENT, Tags.READ],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) =>
      `You are ${name}. Task: ${String(input.prompt ?? '')}`,
    defaultTimeoutMs: 5000,
  };
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${name}`,
    index: 0,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function makeOrchestrator(progress?: SubagentProgress): SubagentOrchestrator {
  const orch = new SubagentOrchestrator({
    llm: new MockLLMAdapter('research findings'),
    parentTools: stubAdapter,
    parentToolsDefs: [],
    defaultBudget: BUDGET,
    progress,
  });
  orch.register(subagentDef('test_researcher'));
  return orch;
}

describe('SubagentOrchestrator', () => {
  it('runs a subagent engine loop and returns its output as a structured result', async () => {
    const orch = makeOrchestrator();
    const result = await orch.execute(toolCall('test_researcher', { prompt: 'research X' }));
    expect(result.success).toBe(true);
    expect(result.toolName).toBe('test_researcher');
    const sub = result.result as SubagentResult;
    expect(sub.agentName).toBe('test_researcher');
    expect(sub.success).toBe(true);
    expect(sub.output).toContain('research findings');
    expect(typeof sub.duration).toBe('number');
  });

  it('emits live progress events (start / state / done) keyed by the parent call id', async () => {
    const seen: SubagentActivity[] = [];
    const progress: SubagentProgress = {
      onStart: (a) => seen.push(a),
      onState: (a) => seen.push(a),
      onDone: (a) => seen.push(a),
    };
    const orch = makeOrchestrator(progress);
    const result = await orch.execute(toolCall('test_researcher', { prompt: 'research X' }));
    expect(result.success).toBe(true);
    // All events carry the stable parent call-id so the UI can key cards.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((a) => a.callId === 'call_test_researcher')).toBe(true);
    expect(seen.every((a) => a.agentName === 'test_researcher')).toBe(true);
    // At least one start and one successful done.
    expect(seen.some((a) => a.success === true)).toBe(true);
    expect(seen.every((a, index) => index === 0 || (a.sequence ?? 0) > (seen[index - 1]?.sequence ?? 0))).toBe(true);
    expect(seen.some((a) => a.lifecycle === 'started')).toBe(true);
    expect(seen.some((a) => a.lifecycle === 'done')).toBe(true);
  });

  it('returns a failure when the subagent engine errors', async () => {
    const failingLLM: LLMAdapter = {
      async *stream(): AsyncGenerator<never> {
        throw new Error('provider boom');
      },
      async complete(): Promise<never> {
        throw new Error('provider boom');
      },
    };
    const orch = new SubagentOrchestrator({
      llm: failingLLM,
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
    });
    orch.register(subagentDef('test_researcher'));
    const result = await orch.execute(toolCall('test_researcher', { prompt: 'x' }));
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('provider boom');
  });

  it('lets the engine recover from a RECOVERABLE error instead of killing the subagent mid-recovery', async () => {
    // The engine emits Error(VERIFY_FAILED, recoverable=true) when its verifier
    // rejects the first answer, folds a recovery hint into the messages, and
    // loops. The orchestrator used to treat ANY Error event as terminal —
    // abandoning a healthy self-correction and reporting the delegation
    // failed. The delegation must complete once the second answer verifies.
    let verifyCalls = 0;
    const orch = new SubagentOrchestrator({
      llm: new MockLLMAdapter('research findings'),
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      // First evaluate fails (→ VERIFY_FAILED, recoverable) with the engine
      // retrying; the retry passes and the run completes normally.
      verifier: new Verifier([{
        name: 'flip-flop',
        run: async () => {
          verifyCalls++;
          return verifyCalls === 1
            ? { passed: false, feedback: 'answer too shallow' }
            : { passed: true };
        },
      }]),
    });
    orch.register(subagentDef('test_researcher'));

    const result = await orch.execute(toolCall('test_researcher', { prompt: 'research X' }));

    expect(verifyCalls).toBe(2);
    expect(result.success).toBe(true);
    const sub = result.result as SubagentResult;
    expect(sub.success).toBe(true);
    expect(sub.output).toContain('research findings');
  });

  it('rejects an unknown subagent name', async () => {
    const orch = makeOrchestrator();
    const result = await orch.execute(toolCall('does_not_exist', { prompt: 'x' }));
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Unknown subagent');
  });
});

describe('ToolRegistry subagent exposure and routing', () => {
  it('exposes subagent tools to the model but keeps them out of the public list', () => {
    const registry = new ToolRegistry(stubAdapter);
    registry.register(subagentDef('test_researcher'));
    expect(registry.getSubagentTools().some((t) => t.name === 'test_researcher')).toBe(true);
    expect(registry.getTools().some((t) => t.name === 'test_researcher')).toBe(false);
  });

  it('getSubagentTools returns only AGENT-tagged tools', () => {
    const registry = new ToolRegistry(stubAdapter);
    registry.register(subagentDef('agent_one'));
    registry.register({ ...subagentDef('plain_tool'), tags: [Tags.READ] });
    const names = registry.getSubagentTools().map((t) => t.name);
    expect(names).toEqual(['agent_one']);
  });

  it('routes an AGENT-tagged call to the orchestrator executor', async () => {
    const registry = new ToolRegistry(stubAdapter);
    const orch = new SubagentOrchestrator({
      llm: new MockLLMAdapter('findings'),
      parentTools: registry,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
    });
    orch.register(subagentDef('test_researcher'));
    registry.register(subagentDef('test_researcher'));
    registry.setSubagentExecutor(orch);

    const result = await registry.execute(toolCall('test_researcher', { prompt: 'x' }));
    expect(result.success).toBe(true);
    // It went through the orchestrator, not the stub delegate.
    expect((result.result as SubagentResult).agentName).toBe('test_researcher');
  });
});

// ── P1: parallel/serial classification, depth, budget, status, checkpoint ──

function subagentDefWith(name: string, tags: string[], timeoutMs = 5000): SubagentDefinition {
  return {
    ...subagentDef(name),
    tags: [Tags.AGENT, ...tags],
    defaultTimeoutMs: timeoutMs,
  };
}

describe('SubagentOrchestrator P1', () => {
  it('classifies read-only subagents as parallel (sideEffects:false), mutators as serial', () => {
    const orch = makeOrchestrator();
    orch.register(subagentDefWith('reader', [Tags.READ]));
    orch.register(subagentDefWith('writer', [Tags.WRITE]));
    orch.register(subagentDefWith('basher', [Tags.SHELL]));
    orch.register(subagentDefWith('destructive', [Tags.DESTRUCTIVE]));

    expect(orch.getMetadata('reader')).toEqual({ sideEffects: false, isWrite: false, timeoutMs: 5000 });
    expect(orch.getMetadata('writer')).toEqual({ sideEffects: true, isWrite: false, timeoutMs: 5000 });
    expect(orch.getMetadata('basher')).toEqual({ sideEffects: true, isWrite: false, timeoutMs: 5000 });
    expect(orch.getMetadata('destructive')).toEqual({ sideEffects: true, isWrite: false, timeoutMs: 5000 });
  });

  it('publishes the definition budget and parallel/serial class through getMetadata', () => {
    const registry = new ToolRegistry(stubAdapter);
    const orch = new SubagentOrchestrator({
      llm: new MockLLMAdapter('findings'),
      parentTools: registry,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
    });
    // Regression: a delegation used to be boxed by the engine's generic
    // 3-minute tool cap even though the definition budgeted far more —
    // code_reviewer "timed out after 3m" then failed retries identically.
    const reviewer = subagentDefWith('test_reviewer', [Tags.READ], 600_000);
    const editor = subagentDefWith('test_editor', [Tags.WRITE], 600_000);
    orch.register(reviewer);
    orch.register(editor);
    registry.register(reviewer);
    registry.register(editor);
    registry.setSubagentExecutor(orch);

    // Read-only delegations run in the parent's PARALLEL reads pool…
    expect(registry.getMetadata('test_reviewer')).toEqual({
      sideEffects: false,
      isWrite: false,
      timeoutMs: 600_000,
    });
    // …and file-mutating ones too (2026-09-20): no delegation is isWrite —
    // they overlap in the reads pool; same-file safety is the inner
    // FileLockManager's job, not whole-agent serialization.
    expect(registry.getMetadata('test_editor')).toEqual({
      sideEffects: true,
      isWrite: false,
      timeoutMs: 600_000,
    });
    // Plain tools carry no budget declaration — the generic cap applies.
    registry.register({ ...subagentDef('plain_tool'), tags: [Tags.READ] });
    expect(registry.getMetadata('plain_tool')?.timeoutMs).toBeUndefined();
  });

  it('refuses to nest a subagent beyond maxDepth', async () => {
    const orch = new SubagentOrchestrator({
      llm: new MockLLMAdapter('x'),
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      depth: 1,      // already 1 level deep
      maxDepth: 1,   // single-level delegation only
    });
    orch.register(subagentDef('test_researcher'));
    const result = await orch.execute(toolCall('test_researcher', { prompt: 'x' }));
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('嵌套超过层级限制');
  });

  it('emits status + duration + tokensUsed on done', async () => {
    const starts: SubagentActivity[] = [];
    const dones: SubagentActivity[] = [];
    const progress: SubagentProgress = { onStart: (a) => starts.push(a), onDone: (a) => dones.push(a) };
    const orch = makeOrchestrator(progress);
    const result = await orch.execute(toolCall('test_researcher', { prompt: 'research X' }));
    expect(result.success).toBe(true);
    const done = dones[0];
    expect(done.status).toBe('done');
    expect(typeof done.durationMs).toBe('number');
    expect(done.tokensUsed).toBeGreaterThan(0);
    // The delegated-task summary rides on onStart (card header), status/meta on done.
    expect(starts[0].inputSnippet).toContain('research X');
    expect(starts[0].status).toBe('running');
  });

  it('persists a checkpoint and resumes a re-delegated identical sub-task', async () => {
    // In-memory IStateStore.
    const sessions = new Map<string, { state: { messages: Message[]; turnCount: number }; checkpoints: Checkpoint[] }>();
    const store: IStateStore = {
      loadSession: (id) => sessions.get(id) ?? null,
      saveCheckpoint: async (id, cp) => {
        const cur = sessions.get(id) ?? { state: { messages: [{ role: 'user', content: '' }], turnCount: 0 }, checkpoints: [] };
        cur.checkpoints.push(cp);
        cur.state = { messages: cp.state.messages, turnCount: cp.state.turnCount };
        sessions.set(id, cur);
      },
      deleteSession: async (id) => { sessions.delete(id); },
    };
    const parentSession = 'parent-123';
    const args = { prompt: 'research X' };
    const orch = new SubagentOrchestrator({
      llm: new MockLLMAdapter('findings'),
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      stateStore: store,
      parentSessionId: parentSession,
    });
    orch.register(subagentDef('test_researcher'));
    const r1 = await orch.execute(toolCall('test_researcher', args));
    expect(r1.success).toBe(true);
    // A checkpoint was saved under a stable sessionId (underscore-separated so
    // FSStore's path-traversal guard accepts it).
    const subSessionId = Array.from(sessions.keys()).find((id) => id.startsWith(`sub_${parentSession}_test_researcher_`));
    expect(subSessionId).toBeDefined();
    expect(sessions.get(subSessionId!)!.checkpoints.length).toBeGreaterThan(0);
  });
});

describe('deriveSubagentBudget (code_reviewer timeout regression)', () => {
  const PARENT: BudgetConfig = {
    maxTurns: 1000,
    maxTotalTokens: 4_000_000,
    maxExecutionTime: 7_200_000,
    warningThreshold: 0.9,
    graceTurns: 3,
  };

  it('caps a subagent below the elastic parent budget but with review headroom', () => {
    const sub = deriveSubagentBudget(PARENT);
    // A real review reads several files then writes a structured verdict; the
    // old 6 turns / 20k tokens / 90s always aborted it mid-review.
    expect(sub.maxTurns).toBeGreaterThanOrEqual(20);
    expect(sub.maxTotalTokens).toBeGreaterThanOrEqual(100_000);
    // 30 minutes: at the old 10-minute ceiling every generative role died
    // mid-work — four delegated agents produced four timeouts.
    expect(sub.maxExecutionTime).toBeGreaterThanOrEqual(1_800_000);
    // The hard slice is what ends ONE engine segment; the orchestrator then
    // continues from the transcript in a fresh slice instead of failing.
    expect(sub.hardMaxTime).toBe(600_000);
    expect(sub.hardMaxTime).toBeLessThanOrEqual(sub.maxExecutionTime);
    // Still bounded — a subagent can't burn the parent's whole allocation.
    expect(sub.maxTotalTokens).toBeLessThanOrEqual(200_000);
  });

  it('gives subagents a 90s first-token ceiling (stalled fan-out siblings fail fast)', () => {
    // 2026-09-20: two of a fan-out batch never produced a token; the shared
    // 5-minute first-token deadline held the whole tool batch as silent gray
    // cards until the user gave up. Subagents must hit the retry policy in
    // seconds-to-a-minute, not minutes; the parent keeps the 5-min default.
    const sub = deriveSubagentBudget(PARENT);
    expect(sub.firstTokenTimeoutMs).toBe(90_000);
  });

  it('keeps a smaller parent budget tight', () => {
    const sub = deriveSubagentBudget({ maxTurns: 3, maxTotalTokens: 8000, maxExecutionTime: 30000, warningThreshold: 0.8, graceTurns: 1 });
    expect(sub.maxTurns).toBe(3);
    expect(sub.maxTotalTokens).toBe(8000);
    expect(sub.maxExecutionTime).toBe(30000);
    expect(sub.hardMaxTime).toBe(30000);
  });

  it("every generative role's defaultTimeoutMs outlives the budget cap (signal must not fire first)", () => {
    // ui_designer / code_editor are here because four of EACH timing out was
    // the reported failure — a role whose signal fires before its budget
    // produces that mass-timeout symptom. Coding roles live in
    // CODING_AGENT_ROLES, reviewers in BUILT_IN_SUBAGENTS.
    const names = ['code_reviewer', 'project_auditor', 'task_planner', 'code_editor', 'deep_thinker', 'ui_designer', 'researcher'];
    const sub = deriveSubagentBudget(PARENT);
    for (const name of names) {
      const def = [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES].find((d) => d.name === name);
      expect(def?.defaultTimeoutMs ?? 0).toBeGreaterThanOrEqual(sub.maxExecutionTime);
    }
    // bash_executor is a command runner, not generative — its tighter cap is
    // deliberate.
    expect(CODING_AGENT_ROLES.find((d) => d.name === 'bash_executor')?.defaultTimeoutMs).toBe(300_000);
  });
});

// ── P2: segment continuation + no-progress watchdog ──
// "Four subagents, four timeouts": a slice ending used to FAIL the whole
// delegation and rely on the parent model re-delegating. Now the orchestrator
// continues from the transcript in a fresh slice, and a wedged run (no
// progress events at all) dies fast via the liveness watchdog instead of
// waiting out the total wall.

describe('SubagentOrchestrator segment continuation + liveness watchdog', () => {
  it('continues in a fresh slice when a segment exhausts its hard budget', async () => {
    let deliver = false;
    let starts = 0;
    const llm: LLMAdapter = {
      async *stream(): AsyncGenerator<LLMChunk, void, void> {
        if (!deliver) {
          yield { type: 'content', content: 'working…' };
          // Stall past the slice: the segment's hard budget must end THIS
          // engine run (clean "Budget exceeded" Interrupted with transcript),
          // not fail the delegation.
          await new Promise<void>(() => {});
        }
        yield { type: 'content', content: 'slice-2 final deliverable' };
        yield { type: 'done', content: 'slice-2 final deliverable', toolCalls: [] };
      },
      async complete() { throw new Error('not used'); },
    };
    const orch = new SubagentOrchestrator({
      llm,
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: { ...BUDGET, maxExecutionTime: 150, graceTurns: 0 },
      progress: { onStart: () => { starts++; if (starts >= 2) deliver = true; } },
    });
    orch.register({ ...subagentDef('test_slicer'), defaultTimeoutMs: 5_000 });
    const result = await orch.execute(toolCall('test_slicer', { prompt: 'long task' }));

    expect(result.success).toBe(true);
    expect(String((result.result as SubagentResult).output)).toContain('slice-2');
    // A second slice actually began (the re-delegate-and-pray path never ran).
    expect(starts).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('aborts a wedged subagent via the no-progress watchdog instead of waiting out the wall', async () => {
    const llm: LLMAdapter = {
      async *stream(): AsyncGenerator<LLMChunk, void, void> {
        // Total stall: not even one chunk, forever.
        await new Promise<void>(() => {});
      },
      async complete() { throw new Error('not used'); },
    };
    const orch = new SubagentOrchestrator({
      llm,
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      noProgressTimeoutMs: 80,
    });
    orch.register(subagentDef('test_wedger'));
    const result = await orch.execute(toolCall('test_wedger', { prompt: 'x' }));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('no progress');
  }, 10_000);

  it('trims unresolved toolCalls from subagent checkpoints so re-delegation resumes safely', async () => {
    // The delegation times out while a tool call is still executing: the
    // transcript ends in an assistant message whose toolCalls never got
    // results. Persisting that raw made every "re-delegate the SAME subtask
    // to continue from its checkpoint" resume request die with a provider
    // 400 — the recovery path this checkpoint store exists for.
    const saved: Checkpoint[] = [];
    const store = {
      saveCheckpoint: async (_sid: string, cp: Checkpoint) => { saved.push(cp); },
      loadSession: () => null,
    } as unknown as IStateStore;
    const llm: LLMAdapter = {
      async *stream(): AsyncGenerator<LLMChunk, void, void> {
        const tc = { id: 'call_hang', index: 0, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } };
        yield { type: 'tool_call', index: 0, id: 'call_hang', name: 'read_file', arguments: '{"path":"a.ts"}' };
        yield { type: 'done', content: '', toolCalls: [tc] };
        // Never returns: the tool hangs and the total wall kills the run.
        await new Promise<void>(() => {});
      },
      async complete() { throw new Error('not used'); },
    };
    const hangingAdapter: ToolAdapter = {
      getTools: () => [{ name: 'read_file', description: 'r', input_schema: {} }],
      getMetadata: () => ({ isWrite: false }),
      execute: async (tc: ToolCall): Promise<ToolResult> =>
        new Promise<ToolResult>(() => {}), // hang until the timeout aborts
    };
    const orch = new SubagentOrchestrator({
      llm,
      parentTools: hangingAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      stateStore: store,
    });
    orch.register({ ...subagentDef('test_stalled_tool'), defaultTimeoutMs: 300 });
    const result = await orch.execute(toolCall('test_stalled_tool', { prompt: 'x' }));
    expect(result.success).toBe(false);

    const interrupted = saved.find((c) => c.label === 'subagent_interrupted');
    expect(interrupted).toBeDefined();
    const last = interrupted!.state.messages[interrupted!.state.messages.length - 1];
    expect(last.role === 'assistant' && !!last.toolCalls?.length).toBe(false);
  }, 10_000);

  it('rescues output from the transcript when the final round is empty (empty-response Completed)', async () => {
    // finalOutput is only the LAST THINK round's text. When the sub-agent's
    // closing round is empty, Completed carried output: "" while the rail
    // card turned done — the "done card above, blank tool-row Output below"
    // desync. The orchestrator must fall back to the closest preceding
    // assistant text.
    //
    // The default verifier would FAIL an empty output and push the engine
    // back into THINK (the normal self-correction path), so this test injects
    // a permissive verifier to reach the empty-Completed directly — the same
    // hole custom verifiers or check-bypass paths can hit in production.
    let round = 0;
    const llm: LLMAdapter = {
      async *stream(): AsyncGenerator<LLMChunk, void, void> {
        round++;
        if (round === 1) {
          yield { type: 'content', content: '调研完成：pure 采用分层引擎架构，Harness 负责上下文与检查点。' };
          yield { type: 'done', content: '调研完成：pure 采用分层引擎架构，Harness 负责上下文与检查点。', toolCalls: [] };
          return;
        }
        // Final round: content is empty — the finalOutput killer.
        yield { type: 'done', content: '', toolCalls: [] };
      },
      async complete() { throw new Error('not used'); },
    };
    // Zero checks → evaluate always passes → the empty round completes.
    const permissiveVerifier = new Verifier();
    const orch = new SubagentOrchestrator({
      llm,
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      verifier: permissiveVerifier,
    });
    orch.register(subagentDef('test_rescuer'));
    const result = await orch.execute(toolCall('test_rescuer', { prompt: 'research pure' }));
    expect(result.success).toBe(true);
    const sub = result.result as SubagentResult;
    // The empty final round must NOT blank the payload: the earlier summary
    // rides instead, so the tool-row Output panel has something to render.
    expect(sub.output).toContain('分层引擎架构');
  }, 10_000);
});

// ── 阶段 12: pause (pauseSignal.ts) ──
// A parent abort carrying PAUSE_ABORT_REASON is a PAUSE, not a cancellation:
// the subagent archives its checkpoint and reports status 'paused' so the UI
// renders a resumable ⏸ card instead of a ✗ failure. A plain abort keeps the
// existing 'cancelled' semantics.

describe('SubagentOrchestrator pause (阶段 12)', () => {
  function memoryStore() {
    const sessions = new Map<string, { checkpoints: Checkpoint[] }>();
    const store: IStateStore = {
      loadSession: () => null,
      saveCheckpoint: async (id, cp) => {
        const cur = sessions.get(id) ?? { checkpoints: [] };
        cur.checkpoints.push(cp);
        sessions.set(id, cur);
      },
      deleteSession: async (id) => { sessions.delete(id); },
    };
    return { sessions, store };
  }

  it('a pause abort archives the checkpoint and reports paused, not cancelled', async () => {
    const ac = new AbortController();
    const { sessions, store } = memoryStore();
    const seen: SubagentActivity[] = [];
    // An LLM that streams nothing until the parent aborts — the pause lands
    // mid-THINK, the engine reports Interrupted, the orchestrator classifies it.
    const pausingLLM: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        while (!ac.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        throw new Error('aborted');
      },
      complete: async () => ({ content: '', toolCalls: [] }),
    };
    const orch = new SubagentOrchestrator({
      llm: pausingLLM,
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      stateStore: store,
      parentSessionId: 'parentp',
      progress: { onDone: (a) => seen.push(a), onError: (a) => seen.push(a) },
    });
    orch.register(subagentDef('test_researcher'));

    const exec = orch.execute(toolCall('test_researcher', { prompt: 'long research' }), ac.signal);
    setTimeout(() => abortPaused(ac), 10);
    const result = await exec;

    // 2026-09-25 复测：暂停不是失败。success:false 曾把 "Error: undefined"
    // 喂给父模型、污染失败策略、让汇总写成"分支挂了"——现在是 success:true
    // + outcome:'paused' 的专用标识。
    expect(result.success).toBe(true);
    const payload = result.result as { aborted?: boolean; reason?: string; outcome?: string };
    expect(payload.aborted).toBe(true);
    expect(payload.outcome).toBe('paused');
    expect(String(payload.reason)).toContain('PAUSED');
    // 整轮暂停：「继续」条承诺子 agent 从存档续——恢复指引必须保留。
    expect(String(payload.reason)).toContain('re-delegate');
    const paused = seen.find((a) => a.status === 'paused');
    expect(paused).toBeDefined();
    expect(paused!.lifecycle).toBe('paused');
    // The archive exists under the stable sessionId — a re-delegation of the
    // SAME subtask resumes from it.
    const subSessionId = Array.from(sessions.keys()).find((id) => id.startsWith('sub_parentp_test_researcher_'));
    expect(subSessionId).toBeDefined();
    expect(sessions.get(subSessionId!)!.checkpoints.some((c) => c.label === 'subagent_interrupted')).toBe(true);
  });

  it('a plain parent abort still reports cancelled (hard stop unchanged)', async () => {
    const ac = new AbortController();
    const seen: SubagentActivity[] = [];
    const pausingLLM: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        while (!ac.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        throw new Error('aborted');
      },
      complete: async () => ({ content: '', toolCalls: [] }),
    };
    const orch = new SubagentOrchestrator({
      llm: pausingLLM,
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      progress: { onDone: (a) => seen.push(a), onError: (a) => seen.push(a) },
    });
    orch.register(subagentDef('test_researcher'));

    const exec = orch.execute(toolCall('test_researcher', { prompt: 'long research' }), ac.signal);
    setTimeout(() => ac.abort(), 10);
    const result = await exec;

    expect(result.success).toBe(false);
    const cancelled = seen.find((a) => a.status === 'cancelled');
    expect(cancelled).toBeDefined();
    expect(seen.find((a) => a.status === 'paused')).toBeUndefined();
  });
});

describe('SubagentOrchestrator steer channel (北极星第二步)', () => {
  // 插话通道进子 agent：宿主的 steer 队列同时挂到子代理引擎的 ctx 上。父任务被
  // 委派工具占住的那几分钟里，插话由干活中的子代理在其 THINK 边界取走——"纠偏
  // 直达干活的人"。drain 语义保证不重复：取走即消失，父引擎不会再次看到。
  it('a queued steer reaches the subagent THINK input as a user message, with a steered receipt', async () => {
    const seen: SubagentActivity[] = [];
    const seenMessages: Message[][] = [];
    const capturingLLM: LLMAdapter = {
      stream: async function* (messages: Message[]): AsyncGenerator<LLMChunk, void, void> {
        seenMessages.push(messages);
        yield { type: 'content' as const, content: 'ok' };
        yield { type: 'done' as const, content: 'ok', toolCalls: [] };
      },
      complete: async () => ({ content: 'ok', toolCalls: [] }),
    };
    const queue: Message[] = [{ role: 'user', content: '顺手把深色主题也改了' }];
    const orch = new SubagentOrchestrator({
      llm: capturingLLM,
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      takeSteerMessages: () => queue.splice(0),
      progress: { onState: (a) => seen.push(a), onDone: (a) => seen.push(a) },
    });
    orch.register(subagentDef('test_researcher'));

    const result = await orch.execute(toolCall('test_researcher', { prompt: 'research X' }));

    expect(result.success).toBe(true);
    // The steer was drained into the subagent's THINK input as a user message.
    expect(seenMessages.length).toBeGreaterThan(0);
    expect(seenMessages[0]!.some((m) => m.role === 'user' && String(m.content).includes('深色主题'))).toBe(true);
    // Drained exactly once — nothing left for a later boundary to re-deliver.
    expect(queue).toHaveLength(0);
    // …and the activity stream carries the 📨 delivery receipt.
    expect(seen.some((a) => a.lifecycle === 'steered')).toBe(true);
  });

  it('an empty steer queue changes nothing: no receipt, delegation unaffected', async () => {
    const seen: SubagentActivity[] = [];
    const orch = new SubagentOrchestrator({
      llm: new MockLLMAdapter('findings'),
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      takeSteerMessages: () => [],
      progress: { onState: (a) => seen.push(a), onDone: (a) => seen.push(a) },
    });
    orch.register(subagentDef('test_researcher'));

    const result = await orch.execute(toolCall('test_researcher', { prompt: 'research X' }));

    expect(result.success).toBe(true);
    expect(seen.some((a) => a.lifecycle === 'steered')).toBe(false);
  });

  it('1a 定向投递：宿主闭包被包上分支身份（branchCallId/branchName）', async () => {
    // 拉取者身份是寻址的地基：宿主闭包收到 {branchCallId, branchName} 才能把
    // 用户点名的那支话直达这一支。编排器负责包身份，宿主负责过滤——引擎
    // 无感知（闭包签名对引擎仍是 () => Message[] 的可选参形态）。
    const recipients: Array<{ branchCallId?: string; branchName?: string } | undefined> = [];
    const orch = new SubagentOrchestrator({
      llm: new MockLLMAdapter('findings'),
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      takeSteerMessages: (recipient) => {
        recipients.push(recipient);
        return [];
      },
    });
    orch.register(subagentDef('test_researcher'));

    const call = toolCall('test_researcher', { prompt: 'research X' });
    const result = await orch.execute(call);

    expect(result.success).toBe(true);
    expect(recipients.length).toBeGreaterThan(0);
    expect(recipients[0]).toEqual({ branchCallId: call.id, branchName: 'test_researcher' });
  });
});

// Agent run id（ag-xxxxxxxx，2026-09-20 用户要求）：每个委派一个可引用的短 ID。
// 卡片、错误行、终态工具结果、会话存档四处指向同一个 ID——报错时用户贴一个
// token 就能定位是哪个 agent，而不是"第二个灰色的卡片"。
describe('SubagentOrchestrator agent run id', () => {
  it('stamps one stable agentId on every activity emit and the terminal result', async () => {
    const seen: SubagentActivity[] = [];
    const orch = new SubagentOrchestrator({
      llm: new MockLLMAdapter('findings'),
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      progress: {
        onStart: (a) => seen.push(a),
        onState: (a) => seen.push(a),
        onDone: (a) => seen.push(a),
      },
    });
    orch.register(subagentDef('test_researcher'));

    const result = await orch.execute(toolCall('test_researcher', { prompt: 'research X' }));

    expect(seen.length).toBeGreaterThan(0);
    const ids = new Set(seen.map((a) => a.agentId));
    expect(ids.size).toBe(1);
    const id = [...ids][0]!;
    expect(id).toMatch(/^ag-[0-9a-f]{8}$/);
    // The terminal payload the parent transcript stores carries the same id.
    expect((result.result as SubagentResult).agentId).toBe(id);
  });

  it('makeAgentId yields distinct well-shaped ids across runs', () => {
    const a = makeAgentId();
    const b = makeAgentId();
    expect(a).toMatch(/^ag-[0-9a-f]{8}$/);
    expect(b).toMatch(/^ag-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe('SubagentOrchestrator relay schema exposure (北极星第 5 步)', () => {
  it('every delegation tool advertises the reserved relay argument; shared definitions stay untouched', () => {
    const orch = new SubagentOrchestrator({ llm: stubAdapter as unknown as LLMAdapter, defaultBudget: BUDGET });
    orch.register(subagentDef('relay_probe'));
    const tools = orch.getTools();
    const probe = tools.find((t) => t.name === 'relay_probe')!;
    const props = probe.input_schema.properties as Record<string, unknown>;
    expect(props.relay).toBeDefined();

    // Definitions are shared singletons — the schema injection must be a
    // clone, or repeated registrations would accumulate relay keys.
    const def = subagentDef('relay_probe');
    expect('relay' in (def.input_schema.properties as Record<string, unknown>)).toBe(false);
    const builtinProps = BUILT_IN_SUBAGENTS[0]!.input_schema.properties as Record<string, unknown>;
    expect('relay' in builtinProps).toBe(false);
    const codingProps = CODING_AGENT_ROLES[0]!.input_schema.properties as Record<string, unknown>;
    expect('relay' in codingProps).toBe(false);
  });

  it('a definition that already documents its own relay argument keeps its version', () => {
    const orch = new SubagentOrchestrator({ llm: stubAdapter as unknown as LLMAdapter, defaultBudget: BUDGET });
    const def = subagentDef('relay_owner');
    (def.input_schema.properties as Record<string, unknown>).relay = { type: 'string', description: 'custom' };
    orch.register(def);
    const tools = orch.getTools();
    const props = tools.find((t) => t.name === 'relay_owner')!.input_schema.properties as Record<string, unknown>;
    expect((props.relay as Record<string, unknown>).type).toBe('string');
  });

  it('getSubagentTools (the model-facing chokepoint) injects the relay schema', () => {
    const registry = new ToolRegistry(stubAdapter);
    registry.register(subagentDef('relay_registry_probe'));
    const exposed = registry.getSubagentTools().find((t) => t.name === 'relay_registry_probe')!;
    const props = exposed.input_schema.properties as Record<string, unknown>;
    expect(props.relay).toBeDefined();
    const relay = props.relay as Record<string, unknown>;
    expect((relay.properties as Record<string, unknown>).as).toBeDefined();
    expect((relay.properties as Record<string, unknown>).from).toBeDefined();
    // Idempotent: a second exposure round-trips without nesting.
    const again = registry.getSubagentTools().find((t) => t.name === 'relay_registry_probe')!;
    expect((again.input_schema.properties as Record<string, unknown>).relay).toEqual(relay);
  });

  it('the multi-agent protocol teaches the relay rule', () => {
    expect(MULTI_AGENT_PROTOCOL).toContain('Relay rule');
    expect(MULTI_AGENT_PROTOCOL).toContain('"relay": {"as"');
    expect(MULTI_AGENT_PROTOCOL).toContain('"relay": {"from"');
  });
});

describe('SubagentOrchestrator persona overlays (北极星第 6 步 13.3)', () => {
  const ZH_NOTE = '你的回复是给主 agent 汇总用的';

  /** Records the system prompt the engine assembled (messages[0]) and ends the
   * loop cleanly — same shape as the mock-driven tests above. */
  function capturingLlm(captured: { system: string }, reply: string): LLMAdapter {
    return {
      async *stream(messages: Message[]) {
        captured.system = messages[0]?.content ?? '';
        yield { type: 'content' as const, content: reply };
        yield { type: 'done' as const, content: reply, toolCalls: [] };
      },
      async complete() {
        return { content: reply, toolCalls: [] };
      },
    };
  }

  it('overlay 追加在 base persona 之后、机械性汇报说明之前', async () => {
    const captured = { system: '' };
    const orch = new SubagentOrchestrator({
      llm: capturingLlm(captured, 'done'),
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      personaOverlays: new Map([['test_researcher', '新增约束：结论必须给出文件:行号证据。']]),
    });
    orch.register(subagentDef('test_researcher'));
    const result = await orch.execute(toolCall('test_researcher', { prompt: 'research X' }));
    expect(result.success).toBe(true);
    // base 一字打头，overlay 紧随其后，汇报格式说明垫底。
    expect(captured.system.startsWith('You are test_researcher. Task: research X')).toBe(true);
    expect(captured.system).toContain('新增约束：结论必须给出文件:行号证据。');
    expect(captured.system).toContain(ZH_NOTE);
    expect(captured.system.indexOf('新增约束')).toBeLessThan(captured.system.indexOf(ZH_NOTE));
  });

  it('无 overlay 命中时 prompt 与 13.3 之前逐字节一致', async () => {
    const withEmpty = { system: '' };
    const orchA = new SubagentOrchestrator({
      llm: capturingLlm(withEmpty, 'done'),
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      personaOverlays: new Map([['some_other_role', '别的角色的 overlay，与本角色无关。']]),
    });
    orchA.register(subagentDef('test_researcher'));
    await orchA.execute(toolCall('test_researcher', { prompt: 'research X' }));

    const withoutConfig = { system: '' };
    const orchB = new SubagentOrchestrator({
      llm: capturingLlm(withoutConfig, 'done'),
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
    });
    orchB.register(subagentDef('test_researcher'));
    await orchB.execute(toolCall('test_researcher', { prompt: 'research X' }));

    expect(withEmpty.system).toBe(withoutConfig.system);
    expect(withEmpty.system.startsWith('You are test_researcher. Task: research X')).toBe(true);
    expect(withEmpty.system).toContain(ZH_NOTE);
  });
});

describe('SubagentOrchestrator branch lifecycle (第 2 期分支中断)', () => {
  function memoryStore() {
    const sessions = new Map<string, { checkpoints: Checkpoint[] }>();
    const store: IStateStore = {
      loadSession: () => null,
      saveCheckpoint: async (id, cp) => {
        const cur = sessions.get(id) ?? { checkpoints: [] };
        cur.checkpoints.push(cp);
        sessions.set(id, cur);
      },
      deleteSession: async (id) => { sessions.delete(id); },
    };
    return { sessions, store };
  }

  function branchToolCall(id: string, args: Record<string, unknown>): ToolCall {
    return { id, index: 0, function: { name: 'test_researcher', arguments: JSON.stringify(args) } };
  }

  function branchLlm(): LLMAdapter {
    // STOPME 任务挂到 signal 上（等被叫停）；其余任务 30ms 后正常交付。
    return {
      stream: async function* (messages: Message[], _tools: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<LLMChunk, void, void> {
        const last = messages[messages.length - 1];
        const text = typeof last?.content === 'string' ? last.content : '';
        if (text.includes('STOPME')) {
          while (!signal?.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          throw new Error('aborted');
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield { type: 'content', content: 'branch findings' };
      },
      complete: async () => ({ content: '', toolCalls: [] }),
    };
  }

  function makeBranchOrchestrator(store?: IStateStore, seen?: SubagentActivity[]): SubagentOrchestrator {
    const orch = new SubagentOrchestrator({
      llm: branchLlm(),
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      stateStore: store,
      progress: seen ? { onDone: (a) => seen.push(a), onError: (a) => seen.push(a) } : undefined,
    });
    orch.register(subagentDef('test_researcher'));
    return orch;
  }

  it('abortBranch 只杀被点名的那支：它按已中止结算（存档照存），同批兄弟照常交付', async () => {
    const { sessions, store } = memoryStore();
    const seen: SubagentActivity[] = [];
    const orch = makeBranchOrchestrator(store, seen);

    const stopme = orch.execute(branchToolCall('call_stopme', { prompt: 'STOPME long research' }));
    const sibling = orch.execute(branchToolCall('call_sibling', { prompt: 'quick research' }));

    // 在飞时注册表看得到它；先试一个不存在的 callId。
    expect(orch.abortBranch('call_nope')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(orch.branchView().some((b) => b.callId === 'call_stopme' && b.state === 'running')).toBe(true);

    expect(orch.abortBranch('call_stopme')).toBe(true);
    const [stopmeResult, siblingResult] = await Promise.all([stopme, sibling]);

    // 被叫停支：用户的决定不是失败（2026-09-25）——success:true +
    // outcome:'stopped' 专用标识，不进失败策略，界面渲染静音 ⏹。
    expect(stopmeResult.success).toBe(true);
    const payload = stopmeResult.result as { aborted?: boolean; reason?: string; outcome?: string };
    expect(payload.aborted).toBe(true);
    expect(payload.outcome).toBe('stopped');
    expect(String(payload.reason)).toContain('STOPPED');
    expect(String(payload.reason)).not.toContain('timed out');
    const stopmeCard = seen.find((a) => a.callId === 'call_stopme' && a.status);
    expect(stopmeCard?.status).toBe('cancelled');
    // 存档在结算前已落盘（persist-before-settle）——断点可另起续。
    const subSessionId = Array.from(sessions.keys()).find((id) => id.startsWith('sub_'));
    expect(subSessionId).toBeDefined();
    expect(sessions.get(subSessionId!)!.checkpoints.some((c) => c.label === 'subagent_interrupted')).toBe(true);

    // 兄弟支零感知：照常交付。
    expect(siblingResult.success).toBe(true);
    // 结算出账即销户：再叫停同一支 = false。
    expect(orch.abortBranch('call_stopme')).toBe(false);
    expect(orch.branchView()).toHaveLength(0);
  });

  it('整树取消仍按 cancelled 结算（原有语义不回归），pause 仍按 paused', async () => {
    const ac = new AbortController();
    const seen: SubagentActivity[] = [];
    const orch = new SubagentOrchestrator({
      llm: branchLlm(),
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      progress: { onDone: (a) => seen.push(a), onError: (a) => seen.push(a) },
    });
    orch.register(subagentDef('test_researcher'));

    const exec = orch.execute(branchToolCall('call_tree_cancel', { prompt: 'STOPME long research' }), ac.signal);
    setTimeout(() => ac.abort(), 10);
    const result = await exec;
    expect(seen.find((a) => a.callId === 'call_tree_cancel' && a.status === 'cancelled')).toBeDefined();
    expect((result.result as { reason?: string }).reason).toBe('cancelled');
  });

  it('pauseBranch 点名暂停一支：按 paused 结算（不是 aborted），存档照存，兄弟支照常', async () => {
    // 复测案例二（2026-09-25）：用户收掉一项说的是「先停下」，落暂停不落
    // 中止。这条锁结算分流——branchController 上的 pause reason 绝不能被
    // 布尔 aborted 检查吞成「用户叫停」。
    const { sessions, store } = memoryStore();
    const seen: SubagentActivity[] = [];
    const orch = makeBranchOrchestrator(store, seen);

    const pausing = orch.execute(branchToolCall('call_pauseme', { prompt: 'STOPME long research on 爆发点' }));
    const sibling = orch.execute(branchToolCall('call_sibling', { prompt: 'quick research' }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(orch.pauseBranch('call_nope')).toBe(false);
    // 注册表带上了任务书片段——按主题点名的匹配面（名字是代号）。
    expect(orch.branchView().find((b) => b.callId === 'call_pauseme')?.inputSnippet).toContain('爆发点');

    expect(orch.pauseBranch('call_pauseme')).toBe(true);
    const [pauseResult, siblingResult] = await Promise.all([pausing, sibling]);

    // 暂停不是失败（2026-09-25）：success:true + outcome:'paused'——父模型
    // 读到的是"用户暂停、可续"，不是 Error；界面据此渲染灰 ⏸ 不染红。
    expect(pauseResult.success).toBe(true);
    const payload = pauseResult.result as { aborted?: boolean; reason?: string; outcome?: string };
    expect(payload.aborted).toBe(true);
    expect(payload.outcome).toBe('paused');
    expect(String(payload.reason)).toContain('PAUSED');
    expect(String(payload.reason)).not.toContain('STOPPED');
    expect(String(payload.reason)).not.toContain('timed out');
    // 2026-09-26 大bug：点名暂停的 note 绝不能唆使父模型自动重派——
    // "可续"是留给用户发话的机制说明，不是父模型的行动指令。
    expect(String(payload.reason)).toContain('Do NOT re-delegate');
    expect(String(payload.reason)).not.toContain('to continue, re-delegate');
    const card = seen.find((a) => a.callId === 'call_pauseme' && a.status);
    expect(card?.status).toBe('paused');
    // 断点在结算前已落盘（persist-before-settle），想续随时同参重派。
    const interruptedSaved = Array.from(sessions.entries()).some(([id, s]) => id.startsWith('sub_') && s.checkpoints.some((c) => c.label === 'subagent_interrupted'));
    expect(interruptedSaved).toBe(true);

    // 兄弟支零感知，照常交付；结算出账即销户，再暂停同一支 = false。
    expect(siblingResult.success).toBe(true);
    expect(orch.pauseBranch('call_pauseme')).toBe(false);
    expect(orch.branchView()).toHaveLength(0);
  });
});

describe('SubagentOrchestrator branch events (第 2 期第四刀)', () => {
  it('emits a first-class branch_retrying receipt on a self-heal retry, without moving the state machine', async () => {
    // failurePolicy 的 retry/reflect 是子代理自己的自愈线：进程继续、状态机
    // 不动、父零感知——但用户必须看得见「它在自己纠错」而不是卡住。
    const seen: SubagentActivity[] = [];
    let turn = 0;
    const llm: LLMAdapter = {
      async *stream(): AsyncGenerator<LLMChunk, void, void> {
        turn++;
        if (turn === 1) {
          const tc = { id: 'call_boom', index: 0, function: { name: 'flaky_tool', arguments: '{}' } };
          yield { type: 'tool_call', index: 0, id: 'call_boom', name: 'flaky_tool', arguments: '{}' };
          yield { type: 'done', content: '', toolCalls: [tc] };
          return;
        }
        yield { type: 'done', content: 'recovered deliverable', toolCalls: [] };
      },
      async complete() { return { content: '', toolCalls: [] }; },
    };
    const flakyAdapter: ToolAdapter = {
      getTools: () => [{ name: 'flaky_tool', description: 'f', input_schema: {} }],
      getMetadata: () => ({ isWrite: false }),
      execute: async (tc: ToolCall): Promise<ToolResult> => ({
        id: tc.id, toolName: tc.function.name, success: false, error: 'transient 503', duration: 1,
      }),
    };
    const orch = new SubagentOrchestrator({
      llm,
      parentTools: flakyAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      progress: { onState: (a) => seen.push(a) },
      failurePolicy: { decide: () => ({ kind: 'retry', hint: 'continue' }) },
    });
    orch.register(subagentDef('test_retry'));

    const result = await orch.execute(toolCall('test_retry', { prompt: 'x' }));
    expect(result.success).toBe(true);

    const retry = seen.find((a) => a.lifecycle === 'retrying');
    expect(retry).toBeDefined();
    expect(retry!.attempt).toBe(1);
    expect(String(retry!.retryCause)).toContain('503');
    // 自愈不迁移状态：重试之后照常跑完，不需要人工介入。
    expect(result.success).toBe(true);
  });
});
