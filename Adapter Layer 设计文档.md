# Adapter Layer 设计文档

> ⚠️ **PHASE 4 / REFERENCE DOCUMENT** — 本文档是 Adapter Layer（接入层）的完整实现参考。
> 📗 核心规范请见 `pure Spec.md`（Prompt-Ready Implementation Guide）第 4-5 节。
>
> **实施顺序**：Phase 4 — 与 Phase 2 (Engine) 和 Phase 3 (Harness) 并行实施，
> 但所有 Adapter 接口定义（`LLMAdapter`、`ToolAdapter`、`IStateStore`）必须早于 Engine 和 Harness，
> 因为它们被 EngineContext 和 HarnessConfig 引用。

## 1. 文档概述

### 1.1 文档定位

本文档定义 **Adapter Layer（接入层）** 的设计规范——四层架构的第一层，所有外部依赖（LLM API、
文件系统、MCP Server、持久化存储）通过此层注入。Adapter Layer 是**所有 I/O 的抽象边界**，
使上层（Engine / Harness / Coding Agent）保持运行时无关和可测试性。

### 1.2 设计概要

Adapter Layer 按职责分为 **5 个适配器类别**：

| 类别 | 接口 | 职责 | 已有实现 | 待实现 |
|:-----|:-----|:------|:---------|:-------|
| **LLM Adapter** | `LLMAdapter` | 与大语言模型 API 通信 | Anthropic (`@anthropic-ai/sdk`), OpenAI (`openai`, 13 测试), Mock (脚本化测试) | Ollama |
| **Tool Adapter** | `ToolAdapter` | 执行工具调用（文件/Shell/搜索） | NodeToolAdapter (fs + exec), Mock (内存文件) | ShellToolAdapter (Rust PTY), SandboxToolAdapter |
| **Storage Adapter** | `IStateStore` | 会话状态持久化（检查点存储） | SQLiteStore (better-sqlite3), FSStore (Node.js fs, 18 测试) | WASMSQLiteStore (sql.js WASM) |
| **Memory Adapter** | `IMemoryStore` | 跨会话长期记忆（偏好/错误模式/项目惯例） | — | FSStore 实现（计划中）、WASMEmbeddingStore（transformers.js WASM，计划） |
| **MCP Transport** | `MCPSession`（Harness 层引用） | MCP Server 连接（JSON-RPC over stdio/HTTP/SSE） | StdioTransport (child_process, 8 测试), HttpClientTransport (fetch, 11 测试) | 无 |

### 1.3 设计原则

| 原则 | 说明 |
|:-----|:------|
| **接口隔离** | 每个 Adapter 仅定义一个职责——LLM / Tool 不共享同一个接口 |
| **运行时无关** | Adapter 接口定义在 Shared Kernel（纯 TS），实现可以有外部依赖 |
| **可 Mock 测试** | 每个 Adapter 至少有一个 Mock 实现，供上层单元测试使用 |
| **适配器即配置** | 所有 Adapter 实现通过 Harness/Coding Agent 的构造函数注入，无全局单例 |
| **错误不吞没** | Adapter 抛出的错误由 Engine/Harness 统一处理（Error 事件），Adapter 不自行处理 |

---

## 2. 五类 Adapter 全景

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          Adapter Layer（接入层）                                   │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │  LLM Adapters (LLMAdapter)     │  API        │ Model Used                │  │
│  │  ├─ AnthropicLLMAdapter        │  fetch/SSE  │ claude-sonnet-4-20250514  │  │
│  │  ├─ OpenAIAdapter (已实现)     │  fetch/SSE  │ gpt-4o                    │  │
│  │  ├─ OllamaAdapter (计划)       │  HTTP       │ llama3.1 (本地)           │  │
│  │  └─ MockLLMAdapter (测试)      │  —          │ 脚本化                    │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │  Tool Adapters (ToolAdapter)  │  Runtime     │ Security                  │  │
│  │  ├─ NodeToolAdapter           │  Node.js     │ path.resolve + prefix 检查│  │
│  │  ├─ ShellToolAdapter (计划)   │  Rust PTY    │ Tauri IPC invoke          │  │
│  │  ├─ SandboxToolAdapter (计划) │  Docker/NS   │ 沙箱隔离                  │  │
│  │  └─ MockToolAdapter (测试)    │  —           │ 内存虚拟文件系统          │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │  Storage Adapters (IStateStore)  │  Backend   │ 特点                     │  │
│  │  ├─ SQLiteStore (已实现)         │  better-sqlite3 │ 持久化 + 事务       │  │
│  │  ├─ FSStore (已实现)             │  fs         │ 文件式存储，无依赖      │  │
│  │  └─ WASMSQLiteStore (计划)       │  sql.js (WASM) │ 跨运行时，零 native 依赖 │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │  MCP Transports              │  Protocol   │ 适用场景                   │  │
│  │  ├─ StdioTransport (已实现)   │  stdio      │ child_process, 8 测试     │  │
│  │  └─ HttpClientTransport (已实现)│ HTTP       │ fetch, 11 测试            │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 3. LLM Adapter

### 3.1 接口定义（Shared Kernel）

> 完整的 `LLMAdapter` 接口定义见 `pure Spec.md` §4 (Canonical types)。
> 所有 LLM 实现必须实现此接口。**不得**在此文档中重新定义。

```typescript
// pure Spec.md §4 定义的规范接口：
// interface LLMAdapter {
//   stream(messages: Message[], tools: ToolDefinition[], signal?: AbortSignal):
//     AsyncGenerator<LLMChunk, void, void>;
//   complete(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse>;
// }

// LLMChunk union type (streaming events)：
//   { type: 'content'; content: string }
//   { type: 'tool_call_delta'; index: number; name?: string; arguments?: string }
//   { type: 'tool_call'; index: number; id: string; name: string; arguments: string }
//   { type: 'done'; content: string; toolCalls: ToolCall[] }
```

**关键约定**：
- `stream()` 的 `AsyncGenerator` 必须最终 yield 一个 `done` 类型的 chunk，携带完整 content 和 toolCalls。
- `complete()` 返回 `LLMResponse`，内容与 `done` chunk 一致。
- `tools` 参数在每个 LLM 调用时传入（不是仅在初始化时），确保 LLM 始终知道可用工具。
- 当 `AbortSignal` 触发时，`stream()` 应尽快停止 yield 并 return（不 yield `done`）。

### 3.1.1 Tauri IPC Transport（v0.5.5 — 桌面端首选）

> **架构决策**：Desktop 构建中，LLM 流式请求通过 Tauri IPC 代理（Rust reqwest → HTTP/2 SSE → Tauri Channel），
> 而非浏览器 `fetch()`。API Key 仅在 Rust 侧持有，永不暴露到 WebView JS 上下文。

