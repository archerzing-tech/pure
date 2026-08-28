// src/coding-agent/DynamicPipeline.ts
// v0.1 — 动态Pipeline调整器：根据执行状态动态调整Agent组合，支持并行执行和错误恢复

import { AgentRole, type AgentRoleType } from './types';
import type { AnalysisResult } from './types';
import { PIPELINES, TaskCategory, type AgentPipeline } from './TaskDispatcher';

// ── 执行状态 ──

export const ExecutionState = {
  PENDING: 'pending',       // 等待执行
  RUNNING: 'running',       // 执行中
  SUCCESS: 'success',       // 成功完成
  FAILED: 'failed',         // 执行失败
  RETRYING: 'retrying',     // 正在重试
  SKIPPED: 'skipped',       // 已跳过
} as const;

export type ExecutionState = typeof ExecutionState[keyof typeof ExecutionState];

// ── Agent执行记录 ──

export interface AgentExecution {
  /** Agent角色 */
  role: AgentRoleType;
  /** 执行状态 */
  state: ExecutionState;
  /** 执行输出 */
  output?: string;
  /** 错误信息 */
  error?: string;
  /** 开始时间 */
  startTime?: number;
  /** 结束时间 */
  endTime?: number;
  /** 重试次数 */
  retryCount: number;
  /** 执行时长（毫秒） */
  duration?: number;
}

// ── Pipeline执行上下文 ──

export interface PipelineExecution {
  /** Pipeline名称 */
  pipelineName: string;
  /** 原始任务 */
  task: string;
  /** 执行计划（可能动态调整） */
  agents: AgentRoleType[];
  /** 各Agent的执行记录 */
  executions: Map<AgentRoleType, AgentExecution>;
  /** 当前执行阶段索引 */
  currentIndex: number;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
  /** 是否整体成功 */
  success: boolean;
}

// ── 动态调整决策 ──

export interface AdjustmentDecision {
  /** 是否需要调整 */
  shouldAdjust: boolean;
  /** 调整类型 */
  type: 'add' | 'remove' | 'reorder' | 'replace' | 'none';
  /** 调整原因 */
  reason: string;
  /** 新的Agent列表 */
  newAgents?: AgentRoleType[];
  /** 建议的修改 */
  suggestion?: string;
}

// ── 动态Pipeline调整器 ──

export class DynamicPipelineController {
  private execution?: PipelineExecution;
  private maxRetries: number;
  private baseTimeout: number;

  constructor(options?: { maxRetries?: number; baseTimeout?: number }) {
    this.maxRetries = options?.maxRetries ?? 2;
    this.baseTimeout = options?.baseTimeout ?? 180_000;
  }

  /**
   * 初始化Pipeline执行
   */
  initExecution(task: string, agents: AgentRoleType[], pipelineName: string): PipelineExecution {
    this.execution = {
      pipelineName,
      task,
      agents: [...agents],
      executions: new Map(),
      currentIndex: 0,
      startTime: Date.now(),
      success: false,
    };

    // 初始化各Agent的执行记录
    for (const role of agents) {
      this.execution.executions.set(role, {
        role,
        state: ExecutionState.PENDING,
        retryCount: 0,
      });
    }

    return this.execution;
  }

  /**
   * 获取当前待执行的Agent
   */
  getNextAgent(): AgentRoleType | null {
    if (!this.execution) return null;

    while (this.execution.currentIndex < this.execution.agents.length) {
      const role = this.execution.agents[this.execution.currentIndex];
      const exec = this.execution.executions.get(role);

      if (exec && (exec.state === ExecutionState.PENDING || exec.state === ExecutionState.RETRYING)) {
        return role;
      }

      this.execution.currentIndex++;
    }

    return null;
  }

  /**
   * 标记Agent开始执行
   */
  startAgent(role: AgentRoleType): void {
    if (!this.execution) return;

    const exec = this.execution.executions.get(role);
    if (exec) {
      exec.state = ExecutionState.RUNNING;
      exec.startTime = Date.now();
    }
  }

