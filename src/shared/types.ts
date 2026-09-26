// src/shared/types.ts
// Canonical types per pure Spec §4 — single source of truth.

import type { UserHooksConfig } from './userHooks';
import type { UserHookRunner } from './userHookRunner';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface MessageAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  kind: 'text' | 'image' | 'doc' | 'binary';
  truncated?: boolean;
}

export interface MessageImage {
  /** data: URL for the vision request and restored transcript thumbnail. */
  dataUrl: string;
  /** MIME type used by provider adapters and the UI. */
  mimeType: string;
  /** Original/persisted temporary filename. */
  name?: string;
  /** Absolute path in the application temporary space. */
  path?: string;
  sizeBytes?: number;
}

export interface Message {
  role: Role;
  content: string;
  /** Internal recovery instructions are context for the agent, not a new user request. */
  internal?: boolean;
  /** Images attached to this user message; adapters map these to native image blocks. */
  images?: MessageImage[];
  attachments?: MessageAttachment[];
  toolCallId?: string;
  toolName?: string;
  name?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  index: number;
  function: { name: string; arguments: string };
}

export interface ToolResult {
  id: string;
  toolName: string;
  result?: unknown;
  error?: string;
  success: boolean;
  duration: number;
  /** 分支中断标识（第 2 期）：用户点名暂停/停掉一支子 agent 时，这次委派
   *  不算失败（success 必须为 true——false 会把 "Error: undefined" 喂给父
   *  模型、污染失败策略、并让最终汇总把"已暂停"写成"失败了"），也不能当
   *  可复用的成功去重（同参重派是断点续跑的入口，吞掉就永远续不上）。
   *  'paused' = 暂停可续；'stopped' = 用户取消，不计入任务。 */
  outcome?: 'paused' | 'stopped';
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * A generated image delivered to the UI by the generate_image tool. `dataUrl`
 * is either a base64 `data:image/...;base64,...` payload or an https URL the
 * provider returned; it renders in the tool row as an <img> card. The LLM
 * never sees these — only the compact metadata summary in ToolResult.result.
 */
export interface GeneratedImage {
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
}

export type LLMChunk =
  | { type: 'content'; content: string }
  // Model-internal reasoning/chain-of-thought streamed separately from the
  // visible answer (DeepSeek/Qwen/GLM `reasoning_content`, OpenAI `reasoning`).
  // Never folded into `content`, never persisted as assistant text.
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call_delta'; index: number; name?: string; arguments?: string }
  | { type: 'tool_call'; index: number; id: string; name: string; arguments: string }
  // Billing usage reported by the provider (OpenAI-style `usage` on the final
  // stream chunk; DeepSeek `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`).
  // Yielded once per stream so the engine can aggregate per-turn totals.
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; content: string; toolCalls: ToolCall[] };

/** Normalized per-request token usage (provider fields mapped into one shape). */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  /** Prompt tokens served from the provider's context cache (DeepSeek `prompt_cache_hit_tokens`). */
  cacheHitTokens?: number;
  /** Prompt tokens that missed the cache (DeepSeek `prompt_cache_miss_tokens`). */
  cacheMissTokens?: number;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
}

