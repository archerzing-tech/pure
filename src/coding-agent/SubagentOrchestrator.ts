// src/coding-agent/SubagentOrchestrator.ts
// v0.1 — Subagent orchestrator implementing ToolAdapter.
// When the parent LLM calls a subagent tool, the orchestrator spawns a new
// AgentLoopEngine instance, runs it to completion, and returns the result.

import { AgentLoopEngine } from '../engine/AgentLoopEngine';
import type {
  BudgetConfig,
  EngineContext,
  LLMAdapter,
  ToolAdapter,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../shared/types';
import type { SubagentDefinition, SubagentResult } from './types';
import { Tags } from './ToolRegistry';

export interface SubagentOrchestratorConfig {
  llm: LLMAdapter;
  parentTools?: ToolAdapter;
  parentToolsDefs?: ToolDefinition[];
  /** Optional: recompute the tool list when spawning each subagent. */
  parentToolsDefsProvider?: () => ToolDefinition[];
  defaultBudget: BudgetConfig;
}

export class SubagentOrchestrator implements ToolAdapter {
  private engine = new AgentLoopEngine();
  private defs = new Map<string, SubagentDefinition>();
  private config: SubagentOrchestratorConfig;

  constructor(config: SubagentOrchestratorConfig) {
    this.config = config;
  }

  register(def: SubagentDefinition): void {
    this.defs.set(def.name, def);
  }

  getTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const def of this.defs.values()) {
      tools.push({
        name: def.name,
        description: def.description,
        input_schema: def.input_schema,
      });
    }
    return tools;
  }

  getMetadata(_toolName: string): { sideEffects?: boolean; isWrite?: boolean } | undefined {
    return { sideEffects: true, isWrite: false };
  }

  async execute(toolCall: ToolCall, parentSignal?: AbortSignal): Promise<ToolResult> {
    const def = this.defs.get(toolCall.function.name);
    if (!def) {
      return {
        id: toolCall.id,
        toolName: toolCall.function.name,
        error: `Unknown subagent: ${toolCall.function.name}`,
        success: false,
        duration: 0,
      };
    }

    const startTime = Date.now();

    // Parse args
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(toolCall.function.arguments); } catch { /* keep {} */ }

    // Build combined signal: parent abort OR timeout
    const timeoutMs = def.defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = parentSignal
      ? AbortSignal.any([parentSignal, timeoutSignal])
      : timeoutSignal;

    // Construct EngineContext for the subagent
    const ctx: EngineContext = {
      llm: this.config.llm,
      tools: this.config.parentTools,
      toolsDefs: this.config.parentToolsDefsProvider?.() ?? this.config.parentToolsDefs ?? [],
      budget: this.config.defaultBudget,
      signal: combinedSignal,
    };

    try {
      const systemPrompt = def.createSystemPrompt(args);
      const userPrompt = typeof args.prompt === 'string'
        ? args.prompt
        : JSON.stringify(args);

      let finalOutput: string | undefined;
      let tokensUsed = 0;

      for await (const event of this.engine.run(
        { sessionId: `subagent_${def.name}_${Date.now()}`, systemPrompt, userPrompt, budget: this.config.defaultBudget },
        ctx,
      )) {
        if (event.type === 'TokenDelta') {
          tokensUsed++;
        }
        if (event.type === 'Completed') {
          finalOutput = event.payload.finalOutput;
        }
        if (event.type === 'Interrupted') {
          if (combinedSignal.aborted) {
            return {
              id: toolCall.id,
              toolName: def.name,
              result: { aborted: true, reason: 'timeout or cancelled', finalOutput },
              success: false,
              duration: Date.now() - startTime,
            };
          }
          break;
        }
        if (event.type === 'Error') {
          return {
            id: toolCall.id,
            toolName: def.name,
            error: event.payload.message,
            success: false,
            duration: Date.now() - startTime,
          };
        }
      }

      const result: SubagentResult = {
        id: toolCall.id,
        agentName: def.name,
        success: true,
        output: finalOutput,
        duration: Date.now() - startTime,
        tokensUsed,
      };

      return {
        id: toolCall.id,
        toolName: def.name,
        result: result,
        success: true,
        duration: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        id: toolCall.id,
        toolName: def.name,
        error: err?.message ?? String(err),
        success: false,
        duration: Date.now() - startTime,
      };
    }
  }
}

// ── Built-in subagent definitions ──

export const BUILT_IN_SUBAGENTS: SubagentDefinition[] = [
  {
    name: 'code_reviewer',
    description: 'Review code changes for correctness, style, and security. Returns a structured review with issues and suggestions.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Description of what to review, with relevant code context' },
        files: { type: 'string', description: 'File paths or code snippets to review (comma-separated)' },
      },
      required: ['prompt'],
    },
    tags: [Tags.AGENT, Tags.READ],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const filesHint = typeof input.files === 'string' ? `\nFocus on these files: ${input.files}` : '';
      return `You are a code reviewer. Review the provided code for:
1. Correctness — does it do what it claims?
2. Style — does it follow conventions?
3. Security — are there any vulnerabilities?
4. Performance — are there obvious optimizations?
5. Edge cases — what might break?

Be concise. Structure your review with clear sections.${filesHint}`;
    },
    defaultTimeoutMs: 120_000,
  },
  {
    name: 'web_researcher',
    description: 'Research a topic online and summarize findings. Use for documentation lookup, API references, or technical research.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The research question or topic to investigate' },
      },
      required: ['prompt'],
    },
    tags: [Tags.AGENT, Tags.READ],
    riskLevel: 'low',
    createSystemPrompt: (_input: Record<string, unknown>) => {
      return `You are a web researcher. For the given topic:
1. Identify the key concepts and terminology
2. Find authoritative sources and documentation
3. Summarize findings clearly and concisely
4. Include relevant code examples or API signatures where applicable
5. Note any version-specific considerations

Be thorough but concise. Organize findings under clear headings.`;
    },
    defaultTimeoutMs: 180_000,
  },
  {
    name: 'planner',
    description: 'Break down a complex task into ordered steps. Use before starting multi-file or multi-step work.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task to plan' },
        context: { type: 'string', description: 'Additional context (files, constraints, preferences)' },
      },
      required: ['prompt'],
    },
    tags: [Tags.AGENT, Tags.PLAN, Tags.READ],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const ctx = typeof input.context === 'string' ? `\nAdditional context: ${input.context}` : '';
      return `You are a task planner. Break down the given task into ordered, actionable steps.${ctx}

For each step provide:
1. What to do (concrete action)
2. Which files to touch (if known)
3. Expected outcome
4. Dependencies on other steps

Keep steps atomic — each step should be one clear action. Order steps logically.`;
    },
    defaultTimeoutMs: 60_000,
  },
];
