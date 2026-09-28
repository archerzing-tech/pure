# 动态插话与插入信息处理设计

> 状态：与当前运行时代码一致（2026-09-28）。本文只描述已实现的行为，不把规划写成能力。
> 核心实现：`src/coding-agent/DynamicInsertionCoordinator.ts`（决策）、`src/ui/chat.ts`（宿主处置）、`src/coding-agent/inputDecision.ts`（共享形状与日志）。

## 1. 目标与设计定调

用户在 agent 执行任务期间继续输入（插话），系统要像人一样处理这些插入信息。判定不再问「相关与否」，而是问**「一个埋头干活的人听到这句话会怎么处理」**，并按两条轴综合权衡：

- **时机**：这句话到达时，正处在哪个阶段（思考规划 / 执行中 / 并行委派在飞 / 已收齐汇总）；
- **结果收益**：哪种处置让最终结果最好——统筹兼顾顺势而为，还是及时停下改方向。

两种绝不允许的错误：

- 把用户的话**弄丢**（分类失败就静默丢弃，而调用方已清空输入框）；
- 把用户的话**反向执行**（收掉一支被排队成新活跑起来；停掉一支把刚要求加进来的活一并杀掉）。

由此定调（2026-09-28）：**决策不看关键词**。机械正则只配做两类事——人对「停」不需要 deliberation 的**命令快路径**，以及裁决器倒下时的**字面安全网**。其余一切判断归裁决器（LLM）。

## 2. 决策通道：judge / rule / net

`DynamicInsertionCoordinator.decide()` 是唯一出口，四条生产路径都经过它，并按「这条决策是谁定的」对账（`decisorOf()`，`signals.via`）：

| 通道 | 谁判的 | 何时生效 | 延迟 |
|---|---|---|---|
| `rule` | 机械正则 | 三类**命令**：整停（`STOP_RE`）、祈使停一支（`BRANCH_STOP_RE`）、点名续支（`RESUME_BRANCH_RE`） | 0 往返 |
| `judge` | 裁决器（LLM） | 其余一切：加活 / 收活 / 推翻 / 约束 / 纠错 / 提问 / 寒暄 / 非字面的停 | ≤ 8s 预算 |
| `net` | 字面安全网 | 仅裁决器不可用（没配 LLM = `no-judge`；超时/网络/解析失败 = `judge-down`） | 0 |

判分原则：

- 停是不可逆动作，等一次裁决往返是抗命——所以字面命令必须先于裁决器接走；
- 安全网绝不冒充判断：按字面族挑一个**不丢话**的目的地（推翻话重开、收活折入、其余一律排队——排队是唯一保证跑完的投递），并在 `signals.netReason` 里说明原因；
- 每条决策连同**判定时的场景原文**（`inputContext`）一起记入共享日志——「判错了」只有配上「在什么场景下判的」才可行动。

## 3. 裁决器：`classifyInsertion`

`Planner.ts` 的 `INSERTION_CLASSIFY_PROMPT` 要求模型「像人类同事一样」判，返回一个 JSON。7 类处置（`InsertionKind`）：

| kind | 含义 | 典型例 |
|---|---|---|
| `stop` | 停手，**没有东西补上来**（区别于 goal-change 的换方向继续） | 「先缓一缓」「不用继续了」 |
| `premise-change` | 纠正任务赖以成立的**事实**——按旧前提算下去全白费 | 「其实我在西安，不是广东」 |
| `goal-change` | 方向本身被推翻 | 「推翻重来」「换方案」 |
| `steer` | 顺路带上：约束、产出物内部加内容、指引 | 「背景上加几朵会动的云」「记得跑测试」 |
| `question` | 要一句现在就答的旁答，不打扰主活 | 「跑完了吗」 |
| `task` | 新的、可独立完成的一件活，排队跑 | 「再加一个爱奇艺平台」 |
| `chatter` | 寒暄，收下即可 | 「哈哈」「+1」 |

除 kind 外还有六个**契约字段**，宿主靠它们而不是自己嗅措辞：

