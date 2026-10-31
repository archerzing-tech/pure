# 逻辑一致性审计与修复计划（2026-10-31）

> 范围：全仓（`src/` 11.4 万行、315 个测试文件）的一次静态审查 + 适配器级探针验证。
> 结论：**质量基线是健康的，问题集中在「同一事实存在多个真相源」**——每一处单看都能跑通，
> 两处并置就互相打脸。本文只列有可复现证据的项；判据是该条能否用一条命令或一次 diff 证伪。
>
> 状态：**计划待决策，尚未改动任何源码**。P0-1 存在 A / A' 两个方案未选定（见 §4.1）。

## 一、基线（审查当时）

| 检查 | 结果 |
|---|---|
| `bun run typecheck` | 通过，0 错误 |
| `bun run lint:conventions` | 通过（untyped-catch 22 / dom-non-null-assertion 33 / unfinished-marker 0 / suppression 0） |
| `bun test` | 4813 pass / 4 skip（均为 PowerShell·Windows 专用）/ 0 fail，89s |
| `.skip` / `.todo` | 0 处（没有靠跳过测试掩盖的缺口） |
| 导出符号无人引用 | 31 / 2673（1.2%） |

基线健康说明一件事：**下列矛盾不在任何一条测试的覆盖面内**。测试锁的是各模块自己的契约，
没有一条锁「模块与模块之间对同一事实是否说法一致」。

## 二、矛盾清单

### 2.1 系统提示教模型调用模型看不见的工具（P0）

**现象**：GUI 的 Web tools 段无条件告诉模型「你有 `web_search` 和 `web_fetch`」，而这两个名字
从模型工具清单里被过滤掉了。真正可见的 `web_scrape` 反而只写在 CLI 专用段里，GUI 用户拿不到用法。

**证据链**

| 位置 | 说的事实 |
|---|---|
| `src/shared/PromptAssembler.ts:180-182` | `GUI_WEB_TOOLS_PROMPT`：`web_search(query, maxResults?)` / `web_fetch(url, maxChars?)`，无条件下发 |
| `src/shared/PromptAssembler.ts:240` | Output style 段：「Call web_search FIRST for time-sensitive data」 |
| `src/shared/promptLayers.ts:143/164/170/171/216/324` | 多处指引 `web_search` / `web_fetch` |
| `src/shared/toolDefs.ts:391` | `PUBLIC_TOOL_NAMES` 不含这两个名字 |
| `src/shared/__tests__/toolDefs.test.ts:19` | `DELIBERATELY_HIDDEN = {web_search, web_fetch, search_files}`（刻意隐藏） |
| `src/shared/__tests__/toolDefs.test.ts:84` | 注释原文：「注意 web_fetch 在 DELIBERATELY_HIDDEN 里，模型看不见它」 |
| `src/shared/PromptAssembler.ts:194` | `web_scrape` 的说明只存在于 `CLI_CAPABILITIES_PROMPT` |

**探针实测**（`NodeToolAdapter`）：

```
web_search visible: false
web_fetch  visible: false
web_scrape visible: true
web_search executes: true
```

**影响**：模型拿不到 schema，只能照提示词散文猜参数名；严格校验工具名的 provider 会直接拒绝；
而它真正该用的 `web_scrape` 在 GUI 侧没有任何说明。这不是文案瑕疵，是提示层与工具层对同一事实
的断言互相矛盾。

**注**：`web_search` 不是别名——`src/adapter/node/NodeToolAdapter.ts:243` 是「结构化直查快路 +
多后端搜索扇出（Serper/Tavily/SearXNG/DDG/Bing/Sogou/Baidu）」，`web_fetch` 有独立的劫持检测
与路由兜底（`TauriToolAdapter.ts:2013`）。两者在 `ToolRegistry.TOOL_TAGS`（71-72 行）与
`TOOL_METADATA_TABLE` 里都有完整条目，是一直按一线工具维护的，只是 `PUBLIC_TOOL_NAMES` 漏了。

### 2.2 `create_document` 在 CLI 上「看得见、跑不了」（P0）

**现象**：CLI 把 `create_document` 发给模型，但 Node 侧没有执行分支，每次调用必失败。

**证据**

- `src/shared/toolDefs.ts:395`：在 `PUBLIC_TOOL_NAMES` 内 → `NodeToolAdapter.getTools()` 会下发
- `src/adapter/node/NodeToolAdapter.ts:275-276`：execute 的 `default` 返回 `Unknown tool: ${name}`
- 全仓 `create_document` 的实现只在 `src/ui/TauriToolAdapter.ts:2106` + `src/shared/docGen.ts:107`
- 探针实测：`advertised: true` / `error: Unknown tool: create_document`