export interface LLMAdapter {
  stream(
    messages: Message[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<LLMChunk, void, void>;
  complete(messages: Message[], tools: ToolDefinition[], signal?: AbortSignal): Promise<LLMResponse>;
}

import type { WorkspaceSnapshotPort } from './workspaceSnapshot';

export interface ToolAdapter {
  execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
  /** `timeoutMs` lets a tool declare its own execution budget — the engine's
   * generic tool cap yields to it. Subagent delegations bracket a whole
   * nested agent loop, so they declare the budget their definition already
   * carries instead of being strangled by the generic cap. `interruptible:
   * false` (1c) exempts a tool from the pause grace-kill: after a pause it
   * drains to its natural end like the old pause semantics, for work that
   * must not be interrupted mid-write. */
  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean; timeoutMs?: number; interruptible?: boolean } | undefined;
  getTools(): ToolDefinition[];
  getSnapshotPort?(): WorkspaceSnapshotPort | undefined;
}

export type AgentStateType = 'THINK' | 'ACT' | 'OBSERVE' | 'VERIFY' | 'TERMINATE';

export interface BudgetSnapshot {
  turns: { used: number; max: number };
  tokens: { used: number; max: number };
  iterations: { used: number; max: number };
  toolCalls: { used: number; max: number };
  elapsed: number;
}

export interface BudgetConfig {
  maxTurns: number;
  maxTotalTokens: number;
  maxExecutionTime: number;
  warningThreshold: number;
  graceTurns: number;
  /**
   * Optional HARD caps. When omitted (0 / undefined) the soft limits above only
   * emit a warning and the run CONTINUES (elastic budget) — the agent is never
   * hard-stopped mid-task by a step / token / time limit. Set a hard cap only
   * where a deterministic ceiling is required (e.g. evaluations).
   */
  hardMaxTurns?: number;
  hardMaxTokens?: number;
  hardMaxTime?: number;
  /**
   * Ceiling for ONE LLM stream round to produce its FIRST chunk (any token /
   * reasoning delta / tool-call delta counts). A connection that accepts but
   * never streams is a queued or dead provider, not slow generation —
   * reasoning models emit reasoning_content deltas as they think, so real
   * work flips this clock within seconds. Default 5 min (parent conversations
   * tolerate long queues); subagent budgets tighten it (deriveSubagentBudget)
   * so a stalled fan-out sibling fails fast into the retry policy instead of
   * holding the whole batch as silent gray cards.
   */
  firstTokenTimeoutMs?: number;
}

export interface RunInput {
  sessionId: string;
  systemPrompt: string;
  userPrompt: string;
  images?: MessageImage[];
  budget: BudgetConfig;
  /** Optional persistence: when set, the engine saves a checkpoint on
   * Completed/Interrupted so a re-run of the same sub-task (stable sessionId)
   * can continue instead of starting fresh. Used by SubagentOrchestrator. */
  stateStore?: IStateStore;
}

export interface RunContinueInput {
  sessionId: string;
  newUserPrompt: string;
  images?: MessageImage[];
  messages: Message[];
  budget: BudgetConfig;
}

export type VerificationStatus = 'passed' | 'failed' | 'incomplete' | 'not_run';

export interface VerificationEvidence {
  id: string;
  checkName: string;
  status: VerificationStatus;
  summary: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  output?: string;
  source: 'engine' | 'command' | 'quality_gate';
  timestamp: number;
}

export interface VerificationSummary {
  status: VerificationStatus;
  evidence: VerificationEvidence[];
}

/** E0.3 — engine phases that may select their own LLM adapter. THINK is the
 * main reasoning stream; HANDOVER is the policy-stop wrap-up round (never
 * streams to the user, so it is cheap-model-friendly); REFLECT is reserved
 * for the post-turn lesson reflector (E1.1), which runs outside the loop.
 * VERIFY routes through ctx.verifier, not an adapter. */
export type EngineLlmPhase = 'THINK' | 'HANDOVER' | 'REFLECT';

export interface EngineContext {
  llm: LLMAdapter;
  /** E0.3 — per-phase adapter override. Return the adapter for a phase, or
   * undefined to fall back to `llm`. Absent ⇒ every phase uses `llm` and the
   * engine is byte-identical to the single-adapter behavior. The reflector
   * (E1.1) reads REFLECT to reach its cheap model. */
  llmFor?: (phase: EngineLlmPhase) => LLMAdapter | undefined;
  /** Mid-run steering (插话重构): user messages typed while the turn was busy
   *  inside a tool round. The engine drains this queue at each THINK boundary
   *  — the one point where appending keeps the message protocol clean (every
   *  tool result is already in; a user turn must never sit between an
   *  assistant tool_call and its result) — and reconciles it in the very next
   *  reasoning round. Return-and-clear; absent ⇒ no steering channel.
   *  1a 定向投递（对话智能升格）: the caller identifies itself — a subagent
   *  engine's ctx is wrapped by the orchestrator with its branch identity, a
   *  bare call is the parent engine. The host closure filters the queue by
   *  recipient so a user remark addressed at one branch reaches THAT branch
   *  (and only it) while broadcast remarks reach everyone working. */
  takeSteerMessages?: (recipient?: import('./steerTargeting').SteerRecipient) => Message[] | Promise<Message[]>;
  /** 1c 暂停真即时 — how long an in-flight tool keeps running after a pause
   *  before the abort is forwarded to it (default PAUSE_TOOL_GRACE_MS).
   *  Injectable so tests can exercise the grace state machine in milliseconds. */
  pauseToolGraceMs?: number;
  /** 1c 升级硬停 — second-channel signal the host can abort to SKIP the
   *  remaining pause grace and kill in-flight tools immediately (still
   *  carrying the pause reason, so accounting stays "paused"). The primary
   *  ctx.signal is already aborted by then and per spec a second abort() on
   *  it is a no-op — this channel is what makes Esc-twice = hard stop real. */
  hardStopSignal?: AbortSignal;
  /** Host-owned actions for this round (代执行回合, 2026-09-22): when this
   *  returns calls at a THINK boundary, the engine skips the model call for
   *  that round and dispatches these calls through the NORMAL ACT pipeline —
   *  ToolStarted events, runBatch, ToolResult, transcript pairing. The point
   *  of the seam: a mid-run insertion that must execute (e.g. a scope
   *  addition while parallel delegations are in flight) becomes an ordinary
   *  delegation round, so cards/trace/persistence render natively and the
   *  ordering guarantee is structural — the model is first consulted only
   *  AFTER the addition's result is already in its transcript. Absent or
   *  empty ⇒ the model is consulted normally. */
  takeSyntheticToolCalls?: () => ToolCall[] | Promise<ToolCall[]>;
  /** 委派起飞闸（2026-09-26 用户实测）：插话落在委派发生之前时，取消型
   *  插话找不到可停的支——点名路（abortBranch）无支可点，折入路只守汇报
   *  步、不守还没出生的支。宿主在每批工具调用起飞前拿到整批调用（完整候
   *  选集——区分词匹配器看到全部兄弟任务书，绝不会单支误杀），返回要拦下
   *  的 callId 与原因；协调器给这些调用直接发「用户已取消」的合成结果，
   *  分支根本不出生。Absent ⇒ 无闸（CLI / 子代理引擎照旧）。 */
  gateDelegations?: (calls: ToolCall[]) => Promise<Array<{ callId: string; reason: string }>>;
  /**
   * Live subagent interior activity as FIRST-CLASS engine events (2026-09-19).
   * CodingAgent maps the orchestrator's progress-sink callbacks onto this
   * feed; during each tool-execution batch the engine subscribes a reader and
   * re-emits everything as `SubagentActivity` events, namespaced by the
   * delegation toolCallId (`callId`). GUI/CLI/evals therefore see what each
   * parallel subagent is doing without the ephemeral side channel. Absent ⇒
   * no subagent events (CLI, nested subagent runs) — behavior unchanged.
   */
  subagentEvents?: { subscribe(): AsyncQueueLike<SubagentActivityEvent> };
  tools?: ToolAdapter;
  toolsDefs: ToolDefinition[];
  /** Recompute the LLM-visible tool list before each THINK iteration so
   * dynamically connected MCP servers become usable without restarting the turn. */
  toolsDefsProvider?: () => ToolDefinition[];
  verifier?: { evaluate(params: { output: string; context: Message[] }): Promise<{ passed: boolean; feedback?: string; evidence?: VerificationEvidence[] }> };
  budget: BudgetConfig;
  signal?: AbortSignal;
  hooks?: HookRouter;
  /** User hooks (hooks.json) run around tool calls — see userHookRunner.ts.
   * Hooks run only when BOTH fields are set: a renderer (no process spawn)
   * omits the runner and the coordinator skips every hook. */
  userHooks?: UserHooksConfig;
  userHookRunner?: UserHookRunner;
  failurePolicy?: FailurePolicy;
  /** GUI-supplied "is the task actually done?" check, consulted once the THINK
   *  round produced no tool calls and VERIFY passed — just before TERMINATE.
   *  Return a directive string to inject an internal user message and re-enter
   *  THINK (the model prematurely stopped calling tools); return false to end
   *  the turn normally. CLI omits it, keeping its behavior unchanged. */
  continueGuard?: (args: { content: string; turnCount: number; guardContinues: number }) => string | false;
  lockManager?: LockManager;
  /** Nesting depth of the current run: 0 = top-level parent, 1 = a subagent
   * spawned by the parent, etc. Set by SubagentOrchestrator; used to enforce
   * a recursion budget (see maxDepth). */
  depth?: number;
  /** Hard cap on nested delegation depth (default 1 = single-level). When
   * depth would exceed maxDepth, the orchestrator refuses to spawn. */
  maxDepth?: number;
}

export interface LockManager {
  acquireRead(path: string): Promise<void>;
  acquireWrite(path: string): Promise<void>;
  release(path: string): void;
}

// ── HookRouter types ──

export type HookEventType =
  | 'before_think'
  | 'after_think'
  | 'before_act'
  | 'after_act'
  | 'before_verify'
  | 'after_verify'
  | 'on_budget_warning';

export interface HookResult {
  action: 'continue' | 'abort' | 'modify' | 'retry';
  reason?: string;
  hint?: string;
  modifiedMessages?: Message[];
}

export type HookEventHandler = (
  event: HookEventType,
  context: { messages: Message[]; turnCount: number; phase: AgentStateType },
) => Promise<HookResult> | HookResult;

export interface HookRouter {
  register(hookType: HookEventType, handler: HookEventHandler): void;
  dispatch(hookType: HookEventType, ctx: { messages: Message[]; turnCount: number; phase: AgentStateType }): Promise<HookResult[]>;
}

// ── FailurePolicy types ──

export interface FailureRecord {
  type: 'verify_failure' | 'tool_error' | 'llm_error';
  message: string;
  turnNumber: number;
  toolName?: string;
}

export type FailureAction =
  | { kind: 'retry'; hint: string }
  | { kind: 'reflect'; hint: string }
  | { kind: 'degrade'; reason: string }
  | { kind: 'stop'; reason: string };

export interface FailurePolicy {
  decide(failures: FailureRecord[]): FailureAction;
}

/** E1.2 — one cross-session failure record, aggregated per (tool, error class). */
export interface FailureHistoryEntry {
  /** How many past-session memories recorded this tool failing with this class. */
  count: number;
  /** The first recorded lesson text (empty when none). */
  lesson: string;
}

/** E1.2 — synchronous snapshot of cross-session failure experience. Loaded
 * ONCE per session from the memory store (a list query, not per-decision),
 * so FailurePolicy.decide() keeps its synchronous signature and the policy
 * core stays stateless and testable. */
export interface FailureHistory {
  lookup(toolName: string | undefined, errorClass: string): FailureHistoryEntry;
}

export interface AgentResult {
  finalOutput?: string;
  isComplete: boolean;
  interrupted: boolean;
  turnCount: number;
  messages: Message[];
  verification?: VerificationSummary;
}

// ── v0.4: Persistence types ──

export interface Checkpoint {
  version: number;
  label: string;
  state: AgentLoopState;
  createdAt: number;
}

export interface AgentLoopState {
  messages: Message[];
  turnCount: number;
}

export interface IStateStore {
  loadSession(sessionId: string): { state: AgentLoopState; checkpoints: Checkpoint[] } | null;
  saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

// ── v0.10: Cross-session long-term memory (Adapter Layer 设计文档 §12) ──

export type MemoryType =
  | 'user_preference'
  | 'error_pattern'
  | 'successful_pattern'
  | 'project_convention'
  | 'procedure'
  | 'tool_preference';

export interface MemoryLesson {
  symptom: string;
  rootCause: string;
  recoveryPath: string;
  verification: string;
  avoidNextTime: string;
  tools?: string[];
  /** E1.1 反思器：lesson 引用的本轮工具调用哈希（证据目录内的 id）。
   *  模板 lesson 不写；反思 lesson 拿不出有效证据时 confidence 强制 low。 */
  evidence?: string[];
}

// ── v1.5 智能进化记忆（Adapter Layer 设计文档 §12.8）──
// 健康分从单一时间衰减扩展为多维（时间 × 可信度 × 使用频率 × 进化状态），
// 生命周期为 活跃 → 降级 → 休眠 → 删除，新策略可取代旧策略。纯规则实现见
// src/adapter/memory/evolution.ts。

export type MemoryLifecycle = 'active' | 'degraded' | 'dormant';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  timestamp: number;
  sessionId: string;
  projectPath: string; // 记忆按项目隔离
  /** 平台维度（tool_preference 专用，也兼容其他类型）：process.platform 风格
   *  （darwin / win32 / linux / unknown）。注入时按当前平台过滤，保证"在
   *  本平台验证过好用的工具"只在本平台被优先。 */
  platform?: string;
  /** 综合健康分（1.0 = 新/最有用，0.0 = 已遗忘）。由 evolution.ts 从
   *  时间 × 可信度 × 使用频率 × 进化状态多维计算，decay() 定期重算。 */
  decayScore?: number;
  /** 进化生命周期：active（活跃）→ degraded（降级）→ dormant（休眠，不进检索）→ 删除。 */
  lifecycle?: MemoryLifecycle;
  /** 使用频率：被 search() 命中并注入提示词的次数（每次检索 +1）。 */
  hitCount?: number;
  /** 最近一次被检索的时间（与 hitCount 共同构成使用频率/新鲜度维度）。 */
  lastUsedAt?: number;
  /** 被哪条新记忆取代（进化：新策略替代旧策略后，旧条目打此标记加速降级）。 */
  supersededBy?: string;
  lesson?: MemoryLesson;
  dedupeKey?: string;
  /** E1.1 防幻觉纪律：反思器产出的可信度。'low' = 根因没有本轮证据支撑，
   *  注入端（Harness.composeMemoryPrompt）默认跳过，evolution 健康分减半。 */
  confidence?: 'high' | 'low';
}

export interface MemorySearchOptions {
  type?: MemoryType;
  k?: number; // 返回条数，默认 5
  projectPath?: string; // 限定项目，默认当前项目
  /** 只返回匹配该平台的条目（tool_preference 按平台隔离用）。 */
  platform?: string;
}

/**
 * 机器级全局作用域哨兵：作为 tool_preference 条目的 projectPath 存储，表示该
 * 记忆不归属任何项目（"这台机器上什么工具能用/想用"，任何项目都成立）。
 * 机器级条目独立存储（FS：独立 hash 目录；localStorage：独立 projectPath），
 * 常驻注入时读取此作用域，保证跨项目可见。
 */
export const GLOBAL_MEMORY_SCOPE = '__machine__';

export interface MemoryListOptions {
  /** 限定项目；缺省 = store 默认范围（FS：默认项目；localStorage：全部）。 */
  projectPath?: string;
  /** 只返回该类型的条目。 */
  type?: MemoryType;
  /** 只返回匹配该平台（platform 字段）的条目。 */
  platform?: string;
  /** 只返回未休眠（健康分 > dormantMax）的条目 —— 机器级常驻注入用。 */
  activeOnly?: boolean;
}

export interface IMemoryStore {
  /** 写入一条记忆（Engine/Harness 在关键事件时调用） */
  add(entry: Omit<MemoryEntry, 'id'>): Promise<string>;