  /**
   * 标记Agent完成（成功）
   */
  completeAgent(role: AgentRoleType, output: string): void {
    if (!this.execution) return;

    const exec = this.execution.executions.get(role);
    if (exec) {
      exec.state = ExecutionState.SUCCESS;
      exec.output = output;
      exec.endTime = Date.now();
      exec.duration = exec.endTime - (exec.startTime ?? exec.endTime);
    }

    this.execution.currentIndex++;
  }

  /**
   * 标记Agent失败
   */
  failAgent(role: AgentRoleType, error: string): AdjustmentDecision {
    if (!this.execution) {
      return { shouldAdjust: false, type: 'none', reason: 'No execution context' };
    }

    const exec = this.execution.executions.get(role);
    if (!exec) {
      return { shouldAdjust: false, type: 'none', reason: 'Agent not found' };
    }

    exec.error = error;
    exec.retryCount++;

    // 决定是否重试
    if (exec.retryCount <= this.maxRetries) {
      exec.state = ExecutionState.RETRYING;
      return {
        shouldAdjust: true,
        type: 'reorder',
        reason: `Agent失败，将重试（第${exec.retryCount}次）`,
        suggestion: `重新调用 ${role} Agent 执行任务`,
      };
    }

    exec.state = ExecutionState.FAILED;
    exec.endTime = Date.now();
    exec.duration = exec.endTime - (exec.startTime ?? exec.endTime);

    // 根据失败的Agent决定如何调整Pipeline
    return this.decideAdjustment(role, error);
  }

  /**
   * 根据失败情况决定Pipeline调整
   */
  private decideAdjustment(failedRole: AgentRoleType, error: string): AdjustmentDecision {
    if (!this.execution) {
      return { shouldAdjust: false, type: 'none', reason: 'No execution context' };
    }

    const errorLower = error.toLowerCase();

    // 网络/超时错误 - 尝试添加研究者收集信息
    if (errorLower.includes('timeout') || errorLower.includes('network') || errorLower.includes('fetch')) {
      if (!this.execution.agents.includes(AgentRole.RESEARCHER)) {
        return {
          shouldAdjust: true,
          type: 'add',
          reason: '检测到网络/超时错误，添加研究者Agent收集信息',
          newAgents: [...this.execution.agents.slice(0, this.execution.currentIndex), AgentRole.RESEARCHER, ...this.execution.agents.slice(this.execution.currentIndex)],
          suggestion: '先调用 researcher 收集必要的参考资料',
        };
      }
    }

    // 规划失败 - 简化流程，直接执行
    if (failedRole === AgentRole.PLANNER) {
      return {
        shouldAdjust: true,
        type: 'remove',
        reason: '规划阶段失败，简化流程直接执行',
        newAgents: this.execution.agents.filter(a => a !== AgentRole.PLANNER),
        suggestion: '跳过规划阶段，直接由编辑器执行',
      };
    }

    // 审查失败 - 继续执行但标记
    if (failedRole === AgentRole.REVIEWER) {
      return {
        shouldAdjust: true,
        type: 'replace',
        reason: '审查阶段失败，降级为简单审查',
        newAgents: this.execution.agents,
        suggestion: '简化审查，仅检查关键问题',
      };
    }

    // 编辑失败 - 添加思考器分析
    if (failedRole === AgentRole.EDITOR) {
      if (!this.execution.agents.includes(AgentRole.THINKER)) {
        return {
          shouldAdjust: true,
          type: 'add',
          reason: '编辑阶段失败，添加思考器分析问题',
          newAgents: [...this.execution.agents.slice(0, this.execution.currentIndex), AgentRole.THINKER, ...this.execution.agents.slice(this.execution.currentIndex)],
          suggestion: '先调用 deep_thinker 分析问题，再重新编辑',
        };
      }
    }

    // 执行失败 - 跳过测试阶段
    if (failedRole === AgentRole.BASHER) {
      return {
        shouldAdjust: true,
        type: 'remove',
        reason: '执行阶段失败，跳过测试',
        newAgents: this.execution.agents.filter(a => a !== AgentRole.BASHER),
        suggestion: '跳过执行阶段，标记任务为部分完成',
      };
    }

    // 默认：标记失败但继续
    return {
      shouldAdjust: true,
      type: 'none',
      reason: `Agent ${failedRole} 失败但继续执行后续步骤`,
      suggestion: '继续执行后续Agent',
    };
  }