**影响**：CLI 用户做 PPT / DOCX / XLSX 必然撞墙。这是项目自己在 `ToolRegistry.ts:156` 注释里
点名的「注册了却看不见」缺陷的对偶面——**宣告了却执行不了**。

### 2.3 自动续跑的默认值与范围，四处四个说法（P1）

| 真相源 | 默认 | 范围 |
|---|---|---|
| `src/ui/autoContinue.ts:16` `DEFAULT_AUTO_CONTINUE_MAX_ROUNDS` | **20** | — |
| `src/shared/i18n.ts:285-286`（中文文案） | **8** | **1–20** |
| `src/shared/i18n.ts:1633`（英文文案） | **8** | **1–20** |
| `index.html:437`（input 属性） | value=20 | **1–50** |
| `src/ui/settings.ts:4652`（保存时钳制） | — | **1–50** |
| `docs/auto-continue-design.md` §2 | 8 | 1–20 |

同一文档 §2 还写着「默认**关闭**、关闭时与现状完全一致」，而 `src/ui/config.ts:810-817` 的
v14 迁移把已有用户的 `autoContinue` **强制翻成 true**。文档描述的是一个已不存在的状态。

### 2.4 「关掉自动续跑」只关了一半机器（P1）

- `autoContinue` 在设置页有开关；`planContinueGuard`（引擎内同回合续跑，上限 3 次）默认
  `true`（`config.ts:378`），并在 v14 迁移里被强制打开（`config.ts:817`）
- 设置页**没有** `planContinueGuard` 的控件（`index.html` 无 `cfg-plan-continue-guard`），
  `settings.ts:4584` 只做 `prev.planContinueGuard ?? true` 的保留
- `chat.ts:5440` 的判据只看 `planContinueGuard`，与 `autoContinue` 无关

**影响**：用户关掉开关后，复杂计划任务在回合内仍会被引擎续着走——观感就是「开关没生效」。
与 `docs/auto-continue-design.md` §2 的承诺（每阶段边界照旧停下）直接冲突。

### 2.5 `normalizePlantumlSource` 两份实现已经分叉（P2）

| 能力 | `src/ui/plantumlDiagram.ts:168` | `src/channels/rasterize/headlessRenderer.ts:58` |
|---|---|---|
| BOM / CRLF | 剥离 | 只处理 CRLF |
| 嵌套 fence 行 | 删除 | 不处理 |
| `@startuml` 前的散文 | 丢弃 | 保留 |
| 缺结束标签时补什么 | `@end<tag>`（如 `@endmindmap`） | 固定 `@enduml` |

**影响**：同一段 puml，在图内聊天里可能成图，在飞书/钉钉投影里渲染失败。gateway 侧注释解释了
动机（不想为几张图把 UI 模块及其 i18n/DOM 依赖拖进来）——但这是纯字符串函数，放进 `shared/`
就没有这个代价，两边的行为差异是无意的副作用而非取舍。

### 2.6 其余一致性债（P2）

- `isVerificationCommand` 两份**逐字符相同**的 60 词正则：`src/ui/projectQualityGate.ts:412` 与
  `src/shared/delivery.ts:533`。目前一致，但没有任何测试锁住二者，改一侧立刻分叉。
  （`projectQualityGate.ts` 已 import 自 `shared/delivery`，合并没有循环依赖风险。）
- 工具可见性过滤存在三套规则：`ToolRegistry.getTools()`（`isPublicToolName || 动态能力 || MCP || EXTERNAL`）、
  `TauriToolAdapter.getTools()`（`isPublicToolName || 动态能力`）、`NodeToolAdapter.getTools()`
  （只有 `isPublicToolName`）。CLI 靠外层 `CliCapabilityToolAdapter` 补齐，当前可用，但规则分散。

### 2.7 死代码 / 未接线导出（P3）

| 符号 | 位置 | 说明 |
|---|---|---|
| `runLlmTurn` | `src/engine/LlmTurnRunner.ts:41` | 无人调用；`AgentLoopEngine` 只用 `streamLlmTurn` 与两个常量 |
| `stopLlmWarmLoop` | `src/ui/llmWarm.ts:71` | 无人调用；30s 预热循环无停止入口 |
| `stopProxyProbeLoop` | `src/ui/proxyProbe.ts:64` | 同上，5min 探测循环 |

最后两个是否要接上「关窗即停轮询」，是产品选择而非缺陷。

## 三、已确认的最优实践（应保留的作风）

下列设计是这次审查里正面样本，修复时不要顺手破坏：

