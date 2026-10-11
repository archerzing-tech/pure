# 审计：做事人格层蓝图（persona-core-upgrade.md）

> 2026-10-11 对 `docs/persona-core-upgrade.md` 的只读设计审计。方法：文档主张逐条对回
> 真实代码（`file:line`）与公开文献；未改动任何产品文件。结论分级 P0（阻断落地）/
> P1（会走样）/ P2（完善）。审计对象是**文档本身**，不覆盖其未开工的实现。
>
> **修订状态（2026-10-11）**：P0-1~P0-4 已在蓝图正文定案 / 修复，Wang 引用已更正为
> Peter 2025；详见各项下的 ✅ 状态行。P0-1 的实现在同日随 v3.3.0 落地（刀 1+2）——
> 独立 fragment `character_core`（priority 119）、内核文件自镜像 + 快照测试、铁律 1
> 的强制机制、铁律 4 的支线接线均已落代码。
> **同日后续（刀 3，2026-10-11）**：表达面投影落地（fragment
> `character_expression`）。其中与本审计直接相关的一点：P1-3 担心的「例句进 prompt
> 后被逐字复用」这一半风险在刀 3 就被移出——进 prompt 的是义务 + 禁止清单，例句只
> 进人读账，并有测试反向锁死（例句出现在注入文本里即红）；剩下的是判例集闸门本身
> （刀 4）与双语（P1-4）。**再后续（刀 4，2026-10-12）**：判例集闸门已落
> （`eval:character`，见 P1-3），双语（P1-4）仍未做。

## 结论

方向成立、结构清晰，是一份**好的设计立场文**；但作为「可落地计划」有 4 处阻断落地
（P0）、6 处会走样（P1）。核心洞见「单一内核 → 同源双投影」与仓库现状一致，可以走。

## 优点（已核实站得住）

- **同源双投影**与代码既有立场一致：`HUMAN_TONE_PROMPT` 注释明确「只写原则、不写例句，
  防被逐字复用」（`src/shared/promptLayers.ts:246`），正是文档「品格生成优于规则穷举」的
  落地版。
- **铁律 3 有真凭据**：插话协议的取消依赖契约字段 `signals.cancelsPart`
  （`src/ui/chat.ts:137`），确属解析器契约，内核不得越——这条必须写死。
- **文档点名的结构钩子确有实物**：交付闸门 `resolveGateSpecs` 是带测试的纯函数
  （`src/shared/delivery.ts`，测试见 `src/shared/__tests__/delivery.test.ts:281`）。
- **主线蓝图存在**：`docs/conversational-intelligence-upgrade.md`（196 行）。
- 刀 1「默认=现状、逐字节一致 + 全量 TS」符合项目既有纪律。

---

## P0 · 阻断落地

### P0-1 内核的层级归属缺失，且与 L0 不可变契约正面冲突

刀 2 / 铁律 2 都要求「内核精炼版注入 system prompt」，但**没说放哪一层、fragment id、
优先级**。而 `src/shared/promptLayers.ts:30-38` 声明 L0 = immutable、runtime 唯一来源，
`system-prompt.md` 是**须保持同步的人读镜像**，且 `src/shared/__tests__/promptLayers.test.ts`
对内容硬断言。可版本化、可切换的内核无法塞进不可变 L0。

→ 文档必须回答：新开哪一层？`system-prompt.md` 镜像与硬断言测试怎么随内核版本走？

**✅ 已定案**（蓝图 §1「内核的层级归属与镜像契约」）：骨架仍为不可变 L0；内核作为独立
required fragment `character_core`（priority 119）注入；镜像改为「内核文件自镜像 + 独立
快照测试」；活跃内核 id 存 `PureConfig`。**✅ 已实现**（2026-10-11，随 v3.3.0 的刀 2）：
`src/character/kernels/veteran-fast.md`（人读源）↔ `veteranFast.ts`（运行时源句表，快照
测试守逐字同文）；注入在 `PromptAssembler`（三条装配路径默认同源）。唯一未落的一条是
「活跃内核 id 存 `PureConfig`」——只有一个内核时选择器无第二项可选，随刀 5 接线。

### P0-2 「persona」同库异义

`src/harness/personaOverlays.ts` 头注释已用 “persona” 指**子代理角色 base+overlay**；本文档
又用它指智能体自身性格，并计划新建 `src/persona/`。同一仓库两个「persona」，且铁律 4
与既有**按角色给个性**（`src/harness/overlayGuard.ts` 全套准入/回退）当场冲突。

