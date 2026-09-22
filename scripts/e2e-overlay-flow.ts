#!/usr/bin/env bun
// scripts/e2e-overlay-flow.ts
// 北极星第 6 步 13.3（part 3）— overlay 起草流的 mock provider 端到端。
//
// 浏览器模式的 Settings 处理器会 isTauriRuntime() 早退、且依赖 Tauri 命令与
// TauriToolAdapter，CDP 浏览器 e2e 驱动不了它。所以流程编排抽在
// src/ui/personaOverlayFlow.ts（无 Tauri/DOM，依赖注入），本脚本用**同一个**
// 生产模块 + 真实 SubagentOrchestrator / NodeToolAdapter + mock LLM provider
// 跑完整链路：起草 → 校验 → A/B 门槛 → 确认 → 落盘。零网络、确定性。
//
// 覆盖：
//   1. DENY —— fixtures < 5，overlay 不落盘；
//   2. REJECT —— overlay 侧产出变差，不落盘；
//   3. ALLOW → 落盘 —— 文件真的写下且内容正确；
//   4. exists —— 目标文件已存在时不覆盖；
//   5. cancelled —— 确认弹窗返回 false 时不落盘。
//
// 用法：bun run scripts/e2e-overlay-flow.ts    （退出码 0 = 全过，1 = 有断言失败）

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPersonaOverlayFlow, type OverlayFlowDeps } from '../src/ui/personaOverlayFlow';
import { draftPersonaOverlay } from '../src/harness/personaOverlayReflector';
import { BUILT_IN_SUBAGENTS, SubagentOrchestrator } from '../src/coding-agent/SubagentOrchestrator';
import { NodeToolAdapter } from '../src/adapter/node/NodeToolAdapter';
import type { SubagentAdvice } from '../src/shared/subagentAdvisory';
import type { BudgetConfig, LLMAdapter, LLMChunk, Message, ToolCall } from '../src/shared/types';
import type { RoleCaseFixture } from '../src/evaluation/roleRegression';

// The real role we gate (its persona is what the overlay is appended to).
const ROLE = 'code_reviewer';
const ROLE_DEF = [...BUILT_IN_SUBAGENTS].find((d) => d.name === ROLE)!;
const OVERLAY_MARKER = 'OVERLAY-MARKER';
const OVERLAY_TEXT = `${OVERLAY_MARKER}: 每次交付都必须附文件:行号证据。`;
const BASE_OK = '发现 correctness 问题，证据见 src/a.ts:12。';
const OVERLAY_OK = '发现 correctness 问题，附文件:行号证据 src/a.ts:12。';
const OVERLAY_BAD = '看起来没问题。';

type Scenario = 'allow' | 'reject';

/** mock provider：按 system prompt 分派三类调用 —— 起草、overlay 侧子 agent、
 *  基座侧子 agent。真实 SubagentOrchestrator 走的是它，链路是真的。 */
function mockLlm(scenario: Scenario): LLMAdapter {
  const respond = (messages: Message[]): string => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    if (system.includes('You improve ONE subagent role')) return OVERLAY_TEXT; // 起草
    if (system.includes(OVERLAY_MARKER)) return scenario === 'allow' ? OVERLAY_OK : OVERLAY_BAD; // overlay 侧
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

const BUDGET: BudgetConfig = { maxTurns: 6, maxTotalTokens: 40_000, maxExecutionTime: 60_000, warningThreshold: 0.8, graceTurns: 1 };

function advice(): SubagentAdvice {
  return {
    role: ROLE,
    reason: 'failure',
    severity: 'high',
    delegations: 8,
    failures: 4,
    failureRate: 50,
    timeoutCount: 0,
    dominantKind: 'tool_error',
    avgDurationMs: 20_000,
    lastFailureAt: Date.now(),
    action: 'skill-gate',
    skillId: 'code-review',
  };
}

function fixtures(count: number): RoleCaseFixture[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `case-0${i + 1}`,
    args: { prompt: `review ${i}`, files: 'src/a.ts' },
    must: ['correctness', '证据'],
  }));
}

