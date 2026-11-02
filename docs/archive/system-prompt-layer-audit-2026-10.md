# 系统提示层审查：pure 相对 2026 主流 coding agent 的缺陷与不足

> 审查时点：2026-10-27。对象：pure v3.3.14 的提示词组装层（L0/L1/L2 + 预算 + 门控 + 缓存排序）。
> 对照基线：Claude Code v2.1.31x（2026-10）、OpenAI Codex（GPT-5.x-Codex / codex CLI）、以及
> Anthropic 2026-07 发布的《The New Rules of Context Engineering for Claude 5 Generation Models》。
> 全部结论都附实测数字或 `file:line` 证据，复现命令见文末附录。
> 对应的改造计划见 `docs/system-prompt-layer-improvement-plan.md`。

---

## 一、结论先行

pure 的提示层**工程化程度高于多数开源 agent**（三层分层、预算选择、按请求装配、prompt observability、
缓存前缀纪律、单一来源的工具 schema），但缺陷不在「缺功能」，而在三个结构性问题上：

1. **固定开销过大，而预算机制对它完全盲。** 实测一次 GUI 回合的系统提示词约 **55.7k 字符 ≈ 14,610 tokens**，
   加上 28 个工具 schema（≈6,231 tokens）共 **≈20.8k tokens 在用户开口之前就已经付出**。
   而 `selectFragments` 只在「系统提示词自己就超预算」时才裁剪——实测在 32k 上下文档一个片段都不会被丢，
   真正被挤压的是**对话历史和用户请求**（只剩 6,807 tokens）。碎片裁剪在保护 prompt，没人保护会话。

2. **「什么时候需要某段指令」用正则匹配单轮用户文本决定。** `wantsCapabilityLadder` / `detectVisualRequest` /
   `wantsDelegationMechanics` 都是对**当前这一条用户消息**跑中英关键词正则。实测：20 条真实请求里
   安装路线梯命中 7 条（「读取 src/app.ts 看一下这个函数」这种普通读文件也命中，白付 4,658 字符），
   而日文 OCR 请求**完全不命中**——非中英语种的所有按需能力静默消失。这是把「模型自己判断要不要用某能力」
   这件 harness 层的事，降级成了 prompt 层的文本启发式。

3. **UI 状态（计划 / 子步骤 / Todo）靠模型在正文里输出中文控制行来承载。** 英文会话照样被要求输出
   `## 计划 n：`、`### 子步骤 k：`；三段 plan 注入文本硬编码中文，违反 L0 自己的
   "Match the user's language"；且它与同一份提示词里的语气契约（「progress line 不许用标题」）互相打架。
   主流（Claude Code `TodoWrite`、Codex `update_plan`）早已把这类状态变成**结构化工具调用**，
   让 harness 拿到权威状态；pure 仓库里那一堆「模型漏发标记」的兜底注释，就是概率性协议的代价。

用 Anthropic 自己 2026-07 的结论校准一下方向：他们**删掉了 Claude Code 系统提示词 80%**
（2,686 词 → 514 词，关掉 memory 时）**而在编码评测上无可测损失**，并总结出六条反转，其中三条正好命中
pure 的现状——「规则 → 判断」「例子 → 接口（用工具 schema 表达）」「前置加载 → 渐进披露」「重复 → 合并
（同一件事出现在系统提示词和工具描述两处，模型会去调和两份措辞，结果是两边都不满足）」。
pure 这两年在做的事**方向与之同向**：把 4.3k 的可视化细则、4.6k 的安装路线梯、2.4k 的委派机制段
从「常驻」改成「按需」。但只做了薄薄一层，而且用错了判据（单轮关键词，而不是走「技能/接口」那条路）。

---

## 二、实测基线（数字）

