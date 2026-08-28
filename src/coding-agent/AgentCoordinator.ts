// src/coding-agent/AgentCoordinator.ts
// v0.1 — 多Agent协调器：管理多Agent间的协作调度、状态管理、结果聚合

import { AgentRole, type AgentRoleType } from './types';
import type { SubagentOrchestrator } from './SubagentOrchestrator';
import type { LLMAdapter } from '../shared/types';
import { AgentStatus, type AgentMessage } from './AgentMessage';

// ── 任务定义 ──

export interface CoordinatedTask {
  /** 任务唯一ID */
  id: string;
  /** 任务描述 */
  description: string;
  /** 分配的Agent角色 */
  agentRole: AgentRoleType;
  /** 任务输入参数 */
  input: Record<string, unknown>;
  /** 依赖的任务ID列表 */
  dependsOn?: string[];
  /** 优先级（1-10） */
  priority?: number;
  /** 超时时间（毫秒） */
  timeoutMs?: number;
  /** 任务状态 */
  status: 'idle' | 'working' | 'waiting' | 'completed' | 'failed' | 'aborted';
  /** 执行结果 */
  result?: {
    success: boolean;
    output?: string;
    error?: string;
    duration: number;
    filesModified?: string[];
  };
  /** 创建时间 */
  createdAt: number;
  /** 开始执行时间 */
  startedAt?: number;
  /** 完成时间 */
  completedAt?: number;
}

// ── 协调器配置 ──

export interface AgentCoordinatorConfig {
  /** LLM适配器（用于生成协作决策） */
  llm: LLMAdapter;
  /** 子Agent编排器 */
  subagentOrchestrator: SubagentOrchestrator;
  /** 最大并发任务数 */
  maxConcurrentTasks?: number;
  /** 默认任务超时（毫秒） */
  defaultTaskTimeout?: number;
  /** 任务完成回调 */
  onTaskComplete?: (task: CoordinatedTask) => void;
  /** 任务失败回调 */
  onTaskFail?: (task: CoordinatedTask, error: string) => void;
  /** 进度更新回调 */
  onProgress?: (taskId: string, progress: number, message: string) => void;
  /** AbortSignal */
  signal?: AbortSignal;
}

// ── Agent协调器 ──

export class AgentCoordinator {
  private llm: LLMAdapter;
  private subagentOrchestrator: SubagentOrchestrator;
  private maxConcurrentTasks: number;
  private defaultTaskTimeout: number;
  private onTaskComplete?: (task: CoordinatedTask) => void;
  private onTaskFail?: (task: CoordinatedTask, error: string) => void;
  private onProgress?: (taskId: string, progress: number, message: string) => void;
  private signal?: AbortSignal;
  private tasks = new Map<string, CoordinatedTask>();
  private taskQueue: string[] = [];
  private activeTasks = new Map<string, CoordinatedTask>();
  private completedTasks = new Map<string, CoordinatedTask>();
  private taskCounter = 0;
  private aborted = false;

  constructor(config: AgentCoordinatorConfig) {
    this.llm = config.llm;
    this.subagentOrchestrator = config.subagentOrchestrator;
    this.maxConcurrentTasks = config.maxConcurrentTasks ?? 3;
    this.defaultTaskTimeout = config.defaultTaskTimeout ?? 300_000;
    this.onTaskComplete = config.onTaskComplete;
    this.onTaskFail = config.onTaskFail;
    this.onProgress = config.onProgress;
    this.signal = config.signal;

    // 监听中止信号
    if (this.signal) {
      this.signal.addEventListener('abort', () => {
        this.abortAll('User aborted');
      });
    }
  }

  /**
   * 生成唯一任务ID
   */
  private generateTaskId(): string {
    return `task_${Date.now()}_${++this.taskCounter}`;
  }