  /**
   * 应用调整决策
   */
  applyAdjustment(decision: AdjustmentDecision): boolean {
    if (!this.execution || !decision.shouldAdjust || !decision.newAgents) {
      return false;
    }

    // 更新Agent列表
    this.execution.agents = decision.newAgents;

    // 为新增的Agent初始化执行记录
    for (const role of decision.newAgents) {
      if (!this.execution.executions.has(role)) {
        this.execution.executions.set(role, {
          role,
          state: ExecutionState.PENDING,
          retryCount: 0,
        });
      }
    }

    return true;
  }

  /**
   * 获取并行可执行的Agent列表
   */
  getParallelizableAgents(): AgentRoleType[] {
    if (!this.execution) return [];

    // 某些Agent可以并行执行
    // 例如：研究 + UI设计可以并行（不依赖彼此）
    const parallelizableGroups: AgentRoleType[][] = [
      [AgentRole.RESEARCHER, AgentRole.UI_DESIGNER], // 研究和UI设计可以并行
    ];

    const currentRole = this.execution.agents[this.execution.currentIndex];
    const group = parallelizableGroups.find(g => g.includes(currentRole));

    if (group) {
      // 返回同组中尚未执行的Agent
      return group.filter(role => {
        const exec = this.execution?.executions.get(role);
        return exec && (exec.state === ExecutionState.PENDING || exec.state === ExecutionState.RETRYING);
      });
    }

    return [];
  }

  /**
   * 检查是否可以并行执行
   */
  canParallelize(): boolean {
    return this.getParallelizableAgents().length > 1;
  }

  /**
   * 获取执行超时时间
   */
  getTimeoutForAgent(role: AgentRoleType): number {
    // 不同Agent有不同的超时时间
    const timeouts: Partial<Record<AgentRoleType, number>> = {
      [AgentRole.PLANNER]: 60_000,      // 1分钟
      [AgentRole.EDITOR]: 300_000,     // 5分钟
      [AgentRole.REVIEWER]: 120_000,    // 2分钟
      [AgentRole.THINKER]: 180_000,     // 3分钟
      [AgentRole.UI_DESIGNER]: 180_000, // 3分钟
      [AgentRole.BASHER]: 120_000,      // 2分钟
      [AgentRole.RESEARCHER]: 180_000,  // 3分钟
    };

    return timeouts[role] ?? this.baseTimeout;
  }

  /**
   * 获取执行统计
   */
  getStats(): {
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
    totalDuration: number;
    successRate: number;
  } {
    if (!this.execution) {
      return { total: 0, completed: 0, failed: 0, running: 0, pending: 0, totalDuration: 0, successRate: 0 };
    }

    let completed = 0;
    let failed = 0;
    let running = 0;
    let pending = 0;

    for (const exec of this.execution.executions.values()) {
      switch (exec.state) {
        case ExecutionState.SUCCESS:
          completed++;
          break;
        case ExecutionState.FAILED:
          failed++;
          break;
        case ExecutionState.RUNNING:
        case ExecutionState.RETRYING:
          running++;
          break;
        case ExecutionState.PENDING:
          pending++;
          break;
      }
    }

    const total = this.execution.agents.length;
    const totalDuration = this.execution.endTime
      ? this.execution.endTime - this.execution.startTime
      : Date.now() - this.execution.startTime;

    return {
      total,
      completed,
      failed,
      running,
      pending,
      totalDuration,
      successRate: total > 0 ? (completed / total) * 100 : 0,
    };
  }

  /**
   * 检查Pipeline是否完成
   */
  isComplete(): boolean {
    if (!this.execution) return false;

    // 所有Agent都已执行（成功或失败）
    for (const exec of this.execution.executions.values()) {
      if (exec.state === ExecutionState.PENDING || exec.state === ExecutionState.RUNNING || exec.state === ExecutionState.RETRYING) {
        return false;
      }
    }

    this.execution.endTime = Date.now();
    const firstExec = this.execution.executions.values().next().value;
    this.execution.success = firstExec ? firstExec.state === ExecutionState.SUCCESS : false;

    return true;
  }

