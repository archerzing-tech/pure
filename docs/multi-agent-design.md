# 多Agent协作系统设计文档

**版本**: v0.1  
**状态**: 草稿  
**创建日期**: 2026-08-28

---

## 1. 概述

### 1.1 目标
为编码类任务构建多Agent协作系统，通过规划器、编辑器、审查器、思考器、UI设计器、执行器、研究者等角色的分工协作，提高复杂任务的处理能力。

### 1.2 设计原则
- **渐进增强**：不是一次性实现完整系统，而是从最小可用范围开始，逐步增强
- **角色解耦**：每个Agent角色独立定义，通过统一接口协作
- **可复用基础设施**：利用现有的 SubagentOrchestrator、ToolRegistry、Harness

---

## 2. 现有架构分析

### 2.1 当前系统结构

```
User → ChatController → CodingAgent → Harness → AgentLoopEngine
                                    ↓
                              SubagentOrchestrator (执行子Agent)
                                    ↓
                              AgentLoopEngine (每个子Agent独立运行)
```

### 2.2 现有组件

| 组件 | 路径 | 职责 |
|------|------|------|
| `SubagentOrchestrator` | `src/coding-agent/SubagentOrchestrator.ts` | 子Agent执行器，实现 ToolAdapter 接口 |
| `BUILT_IN_SUBAGENTS` | 同上 | 内置4个子Agent：code_reviewer、project_auditor、web_researcher、planner |
| `ToolRegistry` | `src/coding-agent/ToolRegistry.ts` | 工具注册中心，支持 Tags.AGENT 路由到子Agent执行器 |
| `Planner` | `src/coding-agent/Planner.ts` | 任务分析器，用于判断复杂度、生成计划 |
| `CodingAgent` | `src/coding-agent/CodingAgent.ts` | 主Agent，组装各个组件 |
| `AgentLoopEngine` | `src/engine/AgentLoopEngine.ts` | ReAct循环引擎 (THINK → ACT → OBSERVE → VERIFY → TERMINATE) |

### 2.3 现有子Agent模式

```typescript
// SubagentDefinition 结构
interface SubagentDefinition {
  name: string;
  description: string;
  input_schema: object;
  tags: string[];           // 如 [Tags.AGENT, Tags.READ]
  riskLevel: 'low'|'medium'|'high';
  createSystemPrompt: (input: Record<string, unknown>) => string;
  defaultTimeoutMs: number;
}
```

### 2.4 执行流程

1. 主LLM调用子Agent工具（如 `planner`）
2. ToolRegistry 识别 Tags.AGENT，路由到 SubagentOrchestrator
3. SubagentOrchestrator 创建独立的 AgentLoopEngine 实例
4. 子Agent使用自己的 systemPrompt + userPrompt 运行
5. 结果返回给主LLM

---

## 3. 角色定义

### 3.1 核心角色

| 角色 | 名称 | 职责 | 输入 | 输出 |
|------|------|------|------|------|
| **规划器 (Planner)** | task_planner | 制定详细修改计划，决定文件及顺序 | 任务描述、上下文 | 分步骤计划 |
| **编辑器 (Editor)** | code_editor | 根据计划执行精确的代码修改 | 计划步骤、文件内容 | 修改后的文件 |
| **审查器 (Reviewer)** | code_reviewer | 检查代码Bug和风格问题 | 修改后的代码 | 审查报告 |
| **思考器 (Thinker)** | deep_thinker | 处理复杂推理问题 | 复杂问题 | 分析结果 |
| **UI设计器 (UI Designer)** | ui_designer | 界面布局、交互设计 | 设计需求 | 设计方案 |
| **执行器 (Basher)** | bash_executor | 运行终端命令 | 命令 | 执行结果 |
| **研究者 (Researcher)** | researcher | 查阅网络和文档 | 研究主题 | 研究报告 |

### 3.2 角色标签

```typescript
const AgentRole = {
  PLANNER: 'planner',
  EDITOR: 'editor',
  REVIEWER: 'reviewer',
  THINKER: 'thinker',
  UI_DESIGNER: 'ui_designer',
  BASHER: 'basher',
  RESEARCHER: 'researcher',
} as const;
```

---

## 4. 实现计划

### Phase 1: 最小范围改造 (当前)

**目标**：扩展现有的 SubagentOrchestrator，增加新的Agent角色

**文件修改**：
1. `src/coding-agent/SubagentOrchestrator.ts` - 扩展 BUILT_IN_SUBAGENTS
2. `src/coding-agent/types.ts` - 添加 AgentRole 类型

