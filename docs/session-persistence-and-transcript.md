# 会话持久化与界面转录架构

> 本文说明 GUI 会话在运行时、持久化和历史恢复之间的职责边界。
> 规范依据：`src/ui/store.ts`、`src/ui/chat.ts`、`src/ui/transcriptProjection.ts`、`src/ui/main.ts`。
>
> 本文讨论的是 GUI 会话快照，不替代 Engine/Harness 内部用于下一轮执行的 `Message[]` 检查点契约。

## 1. 核心原则

Pure 必须严格区分两种“历史”：

1. **模型上下文（Model Context）**：下一次请求真正发送给 LLM 的消息。
2. **界面转录（Transcript）**：为了让用户看到完整过程而保存的展示数据。

因此，界面显示不是把界面字符串反向塞回模型记忆，而是由模型消息和展示元数据共同投影出来：

```text
ModelContext.messages
        │
        │  LLM 请求 / 工具循环 / 上下文压缩
        ▼
   canonical Message[]
        │
        ├──────────────┐
        │              │
        ▼              ▼
TranscriptEntry[]   SessionUiState
        │              │
        │              ├─ 当前计划与游标
        │              └─ 暂停/进行中的 UI 状态
        ▼
projectTranscript()
        ▼
TranscriptReplayBlock[]
        ▼
UI DOM
```

### 1.1 不能混淆的内容

| 内容 | 模型上下文 | 界面转录 / UI 状态 |
|---|---:|---:|
| 用户原始请求 | 是 | 是 |
| assistant canonical 回复 | 是 | 可有展示快照 |
| assistant tool calls | 是 | 是，用于恢复工具行 |
| tool result | 是 | 是，用于恢复输出、耗时和成功状态 |
| 分析文本 | 否，除非它本身被明确作为模型消息发送 | 是 |
| reasoning / thinking phases | 否 | 是 |
| Markdown 图表、图片的展示修复内容 | 否 | 是 |
| 工具执行参数、耗时、结果分类 | 否，不作为额外 UI 字段发送 | 是 |
| 计划暂停卡、评估卡、Todo 游标 | 否 | 是 |
| `<task_context>` 等请求上下文 | 是，属于模型输入 | 不显示在用户气泡中 |

`analysis`、`thinking`、`toolExec`、`artifacts`、`assessment` 和 `planState` 都不能添加到 `Message` 上，也不能通过 UI 展示字段回填 `modelContext.messages`。

## 2. V2 会话快照

当前 GUI 持久化的主格式是 `SessionSnapshotV2`：

```typescript
interface SessionSnapshotV2 {
  version: 2;
  modelContext: {
    messages: Message[];
  };
  transcript: TranscriptEntry[];
  uiState: {
    planState?: {
      plan: Plan;
      planNumber: number;
      todoNumber: number;
      started: boolean;
    } | null;
  };
}
```

### 2.1 `modelContext.messages`

这是 LLM 的 canonical 对话。它只使用共享类型 `Message`：

- `role`
- `content`
- `toolCallId`
- `toolName`
- `name`
- `toolCalls`

下一次继续对话时，`ChatController.loadFromStorage()` 只读取这一层。上下文压缩也只作用于这一层，并且必须保持 assistant tool call 与对应 tool result 的完整配对。

### 2.2 `transcript`

`TranscriptEntry` 是展示恢复所需的消息锚点和元数据。它目前仍保持 message-shaped 结构，便于兼容已有消息顺序，但它不是新的模型上下文：

- `content`：界面投影使用的正文快照；通常来自 canonical message，富媒体或旧会话恢复时可以是展示覆盖内容。
- `analysis`：任务分析卡内容。
- `thinking` / `thinkingPhases`：思考过程和有序思考阶段。
- `toolCalls`：解析后的工具调用摘要，用于通过 `toolCallId` 找到工具名称和参数。
- `toolExec`：工具输出、成功状态、耗时、结果类型和图片/搜索数据。
- `artifacts`：生成文件卡片。
- `isPlanPause` / `assessment`：计划暂停消息及其评估卡。
- `modelMessageIndex`：当前实现中的消息位置兼容字段，用于裁剪和迁移；它不是长期稳定身份，见第 7 节。