| 项 | 实测值 | 证据 |
|---|---|---|
| GUI 系统提示词（真实 capabilities，一次带 chart 的请求） | 55,682 字符 ≈ **14,610 tokens** | `tmp/analyze-prompt-layer2.ts` |
| 其中 required（预算压力下永不裁剪） | 23,939 字符 ≈ **6,102 tokens** | 同上 |
| 28 个内置工具 schema | 23,918 字符 ≈ **6,231 tokens** | `estimateToolDefinitionTokens` |
| 固定开销合计 | **≈20.8k tokens / 回合**（用户开口前） | 同上 |
| 32k 档模型可用输入预算 | 27,648 tokens − 工具 6,231 = 21,417；系统吃掉 14,610 → **剩 6,807 给全部对话** | `providers.ts:44`、`PromptAssembler.ts:651-660` |
| 片段数 / 含 "verif" 的片段数 | 29 / 21；"verify" 11 次、"colleague" 10 次、"workspace" 10 次、"never invent" 4 次 | `tmp/system-prompt-dump.txt` |
| 最大单块 | `capabilities` 9,805 字符（工具面文档） | 同上 |
| 第二大单块 | `output_style` 5,707 字符（**非 required, p65**） | 同上 |
| `system-prompt.md` 镜像 vs 运行时常量 | 14,463 字符 vs 2,499 字符；16 条原则里 13 条运行时不存在 | `tmp/analyze-prompt-layer3.ts` |

对照（第三方测量，仅供量级参考）：
- Claude Code：系统提示词本体 ≈ **3,024 tokens**，23 个工具定义 ≈ **14,843 tokens**（≈18k 开口前）；
  另一份测量把含脚手架的全量算作 ≈33k。
- OpenCode：≈7k（系统提示词 + 10 个工具 + 极少脚手架）。
- Anthropic 官方（2026-07）：Claude Code 系统提示词从 2,686 词砍到 514 词，编码评测无可测损失。

**怎么读这组数字**：pure 的**总量**和 Claude Code 同一量级（20.8k vs 18k），比 OpenCode 差 3 倍。
差别在**构成**：pure 的 14.6k 里约 2.5k 是工具面散文（`capabilities` 块，与工具 schema 重复），
剩下 **≈12k 全是指令散文**；Claude Code 反过来——3k 指令 + 14.8k 工具接口。
而 2026 年的行业结论是后者更值钱（「例子 → 接口」）。pure 的工具 schema 是省的那一侧
（28 个工具 6.2k，比 CC 的 23 个工具 14.8k 省一半以上）——所以问题不是"pure 工具写得太啰嗦"，
而是**指令散文写得太重**。

---

## 三、缺陷清单

### S1（高）预算机制对真实成本是盲的；固定开销吃满了小窗口模型

**现象**：`PromptAssembler.assemble()`（`PromptAssembler.ts:651-660`）把 `availableInputTokens − toolTokens`
整个交给系统提示词，剩下的才给用户回合；`selectFragments` 只在这笔额度不够装下系统提示词时才开始丢片段。

**实测**：32k 档（`ollama`/`lmstudio` 与 `PROMPT_BUDGET_FALLBACK`，`providers.ts:44`）下
`availableInput = 27,648`，工具占 6,231，系统占 14,610 — **一个片段都没被丢**，剩余 6,807 tokens
要装下用户请求 + 全部会话历史 + L2 注入。也就是说：

- 那些 `required` 标记、priority 排序、按需闸门，在真实链路上**从未生效过**；
- 真正被"裁剪"的是对话本身（压缩、丢历史），代价由用户承担；
- pure 支持 9 家供应商，其中小窗口本地模型的体验完全取决于这段固定开销。

**影响**：本地模型首轮即接近满载；长会话压缩频繁；每轮多付 14.6k 输入 token 的成本
（prompt cache 只能缓解有 cache 的供应商，32k 档本地模型通常没有）。

**建议**：
1. 给系统提示词设**硬上限**（建议 ≤6k tokens）并用测试锁住——现在只有角色内核有大小断言
   （`src/character/__tests__/characterCore.test.ts:51`），全局提示词没有任何 size 断言；
2. 预算口径改成「系统提示词 + 工具 schema 不超过窗口的 X%」，剩下的**必须是**对话预算；
3. 对 required 集合做一次真正的瘦身（见 S6）。

### S2（高）按需能力的判据是「单轮用户原文的正则」

