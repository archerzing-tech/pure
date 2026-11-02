# 通道投影设计（让 IM 里看到的内容与桌面端一致）

> 状态：**已实现**（`src/channels/projection/`），验收 `bun run verify:channel-projection`
> 相关：`channel-gateway-design.md` §7（输出渲染）、`cn-im-channels.md`（三家通道）

## 1. 问题

通道（飞书 / 钉钉 / webchat）默认只发**文本**。桌面端 GUI 里一条回答是：markdown 排版 +
语法高亮的代码块 + 表格 + 内联图表（mermaid / PlantUML / echarts / svg）。同一句话在两边
长得完全不一样，用户在 IM 里看到的是「另一个人转述过的版本」。

目标：**通道里看到的内容，和桌面端看到的一样**。表现层一致，交互可以少 —— 客户端上的
点击编辑、放大缩小这些桌面端专属能力可以不要。

## 2. 契约（已拍板的产品选择）

| 维度 | 选择 | 理由 |
|:---|:---|:---|
| 一致性粒度 | **正文原生 markdown + 富元素同管线截图** | 段落/列表走平台原生：可复制、可搜索、链接可点。代码块/表格/图表走截图：这些正是平台 markdown 表达不了的东西 |
| 主题 | **固定浅色** | IM 聊天背景普遍是浅色，深色卡片很突兀；也与飞书/钉钉默认皮肤一致 |
| 交互 | **完全只读** | 截图天然失去可点性；截图前还会拆掉复制/保存按钮与图表控制条 |

「富元素」的判定是 `blocks.ts` 的 `rich` 类：fenced code block（任意语言，含
`chart` / `svg` / `mermaid` / `puml`）与 GFM 表格。其余是 `text`。

## 3. 为什么是「同一套渲染管线 + 真浏览器截图」

2026-09 的现状（调研过一遍）：

- **真浏览器渲染仍是保真天花板**。`html2canvas` / `snapdom` 那一类在 JS 里重实现渲染引擎，
  clip-path、字体、阴影都有偏差；`satori` 快，但只吃 JSX + 自己的样式子集，
  复用不了现有的 `styles.css`。
- 仓库里已经有「系统 Chrome + `--headless=new` + 裸 CDP」的既定模式
  （`src/channels/rasterize/headlessChrome.ts`，前面那批脚本一直在用），
  也有 `Bun.build` 运行时打包浏览器 bundle 的接缝（`rasterize/browserBundle.ts`）。

于是最省、也最忠实的做法是：**把桌面端自己的渲染管线搬进 headless 页面**。

```
src/ui/markdown.ts（marked + hljs + DOMPurify + mermaid + echarts + plantuml）
src/ui/styles.css（桌面端样式原文）
桌面端 DOM 层级（#app-shell → #main → #view-container → #chat-view → main#chat
                 → .bubble-row.assistant > .bubble）
```

实测：`Bun.build` 把 `markdown.ts` 打成浏览器 IIFE 是 **10.7MB / 729ms**，注入后按
桌面端列宽渲染再用 `Page.captureScreenshot` 截元素区域。

**关键收益**：这里没有「把样式翻译成另一套」的部分。图就是那块 DOM 的截图，
桌面端改样式，通道跟着变，不存在两套视觉慢慢漂移的问题。

## 4. 数据流

```
回答 markdown
  └─ blocks.ts: splitAnswerIntoBlocks()  →  [text?, rich?, text?, …]
       ├─ text  → 平台原生 markdown（一条消息）
       └─ rich  → browserProjection.render() → 桌面端同款 PNG → 图片消息
  └─ projection.ts: projectAnswer()      →  OutboundMessage[]（按原顺序，最后一条 final）
       └─ agentSession.deliverFrame() 逐条投递（图片帧 text 为空）
            └─ 适配器：空文本帧只发附件，不发空卡片/空消息
```

投影**优先于** `richOutput`：投影不可用（没 Chrome / 长块超限 / 通道发不了图）时，
回落到 `richOutput` 的图表降级路径；再不行就是纯文本。`projectAnswer` 返回 `null`
表示「这次不该走投影」，调用方走原路 —— 所以纯文字回答不会白白启动一次浏览器。

### 4.1 分块规则（`blocks.ts`）

- fenced code（``` / ~~~ / 更长的围栏都认）→ `rich`
- GFM 表格（表头 + 分隔行 + 连续 `|` 行）→ `rich`
- 其余按行累积成 `text`，相邻文本合并（少发几条消息）
- 空行只是分隔，不产生独立块

### 4.2 尺寸与硬约束

- 桌面端聊天列宽 = `#chat` 的 `max-width: 1120` − 两侧 `padding: 48` = **1024 CSS px**。
  投影页用 `frameOverrideCss()` 把这列显式钉住（投影页没有侧栏，不能指望 app 布局定宽），
  默认 **2× 出图 → 2048px**。
