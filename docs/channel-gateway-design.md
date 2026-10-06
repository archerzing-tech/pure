# Channel Gateway 设计文档（通道网关）

> 目标版本：v3.1（Phase 0/1 为 MVP）
> 参照：OpenClaw 的 Gateway + ChannelPlugin 模型（长期运行的守护进程 + 能力驱动的通道插件 + 会话隔离 + 设备配对）
> 状态：设计稿；**P0 骨架 + P1 飞书已实现**。
> - P0：`src/channels/` + `src/adapter/channels/webchat/` + `pure gateway` / `pure channels`，验收 `bun run verify:channel-loop`。
> - P1：飞书适配器（`src/adapter/channels/feishu/`，SDK 动态 import）+ 钉钉适配器（`src/adapter/channels/dingtalk/`，`dingtalk-stream` 动态 import；卡片实例原地更新尚未实现，一律降级为只发最终结果）+ 配对（`src/channels/pairing.ts`，`pure channels pending|approve`）+ 出站队列落盘重放（`~/.pure/channels/outbox.jsonl`）+ 通道档 LLM 复核验证器（`src/channels/verifierProfile.ts`），验收 `bun run verify:channel-feishu` / `bun run verify:channel-dingtalk`（mock transport）。
> - P2（部分）：审计（`src/channels/audit.ts`，默认只记 hash/长度/元数据）+ 限流与每日预算（`src/channels/limits.ts`）+ 出站队列落盘（已随 P1 前移）+ 富输出降级矩阵（`src/channels/richOutput.ts` + `src/channels/rasterize/`：`chart`/`svg` 走 `@resvg/resvg-js`，`mermaid`/`puml` 走 headless Chrome —— 系统 Chrome + 裸 CDP，不引入 puppeteer/playwright，没装 Chrome 才降级为文本；飞书/钉钉出站图片上传已接入，按 `canDeliverImages` 投递成图片消息），验收 `bun run verify:channel-diagrams`。
> - P2（部分）：**通道投影**（`src/channels/projection/`，设计见 [`docs/channel-projection-design.md`](channel-projection-design.md)）：目标是在通道里看到与桌面端 GUI 一致的表现——把桌面端自己的渲染管线（同一份 `src/ui/markdown.ts` + `src/ui/styles.css` + 同一 DOM 层级）搬进 headless Chrome 页面，按块截图成 PNG 投递；正文与段落列表保持原生 markdown，代码块/表格/图表与 GUI 同像素。渲染失败或图片超限时把富块源码并回正文，**内容永不丢失**；纯文本回答不启动浏览器。优先级：通道投影 > `richOutput` 单块光栅化 > 纯文本，验收 `bun run verify:channel-projection`。
> - P3–P4 仍为设计稿；个人微信维持「默认关闭」。

## 1. 要解决什么

pure 现在有两个表面：终端 CLI（Bun 进程，`bun run cli`）和 Tauri 桌面 GUI（agent 核心跑在 WebView）。
两者都要「人在旁边」——CLI 等你敲字，GUI 窗口一关进程就没了。

本设计给 pure 加**第三个表面：Channel（通道）**。让 agent 从 Telegram / 飞书 / 微信这类聊天应用里被驱动，
多台设备、多个群、多个人都能各自对话，而 agent 仍然拥有完整的 pure 能力（workspace 工具、验证闭环、
项目记忆、子代理编排、MCP、权限门控）。

**做**：

- 一个常驻守护进程 `pure gateway`，同时挂载多个通道；
- 通道插件化——接一个新平台不改核心（能力声明驱动，不为每个通道写特例）；
- 每（人 × 通道 × 会话）× workspace 独立 agent 会话，checkpoint 可恢复；
- 无人值守下的**安全默认值**：来源未配对不进入 agent、渠道来源默认只读、危险操作必须显式批准；
- 富输出落到聊天窗口：流式、分片、图表/图片转附件、附件回传；
- 可靠投递：入站去重、出站 outbox 重放。

**不做**（明确划界）：

- 不做「把 GUI 变成服务器」——WebView 生命周期不适合 7×24（见 §3 决策 D1）；
- 不做跨平台身份合并（identity linking）——默认 per-channel-peer 隔离，合并是后续可选能力；
- 不把通道做成 MCP server（见 §11 反方论证 R3）；
- 不承诺个人微信的稳定接入（见 §8）。

---

## 2. 现状锚点：能直接复用什么

设计的前提是**最大化复用已有的控制平面**，否则会长出第二套决策逻辑（这个仓库明确反对「GUI 一套判断、CLI 另一套判断」）。

