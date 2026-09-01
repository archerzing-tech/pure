// src/shared/types.ts
// Canonical types per pure Spec §4 — single source of truth.

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
  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean } | undefined;
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

export interface EngineContext {
  llm: LLMAdapter;
  tools?: ToolAdapter;
  toolsDefs: ToolDefinition[];
  /** Recompute the LLM-visible tool list before each THINK iteration so
   * dynamically connected MCP servers become usable without restarting the turn. */
  toolsDefsProvider?: () => ToolDefinition[];
  verifier?: { evaluate(params: { output: string; context: Message[] }): Promise<{ passed: boolean; feedback?: string; evidence?: VerificationEvidence[] }> };
  budget: BudgetConfig;
  signal?: AbortSignal;
  hooks?: HookRouter;
  failurePolicy?: FailurePolicy;
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
  | { type: 'Error'; payload: { code: string; message: string; stateType: AgentStateType; recoverable: boolean; recoveryAction?: 'retry' | 'reflect' | 'skip' | 'terminate' }; timestamp: number }
  | { type: 'Completed'; payload: { finalOutput?: string; isComplete: boolean; interrupted: boolean; turnCount: number; messages?: Message[]; usage?: TokenUsage; verification?: VerificationSummary }; timestamp: number }
  | { type: 'Interrupted'; payload: { reason: string; lastState?: AgentStateType; completedSteps: string[]; messages?: Message[]; turnCount?: number }; timestamp: number };
