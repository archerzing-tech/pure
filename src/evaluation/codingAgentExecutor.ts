import { CodingAgent } from '../coding-agent/CodingAgent';
import { MockLLMAdapter } from '../adapter/mock/MockLLMAdapter';
import { NodeToolAdapter } from '../adapter/node/NodeToolAdapter';
import { DeepSeekAnthropicAdapter } from '../adapter/deepseek/DeepSeekAnthropicAdapter';
import {
  OpenAICompatibleAdapter,
  createDeepSeekAdapter,
  createGLMAdapter,
  createQwenAdapter,
} from '../adapter/openai/OpenAICompatibleAdapter';
import { PromptAssembler, buildCliCapabilities } from '../shared/PromptAssembler';
import { promptBudgetForProvider, type PromptBudgetConfig } from '../shared/providers';
import { PromptObservability } from '../shared/promptObservability';
import type { BudgetConfig, EngineEvent, IMemoryStore, LLMAdapter } from '../shared/types';
import type { CodingTaskAgentResult, CodingTaskFixture } from './codingTaskBaseline';

export interface CodingAgentEvaluationExecutorOptions {
  provider: string;
  model: string;
  apiKey?: string;
  qwenWorkspaceId?: string;
  baseURL?: string;
  temperature?: number;
  observability?: PromptObservability;
  promptBudget?: PromptBudgetConfig;
  budget?: BudgetConfig;
  /** E0.2 — when set, the run reads and writes this store at session start/end.
   *  Memory scoping keys on evalProjectKey(fixture id), not the workspace path:
   *  eval workspaces are fresh mkdtemp dirs every pass, so path-based scoping
   *  would make pass A's memories invisible to pass B and flatten any A/B
   *  comparison to zero. */
  memory?: IMemoryStore;
}

/**
 * E0.2 — fixture-stable memory scope. FSMemoryStore buckets entries by
 * projectPath; this fake scheme keeps both passes of a --compare pair in one
 * bucket per fixture while real file work still happens in the per-pass
 * mkdtemp workspace (tools never see this key).
 */
export function evalProjectKey(fixtureId: string): string {
  return `pure-eval://fixture/${fixtureId}`;
}

const EVAL_BUDGET: BudgetConfig = {
  maxTurns: 30,
  maxTotalTokens: 200_000,
  maxExecutionTime: 20 * 60 * 1000,
  warningThreshold: 0.8,
  graceTurns: 2,
  // Hard caps keep evaluations deterministic: the run stops at the ceiling
  // instead of running elastic/indefinitely.
  hardMaxTurns: 30,
  hardMaxTokens: 200_000,
  hardMaxTime: 20 * 60 * 1000,
};

function createAdapter(options: CodingAgentEvaluationExecutorOptions): LLMAdapter {
  switch (options.provider) {
    case 'mock':
      return new MockLLMAdapter();
    case 'deepseek-openai':
      return createDeepSeekAdapter(options.apiKey ?? '', options.model);
    case 'deepseek-anthropic':
      return new DeepSeekAnthropicAdapter({ apiKey: options.apiKey ?? '', model: options.model });
    case 'qwen':
      return createQwenAdapter(options.apiKey ?? '', options.qwenWorkspaceId ?? '', options.model);
    case 'glm':
      return createGLMAdapter(options.apiKey ?? '', options.model);
    default:
      if (!options.baseURL) throw new Error(`Unsupported evaluation provider without baseURL: ${options.provider}`);
      return new OpenAICompatibleAdapter({
        baseURL: options.baseURL,
        apiKey: options.apiKey ?? '',
        model: options.model,
        temperature: options.temperature,
      });
  }
}

/**
 * Drain an engine event stream into the fields the suite report keeps.
 *
 * A fatal LLM failure (bad model code, dead key, unreachable endpoint) does NOT
 * throw out of the engine: the failure policy retries, then emits `Interrupted`
 * and a trailing `Completed` with `interrupted: true` (the terminal
 * `Error { recoverable: false }` only appears when no policy is installed).
 * Scoring either shape as a plain `failed` task made an unreachable provider
 * look like a model that tried and failed: a whole suite could come back 0/N in
 * ~1s per task with zero tool calls and no cost, and nothing in the report said
 * why. `fatalError` carries the cause so the executor can raise instead.
 */
export async function collectAgentRunEvents(
  stream: AsyncIterable<EngineEvent>,
): Promise<{ usage?: CodingTaskAgentResult['usage']; toolCalls: number; turns?: number; completed: boolean; fatalError?: { code: string; message: string } }> {
  let usage: CodingTaskAgentResult['usage'];
  let toolCalls = 0;
  let turns: number | undefined;
  let completed = false;
  let interrupted: { code: string; message: string } | undefined;
  let fatalError: { code: string; message: string } | undefined;
  for await (const event of stream) {
    if (event.type === 'ToolResult') toolCalls++;
    if (event.type === 'Error' && event.payload.recoverable === false) {
      fatalError = { code: event.payload.code, message: event.payload.message };
    }
    if (event.type === 'Interrupted') {
      interrupted = { code: 'AGENT_INTERRUPTED', message: event.payload.reason };
      turns = event.payload.turnCount;
    }
    if (event.type === 'Completed') {
      completed = true;
      usage = event.payload.usage;
      turns = event.payload.turnCount;
      if (!event.payload.isComplete && !fatalError) {
        fatalError = interrupted ?? { code: 'AGENT_INTERRUPTED', message: 'run ended without completing its turn' };
      }
    }
  }
  return { usage, toolCalls, turns, completed, fatalError };
}

export async function runCodingAgentEvaluationTask(
  task: CodingTaskFixture,
  workspace: string,
  options: CodingAgentEvaluationExecutorOptions,
): Promise<CodingTaskAgentResult> {
  const sessionId = `eval-${task.id}-${Date.now().toString(36)}`;
  const observability = options.observability;
  const assembler = new PromptAssembler(observability);
  const tools = new NodeToolAdapter({ workspace, sessionId });
  const budget = options.promptBudget ?? promptBudgetForProvider(undefined, options.provider, options.model);
  const agent = new CodingAgent({
    sessionId,
    llm: createAdapter(options),
    toolAdapter: tools,
    budget: options.budget ?? EVAL_BUDGET,
    toolsDefs: undefined,
    promptAssembler: assembler,
    promptBudget: budget,
    observability,
    permissionMode: 'YOLO',
    projectPath: options.memory ? evalProjectKey(task.id) : workspace,
    memory: options.memory,
  });
  const assembly = assembler.assemble({
    surface: 'cli',
    capabilities: buildCliCapabilities(),
    toolDefinitions: agent.toolRegistry.getTools(),
    mode: 'build',
    budget,
    sessionId,
  }, task.prompt);

  const { usage, toolCalls, turns, completed, fatalError } = await collectAgentRunEvents(
    agent.run(assembly.systemPrompt, assembly.userPrompt ?? task.prompt),
  );
  if (fatalError) {
    // The interrupt reason rides on the error (not just the message) so the
    // suite report can name the cap that ended the run — `max_turns`,
    // `Budget exceeded`, an `llm_*` fault — instead of leaving report readers
    // to reverse-engineer it from the message length.
    const error = new Error(`model call failed (${fatalError.code}): ${fatalError.message}`) as Error & {
      code?: string;
      interruptReason?: string;
    };
    error.code = fatalError.code;
    error.interruptReason = fatalError.message;
    throw error;
  }
  if (!completed) throw new Error('CodingAgent evaluation run ended without a Completed event');
  return { usage, toolCalls, turns, traceId: assembly.traceId };
}
