// 回合级「无进展」基线（2026-11-21）。
//
// 目的：P0 想加一条「成功的重复调用 / 连续无写入」判据，但阈值不能拍脑袋。
// 这个脚本把真实任务跑出来的工具调用序列拆成回合，量三件事：
//   1. 同一 (tool, args) **成功**执行了几次（失败不算——失败已有 FailurePolicy 管）；
//   2. 连续相同成功调用的最长连（period-1），以及 A,B,A,B 交替窗口（period-2）；
//   3. 连续多少个回合没有任何成功写入（write/edit/apply_patch）。
// 只有 3 和 1 的分布能决定阈值是否成立：如果真实任务里 3 次重复几乎不出现，
// 那么「3 次就提醒」只会变成噪音。
//
// 用法：
//   bun run scripts/measure-turn-progress.ts --reps 1 --out tmp/turn-progress.json
//   bun run scripts/measure-turn-progress.ts --only fix-take-top-off-by-one,hard-bugfix-task-queue-leak
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig, resolveOverrideSecretKey } from '../src/cliConfig';
import { customProviderFor, promptBudgetForProvider } from '../src/shared/providers';
import { evaluateCodingTask, CODING_TASK_FIXTURES, type CodingTaskFixture } from '../src/evaluation/codingTaskBaseline';
import { FRONTIER_TASK_FIXTURES } from '../src/evaluation/codingTaskFrontierFixtures';
import { CodingAgent } from '../src/coding-agent/CodingAgent';
import { NodeToolAdapter } from '../src/adapter/node/NodeToolAdapter';
import { PromptAssembler, buildCliCapabilities } from '../src/shared/PromptAssembler';
import { setCustomPresentationCardsLoader } from '../src/coding-agent/ToolRegistry';
import { createLLMAdapter } from '../src/ui/chat';
import type { BudgetConfig, EngineEvent, LLMAdapter, TokenUsage } from '../src/shared/types';

const argv = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}
const reps = Number(flagValue('reps') ?? 1);
const outPath = flagValue('out');
const only = flagValue('only');

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const REVISION = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();

const BUDGET: BudgetConfig = {
  maxTurns: 18,
  maxTotalTokens: 150_000,
  maxExecutionTime: 6 * 60_000,
  warningThreshold: 0.8,
  graceTurns: 2,
  hardMaxTurns: 18,
  hardMaxTokens: 150_000,
  hardMaxTime: 6 * 60_000,
};

interface ToolCallRecord {
  round: number;
  tool: string;
  /** 完整参数（归一后）——同一调用的严格判据。 */
  key: string;
  /** 只看目标路径的口径：同一文件用不同行范围读，严格判据算两次，这里算一次。
   *  用户说的「绕道」通常是后者（同一个文件反复看、每次换一个窗口）。 */
  pathKey: string;
  success: boolean;
}

interface RunRecord {
  rounds: number;
  toolCalls: number;
  writeCalls: number;
  /** 同一 (tool,args) 成功执行的最高次数。 */
  maxIdenticalSuccess: number;
  /** 达到 2 次 / 3 次的 (tool,args) 有几组。 */
  keysRepeatedTwice: number;
  keysRepeatedThrice: number;
  /** 连续完全相同成功调用的最长连。 */
  maxConsecutiveIdentical: number;
  /** A,B,A,B 交替窗口数（相同两条调用来回打转）。 */
  period2Windows: number;
  /** 连续没有任何成功写入的回合数（最长）。 */
  maxNoWriteRounds: number;
  /** 同一 (tool, 路径) 成功执行的最高次数（忽略行范围等细节参数）。 */
  maxSamePathSuccess: number;
  /** 同一路径被重复访问达到 3 次的组数。 */
  pathsRepeatedThrice: number;
  usage?: TokenUsage;
  fatalError?: string;
}

/** 从参数里取目标路径（read/write/edit/list 都叫 path，兜底 file/filePath）。 */
function pathOf(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidate = parsed.path ?? parsed.file ?? parsed.filePath ?? parsed.pattern ?? '';
    return typeof candidate === 'string' ? candidate : '';
  } catch {
    return '';
  }
}

/** 参数归一：解析后按 key 排序，避免同一调用的对象键序不同被判成两次调用。 */
function normalizeArgs(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as unknown;
    const stable = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stable);
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
          out[key] = stable((value as Record<string, unknown>)[key]);
        }
        return out;
      }
      return value;
    };
    return JSON.stringify(stable(parsed));
  } catch {
    return raw.slice(0, 400);
  }
}

const WRITE_TOOL = /(?:^|_)(write|edit|patch)/i;

