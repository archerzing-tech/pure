# pure 框架改革 v2：薄 harness 审计与四期规划（2026-11）

> 2026-11-01 定调（用户最高权）：「尽可能减少教 pure 如何做事，把做事的主动权交给 LLM，pure 只保证整合各种工具、加载各种能力；至于这些能力怎么用，都是大模型思考的结果。」
>
> 本文是对该命题的业界审计（2026-10 时点三路独立调研）、pure 存量盘点与四期施工规划。继承 2026-10 蓝图（`framework-reform-2026-10.md`）的五层分工与不变量，重排其三四五期并增补两刀。一二期（插话薄机制+端口）已落地（v3.4.0 / v3.4.1）。

## 一、审计结论

**命题站得住脚，且是 2026 年业界主线；「交给 LLM」需裁成精确形态；pure 的差距不在方向，在施工进度与两处盲区。**

三处裁定：

1. **方向**：与 Anthropic、OpenAI 2026 年官方口径同向，证据互印（见第二节）。
2. **精确化一——没有一家是「删除」，全是「改载体」**：Claude Code 的 Bash 工具 description 内嵌 1,477tk git 方法论；OpenAI 把方法论挪进按需 grep 的 docs/。共识形态=**分层教**：常驻只留身份+原则+薄指针，方法论转移载体（工具描述/注入块/按需文件/索引自取），行为约束由引擎机械强制。pure 五层分工与此几乎逐字对齐。
3. **精确化二——「交给模型」对 frontier 模型成立，对弱模型与长时程任务不成立**：Anthropic 官方实测 Opus 4.5 裸跑长时程跨窗口任务做不出生产级应用（harness 件值 +13~22pp）；ARC-AGI-2 上工具能力供给仍是 4 倍差距。pure 接多模型（GLM/deepseek/nvidia/openrouter），设计目标不是「模型全能」，而是**薄 prompt + 强机制**：对强模型零损耗，对弱模型是护栏。护栏做成机制不做成说教（v3.6.6 五刀在 deepseek 机上的表现即活证）。

## 二、业界证据（2026-10 时点）

> 注：Claude Code 的 prompt 长度数字均为第三方实测（社区逐版跟踪仓库），官方未公布；其余为厂商一手材料。时效 2026-11-01，第三方数字仅供参考量级。

### 2.1 Anthropic 系

- **Claude Code system prompt 实际形态**：不是一整块长文，而是 515+ 个带条件的字符串按需拼装（第三方逐版跟踪 Piebald-AI/claude-code-system-prompts，更新至 v2.1.314 / 2026-10-29）。核心身份段仅 31–324 tokens（"working with the user toward their goals using its own judgment"）。方法论不在 system prompt，在**工具 description**（Bash 内嵌 git 工作流指引 1,477tk）与**运行时注入的 system-reminder 块**（按需触发）。第三方实测：system prompt ≈3,024tk + 23 工具定义 ≈14,843tk。
- **Skills 三层 progressive disclosure**（2025-10-16 官方）：L1 元数据（name+description，≈100tk/skill）常驻；L2 SKILL.md 正文按需；L3 bundled resources 用到才载。
- **Tool search**（官方文档）：工具定义不进 context 前缀，模型 regex 搜索后命中 schema 才 inline 追加。延伸形态 "Code execution with MCP"（2025-11-04）：MCP 工具定义完全不进 context，模型写代码调 API，仅结果回流。
- **官方口径原文**（"Effective context engineering for AI agents"，更新至 2026-10-18）："good context engineering means finding the *smallest possible* set of high-signal tokens"；system prompt 写在 "*right altitude*"（过细 hardcoding=脆弱，过泛=fail）；"minimal does not necessarily mean short"；**"smarter models require less prescriptive engineering, allowing agents to operate with more autonomy"**；"agentic design will trend towards letting intelligent models act intelligently"。
- **边界（官方自己承认 harness 未归零）**：《Effective harnesses for long-running agents》（2025-11-26）——Opus 4.5 在 Agent SDK 裸循环跨窗口做不出生产级 web app，需 prescribed harness 件（initializer 预置脚手架、跨窗口 feature list 持久化、增量进度文件、显式测试要求）。harness 管**结构化产物与验证规则**，模型管**判断与执行**。改进 agent 靠改工具不加 prompt（"can you add a formal rule in your tool calls"）。

