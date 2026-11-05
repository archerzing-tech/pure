# 表现形式包化蓝图（Presentation Pack Blueprint）

> **状态**：设计稿（2026-11-05 用户提案，已裁定可行、分期施工；**未开工**，任何一期动工前以本文为裁，开工时更新本行）。
> 提案原文：表现层+渲染层成为一种固定的包结构（类似 SKILL.md），pure 提供一个类似 create-skill 的技能用于开发这种包；用户对着 pure 说「增加一种 xxx 表现形式」即可对话内完成、不编码不编译。
> 评估口径：以 2026-11-05 实落的表现形式库五刀（MVP/刀 2 注册化/刀 3 组合式自定义/刀 4 投影降级器/刀 6 校验回流）为地基事实，见 [presentation-capability-library.md](presentation-capability-library.md)。

## 一、裁定：可行，分两期；一期是现成地基上的小刀，二期等真需求拉动

设想的实质是两件事：**包结构**（表现形式成为自包含目录单元，可分享可 git）+ **create 机制**（模型自己会造包）。拆开评估：

| 部分 | 现状 | 结论 |
|---|---|---|
| 语义层（卡：判据/触发/别名/细则） | **已运行时化**——刀 3 `config.json presentationCards` 热注册，模型可语义自加，回合边界活检生效（`syncPresentationCardsFromConfig`） | 包结构的语义层**已存在**，缺的只是「目录扫描装载」（config.json 是单点手编，目录包可分发、自带样例） |
| 渲染层（新呈现机械） | 仍在代码层；刀 3 **有意放弃**了自定义渲染器（插件加载+沙箱成本 vs 真实需求） | 一期不碰（文本形态零渲染）；二期走已验证的沙箱路线，等真需求 |
| create 机制 | 无 | 一期一份 SKILL.md（教结构+校验+自验），零新引擎 |

**成本样本（2026-11-05 ASCII 线框刀，cc1bb4b）**：加一种形式动 6 文件、被 5 个测试锁追着同步（fenceRegistry 双向同源 / textFallback 三方同源 / FENCE_IDS 清单 / stream 行为锁 / 渲染形状锚）——语义部分（一张卡）很小，成本全在渲染层实码与锁同步。这正是包化该切的界面：**语义层包化收编，渲染层分期**。

## 二、一期：文本形态包（零沙箱零 eval，现在就做）

### 包结构

```
~/.pure/presentations/<pack-id>/
  pack.json      # 必备：{ id, base, fence?, title?, aliases?, trigger?,
                 #          whenToUse, whenNotToUse, delivery?, surfaces?, textFallback? }
                 # 字段语义与 CustomCardInput 同构（presentationLibrary.ts），base 必须
                 # 是内置零渲染形式（'ascii'；将来若新增文本形态 base 在此扩）
  example.ascii  # 建议自带：自验样例（create 技能的自检材料，base 通道的围栏块）
  README.md      # 可选：给人看的说明
```

### 装载链（全部现成基建，新增仅扫描器）

1. 启动 + 回合边界活检扫描 `~/.pure/presentations/*/pack.json`（扫描器为唯一新增件，约几十行）。
2. 校验复用刀 3 既有校验：id/tag 不撞内置（`FENCE_IDS` / 别名表）、判据两面非空、base 必须内置。逐包拒绝不阻塞其余（刀 3 同纪律）。
3. 通过者喂既有 `registerCustomCards` + `registerCustomFenceRoutes` → presentation_guide 目录自动收编 → 围栏路由热生效。
4. 真实源=盘上目录（设置 agent 化铁律：现状可见/知识可查/改了真生效——`pack.json` 即现状，错误经校验拒绝原因回给模型）。

### create-presentation 技能

一份 SKILL.md，内容四段：包结构规格（引用本文）、校验清单（撞名/判据两面/JSON 合法）、自验流程（产出 example 块 → 发一个真实围栏到对话看渲染 → 失败修包）、失败行为（校验拒绝时读拒绝原因改包，不换形式硬绕）。触发时机归模型（决策边界铁律：机制只答怎么做成）。

### 一期有意不收的东西

- **`style.css` 不收**：CSS 注入 WebView 是安全面（`url()` 外联数据渗出、遮罩点击劫持）；样式由 base 决定（`ascii-frame` 内置样式，cc1bb4b）。
- **`render.mjs` 不收**：不解析不装载，仅为二期目录位预留（装载器见到即忽略并记一条真话）。
- **base 限零渲染形式**：`'ascii'` 是唯一一期 base；chart/map/mermaid 等带管线的 base 不开放包化（判据可改走刀 3 config.json 既有路）。

### 一期能兑现的愿景

「对着 pure 说『增加一种 ASCII 类的 xxx 表现形式』」→ 模型拉 create-presentation 技能 → 产包 → 自验 → 热生效：**对话内完成、不编码、不编译、不重启**。

## 三、二期：沙箱渲染器包（路线已验证，工程量大，挂账等真需求）

触发条件（满足其一再开工）：出现真实的「既有库+组合封装都表达不了」的渲染需求判例；或用户点名某外部渲染库（如 wasm 图形引擎）必须进表现形式。

- **执行环境唯一安全路 = asset:// iframe 沙箱**（html 围栏卡已验证：源码落盘 `save_artifact('card')` → asset:// 子文档加载 → 宿主 CSP script-src 管不到子文档 → 与宿主 postMessage 通讯）。
- 包结构扩 `render.mjs`：iframe 内执行，输入=围栏源码文本，输出=HTML/SVG 字符串；宿主只管生命周期与超时。
- 必须同步建的工程件：hydration 通讯协议（请求/就绪/失败三态）、错误面（渲染异常→错误卡，复用刀 6 校验回流）、降级投影（textFallback 与 FORM_PROJECTIONS 三方同源锁扩沙箱形态）、版本化（pack 带 revision，缓存失效）。
- **不做的口子：WebView 宿主文档内直接 eval 包 JS**——CSP 与安全面破口；连 pure 自己的 html 卡都为此绕了 iframe，主路径不开。

## 四、开工检查单（动工前过一遍）

1. 四分归属表（docs/decision-boundary-2026-11.md）：扫描/校验/装载=系统手脚；base 选什么、判据写什么=模型决策；pack.json schema=契约；「何时用包 vs 改 config.json」=模型裁决（技能里写判据，不写流程命令）。
2. 锁面预演：包装载的卡进 `allPresentationCards()` 后，fenceRegistry 双向锁目前只扫内置 `PRESENTATION_CARDS`——包卡与路由的同源锁要**扩到运行时视图**（否则包 tag 漂移无锁）。
3. 体量红线：create-presentation 技能不进常驻 prompt（SKILL.md 按需拉，同 presentation_guide 姿态）。
4. 真机验收：对话内造一个测试包 → 热生效 → 发围栏块 → 三面（GUI/CLI/渠道）各验一次。
