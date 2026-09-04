// src/cliHarness.ts
// Harness construction for the CLI — split out of src/cli.ts (audit ①). Owns the
// cross-session memory store (WASM-wrapped FSMemoryStore), the tool registry
// (+ MCP + subagent wiring), the state store, and the createHarness() factory
// that assembles the runnable Harness for one-shot / REPL sessions. Depends on
// cliConfig + cliAdapter + the shared default-harness factory — never on the
// run-loop module (acyclic graph).
import { Harness } from './harness/Harness';
import { createDefaultHarnessConfig } from './coding-agent/defaultHarnessConfig';
import { NodeToolAdapter } from './adapter/node/NodeToolAdapter';
import { FSStore } from './adapter/storage/FSStore';
import { SQLiteStore } from './adapter/storage/SQLiteStore';
import { ToolRegistry } from './coding-agent/ToolRegistry';
import { MCPClient } from './harness/mcp/MCPClient';
import { BUILT_IN_SUBAGENTS, CODING_AGENT_ROLES, SubagentOrchestrator, type SubagentProgress } from './coding-agent/SubagentOrchestrator';
import { PermissionManager } from './coding-agent/PermissionManager';
import { createCliPermissionHandler } from './cli_permission';
import { FSMemoryStore } from './adapter/memory/FSMemoryStore';
import { createEmbeddingMemoryStore } from './shared/memoryFactory';
import { harvestUserPreferences } from './shared/memory';
import { promptBudgetForProvider } from './shared/providers';
import { promptAssembler } from './shared/PromptAssembler';
import { cyan, dim, green, red, yellow } from './termcolors';
import type { MCPServerConfig } from './adapter/mcp/MCPTransport';
import type { IStateStore, ToolAdapter, ToolDefinition } from './shared/types';
import { createAdapter } from './cliAdapter';
import { DEFAULT_BUDGET, evolutionCfg, PURE_DIR } from './cliConfig';
import type { CliArgs } from './cliConfig';

// ── CLI cross-session memory (IMemoryStore) ──
// File-backed store under ~/.pure/memories/{projectHash}/memories.jsonl,
// replacing the old single ~/.pure/memory.json UserProfile. The Harness
// searches it at session start (PromptComposer injects the top memories into
// the system prompt) and writes a successful_pattern when a session completes.
//
// WASM (v2.1): the store is wrapped in WASMEmbeddingStore — the same
// transformers.js-WASM semantic retrieval the GUI uses — so recall is
// vector-similarity based instead of literal keyword matching. The WASM model
// is lazy: it only downloads (~80MB, cached after first use) on the first
// search over a NON-EMPTY corpus, and any embedder failure (offline / no
// model / WASM unavailable) falls back to keyword search, so the CLI keeps
// working exactly as before in every environment. Scripts/CI that don't want
// the first-search download can force keyword mode with PURE_MEMORY_KEYWORD=1.
// Note: standalone released binaries ship with @huggingface/transformers
// external (package.json cli:build — onnxruntime-node can't be bundled), so
// their runtime import always fails and they use keyword search; WASM recall
// is active for repo/dev runs (`bun run cli`).
const memoryStore = process.env.PURE_MEMORY_KEYWORD
  ? new FSMemoryStore(`${PURE_DIR}/memories`, '', evolutionCfg)
  : createEmbeddingMemoryStore({
      store: new FSMemoryStore(`${PURE_DIR}/memories`, '', evolutionCfg),
      // 包装层与内层 store 用同一份配置：WASM 检索路径的 dormant 过滤
      // 必须跟随 PURE_MEMORY_DORMANT_MAX，否则语义检索时阈值静默失效。
      getEvolution: () => evolutionCfg,
    });

function learnFromInput(text: string, sessionId: string, projectPath: string): Promise<unknown> {
  const entries = harvestUserPreferences(text, { sessionId, projectPath });
  return Promise.all(entries.map(e => memoryStore.add(e).catch(() => '')));
}

