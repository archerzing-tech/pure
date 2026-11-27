# 引擎 WebWorker 化迁移设计（方案 2 · 复核修订稿 v2）

> 状态：v1 立项（2026-11-27，用户拍板）；**v2 复核修订（2026-11-27）**——
> 方向成立，但 v1 有三处结构性错误、六处缺口，按本文施工。P0 未开工。
> commit 锚：待 P0 首提交回填。
> 落地刀序见 [`engine-worker-migration-plan.md`](engine-worker-migration-plan.md)。
> 上游判例：前端单点事故三案（呈现冻结吞 persist、双窗口主线程饱和、mac 僵尸态）。
> 关联：方案 3 = [`remote-office-bridge-design.md`](remote-office-bridge-design.md)
> （S1 已部分落地、S3 daemon 未开工）；[`decision-boundary-2026-11.md`](decision-boundary-2026-11.md)
> 的四分归属在本文中的含义：引擎搬 Worker 改的是「系统手脚」的宿主位置，
> 模型决策与判据体系不动。

## 0. 复核结论（先给裁决）

v1 的**判断是对的**：GUI 是 pure 全家族里唯一「引擎住 UI 进程」的宿主，引擎与渲染
共用一个 JS 事件循环，是结构性风险。但 v1 把「Worker」当成了这个风险的**完整解**，
在三个地方推错了，其余是缺项。逐条：

| # | v1 论断 | 复核裁决 | 证据 |
|---|---|---|---|
| R1 | 「persist 权威移入 Worker：前端冻结不再断数据链」 | **错误（致命）**。Worker 没有 `invoke`，persist 必须经主线程桥；主线程冻结时这条桥照样断。v1 §3.3 与 §2 目标形态自相矛盾 | 见 §3.1、§3.3 |
| R2 | 「每会话一 Worker；多窗口打开同一会话 → 投影订阅同一 Worker（单写多读）」 | **物理不成立**。Worker 属于创建它的 WebView（窗口），跨窗口不共享；SharedWorker 也跨不过两个 WebView | 见 §3.4 |
| R3 | 「双窗卡死 = 主线程=所有窗口 ExecuteScript 的串行瓶颈；Worker 化后主线程只剩转发」 | **机制对了一半，归因错位**。实测机制是 Rust→主线程的 **Channel 注入饱和**（`save_session LINK TIMEOUT` ×4、40 条/秒），Worker 不减少这条通道（v1 风险 5 承认了「不归零」，却仍把该案算作 Worker 的收益来源）。收益来自 JS 计算面，不来自 IPC 面 | `CHANGELOG.md` v4.10.19；`src-tauri/src/lib.rs:14029` |
| R4 | 「呈现冻结吞 persist（任务 B）：UI 冻结 → save_session 断 → 交付物丢失」 | **前提待证**。`LINK TIMEOUT` 只证明**回执没回来**，不证明**写没落盘**（`save_session` 走 `run_blocking`，写与回执不在同一条路上）。P0 必须用文件证据分开这两件事 | `src-tauri/src/lib.rs:17363`；`src/ui/store.ts:1663` |
| R5 | 「审计 engine/harness 的 DOM 触碰点清零（预期极少）」 | **低估**。直接触碰确实只有 2 处，但**传递依赖**里有 `localStorage`（Worker 没有）、`document`、WASM 线程与单例状态。「极少」是 v1 最贵的误判 | `src/harness/Harness.ts:52`、`:1581`；`src/adapter/memory/LocalStorageMemoryStore.ts` |
| R6 | 「P1 双轨：新会话走 Worker，既有会话维持主线程」 | **可做，但必须写成不可迁移的开关**。会话不能中途换宿主；不写明就会重演方案 3 已经裁决过的「双主 + 语义税 + 版本偏斜」 | 见 §4 P2 |
| R7 | 「引擎相关任务从主线程消失（Performance 面板取证）」 | **部分成立，不可作为验收主判据**。消失的是引擎计算；`TurnCheckpoint`/`Completed` 携带整份 messages，naive 转发会让结构化克隆把 O(N) 成本搬回主线程 | `src/shared/types.ts:806` |

**一句话结论**：Worker 是 M1（JS 自算饱和）的解，是 M2（IPC 注入饱和）的部分缓解，
对 M3/M4（原生窗口循环、呈现管线停帧）**无效**；「完全解决」= Worker + 既有传输降频与
自愈 + **持久化权威外置**（不是 Worker）。因此施工顺序也要改：**先外置持久化，再搬引擎**。

