// scripts/s1-overlay-flow.ts
// P1-1（S1）— 13.3 overlay 起草流的 headless 驱动：真实失败画像 → 起草 →
// 编译校验 → 回归 A/B 门槛 → 落盘（~/.pure/personas/<role>.overlay.md）。
//
// 与产品的关系：编排核心就是 src/ui/personaOverlayFlow.ts 的 runPersonaOverlayFlow
// （GUI 设置页与 sleep-time 编排器走的同一段代码），本脚本只注入 CLI 侧接缝
// （NodeToolAdapter + SubagentOrchestrator 的 runCase，镜像 eval:roles 的接法）。
// 失败画像从 ~/.pure/observations/app.jsonl 的**真实观测**聚合（30 天窗口、
// 与 subagentAdvisory 同口径的计数），不造数——建议卡的 40% 自动阈值不满足时，
// 这是「手动入口」的等价物：数据真、流程真、裁决真（ALLOW 才落盘）。
// confirm 绑 true 是 sleep-time 编排器的既定语义（门禁通过即自动落盘）。
//
// 用法：
//   bun run scripts/s1-overlay-flow.ts --role code_reviewer [--model glm-5.3-flash]
// 前置：~/.pure/roles/<role>/ 已有 ≥ MIN_ROLE_CASES(5) 条收割样本。

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { BUILT_IN_SUBAGENTS, CODING_AGENT_ROLES, SubagentOrchestrator } from '../src/coding-agent/SubagentOrchestrator';
import { NodeToolAdapter } from '../src/adapter/node/NodeToolAdapter';
import { createAdapter } from '../src/evaluation/codingAgentExecutor';
import { extractSubagentOutput, type RoleCaseFixture } from '../src/evaluation/roleRegression';
import type { RunRoleCase } from '../src/evaluation/roleRegressionRun';
import { runPersonaOverlayFlow } from '../src/ui/personaOverlayFlow';
import { draftPersonaOverlay } from '../src/harness/personaOverlayReflector';
import type { SubagentAdvice } from '../src/shared/subagentAdvisory';
import { parsePromptObservations } from '../src/shared/promptObservability';
import type { BudgetConfig, ToolCall } from '../src/shared/types';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const role = flag('--role');
if (!role) {
  console.error('--role is required');
  process.exit(2);
}

const REGISTRY = new Map([...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES].map((d) => [d.name, d]));
const def = REGISTRY.get(role);
if (!def) {
  console.error(`unknown role: ${role}`);
  process.exit(2);
}

// ── provider/key（与 s1-real-session 同一套解析）──
const cfg = JSON.parse(await readFile(join(homedir(), '.pure', 'config.json'), 'utf8')) as { provider?: string; model?: string; apiKey?: string };
const provider = cfg.provider ?? 'glm';
const model = flag('--model') ?? cfg.model ?? 'glm-5.3-flash';
let apiKey = cfg.apiKey?.trim() || '';
if (!apiKey) {
  const secrets = JSON.parse(await readFile(join(homedir(), '.pure', 'secrets.json'), 'utf8')) as Record<string, unknown>;
  // secrets.json 是扁平的：键名本身就带点（"llm.apiKey.glm"），不是嵌套对象。
  apiKey = String(secrets[`llm.apiKey.${provider}`] ?? secrets['llm.apiKey'] ?? '').trim();
}
if (!apiKey) {
  console.error('no API key found');
  process.exit(2);
}
const adapter = createAdapter({ provider, model, apiKey });

// ── 真实失败画像：30 天窗口内该角色的观测聚合（与 subagentAdvisory 同口径计数）──
const WINDOW_MS = 30 * 24 * 3600 * 1000;
const now = Date.now();
const raw = await readFile(join(homedir(), '.pure', 'observations', 'app.jsonl'), 'utf8').catch(() => '');
const records = parsePromptObservations(raw);
let delegations = 0;
let failures = 0;
let timeoutCount = 0;
const kinds = new Map<string, number>();
let durationSum = 0;
let durationCount = 0;
let lastFailureAt = 0;
for (const record of records) {
  if (record.type !== 'agent_run') continue;
  if (now - record.startedAt > WINDOW_MS) continue;
  for (const call of record.toolCalls ?? []) {
    if (call.toolName !== role) continue;
    delegations++;
    if (typeof call.durationMs === 'number' && call.durationMs > 0) {
      durationSum += call.durationMs;
      durationCount++;
    }
    if (call.success === false) {
      failures++;
      const kind = call.errorKind ?? 'tool_error';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (kind.includes('timeout')) timeoutCount++;
      lastFailureAt = Math.max(lastFailureAt, record.endedAt ?? record.startedAt);
    }
  }
}
if (delegations === 0) {
  console.error(`no observed delegations for ${role} in the 30d window — nothing real to draft from`);
  process.exit(2);
}
const dominantKind = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'tool_error';
const advice: SubagentAdvice = {
  role,
  reason: timeoutCount > 0 && dominantKind.includes('timeout') ? 'timeout' : 'failure',
  severity: failures / delegations >= 0.6 ? 'high' : 'medium',
  delegations,
  failures,
  failureRate: Math.round((failures / delegations) * 1000) / 10,
  timeoutCount,
  dominantKind,
  avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
  lastFailureAt,
  action: 'skill-gate',
};
console.log(`real failure profile (30d): ${delegations} delegations, ${failures} failures (${advice.failureRate}%), dominant=${dominantKind}, timeouts=${timeoutCount}, avg=${advice.avgDurationMs ?? 'n/a'}ms`);

