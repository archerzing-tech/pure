# 子 agent 悬浮卡升级：空间门 + Agent 工作台页面（2026-11-12 设计稿）

状态：**已实施（四刀全落，2026-11-12）**。验证链：typecheck 绿 + build:vite 绿 + bun test 全量 5332 pass 0 fail。实施落点：`agentWorkbench.ts`（新模块，单例 + 外科手术式 patch + 渲染闸消费者）、`agentActivityPanel.ts`（空间门谓词 + onOpenAgent 钩子 + 边界常量导出）、`chat.ts`（funnel 第二消费者 ×2 + gate 接线 + 委派卡跨链四落点 + panel hooks）、`main.ts`（工作台 init + 渲染闸注册 + settings 互斥 + Esc 分支 + context 联动 + 恢复重放跨链）、`markdown.ts`（流式渲染闸：250ms 重试拍追平）、`store.ts`（ToolExecMeta.callId 向后兼容）、`index.html`（#agent-view 壳）、styles/critical css（工作台段 + gate-hidden + bottom sheet 退役）、i18n 双语键。契约测试 `src/ui/__tests__/agentWorkbench.test.ts` ×20（谓词/开关寻址/chip 横跳/trace 换人无残留/产出增量/历史只读/会话更替关闭/空态/渲染闸半开语义/跨链幂等/源码锁×6）。

## 0. 需求原话与映射

1. 「右侧空间不够时不显示这些卡片」→ **空间门（Space Gate）**：不满足显示条件时整条 rail 隐藏。
2. 「显示的卡片可以点击，点击之后切到这个子 agent 的单独面板……专门做一个页面……可以切回去」→ **Agent 工作台（Agent Workbench）**：页面级视图，卡片点击进入，Back/Esc 切回。

## 1. 现状盘点（设计依据，全部实证）

| 事实 | 位置 | 对设计的影响 |
| --- | --- | --- |
| 右侧浮动卡 rail 已存在：每支在干活的子 agent 一张卡（badge/name/time 三行契约），新活卡置顶，任务级生命周期 | `agentActivityPanel.ts` + `styles.css` #agent-activity-host（z 18，宽 clamp 140–168px，bottom 随 composer ResizeObserver） | 不是从零造，是**升级**：加点击、加空间门 |
| `output`（≤2000 字符）与 `toolTrace`（≤20 条：name+args+status）已随活动**持久化** | `store.ts` SessionAgentActivity；`agentActivityPanel.ts:15-16` 边界 | 工作台 v1 的数据底座现成，**不扩存储** |
| `#settings-view` 是现成的页面切换先例：flex 同排 `width:0%→100%`（`.expanded`），Back 按钮 + Esc，chat DOM 不卸载、流式照常写 | `index.html:342`、`styles.css:868`、`settings.ts:267-302` | 工作台**照抄这个机制**，chat 状态天然保全 |
| ≤720px rail 变底部抽屉（bottom sheet）；窄窗 rail 只收缩不隐藏 | `styles.css:1258`（+ critical.css 对应块） | 空间门落地后 bottom sheet **退役**（阈值高于 720px 时永远走不到） |
| 卡片本体无 click handler（只有 session chip 复制）；`.agent-activity-rail > *` 才有 pointer-events | `agentActivityPanel.ts:97,172-218` | 加点击不踩 2026-10-07 误点判例 |
| bash_executor 已被 rail 过滤（工具不是 agent） | `agentActivityPanel.ts:148-150` | 工作台沿用同一过滤 |
| 历史恢复：重载会话 rail 渲染静态历史卡（historical），agentActivities 随 SessionUiState 落盘 | `chat.ts:1885`、`store.ts:105` | 工作台对历史卡**只读开放** |

## 2. 需求一：空间门

**判据（机械、常驻，两个条件任一命中即隐藏整条 rail）：**

1. `viewport 宽度 < 1080px`（可调常数；窗口 minWidth 1000px，1000–1080 区间 rail 要占掉转写 ~11% 宽，_HIDE_ 优于挤压——这就是用户说的「空间不够」）；
2. `#context-panel` 展开（右侧被上下文面板占据，z 30 > rail z 18，现状是叠压，改为让位）。

**机制：** 不新增监听器家族——挂进现有 `installAgentActivityHostLayout`（chat.ts:1744，composer ResizeObserver 已住那）+ resize 事件；谓词算一次，结果落 `#agent-activity-host.hidden`（`[hidden]{display:none!important}` 已存在）。**只藏不卸**：隐藏期间 rail 照常收事件、照常更新数据，只是不画。