## 1. 先把「卡死」拆成四种机制

v1 把三案当成同一种病。它们不是，修法也不同。这张表是本文的地基：

| 机制 | 真机证据形态 | Worker 是否有效 | 真正的解 |
|---|---|---|---|
| **M1 JS 主线程自算饱和** | 长任务扎堆、帧掉但进程健康；Performance 面板主线程满 | **有效**（引擎计算移出） | 本方案 |
| **M2 JS 主线程被 IPC 注入灌满** | `save_session LINK TIMEOUT`、Channel 条数随窗口数线性涨 | **基本无效**：Rust→主线程这一跳不变，还多一次 `postMessage` | 降频/合批（v4.10.19 已落）；终局是换传输（daemon 直连，不经 Tauri Channel） |
| **M3 原生窗口消息泵卡死** | `IsHungAppWindow=True`、指令指针在 `win32u`；JS 也拿不到回执 | **无效**（同进程，同 WebView 生命周期） | 已落的 hotzone 灭活 + PDB/ETW 取证（`windows-undecorated-freeze-2026-11.md`） |
| **M4 呈现管线停帧** | `frame_stall frames=0`，四进程全活全空闲，JS 可跑 | **无效**（画面归渲染管线） | 已落的 frameWatchdog + `webview_frame_nudge`（v4.10.13 / v4.10.18） |

**平台归位（Windows / macOS）**：M3 只在 Windows（`decorations:false` 的 resize 子窗 + 消息泵）；
M4 两端都有——mac 是 occlusion 触发的 WKWebView 呈现挂起（v4.10.13 判例），Windows 是对称的
帧停与 nudge（v4.10.18）；M2 的重灾区是 Windows（WebView2 每条 Channel 消息一次主线程
ExecuteScript，WKWebView 便宜一个量级，但不是零）；M1 两端都有。所以「哪一刀先做」不能
两端共用一套优先级，见 §3.8 与 §6.3。

由此得到三条必须写进设计的边界：

1. **Worker 是同一 WebView 内的第二个事件循环，不是第二个进程。** 它与页面同生命周期；
   页面被挂起/冻结时 Worker 一起停；后台 timer 节流同样作用于 dedicated worker
   （各平台策略不同，P0 真机探针确认）。v1 §2 的「主线程冻结不影响引擎执行」只对 M1 成立。
2. **M2 的账要单列。** Worker 化后主线程每批流式数据的成本 = Channel 回调（不变）
   ＋ `postMessage`（新增）。若引擎在 Worker 内不再逐 token 处理，主线程有可能**变轻**；
   但这来自「Worker 侧合并后再发」，不是「Worker 天然隔离」。所以协议必须规定
   **Worker→主线程按帧合并**（§3.7），否则这是负收益。
3. **「完全解决」的判据不是「不再卡」，是四件事**：会话不因 UI 死而停（M1）、
   数据不因任何 UI 形态丢（持久化外置）、恢复无损（投影重建）、卡了能自愈（M3/M4 已有）。

## 2. 修订后的目标形态

```
┌─ 窗口 A（WebView A）───────────────────────────────┐
│ 主线程：渲染投影 / 输入 / 权限桥 / 传输转发          │
│   ▲ postMessage(增量、按帧合并)   │ invoke/Channel  │
│   │                              ▼                 │
│ Worker A：引擎 + 控制面 + 会话状态机                │
│           （persist 只写增量，不写全量快照）        │
└───────────────────────────────────────────────────┘
        │ append_session_event（单行、增量）
        ▼
Rust：events.jsonl（唯一事实源） + snapshot.json（fold 视图）
```

- **每窗口一个 Worker**，不是每会话全局一个。会话跟着窗口走（2026-11-06 判例）不变；
  同一会话在两窗打开 = **租约**：一窗持引擎（writer），另一窗只读投影（§3.4）。
- **持久化权威不放在 Worker**：Worker 只产生**增量**（单行事件），由 Rust 侧
  `append_session_event` 落 `events.jsonl`；全量 `snapshot.json` 降为 fold 视图。
  这条路径今天就存在（`src/shared/sessionEventLog.ts`、`src-tauri/src/lib.rs:17211`），
  方案 2 应当**复用它**，而不是另造一套 Worker→invoke 的全量快照写。
- **UI 退化为投影**：主线程持有只读投影，靠增量事件维护；重开窗口 = 从日志+快照重建。
  「零丢失」由日志保证，不由 Worker 保证。

## 3. 修订后的关键技术决策

### 3.1 LLM SSE 通道：adapter 拆两半