```
┌─ WebView (JS) ─────────────────────┐    ┌─ Rust (Tauri) ────────────────────┐
│                                     │    │                                    │
│  const ch = new Channel();          │    │  #[tauri::command]                 │
│  ch.onmessage = (data) => {         │    │  async fn chat_stream(             │
│    // delta.content → UI             │    │    ...,                            │
│    // delta.tool_calls → accumulate  │    │    ch: Channel<String>,           │
│  };                                 │    │  ) {                              │
│                                     │    │    let client = reqwest::Client    │
│  const result = await invoke(       │    │      ::builder()                   │
│    'chat_stream', {                 │    │      .http2_prior_knowledge()      │
│      messages, tools, model,        │    │      .build()?;                   │
│      apiKey, baseUrl,               │    │                                    │
│      onChunk: ch,                   │    │    let mut resp = client           │
│    }                                │    │      .post(url)                    │
│  );                                 │    │      .bearer_auth(api_key)         │
│  // result = { text, toolCalls }    │    │      .json(&body)                  │
│                                     │    │      .send().await?;               │
└─────────────────────────────────────┘    │                                    │
                                           │    while let Some(chunk) =         │
                                           │      resp.chunk().await? {         │
                                           │      // parse SSE line             │
                                           │      ch.send(json!({               │
                                           │        type: "delta",              │
                                           │        content: chunk              │
                                           │      }))?;                         │
                                           │    }                                │
                                           │    Ok(json!({text, toolCalls}))    │
                                           │  }                                 │
                                           └────────────────────────────────────┘
```

**优势**：
| 维度 | 浏览器 fetch SSE | Tauri IPC (reqwest) |
|:------|:------|:------|
| API Key 安全 | ❌ 暴露在 JS | ✅ 仅 Rust 侧 |
| HTTP/2 多路复用 | ❌ 不保证 | ✅ reqwest 原生 H2 |
| 连接池 | ❌ 6/domain | ✅ 无限制 |
| CORS | ❌ 问题 | ✅ 不需要 |
| 取消 | AbortController | Channel drop |

**Fallback**：`vite dev` 纯浏览器模式回退到 `fetch()` SSE（当前 v0.7 方案）。

### 3.2 AnthropicLLMAdapter（已实现）

**文件**：`src/adapter/anthropic/AnthropicLLMAdapter.ts`

#### 架构

```
AnthropicLLMAdapter implements LLMAdapter
│
├─ constructor(config?: AnthropicAdapterConfig)
│   ├─ apiKey → process.env.ANTHROPIC_API_KEY
│   ├─ model → 'claude-sonnet-4-20250514' (默认)
│   ├─ maxTokens → 8192 (默认)
│   └─ temperature → 0 (默认)
│
├─ stream(messages, tools, signal)
│   └─ 使用 @anthropic-ai/sdk 的 messages.stream() API
│       ├─ splitSystemMessage() → system / conversationMessages
│       ├─ tools → anthropic Tool[] 映射
│       ├─ 监听 content_block_start / content_block_delta / content_block_stop
│       ├─ 累积 tool_use 参数到 Map<index, {id, name, arguments}>
│       ├─ yield content / tool_call_delta / tool_call chunks
│       └─ 最终 yield done chunk
│
├─ complete(messages, tools)
│   └─ 使用 @anthropic-ai/sdk 的 messages.create() API (非流式)
│       ├─ 分离 system message
│       ├─ tools 映射
│       └─ 解析 response.content → text blocks + tool_use blocks
│
└─ splitSystemMessage(messages)
    └─ 将 system role 提取到顶层 system 参数
        ├─ user → { role: 'user', content }
        ├─ assistant → { role: 'assistant', content } 或含 tool_use content blocks
        └─ tool → { role: 'user', content: [tool_result] } 累积到同一条 user 消息
```

#### 关键实现细节

**System message 处理**：Anthropic API 要求 system 作为顶层参数而非消息数组中的一条。
`splitSystemMessage()` 将 messages 数组中所有 `role: 'system'` 的消息合并为一个 system 字符串。

**Tool result 累积**：当连续多个 tool result 时，`splitSystemMessage()` 将它们累积到同一条
`role: 'user', content: [tool_result, tool_result, ...]` 消息中。这符合 Anthropic 的
`tool_result` content block API。

**流式工具调用构建**：Anthropic 的 `tool_use` 通过 `content_block_start`（id + name）和
`content_block_delta`（`input_json_delta` → partial_json）两个事件逐步构建。实现使用
`Map<index, ToolBlock>` 累积，在 `content_block_stop` 时 yield `tool_call`。

#### 配置

```typescript
interface AnthropicAdapterConfig {
  apiKey?: string;      // 默认 process.env.ANTHROPIC_API_KEY
  model?: string;       // 默认 'claude-sonnet-4-20250514'
  maxTokens?: number;   // 默认 8192
  temperature?: number; // 默认 0
}
```

### 3.3 MockLLMAdapter（已实现，测试用）

**文件**：`src/adapter/mock/MockLLMAdapter.ts`

脚本化的 LLM 适配器，用于 Engine/Harness 单元测试。通过预定义的 `ScriptedTurn[]` 数组控制每轮输出。

```typescript
interface ScriptedTurn {
  content?: string;                                    // 本轮返回的文本
  toolCalls?: Array<{ name: string; arguments: string }>; // 本轮返回的工具调用
}
```

**行为**：
- `stream()` 逐字符 yield `content` chunk，然后 yield `tool_call` chunk，最后 yield `done` chunk。
- `complete()` 直接返回 `LLMResponse`。
- `reset()` 将 `turnIndex` 归零，支持测试间复用。
- 轮次超出 `turns[]` 长度时，重复使用最后一个 turn（适合固定模式测试）。

### 3.4 OpenAIAdapter（已实现）

**文件**：`src/adapter/openai/OpenAIAdapter.ts`（215 行）
**测试**：`src/adapter/openai/__tests__/OpenAIAdapter.test.ts`（13 个测试）

使用 `openai` npm 包的 `chat.completions.create()` API，支持流式和非流式调用。

#### 架构

```
OpenAIAdapter implements LLMAdapter
│
├─ constructor(config?: OpenAIAdapterConfig)
│   ├─ apiKey → process.env.OPENAI_API_KEY
│   ├─ model → 'gpt-4o' (默认)
│   ├─ maxTokens → 4096 (默认)
│   ├─ temperature → 0 (默认)
│   └─ fetch → custom fetch (测试注入)
│
├─ stream(messages, tools, signal)
│   └─ 使用 openai SDK 的 chat.completions.create({ stream: true })
│       ├─ mapMessages() → ChatCompletionMessageParam[]
│       ├─ mapTools() → ChatCompletionTool[] (type: 'function' 包装)
│       ├─ 监听 delta.content / delta.tool_calls[]
│       ├─ 累积 tool_calls 到 Map<index, {id, name, arguments}>
│       ├─ yield content / tool_call_delta / tool_call chunks
│       └─ 最终 yield done chunk（仅当 finishedCleanly）
│
├─ complete(messages, tools)
│   └─ 使用 openai SDK 的 chat.completions.create() (非流式)
│       ├─ mapMessages() → OpenAI 格式
│       ├─ 解析 choices[0].message.content + tool_calls
│       └─ 过滤 type === 'function' 的 tool calls（窄化联合类型）
│
├─ mapMessages(messages)
│   ├─ system → { role: 'system', content }
│   ├─ user → { role: 'user', content }
│   ├─ assistant → { role: 'assistant', content, tool_calls? }
│   └─ tool → { role: 'tool', tool_call_id, content }
│
└─ mapTools(tools)
    └─ { type: 'function', function: { name, description, parameters } }
```

