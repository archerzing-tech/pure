# Coding Agent 设计文档（修订版）

> PHASE 5–8. 依赖 Harness / Engine / Adapter。原始草稿的 **Planner/analyzeTask 只有流程图无定义**、
> **扁平工具列表示例不完整**、**权限用进程内 EventBus 做 request-response
> （跨 WebView↔Rust 不成立）**。本版补齐。系统提示词见 `system-prompt.md`，
> **分层 prompt 架构（system/application/user）见 `system-prompt.md` 头部与 `src/shared/promptLayers.ts`**。

## 1. 应用层职责

Coding Agent 是组装层：把 Engine + Harness + Adapter 串成一次用户任务，并负责
**任务分析（Planner）、工具注册（ToolRegistry/Tags）、权限（PermissionManager）、验证（Verifier）**。

## 1.5 Prompt 分层组装

Coding Agent 端到端组装 prompt 时按三层（见 `src/shared/promptLayers.ts`）：

- **L0 system**：`SYSTEM_CORE_PROMPT`（不可变身份 + 操作原则 + 权限模式 + 运行时 + 响应格式，
  单一来源）。
- **L1 application**：工具块（`<capabilities>`）、`WORKFLOW_PROMPT` + `COMPLETION_PROMPT`、
  输出风格、工具调用规则、typo 容错、逻辑陷阱防御 + 环境/运行时/技能/任务模式上下文 ——
  由 GUI `chat.ts` 与 CLI `cli.ts` 的 `buildSystemPrompt()` 组装进 system 消息。
- **L2 user**：`composeUserTurn(userText, { traps, artifact, plan })` 把本次请求的
  trap 警告、artifact 构建协议、已批准计划拼进 **user 消息**（贴近请求，模型注意力最强；
  且 system 消息跨会话稳定，不重复计费）。

规则：依赖本次请求的碎片一律进 L2（user 消息）；仅依赖应用状态的在 L1；不可变契约在 L0。

## 2. 任务分析：Planner / analyzeTask（原版缺失，现补齐）

`analyzeTask(prompt)` 决定走"直接执行"还是"先计划"。

```typescript
// [SPEC] 必须实现
export interface PlanStep { id: string; action: string; description: string; expectedOutcome: string; }
export interface Plan { steps: PlanStep[]; reasoning: string; }
export type TaskComplexity = 'simple' | 'complex';

export interface CodingAgent {
  analyzeTask(prompt: string): { complexity: TaskComplexity; plan?: Plan };
  run(prompt: string, opts?: { mode?: PermissionMode; signal?: AbortSignal }):
    Promise<{ stream: StreamManager; result: Promise<AgentResult> }>;
}
```

规则（可调整）：
- `complexity = 'complex'` 当：涉及 >3 个文件、需要新建模块、或用户明确要求"先规划"。
- `complex` → 生成 `Plan` → 通过 IPC 让前端 `PlanReview` 组件展示 → 用户确认后才 `Harness.run`。
- `simple` → 直接 `Harness.run`。

## 3. 工具注册：扁平工具列表 + 功能标签

`ToolRegistry` 实现 `ToolAdapter`，内部使用**扁平工具列表**。每个工具附带一组功能标签，
用于权限控制、风险分级和路由，而不是强制的层级分类。

### 3.1 内置工具与标签

| 工具名 | 标签 | 说明 |
|--------|------|------|
| `read_file` | `['fs', 'read']` | 读取文件 |
| `write_file` | `['fs', 'write', 'destructive']` | 写入文件 |
| `edit_file` | `['fs', 'write', 'destructive']` | 替换文件内容 |
| `list_files` | `['fs', 'read']` | 列出目录 |
| `search_files` | `['fs', 'read', 'search']` | 文件搜索 |
| `execute_command` | `['shell', 'destructive']` | 执行 shell 命令 |
| `spawn_subagent` | `['agent']` | 创建子代理 |
| `show_plan` | `['plan']` | 返回当前 Plan |

### 3.2 MCP 工具注入

MCP 工具从 `MCPClient.listTools()` 动态注入，额外携带 `riskLevel` 和 `serverName`。
工具名冲突时使用 `serverName:toolName` 格式。

```typescript
export interface TaggedTool extends ToolDefinition {
  tags: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  serverName?: string;
}

export class ToolRegistry implements ToolAdapter {
  private tools: TaggedTool[] = [];

  register(tool: TaggedTool): void {
    this.tools.push(tool);
  }

  getTools(): ToolDefinition[] {
    return this.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  }

  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean; affectedPaths?: string[] } {
    const tool = this.tools.find(t => t.name === toolName);
    if (!tool) return undefined;
    return {
      sideEffects: tool.tags.includes('destructive') || tool.tags.includes('shell'),
      isWrite: tool.tags.includes('write') || tool.tags.includes('destructive'),
      affectedPaths: tool.tags.includes('fs') ? [] : undefined,
    };
  }
}
```

### 3.3 标签约定

| 标签 | 含义 |
|:-----|:-----|
| `read` | 只读操作 |
| `write` | 写操作 |
| `destructive` | 可能修改状态或执行命令 |
| `shell` | 执行 shell 命令 |
| `agent` | 子代理相关 |
| `plan` | 计划相关 |
| `mcp` | 来自 MCP Server |