v1 说「保持 Rust 拉流不变」——对，但没写清 adapter 必须**拆开**：

| 半边 | 位置 | 内容 |
|---|---|---|
| 协议半边 | Worker | SSE 负载解析、tool_call 累积、`paramRejectionHeal` 重试决策、`normalizeTokenUsage`、终态 `done` 组装（`src/adapter/rust/RustLLMAdapter.ts` 的主体） |
| 传输半边 | 主线程 | `new Channel()`、`invoke('chat_stream')`、`invoke('cancel_chat_stream')`、`reset_llm_stream_clients`、netRoute 记账回调 |

因此 Worker 里跑的是 **ProxyLLMAdapter**：`start(requestId, payload)` 发桥消息，主线程建
Channel 并把每批文本 `postMessage` 回 Worker；`abort` 走反向消息。三个容易漏的点：

1. `onNetOutcome` / `onPrimaryFailure`（`RustLLMAdapter.ts` 的 config 回调）今天直接调
   `src/shared/netRoute.ts` 的 `recordNetOutcome`——**那个模块用 localStorage**。
   Worker 里没有，必须由主线程记，或把 netRoute 迁到 config/IndexedDB（§3.6）。
2. 取消语义：`signal.abort()` 在 Worker 内只是本地标志，真正的 `cancel_chat_stream`
   在主线程。要保证「Stop 后不再有迟到 delta 进引擎」——Worker 侧按 requestId 丢弃。
3. 合批口径不变：Rust 50ms/16KB（单窗）或按活跃流缩放（`ACTIVE_DELTA_STREAMS`，
   `src-tauri/src/lib.rs:14029`）。Worker 侧再按 **一帧一次**（≤16ms 或 ≥4KB）向上合并，
   避免把一个 50ms 批拆成几十条 `postMessage`。

### 3.2 工具执行桥：允许清单是安全边界

- Worker 消息只允许：`tool.invoke`（工具名 + 参数）、`persist.append`、`llm.start/abort`、
  `diag.log`。**不允许**通用 `invoke(cmd, args)` 透传——那会把 Worker 变成一个能调任意
  `#[tauri::command]` 的通道，绕过今天只在主线程成立的权限面。
- 审批（permission mode）留在主线程桥上，与 v1 一致；但审批 UI 是 DOM，Worker 只等裁决。
- `TauriToolAdapter` 的流式输出（`execute_command` 的 `Channel`）留在主线程：它本来就要
  喂工具卡。**结果体**再 `postMessage` 回 Worker；大载荷（读文件全文、大 diff）会走
  结构化克隆，P0 要测这条的字节与耗时，别默认它免费。
- `write_file_stream` 的进度 Channel 同理：进度只到 UI，Worker 只收终态。

### 3.3 持久化：三档，Worker 只在第一档

v1 §3.3 的「persist 移入 Worker」应改为：

| 档 | 内容 | 谁写 | 冻结时 |
|---|---|---|---|
| **A 增量日志** | `user_input` / `turn_messages` / `turn_settled` / `receipt` / `delegation_settled`（单行、有界） | Worker（经桥）或主线程 | 桥断即停，但**每条已发出的单行都小**，损失窗口从「整回合」缩到「最后一拍」 |
| **B 检查点快照** | 全量 `snapshot.json`（`createSessionSnapshot`） | **主线程**（它持有投影与 transcript）或 Rust 侧 fold | 停；但它只是压缩视图，不再承担事实源 |
| **C 传输日志（新增）** | `chat_stream` 每批原文、工具命令的入参与终态 | **Rust**（生产者自己追加） | **不停**——前提是 M3 不成立；M3 下同进程一起停 |

要「UI 全死仍落盘」，只有两个位置：**Rust 侧 journal**（进程内、脱 JS）或 **daemon**
（脱进程）。v1 承诺的「前端冻结不再断数据链」只有在这两处才成立。P1 的落点因此改成
「增量日志 + Rust 侧 journal」，Worker 迁移不再承担持久化承诺。

**先取证再改代码**（P0）：任务 B 要回答的是「`save_session` 是没写，还是写了没回执」。
方法：冻结注入时记录 `snapshot.json` 的 mtime/size 与 `events.jsonl` 尾行时间，和
`LINK TIMEOUT` 行对齐。若写其实落了盘，v1 的事故描述要改，验收判据也要改
（问题就从「数据丢失」降级为「状态陈旧 + 回执假死」）。

补充两条与代码对齐的事实：

