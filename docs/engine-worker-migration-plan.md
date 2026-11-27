# 引擎 Worker 化落地计划（P0–P4）

> 状态：施工计划 v1（2026-11-27）。上游设计：[`engine-worker-migration.md`](engine-worker-migration.md)（v2 复核稿）。
> 纪律：**先持久化外置，再搬引擎**；每刀独立可验证、可回退；同一会话不允许中途换宿主。
> 关联：[`decision-boundary-2026-11.md`](decision-boundary-2026-11.md)（四分归属）、
> [`remote-office-bridge-design.md`](remote-office-bridge-design.md)（S1 已落 / S3 未开工）。

## 0. 本次已落地（2026-11-27）

| 项 | 结果 | 证据 |
|---|---|---|
| 静态依赖闸门 | 新增 `scripts/check-worker-env.ts` + `bun run check:worker`；从 `Harness`/`CodingAgent` 递归走 import，静态 `node:*`/`@tauri-apps/*` 即失败 | 见 §1 实测 |
| 引擎图体检 | **108 个模块、0 条静态阻断**；惰性依赖 10 条（都有浏览器守卫）；运行时触碰 4 处 | `bun run check:worker --audit` |
| wasm 基准 URI | `resolveWasmAsset(name, baseUri)` 可注入；Worker 不再依赖 `document.baseURI` | `src/adapter/memory/wasmRuntime.ts` + `__tests__/wasmRuntime.test.ts` |
| 打包参考 | Bun browser target：Harness 129 模块 / 0.31MB，CodingAgent 166 / 0.64MB。**注意**：Bun 会给 `node:crypto` 塞 shim（实测打包成功），所以它只能当参考，不能当闸门 | P0 探针 |
| **P1-a 恢复接日志尾** | `mergeSessionLogTail` + 两条恢复入口（`loadSession` / `loadLastSession`）；有界尾读 1MB + 超时兑底；只补模型上下文，不动 transcript | `src/ui/store.ts` + `store.test.ts`（6 例） |
| **P2-a 驱动面抽壳** | `EngineHost` 接口 + `MainThreadEngineHost`；chat.ts 的 6 个驱动调用点全部改走宿主，工具/审批/交付核验仍直连 | `src/ui/engineHost.ts` + `engineHost.test.ts`（5 例） |
| **P0-3 双平台探针** | macOS 四种 worker 加载全通；1MB 克隆 1.1–2.4ms、408KB checkpoint 0.75–1.25ms；最小化后 timer 未被节流。Windows 列待真机 | `bun run probe:worker -- --run` / `--summarize` |

### 1. 体检结论（决定后续刀序）

- **静态图已经是 worker-clean**：没有需要「先清 `node:*`」的大工程，P1 的成本在接线与状态所有权。
- **运行时触碰只有 4 处**，不是设计稿里估的「2 处 DOM」：
  | 文件 | 触碰 | 归属 |
  |---|---|---|
  | `src/harness/Harness.ts` | `window.dispatchEvent`（诊断台账，错误路径） | 改为注入 `reportDiagnostic` |
  | `src/shared/i18n.ts` | `document.querySelectorAll`（只被 UI 调用） | 留主线程，Worker 只用 `t()` 取串 |
  | `src/shared/netRoute.ts` | `localStorage` | 主线程（传输半边记账） |
  | `src/shared/netGuard.ts` | `localStorage` | 主线程（网络守卫） |
- **惰性依赖 10 条**：`conventions` / `userHooks` 的 node 加载器、`trace` 的 fs、`fileText` 的 zlib、MCP `StdioTransport`、`shared/tauri` 的 Tauri API——全部是「执行到才失败」且已有守卫；迁移时逐项确认，不预改。

## 2. 刀序总表

