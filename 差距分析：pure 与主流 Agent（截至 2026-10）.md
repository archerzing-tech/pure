# 差距分析：pure 与主流 Agent（截至 2026-10）

> 参照时点：2026-10-27。上一份：[截至 2026-08](差距分析：pure%20与主流%20Agent（截至%202026-08）.md)。对象：Claude Code（2.1.30x）、OpenAI Codex CLI（0.147+）、OpenCode、Cursor 2.0、Antigravity 2.0。
> 事实来源：pure 侧来自源码盘点（src/、evals/、git tag v3.3.5–v3.3.14）；前沿侧来自 2026-10 公开报道（文末）+ 本仓库 prompt 审计实测（docs/system-prompt-layer-audit-2026-10.md）。盘点与评判分离（调研 agent 盘点、本文独立评判）。

## 一、10 月前沿格局：多 agent 从"特性"变成"底盘"

1. **后台 agent 常驻化**。Claude Code 支持后台子 agent（完成时收通知，可中途追加指令、可叫停）；Codex CLI 0.147 加 `/agents` 统一管理在跑 agent，配 agent plugins、thread sections，ChatGPT 桌面端可管多个并行 Codex。"派活—走人—回来收"已是默认产品形态。
2. **多会话管理面**。"同屏看多个 agent 干活"的网格/画布视图进入各家对比评测的标配维度；Cursor 的 worktree 并行（8 agent）仍是这条线的代表。
3. **技能生态跨厂商标准化**。Open Agent Skills 成为 Claude Code / Codex / Cursor 共同格式，技能跨家复用。
4. **跨仓上下文**。Claude Code 自 2026-09-29 支持最多 10 个关联仓库共享上下文。
5. **基准继续快速爬升**。Terminal-Bench 第三方榜单头部从 8 月的 ~58% 涨到 10-25 的 ~85%（第三方口径）；SWE-bench Verified 头部 ~96% 已无区分度。框架层竞争焦点转向 Terminal-Bench 式长任务与可验证性。
6. **上下文工程成为显学**。Anthropic 2026-07 把 CC 系统提示词砍 80%（2,686→514 词）无回归；"规则→判断、例子→接口、前置→渐进披露"六条反转已成方法论。

## 二、pure 现状（v3.3.14 源码盘点口径）

- **委派**：角色即工具（8 内建角色 + `~/.pure/subagents/` 生成角色试用制），同回合多委派进并发池，子代理独立 engine + 派生预算 + 角色级记忆注入；DelegationControlPlane 记账（ag-xxx、token 并账、evolution 埋点）。
- **隔离**：worktree 按**会话**隔离（第二会话开同一仓库自动建，worktreeBinding.ts）；子代理共享父工作区，无 per-agent 隔离。
- **计划**：纯文本控制行协议（`src/ui/plan.ts:81`），无 todo 类工具；待办队列是宿主侧的，模型不可直接写。
- **插话**：五类分发（直接回应/取消/转向/折入/押账），置信门 + 轻模型 judge + 覆盖花名册去重 + 安全网反转。v3.3.11–12 密集重做后是全仓库最深的一套机制。
- **持久化**：快照覆盖待办队列+押账插话（roundClosePlane.ts:184）；子代理暂停态盘上 checkpoint 重启可续；长期记忆 lessons/procedures + 跨项目机器级教训常驻注入。
- **并行后台**：`execute_command background:true`（脱离运行返回 pid+logFile）；并行机会读数进进化面板；scheduler 前端态、关机即失。
- **工具面**：29 内建 + 5 动态能力（skills/MCP 发现连接注册）+ 8 角色工具。
- **评测**：baseline v5（15 fixture 真实验证命令）+ roles（角色级回归）+ character（人格门）+ work-order（分量判读）四轨道，带 compare/snapshot/harvest。
- **已立案未落**：子代理续跑三期、瓶颈视图 UI 无消费者、计划 diff/自动候选比较（multi-agent-design Phase 5）、CLI 插话输入路、父回合 checkpoint（蓝图第 8 期）。

