# 双腿路线图：能力供给 × 模型代际（2026-11）

> 状态：活蓝图。P0（W1a + W2a）已于 2026-11-03 落地，2026-11-04 复审通过（迁移等价性缺口已收窄修正，见第四节末行）；P1 未开工。基线与源码行号取证于 `e3a72e2`，P0 改动建立在该 commit 之上、尚未提交。
>
> 定调（用户，2026-11-03）：「pure 是一堆杂乱的工具和插件的集合，没有章法、没有规矩、只保留基本的输入、输出和做事底线和原则。至于事情怎么做、如何做、用什么做、用哪些工具做、怎么用、怎么呈现，都是大模型的事情。pure 今后两条腿走路：1）不断增强应用本身的基础能力（手脚），尽可能不要影响束缚大模型的表现；2）结合业界最新的 SOTA 模型。」

## 〇、定位修正（先把话说准，否则会往错的方向施工）

原话的方向是对的，但有三处按字面执行会伤到产品。以下是我建议的精确形态，后文一律按这个口径施工：

| 原表述 | 建议口径 | 为什么 |
|---|---|---|
| 「没有章法、没有规矩」 | **无说教，有机制**：不规定模型怎么想，只保证事情可执行、可观测、可验证、可回退 | 「零规矩」在长任务上不成立——业界（Anthropic 长时程、OpenAI Codex）都是薄 prompt + 强机制；项目自己的 framework-reform 也论证过「对弱模型不成立」。删的应该是提示词方法论与宿主语义判断，不是权限、账目、确定性自救 |
| 「一堆杂乱的工具和插件」 | **开放可生长，但一个能力一个权威入口、一份实现** | 杂乱＝种类没有上限（skill/MCP/外部工具一条注册接缝），不等于同一件事五个入口、三份实现。前者是自由，后者是让模型选错的税 + 让人加不动工具的成本 |
| 「两条腿」 | **手脚 × 模型 × 机制**，机制是第三条腿，但只能长在机制层 | pure 真正的护城河是交互智能（插话、证据循环、记账、呈现）。砍掉它 pure 会退化成普通 shell agent；正确做法是把它从「判断层」搬到「机制层」，让它不占模型的决策位 |

第四条隐含修正：「结合 SOTA 模型」≠ 支持很多 provider，而是**接入成本趋近于零 + 有度量能证明哪个模型适合哪类任务**。当前是手写代际表 + 饱和评测，这条腿实际上没接上。

## 一、判定

**pure 现在不是两条腿，是三条腿：手脚 + 模型 + 章法。** 第三条已经是代码量与常驻 prompt 里最粗的一条，而且它长在另外两条上面——宿主仍在替模型做语义判断。

三处错位，按严重度：

1. **判断权错位（最重）**：宿主管到了「怎么想」。`adaptiveControl.ts:42-46` 把策略压成 5 个枚举；`FailurePolicy` 用 retry → reflect → degrade → stop 四级梯替模型决定何时换路；`promptLayers` 的闸门族（`wantsHandsOnWorkflow`:87 / `wantsCapabilityLadder`:153 / `detectVisualRequest`:216 / `wantsDelegationMechanics`:470）用关键词猜意图再决定喂什么。对 frontier 模型是降维，对弱模型才是护栏。
2. **模型代际错位**：接入层是手写代际表——`promptBudgetDefaults` 一条 if 链、reasoning 另一份正则、vision 完全没有判定，同一模型的知识切三处。`PROVIDERS`(:373) 8 家无 Anthropic；协议只有 `openai | anthropic`（:248），**没有 Responses API**。业界模型连续升级，pure 的适配是手工的。
3. **手脚与感知错位**：卖点是「呈现」，但没有 browser / screenshot / computer-use。交付网页只能 `curl` 出一个 200，无法证明「长对了」；呈现卖出去，却没有回读自己产出的眼睛。

一句话：**离定位差三刀——把章法降级为可选能力、把判断权还给模型、把模型接入从手工改成自描述；能拉开差距的是补上「看见自己产出」这一只眼。**

## 二、基线（2026-11-03 实测，附录可复现）

