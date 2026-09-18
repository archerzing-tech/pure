# 差距分析：pure 与主流 Agent（截至 2026-08）

> 参照时点：2026 年 8 月。对象：Claude Code（2.1.x）、OpenAI Codex（GPT-5.x-Codex）、Google Antigravity（2.0）、Cursor（2.0）、Devin（Cognition）、OpenHands、Warp。事实均来自当期公开资料，来源附文末。

## 一、2026-08 的主流格局：五个关键词

1. **并行与隔离成为标配**。Cursor 2.0 用 git worktree / 远程机器同时跑 8 个互不干扰的 agent；Claude Code 8 月的更新主线就是"多任务并行"；Codex Cloud 每个任务一个一次性容器。共识：**并行 agent 必须有文件系统级的隔离，否则互相踩踏**。
2. **异步执行 / 云端托管**。Codex Cloud、Devin（多天级工单、自动开 PR）、Cursor Background Agents、Google Jules——"派活然后走人，回来看结果"已经是主流产品形态。
3. **可编程Hooks + 技能生态**。Claude Code 的 hooks 允许用户在生命周期点上挂自己的 shell 命令（8 月底还加了 PreModelSwitch/PostModelSwitch）；Agent Skills 的 SKILL.md 文件格式正在成为跨工具标准，社区已有 380+ 技能的合集；Confluent 等企业把"MCP server + Agent Skills"当正式产品发。
4. **基准换代**。SWE-bench Verified 已打满（头部 ~96%），社区转向 Terminal-Bench（已迭代到 4.0，含连续验证防污染）和 SWE-bench Pro（头部 ~69%）。**评测能力本身成了产品竞争力**。
5. **安全成为显性议题**。"agentjacking" 波及 85% 的编码 agent、MCP 工具投毒、492 个暴露的 MCP server、OWASP 出了 Agentic Skills Top-10——权限与供应链安全从卖点变成了底线，也开始分化出"可信 agent"的溢价。

顺带一提对 pure 有利的消息：Google 把 Gemini CLI 并入 **Antigravity 2.0 桌面应用**（2026-06），说明"桌面端沉浸式 agent 工作台"这个方向被巨头验证了。pure 的差异化选对了赛道。

## 二、pure 现状对照

已经**领先或持平**的部分（不需要动）：

- **证据驱动循环 + 升级式失败策略**：概念上不输任何人，缺的是公开证据（见差距 1）
- **权限系统**：四模式 + 风险分级 + 缓存键设计 + macOS Seatbelt 兜底，比多数竞品的"YOLO 开关"细
- **记忆系统**：衰减半衰期 + 验证门控晋升，比"无限堆积式"记忆先进
- **双表面一致性**（GUI/CLI 同一编译器）、**分层 prompt**、**拟人化语气工程**：这些是 pure 独有的工艺
- **模型中立**：9 家供应商 + 双 wire protocol，2026 年"换大脑不换身体"依然是真需求

## 三、差距清单（按优先级）

### P0-1 评测太薄：3 个 fixture vs 行业基准体系

pure 的核心主张是"证据驱动、绝不静默交差"，但仓库里只有 3 个确定性 fixture。主流世界里评测就是产品的简历：Terminal-Bench 4.0、SWE-bench Pro 都是现成的题目库。

**建议动作**：
- 短期：把 evals 从 3 个扩到 20–30 个，覆盖 bugfix/feature/refactor 之外加"多步长任务""失败恢复""权限拦截"类目——pure 的循环创新（FailurePolicy、continueGuard）恰恰在这些类目里，现在完全没有数字证明
- 中期：接入 Terminal-Bench 式的容器化任务（每个任务一个隔离环境 + 验证命令），跑 provider × loop 矩阵（GLM-5.3 在 Terminal-Bench 4.0 是 41.8%，头部 58%——pure 能不能靠循环补回这个差值，是个值得公开回答的问题）
- 每次发布自动跑，写进 CHANGELOG

**成本**：低-中。这是**投入产出比最高的一项**，因为 pure 的差异化全是"看不见的机制"，只有评测能让它可见。

### P0-2 并行与隔离：严格串行 vs worktree 范式

pure 的任务队列是刻意设计成"严格串行、单飞"的，子代理在进程内跑，没有 git worktree 集成，没有容器隔离。2026-08 的主流已经完成"单线程对话 → 多 agent 并行工作台"的范式迁移。

**建议动作**：
- 第一步（GUI 优势项）：支持同一 workspace 的多会话并行，每个会话自动落在独立 git worktree 里——pure 的 Harness 是按会话隔离的，天生适合这个模型；Tauri GUI 渲染多任务卡片比终端有天然优势
- 第二步：`execute_command background:true` 已经有了，往上补一层"后台任务面板"（状态、日志、取消），把已有能力产品化
- 容器隔离（每任务一个一次性环境）放最后——对桌面个人工具，worktree + 现有沙箱已够 80%