#### 与 Anthropic 的关键差异

| 特性 | Anthropic | OpenAI |
|:-----|:----------|:-------|
| System message | 顶层 `system` 参数 | `role: 'system'` 普通消息 |
| Tool result | `tool_result` content block | `role: 'tool'` + `tool_call_id` |
| 工具格式 | 直接 `{name, description, input_schema}` | `{type:'function', function:{...}}` 包装 |
| 流式工具调用 | `content_block_start/delta/stop` | `delta.tool_calls[]` (index + function) |
| 测试 | 15 测试（fetch mock） | 13 测试（fetch mock） |

### 3.5 OllamaAdapter 实现指引（待实现）

> **实现计划**：Phase 7（本地开发场景）

```typescript
// 参考骨架 — src/adapter/ollama/OllamaAdapter.ts
// 使用 Ollama 的 HTTP API（兼容 OpenAI 格式，但也支持原生 API）

export class OllamaAdapter implements LLMAdapter {
  private baseUrl: string;
  private model: string;

  constructor(config?: { baseUrl?: string; model?: string }) {
    this.baseUrl = config?.baseUrl ?? 'http://localhost:11434';
    this.model = config?.model ?? 'llama3.1';
  }

  async *stream(messages, tools, signal): AsyncGenerator<LLMChunk> {
    // 使用 Ollama chat API（与 OpenAI 兼容但建议用原生 API）
    // 原生 API: POST /api/chat → SSE stream
    // 工具支持：Ollama 3.1+ 支持 tool_calls，需要在 request 中传入 tools
  }
  // ...
}
```

**注意事项**：
- Ollama 的工具支持因模型而异（llama3.1+ 支持工具，但质量较低）。
- 建议回退到纯文本模式（不传 tools）当模型不支持工具调用时。

---

## 4. Tool Adapter

### 4.1 接口定义（Shared Kernel）

> 完整的 `ToolAdapter` 接口定义见 `pure Spec.md` §4。
> 所有 Tool 实现必须实现此接口。

```typescript
// pure Spec.md §4 定义的规范接口：
// interface ToolAdapter {
//   execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
//   getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean } | undefined;
//   getTools(): ToolDefinition[];
// }
```

**`getMetadata` 返回值语义**：

| 字段 | 含义 | 使用场景 |
|:-----|:-----|:---------|
| `isWrite` | 是否修改文件系统 | 写操作需要顺序执行（`handleAct`）、权限检查 |
| `sideEffects` | 是否有副作用 | 并行执行允许（只读工具可并行） |

**`getTools()` 返回的工具定义被用于**：
1. 传给 LLM（`toolsDefs` 参数），让模型知道可用工具及参数
2. Coding Agent 的 `ToolRegistry` 汇总扁平工具列表

### 4.2 NodeToolAdapter（已实现）

**文件**：`src/adapter/node/NodeToolAdapter.ts`

基于 Node.js `fs` / `child_process` 的 ToolAdapter 实现。是当前项目的主工具适配器。

#### 支持的工具（6 个）

| 工具名 | 函数 | 参数 | 安全级别 |
|:-------|:-----|:-----|:---------|
| `read_file` | `async readFile(path, startLine?, endLine?)` | `path: string` | 🔒 只读，无副作用 |
| `write_file` | `async writeFile(path, content)` | `path, content: string` | ⚠️ 写操作，路径安全 |
| `list_files` | `async listFiles(path?, recursive?, pattern?)` | `path?: string` | 🔒 只读 |
| `execute_command` | `async executeCommand(command, signal?)` | `command: string` | ⚠️ 有副作用，30s 超时 |
| `search_files` | `async searchFiles(pattern, path?, includePattern?)` | `pattern: string` | 🔒 只读 |
| `edit_file` | `async editFile(path, oldString, newString, allowMultiple?)` | `path, oldString, newString: string` | ⚠️ 写操作 |

#### 安全机制

**路径逃逸防护**：
```typescript
// resolvePath() 确保所有文件操作在 workspace 内
private resolvePath(filePath: string): string {
  const resolved = path.resolve(this.workspace, filePath);
  if (!resolved.startsWith(this.workspace)) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }
  return resolved;
}
```

**文件大小限制**：`maxFileSize`（默认 1MB），超过的文件拒绝读取。

**命令超时**：`commandTimeout`（默认 30s），由 `execAsync` 的 timeout 参数控制。

**`execute_command` 错误处理**：即使命令非零退出，也返回 `success: true`（命令执行本身成功），
通过 `exitCode` 字段标识失败。

#### 性能特性

| 操作 | 类型 | 说明 |
|:-----|:-----|:------|
| `read_file` | 同步 IO | 支持行范围截取（startLine/endLine） |
| `write_file` | 同步 IO | 自动创建父目录 |
| `list_files` | 递归遍历 | `walkDir()` 跳过 `node_modules` / `.git` |
| `execute_command` | 子进程 | 使用 `util.promisify(exec)`，最大 10MB stdout 缓冲 |
| `search_files` | 递归遍历+正则 | 最多返回 100 条匹配，跳过不可读文件 |
| `edit_file` | 读+写 | 需精确定位 oldString，支持 allowMultiple |

#### 配置

```typescript
interface NodeToolAdapterConfig {
  workspace: string;        // 工作空间根路径（必须）
  commandTimeout?: number;  // 命令超时 ms（默认 30000）
  maxFileSize?: number;     // 最大文件读取字节（默认 1048576）
}
```

### 4.3 MockToolAdapter（已实现，测试用）

**文件**：`src/adapter/mock/MockToolAdapter.ts`

基于内存虚拟文件系统的 Mock 实现。

```typescript
const FAKE_FILES: Record<string, string> = {
  'src/index.ts': 'console.log("hello world");',
  'package.json': '{"name":"test","version":"1.0.0"}',
  'README.md': '# Test Project\n\nThis is a test project.',
  'src/utils.ts': 'export function add(a: number, b: number) { return a + b; }',
};
```

**支持的工具**：`read_file`、`write_file`、`list_files`、`execute_command`（模拟 stdout）。

**写操作可持久化**：`write_file` 修改 `FAKE_FILES` 对象，后续 `read_file` 可读到新内容。

### 4.4 计划中的 Tool Adapter

#### ShellToolAdapter（计划 — Rust PTY 集成）

> **场景**：Tauri 桌面环境中，`execute_command` 不应直接使用 Node.js `child_process`，
> 而应通过 Tauri `invoke('execute_command')` 走 Rust PTY 执行，支持流式 stdout 回传。

```
NodeToolAdapter.execute_command        ShellToolAdapter (通过 Rust PTY)
┌────────────────────┐                 ┌────────────────────────────────┐
│ exec(command)      │                 │ invoke('execute_command', cmd) │
│ 同步缓冲 stdout    │                 │ 流式 stdout 回传 (Channel)     │
│ 无交互式支持       │                 │ 支持交互式命令 (vim, top)      │
│ Node.js 子进程     │                 │ Rust PTY (portmaster-pty)      │
└────────────────────┘                 └────────────────────────────────┘
```

