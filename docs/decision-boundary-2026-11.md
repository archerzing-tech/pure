# 决策边界改革：LLM 决策、系统执行（2026-11）

> 地位：设计铁律文档。把散在各判例中的归属判据收拢成一条线，并给出运行时与 prompt 的准入门槛。
> 源头：2026-11-04 用户定调「触发门槛和流程规则也改成 LLM 决策、系统执行」——网络路由（42 条名单）、大文件写入（v4.1.5 三刀）是同一病根已修的两例，本文是通用化。
> 前序判例：提示词瘦身三层判据（2026-10-28）、设置自愈反转 5856e63（自愈裁决权归模型）、watchdog 亮灯 c994084（状态可见而非静默自愈）。

## 一、北极星与四分归属

「手脚不缚模型 + SOTA 模型」：怎么做都是模型的事。系统与 prompt 常驻段的每一段规则，按其持有的是决策、手脚、物理边界还是契约来归属：

| 归属 | 判据 | 正当性 | 例子 |
|---|---|---|---|
| **模型** | 何时做、做什么、按什么顺序、触发与否 | —— | 路由选择、是否分段写、是否拆 agent、是否启用某机制 |
| **系统（手脚）** | 怎么做成、失败怎么递回、现状怎么照给模型 | 正当 | append 原语、截断信号透传、证据账本、envFacts 注入、watchdog 亮灯 |
| **物理不变量** | 预算上限、超时、原子写、终态保证 | 正当 | max_tokens、prompt budget、watchdog 超时本身、锁 |
| **契约（用户意志固化）** | 人格、语言、交互接口语义、呈现标准 | 正当 | 插话九类裁决器、取消/steer 语义、复杂任务四原则、拟人语气 |

**裁定规则：系统持有第一行的任一决策 = 越位。持有后三行 = 正当。**

两个澄清，防误伤：
1. 「用户亲手定」只是修改权的归属（只有用户能改），不是存在性豁免（不证明该段规则不越位）。判据常驻，谁定的都要过筛。
2. 「手脚不缚模型」缚的是决策，不是物理护栏。物理不变量不是越位——v4.1.5 三刀本身就是证明：抬 max_tokens 是机制（正当），分段与否模型定（决策归模型）。

## 二、准入铁律（对新机制）

**新机制只准回答「怎么做成」，不准回答「何时做」——例外仅物理不变量与交互契约。**

落地形态：任何新工具/新闸门/新自动化的设计评审，先过四分归属表；判 A（越位）的，改为「现状注入 + 模型裁决」形状——

- 触发条件降级为**现状注入**：系统不执行「满足条件就做」，而是把条件所依赖的状态与证据递到模型面前（envFacts、账本行、亮灯事件）。
- 触发裁决权归**模型**：模型看到现状后自己决定做不做、何时做。
- 机械兜底只保留**不变量级**：超时、预算、终态保证——这些不是决策，是物理护栏。

已验证此形状可行的判例：watchdog 亮灯（不再静默自愈，把 StreamResuming/压缩/degrade 状态照给模型）；设置自愈反转（引擎自动闭环被否，自愈裁决权归模型，pure 只做感知手脚，通用前提三件套=现状可见/知识可查/改了真生效）。

## 三、prompt 常驻段的判据适用

三层判据（2026-10-28 定调，本文确认延续）：**原则留 / 方法机制化 / 长尾索引化**。

- 原则：一句话讲「产出要什么形状/什么不能违背」（复杂任务四原则、人格红线、拟人语气）——留。
- 契约：交互接口语义（插话协议九类、取消/steer）——留，且不可被「瘦身」稀释语义。
- 流程规则：「必须先 X 再 Y」「不得跳过 Z」的步骤性教条=越位候选——删（模型自己会排）或机制化（检查器/注入件在事实层兜底，不在指令层约束）。
- 机制说明：该由工具 description 自己带的，不占常驻段。

已知误伤禁区（不是流程规则）：插话协议是交互契约不是流程；复杂任务四原则是产出形状原则不是步骤；人格/语言/呈现标准是用户意志。