| 事实 | 数值 | 状态 |
|---|---|---|
| 一句「你好」的常驻输入 | **8,358 tk**（system 18,142 字符 + 核心工具 schema 3,294） | 未变 |
| 全工具表的常驻输入 | **12,811 tk**（工具 7,747；P0 给 sys_info 描述加能力句后 +48） | 略增 |
| 内置工具规模 | 30 个 / 7,702 tk，最长单条 708 tk（`switch_package_source`）；`generate_image` 条件注册 | 未变 |
| 核心常驻工具集 | `CORE_TOOL_NAMES` 12 个名字（`toolDefs.ts:442`），实际常驻 def 11 个 | 未变 |
| 工具执行实现份数 | **3**：`src-tauri/src/lib.rs` 19,728 行 + `NodeToolAdapter` 4,731 + `TauriToolAdapter` 2,472 | 未变（P2） |
| 模型能力知识位置 | 预算 if 链 + reasoning 正则 + 视觉无判定 = 三处 | **已改**：单一 manifest（P0） |
| 内置 provider | 8 家，无 Anthropic；无 Responses 协议 | 未变（P1） |
| eval 基线区分度 | **0**：DeepSeek v4-flash / deepseek-flash / NVIDIA nemotron / GLM-5.3-flash 全部 15/15 | 矩阵未变，过程指标已具备（P0） |
| 能力探测深度 | 仅连通性（`/models` 2xx）；Rust `probe_llm_endpoint`(`lib.rs:417`) | 未变（P1） |
| 自进化闭环 | 复用 ≥2 → 建议卡 → 用户点头 → 起草试跑 → **下一会话生效**（`toolSolidification.ts:24`） | 未变（P3） |

数字指向同一件事：**固定成本花在「教怎么想」，可变能力花在「三份实现」，而模型代际靠人肉追。**

## 三、五个工作流

### W1 · 模型能力层：从「正则猜」到「manifest + 自探测」

**P0 已落（W1a）**：`src/shared/modelCapabilities.ts` 成为预算 / 推理 / 视觉三类知识的单一起源——有序规则表（每条带 id）、`resolveModelCapability()` 统一查询、`modelCapabilitySummary()` 的一行 ASCII 摘要。`providers.ts` 的 `promptBudgetDefaults` 与 `isReasoningModelName` 改为查表；`sys_info` 的预算现状行从此带上 `capabilities: rule=… reasoning=… vision=…`，模型不必再猜自己有什么能力。

顺手修掉一处既存矛盾：`ollama` / `lmstudio` 上的模型原来会被模型名族先命中（`qwen2.5-coder:7b` 拿到 262k 预算），与注释「本地运行时 stay conservative」相反；manifest 把「本地运行时」排到规则表最前——provider 是主机事实，优先于模型命名。这是 P0 里唯一的**行为变化**。

**P1 剩余（W1b）**：

1. **自探测**：manifest 未声明时，首次连接做一次有界探测（`/models` + 一次极小请求），结果作为覆盖缓存；`llmProbe.ts` 的形状可复用，不新建通路。探测必须有界、可关、按模型缓存。
2. **Anthropic 内置**：不是缺 adapter（`DeepSeekAnthropicAdapter` 与 `protocol: 'anthropic'` 都在），缺的是 provider 条目。落地要同步 i18n 与 `index.html` 的 option，且 `providers.test.ts` 现在断言 `PROVIDERS` 长度 = 8——三处同步 + 改测试，所以不进「零风险」的 P0。
3. **Responses 协议**：`LLMProtocol` 增加 `responses`，按模型能力选择；缺能力时降级回 chat-completions 而不是报错。必须真机验证，不能凭文档写。
4. **能力事实的送达位置**：P0 把能力现状挂在 `sys_info`，而它是 deferred 工具——模型很可能永远不会去问。P1 要定一件事：是在首个回合按已知模型注入一行 ability 事实（会动缓存前缀，需权衡），还是等「图片附件 / 推理参数」这类具体事件把它推到模型眼前。现状是「能力可查」，不是「能力可见」。

**判据**：模型升级不改 TS；未知模型不再静默落 32k，而是探测或明确告警。

### W2 · 度量：把饱和矩阵换成有区分度的矩阵

**P0 已落（W2a）**：报告新增可选 `process` 块（`codingTaskProcessMetrics`）——平均回合、平均工具调用、通过一题的工具调用与 prompt token、缓存命中率、被上限打断的题数。`compareSuiteReports` 增加可选 `process` 对比，**只在两份报告都带该块时出现**：旧报告没有它，硬比会把「没记录」读成 0，造出假的效率提升。

**P1 剩余（W2b）**：

