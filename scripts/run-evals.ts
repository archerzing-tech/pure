import { CODING_TASK_FIXTURES, evaluateCodingTask, evaluateCodingTaskSuite, writeEvaluationReport, type CodingTaskSuiteReport } from '../src/evaluation/codingTaskBaseline';
import { GOLDEN_SOLUTIONS } from '../src/evaluation/codingTaskGoldenSolutions';
import { runCodingAgentEvaluationTask } from '../src/evaluation/codingAgentExecutor';
import { FSMemoryStore } from '../src/adapter/memory/FSMemoryStore';
import { PromptObservability } from '../src/shared/promptObservability';
import { FilePromptObservationStore } from '../src/shared/FilePromptObservationStore';
import { defaultModelFor } from '../src/shared/providers';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const reportFlag = argv.indexOf('--report');
const reportPath = reportFlag >= 0 ? argv[reportFlag + 1] : undefined;
const keepWorkspaces = argv.includes('--keep-workspaces');
const strict = argv.includes('--strict');
const sanity = argv.includes('--sanity');
const notes = argv.includes('--notes');
const withMemory = argv.includes('--with-memory');
const compare = argv.includes('--compare');
const agentFlag = argv.indexOf('--agent');
const traceFlag = argv.indexOf('--trace');
const requestedAgent = agentFlag >= 0
  ? (argv[agentFlag + 1] && !argv[agentFlag + 1].startsWith('--') ? argv[agentFlag + 1] : process.env.PURE_EVAL_AGENT ?? 'deepseek-openai')
  : process.env.PURE_EVAL_AGENT;

// Declared before the usage check below, which reads it.
const tracePath = traceFlag >= 0
  ? argv[traceFlag + 1]
  : process.env.PURE_EVAL_TRACE;
const traceStore = tracePath ? new FilePromptObservationStore(tracePath) : undefined;

