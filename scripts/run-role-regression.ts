// scripts/run-role-regression.ts
// 北极星第 6 步 13.3（part 2）— 角色级回归 runner。
// 对同一角色把同一批 case 分别用 base persona 和 base+overlay 各跑一遍
// （驱动真实的 SubagentOrchestrator.execute），按内容断言判卷，输出 A/B
// 准入裁决。LLM 适配器复用 eval 基线的 createAdapter，保证两侧与 v5 基线
// 同一条 provider 管线。
//
// 用法：
//   bun run eval:roles -- --role code_reviewer [--agent deepseek-openai]
//       [--model deepseek-chat] [--overlay ~/.pure/personas/code_reviewer.overlay.md]
//       [--cases evals/roles/code_reviewer] [--report evals/roles/code_reviewer.report.json]
//
// 退出码：0 = ALLOW，1 = REJECT，4 = DENY（样本不足），2 = 用法/环境错误。

import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAdapter } from '../src/evaluation/codingAgentExecutor';
import { extractSubagentOutput, type RoleCaseFixture } from '../src/evaluation/roleRegression';
import { runRoleRegressionAB, type RunRoleCase } from '../src/evaluation/roleRegressionRun';
import { NodeToolAdapter } from '../src/adapter/node/NodeToolAdapter';
import { BUILT_IN_SUBAGENTS, CODING_AGENT_ROLES, SubagentOrchestrator } from '../src/coding-agent/SubagentOrchestrator';
import type { SubagentDefinition } from '../src/coding-agent/types';
import { defaultModelFor } from '../src/shared/providers';
import type { BudgetConfig, ToolCall } from '../src/shared/types';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

const role = flag('--role');
const agentFlag = flag('--agent');
const modelFlag = flag('--model');
const overlayFlag = flag('--overlay');
const casesFlag = flag('--cases');
const reportFlag = flag('--report');
const requestedAgent = agentFlag ?? process.env.PURE_EVAL_AGENT;

if (!role) {
  console.error('Usage: bun run eval:roles -- --role <role> [--agent provider] [--model model] [--overlay path] [--cases dir] [--report path]');
  process.exit(2);
}

function apiKeyForProvider(provider: string): string | undefined {
  if (process.env.PURE_EVAL_API_KEY) return process.env.PURE_EVAL_API_KEY;
  switch (provider) {
    case 'deepseek-openai':
    case 'deepseek-anthropic':
      return process.env.DEEPSEEK_API_KEY;
    case 'qwen':
      return process.env.DASHSCOPE_API_KEY;
    case 'glm':
      return process.env.ZHIPU_API_KEY;
    default:
      return undefined;
  }
}

/** Default fixture home: the runtime directory the GUI gate reads
 *  (`~/.pure/roles/<role>/`, written by `bun run eval:harvest`), falling back to
 *  the repo's committed seeds in `evals/roles/<role>/` when nothing was
 *  harvested yet. */
async function resolveDefaultCasesDir(): Promise<string> {
  const runtime = join(homedir(), '.pure', 'roles', role!);
  try {
    if ((await readdir(runtime)).some((name) => name.endsWith('.json'))) return runtime;
  } catch {
    // No runtime fixtures — use the repo seeds.
  }
  return resolve(join('evals', 'roles', role!));
}

const casesDir = casesFlag ? resolve(casesFlag) : await resolveDefaultCasesDir();

// Overlay targets are the roles pure actually exposes; an unknown role would
// never receive an overlay from the reflector, so refuse it here too.
const REGISTRY = new Map<string, SubagentDefinition>(
  [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES].map((def) => [def.name, def]),
);
if (!REGISTRY.has(role)) {
  console.error(`unknown role "${role}" — known: ${[...REGISTRY.keys()].join(', ')}`);
  process.exit(2);
}
const overlayPath = overlayFlag
  ? resolve(overlayFlag.replace(/^~(?=$|\/|\\)/, homedir()))
  : join(homedir(), '.pure', 'personas', `${role}.overlay.md`);
const model = modelFlag ?? process.env.PURE_EVAL_MODEL ?? defaultModelFor(requestedAgent ?? 'deepseek-openai');

if (!requestedAgent) {
  console.error('--agent (or PURE_EVAL_AGENT) is required — the A/B needs a real provider to grade.');
  process.exit(2);
}
if (requestedAgent !== 'mock' && !apiKeyForProvider(requestedAgent)) {
  console.error('A provider API key is required for --agent (set PURE_EVAL_API_KEY or the provider-specific key).');
  process.exit(2);
}

// ── Load fixtures ──

function isRoleCaseFixture(value: unknown): value is RoleCaseFixture {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string'
    && typeof v.args === 'object' && v.args !== null
    && Array.isArray(v.must) && v.must.every((m) => typeof m === 'string');
}