- `cancels_part`：收掉/收窄一件已要求的活（「X 就不调研了」）。**即使 kind 判成 task 也必须报**——漏报会反向执行，判错 kind 反而可存活；
- `adds_along`：同一句既收又加（「B站那支别查了，再加一个爱奇艺」）→ 宿主把收活折入汇合而不是停支（停支会杀死刚要求加的活）；
- `resumes_part`：点名让一支已暂停/已停的分支接着跑 → 宿主从 checkpoint 同参重派；
- `supplements_current`：这句话属于**正在产出的那一件东西**内部（画鸟补云）→ 思考窗吸收（见 §6.4）；
- `when`：用户自报的执行时刻（原话，不做钟表计算——解析在 `inputDecision.ts`）；
- `confidence`：模型对 kind 的把握。低置信不赌——见 §5。

裁决失败（超时/网络/解析失败）返回 `fallbackUsed` 的 `task`，协调器转成字面安全网（§2 net 行）。

## 4. 共享决策形状与可回放日志：`inputDecision.ts`

六处生产方（回合路由、插话裁决、宿主排期……）共用一套词汇，替代各说各话：

- `InputAction`：`proceed / apply / answer / queue / replan / stop / clarify / ignore`；`KIND_POLICY` 把 7 类 kind 映射到它，并定 scope（`stop/replan` 触碰 `completed-steps`，`replan` 由 `shouldAbort` 拆回合）；
- `InputTiming`：`now / after-current / at`，`at` 带 epoch 与用户原话（回显用户说的时间而非时间戳）；
- **置信门** `applyConfidenceGate`：confidence < 0.6 降级为 `clarify`，**ask 而不赌**；`clarify` 永不拆回合。分类器没报数字时默认 0.7（高于门槛——门是给「报告了怀疑」的模型用的，不是惩罚漏字段的 provider），并打 `confidenceDefaulted` 标记供日志回看；
- **可回放日志**：每条决策 `recordInputDecision` 落账（上限 200 条），`formatInputDecisionLog()` 导出 JSONL，`parseInputDecisionLog()/replayInputDecision()` 让回归测试拿真实决策当 fixture——路由 bug 的修法是「回放同一条决策断言同一结果」，不是手写措辞断言。

### 4.1 时间语义

两层解析都在本地做（可测、provider 无关）：

- `parseInputTiming`：把裁决器的 `when` 或用户原话解析成时刻（「10 分钟后」「下午三点」「明天早上九点」；中文数字/半/凌晨都收）。判成 `at` 的插话**先于 kind 生效**——带时刻的话不该当场执行（stop 除外，停恒为 now）；
- `detectScheduledInput`：输入级排期，比上面严格——时间必须套在**延期框架**里（「再过 10 分钟…」「下午三点再跑…」「等到…」）才算排期；时间只是宾语（「把 15:30 这个时间戳改成 UTC」）或问句（「为什么三点再跑就报错？」）不算。误读成「以后跑」比漏掉排期代价更高，所以宁可漏。

## 5. 宿主处置链：`chat.ts`

入口 `interject()`：非流式 → 普通 send；流式中 → 临时回执（一行 pending 状态，终稿原地替换，不重复上屏），插话经 `insertClassificationChain` **串行**裁决（并发插话排队判、不丢弃），最终 `classifyAndApplyInterject()` 分发。分发前先过两道闸：

1. 定时闸：`timing.mode === 'at'` → `deferTimedInsert` 交给排期 sink，「已排期，当前任务不受影响」；
2. 置信门兑现：`clarify` 且原判是破坏性的（stop/replan）→ 先问用户一句（`askMidrunClarification`，带场景与原判），手头的活照跑。

各 kind 落点：

| kind | 处置 |
|---|---|
| `stop` | 回显原话 → abort 收尾，已完成的部分保留，不重排。字面停与非字面停同路 |
| `goal-change` / `premise-change` | 插话暂存 `relatedInsert` → abort 止损 → 收尾后作为新指令重入 `send()`（气泡由重入渲染，避免上两遍） |
| `steer` | 见 §5.1（分支寻址是重点） |
| `question` | 旁路一次 LLM 调用 `answerMidrunQuestion`，主循环无感知 |
| `task` | 见 §5.2（阶段感知 + 契约字段闸） |
| `chatter` | 收下即可，气泡上屏，零打扰 |

