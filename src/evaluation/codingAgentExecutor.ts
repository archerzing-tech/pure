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
import type { BudgetConfig, EngineEvent, LLMAdapter } from '../shared/types';
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
}

const EVAL_BUDGET: BudgetConfig = {
  maxTurns: 30,
  maxTotalTokens: 200_000,
  maxExecutionTime: 20 * 60 * 1000,
  warningThreshold: 0.8,
  graceTurns: 2,
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

  let usage: CodingTaskAgentResult['usage'];
  let toolCalls = 0;
  let completed = false;
  for await (const event of agent.run(assembly.systemPrompt, assembly.userPrompt ?? task.prompt)) {
    if (event.type === 'ToolResult') toolCalls++;
    if (event.type === 'Completed') {
      completed = true;
      usage = event.payload.usage;
    }
  }
  if (!completed) throw new Error('CodingAgent evaluation run ended without a Completed event');
  return { usage, toolCalls, traceId: assembly.traceId };
}
