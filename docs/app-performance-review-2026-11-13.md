# 应用性能全景审视（基线 379494e，2026-11-13）

> 范围：桌面 GUI（WKWebView / WebView2）+ Rust 宿主 + 请求链路，按「应用性能 / 渲染正确性 / 文件读写 / 界面渲染 / 动效」五个维度逐一过一遍。
> 方法：只读代码 + 本机真实数据（`~/.pure/sessions` 134 个会话 / 49.5MB）实测；**没有启动 GUI 做帧率与主线程采样**，所有耗时都是 Bun/V8 同构测量，绝对值 ±30%，相对倍数可靠。

## 0. 先说结论

上一份审计（`gui-performance-audit-2026-11.md`）列的 P0-1～P0-4、P1-2、P2-2、P2-4 在 HEAD 上**都已经落地**（代码里有对应的 `P0-x` 标记）。所以这份报告不重复那些项，只写**仍然存在**的成本。

仍然贵的，按收益排序：

| # | 问题 | 量级 | 类型 |
|---|---|---|---|
| 1 | 历史图片常驻模型上下文，**每轮请求重传全量 base64** | 单张截图 3.74MB / 轮 | 网络 + 序列化 |
| 2 | `save_session_impl` **每次保存额外整份读+解析 2 次** | 11.3MB 会话 ≈ 16ms CPU + 22MB 磁盘读 / 次 | 文件读写 |
| 3 | 每次保存 **整份快照过 IPC**（JS stringify → Rust parse → Rust stringify） | 7.5MB × 3 次过手 | 主线程 + 读写 |
| 4 | `createSessionSnapshot` 的**身份哈希**对每条消息做两次 JSON.stringify + 逐字符 FNV | 实测 9.8ms / 次，线性于字节 | 主线程 |
| 5 | `read_file` **先解全文再切 32k 头部** | 64MB PDF 也要整份 inflate | 文件读写 + 内存峰值 |
| 6 | `events.jsonl` **无上限**（无轮转/压缩） | 已见单会话 3.97MB，全库 14.7MB | 磁盘增长 |
| 7 | 活动轨每次事件 `list.replaceChildren()` **整表重挂** | 5–20Hz × N 张卡 | 渲染 + 动效重启 |

其余（index.json 全量重写、旧档双账本、附件无回收、katex 进 eager 图、超长文本无整段上限）是 P2。

---

## 1. 架构与三条成本链路

```
模型流 ──▶ AgentLoopEngine ──▶ chat.ts ──▶ DOM（bounded）
                    │                        ▲
                    ├──▶ session snapshot ───┘（每检查点整份重建）
                    │            │
                    │            └──▶ invoke save_session ──▶ Rust：读×2 → parse → stringify → write+fsync
                    │
                    └──▶ provider 请求（messages 全量，含历史图片 dataUrl）
```

三条链路的现状：

**A. 流式渲染（已经做得很好，不是问题）**
- 流式尾窗 `STREAM_TAIL_LIMIT = 32_000`（`src/ui/markdown.ts:3834`）
- 自适应节流 100→220→1000ms，按实测渲染成本回退（`markdown.ts:3498-3562`）
- hljs 有独立字符预算 `HLJS_BUDGET_CHARS = 100_000`（`markdown.ts:3287`）
- 工具 stdout：rAF 合帧 + 每帧最多 24 行 + 队列硬上限（`chat.ts:4831-4870`）
- 滚动：rAF 合并，单帧一次 `scrollHeight` 读（`scrollPin.ts`）
- 长会话：活转写按回合折叠成 history group、离屏 park（`liveTranscriptWindow.ts`）
- 工具参数字节流解析（大 `write_file` 内容不再逐 token 重解析）

**B. 持久化（主要剩余成本在这里）**——见 §2.2、§4
**C. 请求链路（最大的单点浪费）**——见 §2.1

---

## 2. 会让应用性能受损的地方

### 2.1 P0：历史图片常驻上下文，每轮重传

