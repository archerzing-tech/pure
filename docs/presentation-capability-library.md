# 表现形式库（Presentation Capability Library）

> **状态**：MVP + routing 卡 + 机械触发 + 刀 2 渲染器注册化（86d12d8）+ 刀 3 组合式自定义（f473c9c）+ 刀 4 投影降级器（34f1f87，2026-11-03，v4.1.0）+ **刀 6 校验真话回流（f8bcfcd，2026-11-03）** 已落。余刀：常驻指针瘦身（刀 5，须真机复验围栏命中率勿先斩）。设计定调源于用户提案：展现形式抽成独立层，模型自主决策用哪种，可扩展可自定义。

## 一、定位与三层结构

把「模型能用哪些视觉形式交付、各适合什么、失败长什么样」从常驻提示词与意图词闸门里抽出来，收编成**表现形式卡注册表**，模型按需拉取、自主决策。

| 层 | 装什么 | 现址 |
|---|---|---|
| **语义描述层** | 每形式一张卡：适用/不适用判据、触发语法、交付纪律与失败行为、DSL 细则引用 | `src/shared/presentationLibrary.ts` |
| **能力支撑层** | 渲染管线（围栏分流）、parseRepair 校验修复、transcriptProjection 回放、cliDiagram ASCII 降级、图表 SVG LRU / 地图池化等性能工程 | `src/ui/markdown.ts` 等（现状不动） |
| **可达性机制** | 常驻最小语法兜底（`VISUAL_BLOCK_POINTER`）+ 尾部发现指针 + `presentation_guide` 工具（目录/全文按需拉） | `promptLayers.ts` + `toolDefs.ts` + `ToolRegistry.ts` |

### 设计原则

1. **展现是 push 型输出语法，不是工具**：模型不是「调用地图」而是在回复里直接产出围栏，前端识别渲染。所以决策发生在生成回复时刻，语义描述必须在那时可达——常驻一行族语法兜底 + 工具按需深挖，而不是 deferred 工具那套「用时才发现」。
2. **判据两面都要有**：每张卡 `whenToUse` 与 `whenNotToUse` 同时在场（契约测试强制非空）。给了选择权不等于会选得好——「何时别用」是防过度可视化（为三行文字上一张图）的唯一闸。
3. **单源引用**：卡的 `detail` 直接引用 promptLayers 既有 DSL 常量（`CHART_DSL_PROMPT` 等），禁止复制文本；`presentationLibrary.test.ts` 有同引用断言防分叉。
4. **自有字段全 ASCII**：sidecar 中文锚三形态全灭判例（v3.6.6）——卡片的判据/触发/交付字段可 grep 验证；detail 引用的既有常量豁免（其中文示例句是既定现实，各自契约测试已锁）。

## 二、现状收编（MVP 前的家底）

- **渲染管线单分流点**：所有模型文本触发的形式（mermaid / puml / svg / chart / map / paint / math 围栏 + KaTeX 行内块 + GFM 表格 + 图片 + 高亮 + details）汇入 `src/ui/markdown.ts:174` 的 `renderer.code` 围栏覆盖，一条 markdown 管线；产物卡（PPT/XLSX/DOCX）、工具卡、任务卡是 transcript 事件驱动，**不归本库管**。
- **既有语义描述（散装第一代）**：常驻 `VISUAL_BLOCK_POINTER`（五围栏最小语法 + 落盘禁令，≈2.1k 字符）+ 意图词闸门 `detectVisualRequest`（picture/chart/map/paint 四路布尔）按需注入五段 DSL 细则（`SVG/CHART/MAP/PAINT/IMAGE_GEN`，≈8k 字符）+ 常驻 `INFORMATION_VALUE_PRINCIPLE`（能图表呈现必落图表的交付硬要求）+ `buildOutputStyle` 呈现形态纪律。
- **闸门的已知缺口**：判例注释自认「闸门漏判后果是细则缺失」；math/table/fold/image 无细则段也无闸门路由。
- **校验与降级**：无独立预校验闸，靠 hydration 前 parse（mapSpec/paintSpec/chart）+ parseRepair 失败修源重试一次 + 错误卡；回放走 transcriptProjection（实时=重放同源解析）；CLI 有 mermaid/puml ASCII 线框（cliDiagram），channel 有 mermaid/puml 降级说明（buildOutputStyle surface 分支）。