| 刀 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **P0-1** | 静态依赖闸门 + 引擎图体检 | — | ✅ 本次 |
| **P0-2** | wasm 基准 URI 可注入（记忆进 Worker 的前置） | — | ✅ 本次 |
| **P0-3** | 两端真机探针：worker 加载 / 往返 / 克隆 / 后台定时器 | 真机 | ✅ 2026-11-27（macOS；Windows 待真机） |
| **P0-4** | 任务 B 取证：`save_session` 是丢写还是丢回执 | 真机 | ✅ 2026-11-27（macOS 判定丢写） |
| **P0-5** | 记忆后端决策（IndexedDB / Rust 文件） | P0-3 | ✅ 2026-11-27（单写者服务 + Worker 镜像） |
| **P1-a** | 恢复路径接日志尾（模型上下文） | — | ✅ 2026-11-27 |
| **P1-b** | 检查点级增量（`turn_messages` + `transcript_delta`） | P1-a | 待做 |
| **P1-c** | Rust `chat_stream` journal（只做文本打捞） | P0-4 | ✅ 2026-11-27 |
| **P1-d** | fold 水位收口（恢复后不重复、不回退） | P1-a | 待做 |
| **P2-a** | `EngineHost` 接口 + 主线程实现（零行为切换） | — | ✅ 2026-11-27 |
| **P2-b** | 协议与纯类型（`sessionProtocol.ts`） | P2-a | 待做 |
| **P2-c** | Worker 入口 + client + 允许清单桥 | P0-3, P2-b | 待做 |
| **P2-d** | 开关 / 租约 / epoch / 崩溃恢复 | P2-c | 待做 |
| **P3-a** | 工具执行桥（审批留主线程） | P2-d | 待做 |
| **P3-b** | LLM ProxyAdapter（协议半边进 Worker） | P2-d | 待做 |
| **P3-c** | 诊断/日志桥 + 大载荷策略 | P3-a | 待做 |
| **P4** | 全量切换、删除主线程引擎路径 | P3-* | 待做 |

## 3. P0：取证（真机部分是唯一门槛）

### P0-3 两端探针（win / mac，各 30 分钟）

在 GUI 里加一个**临时**探针页/按钮（不进产品路径），依次记录：

1. `new Worker(new URL(...), { type: 'module' })` 与 classic worker 各能否加载（WKWebView 的 custom scheme 是关键未知数）。
2. `postMessage` 往返 1000 次的单条成本；带 1MB 字符串与带 `EngineEvent` 对象的成本差。
3. `TurnCheckpoint` 形态的结构化克隆：用一条真实长会话的 messages 数组，量字节与耗时（Windows 与 mac 各一次）。
4. 后台窗口（最小化/遮挡）下 `setTimeout(1000)` 的实际间隔：验证 App Nap / Windows timer 合并的影响面。

结果回填 `engine-worker-migration.md` §3.8 矩阵；**任一平台两种 worker 都加载失败 → P2 直接停，只做 P1**。

**落地记录（2026-11-27）**

- 新增 `src/ui/workerProbe.ts` + `workerProbe.worker.ts`（GUI 内测量）与
  `scripts/worker-probe.ts`（`bun run probe:worker`）。`--run` 用独立
  `productName`/`identifier` 拉起 dev GUI——用户常开着已安装的 pure.app，单实例锁会把
  dev 实例转交给它后直接退出（实测无新 boot 行）；探针实例必须换身份，否则只能杀用户窗口。
  跑完按进程组收尸，`--keep` 可留窗口；`--summarize`/`--json` 离线读日志。
- 触发用 `tauri dev --config` 覆盖 `devUrl` 加 `?worker_probe=1`（环境变量没有穿透
  beforeDevCommand，实测 Vite 内联了变量但 GUI 没收到）。`VITE_WORKER_PROBE=1` 仍保留
  为 dev 构建的备用入口；release 无 query/无常量，不会跑。
- macOS 数字见设计稿 §3.8：asset classic/module 与 blob classic/module 全通；
  1MB 克隆 1.1–2.4ms，408KB checkpoint 0.75–1.25ms；后台最小化 timer p50=0ms。
- Windows：脚本已就绪，**未实测**；同一命令在 Windows 跑一次即可回填。停止条件
  「两端都加载失败」目前只在 macOS 判为不触发，Windows 待真机后才能定论。
- 附带发现：WKWebView 单次 `performance.now()` 被钳到 1ms，报告改用整段平均；
  真实长会话的 checkpoint 未测（探针在 2.5s 启动窗内拿不到 sessionId，用合成 200 条）。

### P0-4 任务 B 取证

冻结注入（主线程长任务循环）期间，每 5s 采样：

- `~/.pure/sessions/<id>/snapshot.json` 的 mtime 与 size；
- `events.jsonl` 尾行 `ts`；
- `gui_perf.log` / 错误台账里的 `save_session LINK TIMEOUT` 行。

判读：文件在长、回执超时 = **只丢回执**（问题降级为状态陈旧）；文件也停 = **丢写**（P1-c 升级为必做）。

**落地记录（2026-11-27）**

