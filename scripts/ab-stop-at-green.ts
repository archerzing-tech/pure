// 验收即停的真机 A/B（2026-11-21）。
//
// 目的：证明「跑通全量验证后再提醒一次收尾」真的减少了绿后的空转。指标不是
// 通过率（这个任务的通过率应当两臂都 1），而是**首次全绿之后又发了几个 LLM
// 回合**——那正是用户抱怨的「做很长时间完成不了」的尾巴。
//
// 两个臂跑同一份代码、同一个 fixture、同一个模型，唯一差异是
// PURE_STOP_AT_GREEN=0（关掉提醒）。用环境开关而不是两个构建，因为两个构建
// 说不清差异属于谁。
//
// fixture 是现场生成的「大仓库」：20 个模块 × 15 个文件 + 1 个核心模块 + 1 个
// 失败测试（300 个源文件，导航成本真实存在，但不是本仓库的拷贝）。每个臂都用
// 全新目录，互不污染。
//
// 用法：
//   bun run scripts/ab-stop-at-green.ts --reps 2 --out tmp/ab-stop-at-green.json
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig, resolveOverrideSecretKey } from '../src/cliConfig';
import { customProviderFor, promptBudgetForProvider } from '../src/shared/providers';
import { CodingAgent } from '../src/coding-agent/CodingAgent';
import { NodeToolAdapter } from '../src/adapter/node/NodeToolAdapter';
import { PromptAssembler, buildCliCapabilities } from '../src/shared/PromptAssembler';
import { setCustomPresentationCardsLoader } from '../src/coding-agent/ToolRegistry';
import { createLLMAdapter } from '../src/ui/chat';
import type { BudgetConfig, EngineEvent, LLMAdapter, Message, ToolDefinition, TokenUsage } from '../src/shared/types';

const argv = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}
const reps = Number(flagValue('reps') ?? 1);
const outPath = flagValue('out');
const modelOverride = flagValue('model');

const MODULE_COUNT = 20;
const FILES_PER_MODULE = 15;
const MODULES = Array.from({ length: MODULE_COUNT }, (_, index) => `m${String(index + 1).padStart(2, '0')}`);

const TASK_PROMPT = 'src/core/range.ts 里的 sumRange 把右端也算进去了，修好后跑 bun test 直到全过。不要改测试文件。';

const BUDGET: BudgetConfig = {
  maxTurns: 14,
  maxTotalTokens: 120_000,
  maxExecutionTime: 4 * 60_000,
  warningThreshold: 0.8,
  graceTurns: 2,
  hardMaxTurns: 14,
  hardMaxTokens: 120_000,
  hardMaxTime: 4 * 60_000,
};

const RANGE_SOURCE = `export function sumRange(start: number, end: number): number {
  let total = 0;
  for (let index = start; index <= end; index += 1) total += index;
  return total;
}
`;

const RANGE_TEST = `import { expect, test } from 'bun:test';
import { sumRange } from './range';

test('sums the half-open range', () => {
  expect(sumRange(1, 5)).toBe(10);
  expect(sumRange(0, 3)).toBe(3);
  expect(sumRange(4, 4)).toBe(0);
});
`;

/** 生成一个「大但不是本仓库」的 fixture：文件多到导航有成本，测试只有一处失败。 */
async function makeFixture(root: string): Promise<void> {
  await mkdir(join(root, 'src', 'core'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'ab-large-repo', private: true, scripts: { test: 'bun test' } }, null, 2));
  await writeFile(join(root, 'src', 'core', 'range.ts'), RANGE_SOURCE);
  await writeFile(join(root, 'src', 'core', 'range.test.ts'), RANGE_TEST);
  for (const module of MODULES) {
    await mkdir(join(root, 'src', module), { recursive: true });
    for (let file = 1; file <= FILES_PER_MODULE; file += 1) {
      const name = `f${String(file).padStart(2, '0')}`;
      await writeFile(
        join(root, 'src', module, `${name}.ts`),
        `export function ${module}${name}(value: number): number {\n  return value + ${file};\n}\n`,
      );
    }
    await writeFile(
      join(root, 'src', module, 'index.ts'),
      Array.from({ length: FILES_PER_MODULE }, (_, index) => {
        const name = `f${String(index + 1).padStart(2, '0')}`;
        return `export { ${module}${name} } from './${name}';`;
      }).join('\n') + '\n',
    );
  }
}

