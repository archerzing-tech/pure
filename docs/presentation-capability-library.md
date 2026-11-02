# 表现形式库（Presentation Capability Library）

> **状态**：MVP 刀已落（2026-11-02，本笔）。后续刀（渲染器注册化 / 组合式自定义 / 投影降级器 / 常驻指针瘦身 / 校验前置共享）未排期。设计定调源于用户提案：展现形式抽成独立层，模型自主决策用哪种，可扩展可自定义。

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

## 四、后续刀路线（未排期）

- **刀 2 渲染器注册化**：`markdown.ts:174` 围栏分流改表驱动，与卡片注册表同源——加新视觉形式一处注册（卡 + 渲染器 + 校验器），消除「改渲染器+改提示词+改闸门+改测试」四处耦合。这是「可扩展」的工程化形态。
- **刀 3 组合式自定义**：用户/会话注册自定义卡 = 现有原语 + 参数封装（如「架构图 = paint + 主题 + 布局参数」），不引入沙箱问题；组件级自定义（真新 JS 组件）挂起。
- **刀 4 投影降级器**：`surfaces` 声明升级为机器可读接口，channel/cli 每 form 一个降级器（现状只有 mermaid/puml 有 ASCII 线框，chart/map 在 channel 是裸 JSON 文本）。
- **刀 5 常驻指针瘦身**：发现工具兜住后，`VISUAL_BLOCK_POINTER` 的五段最小语法可下放卡片，常驻只留落盘禁令 + 发现指针（≈2.1k → ≈600 字符）。须真机复验模型在没有最小语法时的围栏命中率，勿先斩。
- **刀 6 校验前置共享**：卡片声明 validator 引用（mapSpec/paintSpec/chart 已有 parse），渲染前跑、失败前置提示，替代「渲染时才发现」。

## 五、红线与对齐

- 人格段（character_core / expression / human_tone）不沾本库；卡内容是行为判据不是语气文案。
- 契约测试纪律：单源同引用断言、负面判据非空断言、互斥判例句 verbatim 锁、体量红线复现同款量法。
- 互斥判例的归属：`map-is-never-SVG`、`paint-never-switch-to-SVG`、`picture 让位 paint`（2026-10-17）已随卡片固化；改判据先改卡与测试，再动常驻指针。
