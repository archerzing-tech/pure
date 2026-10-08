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
//       [--roles code_reviewer,researcher] [--max 8] [--gate-runs 3] [--replace]
//       [--dry-run] [--sessions ~/.pure/sessions] [--cases-root ~/.pure/roles]
//       [--subagents ~/.pure/subagents]
//
// 默认角色面 = 内建七角色 ∪ `~/.pure/subagents/` 里的生成角色。生成角色能被委派，
// 它的样本就同样收得回来；此前只有内建角色，于是生成角色的样本源默认是空的，
// 转正门槛 MIN_ROLE_CASES=5 结构上永远满足不了。
//
// --dry-run 只报告每个角色有多少可收样本，不调模型、不写盘（先看料够不够）。
// --replace 会先清掉该角色的 case-*.json（把旧手写种子换掉）再写新样本。
// 默认（无 --replace）是断点续收：盘上已有的 case 按样本 args 识别后跳过，
// 新案例的编号接着盘上最大的排——收割常被墙钟掐断，续跑不重烧已过门的资产。
//
// 默认写运行时目录 ~/.pure/roles/<role>/ —— GUI 的 A/B 门槛读的就是这里
// （Rust list_role_cases），写去仓库 evals/roles/ 会让 GUI 永远找不到样本。
//
// 退出码：0 = 正常（含"料不够"），2 = 用法/环境错误。

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAdapter } from '../src/evaluation/codingAgentExecutor';
import {
  draftRoleAssertions,
  filterUnsupportedMarkers,
  gateAdmits,
} from '../src/evaluation/roleAssertionDraft';
import {
  dedupeSamples,
  groupSamplesByRole,
  harvestRoleSamples,
  sampleDedupeKey,
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
import { BUILT_IN_TOOLS } from '../src/coding-agent/ToolRegistry';
import { compileExternalSubagents } from '../src/harness/externalSubagents';
import { TRIAL_MARKER_SUFFIX } from '../src/shared/roleTrial';
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
const subagentsFlag = flag('--subagents');
const gateRunsFlag = Number(flag('--gate-runs') ?? '3');
const requestedAgent = agentFlag ?? process.env.PURE_EVAL_AGENT;
const dryRun = has('--dry-run');
const replace = has('--replace');

const expandHome = (p: string): string => resolve(p.replace(/^~(?=$|\/|\\)/, homedir()));
const sessionsDir = expandHome(sessionsFlag ?? join(homedir(), '.pure', 'sessions'));
const casesRoot = casesRootFlag
  ? resolve(casesRootFlag.replace(/^~(?=$|\/|\\)/, homedir()))
  : join(homedir(), '.pure', 'roles');
const subagentsDir = expandHome(
  subagentsFlag ?? process.env.PURE_SUBAGENTS_DIR ?? join(homedir(), '.pure', 'subagents'),
);

if (!Number.isFinite(maxPerRole) || maxPerRole < 1) {
  console.error('--max must be a positive integer');
  process.exit(2);
}
if (!Number.isInteger(gateRunsFlag) || gateRunsFlag < 1) {
  console.error('--gate-runs must be a positive integer');
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

/** `~/.pure/subagents/` 里的生成角色定义。
 *
 * 收割面默认只有内建七角色时，生成角色的样本源是空的：能委派、收不到样本、
 * MIN_ROLE_CASES=5 永不满足，overlay A/B 裁决恒 `deny_insufficient_data`——
 * 一个结构上不可达的功能（2026-10-07 审计）。
 *
 * 校验与编译走 `compileExternalSubagents` 那一份定义（和 GUI 装载面同源），
 * 这里不自己判一遍：多一份判据就多一次“两边对同一个 manifest 看法不同”。
 */
async function loadGeneratedRoleDefs(): Promise<SubagentDefinition[]> {
  let files: string[] = [];
  try {
    files = (await readdir(subagentsDir))
      .filter((name) => name.endsWith('.json') && !name.endsWith(`.${TRIAL_MARKER_SUFFIX}`))
      .sort();
  } catch {
    return []; // 没有生成角色目录：退回只收内建角色的老行为
  }
  const sources: Array<{ file: string; text: string }> = [];
  for (const file of files) {
    try {
      sources.push({ file, text: await readFile(join(subagentsDir, file), 'utf8') });
    } catch {
      // 单个文件读不到不该拖垮整批。
    }
  }
  // 保留名 = 内建角色名 ∪ 内建工具名，与 GUI 装载面同一份判据。叫
  // `execute_command` 的 manifest 会被编译器拒掉；放它进来，之后每一条 shell
  // 调用都会被当成一次角色委派收样本。
  const reserved = [...REGISTRY.keys(), ...BUILT_IN_TOOLS.map((tool) => tool.name.toLowerCase())];
  const { defs, errors } = compileExternalSubagents(sources, reserved);
  for (const line of errors) console.warn(`[harvest] ${line}`);
  return defs;
}

// 内建优先：生成角色不允许与内建同名（编译器在 reserved 里已经拦下）。
const generatedRoleDefs = await loadGeneratedRoleDefs();
for (const def of generatedRoleDefs) {
  if (!REGISTRY.has(def.name)) REGISTRY.set(def.name, def);
}

// ── Read + harvest session archives ──

interface SessionFile { id: string; messages: HarvestSession['messages']; workspace?: string }

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
      const parsed = JSON.parse(raw) as { messages?: HarvestSession['messages']; workspace?: string };
      if (Array.isArray(parsed.messages)) {
        out.push({ id, messages: parsed.messages, ...(typeof parsed.workspace === 'string' && parsed.workspace ? { workspace: parsed.workspace } : {}) });
      }
    } catch {
      // A broken/empty archive must not stop the harvest — skip it.
    }
  }
  return out;
}