- `save_session` 的看门狗是 **60s**（`SESSION_SAVE_LINK_TIMEOUT_MS`，`store.ts:1458`；
  计时在 `:1663`），不是 v1 写的 10s；超时语义是「弃节、链继续」，不是重试。
  写入本身在 Rust blocking 池（`lib.rs:17363`），所以「没回执」与「没写」必须分开取证。
- 快照是串行链 + 单调 revision（`saveSession`，`store.ts:1631`），迟到写无害——这一点
  在 Worker 化后必须保留，否则双写会互相覆盖。

### 3.4 窗口、Worker 生命周期与租约

- **Worker 生命周期 = 窗口会话生命周期**：打开会话起，切换/关闭/空闲超时终止。
- **同一会话两窗**：不做「订阅同一 Worker」（做不到）。做法是 Rust 侧租约文件
  （`~/.pure/sessions/<id>/engine.lock`，带 pid + window label + epoch）：
  持租约者跑引擎，另一窗只订阅日志投影；租约过期（崩溃/强杀）可被接管，
  接管时 epoch +1，旧 Worker 的迟到写按 epoch 丢弃。
- **重启恢复**：Worker 从「快照 + 水位之后的 turn_messages」重建（`mergeFoldWithLog`，
  `src/shared/sessionEventLog.ts:223`），不从主线程的 DOM 状态抄。
- **失败语义**（v1 完全没写）：Worker 崩溃 → 主线程捕获 `onerror`/`onmessageerror`，
  落台账、按 epoch 从日志恢复一次；连续两次崩溃则降级为主线程路径并**明确告知**，
  不静默。`terminate()` 前必须等增量日志链 flush，否则丢最后一拍。

### 3.5 状态所有权地图（v1 最大的缺口）

Worker 一拆，**模块单例就有两份**。今天这些状态住模块作用域，拆分后必须逐个定主：

| 状态 | 今天的位置 | 拆分后归属 | 备注 |
|---|---|---|---|
| 会话消息 / transcript | `chat.ts` 实例 + `store.ts` 模块缓存 | Worker（权威），主线程只读投影 | `lastPersistedSnapshotBytes` / `lastSavedTranscript` 必须跟着走，否则节流闸失灵 |
| 记忆库 | `ui/memoryStore.ts` 单例 → `LocalStorageMemoryStore`（**localStorage**） | 二选一：IndexedDB（同源共享，主线程设置面板可读）或 Rust 文件（与 CLI 对齐） | **Worker 里没有 localStorage，这是硬阻断** |
| netRoute 学习账 | `shared/netRoute.ts`（localStorage） | 主线程（传输半边记账） | Worker 只消费决策结果 |
| provider 自愈处方 | `shared/providerSelfHeal.ts` 模块变量 | Worker（envFacts 在引擎侧消费） | 主线程若也要显示，走增量事件 |
| 参数撤参账 | `shared/paramRejectionHeal.ts` 模块 Map | Worker | 与 adapter 协议半边同居 |
| writeFeedback 全局账 | `shared/writeFeedback.ts` 单例 | Worker | 按路径跨 run 累积，不能复制 |
| 工具隔离/外部工具状态 | `ui/toolQuarantineHost.ts` + Rust | 主线程（UI 面）+ Rust | Worker 只读快照 |
| 计划卡 / 自动续跑 | `ui/plan.ts`、`ui/autoContinue.ts` | 主线程（呈现契约） | 触发信号由 Worker 事件驱动 |
| 配置 / 密钥 | `ui/config.ts` + Rust secrets | 主线程 + Rust | **密钥永不进 Worker**，与今天一致 |

判定规则：**谁产生事实谁持有，另一方只拿投影**；不要「两边都存一份再同步」——
那就是方案 3 已经否掉的 V1/V2。

### 3.6 打包与依赖清理（可执行的 P0 清单）

1. **构建闸门**：新增 worker 入口后，`bun build --target=browser <worker 入口>` 必须绿。
   这条比「跑单测」硬：`node:*`、`document`、`localStorage` 在这里会直接暴露。
   已有先例：`src/shared/sha256.ts` 就是为了 Harness 静态进浏览器包才写的纯 TS 实现。
2. **直接 DOM 触碰 2 处**：`Harness.guardMessagesShape` 的 `window.dispatchEvent`
   （诊断台账，Worker 里静默丢失）与 `currentPlatform()` 的 `navigator.userAgent`
   （Worker 有 `navigator`，可用）。前者改为注入的 `reportDiagnostic`，别靠 `typeof window`。
