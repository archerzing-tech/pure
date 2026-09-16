import { CODING_TASK_FIXTURES, evaluateCodingTask, evaluateCodingTaskSuite, writeEvaluationReport } from '../src/evaluation/codingTaskBaseline';
import { GOLDEN_SOLUTIONS } from '../src/evaluation/codingTaskGoldenSolutions';
import { runCodingAgentEvaluationTask } from '../src/evaluation/codingAgentExecutor';
import { PromptObservability } from '../src/shared/promptObservability';
import { FilePromptObservationStore } from '../src/shared/FilePromptObservationStore';
import { defaultModelFor } from '../src/shared/providers';

const argv = process.argv.slice(2);
const reportFlag = argv.indexOf('--report');
const reportPath = reportFlag >= 0 ? argv[reportFlag + 1] : undefined;
const keepWorkspaces = argv.includes('--keep-workspaces');
const strict = argv.includes('--strict');
const sanity = argv.includes('--sanity');
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
  console.error('Usage: bun run eval:baseline -- [--agent provider] [--report path] [--trace path] [--sanity] [--keep-workspaces] [--strict]');
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
if (sanity) {
  let violations = 0;
  const control = await evaluateCodingTaskSuite();
  for (const task of control.tasks) {
    const failedAsSeeded = task.status === 'control' && task.verificationPassed === false;
    if (!failedAsSeeded) violations += 1;
    process.stdout.write(`control ${task.taskId}: ${failedAsSeeded ? 'failed as seeded' : `UNEXPECTED ${task.status}`}\n`);
  }
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
    if (!passed) violations += 1;
    process.stdout.write(`golden  ${task.id}: ${passed ? 'passed' : 'MISSING GOLDEN SOLUTION OR FAILED'}\n`);
  }
  process.stdout.write(violations === 0
    ? `eval sanity ok: ${control.taskCount} fixtures fail from seed and solve clean\n`
    : `eval sanity FAILED: ${violations} violation(s)\n`);
  if (violations > 0) process.exit(1);
  process.exit(0);
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
  agent = ({ task, workspace }: { task: import('../src/evaluation/codingTaskBaseline').CodingTaskFixture; workspace: string }) =>
    runCodingAgentEvaluationTask(task, workspace, {
      provider: requestedAgent,
      model: model!,
      apiKey: apiKeyForProvider(requestedAgent),
      qwenWorkspaceId: process.env.PURE_EVAL_QWEN_WORKSPACE_ID ?? process.env.DASHSCOPE_WORKSPACE_ID,
      baseURL: process.env.PURE_EVAL_BASE_URL,
      observability,
      ...(hasEvaluationPromptBudget ? { promptBudget: { provider: requestedAgent, model: model!, ...evaluationPromptBudget } } : {}),
    });
}

const report = await evaluateCodingTaskSuite(undefined, {
  keepWorkspace: keepWorkspaces,
  agent,
  metadata: {
    provider: requestedAgent,
    model,
    promptVersion: process.env.PURE_EVAL_PROMPT_VERSION ?? (requestedAgent ? 'dynamic' : undefined),
    gitRevision: process.env.GIT_COMMIT ?? process.env.GITHUB_SHA,
    seed: process.env.PURE_EVAL_SEED,
  },
});
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