| 已有件 | 位置 | 通道场景怎么用 |
|:---|:---|:---|
| `createHarness(args)` 完整装配 | `src/cliHarness.ts`（导出） | 一个通道会话 = 一个 Harness 实例，直接复用（含记忆、MCP、子代理、hooks、failurePolicy） |
| `Harness.run / continueTurn` | `src/harness/Harness.ts:277 / :551` | 首轮 `run()`，续轮 `continueTurn()`；流式产出 `EngineEvent` |
| `PermissionManager` 四模式 + `PermissionRequestHandler` | `src/coding-agent/PermissionManager.ts`、`src/coding-agent/types.ts:153` | 换一个 handler 实现即可：GUI 弹窗 / CLI 终端 y-n-a / **通道聊天卡片** —— 同一个接口三个表面 |
| `PromptAssembler`（`surface: 'gui' \| 'cli'`） | `src/shared/PromptAssembler.ts:34` | 新增 `surface: 'channel'`，输出风格走第三条分支（无 DOM、以聊天可读为准） |
| `requestWorkflow` / `adaptiveControl` | `src/shared/` | 不改：通道请求同样走 intake→assess→probe→plan→confirm |
| `NodeToolAdapter({ workspace })` | `src/cliHarness.ts:createTools` | **workspace 在构造时绑定** → 这是 §5「一个 workspace 一个 harness」的根因 |
| `StateManager` + `SQLiteStore/FSStore` + `--resume` | `src/harness/StateManager.ts` | 通道会话的重启恢复直接复用 checkpoint 机制 |
| `transcriptProjection.ts` | `src/ui/` | Phase 3 让 GUI 只读投影通道会话的对话 |
| `userHooks`（`on_turn_complete`） | `src/shared/userHooks.ts` | `examples/hooks/` 已有「每轮完成桌面通知」，通道侧可照抄 |
| `mcpPoisonScan` 的立场 | `src/shared/mcpPoisonScan.ts` | 「外部内容是数据、不是指令」——通道入站文本需要同样的姿态（§6.4） |
| `promptObservability` 隐私原则 | `src/shared/promptObservability.ts` | 审计日志默认只记 hash/长度/元数据，不落原文 |

**结论**：通道层是 **Adapter Layer 的第 6 类适配器** + **一个新的宿主进程**，不是新的 agent 实现。

---

## 3. 关键架构决策（含被否决方案）

### D1 宿主形态：独立守护进程 `pure gateway`（否决「GUI 常驻」）

```text
                     ┌──────────────────────────────┐
   Telegram ─────────┤                              │
   飞书     ─────────┤   pure gateway (守护进程)      │
   WebChat  ─────────┤   ├─ ChannelRegistry          │
   企微     ─────────┤   ├─ SessionRouter → Harness  │
                     │   ├─ ChannelRenderer          │
                     │   ├─ ApprovalRouter           │
                     │   └─ Outbox                   │
                     └───────────┬──────────────────┘
                                 │ 共享
                     ┌───────────▼──────────────────┐
                     │ createHarness 装配（与 CLI 同一份）│
                     │ Engine / ContextEngine / 记忆   │
                     │ 权限门控 / 子代理 / MCP / 工具    │
                     └──────────────────────────────┘
```

否决理由：

| 方案 | 否决原因 |
|:---|:---|
| 常驻在 Tauri GUI 里 | 关窗口即停；无头服务器无法部署；agent 核心在 WebView，通道逻辑要跨 IPC 绕一圈 |
| 每条消息起一个 `pure "..."` 进程 | **没有会话连续性**（第二句接不上第一句的上下文）；每轮重付冷启动（记忆 embedder 加载、MCP 连接、技能扫描）；无法流式回消息；并发不可控。这是最容易想到的省钱方案，必须明确否掉 |
| 把 gateway 写进 Rust 侧 | pure 的 agent 核心是 TypeScript（Engine/Harness/CodingAgent 全在 TS）。Rust 只做 OS 手脚，不做决策。写进 Rust 等于把 agent 再实现一遍 |
| 通道用 MCP 接入 | MCP 是**模型主动 pull** 的工具协议，通道需要的是**外部 push 的入站事件源**，方向相反（§11 R3） |

选 `pure gateway` 的收益：CLI 已经是无头的、已经持有完整装配、`bun run cli:build` 能打成单文件二进制 →
`pure gateway` 天然可部署到 VPS / 家里的常开机器；本地 macOS 走 launchd、Linux 走 systemd。

### D2 抽象：ChannelAdapter = 入站事件源 + 出站投递（能力声明驱动）

接口定义放 **Shared Kernel（纯 TS）**，实现放 `src/adapter/channels/*`，与 `LLMAdapter / ToolAdapter /
IStateStore / IMemoryStore / MCPSession` 并列，遵守 Adapter Layer 的五条原则（接口隔离 / 运行时无关 /
可 Mock / 构造注入 / 错误不吞没）。

核心不变式：**核心逻辑只读 `capabilities`，从不 `if (channelId === 'telegram')`**。通道能力差异全部
在声明里表达，不支持的能力由渲染器降级（§7）。

### D3 会话键：per-channel-peer，并额外叠加 workspace

```text
sessionKey = ${channelId}:${accountId}:${peerKind}:${peerId}[:${threadId}]
            （默认 dmScope = per-channel-peer，与 OpenClaw 一致）
```

