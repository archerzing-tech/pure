// src/coding-agent/TaskDispatcher.ts
// v0.1 — 智能任务分配器：根据任务类型自动选择合适的Agent组合

import { AgentRole, type AgentRoleType } from './types';
import type { AnalysisResult } from './types';

// ── 任务类型分类 ──

export const TaskCategory = {
  CODING: 'coding',           // 编码任务
  RESEARCH: 'research',        // 研究任务
  UI_DESIGN: 'ui_design',     // UI设计任务
  ANALYSIS: 'analysis',        // 分析任务
  SIMPLE: 'simple',           // 简单任务
} as const;

export type TaskCategory = typeof TaskCategory[keyof typeof TaskCategory];

// ── Agent组合定义 ──

export interface AgentPipeline {
  /** Pipeline名称 */
  name: string;
  /** Pipeline描述 */
  description: string;
  /** 使用的Agent角色列表（按执行顺序） */
  agents: AgentRoleType[];
  /** 是否需要并发执行 */
  parallel?: boolean;
}

// ── 预定义Agent Pipeline ──

export const PIPELINES: Record<TaskCategory, AgentPipeline> = {
  [TaskCategory.CODING]: {
    name: 'coding_pipeline',
    description: '编码任务流程：规划 → 编辑 → 审查 → 测试',
    agents: [AgentRole.PLANNER, AgentRole.EDITOR, AgentRole.REVIEWER, AgentRole.BASHER],
  },
  [TaskCategory.RESEARCH]: {
    name: 'research_pipeline',
    description: '研究任务流程：研究 → 深度分析',
    agents: [AgentRole.RESEARCHER, AgentRole.THINKER],
  },
  [TaskCategory.UI_DESIGN]: {
    name: 'ui_design_pipeline',
    description: 'UI设计流程：设计 → 实现 → 审查',
    agents: [AgentRole.UI_DESIGNER, AgentRole.EDITOR, AgentRole.REVIEWER],
  },
  [TaskCategory.ANALYSIS]: {
    name: 'analysis_pipeline',
    description: '分析任务流程：深度思考 → 研究（可选）',
    agents: [AgentRole.THINKER, AgentRole.RESEARCHER],
  },
  [TaskCategory.SIMPLE]: {
    name: 'simple_pipeline',
    description: '简单任务：直接执行',
    agents: [AgentRole.EDITOR],
  },
};

// ── Agent工具名称映射 ──

const AGENT_TO_TOOL_MAP: Record<AgentRoleType, string> = {
  [AgentRole.PLANNER]: 'task_planner',
  [AgentRole.EDITOR]: 'code_editor',
  [AgentRole.REVIEWER]: 'code_reviewer',
  [AgentRole.THINKER]: 'deep_thinker',
  [AgentRole.UI_DESIGNER]: 'ui_designer',
  [AgentRole.BASHER]: 'bash_executor',
  [AgentRole.RESEARCHER]: 'researcher',
};

// ── 任务分类器 ──

export function classifyTask(prompt: string): TaskCategory {
  const lowerPrompt = prompt.toLowerCase();

  // UI设计相关关键词
  const uiKeywords = [
    'ui', '界面', '布局', '交互', '按钮', '按钮', '弹窗', '对话框',
    '表单', '输入框', '下拉菜单', '导航', '菜单', '侧边栏', '卡片',
    '样式', 'css', 'html', '组件', '设计', '改样式', '改界面',
    'layout', 'design', 'interface', 'button', 'modal', 'form',
  ];
  if (uiKeywords.some(kw => lowerPrompt.includes(kw))) {
    return TaskCategory.UI_DESIGN;
  }

  // 研究相关关键词
  const researchKeywords = [
    '研究', '调研', '查找', '搜索', '什么', '如何', '怎么',
    '是什么', '为什么', '原理', '解释', '文档', 'api', '资料',
    'research', 'lookup', 'find', 'how', 'what', 'why', 'explain',
    'documentation', 'reference',
  ];
  if (researchKeywords.some(kw => lowerPrompt.includes(kw))) {
    return TaskCategory.RESEARCH;
  }

  // 分析相关关键词（不涉及具体编码）
  const analysisKeywords = [
    '分析', '评估', '比较', '对比', '优缺点', '利弊', '思考',
    '算法', '复杂度', '性能', '优化方案',
    'analyze', 'evaluate', 'compare', 'think', 'algorithm', 'complexity',
  ];
  if (analysisKeywords.some(kw => lowerPrompt.includes(kw))) {
    return TaskCategory.ANALYSIS;
  }

  // 编码相关关键词
  const codingKeywords = [
    '写', '改', '修复', 'bug', '添加', '删除', '重构', '迁移',
    '实现', '开发', '生成', '创建', '编译', '测试', '运行',
    'write', 'fix', 'refactor', 'migrate', 'implement', 'develop',
    'generate', 'create', 'build', 'test', 'run',
  ];
  if (codingKeywords.some(kw => lowerPrompt.includes(kw))) {
    return TaskCategory.CODING;
  }

  return TaskCategory.SIMPLE;
}

// ── 基于AnalysisResult选择Pipeline ──