if ((reportFlag >= 0 && (!reportPath || reportPath.startsWith('--'))) || (traceFlag >= 0 && (!tracePath || tracePath.startsWith('--')))) {
  console.error('Usage: bun run eval:baseline -- [--agent provider] [--report path] [--trace path] [--sanity] [--notes] [--with-memory] [--compare] [--keep-workspaces] [--strict]');
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
const observability = new PromptObservability(
  { enabled: !!tracePath },
  traceStore,
);

// Fixture sanity gate (no agent, no provider keys): the control run must fail
// every fixture from its seed, and the recorded golden solution must pass
// every fixture. A violation means the fixture suite itself is broken — this
// is what CI gates on; the agent modes below are for provider baselines.
// --notes runs the same pass and emits the paste-ready CHANGELOG baseline
// section instead of per-fixture lines, refusing to emit anything when the
// gate is red.
if (sanity || notes) {
  let violations = 0;
  const control = await evaluateCodingTaskSuite();
  for (const task of control.tasks) {
    const failedAsSeeded = task.status === 'control' && task.verificationPassed === false;
    if (!failedAsSeeded) violations += 1;
    if (!notes) process.stdout.write(`control ${task.taskId}: ${failedAsSeeded ? 'failed as seeded' : `UNEXPECTED ${task.status}`}\n`);
  }
  let goldenPassed = 0;
  for (const task of CODING_TASK_FIXTURES) {
    const solve = GOLDEN_SOLUTIONS[task.id];
    const result = solve
      ? await evaluateCodingTask(task, {
          agent: async ({ workspace }) => {
            await solve(workspace);
          },
        })
      : undefined;
    const passed = result?.status === 'passed';
    if (passed) goldenPassed += 1;
    else violations += 1;
    if (!notes) process.stdout.write(`golden  ${task.id}: ${passed ? 'passed' : 'MISSING GOLDEN SOLUTION OR FAILED'}\n`);
  }
  if (notes) {
    if (violations > 0) {
      process.stdout.write(`eval sanity FAILED: ${violations} violation(s); refusing to emit release notes from a broken baseline\n`);
      process.exit(1);
    }
    process.stdout.write(`**评测基线**（${control.suiteVersion}，fixtureHash ${control.fixtureHash}）\n\n`);
    process.stdout.write(`- ${control.taskCount} 个 fixture：控制组全部按种子失败、金标准解全部通过（无 LLM 完整性自检，CI 门禁 \`eval:sanity\`）。\n`);
  } else {
    process.stdout.write(violations === 0
      ? `eval sanity ok: ${control.taskCount} fixtures fail from seed and solve clean\n`
      : `eval sanity FAILED: ${violations} violation(s)\n`);
  }
  if (violations > 0) process.exit(1);
  process.exit(0);
}

// E0.2 — cross-session memory for eval runs. `--with-memory` runs the suite
// once with an IMemoryStore wired in; `--compare` (a superset) runs every
// fixture twice against the SAME per-fixture store: pass A starts cold and
// seeds it via the normal session-end memory writes, pass B retrieves them.
// Stores key on the fixture id (see evalProjectKey) — not the workspace path,
// which is a fresh mkdtemp dir every pass and would flatten A/B to zero.
const memoryStores = withMemory || compare ? new Map<string, FSMemoryStore>() : undefined;
let memoryRoot: string | undefined;
const storeFor = async (fixtureId: string): Promise<FSMemoryStore> => {
  const existing = memoryStores!.get(fixtureId);
  if (existing) return existing;
  memoryRoot ??= await mkdtemp(join(resolve('/tmp'), 'pure-eval-memories-'));
  const store = new FSMemoryStore(join(memoryRoot, fixtureId));
  memoryStores!.set(fixtureId, store);
  return store;
};
if ((withMemory || compare) && !requestedAgent) {
  console.error('--with-memory/--compare need an agent run to remember with (add --agent <provider>).');
  process.exit(2);
}

let agent;
let model = process.env.PURE_EVAL_MODEL;
const numericEnv = (name: string): number | undefined => {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};
const evaluationPromptBudget = {
  contextWindowTokens: numericEnv('PURE_EVAL_CONTEXT_WINDOW_TOKENS'),
  outputReserveTokens: numericEnv('PURE_EVAL_OUTPUT_RESERVE_TOKENS'),
  safetyMarginTokens: numericEnv('PURE_EVAL_SAFETY_MARGIN_TOKENS'),
};
const hasEvaluationPromptBudget = Object.values(evaluationPromptBudget).some((value) => value !== undefined);
if (requestedAgent) {
  model ??= defaultModelFor(requestedAgent);
  if (requestedAgent !== 'mock' && !apiKeyForProvider(requestedAgent)) {
    console.error('A provider API key is required for --agent (set PURE_EVAL_API_KEY or the provider-specific key).');
    process.exit(2);
  }
  if (requestedAgent === 'qwen' && !process.env.PURE_EVAL_QWEN_WORKSPACE_ID && !process.env.DASHSCOPE_WORKSPACE_ID) {
    console.error('Qwen evaluation requires PURE_EVAL_QWEN_WORKSPACE_ID or DASHSCOPE_WORKSPACE_ID.');
    process.exit(2);
  }
  agent = async ({ task, workspace }: { task: import('../src/evaluation/codingTaskBaseline').CodingTaskFixture; workspace: string }) =>
    runCodingAgentEvaluationTask(task, workspace, {
      provider: requestedAgent,
      model: model!,
      apiKey: apiKeyForProvider(requestedAgent),
      qwenWorkspaceId: process.env.PURE_EVAL_QWEN_WORKSPACE_ID ?? process.env.DASHSCOPE_WORKSPACE_ID,
      baseURL: process.env.PURE_EVAL_BASE_URL,
      observability,
      ...(memoryStores ? { memory: await storeFor(task.id) } : {}),
      ...(hasEvaluationPromptBudget ? { promptBudget: { provider: requestedAgent, model: model!, ...evaluationPromptBudget } } : {}),
    });
}

const suiteMetadata = {
  provider: requestedAgent,
  model,
  promptVersion: process.env.PURE_EVAL_PROMPT_VERSION ?? (requestedAgent ? 'dynamic' : undefined),
  gitRevision: process.env.GIT_COMMIT ?? process.env.GITHUB_SHA,
  seed: process.env.PURE_EVAL_SEED,
};

// ── E0.2 compare table ──

interface MemoryCompareRow {
  taskId: string;
  cold: { status: string; toolCalls: number; durationMs: number; promptTokens?: number; cacheHitTokens?: number };
  warm: { status: string; toolCalls: number; durationMs: number; promptTokens?: number; cacheHitTokens?: number };
  delta: { toolCalls: number; durationMs: number; promptTokens: number; cacheHitTokens: number };
  changed: boolean;
}

function compareSide(result: CodingTaskSuiteReport['tasks'][number]) {
  return {
    status: result.status,
    toolCalls: result.agent?.toolCalls ?? 0,
    durationMs: result.durationMs,
    promptTokens: result.agent?.usage?.promptTokens,
    cacheHitTokens: result.agent?.usage?.cacheHitTokens,
  };
}

function memoryCompareRows(cold: CodingTaskSuiteReport, warm: CodingTaskSuiteReport): MemoryCompareRow[] {
  return cold.tasks.map((coldTask) => {
    const warmTask = warm.tasks.find((task) => task.taskId === coldTask.taskId);
    const c = compareSide(coldTask);
    const w = warmTask ? compareSide(warmTask) : { status: 'missing', toolCalls: 0, durationMs: 0 };
    const num = (value: number | undefined) => value ?? 0;
    return {
      taskId: coldTask.taskId,
      cold: c,
      warm: w,
      delta: {
        toolCalls: w.toolCalls - c.toolCalls,
        durationMs: w.durationMs - c.durationMs,
        promptTokens: num(w.promptTokens) - num(c.promptTokens),
        cacheHitTokens: num(w.cacheHitTokens) - num(c.cacheHitTokens),
      },
      changed: c.status !== w.status || w.toolCalls !== c.toolCalls || w.promptTokens !== c.promptTokens,
    };
  });
}

function printMemoryComparison(cold: CodingTaskSuiteReport, warm: CodingTaskSuiteReport): void {
  const rows = memoryCompareRows(cold, warm);
  process.stdout.write('\nE0.2 memory compare (same fixtures, pass A cold → seeds store, pass B warm → retrieves):\n');
  process.stdout.write('fixture                        cold              warm              Δtools  Δprompt   ΔcacheHit\n');
  for (const row of rows) {
    const pad = (value: string, width: number) => value.padEnd(width);
    process.stdout.write(
      `${pad(row.taskId, 30)}${pad(`${row.cold.status}/${row.cold.toolCalls}t`, 17)}${pad(`${row.warm.status}/${row.warm.toolCalls}t`, 17)}${pad(String(row.delta.toolCalls), 7)}${pad(String(row.delta.promptTokens), 9)}${String(row.delta.cacheHitTokens)}\n`,
    );
  }
  const changed = rows.filter((row) => row.changed).length;
  process.stdout.write(`compare: ${changed}/${rows.length} fixtures show a nonzero A/B delta`);
  if (changed === 0) {
    process.stdout.write(' — memory injection produced no measurable difference (expected for --agent mock; suspicious for a real provider)');
  }
  process.stdout.write('\n');
}

try {
  if (compare) {
    const suiteOptions = (memoryPhase: string) => ({
      keepWorkspace: keepWorkspaces,
      agent,
      metadata: { ...suiteMetadata, memoryPhase },
    });
    const cold = await evaluateCodingTaskSuite(undefined, suiteOptions('cold-seed'));
    const warm = await evaluateCodingTaskSuite(undefined, suiteOptions('warm-reuse'));
    printMemoryComparison(cold, warm);
    if (reportPath) {
      const compareReport = { mode: 'memory-compare', generatedAt: new Date().toISOString(), cold, warm, fixtures: memoryCompareRows(cold, warm) };
      await writeFile(reportPath, `${JSON.stringify(compareReport, null, 2)}\n`, 'utf-8');
      process.stdout.write(`Wrote ${reportPath}\n`);
    }
    // Strict gates on the warm pass: it is the memory-enabled run whose
    // quality --compare exists to inspect.
    if (strict && warm.tasks.some((task) => task.status !== 'passed')) process.exitCode = 1;
  } else {
    const report = await evaluateCodingTaskSuite(undefined, {
      keepWorkspace: keepWorkspaces,
      agent,
      metadata: {
        ...suiteMetadata,
        ...(memoryStores ? { memoryPhase: 'single' } : {}),
      },
    });
    // An agent_error means the provider never produced a usable answer (unknown
    // model code, dead key, unreachable endpoint). Such a run is not a baseline:
    // every task would read as failed for a reason the report can't show.
    const agentErrors = report.tasks.filter((task) => task.status === 'agent_error').length;
    if (agentErrors > 0) {
      process.stderr.write(`\n!! ${agentErrors}/${report.taskCount} tasks ended in agent_error — the provider was not reachable. This run is NOT a baseline.\n`);
      if (agentErrors === report.taskCount) {
        process.stderr.write('!! refusing to write a report where every task failed to reach the model\n');
        process.exit(2);
      }
    }
    if (reportPath) {
      await writeEvaluationReport(reportPath, report);
      process.stdout.write(`Wrote ${reportPath}\n`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    // The default fixture run is a control baseline and intentionally scores 0 on
    // every fixture (see the fixture-sanity test in codingTaskBaseline.test.ts).
    // Strict mode is for real agent runs/report consumers, where any failed task
    // should be a non-zero process result.
    if (strict && report.tasks.some((task) => task.status !== 'passed')) process.exitCode = 1;
  }
} finally {
  if (memoryRoot && !keepWorkspaces) {
    await rm(memoryRoot, { recursive: true, force: true }).catch(() => {});
  }
}
