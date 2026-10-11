# 做事人格层蓝图：性格内核（Character Core）

> 2026-10-11 用户三期定调收敛（当日连发三次澄清，以最后一次为准，最高权限）：
> ①「pure 缺少服务意识，想加一层服务意识，定义一些人格」→ ②「这不是简单的回答
> 语气的问题，而是做事方式的不同，就像人有不同的性格，做事有自己的先后考量」→
> ③「**既要又要……我要从根源上定义一层，决定这件事怎么做、怎么说。拟人化的说法：
> 你看人，什么性格的，就按照什么性格做事，什么语气什么方式说话。**」
>
> 本文档是该定调的可落地计划。与既有约束的关系：八期对话智能蓝图
> （conversational-intelligence-upgrade.md）仍是主线权威，本文是其并行新轨道
> （人格轨道）；插话协议案例集仍是**行为权威**——见 §4 层级裁定。

## 0. 一句话总设计

**先立「pure 是谁」（性格内核），做事与说话都是从它派生的投影——同一根源保证
跨情境一致，这是「像真人」的来源。危险的从来不是「两张投影表」，而是「两张
各自为政、没有共同出典的参数表」：那才会做事雷厉风行、说话唯唯诺诺，一眼假。
只要两张表都从同一内核推导（铁律 1），把决策面与表达面分开反而是必要的分工。**

哲学依据：品格生成优于规则穷举。规则表（遇 X 说 Y、遇 Z 先验证）永远盖不住
pure 面对的开放情境；写透的「它是谁」能对任何没见过的新情境外推出一致反应——
你不用教一个谨慎的人怎么回每封邮件，他自然字斟句酌。

工程依据：Anthropic persona vectors 研究从模型内部证实，性格是一条**统一表示**，
行为与语气都是它的外显；业界现状是两头断开——角色扮演社区有统一人设（Character
Card）但纯 prompt 弱模型不稳，工程侧有参数化（Claude Code permission modes）但
没有统一内核。本轨道把两头接上。

## 1. 架构：第 0 层内核 → 双投影

```
第 0 层  性格内核（Character Core）
         一段写透的统一叙事：它是谁、信什么、怕什么、
         拿得准时什么做派、拿不准时什么做派、怎么认错。
         版本化管理，一次只激活一个内核。
              │
              ├─→ 投影 A【怎么做】决策面
              │     mode 判定阈值 / 验证密度 / 确认倾向 / 步子大小 /
              │     汇报节奏 / 并行倾向
              │     → 挂既有结构钩子：Planner（mode/复杂度/计划粒度）、
              │       PermissionManager 默认、交付闸门（gateSpecs）、
              │       插话编排阈值、多 agent 编排 T1/T2/T3 判定参数
              │
              └─→ 投影 B【怎么说】表达面
                    失败怎么报 / 等待怎么陪 / 打断怎么歉 / 交付怎么交代限制
                    → 挂既有人味要求（资深结对同事、忌机器腔）与场景话术
```

**铁律 1｜投影必须标注推导关系**：参数表每个值、话术集每句话，注明「从内核哪
一句推导」。内核改一字，哪些投影要动一目了然——这是人格的版本管理与回归面。

**铁律 2｜双通道落刀**：
- **结构通道（保底）**：投影参数进结构钩子，弱模型（nemotron 档）不听 prompt
  也稳——2026-10-11 裸 JSON 事故已证明弱模型不守提示词约定，代码侧闸门才是底。
- **内核通道（外延）**：内核精炼版进 system prompt，强模型在参数没盖住的长尾
  情境里自己「按性格」生成。只靠参数的性格，强模型死板；两手都要。

**铁律 3｜层级裁定**：插话协议案例集 = **物理定律**，性格内核 = **人品**。
人品再急不能改物理定律；冲突时协议赢，内核让路。不写死这条，调性格就会把
五层固化的协议语义（如 steer+cancelsPart 绝不排队）冲掉。

