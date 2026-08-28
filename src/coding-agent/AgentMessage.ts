// src/coding-agent/AgentMessage.ts
// v0.1 — Agent间消息协议：定义多Agent协作时的消息格式和类型

import type { AgentRoleType } from './types';

// ── 消息类型枚举 ──

export const AgentMessageType = {
  // 任务分发
  TASK_REQUEST: 'task_request',       // 主Agent向子Agent发送任务请求
  TASK_RESPONSE: 'task_response',     // 子Agent返回任务结果

  // Agent间协作
  COLLABORATION_REQUEST: 'collaboration_request',  // 请求其他Agent协助
  COLLABORATION_RESPONSE: 'collaboration_response', // 返回协作结果

  // 状态同步
  STATUS_UPDATE: 'status_update',     // 状态更新通知
  PROGRESS_REPORT: 'progress_report',  // 进度报告

  // 协调指令
  COORDINATION_COMMAND: 'coordination_command',  // 协调器发出的指令
  ABORT_TASK: 'abort_task',          // 中止任务

  // 信息共享
  CONTEXT_SHARE: 'context_share',     // 共享上下文
  RESULT_AGGREGATION: 'result_aggregation', // 聚合多个Agent的结果
} as const;

export type AgentMessageType = typeof AgentMessageType[keyof typeof AgentMessageType];

// ── Agent状态 ──

export const AgentStatus = {
  IDLE: 'idle',           // 空闲
  WORKING: 'working',     // 执行中
  WAITING: 'waiting',     // 等待中（等待依赖）
  COMPLETED: 'completed', // 已完成
  FAILED: 'failed',       // 失败
  ABORTED: 'aborted',     // 已中止
} as const;

export type AgentStatus = typeof AgentStatus[keyof typeof AgentStatus];

// ── 消息基类 ──

export interface BaseMessage {
  /** 消息唯一ID */
  id: string;
  /** 消息类型 */
  type: AgentMessageType;
  /** 发送者Agent角色 */
  sender: AgentRoleType;
  /** 接收者Agent角色（可选，用于定向消息） */
  recipient?: AgentRoleType;
  /** 发送时间戳 */
  timestamp: number;
  /** 关联的任务ID */
  taskId: string;
}

// ── 任务请求消息 ──

export interface TaskRequestMessage extends BaseMessage {
  type: typeof AgentMessageType.TASK_REQUEST;
  payload: {
    /** 任务描述 */
    description: string;
    /** 任务输入参数 */
    input: Record<string, unknown>;
    /** 优先级（1-10，数字越大优先级越高） */
    priority?: number;
    /** 超时时间（毫秒） */
    timeoutMs?: number;
    /** 依赖的任务ID列表 */
    dependsOn?: string[];
  };
}

// ── 任务响应消息 ──

export interface TaskResponseMessage extends BaseMessage {
  type: typeof AgentMessageType.TASK_RESPONSE;
  payload: {
    /** 是否成功 */
    success: boolean;
    /** 执行结果 */
    output?: string;
    /** 错误信息 */
    error?: string;
    /** 执行耗时 */
    duration: number;
    /** 生成的文件列表 */
    filesModified?: string[];
    /** 发现的子任务 */
    subtasks?: string[];
  };
}

// ── 协作请求消息 ──

export interface CollaborationRequestMessage extends BaseMessage {
  type: typeof AgentMessageType.COLLABORATION_REQUEST;
  payload: {
    /** 请求的Agent类型 */
    targetAgent: AgentRoleType;
    /** 协作内容 */
    content: string;
    /** 上下文信息 */
    context?: Record<string, unknown>;
  };
}

// ── 协作响应消息 ──

export interface CollaborationResponseMessage extends BaseMessage {
  type: typeof AgentMessageType.COLLABORATION_RESPONSE;
  payload: {
    /** 是否成功 */
    success: boolean;
    /** 协作结果 */
    result?: string;
    /** 错误信息 */
    error?: string;
  };
}