- 新增 `src/ui/saveProbe.ts` + `scripts/save-session-probe.ts`（`bun run probe:save`）：
  构造 ~3.2MB 快照，派发 `save_session` 后**立刻忙等冻结主线程**，CLI 以 100ms 采样
  `~/.pure/sessions/<id>/session.json` 的 size/mtime。独立 productName/identifier 拉起，
  避开已安装 app 的单实例锁。
- macOS 实测（freeze=8s）：冻结窗口相对 start 行 +2ms → +8001ms；文件**首次出现在
  +8385ms**，即解冻后才到达 Rust。判定为**丢写**（写请求本身被主线程队列卡住），
  不是只丢回执。P1-c 因此升级为必做。
- 边界：这是一次直接 `save_session` 的取证，不是整回合工具链；但「主线程冻结会卡住
  IPC 投递」与任务 B 的 `LINK TIMEOUT` 形态一致，足够决定 P1-c 的优先级。

### P0-5 记忆后端决策

`LocalStorageMemoryStore` 在 Worker 里不可用。二选一：

- **IndexedDB**：改动最小（同源共享，主线程设置面板仍可读）；需要一次 localStorage → IndexedDB 的迁移与回滚开关。
- **Rust 文件**（与 CLI `FSMemoryStore` 对齐）：跨端一致、无浏览器配额；需要新命令与 schema。

决策输入：P0-3 的模型加载耗时 + 现有记忆条目体量。倾向 IndexedDB（先解阻断），Rust 化留给 S3。

**决策（2026-11-27）：主线程记忆服务 + Worker 只读镜像**

- `IMemoryStore.list` 是**同步**接口；IndexedDB 与 Rust 文件两条路线在 Worker 内都
  必须先在内存里放一份镜像才能满足同步 `list`。既然镜像不可避免，保留主线程单一
  写者（现状 localStorage / FS）比迁移存储更稳：不产生双写、不需要回滚开关。
- 形态：Worker attach 时注入记忆快照（只读）；`add/recordHits/forget` 走白名单桥
  回主线程，主线程仍是唯一权威。实现随 P2-c/P3-a 落地。
- 代价：记忆检索的向量计算如果搬进 Worker，仍需 wasm 资源（P0-2 已解 baseUri）；
  但存储 I/O 不经 Worker，省掉 IndexedDB 配额与迁移风险。

## 4. P1：持久化外置（独立于 Worker，先做）

### P1-a 恢复路径接日志尾

- 位置：`src/ui/store.ts` 的 `loadSession`；恢复入口两处：`chat.ts:3788`（冷恢复 `loadLastSession`）与 `main.ts:598`（变体重放）。
- 改动：`loadSession` 读 `read_session_events`（有界尾读，起点 1MB），用
  `mergeFoldWithLog(snapshot.modelContext.messages, snapshot.foldedThrough, events)` 合并；
  失败/超限退回快照并记一笔台账。
- **诚实降级**：`turn_messages` 只有引擎消息，没有 transcript 的卡片元数据。合并后 UI 若
  缺尾部转录，要显示「上次中断的回合已恢复到模型上下文」标记，不假装完整。
- 验收：构造「快照写入后追加一条 turn_messages」的会话，`loadSession` 返回含该条；
  旧会话（无 `foldedThrough`）逐字节不变。
- 回退：读取失败一律走旧路径。

**落地记录（2026-11-27）**

- 实现：`store.ts` 的 `mergeSessionLogTail(snapshot, readTail)` 纯接口（读取器注入，测试不碰 Tauri）
  + `SESSION_LOG_TAIL_MAX_BYTES = 1MB`（4MB 会白白多付 ~30ms 主线程解析，而检查点
  已每 3–12s 一拍，尾部通常只有几秒输出）；`mergeLogTailFromDisk` 用 `withTauriTimeout` 包
  `read_session_events`，一次熔断记录后静默退化。只改 `modelContext.messages`，
  `transcript` 引用不变——尾部没有卡片元数据，不造 UI。
- 接线：`loadSession` 与 `loadLastSession` 两条入口都接；非 Tauri 模式不读日志，
  旧会话（无 `foldedThrough`）不读日志且原对象返回。
- 不变量：快照的 `foldedThrough` 必须 ≥ 所有已折入其 messages 的 `turn_messages` ts。
  今天成立（只在回合落定时追加）；**P1-b 引入检查点级事件后，必须同步抬高水位**（P1-d），
  否则恢复时会把已在快照里的检查点消息重复追加。
- 测试：`store.test.ts` 6 例（旧会话不读日志、只追加水位之后、水位相等不重复、
  坏行跳过、读失败退化、两条入口接线锁）+ `sessionEventLog`/重放保真合计 91 例绿。

