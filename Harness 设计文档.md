# Harness 设计文档

> ⚠️ **PHASE 3 / REFERENCE DOCUMENT** — 本文档是 Harness 层的实现参考。
> 📗 核心规范请见 `pure Spec.md`（Prompt-Ready Implementation Guide）第 5 节。
>
> **实施顺序**：Phase 3 — 在 Phase 2 (Engine) 完成后实施。

## 有状态会话管理层（检查点版）

---

## 1. 文档概述

### 1.1 文档定位

本文档定义 **Harness** 的设计规范——一个有状态、每会话独立的会话管理层。Harness 为上层 Coding Agent 提供会话管理、上下文压缩、持久化和 MCP 集成能力。

### 1.2 设计概要

Harness 的核心设计决策：

- **检查点持久化**：只在关键节点保存完整会话状态，不记录每个微观版本的 Patch。
- **滑动窗口上下文**：默认保留最近 N 条消息，超长时触发可选的 LLM 摘要 fallback。
- **MCP 协议**集成，支持 Server 自动发现。
- **抽象 Storage Adapter**，可对接 SQLite / FS / S3。
- **跨会话长期记忆**（`IMemoryStore`）：在会话开头检索用户偏好和项目惯例，在会话结束时写入新记忆。
- **chokidar 文件变更监听**，触发上下文刷新。
- **Subagent 超时 + 级联中断**机制。
- **纯 TypeScript**，运行时无关。

### 1.3 设计哲学

> "会话状态只需要能恢复，不需要无限回滚"

- **关键检查点**：只在 turn 边界保存完整状态，重启后可恢复。
- **Adapter 隔离**：所有 I/O 操作（存储、LLM、MCP）通过 Adapter Layer。
- **Bun 无关**：核心代码纯 TypeScript，可运行在任何运行时。

### 1.4 核心原则

| 原则 | 说明 |
|:-----|:-----|
| **有状态** | 每个会话独立的 Harness 实例，持有会话状态 |
| **检查点** | 只在关键节点持久化完整状态 |
| **Adapter 隔离** | 所有 I/O 操作通过 Adapter 异步执行 |
| **MCP 原生** | 工具扩展通过 MCP Server，而非硬编码固定工具分类 |

---

## 2. 架构概览

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          Harness (有状态会话管理层)                                   │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │                     StateManager (检查点持久化)                              │  │
│  │  ┌──────────────────────────────────────────────────────────────────────┐   │  │
│  │  │ 会话状态 = AgentLoopState                                          │   │  │
│  │  │ 检查点：在关键节点保存完整状态                                       │   │  │
│  │  │ saveCheckpoint(state) → 持久化                                       │   │  │
│  │  │ loadSession(sessionId) → 最新检查点                                  │   │  │
│  │  └──────────────────────────────────────────────────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │                     ContextEngine (上下文压缩引擎)                            │  │
│  │  ┌──────────────────────────────────────────────────────────────────────┐   │  │
│  │  │ 默认策略：滑动窗口，保留最近 k 步                                      │   │  │
│  │  │ 超长触发：可选 LLM 单次摘要 fallback                                   │   │  │
│  │  │ 硬性约束：tool_call 与 tool_result 必须成对保留或删除                │   │  │
│  │  └──────────────────────────────────────────────────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │                     MCP Client (模型上下文协议客户端)                        │  │
│  │  ├── discover(config) → MCPServer[]        — 从配置发现 MCP Server         │  │
│  │  ├── connect(server) → MCPSession          — 连接到 Server                 │  │
│  │  ├── listTools(session) → MCPTool[]        — 获取可用工具                  │  │
│  │  └── callTool(session, tool) → ToolResult  — 调用工具                      │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │                     FileWatcher (文件变更监听)                               │  │
│  │  ├── watch(patterns) → FileChangeEvent                                      │  │
│  │  └── 触发: reevaluate → 上下文刷新 / 用户通知                               │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │                     SubagentRegistry + EventBus (增强生命周期)                 │  │
│  │  ├── spawn(parentId, task, signal) → SubagentHandle  (带超时)               │  │
│  │  ├── cascadeInterrupt(sessionId) → void              (优雅停止)             │  │
│  │  └── EventBus: emit/on/off/request                  (请求-响应模式)          │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
│  ──────────────────────────────────────────────────────────────────────────────┐  │
│  │                     StreamManager (流式输出管理)                              │  │
│  │  ├── 接收 Engine 的 EngineEvent 流                                            │  │
│  │  ├── 通过 Tauri Channel 推送到前端                                           │  │
│  │  └── 缓冲/合并高频事件 (如 TokenDelta)                                       │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心组件设计

