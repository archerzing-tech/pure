# 双腿路线图：能力供给 × 模型代际（2026-11）

> 状态：活蓝图。P0（W1a + W2a）已于 2026-11-03 落地，2026-11-04 复审通过（迁移等价性缺口已收窄修正，见第四节末行）；P1 进行中——W1b-2 / W1b-1 / W1b-4 / W2b-3 / W2b-1（首两 fixture）/ web 信噪比刀已落，见「四之二」，余 W1b-3 / W2b-2 / W2b-1 尾巴（长时程 fixture）全被真机或真实 key 阻塞；**P2 进行中（2026-11-04）：D1 拍板=A（TS 单执行器）；P2-1 git 归一 + P2-2 browser 工具已落并随 v4.1.3 发布，P2-3 截图进上下文 + P2-4 呈现逃生舱已落（W4 视觉闭环 W4-1/2/3 代码侧全落，判据真机验收留用户）+ 本地无 key API 服务插刀已落；P2-5 起步=劫持检测跨语言双锁已落，web_search 执行单源化 + 公共 API 解析器收敛 + path_policy 注入点上移三子刀收官（Rust web 栈编排/解析器全退役只留守 scrape 链与三原语；路径解析链归 TS 单源+行为锁钉住 GUI 侧），**P2-5 全部落地**。基线与源码行号取证于 `e3a72e2`。
>
> 定调（用户，2026-11-03）：「pure 是一堆杂乱的工具和插件的集合，没有章法、没有规矩、只保留基本的输入、输出和做事底线和原则。至于事情怎么做、如何做、用什么做、用哪些工具做、怎么用、怎么呈现，都是大模型的事情。pure 今后两条腿走路：1）不断增强应用本身的基础能力（手脚），尽可能不要影响束缚大模型的表现；2）结合业界最新的 SOTA 模型。」
>
> 表述定稿见 [pure-positioning-2026-11](pure-positioning-2026-11.md)：那份管「怎么把定位说准、什么算走偏」，本文管施工口径；表述冲突以定稿文档为准，施工与基线以本文为准。本节〇的定位修正仍逐条有效。

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
| 内置 provider | 8 家，无 Anthropic；无 Responses 协议 | **已改**：9 家含 Anthropic（P1 W1b-2）；Responses 协议未变（P1） |
| eval 基线区分度 | **0**：DeepSeek v4-flash / deepseek-flash / NVIDIA nemotron / GLM-5.3-flash 全部 15/15 | 矩阵未变，过程指标已具备（P0） |
| 能力探测深度 | 仅连通性（`/models` 2xx）；Rust `probe_llm_endpoint`(`lib.rs:417`) | **已改**：`/models` 元数据解析窗口与输出上限（P1 W1b-1） |
| 自进化闭环 | 复用 ≥2 → 建议卡 → 用户点头 → 起草试跑 → **下一会话生效**（`toolSolidification.ts:24`） | 未变（P3） |

数字指向同一件事：**固定成本花在「教怎么想」，可变能力花在「三份实现」，而模型代际靠人肉追。**

## 三、五个工作流

### W1 · 模型能力层：从「正则猜」到「manifest + 自探测」

**P0 已落（W1a）**：`src/shared/modelCapabilities.ts` 成为预算 / 推理 / 视觉三类知识的单一起源——有序规则表（每条带 id）、`resolveModelCapability()` 统一查询、`modelCapabilitySummary()` 的一行 ASCII 摘要。`providers.ts` 的 `promptBudgetDefaults` 与 `isReasoningModelName` 改为查表；`sys_info` 的预算现状行从此带上 `capabilities: rule=… reasoning=… vision=…`，模型不必再猜自己有什么能力。

顺手修掉一处既存矛盾：`ollama` / `lmstudio` 上的模型原来会被模型名族先命中（`qwen2.5-coder:7b` 拿到 262k 预算），与注释「本地运行时 stay conservative」相反；manifest 把「本地运行时」排到规则表最前——provider 是主机事实，优先于模型命名。这是 P0 里唯一的**行为变化**。

**P1 剩余（W1b）**：

1. ~~**自探测**~~：**已落（W1b-1，2026-11-04，见「四之二」）**。
2. ~~**Anthropic 内置**~~：**已落（W1b-2，2026-11-04，见「四之二」）**。
3. **Responses 协议**：`LLMProtocol` 增加 `responses`，按模型能力选择；缺能力时降级回 chat-completions 而不是报错。必须真机验证，不能凭文档写。
4. ~~**能力事实的送达位置**~~：**已落（W1b-4，2026-11-04，见「四之二」）**。

**判据**：模型升级不改 TS；未知模型不再静默落 32k，而是探测或明确告警。

### W2 · 度量：把饱和矩阵换成有区分度的矩阵

**P0 已落（W2a）**：报告新增可选 `process` 块（`codingTaskProcessMetrics`）——平均回合、平均工具调用、通过一题的工具调用与 prompt token、缓存命中率、被上限打断的题数。`compareSuiteReports` 增加可选 `process` 对比，**只在两份报告都带该块时出现**：旧报告没有它，硬比会把「没记录」读成 0，造出假的效率提升。

**P1 剩余（W2b）**：