// ── Terminal rendering for subagent activity ──
// So the user can SEE the multi-agent delegation (which agent is working, when
// it finishes, how long it took) instead of only the final tool result line.
// Printed as indented progress lines that commit immediately (not part of the
// streaming answer).
const cliSubagentProgress: SubagentProgress = {
  onStart: (a) => {
    const task = a.inputSnippet ? ` — ${a.inputSnippet}` : '';
    process.stdout.write(`  ${cyan(`◈ ${a.agentName}`)} ${dim(`${a.agentRole}`)}${dim(task)}\n`);
  },
  onState: (a) => {
    if (a.state) process.stdout.write(`    ${dim(`↳ ${agentStateToCli(a.state)}`)}\n`);
  },
  onTool: (a) => {
    if (a.toolName) process.stdout.write(`    ${dim(`↳ 调用 ${a.toolName}`)}\n`);
  },
  onDone: (a) => {
    const ms = typeof a.durationMs === 'number' ? ` ${dim(`(${(a.durationMs / 1000).toFixed(1)}s`)}` : '';
    const tokens = typeof a.tokensUsed === 'number' ? ` · ${a.tokensUsed} tok` : '';
    const mark = a.status === 'timed_out' ? yellow('⏱ 超时') : a.success ? '✓' : red('✗');
    process.stdout.write(`  ${green(`◈ ${a.agentName}`)} ${mark}${ms}${tokens}${ms ? ')' : ''}\n`);
  },
  onError: (a) => {
    const note = a.error ? ` ${dim(`↳ ${a.error.slice(0, 80)}`)}` : '';
    process.stdout.write(`  ${red(`◈ ${a.agentName}`)} ✗${note}\n`);
  },
};

function agentStateToCli(state: string): string {
  switch (state) {
    case 'THINK': return '思考中';
    case 'ACT': return '执行中';
    case 'OBSERVE': return '观察中';
    case 'VERIFY': return '验证中';
    case 'TERMINATE': return '收尾中';
    default: return state;
  }
}

async function createTools(
  workspace: string,
  autoApprove = false,
  sessionId = '',
  mcpServers?: MCPServerConfig[],
  mcpExcludedPrefixes?: string[],
): Promise<{ tools?: ToolAdapter; toolsDefs: ToolDefinition[]; mcpClient?: MCPClient }> {
  if (!workspace) return { toolsDefs: [] };

  const resolved = workspace.startsWith('/') ? workspace : `${process.cwd()}/${workspace}`;
  // Pass the user-configured location (PURE_LOCATION / PURE_CITY env var) so
  // sys_info() reports it as the location baseline, mirroring the GUI.
  const adapter = new NodeToolAdapter({
    workspace: resolved,
    sessionId,
    location: process.env.PURE_LOCATION ?? process.env.PURE_CITY,
  });

  // P1-8: wire PermissionManager + write confirmation into the CLI direct
  // path. The engine executes tools through ctx.tools; wrapping the adapter
  // in a ToolRegistry puts every call behind the same permission gate the GUI
  // uses (read auto-approve / write + command confirm / session cache).
  // toolsDefs stay the adapter's own (the 6 CLI-available tools) so the LLM
  // never sees registry-only git_* tools it cannot actually call.
  //
  // `autoApprove` (driven by --auto-approve) flips that gate to fully open:
  // every tool call is allowed without prompting. Useful for piped / scripted
  // invocations where no human is at the keyboard to answer y/n/a.
  const registry = new ToolRegistry(adapter);
  registry.setPermissionManager(new PermissionManager('NORMAL', createCliPermissionHandler(autoApprove)));

  // MCP servers: GUI-written ~/.pure/config.json `mcpServers` plus repeatable
  // --mcp-server flags. Tools are registered into the same registry as the
  // built-ins (permission-gated like the GUI) and routed to the MCPClient.
  // Prefix exclusions (mcpExcludedPrefixes) keep third-party tool lists from
  // crowding out the built-in selection.
  const mcpDefs: ToolDefinition[] = [];
  let mcpClient: MCPClient | undefined;
  if (mcpServers && mcpServers.length > 0) {
    mcpClient = new MCPClient({
      servers: mcpServers,
      sessionId,
      excludedPrefixes: mcpExcludedPrefixes,
      onToolDiscovered: (tool) => registry.register(tool),
    });
    registry.setMCPExecutor(mcpClient);
    await mcpClient.connectAll();
    // Register tools from any server that connected (allSettled tolerates
    // individual failures, e.g. a missing uvx for the Scrapling preset).
    for (const tool of mcpClient.getTaggedTools()) registry.register(tool);
    mcpDefs.push(...mcpClient.getTools());
  }

  return { tools: registry, toolsDefs: [...adapter.getTools(), ...mcpDefs], mcpClient };
}

// ── Storage factory ──

function createStore(args: CliArgs): IStateStore | undefined {
  if (args.stateDb) return new SQLiteStore(args.stateDb);
  return new FSStore();
}

// ── Harness factory ──

async function createHarness(args: CliArgs) {
  const { adapter } = createAdapter(args);
  const sessionId = args.resume || `session_${Date.now()}`;
  const createdTools = await createTools(args.workspace, args.autoApprove, sessionId, args.mcpServers, args.mcpExcludedPrefixes);
  const tools = createdTools.tools;
  let toolsDefs = createdTools.toolsDefs;
  const store = args.resume ? createStore(args) : undefined;

  // Default Harness plumbing (ContextEngine + rule-based verifier + default
  // hooks + default failure policy) shared with the GUI's CodingAgent — one
  // factory, no drift between the two entrypoints. Declared BEFORE the
  // subagent orchestrator so both the harness AND the subagents reuse the same
  // escalating failure policy.
  const plumbing = createDefaultHarnessConfig({
    llm: adapter,
    promptBudget: promptBudgetForProvider(args.customProviders, args.provider, args.model, args.providerOverrides),
    toolsProvider: () => tools?.getTools() ?? toolsDefs,
  });

  if (tools && tools instanceof ToolRegistry) {
    const orchestrator = new SubagentOrchestrator({
      llm: adapter,
      parentTools: tools,
      parentToolsDefsProvider: () => tools.getTools(),
      defaultBudget: DEFAULT_BUDGET,
      // Subagent resume (CLI has a stateStore) + bounded budget + live progress
      // so the terminal shows which subagent is working.
      parentSessionId: sessionId,
      stateStore: store,
      progress: cliSubagentProgress,
      // Same escalating retry policy as the CLI parent harness.
      failurePolicy: plumbing.failurePolicy,
    });
    // Full delegation surface, mirroring the GUI: both the built-in reviewers
    // and the coding roles (task_planner / code_editor / researcher /
    // ui_designer / deep_thinker / bash_executor), so the CLI can satisfy the
    // multi_agent protocol instead of only being able to review/audit.
    for (const def of [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES]) {
      orchestrator.register(def);
      tools.register(def);
    }
    tools.setSubagentExecutor(orchestrator);
    // Model-visible tools = public tools + subagent tools, so the parent LLM
    // can actually delegate (getTools() alone filters subagents out).
    toolsDefs = [...tools.getTools(), ...tools.getSubagentTools()];
  }
  // Project-scoped memory: resolved workspace (same as createTools uses).
  const projectPath = args.workspace
    ? (args.workspace.startsWith('/') ? args.workspace : `${process.cwd()}/${args.workspace}`)
    : process.cwd();

  const harness = new Harness({
    sessionId,
    llm: adapter,
    tools,
    toolsDefs,
    budget: DEFAULT_BUDGET,
    stateStore: store,
    memory: memoryStore,
    projectPath,
    workspaceAvailable: true,
    promptAssembler,      promptBudget: promptBudgetForProvider(args.customProviders, args.provider, args.model, args.providerOverrides),
    // G-3 fix: the ContextEngine (with LLM summarization fallback) is wired in
    // so long REPL sessions don't grow without bound — the CLI's Harness never
    // had a contextEngine configured.
    contextEngine: plumbing.contextEngine,
    // P1-1 (async verification): the CLI uses the pure rule-based verifier
    // (non-empty-output check — a hard failure still triggers an in-engine
    // rewrite). The LLM re-check of the final answer is NOT run synchronously
    // here: the round-trip it added after the answer stream kept the CLI stuck
    // in "verifying…" and a failed verdict rewrote the answer just printed.
    verifier: plumbing.verifier,
    // Lifecycle hooks + escalating failure recovery policy.
    hooks: plumbing.hooks,
    failurePolicy: plumbing.failurePolicy,
  });

  return { harness, tools, toolsDefs, store, sessionId, projectPath, mcpClient: createdTools.mcpClient };
}

export { memoryStore, learnFromInput, cliSubagentProgress, createTools, createStore, createHarness };