  /** 检索相关记忆（Harness 会话开始时注入 <session_memory>） */
  search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]>;

  /** 枚举记忆（GUI 记忆面板、机器级常驻注入用）。无查询语义、不记录命中。 */
  list(opts?: MemoryListOptions): MemoryEntry[];

  /** 按会话批量清理 */
  forget(sessionId: string): Promise<void>;

  /** 按 id 删除单条记忆（GUI 记忆面板的逐条删除）。返回是否真的删除了。 */
  removeById(id: string): Promise<boolean>;

  /** 衰减旧记忆：将闲置超过 olderThan 的记忆按多维健康分重算，逐级降级，
   *  跌穿删除线或休眠超宽限期即删除（见 evolution.ts） */
  decay(olderThan: number): Promise<void>;

  /** 记录检索命中：被 search() 返回的记忆 hitCount+1、lastUsedAt 刷新 ——
   *  使用频率维度的信号。实现须廉价持久化（FS：内存缓存、decay 时落盘；
   *  localStorage：直接写回）。 */
  recordHits(entries: MemoryEntry[]): Promise<void>;
}

// EngineEvent union

/** The reader the engine pulls subagent events from during a tool batch
 * (shared/asyncQueue.ts AsyncQueue conforms; spelled as an interface so
 * shared/types.ts does not import the implementation). */
