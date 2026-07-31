# Coding Agent 设计文档（修订版）

> PHASE 5–8. 依赖 Harness / Engine / Adapter。原始草稿的 **Planner/analyzeTask 只有流程图无定义**、
> **扁平工具列表示例不完整**、**权限用进程内 EventBus 做 request-response
> （跨 WebView↔Rust 不成立）**。本版补齐。系统提示词见 `system-prompt.md`。

## 1. 应用层职责

Coding Agent 是组装层：把 Engine + Harness + Adapter 串成一次用户任务，并负责
**任务分析（Planner）、工具注册（ToolRegistry/Tags）、权限（PermissionManager）、验证（Verifier）**。

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

## 5. 验证：Verifier

`Verifier implements VerifierAdapter`。Engine 在 VERIFY 阶段调用 `verifier.evaluate({ output, context })`，
返回 `{ passed: boolean }`。Verifier 内部可按优先级分级执行检查（如先跑 lint 再跑 test），
但这些是内部实现策略，对 Engine 透明。
用户确认（写文件前）放在 quick 第 3 步，避免拒绝时浪费计算。Engine 在 VERIFY 阶段调用
`verifier.evaluate`；不通过则回到 THINK 重试。

## 6. 用户体验流程（修正后）

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

## 7. 前端 / Rust（保持原版结构，修正边界）

- 前端 `AgentAPI` 通过 Tauri `Channel` 收 `EngineEvent`，本地 `StreamManager` 合并后渲染。
- Rust `SessionManager` **只持有 Rust 侧资源**（PTY、MCP 子进程、文件 watcher），按 `sessionId`
  索引；**不持有 TS `Harness`**（见 `pure Spec.md` §2）。
- `execute_command` 在 Rust 内用 PTY 跑命令并流式回传 stdout。