### 3.1 检查点状态管理器

#### 3.1.1 设计取舍

旧版设计使用细粒度版本链实现任意版本回滚，但带来以下问题：

- 每次状态变更都需记录变更 diff，长会话下开销明显。
- 版本回放、撤销逻辑复杂，容易引入 bug。
- Coding Agent 的核心需求是"能恢复当前会话"，而非"任意微观版本回滚"。

**新版方案**：只在关键节点保存完整状态检查点。

#### 3.1.2 检查点触发节点

| 节点 | 说明 |
|:-----|:-----|
| **会话启动** | 创建初始检查点 v0 |
| **THINK 完成后** | assistant 消息已生成，ACT 执行前 |
| **ACT 完成后** | 所有 tool results 已 append 到 messages |
| **VERIFY 完成后** | 一轮完整 turn 结束 |
| **Completed / Interrupted** | 会话结束 |

#### 3.1.3 完整实现

```typescript
// [SPEC] AgentLoopState、Checkpoint 接口 —— 必须精确实现
// [EXAMPLE] StateManager 类 —— 实现参考，可自由修改
// src/harness/StateManager.ts

export interface AgentLoopState {
  sessionId: string;
  messages: Message[];
  turnCount: number;
  finalOutput?: string;
  status: 'idle' | 'running' | 'completed' | 'interrupted' | 'error';
  lastError?: string;
  metadata: Record<string, any>;
}

export interface Checkpoint {
  version: number;
  state: AgentLoopState;
  timestamp: number;
  label: string; // 如 "after_think", "after_act", "completed"
}

export class StateManager {
  private checkpoints: Checkpoint[] = [];
  private current: AgentLoopState;
  private storage: IStateStore;
  private eventBus: EventBus;

  constructor(sessionId: string, storage: IStateStore, eventBus?: EventBus) {
    this.storage = storage;
    this.eventBus = eventBus ?? new EventBus();

    const saved = storage.loadSession(sessionId);
    if (saved) {
      this.current = saved.state;
      this.checkpoints = saved.checkpoints ?? [];
    } else {
      this.current = this.createInitialState(sessionId);
      this.saveCheckpoint('session_start');
    }
  }

  getCurrentState(): AgentLoopState {
    return this.current;
  }

  update(updater: (state: AgentLoopState) => void): void {
    updater(this.current);
  }

  /** 在关键节点保存检查点 */
  saveCheckpoint(label: string): Checkpoint {
    const cp: Checkpoint = {
      version: this.checkpoints.length,
      state: structuredClone(this.current),
      timestamp: Date.now(),
      label,
    };
    this.checkpoints.push(cp);
    this.storage.saveCheckpoint(this.current.sessionId, cp).catch(error => {
      this.eventBus?.emit('error:occurred', {
        code: 'PERSISTENCE_ERROR',
        message: `Checkpoint ${label} 持久化失败: ${error.message}`,
      });
    });
    return cp;
  }

  /** 恢复到最近一次检查点 */
  restoreLatest(): AgentLoopState {
    const latest = this.checkpoints[this.checkpoints.length - 1];
    if (!latest) return this.current;
    this.current = structuredClone(latest.state);
    return this.current;
  }

  /** 恢复到指定标签的检查点 */
  restoreByLabel(label: string): AgentLoopState | null {
    const cp = [...this.checkpoints].reverse().find(c => c.label === label);
    if (!cp) return null;
    this.current = structuredClone(cp.state);
    return this.current;
  }

  getCheckpoints(): Checkpoint[] {
    return [...this.checkpoints];
  }

  private createInitialState(sessionId: string): AgentLoopState {
    return {
      sessionId,
      messages: [],
      turnCount: 0,
      status: 'idle',
      metadata: {},
    };
  }
}
```

