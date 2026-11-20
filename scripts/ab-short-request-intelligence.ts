// 短中文工程请求的「思考档」真实任务 A/B。
//
// 目的：v4.9.6 的 turnShape 只认代码块/URL/路径，13–60 字的中文工程请求会被
// 判成寒暄，首轮降成 disableThinking + reasoning_effort:low。bf12c13 补了工作
// 动词信号。这个脚本不模拟判据：它直接调用当前版本的 isLightShapedTurn 与
// createLLMAdapter，把判据给出的档位原样跑在真实任务上，所以同一个脚本在
// v4.9.6 worktree 与 main 上各跑一次就是版本级 A/B。
//
// 任务用仓库已有的确定性 fixture，只把 prompt 改写成不含路径/URL 的短句——
// 这正是旧判据误判的形状；文件、控制组与验收命令都不动。
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig, resolveOverrideSecretKey } from '../src/cliConfig';
import { customProviderFor, promptBudgetForProvider } from '../src/shared/providers';
import { evaluateCodingTask, CODING_TASK_FIXTURES, type CodingTaskFixture, type CodingTaskResult } from '../src/evaluation/codingTaskBaseline';
import { FRONTIER_TASK_FIXTURES } from '../src/evaluation/codingTaskFrontierFixtures';
import { CodingAgent } from '../src/coding-agent/CodingAgent';
import { NodeToolAdapter } from '../src/adapter/node/NodeToolAdapter';
import { PromptAssembler, buildCliCapabilities } from '../src/shared/PromptAssembler';
import { setCustomPresentationCardsLoader } from '../src/coding-agent/ToolRegistry';
import { createLLMAdapter, isLightShapedTurn } from '../src/ui/chat';
import { turnShape } from '../src/coding-agent/turnRoute';
import type { BudgetConfig, EngineEvent, LLMAdapter, TokenUsage } from '../src/shared/types';

const argv = process.argv.slice(2);
const outFlag = argv.indexOf('--out');
const outPath = outFlag >= 0 ? argv[outFlag + 1] : undefined;
const onlyFlag = argv.indexOf('--only');
const only = onlyFlag >= 0 ? argv[onlyFlag + 1] : undefined;
const labelFlag = argv.indexOf('--label');
const label = labelFlag >= 0 ? argv[labelFlag + 1] : undefined;

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const VERSION = JSON.parse(await Bun.file(`${ROOT}/package.json`).text()).version as string;
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

/** 短句改写只去掉路径与验收命令里的文件名；任务本体的文件/验收不动。 */
const SHORT_PROMPTS: Record<string, string> = {
  'fix-take-top-off-by-one': '修复 takeTop 的边界错误（count=3 返回 3 项，count<=0 返回空数组），跑 bun test 直到全过。',
  'add-normalize-slug': '实现 normalizeSlug（去首尾空白、转小写、连续非字母数字压成一个连字符），补测试并跑 bun test 直到全过。',
  'hard-bugfix-task-queue-leak': '修复任务队列的两个问题（并发超上限、一个任务抛错后队列永久挂起），跑 bun test 直到全过，不改测试文件。',
  'frontier-selfverify-pricing-web': '修复开票计算的计价错误：按规则文档补齐所有边界与组合，跑 bun test 和验收脚本直到全过。',
  'frontier-contract-window-units': '修复限流器的单位换算：核心层和适配层都要符合契约，跑 bun test 和审计脚本直到全过。',
};

interface RunSummary {
  usage?: TokenUsage;
  toolCalls: number;
  turns?: number;
  completed: boolean;
  fatalError?: string;
  finalText: string;
}

interface ArmResult {
  taskId: string;
  shortPrompt: string;
  shape: ReturnType<typeof turnShape>;
  light: boolean;
  options: { disableThinking?: boolean; reasoningEffort?: 'low' | 'medium' | 'high' | 'off' };
  result: CodingTaskResult;
  run?: RunSummary;
}