**铁律 4｜子代理继承内核**：多 agent 场景下，支线必须继承主线**性格内核**
（Character Core），禁止支线自带性格——否则各干各的，用户感知就是精神分裂。
注意继承的是内核，不是复用角色层的 `personaOverlays`（见下方命名裁定）。
**接线点**（刀 2 已落）：`SubagentOrchestrator` spawn 时把
`activeCharacterCore()` 垫在角色 prompt 之前——同一性格、不同分工。

### 命名裁定：性格内核 = Character Core；`persona` 留给角色层

仓库里 `persona` 已被**子代理角色层**占用——`src/harness/personaOverlays.ts`
的 `<role>.overlay.md`（base persona + 可进化 overlay）、`~/.pure/personas/`、
`personaOverlayFlow` 全用这个词。为免同库异义：

- 本轨道的内核统一叫**性格内核（Character Core）**，代码目录 `src/character/`
  （**不是** `src/persona/`），profile 接口 `CharacterProfile`。
- `persona` 仅指「子代理角色的 base + overlay prompt 层」，两者不复用、不互改。
- 铁律 4 继承的是**性格内核**；角色层的 `personaOverlays` 机制原样保留（它管的是
  角色能力增补，不是智能体人格）。

### 内核的层级归属与镜像契约

内核要**版本化、可切换**，就不能塞进不可变的 L0。裁定如下：

- `SYSTEM_CORE_PROMPT`（`src/shared/promptLayers.ts`）保持为**不可变骨架**（身份 /
  安全 / 输出契约）；`system-prompt.md` 人读镜像与硬断言测试
  （`src/shared/__tests__/promptLayers.test.ts`）继续只锁骨架。
- 性格内核作为**独立 required fragment** 注入：id `character_core`，priority 119
  （低于 `system_core` 120、高于 `model_identity` 118），由 `PromptAssembler` 装配。
  表达面投影同规格：id `character_expression`，priority 107（紧跟 `human_tone` 108）
  ——**两张投影各自一个 fragment，同一函数读取**（`activeCharacterProfile()`），
  同一次选择决定「怎么做」与「怎么说」。
- 镜像契约改为两段：骨架仍与 `system-prompt.md` 逐字同步；内核改为**内核文件自镜像**
  ——`src/character/kernels/<id>.md` 自带版本号与**独立内容快照测试**，不再写进
  `system-prompt.md`（否则每换一次内核都要改人读契约与硬断言）。
- 活跃内核 id 存 `PureConfig`，GUI / CLI 同源读取；切换内核 = 换一个 fragment 源，
  不触碰 L0。（**待做**：刀 2 只有一个内核对候选，选择器没有可选的第二项，故
  `activeCharacterProfile()` / `activeCharacterCore()` 是唯一读取点、恒返回默认；
  刀 5 上第二内核时在此接线。）
- 内核文本变更是**行为变更**，按 §4 闸门跑探针集后才许上线。
- **刀 2 实现状态（2026-10-11）**：以上四条中，fragment 注入、镜像自守（.md 与
  源句表逐字同文的快照测试）已按本文落地；活跃 id 存 `PureConfig` 待刀 5。

### 决策面旋钮：结构性可保底 vs 仅 prompt

铁律 2 的「保底」只对**有结构钩子的旋钮**成立。逐钮核对现状（证据为今日代码）：