## 四、盘点裁定（2026-11-04 两路并行盘点）

### prompt 常驻段（A 路）

- **越位候选 6 项，全落刀**：workflow 段 7 条步骤流程瘦为 4 条原则+契约（-300tk/动手轮）；SYSTEM_CORE「always read a file before editing it」句删（与 edit_file 描述四重重复）；work_invariant 步骤框架退役（保 fragment 瘦文本防破坏渲染序与前缀缓存）；output_style「Call web_search FIRST」步骤句退役（never-invent 原则保留并迁 web_search 描述）；output_style「用户嫌结果差五件套配方」压成原则句；task_mode 分阶段/逐步方法句退役（BUILD 留交付契约、PLAN 留模式标注）。
- **应下沉区复核无欠账**：复杂任务四原则已住 task_planner 工具描述；capability ladder 核心已退役重货随闸门；multi_agent 委派触发已随工具描述。文件工具策略等五组历史退役均清账。
- **保留区复核干净**：插话协议（实测 482 字符）无步骤混入；人格三件套（≈1500tk required）为地板；completion 的 `[remember]` 是记忆回写唯一通道不动；INCREMENTAL_BUILD 与 GUI 计划卡 UI 联动=呈现契约（判例锚），不动。
- 常驻统计：纯问答 4654tk→≈4450，动手轮 5185tk→≈4740（全闸门 8286→≈7850）。6k 不可达结论不变（人格+契约地板）。

### 运行时硬触发（B 路）

A 档（越位候选）9 项裁定：**落刀 4**——A1 模型失效自愈闭环（唯一违反 5856e63 明文反转定调）、A2 复核失败自动暂停在飞支（插话链内唯一 A 混入）、A4 读图 override（词表覆写 LLM 路由判决，最硬形状）、A3 策略面五档指令注入。**挂账 5**——A5 workShapedFallback（宕机补位选「是活」，与插话 passthrough 口径分叉：探针廉价只读误判代价低，保留但口径分叉已写明；真机证伪直投 TTFT 成本后再议）、A6 偏好收割（正则推断「偏好」语义，改写挂账）、A7 研究收束令措辞、A8 continueGuard 措辞（有界+设置门控，软 A）、A9 web_public_api 未命中滑搜索（契约声明化待查）。B 档内嵌小越位两处挂账：schema 二振摘工具不披露、E1.2 跨会话加速措辞。
复核六点全清：autoJudge=纯设置谓词（D）；路由脑决策面全在 TS（目标态主结构达成，Rust 单请求内尝试经济的收编挂网络层设计稿尾刀）；插话链除 A2 外全 D；自动压缩=C（物理+有披露）；机械触卡=D（用户定调通道）；watchdog=亮灯形状完整（不动）。
保持不动：失败阶梯主体（框架改革 4a 既定裁决）、路由脑与 GitHub 加速（网络智能最高权）、权限链（设置即用户意志）、commandGuard（红线）、reactive/预压缩、劫持/毒化门。

## 五、施工记录（2026-11-05，v4.1.5 后）

**Prompt 六刀**（src/shared/）：agentBehavior.ts workflow 段重写（7→4 条，session_memory 锚/换路线锚/verify+sanity-check 锚逐字保留，ask-before 危险问询契约清单保留——capability_ladder CORE 只覆盖安装）；promptLayers.ts SYSTEM_CORE 先读后改句删+闸门注释更新；PromptAssembler.ts work_invariant 瘦文本/output_style 两处句级切除/task_mode 压缩；toolDefs.ts web_search 描述补 never-invent 原则；promptLayers.ts 渲染尾注释同步。测试：promptLayers/PromptAssembler/promptToolContract 106 全过（锚同步 3 处：session_memory 大写、work invariant 判据改锁交付契约+直达、time-sensitive 谓词换 never-invent）。