1. **难度分层**：15 fixture 之外补「长时程 + 多文件 + 需自我验证」的硬 fixture，把 frontier 之间的差距重新拉开。**首两件已落（2026-11-04，见「四之二」：自我验证约束网 + 跨模块契约传播，独立 frontier 套件）**；**长时程（staged migration）留作下一个内容增量**——等 W2b-2 的真实区分度读数决定它要不要按现在的形状写。
2. **矩阵扩列**：Claude 与 GPT-5 官方各一列（依赖 W1b 的内置 provider）。
3. ~~**发布门**~~：**已落（W2b-3，2026-11-04，见「四之二」）**。

**判据**：矩阵最高-最低 ≥ 2 个 fixture；报告含过程指标；连续两个版本的 compare 有变化可读。

### W3 · 执行器归一（~~决策点 D1，需拍板~~ → **已拍板（2026-11-04）：A**）

**现状证据**：加一个工具要改 Rust + Node + Tauri 三处，三端各测。这不是「不会写工具」，是「写一个工具的成本乘三」。取证补强（2026-11-04 全量盘点，见「四之三」）：定义已单源（`toolDefs.ts` 30 工具 + `ToolRegistry` 权限标签层），执行三份——NodeToolAdapter 4743 行 / TauriToolAdapter 2438 行 / Rust 101 个 command（其中 ~60 个是可搬 TS 的纯工具逻辑）；8 处行为分叉今天就在漂（web_search 后端 10 vs 20、劫持正则手工镜像、公共 API 解析器 1318 vs 757 行、execute_command 沙箱只 GUI 有、git 参数拼装两份……）。

**候选**（二者取一，不建议长期并存）：
- **A. TS 单执行器**：Rust 只留不可替代部分（API key 中转、path policy、沙箱、原生系统能力），工具逻辑统一走 TS。
- **B. 单执行器 daemon**：GUI / CLI / 渠道共连一个本地执行器，口径复用 [remote-office-bridge](remote-office-bridge-design.md)，Rust 退化为壳。

~~**取舍标准**：冷启动与内存、权限模型复用度、GUI/CLI 一致性测试可维护性、离线可用性。建议倾向 B（与 S3 缓行项合并，一次解决两件事），但 A 改造面更小。**需要拍板，不在本文替你定。~~

**D1 裁定：A（TS 单执行器）；B 不否决，降级为 A 落稳后的可选第二阶（届时与 S3 拍板合并考虑）。** 理由四条：

1. **B 的「现成通道」不存在**（取证推翻主要想象）：GUI 主聊天完全不经过 sidecar——引擎跑在 WebView、工具走 Tauri IPC、LLM 走 RustLLMAdapter；sidecar 唯一角色是 gateway spawn。选 B 起步成本=进程模型搬家，remote-office-bridge 文档自己计价「最大的一步」且 GUI 新增 daemon 运行时依赖（新故障形态「GUI 降级提示而非假死」）。
2. **A 的切面比表面小**：不可替代面恰好=候选 A 写的清单（key 中转/secret_*/spawn_mcp+oauth/进程流+进程组+Seatbelt/gateway spawn/系统能力）；其余 ~60 个 command 是可搬 TS 的纯工具逻辑。归一后 Rust 从「每工具一个 command」退化为「每原语一个 command」（fs/spawn/fetch/TCP 等约 15 个）+ 不可替代面。
3. **取舍四条逐项过**：冷启动与内存——A 零新增进程（引擎本在 WebView、CLI 本是 bun 进程），B 要常驻 daemon；权限复用与一致性测试——两者同收益（单源后 8 处分叉机械消失）；离线——A 全本地不变，B 多一个 daemon 依赖面。B 唯一净赢是省一次冷启动，不足以抵进程模型风险。
4. **捆绑是负收益**：本文原写 B「与 S3 合并一次解决两件事」，但 S3 的结构动机（消灭双主 V2）与工具成本正交——remote-office-bridge 已写明 S1/S2 不做 S3 也完成全部结构收益。捆绑的真实效果是一次回归承担两个最大手术，与「共用一次回归」的初衷（W3/W4 都碰执行层）相反。**A 是 B 的必经第一阶**：daemon 化时该搬的是已单源的执行器，不是两份 adapter。

**A 的落地形态**（取证修正后的精确表述）：工具实现单源在新 TS 层（`src/tools/impl/`），两个 adapter 退化为「运行时原语注入」——fs（node:fs vs Rust IPC）、spawn（child_process vs execute_command IPC）、fetch（undici vs Rust fetch 原语）、TCP（node:net vs Rust 探针原语）。归一优先级：web 栈（漂移面最大：后端集并、劫持检测单源、解析器收敛）→ 文件类工具（path_policy 注入点上移 TS 单源）。

### W4 · 视觉闭环：让 agent 看见自己的产出

**现状证据**：`headlessChrome` 只服务渠道位图，模型不可调用；无 browser / screenshot / DOM 交互 / computer-use。呈现是枚举 DSL，模型只能在给定形态里选，且无法回读渲染结果。

**方案**：
1. `browser`（navigate / click / type / evaluate / screenshot）与 `screenshot`（页面 / URL / 本地文件 → 可进模型的图像）。
2. 截图作为 image 块进入下一轮上下文（`openai/mapping.ts` 与 Anthropic 路径已有 image 支持，只需接上来源）。
3. 呈现逃生舱：枚举 DSL 之外允许任意 HTML/JS 卡片（standalone .html 已能渲染成 live card），允许截图自检。
4. 安全面不新增：本地 headless，不开放外部调试端口，SSRF / 私有地址拒绝沿用 `netGuard` / `path_policy`。

