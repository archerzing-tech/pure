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
  | { type: 'tool_call_delta'; index: number; name?: string; arguments?: string }
  | { type: 'tool_call'; index: number; id: string; name: string; arguments: string }
  | { type: 'done'; content: string; toolCalls: ToolCall[] };

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
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

// EngineEvent union
export type EngineEvent =
  | { type: 'TokenDelta'; payload: { content: string; stateId: string; isToolCall: boolean; toolCallBuffer?: string }; timestamp: number }
  | { type: 'StateChange'; payload: { from: AgentStateType; to: AgentStateType; stateId: string; reason?: string }; timestamp: number }
  | { type: 'ToolResult'; payload: { toolName: string; result: ToolResult; duration: number; toolCallId: string }; timestamp: number }
  | { type: 'BudgetWarning'; payload: { exhausted: boolean; reason: string; remaining: { turns: number; tokens: number; time: number }; gracePeriodEnds: number }; timestamp: number }
  | { type: 'Error'; payload: { code: string; message: string; stateType: AgentStateType; recoverable: boolean; recoveryAction?: 'retry' | 'reflect' | 'skip' | 'terminate' }; timestamp: number }
  | { type: 'Completed'; payload: { finalOutput?: string; isComplete: boolean; interrupted: boolean; turnCount: number; messages?: Message[] }; timestamp: number }
  | { type: 'Interrupted'; payload: { reason: string; lastState?: AgentStateType; completedSteps: string[] }; timestamp: number };
