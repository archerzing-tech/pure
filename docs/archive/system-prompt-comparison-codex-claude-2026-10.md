# 提示词三方对比：pure vs Codex 与 Claude Code（截至 2026-10）

> 资料来源：codex 开源仓库 main@2026-10-27 原文（models.json 在役目录 + 各 prompt 文件，本地存档 /tmp/codex-prompts/）；Claude Code 逆向跟踪库 Piebald-AI/claude-code-system-prompts（v2.1.300，2026-10-14，515 片段 314 版）+ Anthropic 官方 Agent SDK 文档口径。第三方逆向数据的精确措辞以原库为准。
> 关系：本文与《系统提示词分层审查》（docs/system-prompt-layer-audit-2026-10.md）互补——审计讲 pure 自身缺陷（S1–S9），本文讲三方对照后的**增量优化点**，每条标注与审计的关系。

## 一、三方画像

| | pure | Codex（gpt-6.1-sol 旗舰） | Claude Code（v2.1.300） |
|---|---|---|---|
| 系统段量级 | ~14.6k tk 常驻 | ~5.4k tk | 瘦身后 ~3k tk（2026-07 删 80%）+ 动态节 |
| 工具 schema | 6.2k / 28 工具（极省） | 机制教学已迁出 base | 14.8k / 23 工具（胖工具路线） |
| 结构形态 | 三层 fragment + priority 预算制 | **数据化**：models.json 按 slug 下发 instructions_template | 515 片段条件拼装 + DYNAMIC_BOUNDARY 动态边界 |
| 人格化 | 性格内核双投影（同源派生），产品核心 | 30–40% 篇幅（Personality/Writing style），personality=none 可剥离 | 协作式 framing，31 tks 开场 |
| 行为条款风格 | 场景段落 + 中英 AI 腔黑名单 | 第二人称习惯句（"you reach first for rg"）+ 禁自夸/禁加戏/词表 | 负面清单微观化（16–815 tk 一条，单一可判定） |
| 缓存纪律 | 稳定区/易变区有意识，排序有缺陷（S7） | AGENTS.md 根链进 developer message | 前缀固化至 compact；一切可变内容下沉对话层 |
| 状态承载 | 中文正文控制行（S3 待改） | update_plan 工具（教学在独立注入件） | TodoWrite 工具 |

## 二、pure 已领先、不要动的

1. **片段化+预算制**：pure 的 fragment/priority/selectFragments 与 Claude Code 的片段库同构，且多一层 fragment 级 observability——多数开源 agent 还是单体字符串。
2. **拟人化的工程深度**：codex 把人格当一等对象（30–40% 篇幅），pure 的性格内核→双投影（怎么做/怎么说同源派生、子代理继承）架构上更系统；HUMAN_TONE 的 AI 腔黑名单（好的，以下是 / 首先-其次-最后 / 希望对你有帮助 + "不许造新仪式词替换禁词"）比 codex 的英文词表更贴中文场景。
3. **工具 schema 经济**：6.2k/28 工具 vs Claude Code 14.8k/23 工具。
4. **session ledger 防重问重跑**：与 codex 把 compaction 行为写进 base prompt（"compaction does not end the task / 最近用户消息是 steering 不是新目标"）同向，pure 更早。

## 三、增量优化点（审计未覆盖或深化）

### P1（高）机制教学从行为契约里搬出去，下沉 tool description
- **发现**：codex 已把 apply_patch freeform 语法、update_plan 正反例从 base prompt 迁出到 tool schema 与独立注入件（gpt-6.x base 只留习惯句）；Claude Code 官方明说 git 提交指引放 Bash tool description——"reach Claude even when you set a custom systemPrompt"。
- **pure 现状**：FILE_TOOLS_CORE 6,081 字符是「行为契约 + 使用教学」混合体，常驻系统段。pure 工具 schema 本就是单一来源，搬家成本低。
- **动作**：FILE_TOOLS_CORE 只留行为契约（先读后写、相对路径规则、验证纪律），参数细节与示例下沉四个 file tool 的 description。审计 S6 讲的是删重复，本条讲的是搬家——同方向不重叠。
- **收益**：常驻段直接减重；工具 description 走工具块缓存，不占系统前缀。

### P2（高）可变层移出系统前缀（conventions / runtimes / network / shell）
- **发现**：Claude Code 官方口径："CLAUDE.md content and environment details like working directory, platform, shell, and OS version don't affect the system prompt cache because Claude Code delivers them in the conversation, not the system prompt." 动态节用独立 cache breakpoint 保护前缀。
- **pure 现状**：project_conventions（priority 250，pinned）、runtimes/network/shell 全在 system prompt 内。项目切换=缓存前缀全毁；conventions 每次被 reflector 收割更新也毁前缀。
- **动作**：conventions 与环境事实下沉到对话层（composeUserTurn 的 task_context 或首条系统 user turn），系统段只留「遵守项目惯例」这一句行为要求。这是审计 S7（排序与 rationale 相反）的根因深化：不是排错位置，是部分层根本不该在这个位置。