**判据**：「改 → 截 → 判 → 修」在无人提示下跑通。

### W5 · 判断权归还：章法降级为可选能力

> 进度交叉（2026-11-05）：方案 1「枚举→事实」已随决策边界改革 A3 落地（adaptiveControl buildDirective 事实化，v4.2.0）；方案 2 阶梯主体按框架改革 4a 既定裁决保持不动。W5 余项仍挂 P3(v5.x)，开工前重盘点。

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

## 四之二、P1 落地记录（2026-11-04，进行中）

| commit | 刀 | 摘要 |
|---|---|---|
| `3f8f955` | **W1b-2 Anthropic 内置** | PROVIDERS 增第 9 家（`protocol: 'anthropic'`，baseURL `https://api.anthropic.com/v1`，defaultModel `claude-sonnet-5`）；`protocolForURL` 补官方域 `anthropic.com` 识别；i18n 与 index.html 计数徽章同步；`providers.test.ts` 长度断言 9 |
| `d57194f` | **web 工具信噪比四刀**（会话插题：用户点名 web 工具是否全量塞上下文。取证结论=不是全量无界：工具层 maxChars + 引擎层 40k 帽早已在，真缺口在别处） | ①CLI 与 overlay 流补提炼回调——此前提炼层只接 GUI 主聊天，CLI/overlay 对模型是虚假承诺；②Tavily/SearXNG snippet 两端 600 字帽（对齐 Exa 服务端帽）；③缓存帽统一 TS 60k UTF-16 字符 / Rust 180k UTF-8 字节（60k 全中文最大字节形态，两侧互不二次截断），截断副本带诚实标记且标记留在帽内；④提炼编排抽共享 `condenseToolBody` 单源，Node 与 Tauri 同一编排，`raw:true` 旁路与缓存语义两端一致 |
| 本次 | **W1b-1 自探测** | 新模块 `src/shared/capabilityProbe.ts` + 全链消费接线，见下 |
| 本次 | **W1b-4 能力事实送达** | 蓝图两难（首回合注入动缓存前缀 vs 事件推送）裁定走事件驱动：新模块 `src/shared/capabilityFacts.ts`，注入走 envFacts 区（formValidationFeedback 同款「事件→装配时读走」通道，user-turn 动态层不碰 system 前缀），无常驻行。事件源 v1 两个：①带图回合 × 视觉非确认支持（known&&supported 零注入；其余 unknown 式措辞「读不到就直说别假装」——manifest 纪律「未命中≠不支持」，不写 known&&false 强警告分支，该形态今天不存在）；②模型切换后首回合一行新模型事实（复用 modelCapabilitySummary），首回合不注（每会话第一条都注=变相常驻，sys_info 可查通道已有）。推理参数不设事件源（effort 是请求参数非模型盲区）；CLI 无图、模型随启动固定 → CLI 零接线。lastSentModelKey 由频道保存、只在请求真正装配时推进 |
| 本次 | **W2b-3 发布门（sanity 档）** | release.yml 加 `eval-smoke` job：LLM 冒烟固定 3 题（`run-evals.ts --limit 3`，metadata.sanitySubset 自证子集 + fixtureHash 随子集天然变、snapshot 的 hash 门堵误当基线之路），读数三态（ran/skipped/failed）**必进 release body**。v1 是**可见性门不是数字门**——退步不挡发布：compare-evals.ts 红线「阈值要有真实数据支撑再谈」，`--strict` 硬门等攒两三版读数再上；无 key=skipped、跑挂=failed，都写进 body，缺席必须可见。**full 档留在发布者本机**（eval:baseline + eval:compare，数字随版本笔进 CHANGELOG）——CI 自动跑 full 是 30 分钟+真金白银，tag 触发无法预算批准。`--limit` 与 `--heldout` 互斥（子集留出集毁留出性质）。启用条件：repo 设 `PURE_EVAL_API_KEY`（或厂商 key）secret + 可选 `PURE_EVAL_AGENT`/`PURE_EVAL_MODEL` vars，未设则 body 标注 skipped 并给出设置指引 |
| 本次 | **W2b-1 frontier 档（首两 fixture）** | 新文件 `src/evaluation/codingTaskFrontierFixtures.ts`，**独立套件**（`pure-coding-frontier-v1`）不并 v5——并入会换 fixtureHash 让已提交基线表全作废，而无 key 重跑前矩阵会空窗；compare-evals 与快照按 suiteVersion 天然隔离。①`frontier-selfverify-pricing-web`（自我验证·约束网）：七条计费规则互相咬合，种子是「单测全绿的草率实现」，错在组合——cap 顺序/取整位置/钳制记账成网，修对一条的天真改法弄坏另一条，必须跑验收读 FAIL 成假设迭代（12 属性 13 检查，全部手算可复验）；②`frontier-contract-window-units`（跨模块契约传播）：限流器单位契约横跨 core/adapters，换算错在 adapters、边界拒收缺在 core，只修任一层过不了审计，「比申请的更宽松」藏在亚毫秒窗口与小数计数里。管线面：`CodingTaskEvaluationOptions.suiteVersion`、run-evals `--suite frontier`（与 `--heldout` 互斥）、`eval:sanity` 扩成双套件门（17 fixtures）、held-out 碰撞集含 frontier、完整性双测与 v5 同款。**区分度读数等 W2b-2 真实 key**；档案设计纪律与 hard/extreme 相同（控制组按种子失败、金标准解通过，确定性验证） |

