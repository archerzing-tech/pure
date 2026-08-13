import { evaluateCodingTaskSuite, writeEvaluationReport } from '../src/evaluation/codingTaskBaseline';
import { runCodingAgentEvaluationTask } from '../src/evaluation/codingAgentExecutor';
import { PromptObservability } from '../src/shared/promptObservability';
import { FilePromptObservationStore } from '../src/shared/FilePromptObservationStore';
import { defaultModelFor } from '../src/shared/providers';

const argv = process.argv.slice(2);
const reportFlag = argv.indexOf('--report');
const reportPath = reportFlag >= 0 ? argv[reportFlag + 1] : undefined;
const keepWorkspaces = argv.includes('--keep-workspaces');
const strict = argv.includes('--strict');
const agentFlag = argv.indexOf('--agent');
const traceFlag = argv.indexOf('--trace');
const requestedAgent = agentFlag >= 0
  ? (argv[agentFlag + 1] && !argv[agentFlag + 1].startsWith('--') ? argv[agentFlag + 1] : process.env.PURE_EVAL_AGENT ?? 'deepseek-openai')
  : process.env.PURE_EVAL_AGENT;

if ((reportFlag >= 0 && (!reportPath || reportPath.startsWith('--'))) || (traceFlag >= 0 && (!tracePath || tracePath.startsWith('--')))) {
  console.error('Usage: bun run eval:baseline -- [--agent provider] [--report path] [--trace path] [--keep-workspaces] [--strict]');
  process.exit(2);
}

const tracePath = traceFlag >= 0
  ? argv[traceFlag + 1]
  : process.env.PURE_EVAL_TRACE;
const traceStore = tracePath ? new FilePromptObservationStore(tracePath) : undefined;

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

// The default fixture run is a control baseline and intentionally scores 0/3.
// Strict mode is for real agent runs/report consumers, where any failed task
// should be a non-zero process result.
if (strict && report.tasks.some((task) => task.status !== 'passed')) process.exitCode = 1;