#### SandboxToolAdapter（计划 — Docker 沙箱）

> **场景**：`execute_command` 或 `write_file` 操作前先创建文件系统沙箱，隔离危险操作。
> 适用 Phase 7（生产环境）。

---

## 5. Storage Adapter

### 5.1 接口定义（Shared Kernel 引用）

`IStateStore` 接口被 `StateManager`（Harness 层）用于检查点持久化。
新版接口以 `Checkpoint` 为最小存储单元，不再存储旧版 diff 或版本链。

```typescript
interface IStateStore {
  loadSession(sessionId: string): { state: AgentLoopState; checkpoints: Checkpoint[] } | null;
  saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}
```

**设计要点**：
- `loadSession` 返回 `null` 表示新会话（StateManager 创建初始检查点）。
- `saveCheckpoint` 是异步的，StateManager 的持久化失败不阻塞主流程。
- `deleteSession` 用于会话清理。

### 5.2 SQLiteStore（已实现）

**文件**：`src/adapter/storage/SQLiteStore.ts`（160 行）
**测试**：`src/adapter/storage/__tests__/SQLiteStore.test.ts`（16 个测试）

```typescript
// 实现概要 — 完整实现见 src/adapter/storage/SQLiteStore.ts
// 使用 better-sqlite3（同步，适合 Electron/Tauri）

export class SQLiteStore implements IStateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');  // WAL 模式提升读取性能
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        current_index INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        session_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, version),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session
        ON checkpoints(session_id, version);
    `);
  }

  // loadSession 是同步方法（better-sqlite3 同步查询）
  loadSession(sessionId: string) {
    // 1. 查询 sessions 表获取 currentIndex
    // 2. 查询 checkpoints 表获取所有版本（按 version ASC）
    // 3. JSON.parse 反序列化 Checkpoint[]
  }

  async saveCheckpoint(sessionId: string, checkpoint: Checkpoint) {
    // 事务：upsert session + insert or replace checkpoint
    // INSERT OR REPLACE 支持同一版本的覆盖
  }

  async deleteSession(sessionId: string) {
    // 事务：DELETE checkpoints + DELETE sessions
  }

  close(): void { this.db.close(); }  // 资源清理
  hasSession(sessionId: string): boolean;  // 快速存在性检查
  getSessionCount(): number;  // 总会话数
  getCheckpointCount(): number;  // 总检查点数
}
```

**关键实现细节**：
- **事务原子性**：`saveCheckpoint` 和 `deleteSession` 使用 `db.transaction()` 确保原子操作。
- **JSON 序列化**：`Checkpoint` 是纯对象，`JSON.stringify`/`parse` 可正确 round-trip。
- **错误恢复**：`loadSession` 在 DB 错误时返回 `null`（不影响主流程）。
- **WAL 模式**：启用 SQLite WAL 日志模式提升并发读取性能。

### 5.3 FSStore（已实现）

**文件**：`src/adapter/storage/FSStore.ts`（160 行）
**测试**：`src/adapter/storage/__tests__/FSStore.test.ts`（18 个测试）

文件式存储，使用 Node.js `fs` 模块，纯 JSON 文件，无外部依赖。

#### 目录结构

```
{rootPath}/
  sessions/
    {sessionId}/
      meta.json           ← { currentIndex, createdAt, updatedAt }
      checkpoints/
        v000.json         ← 关键节点完整状态
        v001.json
        v002.json
```

#### 与 SQLiteStore 对比

| 特性 | SQLiteStore | FSStore |
|:-----|:-----------|:--------|
| 依赖 | `better-sqlite3` | 纯 `fs`（无外部依赖） |
| 并发 | WAL 模式 | 无内置并发控制 |
| 可读性 | 二进制 | JSON 文件可手动查看 |
| 适用场景 | 生产环境（Tauri） | 开发/调试场景 |
| 测试数 | 16 | 18 |

### 5.4 WASM SQLite（sql.js — 跨运行时方案）

> **推荐**：v0.4 直接使用 `sql.js`，一步到位覆盖 Bun CLI 和 Tauri WebView 两种运行时。

`sql.js` 是 SQLite 编译到 WebAssembly 的产物，无需 native binding，在所有 JS 运行时中可用：

| 运行时 | better-sqlite3 | bun:sqlite | sql.js (WASM) |
|:------|:------|:------|:------|
| Bun CLI | ❌ 需 native compile | ✅ 内置 | ✅ 纯 WASM |
| Tauri WebView | ❌ 无 native addon | ❌ 不存在 | ✅ 纯 WASM |
| Node.js | ✅ | ❌ | ✅ |

```typescript
// [REF] WASMSQLiteStore — 跨运行时 SQLite 实现
// 使用 sql.js (https://github.com/sql-js/sql.js)
// API 与 better-sqlite3 相似：同步查询、WAL 模式、事务支持

export class WASMSQLiteStore implements IStateStore {
  private db: SqlJs.Database;

  constructor(dbPath: string) {
    // sql.js 默认在内存中运行，需手动持久化到文件
    this.db = new SqlJs.Database();
  }

  // IStateStore 接口实现同 SQLiteStore
}
```

**与原生 SQLite 对比**：
- ✅ 无 native 依赖，跨运行时移植零成本
- ✅ 数据库文件兼容（sql.js 写的 `.db` 文件可被原生 SQLite 读取）
- ⚠️ 大数据库 (>100MB) 性能略低于原生（WASM 内存限制）
- ⚠️ 每次启动需从文件加载整个 DB 到 WASM 内存（约 50ms/MB）

**建议**：v0.4 用 `sql.js` 实现 `WASMSQLiteStore`，后续如需性能可升级到原生 SQLite（接口不变）。

---

## 6. MCP Transport

### 6.1 现有实现：StdioSession

**文件**：`src/harness/mcp/MCPClient.ts`（内联实现）

当前 `StdioSession` 作为 `MCPClient.ts` 内部的类实现。

```typescript
class StdioSession {
  private proc: ChildProcess;
  private requestId = 0;
  private pendingRequests: Map<number, { resolve, reject }>;
  private buffer: string;