#### 3.1.4 IStateStore 接口调整

```typescript
interface IStateStore {
  loadSession(sessionId: string): { state: AgentLoopState; checkpoints: Checkpoint[] } | null;
  saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}
```

---

### 3.2 上下文压缩引擎

#### 3.2.1 设计目标

- 默认使用**滑动窗口**保留最近 `k` 条消息。
- 当消息接近模型 context window 上限时，触发可选的 LLM 摘要 fallback。
- **绝对约束**：`assistant` 消息中的 `toolCalls` 与其对应的 `tool` 消息必须成对保留或删除。

#### 3.2.2 滑动窗口 + 摘要 fallback

```typescript
// [SPEC] ContextWorkspace 类型 —— 必须精确实现
// [EXAMPLE] ContextEngine 类 —— 实现参考，可自由修改
// src/harness/ContextEngine.ts

export interface ContextWorkspace {
  system: string;          // 系统提示（始终保留）
  recent: Message[];       // 最近 k 条消息
  summary?: string;       // 被替换掉的早期消息的摘要
  totalTokens: number;
}

export class ContextEngine {
  private config: {
    maxTokens: number;
    windowSize: number;
    summaryThreshold: number; // 触发摘要的 token 比例，默认 0.8
    llm: LLMAdapter;
  };

  async compress(messages: Message[]): Promise<ContextWorkspace> {
    const system = messages.find(m => m.role === 'system')?.content ?? '';
    const nonSystem = messages.filter(m => m.role !== 'system');

    // 1. 滑动窗口
    let recent = nonSystem.slice(-this.config.windowSize);

    // 2. 估算 token
    const serialized = recent.map(m => `[${m.role}] ${m.content}`).join('\n');
    let totalTokens = this.estimateTokens(serialized) + this.estimateTokens(system);

    let summary: string | undefined;
    const ratio = totalTokens / this.config.maxTokens;

    // 3. 超长时：先尝试成对裁剪，仍超长则触发 LLM 摘要
    if (ratio > this.config.summaryThreshold) {
      const pruned = this.pruneWithPairedConstraint(recent, this.config.maxTokens);
      recent = pruned.recent;
      if (pruned.evicted.length > 0) {
        summary = await this.summarizeEvicted(pruned.evicted);
      }
      totalTokens = this.estimateTokens(recent.map(m => `[${m.role}] ${m.content}`).join('\n'));
    }

    return {
      system,
      recent,
      summary,
      totalTokens,
    };
  }

  /**
   * 成对裁剪：
   * - 从 oldest 开始扫描；
   * - 若遇到 assistant 的 toolCalls，则连带保留/删除其后的 tool_result；
   * - 直到 totalTokens < maxTokens。
   */
  private pruneWithPairedConstraint(messages: Message[], maxTokens: number): { recent: Message[]; evicted: Message[] } {
    let tokenCount = this.estimateTokens(messages.map(m => `[${m.role}] ${m.content}`).join('\n'));
    if (tokenCount <= maxTokens) return { recent: messages, evicted: [] };

    const evicted: Message[] = [];
    const recent = [...messages];

    while (recent.length > 1 && tokenCount > maxTokens) {
      const first = recent[0];

      // 如果 oldest 是 assistant 且包含 toolCalls，则必须同时移除对应的 tool_result
      if (first.role === 'assistant' && first.toolCalls?.length) {
        const ids = new Set(first.toolCalls.map(tc => tc.id));
        let removeCount = 1;
        // 紧接在 assistant 后的 tool result 属于该 tool_call
        for (let i = 1; i < recent.length; i++) {
          if (recent[i].role === 'tool' && ids.has(recent[i].toolCallId!)) removeCount++;
          else break;
        }
        for (let i = 0; i < removeCount; i++) {
          const m = recent.shift()!;
          evicted.push(m);
          tokenCount -= this.estimateTokens(m.content);
        }
      } else {
        const m = recent.shift()!;
        evicted.push(m);
        tokenCount -= this.estimateTokens(m.content);
      }
    }

    return { recent, evicted };
  }

  private async summarizeEvicted(messages: Message[]): Promise<string> {
    const prompt = `Summarize the following older conversation turns, keeping key decisions and code changes:\n\n${messages.map(m => `[${m.role}] ${m.content.substring(0, 500)}`).join('\n')}`;
    const result = await this.config.llm.complete([{ role: 'user', content: prompt }], []);
    return result.content;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
```