为什么不能全局共享一个会话：A 在 WhatsApp 问的问题会进 B 在 Telegram 的上下文；群里每个人互相覆盖。
为什么不引入身份合并：默认隔离更安全，合并是显式的可选能力（Phase 4+）。

**pure 特有的第二维**：workspace。`NodeToolAdapter` 在构造时绑定 workspace（`createTools`），
`projectPath` 又决定记忆桶隔离。所以：

```text
AgentSession 身份 = (workspace, sessionKey)
```

工作区由 binding 链解析（见 §5），不是由 agent 自己猜。

### D4 安全默认值：渠道来源默认 PLAN（只读）

通道消息是**无人值守**的。pure 的 `NORMAL` 模式要人按 y/n/a，聊天窗口里没人按。
绝不能为了「可用」把渠道默认成全自动——那等于任何人给 bot 发一句话就能删库。

规则：**渠道来源的 binding 默认 `permissionMode: 'PLAN'`（只读）**，写操作/命令必须由 binding 显式升级；
即使升级了，`NORMAL` 下的每次写仍必须走审批回路（§6.3），且**超时默认拒绝**。
这符合 pure 已有的硬门控哲学：权限是程序不变式，不能被 adaptive context 或提示词放开。

### D5 内部事件总线先定，外部 WS 控制平面后定

「多个终端」有两种解释，两种都要覆盖：

1. **多设备**：每个通道本身就是一端，天然满足（Phase 1 达成）。
2. **本地多进程**：GUI / CLI / Web 同时看向**同一个** gateway（`pure attach`、GUI 实时看通道会话、
   在电脑上点「批准」）。

第二种需要 WS 控制平面（对齐 OpenClaw 的 `req/res/event` + 首帧 connect + 设备配对）。但**现在不定义协议**，
只要求 gateway 内部所有跨组件通信都走同一个 `ChannelEventBus`（入站、出站、审批、状态）。
这样 Phase 3 的控制平面只是「再加一个订阅者」，不是重构。

---

## 4. 组件与接口

### 4.1 目录

```text
src/channels/                     # 通道层（宿主 + 路由 + 渲染 + 审批）
  types.ts                        # 规范类型（Shared Kernel，无外部依赖）
  registry.ts                     # 内置插件 + ~/.pure/channels/<id>/ 动态加载
  gateway.ts                      # 守护进程：启动/停止适配器，持有 EventBus
  router.ts                       # sessionKey + binding → AgentSession
  agentSession.ts                 # Harness 生命周期：run / continueTurn / 落盘 / 驱逐
  renderer.ts                     # EngineEvent → OutboundMessage（流式/分片/媒体）
  approvals.ts                    # 渠道版 PermissionRequestHandler + 配对
  outbox.ts                       # 出站可靠投递 + 重放
  audit.ts                        # 审计（默认不落原文）
  config.ts                       # ~/.pure/channels.json 读写 + schema 校验
  richOutput.ts                   # 富输出提取 + 能力驱动的降级矩阵
  rasterize/                      # 光栅化：resvg 直转（chart/svg）+ headless Chrome（mermaid/puml）
  projection/                     # 通道投影：桌面端同管线 headless Chrome 渲染 + 按块截图（docs/channel-projection-design.md）
  __tests__/
src/adapter/channels/
  webchat/                        # 零依赖自带通道（开发/内网自测）
  feishu/                         # 开放平台长连接 + 交互卡片 + 出站图片
  dingtalk/                       # 钉钉 Stream + 卡片 + 出站图片（media/upload → robot OpenAPI）
  telegram/ wecom/ wechat-personal/   # 设计稿，未实现（§8：个人微信默认关）
```

### 4.2 规范类型（`src/channels/types.ts`）

```ts
export type ChannelId = string;   // 'telegram' | 'feishu' | 'webchat' | ...

/** 通道能力声明 —— 核心逻辑的唯一分支依据。 */
export interface ChannelCapabilities {
  chatTypes: ('dm' | 'group')[];
  media: { images?: boolean; audio?: boolean; video?: boolean; files?: boolean };
  /** none=整段发；edit=编辑已发消息；card=平台卡片流式；stream=全量替换式流式消息（企业微信） */
  streaming: 'none' | 'edit' | 'card' | 'stream';
  maxTextLength: number;              // 各平台上限，以官方文档/实测为准（见 cn-im-channels.md §7）
  markdown: 'none' | 'basic' | 'full';
  threads?: boolean; reactions?: boolean; typing?: boolean;
  editMessages?: boolean; deleteMessages?: boolean; buttons?: boolean;
  /** 群聊必须 @ 才响应（飞书/钉钉/企微的群聊语义，默认 true） */
  requiresMentionInGroup?: boolean;
}

export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly capabilities: ChannelCapabilities;
  /** 出站（唯一必需能力） */
  send(target: ChannelTarget, msg: OutboundMessage, opts?: SendOptions): Promise<SendResult>;
  /** 声明式可选能力：capabilities 里为 true 才会被调用 */
  editMessage?(target: ChannelTarget, messageId: string, msg: OutboundMessage): Promise<void>;
  setTyping?(target: ChannelTarget, on: boolean): Promise<void>;
  downloadMedia?(ref: MediaRef): Promise<LocalMedia>;
  /** 生命周期：适配器自己负责长连接/webhook，入站经 ctx.onInbound 推入 */
  start(ctx: ChannelRuntimeContext): Promise<void>;
  stop(): Promise<void>;
  listAccountIds(): string[];
}

/** 入站归一化事件（适配器 → gateway） */
export interface InboundEvent {
  kind: 'message' | 'reaction' | 'command' | 'status';
  channelId: ChannelId; accountId: string;
  peer: { id: string; kind: 'dm' | 'group'; name?: string };
  threadId?: string;
  messageId: string;                     // 入站幂等键来源
  text: string;
  attachments: InboundAttachment[];      // 已下载到本地临时目录
  receivedAt: number;
  raw?: unknown;                         // 仅供审计，不进模型上下文
}
```