export interface AsyncQueueLike<T> extends AsyncIterableIterator<T> {
  drainAvailable(): T[];
  close(): void;
}

/** One subagent interior event riding the ENGINE event stream (first-class,
 * persisted-adjacent, consumed by GUI/CLI/evals alike). `callId` is the
 * delegation tool call that spawned the subagent — the namespace key that
 * maps events back to the right transcript card. Lean on purpose: the rich
 * activity-panel model stays in coding-agent/SubagentOrchestrator. */
export interface SubagentActivityEvent {
  /** Delegation toolCallId that spawned this subagent. */
  callId: string;
  /** Short quotable run id (ag-xxxxxxxx) shown on cards and error lines —
   *  the locator when one specific run needs to be found or reported. */
  agentId?: string;
  agentName: string;
  agentRole?: string;
  kind: 'start' | 'state' | 'tool' | 'done' | 'error' | 'paused' | 'cancelled' | 'steered' | 'waiting';
  state?: string;
  /** The tool the subagent invoked (kind 'tool'). */
  toolName?: string;
  toolState?: 'running' | 'completed';
  toolArgsHint?: string;
  lifecycle?: string;
  success?: boolean;
  error?: string;
  /** Truncated delegated ask (args.prompt/task/…) for context on the line. */
  summary?: string;
  durationMs?: number;
  tokensUsed?: number;
}