// ── 状态更新消息 ──

export interface StatusUpdateMessage extends BaseMessage {
  type: typeof AgentMessageType.STATUS_UPDATE;
  payload: {
    /** 当前状态 */
    status: AgentStatus;
    /** 状态描述 */
    description?: string;
    /** 进度百分比（0-100） */
    progress?: number;
  };
}

// ── 进度报告消息 ──

export interface ProgressReportMessage extends BaseMessage {
  type: typeof AgentMessageType.PROGRESS_REPORT;
  payload: {
    /** 当前步骤 */
    currentStep: string;
    /** 总步骤数 */
    totalSteps: number;
    /** 步骤描述 */
    stepDescription?: string;
    /** 完成百分比 */
    percentage: number;
  };
}

// ── 协调指令消息 ──

export interface CoordinationCommandMessage extends BaseMessage {
  type: typeof AgentMessageType.COORDINATION_COMMAND;
  payload: {
    /** 指令类型 */
    command: 'start' | 'pause' | 'resume' | 'stop' | 'retry';
    /** 指令参数 */
    params?: Record<string, unknown>;
    /** 原因说明 */
    reason?: string;
  };
}

// ── 中止任务消息 ──

export interface AbortTaskMessage extends BaseMessage {
  type: typeof AgentMessageType.ABORT_TASK;
  payload: {
    /** 中止原因 */
    reason: string;
    /** 是否强制中止 */
    force?: boolean;
  };
}

// ── 上下文共享消息 ──

export interface ContextShareMessage extends BaseMessage {
  type: typeof AgentMessageType.CONTEXT_SHARE;
  payload: {
    /** 共享的上下文键 */
    keys: string[];
    /** 上下文内容 */
    context: Record<string, unknown>;
  };
}

// ── 结果聚合消息 ──

export interface ResultAggregationMessage extends BaseMessage {
  type: typeof AgentMessageType.RESULT_AGGREGATION;
  payload: {
    /** 聚合的任务ID列表 */
    taskIds: string[];
    /** 各任务的结果 */
    results: Array<{
      taskId: string;
      success: boolean;
      output?: string;
      error?: string;
    }>;
    /** 聚合策略 */
    strategy: 'merge' | 'sequence' | 'parallel_summary';
  };
}

// ── 联合消息类型 ──

export type AgentMessage =
  | TaskRequestMessage
  | TaskResponseMessage
  | CollaborationRequestMessage
  | CollaborationResponseMessage
  | StatusUpdateMessage
  | ProgressReportMessage
  | CoordinationCommandMessage
  | AbortTaskMessage
  | ContextShareMessage
  | ResultAggregationMessage;

// ── 消息生成器 ──

let messageCounter = 0;

