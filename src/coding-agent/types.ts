// src/coding-agent/types.ts
// v0.2 — Coding Agent layer shared types (includes Subagent types).

import type { ToolDefinition } from '../shared/types';

export type PermissionMode = 'YOLO' | 'NORMAL' | 'PLAN' | 'DONT_ASK';

export interface PermissionContext {
  tool: string;
  command?: string;
  description?: string;
  isRead: boolean;
  riskLevel?: 'low' | 'medium' | 'high';
  serverName?: string;
  /** 只读工具的无副作用参数哈希(历史字段:缓存键已改为按工具名,不再使用)。 */
  argsHash?: string;
  /** 写工具的目标文件路径(用于确认弹窗的内容预览)。 */
  path?: string;
  /** 写工具将要写入/替换的内容预览(write_file: 全文;edit_file: old→new)。 */
  contentPreview?: string;
  /** 可中止信号:当运行被取消(如 CLI 中用户按 Ctrl+C)时,进行中的确认应立即以拒绝结束。 */
  signal?: AbortSignal;
}

export interface PermissionDecision {
  allowed: boolean;
  autoApproved?: boolean;
  reason?: string;
  /** 用户选择"始终允许(本次会话)"时置位,PermissionManager 会缓存该决定。 */
  remember?: boolean;
}

export interface PlanSubstep {
  id: string;
  action: string;
  description: string;
  expectedOutcome: string;
}

export interface PlanStep {
  id: string;
  action: string;
  description: string;
  expectedOutcome: string;
  /** Whether this plan needs a visible Todo list for clear progress feedback. */
  todosRequired?: boolean;
  /** Concrete (1)/(2)/(3) work items shown under the active top-level step. */
  substeps?: PlanSubstep[];
}

export interface Plan {
  steps: PlanStep[];
  reasoning: string;
}

export type TaskComplexity = 'simple' | 'complex';

/**
 * Operating mode the agent auto-selects per turn from the task analysis:
 *   - 'yolo'  — simple task: direct execution, no planning step.
 *   - 'plan'  — complex task: plan review + approved plan + live todo checkoffs.
 *   - 'build' — complex task with an explicit build/artifact intent ("写一个小游
 *     戏", "搭建全栈项目"): same plan + checkoff flow, labeled as build mode so
 *     the user sees the agent switched into a structured build workflow.
 */
export type TaskMode = 'yolo' | 'plan' | 'build';

export type RequestIntent = 'question' | 'research' | 'add' | 'modify' | 'debug' | 'refactor' | 'migrate' | 'delete' | 'build';
export type RiskLevel = 'low' | 'medium' | 'high';
export type Reversibility = 'reversible' | 'partially-reversible' | 'hard-to-reverse' | 'irreversible';

/** A pre-execution assessment that keeps the agent from mechanically applying
 * a plausible-looking request without considering impact or recovery. */
export interface IntentAssessment {
  intent: RequestIntent;
  riskLevel: RiskLevel;
  reversibility: Reversibility;
  impact: string;
  recommendation: string;
  /** A read-only workspace probe should happen before deciding the exact edit. */
  requiresProbe: boolean;
  /** The user must explicitly approve the proposed direction before execution. */
  requiresConfirmation: boolean;
}

/**
 * A potential logical trap detected in the user's request — a premise that is
 * self-contradictory, impossible, mutually exclusive, or explicitly framed as
 * a trick/paradox. Detected by the Planner before execution so the agent can
 * verify the premise and, if confirmed, escape the trap by switching to a
 * reasonable interpretation instead of blindly following contradictory
 * instructions into a failure loop.
 */
export interface TrapWarning {
  type: 'self-contradiction' | 'impossible-constraint' | 'mutually-exclusive' | 'trap-keyword';
  description: string;
}

export interface AnalysisResult {
  complexity: TaskComplexity;
  /** Auto-selected operating mode derived from complexity + build intent. */
  mode: TaskMode;
  plan?: Plan;
  reasoning: string;
  /** Potential logical traps in the prompt; empty when none were detected. */
  traps: TrapWarning[];
  /** Freebuff-style intent, impact, reversibility, and next-action assessment. */
  intent: IntentAssessment;
}

export interface TaggedTool extends ToolDefinition {
  tags: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  serverName?: string;
}

export interface ToolExecResult {
  toolName: string;
  output: string;
  success: boolean;
  error?: string;
  duration: number;
}

export interface PermissionRequestHandler {
  (ctx: PermissionRequestInfo): Promise<PermissionDecision>;
}

export interface PermissionRequestInfo {
  tool: string;
  command?: string;
  description: string;
  dangerLevel: 'safe' | 'caution' | 'danger';
  riskLevel: 'low' | 'medium' | 'high';
  serverName?: string;
  /** 写工具的目标文件路径(用于确认弹窗的内容预览)。 */
  path?: string;
  /** 写工具将要写入/替换的内容预览。 */
  contentPreview?: string;
  /** 可中止信号:取消时进行中的确认应立即以拒绝结束。 */
  signal?: AbortSignal;
}

// ── Subagent types ──

export interface SubagentDefinition extends TaggedTool {
  createSystemPrompt: (input: Record<string, unknown>) => string;
  defaultTimeoutMs: number;
}

export interface SubagentTask {
  id: string;
  agentName: string;
  input: Record<string, unknown>;
  budget?: import('../shared/types').BudgetConfig;
}

export interface SubagentResult {
  id: string;
  agentName: string;
  success: boolean;
  output?: string;
  error?: string;
  duration: number;
  tokensUsed?: number;
}

export interface SubagentRegistry {
  register(def: SubagentDefinition): void;
  get(name: string): SubagentDefinition | undefined;
  getAsTools(): ToolDefinition[];
}