## 三、MVP 刀已落（2026-11-02）

**做什么了**：

1. `src/shared/presentationLibrary.ts`：`PresentationCard` 类型 + 首批 **11 卡 7 族**（diagram: mermaid/puml · data-viz: chart · geo: map · illustration: svg/paint · media: image_gen/image · formula: math · document: table/fold）+ `matchPresentationCards`（id→别名→族名→单 token 子串容错）+ 目录/全文渲染函数。全部来自既有实现，零新渲染器。
2. `presentation_guide` 工具：常驻可见（CORE，同 discover_tools 姿态——发现工具自己被藏起来就是死重）、注册表自持执行（`ToolRegistry.executePresentationGuide`，永不下沉 delegate）、READ/low 纯只读。无 form → 目录索引（复制 discover_tools「目录只在被搜索时进对话」模式）；命中 → 卡片全文含 detail DSL。
3. `VISUAL_BLOCK_POINTER` 尾部接发现指针一句（+≈200 字符，体量红线 9,978×105% 内实测通过）：闸门漏判的后果从「细则缺失」降级为「多一次 presentation_guide 调用」。
4. 契约测试：`presentationLibrary.test.ts`（判据两面非空 / 单源同引用 / 自有字段 ASCII / 匹配路由 / 互斥判例上锁 map-is-never-SVG、paint-never-SVG、chart-vs-table）+ `deferredTools.test.ts`（常驻可见且不入 deferred 目录 / 全卡返回 / 族拉取与别名 / 目录行为）+ `promptLayers.test.ts`（指针锚）。

**不做什么（MVP 边界）**：不动渲染管线与意图词闸门；不瘦身既有常驻段；不做投影降级器（卡片的 `surfaces` 只做声明）；不做自定义扩展。

**MVP 后增补（同日）——routing 决策卡**：三层架构图会话（paint/svg 连用而未走 mermaid）引出用户问答，固化「形式跟着用途走」的决策序列进 `routing` meta 卡（目录首位）：① 内容路由 → ② 结构图的语义重心（TOPOLOGY=边承载语义 → mermaid 自动布局；LAYOUT=版面承载语义 → paint/svg 显式坐标）→ ③ 生命周期（一次性讲给人听 → 版面控制赢；进 repo 随代码演进 → 源码式 mermaid 赢）→ ④ 读者 → ⑤ 规模闸（~30 节点）→ ⑥ 失败修正不换形式。判据写给人看（工具结果卡用户直接可见）；mermaid/paint 两卡补生命周期让位句呼应。测试锁在 presentationLibrary.test.ts / deferredTools.test.ts。

**真机二修（同日，session_1793600755798_1 判例）**：判轴对撞请求（非技术读者 + 图进 docs 长期演进）暴露两缺口——①「docs/」措辞引力把形式选择降维成「SVG 文件 vs PNG」，write_file 落盘破围栏铁律（SVG 细则在声仍破）；②拉卡触发词是主观 "unsure"，模型自信选错时永不触发。修法：routing 卡新增第 0 步（当时判「File is NOT an option」，第三刀已重写）+ 生命周期判据句补 "still a fenced block in the chat first" + 拉卡触发词客观化，工具 description 同步。对照组（9 家供应商对比）表现合格：跳过 routing 直拉 table/chart 两卡、按 chart 卡 "give both" 判据双形式交付——判据能落地，缺的是竞争场景的拉卡纪律与选项空间边界。

**第三刀：机械触发 + 双交付纪律（同日，d750ee4；复测 session_1793602596186_3 判例）**：二修后复测暴露更深的真因——第 0 步没进上下文（模型仍没拉卡），改卡是空转；同时第 0 步本身矫枉过正：用户明示「图进 docs/」时落盘是**需求的一部分**，不是违规。两刀一起落：