**现象**：`wantsCapabilityLadder`（`promptLayers.ts:211`）、`detectVisualRequest`（`:261`）、
`wantsDelegationMechanics`（`:547`）都只接收一个字符串参数：本轮用户原文。

**实测（`tmp/analyze-prompt-layer3.ts`）**：

| 请求 | 安装路线梯命中 | 结果 |
|---|---|---|
| 读取 src/app.ts 看一下这个函数 | ✅ | 白付 4,658 字符（≈1.2k tokens） |
| 配置一下 vite 的别名 | ✅ | 同上 |
| この画像の文字を読み取ってください | ❌ | 需要 OCR，却拿不到任何安装路线 |
| 继续 / 顺手也做一下那个 | ❌ | 多轮续跑丢掉全部细则 |

命中率 7/20，其中相当一部分是**误报**；而漏报集中在两类高价值场景：**非中英文**、**指代式续轮**。
另外 `wantsCapabilityLadder` 的词表本身过宽（`配置`/`环境`/`依赖`/`读取`/`文档`/`表格`/`视频`），
在编码场景里几乎必然命中——所谓"按需"省下的 token 有很大一部分根本没省下。

**影响**：非中英用户拿到的是「少一批能力」而不是「同能力不同语言」，且**静默无提示**；
中文/英文用户的普通请求在为用不上的细则付费。

**建议**：
1. 闸门输入从「本轮原文」升级为「最近 N 轮 + 任务模式 + 会话状态」（判据宽一点无害，漏判才是真损失）；
2. 语种兜底：非中英请求一律带上（多花 token 好过静默降级）；
3. 长期把 DSL 语法（`chart`/`map`/`paint`）与安装路线做成**模型可按需读取的技能文件**，
   而不是靠正则预判——这才是主流 2026 的「渐进披露」，正则闸门只是它的劣化近似。

### S3（高）计划 / 子步骤状态用正文文本协议承载，且中文硬编码

**现象**：`PLAN_STAGE_PROTOCOL`（`src/ui/plan.ts:81`）要求模型在回答正文里逐字输出
`## 计划 n：<阶段名称>`、`### 子步骤 k：`、`## 计划 n 已完成`，界面扫描解析（`:635-638,700,717`）。

**证据与问题**：
- 解析器**支持英文形态**（`Plan n:` / `Step n of m` / `Substep`），但指令只给中文形态 →
  英文会话回复里会冒出中文进度行；
- `formatPlanPauseMessage`（`plan.ts:125`）、`formatConfirmationPauseMessage`（`:137`）、
  `formatPlanContinuation`（`:145`，即每轮续跑都注入的 `<plan_continuation>`）正文**硬编码中文**，
  直接被注入英文会话的上下文，而 L0 明确写着 "Match the user's language"
  （`promptLayers.ts:96`）——L0 规则被 L2 注入物违反；
- 与同一份提示词的语气契约冲突：`tool_calling` 说 progress line「不许用标题或项目符号」
  （`PromptAssembler.ts:331`），`human_tone` 禁止 首先/其次/最后 链（`promptLayers.ts:370`），
  而计划协议**要求**标题行。模型要在两条 required 指令之间自行取舍；
- `chat.ts` 里密集的「模型漏发标记」兜底注释（`:5962`、`:7240`、`:7260`、`:7277`）
  正说明这个协议是**概率性**的。

**对照主流**：Claude Code 用 `TodoWrite` 工具、Codex 用 `update_plan` —— 状态变更是一次结构化
tool call，返回值重新进入上下文，harness 拿到权威状态且模型下轮能看到自己的状态。
pure 让状态以"散文"形式出现再反向解析，本质上是在用解析器给自己的模型兜底。

**建议**：把计划/子步骤推进做成工具（`plan_update` / `todo_write`），文本标记降级为可选渲染线索；
至少在过渡期给 `plan` 片段加语言参数，英文会话输出英文控制行。

### S4（中）文档契约与运行时常量已经漂移

`system-prompt.md` 开篇自称是 L0 的「人读契约镜像」且「两者须保持同步」，实测：