1. `ToolRegistry` 作为模型可见性的单一咽喉（schema 在 `shared/toolDefs.ts`，权限标签在 registry）
2. `PromptAssembler` 被 GUI / CLI 共用，没有第二套系统提示
3. `shared/insertionMessaging.ts` 用 `CANCELLATION_INVARIANTS` / `RESUME_INVARIANTS` 正则锚住话术，
   让「收执不许替机制许愿」可被测试判据咬住
4. 根 `AGENTS.md` 与 `src/shared/defaultAgentsMd.ts` 的 base64 副本严格同步
   （逐字节 diff 仅差尾换行，由 `scripts/sync-default-agents-md.ts` 维护）
5. 导出面的克制：2673 个导出中仅 31 个无人引用

## 四、修复计划（按优先级，分批可独立发布）

### 4.1 P0-1 网页搜索工具与提示词对齐

**方案 A（推荐）**：把 `web_search` / `web_fetch` 放回公开集。

- `src/shared/toolDefs.ts:391` 的 `PUBLIC_TOOL_NAMES` 加回这两个名字
- `src/shared/__tests__/toolDefs.test.ts:19` 的 `DELIBERATELY_HIDDEN` 缩减为 `{search_files}`
- 约 3 行。回归最小，能力最全，提示词一行不用改

**方案 A'**：只公开 `web_search`，把提示里 `web_fetch` 的指引改到 `web_scrape`。

- 需改 `PromptAssembler.ts:181/182`、`promptLayers.ts:168/170`（约 5 处文案）
- 工具面更干净（少一个与 `web_scrape` 重叠的抓取器），但要求模型完全改用 `web_scrape`
- 风险：`web_fetch` 有「直连 + 反向兜底 + 劫持检测」的路由语义，`web_scrape` 的兜底链是
  Jina→Wayback→Firecrawl，两者不是等价替换

**被放弃的方案**：把提示词全部改成 `web_scrape` + `researcher_web`。`researcher_web` 是
检索+抓取+引用的重工具，成本高一个量级；删掉 `web_search` 会让模型失去一般性「发现 URL」的能力。

**风险**：工具数 +2，每轮 schema 约 +1k 字符。
**验证**：`bun test src/shared/__tests__/toolDefs.test.ts`；探针确认 `web_search visible: true`；`bun run typecheck`。
**工时**：15 分钟。

### 4.2 P0-2 CLI 补 `create_document` 执行路径

- `src/adapter/node/NodeToolAdapter.ts` execute switch 加 `case 'create_document'`
- 用 `generateDocument(format, spec)`（`src/shared/docGen.ts:107`）取 `Uint8Array`，直接写盘
  （Node 侧无需 Tauri 的 base64 中转；`toBase64` 是 IPC 专用）
- 路径复用 `NodeToolAdapter.ts:3038` 的 `private resolve()`，但需补「无 workspace → `~/Downloads`」
  分支，与 Rust 侧 `resolve_document_path`（`src-tauri/src/lib.rs:1587`，单测在 `:17611`）语义对齐
- 报告必须用**落盘实路径**（相对路径已收口的语义），避免「卡片在、文件不在」那类判例重演

**风险**：两端路径语义若不同，会制造新的静默不一致。若愿意多花半天，把路径解析抽成
`shared/` 纯函数两端共用是更优解；否则先在 Node 侧按 GUI 行为实现并以测试锁住。
**验证**：新增单测「CLI 侧生成 pptx 后文件存在且非空」；用探针脚本复测应 `success: true`。
**工时**：2–3 小时（含测试）。

### 4.3 P1-3 统一自动续跑的数字口径

**推荐**：以代码为准改文字（保留 20 / 50）。

- `src/shared/i18n.ts:285-286`、`:1633`：默认 20、范围 1–50
- `index.html:435` 的 fallback 文案同步
- `docs/auto-continue-design.md` §2：更正默认值、范围，以及「默认关闭」的过时描述

**备选**：把 `DEFAULT_AUTO_CONTINUE_MAX_ROUNDS` 改回 8，并同步 `index.html:437` 的 `value`、
`settings.ts:4652` 的钳制、`scripts/verify-auto-continue.ts:402`。**不建议**——`autoContinue.ts:14-15`
的注释记录了「8 会在构建中途耗尽」的实测。

**风险**：纯文案，零行为变更。
**工时**：20 分钟。

### 4.4 P1-4 让开关语义完整（`planContinueGuard`）

**方案 B（推荐）**：`src/ui/chat.ts:5440` 改为

```ts
continueGuard: (config.planContinueGuard === false || config.autoContinue !== true)
  ? undefined
  : (args) => this.planContinueGuard(args),
```