设计要点：

- **入站是 push、不是返回值**（`ctx.onInbound`），因为 webhook / 长连接轮询是外部驱动；
- `raw` 永不进模型上下文——外部平台的内容是**数据**，不是指令（§6.4）；
- 适配器**不做渲染、不做分片、不做权限判断**，只做平台协议 ↔ 规范类型；
- 适配器内部错误自己重连，抛出的错误由 gateway 统一处理（Adapter 原则第五条）；
- **流式帧在规范层是「全量快照」而不是增量**：飞书卡片更新、企微 `stream.content` 都是整块内容替换。
  适配器只负责把快照写到平台，累积与节流由 renderer 统一处理（§7）。

### 4.3 事件总线

```
InboundEvent ──► ChannelEventBus ──► SessionRouter ──► AgentSession(Harness)
                                                          │ EngineEvent 流
                                                          ▼
     OutboundMessage ◄── ChannelRenderer ◄────────────────┘
            │
            ├─► Outbox ──► ChannelAdapter.send()
            └─► (Phase 3) WS 控制平面订阅者
```

同一会话的入站事件**串行**入队（一个 in-flight turn），不同会话并行但受全局并发上限约束。

---

## 5. 会话映射与 workspace 绑定

### 5.1 binding 优先级链（高 → 低）

```jsonc
{
  "bindings": [
    // 1. 群 / 主题级（最高）
    { "match": { "channel": "telegram", "peer": "-1001234", "threadId": "7" },
      "workspace": "/Users/me/work/api", "permissionMode": "NORMAL", "toolProfile": "coding" },
    // 2. 单聊级
    { "match": { "channel": "feishu", "peer": "ou_xxx" },
      "workspace": "/Users/me/personal-notes", "permissionMode": "PLAN", "toolProfile": "readonly" },
    // 3. 通道级
    { "match": { "channel": "telegram" }, "workspace": "/tmp/playground", "permissionMode": "PLAN" }
  ],
  "default": { "workspace": null, "permissionMode": "PLAN", "toolProfile": "readonly" }
}
```

`workspace: null` = 无工作区会话（只聊天、不碰文件；`createTools` 本来就会返回空工具集）。

### 5.2 AgentSession 生命周期

- 首条消息（无 checkpoint）→ `harness.run(systemPrompt, userText, signal, images)`；
- 有 checkpoint（本进程内 hot，或重启后从 store 恢复）→ `harness.continueTurn(...)`；
- 空闲 TTL（默认 30 min）→ 落 checkpoint、`settleReflections()`、释放 Harness，从内存 LRU 驱逐；
- **一个 workspace 一个 tools 实例**：同一 workspace 的多个会话共享 Harness 装配开销（MCP 连接、
  技能扫描）但各自独立的 `messages`/`sessionSystemPrompt`；
- **gateway 启动时就要预装配已配置 workspace 的 Harness**：国内平台对首次回复有硬时限
  （飞书 3 秒 / 企微 5 秒），记忆 embedder、MCP 连接、技能扫描都不能落在首条消息的关键路径上。
- 会话索引：`~/.pure/channels/sessions.json`（`sessionKey → { sessionId, lastActivityAt, workspace }`）。

**每个通道会话的 verifier 要比 CLI 更强**：CLI 为了延迟用纯规则 verifier，GUI 有 LLM 复核。
通道场景**没有人在旁边看输出**，验证是唯一的质量闸 → 通道 profile 应走 GUI 那档（含 LLM 复核），
延迟换正确性。这是本设计和 CLI 默认值的**有意分叉**，需要在实现时显式传参，不能靠默认值继承。

---

## 6. 安全模型

### 6.1 三层（对齐 OpenClaw，但复用 pure 已有原语）

```text
第一层  入口信任     dmPolicy: pairing(默认) | allowlist | open
                    首次私信生成配对码 → 必须在本地批准
                    群聊默认只在 @提及 / 触发前缀时响应
        ────────────────────────────────────────────
第二层  能力收敛     binding 的 permissionMode（PLAN 默认）+ toolProfile（allow/deny）
                    危险动作在工具层被拦，不依赖提示词自觉
        ────────────────────────────────────────────
第三层  运行中审批   PermissionRequestHandler → 审批卡片（回复 y/a/n 或按钮）
                    发到原会话 + 所有已配对管理设备；超时 120s 默认拒绝
```