async function runAgent(
  task: CodingTaskFixture,
  workspace: string,
  llm: LLMAdapter,
  model: string,
): Promise<RunSummary> {
  const sessionId = `ab-${task.id}-${Date.now().toString(36)}`;
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

  let finalText = '';
  let toolCalls = 0;
  let usage: TokenUsage | undefined;
  let turns: number | undefined;
  let completed = false;
  let fatalError: string | undefined;
  for await (const event of agent.run(assembly.systemPrompt, assembly.userPrompt ?? task.prompt) as AsyncGenerator<EngineEvent>) {
    if (event.type === 'TokenDelta' && !event.payload.isToolCall && event.payload.content) finalText += event.payload.content;
    if (event.type === 'ToolResult') toolCalls += 1;
    if (event.type === 'Error' && event.payload.recoverable === false) fatalError = `${event.payload.code}: ${event.payload.message}`;
    if (event.type === 'Interrupted') {
      turns = event.payload.turnCount;
      fatalError ??= `interrupted: ${event.payload.reason}`;
    }
    if (event.type === 'Completed') {
      completed = true;
      turns = event.payload.turnCount;
      usage = event.payload.usage;
      if (!event.payload.isComplete && !fatalError) fatalError = 'run ended without completing its turn';
    }
  }
  return { usage, toolCalls, turns, completed, fatalError, finalText: finalText.slice(0, 2_000) };
}

const baseConfig = loadConfig();
if (!baseConfig) throw new Error('no ~/.pure/config.json');
const custom = customProviderFor(baseConfig.customProviders, 'custom001');
if (!custom?.baseURL) throw new Error('custom001 without baseURL');
const apiKey = custom.apiKey || resolveOverrideSecretKey('custom001');
if (!apiKey) throw new Error('no key for custom001');
const model = baseConfig.model || custom.defaultModel;
// createLLMAdapter 的 custom 分支优先读条目自带的 apiKey；把密钥塞进内存副本，
// 不写盘、不打印。
const config = {
  ...baseConfig,
  customProviders: (baseConfig.customProviders ?? []).map((entry) =>
    entry.id === 'custom001' ? { ...entry, apiKey } : entry,
  ),
};

const onlyIds = only ? new Set(only.split(',')) : undefined;
const selected = [...CODING_TASK_FIXTURES, ...FRONTIER_TASK_FIXTURES].filter((task) => SHORT_PROMPTS[task.id] && (!onlyIds || onlyIds.has(task.id)));
if (selected.length === 0) throw new Error(`no fixture matched ${only ?? 'SHORT_PROMPTS'}`);

const results: ArmResult[] = [];
for (const fixture of selected) {
  const task: CodingTaskFixture = { ...fixture, prompt: SHORT_PROMPTS[fixture.id] };
  const shape = turnShape(task.prompt);
  const light = isLightShapedTurn(shape, undefined, false);
  const options = light
    ? { disableThinking: true, reasoningEffort: 'low' as const }
    : {};
  const llm = createLLMAdapter(config, options);
  const started = Date.now();
  let run: RunSummary | undefined;
  const result = await evaluateCodingTask(task, {
    agent: async ({ workspace }) => {
      run = await runAgent(task, workspace, llm, model);
      return { usage: run.usage, toolCalls: run.toolCalls, turns: run.turns };
    },
  });
  results.push({ taskId: task.id, shortPrompt: task.prompt, shape, light, options, result, run });
  const status = result.passAt1 ? 'PASS' : result.status.toUpperCase();
  console.log(`${status} ${task.id} light=${light} effort=${options.reasoningEffort ?? 'model-default'} ` +
    `turns=${run?.turns ?? '?'} tools=${run?.toolCalls ?? '?'} ${Date.now() - started}ms`);
  if (!result.passAt1) {
    console.log(`  verification: ${result.verification.map((v) => `${v.name}=${v.passed}`).join(' ') || '(none)'}`);
    if (run?.fatalError) console.log(`  fatal: ${run.fatalError.slice(0, 240)}`);
    if (run?.finalText) console.log(`  final: ${run.finalText.replace(/\s+/g, ' ').slice(0, 240)}`);
  }
}

const report = {
  version: VERSION,
  revision: REVISION,
  generatedAt: new Date().toISOString(),
  provider: 'custom001',
  model,
  label,
  tasks: results,
};
if (outPath) {
  await mkdir(dirname(resolve(outPath)), { recursive: true });
  await writeFile(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`report: ${resolve(outPath)}`);
}