**退役项：** `@media (max-width:720px)` 的 bottom sheet 规则组（styles.css + critical.css 两处）随空间门删除——阈值 1080 > 720，bottom sheet 成死代码；留着会骗人。

## 3. 需求二：Agent 工作台

### 3.1 页面机制

- `index.html` 新增 `#agent-view`，与 `#settings-view` 同模式：`width:0% → .expanded 100%` 过渡，chat 不卸载、流式继续写进被挤压的 DOM（settings 已验证此路无损）。
- 打开：rail 卡片 click（带 `dataset.callId`）；关闭：页头「← 返回对话」按钮 + Esc（与 settings 同键路）。Esc 只在 agent view expanded 时劫持，不越权。

### 3.2 页面结构（四段，头尾固定、中间滚）

```
┌──────────────────────────────────────────────┐
│ ← 返回对话   code_reviewer · 代码评审   [●运行中 03:24]  ag-1a2b3c4d⧉ │  ← 头（Back/名称/态/耗时/ID）
│ [researcher] [code_reviewer●] [ui_designer✓]  │  ← 同任务 agent 切换条（chip，点了换人不用先退）
├──────────────────────────────────────────────┤
│ 任务卡：inputSnippet（这支队被派了什么活）        │  ← 概要段
│ 续跑徽标/自愈重试第 N 次/失败原因（error）        │
├──────────────────────────────────────────────┤
│ 工作流：toolTrace 时间线                        │  ← 过程段
│   🔍 search_files(“auth”) ✓  📖 read_file(...) ● │    （复用 formatSubagentTraceLine 的呈现语汇）
├──────────────────────────────────────────────┤
│ 产出：output（流式追加，尾随滚动）               │  ← 产出段
│ …(截断交代：完整产出见对话委派卡 [跳过去 ↗])      │
└──────────────────────────────────────────────┘
```

- **数据源 = 已持久化的 SessionAgentActivity 全量字段**：inputSnippet、toolTrace、output、lifecycle/status、error、durationMs、tokensUsed、startedAt、attempt、resumed、agentId。**v1 不扩存储边界**（output 2000 字符 / trace 20 条不动）；页内截断交代 + 「在对话中查看 ↗」链到转写里同 callId 的委派卡（scrollIntoView）——细节追完整走既有路。
- **实时性**：chat.ts 里 rail 的 funnel（mergeAgentActivity → panel.update）是唯一写入口；工作台作为**第二个消费者**挂在同一 funnel，打开时只更新当前 callId 对应段块，尾随滚动复用 scrollPin（followInnerTail）。
- **切换条**：同任务全部 agent（含完成态）chip 化，当前高亮——多 agent 之间直接横跳，不用来回退。
- **历史只读**：重载会话点历史卡进工作台，渲染落盘快照，头部标「历史（已归档）」，无实时段。

### 3.3 卡片侧改动（最小）

- 卡片 `cursor:pointer` + hover 抬升 + 尾部 `›` 指示（三行契约不破：不加状态文字，指示语义走视觉）。
- 运行中/完成/失败卡都可点（完成卡=看结果，失败卡=看 error + 已跑到的位置）。

## 3.4 风格融入硬约束（2026-11-12 用户定案：设计可以，但必须融入现有 UI 风格）

**零新视觉语汇**——工作台与卡片不发明任何新组件样式，全部复用现役素材：

- 卡片：直接用现有 `.agent-worker` 卡样式族（badge/name/time 三行、状态色左边条、entering/retrying/resumed 修饰类），只加 `cursor` 与 hover 抬升两个伪类级增强；
- 页面切换：复用 `#settings-view` 的 `width:0%→100%` 机制与 `settings-back-btn` 的按钮样式语义（返回按钮长得像设置页的返回）；
- 段落呈现：概要段用 `--bg-assistant` 气皮 + `--border-light` 描边（assistant 气泡同款），工作流时间线复用 tool-row 的状态语汇（✓/●/✗ + mono 参数提示），产出段用 tool 面板的终端皮（`--bg-input`+mono 语境或 assistant 皮，实装时取其一）；
- 状态徽标：沿用 rail 卡的 done/failed/active 状态色（--success/--danger/--accent），不引入新色；
- chip 切换条：现有 pill/chip 圆角语法（999px、11px、border+accent 高亮），与设置页分类导航同语感；
- 字号阶全程走现有 9/10/11/12/14px 阶，间距走 4px 栅格。

原型（prototype/agent-workbench-ui.html）里卡片样式是**示意近似**，实装以上面清单为准——绑现有类，不抄原型的近似 CSS。