- **位置**：`src/ui/store.ts:454`（`compactTranscriptImages` 只压缩 transcript 侧）；`src/adapter/openai/mapping.ts:36-61`、`src/adapter/deepseek/DeepSeekAnthropicAdapter.ts:340-381`（请求组装把**所有**历史消息的 `images[].dataUrl` 原样发出）。
- **机制**：`modelContext.messages[].images.dataUrl` 永久保留。每轮请求都要把历史图片的 base64 重新 JSON.stringify 一次并上传一次。
- **实测**：`session_1794109757707_1` 里单条图片消息 3.74MB（原图 2.94MB PNG）；该会话快照 7.55MB，其中图片占绝大部分。`JSON.stringify` 该条消息 3.0ms。
- **代价**：每轮 +3.74MB 上传（弱网首包显著变慢）+ 主线程一次 3ms 级序列化 + 服务端每轮重复计图像 token。
- **修法**：只在**最近 N 轮**（例如最近 1–2 条用户消息）保留 `dataUrl`；更早的降级为 `thumbDataUrl` / `path` 占位，必要时（用户重发、显式引用）再从 `~/.pure/attachments/` 按需水合。
- **风险**：模型对「图片还能不能看到」的语义变化。建议只对「已被后续轮次覆盖的历史图片」降级，并保留一句文本说明，避免模型误以为用户又发了新图。

### 2.2 P1：保存链路的读放大与三次序列化

- **位置**：`src-tauri/src/lib.rs:15210`（`save_session_impl`）——同一次保存里：
  1. `load_stored_session_revision()`（`lib.rs:15020`）：`read_to_string` + 完整 `serde_json::from_str`，只为取 `snapshot.revision`
  2. `load_stored_session_model_provider()`（`lib.rs:15034`）：再一次 `read_to_string` + 完整解析，只为取 `model`/`provider`
  3. `load_session_workspace()`（`lib.rs:15336`）：有 sidecar 时便宜；**旧会话没有 sidecar 时会第三次读+解析整份文件**
- **实测**（11.3MB 文件，warm median）：read 4.9ms、parse 11.2ms → 多两次 ≈ **16ms CPU + 22MB 额外磁盘读**，然后在全局 `session_persistence_lock` 里串行。
- **前端侧**：`createSessionSnapshot` 重建 + 整份快照 `JSON.stringify`（该会话 snapshot 单独 stringify 14.2ms，整份 29.3ms）+ Tauri `invoke` 自己再 stringify 一次 → **同一份字节在主线程+阻塞池里过手 3 次**。
- **修法**（按性价比）：
  1. `revision`/`model`/`provider` 由前端随快照一起传（前端本来就持有），删掉两条读路径 → 直接省掉全部放大；
  2. 若必须服务端校验 revision，就用 sidecar（`revision.json`，几十字节）替代解析整份；
  3. 串行锁只在真正的写入段持有，读取校验移到锁外。

### 2.3 P1：`createSessionSnapshot` 的身份哈希

- **位置**：`src/ui/store.ts:402`（`stableMessageId`）、`store.ts:475-477`（`occurrenceKey = JSON.stringify(message)`）
- **机制**：每条消息被 `JSON.stringify` **两次**（occurrenceKey + id 种子），再做一次**逐字符** FNV 循环。
- **实测**：该会话「全体消息 stringify + FNV」= **9.8ms/次**；其中图片消息单条 stringify 3.0ms、FNV over 3.74MB 5.4ms。
- **影响**：每次检查点都重算一遍，与 §2.2 相乘。
- **修法**：id 只依赖 `modelMessageIndex` + 内容长度 + 一个 32 位轻量哈希（或直接复用上一份快照里按 index 命中的 id，只给新增消息算）；图片字段不参与哈希（用 `path`/`thumbDataUrl` 的短指纹代替）。

### 2.4 P2：`index.json` 每次保存全量重写

- **位置**：`lib.rs:16034` `update_sessions_index`——读全量 → 解析 → 改一条 → `to_string_pretty` 全量写。
- **现状**：24.7KB / 134 会话，跟着会话数线性长；没有 fsync（这点是对的）。
- **修法**：title/messageCount 没变化就跳过写；或改成 `index.jsonl` 追加 + 启动时折叠。

### 2.5 P2：启动 eager 图

- 首屏：入口 `index-*.js` **1.41MB** + modulepreload 约 **1.06MB**（katex 512KB、llm-vendor 304KB、markdown-vendor 107KB、hljs 82KB、tauri-vendor 29KB、katex.css 29KB、critical.css 20KB）≈ **2.5MB JS**。
- 主样式 274KB **不是** eager：走 `deferredStyles.ts` 动态加载（`main.ts:310`），首屏只有约 20KB critical（源文件 `critical.css` + `plain-text-plan.css` 共 27KB），这一点设计是对的。
- **可动的一处**：`src/ui/markdown.ts:13` 静态 `import katex from 'katex'` → 512KB 在任何公式出现前就必须下载解析。改成首个 `$$` 出现时动态 import，首屏少 512KB。
- echarts / mermaid / plantuml / xlsx / pptx 都已经是动态 import，无需处理。