#### 3.2.3 tool_call / tool_result 成对约束

这是防止 Anthropic / OpenAI API 报错的硬性要求。规则如下：

1. 如果 `assistant` 消息包含 `toolCalls`，则其后必须紧跟对应 `toolCallId` 的 `tool` 消息。
2. 裁剪历史时，`assistant` 消息与其对应的 `tool` 消息必须作为一个整体保留或删除。
3. 不得单独删除 `tool` 消息而保留其 `assistant` 消息，反之亦然。

---

### 3.3 MCP Client

保持原设计，但在 `Coding Agent` 层增加权限拦截（详见 `Coding Agent 设计文档.md`）。

```typescript
// [SPEC] MCPServerConfig、MCPTool 接口 ─── 必须精确实现
// [EXAMPLE] MCPClient 类 ─── 实现参考，可自由修改
// src/harness/mcp/MCPClient.ts

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled: boolean;
  // 风险等级：low / medium / high
  riskLevel?: 'low' | 'medium' | 'high';
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  serverName: string;
  riskLevel?: 'low' | 'medium' | 'high';
}

export class MCPClient {
  private servers: Map<string, MCPSession> = new Map();
  private tools: Map<string, MCPTool> = new Map();

  async discover(config: { configPath?: string }): Promise<MCPServerConfig[]> {
    const servers: MCPServerConfig[] = [];
    if (config.configPath) {
      try {
        const content = await fs.readFile(config.configPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed.mcpServers) {
          servers.push(...Object.entries(parsed.mcpServers).map(([name, cfg]: [string, any]) => ({
            name,
            ...cfg,
            enabled: cfg.enabled !== false,
            riskLevel: cfg.riskLevel ?? 'medium',
          })));
        }
      } catch {}
    }
    return servers;
  }

  async connect(config: MCPServerConfig): Promise<void> {
    if (!config.enabled) return;
    const session = new MCPSession(config);
    await session.initialize();
    this.servers.set(config.name, session);

    const tools = await session.listTools();
    for (const tool of tools) {
      const key = `${config.name}:${tool.name}`;
      this.tools.set(key, { ...tool, serverName: config.name, riskLevel: config.riskLevel ?? 'medium' });
    }
  }

  listTools(): MCPTool[] {
    return [...this.tools.values()];
  }

  private findTool(toolName: string): { tool: MCPTool; session: MCPSession } | null {
    const colonIndex = toolName.indexOf(':');
    if (colonIndex > 0) {
      const serverName = toolName.substring(0, colonIndex);
      const shortName = toolName.substring(colonIndex + 1);
      const key = `${serverName}:${shortName}`;
      const tool = this.tools.get(key);
      const session = this.servers.get(serverName);
      if (tool && session) return { tool, session };
      return null;
    }
    for (const [key, tool] of this.tools) {
      if (tool.name === toolName) {
        const session = this.servers.get(tool.serverName);
        if (session) return { tool, session };
      }
    }
    return null;
  }

  async callTool(toolName: string, args: any): Promise<ToolResult> {
    const lookup = this.findTool(toolName);
    if (!lookup) throw new Error(`MCP tool not found: ${toolName}`);
    return lookup.session.callTool(lookup.tool.name, args);
  }

  async disconnectAll(): Promise<void> {
    for (const [name, session] of this.servers) {
      await session.close();
      this.servers.delete(name);
    }
    this.tools.clear();
  }
}

export interface MCPSession {
  name: string;
  initialize(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: any): Promise<any>;
  close(): Promise<void>;
}
```

---

### 3.4 流式输出管理

保持原设计。

