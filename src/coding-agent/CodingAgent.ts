// src/coding-agent/CodingAgent.ts
// v0.3 — Application layer: assembles Engine + Harness + Adapters for a user task.
// Includes SubagentOrchestrator + MCPClient integration.

import { Harness, type HarnessConfig } from '../harness/Harness';
import { DefaultHookRouter } from '../engine/HookRouter';
import { DefaultFailurePolicy } from '../engine/FailurePolicy';
import { ContextEngine } from '../harness/ContextEngine';
import { FileWatcher, type FileWatcherConfig } from '../harness/FileWatcher';
import { DefaultSubagentRegistry } from '../harness/SubagentRegistry';
import { Planner } from './Planner';
import { PermissionManager } from './PermissionManager';
import { Verifier, createDefaultVerifier } from './Verifier';
import { ToolRegistry } from './ToolRegistry';
import { SubagentOrchestrator, BUILT_IN_SUBAGENTS, type SubagentOrchestratorConfig } from './SubagentOrchestrator';
import { MCPClient, type MCPClientConfig } from '../harness/mcp/MCPClient';
import type { MCPServerConfig } from '../adapter/mcp/MCPTransport';
import type {
  BudgetConfig,
  EngineEvent,
  FailurePolicy,
  HookRouter,
  IMemoryStore,
  LLMAdapter,
  Message,
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
  subagents?: SubagentDefinition[];
  mcpServers?: MCPServerConfig[];
  fileWatcher?: FileWatcherConfig;
  /** Pre-created MCPClient — if provided, mcpServers is ignored. */
  mcpClient?: MCPClient;
  /** Pre-created FileWatcher — if provided, fileWatcher config is ignored. */
  fileWatcherInstance?: FileWatcher;
}

export class CodingAgent {
  public readonly toolRegistry: ToolRegistry;
  public readonly planner: Planner;
  public readonly permissionManager: PermissionManager;
  public readonly verifier: Verifier;
  public readonly hooks: HookRouter;
  public readonly failurePolicy: FailurePolicy;
  public readonly subagentOrchestrator: SubagentOrchestrator;
  public readonly subagentRegistry: DefaultSubagentRegistry;
  public readonly mcpClient?: MCPClient;
  public readonly fileWatcher?: FileWatcher;
  private harness: Harness;

  constructor(config: CodingAgentConfig) {
    this.toolRegistry = new ToolRegistry(config.toolAdapter);
    this.planner = new Planner();
    this.permissionManager = config.permissionManager ?? new PermissionManager(
      config.permissionMode ?? 'NORMAL',
      config.permissionHandler,
    );
    this.verifier = config.verifier ?? createDefaultVerifier();
    this.hooks = config.hooks ?? new DefaultHookRouter();
    this.failurePolicy = config.failurePolicy ?? new DefaultFailurePolicy();

    // Wire the permission manager into the tool execution path
    this.toolRegistry.setPermissionManager(this.permissionManager);

    // ── Subagent system ──
    this.subagentRegistry = new DefaultSubagentRegistry();
    const orchConfig: SubagentOrchestratorConfig = {
      llm: config.llm,
      parentTools: this.toolRegistry,
      parentToolsDefsProvider: () => this.toolRegistry.getTools(),
      defaultBudget: config.budget,
    };
    this.subagentOrchestrator = new SubagentOrchestrator(orchConfig);

    // Wire orchestrator as the executor for AGENT-tagged tools
    this.toolRegistry.setSubagentExecutor(this.subagentOrchestrator);

    // Register subagents in all three registries
    const subagents = config.subagents ?? BUILT_IN_SUBAGENTS;
    for (const def of subagents) {
      this.subagentRegistry.register(def);
      this.subagentOrchestrator.register(def);
      this.toolRegistry.register(def);
    }

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
        onToolDiscovered: (tool) => this.toolRegistry.register(tool),
      });
      this.toolRegistry.setMCPExecutor(this.mcpClient);
      // Deferred connect: call mcpClient.connectAll() from the UI after construction
    }

    // ── File Watcher ──
    if (config.fileWatcherInstance) {
      this.fileWatcher = config.fileWatcherInstance;
    } else if (config.fileWatcher) {
      this.fileWatcher = new FileWatcher(config.fileWatcher);
    }

    // G-3 fix: pass the LLM so the summary fallback actually runs when a lot
    // of history gets evicted (previously `llm` was omitted → summarizeEvicted
    // was dead code and the summary path never triggered).
    const contextEngine = new ContextEngine({ maxMessages: 20, llm: config.llm });

    this.harness = new Harness({
      sessionId: config.sessionId,
      llm: config.llm,
      tools: this.toolRegistry,
      toolsDefs: config.toolsDefs ?? this.toolRegistry.getTools(),
      // Recompute the tool list on every run so tools registered after
      // construction (subagents, MCP tools discovered asynchronously) are
      // visible to the LLM. Only active when the caller did NOT pin toolsDefs
      // (e.g. `[]` in plain-chat mode without a workspace must stay zero tools).
      toolsDefsProvider: config.toolsDefs === undefined
        ? () => this.toolRegistry.getTools()
        : undefined,
      budget: config.budget,
      stateStore: config.stateStore,
      memory: config.memory,
      projectPath: config.projectPath,
      contextEngine,
      fileWatcher: this.fileWatcher,
      // VERIFY phase: run the built-in checks (or the caller's custom verifier)
      // against the final output before declaring completion.
      verifier: this.verifier,
      // Lifecycle hooks + escalating failure policy — previously dead branches
      // in the engine (never injected), now live in every run.
      hooks: this.hooks,
      failurePolicy: this.failurePolicy,
    });
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
  ): AsyncGenerator<EngineEvent, void, void> {
    yield* this.harness.run(systemPrompt, userPrompt, signal);
  }

  /** Continue an existing session with a follow-up prompt. */
  async *continueTurn(
    systemPrompt: string,
    messages: Message[],
    newUserPrompt: string,
    signal?: AbortSignal,
  ): AsyncGenerator<EngineEvent, void, void> {
    yield* this.harness.continueTurn(systemPrompt, messages, newUserPrompt, signal);
  }

  /** Get the underlying Harness instance (for advanced use). */
  getHarness(): Harness {
    return this.harness;
  }
}