3. **传递依赖里的 `localStorage`**：`adapter/memory/LocalStorageMemoryStore.ts`、
   `shared/netRoute.ts`、`shared/netGuard.ts`、`shared/providers.ts`、
   `shared/memoryFactory.ts`、`adapter/memory/WASMEmbeddingStore.ts`。逐个定归属
   （§3.5），不是「审计一下」就完。
4. **`node:crypto`**：`shared/userHookApprovals.ts` 仍直接 import；确认它不在 Harness 的
   静态图里（今天 GUI 能构建，说明大概率不在），但 worker 构建闸门会给出确定答案。
5. **记忆检索的 WASM（两端条件不同，别按 Windows 的经验写）**：GUI 走 transformers.js
   动态导入（`adapter/memory/WASMEmbeddingStore.ts:325`），`OrtWebEmbedder` 是 CLI 专用
   （`node:fs`），不进 Worker。两个确定的问题：
   - `wasmRuntime.ts:15` 的 `wasmAsset()` 用 `document.baseURI` 拼 wasm 路径；Worker 里
     没有 `document`，会退化成裸文件名 → 路径解析失败。改为由主线程 `attach` 时传入
     base URI，或 Worker 侧用 `self.location.href`。
   - `crossOriginIsolated` 默认不成立（Tauri 未发 COOP/COEP），`wasmRuntime.ts:24-28`
     已据此把 `numThreads` 压到 1；mac 更硬——WKWebView 不把 `tauri://` 当安全上下文，
     就算补了 COOP/COEP 也不认。所以**两端今天都没有嵌套线程**；将来要开线程是平台
     新命题，不是 Worker 迁移的前置。P0 仍要在两端各测一次模型加载耗时（80MB 首次加载）。
6. **Worker 的加载方式按平台定，别共用 `{ type: 'module' }`**：
   - WebView2 = Chromium，module worker 可用；WKWebView 的 module worker 要 Safari 15
     （macOS 12）以上，而 `tauri.conf.json` 没有声明 `minimumSystemVersion`——默认最低版本
     可能低于它。**默认走 Vite 的 classic/IIFE worker**（`worker.format`），把 module
     worker 作为探针通过后的优化项。
   - WKWebView 对自定义 scheme 下的 worker 加载有历史坑；兜底是 Vite `?worker&inline`
     产出的 blob worker——CSP 的 `csp` 与 `devCsp` 都已允许 `worker-src 'self' blob:`
     （`src-tauri/tauri.conf.json:33/34`），兜底不需要改安全策略。
   - 两端各做一次 30 分钟探针：加载成功、`postMessage` 往返、`terminate` 后重建。

### 3.7 消息协议（v1 只写了「复用 EngineEvent」，不够）

`EngineEvent`（`src/shared/types.ts:806`）确实是现成协议，但它**不是**投影协议：
`TurnCheckpoint.payload.messages` 与 `Completed.payload.messages` 是整份消息数组。
naive 全量转发 = 每个检查点一次 MB 级结构化克隆，正好复刻性能审计里的 O(N) 问题。

协议最小集：

```
main → worker : attach{sessionId, epoch, snapshot?} | userInput | steer | approval
              | toolResult{callId, result} | llmBatch{requestId, text} | abort{requestId}
worker → main : project{seq, ops[]}          // 增量投影：append/patch/replace
              | preview{seq, kind, bytes}    // 工具卡/思考卡的可丢弃预览
              | state{seq, patch}            // 计划卡/统计/预算
              | need{callId, tool, args}     // 工具请求（等结果）
              | persist{kind, line}          // 增量日志（有界）
              | diag{level, text}
```

- **`seq` 单调**：主线程可按 seq 检测缺口并请求 `resync{fromSeq}`；Worker 回全量投影一次。
- **可丢弃 vs 不可丢弃**：`preview` 可丢（背压时合并/丢弃），`project` 不可丢；
  两者分通道，避免「为了不丢预览把主线程拖死」。
- **背压**：主线程 `ack{seq}`；Worker 未 ack 的 `preview` 只保留最后一帧。
- **持久化与投影分开**：`persist` 走 Rust 单行追加，不经过投影通道，投影卡住不影响落盘。

### 3.8 双平台差异矩阵（Windows / macOS）

同一个设计在两端不是同一道题。差异只允许落在三处：**传输 shim（主线程）、
worker 加载方式、记忆后端**；业务层与协议层必须共用一份。

