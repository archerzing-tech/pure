# Coding Agent 设计文档（修订版）

> 对应实现：v1.9.2。涉及运行时行为时，以 `src/coding-agent/Planner.ts`、`src/shared/requestWorkflow.ts`、`src/shared/adaptiveControl.ts`、`src/shared/PromptAssembler.ts`、`src/shared/promptObservability.ts`、`src/evaluation/`、`src/ui/chat.ts` 和 `src/cli.ts` 为准。
>
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
  由共享 `src/shared/PromptAssembler.ts` 的 `PromptAssembler.assemble()` 组装 system/user 消息；GUI/CLI 只提供 surface-specific capabilities、实际工具/MCP definitions 与运行时上下文。编译器按 provider/model 预算和 fragment priority 选择片段，并把工具 schema 的非 messages token 开销计入窗口；自定义 provider 可提供模型级预算 metadata。
- **L2 user**：`composeUserTurn(userText, { traps, buildProtocol, plan, clarifications, contract, assessment })`
  把本次请求的逻辑陷阱警告、artifact/增量构建协议、澄清回答、交付契约、已批准计划和主动评估
  拼进 **user 消息**（贴近请求，模型注意力最强；且 system 消息跨会话稳定，不重复计费）。
  `assessment` 由 Coding Agent 层的 `assessIntent()` 生成，包含意图、影响、风险、可逆性和推荐动作。

规则：依赖本次请求的碎片一律进 L2（user 消息）；仅依赖应用状态的在 L1；不可变契约在 L0。

## 1.6 上下文管理：容量策略与任务策略解耦

`ContextEngine` 只负责消息窗口容量、工具 schema 开销和 provider 消息序列有效性，不负责决定复杂任务如何拆分。自动路径调用 `trim()`；CLI REPL 的 `/compact` 与 GUI composer 的 `⌁` 调用结构化 `compact()`，只更新下一轮执行窗口，保留可见 transcript。

实现契约：system 消息保留；assistant 的 `toolCalls` 与全部匹配 tool 结果成组保留或淘汰；不完整调用和孤立结果不进入下一次请求；消息数和估算 Token 数同时作为容量边界；摘要失败时回退到有界窗口。计划阶段数、Todo 粒度、验证顺序和沟通方式仍由模型结合当前任务决定，不能从上下文容量规则推导固定复杂任务流程。

## 1.7 Prompt observability 与真实任务评测

Prompt observability 是组装层和 Harness 的外部观测能力，不是额外的 Prompt 规则，也不改变模型请求内容：

- `PromptAssembler.assemble()` 记录 system/user 长度哈希、fragment 包含/省略、provider/model budget、工具 schema 成本和 `traceId`。
- `Harness.run()` / `continueTurn()` 沿同一 `traceId` 记录 EngineEvent 数量、工具调用、耗时、usage、verification 和最终状态；异常路径通过 `try/finally` 收束 trace。
- 默认使用有界内存存储；`FilePromptObservationStore` 是 Node-only、显式 opt-in 的版本化 JSONL sink。原始 prompt、工具参数、命令输出和最终回答不落盘。
- 自定义 PromptAssembler 与 Harness 必须共享同一 observability sink；MCP/子代理动态注册后的 live tool definitions 必须参与最终 Prompt budget。

真实编码任务基线位于 `src/evaluation/` 与 `evals/`：fixture 每次创建独立 workspace，验证命令决定 `verificationPassed`，只有 agent 正常完成且验证通过才计入 `passAt1`。control、fixture error、agent error 和 verification failure 不得混为成功率；报告至少携带 suite/fixture hash、provider/model、prompt version、runtime、revision、usage、耗时和成本。

## 1.75 自适应控制平面（运行时策略，不固化任务流程）

`src/shared/adaptiveControl.ts` 是 Harness 共享的第一阶段自适应控制平面。它把当前工作区能力、工具数量、verifier、时间、检索到的已验证流程和最近失败/验证证据编译为运行时策略，再由 `PromptAssembler` 注入 `<adaptive_context>`。

策略可调整探索深度、验证强度、委派偏好、失败恢复方式和本地无人执行等级；它不生成固定文件清单、步骤数量或 Todo 拓扑。模型必须根据新的工作区证据修正策略，而不是机械遵循旧建议。权限、路径边界、破坏性操作确认、预算和 verifier 是不可进化的安全不变量。

Harness 只把带有真实验证证据的结果晋升为可复用 `procedure`，避免“模型说完成了”污染长期策略。CLI 与 GUI 都通过 Harness 使用同一控制平面；GUI 的额外 LLM 任务分析只提供语义增强和展示，不复制安全决策。

`src/shared/requestWorkflow.ts` 是 GUI 与 CLI 共用的前置工作流编译器。它不替模型拆分任务，而是把本轮输入和运行时能力编译成可执行的前置决策与 request-scoped Prompt context：

```text
intake → assess → probe? → plan? → confirm? → Harness/Engine → verify → deliver
```

编译结果包括：

- `analysis`：Planner 的保守启发式意图、风险、复杂度和陷阱判断；GUI 随后用任务专属 LLM 分析做语义校准。
- `stage`：`direct`、`probe`、`plan` 或 `confirm`，只表示前置策略，不表示固定的业务步骤。
- `probeRequired / probeAvailable / needsProbe`：区分证据需求与当前能力，避免无工具时假装完成探索。
- `needsDeliveryGate / requiresPlanReview`：决定是否建立交付契约、计划卡或确认闸门。
- `userContext`：动态生成 traps、assessment、artifact/增量构建协议；工作区契约和已批准计划在探针/计划完成后再合并。