```typescript
// [SPEC] StreamCallback 类型 ─── 必须精确实现
// [EXAMPLE] StreamManager 类 ─── 实现参考，可自由修改
// src/harness/StreamManager.ts

import type { EngineEvent } from '../engine/types/events';

export type StreamCallback = (event: EngineEvent) => void;

export class StreamManager {
  private subscribers: Set<StreamCallback> = new Set();
  private buffer: EngineEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_INTERVAL = 16; // ~60fps

  subscribe(callback: StreamCallback): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  push(event: EngineEvent): void {
    this.buffer.push(event);
    this.scheduleFlush();
  }

  async connect(generator: AsyncGenerator<EngineEvent>): Promise<void> {
    try {
      for await (const event of generator) {
        this.push(event);
      }
    } catch (error) {
      this.push({
        type: 'Error',
        payload: { code: 'INTERNAL_ERROR', message: String(error), stateType: 'TERMINATE', recoverable: false },
        timestamp: Date.now(),
      } as EngineEvent);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.FLUSH_INTERVAL);
  }

  private flush(): void {
    this.flushTimer = null;
    const events = this.buffer.splice(0);
    const merged = this.mergeTokenDeltas(events);
    for (const event of merged) {
      for (const cb of this.subscribers) {
        try { cb(event); } catch {}
      }
    }
  }

  private mergeTokenDeltas(events: EngineEvent[]): EngineEvent[] {
    const result: EngineEvent[] = [];
    let buf = '';
    let lastStateId = '';
    let lastIsTool = false;
    let lastBuffer: string | undefined;

    const flush = () => {
      if (buf) {
        result.push({
          type: 'TokenDelta',
          payload: { content: buf, stateId: lastStateId, isToolCall: lastIsTool, toolCallBuffer: lastBuffer },
          timestamp: Date.now(),
        });
        buf = '';
        lastBuffer = undefined;
      }
    };

    for (const e of events) {
      if (e.type === 'TokenDelta') {
        buf += e.payload.content;
        lastStateId = e.payload.stateId;
        lastIsTool = e.payload.isToolCall;
        lastBuffer = e.payload.toolCallBuffer ?? lastBuffer;
      } else {
        flush();
        result.push(e);
      }
    }
    flush();
    return result;
  }
}
```

---

### 3.5 文件变更监听

保持原设计。