1. **难度分层**：15 fixture 之外补「长时程 + 多文件 + 需自我验证」的硬 fixture，把 frontier 之间的差距重新拉开。
2. **矩阵扩列**：Claude 与 GPT-5 官方各一列（依赖 W1b 的内置 provider）。
3. **发布门**：`eval:compare` 进发布流程，CHANGELOG 写数字；`sanity` / `full` 两档控制成本。

**判据**：矩阵最高-最低 ≥ 2 个 fixture；报告含过程指标；连续两个版本的 compare 有变化可读。

### W3 · 执行器归一（决策点 D1，需拍板）

**现状证据**：加一个工具要改 Rust + Node + Tauri 三处，三端各测。这不是「不会写工具」，是「写一个工具的成本乘三」。

**候选**（二者取一，不建议长期并存）：
- **A. TS 单执行器**：Rust 只留不可替代部分（API key 中转、path policy、沙箱、原生系统能力），工具逻辑统一走 TS。
- **B. 单执行器 daemon**：GUI / CLI / 渠道共连一个本地执行器，口径复用 [remote-office-bridge](remote-office-bridge-design.md)，Rust 退化为壳。

**取舍标准**：冷启动与内存、权限模型复用度、GUI/CLI 一致性测试可维护性、离线可用性。建议倾向 B（与 S3 缓行项合并，一次解决两件事），但 A 改造面更小。**需要拍板，不在本文替你定。**

### W4 · 视觉闭环：让 agent 看见自己的产出

**现状证据**：`headlessChrome` 只服务渠道位图，模型不可调用；无 browser / screenshot / DOM 交互 / computer-use。呈现是枚举 DSL，模型只能在给定形态里选，且无法回读渲染结果。

**方案**：
1. `browser`（navigate / click / type / evaluate / screenshot）与 `screenshot`（页面 / URL / 本地文件 → 可进模型的图像）。
2. 截图作为 image 块进入下一轮上下文（`openai/mapping.ts` 与 Anthropic 路径已有 image 支持，只需接上来源）。
3. 呈现逃生舱：枚举 DSL 之外允许任意 HTML/JS 卡片（standalone .html 已能渲染成 live card），允许截图自检。
4. 安全面不新增：本地 headless，不开放外部调试端口，SSRF / 私有地址拒绝沿用 `netGuard` / `path_policy`。

**判据**：「改 → 截 → 判 → 修」在无人提示下跑通。

### W5 · 判断权归还：章法降级为可选能力

**现状证据**：见第一节的 5 维枚举、四级失败阶梯、四族意图闸门。与 framework-reform 四期是交叉关系：**常驻瘦身 / 工具 deferred / 形态归还归它**，本文只补它没列的两项——策略枚举与失败阶梯的裁决权。

**方案**：
1. **枚举 → 事实**：五维不再「选档」，改为陈述环境事实（有 verifier / 有 workspace / 最近失败 / 可用角色），由模型决定探索与委派。
2. **阶梯 → 自救**：`FailurePolicy` 只留确定性动作（schema 一振剥、4xx 分流、重复调用拦截、429 退避）与失败事实注入；路线裁决交模型。
3. **正则闸门 → 自取**：四族闸门改按需自取（`presentation_guide` / `discover_tools` 已是正确样式），先跑「路由 vs 旧正则」影子对照，覆盖率达标再删。

**判据**：宿主语义正则 ≤ 5 处（豁免不计）；A/B 对照任务完成率不回退。

## 四、P0 落地记录（2026-11-03）