第一层落地：`pure channels pending` / `pure channels approve <code>`（进程内 IPC 或直接读
`~/.pure/channels/pending-pairings.json`）。批准后签发 per-peer 设备令牌，写进
`~/.pure/channels/peers.json`（0600）。

### 6.2 审计

`~/.pure/channels/audit.jsonl` 每行：`{ ts, channelId, peerHash, sessionKey, decision, tool, argsHash }`。
默认**不落原文**（沿用 `promptObservability` 的隐私姿态），需要排障时用
`PURE_CHANNEL_AUDIT=full` 显式打开。

### 6.3 审批回路（本设计里最容易做错的一块）

复用 `PermissionRequestHandler`（`src/coding-agent/types.ts:153`），实现 `createChannelApprovalHandler()`：

- 请求 → 发一条带按钮/编号的审批卡片到原会话；
- 同时在本地 gateway 日志里打印（在电脑前的人可以直接批准）；
- 决策来源二选一先到先得：聊天回复、按钮回调、本地 stdin；
- **超时 = 拒绝**，并回一条「已拒绝，因为无人确认」——不静默吞掉，也不静默放过。

**双轨（必做）**：卡片按钮都有失效场景（模板未发布、旧卡片回调不支持长连接、群里点不了按钮），
所以审批**永远**同时给出文字指令 `回复 y 批准 / n 拒绝 / a 本次会话总是允许`，与 CLI 的 `y/a/n` 语义一致；
卡片下发失败时自动降级为纯文字审批并在日志里说明原因。

### 6.4 prompt injection

渠道入站文本来自第三方（群里的陌生人）。姿态与 `mcpPoisonScan` 一致：

- 入站文本作为普通 user 消息进入，绝不进入 system 段；
- 未配对来源根本进不了 agent（第一层挡掉大部分）；
- 已配对来源仍受绑定 toolProfile 限制；
- 群聊场景额外把「其他人说的话」包成引用块并标注来源，降低「群里有人冒充系统」的成功率。

### 6.5 成本与滥用

- 每 peer 速率限制（默认 5 条/分钟，超出排队并告知）；
- 每 peer / 全局每日 token 预算，超出后只回一句「今日额度用完」而不进 agent；
- 未配对消息计入日志但不消耗预算（因为不进 agent）。

---

## 7. 输出渲染（能力驱动降级矩阵）

`ChannelRenderer` 在 gateway 层（不在适配器内），所有通道共享一份降级策略：

| pure 的输出 | 通道能力齐全 | 能力受限时的降级 |
|:---|:---|:---|
| **通道投影（首选，针对整条回答）** | ✅ 已实现（`src/channels/projection/`）：回答含富块（代码块/表格）且通道能发图、本机有 Chrome 时，正文走原生 markdown，富块用**桌面端同一渲染管线**（同一份 `src/ui/markdown.ts` + `styles.css` + 同一 DOM 层级）在 headless Chrome 里逐块截图成 PNG 投递；纯文本回答不投影、不启动浏览器 | 没装 Chrome / 渲染失败 / 图片超 8MB 或超 Chromium 8192px 截图上限：该富块源码并回正文合成连续消息（不丢内容），并回落 richOutput 单块光栅化 / 纯文本 |
| 流式回答 | `streaming: 'edit'` 节流 edit（≥1s，防限流）；`'card'` 走平台卡片 | `'none'`：typing + 一次性发最终结果 |
| 长回答 | ≤ `maxTextLength` | 按段落边界分片，附 `(1/3)`；超阈值转 `.md` 附件 |
| `chart` DSL | ✅ 已实现：`echarts` SSR 出 SVG（复用 GUI 的 `parseChartSource`/`buildChartOption`）→ `@resvg/resvg-js` 光栅化成 PNG → 附件，经适配器 `sendImage` 真投递（飞书/钉钉/自建 webchat 已接入） | 转 markdown 表格 / 纯文本序列 |
| `svg` / `mermaid` / `puml` | ✅ 三者都光栅化成 PNG 并同 `chart` 一路投递：`svg` 直接走 resvg；`mermaid`/`puml` 在 headless Chrome 里跑 UI 同一批引擎拿到 SVG（happy-dom 下 mermaid 只返回空串、puml 直接挂，所以必须真浏览器）→ resvg 转 PNG | 没装 Chrome / 渲染失败：原样贴文本并标注「请在 GUI 中查看」 |
| `generate_image` 产物 | 图片附件（通道 `canDeliverImages` 为真时才转图片消息，否则正文保留路径） | 回绝对路径 + 提示在本地查看 |
| `write_file` 产物 | 文件附件（有 files 能力） | 回路径 + 变更摘要 |
| 工具执行过程 | `typing` + 关键节点一行摘要（对齐 CLI 的子代理进度行） | 仅「正在处理…」与最终结果 |

