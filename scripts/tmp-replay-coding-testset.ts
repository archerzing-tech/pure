// 编码 Agent 测试集回放：~/Documents/编码 Agent 测试集（简单 + 复杂）.md
//
// 与前两轮（TC-01..09 对话姿态、T01..T30 插话协议）同一套路，但这次被测量的是
// pure 的**编码循环**，所以直接复用仓库自己的评测骨架：
//   evaluateCodingTask（种文件 + 跑验收 + 判 pass/fail，只认验收命令，不认模型自述）
//   CodingAgent + NodeToolAdapter + PromptAssembler（真提示词、真工具、真权限）
//   collectAgentRunEvents（引擎事件流 → usage / toolCalls / turns / fatal）
// provider 取本机 ~/.pure 配置（glm + providerOverrides.glm.baseURL），与应用一致。
//
// 本脚本额外做三件骨架不做的事：
//   1) tap 引擎事件流，留下工具调用序列与最终回答（反例检测 + 人类表达评分的原料）；
//   2) 在 workspace 之外生成隐藏边界检查（测试集的「陷阱」），跑完独立复核；
//   3) 记录运行后的文件清单 delta、源码反例扫描、轨迹顺序审计、验收口径文件哈希。
//
// 用法：
//   bun scripts/tmp-replay-coding-testset.ts --sanity          # 无 provider：控制组必失败 + 金标准解必过
//   bun scripts/tmp-replay-coding-testset.ts --section S       # 真 provider 跑 S 段
//   bun scripts/tmp-replay-coding-testset.ts --only S01,S03    # 跑指定用例
//   bun scripts/tmp-replay-coding-testset.ts --model glm-5.3 --out tmp/coding-testset-results.json

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { DeepSeekAnthropicAdapter } from '../src/adapter/deepseek/DeepSeekAnthropicAdapter';
import { NodeToolAdapter } from '../src/adapter/node/NodeToolAdapter';
import { CodingAgent } from '../src/coding-agent/CodingAgent';
import { collectAgentRunEvents } from '../src/evaluation/codingAgentExecutor';
import { evaluateCodingTask, type CodingTaskAgentResult, type CodingTaskFixture } from '../src/evaluation/codingTaskBaseline';
import { PromptAssembler, buildCliCapabilities } from '../src/shared/PromptAssembler';
import { promptBudgetForProvider } from '../src/shared/providers';
import type { BudgetConfig, EngineEvent } from '../src/shared/types';
import { TEST_SET_TASKS_SM, type TestSetFixture } from './tmp-coding-testset-tasks';
import { TEST_SET_TASKS_L } from './tmp-coding-testset-tasks-l';

const ROOT = process.cwd();
const SCRATCH = join(ROOT, 'tmp', 'coding-testset');
const SHIM_DIR = join(SCRATCH, 'bin');
const CHECKS_DIR = join(SCRATCH, 'checks');
const WORKSPACE_DIR = join(SCRATCH, 'workdirs');
const VENV_DIR = join(SCRATCH, '.venv');
const VENV_PYTHON = join(VENV_DIR, 'bin', 'python');

const TASKS: TestSetFixture[] = [...TEST_SET_TASKS_SM, ...TEST_SET_TASKS_L];

// ── 参数 ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
};
const sanity = argv.includes('--sanity');
const keepWorkspaces = argv.includes('--keep-workspaces');
const section = flagValue('--section')?.toUpperCase();
const only = flagValue('--only')?.split(',').map((value) => value.trim().toUpperCase());
const outPath = flagValue('--out') ?? join(ROOT, 'tmp', 'coding-testset-results.json');
const modelArg = flagValue('--model');
const baseUrlArg = flagValue('--base-url');

let selected = TASKS;
if (section) selected = selected.filter((task) => task.section === section);
if (only && only.length > 0) selected = selected.filter((task) => only.includes(task.id));
if (selected.length === 0) {
  console.error('no fixtures selected');
  process.exit(2);
}