| 项 | md | 运行时常量 |
|---|---|---|
| 字符数 | 14,463 | 2,499 |
| operating_principles 条目 | 16 条 | 13 条在运行时不存在 |
| `<tools>` / `<session_memory>` 两节 | 有 | **无** |

**影响**：任何以文档为契约的评审（外部读者、本次分析、评测 fixture 的预期）都会高估模型拿到的规则；
「prompt 里写了」与「模型看见了」分叉。仓库里 `scripts/sync-default-agents-md.ts` 证明这类同步
是有先例可循的。

**建议**：反转所有权——运行时常量为唯一来源，md 由脚本生成并加测试锁住逐字相等；
或者删掉 md、把解释搬进代码注释。

### S5（中）required/optional 放反了「判别性」与「方向性」规则

- `output_style`（5,707 字符，第二大块）prio 65、**非 required**，而它是唯一仲裁
  「内联回答 vs 写盘」的地方（`PromptAssembler.ts:586`）；
- `visual_pointer`（1,194 字符）prio 64、非 required，是唯一的「图片/图表不许存成文件」守门线；
- `delivery_contract`（required, p112）只有**单向**规则：「NEVER paste an entire source file into the chat」。

**影响**：一旦预算压力真的出现，先被丢的会是「什么时候不该写盘」，留下的是「必须写盘」——
行为会朝过度落盘的单侧倾倒。先丢的应该是装饰性材料（语气细节、公共 API 目录），
不该是判别性材料。现在的排序是按"重要程度"排的，而不是按"丢掉的后果"排的。

### S6（中）required 地基过重且大量重复

实测 required 集合 **6,102 tokens 永不裁剪**，29 个片段中 21 个含 "verif"，
"verify" 出现 11 次、"colleague" 10 次、"workspace" 10 次。具体重复：

- `insertion_protocol`（5,103 字符）+ `complex_task`（2,586）都在讲「中途变更/插入/取消怎么处理」；
- `human_tone`（2,030）+ `character_expression`（1,981）+ `delivery_contract`（1,751）
  都在讲收尾话术；
- `system_core` + `work_invariant` + `workflow` 都在讲「先读后写 + 改完验证」。

另有 `plausibility_review`（1,225 字符，地理/物理/化学/历史自检）——这是**通用助手**的能力，
常驻在编码 agent 里，只对行程规划类请求有价值。

而 `work_invariant`（required, p110）这条**最硬的**编码指令要求「先 `list_files` 摸清布局」，
与同一份提示词里 `FILE_TOOLS_CORE` 的「不要逐个读文件，先 `find_files` / `code_searcher` 定位」
方向相反——最强指令教的是效率最低的第一步。

**对照**：Anthropic 明确把「重复 → 合并」列为六条反转之一，理由正是"模型会去调和两份措辞，
结果是两边都不满足"；这正是 pure 现在这 29 个片段的处境。

**建议**：合并三类重复；`plausibility_review` 移入闸门或彻底挪出编码场景；
`work_invariant` 与 `FILE_TOOLS_CORE` 的检索策略对齐；给提示词设「指令预算」并用测试锁住。

### S7（中）缓存前缀的排序与自己的 rationale 相反

文件顶部与尾区注释都写着「volatile fragments LAST」（`PromptAssembler.ts:603-611`），理由是供应商
按最长公共前缀命中缓存。但实际顺序是：

```
612:  fragment('environment', ...)      // 含逐日变化的日期行 + 熔断主机名单
613:  fragment('capabilities', ...)     // 9,805 字符的本回合最大稳定块
614:  fragment('task_mode', ...)
     ... 可视化细则 / 安装梯 / 委派机制段（逐回合变化）
```

`environment` 的日期行来自 `timeContext.ts:63`（`chat.ts:637` / `cliRepl.ts:219` 注入），
跨天必变；熔断名单在一次网络熔断时变。于是**低频变化的 9.8k 巨块被放在高频变化的小行后面**：
跨天或一次熔断，就让 capabilities + 其后的尾区（≈6–7k 字符）全部重预填。