降级矩阵是**数据表**，不是 per-channel 的 if/else——新增通道只需声明 capabilities。

注意通道投影与 richOutput 单块光栅化不是平级互斥的两行：投影在 deliverFrame 层**优先**于 richOutput，
只有投影不可用（无 Chrome / 纯文本回答）或逐块失败时，才由 richOutput 与纯文本兜底。
完整契约、尺寸硬限制与反方论证见 [`docs/channel-projection-design.md`](channel-projection-design.md)。

两条与流式相关的硬约束：

- **全量替换**：所有支持流式的通道（含飞书卡片、企微 `stream`、钉钉 AI 卡片）都是整块内容替换。
  renderer 内部维护「累积快照 + 上次已发送内容 + 节流时间戳」，每次写入快照而非追加 delta——
  不能直接复用 GUI 的增量渲染逻辑。
- **两类队列不能混用**：进度/流式帧是**可丢**的（只发最新快照，默认 1 次/秒节流，避免触发平台频控）；
  最终结果 / 审批请求 / 错误是**不可丢**的，走 outbox 重试与重启重放。

---

## 8. 通道选型（含合规约束，这部分必须诚实）

| 通道 | 接入方式 | 依赖 | 公网要求 | 评价 |
|:---|:---|:---|:---|:---|
| **webchat**（自带） | gateway 自带极简页面 + WS | 零 | 否 | **Phase 0 用它打通端到端**，也是没公网时的兜底 |
| **Telegram** | 官方 Bot API，long polling | 零（fetch 即可） | 否 | **首发推荐**：零依赖、无需域名/证书 |
| **飞书 / Lark** | 开放平台自建应用，**长连接模式** | 零（Bun 内置 WebSocket 客户端） | 否 | 有交互卡片 + 卡片流式，体验最好；企业场景合规 |
| **企业微信 WeCom** | 官方机器人 webhook / 回调 | 零 | webhook 需公网 | 「微信生态」的合规路径，推荐用它替代个人微信 |
| 个人微信 | 无官方 API：订阅号被动消息 / 第三方 hook & 协议库 | 重 | 视方案 | **默认关闭、单列插件**。存在账号封禁与违反平台协议风险，不进 MVP，不进推荐路径 |
| cron / CI / webhook | 同一个 ChannelAdapter 抽象的另一实现 | 零 | — | Phase 4 顺手支持（定时任务也是一种「入站源」） |

> 国内的飞书 / 企业微信 / 钉钉三家的完整接入机制（凭证、长连接协议、入站事件、流式与卡片、
> 媒体加解密、频控、以及由此产生的设计修订）见 **`docs/cn-im-channels.md`**。
> 三家现在都提供「无公网 IP 的 WebSocket 长连接」，与纯本地 gateway 的前提完全吻合。

结论：**先 Telegram（零依赖最快）→ 国内三家（飞书 / 钉钉 / 企微，顺序见专项文档 §8）**；
企业微信走「智能机器人长连接」这条官方路径，它同时覆盖了微信生态与「无需公网」两个诉求；
个人微信仍做成独立插件的可选项，不进默认路径。

---

## 9. 配置样例（`~/.pure/channels.json`）

```jsonc
{
  "enabled": true,
  "gateway": { "host": "127.0.0.1", "port": 18790, "wsEnabled": false },
  "limits": { "maxConcurrentSessions": 4, "perPeerPerMinute": 5, "dailyTokens": 500000 },
  "streaming": { "throttleMs": 1000, "ackPlaceholder": true, "cardFallbackToText": true },
  "groupPolicy": { "mentionRequired": true },
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "groupPolicy": "mention",
      "accounts": { "main": { "botTokenRef": "telegram.botToken" } }
    },
    "feishu": {
      "enabled": false,
      "dmPolicy": "pairing",
      "accounts": { "main": { "appId": "cli_xxx", "appSecretRef": "feishu.appSecret",
                              "connectionMode": "websocket", "botOpenId": "ou_xxx" } }
    },
    "dingtalk": {
      "enabled": false,
      "dmPolicy": "pairing",
      // robotCode 与 cardTemplateId 均可省：robotCode 优先从入站消息体取
      // （发图片必需），cardTemplateId 目前不生效（卡片实例更新未实现），降级为只发最终结果。
      "accounts": { "main": { "clientId": "ding_xxx", "clientSecretRef": "dingtalk.clientSecret",
                              "robotCode": "ding_xxx", "cardTemplateId": "" } }
    }
  },
  "bindings": [ /* §5.1 */ ]
}
```

约定：

- 密钥用 `*Ref` 指向既有密钥存储（桌面走 `~/.pure/secrets.json` 的 Rust keyring 槽位；CLI/gateway 走
  `~/.pure/config.json` 的同名约定），**不把 token 明文写进 channels.json**；
- 配置改动**热加载**（watch 文件），不要求重启 gateway；
- 校验不过的配置整体拒绝加载并在日志中给出行号级错误，不做「部分生效」。