  /**
   * 获取最终结果摘要
   */
  getSummary(): string {
    if (!this.execution) return 'No execution';

    const stats = this.getStats();
    const parts: string[] = [];

    parts.push(`Pipeline: ${this.execution.pipelineName}`);
    parts.push(`Task: ${this.execution.task}`);
    parts.push(`Status: ${stats.completed}/${stats.total} completed`);

    if (stats.failed > 0) {
      parts.push(`Failed: ${stats.failed}`);
    }

    parts.push(`Duration: ${Math.round(stats.totalDuration / 1000)}s`);
    parts.push(`Success Rate: ${stats.successRate.toFixed(1)}%`);

    return parts.join('\n');
  }

  /**
   * 重置执行上下文
   */
  reset(): void {
    this.execution = undefined;
  }
}

// ── 静态分析函数 ──

/**
 * 分析任务复杂度并建议Pipeline
 */
export function analyzeTaskForPipeline(task: string, analysis?: AnalysisResult): {
  recommendedPipeline: AgentPipeline;
  parallelSteps: AgentRoleType[][];
  estimatedDuration: number;
  suggestions: string[];
} {
  const suggestions: string[] = [];
  let estimatedDuration = 0;
  let recommendedPipeline: AgentPipeline;

  // 确定任务类别
  let category: TaskCategory;
  if (analysis) {
    const intent = typeof analysis.intent === 'object' ? analysis.intent.intent : analysis.intent;
    if (intent === 'research') {
      category = TaskCategory.RESEARCH;
    } else if (analysis.complexity === 'complex') {
      category = TaskCategory.CODING;
    } else {
      category = TaskCategory.SIMPLE;
    }
  } else {
    // 使用启发式分类
    const lowerTask = task.toLowerCase();
    if (lowerTask.includes('ui') || lowerTask.includes('界面') || lowerTask.includes('布局')) {
      category = TaskCategory.UI_DESIGN;
    } else if (lowerTask.includes('研究') || lowerTask.includes('查找') || lowerTask.includes('什么')) {
      category = TaskCategory.RESEARCH;
    } else if (lowerTask.includes('分析') || lowerTask.includes('思考')) {
      category = TaskCategory.ANALYSIS;
    } else {
      category = TaskCategory.CODING;
    }
  }

  recommendedPipeline = PIPELINES[category];

  // 分析可并行步骤
  const parallelSteps: AgentRoleType[][] = [];
  if (category === TaskCategory.CODING) {
    // 研究和UI设计可以并行（如果有）
    parallelSteps.push([AgentRole.RESEARCHER]);
  }

  // 估算执行时间
  const durationByRole: Partial<Record<AgentRoleType, number>> = {
    [AgentRole.PLANNER]: 60,
    [AgentRole.EDITOR]: 180,
    [AgentRole.REVIEWER]: 60,
    [AgentRole.THINKER]: 120,
    [AgentRole.UI_DESIGNER]: 120,
    [AgentRole.BASHER]: 60,
    [AgentRole.RESEARCHER]: 120,
  };

  for (const role of recommendedPipeline.agents) {
    estimatedDuration += durationByRole[role] ?? 60;
  }

  // 添加建议
  if (analysis?.complexity === 'complex') {
    suggestions.push('建议启用详细的规划阶段');
  }

  if (task.includes('测试') || task.includes('验证')) {
    suggestions.push('建议包含测试执行阶段');
  }

  if (task.includes('重构')) {
    suggestions.push('建议启用审查阶段确保代码质量');
  }

  return {
    recommendedPipeline,
    parallelSteps,
    estimatedDuration,
    suggestions,
  };
}

/**
 * 创建默认的动态Pipeline控制器
 */
export function createDynamicPipelineController(options?: { maxRetries?: number }): DynamicPipelineController {
  return new DynamicPipelineController(options);
}