---

## 3. 会导致渲染出问题的地方

### 3.1 红线：不要再对转写行做 `content-visibility` / `contain: layout`

`styles.css:1937-1941`、`1979-1984`、`2560-2563` 记录了实测过的回归：WKWebView 下已绘制行滚回来会**变空白**。这类「省布局」优化在本项目已被判定为负收益，任何后续「虚拟化/裁剪」提案必须先在 WKWebView 真机验证，不能凭 Chromium 结论上线。

### 3.2 活动轨每次事件整表重挂

- **位置**：`src/ui/agentActivityPanel.ts:157` `list.replaceChildren()` → 然后逐卡复用节点重新 `append`。
- **现状**：节点已经复用、文本写入已做「先比较再写」（P1-2b），所以**不是**旧审计说的整表重建。
- **剩余问题**：
  1. 每拍把所有卡从文档里摘下再插回——一次 O(N) 的结构变更 + 逐卡样式失效；
  2. **摘挂会重启正在跑的 CSS 动画**（`agentWorkerBreath` / `agentWorkerRetry` 脉冲），视觉上是「闪一下」；
  3. 5–20Hz × 4 路并发时会持续踩这条路径。
- **修法**：只在顺序真的变化时做最小移动（或按 `startedAt` 插入到正确位置），状态更新走属性/文本 patch；顺序不变时完全不碰 DOM 结构。

### 3.3 长会话渲染的边界

- 活转写：超过阈值后旧回合折叠成 history group，离屏内容 park（`liveTranscriptWindow.ts`），这是正确的方向。
- 剩余风险：**单个 group 首次展开时是一次性整段挂载**（组内所有回合 + 工具卡），超大组（几百个工具行）展开会有一次明显停顿；建议给组内挂载也加 rAF 分片（恢复路径 `main.ts:1415-1580` 已经有 `yieldToUI` 分片，活路径复用同一套即可）。

### 3.4 超长非代码文本

- `marked` 侧没有整段上限（hljs 有 100k 字符预算，流式有 32k 尾窗）。完成态一条 200k 字符的纯文本回复会整段解析一次——偶发一帧 100ms 级卡顿。
- 建议：完成态渲染加与流式同款长度闸门（超阈值降级为纯文本 + 「展开渲染」按钮），而不是硬截断。

### 3.5 图片没有固有尺寸

气泡内 `<img>`（`chat.ts:605/633`、`pasteChip.ts:612/733`、`toolRow.ts:1531`、`markdown.ts:4484`）没有统一写 `width`/`height`/`aspect-ratio`，加载完成才撑开高度 → 恢复会话或图片解码时有布局跳动，若同时 pinned 会带着滚动条跳一次。建议给带 `width/height` 元数据的图片直接写死比例。

---

## 4. 影响文件读写的地方

| 项 | 位置 | 现状 | 判断 |
|---|---|---|---|
| 保存读放大 | `lib.rs:15210` | 每次保存额外 2 次整份读+解析 | **修**（§2.2） |
| 旧会话第三次读 | `lib.rs:15336` | 无 workspace sidecar 时再读整份 | 随 §2.2 一起消掉 |
| 整份快照写 | `lib.rs:15266-15272` | `to_string_pretty` + write + **`sync_all()`** + rename | 保留（崩溃安全），但可考虑大文件降级为 compact |
| `read_file` 全量提取 | `lib.rs:1331` | `fs::read` 整份（≤64MB）→ 格式提取（PDF inflate / zip）→ `lines().collect()`（全行 `Vec<&str>`）→ 只返回 2k 行/32k 字符 | **修**：大文件先按字节首窗解码；PDF/xlsx 走页级/条目级按需提取 |
| `events.jsonl` | `lib.rs:15062` | 只追加、无轮转/压缩；单会话已见 3.97MB，全库 14.7MB | P2：按会话大小轮转或压缩归档 |
| 旧档双账本 | `~/.pure/sessions` | 134 个会话共 49.5MB；4 个 >1MB 文件仍带顶层 `messages`，其中 1 个 11.3MB 仍带 2 份 base64 | P2：一次性迁移脚本（预计 49.5MB → ~30MB） |
| 附件回收 | `lib.rs:11019-11031` | `~/.pure/attachments/<hex(sessionId)>/`；删除会话/清空会话路径里没有看到对应清理 | P2：删除会话时一并删附件目录 |
| 观测 dump | `lib.rs:10822` | 16MB 尾读已移出主线程；剩余成本在 JS 侧解析整份 JSON | 可接受（面板打开才触发） |
| `index.json` | `lib.rs:16034` | 每次保存全量重写，24.7KB | P2（§2.4） |