function measure(calls: ToolCallRecord[], rounds: number): Omit<RunRecord, 'usage' | 'fatalError'> {
  const successes = calls.filter((call) => call.success);
  const byKey = new Map<string, number>();
  const byPath = new Map<string, number>();
  for (const call of successes) {
    const key = `${call.tool}\u0000${call.key}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
    if (call.pathKey) {
      const pathKey = `${call.tool}\u0000${call.pathKey}`;
      byPath.set(pathKey, (byPath.get(pathKey) ?? 0) + 1);
    }
  }
  const counts = [...byKey.values()];
  const pathCounts = [...byPath.values()];
  let maxConsecutiveIdentical = 0;
  let streak = 0;
  let previous: string | null = null;
  for (const call of successes) {
    const key = `${call.tool}\u0000${call.key}`;
    streak = key === previous ? streak + 1 : 1;
    previous = key;
    maxConsecutiveIdentical = Math.max(maxConsecutiveIdentical, streak);
  }
  let period2Windows = 0;
  for (let index = 0; index + 3 < successes.length; index += 1) {
    const a = `${successes[index].tool}\u0000${successes[index].key}`;
    const b = `${successes[index + 1].tool}\u0000${successes[index + 1].key}`;
    const c = `${successes[index + 2].tool}\u0000${successes[index + 2].key}`;
    const d = `${successes[index + 3].tool}\u0000${successes[index + 3].key}`;
    if (a === c && b === d && a !== b) period2Windows += 1;
  }
  // 无写入回合：按回合号扫，只有成功写入才打断连。
  const roundsWithWrite = new Set(successes.filter((call) => WRITE_TOOL.test(call.tool)).map((call) => call.round));
  let maxNoWriteRounds = 0;
  let noWriteStreak = 0;
  for (let round = 1; round <= rounds; round += 1) {
    noWriteStreak = roundsWithWrite.has(round) ? 0 : noWriteStreak + 1;
    maxNoWriteRounds = Math.max(maxNoWriteRounds, noWriteStreak);
  }
  return {
    rounds,
    toolCalls: calls.length,
    writeCalls: successes.filter((call) => WRITE_TOOL.test(call.tool)).length,
    maxIdenticalSuccess: counts.length > 0 ? Math.max(...counts) : 0,
    keysRepeatedTwice: counts.filter((count) => count >= 2).length,
    keysRepeatedThrice: counts.filter((count) => count >= 3).length,
    maxConsecutiveIdentical,
    period2Windows,
    maxNoWriteRounds,
    maxSamePathSuccess: pathCounts.length > 0 ? Math.max(...pathCounts) : 0,
    pathsRepeatedThrice: pathCounts.filter((count) => count >= 3).length,
  };
}

async function runAgent(task: CodingTaskFixture, workspace: string, llm: LLMAdapter, model: string): Promise<RunRecord> {
  const sessionId = `measure-${task.id}-${Date.now().toString(36)}`;
  const assembler = new PromptAssembler();
  const tools = new NodeToolAdapter({ workspace, sessionId });
  const budget = promptBudgetForProvider(undefined, 'custom001', model);
  setCustomPresentationCardsLoader(() => loadConfig()?.presentationCards);
  const agent = new CodingAgent({
    sessionId,
    llm,
    toolAdapter: tools,
    budget: BUDGET,
    toolsDefs: undefined,
    promptAssembler: assembler,
    promptBudget: budget,
    permissionMode: 'YOLO',
    projectPath: workspace,
  });
  const assembly = assembler.assemble({
    surface: 'cli',
    capabilities: buildCliCapabilities(),
    toolDefinitions: agent.toolRegistry.getTools(),
    mode: 'build',
    budget,
    sessionId,
  }, task.prompt);

  const calls: ToolCallRecord[] = [];
  const pending = new Map<string, { tool: string; key: string; pathKey: string }>();
  let round = 0;
  let usage: TokenUsage | undefined;
  let fatalError: string | undefined;
  for await (const event of agent.run(assembly.systemPrompt, assembly.userPrompt ?? task.prompt) as AsyncGenerator<EngineEvent>) {
    if (event.type === 'StateChange' && event.payload.to === 'THINK') round += 1;
    if (event.type === 'ToolStarted') {
      pending.set(event.payload.toolCallId, {
        tool: event.payload.toolName,
        key: normalizeArgs(event.payload.toolCallArgs),
        pathKey: pathOf(event.payload.toolCallArgs),
      });
    }
    if (event.type === 'ToolResult' && !event.payload.backgroundSettle) {
      const call = pending.get(event.payload.toolCallId);
      if (call) {
        calls.push({ round, tool: call.tool, key: call.key, pathKey: call.pathKey, success: event.payload.result.success === true });
        pending.delete(event.payload.toolCallId);
      }
    }
    if (event.type === 'Error' && event.payload.recoverable === false) {
      fatalError = `${event.payload.code}: ${event.payload.message}`;
    }
    if (event.type === 'Completed') {
      usage = event.payload.usage;
      if (!event.payload.isComplete && !fatalError) fatalError = 'run ended without completing its turn';
    }
  }
  return { ...measure(calls, round), usage, fatalError, };
}

const baseConfig = loadConfig();
if (!baseConfig) throw new Error('no ~/.pure/config.json');
const custom = customProviderFor(baseConfig.customProviders, 'custom001');
if (!custom?.baseURL) throw new Error('custom001 without baseURL');
const apiKey = custom.apiKey || resolveOverrideSecretKey('custom001');
if (!apiKey) throw new Error('no key for custom001');
const model = baseConfig.model || custom.defaultModel;
const config = {
  ...baseConfig,
  customProviders: (baseConfig.customProviders ?? []).map((entry) =>
    entry.id === 'custom001' ? { ...entry, apiKey } : entry,
  ),
};

const onlyIds = only ? new Set(only.split(',')) : undefined;
const fixtures = [...CODING_TASK_FIXTURES, ...FRONTIER_TASK_FIXTURES]
  .filter((task) => !onlyIds || onlyIds.has(task.id));
if (fixtures.length === 0) throw new Error(`no fixture matched ${only ?? 'all'}`);

const rows: Array<RunRecord & { taskId: string; rep: number; passAt1: boolean; wallMs: number }> = [];
for (const fixture of fixtures) {
  for (let rep = 1; rep <= reps; rep += 1) {
    const llm = createLLMAdapter(config, {});
    const started = Date.now();
    let run: RunRecord | undefined;
    const result = await evaluateCodingTask(fixture, {
      agent: async ({ workspace }) => {
        run = await runAgent(fixture, workspace, llm, model);
        return { usage: run.usage, toolCalls: run.toolCalls, turns: run.rounds };
      },
    });
    if (!run) throw new Error(`fixture ${fixture.id} never ran`);
    const wallMs = Date.now() - started;
    rows.push({ ...run, taskId: fixture.id, rep, passAt1: result.passAt1, wallMs });
    console.log(
      `${result.passAt1 ? 'PASS' : 'FAIL'} ${fixture.id} rep=${rep} rounds=${run.rounds} tools=${run.toolCalls} writes=${run.writeCalls} ` +
      `maxSame=${run.maxIdenticalSuccess} same>=3=${run.keysRepeatedThrice} ` +
      `maxSamePath=${run.maxSamePathSuccess} path>=3=${run.pathsRepeatedThrice} ` +
      `streak=${run.maxConsecutiveIdentical} p2=${run.period2Windows} noWrite=${run.maxNoWriteRounds} ${wallMs}ms` +
      (run.fatalError ? ` fatal=${run.fatalError.slice(0, 120)}` : ''),
    );
  }
}

const max = (pick: (row: RunRecord) => number): number => (rows.length > 0 ? Math.max(...rows.map(pick)) : 0);
const median = (pick: (row: RunRecord) => number): number => {
  const sorted = rows.map(pick).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};
const share = (pick: (row: RunRecord) => boolean): string => `${rows.filter(pick).length}/${rows.length}`;

console.log('');
console.log(`聚合（${rows.length} 次运行，${REVISION}，${model}）`);
console.log(`  通过率           ${share((row) => row.passAt1)}`);
console.log(`  回合 中位/最大   ${median((row) => row.rounds)} / ${max((row) => row.rounds)}`);
console.log(`  工具 中位/最大   ${median((row) => row.toolCalls)} / ${max((row) => row.toolCalls)}`);
console.log(`  同一调用成功重复 中位/最大 ${median((row) => row.maxIdenticalSuccess)} / ${max((row) => row.maxIdenticalSuccess)}`);
console.log(`  出现 >=3 次重复的运行   ${share((row) => row.keysRepeatedThrice > 0)}`);
console.log(`  出现 >=2 次重复的运行   ${share((row) => row.keysRepeatedTwice > 0)}`);
console.log(`  连续相同成功调用 最大连 ${max((row) => row.maxConsecutiveIdentical)}`);
console.log(`  A,B,A,B 交替窗口 合计   ${rows.reduce((sum, row) => sum + row.period2Windows, 0)}`);
console.log(`  连续无写入回合 中位/最大 ${median((row) => row.maxNoWriteRounds)} / ${max((row) => row.maxNoWriteRounds)}`);
console.log(`  同一路径重复访问 中位/最大 ${median((row) => row.maxSamePathSuccess)} / ${max((row) => row.maxSamePathSuccess)}`);
console.log(`  出现同路径 >=3 次的运行 ${share((row) => row.pathsRepeatedThrice > 0)}`);

if (outPath) {
  const target = resolve(outPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ generatedAt: new Date().toISOString(), revision: REVISION, model, reps, rows }, null, 2)}\n`, 'utf8');
  console.log(`report: ${target}`);
}