---

## 10. 与现有层的接线点（精确到符号）

| 改动 | 文件 | 说明 |
|:---|:---|:---|
| 新增 `surface: 'channel'` | `src/shared/PromptAssembler.ts:34` | `PromptSurface` 加一个分支；`buildOutputStyle`/`buildToolCallingRules` 增加 channel 分支（无 DOM、聊天可读、产物走附件） |
| 新增 `buildChannelCapabilities()` | 同上 | 与 `buildGuiCapabilities` / `buildCliCapabilities` 并列，由 `ChannelCapabilities` 生成 |
| 复用 `createHarness` | `src/cliHarness.ts`（已导出） | 通道按 binding 构造等价的 args：`workspace` + `permissionMode` + `evolutionEnabled`。**Phase 2 再抽 `src/host/agentHost.ts`** 让 CLI/gateway 共用一份装配，MVP 阶段先复用，避免改动 CLI 行为 |
| 新命令 | `src/cli.ts` / `src/cliConfig.ts` | `pure gateway`、`pure channels list|pending|approve|test`；`PureConfig` 增加 `channels` 字段（GUI 设置页后续同步） |
| 权限 handler | `src/channels/approvals.ts` | 实现 `PermissionRequestHandler`，不改 `PermissionManager` |
| 审计 | `src/channels/audit.ts` | 复用 `promptObservability` 的 hash/长度约定 |

**零改动的部分**（这是复用设计的价值）：Engine、ContextEngine、FailurePolicy、SubagentOrchestrator、
记忆与进化、MCP、`requestWorkflow`、`adaptiveControl`、工具实现。

---

## 11. 分阶段路线图与验收

| 阶段 | 内容 | 验收（可脚本化） |
|:---|:---|:---|
| **P0 骨架** | types / registry / gateway（含**单实例进程锁**）/ router / webchat 通道 / outbox（内存版）/ 单 binding（PLAN） | `bun run verify:channel-loop`：起 gateway → webchat 发一句 → agent 在临时 workspace 造一个文件 → 文本流式回到浏览器；进程重启后同一会话能续聊（checkpoint 恢复） |
| **P1 首个真实通道** | ✅ **飞书**（长连接、配对码、mention 触发、卡片流式、分片；typing 飞书不支持 → 占位卡片代替）、出站队列落盘重放、通道档 LLM 复核验证器 | ✅ `bun run verify:channel-feishu`（mock transport 跑完整链路：未配对被挡 → 批准后 agent 造文件 → 群聊未 @ 不响应、@ 则响应）；真实机器人端到端仍待手动跑 |
| **P2 富输出 + 审批** | renderer 全矩阵、chart/svg/mermaid/puml→PNG、**通道投影**（桌面端同管线逐块截图）、审批卡片 + 超时拒绝、outbox 落盘重放、审计、限流与预算 | 单测覆盖降级矩阵每一行；`verify:channel-diagrams`：mermaid/puml 在真 Chromium 里出 PNG 并经适配器投递，正文不再出现降级说明；`verify:channel-projection`：正文+```ts+表格+```mermaid 混合回答 → 三张真 PNG 按序投递、正文只剩原生文本（含 `这是结论。`）、无源码泄漏与空文本卡片；`verify:channel-approval`：PLAN binding 下写操作被拒 → 升级 binding 后弹审批 → 超时 → 确认被拒绝且提示可见 |
| **P3 第二通道 + 控制平面** | 飞书（长连接 + 卡片流式）、WS 控制平面、GUI 只读看通道会话、`pure attach` | 飞书端到端；GUI 里能看到通道会话的 transcript 投影（不污染模型上下文） |
| **P4 可选** | 企微、个人微信插件（默认关）、cron 入站源、per-topic 多 agent | 按需 |

依赖新增：**P0–P1 零新增依赖**（fetch / Bun 内置 WebSocket）。P2 的 SVG→PNG 光栅化选了
`@resvg/resvg-js`（无原生工具链、能直接吃 SVG 字符串）；mermaid/puml 则**没有**再引入
puppeteer/playwright —— 复用仓库既有的「系统 Chrome + `--headless=new` + 裸 CDP」模式
（`src/channels/rasterize/headlessChrome.ts`），用 `Bun.build` 在运行时把引擎打成浏览器
bundle 注入页面。代价是运行 gateway 的机器上要有 Chrome；没有就诚实降级为文本。

---

## 12. 评审：反方论证与风险（评估者视角）