### 2.3 `uiState`

`uiState` 保存不应进入 LLM 对话、但需要在恢复后继续工作的界面状态。目前主要是：

- 当前复杂计划。
- 当前计划编号和 Todo 游标。
- 计划是否已经开始执行。
- `null` 表示计划已被明确取消或不存在。

恢复时 `ChatController.loadFromStorage()` 会根据这一层重建右侧计划总览；转录投影则负责恢复聊天内容中的评估卡和暂停操作。

## 3. 保存链路

运行时不再先构造旧版 `StoredMessage[]` 再保存。`ChatController.persistSession()` 的主路径是：

```text
LLM / 工具循环
    ↓
canonical Message[]
    + TranscriptDraft[]
    ↓
createSessionSnapshot()
    ↓
mergeSessionSnapshotMetadata()
    ↓
saveSession()
```

保存时遵守以下规则：

1. assistant 的 canonical 内容优先来自模型消息。
2. 如果适配器最终消息为空，但流式 UI 已收到真实正文，只在保存边界补齐 canonical assistant 内容。
3. 分析、思考、工具状态、评估和文件卡片写入转录层。
4. 后续 turn 重建快照时，使用当前生成的消息级 ID 合并之前的展示元数据，避免早期分析和思考过程被新一轮保存覆盖；该 ID 的长期稳定性仍是下一阶段优化项。
5. 计划取消时明确写入 `uiState.planState = null`，不能依赖“缺字段”表达清除。

### 3.1 存储后端

- **Tauri**：前端调用 `save_session(sessionId, snapshot, workspace)`；Rust 将 `snapshot` 写入 `~/.pure/sessions/<sessionId>/session.json`，并从 `modelContext.messages` 生成索引标题和消息计数。
- **纯浏览器开发模式**：localStorage 保存 `{ snapshot, updatedAt, messageCount, workspace }`。
- 保存前会对 `modelContext.messages` 做有界裁剪，当前上限为 `MAX_PERSISTED_MESSAGES = 400`；转录只保留仍对应于该模型窗口的条目。

Rust 的 `session.json` 外层仍保留 `messages` 字段用于旧版本索引和读取兼容，但 V2 的真实快照位于 `snapshot` 字段。新的前端读取优先使用 `snapshot`，不能把外层 `messages` 当成 V2 的完整 UI 数据。

## 4. 历史恢复链路

历史会话恢复由 `SessionSidebar` 触发，顺序如下：

```text
SessionSidebar.load()
    ↓
loadSession()
    ↓
normalizeSessionSnapshot()
    ├─ V2：直接读取 modelContext / transcript / uiState
    └─ V1：createSessionSnapshotFromLegacy()
    ↓
ChatController.loadFromStorage(snapshot)
    ├─ 只加载 modelContext.messages
    └─ 根据 uiState 恢复计划总览
    ↓
projectTranscript(snapshot.transcript)
    ↓
TranscriptReplayBlock[]
    ↓
main.ts 渲染 DOM
```

`src/ui/transcriptProjection.ts` 是转录到界面块的唯一投影入口。它负责：

- 按转录顺序产生用户、分析、思考、助手、工具、评估和产物块。
- 通过 `toolCallId` 配对工具调用和工具结果，而不是依赖相邻数组位置。
- 对没有返回结果的 tool call 生成 stopped 工具块，避免历史中出现“调用消失”。
- 对旧会话缺少 `toolExec` 的情况，从工具消息和前置调用补全参数、名称和结果。
- 对缺少显式产物元数据的旧会话，从成功的写文件工具推导文件卡片。

`src/ui/main.ts` 只消费 `TranscriptReplayBlock[]`，不再直接从快照字段推断界面结构。历史恢复仍逐块让出浏览器帧，并使用共享滚动合帧逻辑，避免一次性重建长转录阻塞输入。

### 4.1 用户气泡与模型上下文的差异

请求级 `<task_context>` 是模型输入的一部分，但不是用户原始文本。恢复用户气泡时，UI 使用 `stripUserTurnContext()` 去掉该块；恢复模型上下文时不做这一步。