**W1b-1 自探测要点**：

- **哲学：探测填 manifest 空档，不推翻族知识。** 消费层插在 manifest 之后、FALLBACK 之前：显式 override > provider-model defaults > probed > fallback。P0 收窄规则时制造的真实空档（openrouter 上的 moonshot-v1 等老模型）由探测补上，而不是把猜测加回规则表。
- **蓝图原写「`/models` + 一次极小请求」；落地裁定砍掉极小请求**：挂点（设置面板连通性测试）前已有连通性 probe 兜底；官方 API 的 `/models` 不返回窗口、极小请求也拿不到；读数薄、每挂钩一次多花一次调用。复验按 `/models` 缺失率再议要不要补。
- **诚实出口**：聚合商（openrouter `/models` 带 `context_length` / `top_provider.max_completion_tokens`）才有窗口元数据；官方 `/models` 不给 → 如实报告「端点活着但没给窗口」，fallback 继续兜底，现状行提示可跑连通性测试探测。不编数。
- **缓存与开关**：config.json `capabilityProbes`（键 `provider::model`，条目带 endpoint 快照——换端点即失效，防止 A 端点的读数污染 B 端点）；`probeCapabilities` 开关默认开；agent 可按键删改（「agent 怎么改」铁律）。
- **接线面**：`resolvePromptBudget` / `promptBudgetForProvider` / `promptBudgetLiveLine` 全部加 probed 插层与现状行 `source: probed-from-endpoint`；GUI（chat/settings/overlayFlowHost）与 CLI（cli/cliAdapter/cliHarness/cliRepl/harnessFactory）全调用点接 `capabilityProbes`；挂点=设置面板连通性测试成功后静默追加（manifest 已有档的模型跳过，省请求）。

**验证**：`bun run typecheck` 通过；`bun test src` = 4983 pass / 0 fail；`bun run lint:conventions` 通过。

## 四之三、P2 落地记录（2026-11-04，进行中）

**开工取证（2026-11-04 全量盘点）**：30 个内置工具，定义单源（toolDefs + ToolRegistry），执行三份。8 处行为分叉：①web_search 后端集 Node ~10 vs Rust ~20（toolDefs 注释自认「probe different sets」）；②劫持检测正则表 TS/Rust 手工镜像「逐条对齐」必漂移；③web 公共 API 解析器 Rust 1318 行 vs TS 757 行两份；④path_policy 只在 Rust 文件命令、Node 侧只有词法 resolve；⑤execute_command 沙箱只 GUI 有（Seatbelt）；⑥sys_info 两端输出形不同；⑦git_commit/branch GUI 借道 execute_command 拼参数 vs CLI 独立 spawn；⑧共享缓存文件 ~/.pure/cache/web-cache.json 同键不同帽靠注释互镜像。**sidecar 现状**：GUI 主聊天不经过它（引擎在 WebView、工具走 IPC），唯一消费方 gateway_start。**W4 基建**：HeadlessChrome（port=0+stderr 解析、CDP 透传、findChromePath→null 降级）+ browserProjection 的 navigate+captureScreenshot 先例齐备；缺口在引擎侧——ToolResult 无 images 字段、两条 adapter 映射只在 user role 生效。**安全面裁定（W4 开工前说清）**：browser 不做 SSRF/私网拒绝——与文件工具「绝对路径全盘可达」同契约，localhost/file:// 恰是「改→截→判→修」核心场景；唯一纪律=不开放外部调试端口（port=0+stderr 解析，基建已有；防端口抢占属工程正确性非安全加固）。netGuard（死 host 熔断）不接 browser——navigate 失败模型自己会看到错误，熔断器是防重复浪费的机制非安全边界。