// ── 接缝注入（runCase 镜像 scripts/run-role-regression.ts 的接法）──
const ROLE_BUDGET: BudgetConfig = {
  maxTurns: 12,
  maxTotalTokens: 120_000,
  maxExecutionTime: 12 * 60 * 1000,
  warningThreshold: 0.8,
  graceTurns: 1,
};
const runCase: RunRoleCase = async (fixture, overlay) => {
  const side = overlay ? 'overlay' : 'base';
  // S1：fixture 带工作区且目录还在 ⇒ 原地重跑（评审对象在那里），两侧同目录。
  let hinted = false;
  if (fixture.workspace) {
    try {
      const stat = await (await import('node:fs/promises')).stat(fixture.workspace);
      hinted = stat.isDirectory();
    } catch { /* 目录没了退回临时目录 */ }
  }
  const workspace = hinted
    ? fixture.workspace!
    : await mkdtemp(join(await import('node:path').then((m) => m.resolve('/tmp')), `pure-overlay-${side}-`));
  const tools = new NodeToolAdapter({ workspace, sessionId: `s1-overlay-${side}` });
  const orch = new SubagentOrchestrator({
    llm: adapter,
    parentTools: tools,
    parentToolsDefsProvider: () => tools.getTools(),
    defaultBudget: ROLE_BUDGET,
    parentSessionId: `s1-overlay-${side}`,
    ...(overlay ? { personaOverlays: new Map([[role, overlay]]) } : {}),
  });
  orch.register(def);
  const toolCall: ToolCall = {
    id: `call_${fixture.id}`,
    index: 0,
    function: { name: role, arguments: JSON.stringify(fixture.args) },
  };
  const started = Date.now();
  const result = await orch.execute(toolCall);
  process.stdout.write(`  ${side.padEnd(7)} ${fixture.id} (${Math.round((Date.now() - started) / 1000)}s)\n`);
  return extractSubagentOutput(result);
};

const personasDir = join(homedir(), '.pure', 'personas');
const result = await runPersonaOverlayFlow({
  role,
  baseContract: (() => { try { return def.createSystemPrompt({}); } catch { return def.description; } })(),
  advice,
  knownRoles: [...REGISTRY.keys()],
  draft: (input) => draftPersonaOverlay(adapter, input),
  loadFixtures: async (r) => {
    const dir = join(homedir(), '.pure', 'roles', r);
    const files = (await import('node:fs/promises').then((m) => m.readdir(dir))).filter((f) => /^case-\d+\.json$/.test(f)).sort();
    const out: RoleCaseFixture[] = [];
    for (const f of files) {
      try {
        out.push(JSON.parse(await readFile(join(dir, f), 'utf8')) as RoleCaseFixture);
      } catch { /* 坏文件跳过，与 GUI 装载同语义 */ }
    }
    return out;
  },
  overlayExists: async (r) => {
    try {
      await readFile(join(personasDir, `${r}.overlay.md`));
      return true;
    } catch {
      return false;
    }
  },
  writeOverlay: async (r, text) => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, `${r}.overlay.md`), text);
  },
  confirm: async () => true, // sleep-time 同语义：A/B verdict === allow 即落盘
  runCase,
  onStage: (stage, detail) => console.log(`[stage] ${stage}${detail ? ` (${detail})` : ''}`),
});

console.log(`\noutcome: ${result.outcome}${result.reason ? ` — ${result.reason}` : ''}`);
if (result.base) console.log(`base:    ${JSON.stringify(result.base)}`);
if (result.overlay) console.log(`overlay: ${JSON.stringify(result.overlay)}`);
if (result.outcome === 'written') console.log(`written: ${join(personasDir, `${role}.overlay.md`)}`);
process.exit(result.outcome === 'written' ? 0 : 1);