export function selectPipeline(analysis: AnalysisResult): AgentPipeline {
  const { intent, complexity } = analysis;
  const intentType = typeof intent === 'object' && 'intent' in intent ? intent.intent : intent;

  // 根据意图选择
  switch (intentType) {
    case 'research':
      return PIPELINES[TaskCategory.RESEARCH];

    case 'build':
    case 'add':
    case 'modify':
    case 'refactor':
    case 'migrate':
    case 'delete':
      if (complexity === 'complex') {
        return PIPELINES[TaskCategory.CODING];
      }
      return PIPELINES[TaskCategory.SIMPLE];

    case 'debug':
      return {
        ...PIPELINES[TaskCategory.CODING],
        name: 'debug_pipeline',
        description: '调试任务流程：分析 → 修复 → 验证',
        agents: [AgentRole.THINKER, AgentRole.EDITOR, AgentRole.BASHER],
      };

    default:
      return PIPELINES[TaskCategory.SIMPLE];
  }
}

// ── 获取Agent对应的工具名称 ──

export function getAgentToolName(role: AgentRoleType): string {
  return AGENT_TO_TOOL_MAP[role] ?? role;
}

// ── 获取Pipeline的所有工具名称 ──

export function getPipelineTools(pipeline: AgentPipeline): string[] {
  return pipeline.agents.map(agent => getAgentToolName(agent));
}

// ── 构建Pipeline执行上下文 ──

export interface PipelineContext {
  /** Pipeline名称 */
  pipelineName: string;
  /** 用户原始请求 */
  userPrompt: string;
  /** 选定的Agent */
  agents: AgentRoleType[];
  /** 执行的工具名称 */
  tools: string[];
  /** 是否需要规划阶段 */
  needsPlanning: boolean;
  /** 是否需要审查阶段 */
  needsReview: boolean;
}

export function buildPipelineContext(
  prompt: string,
  analysis?: AnalysisResult,
): PipelineContext {
  const category = classifyTask(prompt);
  const pipeline = analysis
    ? selectPipeline(analysis)
    : PIPELINES[category];

  return {
    pipelineName: pipeline.name,
    userPrompt: prompt,
    agents: pipeline.agents,
    tools: getPipelineTools(pipeline),
    needsPlanning: pipeline.agents.includes(AgentRole.PLANNER),
    needsReview: pipeline.agents.includes(AgentRole.REVIEWER),
  };
}

// ── 生成Pipeline执行提示 ──

export function generatePipelineInstructions(
  context: PipelineContext,
  options?: {
    includeContext?: boolean;
    previousResults?: string[];
  },
): string {
  const { agents, needsPlanning, needsReview } = context;
  const instructions: string[] = [];

  instructions.push(`任务：${context.userPrompt}`);
  instructions.push(`执行流程：${agents.join(' → ')}`);

  if (needsPlanning) {
    instructions.push('\n【规划阶段】');
    instructions.push('1. 先调用 task_planner 制定详细的修改计划');
    instructions.push('2. 计划应包含：步骤、涉及文件、预期结果');
  }

  if (agents.includes(AgentRole.EDITOR)) {
    instructions.push('\n【编辑阶段】');
    instructions.push('- 根据计划执行代码修改');
    instructions.push('- 使用 write_file/edit_file/replace_files 工具');
  }

  if (agents.includes(AgentRole.UI_DESIGNER)) {
    instructions.push('\n【UI设计阶段】');
    instructions.push('- 分析需求并提供设计方案');
    instructions.push('- 包含：界面布局、交互设计、代码实现');
  }

  if (agents.includes(AgentRole.THINKER)) {
    instructions.push('\n【思考阶段】');
    instructions.push('- 深度分析问题');
    instructions.push('- 探索多种解决方案');
  }

  if (agents.includes(AgentRole.RESEARCHER)) {
    instructions.push('\n【研究阶段】');
    instructions.push('- 使用 web_search/web_fetch 查找资料');
    instructions.push('- 整理并总结研究发现');
  }

  if (needsReview) {
    instructions.push('\n【审查阶段】');
    instructions.push('- 审查代码变更的正确性');
    instructions.push('- 检查风格、安全性、性能');
  }

  if (agents.includes(AgentRole.BASHER)) {
    instructions.push('\n【执行阶段】');
    instructions.push('- 使用 execute_command 运行测试');
    instructions.push('- 验证修改正确性');
  }

  if (options?.previousResults && options.previousResults.length > 0) {
    instructions.push('\n【前置结果】');
    options.previousResults.forEach((result, i) => {
      instructions.push(`Step ${i + 1} 结果：${result}`);
    });
  }

  return instructions.join('\n');
}

// ── 快捷函数 ──

/**
 * 获取单个任务的推荐Agent
 */
export function getRecommendedAgent(prompt: string): AgentRoleType {
  const category = classifyTask(prompt);
  const pipeline = PIPELINES[category];
  return pipeline.agents[0];
}

/**
 * 检查是否建议使用多Agent协作
 */
export function shouldUseMultiAgent(prompt: string, analysis?: AnalysisResult): boolean {
  if (analysis && analysis.complexity === 'complex') {
    return true;
  }
  const category = classifyTask(prompt);
  return category !== TaskCategory.SIMPLE;
}

/**
 * 获取任务的Agent组合描述
 */
export function describeAgentCombination(pipeline: AgentPipeline): string {
  const descriptions: Record<AgentRoleType, string> = {
    [AgentRole.PLANNER]: '📋 规划器：制定详细计划',
    [AgentRole.EDITOR]: '✏️ 编辑器：执行代码修改',
    [AgentRole.REVIEWER]: '🔍 审查器：检查代码质量',
    [AgentRole.THINKER]: '🧠 思考器：深度分析问题',
    [AgentRole.UI_DESIGNER]: '🎨 UI设计器：设计界面布局',
    [AgentRole.BASHER]: '⚡ 执行器：运行终端命令',
    [AgentRole.RESEARCHER]: '📚 研究者：查阅网络文档',
  };

  return pipeline.agents.map(a => descriptions[a]).join('\n');
}