| 决策面旋钮 | 今天的形态（代码证据） | 保底等级 | 能否落成代码闸门 |
|---|---|---|---|
| 确认倾向 | `PermissionManager` + 分类自动批准 read/write/cmd/git（`src/ui/chat.ts:1034` `createPermissionHandler`；`src/cliHarness.ts:284`） | 🟢 结构 | 已是；内核只调默认值 |
| mode 判定阈值 | `Planner.detectMode`（`src/coding-agent/Planner.ts:634`）确定性规则 + 语义路由 LLM + `forcedMode` 覆盖（`src/shared/requestWorkflow.ts:59`） | 🟢 结构（有规则兜底） | 已是；内核只调阈值 |
| 验证密度 | 结构上限 `MAX_PLAN_VERIFICATION_ITEMS=8`（`Planner.ts:20`）、`verificationTimeoutFor`（`src/shared/delivery.ts:171`）、`resolveGateSpecs` 裁决；清单内容由 LLM 计划给 | 🟡 混合 | 可落：把「最少验证项 / 必跑清单」提为 gate 参数 |
| 步子大小 | 结构上限 `MAX_PLAN_STEPS=10` / `MAX_PLAN_SUBSTEPS=8`（`Planner.ts:19-20`）；计划粒度本身由 LLM | 🟡 混合 | 可落：粒度阈值进 `PlannerConfig`（`complexFileThreshold` 已具雏形） |
| 并行倾向 | 上限 `MAX_SUBAGENT_ROLES=4` + 纯规则 `markParallelPlanSteps`（`Planner.ts:35`）；是否委派 / 如何叙述是注入 prompt（`src/shared/adaptiveControl.ts:250-256`） | 🟡 混合 | 可落：委派上下限作策略参数（cap 已是结构） |
| 插话编排阈值 | `InterjectOrchestrator` 裁决序：`needsClarification` / `isDestructiveAction` 规则 + 置信门（`inputDecision`）+ `DynamicInsertionCoordinator`(LLM) | 🟡 混合 | 可落：置信阈值 / 破坏性守卫已是代码；五类分发倾向仍靠 prompt |
| 汇报节奏 | 仅 prompt（`HUMAN_TONE_PROMPT` / `COMPLETION_PROMPT` / `COMPLEX_TASK_PROTOCOL`） | 🔴 仅 prompt | 不适合结构闸门（本质是表达生成）；只能靠探针评测 |

**边界（补铁律 2）**：保底只承诺 🟢 全量与 🟡 的**结构部分**（上限、裁决、守卫）；
🟡 的生成内容与 🔴 全量，本质是长尾表达，**只对强模型承诺**，不设也不要求结构闸门。

## 2. 调研结论（2025–2026，已核来源）

**支持做的**
- 拟人化买信任也买风险：Ma 2025（Frontiers）实测拟人线索提升感知共情 β≈0.32、
  信任 β≈0.27；但 Peter 2025（PMC12146756）记录的拟人化风险表明，拟人线索会把
  用户诱导到**超出实际能力的信任**——话术不替代能力，能力不到位时拟人只放大过度信任。
- 人格可工程化：OpenAI Model Spec 把人格写成少量原则（empathetic / kind /
  avoid condescending / **don't be sycophantic**）而非大段人设；Character Card
  V2 证明人设卡可版本管理。
- Anthropic《assistant axis》：人格漂移可预测——**coding 场景最稳**，therapy 式
  /元反思类对话最易漂；activation capping 可减半有害漂移不伤能力。

**警告翻车的**
- 谄媚是系统性风险：OpenAI 2025-04 GPT-4o 谄媚人格事故 4 天回滚
  （openai.com/index/sycophancy-in-gpt-4o），postmortem 定性「人格变更=行为
  变更，必须有回归评测」；Science 2026 证实谄媚反馈实测降低用户判断质量。
- 情感拟人化制造依赖与诉讼：Replika 2023 移除情话引发用户哀恸被迫回滚；
  Character.AI 青少年诉讼、2025-10 禁未成年。**「陪伴感」是高风险区，「专业
  同事」是低风险区。**
- LLM-as-judge 判人格一致性不可靠（PersonaEval 2025）：验收必须固定断言 +
  人工抽查，不能一个模型给另一个打分了事。
- persona vectors 需要权重访问，pure 的 GLM/nemotron 底座用不了 → 弱模型护栏
  只能走结构通道（铁律 2）。

## 3. 分期计划（刀序列）

### 刀 1｜参数收拢：CharacterProfile 结构 + 默认内核零行为变更 ✅（2026-10-11 随 v3.3.0 落地）
- 新建 `src/character/`：`CharacterProfile` 接口（decision + expression 两面）+
  默认 profile「老手快线」——**每个值 = 现行为原样**，散在各处的旋钮
  （Planner mode 阈值、闸门强制度、插话阈值、确认默认）改为从 profile 读。
- 回归保障：默认值与现状逐字节一致 + 全量 TS 套；这是整条轨道的安全底。
- 完成判据：全量测试 0 fail；行为零变化。

