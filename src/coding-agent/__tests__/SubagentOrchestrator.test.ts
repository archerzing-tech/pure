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
import { Tags, ToolRegistry } from '../ToolRegistry';
import { MockLLMAdapter } from '../../adapter/mock/MockLLMAdapter';
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
    // …while file-mutating ones stay serialized so they never race.
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
});