CLI 与 GUI 只负责展示阶段、收集用户批准和消费事件；具体读取哪些文件、如何委派子智能体、如何修改和验证，仍由 LLM 依据实际证据决定。GUI 可以进行一轮流式任务预分析并在完成后重新编译 assessment；CLI 为降低额外延迟和 Token 成本，使用同一规则安全下限与动态上下文，直接让主执行 LLM 完成任务规划。规则层只允许抬高安全要求，不能降低它。这样吸收 Freebuff/Claude Code 的“先收集证据、隔离计划、最小授权、验证交付”原则，同时避免把步骤数量或任务类型固化成关键词脚本。

## 2. 任务分析：Planner / analyzeTask

`analyzeTask(prompt)` 不只判断任务复杂度，还会在执行前评估用户意图、影响范围、可逆性和下一步策略。
复杂度与风险是两个独立维度：一个任务可以规模简单但风险很高，也可以规模复杂但属于正常的可控构建。

```typescript
export type RequestIntent =
  'question' | 'research' | 'add' | 'modify' | 'debug' |
  'refactor' | 'migrate' | 'delete' | 'build';
export type RiskLevel = 'low' | 'medium' | 'high';
export type Reversibility =
  'reversible' | 'partially-reversible' | 'hard-to-reverse' | 'irreversible';

export interface IntentAssessment {
  intent: RequestIntent;
  riskLevel: RiskLevel;
  reversibility: Reversibility;
  impact: string;
  recommendation: string;
  requiresProbe: boolean;
  requiresConfirmation: boolean;
}

export interface AnalysisResult {
  complexity: TaskComplexity;
  mode: 'yolo' | 'plan' | 'build';
  plan?: Plan;
  reasoning: string;
  traps: TrapWarning[];
  intent: IntentAssessment;
}
```

### 2.1 主动决策策略

- **低风险**：问题咨询、研究、局部读取、局部修复和单文件新产物可直接进入 `Harness.run`；仍要求先读后写、完成后验证。
- **中风险**：项目级构建、认证/权限/数据库相关改动、迁移、重构等，先执行只读工作区探针，确认真实结构和依赖，再按小步修改并立即验证。
- **高风险**：删除、销毁、覆盖历史、破坏性迁移等，先列出影响、可逆性和更窄/可恢复替代方案；GUI 在任何写操作前通过计划/安全评估卡要求明确确认，高风险后续请求不能被已有计划续接绕过。
- **CLI 展示差异**：CLI 会打印中/高风险评估，并在 workspace/tools 可用且 `requiresProbe` 为 true 时执行只读探针；普通请求默认自动批准，但高风险评估会强制切换到交互式权限处理器，不能只依赖模型遵守 `<intent_assessment>`。需要所有工具逐次交互确认时使用 `--prompt-on-tool`，该开关由 `PermissionManager` 门控具体工具调用，不是另一个 GUI 式计划卡。
- **复杂度**：Planner 的复杂度判断只用于决定是否需要一次额外的 LLM 任务分析，以及在分析失败时提供保守兜底；它不是对任务规模的最终裁决。真实计划由模型根据当前请求和工作区生成，步骤数量、Todo 粒度、阶段标题和执行顺序都是建议，不是安全规则。
- **失败切换**：探针或验证失败时不能机械重试同一方法，应根据证据改变假设、缩小范围或询问缺失决策。

`assessIntent()` 是保守启发式，不替代权限系统：它决定“先分析/探针/确认”的前置策略；`PermissionManager` 仍负责每一次具体工具调用的最终权限门控。任务拆分和沟通方式由 LLM 结合本轮上下文决定，Planner 只在模型分析不可用时提供最小兜底，不自动追加测试步骤或按关键词推断 Todo。

## 3. 工具注册：扁平工具列表 + 功能标签

工具适配器还提供一个与复杂任务策略无关的当前会话恢复端口：成功的 `write_file`、`edit_file`、`replace_files` 和新建目录会记录最近一批写入的前后状态。CLI 的 `/undo` 与 GUI 的撤销按钮调用同一契约；恢复前若检测到外部并发修改则报告冲突，不覆盖新内容。该快照只存在于当前进程，安全边界仍由适配器路径校验和权限系统负责。

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
- `low` 风险工具默认缓存，`medium` 可选缓存；在 GUI 或交互式权限处理器中，`high` 风险工具每次都需要确认。CLI 普通请求默认自动批准，但高风险请求强制使用交互式权限处理器；`--prompt-on-tool` 可将所有请求切换为逐工具确认。
- 缓存键：`serverName?toolName:argsHash`（仅对无副作用的参数哈希）。

### 4.2 MCP 工具特别处理

- MCP 工具的 `riskLevel` 来自 `MCPServerConfig` 或工具元数据。
- 如果 MCP 工具没有标注风险等级，默认为 `medium`。
- GUI 或启用交互式工具确认时，高风险 MCP 工具在执行前必须弹窗/提示确认，并显示完整参数；CLI 的高风险请求会自动启用交互式权限处理器，普通请求仍可保持默认自动批准。

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
prompt
  ↓
Planner.analyzeTask
  ├─ low risk       → 直接进入 Harness.run
  ├─ medium risk    → 只读工作区探针 → Harness.run（小步修改 + 验证）
  ├─ high risk      → 影响/替代方案 → GUI PlanReview / CLI 风险提示 + 权限模式 → Harness.run
  └─ complex/build  → Plan 卡（GUI）/阶段提示（CLI）+ 澄清（必要时）→ 分阶段 Harness.run

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