### P1-b 检查点级增量

- 位置：`src/ui/chat.ts` 的 `TurnCheckpoint` 消费臂（约 4946 起的切片逻辑）与回合落定提交点（约 3633）。
- 改动：检查点处按「上次已追加的消息下标」切出增量，追加 `turn_messages`（现有 kind）；
  同时追加新的 `transcript_delta`（新增 kind，携带本回合新增的 transcript 草稿）。
  两个事件同一 `ts`，读取侧按 `ts` 合并。
- 约束：单事件有界（沿用 `capEventText` 思路）；图片只留 path/缩略图，不写 base64。
- 验收：强杀进程后重开，最后一条检查点之前的助手文本与工具行都在；`events.jsonl`
  单行不超过设定上限。
- 回退：事件 kind 未知时读取侧忽略（现有 `parseSessionEvents` 已前向兼容）。

### P1-c Rust `chat_stream` journal（可选）

只有 P0-4 判定「丢写」才做。形态：`chat_stream` 增加可选 `journalSessionId`，每批 delta
追加到 `turn.journal.jsonl`；**只用于崩溃打捞**，不参与正常恢复（正常恢复读 `turn_messages`）。
不做工具结果 journal——工具结果已经在 Rust 侧执行，重放会重复副作用。

**落地记录（2026-11-27）**

- `ChatStreamArgs` 新增 `journalSessionId`；`chat_stream` 在 Rust 侧把 content / thinking /
  reasoning delta 追加到 `~/.pure/sessions/<id>/turn.journal.jsonl`。8MB 上限，超限才截断；
  平时**追加不截断**，因为一个回合会有多个工具轮、每次 `chat_stream` 都要保留（行内 `stream`
  记 requestId，打捞时按它分组取最后一段）。
- GUI 主回合适配器传当前 `sendSessionId`；judge / plan / phase 与设置页预览不写，避免内部
  提示混进打捞文本。
- 单测：Rust `turn_journal_tests` 锁「空 delta 不写行 / stream 分组 / 追加语义」；TS 适配器
  补「传了 journalSessionId 才带、没传不能凭空出现」。
- 边界：journal 只打捞**文本**，不含工具结果（重放会有副作用）；正常退出后文件保留在
  上限内，下一次回合继续追加。

### P1-d fold 水位收口

恢复后第一次 `saveSession` 必须把新快照的 `foldedThrough` 设为「已合并的最后一条
`turn_messages` 的 ts」，并验证：连续两次恢复→保存不产生重复消息。

## 5. P2：Worker 骨架

### P2-a `EngineHost` 接口（先零行为切换）

- 新文件：`src/ui/engineHost.ts`。
- 接口只覆盖**引擎驱动面**：`run` / `continueTurn` / `abort` / `executeSubagent` /
  `getContextEngine` / `syncToolCatalog`。**工具注册、可见性、MCP 发现、命令守卫、
  交付核验留在主线程**——它们今天就在主线程用 `codingAgent.toolRegistry`，不搬。
- 先实现 `MainThreadEngineHost`（内部就是现有 `CodingAgent`），把 `chat.ts` 的
  `run`/`continueTurn`（`:7577/:7578`）、`subagentOrchestrator.execute`（`:8899`）、
  `getHarness().getContextEngine()`（`:6431`）换成 `engineHost.*`。
- 验收：全量测试与改前一致；`chat.ts` 源码结构锁若断言了调用点，同步更新。
- 回退：这一刀行为零变化，可直接 revert。

**落地记录（2026-11-27）**

- 新文件 `src/ui/engineHost.ts`：接口只有四个驱动方法（`run` / `continueTurn` /
  `executeSubagent` / `getContextEngine`），`MainThreadEngineHost` 只做原样转发——
  返回同一个 `AsyncGenerator`/`Promise`，不改参数顺序（测试钉了身份）。
- chat.ts 实际换了 **6 个调用点**（不是 4）：主回合 `continueTurn`/`run`、修复轮
  `continueTurn`、收尾轮 `continueTurn`、课后建议的 `executeSubagent`、预压缩的
  `getContextEngine`。工具注册、可见性门、MCP、命令守卫、交付核验全保持直连。
- 测试：`engineHost.test.ts` 5 例（四方法零行为 + 接线锁）；`chat.test.ts` 与
  `sessionReplayFidelity.test.ts` 195 例全绿（后者把断言从 `codingAgent.continueTurn`
  改为 `engineHost.continueTurn`，参数形状不变）。