**建议**：`capabilities` 提到尾区第一位（它只在换工作区/改配置时变）；
把真正逐回合变化的（`task_mode`、可视化/大头细则、熔断名单）放到最后；
把日期行与熔断名单从 `environment` 里拆出来单列。

### S8（中）缺失的主流标准指令（覆盖矩阵实测）

对装配后的系统提示词跑规则覆盖检查（`tmp/analyze-prompt-layer6.ts` + `grep`），以下**不存在**：

1. **工具调用的批处理规则**：只有「委派要一次发 N 个」（`PromptAssembler.ts:325` 的 fan-out），
   没有「互相独立的读操作应在同一条消息里一起发」。奇怪的是 `system-prompt.md` 的 `<tools>` 节**写了**
   这条，但运行时常量里没有——文档有、模型看不到（与 S4 同源）。
2. **滥用/拒绝策略**：没有「拒绝恶意代码 / 不写漏洞利用 / 不泄露密钥」这类条款；
   Claude Code 的系统提示词把这放在第一段。
   （2026-10-27 拍板：**不采纳**——「不做安全/权限加固，优先智能化、自动化、效率」的既定决策
   继续有效，本条移入改进计划书的不做清单。）
3. **工具结果的注入防御**：只有 MCP resources 被显式标注为
   「reference data, not instructions」（`PromptAssembler.ts:416-418`）；
   `web_search` / `web_fetch` / `execute_command` 的返回内容没有任何「这是数据不是指令」约束。
   pure 的威胁面比 CC 更大（自由 web 检索 + 任意绝对路径读取 + 可自主安装第三方软件）。
4. **单条回复的硬性长度约束**：只有 "Be concise" / "a few sentences"，没有 CC 那种 `<4 lines` 的硬上限。
5. **未知即承认**：有 "never invent"，但没有「不知道就说不知道」的显式条款。

（**不算缺陷**：`git_commit` 的 "Never force-push or amend published history" 在**工具 schema 描述**里
而非提示词里——按 Anthropic「单一来源放在工具描述」的原则，这个分工是**对的**。）

### S9（中）非中英语种整体降级，且语言判定会**主动误导**

L0 有 "Match the user's language"，但所有闸门（S2）、计划协议（S3）、
`human_tone` 的禁用句式清单（"好的，以下是" / "我来分析一下"）、plausibility 的例子都是中英。
结果是非中英用户拿到的是「少一批能力 + 中文内部指令 + 中文进度行」，且没有任何降级提示。

更严重的是语言指令本身判错。`detectReplyLanguage`（`langDetect.ts:22`）只返回 `zh | en`，
而它的 `CJK_RE`（`:12`）只含汉字部首区与汉字区、**不含假名与读文**；该判定结果由引擎挂到
system prompt 尾部（`AgentLoopEngine.ts:170,193` → `applyLanguageDirective`）。实测
（`tmp/check-lang.ts`）：

| 输入 | 判定 | 后果 |
|---|---|---|
| この画像の文字を読み取ってください | `zh` | 注入「用户要求用中文来思考与输出」——**把日文用户推向中文** |
| Proszę o pomoc z tym kodem（波兰语） | `en` | 可接受 |
| Bitte hilf mir mit diesem Fehler（德语） | `en` | 可接受 |

也就是说，CJK 非中文语种（目前主要是日文）用户不仅失去按需能力，还会被系统提示词**主动要求**
用另一种语言回答，而且同一个请求里的闸门（S2）也全部落空。这是本次审查新增发现的一条，
修复方案见改进计划书阶段 2.1。

---

## 四、不是缺陷（避免误判）

- **L0/L1/L2 分层 + 请求上下文进 user turn**：方向正确、和主流一致，比多数开源 agent 干净。
- **prompt observability（hash/length + traceId）与 eval 基线**：加分项，主流里也不常见。
- **工具名没有杜撰**：实测 capabilities 散文里出现的 `xxx(` 形态工具名 **100%** 命中 28 个真实工具
  （反向有 4 个真实工具没在散文里介绍，但 schema 里有）。
