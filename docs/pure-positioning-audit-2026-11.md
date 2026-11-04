# Pure 定位审计（2026-11）

> 基于当前代码库（`PromptAssembler`、`agentBehavior`、`SubagentOrchestrator`、`AGENTS.md` 等）对比纯定位与业界最新 Agent 的审计结论。
> 2026-11-05 复核：多数 Phase 建议已是完成时或已裁定不做（见「现状复核」节）；本文档作差距参考而非施工单，净增量仅 Phase 3 自省空间一条。

## 核心结论

pure 当前的实现与其期望定位之间存在**哲学性脱节**：

- **期望定位**：多 agent、可自进化的 AI Agent 智能体。形式上是工具和插件的集合，没有章法、没有规矩，只保留基本的输入、输出和做事底线原则。至于怎么做、用什么做、怎么用、怎么呈现，全由大模型决定。
- **当前实现**：大量"系统替模型做决策"的设计（提示规则、流程强制、多 agent 硬触发、复杂编排）。系统比模型更懂"该怎么做"。

**要达成期望定位，核心思路不是加功能，而是大量删减。**

## 核心差距点

| 维度 | 当前状态 | 期望状态 | 差距 | 建议 |
|---|---|---|---|---|
| **系统提示** | 极度规则化。`PromptAssembler` 装配 `work_invariant`、`INFORMATION_VALUE_PRINCIPLE`、`PROACTIVE_WORKFLOW_PROMPT`、`INCREMENTAL_BUILD_PROMPT`、`COMPLETION_LESSON_PROMPT` 等大量 fragment。`AGENTS.md` 也有多 agent 触发、语言约定等硬性规则。 | 极简，只保留输入/输出、底线原则（安全、权限、不可逆操作确认、密钥保护等最少必要约束）。一切流程、汇报格式、最佳实践交给模型决策。 | **极大** | 按"删掉后大概率还会做对吗？只有灾难性后果才留"筛选。大幅精简 `PromptAssembler`，砍掉大部分 workflow/incremental-build 规则。 |
| **工具系统** | 工具定义完备，但使用方式被 prompt 规则约束。`ToolExecutionCoordinator` 按 `isWrite` 分读写池：读池真并发（2026-09-20 已修旧假并行——sideEffects 曾把 SHELL/AGENT/MCP 误关进串行池，四个并行委派被一个接一个跑），写池串行 + FileLockManager per-path 锁；并发上限可配。 | 工具就是能力集合。模型自主决定用哪个、怎么组合、并行还是串行。 | **中到大**（2026-11-05 复核：并发调度已是纯技术约束形态，与右列建议一致；差距主要剩 prompt 规则对使用方式的约束） | 去掉大部分调度规则，只保留最必要的纯技术约束（如文件锁防冲突）。让模型自己决定调度顺序。 |
| **多 Agent** | `SubagentOrchestrator` 极为复杂：预算、超时、重试、自愈、steering、checkpoint 恢复、记忆注入、人格继承、进化注入等。`AGENTS.md` 用 T1/T2/T3 硬性触发条件强制启用多 agent。 | 最小子 agent 机制：能 spawn 独立上下文的 agent，用完即走，纯工具+提示。主模型自主判断要不要用、用几个、怎么协作。 | **极大** | 简化为 `spawn_subagent(task, tools, context) -> result`。彻底去除硬性触发规则和大部分编排逻辑（预算强制、复杂 retry、steering 注入等）。 |
| **自进化** | 有进化轨迹（`src/evolution/*`）、记忆库、子 agent 记忆注入、persona overlays 等。但都是被动记录，系统主导的"设计式进化"，而非模型自我改造。 | 真正可自进化：模型能总结经验、改进自身工作流、增删工具用法、甚至建议新增工具/插件，全由模型主导并持久化。 | **中** | 新增模型可写入的持久化自省空间（如 `~/.pure/self-evolve/`），在上下文加载。允许模型总结经验、调整工作偏好。未来可考虑允许模型提议修改工具描述（需谨慎控制变更范围）。 |
| **插件化** | 有 MCP、skills、harness 等概念，但整体仍是 monolith 架构。`SubagentOrchestrator` 等核心组件硬编码大量逻辑，模块间耦合较重。 | 真正的"工具+插件堆"：插件热插拔，核心极简只做调度。角色、流程全由模型自定义。 | **中** | 向极简调度层演进。核心不再内置 "reviewer"/"editor" 等预设角色，所有能力都通过插件/MCP/skill 加载。减少核心对具体能力的硬编码。 |