/** 真实编排器跑一例（base 侧 ov=undefined，overlay 侧带 overlay）。 */
function makeRunCase(llm: LLMAdapter, workspace: string) {
  return async (fixture: RoleCaseFixture, ov: string | undefined): Promise<string> => {
    const tools = new NodeToolAdapter({ workspace, sessionId: `e2e-overlay-${ROLE}` });
    const orch = new SubagentOrchestrator({
      llm,
      parentTools: tools,
      parentToolsDefsProvider: () => tools.getTools(),
      defaultBudget: BUDGET,
      parentSessionId: `e2e-overlay-${ROLE}`,
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

interface ScenarioDeps extends OverlayFlowDeps {
  /** Spy: did writeOverlay fire, and with what. */
  written: { text?: string };
  /** Count of confirm prompts. */
  confirms: { n: number };
  file: string;
}

function buildDeps(opts: {
  scenario: Scenario;
  caseCount: number;
  workspace: string;
  file: string;
  confirmAnswer?: boolean;
  preexisting?: boolean;
}): ScenarioDeps {
  const llm = mockLlm(opts.scenario);
  const written: { text?: string } = {};
  const confirms = { n: 0 };
  const deps: ScenarioDeps = {
    role: ROLE,
    baseContract: (() => {
      try { return ROLE_DEF.createSystemPrompt({ prompt: 'review', files: 'src/a.ts' }); } catch { return ROLE_DEF.description; }
    })(),
    advice: advice(),
    knownRoles: [...BUILT_IN_SUBAGENTS].map((d) => d.name),
    draft: (input) => draftPersonaOverlay(llm, input),
    loadFixtures: async () => fixtures(opts.caseCount),
    overlayExists: async () => opts.preexisting === true,
    writeOverlay: async (_role, text) => {
      written.text = text;
      await writeFile(opts.file, `${text}\n`, 'utf8');
    },
    confirm: async () => {
      confirms.n += 1;
      return opts.confirmAnswer !== false;
    },
    runCase: makeRunCase(llm, opts.workspace),
    written,
    confirms,
    file: opts.file,
  };
  return deps;
}

// ── run the scenarios ──

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const root = await mkdtemp(join(tmpdir(), 'pure-e2e-overlay-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  // 1) DENY
  {
    const ws = await mkdtemp(join(root, 'deny-'));
    const file = join(root, 'deny.overlay.md');
    const deps = buildDeps({ scenario: 'allow', caseCount: 4, workspace: ws, file });
    const result = await runPersonaOverlayFlow(deps);
    check('DENY：样本不足不落盘', result.outcome === 'deny', `outcome=${result.outcome}`);
    check('DENY：没有写盘', deps.written.text === undefined);
  }

  // 2) REJECT
  {
    const ws = await mkdtemp(join(root, 'reject-'));
    const file = join(root, 'reject.overlay.md');
    const deps = buildDeps({ scenario: 'reject', caseCount: 5, workspace: ws, file });
    const result = await runPersonaOverlayFlow(deps);
    check('REJECT：overlay 变差不落盘', result.outcome === 'reject', `outcome=${result.outcome}`);
    check('REJECT：没有写盘', deps.written.text === undefined);
  }

  // 3) ALLOW → 落盘
  {
    const ws = await mkdtemp(join(root, 'allow-'));
    const file = join(root, 'allow.overlay.md');
    const deps = buildDeps({ scenario: 'allow', caseCount: 5, workspace: ws, file });
    const result = await runPersonaOverlayFlow(deps);
    check('ALLOW：verdict 放行并写盘', result.outcome === 'written', `outcome=${result.outcome}`);
    check('ALLOW：confirm 被调用一次', deps.confirms.n === 1, `n=${deps.confirms.n}`);
    const onDisk = await readFile(file, 'utf8').catch(() => '');
    check('ALLOW：文件内容 = 起草的 overlay', onDisk.trim() === OVERLAY_TEXT, `disk=${onDisk.trim().slice(0, 40)}`);
  }

  // 4) exists —— 目标文件已存在时不覆盖
  {
    const ws = await mkdtemp(join(root, 'exists-'));
    const file = join(root, 'exists.overlay.md');
    const deps = buildDeps({ scenario: 'allow', caseCount: 5, workspace: ws, file, preexisting: true });
    const result = await runPersonaOverlayFlow(deps);
    check('exists：已存在不覆盖', result.outcome === 'exists', `outcome=${result.outcome}`);
    check('exists：没有写盘', deps.written.text === undefined);
    check('exists：没有弹确认', deps.confirms.n === 0);
  }

  // 5) cancelled
  {
    const ws = await mkdtemp(join(root, 'cancel-'));
    const file = join(root, 'cancel.overlay.md');
    const deps = buildDeps({ scenario: 'allow', caseCount: 5, workspace: ws, file, confirmAnswer: false });
    const result = await runPersonaOverlayFlow(deps);
    check('cancelled：用户取消不落盘', result.outcome === 'cancelled', `outcome=${result.outcome}`);
    check('cancelled：没有写盘', deps.written.text === undefined);
  }
} finally {
  // Small grace so any straggling fs op settles before cleanup.
  await sleep(50);
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

if (failures.length > 0) {
  console.error(`\n[e2e] FAIL — ${failures.length} check(s) failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\n[e2e] PASS — overlay flow: DENY / REJECT / ALLOW+write / exists / cancelled all behave');
