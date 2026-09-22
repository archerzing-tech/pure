// scripts/harvest-role-samples.ts
// 北极星第 6 步 13.3（part 3）/ 13.1 — 真实派发样本收割 runner。
//
// 流程：读会话存档（~/.pure/sessions/<id>/session.json）→ 抽真实角色委派
// {role, args, output}（E4.1 观测不存 args/产出，只能从存档回收）→ 用一次便宜
// 模型从（角色契约 + 真实产出）起草内容断言 → **自洽门**：base 侧用自己的
// SubagentOrchestrator 跑一遍，断言必须通过才收录 → 写入 evals/roles/<role>/。
//
// 用法：
//   bun run eval:harvest -- --agent deepseek-openai [--model deepseek-chat]
//       [--roles code_reviewer,researcher] [--max 8] [--replace] [--dry-run]
//       [--sessions ~/.pure/sessions] [--cases-root ~/.pure/roles]
//
// --dry-run 只报告每个角色有多少可收样本，不调模型、不写盘（先看料够不够）。
// --replace 会先清掉该角色的 case-*.json（把旧手写种子换掉）再写新样本。
//
// 默认写运行时目录 ~/.pure/roles/<role>/ —— GUI 的 A/B 门槛读的就是这里
// （Rust list_role_cases），写去仓库 evals/roles/ 会让 GUI 永远找不到样本。
//
// 退出码：0 = 正常（含"料不够"），2 = 用法/环境错误。

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAdapter } from '../src/evaluation/codingAgentExecutor';
import { draftRoleAssertions } from '../src/evaluation/roleAssertionDraft';
import {
  dedupeSamples,
  groupSamplesByRole,
  harvestRoleSamples,
  type HarvestSession,
  type RoleDelegationSample,
} from '../src/evaluation/roleSampleHarvest';
import {
  extractSubagentOutput,
  gradeRoleCase,
  MIN_ROLE_CASES,
  type RoleCaseFixture,
} from '../src/evaluation/roleRegression';
import { NodeToolAdapter } from '../src/adapter/node/NodeToolAdapter';
import { BUILT_IN_SUBAGENTS, CODING_AGENT_ROLES, SubagentOrchestrator } from '../src/coding-agent/SubagentOrchestrator';
import type { SubagentDefinition } from '../src/coding-agent/types';
import { NON_ROLE_SUBAGENTS } from '../src/shared/subagentAdvisory';
import { defaultModelFor } from '../src/shared/providers';
import type { BudgetConfig, ToolCall } from '../src/shared/types';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(name);

const agentFlag = flag('--agent');
const modelFlag = flag('--model');
const rolesFlag = flag('--roles');
const maxPerRole = Number.parseInt(flag('--max') ?? '8', 10);
const sessionsFlag = flag('--sessions');
const casesRootFlag = flag('--cases-root');
const requestedAgent = agentFlag ?? process.env.PURE_EVAL_AGENT;
const dryRun = has('--dry-run');
const replace = has('--replace');

const expandHome = (p: string): string => resolve(p.replace(/^~(?=$|\/|\\)/, homedir()));
const sessionsDir = expandHome(sessionsFlag ?? join(homedir(), '.pure', 'sessions'));
const casesRoot = casesRootFlag
  ? resolve(casesRootFlag.replace(/^~(?=$|\/|\\)/, homedir()))
  : join(homedir(), '.pure', 'roles');