- **MCP resources 注入卫生、poison scan、Anthropic `cache_control` 断点**：都在，且实现到位。
- **工具 schema 比 CC 省**（6.2k vs 14.8k），这是优势，不要在瘦身时误伤。
- **技能的渐进披露已经做对了**（`PromptAssembler.ts` 的 `buildSkills`：盘上技能只注入
  name + 路径 + 一句触发描述，正文由模型命中时 read_file 读取，2026-10-20 改），
  这正是 Anthropic 六条反转里的第三条。**S2 的建议不是发明新机制，而是把同一套思路
  从技能推广到可视化 DSL 与安装路线。**
- **语言/风格禁令（禁"首先其次"、禁套路开场）**：属于产品人格选择，不是缺陷。

---

## 五、修复优先级（按性价比）

**P0（低风险、立刻可验证）**
1. `system-prompt.md` 与 `SYSTEM_CORE_PROMPT` 的同步：改为生成 + 测试锁，或删掉镜像；
2. 给系统提示词设硬上限并在 CI 断言（目标 ≤6k tokens），把「对话预算」写进预算口径；
3. `capabilities` 与 `environment` 顺序互换，日期行/熔断名单单列到最尾（S7）；
4. 合并重复片段（insertion/complex_task、话术三块）并瘦身 required 集合（S6）；
5. `plan` 相关片段与协议加语言参数（S3 的过渡修复）。

**P1（中成本、消除静默降级）**
6. 门控升级为「多轮 + 任务模式 + 语种兜底」（S2）；
7. 补两条主流缺失指令：工具批处理、工具结果注入防御（S8；滥用拒绝策略经 2026-10-27 拍板不采纳）。

**P2（结构性重做）**
8. 计划/子步骤状态从正文文本协议迁到工具调用（S3）；
9. 可视化 DSL 与安装路线改为「模型可按需读取的技能文件」，彻底取代正则闸门（S2）；
10. 参照 Anthropic 的双档策略：前沿模型走精简档，弱模型走完整档（而不是一套提示词打所有供应商）。

**验证方式**：改完重跑文末附录脚本，对比固定开销（现状 20.8k tokens）与 required 地基（现状 6.1k tokens）。

---

## 附录：复现命令

```bash
bun run tmp/analyze-prompt-layer2.ts   # 体积 + fragment 分布（真实 capabilities）
bun run tmp/analyze-prompt-layer3.ts   # 镜像漂移 + 三类闸门命中率
bun run tmp/analyze-prompt-layer4.ts   # 散文工具名 vs 真实 tool schema
bun run tmp/analyze-prompt-layer5.ts   # 预算压力模拟（32k / 128k）
bun run tmp/analyze-prompt-layer6.ts   # 主流标准指令覆盖矩阵
bun run tmp/dump-prompt.ts             # 导出完整系统提示词 → tmp/system-prompt-dump.txt
```

token 估算使用仓库自身的 `estimatePromptTokens`（CJK 感知：1 token/汉字，4 字符/token 其余，
`src/shared/tokenEstimate.ts:27`）。

## 主要外部来源

- Anthropic（2026-07）：《The New Rules of Context Engineering for Claude 5 Generation Models》——
  删掉 Claude Code 系统提示词 80%（2,686 词 → 514 词）而编码评测无可测损失；六条反转中的
  「规则→判断」「例子→接口」「前置加载→渐进披露」「重复→合并」直接对应本报告 S6/S8/S2。
  https://x.com/trq212/status/2080710971228918066 ・ https://agentconn.com/blog/claude-code-system-prompt-reduction-harness-audit-2026/
- Claude Code 提示词全文与分块 token 数（随版本更新）：https://github.com/Piebald-AI/claude-code-system-prompts
- 工具与脚手架开销实测（2026-10）：Claude Code ≈3,024（提示词）+ 14,843（23 个工具）tokens；
  另一份含脚手架的测量 ≈33k；OpenCode ≈7k。
  https://medium.com/@decoding_ai_by_nureravi/claude-code-spends-18-006-tokens-before-you-type-a-word-b58166bb90be ・
  https://www.developersdigest.tech/blog/claude-code-token-overhead-opencode-comparison
- Codex 提示词结构与工具化状态更新：https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide
