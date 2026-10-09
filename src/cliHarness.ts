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
import { SteerBus } from './coding-agent/steerBus';
import { DelegationControlPlane } from './coding-agent/delegationControl';
import { FoldInLedger } from './coding-agent/foldInLedger';
import { RoundClosePlane } from './coding-agent/roundClosePlane';
import { InterjectOrchestrator } from './coding-agent/interjectOrchestrator';
import { DynamicInsertionCoordinator } from './coding-agent/DynamicInsertionCoordinator';
import { steerFrameText } from './shared/insertionMessaging';
import { compileExternalSubagents, isExternalSubagentManifest } from './harness/externalSubagents';
import { compilePersonaOverlays } from './harness/personaOverlays';
import { loadOverlayText, overlayGuardPaths, parseOverlayGuardMeta } from './harness/overlayGuard';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PermissionManager } from './coding-agent/PermissionManager';
import { createCliPermissionHandler, createCliHookGate } from './cli_permission';
import type { PermissionMode, PermissionRequestHandler } from './coding-agent/types';
import type { Verifier } from './coding-agent/Verifier';
import { FSMemoryStore } from './adapter/memory/FSMemoryStore';
import { scanToolCorrections } from './adapter/memory/toolCorrections';
import { createEmbeddingMemoryStore } from './shared/memoryFactory';
import { harvestUserPreferences } from './shared/memory';
import { distillSkill, pickDistillSource } from './shared/skillDistill';
import { writeAutoSkillDir } from './cliSkillStore';
import { promptBudgetForProvider } from './shared/providers';
import { promptAssembler } from './shared/PromptAssembler';
import { promptObservability } from './shared/promptObservability';
import { FilePromptObservationStore } from './shared/FilePromptObservationStore';
import { failureHistoryFromMemories } from './engine/FailurePolicy';
import { cyan, dim, green, red, yellow } from './termcolors';
import type { MCPServerConfig } from './adapter/mcp/MCPTransport';
import type { IStateStore, IMemoryStore, LLMAdapter, ToolAdapter, ToolDefinition, EngineLlmPhase } from './shared/types';
import { phaseModelOverrides } from './shared/phaseModels';
import { createAdapter } from './cliAdapter';
import { DEFAULT_BUDGET, evolutionCfg, PURE_DIR } from './cliConfig';
import { loadUserHooks } from './shared/userHooks';
import { createGatedUserHookRunner, createNodeUserHookRunner } from './shared/userHookRunner';
import { loadHookApprovals } from './shared/userHookApprovals';
import type { CliArgs } from './cliConfig';

// E0.1 — mirror finished prompt/run observations to ~/.pure/observations/cli.jsonl.
// The singleton previously only fed the in-process ring buffer (no durable
// record); the sink is best-effort and never breaks a run.
promptObservability.setSink(new FilePromptObservationStore(`${PURE_DIR}/observations/cli.jsonl`));

// 阶段 13.3 — persona overlays for the CLI host: node:fs does the IO, the
// shared compiler validates (same split as the GUI's Tauri invoke). Pure
// function of the filesystem + role set; a broken file warns, never throws.
export function loadCliPersonaOverlays(externalDefs: { name: string }[]): Map<string, string> {
  const dir = process.env.PURE_PERSONAS_DIR
    ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.pure', 'personas');
  // 护栏路径的基准是 pure home（overlayGuardPaths 给 pure-home 相对路径）——
  // 直接 join 到 dir（已是 personas 目录）会双层错位、永不读到 meta，回退
  // 过滤整体失效。这个错法真实发生过，测试锁在 cliPersonaOverlays.test.ts。
  const guardBase = dirname(dir);
  let sources: { file: string; text: string }[] = [];
  try {
    sources = readdirSync(dir).filter((f) => f.endsWith('.overlay.md')).sort().map((file) => {
      // P1-2 回退护栏 — 装载侧过滤：meta.revertedAt ⇒ 回 .bak 前版或 base；
      // 手写文件无 meta 照装（与 GUI 装载同一份决策 loadOverlayText）。
      const role = file.replace(/\.overlay\.md$/, '');
      const paths = overlayGuardPaths(role);
      const meta = parseOverlayGuardMeta(readFileOrNull(join(guardBase, paths.meta)));
      const text = loadOverlayText(meta, readFileSync(join(dir, file), 'utf8'), readFileOrNull(join(guardBase, paths.bak)));
      return { file, text: text ?? '' };
    }).filter((s) => s.text !== '');
  } catch {
    return new Map();
  }
  const knownRoles = [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES, ...externalDefs].map((d) => d.name);
  const { overlays, errors } = compilePersonaOverlays(sources, knownRoles);
  for (const line of errors) {
    process.stderr.write(`  ${yellow('[persona-overlays]')} ${dim(line)}\n`);
  }
  return overlays;
}