→ 先定名（如内核叫 character core / 角色层叫 role prompt），否则后续文档与目录都在歧义上盖楼。

**✅ 已修复**（蓝图 §1「命名裁定」）：内核统一为 **Character Core**、目录 `src/character/`、
接口 `CharacterProfile`；`persona` 专指子代理角色层；铁律 4 改述为「继承内核，不复用
`personaOverlays`」。

### P0-3 铁律 2「弱模型走结构保底」覆盖面被高估

决策面里真正有代码闸门的只有少数（`PermissionManager`、交付闸门 `resolveGateSpecs`）。
「验证密度 / 步子大小 / 并行倾向 / 探索深度」目前**只是 `src/shared/adaptiveControl.ts`
注入的 `<adaptive_context>` 提示文本**（`verificationStrength` 全仓无实现）。

→ 文档把它写成「代码侧闸门才是底」，但一半旋钮根本没有底。需一张「结构性可保底 /
只能靠 prompt」的旋钮对照表。

**✅ 已修复**（蓝图 §1「决策面旋钮：结构性可保底 vs 仅 prompt」）：逐钮标注 🟢 结构 /
🟡 混合 / 🔴 仅 prompt 并附代码证据；铁律 2 边界补为「只承诺 🟢 全量与 🟡 的结构
部分」。

### P0-4 红线 5 与铁律 2 自相矛盾

铁律 2 承认「参数没盖住的**长尾情境由强模型按性格生成**」（即只存在于 prompt），红线 5
却要求「**任何**只存在于 prompt 的人格要求都必须有结构通道兜底」。长尾天然无法结构兜底。

→ 两句必须择一限定，否则红线 5 会把内核通道本身判为违规。

**✅ 已修复**：红线 5 收窄为「弱模型也必须遵守的硬要求」，显式豁免铁律 2 的内核通道。

---

## P1 · 会走样

- **P1-1 刀 1 的「整条轨道的安全底」是过度承诺。** 默认=现状只保证*重构零回归*；刀 2 一旦
  按内核改动某个现状行为，行为变更就发生在刀 2，而非「被安全底挡住」。
- **P1-2 铁律 1（投影须标注推导来源）无强制机制** → 必腐烂。项目已有
  `scripts/check-conventions.ts`（`lint:conventions`），应把「每个投影值带内核源句 id」
  做成 CI 校验。**✅ 已修复**（2026-10-11，刀 2），但换了更贴切的形态：这不是文本模式
  而是关系约束，正则栅栏（`check-conventions` 的形态）反而难写。落法是
  `CharacterProfile.decisionDerivation` 为
  `Record<keyof CharacterDecisionProfile, 源句 id[]>`（**少标一个旋钮编译不过**）
  + `src/character/__tests__/characterCore.test.ts` 验 id 有效、`.md` 镜像逐字同文。
- **P1-3 刀 4 验收对主观人格会退化。** 「固定断言」用在性格上会塌成字符串匹配（项目自己
  在 `promptLayers.ts:246` 警告过引文被逐字复用），「人工抽查」不进 CI 必被跳过。应改成
  **行为探针**（是否先给结论 / 是否拒绝谄媚 / 协议控制行是否原样保留），挂
  `scripts/run-evals.ts` / `eval:roles`。**✅ 已修复**（2026-10-12，刀 4）：
  行为探针集落在 `bun run eval:character`（`scripts/run-character-probes.ts` +
  `src/evaluation/characterProbe.ts` + `evals/character/`）——七类断言判结构
  与位置（首屏实质信号 / 谄媚词面 / 陪伴话术 / 罐头收尾 / 限制信号 / 道歉
  计数 / 控制行逐字），词表只活在判定函数内部、不进判例 JSON。挂载点没选
  `run-evals` 而是独立 suite：run-evals 的判据是验证命令的退出码，套不上
  文本姿态；同目录新建保持了「每套判据一种语义」的纪律，退出码语义
  与之对齐。replay 层（免 key）进 CI 守「断言可控 + 语料漂移」，live 层
  （--agent）跑真 provider + 真实装配的 system prompt 供人工抽查；
  LLM-as-judge 按原建议未采用。