| 文件 | 改动 | 性质 |
|---|---|---|
| `src/shared/modelCapabilities.ts` | 新增：预算规则表（10 条，含本地运行时前置）、推理白名单、视觉已知支持表、`resolveModelCapability` / `modelCapabilitySummary` | 新模块 |
| `src/shared/providers.ts` | `promptBudgetDefaults` / `isReasoningModelName` 改查 manifest；`promptBudgetLiveLine` 追加 `capabilities:` 段 | 去正则 |
| `src/shared/toolDefs.ts` | `sys_info` 描述补「能力判定（reasoning / vision，unknown 不写成 unsupported）」 | 送达 |
| `src/shared/__tests__/modelCapabilities.test.ts` | 新增：规则顺序、族/代际、provider-only 查询、白名单 vs 已知支持（unknown 不是 false）、ASCII 摘要 | 新测试 |
| `src/shared/__tests__/providers.test.ts` | 补 live line 的 capability 断言 | 测试 |
| `src/evaluation/codingTaskBaseline.ts` | 新增 `CodingTaskProcessMetrics` + `codingTaskProcessMetrics()`，suite 报告挂可选 `process` | 新指标 |
| `src/evaluation/reportCompare.ts` | `ReportComparison` 加可选 `process` 块（两边都有才比） | 新读数 |
| `src/evaluation/__tests__/processMetrics.test.ts` | 新增：只聚合有读数的题、缺读数不稀释、旧报告不产生假 delta | 新测试 |
| `src/shared/modelCapabilities.ts` | 复审修正（2026-11-04）：glm / qwen / moonshot / minimax / claude 五条规则的 provider 侧从 eitherIncludes 子串放宽收窄回旧链口径（providerIn 精确 id；providerIncludes 仅显式厂商词根 anthropic）。放宽会让 openrouter 上的 moonshot-v1-8k（真实 8k 窗口）拿到 262k 默认——预算错配的代价是每个请求超限失败，比「没默认值」贵；自定义 provider 的空档由 W1b-1 探测填，不靠猜名字 | 等价性回归 |
| `src/shared/modelCapabilities.ts` | 数据编辑（2026-11-04，独立笔）：补已退役 moonshot-v1 系的预算档（`moonshot-v1-legacy` 规则，8k/32k/128k 三档 + 无尺寸变体落最小档）。窗口数字由模型 id 自描述（厂商策展命名硬事实），与被禁的 provider 名猜测是两种证据类型——收窄收的是证据类型，不是覆盖范围。现行定价页（.ai/.cn 双站核实）只剩 K2/K3、v1 规格表随页下架，输出上限按窗口一半保守预留（多预留只压紧输入，方向安全）；这批老模型至今挂在 openrouter 等网关，是收窄制造的真实空档 | 数据编辑（非猜测） |

**验证**：`bun run typecheck` 通过；`bun test src/shared/__tests__ src/evaluation/__tests__` = 1301 pass / 0 fail；`bun run lint:conventions` 通过。

**有意留在 P1 的两件事**：自探测（要发请求、要接调用面）、Anthropic / Responses（要真机验证 + PROVIDERS 长度断言 + i18n/index.html 同步）。P0 的边界是「零网络、零 UI 改动」。

## 五、分期

| 期 | 内容 | 为什么这个顺序 |
|---|---|---|
| **P0**（已落） | W1a 能力 manifest + 现状可见；W2a 过程指标 | 零网络、零 UI、可测，先把「模型知识」和「度量口径」的地基打好 |
| **P1**（v4.3） | W1b 自探测 + Anthropic 内置 + Responses；W2b 硬 fixture + 官方列 + 发布门 | 两者互为前提：W1b 的收益只能靠 W2b 证明，W2b 扩列依赖 W1b 的 provider。做完这条腿才能自我证伪 |
| **P2**（v5.0） | W3 执行器归一（D1 拍板）+ W4 视觉闭环 | 都碰执行层与安全面，合并推进共用一次回归；W4 验收复用 W2 的呈现指标 |
| **P3**（v5.x） | W5 判断权归还 + 自进化收口 | 依赖前几期把度量与执行器稳住，否则「删规矩」无法对照验证 |

自进化收口：`toolSolidification` 现在是「建议 → 点头 → 下一会话生效」，缺采纳后的效果归因与自动回滚。`strategyEffect` 已有按策略维度的聚合，把「固化后的工具是否真的减少了调用数/失败率」接进去才算闭环。

## 六、不变量（全程不许破）

1. **底线与原则归宿主**：权限四模式、可逆性、审计、账不平不收工、失败事实诚实上报——这是产品契约，不是「教模型做事」。
2. **人格红线**：`character_core` / expression / `human_tone` 不删不改写。
3. **缓存纪律**：常驻区稳定渲染序；动态内容只走消息层与分区 diff。
4. **呈现领先不许回退**：渠道降级、富输出光栅化、可视化 DSL 是领先项；W4 是加逃生舱，不是替换现有形态。
5. **安全面不扩张**：browser 复用既有 `netGuard` / `path_policy` / 沙箱判定。

## 七、验收口径