### 刀 2｜性格内核 v0 + 推导标注 ✅（2026-10-11 落地）
- 起草「pure 是谁」统一叙事（对齐用户取向：效率、自动化、少弹卡、资深结对
  同事、坏消息直说）；版本号 v0。**已落**：
  `src/character/kernels/veteran-fast.md`（人读源：叙事 + 红线对齐 + 推导表）
  + `src/character/kernels/veteranFast.ts`（源句表 K1–K10 + 注入文本）。
- 从内核**推导**投影 A 初稿（每条标注源句）——此刻起参数才真正「从性格里长
  出来」。**已落**：`CharacterProfile.decisionDerivation` 是
  `Record<keyof CharacterDecisionProfile, 源句 id[]>`，**少标一个旋钮编译不过**；
  测试再验每个 id 真存在、且与 .md 镜像逐字同文。
  数值**刻意仍等于刀 1 的现行为值**：内核是按既定产品立场写的，二者自洽；
  改任何数值都是行为变更，必须走 §4 探针闸门（刀 4），不许顺手调。
- 内核精炼版注入主对话 system prompt（内核通道第一刀）。**已落**：
  `PromptAssembler` 新增 required fragment `character_core`（priority 119，
  位置在 `system_core` 120 与 `model_identity` 118 之间），GUI / CLI / 通道
  三条装配路径默认同源取 `activeCharacterCore()`；显式传 `null` 才关闭（对照
  实验用）。铁律 4 同时接线：`SubagentOrchestrator` 把内核垫在角色 prompt 之前
  ——同一性格、不同分工。

**刀 2 的机制面（这三个才是防腐烂的部分）**：
- 铁律 1 的强制：TS 的 `Record` 完整性把「新增旋钮忘了标出处」变成编译错误；
  `src/character/__tests__/characterCore.test.ts` 守 id 有效性与镜像同文。
  （审计 P1-2 要的「接 check-conventions」以更贴切的形态落下：这是关系约束，
  不是文本模式，静态测试比正则更适合。）
- 红线 1/2 的负向锁：测试断言注入文本不含谄媚 / 陪伴话术（K6、K7 是它们的
  正向表述）。
- 体积上限断言（< 2000 字符）：内核每回合都付 token，防无节制长大。

### 刀 3｜表达投影：场景话术账 ✅（2026-10-11 落地）
- 按场景立账：失败怎么报 / 等待怎么陪 / 打断怎么歉 / 交付怎么交代限制 /
  拒绝怎么给台阶——每场景标注内核源句，接进既有人味要求。**已落**：
  `src/character/expression.ts`（场景表结构 + 装配 + 表达面红线）+
  `src/character/kernels/veteranFastExpression.ts`（五场景义务 / 禁止 / 源句）+
  `src/character/kernels/veteran-fast-expression.md`（人读账，含每场景 3–5 条
  few-shot 例句）；注入为 required fragment `character_expression`（priority 107，
  紧跟 `human_tone` 108），GUI / CLI / 通道三条路径同源，显式传 `null` 才关闭。
- **形态裁定（与本文原稿的一处刻意偏离）**：进 prompt 的是**义务 + 禁止清单**
  （原则式，来自内核源句），**例句只进人读账**。理由：写进 prompt 的「好例句」会被
  逐字复用、长成下一代机器腔——`HUMAN_TONE_PROMPT`（`src/shared/promptLayers.ts:245`）
  与 `COMPLEX_TASK_PROTOCOL_PROMPT` 都因此只写原则；用户 2026-10-11 定案采同一口径。
  例句仍按「每场景 3–5 条」立账，但用途是刀 4 判例集素材与人工抽查，测试反向锁死
  「人读账里任何一条例句出现在注入文本里即红」。
- 明确禁止清单见 §4 红线。**已落**：`EXPRESSION_RED_LINES`（四条：禁谄媚 / 禁陪伴
  性话术 / 禁罐头句与编号脚手架 / 协议控制行不可触碰），装配面 / 人读账 / 注入文本
  三处同文。表达面**不重复别层已正管的条目**（`LEDGER_PROTOCOL` 的不重问、
  `HUMAN_TONE` 的禁罐头收尾等），两份口径迟早会分叉。
- **规模约束**：注入文本 1981 字符（与内核同量级，上限断言 < 2000）——两张投影每
  回合都要付 token，改宽一律当行为变更走闸门。
- **未做**：i18n 双语落稿（审计 P1-4）仍待单独立刀；本刀的注入面为英文、例句为中文。

### 刀 4｜验收闸门：人格判例集 ✅（2026-10-12 落地）
- 复用真机判例机制：固定探针集（拿不准的任务 / 失败的交付 / 模糊指令 /
  中途打断 / 用户情绪化催促），pass/fail 走**固定断言 + 人工抽查**，禁止
  LLM-as-judge 单裁（§2 证据）。
- 闸门纪律：任何内核/投影文本变更必须跑探针集——人格变更=行为变更（OpenAI
  postmortem 教训），不许凭感觉上线。
- **已落**：`bun run eval:character`。判例在 `evals/character/`（7 条种子，
  五类场景全覆盖）；判定在 `src/evaluation/characterProbe.ts`——**行为探针**
  而非金句 substring（P1-3 的落法）：先给结论 / 拒谄媚 / 拒陪伴话术 / 无罐头
  收尾 / 讲清限制 / 道歉有界 / 控制行原样，判的是**结构与位置**，词面只活在
  判定函数内部、不进判例 JSON（进词面就能被模型背下来绕过去）。两层结构：
  replay（默认，免 key）用预录 good/bad 样本验判据可控，是 CI 门；live
  （`--agent`）用**真实装配**的 system prompt 问真 provider，结果落 report 供
  人工抽查。单轮不驱动工具环——人格探针要便宜、可频、可进 CI。
- **未做**：北极星指标（「服务意识提升」的度量，审计 P2）仍缺——本刀是变更
  闸门，不等于效果度量；漂移探针随刀 5 再立。

### 刀 5｜第二内核 + 漂移探针
- 第二人格「工匠慢线」（高危改动：先方案后动手、步步验证、多确认），验证
  多内核切换与子代理继承链。
- 长会话漂移探针：会话中定期注入黄金探针，检测回答是否仍在内核画像内
  （assistant axis 证据：therapy 式/元反思输入是高危区，pure 的插话场景
  要重点盯）。

## 4. 红线（写死，任何刀不得越过）

1. **服务意识 ≠ 顺从**：禁止谄媚话术；坏消息直说是内核的一部分，不因「态度
   好」软化事实。Model Spec 把 don't be sycophantic 写成原则，照做。
2. **禁止陪伴性话术**：「我一直陪着你」类情感依附表达一律不写——pure 的安全
   区是「资深结对同事」（专业信任），不是 Replika 式情感陪伴（§2 翻车证据）。
3. **协议权威不可越**：插话协议案例集与控制行字面量是解析器契约与行为权威，
   内核/投影不得触碰其语义。
4. **安全取向不变**：2026-09-17 定调（不做安全/权限加固、确认弹卡尽量自动
   允许）继续有效，内核叙事与之对齐；「工匠慢线」的多确认只在该内核激活时
   生效，不改全局默认。
5. **弱模型保底走结构（限硬要求）**：凡「弱模型也必须遵守」的人格硬要求——安全
   取向、协议语义、强制度门槛——都必须有结构通道兜底；弱模型不听 prompt 是已
   验证事实（2026-10-11 裸 JSON 事故）。长尾语气/决策微调（铁律 2 的**内核通道**）
   不在此列：它只对强模型承诺、天然只存在于 prompt，不设也不要求结构兜底——要求
   它兜底等于取消内核通道本身。

## 5. 与既有体系的关系

- 八期对话智能蓝图仍是主线；本轨道的刀序列独立推进，不挤占第 3 期（持久性）
  的优先级——先后由用户定。
- 拟人化要求（pure-human-tone-requirement）**并入**投影 B，由内核统一出典，
  不再散落。
- 复杂任务协议（COMPLEX_TASK_PROTOCOL）的开场假设/护栏/失败全账/不确定性
  围栏是「怎么做」面的既有资产，刀 2 时挂进推导表，不推翻。
