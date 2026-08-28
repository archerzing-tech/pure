// src/coding-agent/SubagentOrchestrator.ts
// v0.1 — Subagent orchestrator implementing ToolAdapter.
// When the parent LLM calls a subagent tool, the orchestrator spawns a new
// AgentLoopEngine instance, runs it to completion, and returns the result.

import { AgentLoopEngine } from '../engine/AgentLoopEngine';
import { parseToolArguments } from '../shared/parseRepair';
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

/**
 * A single progress snapshot emitted by the orchestrator while a subagent runs.
 * The host UI turns these into a live "which agent is working" view.
 */
export interface SubagentActivity {
  /** Parent tool-call id that spawned this subagent (stable UI key). */
  callId: string;
  /** Subagent definition name, e.g. 'code_editor'. */
  agentName: string;
  /** Human description of the subagent's role. */
  agentRole?: string;
  /** Current engine state of the subagent (THINK / ACT / OBSERVE / ...). */
  state?: string;
  /** Last tool the subagent invoked. */
  toolName?: string;
  /** Outcome: true = finished successfully, false = failed / interrupted. */
  success?: boolean;
  error?: string;
  output?: string;
}

/** Optional UI progress sink — lets the host surface multi-agent activity. */
export interface SubagentProgress {
  onStart?: (a: SubagentActivity) => void;
  onState?: (a: SubagentActivity) => void;
  onTool?: (a: SubagentActivity) => void;
  onDone?: (a: SubagentActivity) => void;
  onError?: (a: SubagentActivity) => void;
}

export interface SubagentOrchestratorConfig {
  llm: LLMAdapter;
  parentTools?: ToolAdapter;
  parentToolsDefs?: ToolDefinition[];
  /** Optional: recompute the tool list when spawning each subagent. */
  parentToolsDefsProvider?: () => ToolDefinition[];
  defaultBudget: BudgetConfig;
  /** Optional UI progress sink — lets the host show which subagent is working. */
  progress?: SubagentProgress;
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

    // UI progress sink: emit a live "which agent is working" trace so the host
    // UI can show the multi-agent nature of the run instead of a black box.
    // CRITICAL: a display/UI error MUST NOT break the agent's actual work
    // (code/image/plan generation) — every emit is swallowed. The orchestrator's
    // return value (the ToolResult handed back to the parent agent) is never
    // touched by these callbacks, so message pass-through stays intact.
    const progress = this.config.progress;
    const activity = (): SubagentActivity => ({
      callId: toolCall.id,
      agentName: def.name,
      agentRole: def.description,
    });
    const emit = (
      cb: ((a: SubagentActivity) => void) | undefined,
      extra: Partial<SubagentActivity> = {},
    ): void => {
      if (!cb) return;
      try {
        cb({ ...activity(), ...extra });
      } catch {
        // Host UI failed to render — ignore so the subagent keeps working.
      }
    };
    emit(progress?.onStart);