// ── 隔离的 Python 环境（PATH shim）──────────────────────────────────────────
//
// 验收命令与 agent 的 execute_command 都继承本进程环境，所以 shim 目录前置进
// PATH 就同时覆盖「谁在跑」。绝不碰系统/共享 venv：
//   python/python3/pytest/uvicorn → tmp/coding-testset/.venv
//   pip/pip3                      → 用 uv 装进同一个 .venv（不污染用户其它环境）

// Bun.spawn 在进程启动时就缓存了 PATH 的命令映射，运行时改 process.env.PATH 对
// 裸命令无效（会直接 ENOENT）。所以：① 验收命令一律走绝对路径；② 为了让
// agent 自己的 execute_command 也能拿到 pytest/uvicorn，runner 会在 PATH 缺失
// shim 目录时用带 shim 的 PATH 重启自己。
function ensureShimOnPath(): void {
  const current = process.env.PATH ?? '';
  if (current.split(':').includes(SHIM_DIR)) return;
  const proc = Bun.spawnSync([process.execPath, ...process.argv.slice(1)], {
    env: { ...(process.env as Record<string, string>), PATH: `${SHIM_DIR}:${current}` },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(proc.exitCode ?? 1);
}

function resolveCommand(command: string): string[] {
  switch (command) {
    case 'pytest':
      return [VENV_PYTHON, '-m', 'pytest'];
    case 'python':
    case 'python3':
      return [VENV_PYTHON];
    case 'uvicorn':
      return [join(VENV_DIR, 'bin', 'uvicorn')];
    case 'bun':
      return [process.execPath];
    default:
      return [command];
  }
}

function installShims(): void {
  if (!existsSync(VENV_PYTHON)) {
    console.error(`缺少隔离 Python 环境：${VENV_PYTHON}\n先跑：uv venv tmp/coding-testset/.venv && uv pip install --python ${VENV_PYTHON} pytest pytest-cov fastapi uvicorn httpx flask respx requests`);
    process.exit(2);
  }
  mkdirSync(SHIM_DIR, { recursive: true });
  const shims: Record<string, string> = {
    python: `exec "${VENV_PYTHON}" "$@"\n`,
    python3: `exec "${VENV_PYTHON}" "$@"\n`,
    pytest: `exec "${VENV_PYTHON}" -m pytest "$@"\n`,
    uvicorn: `exec "${join(VENV_DIR, 'bin', 'uvicorn')}" "$@"\n`,
    pip: `exec "${join(homedir(), '.local', 'bin', 'uv')}" pip install --python "${VENV_PYTHON}" "$@"\n`,
    pip3: `exec "${join(homedir(), '.local', 'bin', 'uv')}" pip install --python "${VENV_PYTHON}" "$@"\n`,
  };
  for (const [name, body] of Object.entries(shims)) {
    writeFileSync(join(SHIM_DIR, name), `#!/bin/sh\n${body}`, { encoding: 'utf8', mode: 0o755 });
  }
  process.env.PATH = `${SHIM_DIR}:${process.env.PATH ?? ''}`;
}

// ── provider：与应用同一解析顺序（override secret → 共享 secret）───────────

interface ProviderConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

function resolveProvider(): ProviderConfig {
  let config: {
    apiKey?: string;
    providerOverrides?: Record<string, { apiKey?: string; baseURL?: string }>;
  } = {};
  try {
    config = JSON.parse(readFileSync(join(homedir(), '.pure', 'config.json'), 'utf8'));
  } catch {
    // 没有配置文件就走 secrets / 环境变量。
  }
  let secrets: Record<string, string> = {};
  try {
    secrets = JSON.parse(readFileSync(join(homedir(), '.pure', 'secrets.json'), 'utf8'));
  } catch {
    // 忽略：下面还有兜底。
  }
  const apiKey =
    process.env.PURE_EVAL_API_KEY ??
    config.providerOverrides?.glm?.apiKey ??
    secrets['llm.apiKey.glm'] ??
    config.apiKey;
  if (!apiKey) {
    console.error('找不到 GLM API key（~/.pure/config.json 或 secrets.json），也未见 PURE_EVAL_API_KEY。');
    process.exit(2);
  }
  return {
    apiKey,
    baseURL: baseUrlArg ?? config.providerOverrides?.glm?.baseURL ?? 'https://open.bigmodel.cn/api/anthropic',
    model: modelArg ?? process.env.PURE_EVAL_MODEL ?? 'glm-5.3-flash',
  };
}

// ── 事件流 tap：工具序列 + 最终回答 ─────────────────────────────────────────

interface RecordedRun {
  toolNames: string[];
  toolArgs: string[];
  finalOutput: string;
  assistantText: string;
  errors: string[];
}

const recorded = new Map<string, RecordedRun>();

async function* tap(stream: AsyncIterable<EngineEvent>, sink: (event: EngineEvent) => void): AsyncIterable<EngineEvent> {
  for await (const event of stream) {
    sink(event);
    yield event;
  }
}

function budgetFor(task: TestSetFixture): BudgetConfig {
  const maxTurns = task.budget?.maxTurns ?? 30;
  const maxTotalTokens = 400_000;
  const maxExecutionTime = 25 * 60 * 1000;
  return {
    maxTurns,
    maxTotalTokens,
    maxExecutionTime,
    warningThreshold: 0.8,
    graceTurns: 2,
    hardMaxTurns: maxTurns,
    hardMaxTokens: maxTotalTokens,
    hardMaxTime: maxExecutionTime,
  };
}

function createAgentCallback(provider: ProviderConfig) {
  return async ({ task, workspace }: { task: CodingTaskFixture; workspace: string }): Promise<CodingTaskAgentResult> => {
    const fixture = selected.find((item) => item.id === task.id)!;
    const sessionId = `testset-${task.id}-${Date.now().toString(36)}`;
    const assembler = new PromptAssembler();
    const tools = new NodeToolAdapter({ workspace, sessionId });
    const budget = budgetFor(fixture);
    const llm = new DeepSeekAnthropicAdapter({
      apiKey: provider.apiKey,
      model: provider.model,
      baseURL: provider.baseURL,
      maxTokens: 32768,
    });
    const agent = new CodingAgent({
      sessionId,
      llm,
      toolAdapter: tools,
      budget,
      toolsDefs: undefined,
      promptAssembler: assembler,
      promptBudget: promptBudgetForProvider(undefined, 'glm', provider.model),
      permissionMode: 'YOLO',
      projectPath: workspace,
    });
    const assembly = assembler.assemble(
      {
        surface: 'cli',
        capabilities: buildCliCapabilities(),
        toolDefinitions: agent.toolRegistry.getTools(),
        mode: 'build',
        budget,
        sessionId,
      },
      task.prompt,
    );

    const run: RecordedRun = { toolNames: [], toolArgs: [], finalOutput: '', assistantText: '', errors: [] };
    recorded.set(task.id, run);
    const events = tap(agent.run(assembly.systemPrompt, assembly.userPrompt ?? task.prompt), (event) => {
      if (event.type === 'ToolStarted') {
        run.toolNames.push(event.payload.toolName);
        run.toolArgs.push(event.payload.toolCallArgs ?? '');
      }
      if (event.type === 'TokenDelta' && !event.payload.isToolCall) {
        run.assistantText += event.payload.content;
      }
      if (event.type === 'Completed') {
        run.finalOutput = event.payload.finalOutput ?? run.assistantText;
      }
      if (event.type === 'Error' && event.payload.recoverable === false) {
        run.errors.push(event.payload.code ?? 'error');
      }
    });
    const { usage, toolCalls, turns, fatalError } = await collectAgentRunEvents(events);
    if (fatalError) {
      const error = new Error(`model call failed (${fatalError.code})`) as Error & { code?: string; interruptReason?: string };
      error.code = fatalError.code;
      error.interruptReason = fatalError.message;
      throw error;
    }
    return { usage, toolCalls, turns, traceId: assembly.traceId };
  };
}

// ── 审计：workspace 外的隐藏边界检查 + 源码/清单/回答/轨迹复核 ──────────────

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

function listFiles(root: string): string[] {
  const skip = new Set(['__pycache__', '.pytest_cache', '.ruff_cache', '.venv', 'node_modules', '.git']);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.endsWith('.pyc')) found.push(relative(root, full));
    }
  };
  walk(root);
  return found.sort();
}