### 2.2 OpenAI 系（对照组）

- GPT-5.1 prompting guide（2025-11）仍 prompt 级教 persistence/eagerness/verbosity——2025 年底 OpenAI 官方还在「教」。
- **2026-10-23 官方转向**：《Harness engineering: leveraging Codex in an agent-first world》——"give Codex a map, not a 1,000-page instruction manual"。列出巨型 AGENTS.md 四条失败模式：context 稀缺、guidance 互相稀释（"turns into non-guidance"）、文件腐烂、无法机械验证。方案：AGENTS.md 压到 ~100 行当目录，方法论下沉 docs/ 结构化知识库按需 grep；约束改 **linter/CI 机械强制**，违规时注入 remediation instructions；"enforcing invariants, not micromanaging implementations"。
- **AGENTS.md 生态基金会化**：2026-03-17 转 Linux Foundation 下 Agentic AI Foundation；60,000+ 开源项目采用；Codex/Cursor/Gemini CLI/Devin/VS Code 等 20+ 工具支持——项目级方法论「文件化按需」是主流扩张方向而非逆流。
- 竞品同构：Cursor Rules/Memories（system-level instructions 文件化）、Devin Playbooks（"like a custom system prompt for a repeated task"）、Gemini CLI GEMINI.md。Manus："KV-cache hit rate is the single most important metric" + "keep the system prompt really short and stable"。
- **工具设计承载方法论的量化正证**：apply_patch 做成托管工具类型（named function）后失败率降 35%（GPT-5.1 guide 自述）。

### 2.3 模型内化趋势

**支持侧**：

- mini-swe-agent：≈100 行纯 ReAct 循环 + 仅 bash 工具，SWE-bench Verified 74%+（官方自述 "Radically simple, no huge configs"）；SWE-bench 官网称顶级成绩来自 "no tools, no special scaffold structure"。
- GLM-5.2 官方表（2026-06-17）：Terminal-Bench 2.1 上标准轻 harness vs 重 harness——Opus 4.8：85.0 vs 78.9（Claude Code，重 harness **反低 6.1pp**）；GPT-5.5：84.0 vs 83.4。重 harness 对 frontier 模型已无稳定优势。
- ARC-AGI-3（2026-07）官方采用 "intentionally generic harness without tools or special features"。
- agentic RL 后训练内化：GLM-5.2 把 "long-horizon interactions, tool use, sub-task decomposition" 及 **compaction（压缩后继续干活）** 都训进模型（"we bring compaction into training by including all compacted sub-traces as trainable trajectories"）。

**边界侧（勿只采信支持侧）**：

- 同上 Anthropic 长时程文：裸跑不行。
- LangChain harness 工程（2026）：同一 GPT-5.2 Codex 仅改 harness，Terminal-Bench 2.0 从 52.8%→66.5%（+13.7pp），手段含 self-verification、tracing、context 优化——**放进 harness 而非 prompt 方法论**。
- arXiv 2607.22585：同模型不同 harness 排行榜差异最大 22pp，scaffold 是混杂变量。
- ARC-AGI-2：plain CoT 6.11% vs agentic coding 26.38%——工具能力供给在推理基准仍是 4 倍差距；弱/廉价模型靠工具与 scaffold 的红利仍在。
- Opus 4.5 发布材料自身：deep research eval 加 compaction/memory/subagents 仍 +≈15pp。

### 2.4 失败恢复责任划分（业界最新范式）

主流转向「**引擎确定性护栏 + 模型自主恢复**」，硬阶梯渐退：