/**
 * 生成唯一的消息ID
 */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${++messageCounter}`;
}

/**
 * 创建任务请求消息
 */
export function createTaskRequest(
  sender: AgentRoleType,
  taskId: string,
  description: string,
  input: Record<string, unknown>,
  options?: {
    recipient?: AgentRoleType;
    priority?: number;
    timeoutMs?: number;
    dependsOn?: string[];
  },
): TaskRequestMessage {
  return {
    id: generateMessageId(),
    type: AgentMessageType.TASK_REQUEST,
    sender,
    recipient: options?.recipient,
    timestamp: Date.now(),
    taskId,
    payload: {
      description,
      input,
      priority: options?.priority,
      timeoutMs: options?.timeoutMs,
      dependsOn: options?.dependsOn,
    },
  };
}

/**
 * 创建任务响应消息
 */
export function createTaskResponse(
  sender: AgentRoleType,
  taskId: string,
  success: boolean,
  duration: number,
  options?: {
    recipient?: AgentRoleType;
    output?: string;
    error?: string;
    filesModified?: string[];
    subtasks?: string[];
  },
): TaskResponseMessage {
  return {
    id: generateMessageId(),
    type: AgentMessageType.TASK_RESPONSE,
    sender,
    recipient: options?.recipient,
    timestamp: Date.now(),
    taskId,
    payload: {
      success,
      output: options?.output,
      error: options?.error,
      duration,
      filesModified: options?.filesModified,
      subtasks: options?.subtasks,
    },
  };
}

/**
 * 创建状态更新消息
 */
export function createStatusUpdate(
  sender: AgentRoleType,
  taskId: string,
  status: AgentStatus,
  options?: {
    recipient?: AgentRoleType;
    description?: string;
    progress?: number;
  },
): StatusUpdateMessage {
  return {
    id: generateMessageId(),
    type: AgentMessageType.STATUS_UPDATE,
    sender,
    recipient: options?.recipient,
    timestamp: Date.now(),
    taskId,
    payload: {
      status,
      description: options?.description,
      progress: options?.progress,
    },
  };
}

/**
 * 创建协作请求消息
 */
export function createCollaborationRequest(
  sender: AgentRoleType,
  taskId: string,
  targetAgent: AgentRoleType,
  content: string,
  options?: {
    context?: Record<string, unknown>;
  },
): CollaborationRequestMessage {
  return {
    id: generateMessageId(),
    type: AgentMessageType.COLLABORATION_REQUEST,
    sender,
    recipient: targetAgent,
    timestamp: Date.now(),
    taskId,
    payload: {
      targetAgent,
      content,
      context: options?.context,
    },
  };
}

/**
 * 创建协调指令消息
 */
export function createCoordinationCommand(
  sender: AgentRoleType,
  taskId: string,
  command: CoordinationCommandMessage['payload']['command'],
  options?: {
    recipient?: AgentRoleType;
    params?: Record<string, unknown>;
    reason?: string;
  },
): CoordinationCommandMessage {
  return {
    id: generateMessageId(),
    type: AgentMessageType.COORDINATION_COMMAND,
    sender,
    recipient: options?.recipient,
    timestamp: Date.now(),
    taskId,
    payload: {
      command,
      params: options?.params,
      reason: options?.reason,
    },
  };
}

/**
 * 创建进度报告消息
 */
export function createProgressReport(
  sender: AgentRoleType,
  taskId: string,
  currentStep: string,
  totalSteps: number,
  options?: {
    recipient?: AgentRoleType;
    stepDescription?: string;
    percentage?: number;
  },
): ProgressReportMessage {
  return {
    id: generateMessageId(),
    type: AgentMessageType.PROGRESS_REPORT,
    sender,
    recipient: options?.recipient,
    timestamp: Date.now(),
    taskId,
    payload: {
      currentStep,
      totalSteps,
      stepDescription: options?.stepDescription,
      percentage: options?.percentage ?? Math.round((parseInt(currentStep) / totalSteps) * 100),
    },
  };
}

/**
 * 创建中止任务消息
 */
export function createAbortTask(
  sender: AgentRoleType,
  taskId: string,
  reason: string,
  options?: {
    recipient?: AgentRoleType;
    force?: boolean;
  },
): AbortTaskMessage {
  return {
    id: generateMessageId(),
    type: AgentMessageType.ABORT_TASK,
    sender,
    recipient: options?.recipient,
    timestamp: Date.now(),
    taskId,
    payload: {
      reason,
      force: options?.force,
    },
  };
}

/**
 * 创建结果聚合消息
 */
export function createResultAggregation(
  sender: AgentRoleType,
  taskId: string,
  results: ResultAggregationMessage['payload']['results'],
  strategy: ResultAggregationMessage['payload']['strategy'] = 'merge',
  options?: {
    recipient?: AgentRoleType;
    taskIds?: string[];
  },
): ResultAggregationMessage {
  return {
    id: generateMessageId(),
    type: AgentMessageType.RESULT_AGGREGATION,
    sender,
    recipient: options?.recipient,
    timestamp: Date.now(),
    taskId,
    payload: {
      taskIds: options?.taskIds ?? results.map(r => r.taskId),
      results,
      strategy,
    },
  };
}