async function runCommand(command: string, args: string[], cwd: string, timeoutMs = 180_000) {
  const proc = Bun.spawn([command, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode, output: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim() };
}

async function runBoundaryChecks(task: TestSetFixture, workspace: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of task.boundaryChecks ?? []) {
    // 边界脚本 import 的是 workspace 里的项目模块（roman/src/emails…），所以
    // 必须以 cwd 方式跑：直接 `python checks/x.py` 会让 sys.path[0] 指向
    // checks/ 目录，import 永远 ModuleNotFoundError（与实现无关的假阳性）。
    const args = check.args ?? ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(CHECKS_DIR)}); exec(open(${JSON.stringify(`${CHECKS_DIR}/${check.file}`)}, encoding='utf-8').read())`];
    const { exitCode, output } = await runCommand(VENV_PYTHON, args, workspace);
    results.push({ name: check.name, passed: exitCode === 0, detail: output.split('\n').slice(-3).join(' | ') });
  }
  return results;
}

async function auditRun(
  task: TestSetFixture,
  workspace: string,
  run: RecordedRun | undefined,
  snapshot: { files: string[]; seedFiles: string[] },
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 清单审计：反例「建了 Docker/CI/多模块」这类
  for (const audit of task.inventoryAudits ?? []) {
    const offenders = audit.mustBeAbsent.filter((pattern) =>
      snapshot.files.some((file) => file.includes(pattern)),
    );
    results.push({
      name: audit.label,
      passed: offenders.length === 0,
      detail: offenders.length > 0 ? `出现了 ${offenders.join(', ')}` : `清单干净（新增 ${snapshot.files.length - snapshot.seedFiles.length} 个文件）`,
    });
  }

  // 源码反例扫描
  for (const audit of task.sourceAudits ?? []) {
    const path = join(workspace, audit.file);
    if (!existsSync(path)) {
      results.push({ name: audit.label, passed: false, detail: `${audit.file} 不存在` });
      continue;
    }
    const source = readFileSync(path, 'utf8');
    let passed = true;
    let detail = 'ok';
    if (audit.mustMatch && !new RegExp(audit.mustMatch, 'i').test(source)) {
      passed = false;
      detail = `缺少期望的 ${audit.mustMatch}`;
    }
    if (audit.mustNotMatch && new RegExp(audit.mustNotMatch, 'i').test(source)) {
      passed = false;
      detail = `命中反例 ${audit.mustNotMatch}`;
    }
    results.push({ name: audit.label, passed, detail });
  }

  // 验收口径文件不许变
  if (task.unchangedFiles && task.unchangedFiles.length > 0) {
    const changed: string[] = [];
    for (const file of task.unchangedFiles) {
      const seed = task.files[file];
      const path = join(workspace, file);
      if (seed === undefined) continue;
      if (!existsSync(path)) changed.push(`${file} 被删除`);
      else if (readFileSync(path, 'utf8') !== seed) changed.push(`${file} 被改写`);
    }
    results.push({
      name: '验收口径文件未被改动',
      passed: changed.length === 0,
      detail: changed.length > 0 ? changed.join('; ') : `未变（${task.unchangedFiles.length} 个）`,
    });
  }

  // 回答审计（测试集的人工评审项，机器只查关键词，真正打分在报告里人工过）
  for (const audit of task.answerAudits ?? []) {
    const text = `${run?.finalOutput ?? ''}\n${run?.assistantText ?? ''}`;
    results.push({
      name: audit.label,
      passed: new RegExp(audit.pattern, 'i').test(text),
      detail: text.length === 0 ? '没有可读的最终回答' : `回答 ${text.length} 字`,
    });
  }

  // 轨迹顺序审计：先分析（EXPLAIN）再加缓存
  if (task.orderAudit) {
    const args = (run?.toolArgs ?? []).join('\n');
    const first = new RegExp(task.orderAudit.firstPattern, 'i');
    const then = new RegExp(task.orderAudit.thenPattern, 'i');
    const firstIndex = first.exec(args)?.index ?? -1;
    const thenIndex = then.exec(args)?.index ?? -1;
    let passed = true;
    let detail = 'ok';
    if (thenIndex >= 0 && firstIndex < 0) {
      passed = false;
      detail = '引入缓存但全程没有 EXPLAIN/执行计划证据';
    } else if (thenIndex >= 0 && firstIndex > thenIndex) {
      passed = false;
      detail = '先写缓存后才做执行计划分析';
    } else if (thenIndex < 0) {
      detail = '未引入缓存（不需要顺序证据）';
    } else {
      detail = 'EXPLAIN 早于缓存写入';
    }
    results.push({ name: task.orderAudit.label, passed, detail });
  }

  return results;
}

// ── fixture 组装 ─────────────────────────────────────────────────────────────

function toCodingFixture(task: TestSetFixture): CodingTaskFixture {
  const checksDir = CHECKS_DIR;
  return {
    id: task.id,
    category: task.category,
    difficulty: task.difficulty,
    prompt: task.prompt,
    files: task.files,
    verification: task.verification.map((command) => {
      const [executable, ...prefix] = resolveCommand(command.command);
      return {
        name: command.name,
        command: executable!,
        args: [...prefix, ...command.args.map((arg) => arg.replace('{{checks}}', checksDir))],
        ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
      };
    }),
  };
}

function writeCheckFiles(): void {
  mkdirSync(CHECKS_DIR, { recursive: true });
  for (const task of selected) {
    for (const check of [...(task.verificationScripts ?? []), ...(task.boundaryChecks ?? [])]) {
      writeFileSync(join(CHECKS_DIR, check.file), check.content, 'utf8');
    }
  }
}

interface TaskRecord {
  id: string;
  section: string;
  title: string;
  prompt: string;
  alignment: string[];
  adaptation?: string;
  status: string;
  verificationPassed: boolean;
  score: number;
  durationMs: number;
  agent?: { toolCalls?: number; turns?: number; usage?: unknown };
  agentError?: unknown;
  verification: unknown[];
  toolNames: string[];
  finalOutputChars: number;
  finalOutput: string;
  addedFiles: string[];
  removedFiles: string[];
  modifiedFiles: string[];
  boundary: CheckResult[];
  audits: CheckResult[];
  workspace?: string;
  fatal?: string;
}

async function runOne(task: TestSetFixture, agent?: ReturnType<typeof createAgentCallback>): Promise<TaskRecord> {
  const fixture = toCodingFixture(task);
  const workspaceBase = join(WORKSPACE_DIR, task.id);
  mkdirSync(workspaceBase, { recursive: true });

  const started = Date.now();
  const result = await evaluateCodingTask(fixture, {
    workspace: workspaceBase,
    keepWorkspace: true,
    ...(agent ? { agent } : {}),
  });
  const run = recorded.get(task.id);
  const workspace = result.workspace ?? workspaceBase;

  const files = listFiles(workspace);
  const seedFiles = Object.keys(task.files);
  const seedSet = new Set(seedFiles);
  const added = files.filter((file) => !seedSet.has(file));
  const removed = seedFiles.filter((file) => !files.includes(file));
  const modified = seedFiles.filter(
    (file) => files.includes(file) && readFileSync(join(workspace, file), 'utf8') !== task.files[file],
  );

  const boundary = await runBoundaryChecks(task, workspace);
  const audits = await auditRun(task, workspace, run, { files, seedFiles });

  const record: TaskRecord = {
    id: task.id,
    section: task.section,
    title: task.title,
    prompt: task.prompt,
    alignment: task.alignment,
    ...(task.adaptation ? { adaptation: task.adaptation } : {}),
    status: result.status,
    verificationPassed: result.verificationPassed,
    score: result.score,
    durationMs: Date.now() - started,
    ...(result.agent ? { agent: result.agent } : {}),
    ...(result.agentError ? { agentError: result.agentError } : {}),
    verification: result.verification,
    toolNames: run?.toolNames ?? [],
    finalOutputChars: (run?.finalOutput ?? '').length,
    finalOutput: (run?.finalOutput ?? '').slice(0, 4000),
    addedFiles: added,
    removedFiles: removed,
    modifiedFiles: modified,
    boundary,
    audits,
    ...(keepWorkspaces ? { workspace } : {}),
  };

  if (!keepWorkspaces) rmSync(workspace, { recursive: true, force: true });
  return record;
}

function printRecord(record: TaskRecord): void {
  const boundary = record.boundary.length === 0
    ? ''
    : ` | 边界 ${record.boundary.filter((check) => check.passed).length}/${record.boundary.length}`;
  const audits = record.audits.length === 0
    ? ''
    : ` | 审计 ${record.audits.filter((check) => check.passed).length}/${record.audits.length}`;
  console.log(
    `${record.id.padEnd(4)}${record.status.padEnd(12)}${String(record.durationMs / 1000).padStart(7)}s` +
      ` | tools ${String(record.agent?.toolCalls ?? 0).padStart(3)} turns ${String(record.agent?.turns ?? 0).padStart(3)}` +
      ` | 新增 ${String(record.addedFiles.length).padStart(2)}${boundary}${audits}`,
  );
  for (const check of [...record.boundary, ...record.audits]) {
    if (!check.passed) console.log(`      ✗ ${check.name}: ${check.detail}`);
  }
  if (record.fatal) console.log(`      !! ${record.fatal}`);
}

// ── sanity：控制组必失败 + 金标准解必过 ─────────────────────────────────────

async function runSanity(): Promise<void> {
  let violations = 0;
  for (const task of selected) {
    const fixture = toCodingFixture(task);
    const base = join(WORKSPACE_DIR, `sanity-${task.id}`);
    mkdirSync(base, { recursive: true });

    const control = await evaluateCodingTask(fixture, { workspace: base, keepWorkspace: false });
    const controlFailedAsSeeded = control.status === 'control' && control.verificationPassed === false;
    if (!controlFailedAsSeeded) violations += 1;
    console.log(`control ${task.id}: ${controlFailedAsSeeded ? 'fails from seed' : `UNEXPECTED ${control.status}`}`);

    const golden = await evaluateCodingTask(fixture, {
      workspace: base,
      keepWorkspace: false,
      agent: async ({ workspace }) => {
        for (const [file, content] of Object.entries(task.golden)) {
          const target = join(workspace, file);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content, 'utf8');
        }
      },
    });
    const goldenPassed = golden.status === 'passed';
    if (!goldenPassed) violations += 1;
    const failed = golden.verification.filter((item) => !item.passed).map((item) => item.name);
    console.log(
      `golden  ${task.id}: ${goldenPassed ? 'passes' : `FAILS (${failed.join(', ') || golden.status})`}`,
    );
  }
  console.log(violations === 0 ? 'sanity ok' : `sanity FAILED: ${violations} violation(s)`);
  process.exit(violations === 0 ? 0 : 1);
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

installShims();
ensureShimOnPath();
writeCheckFiles();

if (sanity) {
  await runSanity();
} else {
  const provider = resolveProvider();
  console.log(
    `provider=glm model=${provider.model} baseURL=${provider.baseURL} fixtures=${selected.map((task) => task.id).join(',')}`,
  );

  const agent = createAgentCallback(provider);
  const records: TaskRecord[] = [];
  for (const task of selected) {
    let record: TaskRecord;
    try {
      record = await runOne(task, agent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record = {
        id: task.id,
        section: task.section,
        title: task.title,
        prompt: task.prompt,
        alignment: task.alignment,
        status: 'harness_error',
        verificationPassed: false,
        score: 0,
        durationMs: 0,
        verification: [],
        toolNames: [],
        finalOutputChars: 0,
        finalOutput: '',
        addedFiles: [],
        removedFiles: [],
        modifiedFiles: [],
        boundary: [],
        audits: [],
        fatal: message,
      };
    }
    records.push(record);
    printRecord(record);
    mkdirSync(join(ROOT, 'tmp'), { recursive: true });
    writeFileSync(
      outPath,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), provider: { model: provider.model, baseURL: provider.baseURL }, records }, null, 2)}\n`,
      'utf8',
    );
  }

  const passed = records.filter((record) => record.status === 'passed').length;
  console.log(`\n自动验收：${passed}/${records.length} 通过（结果写入 ${relative(ROOT, outPath)}）`);
}
