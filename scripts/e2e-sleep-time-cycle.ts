#!/usr/bin/env bun
// scripts/e2e-sleep-time-cycle.ts
// P0-1 — sleep-time 进化循环的 mock provider 端到端。
//
// 编排纯核 runSleepTimeCycle 全 DI（零 DOM/Tauri/fs），本脚本用**生产纯核**
// + 真实 FSMemoryStore / SubagentOrchestrator / NodeToolAdapter + mock LLM
// + 临时目录跑完整链路：会话直喂 → 反思落库（lesson + procedure 便车）→
// 观测→建议增量 → overlay 13.3 A/B 门禁 allow → 自动落盘 → 游标推进。
// 零网络、零 ~/.pure 污染、确定性。
//
// 覆盖：
//   1. 第一轮 —— 反思落库（reflect: dedupeKey + procedure 便车）、code_editor
//      失败画像 → prompt 类建议 → overlay A/B allow → 文件真写下、游标推进；
//   2. 第二轮重放 —— reflect: 查重跳过（不再写 lesson）、overlay 已存在不
//      重写、游标稳定 —— 幂等回放不重放。
//
// 用法：bun run scripts/e2e-sleep-time-cycle.ts   （退出码 0 = 全过）

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSleepTimeCycle, sessionTurnFromMessages } from '../src/evolution/sleepTimeOrchestrator';
import { FSMemoryStore } from '../src/adapter/memory/FSMemoryStore';
import { draftPersonaOverlay } from '../src/harness/personaOverlayReflector';
import { BUILT_IN_SUBAGENTS, CODING_AGENT_ROLES, SubagentOrchestrator } from '../src/coding-agent/SubagentOrchestrator';
import { NodeToolAdapter } from '../src/adapter/node/NodeToolAdapter';
import { sha256Hex } from '../src/shared/sha256';
import type { AgentRunObservation, BudgetConfig, LLMAdapter, LLMChunk, Message, ToolCall } from '../src/shared/types';
import type { SubagentAdvice } from '../src/shared/subagentAdvisory';
import type { RoleCaseFixture } from '../src/evaluation/roleRegression';
import type { OverlayFlowDeps } from '../src/ui/personaOverlayFlow';

const ROLE = 'code_editor'; // 不在 ROLE_SKILL_GATES → prompt 类建议 → overlay 路径
const ROLE_DEF = [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES].find((d) => d.name === ROLE)!;
const OVERLAY_MARKER = 'OVERLAY-MARKER-SLEEP';
const OVERLAY_TEXT = `${OVERLAY_MARKER}: 改代码前先列 touching files 清单。`;
const BASE_OK = '计划修改 src/a.ts：把循环边界修正（证据 src/a.ts:12）。';
const OVERLAY_OK = '计划修改 src/a.ts：把循环边界修正，附 touching files 清单（证据 src/a.ts:12）。';
const SESSION_ID = 'e2e-sleep-session';
const USER_PROMPT = 'Fix the flaky test in src/loop.test.ts';

// 直喂会话里的首个工具调用 —— 反思 JSON 引用的证据 id 必须能在证据目录里
// 对上（parseReflectedLesson 的防幻觉校验），所以用同一 sha256 现算。
const EVIDENCE_ID = sha256Hex('run_command::{"command":"bun test"}').slice(0, 12);

const BUDGET: BudgetConfig = { maxTurns: 6, maxTotalTokens: 40_000, maxExecutionTime: 60_000, warningThreshold: 0.8, graceTurns: 1 };

/** mock provider：按 system prompt 分派三类调用 —— 反思、overlay 侧子 agent、
 *  基座侧子 agent（起草走 overlay e2e 同一款 marker 约定）。 */
function mockLlm(): LLMAdapter {
  const lessonJson = JSON.stringify({
    symptom: 'A flaky loop-boundary test failed intermittently.',
    rootCause: `Off-by-one boundary; rerun evidence [${EVIDENCE_ID}] shows the fix landed and tests passed.`,
    prevention: 'Always run the loop test twice after boundary edits.',
    recovery: 'not needed',
    evidence: [EVIDENCE_ID],
    procedure: 'intent: fix flaky test -> edit boundary -> run bun test twice -> green',
  });
  const respond = (messages: Message[]): string => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    if (system.includes('engineering retrospective analyst')) return lessonJson; // 反思
    if (system.includes('You improve ONE subagent role')) return OVERLAY_TEXT; // 起草
    if (system.includes(OVERLAY_MARKER)) return OVERLAY_OK; // overlay 侧
    return BASE_OK; // 基座侧
  };
  return {
    async *stream(messages: Message[]): AsyncGenerator<LLMChunk, void, void> {
      const content = respond(messages);
      yield { type: 'content', content };
      yield { type: 'done', content, toolCalls: [] };
    },
    async complete(messages: Message[]) {
      return { content: respond(messages) };
    },
  };
}