- 下一步：P2-b 协议纯类型；P2-c 才引入 `WorkerEngineHost`，消费侧零改动。

### P2-b 协议与纯类型

- 新文件：`src/shared/sessionProtocol.ts`：`attach` / `project{seq,ops}` / `preview` /
  `state` / `need` / `persist` / `diag` / `ack` / `resync`。
- 只放类型与纯函数（`coalescePreview`、`applyOps`），dom 与 Tauri 依赖为零；单测覆盖
  seq 缺口、ops 幂等、preview 背压丢弃。

### P2-c Worker 入口 + client

- 新文件：`src/ui/sessionWorker.ts`（入口）、`src/ui/workerEngineHost.ts`（主线程侧）。
- Worker 内：`CodingAgent` + `ProxyLLMAdapter` + `ProxyToolAdapter` + 本地 `ToolRegistry`
  （只持有 schema，执行回主线程）。
- 桥允许清单：`tool.invoke` / `llm.start` / `llm.abort` / `persist.append` / `diag.log`；
  **不做通用 invoke 透传**。
- 合帧：Worker → 主线程的 `project`/`preview` 按 ≤16ms 或 ≥4KB 合并；`TurnCheckpoint`
  与 `Completed.messages` 不转发（persist 在 Worker 内消费）。
- 构建：`worker.format` 用 classic/IIFE；`bun run check:worker` 的入口清单加入
  `src/ui/sessionWorker.ts`。

### P2-d 开关、租约、恢复

- 开关：配置项 `engine.worker`（默认 false），**按会话创建时读取**；切换需重开会话。
- 租约：`~/.pure/sessions/<id>/engine.lock`（pid + window label + epoch）；第二窗只读。
- 崩溃：`onerror`/`onmessageerror` → 台账 + 按 epoch 从日志恢复一次；连续两次降级主线程并告知。

## 6. P3：两条桥

- **P3-a 工具桥**：`need{callId,tool,args}` → 主线程 `TauriToolAdapter` → `toolResult`；
  审批在主线程，Worker 只等 `approval` 消息。大载荷（全文/大 diff）先测克隆成本，
  超阈值改为「主线程存句柄、Worker 取摘要」。
- **P3-b LLM 桥**：`ProxyLLMAdapter` 承接 `RustLLMAdapter` 的协议半边（解析/累积/撤参重试/
  usage）；主线程承接 Channel、`cancel_chat_stream`、`reset_llm_stream_clients`、
  `onNetOutcome`（netRoute 记账）。
- **P3-c 诊断**：Worker 内 `console` 不作诊断面；`diag` 落 `gui_perf.log`，两端同格式。

## 7. 决策点（开工前要拍）

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D1 | Worker 格式 | module / classic-IIFE | 默认 classic；module 作为探针通过后的优化 |
| D2 | 记忆后端 | IndexedDB / Rust 文件 | 先 IndexedDB 解阻断，Rust 化随 S3 |
| D3 | journal | 不做 / Rust 侧文本打捞 | 只在 P0-4 判定丢写时做 |
| D4 | 工具目录 | 主线程权威 + Worker 镜像 / 整体搬 Worker | 主线程权威；执行永远在主线程 |
| D5 | 恢复粒度 | 仅模型上下文 / 转录也恢复 | P1-a 先上下文，P1-b 补转录 |

## 8. 每刀的验证命令

```bash
bun run typecheck
bun run check:worker          # 加 --audit 看运行时触碰
bun test <改动相关文件>
bun run lint:conventions      # 改动涉及命名/导出约定时
bun run build                 # 仅 P2/P4 与打包相关
cargo check --lib             # 仅 Rust 侧（P1-c）
```

## 9. 停止条件（写清楚，避免为搬而搬）

1. P0-3 显示两端 worker 都加载不了 → **停 P2**，只交付 P1。
2. P0 实测 M1（JS 自算）在真实卡死里占比很低 → P2 降级为「可选优化」，不排期。
3. 若 S3 daemon 进入排期 → 跳过 P2–P4，直接复用 P1 的事件日志与投影。
4. 任一平台 P2 出现「无法归因的双份状态」且一周内收不口 → 回退开关，保留 P1。

## 10. 不做

- 不为 Worker 造第二套工具注册表语义（目录镜像只传 schema）。
- 不把审批、密钥、配置写进 Worker。
- 不通过桥传全量快照或 `Completed.messages`。
- 不在本计划里顺手做 S3；daemon 是独立里程碑。