interface RunMetrics {
  arm: 'on' | 'off';
  rep: number;
  llmRounds: number;
  roundOfFirstGreen: number | null;
  roundsAfterGreen: number | null;
  toolCalls: number;
  wallMs: number;
  usage?: TokenUsage;
  testsPass: boolean;
  fatalError?: string;
  finalText: string;
}

function isTestGreen(result: unknown): boolean {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  // exit code 与失败标记任一出现就不算绿；适配器把它拼在结果尾部。
  if (/exit(?:\s*code)?[:=]\s*[1-9]/i.test(text)) return false;
  if (/\b(?:fail|failed|FAIL|错误|失败)\b/.test(text) && !/\b0 fail\b/.test(text)) return false;
  return true;
}

async function runArm(arm: 'on' | 'off', rep: number, config: ReturnType<typeof loadConfig>, model: string): Promise<RunMetrics> {
  const root = await mkdtemp(join(tmpdir(), 'ab-green-'));
  await makeFixture(root);
  const sessionId = `ab-green-${arm}-${rep}-${Date.now().toString(36)}`;

  if (arm === 'off') process.env.PURE_STOP_AT_GREEN = '0';
  else delete process.env.PURE_STOP_AT_GREEN;

  const base = createLLMAdapter(config, {});
  const abort = new AbortController();
  let llmRounds = 0;
  let emptyRounds = 0;
  let quotaError: string | undefined;
  const llm: LLMAdapter = {
    stream: async function* (messages: Message[], tools: ToolDefinition[], signal?: AbortSignal) {
      llmRounds += 1;
      let produced = false;
      try {
        for await (const chunk of base.stream(messages, tools, signal)) {
          if (chunk.type === 'done' && (chunk.content || (chunk.toolCalls?.length ?? 0) > 0)) produced = true;
          yield chunk;
        }
      } catch (error) {
        // 429 等错误在适配器里以抛错形式出现（不是空块），同样算空轮。
        emptyRounds += 1;
        if (emptyRounds >= 3) {
          quotaError ??= String(error).slice(0, 240);
          abort.abort();
        }
        throw error;
      }
      // 配额/网络故障时适配器把错误包成可恢复事件重试，每轮都是空产出。连续
      // 3 轮直接收场：这不是被测行为，等下去只会烧满预算窗口。
      emptyRounds = produced ? 0 : emptyRounds + 1;
      if (emptyRounds >= 3) {
        quotaError ??= 'provider returned empty output for 3 consecutive rounds (quota/network?)';
        abort.abort();
      }
    },
    complete: (messages: Message[], tools: ToolDefinition[], signal?: AbortSignal) => {
      llmRounds += 1;
      return base.complete(messages, tools, signal);
    },
  };

  const tools = new NodeToolAdapter({ workspace: root, sessionId });
  const assembler = new PromptAssembler();
  const budget = promptBudgetForProvider(undefined, 'custom001', model);
  setCustomPresentationCardsLoader(() => config?.presentationCards);
  const agent = new CodingAgent({
    sessionId,
    llm,
    toolAdapter: tools,
    budget: BUDGET,
    toolsDefs: undefined,
    promptAssembler: assembler,
    promptBudget: budget,
    permissionMode: 'YOLO',
    projectPath: root,
  });
  const assembly = assembler.assemble({
    surface: 'cli',
    capabilities: buildCliCapabilities(),
    toolDefinitions: agent.toolRegistry.getTools(),
    mode: 'build',
    budget,
    sessionId,
  }, TASK_PROMPT);

  const commandArgs = new Map<string, string>();
  const providerErrors: string[] = [];
  let toolCalls = 0;
  let roundOfFirstGreen: number | null = null;
  let usage: TokenUsage | undefined;
  let fatalError: string | undefined;
  let finalText = '';
  const started = Date.now();
  for await (const event of agent.run(assembly.systemPrompt, assembly.userPrompt ?? TASK_PROMPT, abort.signal) as AsyncGenerator<EngineEvent>) {
    if (event.type === 'TokenDelta' && !event.payload.isToolCall && event.payload.content) finalText += event.payload.content;
    if (event.type === 'Error') providerErrors.push(`${event.payload.code}: ${event.payload.message}`);
    if (event.type === 'ToolStarted' && event.payload.toolCallArgs) commandArgs.set(event.payload.toolCallId, event.payload.toolCallArgs);
    if (event.type === 'ToolResult') {
      toolCalls += 1;
      const result = event.payload.result;
      if (result.toolName === 'execute_command' && roundOfFirstGreen === null) {
        const args = commandArgs.get(event.payload.toolCallId) ?? '';
        // 只认全量 bun test；带路径的局部跑不算项目绿（与引擎同一判据）。
        const fullSuite = /"command"\s*:\s*"[^"]*\bbun\s+test\b(?![^"]*\.(?:ts|js|tsx|jsx))/i.test(args);
        if (fullSuite && result.success === true && isTestGreen(result.result)) {
          roundOfFirstGreen = llmRounds;
        }
      }
    }
    if (event.type === 'Error' && event.payload.recoverable === false) fatalError = `${event.payload.code}: ${event.payload.message}`;
    if (event.type === 'Completed') {
      usage = event.payload.usage;
      if (!event.payload.isComplete && !fatalError) fatalError = 'run ended without completing its turn';
    }
  }
  // 配额/网络原因的优先级高于「回合没跑完」——后者只是前者的结果，报出来
  // 会把一次 429 误读成 agent 行为问题。
  if (quotaError) fatalError = quotaError;
  else fatalError ??= providerErrors.length > 0 && toolCalls === 0 && !usage ? providerErrors[0] : undefined;
  const wallMs = Date.now() - started;

  let testsPass = false;
  try {
    execSync('bun test', { cwd: root, stdio: 'ignore', timeout: 120_000 });
    testsPass = true;
  } catch {
    testsPass = false;
  }

  return {
    arm,
    rep,
    llmRounds,
    roundOfFirstGreen,
    roundsAfterGreen: roundOfFirstGreen === null ? null : llmRounds - roundOfFirstGreen,
    toolCalls,
    wallMs,
    usage,
    testsPass,
    fatalError,
    finalText: finalText.replace(/\s+/g, ' ').slice(0, 400),
  };
}

function summarise(rows: RunMetrics[], arm: 'on' | 'off'): string {
  const picked = rows.filter((row) => row.arm === arm);
  if (picked.length === 0) return `${arm}: (no runs)`;
  const avg = (values: number[]): string => (values.length === 0 ? '?' : (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
  const green = picked.filter((row) => row.roundsAfterGreen !== null).map((row) => row.roundsAfterGreen as number);
  const tokens = picked.map((row) => row.usage?.total ?? 0).filter((value) => value > 0);
  return `${arm}: rounds=${avg(picked.map((row) => row.llmRounds))} roundsAfterGreen=${avg(green)} `
    + `wallMs=${avg(picked.map((row) => row.wallMs))} tools=${avg(picked.map((row) => row.toolCalls))} `
    + `tokens=${avg(tokens)} pass=${picked.filter((row) => row.testsPass).length}/${picked.length}`;
}

const baseConfig = loadConfig();
if (!baseConfig) throw new Error('no ~/.pure/config.json');
const custom = customProviderFor(baseConfig.customProviders, 'custom001');
if (!custom?.baseURL) throw new Error('custom001 without baseURL');
const apiKey = custom.apiKey || resolveOverrideSecretKey('custom001');
if (!apiKey) throw new Error('no key for custom001 (set it in the app or PURE_EVAL_API_KEY)');
const config = {
  ...baseConfig,
  customProviders: (baseConfig.customProviders ?? []).map((entry) => (entry.id === 'custom001' ? { ...entry, apiKey } : entry)),
};
const model = modelOverride ?? baseConfig.model ?? custom.defaultModel ?? 'unknown';
console.log(`model=${model} reps=${reps} fixture=${MODULE_COUNT}x${FILES_PER_MODULE} files`);

const rows: RunMetrics[] = [];
for (let rep = 1; rep <= reps; rep += 1) {
  for (const arm of ['off', 'on'] as const) {
    const row = await runArm(arm, rep, config, model);
    rows.push(row);
    console.log(`${arm.padEnd(3)} rep=${rep} rounds=${row.llmRounds} firstGreen=${row.roundOfFirstGreen ?? '-'} afterGreen=${row.roundsAfterGreen ?? '-'} `
      + `tools=${row.toolCalls} ${row.wallMs}ms pass=${row.testsPass}${row.fatalError ? ` fatal=${row.fatalError.slice(0, 120)}` : ''}`);
  }
}

console.log('');
console.log(summarise(rows, 'off'));
console.log(summarise(rows, 'on'));

if (outPath) {
  const target = resolve(outPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify({
    generatedAt: new Date().toISOString(),
    revision: execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(),
    model,
    prompt: TASK_PROMPT,
    fixture: { modules: MODULE_COUNT, filesPerModule: FILES_PER_MODULE },
    rows,
  }, null, 2));
  console.log(`report: ${target}`);
}