/** 直喂会话：一个带 3 次工具调用 + 最终答复的完整轮（shouldReflect 会放行）。 */
function sessionMessages(): Message[] {
  const toolCall = (id: string, name: string, args: string): ToolCall => ({ id, index: 0, function: { name, arguments: args } });
  return [
    { role: 'user', content: USER_PROMPT },
    { role: 'assistant', content: '', toolCalls: [toolCall('c1', 'run_command', '{"command":"bun test"}')] },
    { role: 'tool', toolCallId: 'c1', content: '1 failed' },
    { role: 'assistant', content: '', toolCalls: [toolCall('c2', 'edit_file', '{"path":"src/loop.test.ts"}')] },
    { role: 'tool', toolCallId: 'c2', content: 'written' },
    { role: 'assistant', content: '边界修正完成，连跑两次全绿。', toolCalls: [toolCall('c3', 'run_command', '{"command":"bun test"}')] },
    { role: 'tool', toolCallId: 'c3', content: '2/2 passed' },
  ];
}

/** 一条带角色派发失败的 agent_run 观测（喂 scanSubagentAdvice → code_editor 画像）。 */
let seq = 0;
function roleRun(ok: boolean): AgentRunObservation {
  seq += 1;
  const now = Date.now();
  return {
    type: 'agent_run',
    traceId: `r${seq}`,
    startedAt: now - 1000,
    endedAt: now - 990,
    eventCounts: {},
    reasoningChars: 0,
    outputChars: 0,
    toolCalls: [
      ok
        ? { toolName: ROLE, success: true, durationMs: 100 }
        : { toolName: ROLE, success: false, durationMs: 100, error: { kind: 'tool_error', hash: 'h', chars: 0 } },
    ],
    outcome: { isComplete: ok, interrupted: false },
  };
}

function advice(): SubagentAdvice {
  return {
    role: ROLE,
    reason: 'failure',
    severity: 'high',
    delegations: 5,
    failures: 3,
    failureRate: 60,
    timeoutCount: 0,
    dominantKind: 'tool_error',
    avgDurationMs: 20_000,
    lastFailureAt: Date.now(),
    action: 'prompt', // code_editor 无技能闸 → prompt 类 → overlay 路径
  };
}

function fixtures(count: number): RoleCaseFixture[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `case-0${i + 1}`,
    args: { prompt: `edit ${i}`, files: 'src/a.ts' },
    must: ['src/a.ts'],
  }));
}

/** 真实编排器跑一例（base 侧 ov=undefined，overlay 侧带 overlay）。 */
function makeRunCase(llm: LLMAdapter, workspace: string) {
  return async (fixture: RoleCaseFixture, ov: string | undefined): Promise<string> => {
    const tools = new NodeToolAdapter({ workspace, sessionId: `e2e-sleep-${ROLE}` });
    const orch = new SubagentOrchestrator({
      llm,
      parentTools: tools,
      parentToolsDefsProvider: () => tools.getTools(),
      defaultBudget: BUDGET,
      parentSessionId: `e2e-sleep-${ROLE}`,
      ...(ov ? { personaOverlays: new Map([[ROLE, ov]]) } : {}),
    });
    orch.register(ROLE_DEF);
    const toolCall: ToolCall = {
      id: `call_${fixture.id}`,
      index: 0,
      function: { name: ROLE, arguments: JSON.stringify(fixture.args) },
    };
    const result = await orch.execute(toolCall);
    const payload = result.result as { output?: unknown; finalOutput?: unknown } | undefined;
    if (typeof payload?.output === 'string' && payload.output.trim()) return payload.output;
    if (typeof payload?.finalOutput === 'string' && payload.finalOutput.trim()) return payload.finalOutput;
    return result.error ? `[RUN_FAILED] ${result.error}` : '';
  };
}

interface E2eContext {
  root: string;
  memory: FSMemoryStore;
  cursorFile: string;
  overlayFile: string;
}

function loadCursor(ctx: E2eContext): unknown {
  try {
    return JSON.parse(readFileSync(ctx.cursorFile, 'utf8'));
  } catch {
    return undefined;
  }
}