## 三、8 月差距清单复核

| 8月编号 | 事项 | 现状 | 剩余缺口 |
|---|---|---|---|
| P0-1 | 评测太薄 | **大半闭合**（4 轨道+对比链路） | 真实 provider 矩阵常态化；公开数字；容器化长任务 |
| P0-2 | 并行与隔离 | **部分闭合**（并行池+并行委派+会话级 worktree） | per-agent 隔离；多会话任务面板；后台任务产品化 |
| P0-3 | 异步执行 | **已闭合主体**（路线图 5.1–5.3：托盘关窗续跑、SettleNotifier 三态系统通知+点击跳转、托盘在跑任务菜单；5.4 真分离进程=S3 明确缓行） | 单实例锁；隐藏态 WKWebView 节流防护；Dock 徽标/未读回看 |
| P1-4 | 用户 hooks | **未动** | 配置面+执行器（HookRouter 已在） |
| P1-5 | MCP 一半 | **部分**（tools+发现/连接/注册） | resources/prompts；OAuth（安全侧按决策不追） |
| P1-6 | git 写工具 | **闭合**（落地且自动放行） | code_reviewer 未接 PR/提交前自动评审流 |
| P1-7 | skills 签名审计 | **转入不追**（2026-09-17 决策） | — |
| P2-8 | 上下文工程 | **部分**（85% 主动压缩、记忆总帽） | 显式缓存断点；缓存顺序缺陷（audit 已定位）；token 级压缩 |
| P2-9 | 每阶段模型路由 | **萌芽**（judge 已走轻模型 phaseModels） | 阶段级路由实验 |
| P2-10 | 跨平台沙箱 | **转入不追**（同上） | — |

两个月净结论：**10 项里闭合 1.5 项、大半闭合 1 项、部分闭合 4 项、未动 1 项、转不追 2 项**。推进集中在评测与委派观测，产品形态项（异步、面板、hooks）基本原地。

## 四、三轴差距

### 能力轴

| 维度 | 前沿 2026-10 | pure 现状 | 判定 |
|---|---|---|---|
| 后台异步 | 后台 agent+通知为标配 | 托盘关窗续跑+三态通知+托盘任务菜单已落（5.1–5.3）；真分离进程（5.4=S3）未做 | 差距收窄为「真分离」一档；补单实例/节流防护/徽标即齐 |
| 并行隔离 | worktree/容器 × 8–10 agent | 会话级 worktree + 进程内并行池 | 落后一档 |
| 跨仓上下文 | CC 10 仓共享 | 无 | 落后 |
| 用户扩展点 | hooks/plugins/技能标准三件套 | 技能读兼容+MCP tools；hooks 用户不可配 | 落后 |
| 计划状态 | update_plan/TodoWrite 结构化工具 | 文本控制行协议 | 落后（audit 已立案，注意插话耦合） |
| 渠道与呈现 | 终端/云端为主 | 飞书/钉钉网关+富输出降级光栅化+可视化 DSL | **领先** |
| 模型中立 | 各家绑自家模型 | 9 家供应商+双 wire protocol+32k 本地档 | **领先** |
| 委派观测 | 无公开对等物 | 记账/token 并账/evolution trace/瓶颈聚合器 | **领先**（缺 UI 消费者） |

### 智能轴

**领先**：插话统筹（五类分发、押账重入、覆盖花名册、安全网——主流的 ESC 式粗中断没有对等物）；证据驱动失败升级循环；人格内核双投影+character 门；角色生成试用制自进化。

**落后**：
1. 计划状态工具化（文本协议 vs 结构化工具，模型自查/恢复/并行标注都弱一截）
2. 上下文工程（系统提示词 14.6k vs CC ~3k；单回合 regex 门控；缓存顺序缺陷）——工具 schema 反而极省（6.2k vs CC 14.8k），胖瘦错位明显
3. 长任务调度与止损分寸（蓝图第 5/6 期 pending）

