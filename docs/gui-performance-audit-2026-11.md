# GUI 性能审计（2026-11）

> **状态（2026-11-13 复核）**：本文件是**历史审计记录**。文中 P0-1（活动 sidecar）、P0-2（检查点闸门改用 `lastPersistedSnapshotBytes`）、P0-3（顶层 `messages` 不再落盘）、P0-4（transcript 只存缩略图）、P1-2（活动轨按 callId 复用 + 先比较再写）、P2-2（常驻 chrome 去掉 `backdrop-filter`）、P2-4（工具卡计时并入共享心跳）在 379494e 上均已实现。**仍然存在的问题、量级与修法见 `app-performance-review-2026-11-13.md`**，不要再按本文的 P0 清单开工。

> 审计范围：GUI 桌面端（WebView2 / WKWebView）的渲染进程与 Rust 侧的会话读写路径。
> 结论：**主要的 GUI 卡顿不是来自 Markdown/渲染层，而是来自「写盘路径对会话大小的 O(N) 放大」**——
> 子 agent 活动每来一次就要把整份会话重新读、重新写；大文件（截图、长工具输出）把会话撑到 11MB 时，这个循环变成 150–300ms/秒的主线程阻塞。
> 证据：`docs/session-persistence-and-transcript.md`（快照结构）、`src/ui/store.ts`、`src/ui/chat.ts`、`src-tauri/src/lib.rs`。

## 0. 测量基线

在本机 `~/.pure/sessions/`（129 个会话，共 60MB）上取样：

| 会话 | 文件大小 | messages | transcript | 备注 |
|---|---:|---:|---:|---|
| `session_1794109757707_1` | **11.36 MB** | 15 | 14 条 | 含 1 张 2.94MB 截图 → 3.92MB base64 |
| `session_1792553838368_2` | 1.12 MB | — | — | 对照组 |

11.36MB 文件的 JSON 成本（本机 Bun/V8，WebView 跑 JSC，绝对值 ±30% 但相对倍数可靠）：

| 操作 | 11.36MB | 1.12MB | 放大倍数 |
|---|---:|---:|---:|
| `JSON.parse` | 15.9 ms | 4.7 ms | 3.4× |
| `JSON.stringify`（整份快照） | 58.3 ms | 3.5 ms | 16.7× |
| `write` + `fsync` | 18.4 ms | — | — |

**11.36MB 会话的快照里，同一份消息数组出现了两次**：顶层 `messages` 3.78MB + `snapshot.modelContext.messages` 3.78MB，逐字节 `identical === true`。截图的 base64 也分别出现在 `modelContext.messages[].images` 与 `transcript[].images`（各 3.92MB）。

## 1. P0：写盘放大（根因）

### P0-1 子 agent 活动持久化 = 全量读-改-写回路

- **位置**：`src/ui/chat.ts:2996-3014`（`scheduleAgentActivityPersistence`）
- **链路**：每次子 agent 事件 → 250ms 尾沿定时器 → `flushSessionSaves()` → `loadSession()`（读盘 + 解析整份文件）→ `saveSession()`（整份 stringify + IPC + Rust `to_string_pretty` + `fsync`）。
- **触发频率**：`onStart / onState / onTool / onDone / onError` 全部调 `updateAgentActivity`（`src/ui/chat.ts:4511-4531`），`onTool` 每个子 agent 的每次工具调用都触发。4 路并发下事件 5–20 Hz，实际落盘约 2–5 次/秒。
- **影响**：11MB 会话每次循环 ≈ 74ms 主线程（15.9 + 58.3）+ 18ms 磁盘 + Rust 序列化，主线程被持续占用 15%–40%，滚动/流式掉帧、风扇转。
- **体验风险**：低。该函数只把 `uiState.agentActivities` 写回磁盘，不改变 UI。
- **修法**：
  1. Rust 增加切片落盘命令（类比 `save_session_workspace` 的 sidecar 思路），只更新 `uiState.agentActivities`，永远不 read-modify-write 整份快照；
  2. 前端 `scheduleAgentActivityPersistence` 改为「只追加脏字段 + ≥1–2s 壁钟节流」，并发事件合并。
  3. 作为过渡方案，把 250ms 尾沿改为至少 1s，并在 `flushSessionSaves` 之前做「 dirty 检查」，无变更直接跳过。