| 维度 | Windows（WebView2 / Chromium） | macOS（WKWebView / WebKit） | 对本设计的影响 |
|---|---|---|---|
| IPC 成本 | 每条 Channel 消息 = 一次主线程 ExecuteScript；>8KB 还走 eval/fetch 回拉。**M2 主因** | `evaluateJavaScript` 便宜一个量级，但不是零 | Worker 桥的合批阈值不能按 mac 的经验设；Windows 必须实测「引擎搬走后主线程是否真的变轻」 |
| 安全上下文 | `http://tauri.localhost` 视为安全上下文，但未发 COOP/COEP → `crossOriginIsolated=false` | `tauri://` **不**视为安全上下文；补 COOP/COEP 也不认 | 两端记忆检索今天都压 `numThreads=1`（`wasmRuntime.ts:24`）；任何依赖 SharedArrayBuffer 的新能力都不能作为 P2 前置 |
| Worker 加载 | module worker 稳定 | module worker 需 Safari 15（macOS 12）+；自定义 scheme 下有历史坑 | 默认 classic/IIFE；`?worker&inline` 的 blob 兜底（CSP 已允许） |
| 挂起 / 节流 | 无 occlusion 补丁（该开关 macOS 专属）；但同样观测到 `frame_stall frames=0`（v4.10.18），用 HWND 抖动 nudge；后台 timer 合并会延迟定时器 | occlusion 触发 render suspension：**画面停、JS 活**；App Nap 会节流后台定时器 | M4 两端都有，Worker 对两端都无效；定时器驱动的机制（autoContinue/watchdog）在后台窗口会迟到，SSE 回调不受影响——P0 用后台窗口跑一回合实测 |
| 进程模型 | 所有窗口共享宿主主线程与 WebView2 浏览器进程 | 每窗独立 WebContent 进程 + 共享宿主主线程 | 双窗争用 Windows 更硬（同一条消息泵）；mac 每窗多一个 Worker 的内存开销更明显 |
| 卡死主场 | **M2 + M3** | **M4 + M1** | 优先级分平台排（见下） |
| 已有自愈 | hotzone 灭活、occlusion 平台闸、帧 nudge | occlusion 补丁指数重试、frameWatchdog、帧 nudge | 这些是 M3/M4 的正解，Worker 不能替代，也不应被 Worker 改动影响 |
| 落盘 | `save_session` / `append_session_event` 均在 Rust blocking 池 | 同一条路径 | P1 的 Rust journal 两端同源，不需要平台分支 |

**P0-3 实测（2026-11-27，macOS 14 / WKWebView）：**

`bun run probe:worker -- --run`，同一台机器跑四类 worker；数字取「整段总耗时 / 轮数」
（WKWebView 单次 `performance.now()` 被钳到 1ms，逐次差值不可用）。

| worker | 加载 | 小消息往返(avg) | 1MB 字符串克隆 | 单条 EngineEvent | TurnCheckpoint（200 条 / 408KB，合成） |
|---|---|---|---|---|---|
| asset-classic | 39ms | 0.12ms | 2.38ms | 0.13ms | 1.25ms |
| asset-module | 99ms | 0.11ms | 1.75ms | 0.13ms | 1.00ms |
| blob-classic | 3ms | 0.13ms | 1.50ms | 0.13ms | 0.87ms |
| blob-module | 5ms | 0.10ms | 1.13ms | 0.25ms | 0.75ms |

- **加载**：四种全通。自定义 scheme 的 asset URL 可用（classic 39ms；module 首次 99ms，
  冷启动含模块解析）；blob 3–5ms 是兜底里最快的。§3.8 里「module worker 历史坑」
  在 macOS 14 未复现，但 Windows 列仍待真机。
- **克隆**：1MB 与 408KB checkpoint 都在 1–3ms 量级，单条 50KB 事件 <0.3ms——
  16ms 合帧阈值有充足余量；这不构成 P2 的瓶颈。
- **后台定时器**：最小化后 `visibilityState=hidden`，`setTimeout(50)` 3 拍漂移
  p50=0ms / max=1ms → 本次 App Nap 没有节流定时器。不能据此推断 Windows
  （WebView2 的 timer 合并是另一套机制），也不能据此认为 M4 已解。
- **Windows**：未实测。`probe:worker` 在 Windows 上跑同一条命令即可回填；在拿到数字前
  矩阵里 Windows 列保持设计推断，不写实测值。

**分平台结论：**

- **Windows**：先做实 M2 的账（双窗 Channel 条数/秒、`save_session` 回执时延、
  主线程 >50ms 长任务占比）。Worker 在这里只买 M1；M2 的大头仍靠合批或换传输。
  P1 的持久化外置在 Windows 上收益最大——因为「写落了、回执丢了」这种假故障最容易
  在这里出现。