**结构性洞察**：pure 的智能投入集中在**交互智能**（怎么跟人打交道），frontier 集中在**执行智能**（怎么把长任务跑完）。这是错位不是全面落后——插话+证据循环没人有，调度+止损没人替 pure 做。补执行智能不必牺牲交互智能，两头都占是 pure 的蓝海位。

### 性能轴

- **固定开销**：pure ~20.8k（系统 14.6k+工具 6.2k）vs CC ~18k vs OpenCode ~7k → 中游。审计改进计划的阶段 0–1 正对此：目标固定开销 ≤ CC。
- **并行度**：单回合内可并行委派+工具池；跨会话严格单飞 → 差在跨 agent 并行工作台。
- **通路韧性**：LLM 连接池半开自愈、GitHub 加速节点健康缓存、装依赖多源轮换——独有的通路工程，frontier 少见公开对等物。
- **基准盲区**：frontier 头部两个月 58%→85%，pure 有四条评测轨道却无公开数字、未接发布门 → **性能维度不可比是当前最大问题**（轨道都在，缺变现）。

## 五、真正的差距（按投入产出排序）

1. **后台异步收尾三小片**：5.1–5.3 已落（本表 2026-10-27 晚纠偏：初版误判未落），剩单实例锁（双开会话账本互踩）、隐藏态节流防护（App Nap 掐 webview 定时器）、Dock 徽标+未读回看；真分离进程=5.4/S3，仍缓行。
2. **多会话任务面板**：把已有的会话级 worktree 隔离翻成 GUI 工作台（pure 桌面端主场，做出来即与终端系拉开）。
3. **计划工具化**：audit 改进计划已立案，施工前对齐插话/押账案例集（修正②）。
4. **prompt 预算瘦身+缓存排序修正**：audit 阶段 0–1，顺手把 8 月 P2-8 的缓存断点一起收。
5. **eval 发布门+公开数字**：eval:compare 已能跑，缺"每次发布跑全量、写进 CHANGELOG"的纪律。
6. **跨仓共享上下文**：CC 已到 10 仓；pure 在上下文注入层做，成本相对低。
7. **用户 hooks**：HookRouter 现成，粘性最高的扩展点，仍是低成本项。
8. **MCP resources/prompts**：补全生态位（OAuth/投毒扫描按安全决策不追）。

## 六、明确不追（更新版）

云端托管平台、自研 IDE、榜单刷分、多租户、自研模型（沿 8 月结论）+ **安全/权限加固类全项**（skills 签名、跨平台沙箱、MCP 投毒扫描、滥用拒绝策略——2026-09-17 拍板"优先智能化、自动化、效率"，2026-10-27 复确认）。附注：工具结果注入防御（audit S8.3）属执行正确性，不在此列，保留。

## 主要来源

- Claude Code：多仓共享上下文（[SkillsLLM 2026-09-29](https://skillsllm.com/news/ai-news-2026-09-29)）；技能跨厂商标准（[Composio](https://composio.dev/blog/skills-cursor-claude-code-openai-agents-open-standard)）；后台 agent/Monitor/SendMessage/TaskStop 为本机 Claude Code 环境实测存在；固定开销数字见 docs/system-prompt-layer-audit-2026-10.md
- Codex：0.147 agent plugins/thread sections/`/agents`（[ReleaseBot 2026-10](https://releasebot.io/blog/codex-updates-october-2026)、[Reddit r/OpenAI](https://www.reddit.com/r/OpenAI/comments/1oc6bwn/codex_cli_01470_is_out_and_its_a_big_one/)）；agent loop 深拆（[OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop)）；桌面多 agent（[IntuitionLabs](https://intuitionlabs.ai/articles/openai-codex-complete-guide-2026)）
- 基准：Terminal-Bench 头部 ~85%（[llmbenchmark.ai，2026-10-25](https://llmbenchmark.ai/benchmarks/epoch-terminal-bench)）；SWE-bench Verified ~96% 打满（8 月分析口径）
- 方法论：Anthropic 上下文工程六反转（audit 文档已核）