这保证了：

```text
LLM 看到：请求 + 本轮必要的 task_context
用户看到：自己真正输入的请求
```

两者不同是有意设计，不是数据丢失。

## 5. 旧会话迁移

V1 旧格式通常是：

```typescript
{
  messages: StoredMessage[]
}
```

迁移时：

1. `StoredMessage` 的模型字段转换成 `modelContext.messages`。
2. `displayContent` 只转换为 `transcript.content`，绝不作为空模型内容的回退值。
3. `analysis`、`thinking`、`thinkingPhases`、`toolExec`、`artifacts`、`assessment` 和 `planState` 转换为转录/UI 状态。
4. 缺少 V2 字段的旧工具结果通过 `tool_call_id` 和前置 tool call 兼容恢复。
5. 读取后的旧结构不会成为新的运行时保存主路径。

因此，旧会话可以继续显示富媒体、分析、思考和工具信息，同时不会把界面专用内容污染到下一次 LLM 请求。

## 6. 不变量与验证

实现必须保持以下不变量：

- `modelContext.messages` 是唯一的 LLM 继续对话输入。
- `transcript` 和 `uiState` 不得被拼接进 provider 请求。
- `displayContent` 不得作为 `Message.content` 的历史恢复回退。
- assistant tool call 和 tool result 在模型上下文中必须成组保留或成组裁剪。
- 工具 UI 关联优先使用 `toolCallId`。
- 计划取消必须可持久化为明确的 `null`。
- UI 恢复失败不能静默清除模型上下文；应移除加载提示并向调用方抛出错误。
- 历史恢复不能改变当前会话的 workspace、路径链接解析或模型上下文边界。

相关验证：

```bash
bun run typecheck
bun test src/ui/__tests__/store.test.ts \
  src/ui/__tests__/thinkingPersistence.test.ts \
  src/ui/__tests__/transcriptProjection.test.ts
bun test
cargo check
```

核心测试覆盖模型/UI 隔离、旧会话迁移、分析与思考恢复、工具配对、计划评估和产物卡片恢复。

## 7. 优化评审

### 当前已经足够稳定的部分

- 模型上下文与 UI 展示已经在持久化格式上分层。
- 历史恢复不再通过 `displayContent` 猜测模型内容。
- 转录投影与 DOM 渲染已经分离，工具、思考和计划恢复可以独立测试。
- 上下文压缩只影响下一次 provider 请求，不删除运行中的可见转录。
- V1 迁移和无 `toolExec` 的旧工具数据都有兼容路径。

### 建议的下一阶段优化

1. **用稳定的模型消息 ID 替代位置索引**：当前 `modelMessageIndex` 在上下文裁剪、插入摘要或消息重写后仍可能发生错位。下一版可以在 canonical message 生成时分配持久化 `modelMessageId`，让转录和模型消息通过 ID 关联。
2. **把 message-shaped transcript 逐步演进为事件序列**：当前投影层已经独立，但仍需根据 assistant/tool 顺序推断部分工具批次。长期可以采用带 `sequence` 的 `TranscriptEvent[]`，直接表达 `analysis → thinking → tool_start → tool_result → assistant → artifact`，减少恢复时的推断。
3. **增加快照 schema 校验与迁移注册表**：当前读取层对 V2 字段做了兼容归一化，但主要依赖类型断言。随着字段增加，应为每个版本提供运行时校验、迁移函数和坏数据错误提示。
4. **补充真实 WebView 端到端测试**：现有单元测试验证投影结果，仍应在真实 Tauri/WKWebView 中点击历史会话，检查正文、Markdown、分析、工具行、计划卡和继续操作是否全部存在于 DOM。
5. **长会话富内容虚拟化**：持久化和上下文已有 400 条消息上限，当前活动 WebView 仍保留完整 DOM。若单条消息包含大量图表、图片或终端输出，可进一步采用分段渲染/虚拟列表，但必须保证复制、路径链接和滚动定位不退化。

这些优化不应重新合并模型上下文与界面转录；它们是在当前边界之上改进身份关联、校验、事件表达和渲染性能。
