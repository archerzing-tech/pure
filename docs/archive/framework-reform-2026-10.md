# pure 框架改革蓝图：处事逻辑新分工（2026-10）

> **权威声明**（用户 2026-10-28 定调原文，冲突以此为准）：
> 「今后的优化方向尽可能是减少 system prompt，system prompt 只保留核心的原则，处理事情的方式方法应该通过机制、工程能力解决。并且工程能力和机制的定位是大模型的手脚，怎么用，怎么排列，何时用，何时处理是由大模型决策的，不要干扰大模型的能力。」
> 「整个 pure 的框架层面要进行大刀阔斧的改革，把老的处事逻辑和步骤甚至写死的办法，正则都删除掉，使用新的处事逻辑和办法。」
>
> **pure 定位**（2026-10-28）：可自进化的多 agent 智能体系统——真实多 agent 能力（能并行绝不串行）；智能自我进化（可增删改工具/插件/prompt/机制/编排）；越用越贴合使用者；智能不盲从（明确提出自己的意见）；对话窗口可视化交互（结果可见、形象化）；拟人对话（顺序/随时打断随时接续/随时转话题/随时插话）。本改革与定位的对应：刀 1–3=随时打断随时接续的薄机制；刀 4–5=把 prompt 变薄、机制变清晰，让自进化的对象从「改大段提示词文本」变成「增删改工具/索引/分区」这类结构化资产；四期分区化是多 agent 并行的上下文地基。
>
> 关系：本文是施工权威；docs/system-prompt-comparison-codex-claude-2026-10.md 与 docs/system-prompt-layer-audit-2026-10.md 是它的调研输入。插话架构 v2（docs/insertion-redesign-v2.md）的引擎层结构（判定器/软暂停闸/taskState）保留——本改革卸的是它的常驻教学与字面网，不是判定能力。

## 一、三方实证基础

**Codex**（源码级，main@2026-10-28）：base prompt ≈5.2k tk 只装人格+工作方式+规范；一切随环境变化的（AGENTS.md 内容/cwd/权限/工具清单/skills/压缩摘要/token 预算）都是带 `ContentItemKind` 元数据的独立分区，**每次采样请求组装时按条件渲染**；每个分区实现 typed Snapshot + render_diff——状态变了才发增量，没变不发。教学挂工具定义（apply_patch 语法随 schema 走，工具不注册零成本）。压缩 prompt 仅 106tk/保留近期消息 20k。AGENTS.md 32KiB 硬截；skills 目录预算=窗口 2%。

**Claude Code**（v2.1.289–312）：工具渐进披露（常驻仅 discovery 工具，deferred 命中 ToolSearch 后装 schema，已加载状态跟踪）；skills/memory 全是「索引常驻（名字+触发条件）、正文按需」；环境信息/配置走消息层 system-reminder 带外信令不进系统段；压缩只压对话史，身份层在压缩点重建。

**pure 现状**（盘点 main@a17d07b）：运行时正则 75–80 处（替模型做语义决策的主力 ≈55 处）；收执话术模板 22 个函数 ≈2.5k 字符；常驻写死话术 ≈9,700tk；闸门 fragment 全开 ≈3,900tk。最重单点=Planner 形态判定三组（detectProjectRequest/detectArtifactRequest/assessIntent，决定整轮形态与风险档）。

## 二、新处事逻辑：五层分工

```
原则层（system prompt）   身份、人格、价值观、底线、薄指针          ← 常驻
索引层（目录）            名字+触发条件；工具 deferred、技能、记忆、DSL 契约 ← 常驻（很小）
注入层（带外信令）        插话处置块、任务状态投影、环境事实        ← 消息层、分区 diff 渲染
手脚层（引擎机制）        工具执行、进程、账本、掐流、渲染、算术、门禁 ← 不占模型注意力
脑（模型）                语义决策：回应什么、先做什么、怎么措辞、风险、任务形态
```

判据（归位检查表）：
1. 这是原则吗（身份/人格/底线）？→ 留 system prompt
2. 这是方式方法吗（流程/教学/用法）？→ 机制承载：工具 description、注入件、引擎检查器
3. 这是长尾能力吗（场景细则/DSL/锦囊）？→ 索引+模型自取
4. 这是机械解析吗（算术/格式/钟表/命令发现）？→ 引擎手脚，豁免
5. 这是在替模型做语义判断吗？→ 删，归模型/路由/裁决器

## 三、五组刀法（对应盘点清单）

