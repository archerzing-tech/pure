// src/evolution/__tests__/sleepTimeOrchestrator.test.ts
// P0-1 编排器纯核验收：游标水位与尾表、reflect: 前缀防重放、坏档案毒丸、
// 日上限、shouldReflect 门、三类预算（wall-clock/sessions/llm）、AbortSignal、
// 重入窗、技能闸路由（high 自动 / medium 看卡）、overlay 13.3 路由 + 7 天退避、
// 以及 lessonToMemoryAdds 抽取的键格式契约。

import { describe, it, expect } from 'bun:test';
import type { IMemoryStore, LLMAdapter, MemoryEntry, MemoryListOptions, Message } from '../../shared/types';
import type { AgentRunObservation } from '../../shared/promptObservability';
import type { SubagentAdvice } from '../../shared/subagentAdvisory';
import type { OverlayFlowResult } from '../../ui/personaOverlayFlow';
import { sha256Hex } from '../../shared/sha256';
import {
  REFLECT_DEDUPE_PREFIX,
  lessonToMemoryAdds,
  type ReflectedLesson,
} from '../../harness/LessonReflector';
import {
  OVERLAY_BACKOFF_MS,
  defaultConfirmPolicy,
  emptyCursor,
  runSleepTimeCycle,
  type OrchestratorCursor,
  type SleepTimeAction,
  type SleepTimeDeps,
  type SleepTimeTurnInput,
} from '../sleepTimeOrchestrator';
import type { RoleTrialState } from '../../shared/roleTrial';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const PROJECT = '/p';

// ── fakes ──

let seq = 0;

function fakeMemory(seed: MemoryEntry[] = []): Pick<IMemoryStore, 'add' | 'list'> & { entries: MemoryEntry[] } {
  const entries = [...seed];
  return {
    entries,
    add: async (e: Omit<MemoryEntry, 'id'>) => {
      const id = `m${++seq}`;
      entries.push({ ...e, id });
      return id;
    },
    list: ((opts?: string | MemoryListOptions) => {
      const pp = typeof opts === 'string' ? opts : opts?.projectPath;
      return entries.filter((e) => pp === undefined || e.projectPath === pp);
    }) as IMemoryStore['list'],
  };
}