function readFileOrNull(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

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
//
// E0.4 — released single-file binaries can't load transformers.js (its static
// onnxruntime-node import can't be bundled), so the compiled build injects the
// OrtWebEmbedder (embedded ort-wasm runtime + q8 MiniLM) through the wrapper's
// embedder seam instead. Dev runs (`bun run cli`) keep the transformers.js
// path; the embedder module never loads there.
function buildInnerMemoryStore(): FSMemoryStore {
  return new FSMemoryStore(`${PURE_DIR}/memories`, '', evolutionCfg);
}

async function buildCliMemoryStore(): Promise<IMemoryStore> {
  if (process.env.PURE_MEMORY_KEYWORD) return buildInnerMemoryStore();
  if (process.env.PURE_CLI_VERSION) {
    try {
      const { createOrtWebEmbedder } = await import('./adapter/memory/OrtWebEmbedder');
      const ortEmbedder = createOrtWebEmbedder({
        onProgress: (message) => process.stderr.write(`${dim(`[memory] ${message}`)}\n`),
      });
      return createEmbeddingMemoryStore({
        store: buildInnerMemoryStore(),
        getEvolution: () => evolutionCfg,
        embed: ortEmbedder.embed,
        embedBatch: ortEmbedder.embedBatch,
      });
    } catch (err) {
      // Embedder module failed to load — fall through to the plain wrapper;
      // its transformers import will fail in a binary too and degrade to
      // keyword search (pre-E0.4 released behavior).
      process.stderr.write(`${dim(`[memory] ort embedder unavailable (${err instanceof Error ? err.message : String(err)}); keyword fallback`)}\n`);
    }
  }
  return createEmbeddingMemoryStore({
    store: buildInnerMemoryStore(),
    getEvolution: () => evolutionCfg,
  });
}

const memoryStore = await buildCliMemoryStore();

// E1.3 — startup surfacing for tool-correction suggestions. Scans ALL project
// buckets of the inner FS store (tool cautions are machine-level, not
// per-project) and prints a compact list to stderr — advisory only, piped
// one-shot output stays clean. Approval lives in the GUI settings
// (工具使用建议 card); the CLI never writes these notes by itself.
function printToolCorrectionHints(): void {
  try {
    const suggestions = scanToolCorrections(buildInnerMemoryStore().listAllEntries());
    if (suggestions.length === 0) return;
    process.stderr.write(`  ${yellow('⚠')} ${dim(`近期工具失败模式（GUI 设置页 → 工具，可采纳为长期注意）：`)}\n`);
    for (const s of suggestions.slice(0, 3)) {
      process.stderr.write(`    ${dim(`· ${s.toolName} — ${s.errorClass} ×${s.count}（近 ${s.windowDays} 天）`)}\n`);
    }
    if (suggestions.length > 3) {
      process.stderr.write(`    ${dim(`… 等 ${suggestions.length} 条`)}\n`);
    }
  } catch {
    // Suggestions are informational — a scan failure never blocks startup.
  }
}

function learnFromInput(text: string, sessionId: string, projectPath: string): Promise<unknown> {
  const entries = harvestUserPreferences(text, { sessionId, projectPath });
  return Promise.all(entries.map(e => memoryStore.add(e).catch(() => '')));
}

// ── E2.2 沉淀成技能（CLI 侧编排）──
// 「把这个做法沉淀成技能」命中后：从全部项目桶挑最近的过程记忆，让模型扩写成
// SKILL.md，落 ~/.pure/skills/auto-<name>/。结果用可判别联合返回，文案归
// cliRepl（这里不打印）。
export type SkillDistillOutcome =
  | { ok: true; name: string; dir: string }
  | { ok: false; reason: 'no-source' | 'llm-failed' | 'write-failed'; detail?: string };

async function distillSkillFromMemory(llm: LLMAdapter, instruction: string): Promise<SkillDistillOutcome> {
  let source;
  try {
    source = pickDistillSource(buildInnerMemoryStore().listAllEntries());
  } catch {
    return { ok: false, reason: 'no-source' };
  }
  if (!source) return { ok: false, reason: 'no-source' };

  const skill = await distillSkill(llm, source.content, instruction);
  if (!skill) return { ok: false, reason: 'llm-failed' };

  try {
    const dir = writeAutoSkillDir(skill);
    return { ok: true, name: skill.name, dir };
  } catch (err) {
    return { ok: false, reason: 'write-failed', detail: err instanceof Error ? err.message : String(err) };
  }
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
  permissionMode: PermissionMode = 'NORMAL',
  permissionHandler?: PermissionRequestHandler,
  evolutionEnabled = true,
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
  // 通道来源默认 PLAN（只读）并由 gateway 注入审批 handler；CLI 保持 NORMAL +
  // 终端 y/n/a。同一接口，两个表面，PermissionManager 本身零改动。
  registry.setPermissionManager(new PermissionManager(permissionMode, permissionHandler ?? createCliPermissionHandler(autoApprove)));

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

// 通道宿主（gateway）经由这里复用同一份 createHarness 装配。全是可选覆盖：
// 不传时行为与本字段存在前逐字节一致（CLI / GUI 路径不受影响）。
export interface HarnessOverrides {
  sessionId?: string;
  /** 需要持久化 checkpoint（通道会话重启后要能续聊）。 */
  persistState?: boolean;
  permissionMode?: PermissionMode;
  permissionHandler?: PermissionRequestHandler;
  evolutionEnabled?: boolean;
  workspaceAvailable?: boolean;
  /** 直接指定验证器。 */
  verifier?: Verifier;
  /** 按最终 LLM adapter 构造验证器（通道档要 GUI 那档的 LLM 复核）。 */
  verifierFactory?: (llm: LLMAdapter) => Verifier;
}

/** createHarness 的返回形状（S2 起 steerBus = 转向队列入队口）。 */
export interface CliHarness {
  harness: import('./harness/Harness').Harness;
  tools: ToolAdapter | undefined;
  toolsDefs: import('./shared/types').ToolDefinition[];
  store: IStateStore | undefined;
  sessionId: string;
  projectPath: string;
  mcpClient: MCPClient | undefined;
  steerBus: SteerBus;
  /** S2 第五刀 — 控制面三件（起飞闸/折入账/收尾派发序），远程通道宿主的
   *  入队与读数口（入队面还空着，见构造处注释）。 */
  delegationControl: DelegationControlPlane;
  /** 折入账暴露口。注意：roundClose.foldSettle 目前是空桩（见构造处注释）——
   *  未来通道宿主往 folds 折入并调 dispatch 前，先把桩换成真缝，否则折入
   *  残差静默不派。 */
  folds: FoldInLedger;
  roundClose: RoundClosePlane;
  /** S2 第六刀 — 插话分类编排暴露口（见构造处注释：休眠，插话输入路未接）。 */
  interjectOrchestrator: InterjectOrchestrator;
}

async function createHarness(args: CliArgs, overrides: HarnessOverrides = {}): Promise<CliHarness> {
  const { adapter } = createAdapter(args);
  // P0-3 — 进化总开关与项目域在 createTools 之前算好：编排器（子代理记忆
  // 注入）与 Harness（父侧）用同一份，与 GUI 的 chat.ts 装配同构。
  const evolutionEnabled = overrides.evolutionEnabled ?? (process.env.PURE_EVOLUTION_DISABLED !== '1');
  // Project-scoped memory: resolved workspace (same as createTools uses).
  const projectPath = args.workspace
    ? (args.workspace.startsWith('/') ? args.workspace : `${process.cwd()}/${args.workspace}`)
    : process.cwd();
  // 9.2 — per-phase model routing (experimental): each phase naming a
  // different model rebuilds through createAdapter ({ ...args, model }), so
  // endpoint overrides, prompt budgets and provider quirks resolve exactly
  // like the main adapter. The main call above already validated the key, so
  // the phase rebuilds cannot hit the missing-key exit again.
  const phaseOverrides = phaseModelOverrides(args.phaseModels, args.model);
  const phaseAdapters = new Map<EngineLlmPhase, LLMAdapter>();
  for (const [phase, model] of Object.entries(phaseOverrides) as [EngineLlmPhase, string][]) {
    phaseAdapters.set(phase, createAdapter({ ...args, model }).adapter);
  }
  const llmFor = phaseAdapters.size > 0
    ? (phase: EngineLlmPhase) => phaseAdapters.get(phase)
    : undefined;
  if (llmFor) {
    const routed = Object.entries(phaseOverrides).map(([phase, model]) => `${phase}→${model}`).join(', ');
    process.stderr.write(`  ${dim('[phase-routing]')} ${dim(routed)}\n`);
  }
  const sessionId = overrides.sessionId ?? (args.resume || `session_${Date.now()}`);
  // S2 第一刀 — 转向队列同接：CLI/通道宿主从此拥有与 GUI 同一份投递/消费
  // 语义（SteerBus）。今天入队面还空着（CLI 没有插话输入路），行为与省略
  // takeSteerMessages 逐字节一致；随返回值暴露 bus，是远程遥控（手机经通道
  // 插话）的入队口。
  const steerBus = new SteerBus();
  // S2 第五刀 — 控制面同接（比照 steerBus 先例）：CLI 从此拥有与 GUI 同一份
  // 起飞闸/折入账/收尾派发序的实现。今天插话输入路仍空着（cliRepl 没有中途
  // 插话），FoldInLedger/RoundClosePlane 以中性读数构造并随返回值暴露——
  // 远程遥控（通道宿主）的入队口；dispatch 在 CLI 尚无调用方（回合收尾钩子
  // 未接），接通时再把读数换成真账。真正的引擎缝先接实：起飞闸
  // gateDelegations（委派批次出生时按区分词拦下取消/停支挂号）。
  const delegationControl = new DelegationControlPlane();
  const folds = new FoldInLedger();
  const roundClose = new RoundClosePlane({
    activityCount: () => 0,
    isStreaming: () => false,
    autoContinuePending: () => false,
    steerSettleRound: () => steerBus.settleRound(),
    delegationSettleRound: () => delegationControl.settleRound(),
    foldSettle: () => [],
    resumeFallback: () => delegationControl.settleResumesFallback(),
    settleReceipts: () => {},
    supersedeAutoContinue: () => {},
    reenter: () => {},
    narrateHandoff: () => {},
    timer: (fn, ms) => setTimeout(fn, ms),
  });
  // S2 第六刀 — 插话编排同接（比照 steerBus/roundClose 先例）：CLI 从此拥有
  // 与 GUI 同一份五分类裁决序/序列化链/思考窗寄存器的实现。今天插话输入路仍
  // 空着：宿主读数全部中性（流态恒 false、分支视图恒空、无 abort 把手），
  // 动作缝里 delegation/roundClose/steerRunningTurn（进 steerBus）是真缝，
  // send/abort/DOM 投影（ack/回显/收执）休眠——判定 LLM 未接（decideLlm 恒
  // null 时 decide 走字面安全网，休眠下不会被调用）。远程通道宿主接插话输入
  // 时，把这些缝换成真账即可；GUI 的 chat.ts 装配是权威参照。
  const interjectOrchestrator = new InterjectOrchestrator({
    decider: new DynamicInsertionCoordinator(),
    delegation: delegationControl,
    roundClose,
    isStreaming: () => false,
    isAborted: () => false,
    decideSignal: () => undefined,
    decideLlm: () => null,
    insertionContext: () => '（当前任务）',
    hasDelegationInFlight: () => false,
    runningBranches: () => [],
    stoppedBranches: () => [],
    coveringCandidates: () => [],
    branchLabel: (name) => name,
    // 续跑预检同接（第 2 期第三刀）：store 在下方才建（const store），缝延
    // 迟求值没问题；CLI 的 checkpoint 走 FSStore 落盘，重启后 probe 仍命中。
    probeResume: (name, args) => SubagentOrchestrator.probeResumeCheckpoint(store, sessionId, name, args),
    // send 缝休眠：cliRepl 没有单条消息入口（引擎整回合跑），插话输入路接通
    // 时把这里换成通道宿主的真发送缝；空函数保证休眠期零副作用。
    send: () => {},
    abort: () => {},
    stopNamedBranch: () => null,
    steerRunningTurn: (text, images, ack, target, cancel) => steerBus.enqueue({ message: { role: 'user', content: steerFrameText(text, cancel), images }, target, displayText: text, images }),
    queueInterjectTask: (text, images, displayText) => roundClose.queueTask({ text, images, displayText, ts: Date.now() }),
    foldInScopeAddition: () => {},
    answerMidrunQuestion: async () => {},
    askMidrunClarification: async () => {},
    deferTimedInsert: () => false,
    createAck: () => null,
    settleAck: () => {},
    discardAckRow: () => {},
    echoUser: () => {},
    logDecision: () => {},
  });
  const createdTools = await createTools(
    args.workspace,
    args.autoApprove,
    sessionId,
    args.mcpServers,
    args.mcpExcludedPrefixes,
    overrides.permissionMode,
    overrides.permissionHandler,
    evolutionEnabled,
  );
  const tools = createdTools.tools;
  let toolsDefs = createdTools.toolsDefs;
  const store = (args.resume || overrides.persistState) ? createStore(args) : undefined;

  // Default Harness plumbing (ContextEngine + rule-based verifier + default
  // hooks + default failure policy) shared with the GUI's CodingAgent — one
  // factory, no drift between the two entrypoints. Declared BEFORE the
  // subagent orchestrator so both the harness AND the subagents reuse the same
  // escalating failure policy.
  const plumbing = createDefaultHarnessConfig({
    llm: adapter,
    promptBudget: promptBudgetForProvider(args.customProviders, args.provider, args.model, args.providerOverrides),
    toolsProvider: () => tools?.getTools() ?? toolsDefs,
    // E1.2 — preload the cross-session failure history from error_pattern
    // memories so already-seen traps escalate the failure ladder immediately.
    failureHistory: failureHistoryFromMemories(memoryStore.list({ type: 'error_pattern', activeOnly: true })),
  });

  // 起飞闸的角色集：与下面注册进 orchestrator/tools 的子代理名单同源（gate
  // 只按角色名认委派批次）。子代理面关着时恒空 = gate 恒放行。
  const cliSubagentNames = new Set<string>();
  if (tools && tools instanceof ToolRegistry) {
    // Full delegation surface, mirroring the GUI: both the built-in reviewers
    // and the coding roles (task_planner / code_editor / researcher /
    // ui_designer / deep_thinker / bash_executor), so the CLI can satisfy the
    // multi_agent protocol instead of only being able to review/audit.
    // 阶段 13.2 — declarative roles from ~/.pure/subagents/*.json join the
    // surface too (compile once at startup; a broken file warns and is skipped).
    const externalRoles = (() => {
      const dir = process.env.PURE_SUBAGENTS_DIR
        ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.pure', 'subagents');
      let sources: { file: string; text: string }[] = [];
      try {
        // 旁挂账（`<role>.trial.json`）不是 manifest。它没有 `name` 字段，喂给
        // compileExternalSubagents 会每次启动都吐一行假告警，还把这个角色算两次。
        // Rust 侧的扫描早就排除了它；这份 node:fs 扫描是第三份，得跟上。
        sources = readdirSync(dir)
          .filter(isExternalSubagentManifest)
          .sort()
          .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }));
      } catch {
        return { defs: [], errors: [] as string[] };
      }
      const reserved = [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES].map((d) => d.name);
      return compileExternalSubagents(sources, reserved);
    })();
    for (const line of externalRoles.errors) {
      process.stderr.write(`  ${yellow('[external-subagents]')} ${dim(line)}\n`);
    }
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
      // 阶段 13.3 — persona overlays (~/.pure/personas/*.overlay.md) merge into
      // the matching role's system prompt at spawn time.
      personaOverlays: loadCliPersonaOverlays(externalRoles.defs),
      // P0-3 两柱焊点 — 子代理记忆注入：同一份 CLI 记忆库 + 工作区项目域 +
      // 进化总开关（函数顶算好，与 Harness 那份同源零漂移）。
      memory: memoryStore,
      memoryProjectPath: projectPath,
      evolutionEnabled,
    });
    for (const def of [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES, ...externalRoles.defs]) {
      orchestrator.register(def);
      tools.register(def);
      cliSubagentNames.add(def.name);
    }
    tools.setSubagentExecutor(orchestrator);
    // Model-visible tools = public tools + subagent tools, so the parent LLM
    // can actually delegate (getTools() alone filters subagents out).
    toolsDefs = [...tools.getTools(), ...tools.getSubagentTools()];
  }

  // User hooks (hooks.json): only the global layer (~/.pure) is loaded for
  // now. The workspace layer is project-provided and waits for its permission
  // gate (first-enable confirmation) before it may run anything.
  const userHooks = await loadUserHooks({ globalUserRoot: PURE_DIR });
  // 2.3: every hook — even from the trusted global layer — passes the gate on
  // first use. "Always allow" is cached per command text in
  // ~/.pure/hooks-approved.json; a session answer lasts the session only.
  // Skipped (unapproved) hooks are logged to stderr, never silent.
  const hookGate = createCliHookGate(await loadHookApprovals(PURE_DIR));
  const userHookRunner = createGatedUserHookRunner(
    createNodeUserHookRunner({ cwd: projectPath }),
    hookGate,
    (hook, event) => process.stderr.write(`  ${dim('[hooks]')} ${dim(`unapproved ${event} hook skipped: ${hook.command}`)}\n`),
  );

  const harness = new Harness({
    sessionId,
    llm: adapter,
    llmFor,
    tools,
    toolsDefs,
    budget: DEFAULT_BUDGET,
    stateStore: store,
    memory: memoryStore,
    projectPath,
    workspaceAvailable: overrides.workspaceAvailable ?? true,
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
    // 通道来源没有人在旁边看输出，验证是唯一的质量闸 —— 由 overrides 换成
    // GUI 那档（含 LLM 复核），延迟换正确性（设计文档 §5.2）。
    verifier: overrides.verifier ?? overrides.verifierFactory?.(adapter) ?? plumbing.verifier,
    // Lifecycle hooks + escalating failure recovery policy.
    hooks: plumbing.hooks,
    userHooks,
    userHookRunner,
    failurePolicy: plumbing.failurePolicy,
    // P0 棘轮 — 进化总开关的 CLI 形态（GUI 走 config.skills.evolution）。
    // 控归因记账、后台编排与 E1.1 反思器（P0-1）及子代理记忆注入（P0-3）；
    // 函数顶算好，与编排器同一份。
    evolutionEnabled,
    // S2 — 引擎在 THINK 边界拉转向队列（空队列 = 与省略时行为一致）。
    takeSteerMessages: (recipient) => steerBus.drain(recipient),
    // S2 第五刀 — 委派批次出生时过起飞闸：取消/停支挂号按区分词拦下（CLI
    // 今天无插话输入路，挂号簿恒空 = 与省略时行为一致；通道宿主经暴露的
    // delegationControl 挂号即生效）。
    gateDelegations: async (calls) => delegationControl.gate(calls, cliSubagentNames),
  });

  return { harness, tools, toolsDefs, store, sessionId, projectPath, mcpClient: createdTools.mcpClient, steerBus, delegationControl, folds, roundClose, interjectOrchestrator };
}

export { memoryStore, learnFromInput, cliSubagentProgress, createTools, createStore, createHarness, printToolCorrectionHints, distillSkillFromMemory };