if (!Number.isFinite(maxPerRole) || maxPerRole < 1) {
  console.error('--max must be a positive integer');
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

const REGISTRY = new Map<string, SubagentDefinition>(
  [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES].map((def) => [def.name, def]),
);

// ── Read + harvest session archives ──

interface SessionFile { id: string; messages: HarvestSession['messages'] }

async function readSessions(): Promise<SessionFile[]> {
  let dirs: string[] = [];
  try {
    dirs = (await readdir(sessionsDir)).filter((n) => n.startsWith('session_')).sort();
  } catch {
    console.error(`no session archives at ${sessionsDir}`);
    process.exit(2);
  }
  const out: SessionFile[] = [];
  for (const id of dirs) {
    try {
      const raw = await readFile(join(sessionsDir, id, 'session.json'), 'utf8');
      const parsed = JSON.parse(raw) as { messages?: HarvestSession['messages'] };
      if (Array.isArray(parsed.messages)) out.push({ id, messages: parsed.messages });
    } catch {
      // A broken/empty archive must not stop the harvest — skip it.
    }
  }
  return out;
}

const sessions = await readSessions();
const wantedRoles = rolesFlag
  ? rolesFlag.split(',').map((r) => r.trim()).filter(Boolean)
  : [...REGISTRY.keys()].filter((role) => !NON_ROLE_SUBAGENTS.has(role));
const samples = groupSamplesByRole(dedupeSamples(harvestRoleSamples(sessions, wantedRoles)));

console.log(`sessions: ${sessions.length} from ${sessionsDir}`);
console.log(`roles with real samples:`);
let total = 0;
for (const [role, group] of samples) {
  const known = REGISTRY.has(role) ? '' : ' (not a registered role — skipped)';
  total += group.length;
  console.log(`  ${role}: ${group.length}${known}`);
}
if (total === 0) {
  console.log('no real role delegations found — nothing to harvest (run more multi-agent sessions first).');
  process.exit(0);
}

if (dryRun) {
  for (const [role, group] of samples) {
    if (!REGISTRY.has(role)) continue;
    const enough = group.length >= MIN_ROLE_CASES ? 'gate can decide' : `need ≥${MIN_ROLE_CASES} for the gate`;
    console.log(`  → ${role}: up to ${Math.min(group.length, maxPerRole)} cases (${enough})`);
  }
  process.exit(0);
}

if (!requestedAgent) {
  console.error('--agent (or PURE_EVAL_AGENT) is required — drafting assertions needs a model.');
  process.exit(2);
}
if (requestedAgent !== 'mock' && !apiKeyForProvider(requestedAgent)) {
  console.error('A provider API key is required for --agent (set PURE_EVAL_API_KEY or the provider-specific key).');
  process.exit(2);
}
const model = modelFlag ?? process.env.PURE_EVAL_MODEL ?? defaultModelFor(requestedAgent);
const adapter = createAdapter({ provider: requestedAgent, model, apiKey: apiKeyForProvider(requestedAgent) });

// ── Draft assertions + self-consistency gate ──

// Same constrained budget as the A/B runner: a wedged case fails fast instead
// of burning the harvest's wall clock.
const HARVEST_BUDGET: BudgetConfig = {
  maxTurns: 12,
  maxTotalTokens: 120_000,
  maxExecutionTime: 12 * 60 * 1000,
  warningThreshold: 0.8,
  graceTurns: 1,
};

/** The role's contract text for the drafting prompt: the base persona rendered
 *  for this case's args (what the subagent would actually be told). Falls back
 *  to the role description when rendering throws. */
function safeContract(def: SubagentDefinition, sample: RoleDelegationSample): string {
  try {
    return def.createSystemPrompt(sample.args);
  } catch {
    return def.description;
  }
}

/** Run the base persona once for one case and report whether the drafted
 *  assertions hold. The self-consistency gate: an assertion set the base
 *  persona cannot satisfy measures nothing, so it is never admitted. */
async function basePasses(role: string, fixture: RoleCaseFixture): Promise<boolean> {
  const workspace = await mkdtemp(join(resolve('/tmp'), `pure-harvest-${role}-`));
  const tools = new NodeToolAdapter({ workspace, sessionId: `harvest-${role}` });
  const orch = new SubagentOrchestrator({
    llm: adapter,
    parentTools: tools,
    parentToolsDefsProvider: () => tools.getTools(),
    defaultBudget: HARVEST_BUDGET,
    parentSessionId: `harvest-${role}`,
  });
  orch.register(REGISTRY.get(role)!);
  const toolCall: ToolCall = {
    id: `call_${fixture.id}`,
    index: 0,
    function: { name: role, arguments: JSON.stringify(fixture.args) },
  };
  const result = await orch.execute(toolCall);
  return gradeRoleCase(extractSubagentOutput(result), fixture).passed;
}

const written: Record<string, number> = {};
for (const [role, group] of samples) {
  const def = REGISTRY.get(role);
  if (!def) continue;
  const roleDir = join(casesRoot, role);
  const candidates = group.slice(0, maxPerRole);
  console.log(`\n${role}: ${candidates.length} candidate(s)`);
  await mkdir(roleDir, { recursive: true });
  if (replace) {
    for (const entry of await readdir(roleDir)) {
      if (/^case-\d+\.json$/.test(entry)) await rm(join(roleDir, entry));
    }
  }
  const fixtures: RoleCaseFixture[] = [];
  let index = 1;
  for (const sample of candidates) {
    const draft = await draftRoleAssertions(adapter, {
      role,
      roleContract: safeContract(def, sample),
      realOutput: sample.output,
    }).catch((err) => {
      console.warn(`  ${sample.sessionId}#${sample.messageIndex}: draft failed — ${err instanceof Error ? err.message : err}`);
      return undefined;
    });
    if (!draft) {
      console.warn(`  ${sample.sessionId}#${sample.messageIndex}: no usable assertions — skipped`);
      continue;
    }
    const fixture: RoleCaseFixture = {
      id: `case-${String(index).padStart(2, '0')}`,
      description: `真实派发样本：${sample.sessionId}#${sample.messageIndex}`,
      args: sample.args,
      must: draft.must,
      ...(draft.mustNot.length > 0 ? { mustNot: draft.mustNot } : {}),
    };
    const passes = await basePasses(role, fixture).catch(() => false);
    if (!passes) {
      console.warn(`  ${fixture.id}: base failed the drafted assertions (self-consistency gate) — skipped`);
      continue;
    }
    await writeFile(join(roleDir, `${fixture.id}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    fixtures.push(fixture);
    console.log(`  ${fixture.id}: ✓ must[${fixture.must.join(' | ')}]`);
    index++;
  }
  written[role] = fixtures.length;
}

console.log('\nharvest summary:');
for (const [role, count] of Object.entries(written)) {
  const gate = count >= MIN_ROLE_CASES ? `gate can decide (≥${MIN_ROLE_CASES})` : `still ${MIN_ROLE_CASES - count} short of the gate`;
  console.log(`  ${role}: ${count} case(s) written — ${gate}`);
}
console.log(`\nrun the A/B with: bun run eval:roles -- --role <role> --agent ${requestedAgent}${model ? ` --model ${model}` : ''}`);