- GLM-5.2 anti-hack 在线护栏：检测到 hack 行为时**引擎拦截该次工具调用、返回占位结果、让 rollout 继续**——明确反对整轨废除（"prevents the training instability and model collapse that can happen when rollouts are abruptly stopped"）。
- 分类学（LLM Recovery from Failed Tool Calls）：瞬时错误可在 loop 内静默 Retry；关键信息缺失则 Stop 交还用户；反思类交模型。
- pure v3.6.6 五刀（schema 一振剥/二振摘、relaySkip 不入账、context 只数 llm_error、429 退避）与该范式同构——引擎只做确定性自救与事实注入，绕路裁决交模型。

### 2.5 数据缺口（诚实声明）

未找到任何厂商公布「极简 prompt → 量化提升 X%」的硬数据；OpenAI harness engineering 只给失败模式与形态主张，无数字。**pure 每期真机对照验收（路由 vs 旧正则正确率、完成率不回退）即是补这块空白。**

## 三、pure 存量盘点（2026-11-01 实测）

### 3.1 常驻 system prompt（每回合必付）

| 段 | 位置 | 字符 | 性质 |
|---|---|---|---|
| character_core + expression | src/character/kernels/* | ≈6000 | 原则/身份（**红线不动**） |
| SYSTEM_CORE_PROMPT | promptLayers:35 | 2381 | 原则/身份(+少量机制) |
| HUMAN_TONE_PROMPT | promptLayers:360 | 2067 | 原则/身份 |
| output_style | PromptAssembler:258 | 2852 | **方法论** |
| COMPLEX_TASK_PROTOCOL_PROMPT | promptLayers:422 | 2334 | **方法论** |
| MULTI_AGENT_CORE | promptLayers:498 | ≈2100 | **方法论** |
| FILE_TOOLS_CORE | promptLayers:116 | 2016 | **方法论** |
| CAPABILITY_GAP_CORE | promptLayers:160 | 1834 | **方法论** |
| INFORMATION_VALUE_PRINCIPLE | agentBehavior:7 | 516 | 原则/身份 |
| DELIVERY_CONTRACT | promptLayers:486 | 1345 | **方法论** |
| LEDGER_PROTOCOL_PROMPT | promptLayers:402 | 1201 | **方法论**(机制用法) |
| work_invariant | PromptAssembler:554 | 1065 | **方法论** |
| PLAUSIBILITY_REVIEW_PROMPT | promptLayers:139 | 1026 | **方法论** |
| COMPLETION_PROMPT | agentBehavior:23 | 900 | **方法论** |
| PRE_COMMIT_REVIEW_CONTRACT | promptLayers:552 | 832 | **方法论**(产品决策) |
| LOGICAL_TRAPS_PROMPT | promptLayers:129 | 802 | **方法论** |
| TYPO_TOLERANCE_PROMPT | promptLayers:126 | 398 | **方法论** |
| capabilities/tool_calling/model_identity/skills 头/PUBLIC_API | PromptAssembler | ≈5000 | 机制事实 |
| INSERTION_PROTOCOL、VISUAL_BLOCK_POINTER、task_mode 等 | promptLayers/PromptAssembler | ≈4200 | 产品契约 |

**常驻方法论合计 ≈18.3k 字符（13 段）**；常驻总量 ≈41.5k 字符。

### 3.2 非常驻教学存量

- 按需闸门段 ≈17.6k 字符：CAP_GAP_LADDER 4682、INCREMENTAL_BUILD 3344、WORKFLOW 2326、可视化五段 5754、MULTI_AGENT_MECHANICS 1540。
- 引擎侧判定 prompts ≈29k：SEMANTIC_ROUTE_PROMPT 5245、INSERTION_CLASSIFY_PROMPT 6348、7 个子代理角色书 ≈8000、其余（Planner/Reflector）≈9k。非常驻但同属教学存量（蓝图未列，本期纳入验收口径）。
- 工具描述（126 条）顶层教学 ≈9k：switch_package_source 1483、diagnose_network 1128、execute_command 1069 等。另 MCP（rea 207 工具）全量 defs 随表。

## 四、与业界标杆的差距

**方向零差距**（五层分工=业界共识形态），**进度与两盲区**：

1. 施工进度：四期已全部落地（2026-11-01）——一期形态归还 45b2f21+07177a2、二期常驻段分流转载体 5568da4、三期工具 deferred 化 bd1d3c2、四期失败恢复深改 d3997e8 + 分区化 diff 渲染（worldStateRender.ts）。
2. 盲区 A：**工具 deferred 化须从「评估」升格为确定刀**。Anthropic tool search 已是官方机制（工具定义不进前缀）；pure 126 条描述 ≈13k 随表 + rea 207 工具 MCP——上百工具全量 defs 是几千 token 量级，刚需非优化。
3. 盲区 B：**引擎侧判定 prompts（≈29k）不在蓝图刀法清单**，纳入终态验收口径。

## 五、四期施工规划

**定位一句话：pure = 能力供给 + 机制事实注入 + 确定性护栏 + 索引层；模型 = 全部语义决策。教条不删，改载体。**

| 期 | 内容 | 删量/收益 | 对标 |
|---|---|---|---|
| **一期·形态归还**（原蓝图三期，重估条件已满足：插话改版 v3.4.1 已落） | ① 删 250 行形态判定正则族（detectProjectRequest/detectArtifactRequest/assessIntent/detectComplexity/detectFictionIntent/detectTraps/WORK_VERB_RE 族/EDIT_VERB_RE 族/taskKind 词表/CONTINUATION_PREFIX/CONFIRMATION_REPLIES）→ 语义路由（LLM router 已存在）接管，宿主只执行形态；generatePlan 6 步固定模板砍成「路由失败，请重试」。② insertionMessaging 22 个固定话术 → 收执=承接插话的模型在下一动作自然带出（receipt 唯一来源），引擎在模型缺席时**沉默**（宁可无话，不出机械腔） | ≈250 行正则 + 1.2k 话术模板 | Claude Code「宿主只执行、模型自主判断」 |
| **二期·常驻 13 段分流转载体**（蓝图刀 5 扩全） | 三类去向：**并工具 description**——FILE_TOOLS_CORE→find_files/read_file 描述、COMPLEX_TASK 开工纪律→委派/计划工具描述、MULTI_AGENT_CORE→委派工具描述；**归引擎门禁机械执行**——DELIVERY_CONTRACT、PRE_COMMIT_REVIEW、PLAUSIBILITY → delivery.ts 检查器 + 一次性注入式提醒（对齐 OpenAI「linter 强制不靠嘱咐」）；**直删**——CAPABILITY_GAP_CORE、LOGICAL_TRAPS、TYPO_TOLERANCE（模型内化程度已够） | 常驻 −≈12k 字符 | OpenAI「map, not manual」 |
| **三期·工具 deferred 化**（盲区 A 升格） | 内置 28 工具分核心常驻 + 长尾 discover（ToolSearch 基建已有先例）；MCP 工具强制走 discover——与 schema 清洗天然衔接（清洗已挂 discover 入库前）；工具描述教学与 deferred 化同刀合并瘦身 | 工具表 ≈13k → 核心 3–4k | Anthropic tool search / code execution with MCP |
| **四期·分区化 + 失败恢复深改**（蓝图五期 + 留档项） | ① 世界状态分区化 + diff 渲染：envFacts/taskState/ledger 分区 typed snapshot，重渲染只出 diff（状态不变零 token），缓存友好。② FailurePolicy 深改：count 混账分型（tool/llm/verify 分阶梯）、部分成功轮清零口径（镜像 Harness transient 豁免）、repeats≥5 强制 skip——对齐「引擎确定性护栏+模型自主恢复」：pure 只留确定性自救（schema 摘工具/4xx 分流），阶梯裁决权下放模型 | 阶梯裁决权下放；状态渲染零冗余 | GLM-5.2 anti-hack 范式 |

**不变量四条（全程守住）**：插话不丢（原话直投底线）；账不平不收工；人格红线（character_core/expression/human_tone 不删不改写）；缓存纪律（常驻区稳定渲染序，动态装配只走消息层与分区 diff）。机械解析豁免清单照旧（钟表算术/PLAN_PHASE 标记/delivery 命令发现/autoContinue 机械参数）。

**终态验收（更新版）**：常驻 system prompt ≈4k tokens（人格 ≈1.5k + 原则瘦身版 + 薄指针 + 索引）；运行时语义正则 ≤5 处（豁免清单不计）；收执话术模板 0（引擎沉默兜底）；工具表核心常驻 + 长尾 discover；引擎判定 prompts 纳入瘦身口径（SEMANTIC_ROUTE/角色书向 Claude Code 子代理 prompt 的精悍度看齐）；**每期真机对照验收**（形态正确率路由 vs 旧正则、任务完成率不回退、插话承接观感）。

## 六、风险与对策

| 风险 | 对策 |
|---|---|
| 弱模型方差变大（薄 prompt 后弱模型翻车多） | 护栏全走机制：schema 清洗、确定性自救、沙箱、引擎门禁——v3.6.6 已验证此路径在严格端点（deepseek）有效 |
| 业界无硬数据，方向错了怎么办 | 每期真机对照验收自带回退证据；一二期的插话改版已证明「删教条+机制承载」行为不回退 |
| 缓存击穿（prompt 拼装动态化后前缀不稳） | 不变量 4：常驻区稳定渲染序 + 分区 diff 渲染；Claude Code 2.1.302 cache bug 事故为前车之鉴 |
| 判定类正则删除后路由覆盖缺口 | 一期先跑「路由 vs 旧正则」影子对照，覆盖率达标再删 |

## 七、出处

- Piebald-AI/claude-code-system-prompts（第三方逐版跟踪，v2.1.314 / 2026-10-29）：github.com/Piebald-AI/claude-code-system-prompts
- Anthropic, "Effective context engineering for AI agents"（2025-09-29，更新至 2026-10-18）：anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, "Equipping agents for the real world with Agent Skills"（2025-10-16）：anthropic.com/research/equipping-agents-for-the-real-world-with-agent-skills
- Anthropic, Tool search tool（官方文档）：platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Anthropic, "Code execution with MCP"（2025-11-04）：anthropic.com/engineering/code-execution-with-mcp
- Anthropic, "Effective harnesses for long-running agents"（2025-11-26）：anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic, "Introducing Claude Opus 4.5"（2025-11-24）：anthropic.com/news/claude-opus-4-5
- Anthropic, "Building agents with the Claude Agent SDK"（2025-09-29）：anthropic.com/engineering/building-agents-with-the-claude-agent-sdk
- OpenAI, "Harness engineering: leveraging Codex in an agent-first world"（2026-10-23）：openai.com/index/harness-engineering
- OpenAI, GPT-5.1 Prompting Guide（2025-11-13）：cookbook.openai.com/examples/gpt-5/gpt-5-1_prompting_guide
- OpenAI, GPT-5.1-Codex-Max Prompting Guide（2025-11-19）：cookbook.openai.com/examples/gpt-5/gpt-5-1-codex-max_prompting_guide
- AGENTS.md（Linux Foundation 下 Agentic AI Foundation，2026-03-17 起托管）：agents.md
- z.ai, GLM-5.2（2026-06-17，重 harness 对照表 + compaction-in-training）：z.ai/blog/glm-5.2
- LangChain, "Improving Deep Agents with Harness Engineering"（2026）：langchain.com/blog/improving-deep-agents-with-harness-engineering
- arXiv 2607.22585, "The Scaffold Effect in Coding Agents: Harness Choice as a Confounder"
- Manus, "Context Engineering for AI Agents"（2025-07-18）：manus.im/blog/context-engineering-for-ai-agents-lessons-from-building-manus
- mini-swe-agent：github.com/SWE-agent/mini-swe-agent
- SWE-bench Verified：swebench.com/verified.html
- ARC-AGI（generic harness 口径）：arcprize.org