补充：`read_file` 的 64MB 上限 + `lines().collect()` 会在内存里同时持有「原始字节 + 解码文本 + 全行索引」，一个 60MB 日志文件的内存峰值是数百 MB 级；这是当前最容易触发「工具跑着跑着内存飙一下」的地方。

---

## 5. 影响界面渲染的地方

- **CSS 体量**：`styles.css` 423KB / **2491 条规则** / 57 组 `@keyframes` / 168 条 `transition` / 119 条 `box-shadow` / 19 处 `filter: blur`。主样式是 deferred（不阻塞首屏），但首次加载后每次类名切换的样式失效面按 2491 条规则算。可做的是「按功能拆包」（设置页、工作台、图表只在打开时加载自己的样式），不是整篇重写。
- **`backdrop-filter` 剩 25 处**：常驻 chrome（`#input-bar`、`#composer-box`、`#status-bar`、`#landing-input-wrap`、`#sidebar-toggle`）**已经全部去掉了**，并留了理由注释。剩下的都在浮层（modal / drag-overlay / lightbox / settings-header / 上下文面板重开按钮），屏上时间短，**不建议再动**。
- **README 级结论：渲染侧不是瓶颈**。滚动、流式、工具输出、长会话都已经做了合并/分片/折叠。别在这里继续加复杂度。

---

## 6. 影响动效展示的地方

- **35 处 `infinite` 动画**，全部绑定运行态（`.busy` / `.pending` / `.is-switching` / thinking / loading / boot），空闲态为零订阅（`heartbeat.ts` 已把 plan 徽标那三处合并成单一节拍，工具卡计时也并进去了）。
- **逐帧重绘的动画**（动画的是 paint 属性而不是 transform/opacity）：
  - `thinkIconPulse` → `filter: drop-shadow()`（思考中每帧重绘）
  - `quality-gate-pulse` → `box-shadow` 扩散
  - `boot-glow` → `drop-shadow`（仅启动）
  这些只在活跃时跑，收益有限；若要继续压，把 `drop-shadow` 换成预渲染的伪元素 + `opacity/scale` 动画即可，视觉几乎一致。
- **`transition: width`**（`styles.css:861/879/909/6165/8568`）——进度条与侧栏类元素，动画的是布局属性。侧栏/设置面板的大挤压已经刻意用 `width 0s` 跳过过渡（`styles.css:8239-8250`），这条纪律要守住：**面板级布局不做 width/height 过渡**。
- **动效重启**：见 §3.2——整表重挂会让呼吸/重试脉冲从头开始，观感上是「闪一下」，这属于动效正确性问题而不只是性能问题。
- `prefers-reduced-motion` 覆盖了 17 处（含 `agent-worker--entering`、`agent-worker--active`、`interject-pending`、artifact spinner、plan 系列）。建议补一条兜底：`@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; } }`，避免新增动效漏配。

---

## 7. 建议的动手顺序

1. **图片上下文降级**（§2.1）——每轮都在付，收益最大，且不碰渲染逻辑。
2. **保存链路去掉读放大**（§2.2 修法 1）——纯 Rust 侧，行为不变，可用现成的 `save_session` 单测锁住。
3. **快照身份哈希换成 O(1)**（§2.3）——一次改动，永久收益。
4. **`read_file` 大文件首窗读取**（§4）——影响工具延迟与内存峰值。
5. P2 清理：index.json 跳过无变化写、events 轮转、附件回收、旧档一次性迁移、katex 动态化。
6. 渲染与动效只做两件小事：活动轨不重挂（§3.2）、图片固有尺寸（§3.5）。

前 4 项都不改变用户可见行为；第 6 项的第二条才会轻微影响视觉（消除跳动）。

## 8. 未验证 / 边界

- 没有启动 GUI 采样主线程 Busy、帧率、GPU 合成层；本报告的耗时是 Bun/V8 同构测量，WKWebView(JSC)/WebView2 的绝对值可能差 ±30%，**只用相对倍数做排序**。
- §2.1 的「每轮重传」是从请求组装代码读到的事实，**没有抓包验证**实际 body 大小；服务端是否对重复图片做去重计费未验证。
- §3.4 的 100ms 级卡顿是按 marked/hljs 的已知量级推断，未在该会话上实测单条 200k 文本的渲染耗时。
- 本报告只读代码 + 读真实数据，没有修改任何实现，因此没有可重跑的 typecheck/test。