**新增Agent**：
- `deep_thinker` - 深度思考器，处理复杂推理
- `ui_designer` - UI设计器（界面、布局、交互）
- `bash_executor` - 命令执行器
- `task_planner` - 改进版规划器（替换现有的简单 planner）
- `code_editor` - 代码编辑器

**保留现有Agent**：
- `code_reviewer` - 保留并增强
- `web_researcher` - 保留
- `project_auditor` - 保留

### Phase 2: Agent协作机制

**目标**：实现Agent间的消息传递和状态共享

**新增文件**：
- `src/coding-agent/AgentCoordinator.ts` - 协调器，管理多Agent协作
- `src/coding-agent/AgentMessage.ts` - Agent间消息格式

### Phase 3: 智能任务分配

**目标**：根据任务类型自动选择合适的Agent组合

**修改**：
- `src/coding-agent/Planner.ts` - 增强任务分析，根据类型返回Agent组合建议
- `src/coding-agent/CodingAgent.ts` - 根据分析结果启动对应Agent

---

## 5. Phase 1 详细实现

### 5.1 新增Agent定义

```typescript
// src/coding-agent/SubagentOrchestrator.ts 扩展

export const CODING_AGENT_ROLES: SubagentDefinition[] = [
  // === 规划器 ===
  {
    name: 'task_planner',
    description: '制定详细的修改计划，决定修改哪些文件及执行顺序',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '用户任务描述' },
        context: { type: 'string', description: '项目上下文信息' },
        constraints: { type: 'string', description: '约束条件（如技术栈、代码风格）' },
      },
      required: ['task'],
    },
    tags: [Tags.AGENT, Tags.PLAN],
    riskLevel: 'low',
    createSystemPrompt: (input) => `你是一个专业的任务规划师。分析任务并制定详细的修改计划。

任务：${input.task}
上下文：${input.context || '无'}
约束：${input.constraints || '无'}

请制定包含以下信息的计划：
1. 步骤编号和具体动作
2. 涉及的文件列表（按依赖顺序）
3. 每个步骤的预期结果
4. 步骤间的依赖关系

保持步骤原子化，每个步骤一个清晰动作。`,
    defaultTimeoutMs: 60_000,
  },

  // === 编辑器 ===
  {
    name: 'code_editor',
    description: '根据计划执行精确的代码修改',
    input_schema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: '执行计划（JSON格式）' },
        files: { type: 'string', description: '需要修改的文件列表' },
        instructions: { type: 'string', description: '具体的修改指令' },
      },
      required: ['plan', 'instructions'],
    },
    tags: [Tags.AGENT, Tags.WRITE],
    riskLevel: 'medium',
    createSystemPrompt: (input) => `你是一个精确的代码编辑器。根据计划执行代码修改。

计划：${input.plan}
需要修改的文件：${input.files || '待确定'}
修改指令：${input.instructions}

执行时请：
1. 先读取目标文件的当前内容
2. 精确执行计划中的修改
3. 保持代码风格一致
4. 必要时添加注释说明修改原因`,
    defaultTimeoutMs: 120_000,
  },

  // === 审查器 ===
  {
    name: 'code_reviewer',
    description: '审查代码变更的正确性、风格和安全性',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '审查要求' },
        files: { type: 'string', description: '文件路径或代码片段' },
      },
      required: ['prompt'],
    },
    tags: [Tags.AGENT, Tags.READ],
    riskLevel: 'low',
    createSystemPrompt: (input) => {
      const filesHint = typeof input.files === 'string' ? `\n重点审查这些文件：${input.files}` : '';
      return `你是一个严格的代码审查员。审查代码变更：
1. 正确性 — 是否完成预期功能？
2. 风格 — 是否符合项目规范？
3. 安全 — 是否有安全漏洞？
4. 性能 — 是否有明显优化点？
5. 边界情况 — 哪些场景可能出错？${filesHint}

结构化输出审查结果，标注问题严重程度。`;
    },
    defaultTimeoutMs: 120_000,
  },

  // === 思考器 ===
  {
    name: 'deep_thinker',
    description: '专门处理复杂、需要深度推理的问题',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '复杂问题描述' },
        context: { type: 'string', description: '相关上下文' },
        approach: { type: 'string', description: '思考方式（可选：分析、推理、创造等）' },
      },
      required: ['question'],
    },
    tags: [Tags.AGENT],
    riskLevel: 'low',
    createSystemPrompt: (input) => `你是一个深度思考专家。处理复杂问题和需要多步推理的场景。

问题：${input.question}
上下文：${input.context || '无'}
思考方式：${input.approach || '全面分析'}