/** T1/G2 对账：读观测日志里的角色委派统计（toolCalls 口径），与存档收割结果
 *  对照。agent_run.sessionId 就是存档目录名，所以「观测有、存档无」直接等价于
 *  「该会话的存档已删或不可读」——差距不是实现问题，是数据已经没了。只读，
 *  读不到观测日志就返回空（CLI 场景没有 app.jsonl 是正常的）。 */
async function readObservedDelegations(): Promise<Map<string, number>> {
  const observed = new Map<string, number>();
  try {
    const raw = await readFile(join(homedir(), '.pure', 'observations', 'app.jsonl'), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { type?: string; toolCalls?: Array<{ toolName?: string }> };
        if (record.type !== 'agent_run') continue;
        for (const call of record.toolCalls ?? []) {
          if (call.toolName && REGISTRY.has(call.toolName)) {
            observed.set(call.toolName, (observed.get(call.toolName) ?? 0) + 1);
          }
        }
      } catch {
        // One broken line never hides the later observations.
      }
    }
  } catch {
    // No observation log (CLI-only machine) — nothing to reconcile against.
  }
  return observed;
}

const sessions = await readSessions();
const wantedRoles = rolesFlag
  ? rolesFlag.split(',').map((r) => r.trim()).filter(Boolean)
  : [...REGISTRY.keys()].filter((role) => !NON_ROLE_SUBAGENTS.has(role));
const samples = groupSamplesByRole(dedupeSamples(harvestRoleSamples(sessions, wantedRoles)));

console.log(`sessions: ${sessions.length} from ${sessionsDir}`);
// 把收割面本身打出来：生成角色收不到样本时，「没料」与「根本没在面里」是两件
// 完全不同的事，两者的修法也完全不同（多跑几次 vs 换目录）。
if (generatedRoleDefs.length > 0) {
  console.log(`generated roles: ${generatedRoleDefs.map((def) => def.name).join(', ')} (from ${subagentsDir})`);
}
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