const fixtures: RoleCaseFixture[] = [];
for (const entry of (await readdir(casesDir)).sort()) {
  if (!entry.endsWith('.json')) continue;
  const parsed: unknown = JSON.parse(await readFile(join(casesDir, entry), 'utf8'));
  if (!isRoleCaseFixture(parsed)) {
    console.error(`${entry}: not a role case fixture (need id / args / must[])`);
    process.exit(2);
  }
  fixtures.push(parsed);
}
if (fixtures.length === 0) {
  console.error(`no case fixtures in ${casesDir} — see evals/roles/README.md for the format`);
  process.exit(2);
}

// ── Overlay side setup ──

let overlayText: string | undefined;
try {
  overlayText = (await readFile(overlayPath, 'utf8')).trim() || undefined;
} catch {
  // No overlay file: nothing to gate — report and leave.
  console.error(`no overlay at ${overlayPath} — nothing to A/B (write one or pass --overlay).`);
  process.exit(2);
}

// ── Run both sides (base = no overlay, overlay = base + overlay) ──

// Subagents inherit the constrained deriveSubagentBudget from this parent
// budget; small on purpose so a wedged case fails fast instead of burning
// the A/B's wall clock.
const ROLE_BUDGET: BudgetConfig = {
  maxTurns: 12,
  maxTotalTokens: 120_000,
  maxExecutionTime: 12 * 60 * 1000,
  warningThreshold: 0.8,
  graceTurns: 1,
};

const adapter = createAdapter({ provider: requestedAgent!, model, apiKey: apiKeyForProvider(requestedAgent!) });

// One throwaway workspace per side: subagent tool writes never touch the repo.
const workspaces = new Map<string, string>();
async function workspaceFor(side: string): Promise<string> {
  let workspace = workspaces.get(side);
  if (!workspace) {
    workspace = await mkdtemp(join(resolve('/tmp'), `pure-role-regression-${role}-${side}-`));
    workspaces.set(side, workspace);
  }
  return workspace;
}

/** The one host-specific seam: run one case under one side. Everything else
 *  (grading, verdict) lives in the shared, injected-runCase core. */
const runCase: RunRoleCase = async (fixture, overlay) => {
  const side = overlay ? 'overlay' : 'base';
  const workspace = await workspaceFor(side);
  const tools = new NodeToolAdapter({ workspace, sessionId: `role-regression-${role}-${side}` });
  const orch = new SubagentOrchestrator({
    llm: adapter,
    parentTools: tools,
    parentToolsDefsProvider: () => tools.getTools(),
    defaultBudget: ROLE_BUDGET,
    parentSessionId: `role-regression-${role}-${side}`,
    ...(overlay ? { personaOverlays: new Map([[role, overlay]]) } : {}),
  });
  orch.register(REGISTRY.get(role)!);
  const toolCall: ToolCall = {
    id: `call_${fixture.id}`,
    index: 0,
    function: { name: role, arguments: JSON.stringify(fixture.args) },
  };
  const started = Date.now();
  const result = await orch.execute(toolCall);
  const output = extractSubagentOutput(result);
  process.stdout.write(`${side.padEnd(7)} ${fixture.id} (${Math.round((Date.now() - started) / 1000)}s)\n`);
  return output;
};

console.log(`role regression: ${role} · agent=${requestedAgent} · model=${model}`);
console.log(`cases: ${fixtures.length} from ${casesDir}`);
console.log(`overlay: ${overlayPath} (${overlayText.length} chars)`);

const ab = await runRoleRegressionAB({
  role,
  fixtures,
  overlay: overlayText,
  runCase,
  onCase: (side, grade) => {
    const mark = grade.passed ? '✓' : '✗';
    if (!grade.passed) process.stdout.write(`  ${side} ${grade.id}: ${mark} — ${grade.failures.join('; ')}\n`);
  },
});

console.log(`\nbase:    ${ab.base.passed}/${ab.base.total}`);
console.log(`overlay: ${ab.overlay.passed}/${ab.overlay.total}`);
console.log(`verdict: ${ab.verdict} — ${ab.reason}`);

const report = {
  suiteVersion: 'role-regression-v1',
  role,
  agent: requestedAgent,
  model,
  overlayPath,
  overlayChars: overlayText.length,
  caseCount: fixtures.length,
  cases: fixtures.map((f) => ({
    id: f.id,
    base: ab.grades.base.find((g) => g.id === f.id),
    overlay: ab.grades.overlay.find((g) => g.id === f.id),
  })),
  base: ab.base,
  overlay: ab.overlay,
  verdict: ab.verdict,
  reason: ab.reason,
  ranAt: new Date().toISOString(),
};
if (reportFlag) {
  await mkdir(join(resolve(reportFlag), '..'), { recursive: true });
  await writeFile(resolve(reportFlag), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${resolve(reportFlag)}`);
}
process.exit(ab.verdict === 'allow' ? 0 : ab.verdict === 'reject' ? 1 : 4);