    // Parse args — slightly-broken LLM JSON is repaired first, so a single
    // trailing comma or unquoted key no longer drops the whole prompt payload.
    const args = parseToolArguments(toolCall.function.arguments);

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
        } else if (event.type === 'StateChange') {
          emit(progress?.onState, { state: event.payload.to });
        } else if (event.type === 'ToolResult') {
          emit(progress?.onTool, { toolName: event.payload.toolName });
        } else if (event.type === 'Completed') {
          finalOutput = event.payload.finalOutput;
          emit(progress?.onDone, { success: true, output: finalOutput });
        } else if (event.type === 'Interrupted') {
          if (combinedSignal.aborted) {
            emit(progress?.onDone, { success: false, error: 'timed out or cancelled' });
            return {
              id: toolCall.id,
              toolName: def.name,
              result: { aborted: true, reason: 'timeout or cancelled', finalOutput },
              success: false,
              duration: Date.now() - startTime,
            };
          }
          emit(progress?.onDone, { success: false, error: event.payload.reason, output: finalOutput });
          break;
        } else if (event.type === 'Error') {
          emit(progress?.onError, { error: event.payload.message });
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
      emit(progress?.onError, { error: err?.message ?? String(err) });
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
    name: 'project_auditor',
    description: 'Audit a project for dependency vulnerabilities, unsafe configuration, exposed secrets, and reproducible verification evidence. Uses read-only checks and returns a structured AUDIT: PASS or AUDIT: FAIL verdict.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The project audit scope and delivery constraints' },
        files: { type: 'string', description: 'Project manifests, lockfiles, configuration, and source paths to inspect' },
      },
      required: ['prompt'],
    },
    tags: [Tags.AGENT, Tags.READ],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const filesHint = typeof input.files === 'string' ? `\nPrioritize these paths: ${input.files}` : '';
      return `You are a project security and delivery auditor. Perform a read-only audit using the available filesystem and command tools.

Check:
1. Dependency manifests and lockfiles for known vulnerabilities using the project's existing audit tool when available. Never run npm audit fix, cargo update, or other mutating remediation.
2. Secret exposure in tracked and untracked source/config files, including common API-key and private-key patterns. Avoid printing full secrets; report only the file and line context needed to fix them.
3. Unsafe scripts, shell injection surfaces, permissive configuration, and missing validation around external input.
4. Whether the project's documented typecheck, test, lint, and build commands are reproducible and whether their real output supports the conclusion.

Distinguish a vulnerability/finding from an unavailable audit tool, missing lockfile, network failure, or inconclusive result. Do not call an unavailable check a pass. Report evidence under concise headings, then end with exactly one line: AUDIT: PASS when no blocking finding remains and all required checks have evidence, otherwise AUDIT: FAIL.${filesHint}`;
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

// ── Extended coding agent roles (Phase 1) ──
// These agents form the core multi-agent collaboration system for coding tasks.
// They are designed to work together: planner → editor → reviewer → basher.