- **macOS**：最痛的是 M4（Worker 无效）。P0 要先确认 occlusion 补丁命中率与
  frameWatchdog 覆盖，而不是把希望寄托在引擎搬走。Worker 在 mac 的净收益是
  M1 + 会话连续性，不是「救 freeze」。
- **两端共同**：协议、状态所有权、构建闸门、日志格式共用；平台分支只出现在
  `ProxyLLMAdapter`/工具桥的传输 shim、worker 加载方式、记忆后端三处
  （M3/M4 的自愈本就平台专属，不在此列）。任何一处出现 `if (isWindows)` 的
  业务判断，说明分层错了。

**调试面（两端不同，诊断必须同源）**：WebView2 DevTools 能看到 worker 的独立 context；
WKWebView 要 Safari Web Inspector（仅开发构建），release 设备上拿不到。所以 Worker 内的
`console` 不能作为诊断手段——`diag` 事件经桥落 `gui_perf.log` / 错误台账，两端同一格式。

## 4. 修订后的施工顺序（渐进可回退）

v1 把「搬引擎」放第一步。修订后**持久化先做**——它独立就有价值，且是「完全解决」里
唯一与 Worker 无关的部分。

| 阶段 | 内容 | 独立价值 | 回退 |
|---|---|---|---|
| **P0** | 取证 + 审计：任务 B 的「写没落盘」判定；worker 环境构建闸门；DOM/localStorage/node: 依赖清单；**两端各一次 worker 探针**（加载/往返/重建）；`TurnCheckpoint` 体量与 `wasmPaths` 实测 | 把「预期极少」换成清单，把平台差异提前暴露 | — |
| **P1** | **持久化外置**：增量日志补全（工具结果/检查点级别）；Rust 侧 `chat_stream` journal（脱 JS）；快照降为 fold；`foldedThrough` 水位贯通恢复路径 | 直接消除任务 B 形态的数据风险，与 Worker 无关 | 保留旧快照路径 |
| **P2** | Worker 骨架：单窗、单会话、`attach/project/need` 最小协议；特性开关**按会话创建时定**，不迁移 | 引擎 M1 隔离可观测 | 开关回退（新会话回主线程） |
| **P3** | 工具桥（允许清单 + 审批）+ LLM ProxyAdapter + 增量日志接 Worker | 引擎完整搬离主线程 | 同上 |
| **P4** | 全量切换，删除主线程引擎路径；状态所有权地图逐项收口 | 双轨税归零 | — |
| **P5（可选）** | daemon（方案 3 S3）：跨窗单写、UI 全死仍落盘、多表面 | 结构收口 | 最大一步 |

P2 的开关必须写明：**同一会话不允许中途换宿主**。切换 = 关闭会话重开（从日志恢复）。
不写这条，双轨就会变成两套状态机的长期并存。

## 5. 风险清单（修订）

1. **Worker 不等于进程隔离**（新增，最重要）：页面挂起/冻结时 Worker 一起停；后台节流
   同样作用。所有「UI 死了引擎照跑」的措辞都要改成「UI 的**渲染**死了，引擎的**事件循环**
   还在，前提是 WebView 未被挂起」。
2. **M2 通道不变**（v1 只写在风险 5）：主线程仍要收 Channel、仍要做 `postMessage`。
   收益必须由「Worker 侧按帧合并 + 引擎计算移出」兑现，否则是负收益。
3. **结构化克隆的字节账**（新增）：`TurnCheckpoint` / 工具结果 / 大 diff 要单独测；
   超阈值的大载荷考虑「主线程只拿摘要，全文留 Worker 或走 Rust」。
4. **单例分裂**（新增）：§3.5 的每一项都是潜在的双份状态；漏一项就是静默不一致。
5. **invoke 桥的权限面**（新增）：必须命令白名单，不能通用透传。
6. **双轨税**（v1 风险 4 的升级）：调试面、诊断打点、日志格式都要双份验证；
   开关存续期越短越好。
7. **测试等价性不等于环境等价**：`bun test` 跑在 Node 里，有 `window`、有 `localStorage`，
   证明不了 Worker 可用。等价通过 = 构建闸门 + 无 DOM 环境的子集跑通 + 真机 smoke。
8. **SSE 取消的时序**：Worker 本地 abort 后仍可能有在途 `llmBatch`，按 requestId 丢弃；
   主线程 `cancel_chat_stream` 失败不影响引擎收尾（今天也是 fire-and-forget）。