**运行时四刀**：
1. **A1 自愈反转**：providerSelfHeal.ts 新增处方事件器（record/take，读即清，provider 字段补进 plan）；chat.ts 删 `persistConfig(applyModelSelfHeal(...))` 落盘闭环，改记处方；envFacts 双面接流（GUI buildEnvFacts 第四参 / CLI buildCliEnvFacts）；config.ts applyModelSelfHeal 退役；i18n 四键改处方式文案（不再宣告既成事实）。模型下一回合拿处方自行改 config.json（设置语义操作 1cf8181 确保真生效）。
2. **A2 复核失败 passthrough 化**：interjectOrchestrator.ts recheck===null 臂从「宿主暂停 covered 支+沉默」改为原话直投父引擎+callId 现场事实随附（covered_recheck_unresolved_passthrough trace），与同文件超时 passthrough 口径对齐；源码结构锁三处同步（settleAck 计数 2→1、stopBranchByCallId covered 调用退役、行为锁换直投断言）。
3. **A4 读图 override 退役**：Planner.ts 删 IMAGE_READ_PATTERN+applyImageReadOverride——词表覆写 LLM 路由判决退役，复合请求（截图+改码被压成 question）的现实错误路由随之修复；测试零锁定（暗越位）。
4. **A3 策略面事实化**：adaptiveControl.ts buildDirective 重写——五档打法指令（exploration/verification/delegation/recovery/autonomy 命令式 prose）退役，改为纯事实件（路由分类+证据行+角色名录「a roster, not an order」+priorArt+红线）；档位计算保留在 select() 做观测分类（E4.1 仪表盘切片语义不变）；adaptiveControl 测试五处锚同步（指令腔反锁加码）、Harness 漏网锚一处同步。

**验证**：bun test 全量绿（5052 例）+ tsc 零错 + lint:conventions 过。

## 六、发布后审视补刀（2026-11-05，三路独立审视）

三路 fresh-context 审视（A1 处方链端到端 / A2+A4 / prompt 六刀+A3）结论：0 条运行时 bug；功能完整性缺口 1 条已补——**A1 CLI 生产端断链**（此前 CLI 只有消费端 buildCliEnvFacts 读处方、没有生产端，纯 CLI 跑模型失效处方永不入账）：cliRepl.ts Interrupted 臂在 failure_policy_stop 时同判同记（cliProviderHealContext 按 CLI 可见来源组清单，与 GUI modelListForProvider 同构不引 GUI 模块），三个调用点全透传。另修：providerSelfHeal.ts 头注旧口径、DynamicInsertionCoordinator recheckCovered doc 旧口径、interjectOrchestrator 直投附注快照语义（「复核时仍在跑，此刻可能已收工」）与去行号注释、promptLayers 死文本两行（指向已删 workflow install 路线梯）与四条注释失真（edit_file/write_file 并列只对一半/步骤号/CORE 兜底不存在/token 数统一 ≈300 实测）、modelSelfHeal 测试补三覆盖（上限 8 弹旧保新/跨 provider 不误合并/no-next 整行形状）+ 每用例读即清场防御（顺序地雷判例）。

**审视暴露的边界记录（记入，不擅自扩机制）**：
- **A2 停支执行通路**：宿主零代裁后，父引擎工具面无停支工具（pauseBranch/abortBranch 只在宿主缝与 UI）——模型裁决「该停」时只能软消化（不采纳/不再等/叙述交代），硬停支仍需下一句插话或用户手停。裁决权已交、机械手未配；补停支工具是「手脚」（准入铁律正当），待用户点名再动。
- **A2 收尾重入丢附注**：父引擎在复核 8s 内已收尾时，steer 走 roundClosePlane leftoverSteers 重入，取裸原话，callId 现场事实附注不随话走（既有「重入用用户原话」口径）；缓解=下一 THINK 的 live_branches 新鲜花名册。挂账观察真机出现率。
- **CAPABILITY_GAP_PROMPT 前半段死文本**（先在，非本刀引入）：CORE 半段全 src 无装配点，只 LADDER 切片进 prompt；本刀清了其中指向已删内容的两句，前半段存废（整体退役 or 恢复装配）待用户点名。

**验证（补刀后）**：tsc 零错 + 相关测试文件全绿 + 全量复跑。
