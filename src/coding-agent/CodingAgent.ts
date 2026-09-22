// src/coding-agent/CodingAgent.ts
// v0.3 — Application layer: assembles Engine + Harness + Adapters for a user task.
// Includes SubagentOrchestrator + MCPClient integration.

import { Harness, type HarnessConfig } from '../harness/Harness';
import type { ReflectionConfig } from '../harness/LessonReflector';
import { DefaultSubagentRegistry } from '../harness/SubagentRegistry';
import { Planner } from './Planner';
import { PermissionManager } from './PermissionManager';
import { Verifier } from './Verifier';
import { createDefaultHarnessConfig } from './defaultHarnessConfig';
import { ToolRegistry } from './ToolRegistry';
import { SubagentOrchestrator, BUILT_IN_SUBAGENTS, CODING_AGENT_ROLES, type SubagentActivity, type SubagentOrchestratorConfig, type SubagentProgress } from './SubagentOrchestrator';
import { MCPClient, type MCPClientConfig } from '../harness/mcp/MCPClient';
import { PromptAssembler, type PromptBudgetConfig } from '../shared/PromptAssembler';
import type { PromptObservability } from '../shared/promptObservability';
import type { MCPServerConfig } from '../adapter/mcp/MCPTransport';
import type {
  AsyncQueueLike,
  BudgetConfig,
  EngineContext,
  EngineEvent,
  EngineLlmPhase,
  FailurePolicy,
  FailureHistory,
  HookRouter,
  IMemoryStore,
  LLMAdapter,
  Message,
  MessageImage,
  SubagentActivityEvent,
  ToolAdapter,
  ToolDefinition,
  IStateStore,
} from '../shared/types';
import type {
  PermissionMode,
  PermissionContext,
  PermissionDecision,
  PermissionRequestHandler,
  AnalysisResult,
  SemanticRouteDecision,
  SubagentDefinition,
} from './types';

export interface CodingAgentConfig {
  sessionId: string;
  llm: LLMAdapter;
  toolAdapter: ToolAdapter;
  toolsDefs?: ToolDefinition[];
  budget: BudgetConfig;
  stateStore?: IStateStore;
  /** Cross-session long-term memory (IMemoryStore) — retrieved at session
   *  start, written at session end. Omit to run without memory. */
  memory?: IMemoryStore;
  /** Project path for memory isolation; defaults to process.cwd(). */
  projectPath?: string;
  /** Explicitly tells the Harness whether local workspace capability is available. */
  workspaceAvailable?: boolean;
  /** Shared prompt compiler for application and Harness context assembly. */
  promptAssembler?: PromptAssembler;
  promptBudget?: PromptBudgetConfig;
  /** Optional local trace collector shared by prompt assembly and Harness runs. */
  observability?: PromptObservability;
  permissionMode?: PermissionMode;
  permissionHandler?: PermissionRequestHandler;
  /** Pre-built PermissionManager to reuse (e.g. a session-scoped instance so
   *  "allow always this session" survives across turns). When provided,
   *  permissionMode / permissionHandler are ignored. */
  permissionManager?: PermissionManager;
  /** Custom verifier — defaults to the built-in rule checks. */
  verifier?: Verifier;
  /** Custom hook router — defaults to an empty DefaultHookRouter. */
  hooks?: HookRouter;
  /** Custom failure policy — defaults to the built-in escalating policy. */
  failurePolicy?: FailurePolicy;
  /** E1.2 — preloaded cross-session failure history for the default policy
   * (ignored when a custom failurePolicy is supplied). */
  failureHistory?: FailureHistory;
  /** Optional plan-completion guard (EngineContext.continueGuard) — recovers
   * turns where the model stopped calling tools while plan work remained. */
  continueGuard?: EngineContext['continueGuard'];
  /** E0.3/E1.1 — per-phase adapter resolver (THINK / HANDOVER / REFLECT);
   * phases without a dedicated adapter fall back to the main llm. */
  llmFor?: (phase: EngineLlmPhase) => LLMAdapter | undefined;
  /** Mid-run steering queue (插话重构): drained by the engine at each THINK
   * boundary so a mid-round user message steers the next round instead of
   * restarting the turn. The GUI supplies it; CLI / subagents omit it. */
  takeSteerMessages?: EngineContext['takeSteerMessages'];
  /** 代执行回合（2026-09-22 插话重设计）：宿主在 THINK 边界给出的本轮
   *  toolCalls——引擎跳过模型调用，走原生 ACT 管线。只接父引擎；子代理
   *  引擎不传（折入的交付只属于父任务汇合轮，闸门在宿主闭包里）。 */
  takeSyntheticToolCalls?: EngineContext['takeSyntheticToolCalls'];
  /** Live subagent activity feed (parallel multi-agent): a fanout owned by
   * the host. CodingAgent publishes every orchestrator progress callback onto
   * it, and the Harness hands it to the engine context, which subscribes a
   * fresh reader per tool batch and re-emits the events as `SubagentActivity`.
   * Omitting it keeps the legacy pure-side-channel behavior (CLI / nested
   * runs). */
  subagentEvents?: {
    publish(event: SubagentActivityEvent): void;
    subscribe(): AsyncQueueLike<SubagentActivityEvent>;
  };
  /** E1.1 lesson reflector tuning; omitted = defaults. */
  reflection?: ReflectionConfig;
  subagents?: SubagentDefinition[];
  /** 阶段 13.3 — role → 进化 overlay（宿主从 ~/.pure/personas/ 装载后传入）；
   * 命中角色的 system prompt 在 base 之后追加 overlay。 */
  personaOverlays?: Map<string, string>;
  /** Optional UI sink to surface which subagent is currently working. */
  subagentProgress?: SubagentProgress;
  mcpServers?: MCPServerConfig[];
  /** Tool-name prefixes to hide from MCP discovery (see MCPClientConfig). */
  mcpExcludedPrefixes?: string[];
  proxyUrl?: string;
  /** Pre-created MCPClient — if provided, mcpServers is ignored. */
  mcpClient?: MCPClient;
}

export class CodingAgent {
  public readonly toolRegistry: ToolRegistry;
  public readonly planner: Planner;
  public readonly permissionManager: PermissionManager;
  public readonly verifier: Verifier;
  public readonly hooks: HookRouter;
  public readonly failurePolicy: FailurePolicy;
  public readonly continueGuard?: EngineContext['continueGuard'];
  public readonly subagentOrchestrator: SubagentOrchestrator;
  public readonly subagentRegistry: DefaultSubagentRegistry;
  public readonly mcpClient?: MCPClient;
  private harness: Harness;

  constructor(config: CodingAgentConfig) {
    this.toolRegistry = new ToolRegistry(config.toolAdapter);
    this.planner = new Planner();
    this.permissionManager = config.permissionManager ?? new PermissionManager(
      config.permissionMode ?? 'NORMAL',
      config.permissionHandler,
    );
    // Default Harness plumbing (ContextEngine + rule-based verifier + empty hook
    // router + escalating failure policy) is shared with the CLI — one factory,
    // no drift between the two entrypoints.
    const plumbing = createDefaultHarnessConfig({
      llm: config.llm,
      promptBudget: config.promptBudget,
      toolsProvider: () => this.toolRegistry.getTools(),
      failureHistory: config.failureHistory,
    });
    this.verifier = config.verifier ?? plumbing.verifier;
    this.hooks = config.hooks ?? plumbing.hooks;
    this.failurePolicy = config.failurePolicy ?? plumbing.failurePolicy;
    this.continueGuard = config.continueGuard;

    // Wire the permission manager into the tool execution path
    this.toolRegistry.setPermissionManager(this.permissionManager);

    // ── Subagent system ──
    this.subagentRegistry = new DefaultSubagentRegistry();
    const orchConfig: SubagentOrchestratorConfig = {
      llm: config.llm,
      parentTools: this.toolRegistry,
      parentToolsDefsProvider: () => this.toolRegistry.getTools(),
      defaultBudget: config.budget,
      // Composite progress sink: the legacy UI sink keeps working unchanged,
      // and every callback simultaneously lands on the event feed so the
      // ENGINE event stream carries subagent interior activity (callId namespacing).
      progress: this.makeSubagentProgressSink(config),
      // Subagent resume + bounded budget: propagate the parent session id and
      // (when a stateStore exists) so a re-delegated identical sub-task can
      // continue, and so a single subagent can't burn the whole parent budget.
      parentSessionId: config.sessionId,
      stateStore: config.stateStore,
      verifier: config.verifier,
      // Subagents inherit the parent's escalating failure policy so a transient
      // LLM/API error retries inside the subagent instead of killing it.
      failurePolicy: this.failurePolicy,
      // 插话通道进子 agent（北极星第二步）：同一 steer 队列交给子代理引擎。
      // 父任务被委派工具占住时，插话由干活中的子代理在其 THINK 边界取走。
      takeSteerMessages: config.takeSteerMessages,
      // 13.3：宿主装载好的角色 overlay 透传给编排器（spawn 时合并进 system prompt）。
      personaOverlays: config.personaOverlays,
    };
    this.subagentOrchestrator = new SubagentOrchestrator(orchConfig);

    // Wire orchestrator as the executor for AGENT-tagged tools
    this.toolRegistry.setSubagentExecutor(this.subagentOrchestrator);

    // Register subagents in all three registries
    // Include both original BUILT_IN_SUBAGENTS and the new CODING_AGENT_ROLES
    const allSubagents = [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES];
    const subagents = config.subagents ?? allSubagents;
    for (const def of subagents) {
      this.subagentRegistry.register(def);
      this.subagentOrchestrator.register(def);
      this.toolRegistry.register(def);
    }

    // T1 — the observation layer needs to know which tool names are role
    // delegations. The roster is whatever this agent registered above; the
    // predicate keeps the shared observer decoupled from roster types.
    const registeredRoles = new Set(subagents.map((def) => def.name));
    config.observability?.setDelegationRolePredicate((toolName) => registeredRoles.has(toolName));

    // ── MCP Client ──
    if (config.mcpClient) {
      this.mcpClient = config.mcpClient;
      this.toolRegistry.setMCPExecutor(this.mcpClient);
      // Re-register previously discovered tools
      for (const tool of this.mcpClient.getTaggedTools()) {
        this.toolRegistry.register(tool);
      }
    } else if (config.mcpServers && config.mcpServers.length > 0) {
      this.mcpClient = new MCPClient({
        servers: config.mcpServers,
        sessionId: config.sessionId,
        onToolDiscovered: (tool) => this.toolRegistry.register(tool),
        proxyUrl: config.proxyUrl,
        excludedPrefixes: config.mcpExcludedPrefixes,
      });
      this.toolRegistry.setMCPExecutor(this.mcpClient);
      // Deferred connect: call mcpClient.connectAll() from the UI after construction
    }

    // G-3 fix: the ContextEngine carries the LLM so the summary fallback
    // actually runs when a lot of history gets evicted (previously `llm` was
    // omitted → summarizeEvicted was dead code and the summary path never
    // triggered). Built by the shared default harness factory.
    const contextEngine = plumbing.contextEngine;

    const promptCompiler = config.promptAssembler ?? new PromptAssembler(config.observability);

    // Model-visible tools = public tools + subagent tools. Subagent tools are
    // AGENT-tagged and filtered OUT of getTools() (the public list); without
    // merging them in here the parent LLM can never see or call them, which
    // makes the whole multi-agent system unreachable. Nested delegation is not
    // exposed: subagents get their own (public-only) tool list via
    // parentToolsDefsProvider, so a subagent cannot spawn a subagent (P0 keeps
    // delegation single-level).
    const modelToolsDefs = (): ToolDefinition[] => [
      ...this.toolRegistry.getTools(),
      ...this.toolRegistry.getSubagentTools(),
    ];
    this.harness = new Harness({
      sessionId: config.sessionId,
      llm: config.llm,
      tools: this.toolRegistry,
      toolsDefs: config.toolsDefs ?? modelToolsDefs(),
      // Recompute the tool list on every run so tools registered after
      // construction (subagents, MCP tools discovered asynchronously) are
      // visible to the LLM. Only active when the caller did NOT pin toolsDefs
      // (e.g. `[]` in plain-chat mode without a workspace must stay zero tools).
      toolsDefsProvider: config.toolsDefs === undefined
        ? modelToolsDefs
        : undefined,
      budget: config.budget,
      stateStore: config.stateStore,
      memory: config.memory,
      projectPath: config.projectPath,
      workspaceAvailable: config.workspaceAvailable ?? Boolean(config.projectPath),
      promptAssembler: promptCompiler,
      promptBudget: config.promptBudget,
      observability: config.observability,
      contextEngine,
      // VERIFY phase: run the built-in checks (or the caller's custom verifier)
      // against the final output before declaring completion.
      verifier: this.verifier,
      // Lifecycle hooks + escalating failure policy — previously dead branches
      // in the engine (never injected), now live in every run.
      hooks: this.hooks,
      failurePolicy: this.failurePolicy,
      continueGuard: this.continueGuard,
      llmFor: config.llmFor,
      takeSteerMessages: config.takeSteerMessages,
      takeSyntheticToolCalls: config.takeSyntheticToolCalls,
      subagentEvents: config.subagentEvents,
      reflection: config.reflection,
    });
  }