9. **后台定时器两端都会迟到（新增）**：mac App Nap 与 Windows 后台 timer 合并都会
   延迟 `setTimeout` 类机制（自动续跑、看门狗、重试退避），SSE/网络回调不受影响。
   任何「后台也能按秒推进」的设计（包括 Worker 内的）都要在两端实测，不能拿前台数据推广。

## 6. 验收判据（修订，可测）

1. **冻结注入分两种，各自验**：
   - M1（主线程长任务注入循环）：Worker 内回合继续、`events.jsonl` 继续增长、
     `snapshot.json` mtime 继续前进；解冻后投影按 `seq` 补齐，零丢失。
   - M4（停渲染，用现有 frameWatchdog 场景模拟）：Worker 无感；UI 由 nudge 自愈。
2. **落盘判据用文件，不用 UI**：冻结期间每 5s 采样 `events.jsonl` 尾行 ts 与
   `snapshot.json` mtime；`LINK TIMEOUT` 与「文件未写」必须分开统计。
3. **双窗并发**：两窗各跑一条流，在对方流式期间打字/滚动/收结果；
   同时记录 Channel 条数、`postMessage` 条数、主线程 >50ms 长任务占比。
4. **主线程工作量**：目标（待 P0 校准）——引擎相关长任务从主线程消失；
   每流每帧 ≤1 条 `project` 消息；`preview` 背压下不排队。
5. **等价性**：Worker 入口 `--target=browser` 构建绿；engine/harness 在无 `window`/
   `localStorage` 环境下跑通约定子集；双平台真机 smoke（mac WKWebView / Win WebView2）。
6. **分平台矩阵（两条都要过，不取其一）**：

| 判据 | Windows | macOS |
|---|---|---|
| Worker 加载 | module 与 classic 各记一条成本 | classic + blob 兜底；确认 custom scheme 下可加载 |
| M1 冻结注入 | 主线程长任务循环 | 同左 |
| M2 指标 | Channel/秒、`save_session` 回执时延、双窗帧率 | 同左（阈值可不同，必须留数） |
| M3 | hotzone 灭活回归（连点 20 次） | N/A |
| M4 | 帧停 nudge 回归 | occlusion 补丁 + frameWatchdog 回归 |
| 落盘 | `events.jsonl` 尾行 / `snapshot.json` mtime | 同左 |
| 恢复 | 强杀 Worker 后重开 | 同左 |

7. **恢复**：强杀 Worker（`terminate`）后重开，最后一条已 flush 的增量在；
   未 flush 的那一拍允许丢，且台账有记录。

## 7. 与方案 3 的关系（修订）

- **S1 已经部分落地**，本文不重造：`src/shared/sessionEventLog.ts` 的词汇表/串行化/
  投影/`mergeFoldWithLog`，`src-tauri/src/lib.rs:17211` 的 `append_session_event`
  （原子行写、跑在 blocking 池），GUI 写手在 `src/ui/chat.ts:1178`。缺的是
  **工具结果/检查点级别的增量**与 **Rust 侧 journal**，这正是 P1。
- **S3（daemon）是唯一能同时兑现「跨窗单写」与「UI 全死仍落盘」的位置**；方案 2 的
  R1/R2 两条错误在 S3 下自动消失。所以：如果 S3 在可预见周期内要做，方案 2 的
  P2–P4 应重新算净收益（引擎已经不在 WebView 里，Worker 只剩「daemon 缺席时的兜底」）。
- **推荐决策**：先做 P1（持久化外置，独立收益、无争议），再按真机取证决定 P2 是否开工。
  不要把「完全解决」押在 Worker 上——它解决 M1，不解 M2/M3/M4，也不解数据安全。
- **平台收敛**：S3 之后 GUI 与 daemon 之间是 localhost WS，两端同一条传输路径，
  §3.8 里「Channel 成本 / worker 加载 / WKWebView 安全上下文」三项差异随之消失；
  方案 2 若不走向 S3，这三项差异就要长期留在一个平台分支里——这也是 P5 的一个隐性收益。

## 8. 不做清单

- 不 hack Worker 直连 Tauri IPC（非官方支持，绕过 `__TAURI_INTERNALS__` 的安全封装）。
- 不做 SharedWorker / 跨窗共享 Worker（跨不过 WebView）。
- 不在 Worker 里做任何 DOM/渲染/计划卡。
- 不通过桥传全量快照（那是把性能审计的 O(N) 原样搬回来）。
- 不把密钥、审批裁决、配置写入搬进 Worker。