请进行深度分析：
1. 分解问题为多个子问题
2. 分析各子问题的关系
3. 探索多种解决路径
4. 评估每个路径的优劣
5. 给出推荐方案及理由`,
    defaultTimeoutMs: 180_000,
  },

  // === UI设计器 ===
  {
    name: 'ui_designer',
    description: '负责界面设计、布局规划和交互设计',
    input_schema: {
      type: 'object',
      properties: {
        requirement: { type: 'string', description: 'UI需求描述' },
        type: { type: 'string', description: '设计类型：interface|layout|interaction' },
        context: { type: 'string', description: '现有设计上下文' },
      },
      required: ['requirement'],
    },
    tags: [Tags.AGENT],
    riskLevel: 'low',
    createSystemPrompt: (input) => `你是一个专业的UI设计师。

需求：${input.requirement}
设计类型：${input.type || '综合设计'}
现有上下文：${input.context || '新设计'}

请提供设计方案：
1. **界面设计**：视觉元素、颜色、排版
2. **布局设计**：结构、层次、响应式
3. **交互设计**：用户操作流程、反馈机制

使用清晰的格式输出，便于开发者实现。`,
    defaultTimeoutMs: 120_000,
  },

  // === 执行器 ===
  {
    name: 'bash_executor',
    description: '执行终端命令，返回执行结果',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录' },
        description: { type: 'string', description: '命令用途说明' },
      },
      required: ['command'],
    },
    tags: [Tags.AGENT, Tags.SHELL],
    riskLevel: 'high',
    createSystemPrompt: () => `你是一个命令执行专家。安全地执行终端命令。

请注意：
1. 解释将要执行的命令
2. 执行并捕获输出
3. 分析结果是否成功
4. 如有错误，提供诊断信息

只执行必要的命令，避免破坏性操作。`,
    defaultTimeoutMs: 60_000,
  },

  // === 研究者 ===
  {
    name: 'web_researcher',
    description: '研究主题并总结发现，包括文档查阅',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '研究主题或问题' },
        sources: { type: 'string', description: '优先的信息来源' },
      },
      required: ['prompt'],
    },
    tags: [Tags.AGENT, Tags.SEARCH, Tags.READ],
    riskLevel: 'low',
    createSystemPrompt: (input) => `你是一个专业的研究员。

研究主题：${input.prompt}
优先来源：${input.sources || '综合网络和文档'}

研究方法：
1. 识别关键概念和术语
2. 查找权威来源和文档
3. 整理发现，用清晰简洁的方式总结
4. 包含相关的代码示例或API签名
5. 标注版本相关注意事项

保持研究全面但简洁，使用清晰的标题组织。`,
    defaultTimeoutMs: 180_000,
  },
];
```

### 5.2 Agent角色类型

```typescript
// src/coding-agent/types.ts 新增

export const AgentRole = {
  PLANNER: 'planner',
  EDITOR: 'editor',
  REVIEWER: 'reviewer',
  THINKER: 'thinker',
  UI_DESIGNER: 'ui_designer',
  BASHER: 'basher',
  RESEARCHER: 'researcher',
} as const;

export type AgentRoleType = typeof AgentRole[keyof typeof AgentRole];

export interface AgentConfig {
  role: AgentRoleType;
  name: string;
  timeoutMs?: number;
  retryable?: boolean;
}

export interface AgentTask {
  id: string;
  agent: AgentConfig;
  input: Record<string, unknown>;
  dependsOn?: string[];
}

export interface AgentResult {
  id: string;
  agent: AgentConfig;
  success: boolean;
  output?: string;
  error?: string;
  duration: number;
}
```

### 5.3 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `src/coding-agent/types.ts` | 扩展 | 添加 AgentRole、AgentConfig、AgentTask、AgentResult 类型 |
| `src/coding-agent/SubagentOrchestrator.ts` | 扩展 | 添加新的 BUILT_IN_SUBAGENTS 定义 |

---

## 6. 使用示例

### 6.1 简单调用单个Agent

```
用户: 帮我分析这个复杂的算法问题

主Agent判断这是一个复杂推理任务，调用 deep_thinker：

输入：
{
  "question": "帮我分析这个复杂的算法问题",
  "context": "这是一个关于...",
  "approach": "分析"
}

输出：
[深度分析结果...]
```

### 6.2 编码任务的多Agent协作

```
用户: 重构这个模块，要求提高性能

主Agent判断这是一个编码任务，启动协作：

1. task_planner: 制定重构计划
   → 输出分步骤计划

2. code_editor: 按计划执行修改
   → 输出修改后的代码

3. code_reviewer: 审查变更
   → 输出审查报告

4. bash_executor: 运行测试
   → 验证修改正确性
```

---

## 7. Phase 2 & 3 实现总结

### 7.1 已完成组件