- **P1-4 双语 / i18n 未覆盖。** `SYSTEM_CORE_PROMPT` 要求按用户语言作答
  （`promptLayers.ts` response_format），`HUMAN_TONE_PROMPT` 的禁语举例却是全中文
  （如「好的，以下是」）。投影 B 的语气按语言落点不同，需按 locale 出稿。
- **P1-5 铁律 4 字面过宽**，会抹掉既有角色级能力增量（`overlayGuard.ts`、角色级 A/B、
  角色级建议卡）。**已修复**：字面上已改述为「继承**性格内核**、不复用 `personaOverlays`」；
  接线也已落地（2026-10-11，刀 2）——`SubagentOrchestrator` spawn 时把
  `activeCharacterCore()` 垫在角色 prompt 之前，角色层能力增量原样保留。
- **P1-6 §5 追溯不清。** `pure-human-tone-requirement` 全仓**只有本文档提及**，无同名产物
  ——应直接写 `HUMAN_TONE_PROMPT`；`COMPLEX_TASK_PROTOCOL` 是真常量，但没标 fragment id /
  优先级，挂靠关系无法验证。

---

## P2 · 完善

- ~~§0「拆成两张参数表就是精神分裂」与刀 1 落 decision + expression **两张表**字面打架~~
  ✅ 已澄清为「危险的是无共同出典的两张参数表；同源双投影是必要分工」。
- **多内核选择器未定义**：谁选、存哪、GUI/CLI 怎么切、是否绑会话/工作区。
- **漂移探针的「黄金探针」未定义**：触发时机、判定口径、成本。
- **缺成功指标**：刀 4 是变更闸门，不等于「服务意识提升」的度量，缺北极星指标。
- **未复用现成范式**：`overlayGuard.ts` 的「快照 + meta 标记回退、不删文件可逆」正好可做
  内核版本回滚，文档只字未提。

---

## 来源核验表

| 文档引用 | 结果 |
|---|---|
| Ma 2025（Frontiers），共情 β≈0.32 / 信任 β≈0.27 | ✅ 数字准确（fcomp.2025.1531976） |
| Science 2026 谄媚反馈 | ✅ 实为 Cheng 2026（`science.aec8352`），但结论比「降低判断质量」更宽：降亲社会意愿、促依赖 |
| PersonaEval 2025 | ✅ 存在（arXiv 2508.10014），但它测的是「评审模型能否认出人类扮演的角色」，与「判人格一致性」不完全同题，作证据偏弱 |
| **~~Wang 2026（PMC）「超出能力的人设反噬信任」~~** | ✅ **已更正**为 Peter 2025（PMC12146756）——原文引用未核到，新版引可验证来源 |
| GPT-4o 谄媚回滚、Anthropic persona vectors / assistant axis、Replika、Character.AI、Character Card V2、OpenAI Model Spec | 未逐条复查，与已知公开事实方向一致 |
| 2026-09-17 定调、2026-10-11 裸 JSON 事故 | 项目内部事件，无外部来源，按内部事实采信（未证伪） |

---

## 建议的最小落地路径

1. ~~先定名 + 给内核指定层级（P0-2、P0-1）~~ ✅ 已在蓝图定案。
2. ~~铁律 2 补「结构性可保底 / 只能靠 prompt」旋钮对照表；修掉红线 5 矛盾（P0-3、P0-4）~~
   ✅ 已完成。
3. ~~铁律 1 接 `check-conventions`~~ ✅ 已落（2026-10-11，以 TS 强制 + 静态测试的形态，
   见 P1-2）；~~刀 4 探针接 `run-evals`（P1-3）~~ ✅ 已落（2026-10-12，形态为独立
   suite `eval:character`，理由见 P1-3）。
4. ~~更正 Wang 2026 引用~~ ✅ 已更正为 Peter 2025（PMC12146756）。
5. ~~鉴于诉求是「服务意识」，**先只落投影 B 一个最小切片并跑通判例**，再决定是否上五刀。~~
   投影 B 的切片已落（刀 3，2026-10-11）：五场景的义务 / 禁止 / 源句账进 prompt，
   例句留人读账；判例那一半亦已落（刀 4，2026-10-12，见 P1-3）。

## 核验方法与未核项

- 代码断言均以 `grep` / 文件精读确认，引用带 `file:line`。
- 文献断言以公开检索确认；未能确认者显式标注为「未核到」，不臆断真伪。
- 本审计为只读，未改动任何文件，故未运行 typecheck/test。