### 刀 1：插话字面族 → 裁决器 + 原话直投
- **删**：SCOPE_ADD_RE（已死代码）；netVerdict 字面族（GOAL_CHANGE_RE/CANCEL_PART_RE/URGENT_RE）——裁决器缺席/倒下时不再猜 relation，**原话直投队列**，让在跑的模型自己消化（薄机制下安全网自然消失，这是最大化简红利）。
- **移**：BRANCH_STOP_RE / RESUME_BRANCH_RE 的点名寻址归裁决器（coveredBranch call_id 同款：模型拿花名册点 id，宿主只核实执行，零字面匹配）。
- **已裁定**：STOP_RE 快路径**删**。理由：①哲学一致——「停」的语义判断归还模型，引擎只保留 abortController 掐流的机械动作；②「随时打断」的体验里 1–2s 裁决往返可接受，而误停的代价（丢在跑工作）远大于延迟；③删后插话通路收敛为唯一形态（判定归裁决器/原话直投），维护面最小。

### 刀 2：收执模板族 → 裁决器现场收执扩全路径
- **删**：insertionMessaging.ts 全部 22 个固定话术函数（含刚写的 steerFallbackReceipt）+ 约 24 个调用点的模板选择分支。
- **新逻辑**：收执=承接插话的模型在下一动作里自然带出（receipt 机制已在，扩为唯一来源）；引擎在模型缺席时**沉默**（宁可无话，不出机械腔）。框架文本（steerFrameText 等机制指令）只描述机制事实，不示范措辞。

### 刀 3：INSERTION_PROTOCOL → 薄指针 + 注入块
- 常驻 1,865tk → **≈150tk 指针**：「用户插话会以标注块出现在对话流中，按块内处置配合；收执点名具体的事」。
- 处置指令跟判定结果走消息注入（原话+relation+路由目标）——九类理论、处置管线表撤到裁决器提示词（引擎侧按需调用，不占常驻）。

### 刀 4：形态判定族 → 语义路由接管
- **删**：detectProjectRequest / detectArtifactRequest / assessIntent / detectComplexity / detectFictionIntent / detectTraps / WORK_VERB_RE 族 / EDIT_VERB_RE 族 / taskKind 词表 / CONTINUATION_PREFIX / CONFIRMATION_REPLIES（≈250 行正则）。
- **新逻辑**：任务形态/风险档/是否动手=语义路由（LLM router 已存在）的输出；宿主只执行形态。复杂任务判定并入路由信号。逻辑陷阱归模型自查（LOGICAL_TRAPS 原则段已教）。
- generatePlan 的 6 步固定计划模板砍成一句「路由失败，请重试」。

### 刀 5：闸门 fragment → 索引 + 自取 + 教学挂工具
- **删闸门**：wantsHandsOnWorkflow / wantsCapabilityLadder / wantsDelegationMechanics / detectVisualRequest 全族正则（≈120 行）。
- **去向**：
  - WORKFLOW_PROMPT 786tk → 交付纪律归引擎门禁（delivery.ts 管线已有，机械执行），7 条操作流程教学并入 execute_command/write_file 等 description。
  - CAPABILITY_GAP_LADDER 900tk → 安装路线归 skill 机制与工具 description（模型自寻路）。
  - MULTI_AGENT_MECHANICS 460tk → 委派工具 description（fan-out/relay 参数化）。
  - 视觉五件 1,600tk（PAINT/CHART/MAP/SVG/IMAGE_GEN）→ 渲染工具 description + 引擎侧校验器（Codex apply_patch.lark 模式）；常驻仅 VISUAL_BLOCK_POINTER 一句。
  - fiction 豁免 133tk → 删，模型按常驻审查条款自判例外。

## 四、架构工程：世界状态分区 + diff 渲染（Codex 移植）

把 pure 的动态上下文（环境事实/任务状态投影/session ledger 摘要/插话处置块）改造成**分区化**：
- 每分区 typed snapshot 持久化进会话卷，重渲染只输出与上一快照的 diff——状态不变零 token。
- composeUserTurn 的 envFacts/traps/plan/ledgerFacts 序列是雏形，升级为分区 trait。
- 分区渲染天然缓存友好；工具 deferred 化时做已加载跟踪，防打穿缓存前缀（Claude Code 2.1.302 教训）。
- 预算纪律：各分区设硬上限（AGENTS.md 32KiB 硬截 / skills 2% 窗口模式）；conventions/项目文档加载同步加硬截。

## 五、分期施工