| 文件 | 说明 |
|------|------|
| `src/coding-agent/AgentMessage.ts` | Agent间消息协议：消息类型、状态定义、消息生成器 |
| `src/coding-agent/AgentCoordinator.ts` | 多Agent协调器：任务队列、依赖管理、结果聚合 |
| `src/coding-agent/TaskDispatcher.ts` | 智能任务分配：根据任务类型选择合适的Agent Pipeline |
| `src/coding-agent/DynamicPipeline.ts` | 动态Pipeline：支持调整、并行执行、错误恢复 |

### 7.2 Phase 4 核心功能

#### 动态调整决策
```typescript
interface AdjustmentDecision {
  shouldAdjust: boolean;
  type: 'add' | 'remove' | 'reorder' | 'replace' | 'none';
  reason: string;
  newAgents?: AgentRoleType[];
  suggestion?: string;
}

// 根据错误类型自动调整Pipeline
- 网络/超时错误 → 添加 researcher 收集信息
- 规划失败 → 简化流程直接执行
- 编辑失败 → 添加 thinker 分析问题
- 测试失败 → 跳过测试阶段
```

#### 并行执行支持
```typescript
// 可并行的Agent组合
parallelizableGroups: [
  [RESEARCHER, UI_DESIGNER],  // 研究和UI设计可以并行
]

// 获取可并行执行的Agent
getParallelizableAgents(): AgentRoleType[]
canParallelize(): boolean
```

#### 错误恢复策略
```typescript
// 自动重试机制
maxRetries: 2  // 失败后自动重试2次

// 执行状态追踪
ExecutionState: PENDING | RUNNING | SUCCESS | FAILED | RETRYING | SKIPPED
```

### 7.3 使用示例

```typescript
import { DynamicPipelineController, analyzeTaskForPipeline } from './DynamicPipeline';

// 1. 分析任务
const analysis = analyzeTaskForPipeline("重构这个模块");
console.log(analysis.recommendedPipeline); // coding_pipeline
console.log(analysis.suggestions); // ["建议启用审查阶段"]

// 2. 创建控制器
const controller = new DynamicPipelineController({ maxRetries: 3 });

// 3. 初始化执行
controller.initExecution("重构模块", [PLANNER, EDITOR, REVIEWER], 'coding_pipeline');

// 4. 执行并处理结果
let agent = controller.getNextAgent();
while (agent) {
  controller.startAgent(agent);
  // ... 执行agent ...
  if (success) {
    controller.completeAgent(agent, output);
  } else {
    const decision = controller.failAgent(agent, error);
    if (decision.shouldAdjust) {
      controller.applyAdjustment(decision);
    }
  }
  agent = controller.getNextAgent();
}
```

---

## 8. 已完成功能清单

```typescript
// TaskDispatcher.ts

export const PIPELINES = {
  coding_pipeline: [PLANNER, EDITOR, REVIEWER, BASHER],      // 规划→编辑→审查→测试
  research_pipeline: [RESEARCHER, THINKER],                 // 研究→深度分析
  ui_design_pipeline: [UI_DESIGNER, EDITOR, REVIEWER],     // 设计→实现→审查
  analysis_pipeline: [THINKER, RESEARCHER],                // 深度思考→研究
  simple_pipeline: [EDITOR],                               // 直接执行
};
```

### 7.3 使用示例

```typescript
import { classifyTask, buildPipelineContext, generatePipelineInstructions } from './TaskDispatcher';

// 1. 分类任务
const category = classifyTask("帮我重构这个模块");
// → 'coding'

// 2. 获取执行Pipeline
const context = buildPipelineContext("帮我重构这个模块");
// → { agents: [PLANNER, EDITOR, REVIEWER, BASHER], tools: [...], ... }

// 3. 生成执行指令
const instructions = generatePipelineInstructions(context);
// → "任务：帮我重构这个模块\n执行流程：planner → editor → reviewer → basher\n..."
```

---

## 9. Phase 5 后续规划

- **结果缓存**：缓存Agent输出，支持增量修改
- **性能监控**：实时监控各Agent的执行效率
- **学习优化**：基于历史执行数据优化Pipeline选择

---

## 9. 附录

### 8.1 Tags 常量参考

```typescript
export const Tags = {
  READ: 'read',
  WRITE: 'write',
  DESTRUCTIVE: 'destructive',
  SHELL: 'shell',
  AGENT: 'agent',
  PLAN: 'plan',
  FS: 'fs',
  SEARCH: 'search',
  MCP: 'mcp',
} as const;
```

### 8.2 SubagentDefinition 完整结构

```typescript
interface SubagentDefinition extends TaggedTool {
  createSystemPrompt: (input: Record<string, unknown>) => string;
  defaultTimeoutMs: number;
}
```