| 指标 | 现状 | 目标 | 测量 |
|---|---|---|---|
| 一句问答常驻输入 | 8,358 tk | ≤ 4,000 tk | PromptAssembler 实测（附录） |
| 模型能力知识位置 | **1 处（P0 已落）** | 1 处 + 自探测覆盖未知模型（P1） | 源码 |
| 新模型接入触点 | 3 处代码 → **1 条规则（P0 已落）** | 0（仅配置，P1 自探测后） | diff 检查 |
| 能力可查询 | **窗口 / 推理 / 视觉三项（P0 已落）** | 再补 parallel tool calls / image gen（P1） | `resolveModelCapability` |
| 新工具接入触点 | 3 处（Rust/Node/Tauri） | 1 处（P2） | diff 检查 |
| eval 区分度 | 0（全 15/15） | 最高-最低 ≥ 2 fixture（P1） | `eval:compare` |
| 过程指标 | **6 项入报告（P0 已落）** | 进发布门（P1） | 报告字段 |
| 视觉自检闭环 | 无 | ≥ 80%（3 样例，P2） | 验收脚本 |
| 宿主语义正则 | 4 族闸门 + 其它 | ≤ 5 处（P3） | 源码计数 |
| 自进化效果归因 | 无 | ≥ 1 个策略维度可归因（P3） | 进化面板 |

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| manifest 规则与厂商文档漂移 | 规则带 id，live line 显示命中哪条；测试钉住每族关键值，改数据必须同时改测试 |
| 自探测产生额外请求/费用 | 有界（超时 + 单次极小请求）、按模型缓存、可关；失败回落保守档并告警 |
| 执行器归一破坏桌面端 | 先影子对比（双跑同输入比结果）再切换；契约测试覆盖每个工具的形状 |
| 删阶梯后弱模型方差变大 | 只删「裁决」，保留确定性自救；弱模型靠机制护栏不靠说教 |
| browser 引入 SSRF / 本地文件面 | 私有地址拒绝、路径策略复用、只起本地 headless、不给外部调试端口 |
| 评测成本上升 | sanity / full 两档；full 只在发布门跑 |
| 缓存击穿（动态装配增多） | 不变量 3 硬约束 + 每期真机对照看缓存命中率 |

## 九、明确不追

沿用 2026-09-17 决策：云端托管平台、自研 IDE、榜单刷分、多租户、自研模型；安全/权限加固类全项（skills 签名、跨平台沙箱、MCP 投毒扫描、滥用拒绝策略）——W4 的浏览器不构成例外，因为它复用既有安全面。

## 十、与既有文档的关系

- [framework-reform-2026-11](framework-reform-2026-11.md)：管「少教」。W5 与它交叉但不重复——常驻瘦身、工具 deferred、形态归还归它；本文只补策略枚举与失败阶梯的裁决权。
- [差距分析（截至 2026-10）](差距分析：pure%20与主流%20Agent（截至%202026-10）.md)：管「与主流对比」。本文管「与自身定位对比」，坐标系不同，结论并存。
- [capability-self-extension-design](archive/capability-self-extension-design.md)：自进化的设计口径。P3 的收口是它的补完。

## 附录 · 复现基线

在仓库根目录执行（`tmp/` 已在 .gitignore，脚本用完可删）：

```bash
cat > tmp/measure-prompt.ts <<'EOF'
import { PromptAssembler } from '../src/shared/PromptAssembler';
import { BUILT_IN_TOOL_DEFS, CORE_TOOL_NAMES } from '../src/shared/toolDefs';
const core = BUILT_IN_TOOL_DEFS.filter((d) => CORE_TOOL_NAMES.has(d.name));
for (const tools of [core, BUILT_IN_TOOL_DEFS]) {
  const a = new PromptAssembler().assemble(
    { surface: 'cli', capabilities: '', toolDefinitions: tools as never, hasSubagents: true, mode: 'yolo' },
    '你好',
  );
  console.log(tools.length, a.budget.estimatedInputTokens, a.budget.estimatedToolTokens, a.systemPrompt.length);
}
EOF
bun run tmp/measure-prompt.ts
```

2026-11-03 在 `e3a72e2` + P0 上输出：`11 8358 3294 18142` / `30 12811 7747 18142`（第一列 = 传给 assemble 的 tool defs 数：核心 11、全量 30，均不含条件注册的 `generate_image`）。换请求文本复测时，问答轮会因 `wantsHandsOnWorkflow` 闸门少带 workflow 段（实测「解释一下这个函数」= 7,837 tk）——常驻量本身取决于正则闸门，正是 W5 要拆的东西。