  /**
   * Composite progress sink for the orchestrator: every callback forwards to
   * the legacy UI sink unchanged (activity panel keeps its rich model) and
   * simultaneously maps onto the lean shared event shape and publishes to the
   * feed, so the engine event stream carries subagent interior activity
   * namespaced by the delegation toolCallId. Subagents are one activity per
   * emit — the mapping is 1:1, no aggregation.
   */
  private makeSubagentProgressSink(config: CodingAgentConfig): SubagentProgress {
    const feed = config.subagentEvents;
    const ui = config.subagentProgress;
    if (!feed && !ui) return {};
    const publish = (a: SubagentActivity, kind: SubagentActivityEvent['kind']): void => {
      feed?.publish({
        callId: a.callId,
        agentId: a.agentId,
        agentName: a.agentName,
        agentRole: a.agentRole,
        kind,
        state: a.state,
        toolName: a.toolName,
        toolState: a.toolState,
        toolArgsHint: a.toolTrace?.find((t) => t.name === a.toolName)?.args,
        lifecycle: a.lifecycle,
        success: a.success,
        error: a.error,
        summary: a.inputSnippet,
        durationMs: a.durationMs,
        tokensUsed: a.tokensUsed,
      });
    };
    return {
      onStart: (a) => { publish(a, 'start'); ui?.onStart?.(a); },
      // 北极星第二步: a steer receipt rides the onState channel but bridges as
      // its own event kind so the transcript card can render 📨, not a state blip.
      onState: (a) => { publish(a, a.lifecycle === 'steered' ? 'steered' : a.lifecycle === 'waiting' ? 'waiting' : 'state'); ui?.onState?.(a); },
      onTool: (a) => { publish(a, 'tool'); ui?.onTool?.(a); },
      // 阶段 12: a pause lands on the onDone channel (it IS terminal for this
      // run) but must not read as "✓ 交付" or "✗ 中断" on the transcript card
      // — bridge it as its own event kind so consumers can render ⏸.
      onDone: (a) => { publish(a, a.status === 'paused' ? 'paused' : 'done'); ui?.onDone?.(a); },
      onError: (a) => { publish(a, a.status === 'paused' ? 'paused' : 'error'); ui?.onError?.(a); },
    };
  }

  /** Analyze a user prompt to determine complexity and optionally generate a plan. */
  analyzeTask(prompt: string): AnalysisResult {
    return this.planner.analyzeTask(prompt);
  }

  /** Check if a tool call is permitted. */
  async checkPermission(ctx: PermissionContext): Promise<PermissionDecision> {
    return this.permissionManager.askUser(ctx);
  }

  /** Run the agent on a user prompt — the main entry point. */
  async *run(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
    images?: MessageImage[],
    semantic?: SemanticRouteDecision | null,
  ): AsyncGenerator<EngineEvent, void, void> {
    yield* this.harness.run(systemPrompt, userPrompt, signal, images, semantic);
  }

  /** Continue an existing session with a follow-up prompt. */
  async *continueTurn(
    systemPrompt: string,
    messages: Message[],
    newUserPrompt: string,
    signal?: AbortSignal,
    images?: MessageImage[],
    semantic?: SemanticRouteDecision | null,
  ): AsyncGenerator<EngineEvent, void, void> {
    yield* this.harness.continueTurn(systemPrompt, messages, newUserPrompt, signal, images, semantic);
  }

  /** Get the underlying Harness instance (for advanced use). */
  getHarness(): Harness {
    return this.harness;
  }
}