### P0-2 检查点节流的度量对象错了

- **位置**：`src/ui/chat.ts:7360`、`src/ui/store.ts:1565-1572`（`turnCheckpointGateMs`）
- **问题**：`checkpointEstBytes` 累计的是「最新一条消息」的字节，而 invoke 体量是整份快照。有截图的会话（11MB）仍走 3s 快档，每 3s 重写 11MB。
- **修法**：闸门用上一份快照的真实字节数（或本次 `saveSession` 返回的 string 长度）做累计；小会话行为不变（仍 3s），大会话自动降到 12s 甚至 30s。**不缩短强杀保护窗口**：小会话仍 3s，只有大文件会话才降频。

### P0-3 磁盘上双份消息账

- **位置**：`src-tauri/src/lib.rs:15061-15078`（`save_session_impl`）
- **问题**：`SessionData` 同时写 `messages` 与 `snapshot.modelContext.messages`；`messages` 仅用于 `extract_title`（`lib.rs:15094`）与无 `snapshot` 的旧格式回退（`lib.rs:15109-15115`）。
- **收益**：去掉顶层 `messages`（或只存 title）立即 **−33%** 文件大小 / IPC 字节数 / 磁盘 fsync / 加载解析。
- **修法**：`save_session_impl` 不再把 `snapshot` 里的消息再塞进顶层 `messages`；`extract_title` 直接从 `snapshot.modelContext.messages` 取；`message_count` 从 snapshot 取。保留字段的 `#[serde(default)]` 兼容旧档。

### P0-4 图片以 base64 存两处

- **位置**：`src/ui/pasteChip.ts`（`attachmentToMessageImage` 产出 dataUrl）、会话快照的 `modelContext.images` + `transcript.images`
- **问题**：一张 2.94MB 截图 → 3.92MB base64，两处合计 7.8MB 写盘/写 IPC；且截图已有 `path`（`/private/tmp/pure-shot-1-small.png`），base64 是冗余副本。
- **修法**：图片落盘到 `~/.pure/attachments/<sessionId>/`（或会话目录），消息里只留 `path` + 一个 ≤64KB 的缩略图 dataUrl 供回放；模型上下文里同样只留 path（模型本来也只读 path）。回放/重发时按 path 读取，失败时降级为缩略图。**注意**：`/private/tmp` 会被系统清理，必须复制到稳定目录。

## 2. P1：主线程与渲染（次因）

### P1-1 每次 save 从零重建快照

- **位置**：`src/ui/chat.ts:8915-9019`（`doPersistSession`）→ `createSessionSnapshot` + `limitSessionSnapshot`
- **问题**：O(全部消息) 的主线程工作，与 P0-1/P0-2 相乘。
- **修法**：把快照构建改为「追加本回合新增 transcript 条目 + 只重算尾部」；或把 `createSessionSnapshot` 移到 Web Worker（`structuredClone` 后 postMessage，避免主线程）。

### P1-2 活动轨每次事件整表重建

- **位置**：`src/ui/agentActivityPanel.ts:157`（`list.replaceChildren()` + 逐卡 new DOM）、`src/ui/chat.ts:2979`（每事件调用 + `agentWorkbench().sync`）
- **问题**：4 路并发时每秒数十次整表重建。
- **修法**：按 `callId` 复用已有行，只 patch 变化的文本/状态/时间；`sync` 保持外科手术式 patch（已有 comment 要求）。

### P1-3 加载与恢复路径

- **位置**：`src/ui/store.ts:635`（`normalizeSessionSnapshot`，同步）、`src/ui/main.ts:1415-1580`
- **问题**：11MB JSON 在 WebView 同步解析 + 归一化 + 全量事件流渲染。渲染侧已做分块 yield 与历史组懒加载，但解析+归一化仍是同步的。
- **修法**：随 P0-3/P0-4 缩小文件；`loadSession` 只需返回 `snapshot`（顶层 `messages` 不再传）；归一化拆成可中断的微任务。