| commit | 刀 | 摘要 |
|---|---|---|
| 本次 | **D1 拍板** | 裁定 A（TS 单执行器），B 降级为可选第二阶。理由与形态见 W3 节（sidecar 零复用 / A 切面小 / 四条逐项 / 捆绑负收益） |
| 本次 | **P2-1 执行器骨架（git 五工具归一）** | 立起单源层：`src/tools/runtime.ts`（`ToolRuntime` 原语注入接口，首发原语 `runArgv`——argv 直通无 shell）+ `src/tools/impl/git.ts`（git_diff/log/status/commit/branch 单源实现，行为口径=CLI 旧形态）。两 adapter 退化为原语提供者：Node 端 `runArgv`=Bun.spawn（自旧 handleGitCmd 泛化），GUI 端 `runArgv`=新 Rust command **`run_argv`**（execute_command 骨架 minus shell wrapper/代理 env；Seatbelt 经新增 `sandbox::wrap_argv` 直接包 argv，无 sh -c 中介）。**Rust 面 3→1**：git_diff/git_log/git_status 三 command + run_git helper 退役，`run_argv` 一个原语 command 顶上——「每工具一个 command」→「每原语一个 command」的第一个实证（GUI 的 git_commit/branch 不再借道 execute_command shell 拼接 quoteShellArg；TA 的 quoteShellArg 保留给 workspace.ts，列后续归一候选）。GUI 侧行为几乎零变化（旧 Rust git_status 本就是 --short、log 默认 -n 10 --oneline 一致）；CLI 侧仅 git_log maxCount 加了正整数校验、失败文案超时行对齐 execute_command。**契约测试单份两端生效**：git.test.ts 11 用例（argv 组装/校验拒收/失败取材序/真 git 集成），adapter 不再各测一份。验证：cargo check/test 绿、typecheck 绿、bun test 5004 全过、lint 绿 |
| 本次 | **P2-2 browser 工具（W4-1）** | W4 视觉闭环的执行面落地：`src/tools/impl/browser.ts`（browser/screenshot 两工具单源，零 node 依赖——fetch/WebSocket/JSON only，WebView 与 Bun 同码跑）。**会话模型**：每进程一个共享 headless Chrome，会话常驻（导航状态是工具价值本身）、5min 空闲关闭、死会话（CDP 断）下次调用自动重建、页面级错误不拆会话；WebView 刷新丢模块态的孤儿 Chrome 已文档化为接受泄漏窗（残留无害）。**CSP 验证先行通过**（tauri.conf connect-src 含 ws: wss: http:）→ 无需 Rust 薄代理，CDP WebSocket 由 WebView 直连。**原语面从 1 扩到 4**（每原语必须双宿主可表达）：`resolveExecutable`（候选表传全平台并集，exists 探测天然平台盲，impl 层永不碰 process.platform——WebView 无 node API，初版 mkdtemp/tmpdir 方案因此推翻重来）、`launchHeadlessChrome`（宿主自管 throwaway profile 与清理，port=0+stderr 解析，不绑外部调试端口）、`writeArtifact`（目录规则在 Rust 端 save_artifact 算，~/.pure/cache/screenshots/）。Rust 新增三原语 command：find_chrome/launch_chrome/save_artifact。**实现层两次写作中自查修正**：①参数校验原本在会话回调内——缺 url 的 navigate 也会先启动 Chrome，无 Chrome 环境报错错位，校验上提到 withSession 之前；②CHROME_NOT_FOUND_HINT 原以异常抛出靠 adapter 通用 catch 兜底，对齐 git 单源口径（预期失败转 outcome 返还模型）改 asOutcome 包装。注册走 deferred 形态（BUILT_IN_TOOL_DEFS 在册+PUBLIC_TOOL_NAMES 公开+不进 CORE 常驻），模型经 discover_tools 激活。测试 16 用例：契约层（无 Chrome 也跑——校验先于 OS 原语、无 Chrome 诚实提示）+ 真 Chrome 集成层（findChromePath null 整组 skip，CI 安全降级；navigate→evaluate→type→click→screenshot 落盘 PNG magic 断言、warm session 单次启动复用断言）。验证：typecheck 绿、bun test 5005 全过（+16）、cargo check 绿、lint 绿 |
| 本次 | **P2-3 截图进上下文（W4-2）** | ToolResult 加 `images` 通道 + 四处映射接线，模型亲眼看到自己刚截的图（「改→截→判→修」的判据端）。**口径翻转注记**：types.ts 原 GeneratedImage 注释「The LLM never sees either」是 generate_image 交付物的口径——screenshot 是模型的眼睛，两种口径并存且各自正确（ToolResult.images 注释写明：那是交付物，这是模型的眼睛）。**四处接线**：①引擎折页（AgentLoopEngine tool 消息带 `images: tr.result.images`，Message.images 通道本就存在只是 tool role 没人填）；②openai mapping tool case——带图时 content 数组化（text + image_url parts），无图保持 plain string 紧凑形状（既有后端零扰动）；③anthropic 双直连各一处——TS DeepSeekAnthropicAdapter 的 tool_result content 数组化（复用 parseAnthropicImageSource，空 text 跳过/全空回落 string，同 user 路径「Anthropic 拒收空 text」判例），Rust 抽独立函数 `anthropic_tool_result`（对齐 anthropic_image_blocks 抽函数先例，改写失败原样保留、「宁服务端报错不静默丢图」同哲学，可单测）；④两端 adapter handleBrowserTool 三行同款接图。测试 +6：TS +4（openai tool 带图数组/无图 string、anthropic tool_result 带图/无图）、Rust +2（wire 数组重排 / string 保持+空文本跳过+https 直链透传）。验证：typecheck 绿、bun test 5009 全过、cargo test 303 全过、build:vite 绿、lint 绿。**真机验证项**（W1b-3 同款纪律：代码按协议标准形态落，真机红了再降级）：DeepSeek 对 tool content 数组+image_url 的兼容性；**预算观察项**：图的 token 不进 budget.addTokens 文本帽，P2-4 验收读数观察 |
| 本次 | **P2-4 呈现逃生舱+判据（W4-3）** | ` ```html ` 围栏卡=枚举 DSL 之外的任意 HTML/JS 呈现通道，screenshot 工具本体 P2-2 已带（path 支持 file://，本刀补逃生舱与判据）。**CSP 取证定通道**：宿主 script-src 'self' 挡 inline script，srcdoc/blob: iframe 又继承宿主 CSP → **asset:// 是唯一干净通道**（asset protocol 响应无 CSP 头，img-src 已有同源基建）；frame-src 补 `asset:` + `http(s)://asset.localhost` 三源（macOS/Linux scheme-source 与 Windows localhost 双形式全覆盖，convertFileSrc 平台差异）。**落盘链**：iframe 必须 JS 造（DOMPurify 会剥模板里的 iframe）→ hydration 时 `save_artifact 'card'` 落 `~/.pure/cache/card/` → `assetUrlFor` iframe `sandbox="allow-scripts"`（异 origin 本就隔离，非安全加固）→ 落盘失败退回源码显示（never silent）；basename 纯 FNV-1a hash（写作中自查修正：注释承诺同源不堆文件、实现却带 Date.now()——去时间戳，同源重渲覆盖同名）。**判据端双落**：①presentationLibrary html 卡 `family='escape'`，两面判据硬约束——whenToUse 只放行「枚举形式全部表达不了」（自定义交互组件/DSL 装不下的布局），whenNotToUse 反压「枚举能表达的一律用枚举，逃生舱是最后手段不是捷径」（只说好处的卡催生过度可视化判例），delivery 钉「改→截→判→修」闭环（write_file 落盘 + screenshot 亲眼验证，WITHOUT being asked）；②surfaces 双面真话（gui: sandboxed iframe / cli & channel: 源码直出，textFallback='text'）。**同源锁进化判例**：presentationLibrary.test.ts 手写 FENCE_IDS 复刻在 html 加入后漂移红——改库导出+测试 import 单源引用（第三处手写清单消灭）；textFallback 锁补显式 `'text'` 等价缺省分支。测试 +5：markdown +3（slot 结构/降级链特征串/不过度匹配）、fenceRegistry +1 行为 pin、presentationLibrary +1（escape 判据两面）。验证：typecheck 绿、bun test 5013 全过、cargo test 303 全过、build:vite 绿。**判据验收**：「改→截→判→修」无人提示跑通的代码侧判据已写到位（卡 delivery + screenshot 工具 path=file:// 闭环），真机验收留待用户 |
| 插刀 | **本地无 key API 服务全链打通（2026-11-04 用户点名）** | Ollama 预设之外手动添加 LM Studio / vLLM / llama.cpp 仍被三面卡死，011919e 三刀净除：①GUI 表单 key 必填校验只认 `local` 快照字段（手动条目永远没有该字段，localhost 地址也报缺 key）→ `isLocalEndpoint(baseURL)` 单源判定（loopback/`*.local`/`*.internal`/IPv4 127 段），校验与 placeholder 改「预设标记 ∥ URL 判定」——**读取时判定优于保存时快照**（后改 baseURL 立即生效）；②Rust 传输层 anthropic 协议无条件发 `x-api-key: ""`（严格路由器拒空值头）→ 抽 `apply_auth_headers` 门控两协议（keyless 一律不发，anthropic-version 保留）+ 单测；③Anthropic SDK 空 key 请求时抛错 → 占位值对齐 OpenAICompatibleAdapter `'ollama'` 先例，`DeepSeekAnthropicConfig.apiKey` 改可选。CLI 链取证无墙（loadConfig 只要求 provider、custom 分支提前 return）。测试 +5（TS +4 判定表/空构造、Rust +1 header 门控）。验证五件套+Windows cross-check 全绿 |
| 本次 | **P2-5 起步：劫持检测跨语言双锁（W3-A2 第一子刀）** | TS netGuard ↔ Rust detect_response_hijack 是刻意「逐条对齐」的手工镜像（Rust 不能 import TS，真单源不可达）——**机械锁可达**，两把锁把注释升格为断言：**锁 1（数据锁，netGuard.test.ts 读 lib.rs 源码）**：static_regex! 指纹表 7 条+JS 跳转 2 式与 TS 侧逐条比对（pattern 归一：Rust `(?flags)` 前缀 ↔ JS flags；JS `\/` 归一 `/`；**Bun/JSC 判例：RegExp.source 对非 ASCII 输出 `\uXXXX` 转义而 V8 保持明文——序列化行为差异匹配语义不变，比对须先解码**，当场抓到两处历史微漂：TS 的 cf_title 少 `\s*`、cn_blocked 缺包裹括号，已对齐）+ 后缀表集合相等 + 三阈值同值；**锁 2（行为锁，`__fixtures__/hijackFixtures.json` 两侧测试同源消费）**：18 case 钉三大信号组合+分支优先级（fingerprint&&short 先于跨域分支、short 先于 offsite——fixture 设计必须给 D 信号配长正文才钉得住独立命中）+ 反例（ccTLD 钓鱼/托管平台独立站/IP 同站/非 html/延迟 5s 排除 D），Rust include_str! 同 JSON 一次通过=两侧行为真同。测试 +6（TS +5、Rust +1）。验证：typecheck 绿、bun test 5026 全过、cargo test 305 全过、build:vite 绿、conventions 绿。**余子刀**：web_search 执行单源化（后端集并+编排归一，最大刀——双端网络栈/代理注入差异是硬骨头）→ 公共 API 解析器收敛 → path_policy 上移 |
| 本次 | **P2-5 web_search 执行单源化（绞杀者第一刀）** | 双端各养一份搜索编排（NA handleWebSearch ~360 行 / Rust web_search_inner ~1300 行）→ 抽 `src/tools/impl/webSearch.ts` 单源（~1200 行，后端 11∪ 解析器 8，零 node 依赖），双端经**原语注入**接线：`WebSearchDeps{fetchPage, env, cacheGet?, cacheSet?}`。**刀 A**：impl 单源（含 CJK 相关性门 36b3ab2 判例、cookie jar、quota 冷却、FNV-1a 缓存键与 Rust cache_hash_key byte-identical、GB2312/latin1 charset 归一、normalize retry、Jina 末路层）。**刀 B**：NA 接线（cliFetch 包装原语 + env 直读 process.env + webCache 注入；handleWebSearch/解析器三族 ~1400 行退役；fast path cachedDirectPublicApi 留守不劫持研究查询；web_public_api searchOnMiss 也改走单源）。**刀 C**：Rust 原语四 command（fetch_page= reqwest 透传+base64、web_cache_get/set=WebCache 透传、direct_public_api=结构化暴露 cached_direct_public_api 不玩 miss 文案匹配）+ TA 接线（searchViaSingleSource：WebView 无 process.env→env 表只映射 Settings 三值 TAVILY/SERPER/SEARXNG，EXA/JINA GUI 显式不启用；fetch_page 包装含 base64→Uint8Array；**换路重试×冷却单例冲突修复**：全后端失败⟺全部进 30s 冷却⟺换代理第二轮空跑（旧 Rust backend_blocked 同缺陷）→ runWebSearch 加 `options.ignoreCooldown`，runRoutedSurface 传 attempt，重试轮跳过冷却——真被封的后端再失败重新入冷却只多一轮不放大）+ **搬运缺口当场抓到**：structured 三件（ddgInstant/wikipedia/googleNews）冷却过滤在 HTML 层/旧 Rust 都有、TS 单源漏掉——编排契约测试当场抓红已补。buildWebSearchArgs 及其 invoke 参数锁测试退役（command 壳已死）。web_search_inner 保留（web_public_api searchOnMiss Rust 侧复用），等解析器收敛刀一并退役。**刀 D**：编排契约测试 +8（缓存短路零调用/API 命中不打扇出/全失败 ok:false 文案=换路上抛依赖/空结果 ok:true 不触发换路/冷却默认跳过/ignoreCooldown 重打/CJK 门拒收降级/成功写缓存），TA 行为锁 2 用例改观察点（fetch_page 的 proxyUrl：直连优先/换代理），TA 四处消费点全走单源（communityRaw/researcher_web/researcher_docs/web_search case）。验证：typecheck 绿、bun test 全过、cargo test 305 全过、build:vite 绿、conventions 绿。**余**：公共 API 解析器收敛（届时 Rust web_search_inner+后端函数全退役）→ path_policy 上移；真机验收=GUI 搜索全链（fast path/缓存共享/jar/换路）留用户 |
| 本次 | **P2-5 公共 API 解析器收敛（绞杀者第二刀，7378b6a）** | `web_public_api.rs`（1318 行）与 CLI `publicApis.ts` 各养一份解析器栈 → 归一 `src/tools/impl/publicApi.ts`（分类器 + 10 resolver，零 node 依赖），`PublicApiDeps{fetchPage, cacheGet?, cacheSet?}` 原语注入（公共 API 全免 key 故无 env 原语；fetchPage 与 webSearch 刀共用同一 CLI/GUI 包装）。**Rust 大拆除**：web_public_api.rs 全删 + web_search_inner 与独占搜索后端栈（backend_cooldowns/jina 系列/google_news_rss/ddg_instant/serper/tavily/exa/searxng/cookie jar/百度预热/HTML 解析器群）连带退役，direct_public_api command 退役（fast path 归 TS 单源）；lib.rs 只留守 web_scrape 链 + charset 嗅探 + feed 格式化（parse_rss_items/clean_xml_text 搬回 lib.rs；html_decode 被 web_fetch 文本提取器消费留守；is_chinese_query 被 find_files 与缓存归一消费留守；urlencoding 被 wayback 兜底消费留守——三个「看似搜索栈实为留守」的坑全靠消费者图谱逐函数取证兜住）。**NA 薄壳化零改动**：旧签名保持函数 + deps 内部化，调用方与测试零改动（103 pass 验证兼容）。**TA 接线**：makeIpcFetchPage/webCacheDeps 抽取共用，directPublicApi 替代 fastPathDirectApi（impl cachedDirectPublicApi + 原语），case 'web_public_api' 重写=直查不换路 + searchOnMiss 升级走 runRoutedSurface('web_public_api') 出口面（对齐 NA 语义），searchOnMiss:false 返 miss 文案。**12 项收敛裁决取行为更正确侧**：isBuildRequest 拆 CJK 无条件（动词后空格不漏拦）+英文词边界（makeup 不拦）/fx zh 分支 $ 锚（「美元换人民币汇率」不误入 fx）/worldbank value=null 返 null 不伪装成 0/新浪成交额定长去 toLocaleString/腾讯新浪 NaN→0 防御/无城市文案中性化/github 冒号剥净/**geocode 网络级失败才进 300s 冷却**（服务无结果不 mark——冷却「查无此地」会把正常查询误判成服务不可达）+**降级卡 degraded:true 不落盘**（旧 Rust 会把「服务不可达」缓存 30 天）+缓存命中 intent 合法性防御（旧 Rust PascalCase 记录视为损坏重解析）。**Rust CJK 门判例测试随退役搬 TS**（resultsRelevant 纯函数锁：天眼查垃圾拒收/真实结果接受/短 bigram 恒接受/非 CJK 恒接受）——行为锁不因模块消失而失锚。验证：typecheck 绿、bun test 5043 全过（impl 契约测试 +13）、cargo test 269 全过（退役 36 个 Rust 测试）、build:vite 绿、conventions 绿；净 -3206 行（+1425/-4631）。**余**：path_policy 注入点上移；真机验收=GUI 公共 API 全链（fast path/缓存共享/geocode 降级卡/searchOnMiss 升级）留用户 |
| 本次 | **P2-5 path_policy 注入点上移（绞杀者第三刀收官，a9002d4）** | 文件类工具的路径策略三份手工镜像（Rust path_policy.rs=GUI 权威 / NodeToolAdapter.resolve=CLI 手抄 / expandTilde 两侧注释互指双胞胎）→ 归一 `src/tools/impl/pathPolicy.ts`（expandTilde/normalizeLexical/resolveWorkspacePath/hasSymlinkComponent，零 node 依赖），`PathPolicyFs{canonicalize, exists, symlinkMeta, isDir}` 原语注入（CLI 注 node:fs 同步函数，async 签名 await 同步值零开销，给将来 GUI IPC 预解析留门）；**三处真实分叉收敛到 Rust 权威语义**：`..` 越过文件系统根（旧 Node pathResolve 静默吞——写操作落到模型意图之外只差一个系统错误）/workspace·path 空校验（旧 Node 静默落进程 cwd）/trim 语义（旧 Node 前导空格挡住 `~` 展开把 ` ~/x` 当相对路径）；错误文案对齐 Rust（旧 Node 大写 P 文案）。**单源形态=劫持双锁「真单源不可达，机械锁可达」**：Rust 不能 import TS、WebView 不能 import Rust，Rust 份是 GUI 的 fs 执行者随模块保留，行为由 `pathPolicyFixtures.json` 两侧测试同源消费锁住；锁的平台结构=posix 词法段两侧全平台精确锁 / windowsOnly 段（盘符 C: 相对盘符不升绝对、UNC 头）TS 全平台跑（纯字符串逻辑）Rust 按 cfg(windows)（std Components 前缀语义平台相关）/expandTilde 表 Rust 按 cfg(unix)（MAIN_SEPARATOR 拼接形状漂移，Windows 已有行为断言单测兜底）。**迁移中抓到真 bug**：字面 `..`（相对越界保留段）被后续 `..` 误 pop——Rust normal_depth 只数 Normal 段的语义照抄后消除。**刻意不收编**：Node 快照链的 hasSymlinkComponent 是不同守卫（workspace 外也查最深存在祖先，防 symlink 搅乱快照回滚），两消费方严格度不同是设计不是漂移。resolve 变 async（NodeToolAdapter 16 调用点 await 化）；expandTilde 移 impl 旧导入 re-export 保持兼容。验证：typecheck 绿、bun test 5065 全过（impl 契约 +22）、cargo test 271 全过（行为锁 +2）、build:vite 绿、conventions 绿。**P2-5 三子刀收官**；真机验收=CLI 侧文件工具全链（相对锚/绝对越界/`~` 展开/悬空 symlink 拒绝/新建文件缺失段补回）留用户 |

**P2 刀序**（绞杀者式，每刀独立可回退）：

1. **P2-1 执行器骨架**：立 `src/tools/impl/` TS 实现层 + 原语注入接口，首批收敛 git 五兄弟（diff/log/status/commit/branch）——两份转义/解析逻辑归一，验证骨架形态。
2. **P2-2 browser 工具**（W4-1）：落在单源层，复用 HeadlessChrome（会话常驻+空闲关闭抄 headlessRenderer 模式）；GUI spawn 经新 Rust 原语 command（WebView 不能 spawn，壳边界内）；开工前先验 WebView WebSocket 连 CDP 的 CSP 可行性（若 CSP 挡 localhost ws，CDP 会话改走 Rust 侧薄代理，实现仍单源 TS 经原语调用）。
3. **P2-3 截图进上下文**（W4-2）：ToolResult 加 images 通道 + 引擎把工具图折进下一轮 + 两条 adapter 映射扩展到 tool 消息（anthropic tool_result image 块已有形状；openai tool content 数组 / DeepSeek 兼容性**真机验证**，W1b-3 同款纪律）。
4. **P2-4 screenshot 工具+逃生舱**（W4-3）：本地文件/URL→图；呈现逃生舱（枚举 DSL 之外允许任意 HTML/JS 卡片）；判据验收「改→截→判→修」无人提示跑通（复用 W2 呈现指标）。
5. **P2-5+ web 栈归一**（W3-A2，后续会话）：搜索后端集并（10∪20）、劫持检测单源、公共 API 解析器收敛 → 文件类工具归一（path_policy 注入点上移）。

## 五、分期

| 期 | 内容 | 为什么这个顺序 |
|---|---|---|
| **P0**（已落） | W1a 能力 manifest + 现状可见；W2a 过程指标 | 零网络、零 UI、可测，先把「模型知识」和「度量口径」的地基打好 |
| **P1**（v4.3） | W1b 自探测 + Anthropic 内置 + Responses；W2b 硬 fixture + 官方列 + 发布门 | 两者互为前提：W1b 的收益只能靠 W2b 证明，W2b 扩列依赖 W1b 的 provider。做完这条腿才能自我证伪 |
| **P2**（v5.0，进行中） | W3 执行器归一（D1 已拍板=A）+ W4 视觉闭环 | 都碰执行层与安全面，合并推进共用一次回归；W4 验收复用 W2 的呈现指标 |
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
- 差距分析（截至 2026-10，文档已清理，git history 可考）：管「与主流对比」。本文管「与自身定位对比」，坐标系不同；10 月评估已废弃清理，对比结论由本文独立承载。
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