**成本**：中。Harness 的会话模型不用动，主要是 GUI 和 worktree 生命周期管理。

### P0-3 异步执行缺席：桌面绑死 vs "派活走人"

纯本地、会话绑死的执行模型，和"回来看 PR"的主流形态差距最大。但 pure 不必建云平台。

**建议动作**：
- 本地异步先做：关闭窗口 agent 继续跑（Tauri 托盘 + 分离进程），完成后系统通知 + 下次打开看结果。pure 的检查点/恢复体系（`turn_completed` / `interrupted` checkpoint）已经把地基打好了
- 通知渠道：系统通知 +（可选）邮件/webhook，对齐"派活走人"的最低体验
- 云端托管**不做**（见第五节）

**成本**：中。

### P1-4 用户可编程 Hooks：程序内部 vs 用户生态

pure 的 7 个 engine hooks 是代码内部接口，用户碰不到。Claude Code 证明了 hooks 是用户粘性最高的扩展点（确定性控制 > 提示词祈祷）。

**建议动作**：加一层用户可配的 hooks（如 `~/.pure/hooks.json`：`on_pre_tool` / `on_post_tool` / `on_turn_complete` → shell 命令），且**走 pure 自己的权限门**——hooks 的执行也该弹确认，这本身就是和其他家拉开差距的点。

**成本**：低。HookRouter 已在，缺的只是配置面和执行器。

### P1-5 MCP 只接了一半

pure 只接了 MCP 的 tools；resources（上下文注入）、prompts、OAuth（HTTP server 授权）、registry 发现都没接。2026-08 MCP 生态在二次爆发（MCP Apps、企业 GA），同时安全问题集中爆发。

**建议动作**：接 resources + prompts → HTTP MCP 的 OAuth → **把安全做成卖点**：对第三方 MCP server 的工具描述做投毒特征检查、接入 registry 时展示"已扫描/已签名"状态。pure 的权限体系是现成的底座，"最可信的 MCP 客户端"是一个没人占住的位置。

**成本**：resources/prompts 低，OAuth 中，安全扫描中。

### P1-6 Git 工作流不是一等公民

pure 的 git 三件套全是只读，写操作被权限测试显式拒绝（"rejects guarded Git mutations"）。而主流 agent 的默认产出物是 **commit / branch / PR**——Codex 的自动代码评审、Claude Code 的 PR 工作流都长在这上面。pure 有 code_reviewer 子代理，但没有接到任何 PR 流程上。

**建议动作**：加受权限门控的 `git_commit` / `git_branch` / `create_pull_request` 工具（medium 风险，弹确认卡）；把 code_reviewer 子代理包装成"提交前自动评审"环节——pure 的证据驱动循环天然适合"改完 → 评审 → 带证据合入"。

**成本**：低-中。

### P1-7 Skills 生态对齐 + 供应链安全

pure 已经读 SKILL.md（CLI 走 npx skills），但 2026-08 的技能生态正在被攻击（OWASP Top-10、Snyk 扫出近 4 千技能的问题）。pure 的 `skills-lock.json` 已经记 hash——往前一步就是**签名与来源审计**。

**建议动作**：完整对齐 Agent Skills 标准（进/出双兼容）；技能安装时展示来源、hash、权限需求；"已验证技能"标记。和小丑鱼同游是免费的，但要做那条鱼群里唯一查健康证的。

**成本**：低。

### P2-8 上下文工程：20 条窗口 vs 百万 token 时代

竞品进入 1M token 上下文时代，pure 的压缩是"20 条消息窗口 + 摘要兜底"。字节稳定的 system prompt 对 provider 侧缓存友好，但没显式利用 prompt caching（cache_control / 缓存计费优化）。

**建议动作**：压缩从"条数窗口"升级为"token 预算 + 语义边界"（tool-call 组原子已经做对了，方向没问题）；在 PromptAssembler 里显式打缓存断点标记；长会话基准测试进 evals。

### P2-9 每阶段模型路由

主流在做模型切换 hooks（PreModelSwitch）。pure 的五状态结构让**按阶段路由模型**变得自然：THINK 用强模型、机械性 ACT 用便宜模型、VERIFY 用带 web 搜索的模型。这是别的架构做不了、pure 的架构白送的特性。

**建议动作**：作为实验特性放出，用 P0-1 的评测矩阵验证收益。

### P2-10 跨平台沙箱

Seatbelt 只在 macOS。pure 明确支持 Windows（PowerShell -EncodedCommand）和 Linux，但内核级兜底缺位，非 mac 上 YOLO 模式的最后防线是空的。

**建议动作**：Linux 用 bubblewrap、Windows 用受限令牌 + Job Object，各做最小可用版；做不了就**显式降级提示**（"此平台无沙箱，建议 NORMAL 模式"），别静默。

## 四、优先级总表