## 对比业界

| 产品 | 系统提示 | 多 Agent | 工具调用 | 自进化 | 趋势 |
|---|---|---|---|---|---|
| **Claude Code** | 极简，主要是工具描述 + 基本约束 | 简单的 Task/subagent，编排逻辑少 | 工具为主，模型自主决策 | 较弱（多靠 CLAUDE.md 人工维护） | **最接近期望定位** |
| **Codex CLI (OpenAI)** | 极简，"just solve the problem" 思路 | 较轻的 subagent/并行执行 | 工具驱动，minimal rules | 较弱 | **非常接近期望定位** |
| **RooCode/Cline** | 中等，模式化但仍较灵活 | 有模式/orchestrator，但相对灵活 | 工具丰富，模型决策为主 | 中等（custom instructions 可调整） | 中庸 |
| **OpenCode** | 极简，plugin-first 架构 | 简单，强调可扩展 | 工具+插件堆形态 | 强调可定制化，插件生态驱动 | **在架构上最符合期望定位** |
| **LangGraph/OpenAI Agents SDK** | 框架型，强制工作流（graph/state machine） | 显式编排，强制流程 | 工具驱动但强制流程 | 较弱 | 完全相悖，不适合此定位 |

## 建议路线

| 阶段 | 目标 | 具体动作 |
|---|---|---|
| **Phase 0: 识别底线** | 划定不可动范围 | 只保留安全、权限、不可逆操作需确认、不要泄露密钥、不要破坏未备份数据等真正的底线。把所有"最佳实践"、"工作流"、"汇报格式"都视为可删。 |
| **Phase 1: 精简提示** | 大幅削减系统提示 | 删掉 `work_invariant` 大部分条款、全量删除 `PROACTIVE_WORKFLOW_PROMPT`、`INCREMENTAL_BUILD_PROMPT`。只保留工具列表 + 底线原则。让模型自己决定流程、顺序、汇报方式。 |
| **Phase 2: 瘦身多 Agent** | 回归最小子 agent | 重构 `SubagentOrchestrator`：去掉预算强制、复杂 retry、自愈、steering 注入、过多 checkpoint 逻辑。删掉 `AGENTS.md` 中的 T1/T2/T3 硬性触发规则，把多 agent 的使用权完全交还给主模型。 |
| **Phase 3: 真正的自进化** | 打通自我改造通道 | 新增 `self_evolve` 持久化空间，允许模型写入经验、偏好、工作流、工具用法心得。每次会话加载到上下文。允许模型总结并持久化，逐步形成自己的"使用手册"。 |
| **Phase 4: 插件化收束** | 成为真正的工具堆 | 将核心再精简到最小调度层，所有能力通过插件/MCP/skill 加载。核心不再知道预设角色（reviewer/editor/planner 等），角色全由模型在运行时自定义。 |

### 现状复核（2026-11-05）

- **Phase 0**：判据已吸纳进瘦身流程（「删掉后大概率还会做对吗」即现行筛选标准），持续态。
- **Phase 1 大头已完成**：常驻提示 14.7k→8,194tk 双轮瘦身；`PROACTIVE_WORKFLOW_PROMPT` 6528→632 字符。残余 `INCREMENTAL_BUILD_PROMPT`/`work_invariant` 保留——6k 人格地板已裁定，属「不必删」而非「没删」。
- **Phase 2 部分完成，其余已裁定保留**：插话端口化、机械处理退役已落；`SubagentOrchestrator` 的预算/watchdog/自愈是真机事故学费（概率性中断误杀判例），`AGENTS.md` T1/T2/T3 是用户亲手定的产品决策——按本表建议删除将推翻既定决策，不在执行范围。
- **Phase 3 通道部分已通**：设置面板 agent 可语义操作（config.json 真实源）、presentationCards 模型可写、自愈裁决权归模型。未做：独立自省持久化空间——本文档的净增量，与 2026-11-03 定调（模型裁决、pure 做感知手脚）同向，P3 候选。
- **Phase 4 未做**，未排期。

## 核心建议

**先做减法，而不是加法。** 按照"减法审计"原则逐条审查：每一条提示规则、每一段编排逻辑都要问"如果删掉这条，模型还会做对吗？"。只有答案是"会导致灾难性后果"（泄密、越权、删库等）才保留，其余一律删除。

pure 要想真正贴近其定位，最关键的是**放权**：放弃"系统知道怎么做更好"的假设，转向"给模型工具和底线，让模型自己想办法"的思路。