### P3（中）「禁主动加戏」条款 + 化解 Safety first 冲突句
- **发现**：codex 明文禁令："Do not introduce unsolicited warnings, disclaimers, approval flows, or safety/compliance checklists due to hypothetical risk." 另有「不因中性追问道歉」「禁贬低式自夸（never praise your plan by contrasting it with an implied worse alternative）」。
- **pure 现状**：HUMAN_TONE 有「挑默认继续干」，但没有防模型自主加戏的条款；SYSTEM_CORE operating_principles 里 "Safety first: destructive or wide-reaching operations require explicit user approval" 与 2026-09-17 用户决策（确认弹卡尽量默认放行、优先智能化）方向相反——审计改进计划的修正点之一（S8.2）已点名。
- **动作**：删改 Safety first 句为「按 harness 权限模式行事，不自行加码确认」；新增一条：不主动附加免责声明/风险警告/合规清单，除非用户问的是风险本身。将「少问多做」从 harness 行为（自动放行）补齐到 prompt 层（模型不主动求确认）。

### P4（中）「先出可审成品再求批」的授权纪律
- **发现**：codex："You MUST complete the work that is already authorized … before asking the user for permission as a final step." + 授权跨 turn 持久化 + 追问须报出处（"explain why you need the confirmation … and where it came from"）。
- **pure 现状**：无对应条款；模型在长任务中段主动停下来求确认时，pure 没有教它「先把已授权部分干完、把待批动作做成具体可审的形态再问」。
- **动作**：并入 WORKFLOW 或 COMPLEX_TASK 协议一条：求确认前先完成已授权部分，待批项给具体方案而非开放问题。与 P3 是一体两面：P3 管不乱问，P4 管真要问时怎么问。

### P5（低）评审子代理的 rubric 结构化
- **发现**：codex review rubric 7,685 字符：8 条 bug 判据（须本次引入/作者会修/不靠臆测）+ 评论写法（matter-of-fact、禁过度表扬）+ P0–P3 优先级 + 严格 JSON schema + AGENTS.md 规则归因（finding 须引用项目指令行号）。
- **pure 现状**：PRE_COMMIT_REVIEW_CONTRACT 931 字符委托 code_reviewer，架构（子代理制衡）更先进但契约太薄。
- **动作**：给 code_reviewer 的子代理 prompt 补判据清单与输出纪律（发现/严重度/归因），形态按 pure 拟人化要求不必是 JSON，但「判据+优先级+出处」三要素要有。

### P6（低，前瞻）压缩/截断必配行为条款
- **发现**：codex 把 compaction 行为写进 base prompt（最近用户消息=最新 steering 而非新目标；禁从头重跑）。
- **pure 现状**：引擎未见 auto-compact（长会话靠 session ledger）。若未来引入上下文压缩/截断，必须同步配这套条款——ledger 教「查账」，压缩条款教「压缩后怎么读账」。
- 次级：Claude Code 连 ScheduleWakeup 都按缓存 TTL 做三个条件变体（"never wake just to keep the cache warm"）——pure 的 scheduler/timer 场景若膨胀可参考。

### P7（低）prompt 按模型家族的数据化适配
- **发现**：codex 的 prompt 已「数据化」：models.json（540KB）按 slug 下发不同 instructions_template，人格/前端细则配比逐模型调。
- **pure 现状**：模型中立、用户自配模型，复制 12 份模板不现实。但 selectFragments 预算制已有机制位：可按模型家族（上下文窗口/指令遵循档位）调预算与 required 集合，而非全局一套。
- **动作**：记录为方向，待 eval 轨道有数字后再做。

## 四、审计已覆盖、本次三方数据进一步佐证的

- **S1 固定开销/预算盲区** ← claude 514 词实证 + codex ~5.4k：20.8k 的起步开销在主流两个参照系里都属最重。
- **S2 正则判据** ← claude 的 ToolSearch/deferred tools（开场教学仅 39+121 tks）就是「接口+渐进披露」路的成品形态。
- **S3 中文控制行** ← claude TodoWrite / codex update_plan（教学已独立注入件）：双 Frontier 均已工具化，pure 是唯一还走正文协议的。
- **S6 required 过重** ← claude 语气族 4.5k 但每条微观可判定；pure 的 CAPABILITY_GAP 6.9k 单段是一个「胖块」而非「条款族」。
- **S7 缓存排序** ← claude 官方 DYNAMIC_BOUNDARY + 「首次请求固化 system prompt 直至 compact」机制佐证。
- **S8.2** ← SYSTEM_CORE 原文证实冲突句存在（见 P3）。

## 五、不做清单

- **安全双轨制**（claude 98tks 白名单 + 14k 监控器）：与 2026-09-17 用户决策直接冲突，不做（[[pure-priorities-intelligence-over-security]]）。
- **多模型模板库**：pure 模型中立是既定契约，全量复制 codex 的 per-slug 模板违背维护现实，只取「按家族调预算」的机制（P7）。
- **负面清单的全面英文化**：claude 条款微观化的形态值得学，但 pure 的中文黑名单+场景段写法在中文拟人化上实测有效，整体替换有翻车风险——只补缺失的具体条款（P3），不重写 HUMAN_TONE。

## 六、执行顺序建议

P3（半天，含 S8.2 修正）→ P2（半天，下沉 conventions）→ P1（1 天，FILE_TOOLS 拆分）→ P4（半天）→ P5（半天）→ P6/P7 记录待时机。前三步做完，常驻系统段预计从 ~14.6k 减到 ~10–11k，且缓存命中率显著改善（项目切换不再全毁）。