export type EngineEvent =
  | { type: 'TokenDelta'; payload: { content: string; stateId: string; isToolCall: boolean; toolCallBuffer?: string; toolCallName?: string; toolCallId?: string }; timestamp: number }
  | { type: 'ToolStarted'; payload: { toolName: string; toolCallId: string; toolCallArgs?: string }; timestamp: number }
  // Reasoning/chain-of-thought deltas, surfaced so the GUI can render a live
  // "thinking" card (animation while collapsed, streaming text when expanded).
  | { type: 'ReasoningDelta'; payload: { content: string; stateId: string }; timestamp: number }
  | { type: 'StateChange'; payload: { from: AgentStateType; to: AgentStateType; stateId: string; reason?: string }; timestamp: number }
  | { type: 'ToolResult'; payload: { toolName: string; result: ToolResult; duration: number; toolCallId: string }; timestamp: number }
  | { type: 'YieldControl'; payload: { turnNumber: number; budget: BudgetSnapshot }; timestamp: number }
  // v0.10 §12.3 — surfaced so the Harness can persist error_pattern memories:
  // the engine calls FailurePolicy.decide() at every failure point and yields
  // the resulting action here. kind 'stop' → write error_pattern immediately;
  // kind 'retry' → Harness remembers the failure, writes error_pattern once
  // the session completes successfully ("retry 且最终成功").
  | { type: 'FailurePolicyDecision'; payload: { action: FailureAction; failure: FailureRecord; turnNumber: number }; timestamp: number }
  | { type: 'BudgetWarning'; payload: { exhausted: boolean; reason: string; remaining: { turns: number; tokens: number; time: number }; gracePeriodEnds: number }; timestamp: number }
  // Mid-run steering (插话重构): user messages queued while tools were running
  // were appended at the THINK boundary and ride into the next reasoning
  // round. Observability only — the user's words themselves render via the
  // chat surface; this event lets tests and observers pin down the round
  // where steering took effect.
  | { type: 'SteerInjected'; payload: { count: number; turnNumber: number }; timestamp: number }
  // Live subagent interior activity (parallel multi-agent): forwarded from the
  // orchestrator's progress sink through ctx.subagentEvents while the engine
  // awaits the tool batch, namespaced by the delegation toolCallId. Between a
  // delegation's ToolStarted and its ToolResult the conversation card can show
  // what the subagent is actually doing instead of a silent spinner.
  | { type: 'SubagentActivity'; payload: SubagentActivityEvent; timestamp: number }
  | { type: 'Error'; payload: { code: string; message: string; stateType: AgentStateType; recoverable: boolean; recoveryAction?: 'retry' | 'reflect' | 'skip' | 'terminate' }; timestamp: number }
  | { type: 'Completed'; payload: { finalOutput?: string; isComplete: boolean; interrupted: boolean; turnCount: number; messages?: Message[]; usage?: TokenUsage; verification?: VerificationSummary }; timestamp: number }
  | { type: 'Interrupted'; payload: { reason: string; lastState?: AgentStateType; completedSteps: string[]; messages?: Message[]; turnCount?: number }; timestamp: number };