## 3.5 性能设计（切换与数据显示的账，前置写死）

背景纪律：渲染饱和烧过四轮 Windows，任何新渲染路径先算 O 账。

| 关注点 | 设计 | 依据 |
| --- | --- | --- |
| 打开成本 | 工作台打开**零 I/O**：只读内存里的 SessionAgentActivity（活动快照会话恢复时已在内存）；不读盘、不 fetch | store.ts 快照已随会话加载 |
| 更新路径 | 工作台是 funnel 的**第二消费者**，更新做**外科手术式 patch**：只动当前 agent 的三段（snip/flags、trace ≤20 行全量小重建、output 增量 append 文本节点）；**禁止**照抄 rail 的 `list.replaceChildren()` 全列重建模式 | rail 现状是每事件 O(N) 重建全卡，工作台不许复制这个模式 |
| 显示边界 | 产出段显示与存储同界（2000 字符内、尾窗 ~6 行 + caret），trace 段 ≤20 条——DOM 有界常数 | agentActivityPanel.ts:15-16 |
| **切换期间 chat 的渲染闸** | 工作台全开（chat 被挤到 0 宽、不可见）时，**chat 流式 DOM 更新挂起**：流数据照收进状态、DOM 不动；关闭工作台（transitionend）后一次追平渲染。半开过渡期（chat 还看得见）不挂起 | 「打字优先退避」同款哲学：**推迟不丢弃**；不然流式回合 + 工作台双开 = 两份活跃 DOM 同步重排，正是第三轮卡死的形状 |
| 尾随滚动 | 复用 scrollPin 既有宽限窗机制（用户上翻即停跟），不新写滚动逻辑 | scrollPin.ts followInnerTail |
| 定时器 | 仅工作台打开时跑 1s 计时器（elapsed），关闭即停；产出追加靠事件驱动不轮询 | Windows 活锁判例：高频预算按每秒穿越次数算 |
| 布局抖动 | 空间门谓词只挂在既有 ResizeObserver + resize 事件上，一次读 clientWidth 一次判定，不在事件里循环读布局 | installAgentActivityHostLayout 已有骨架 |
| 历史会话 | 历史卡打开工作台 = 渲染落盘快照一次，无任何持续更新路径 | 恢复路径本就 static |



- **空间门只影响 rail，不影响工作台**：1080px 以下 rail 隐藏，但工作台入口不能丢——转写委派卡头部加同款「查看工作台 ↗」（委派卡与工作台共用 callId 寻址）。否则窄窗用户永远进不去。
- **隐藏与点击的竞态**：空间门把 rail 藏掉的瞬间若工作台开着，工作台**不关**（它现在占的是整页，不再依赖右侧空间）。
- **i18n**：新增键（工作台标题/返回/段落标题/历史徽标/跳转链）中英双语同刀落。
- **测试**（随特性落，契约测试判例）：
  - 空间门谓词单测（宽度阈值 × context panel 态 × hidden 落点）；
  - 工作台开/关/Esc、chip 切换、callId 寻址正确性；
  - 历史只读态渲染；
  - CSS 契约（bottom sheet 退役断言：styles.css/critical.css 零 `max-width:720px` agent 残留）。
- **不动的**：卡片三行契约、任务级 card 生命周期、bash_executor 过滤、存储边界（2000/20）、session chip 复制。

## 5. 实施切刀（确认后执行）

1. **刀 1 空间门**：谓词 + hidden 接线 + context-panel 联动 + bottom sheet 退役（styles.css + critical.css）+ 委派卡「查看工作台」入口占位（刀 2 接线）。
2. **刀 2 工作台页面**：#agent-view 骨架 + 开关/Esc + 头部 + 概要/过程/产出三段 + chip 切换条 + funnel 第二消费者 + scrollPin。
3. **刀 3 卡片可点 + 跨链**：卡片 click/hover/`›`、委派卡↔工作台双向跳转。
4. **刀 4 i18n + 测试全量**：双语键、四组测试、typecheck/build:vite/win-gnu 交叉 check、bun test 全量。

## 6. 待定参数（默认值已选，可改）

| 参数 | 默认 | 备选 |
| --- | --- | --- |
| 空间门宽度阈值 | **1080px** | 1000（贴窗口下限）/ 1200（更保守） |
| context panel 展开时 | **rail 隐藏** | 保持叠压（现状） |
| bottom sheet（≤720px 底部抽屉） | **退役** | 保留（与空间门并存） |
| 工作台产出段边界 | **沿存储 2000 字符 + 截断交代** | 扩存储边界（不建议：落盘体量随产出涨） |