function buildSleepDeps(ctx: E2eContext): Parameters<typeof runSleepTimeCycle>[0] {
  const llm = mockLlm();
  const turn = sessionTurnFromMessages(sessionMessages());
  if (!turn) throw new Error('session fixture must map to a turn');
  return {
    cursor: {
      load: async () => loadCursor(ctx) as never,
      save: async (cursor) => {
        mkdirSync(join(ctx.root, 'evolution'), { recursive: true });
        writeFileSync(ctx.cursorFile, JSON.stringify(cursor), 'utf8');
      },
    },
    directSession: {
      ...turn,
      id: SESSION_ID,
      verificationSummary: 'bun test 2/2 green after boundary fix',
      verificationPassed: true,
    },
    memory: ctx.memory,
    llm,
    projectPath: ctx.root,
    observations: () => [roleRun(false), roleRun(false), roleRun(false), roleRun(true), roleRun(true)],
    overlayExists: async () => existsSync(ctx.overlayFile), // 预检：已存在就不白烧起草调用
    runOverlayFlow: async (adv: SubagentAdvice) => {
      const deps: OverlayFlowDeps = {
        role: adv.role,
        baseContract: (() => {
          try { return ROLE_DEF.createSystemPrompt({ prompt: 'edit', files: 'src/a.ts' }); } catch { return ROLE_DEF.description; }
        })(),
        advice: adv,
        knownRoles: [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES].map((d) => d.name),
        draft: (input) => draftPersonaOverlay(llm, input),
        loadFixtures: async () => fixtures(6),
        overlayExists: async () => existsSync(ctx.overlayFile),
        writeOverlay: async (_role, text) => {
          mkdirSync(join(ctx.root, 'personas'), { recursive: true });
          writeFileSync(ctx.overlayFile, `${text}\n`, 'utf8');
        },
        confirm: async () => true, // 编排器立场：到 confirm 即 A/B verdict==='allow' → 自动落盘
        runCase: makeRunCase(llm, ctx.root),
      };
      const { runPersonaOverlayFlow } = await import('../src/ui/personaOverlayFlow');
      return runPersonaOverlayFlow(deps);
    },
    budget: { maxWallClockMs: 60_000 },
    onAction: (action) => console.log(`    [action] ${JSON.stringify(action.kind === 'overlay-deferred' ? { ...action } : action)}`),
  };
}

// ── run ──

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const root = mkdtempSync(join(tmpdir(), 'pure-e2e-sleep-'));
const ctx: E2eContext = {
  root,
  memory: new FSMemoryStore(join(root, 'memories'), ''),
  cursorFile: join(root, 'evolution', 'orchestrator.json'),
  overlayFile: join(root, 'personas', `${ROLE}.overlay.md`),
};

try {
  console.log('── 第一轮：反思落库 + overlay A/B allow 自动落盘 ──');
  const r1 = await runSleepTimeCycle(buildSleepDeps(ctx));

  check('反思落库 1 条 lesson', r1.lessonsWritten === 1, `got ${r1.lessonsWritten}`);
  check('会话进 processed', r1.sessionsProcessed.includes(SESSION_ID), JSON.stringify(r1.sessionsProcessed));
  check('无错误', r1.errors.length === 0, JSON.stringify(r1.errors));

  const entries = ctx.memory.list({ projectPath: root });
  const lesson = entries.find((e) => e.dedupeKey === `reflect:${SESSION_ID}:${USER_PROMPT.toLowerCase()}`);
  check('reflect: dedupeKey 与 Harness 同格式', !!lesson, JSON.stringify(entries.map((e) => e.dedupeKey)));
  const procedure = entries.find((e) => e.dedupeKey === `procedure:reflect:${SESSION_ID}:${USER_PROMPT.toLowerCase()}`);
  check('procedure 便车落库（verificationPassed）', !!procedure);
  const lessonContent = lesson?.content ?? '';
  check('lesson 内容含证据引用', lessonContent.includes(EVIDENCE_ID));

  check('overlay 文件真写下', existsSync(ctx.overlayFile) && readFileSync(ctx.overlayFile, 'utf8').includes(OVERLAY_MARKER));
  check('overlaysWritten === 1', r1.overlaysWritten === 1, String(r1.overlaysWritten));

  const cursor1 = loadCursor(ctx) as { lastProcessedAt: number; processedSessionIds: string[]; overlayLedger: Record<string, unknown> };
  check('游标水位推进', typeof cursor1?.lastProcessedAt === 'number' && cursor1.lastProcessedAt > 0);
  check('游标记下会话 id', Array.isArray(cursor1?.processedSessionIds) && cursor1.processedSessionIds.includes(SESSION_ID));
  check('门禁通过 → 记账清空', !cursor1?.overlayLedger?.[`overlay:${ROLE}`]);

  console.log('── 第二轮重放：reflect: 查重 + overlay 已存在 → 幂等 ──');
  const r2 = await runSleepTimeCycle(buildSleepDeps(ctx));
  check('不再写 lesson', r2.lessonsWritten === 0, String(r2.lessonsWritten));
  check('不再重写 overlay', r2.overlaysWritten === 0, String(r2.overlaysWritten));
  check('无错误', r2.errors.length === 0, JSON.stringify(r2.errors));

  const entries2 = ctx.memory.list({ projectPath: root });
  const lessonCount = entries2.filter((e) => (e.dedupeKey ?? '').startsWith(`reflect:${SESSION_ID}:`)).length;
  check('reflect: 条目仍只有 1 条', lessonCount === 1, String(lessonCount));
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n❌ e2e-sleep-time-cycle: ${failures.length} 项断言失败`);
  process.exit(1);
}
console.log('\n✅ e2e-sleep-time-cycle 全过');