| 优先级 | 事项 | 一句话理由 | 成本 |
|---|---|---|---|
| P0 | 评测体系扩容 + Terminal-Bench 式容器任务 | 差异化不可见 = 不存在 | 低-中 |
| P0 | worktree 并行会话（GUI 多任务工作台） | 主流范式已迁移，GUI 是 pure 的主场 | 中 |
| P0 | 本地异步执行（托盘 + 通知） | "派活走人"是主流形态，地基已有 | 中 |
| P1 | 用户 hooks（带权限门） | 粘性最高的扩展点，HookRouter 现成 | 低 |
| P1 | MCP 补全 + "最可信客户端"定位 | 生态二次爆发 + 安全真空期 | 中 |
| P1 | git 写工具 + 提交前自动评审 | 主流产出物是 PR，不是聊天记录 | 低-中 |
| P1 | Skills 签名与审计 | 生态被攻击期，信任是稀缺品 | 低 |
| P2 | token 级压缩 + 缓存断点 | 长会话体验与成本 | 中 |
| P2 | 按阶段模型路由 | 架构白送的差异化 | 低 |
| P2 | Linux/Windows 沙箱或显式降级 | 别让 YOLO 在非 mac 裸奔 | 中 |

## 五、明确不追的（对单人项目同样重要）

- **云端托管平台**（Codex Cloud / Devin 的形态）：运维成本会吞掉全部开发时间，本地异步做到位即可
- **自研 IDE / 编辑器**：Antigravity 和 Cursor 的战场，pure 的桌面工作台已是差异化，别开辟第二战线
- **追 SWE-bench 榜单**：已打满、且是模型能力的榜单不是 agent 框架的；Terminal-Bench 式任务更能体现 pure 循环的价值
- **多人群协作 / 团队管理**：单人不该背多租户的复杂度
- **自研模型**：模型中立是 pure 的立场，也是成本护城河

## 六、三个月路线建议

- **第 1 个月**：评测扩容到 20+（P0-1 前半）+ 用户 hooks（P1-4）+ git 写工具（P1-6）。全是低成本高确定性项，且 hooks/git 会立即被自己 dogfood。
- **第 2 个月**：worktree 并行会话 + 后台任务面板（P0-2）。GUI 工作台成型。
- **第 3 个月**：本地异步执行 + 通知（P0-3）+ MCP resources/prompts 与安全扫描（P1-5）+ Skills 签名（P1-7）。
- 穿插：每次发布跑全量 evals 写进 CHANGELOG；Terminal-Bench 式容器任务作为月度目标滚动推进。

## 主要来源

- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks) / [Hooks guide](https://code.claude.com/docs/en/hooks-guide) / [Claude Code release notes 2026-08（v2.1.251，PreModelSwitch）](https://updatify.io/releases/claude-code) / [Claude Code 2026 Q2 特性综述](https://wal.sh/research/2026-q2-claude-code-features/)
- [Introducing upgrades to Codex（OpenAI）](https://openai.com/index/introducing-upgrades-to-codex/) / [Codex Cloud 解析](https://www.agent37.com/blog/codex-cloud) / [Codex 2026 评测（多方案预览）](https://zackproser.com/blog/openai-codex-review-2026)
- [Google：Gemini CLI 向 Antigravity CLI 过渡](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) / [Introducing Google Antigravity](https://antigravity.google/blog/introducing-google-antigravity) / [Google Cloud I/O '26：Antigravity 2.0](https://cloud.google.com/blog/topics/developers-practitioners/io26-news-for-agent-developers-on-google-cloud)
- [Introducing Cursor 2.0 and Composer（worktree 并行）](https://cursor.com/blog/2-0) / [Composer：RL 训练的前沿模型](https://cursor.com/blog/composer)
- [SWE-bench 官方榜单](https://www.swebench.com/) / [SWE-bench Verified](https://www.swebench.com/verified.html) / [Terminal-Bench 官网](https://www.tbench.ai/) / [Terminal-Bench 4.0 榜单](https://codingfleet.com/blog/terminal-bench-4-leaderboard-2026/) / [SWE-bench Pro 解析](https://codingfleet.com/blog/swe-bench-pro-explained-the-new-standard-for-ai-coding-benchmarks-2026/)
- [2026 最佳 AI Coding Agent 对比（Terminal-Bench 维度）](https://www.morphllm.com/ai-coding-agent) / [2026 编码 agent 平台综述](https://www.marktechpost.com/2026/06/10/ai-coding-agents-development-platforms-2026/)
- [2026 Agentic 趋势（MCP 复兴、可验证性）](https://www.firecrawl.dev/blog/agentic-ai-trends) / [CNCF：云原生 agentic 标准（MCP/A2A）](https://www.cncf.io/blog/2026/03/23/cloud-native-agentic-standards/) / [AI Agent 安全风险（agentjacking 85%）](https://blog.cyberdesserts.com/ai-agent-security-risks/) / [OWASP Agentic Skills Top 10](https://owasp.org/www-project-agentic-skills-top-10/)