1. **劝导 → 机械**：两刀都在改卡内容，但卡没被拉 = 判据不在场。可靠性只能来自机械层——`detectVisualRequest` 加 `destination` 路（动词+归宿地组合如「放进/存到/归档 + docs/文档/README/仓库」、演进语义如「跟随代码演进」「长期维护」、英文 "evolving with the code" 等；裸「文档」不单独命中，阅读请求不误伤），命中即把新常量 `ROUTING_ESSENTIALS`（~750 字符精要：双交付纪律 + 判轴浓缩 + 发现指针）随既有闸门通道注入 system prompt，不分面。召回优先判例同闸门：误判只多花 token，漏判是判据缺失。铁律锚（`never file-over-fence` / `DOUBLE DELIVERY`）与 routing 卡共享，测试同锚锁死——两个载体一个口径。
2. **第 0 步重写为双交付**：「Fence first, file second」——聊天交付永远是围栏（无归宿明示时文件不是替身，铁律不变）；请求点名归宿时**交付两件**：围栏先发（渲染在聊天里、是权威版本），再把块的源码存到指定路径（repo 演进优先 mermaid 文本）。「docs/slides/README」选的是**哪种围栏形式**，永远不是用文件替代围栏。

判例沉淀：行为判据的可靠性分层——**卡（pull）管深挖，机械注入（push）管在场**；判据能否生效先问「它在不在这个请求的上下文里」，不在场的内容改一万字也是零。

**刀 2：渲染器注册化（2026-11-03，86d12d8）**：markdown.ts 的围栏分流从七处散点收敛到两张表——`FENCE_ROUTES`（tag → kind + slot 构造 + stream 布尔，围栏分流的唯一注册点）与 `KIND_PIPELINE`（kind → render+bind，hydration kick 与失败重试共用）。改查表的散点：完成渲染 `renderer.code`、流式 `streamRenderer.code`、`slotFenceLang`（查 routeOf 的 stream:true）、`normalizeMapFence` 容器正则（从 map 路由 tags 构造）、kick/retry 两处 kind 分发、PNG 导出的 target 选择器。卡注册表加 `fence` 字段（tag 全集），`fenceRegistry.test.ts` 双向同源锁（route↔卡 tag **全集相等**，单向包含会放过漂移）——加新视觉形式 = 一条 route + 一张卡，漏任何一侧测试即红。**零行为变化**：math 流式不挂 slot 栏（`stream: false` 保真）、流式与完成各自的 fallback 保留、paint 的 canvas 导出特判保留；三个源码形态锚测试随注册化更新。刀 2 是刀 3 的地基：自定义卡从此有渲染通道。

**刀 3：组合式自定义（2026-11-03，f473c9c）**：用户/agent 在 `~/.pure/config.json` 写 `presentationCards` 键（`{ id, base, ...只写想改的字段 }`）即注册自定义视觉形式。**组合式封装本意**：`{ id, base }` 就得到一张完整卡（判据/触发/交付/细则/族全继承 base），`registerCustomCards` 只覆盖显式给出的字段；自定义围栏 tag（可选 `fence`）挂 base kind 的既有渲染管线——`registerCustomFenceRoutes` 产出的路由 kind/build/stream 全部复用刀 2 静态表条目，hydration/retry 因 `data-diagram-kind` 写 base kind 天然走 KIND_PIPELINE，**零新渲染器零沙箱问题**（放弃的方案：让自定义卡带全新渲染器——那要插件加载与沙箱，而真实需求是判据与触发的运行时定制）。纪律：base 必须是内置七类围栏形式；id/tag 小写 ASCII 且不撞内置；同 id 幂等更新；逐卡拒绝不阻塞其余；新 tag 卡的 trigger 改写为 "Fenced block tagged X (rendered on the base pipeline)"。**真实源是盘上 config.json**（设置 agent 化铁律）：GUI 侧启动注册 + 回合边界活检热生效（`syncPresentationCardsFromConfig`，lastSyncKey 短路）；引擎侧 `presentation_guide` 惰性加载一次（ToolRegistry 经 `setCustomPresentationCardsLoader` 注入口收盘上读取——ToolRegistry/CodingAgent 都在 GUI 浏览器 bundle 里，静态 import cliConfig 会把 node:fs 拖进 vite 炸打包，宿主各自注册 loader：cliHarness/ui main/评测三处）；目录尾带注册说明句，agent 可语义自加卡。测试三面：卡注册表（继承/改写/拒绝/幂等/目录合入/reset 隔离）、渲染注册表（自定义 tag 走 base 管线端到端、:::容器归一、无新 tag 卡不动路由表、re-sync 三态）、引擎消费面（presentation_guide 目录含自定义卡）。