- **Chromium 有一处硬限制**：截图高度超过 **8192px** 会损坏（超出的部分变成左上角像素
  重复，见 chromium issue 40724721）。所以出图前先按 2× 试，太高退回 1×，
  仍然过高就**拒绝渲染并让这块退回文本源码** —— 宁可不截，也不给一张坏图。

### 4.3 只读投影

- `data-theme="light"` 固定浅色（`isDark()` 读的就是这个属性）。
- 截图前执行 `STRIP_INTERACTIVE`：移除 `button`、`.diagram-controls`、`.code-copy-btn`
  等一切交互件。视觉不变，可点性归零 —— 正是「表现一样、去掉交互」。
- 量尺寸前 `await document.fonts.ready`，否则字体切换会改变换行与高度。

## 5. 与降级矩阵的关系

| 层 | 触发条件 | 结果 |
|:---|:---|:---|
| 通道投影（首选） | 有 Chrome + 通道能发图 + 回答含富块 | 富块 = 桌面端同款 PNG；正文 = 原生 markdown |
| `richOutput`（回落） | 投影不可用，但通道能收图 | 图表用各自的光栅化器出图（resvg / headless），正文保留源码 |
| 纯文本（兜底） | 通道发不了图，或某块渲染失败 | 源码留在正文里（失败的富块**并回**前后文本，合成一条连续回答） |

失败永远不丢内容：渲染失败 / 图片过大 / 渲染页不可用，都把源码放回正文并附一句说明。

## 6. 验证

`bun run verify:channel-projection`（真 Chrome、真管线、真截图）：

1. 渲染页自身：代码块 → 2048×N PNG；
2. 端到端：一条含正文 + 代码块 + 表格 + mermaid 的回答 → 恰好 3 张 PNG，均为 2048px 宽；
3. 最终卡片保留正文「这是结论。」，且**不再出现** ```ts / ```mermaid 源码；
4. 只发图的帧不产生空文本卡片；
5. 顺序是 `文本 → 图 → 图 → 图`。

`--out <dir>` 会把三张图落盘，供人工对一眼「和桌面端像不像」。

## 7. 反方论证与风险

| # | 质疑 | 回应 |
|:---|:---|:---|
| P1 | 为什么不整条回答截一张长图？那才最像。 | 文字会失去可复制/可搜索/可点链接；且 8192px 硬限制下长回答必然要切，切成几条长图比「原生文本 + 富块图」更难读。产品选择是「正文原生」。 |
| P2 | 为了几张图，在用户机器上跑浏览器值得吗？ | 不下载浏览器（用系统 Chrome）、懒启动、空闲 5 分钟关闭；没 Chrome 就整层降级。见 `headlessRenderer.ts` 的同类取舍。 |
| P3 | 10.7MB 的 bundle 注入会不会太慢？ | 一次性成本，实测打包 729ms、首次出图约 3 秒；之后同页复用。相比之下「两套视觉慢慢漂移」的维护成本更高。 |
| P4 | 截图里的字号/字体与用户桌面端窗口宽度不同怎么办？ | 列宽是显式钉住的 1024，与桌面端 `#chat` 的最大列宽一致；字号来自同一份 CSS 变量，不随窗口缩放（`max-width` 是上限不是当前宽度）。窄窗口时桌面端会换行，投影保持最大列宽 —— 这是有意的：图要一份稳定的排版。 |
| P5 | 图发到 IM 后用户想复制代码怎么办？ | 已知代价。产品选择是「完全只读」；需要可复制时回桌面端。曾考虑过「代码块另发一条原生 code block」，被产品选择否掉了。 |

## 8. 未决 / 后续

- **图片数量上限**：一条回答有很多代码块时会连发多张图，可能触发平台频控。
  当前没有合并策略；真实使用后按需加「相邻同色块合并」或节流。
- **编译产物的样式内嵌**：`styles.css` 目前是 `readFileSync` 读盘（dev 与常规运行都成立）。
  若将来 CLI 打成单文件二进制，需要改成 `with { type: 'file' }` 内嵌。
- **GUI 里的通道预览**：在桌面端直接看「这条消息在通道里长什么样」，是可验证性的自然补强，尚未做。
- **```` ```map ```` 等需要网络的重块**：投影页里会走各自的渲染路径；离线时按既有降级处理，未专门优化超时。
