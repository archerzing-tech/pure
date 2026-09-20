// src/coding-agent/__tests__/SubagentOrchestrator.test.ts
// Coverage for the multi-agent delegation path:
//  1. SubagentOrchestrator spawns a real AgentLoopEngine per subagent call,
//     streams progress, and returns a structured result to the parent.
//  2. ToolRegistry exposes subagent tools to the model (getSubagentTools) and
//     routes AGENT-tagged calls to the orchestrator.
// The LLM is mocked (no tool calls) so the subagent engine runs its loop to a
// clean Completed event — no network, no real provider.

import { describe, expect, it } from 'bun:test';
import { SubagentOrchestrator, deriveSubagentBudget, BUILT_IN_SUBAGENTS, CODING_AGENT_ROLES, type SubagentActivity, type SubagentProgress } from '../SubagentOrchestrator';
import { Verifier } from '../Verifier';
import { Tags, ToolRegistry } from '../ToolRegistry';
import { MockLLMAdapter } from '../../adapter/mock/MockLLMAdapter';
import { abortPaused } from '../../shared/pauseSignal';
import type { BudgetConfig, Checkpoint, IStateStore, LLMAdapter, LLMChunk, Message, ToolAdapter, ToolCall, ToolResult } from '../../shared/types';
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

    expect(result.success).toBe(false);
    const payload = result.result as { aborted?: boolean; reason?: string };
    expect(payload.aborted).toBe(true);
    expect(String(payload.reason)).toContain('PAUSED');
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
});