### 5.1 steer 的四个去向（按优先序）

1. **点名续支**（`resumesBranch`）：`resumeNamedBranch` 从已暂停/已停的支里按区分词点名，用**原始参数**同参重派——稳定 sessionId 命中 checkpoint，子引擎 continue，不从头做；点不出/拿不到原参 → 退普通 steer 让父模型重派；
2. **停支/收活**（`branchStop`/`cancelsPart` 且委派在飞）：`stopNamedBranch` 点名真停——祈使停 = abort（产出不入账、断点照存），收活 = pause（活口更大）。点不出具体支 → **宁可折叠不误杀**：折入取消口径 + 挂起飞闸；绝不能往下走广播（每支都可能把自己当成「那支」）；
3. **出生前取消**（取消味但委派还没出生）：话挂**起飞闸**（`pendingCancels` + `planTakeoffGate`——同回合父再派这一路，出生点拦下）并转达父引擎，收执说清「没派的不会派」；
4. **普通 steer**：定向投递 `steerRunningTurn`——委派在飞时按 `matchSteerRecipient` 点名直达某支（`matchInFlightBranch` 只认只被一支含有的区分词，打平宁可广播不赌），没点名广播全部；委派不在飞 → 父引擎下个 THINK 边界顺路带上（`takeSteerMessages`）。

### 5.2 task 的阶段感知

- 带 `cancelsPart` 的「task」**绝不去重、绝不排队**（排队一个取消 = 反向执行），走 §5.1 的收活路径；
- 已覆盖去重：`findCoveringBranch` 点名命中在飞/已收工的支 → 如实回「已经在跑/已在汇总里」，不重复派；
- **委派还在飞** → 折入汇合轮 `foldInScopeAddition`：排定的追加委派指令（「在此之前不要输出最终汇总」），收尾核验没兑现就转排队兜底——话绝不丢；
- 委派已收齐 → 排队 `pendingTasks`，当前任务收尾后作为新任务启动（队列卡逐条可见、就地更新）。

### 5.3 场景上下文：`buildInsertionContext`

裁决器看到的是它要的全景，不是光秃秃一句话：

- 用户当前诉求（活回合的原话优先——canonical 要等回合结束才落账）；
- 阶段自述：思考窗（思考激活 + **思考叙述尾** + 已并进来的补充）/ 委派在飞数 / 已收齐；
- 当前计划步骤、已暂停/已停的支（分支级续跑的判据输入）、本会话已写文件。

### 5.4 思考窗吸收

预检思考还活着时，四类话都是「正在想的这件东西本身要变」——不排队、不广播、不拆回合，全部并进请求推倒重想（`preflightRestartRequested` + `preflightAbort`）：

1. 加内容/约束（`supplements_current`）；
2. 事实纠错（premise-change——旧思考建立在错事实上，继续想全白费；而拆回合重入会丢掉原请求）；
3. 方向推翻（goal-change，思考期 = 带新方向重想）；
4. 窗内普通 steer——「下个动作带上」的唯一兑现点就是在飞的思考本身。

取消/停支/续支、task、停、问、寒暄照旧走各自的路。

## 6. 学习闭环：日志 → 审计 → 收割 → 回放

决策路径上的关键词撤掉后，「该报的契约字段没报」宿主看不见了。闭环四步把它接成「跑得到」：

1. **日志**：每条决策带 `inputText`（≤160 字）与 `inputContext`（≤600 字，判定时的场景原文）落账；
2. **事后审计** `insertionAudit.ts`：只读词族（当年出事故的 `CANCEL_SMELL` 搬到审计位）比对已落账的决策，标两类疑点——`cancels-missed`（有取消味没报 cancels_part，会反向执行）、`adds-along-missed`（报了取消但同句在加活没报 adds_along）。铁律：审计绝不参与/改写决策；假阳性可接受（人一眼扫过），假阴性不可接受。疑点率按批切出**趋势**（`auditTrend`）；
3. **疑点收割** `insertionHarvest.ts`：审计标出的句子自动并入回归语料（去重按原句），期望只由「当初为何被标疑点」推出，标 `expectation: 'suspected'` 与人工核对语料分开统计。收割时连**场景原文**一起带走（换场景重判可能不复现疑点）。两个入口同产物：设置页「收割」按钮（复制到剪贴板）/ `scripts/harvest-insertion-corpus.ts`（写盘）；复核后手工搬进 `CASES` 升格；
4. **回放** `scripts/replay-insertion-decisor.ts`：语料与离线回归测试共用 `insertionCorpus.ts` 一份。离线量机械路径截胡面；`--llm` 真跑裁决量**契约遵守率**（stop 档 / cancels_part / adds_along），`--timing` 两阶段各跑、`--thinking-on` 复现暗推理延迟兜底。