function fakeLLM(reply: string): LLMAdapter & { count(): number } {
  let calls = 0;
  return {
    count: () => calls,
    complete: async () => {
      calls++;
      return { content: reply };
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async *stream() { /* 编排器只用 complete */ },
  } as LLMAdapter & { count(): number };
}

const ARGS = '{"path":"a1"}';
const EV_ID = sha256Hex(`read_file::${ARGS}`).slice(0, 12);

/** 能通过 parseReflectedLesson 的合法反思回复（引用真实证据 id）。 */
function lessonReply(): string {
  return JSON.stringify({
    symptom: 'Tests fail after edits',
    rootCause: `Edited without re-running tests (${EV_ID})`,
    prevention: 'Run the suite after each edit batch',
    recovery: 'Reran and fixed',
    evidence: [EV_ID],
    procedure: 'edit -> run tests -> fix',
    correction: { kind: 'project_convention', statement: 'always run tests before commit' },
  });
}

function sessionTurn(prompt = 'Fix the bug'): SleepTimeTurnInput {
  return {
    userPrompt: prompt,
    finalOutput: 'done',
    messages: [
      {
        role: 'assistant',
        content: '',
        toolCalls: [1, 2, 3].map((i) => ({
          id: `c${i}`,
          index: i,
          function: { name: i === 1 ? 'read_file' : 'grep', arguments: i === 1 ? ARGS : `{"q":"x${i}"}` },
        })),
      } as Message,
    ],
    failures: [],
    verificationSummary: 'tests green',
    verificationPassed: true,
  };
}

/** 一条带角色派发失败的 agent_run 观测（喂 scanSubagentAdvice）。 */
function roleRun(role: string, ok: boolean): AgentRunObservation {
  seq++;
  return {
    type: 'agent_run',
    traceId: `r${seq}`,
    startedAt: NOW - 1000,
    endedAt: NOW - 990,
    eventCounts: {},
    reasoningChars: 0,
    outputChars: 0,
    toolCalls: [
      ok
        ? { toolName: role, success: true, durationMs: 100 }
        : { toolName: role, success: false, durationMs: 100, error: { kind: 'tool_error', hash: 'h', chars: 0 } },
    ],
    outcome: { isComplete: ok, interrupted: false },
  };
}

interface Fixture {
  cursor: OrchestratorCursor;
  saves: number[];
  memory: ReturnType<typeof fakeMemory>;
  llm: ReturnType<typeof fakeLLM>;
  deps: SleepTimeDeps;
}

function fixture(over: Partial<SleepTimeDeps> = {}, seed: MemoryEntry[] = []): Fixture {
  const cursor = emptyCursor(0);
  const saves: number[] = [];
  const memory = fakeMemory(seed);
  const llm = fakeLLM(lessonReply());
  const deps: SleepTimeDeps = {
    cursor: {
      load: async () => cursor,
      save: async (c) => {
        Object.assign(cursor, c);
        saves.push(Date.now());
      },
    },
    memory,
    llm,
    projectPath: PROJECT,
    ...over,
  };
  return { cursor, saves, memory, llm, deps };
}

function reflectSeed(sessionId: string, prompt: string, at = NOW): MemoryEntry[] {
  seq++;
  return [{
    id: `seed${seq}`,
    type: 'successful_pattern',
    content: 'old lesson',
    timestamp: at,
    sessionId,
    projectPath: PROJECT,
    dedupeKey: `${REFLECT_DEDUPE_PREFIX}${sessionId}:${prompt}`,
  }];
}

// ── lessonToMemoryAdds（抽取契约）──

describe('lessonToMemoryAdds', () => {
  const lesson: ReflectedLesson = {
    symptom: 'S',
    rootCause: 'R',
    prevention: 'P',
    recovery: 'not needed',
    evidence: ['abc123'],
    confidence: 'high',
    procedure: 'step by step',
    correction: { kind: 'user_preference', statement: 'prefer concise answers' },
  };
  const ctx = {
    sessionId: 's9',
    projectPath: PROJECT,
    dedupeKey: `${REFLECT_DEDUPE_PREFIX}s9:fix the bug`,
    verificationSummary: 'ok',
    verificationPassed: true,
  };

  it('emits main + procedure piggyback + correction draft with stable keys', () => {
    const adds = lessonToMemoryAdds(lesson, ctx);
    expect(adds).toHaveLength(3);
    expect(adds[0]!.type).toBe('successful_pattern');
    expect(adds[0]!.dedupeKey).toBe('reflect:s9:fix the bug');
    expect(adds[0]!.confidence).toBe('high');
    expect(adds[0]!.lesson?.evidence).toEqual(['abc123']);
    expect(adds[1]!.type).toBe('procedure');
    expect(adds[1]!.dedupeKey).toBe('procedure:reflect:s9:fix the bug');
    expect(adds[2]!.type).toBe('user_preference');
    expect(adds[2]!.confidence).toBe('low');
    expect(adds[2]!.dedupeKey!.startsWith('correction:user_preference:')).toBe(true);
  });

  it('gates the procedure piggyback on verificationPassed and slices content', () => {
    const noVerify = lessonToMemoryAdds(lesson, { ...ctx, verificationPassed: false });
    expect(noVerify).toHaveLength(2);
    expect(noVerify.some((a) => a.type === 'procedure')).toBe(false);
    const long = lessonToMemoryAdds(
      { ...lesson, symptom: 'x'.repeat(400), procedure: 'y'.repeat(700), correction: { kind: 'project_convention', statement: 'z'.repeat(400) } },
      ctx,
    );
    expect(long[0]!.content.length).toBeLessThanOrEqual(900);
    expect(long[1]!.content.length).toBeLessThanOrEqual(600);
    expect(long[2]!.content.length).toBeLessThanOrEqual(300);
  });
});

// ── runSleepTimeCycle ──

describe('runSleepTimeCycle', () => {
  it('reflects a pending session and persists cursor + entries', async () => {
    const f = fixture({}, []);
    f.deps.listPendingSessions = async () => [{ id: 's1', updatedAt: NOW - 1000 }];
    f.deps.loadSession = async () => sessionTurn();
    const result = await runSleepTimeCycle(f.deps);
    expect(result.errors).toEqual([]);
    expect(result.sessionsProcessed).toEqual(['s1']);
    expect(result.lessonsWritten).toBe(1);

    const entries = f.memory.entries;
    const main = entries.find((e) => e.dedupeKey === 'reflect:s1:fix the bug');
    expect(main?.type).toBe('successful_pattern');
    expect(main?.confidence).toBe('high');
    expect(main?.sessionId).toBe('s1');
    expect(main?.projectPath).toBe(PROJECT);
    expect(entries.some((e) => e.dedupeKey === 'procedure:reflect:s1:fix the bug')).toBe(true);
    const draft = entries.find((e) => e.dedupeKey?.startsWith('correction:project_convention:'));
    expect(draft?.confidence).toBe('low');

    expect(f.cursor.processedSessionIds).toEqual(['s1']);
    expect(f.cursor.lastProcessedAt).toBe(NOW - 1000);
    expect(f.cursor.runningUntil).toBeUndefined(); // 收尾清窗
    expect(f.saves.length).toBeGreaterThanOrEqual(2);
  });

  it('skips sessions at or below the cursor watermark', async () => {
    const f = fixture({}, reflectSeed('old', 'p'));
    Object.assign(f.cursor, emptyCursor(0), { lastProcessedAt: NOW - 500 });
    f.deps.listPendingSessions = async () => [
      { id: 'old1', updatedAt: NOW - 1000 }, // 水位之下
      { id: 'old2', updatedAt: NOW - 500 }, // 恰在水位上（<= → 跳过）
      { id: 'fresh', updatedAt: NOW - 100 },
    ];
    f.deps.loadSession = async (id) => (id === 'fresh' ? sessionTurn() : undefined);
    const result = await runSleepTimeCycle(f.deps);
    expect(result.sessionsProcessed).toEqual(['fresh']);
    expect(f.llm.count()).toBe(1);
  });

  it('skips sessions already in the processed tail', async () => {
    const f = fixture({}, []);
    Object.assign(f.cursor, emptyCursor(0), { processedSessionIds: ['s1'] });
    f.deps.listPendingSessions = async () => [{ id: 's1', updatedAt: NOW - 1000 }];
    f.deps.loadSession = async () => sessionTurn();
    const result = await runSleepTimeCycle(f.deps);
    expect(result.sessionsProcessed).toEqual([]);
    expect(f.llm.count()).toBe(0);
  });

  it('never replays sessions that already have a reflect: entry (SIGINT half-run)', async () => {
    const f = fixture({}, reflectSeed('s1', 'fix the bug'));
    f.deps.listPendingSessions = async () => [{ id: 's1', updatedAt: NOW - 1000 }];
    f.deps.loadSession = async () => sessionTurn();
    const result = await runSleepTimeCycle(f.deps);
    expect(result.sessionsProcessed).toEqual([]);
    expect(f.llm.count()).toBe(0);
    // 水位仍要推进 —— 否则该会话每轮都被重新枚举。
    expect(f.cursor.processedSessionIds).toContain('s1');
    expect(f.cursor.lastProcessedAt).toBe(NOW - 1000);
  });

  it('poison-pills unreadable archives instead of retrying them every cycle', async () => {
    const f = fixture({}, []);
    f.deps.listPendingSessions = async () => [{ id: 'broken', updatedAt: NOW - 1000 }];
    f.deps.loadSession = async () => undefined; // 坏档案
    const first = await runSleepTimeCycle(f.deps);
    expect(first.errors.some((e) => e.includes('broken'))).toBe(true);

    const second = await runSleepTimeCycle(f.deps); // 同一游标续跑
    expect(second.sessionsProcessed).toEqual([]);
    expect(second.errors.some((e) => e.includes('broken'))).toBe(false); // 不再撞
    expect(f.llm.count()).toBe(0);
  });

  it('respects the daily reflection cap without burning an LLM call', async () => {
    const f = fixture({ reflection: { dailyCap: 1 }, now: () => NOW }, reflectSeed('other', 'p'));
    f.deps.listPendingSessions = async () => [{ id: 's1', updatedAt: NOW - 1000 }];
    f.deps.loadSession = async () => sessionTurn();
    const result = await runSleepTimeCycle(f.deps);
    expect(f.llm.count()).toBe(0);
    expect(result.sessionsProcessed).toEqual([]);
    expect(f.cursor.processedSessionIds).toContain('s1');
  });

  it('skips plain-chat sessions (no tool calls, no failures) via shouldReflect', async () => {
    const f = fixture({ now: () => NOW }, []);
    f.deps.listPendingSessions = async () => [{ id: 'chat', updatedAt: NOW - 1000 }];
    f.deps.loadSession = async () => ({ userPrompt: 'hi', messages: [] }); // 零证据
    const result = await runSleepTimeCycle(f.deps);
    expect(f.llm.count()).toBe(0);
    expect(result.sessionsProcessed).toEqual([]);
    expect(f.cursor.processedSessionIds).toContain('chat');
  });

  it('stops at maxSessions and reports the budget dimension', async () => {
    const f = fixture({ budget: { maxSessions: 1 }, now: () => NOW }, []);
    f.deps.listPendingSessions = async () => [
      { id: 's1', updatedAt: NOW - 2000 },
      { id: 's2', updatedAt: NOW - 1000 },
    ];
    f.deps.loadSession = async () => sessionTurn();
    const result = await runSleepTimeCycle(f.deps);
    expect(result.budgetExhausted).toBe('sessions');
    expect(result.sessionsProcessed).toEqual(['s1']);
    expect(f.cursor.processedSessionIds).not.toContain('s2'); // 留给下轮
  });

  it('stops at maxLlmCalls leaving the rest unprocessed', async () => {
    const f = fixture({ budget: { maxLlmCalls: 1 }, now: () => NOW }, []);
    f.deps.listPendingSessions = async () => [
      { id: 's1', updatedAt: NOW - 2000 },
      { id: 's2', updatedAt: NOW - 1000 },
    ];
    f.deps.loadSession = async () => sessionTurn();
    const result = await runSleepTimeCycle(f.deps);
    expect(result.budgetExhausted).toBe('llm');
    expect(f.llm.count()).toBe(1);
    expect(result.lessonsWritten).toBe(1);
    expect(f.cursor.processedSessionIds).toEqual(['s1']);
  });

  it('stops immediately on an expired wall clock', async () => {
    let t = 1_000_000;
    const f = fixture({ budget: { maxWallClockMs: 1000 }, now: () => (t += 5000) }, []);
    f.deps.listPendingSessions = async () => [{ id: 's1', updatedAt: t }];
    f.deps.loadSession = async () => sessionTurn();
    const result = await runSleepTimeCycle(f.deps);
    expect(result.budgetExhausted).toBe('wall-clock');
    expect(result.sessionsProcessed).toEqual([]);
    expect(f.llm.count()).toBe(0);
  });

  it('honors a pre-aborted signal', async () => {
    const f = fixture({ now: () => NOW, signal: AbortSignal.abort() }, []);
    f.deps.listPendingSessions = async () => [{ id: 's1', updatedAt: NOW - 1000 }];
    f.deps.loadSession = async () => sessionTurn();
    const result = await runSleepTimeCycle(f.deps);
    expect(result.aborted).toBe(true);
    expect(result.sessionsProcessed).toEqual([]);
    expect(f.llm.count()).toBe(0);
  });

  it('yields when the re-entrancy window is still open', async () => {
    const f = fixture({ now: () => NOW }, []);
    Object.assign(f.cursor, emptyCursor(0), { runningUntil: NOW + 60_000 });
    f.deps.listPendingSessions = async () => [{ id: 's1', updatedAt: NOW - 1000 }];
    f.deps.loadSession = async () => sessionTurn();
    const result = await runSleepTimeCycle(f.deps);
    expect(result.skippedRunning).toBe(true);
    expect(f.llm.count()).toBe(0);
    expect(f.cursor.runningUntil).toBe(NOW + 60_000); // 让路不清别人的窗
  });

  it('processes directSession without an archive list (CLI hand-off)', async () => {
    const f = fixture({ now: () => NOW }, []);
    f.deps.directSession = { ...sessionTurn(), id: 'cli-oneshot' };
    const result = await runSleepTimeCycle(f.deps);
    expect(result.sessionsProcessed).toEqual(['cli-oneshot']);
    expect(result.lessonsWritten).toBe(1);
    expect(f.memory.entries.some((e) => e.dedupeKey === `reflect:cli-oneshot:fix the bug`)).toBe(true);
  });
});

// ── 建议路由 ──

describe('runSleepTimeCycle advice routing', () => {
  it('auto-applies a high-severity skill gate via the policy + handler seam', async () => {
    const applied: SubagentAdvice[] = [];
    const flows: SubagentAdvice[] = [];
    const f = fixture({
      now: () => NOW,
      observations: () => [roleRun('researcher', false), roleRun('researcher', false), roleRun('researcher', false)],
      applySkillGate: (advice) => { applied.push(advice); },
      runOverlayFlow: async (advice) => { flows.push(advice); return { outcome: 'written' }; },
    }, []);
    const result = await runSleepTimeCycle(f.deps);
    expect(result.advicesConsidered).toBe(1);
    expect(result.skillGatesApplied).toBe(1);
    expect(applied[0]?.skillId).toBe('web-research');
    expect(flows).toHaveLength(0); // 闸已拉 —— overlay 无的放矢
    expect(defaultConfirmPolicy()({ kind: 'skill-gate', severity: 'high', skillId: 'x', advice: applied[0]! })).toBe('allow');
    expect(defaultConfirmPolicy()({ kind: 'skill-gate', severity: 'medium', skillId: 'x', advice: applied[0]! })).toBe('queue');
  });

  it('leaves medium-severity gates queued (no auto-apply, no overlay)', async () => {
    const applied: SubagentAdvice[] = [];
    // 5 派发 2 失败 → 失败率 0.4：过门槛（≥0.4）但低于 high 线（0.6）→ medium。
    const f = fixture({
      now: () => NOW,
      observations: () => [
        roleRun('researcher', false), roleRun('researcher', false),
        roleRun('researcher', true), roleRun('researcher', true), roleRun('researcher', true),
      ],
      applySkillGate: (advice) => { applied.push(advice); },
    }, []);
    const result = await runSleepTimeCycle(f.deps);
    expect(result.advicesConsidered).toBe(1);
    expect(result.skillGatesApplied).toBe(0); // medium → queue，留给用户看卡
    expect(applied).toHaveLength(0);
  });

  it('routes prompt-class advice into the overlay flow and ledgers a deny for 7 days', async () => {
    let now = NOW;
    let flowCalls = 0;
    const f = fixture({ now: () => now }, []);
    f.deps.listPendingSessions = async () => [];
    f.deps.observations = () => [roleRun('code_editor', false), roleRun('code_editor', false), roleRun('code_editor', false)];
    const deny: OverlayFlowResult = { outcome: 'deny', reason: 'insufficient data' };
    f.deps.runOverlayFlow = async () => { flowCalls++; return deny; };

    const first = await runSleepTimeCycle(f.deps);
    expect(first.overlaysWritten).toBe(0);
    expect(flowCalls).toBe(1);
    expect(f.cursor.overlayLedger['overlay:code_editor']?.attempts).toBe(1);

    // 退避期内绝不重试风暴。
    await runSleepTimeCycle(f.deps);
    expect(flowCalls).toBe(1);

    // 退避窗过后允许再试一次。
    now += OVERLAY_BACKOFF_MS + DAY;
    await runSleepTimeCycle(f.deps);
    expect(flowCalls).toBe(2);
    expect(f.cursor.overlayLedger['overlay:code_editor']?.attempts).toBe(2);
  });

  it('counts a written overlay and clears the ledger entry', async () => {
    const f = fixture({ now: () => NOW }, []);
    f.deps.listPendingSessions = async () => [];
    f.deps.observations = () => [roleRun('code_editor', false), roleRun('code_editor', false), roleRun('code_editor', false)];
    f.deps.runOverlayFlow = async () => ({ outcome: 'written' });
    const result = await runSleepTimeCycle(f.deps);
    expect(result.overlaysWritten).toBe(1);
    expect(f.cursor.overlayLedger['overlay:code_editor']).toBeUndefined();
  });

  it('pre-checks overlay existence before spending the flow', async () => {
    let flowCalls = 0;
    const f = fixture({ now: () => NOW }, []);
    f.deps.listPendingSessions = async () => [];
    f.deps.observations = () => [roleRun('code_editor', false), roleRun('code_editor', false), roleRun('code_editor', false)];
    f.deps.overlayExists = async () => true;
    f.deps.runOverlayFlow = async () => { flowCalls++; return { outcome: 'written' }; };
    await runSleepTimeCycle(f.deps);
    expect(flowCalls).toBe(0);
  });

  it('does nothing mechanical when the host provides no routing seams', async () => {
    const f = fixture({ now: () => NOW }, []);
    f.deps.listPendingSessions = async () => [];
    f.deps.observations = () => [roleRun('code_editor', false), roleRun('code_editor', false), roleRun('code_editor', false)];
    const result = await runSleepTimeCycle(f.deps);
    expect(result.advicesConsidered).toBe(1);
    expect(result.skillGatesApplied).toBe(0);
    expect(result.overlaysWritten).toBe(0);
    expect(result.errors).toEqual([]);
  });
});

describe('runSleepTimeCycle 归档扫掠（13.2）', () => {
  /** 一条带**有名委派**的运行记录（T1 之后的真机形态：delegations[]）。 */
  function delegationRun(role: string, total: number, successes: number, startedAt = NOW - 1000): AgentRunObservation {
    seq++;
    return {
      type: 'agent_run',
      traceId: `d${seq}`,
      startedAt,
      endedAt: startedAt + 10,
      eventCounts: {},
      reasoningChars: 0,
      outputChars: 0,
      toolCalls: [],
      delegations: Array.from({ length: total }, (_, i) => ({
        agentId: 'ag-00000000',
        role,
        startedAt,
        durationMs: 5,
        success: i < successes,
      })),
    } as unknown as AgentRunObservation;
  }

  const SURFACE = ['researcher', 'researcher_focused'];
  /** 父角色 12 次成 10（83%），变体 6 次成 1（17%）—— 样本够、且不达标。 */
  const below = [delegationRun('researcher', 12, 10), delegationRun('researcher_focused', 6, 1)];
  const surfaceOf = (): string[] => SURFACE;

  it('样本够且不达标 → 自动归档，并把两侧数字交给宿主', async () => {
    const archived: Array<{ role: string; evidence: string }> = [];
    const actions: SleepTimeAction[] = [];
    const f = fixture({
      now: () => NOW,
      observations: () => below,
      roleSurface: surfaceOf,
      generatedRoles: () => [{ name: 'researcher_focused', trial: { status: 'trial', parentRole: 'researcher' } }],
      archiveRole: async (role, evidence) => { archived.push({ role, evidence }); return true; },
      onAction: (action) => { actions.push(action); },
    }, []);
    f.deps.listPendingSessions = async () => [];

    const result = await runSleepTimeCycle(f.deps);
    expect(result.rolesArchived).toBe(1);
    expect(archived).toHaveLength(1);
    expect(archived[0].role).toBe('researcher_focused');
    // 「凭什么归档」必须一起交出去：只报一个角色名，用户无从判断该不该恢复。
    expect(archived[0].evidence).toContain('父角色 researcher');
    expect(actions.some((action) => action.kind === 'role-archived')).toBe(true);
  });

  it('没测到的三种一律不动：样本不够 / 没记父角色 / 已转正（+已归档幂等）', async () => {
    const cases: Array<{ name: string; trial: RoleTrialState; records: AgentRunObservation[] }> = [
      {
        name: '样本不够',
        trial: { status: 'trial', parentRole: 'researcher' },
        records: [delegationRun('researcher', 12, 10), delegationRun('researcher_focused', 2, 0)],
      },
      { name: '没记父角色', trial: { status: 'trial' }, records: below },
      { name: '已转正', trial: { status: 'promoted', parentRole: 'researcher' }, records: below },
      { name: '已归档', trial: { status: 'archived', parentRole: 'researcher' }, records: below },
    ];
    for (const kase of cases) {
      const archived: string[] = [];
      const f = fixture({
        now: () => NOW,
        observations: () => kase.records,
        roleSurface: surfaceOf,
        generatedRoles: () => [{ name: 'researcher_focused', trial: kase.trial }],
        archiveRole: async (role) => { archived.push(role); return true; },
      }, []);
      f.deps.listPendingSessions = async () => [];
      const result = await runSleepTimeCycle(f.deps);
      // 把「没测到」读成「失败」和读成「通过」一样错，只是方向相反。
      expect({ name: kase.name, archived, count: result.rolesArchived })
        .toEqual({ name: kase.name, archived: [], count: 0 });
    }
  });

  it('一个角色归档失败不拖住另一个（循环永不 throw）', async () => {
    const archived: string[] = [];
    const f = fixture({
      now: () => NOW,
      observations: () => [
        delegationRun('researcher', 12, 10),
        delegationRun('researcher_focused', 6, 1),
        delegationRun('code_reviewer_v2', 6, 1),
      ],
      roleSurface: () => ['researcher', 'researcher_focused', 'code_reviewer_v2'],
      generatedRoles: () => [
        { name: 'researcher_focused', trial: { status: 'trial', parentRole: 'researcher' } },
        { name: 'code_reviewer_v2', trial: { status: 'trial', parentRole: 'researcher' } },
      ],
      archiveRole: async (role) => {
        if (role === 'researcher_focused') throw new Error('disk full');
        archived.push(role);
        return true;
      },
    }, []);
    f.deps.listPendingSessions = async () => [];

    const result = await runSleepTimeCycle(f.deps);
    expect(archived).toEqual(['code_reviewer_v2']);
    expect(result.rolesArchived).toBe(1);
    expect(result.errors.some((error) => error.includes('researcher_focused'))).toBe(true);
  });

  it('取消后不再归档剩下的角色', async () => {
    const controller = new AbortController();
    const archived: string[] = [];
    const f = fixture({
      now: () => NOW,
      observations: () => [
        delegationRun('researcher', 12, 10),
        delegationRun('researcher_focused', 6, 1),
        delegationRun('code_reviewer_v2', 6, 1),
      ],
      roleSurface: () => ['researcher', 'researcher_focused', 'code_reviewer_v2'],
      generatedRoles: () => [
        { name: 'researcher_focused', trial: { status: 'trial', parentRole: 'researcher' } },
        { name: 'code_reviewer_v2', trial: { status: 'trial', parentRole: 'researcher' } },
      ],
      archiveRole: async (role) => { archived.push(role); controller.abort(); return true; },
      signal: controller.signal,
    }, []);
    f.deps.listPendingSessions = async () => [];

    const result = await runSleepTimeCycle(f.deps);
    expect(archived).toEqual(['researcher_focused']);
    expect(result.aborted).toBe(true);
  });

  it('窗口下界与仪表盘同一份：重启后的新试用期不会被当年那批委派送进归档', async () => {
    const archived: string[] = [];
    const f = fixture({
      now: () => NOW,
      observations: () => [
        delegationRun('researcher', 12, 10),
        // 把变体送进归档的那批委派发生在 10 天前，而它在 1 天前才被重新启用。
        delegationRun('researcher_focused', 6, 1, NOW - 10 * DAY),
      ],
      roleSurface: surfaceOf,
      generatedRoles: () => [{
        name: 'researcher_focused',
        trial: { status: 'trial', parentRole: 'researcher', registeredAt: NOW - DAY },
      }],
      archiveRole: async (role) => { archived.push(role); return true; },
    }, []);
    f.deps.listPendingSessions = async () => [];

    const result = await runSleepTimeCycle(f.deps);
    expect(result.rolesArchived).toBe(0);
    expect(archived).toEqual([]);
  });

  it('宿主没接归档缝 → 一段扫掠都不跑（只读宿主不该凭空多一个写面）', async () => {
    const f = fixture({ now: () => NOW, observations: () => below, roleSurface: surfaceOf }, []);
    f.deps.listPendingSessions = async () => [];
    const result = await runSleepTimeCycle(f.deps);
    expect(result.rolesArchived).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