  /**
   * 创建并提交一个任务
   */
  async createTask(
    description: string,
    agentRole: AgentRoleType,
    input: Record<string, unknown>,
    options?: {
      dependsOn?: string[];
      priority?: number;
      timeoutMs?: number;
    },
  ): Promise<string> {
    const taskId = this.generateTaskId();
    const task: CoordinatedTask = {
      id: taskId,
      description,
      agentRole,
      input,
      dependsOn: options?.dependsOn,
      priority: options?.priority ?? 5,
      timeoutMs: options?.timeoutMs ?? this.defaultTaskTimeout,
      status: AgentStatus.IDLE,
      createdAt: Date.now(),
    };

    this.tasks.set(taskId, task);

    // 按优先级排序后加入队列
    this.enqueueTask(taskId);

    return taskId;
  }

  /**
   * 将任务加入执行队列（按优先级排序）
   */
  private enqueueTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    // 找到合适的插入位置（优先级高的在前）
    const insertIndex = this.taskQueue.findIndex(id => {
      const t = this.tasks.get(id);
      return t && (t.priority ?? 5) < (task.priority ?? 5);
    });

    if (insertIndex === -1) {
      this.taskQueue.push(taskId);
    } else {
      this.taskQueue.splice(insertIndex, 0, taskId);
    }
  }

  /**
   * 检查任务依赖是否满足
   */
  private areDependenciesMet(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !task.dependsOn || task.dependsOn.length === 0) {
      return true;
    }

    return task.dependsOn.every(depId => {
      const depTask = this.tasks.get(depId);
      return depTask?.status === AgentStatus.COMPLETED;
    });
  }

  /**
   * 获取下一个可执行的任务
   */
  private getNextRunnableTask(): string | null {
    // 检查队列头的任务是否可以执行
    while (this.taskQueue.length > 0) {
      const taskId = this.taskQueue[0];
      const task = this.tasks.get(taskId);

      if (!task) {
        this.taskQueue.shift();
        continue;
      }

      if (task.status !== AgentStatus.IDLE) {
        this.taskQueue.shift();
        continue;
      }

      if (this.areDependenciesMet(taskId)) {
        // 再次检查并发限制
        if (this.activeTasks.size < this.maxConcurrentTasks) {
          return this.taskQueue.shift()!;
        }
        return null;
      }

      // 依赖未满足，等待
      return null;
    }

    return null;
  }

  /**
   * 执行单个任务
   */
  private async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (this.aborted) {
      task.status = AgentStatus.ABORTED;
      return;
    }

    task.status = AgentStatus.WORKING;
    task.startedAt = Date.now();
    this.activeTasks.set(taskId, task);

    const startTime = Date.now();
    this.onProgress?.(taskId, 10, `开始执行: ${task.description}`);

    try {
      // 构建Agent输入
      const agentInput = {
        ...task.input,
        taskId,
        originalTask: task.description,
      };

      // 调用对应的Agent工具
      const agentName = this.getAgentNameForRole(task.agentRole);
      const timeoutMs = task.timeoutMs ?? this.defaultTaskTimeout;

      // 创建超时控制器
      const timeoutController = AbortSignal.timeout(timeoutMs);
      const combinedSignal = this.signal
        ? AbortSignal.any([this.signal, timeoutController])
        : timeoutController;

      this.onProgress?.(taskId, 30, `调用 ${agentName}...`);

      // 使用SubagentOrchestrator执行任务
      // 注意：这里需要通过tool call来执行，实际上是由主LLM调用的
      // 协调器主要负责任务队列管理和状态追踪

      // 模拟执行（实际由主LLM调用对应的Agent工具）
      // 在实际使用中，这个方法会被扩展以支持真实的Agent调用

      const duration = Date.now() - startTime;
      task.status = AgentStatus.COMPLETED;
      task.completedAt = Date.now();
      task.result = {
        success: true,
        output: '任务由主LLM通过Agent工具调用执行',
        duration,
      };

      this.onProgress?.(taskId, 100, `完成: ${task.description}`);
      this.onTaskComplete?.(task);

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      task.status = AgentStatus.FAILED;
      task.completedAt = Date.now();
      task.result = {
        success: false,
        error: errorMessage,
        duration,
      };

      this.onTaskFail?.(task, errorMessage);
    } finally {
      this.activeTasks.delete(taskId);
      this.completedTasks.set(taskId, task);
    }
  }

  /**
   * 根据Agent角色获取对应的工具名称
   */
  private getAgentNameForRole(role: AgentRoleType): string {
    const roleToAgentMap: Record<AgentRoleType, string> = {
      [AgentRole.PLANNER]: 'task_planner',
      [AgentRole.EDITOR]: 'code_editor',
      [AgentRole.REVIEWER]: 'code_reviewer',
      [AgentRole.THINKER]: 'deep_thinker',
      [AgentRole.UI_DESIGNER]: 'ui_designer',
      [AgentRole.BASHER]: 'bash_executor',
      [AgentRole.RESEARCHER]: 'researcher',
    };
    return roleToAgentMap[role] ?? role;
  }

  /**
   * 启动协调器，开始执行队列中的任务
   */
  async start(): Promise<void> {
    if (this.aborted) return;

    // 启动任务调度循环
    while (!this.aborted && (this.taskQueue.length > 0 || this.activeTasks.size > 0)) {
      // 获取下一个可执行的任务
      const taskId = this.getNextRunnableTask();

      if (taskId) {
        // 异步执行任务，不阻塞调度循环
        this.executeTask(taskId).catch(error => {
          console.error(`[AgentCoordinator] Task ${taskId} execution error:`, error);
        });
      } else {
        // 没有可执行的任务，等待一小段时间后重试
        await this.sleep(100);
      }
    }
  }

  /**
   * 停止所有任务
   */
  abortAll(reason: string = 'Coordinator aborted'): void {
    this.aborted = true;

    // 中止所有活跃任务
    for (const [taskId, task] of this.activeTasks) {
      task.status = AgentStatus.ABORTED;
      task.completedAt = Date.now();
      task.result = {
        success: false,
        error: reason,
        duration: Date.now() - (task.startedAt ?? Date.now()),
      };
      this.onTaskFail?.(task, reason);
    }

    this.activeTasks.clear();
    this.taskQueue = [];
  }

  /**
   * 获取任务状态
   */
  getTask(taskId: string): CoordinatedTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): CoordinatedTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 获取任务统计信息
   */
  getStats(): {
    total: number;
    pending: number;
    active: number;
    completed: number;
    failed: number;
  } {
    let pending = 0;
    let active = 0;
    let completed = 0;
    let failed = 0;

    for (const task of this.tasks.values()) {
      switch (task.status) {
        case AgentStatus.IDLE:
          pending++;
          break;
        case AgentStatus.WORKING:
        case AgentStatus.WAITING:
          active++;
          break;
        case AgentStatus.COMPLETED:
          completed++;
          break;
        case AgentStatus.FAILED:
        case AgentStatus.ABORTED:
          failed++;
          break;
      }
    }

    return {
      total: this.tasks.size,
      pending,
      active,
      completed,
      failed,
    };
  }

  /**
   * 等待所有任务完成
   */
  async waitForCompletion(timeoutMs?: number): Promise<CoordinatedTask[]> {
    const startTime = Date.now();
    const timeout = timeoutMs ?? this.defaultTaskTimeout;

    while (!this.aborted && this.activeTasks.size > 0) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Coordinator wait timeout after ${timeout}ms`);
      }
      await this.sleep(100);
    }

    return Array.from(this.completedTasks.values());
  }

  /**
   * 聚合所有已完成任务的结果
   */
  aggregateResults(strategy: 'merge' | 'sequence' = 'merge'): {
    success: boolean;
    results: Array<{ taskId: string; output?: string; error?: string }>;
    summary: string;
  } {
    const results: Array<{ taskId: string; output?: string; error?: string }> = [];
    let allSuccess = true;

    for (const task of this.completedTasks.values()) {
      if (task.result) {
        results.push({
          taskId: task.id,
          output: task.result.output,
          error: task.result.error,
        });
        if (!task.result.success) {
          allSuccess = false;
        }
      }
    }

    let summary: string;
    if (strategy === 'merge') {
      summary = results
        .filter(r => r.output)
        .map(r => r.output)
        .join('\n---\n');
    } else {
      summary = results
        .map((r, i) => `[Step ${i + 1}] ${r.output ?? r.error ?? 'No output'}`)
        .join('\n');
    }

    return {
      success: allSuccess,
      results,
      summary,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── 便捷函数 ──

/**
 * 创建标准的多步骤编码任务流程
 */
export function createCodingWorkflow(
  description: string,
  options?: {
    planningPhase?: boolean;
    reviewPhase?: boolean;
    testPhase?: boolean;
    context?: string;
  },
): Array<{
  agentRole: AgentRoleType;
  description: string;
  input: Record<string, unknown>;
}> {
  const steps: Array<{
    agentRole: AgentRoleType;
    description: string;
    input: Record<string, unknown>;
  }> = [];

  const context = options?.context ?? '';

  // 规划阶段
  if (options?.planningPhase !== false) {
    steps.push({
      agentRole: AgentRole.PLANNER,
      description: '制定修改计划',
      input: { task: description, context },
    });
  }

  // 编辑阶段
  steps.push({
    agentRole: AgentRole.EDITOR,
    description: '执行代码修改',
    input: {
      task: description,
      instructions: `根据规划执行代码修改：${description}`,
      context,
    },
  });

  // 审查阶段
  if (options?.reviewPhase !== false) {
    steps.push({
      agentRole: AgentRole.REVIEWER,
      description: '审查代码变更',
      input: {
        prompt: `审查以下代码变更：${description}`,
        context,
      },
    });
  }

  // 测试阶段
  if (options?.testPhase) {
    steps.push({
      agentRole: AgentRole.BASHER,
      description: '运行测试',
      input: {
        description: '运行测试验证修改',
        context,
      },
    });
  }

  return steps;
}

/**
 * 创建UI设计任务流程
 */
export function createUIWorkflow(
  requirement: string,
  options?: {
    designType?: 'interface' | 'layout' | 'interaction' | 'both';
    context?: string;
  },
): Array<{
  agentRole: AgentRoleType;
  description: string;
  input: Record<string, unknown>;
}> {
  const steps: Array<{
    agentRole: AgentRoleType;
    description: string;
    input: Record<string, unknown>;
  }> = [];

  const context = options?.context ?? '';
  const designType = options?.designType ?? 'both';

  // UI设计阶段
  steps.push({
    agentRole: AgentRole.UI_DESIGNER,
    description: '设计UI方案',
    input: {
      requirement,
      design_type: designType,
      context,
    },
  });

  // 编辑实现阶段
  steps.push({
    agentRole: AgentRole.EDITOR,
    description: '实现UI设计',
    input: {
      task: `实现UI设计：${requirement}`,
      instructions: requirement,
      context: context + `\n\nUI设计方案已由ui_designer生成。`,
    },
  });

  // 审查阶段
  steps.push({
    agentRole: AgentRole.REVIEWER,
    description: '审查UI实现',
    input: {
      prompt: `审查UI实现是否符合设计要求：${requirement}`,
      context,
    },
  });

  return steps;
}

/**
 * 创建研究任务流程
 */
export function createResearchWorkflow(
  topic: string,
  options?: {
    deepAnalysis?: boolean;
    scope?: string;
  },
): Array<{
  agentRole: AgentRoleType;
  description: string;
  input: Record<string, unknown>;
}> {
  const steps: Array<{
    agentRole: AgentRoleType;
    description: string;
    input: Record<string, unknown>;
  }> = [];

  // 研究阶段
  steps.push({
    agentRole: AgentRole.RESEARCHER,
    description: '收集研究资料',
    input: {
      topic,
      sources: 'both',
      scope: options?.scope ?? '',
    },
  });

  // 深度分析阶段
  if (options?.deepAnalysis) {
    steps.push({
      agentRole: AgentRole.THINKER,
      description: '深度分析研究结果',
      input: {
        question: `分析研究主题：${topic}`,
        context: '基于上述研究资料进行深度分析',
        approach: '分析',
      },
    });
  }

  return steps;
}