  constructor(config: MCPServerConfig) {
    this.proc = spawn(config.command!, config.args ?? [], {
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  async initialize(): Promise<void> { /* 发送 JSON-RPC initialize 请求 */ }
  async listTools(): Promise<MCPTool[]> { /* 发送 JSON-RPC tools/list */ }
  async callTool(name: string, args: any): Promise<any> { /* 发送 JSON-RPC tools/call */ }
  close(): void { /* 关闭进程 */ }
}
```

**当前局限**：
- 仅支持 stdio transport（无 HTTP/SSE）
- 内联在 MCPClient.ts 中，不可独立复用
- 无连接池/重连机制

### 6.2 StdioTransport（已实现）

**文件**：`src/adapter/mcp/StdioTransport.ts`（160 行）
**测试**：`src/adapter/mcp/__tests__/StdioTransport.test.ts`（8 个测试）

从 `MCPClient.ts` 提取的独立 `StdioTransport` 类，实现 `MCPSession` 接口。

```typescript
export class StdioTransport implements MCPSession {
  // 使用 Node.js child_process.spawn() 管理 stdio 连接
  // 支持 JSON-RPC request/response over stdin/stdout
  // 30s 超时, 错误时 reject 所有 pending 请求
}
```

### 6.3 HttpClientTransport（已实现）

**文件**：`src/adapter/mcp/HttpClientTransport.ts`（100 行）
**测试**：`src/adapter/mcp/__tests__/HttpClientTransport.test.ts`（11 个测试）

基于 `fetch()` 的 HTTP POST 传输，实现 `MCPSession` 接口。每个请求独立（无状态）。

```typescript
export class HttpClientTransport implements MCPSession {
  constructor(private config: MCPServerConfig) {}
  // 使用 fetch() 发送 JSON-RPC POST 请求
  // 30s 超时 via AbortController
  // 错误处理：HTTP status errors + JSON-RPC error 响应
  // close() 只重置状态（无持久连接）
}
```

### 6.4 SSE Transport（待实现）

> **场景**：需要服务器推送事件的流式响应（如长时间运行的工具结果）。
> 需要 `@modelcontextprotocol/sdk` 支持。

---

## 7. MCP 安全与隔离策略

### 7.1 风险分级

所有 MCP Server 及其暴露的工具必须被标注风险等级。`MCPServerConfig` 新增 `riskLevel` 字段，
MCP Client 在 `connect()` 时根据配置或工具元数据为每个 `MCPTool` 打上风险标签。

| 风险等级 | 典型操作 | 默认策略 |
|:---------|:---------|:---------|
| **low** | 只读查询、本地文件读取 | 可直接执行，无需用户确认 |
| **medium** | 写入文件、执行受信任命令 | 首次执行时请求用户授权，后续在同一会话中可缓存 |
| **high** | 执行任意 shell、网络请求、删除操作 | 每次执行前必须经用户明确确认 |

### 7.2 权限拦截流程

```
MCP Tool Call
     │
     ▼
┌────────────────────────┐
│ 1. RiskLevel 判定       │
│    low  → 直接执行      │
│    medium/high → 下一步 │
└──────────┬─────────────┘
           ▼
┌────────────────────────┐
│ 2. PermissionManager     │
│    检查缓存 / 用户模式   │
│    YOLO → 放行          │
│    NORMAL → 弹窗确认     │
│    PLAN/DONT_ASK → 拒绝  │
└──────────┬─────────────┘
           ▼
┌────────────────────────┐
│ 3. 沙箱隔离（可选）      │
│    限制工作目录          │
│    限制环境变量          │
│    限制网络访问          │
└──────────┬─────────────┘
           ▼
        执行
```

### 7.3 沙箱隔离策略

针对高风险 MCP 工具，Adapter Layer 应提供可选的沙箱机制：

| 隔离维度 | 实现方式 | 说明 |
|:---------|:---------|:-----|
| 文件系统 | 挂载只读 / 写入限定目录 | 防止越界访问工作区外文件 |
| 网络 | 防火墙 / 代理白名单 | 限制 MCP Server 的网络目标 |
| 进程 | 独立子进程 + 超时 | 避免 MCP Server 阻塞主进程 |
| 环境变量 | 黑名单 / 白名单过滤 | 防止泄露敏感 API key |

### 7.4 安全建议

- 默认不信任任何 MCP Server，至少配置为 `riskLevel: 'medium'`。
- 对 `stdio` transport 的 MCP Server，使用独立工作目录启动，并限制其 `PATH`。
- 对 `http` / `sse` transport 的 MCP Server，使用本地代理并校验 TLS 证书。
- 所有 MCP 工具执行结果都应经过 sanitization，避免 LLM 被恶意结果诱导。


---

## 8. Adapter 注册与注入模式

### 8.1 依赖注入流程

```
Config / CLI args            Coding Agent / Harness                Engine
─────────────────            ──────────────────────────           ──────────
                                new CodingAgent({                    run(context)
ANTHROPIC_API_KEY ───────┐        llm: new AnthropicLLMAdapter(),     ctx.llm.stream()
  → AnthropicLLMAdapter  ├───────  tools: new ToolRegistry([          ctx.tools.execute()
                                │       new NodeToolAdapter(        ctx.toolsDefs
workspace path ──────────┘       │         { workspace }),        ctx.verifier?.evaluate()
  → NodeToolAdapter              │       mcpClient,
                                │     ]),
                                │   ......
                                └──→ Harness({ llm, tools, verifier, ... })
                                           ↓
                                     EngineContext
```

### 8.2 Adapter 组合模式

**Coding Agent → ToolRegistry**：`ToolRegistry` 实现 `ToolAdapter` 接口，组合多个底层 ToolAdapter：

```typescript
// ToolRegistry 的 getTools() 汇总所有来源：
getTools(): ToolDefinition[] {
  return [
    ...this.baseAdapter.getTools(),    // NodeToolAdapter 的 6 个内置工具
    ...this.mcpClient.listTools(),     // MCP 动态发现的外置工具
    ...this.extraTools.map(t => t.def), // 编程注册的额外工具
  ];
}
```

**多 LLM 支持**：通过 Coding Agent 的工厂方法或配置切换：

```typescript
function createLLMAdapter(type: 'anthropic' | 'openai' | 'ollama'): LLMAdapter {
  switch (type) {
    case 'anthropic': return new AnthropicLLMAdapter();
    case 'openai':    return new OpenAIAdapter();
    case 'ollama':    return new OllamaAdapter();
  }
}
```

---

## 9. 测试策略

### 9.1 单元测试（每个 Adapter 独立测试）

| Adapter | 测试文件 | 测试数 | 覆盖要点 |
|:--------|:---------|:------|:---------|
| **NodeToolAdapter** | `src/adapter/node/__tests__/NodeToolAdapter.test.ts` | 15+ | 6 个工具 + 安全机制 + getTools/getMetadata |
| **MockLLMAdapter** | （通过 Engine/Harness 测试覆盖） | — | 脚本化轮次、重置、边界 |
| **MockToolAdapter** | （同上） | — | 4 个工具 |
| **AnthropicLLMAdapter** | `src/adapter/anthropic/__tests__/AnthropicLLMAdapter.test.ts` | 15 | 消息映射、工具调用流、SSE 事件解析、splitSystemMessage |
| **OpenAIAdapter** | `src/adapter/openai/__tests__/OpenAIAdapter.test.ts` | 13 | content/tool_call 流式、complete()、AbortSignal、fetch mock |
| **SQLiteStore** | `src/adapter/storage/__tests__/SQLiteStore.test.ts` | 16 | CRUD 操作、序列化/反序列化、多会话隔离、错误恢复 |
| **FSStore** | `src/adapter/storage/__tests__/FSStore.test.ts` | 18 | 镜像 SQLiteStore 测试 + 目录布局验证 + 文件系统损坏恢复 |
| **StdioTransport** | `src/adapter/mcp/__tests__/StdioTransport.test.ts` | 8 | 生命周期、工具发现/调用、错误、清理 |
| **HttpClientTransport** | `src/adapter/mcp/__tests__/HttpClientTransport.test.ts` | 11 | fetch mock、初始化/HTTP 错误/JSON-RPC 错误、工具调用、清理 |

### 9.2 集成测试

| 场景 | 涉及组件 | 测试方法 |
|:-----|:---------|:---------|
| LLM + Tool 串联 | MockLLMAdapter + MockToolAdapter → Engine | `AgentLoopEngine.test.ts` |
| 工具调用全流程 | AnthropicLLMAdapter + NodeToolAdapter → Harness | 集成测试（Phase 8 E2E） |

### 9.3 NodeToolAdapter 测试模式

> **（已完成）** 所有 15+ 测试在临时目录中进行，每个测试用例创建独立的文件结构。
> 测试覆盖：正常操作、边界条件（超大文件、路径逃逸）、错误处理（无效正则、空结果）。

**测试安全机制**：
```typescript
describe('security', () => {
  it('should prevent path traversal', async () => {
    const result = await adapter.execute(makeToolCall('read_file', { path: '../../etc/passwd' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Path escapes workspace');
  });
});
```

---

## 10. 已知修复与改进（vs 原始草稿）

| # | 问题 | 修正 |
|---|------|------|
| 1 | 原始 `MockLLMAdapter` 不 yield `done` chunk，Engine 无法同步获取完整 content | 添加 `type: 'done'` chunk |
| 2 | `AnthropicLLMAdapter` 的 `tool_call_delta` 不 yield arguments（只有 name） | 添加 `input_json_delta` → `tool_call_delta` 映射 |
| 3 | `AnthropicLLMAdapter.`complete()` 使用 stream+accumulate 而非 `messages.create(non-streaming)` | 改为 `messages.create()` 非流式 API（更高效） |
| 4 | `NodeToolAdapter` 路径安全：仅绝对路径检查（可被 `/workspace/../../etc` 绕过） | 改为 `path.resolve()` + `startsWith()` 检查 |
| 5 | `NodeToolAdapter` 缺失 `edit_file` 工具（原始草稿未规划） | 已添加，支持 `replace()` 和 `allowMultiple` |
| 6 | `NodeToolAdapter` 'execute_command' 无超时 | 添加 `commandTimeout`（默认 30s）+ `maxBuffer`（10MB） |
| 7 | Storage Adapter 接口 (`IStateStore`) 只有类型定义无实现 | SQLiteStore 已完成（16 测试），FSStore 已完成（18 测试） |
| 8 | MCP Transport 与 Session 耦合在 `MCPClient.ts` 内 | 已拆分为独立 `StdioTransport` (8 测试) + `HttpClientTransport` (11 测试) |
| 9 | `MockToolAdapter` 的 `getMetadata` 返回 `undefined` 给未知工具 | 保持 `undefined` 语义，`ToolRegistry` 兜底默认 |
| 10 | `AnthropicLLMAdapter` 未处理 `AbortSignal`（stream 持续运行） | 添加 `signal.addEventListener('abort', () => stream.controller.abort())` |
| 11 | `NodeToolAdapter` 的 glob 转正则实现缺失 `?` 单字符匹配 | 添加 `\\? → [^/]` 映射 |

## 11. 跨文档一致性说明

| 组件 | 定义位置 | 实现位置 | 引用方 |
|:-----|:---------|:---------|:-------|
| **LLMAdapter** 接口 | `pure Spec.md` §4 + `src/shared/types.ts` | `src/adapter/anthropic/`, `src/adapter/openai/` | Engine（`EngineContext.llm`）|
| **ToolAdapter** 接口 | `pure Spec.md` §4 + `src/shared/types.ts` | `src/adapter/node/`, `src/adapter/mock/` | Engine（`EngineContext.tools`）, ToolRegistry |
| **IStateStore** 接口 | `三层依赖关系总结.md`（共享类型索引） | `src/adapter/storage/SQLiteStore.ts`, `src/adapter/storage/FSStore.ts` | StateManager（Harness） |
| **MCP StdioTransport** | `src/adapter/mcp/types.ts` | `src/adapter/mcp/StdioTransport.ts` | MCPClient（Harness） |
| **MCP HttpClientTransport** | `src/adapter/mcp/types.ts` | `src/adapter/mcp/HttpClientTransport.ts` | MCPClient（Harness） |
| **VerifierAdapter** 接口 | `src/shared/VerifierAdapter.ts` | `src/coding-agent/Verifier.ts`（Coding Agent） | Engine（VERIFY 阶段） |

---

## 12. Memory Adapter（IMemoryStore）

> **实施优先级**：P1 — 记忆是实现 Agent 自进化能力的关键基础设施。
> 初期使用文件式存储（JSON per project），后续可升级为向量检索。

### 12.1 职责

`IMemoryStore` 负责**跨会话长期记忆**——与会话状态持久化（`IStateStore`，单会话内）不同，
`IMemoryStore` 关注的是：

- **用户偏好**："用户喜欢用 pnpm 不是 npm"、"用户总是用 2 空格缩进"
- **错误模式**："当遇到 error X 时，修复方案是 Y"
- **成功模式**："上次重构 auth 模块时使用的步骤"
- **项目惯例**："本项目使用 vitest 而不是 jest"

记忆按 **项目路径隔离**，不同项目之间不共享记忆。

### 12.2 接口定义

```typescript
// [SPEC] MemoryEntry、IMemoryStore — 必须精确实现
// src/adapter/memory/IMemoryStore.ts

interface MemoryEntry {
  id: string;
  type: 'user_preference' | 'error_pattern' | 'successful_pattern' | 'project_convention';
  content: string;
  timestamp: number;
  sessionId: string;
  projectPath: string;          // 记忆按项目隔离
  decayScore?: number;           // 时间衰减分数（1.0 = 新，0.0 = 已遗忘），用于自动清理
}

interface IMemoryStore {
  /** 写入一条记忆（Engine/Harness 在关键事件时调用） */
  add(entry: Omit<MemoryEntry, 'id'>): Promise<string>;

  /** 检索相关记忆（PromptComposer 在会话开始时调用） */
  search(query: string, opts?: {
    type?: MemoryEntry['type'];
    k?: number;                  // 返回条数，默认 5
    projectPath?: string;        // 限定项目，默认当前项目
  }): Promise<MemoryEntry[]>;

  /** 按会话批量清理 */
  forget(sessionId: string): Promise<void>;

  /** 衰减旧记忆：将超过 olderThan 的记忆 decayScore 减半 */
  decay(olderThan: number): Promise<void>;
}
```

### 12.3 记忆写入时机

| 时机 | 记忆类型 | 内容示例 |
|:------|:------|:------|
| 会话 `Completed` 且用户确认结果满意 | `successful_pattern` | "成功实现 X 功能的步骤：1) ... 2) ..." |
| `FailurePolicy.decide()` 返回 `stop` | `error_pattern` | "error X 需要降级模型 Y 才能解决" |
| `FailurePolicy.decide()` 返回 `retry` 且最终成功 | `error_pattern` | "error X 的修复方案：修改 Y 文件的 Z 行" |
| `PermissionManager` 用户手动授权了某个高风险工具 | `user_preference` | "用户信任 MCP tool X，下次自动批准" |
| Coding Agent 探测到项目使用特定工具链 | `project_convention` | "本项目使用 vitest，不要用 jest" |

### 12.4 记忆检索与注入流程

```
Harness.run(systemPrompt, userPrompt)
     │
     ├─ 1. IMemoryStore.search(userPrompt, { k: 5 })
     │      → 返回最相关的近期记忆
     │
     ├─ 2. PromptComposer.compose({
     │      template: system-prompt.md,   // L0 system-prompt.md 模板
     │      memory:   { preferences, errorPatterns },
     │      project:  projectContext
     │    })
     │      → 记忆注入到 <session_memory> 段（L0 尾部，会话级上下文）
     │
     ├─ 3. Engine.run(composedSystemPrompt, userPrompt)
     │      // L2 每请求碎片（trap/artifact/plan）由 GUI/CLI 在调用前
     │      // 经 composeUserTurn() 拼入 userPrompt，不进 system（见 promptLayers.ts）
     │
     └─ 4. 监听 Completed / Error 事件
            → 提取关键信息 → IMemoryStore.add(...)
```

### 12.5 实现策略

**第一阶段（Phase 4）**：基于文件的简单实现

```
~/.pure/memories/{projectHash}/
  memories.jsonl           ← 每行一条 JSON MemoryEntry
```

- `search()` 使用全文匹配（keywords in content），按 keyword × decayScore 排序取前 k 条；休眠（dormant）记忆不进检索
- `add()` 追加一行 JSON，并按 §12.9 执行「新策略取代旧策略」判定
- `decay()` 定时任务（Harness 每小时一次），按 §12.9 的多维健康分逐级降级、休眠、删除

**第二阶段（Phase 8+）**：向量检索升级

- 使用本地 embedding 模型（`all-MiniLM-L6-v2`，80MB，384维）
- 借助 `@xenova/transformers.js`（HuggingFace Transformers 的 WASM 移植）在 WebView/Bun 中本地推理
- 基于余弦相似度的语义检索，零外部 API 依赖
- 可对接 Chroma / LanceDB 等本地向量库做索引加速

### 12.7 WASM Embedding（transformers.js — 本地语义检索方案）

> **推荐**：v2.0 使用 `@xenova/transformers.js` 实现完全本地的语义记忆检索，零外部 API 依赖。

`transformers.js` 是 HuggingFace Transformers 的 WASM 移植，可在 Bun CLI 和 Tauri WebView 中直接运行 embedding 模型：

| 方案 | 依赖 | 隐私 | 延迟 | 质量 |
|:------|:------|:------|:------|:------|
| OpenAI Embeddings API | 网络 + API Key | ❌ 数据外传 | ~200ms | ⭐⭐⭐⭐⭐ |
| 本地 Python 模型 | Python + PyTorch | ✅ 完全本地 | ~50ms | ⭐⭐⭐⭐ |
| transformers.js WASM | 仅 npm 包 (~80MB) | ✅ 完全本地 | ~100ms | ⭐⭐⭐⭐ |

**推荐模型**：`all-MiniLM-L6-v2`（80MB，384 维，余弦相似度）—— 在语义检索任务上的质量接近 OpenAI `text-embedding-3-small`，但完全本地运行。

```typescript
// [REF] WASMEmbeddingStore — 本地语义记忆检索
// 使用 @xenova/transformers.js (https://github.com/xenova/transformers.js)

import { pipeline } from '@xenova/transformers';

export class WASMEmbeddingStore implements IMemoryStore {
  private extractor: any; // feature-extraction pipeline
  private memories: MemoryEntry[] = [];

  async init() {
    this.extractor = await pipeline('feature-extraction', 
      'Xenova/all-MiniLM-L6-v2');
  }

  async search(query: string, opts) {
    const queryEmbedding = await this.extractor(query, { pooling: 'mean' });
    // 对 this.memories 逐条计算余弦相似度
    // 按得分降序取前 k 条
    return scored.slice(0, opts?.k ?? 5).map(s => s.entry);
  }
}
```

**优势**：
- ✅ 完全本地，用户代码永不离开设备
- ✅ 跨运行时（Bun CLI + Tauri WebView + Node.js 均可用）
- ✅ 与 `FSStore` 组合：`WASMEmbeddingStore` 负责语义检索，`FSStore` 负责持久化
- ⚠️ 首次加载模型需下载 ~80MB（仅一次，之后缓存）
- ⚠️ 384 维 × 数千条记忆的相似度计算需考虑性能（可用 TypedArray 加速或对接 LanceDB）

**建议实施路径**：
1. v0.4 先用文件式 `FSStore` 实现 `IMemoryStore`（关键词匹配）
2. v2.0 升级为 `WASMEmbeddingStore`（语义检索），`IMemoryStore` 接口不变

### 12.8 与 IStateStore 的边界

| | IStateStore | IMemoryStore |
|:------|:------|:------|
| **存储内容** | 会话检查点（完整状态快照） | 知识片段（偏好/模式/惯例） |
| **生命周期** | 单会话内 | 跨会话，长期积累 |
| **检索方式** | 按 sessionId 精确查找 | 按语义/关键词相似度检索 |
| **使用者** | StateManager（Harness） | PromptComposer（Harness） + FailurePolicy |
| **隔离粒度** | 按 sessionId | 按 projectPath |

### 12.9 智能进化记忆（多维打分 + 生命周期 + 策略取代）

> 实现：`src/adapter/memory/evolution.ts`（纯规则、确定性，无 LLM/网络依赖）。

旧的衰减是单一时间轴「>7 天减半」；v1.5 升级为**多维健康分 + 生命周期 + 进化**，让记忆「该用的越用越活、过时的逐级降级、被取代的慢慢淘汰」：

**多维健康分（0..1，确定性公式）**

```
health = recency(时间) × [0.55×credibility + 0.45×usage(饱和)] × superseded(进化)

recency      = 2^(-闲置天数 / 30)          // 30 天半衰期，闲置越久越低
credibility  = 按类型：successful_pattern/procedure 1.0、user_preference 0.9、
               project_convention 0.85、error_pattern 0.8
usage        = min(1, hitCount / 4)        // 每次检索命中 +1（search 时记录），4 次饱和
superseded   = 被取代 ? 0.4 : 1            // 被新策略取代的旧策略惩罚因子
```

**生命周期（decay 逐级推进）**

| 阶段 | 健康分 | 行为 |
|:------|:------|:------|
| active 活跃 | ≥ 0.45 | 正常进检索、注入提示词 |
| degraded 降级 | (0.15, 0.45) | 仍可检索，但排序靠后 |
| dormant 休眠 | ≤ 0.15 | 不进检索（睡着，不是没了）；文件保留 |
| 删除 | < 0.05，或休眠 ≥ 60 天宽限期 | 从文件移除 |

- `decay()` 对**闲置超过阈值**的记忆按绝对时间重算（确定性收敛，不叠加）；被取代的策略因 ×0.4 惩罚约 30 天即休眠、60 天删除，比普通记忆（约 90 天休眠）淘汰得更快。
- 60 天休眠宽限主要作用于**被取代的策略**：普通记忆跌入休眠时已闲置约 68 天（本身已超宽限），其删除由分数线触发；被取代的策略约 30 天即休眠，宽限在分数跌到底线之前就把它们清出系统。
- 使用频率信号：`search()` 命中即 `hitCount+1`、刷新 `lastUsedAt`（FS 进内存缓存、decay 时落盘并合并；localStorage 直接写回）—— 高频使用的记忆即使闲置也降级得慢。

**策略取代（进化）**

- 新增 `procedure` / `successful_pattern` / `user_preference` / `project_convention` 时，与同项目、同类型、未被取代的旧条目比较**内容定向覆盖率**（新条目 ≥55% 的有效 token 被旧条目覆盖，剥离模板样板、中文按二元组分词）：命中即标记 `supersededBy` 并立即降级，新条目成为该情境的最新版本。
- `error_pattern` 不参与取代（其内容充满共享模板样板，相似度是噪音），靠 dedupe + 衰减自然淘汰。
- 旧条目不立即删除，而是带着惩罚因子走完 降级→休眠→删除 —— 「不合时宜的策略慢慢进化成最新最好用的」。

**示例时序**（被取代的旧策略，40 天闲置）：健康分 0.775×0.4×2^(-40/30) ≈ 0.12 → dormant（第 1 次 decay）→ 40 天后仍保留；闲置到 ≥60 天 → 删除。

**阈值可配置（遗忘速度）**

所有进化阈值从硬编码常量升级为 `EvolutionConfig`（`evolution.ts`，默认值逐项等于上表），支持用户自定义遗忘速度：

- **接口**：`healthScore(entry, now, cfg?)` / `lifecycleOf(score, cfg?)` / `decayEntry(…)` / `findSupersedeTarget(…)` / `searchMemories(…)` 均接受可选 `Partial<EvolutionConfig>`，缺省项回落 `EVOLUTION_DEFAULTS`；`resolveEvolutionConfig(partial)` 做合并。
- **可调项**：`recencyHalfLifeMs`（半衰期）、`activeMin` / `dormantMax` / `deleteFloor`（活跃/休眠/删除线）、`dormantGraceMs`（休眠宽限）、`supersedeSimilarity`（取代覆盖率）、`supersededPenalty`、`hitsForFullUsage`。
- **GUI**：Settings → Memory → 遗忘速度 六个输入框（半衰期/活跃线/休眠线/删除线/休眠宽限/取代覆盖率）+ 重置默认。配置存 `PureConfig.evolution`（仅非默认字段），面板做 天↔毫秒、百分比↔小数 换算。`memoryStore.ts` 把 `() => loadConfig()?.evolution` 注入 `LocalStorageMemoryStore` 与 `WASMEmbeddingStore`，每次 add/search/decay 读取最新值 —— 改动即时生效，无需重启。记忆库仪表盘的健康分/生命周期同样按用户配置实时计算。
- **CLI**：无 UI，用环境变量 `PURE_MEMORY_HALF_LIFE_DAYS` / `PURE_MEMORY_ACTIVE_MIN` / `PURE_MEMORY_DORMANT_MAX` / `PURE_MEMORY_DELETE_FLOOR` / `PURE_MEMORY_DORMANT_GRACE_DAYS` / `PURE_MEMORY_SUPERSEDE_SIMILARITY`（百分比），进程启动时读取一次。

**运行时诊断（记忆页）**

- 记忆页新增「运行时诊断」区：显示**当前生效**的进化参数（`resolveEvolutionConfig(cfg.evolution)` 合并结果，自定义项带「已自定义」标记）+ **上次衰减运行信息**（时间 + 删除/更新条数）+ **下次自动衰减**（`上次衰减 + 1h 节流窗`，后台定时器到点自动执行，无需新会话）+ **后台定时器徽章**（「每 1 小时自动检查，即使没有新会话」）。
- 存储层在衰减执行时记录运行信息（localStorage 用独立 `pure_memories_meta_v1` key；FS 写 `~/.pure/memories/meta.json`），`LocalStorageMemoryStore` / `FSMemoryStore` 暴露 `getLastDecayInfo()`（非接口成员，返回拷贝；WASMEmbeddingStore 委托透传），设置面板经 `memoryStore.getLastDecayInfo()` 读取。
- 「立即执行衰减」按钮以 `decay(0)` 按当前阈值重算**全部**记忆（无视 Harness 的 14 天闲置门槛）——调整遗忘速度后手动触发，新分数即时落盘并刷新仪表盘。
- 衰减调度语义：`MEMORY_DECAY_MS = 14 天`（闲置超过才处理）、`MEMORY_DECAY_INTERVAL_MS = 1 小时`（节流）。**GUI 后台定时器**（`src/ui/memoryDecayTimer.ts`，main.ts deferred init 启动）：按存储层 `lastDecayAt + 1h` 调度 `setTimeout`，到点执行 `decay(14 天)` 并派发 `pure:memory-decay-run` 事件（设置面板监听刷新诊断区/仪表盘）；Memory 技能关闭时跳过衰减但继续调度；`computeNextDecayDelayMs()` 纯函数可单测。CLI 仍由长驻 Harness 每轮触发。

**导出 / 导入（记忆页）**

- 记忆页新增「导出 / 导入」区（`src/ui/memoryTransfer.ts` 纯函数模块，可 headless 单测）：
  - **导出 JSON**（`buildMemoryExportJson`）：信封 `{ app: 'pure', kind: 'memory-library', version: 1, exportedAt, entries }`。每条含**原始字段**（id / supersededBy / hitCount / lastUsedAt / decayScore / lifecycle / sessionId / projectPath / dedupeKey）——**保留原 id 使取代链（supersededBy → 新 id）迁移后依然成立**、使用频率信号不丢失——外加**实时健康分快照**（`healthScore` / `liveLifecycle`，导出时刻按当前生效阈值重算）。
  - **导出 Markdown**（`buildMemoryExportMarkdown`）：人类可读报告，按生命周期分组（活跃/降级/休眠），每条含类型、内容、健康分进度、上次使用、检索次数与被取代标记。
  - **导入**（`parseMemoryImport` + `LocalStorageMemoryStore.importEntries`）：接受本模块导出的 JSON 信封，也容忍裸 MemoryEntry 数组；逐条最小字段校验（type 合法、content 非空、timestamp 有限），不合法条目跳过，未知键（含快照字段 healthScore/liveLifecycle）不进库；`importEntries` 按 `id` 或 `(type, projectPath, content|dedupeKey)` 去重（与 `add()` 口径一致），保留原字段写入，返回 `{ imported, skipped }`。WASMEmbeddingStore 委托透传。
  - 保存走与 stats 导出相同的流程（Tauri `plugin-dialog` save + `save_file` invoke；browser File System Access API → download anchor 回退）。