## 4. 权限：IPC 往返与 MCP 工具审批（原版用错机制）

原版 `PermissionManager.askUser` 调 `eventBus.request('perm:request')`——但 EventBus 在 WebView
进程内，弹窗在 WebView、决策需回 Rust/前端，**同一进程内的 request 拿不到 UI 响应**。

修正为 **Tauri 双向通道**，并增加对 MCP 工具的审批：

```typescript
// [REF] 权限请求走 Tauri invoke，前端弹窗后回传
async askUser(tool: string, ctx: PermissionContext): Promise<PermissionDecision> {
  if (this.mode === PermissionMode.YOLO) return { allowed: true, autoApproved: true };
  if (this.mode === PermissionMode.PLAN && !ctx.isRead) return { allowed: false, reason: 'PLAN mode: read-only' };
  if (this.mode === PermissionMode.DONT_ASK) return { allowed: ctx.isRead, reason: 'DONT_ASK' };

  // 对 MCP 工具，基于风险等级决定是否需要显式确认
  const risk = ctx.riskLevel ?? 'medium';
  if (risk === 'low' && this.cache.has(tool)) {
    return { allowed: true, autoApproved: true, reason: 'cached low-risk MCP tool' };
  }

  // NORMAL：调用前端已注册的 handler（WebView 内），或经 invoke 到 Rust 再到 UI
  return (await this.requestFn?.({
    tool,
    command: ctx.command,
    description: ctx.description,
    dangerLevel: this.dangerLevel(tool, ctx),
    riskLevel: risk,
    serverName: ctx.serverName,
  })) ?? { allowed: false };
}
```

### 4.1 权限缓存

- 同一会话内，用户对某工具的批准可以缓存。
- `low` 风险工具默认缓存，`medium` 可选缓存，`high` 每次都需要确认。
- 缓存键：`serverName?toolName:argsHash`（仅对无副作用的参数哈希）。

### 4.2 MCP 工具特别处理

- MCP 工具的 `riskLevel` 来自 `MCPServerConfig` 或工具元数据。
- 如果 MCP 工具没有标注风险等级，默认为 `medium`。
- 高风险 MCP 工具在执行前必须弹窗确认，并显示完整参数。

前端把 `PermissionDialog` 的结果通过 Tauri event/channel 回传；`DONT_ASK` 模式现在**只读放行、写操作拒绝**（原版默认 `allowed:true` 是 bug）。

## 5. 主动解决问题工作流

Coding Agent 不应把“调用一次工具并返回结果”当作完成。每个任务按以下闭环运行：

1. **理解**：确认目标、约束、环境和完成定义；先查看仓库结构、相关文件、配置和可用命令。
2. **诊断**：遇到错误时读取完整错误、复现或隔离问题，并判断是代码、数据、依赖、环境、权限、网络还是错误前提。
3. **研究**：遇到不熟悉的库、API、格式或平台行为，主动使用 web/docs 工具和本地权威文档；不得编造 API。
4. **补齐工具**：缺少依赖或开发工具时，优先使用项目既有包管理器做本地、可复现安装。系统级安装、凭据、付费服务、生产变更和破坏性操作必须先获得用户确认。
5. **换路**：第一次失败后必须改变假设或方法；禁止无新证据重复同一个命令、查询或补丁。多次失败后使用 fallback、缩小问题，或向用户提出唯一缺失决策。
6. **验证**：先运行最小相关测试，再按需运行类型检查、lint、全量测试和构建；没有验证结果不得声称成功。
7. **沉淀**：任务结束记录“症状、根因、成功路径、验证命令、下次避免事项”，写入长期记忆供相似任务检索。

GUI 与 CLI 必须注入同一份主动工作流提示，避免行为漂移。Harness 的 `successful_pattern` 应记录可复用成功路径，而不只是“session completed”。

## 6. 验证：Verifier

`Verifier implements VerifierAdapter`。Engine 在 VERIFY 阶段调用 `verifier.evaluate({ output, context })`，
返回 `{ passed: boolean }`。Verifier 内部可按优先级分级执行检查（如先跑 lint 再跑 test），
但这些是内部实现策略，对 Engine 透明。
用户确认（写文件前）放在 quick 第 3 步，避免拒绝时浪费计算。Engine 在 VERIFY 阶段调用
`verifier.evaluate`；不通过则回到 THINK 重试。

## 7. 用户体验流程（修正后）

```
prompt → analyzeTask → simple: Harness.run
                       complex: Planner → PlanReview(UI) → 确认 → Harness.run
Harness.run → Engine.run (流式 EngineEvent)
  TokenDelta → ChatPanel 流式文本
  StateChange → 状态指示器
  ToolResult → 工具输出 / Diff
  BudgetWarning → 预算条
  Completed/Interrupted → 结束
```

## 8. 前端 / Rust（保持原版结构，修正边界）

- 前端 `AgentAPI` 通过 Tauri `Channel` 收 `EngineEvent`，本地 `StreamManager` 合并后渲染。
- Rust `SessionManager` **只持有 Rust 侧资源**（PTY、MCP 子进程、文件 watcher），按 `sessionId`
  索引；**不持有 TS `Harness`**（见 `pure Spec.md` §2）。
- `execute_command` 在 Rust 内用 PTY 跑命令并流式回传 stdout。
