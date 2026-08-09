// src/shared/types.ts
// Canonical types per pure Spec §4 — single source of truth.

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
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
  complete(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse>;
}

export interface ToolAdapter {
  execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean } | undefined;
  getTools(): ToolDefinition[];
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
}

export interface RunInput {
  sessionId: string;
  systemPrompt: string;
  userPrompt: string;
  budget: BudgetConfig;
}

export interface RunContinueInput {
  sessionId: string;
  newUserPrompt: string;
  messages: Message[];
  budget: BudgetConfig;
}

export interface EngineContext {
  llm: LLMAdapter;
  tools?: ToolAdapter;
  toolsDefs: ToolDefinition[];
  verifier?: { evaluate(params: { output: string; context: Message[] }): Promise<{ passed: boolean; feedback?: string }> };
  budget: BudgetConfig;
  signal?: AbortSignal;
  hooks?: HookRouter;
  failurePolicy?: FailurePolicy;
  lockManager?: LockManager;
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
  | 'project_convention';

export interface MemoryLesson {
  symptom: string;
  rootCause: string;
  recoveryPath: string;
  verification: string;
  avoidNextTime: string;
  tools?: string[];
}

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  timestamp: number;
  sessionId: string;
  projectPath: string; // 记忆按项目隔离
  decayScore?: number; // 时间衰减分数（1.0 = 新，0.0 = 已遗忘）
  lesson?: MemoryLesson;
  dedupeKey?: string;
}

export interface MemorySearchOptions {
  type?: MemoryType;
  k?: number; // 返回条数，默认 5
  projectPath?: string; // 限定项目，默认当前项目
}

export interface IMemoryStore {
  /** 写入一条记忆（Engine/Harness 在关键事件时调用） */
  add(entry: Omit<MemoryEntry, 'id'>): Promise<string>;

  /** 检索相关记忆（PromptComposer 在会话开始时调用） */
  search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]>;

  /** 按会话批量清理 */
  forget(sessionId: string): Promise<void>;

  /** 衰减旧记忆：将超过 olderThan 的记忆 decayScore 减半 */
  decay(olderThan: number): Promise<void>;
}

// EngineEvent union
export type EngineEvent =
  | { type: 'TokenDelta'; payload: { content: string; stateId: string; isToolCall: boolean; toolCallBuffer?: string; toolCallName?: string; toolCallId?: string }; timestamp: number }
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
  | { type: 'Completed'; payload: { finalOutput?: string; isComplete: boolean; interrupted: boolean; turnCount: number; messages?: Message[]; usage?: TokenUsage }; timestamp: number }
  | { type: 'Interrupted'; payload: { reason: string; lastState?: AgentStateType; completedSteps: string[]; messages?: Message[]; turnCount?: number }; timestamp: number };