## 3. P2：偶发与未验证项

| # | 项目 | 位置 | 说明 |
|---|---|---|---|
| P2-1 | 无上限的 Markdown/hljs 渲染 | `src/ui/markdown.ts`（无长度闸门；流式只有 32k 尾窗 `STREAM_TAIL_LIMIT`） | 单条 40k 助手消息整段 marked+hljs，偶发一帧卡顿。修：超过阈值降级为纯文本/代码块懒高亮（IntersectionObserver）。 |
| P2-2 | 25 处 `backdrop-filter` + 423KB CSS | `src/ui/styles.css` | 合成层成本，滚动/窗口缩放时 GPU 压力。**未实测，需 WebView profiling 确认。** |
| P2-3 | 同步读大文件 | `src-tauri/src/lib.rs:10819`（`read_observations` 默认 16MB） | 仅在打开观测面板时触发，`secret_*` 同步 JSON 读写同理。 |
| P2-4 | 每个运行中工具卡/思考卡各一个 1s 定时器 | `src/ui/toolRow.ts:892`、`src/ui/thinkingCard.ts:204`、`src/ui/plan.ts`、`src/ui/agentWorkbench.ts:215` | 文本更新便宜，但多卡时是 N 个 timer + N 次布局。可合并为单个 1s 心跳。 |
| P2-5 | llmWarm / proxyProbe 每 30s 网络 GET | `src/ui/llmWarm.ts:84`、`src/ui/proxyProbe.ts:61` | 意图是降低 TTFT；后台 Tab 时也持续跑。修：`document.visibilityState` 隐藏时降频。 |

## 4. 体验不变的约束（所有修复必须遵守）

1. **不改 UI**：所有改动都在写盘 / IPC / 主线程工作量层，用户看到的界面、交互、流式体验不变。
2. **不缩短强杀保护**：小会话仍 3s 检查点；只有大文件会话才降频到 12s/30s。
3. **不丢数据**：P0-4 的图片必须复制到稳定目录再删 dataUrl，避免 `/private/tmp` 被系统清理导致图片丢失；P0-3 必须保留 `#[serde(default)]` 兼容旧档。
4. **不改数据语义**：`modelContext.messages` 仍是唯一的 LLM 输入；`transcript`/`uiState` 不得回填模型上下文。
5. **Rust 侧改动必须带单测**（已有 295 个 lib 测试），并跑 `cargo test --lib`。

## 5. 建议的验证方式

1. **埋点**：在 `saveSession` / `doPersistSession` 入口记录 `snapshotBytes` 与耗时（`performance.now()`），写入 `console.debug`，生产构建可关。
2. **压测**：用这条 11MB 会话做基线，跑 4 路并发子 agent 任务，观察 Chrome Performance 面板的 Main 线程长任务与帧率。
3. **回归**：`bun run typecheck`、`bun test`、`cargo test --lib` 必须全绿；新增 `readFileHead.test.ts` / `fileText.test.ts` 同等粒度的用例覆盖切片落盘与图片落盘。
4. **真机**：在 WKWebView（macOS）与 WebView2（Windows）各打开一次 11MB 会话并滚动到底，确认无掉帧；Dock/任务栏 CPU 不应持续 >30%。

## 6. 未测项（本审计的 honest limits）

- 耗时用 Bun/V8 测，WebView 跑的是 JSC/WebView2；绝对值 ±30%，相对倍数可靠。
- **没有启动 GUI 做真机帧率 / 主线程 Busy 采样**，也没有 profile GPU 合成层——P2-2 明确标为「未实测」。
- P0-1 的 2–5 次/秒是按「事件间隙 ≥250ms 且保存链延迟」推的区间，不是抓到的实测调用次数。
- 本审计未修改任何代码，因此没有可 rerun 的 typecheck/test；所有证据来自只读检查与真实会话文件的解析。