**刀 4：投影降级器（2026-11-03，34f1f87，v4.1.0）**：`src/shared/formProjections.ts` 每形式一个投影器——chart（bar/hbar/pie → ASCII 条形图，line/scatter/kline/radar/tree 系行文本已可读不投影）、map（markers+route → 清单，**吃 GUI 同款 `parseMapSource`**——为此 mapSpec 纯解析器从 ui/ 搬进 shared/，字段名零漂移）、paint（shapes → 形状清单，group 递归缩进、40 条封顶防刷屏，字段名靠 PaintShape 类型 fixture 编译期锁）。纪律承 cliDiagram 判例：解析失败一律 null 回退源码，绝不产出错图。三处接线：CLI 流式（`BUFFERED_LANGS` 分流线框/投影两通道）+ 一次性转换；渠道 `richOutput` text 降级先投影、正文围栏块替换成投影文本（`projectedText`），图片能力在时仍走 PNG；卡注册表加机器可读 `textFallback` 字段（'wireframe'/'projection'/缺省 text），与投影注册表、surfaces 文案**三方同源锁**（自定义卡继承 base）。判例：同源锁当场抓到 charts/leaflet 别名无投影的真缺口——锁的不是文档是行为。已知边界：自定义卡 tag 的文本投影不做（主表面 GUI，回退源码）。

## 四、后续刀路线

- **刀 5 常驻指针瘦身（未排期）**：发现工具兜住后，`VISUAL_BLOCK_POINTER` 的五段最小语法可下放卡片，常驻只留落盘禁令 + 发现指针（≈2.1k → ≈600 字符）。须真机复验模型在没有最小语法时的围栏命中率，勿先斩。
- **刀 6 校验真话回流（已落，f8bcfcd，2026-11-03）**：蓝图原案「卡片声明 validator 引用、渲染前跑」被简化——校验本来就发生在渲染管线（hydration parse + parseRepair），唯一缺口是**结果对模型全盲**（错误卡/badge 是纯 DOM，引擎侧零引用，同样的语法错下次照犯）。落法：markdown.ts 三个收口点（setDiagramState('error') / setMapState('error') / markDiagramRepaired）记事件 → chat.ts 每回合装配 user-turn 时读走（读即清）注入 envFacts 区——形式、修没修成、失败原因（截 120 字符），pure 只报事实不加判断（连引擎加载失败也原样报，原因归类归模型）。聚合按 lang+outcome 计数、封顶 5 行、detail 截 120；无事件零注入。**v1 无门控的裁定**：历史重渲染（切会话/编辑重发）会混入事件，但块确实失败过信息仍真，封顶兜住噪音，真机观察噪音率后再定门控。已知边界：CLI 面投影失败静默回退源码，事件回流留后续小刀；修复器无 reason 字段，repaired 事件不带细节（YAGNI）。

## 五、红线与对齐

- 人格段（character_core / expression / human_tone）不沾本库；卡内容是行为判据不是语气文案。
- 契约测试纪律：单源同引用断言、负面判据非空断言、互斥判例句 verbatim 锁、体量红线复现同款量法。
- 互斥判例的归属：`map-is-never-SVG`、`paint-never-switch-to-SVG`、`picture 让位 paint`（2026-10-17）已随卡片固化；改判据先改卡与测试，再动常驻指针。