1 行，让「关掉自动续跑」真的没有任何自动续，正好兑现设计文档承诺。

**备选 A**：为 `planContinueGuard` 增加独立设置项（`index.html` + `settings.ts` + i18n，约 2h），
给高级用户细粒度。**备选 C**：只改文档说明两者独立（零风险，但开关继续撒谎）。

**风险**：关闭后模型可能在任务未完时提前收尾，需要用户说「继续」——这是旧行为，且是显式选择。
字段保留，将来要细分随时可拆。
**验证**：新增单测「autoContinue=false 时不注入 continueGuard」；`chat.test.ts` 中锁定该源码
文本的断言需同步更新。
**工时**：1 小时。

### 4.5 P2-5 PlantUML 归一化收敛为单源

- 新建 `src/shared/plantumlSource.ts`，搬入 `ui/plantumlDiagram.ts:168` 的实现（含
  `FENCE_LINE` / `START_LINE` / `END_LINE` 与 `trimBlankLines`）
- `ui/plantumlDiagram.ts` 与 `channels/rasterize/headlessRenderer.ts:58` 都改为导入并 re-export

**风险**：gateway 侧行为会变（变好），需确认没有测试断言旧的宽松行为。
**验证**：两侧渲染测试全绿；加一条「两处导出是同一函数引用」的断言。
**工时**：1 小时。

### 4.6 P2-6 验证命令识别去重

- `src/ui/projectQualityGate.ts:412` 删除本地实现，改为从 `../shared/delivery` 导入并 re-export
  （该文件本就 import 自 `shared/delivery`，无循环依赖）
**工时**：10 分钟。

### 4.7 P2-7 加「提示词 ↔ 工具集」契约测试

- 新增 `src/shared/__tests__/promptToolContract.test.ts`
- 输入：读取 `PromptAssembler.ts` / `promptLayers.ts` / `agentBehavior.ts` 的源文本
- 断言：**被 `PUBLIC_TOOL_NAMES` 排除的 built-in 工具名，不得以 `name(` 的调用形态出现在提示文本中**

用「隐藏名单」做输入而不是从提示里正则抓工具名，是为了避开假阳性（`sys_info()` 之类的正文明文）。
三行断言即可锁住 §2.1 这类回归，且新增隐藏工具时自动受保护。
**风险**：`promptLayers.ts:168` 现在仍写着 `web_fetch / curl`，§4.1 修完后自然通过；
若选 A' 方案，这条测试会立刻指出漏改的文案——这正是它的价值。
**工时**：45 分钟。

### 4.8 P3 死代码清理

- 删 `LlmTurnRunner.ts` 的 `runLlmTurn` / `contentLooksTruncated` / `LlmTurnResult`
- `stopLlmWarmLoop` / `stopProxyProbeLoop`：删除，或在窗口关闭路径真正接上（需先定「关窗是否停轮询」）
**工时**：30 分钟。

## 五、批次与依赖

| 批次 | 内容 | 累计工时 | 收益 |
|---|---|---|---|
| 批次 1 | P0-1 + P0-2 + P2-7 | ~3.5h | 模型能力不再自我矛盾，并由契约测试上锁 |
| 批次 2 | P1-3 + P1-4 | ~1.5h | 用户可见的文案与开关都变诚实 |
| 批次 3 | P2-5 + P2-6 | ~1h | 清掉两处分叉源码 |
| 批次 4 | P3-8 | 0.5h | 减噪 |

批次之间无硬依赖；P2-7 放在批次 1 是为了让后续每一批都在「提示词与工具集对齐」的护栏下进行。

## 六、待决策项

1. **P0-1 选 A 还是 A'**：A = 公开两个工具（1 行，能力最全）；A' = 只公开 `web_search` 并把
   `web_fetch` 的指引改到 `web_scrape`（5 处文案，工具面更干净，但两者兜底链不等价）。
2. **P1-4 是否需要独立开关**：推荐 B（跟随 `autoContinue`）；若你希望保留「关掉续跑链但仍要
   防模型提前收尾」的组合，则走 A（加设置项）。
3. **P3 的轮询生命周期**：关窗时是否要停掉 30s 预热与 5min 代理探测。

## 七、回归防线（本次审计的产物）

- 一组可复现探针：`create_document` 的「宣告可见 / 执行 Unknown tool」、`web_search`/`web_fetch`
  的可见性，以及 `AGENTS.md` 与内嵌副本的字节 diff
- 契约测试（§4.7）落地后，§2.1 与 §2.2 会从「靠人记得」变成「改错了就红」

> 本文档只记录审查与计划；所有 `src/` 文件截至写入时未被修改。