| # | 质疑 | 回应 / 处置 |
|:---|:---|:---|
| R1 | 为什么不直接在 GUI 里做，省一个进程？ | GUI 生命周期 = 窗口生命周期；无头服务器部署不了；agent 在 WebView，通道要绕 IPC。见 D1 |
| R2 | 每条消息开一个 `pure` 进程不是更省事、更隔离吗？ | 没有会话连续性（`continueTurn` 才有上下文），每轮重付冷启动与 MCP 连接，无法流式回。**明确否决** |
| R3 | 通道为什么不能是 MCP server？ | MCP 的调用方向是 client（模型）→ server（工具），是 pull；通道需要外部 push 入站事件。用 MCP 做通道只能靠轮询，且每次都要模型主动发起，语义完全不符 |
| R4 | 多 workspace 会怎样？ | `NodeToolAdapter` 构造绑定 workspace，切换 = 新建 Harness（MCP 重连、技能重扫）。→ workspace 级装配池 + 上限，避免一个 gateway 挂 10 个项目把进程拖死 |
| R5 | 渠道闲聊会不会污染项目记忆？ | **真实风险**。CLI 现在 `evolutionEnabled` 默认开，闲聊也会沉淀教训。处置：通道会话默认 `evolutionEnabled: false`（只记 session 级，不写 `error_pattern`/`user_preference`），需要沉淀的会话由 binding 显式开启 |
| R6 | 有人在群里 @bot 做 prompt injection？ | 未配对不进 agent；入站文本永不进 system 段；toolProfile 限权；`raw` 不进上下文。见 §6.4 |
| R7 | 成本失控/被陌生人烧 token？ | 配对 + 速率限制 + 每日预算 + 未配对不进 agent。见 §6.5 |
| R8 | 一个 gateway 挂了，所有端全哑。 | 这是**有意选择**（单点、可观测、状态一致）。通道适配器各自重连；gateway 用 launchd/systemd 自动重启；会话状态在磁盘，重启不丢 |
| R9 | 「最优」是不是该上多 agent 并行处理不同通道？ | 不需要。天然并行单位是**会话**（每会话一个 Harness，各自跑 Engine）。同一会话内并行已有 `SubagentOrchestrator`。再加一层进程级编排只增加状态一致性成本 |
| R10 | 个人微信不做，用户会失望。 | 诚实优先：无官方 API，破解方案有封号与协议风险。给合规替代（企微/飞书）并把个人微信做成默认关闭的插件，风险和收益摆在明面上 |
| R11 | 用户忘了已经开着一个 gateway，又启了第二个。 | **正确性问题，不是优化**：飞书集群模式只有一个客户端收到消息、企微新连接会踢掉旧连接 → 消息会静默丢失且极难排查。启动时抢占 `~/.pure/channels/gateway.lock`，第二个实例直接报错退出（§8 专项文档 5.1） |
| R12 | 三个国内通道是不是各写一套？ | 不是。共用同一份 `ChannelAdapter` 接口 + renderer 数据表，差异只落在适配器文件与能力声明里；第二个通道的边际成本 ≈ 一个适配器 + 一份凭证配置 |
| R13 | 为了几张 mermaid/puml 图，值得在用户机器上起浏览器吗？ | 不值得**下载**一个浏览器：不引 puppeteer/playwright，用系统已有的 Chrome + 仓库既有的裸 CDP 模式，懒启动、空闲 5 分钟关闭。没有 Chrome 就不提供这两个渲染器，富输出照旧降级为文本 —— 能力是可选的，不是必需前提 |
| R14 | 通道投影复用桌面渲染管线，GUI 改样式会不会悄悄改变通道出图？ | 这是**有意收益**（两端表现一致、改一处同步），但也意味着桌面端改 `markdown.ts`/`styles.css` 的 DOM 层级或尺寸假设（聊天列宽 1024px）时，需跑 `verify:channel-projection` 回归；投影页显式钉住 `#chat` 宽度，不依赖 app 布局，样式微调不影响。失败路径与更多反方论证见 [`docs/channel-projection-design.md`](channel-projection-design.md) P1–P5 |

**未决 / 需要拍板**（不阻塞 P0–P1）：

1. 部署目标：只在本机常开，还是要能跑在 VPS 上？（影响密钥存储方案：keyring vs 文件）
2. 首个真实通道选 Telegram（最快）还是飞书（体验最好）？
3. 是否需要 Phase 3 的 WS 控制平面，还是「每渠道各自成端」已经够用？
4. 个人微信是否进入范围（默认建议：不进）。

---

## 13. 一句话总结

通道能力 = **新增一个常驻宿主 `pure gateway` + Adapter Layer 的第 6 类适配器（ChannelAdapter，能力声明驱动）
+ 一层会话路由（(workspace, per-channel-peer) → Harness）**，其余全部复用 pure 已有的控制平面；
安全性靠「默认只读 + 配对 + 审批超时拒绝」三层挡在工具层，而不是靠提示词；富输出靠一张能力降级矩阵统一处理；
通道内看到的富内容与桌面端 GUI 同像素——同一份渲染管线在 headless Chrome 里逐块截图（通道投影，见
[`docs/channel-projection-design.md`](channel-projection-design.md)），渲染不了就诚实地降级。

国内落地（飞书 / 企业微信 / 钉钉）的全部平台细节与由此产生的设计修订，见
[`docs/cn-im-channels.md`](cn-im-channels.md)：三家都支持无需公网的 WebSocket 长连接，
但都带来「单连接、首响 3–5 秒、全量替换式流式、平台频控」四条硬约束。