// T1/G2 对账：观测里数得出的委派 vs 存档里收得回的样本。缺口 = 已删除/不可读
// 存档里的历史委派——看清楚它，才不会误以为"多跑几次就能补"。
const observed = await readObservedDelegations();
if (observed.size > 0) {
  console.log('observation cross-check (observed delegations vs harvestable samples):');
  for (const [role, count] of [...observed.entries()].sort((a, b) => b[1] - a[1])) {
    const harvestable = samples.get(role)?.length ?? 0;
    const lost = count - harvestable;
    const note = lost > 0 ? ` — ${lost} in deleted/unreadable archives (gone for good)` : '';
    console.log(`  ${role}: observed ${count}, harvestable ${harvestable}${note}`);
  }
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

/** 自洽门：收录一条样本前，base 侧对起草断言的满足度要经得起重复——
 *  判定核是 roleAssertionDraft.gateAdmits（K 次过半收录），与判定 LLM 的
 *  抖动对冲：「偶尔可满足」的断言集不可收录，否则 A/B 的 base 基线自身
 *  随机挂，verdict 全是噪音。提前终止只在数学上安全时发生：剩余票全败
 *  也已过半，或剩余票全过也凑不齐多数——票没开完不预判（独立检验打回：
 *  「首跑挂即拒」比多数票更严，1/3 抖动的合法样本被误杀，且 K≥3 时不
 *  等价）。 */
async function gatePasses(role: string, fixture: RoleCaseFixture): Promise<{ admit: boolean; tally: string }> {
  const runs: boolean[] = [];
  for (let i = 0; i < gateRunsFlag; i++) {
    runs.push(await basePasses(role, fixture).catch(() => false));
    const yes = runs.filter(Boolean).length;
    const remaining = gateRunsFlag - runs.length;
    if (yes * 2 > gateRunsFlag || (yes + remaining) * 2 <= gateRunsFlag) break;
  }
  const yes = runs.filter(Boolean).length;
  return { admit: gateAdmits(runs), tally: `${yes} yes of ${runs.length}/${gateRunsFlag} run(s)` };
}

/** Run the base persona once for one case and report whether the drafted
 *  assertions hold. An assertion set the base persona cannot satisfy measures
 *  nothing, so it is never admitted.
 *  S1 真机（2026-09-30）：样本带工作区且目录还在 ⇒ 原地重跑（文件依赖型角色
 *  的评审对象在那里）；否则空临时目录（研究型样本无感，文件型的会如实地
 *  过不了断言——不假装）。 */
async function basePasses(role: string, fixture: RoleCaseFixture): Promise<boolean> {
  const hint = fixture.workspace;
  let hinted = false;
  if (hint) {
    try {
      const stat = await (await import('node:fs/promises')).stat(hint);
      hinted = stat.isDirectory();
    } catch { /* 目录没了就退回临时目录 */ }
  }
  const workspace = hinted ? hint! : await mkdtemp(join(resolve('/tmp'), `pure-harvest-${role}-`));
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
  // 断点续收：盘上已有的案例是过了门的资产，重跑不覆盖也不重收——按 args
  // 去重键（与样本去重同一把尺）识别已收录的委派，编号接着盘上最大的排。
  // 一次收割常被墙钟掐断（门跑 K 次很花时间），没有这条语义就只能白白重烧
  // 已过案例的门，还得赌新起草的不如旧的好。
  const diskKeys = new Set<string>();
  let maxDiskIndex = 0;
  const diskKey = (args: Record<string, unknown>): string =>
    sampleDedupeKey({ role, args, output: '', sessionId: '', messageIndex: 0 });
  for (const entry of await readdir(roleDir)) {
    const m = /^case-(\d+)\.json$/.exec(entry);
    if (!m) continue;
    maxDiskIndex = Math.max(maxDiskIndex, Number(m[1]));
    try {
      const parsed = JSON.parse(await readFile(join(roleDir, entry), 'utf8')) as { args?: unknown };
      if (parsed && typeof parsed.args === 'object' && parsed.args !== null && !Array.isArray(parsed.args)) {
        diskKeys.add(diskKey(parsed.args as Record<string, unknown>));
      }
    } catch { /* 旧案例读不动就放着，也不许被本轮覆盖 */ }
  }
  const fixtures: RoleCaseFixture[] = [];
  let index = maxDiskIndex + 1;
  for (const sample of candidates) {
    if (diskKeys.has(diskKey(sample.args))) {
      console.log(`  ${sample.sessionId}#${sample.messageIndex}: already on disk — kept`);
      continue;
    }
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
    // 预滤先走：原文里找不到的 must 是 paraphrase/幻觉，判分器永远找不到
    // 支撑，不值得为它烧 K 次 base 重跑。
    const supported = filterUnsupportedMarkers(draft, sample.output);
    if (!supported) {
      console.warn(`  ${sample.sessionId}#${sample.messageIndex}: every must marker is absent from the real output (paraphrased?) — skipped`);
      continue;
    }
    const fixture: RoleCaseFixture = {
      id: `case-${String(index).padStart(2, '0')}`,
      description: `真实派发样本：${sample.sessionId}#${sample.messageIndex}`,
      args: sample.args,
      must: supported.must,
      ...(supported.mustNot.length > 0 ? { mustNot: supported.mustNot } : {}),
      ...(sample.workspace ? { workspace: sample.workspace } : {}),
    };
    const gate = await gatePasses(role, fixture);
    if (!gate.admit) {
      console.warn(`  ${fixture.id}: gate ${gate.tally} — base could not reliably satisfy the assertions — skipped`);
      continue;
    }
    await writeFile(join(roleDir, `${fixture.id}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    fixtures.push(fixture);
    console.log(`  ${fixture.id}: ✓ gate ${gate.tally} — must[${fixture.must.join(' | ')}]`);
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