```typescript
// [SPEC] FileChangeEvent 接口 ─── 必须精确实现
// [EXAMPLE] FileWatcher 类 ─── 实现参考，可自由修改
// src/harness/FileWatcher.ts

import { promises as fs } from 'fs';

export interface FileChangeEvent {
  type: 'change' | 'create' | 'delete';
  path: string;
  timestamp: number;
}

export class FileWatcher {
  private watchers: Map<string, FSWatcher> = new Map();

  async watch(
    rootPath: string,
    patterns: string[],
    callback: (event: FileChangeEvent) => void
  ): Promise<void> {
    const chokidar = await import('chokidar');
    const ignored = [...this.getDefaultIgnored(), ...await this.getGitIgnored(rootPath)];
    const watcher = chokidar.watch(rootPath, { ignored, ignoreInitial: true });

    watcher.on('change', (path: string) => callback({ type: 'change', path, timestamp: Date.now() }));
    watcher.on('add', (path: string) => callback({ type: 'create', path, timestamp: Date.now() }));
    watcher.on('unlink', (path: string) => callback({ type: 'delete', path, timestamp: Date.now() }));

    this.watchers.set(rootPath, watcher);
  }

  unwatch(rootPath: string): void {
    const watcher = this.watchers.get(rootPath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(rootPath);
    }
  }

  private getDefaultIgnored(): string[] {
    return ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**'];
  }

  private async getGitIgnored(rootPath: string): Promise<string[]> {
    try {
      const gitignore = await fs.readFile(`${rootPath}/.gitignore`, 'utf-8');
      return gitignore.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => `**/${l}/**`);
    } catch {
      return [];
    }
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}
```

---

### 3.6 Subagent 注册表（带超时和优雅停止）

保持原设计。

```typescript
// [EXAMPLE] SubagentRegistry 类 ─── 实现参考，可自由修改
// src/harness/SubagentRegistry.ts

export class SubagentRegistry {
  private children: Map<string, SubagentHandle> = new Map();
  private storage: IStateStore;

  constructor(storage: IStateStore) {
    this.storage = storage;
  }

  async spawn(
    parentSessionId: string,
    task: SubagentTask,
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<SubagentHandle> {
    const subSessionId = `${parentSessionId}:sub:${task.id}`;
    const controller = new AbortController();
    const timeout = options?.timeout ?? 60000;

    const combinedSignal = this.combineSignals(controller.signal, options?.signal);
    const mandate = await this.buildMandate(parentSessionId, task);

    // 简化示意：实际由 Harness 工厂创建
    const subHarness = new Harness({ sessionId: subSessionId, storage: this.storage });
    const runPromise = subHarness.run(mandate, { signal: combinedSignal });

    const handle: SubagentHandle = {
      sessionId: subSessionId,
      status: 'running',
      interrupt: () => controller.abort(),
      getResult: async () => {
        try {
          return await runPromise;
        } catch (error) {
          return { status: 'interrupted', error: String(error) };
        }
      },
    };

    this.children.set(subSessionId, handle);
    return handle;
  }

  async cascadeInterrupt(sessionId: string): Promise<void> {
    const relevant = [...this.children.entries()].filter(([id]) => id.startsWith(sessionId));
    await Promise.allSettled(relevant.map(([_, handle]) => handle.interrupt()));
    await new Promise(resolve => setTimeout(resolve, 5000));
    for (const [_, handle] of relevant) {
      if (handle.status === 'running') handle.interrupt();
    }
  }

  private combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal) {
        if (signal.aborted) {
          controller.abort(signal.reason);
          return controller.signal;
        }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      }
    }
    return controller.signal;
  }

  private async buildMandate(parentSessionId: string, task: SubagentTask): Promise<string> {
    return `${parentSessionId}:${task.id}`;
  }
}
```

---

### 3.7 EventBus（Harness 扩展）

保持原设计。

```typescript
// [SPEC] Harness 层的 EventMap 扩展 ─── 通过 declaration merging 添加事件类型
// src/harness/EventBus.ts

export { EventBus } from '../shared/EventBus';

export type ErrorCode =
  | 'PERSISTENCE_ERROR'
  | 'MCP_CONNECT_ERROR'
  | 'MCP_TOOL_ERROR'
  | 'LLM_ERROR'
  | 'TOOL_EXECUTION_ERROR'
  | 'CONTEXT_COMPRESSION_ERROR'
  | 'SUBAGENT_ERROR'
  | 'INTERNAL_ERROR';

declare module '../shared/EventBus' {
  export interface EventMap {
    'state:changed': { fromVersion: number; toVersion: number; label: string };
    'context:compressed': { level: number; ratio: number };
    'mcp:connected': { serverName: string; toolCount: number };
    'mcp:toolcalled': { toolName: string; duration: number; success: boolean };
    'file:changed': FileChangeEvent;
    'subagent:completed': { sessionId: string; result: any };
    'user:confirmed': { action: string };
    'error:occurred': { code: ErrorCode; message: string };
  }
}
```

---

### 3.8 Harness 主入口（整合所有组件）

```typescript
// [SPEC] AgentResult 类型 ─── 必须精确实现
// [EXAMPLE] Harness 主类 ─── 实现参考，可自由修改
// src/harness/Harness.ts

export interface AgentResult {
  finalOutput?: string;
  isComplete: boolean;
  interrupted: boolean;
  turnCount: number;
  messages: Message[];
}

export interface HarnessConfig {
  sessionId: string;
  storage: IStateStore;
  memory?: IMemoryStore;
  llm: LLMAdapter;
  tools: ToolAdapter;
  verifier?: VerifierAdapter;
  mcpServers?: MCPServerConfig[];
  maxTokens?: number;
  windowSize?: number;
}

export class Harness {
  private stateManager: StateManager;
  private contextEngine: ContextEngine;
  private streamManager: StreamManager;
  private mcpClient: MCPClient;
  private fileWatcher: FileWatcher;
  private eventBus: EventBus;

  constructor(private config: HarnessConfig) {
    this.eventBus = new EventBus();
    this.stateManager = new StateManager(config.sessionId, config.storage, this.eventBus);
    this.contextEngine = new ContextEngine({
      maxTokens: config.maxTokens ?? 128000,
      windowSize: config.windowSize ?? 20,
      summaryThreshold: 0.8,
      llm: config.llm,
    });
    this.streamManager = new StreamManager();
    this.mcpClient = new MCPClient();
    this.fileWatcher = new FileWatcher();
  }

  async *run(systemPrompt: string, userPrompt: string, budgetConfig: BudgetConfig): AsyncGenerator<EngineEvent, void, void> {
    const state = this.stateManager.getCurrentState();
    state.status = 'running';

    // ── 记忆检索（Layer 2：会话开始时注入相关记忆）──
    let systemPromptWithMemory = systemPrompt;
    if (this.config.memory) {
      const memories = await this.config.memory.search(userPrompt, { k: 5 });
      const preferences = memories.filter(m => m.type === 'user_preference').map(m => m.content);
      const errorPatterns = memories.filter(m => m.type === 'error_pattern').map(m => m.content);
      const composer = new PromptComposer();
      systemPromptWithMemory = await composer.compose({
        template: systemPrompt,
        memory: preferences.length || errorPatterns.length ? { preferences, errorPatterns } : undefined,
      });
    }

    // 连接 MCP servers
    for (const server of this.config.mcpServers ?? []) {
      await this.mcpClient.connect(server);
    }

    // 启动文件监听
    this.fileWatcher.watch('.', ['src/**/*'], (event) => {
      this.eventBus.emit('file:changed', event);
    });

    const engine = new AgentLoopEngine();
    const stream = engine.run({
      sessionId: this.config.sessionId,
      systemPrompt: systemPromptWithMemory,
      userPrompt,
      budget: budgetConfig,
    }, {
      llm: this.config.llm,
      tools: this.config.tools,
      toolsDefs: [...this.config.tools.getTools(), ...this.mcpClient.listTools().map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }))],
      verifier: this.config.verifier,
      budget: budgetConfig,
    });

    for await (const event of stream) {
      this.streamManager.push(event);
      yield event;

      // 关键节点保存检查点
      if (event.type === 'StateChange' && (event.payload.to === 'OBSERVE' || event.payload.to === 'TERMINATE')) {
        this.stateManager.saveCheckpoint(event.payload.to.toLowerCase());
      }
    }

    // ── 记忆写入（会话结束后提取关键信息写入记忆）──
    if (this.config.memory) {
      const lastEvent = state.finalOutput;
      if (lastEvent) {
        await this.config.memory.add({
          type: 'successful_pattern',
          content: `Session completed: ${userPrompt.substring(0, 200)}`,
          timestamp: Date.now(),
          sessionId: this.config.sessionId,
          projectPath: process.cwd(),
        }).catch(() => {}); // 记忆写入失败不阻塞
      }
    }

    this.fileWatcher.close();
    await this.mcpClient.disconnectAll();
  }
}
```

---

## 4. 与 Engine 的上下文边界

Harness 在每次调用 Engine 前，通过 `ContextEngine.compress(messages)` 生成压缩后的上下文。压缩后的 `ContextWorkspace` 需要被转换为 Engine 可识别的 `Message[]`：

```typescript
function toEngineMessages(workspace: ContextWorkspace): Message[] {
  const messages: Message[] = [];
  if (workspace.system) {
    messages.push({ role: 'system', content: workspace.system });
  }
  if (workspace.summary) {
    messages.push({ role: 'system', content: `Earlier conversation summary: ${workspace.summary}` });
  }
  messages.push(...workspace.recent);
  return messages;
}
```

---

## 5. 已知修复与改进（vs 原始草稿）

- TS/Rust 边界已明确：Harness 运行在 WebView 的 TS 中，Rust 只提供 OS 能力。
- StateManager 从旧版版本链降级为检查点，删除旧版 diff、撤销、版本对比等复杂逻辑。
- ContextEngine 从旧版多级压缩降级为滑动窗口 + 可选 LLM 摘要。
- 明确 tool_call / tool_result 成对保留约束。
- Engine 在 `StateChange` 到 `OBSERVE` / `TERMINATE` 时触发 Harness 检查点。