export const CODING_AGENT_ROLES: SubagentDefinition[] = [
  // === 规划器 (Task Planner) ===
  // Breaks down complex tasks into ordered, actionable steps
  {
    name: 'task_planner',
    description: '制定详细的修改计划，决定修改哪些文件及执行顺序。用于复杂的多文件修改或重构任务。',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '用户任务描述' },
        context: { type: 'string', description: '项目上下文信息（当前代码结构、技术栈等）' },
        constraints: { type: 'string', description: '约束条件（如代码风格、技术要求）' },
      },
      required: ['task'],
    },
    tags: [Tags.AGENT, Tags.PLAN],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const task = String(input.task || '');
      const context = String(input.context || '无');
      const constraints = String(input.constraints || '无');
      return `你是一个专业的任务规划师。分析任务并制定详细的修改计划。

任务：${task}
上下文：${context}
约束：${constraints}

请制定包含以下信息的计划：
1. 步骤编号和具体动作
2. 涉及的文件列表（按依赖顺序）
3. 每个步骤的预期结果
4. 步骤间的依赖关系

保持步骤原子化，每个步骤一个清晰动作。`;
    },
    defaultTimeoutMs: 60_000,
  },

  // === 编辑器 (Code Editor) ===
  // Executes precise code modifications based on plans
  {
    name: 'code_editor',
    description: '根据计划执行精确的代码修改。先读取文件，然后按指令修改。',
    input_schema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: '执行计划（JSON格式或文字描述）' },
        files: { type: 'string', description: '需要修改的文件列表（逗号分隔）' },
        instructions: { type: 'string', description: '具体的修改指令' },
      },
      required: ['instructions'],
    },
    tags: [Tags.AGENT, Tags.WRITE],
    riskLevel: 'medium',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const plan = String(input.plan || '无特定计划');
      const files = String(input.files || '待确定');
      const instructions = String(input.instructions || '');
      return `你是一个精确的代码编辑器。根据计划执行代码修改。

计划：${plan}
需要修改的文件：${files}
修改指令：${instructions}

执行时请：
1. 先读取目标文件的当前内容
2. 精确执行计划中的修改
3. 保持代码风格一致
4. 必要时添加注释说明修改原因

只使用 write_file、edit_file 或 replace_files 工具修改文件。`;
    },
    defaultTimeoutMs: 180_000,
  },

  // === 思考器 (Deep Thinker) ===
  // Handles complex reasoning and multi-step analysis
  {
    name: 'deep_thinker',
    description: '专门处理复杂、需要深度推理的问题。用于算法分析、架构设计决策等。',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '复杂问题描述' },
        context: { type: 'string', description: '相关上下文信息' },
        approach: { type: 'string', description: '思考方式：分析|推理|创造|评估' },
      },
      required: ['question'],
    },
    tags: [Tags.AGENT],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const question = String(input.question || '');
      const context = String(input.context || '无');
      const approach = String(input.approach || '全面分析');
      return `你是一个深度思考专家。处理复杂问题和需要多步推理的场景。

问题：${question}
上下文：${context}
思考方式：${approach}

请进行深度分析：
1. 分解问题为多个子问题
2. 分析各子问题的关系和依赖
3. 探索多种解决路径
4. 评估每个路径的优劣
5. 给出推荐方案及详细理由

请以结构化的方式输出你的思考过程和结论。`;
    },
    defaultTimeoutMs: 180_000,
  },

  // === UI设计器 (UI Designer) ===
  // Handles interface design, layout planning, and interaction design
  {
    name: 'ui_designer',
    description: '负责界面设计、布局规划和交互设计。处理UI/UX相关的需求。',
    input_schema: {
      type: 'object',
      properties: {
        requirement: { type: 'string', description: 'UI需求描述' },
        design_type: { type: 'string', description: '设计类型：interface|layout|interaction|both' },
        context: { type: 'string', description: '现有设计上下文或参考' },
      },
      required: ['requirement'],
    },
    tags: [Tags.AGENT],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const requirement = String(input.requirement || '');
      const designType = String(input.design_type || 'both');
      const context = String(input.context || '新设计');
      return `你是一个专业的UI设计师。

需求：${requirement}
设计类型：${designType}
现有上下文：${context}

请提供完整的设计方案：

**1. 界面设计**
- 视觉元素（颜色、字体、图标）
- 整体风格和调性

**2. 布局设计**
- 页面结构
- 层次和优先级
- 响应式策略

**3. 交互设计**
- 用户操作流程
- 状态和反馈机制
- 动画和过渡效果

使用清晰的格式输出，便于开发者实现。对于代码相关的内容，提供具体的代码示例。`;
    },
    defaultTimeoutMs: 120_000,
  },

  // === 执行器 (Bash Executor) ===
  // Executes terminal commands with safety checks
  {
    name: 'bash_executor',
    description: '执行终端命令，返回执行结果。用于运行测试、构建脚本等。',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录（可选）' },
        description: { type: 'string', description: '命令用途说明' },
      },
      required: ['command'],
    },
    tags: [Tags.AGENT, Tags.SHELL],
    riskLevel: 'high',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const description = String(input.description || '');
      return `你是一个命令执行专家。安全地执行终端命令。

${description ? `命令用途：${description}` : ''}

请注意：
1. 解释将要执行的命令的作用
2. 使用 execute_command 工具执行
3. 分析结果是否成功
4. 如有错误，提供诊断信息和修复建议

避免执行破坏性命令（如 rm -rf 除非明确要求）。`;
    },
    defaultTimeoutMs: 120_000,
  },

  // === 研究者 (Researcher) ===
  // Researches topics and summarizes findings
  {
    name: 'researcher',
    description: '研究主题并总结发现，包括查阅网络资源和文档。用于技术调研、API研究等。',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '研究主题或问题' },
        sources: { type: 'string', description: '优先的信息来源类型：web|docs|both' },
        scope: { type: 'string', description: '研究范围或限制' },
      },
      required: ['topic'],
    },
    tags: [Tags.AGENT, Tags.SEARCH, Tags.READ],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const topic = String(input.topic || '');
      const sources = String(input.sources || 'both');
      const scope = String(input.scope || '');
      return `你是一个专业的研究员。

研究主题：${topic}
信息来源：${sources}
研究范围：${scope || '无限制'}

研究方法：
1. 使用 web_search 和 web_fetch 工具查找相关信息
2. 识别关键概念和术语
3. 查找权威来源和官方文档
4. 整理发现，用清晰简洁的方式总结
5. 包含相关的代码示例或API签名
6. 标注版本相关注意事项和最佳实践

保持研究全面但简洁，使用清晰的标题组织。最终输出结构化的研究报告。`;
    },
    defaultTimeoutMs: 180_000,
  },
];