> **2026-10-28 二次定调**（真机后）：「当前一期实现的插话处理逻辑不对，整体架构先不变，要把插话的对接点、插入点留出来，后续再改。」——插话处理逻辑的改版（目标态：队列+注入式 mid-turn injection）列为独立工作，端口先行；原刀 4（形态归还）顺延。

| 期 | 内容 | 规模 | 依赖 |
|---|---|---|---|
| **一期** | 插话薄机制：刀 1+2+3（字面族/收执模板/INSERTION_PROTOCOL） | 删 ≈2.5k 字符模板+6 正则+1.7tk 常驻 | 无（✅ 2484ce8，v3.4.0 已发布） |
| **二期** | 插话端口契约：对接点+插入点显式化（interjectionPort.ts），处理逻辑标记为边界内可替换 | 契约文件+类型锁+端口标注，零行为变更 | 无 |
| **三期** | 形态归还：刀 4（语义路由接管形态/风险/复杂度判定） | 删 ≈250 行正则 | 路由覆盖率确认；插话逻辑改版后重估 |
| **四期** | 索引自取：刀 5（闸门删+教学挂工具+索引层）+ 分区 diff 渲染地基 | 删 ≈120 行正则+4.7tk 闸门 fragment | 五期分区机制先行 |
| **五期** | 世界状态分区化 + 工具 deferred 化评估（28 工具→核心常驻+长尾 discover） | 架构工程 | 无 |

### 插话端口契约（二期施工物，`src/coding-agent/interjectionPort.ts`）

- **对接点（唯一入口）**：`InterjectOrchestrator.interject()`——GUI 主输入、多会话面板都汇到 chat 转发缝；CLI/新通道接入只写转发，不复制逻辑。
- **插入点（三个取件口）**：P1 轮中消息边界 `takeSteerMessages`（EngineContext）/ P2 委派收齐派发 `takeSyntheticToolCalls`（EngineContext）/ P3 思考窗补充 `takePreflightSupplements`（编排器）。
- **宿主动作面/读数面**：`InterjectOrchestratorDeps`——决策核不猜宿主状态，双向不越界。
- **边界内可替换**（后续再改，端口不动）：classifyAndApply 裁决序九类分发、DynamicInsertionCoordinator 裁决器、收执纪律、SteerBus/FoldInLedger/DelegationControlPlane/RoundClosePlane/HoldGate。
- **接入纪律**：宿主不得旁路裁决序；不得自开第四插入点；扩插入点形状先改契约再动实现。锁：`interjectionPort.test.ts`（编译期类型锁+宿主旁路源码锁）。
- **后续改版方向**：队列+注入式 mid-turn injection（业界通行形状）——在边界内替换裁决序实现，端口签名不变。

每期：全量测试绿 → 提交 → 部署本机 → 真机复验后进下一期。顺序可按真机反馈重排（五期是四期的地基，若四期先行需临时分区内联）。

## 六、不变量（改革全程守住）

1. **插话不丢**：原话直投队列是底线动作，任何路径不得吞话。
2. **账不平不收工**：session ledger 是机制不是话术，保留。
3. **人格红线**：character_core / character_expression / human_tone 是「原则」层，不删不改写。
4. **机械解析豁免**：parseInputTiming 钟表算术、PLAN_PHASE 渲染标记、delivery.ts 命令发现、autoContinue/修复轮数机械参数——这些是手脚，不动。
5. **缓存纪律**：system prompt 稳定区/尾区渲染序不变；动态装配只走消息层与分区 diff。

## 七、终态验收

- 常驻 system prompt：9.7tk → **≈4k**（原则+指针+索引；人格 ≈1.5k + system_core 瘦身版 + work_invariant + 薄指针族）。**已裁定不再压**：低于 4k 就要砍人格/原则层，与定位（拟人化是产品差异化）冲突；Claude Code 3k 是纯工具人格（无性格内核），Codex 5.2k，4k 居中合理。
- 运行时语义正则：55 处 → **≤5 处**（豁免清单不计）。
- 收执话术模板：22 → **0**（模型现场措辞，引擎沉默兜底）。
- 每期真机复验行为不回退：插话承接观感、任务形态正确率（路由 vs 旧正则对照）、交付质量门禁。

## 八、两个遗留裁定的执行口径

1. **寒暄直通**（isPlainConversational + PLEASANTRY_BYPASS 40 词词表）：词表删，直通判定改为**路由换快模型**（统一通路一次投入全线受益），不引入本地小分类器（那是一个新的要维护的判定器，违背改革方向）。更彻底的「主模型直答、路由只在需要工具时介入」列为二期设计细节，随路由覆盖率数据定。
2. **STOP_RE**：见刀 1，删。
