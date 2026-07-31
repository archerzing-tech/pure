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
  /** 只读工具的无副作用参数哈希,用于缓存键(argsHash)。 */
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

export interface PlanStep {
  id: string;
  action: string;
  description: string;
  expectedOutcome: string;
}

export interface Plan {
  steps: PlanStep[];
  reasoning: string;
}

export type TaskComplexity = 'simple' | 'complex';

export interface AnalysisResult {
  complexity: TaskComplexity;
  plan?: Plan;
  reasoning: string;
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