语料（`CASES` + `HARVESTED_CASES`）60+ 句真实原句，每句标 `source` 出处（测试、事故记录或已定稿口径），并按 `scenario` 指名自己该在哪个场景里判——回放不再给每句喂同一个上下文。

设置页诊断区（`src/ui/settings.ts`）展示：每条决策的 via 徽章（裁决器/规则/安全网）、场景徽章（思考中/在飞 N/执行中）、疑点高亮与疑点率柱条、收割轮次趋势。

## 7. 当前边界

以下未实现，不应描述为已完成：

1. 不做新旧计划的结构化 diff；「保留哪些步骤、从哪步重来」由重入的模型回合结合上下文决定；
2. 裁决器独立预算 8s；provider 暗推理开着时首字节即「思考结束」，大部分插话轮不到判断而落到安全网——生产用关暗推理的 judgeLlm（`--thinking-on` 可复现该退化）；
3. 分支寻址是**区分词匹配**（`matchInFlightBranch`），没有语义检索；打平宁可保守（折叠/广播），不赌点名；
4. 是否委派、计划如何改，仍由父模型经现有子 Agent 工具决定；宿主只做止损、投递与兜底；
5. 定时插话依赖会话存活（排期 sink 在宿主进程内），无跨进程持久化。

## 8. 实现文件与验证

| 文件 | 责任 |
|---|---|
| `src/coding-agent/inputDecision.ts` | 共享决策形状、置信门、时间解析、可回放日志 |
| `src/coding-agent/DynamicInsertionCoordinator.ts` | 三通道 decide、KIND_POLICY、字面安全网、快路径正则 |
| `src/coding-agent/Planner.ts` | `classifyInsertion` 裁决器（INSERTION_CLASSIFY_PROMPT + 契约字段解析） |
| `src/ui/chat.ts` | 宿主处置链：interject 入口、场景上下文、分支寻址/停支/续支、思考窗吸收、折入与收尾核验、去重、排队、旁答、澄清、定时 |
| `src/shared/steerTargeting.ts` | 点名寻址（`matchInFlightBranch` 区分词匹配）与折入/起飞闸文案 |
| `src/coding-agent/insertionCorpus.ts` (+ `insertionCorpusHarvested.ts`) | 语料资产：人工核对段 + 收割段，场景库，机械路径对照 |
| `src/coding-agent/insertionAudit.ts` | 契约字段漏报的事后审计（疑点标记、批趋势） |
| `src/coding-agent/insertionHarvest.ts` | 疑点句 → 语料收割（渲染生成模块） |
| `src/ui/settings.ts` | 设置页插话决策诊断区（via/场景徽章、疑点率、收割按钮） |

测试（无需 key 的离线回归）：

```bash
bun test src/coding-agent/__tests__/DynamicInsertionCoordinator.test.ts
bun test src/coding-agent/__tests__/inputDecision.test.ts
bun test src/coding-agent/__tests__/insertionCorpus.test.ts
bun test src/coding-agent/__tests__/insertionAudit.test.ts
bun test src/coding-agent/__tests__/insertionHarvest.test.ts
bun test src/ui/__tests__/insertionDiagPanel.test.ts
bun run typecheck
```

裁决器实测（需 GLM key，限流时分片跑）：

```bash
bun scripts/replay-insertion-decisor.ts          # 离线：机械路径截胡面
bun scripts/replay-insertion-decisor.ts --llm    # 追加真跑裁决器：契约遵守率
```
