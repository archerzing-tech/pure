# 改进计划：自进化焊点与飞轮（2026-09-30 定稿）

> 起点：2026-09-30 全仓评审（多 agent 运行时 / 自进化层 / 产物接缝三路只读审查 +
> 2026-09 业界水位对照）。结论浓缩成一句话：**防缠纪律与运行时控制面已是最优梯队；
> 但"可自进化的多 agent 系统"还缺三块——进化对象覆盖（工具/父 prompt）、两根柱子的
> 焊点（子代理吃不到记忆）、飞轮实证（最高价值的回路没在真实数据上转过一圈）。**
>
> 本计划回答：按什么顺序、以多小的步子补齐。参照 2026-09 当期水位：Claude Code
> subagents/agent teams、Letta git 记忆、MemSkill（快照回滚）、FlowEvo（工作流→技能
> 编译 + 负迁移抑制）、GEPA（反思式 prompt 进化）、Alita/SkillWeaver（自造工具）。

## 0. 执行纪律（沿用既有路线图规矩，逐字有效）

1. **同一时间只开一个步骤**；每步独立提交、独立可回滚。
2. 量级：S ≤ 半天 / M = 1–2 天 / L = 3 天+。
3. 每步收尾三件套：行为测试 + 关键注释 + CHANGELOG 一条；进度记入改进进度记录.md。
4. 红线（每步都要过）：v5 基线不倒退；全量 bun test + tsc 干净（涉 Rust 加 cargo
   test）；**进化总开关关闭后行为与纯运行时逐字节一致**——注意：本计划 P0-1 修的
   就是这条红线目前的洞，修完之前它对反思器不成立。
5. 版本节奏建议：第一波结束发 3.0.4（修复批），第二波结束发 3.1.0（飞轮首次转动）。

## 1. 优先级总览与依赖

```
第一波 P0 焊缝与红线（便宜、立刻生效、放大后续一切收益）
  P0-1 反思器纳入进化总开关            S
  P0-2 sleep-time 换 REFLECT 便宜通道    S
  P0-3 子代理记忆注入（两柱焊点）        M
第二波 P1 飞轮转一圈（唯一能证明"自进化"的事）
  P1-1 S1 真实样本 + 首次 ALLOW         半人工
  P1-2 overlay 落盘后自动回退护栏        M   ← 依赖 P1-1（有真实 overlay 才有对象）
  P1-3 held-out mini-set               S+
第三波 P2 工具自进化（兑现"工具"这个词）
  P2-1 TOOL.json 装载半边              M   ← 独立
  P2-2 procedure→工具固化流             M   ← 依赖 P2-1
第四波 P3 结构债（穿插进行，随时可插）
  P3-1 lib.rs 三刀（web_public_api / mcp / llm_stream）  各 M
  P3-2 chat.ts 控制面出 UI（✅ 五刀收官，见 :205）   L
  P3-3 reads 并发池上限                 S
  P3-4 仓库卫生                        S
```

依赖关系只有三条：P1-2 ← P1-1；P2-2 ← P2-1；P1-1 的样本质量受益于 P0-3（不阻塞）。
第四波与前三波零依赖，作为"换脑子"的间隔刀随时插入。

## 2. 第一波 P0：焊缝与红线

### P0-1 反思器纳入进化总开关（S）

**现状洞**：E1.1 in-turn 反思器的开关 `HarnessConfig.reflection` 全库无宿主传入
（唯一传递点 CodingAgent.ts:285 透传自身 config，也无人配置），默认 enabled:true。
用户关掉 `skills.evolution` / 设 `PURE_EVOLUTION_DISABLED=1` 后，回合末的反思 LLM
调用与 lesson 写入照旧发生——与"关闭后逐字节一致"红线直接冲突。

**改什么**：装配点接线。GUI（chat.ts 构造 CodingAgent 处）与 CLI（cliHarness.ts）在
传 `reflection` 时并入 `evolutionEnabled`（与 `memoryInjection` 归因同一份判定来源）。
不改 Harness 内部默认值——宿主装配层负责策略，Harness 保持纯。

**验收**：mock provider 断言——总开关关闭的会话回合末零反思 LLM 调用、零 lesson
落库；开启时行为与现状逐字节一致（既有反思测试不迁移）。CLI 侧 env 与 config 两条
路都测。

### P0-2 sleep-time 反思/overlay 换 REFLECT 便宜通道（S）

**现状洞**：GUI 空闲循环绑 `createLLMAdapter(cfg)` 主模型
（evolutionOrchestratorTimer.ts:174）、CLI 直喂传主 adapter（cliRepl.ts:726）——与
纯核注释"宿主绑 E0.3 的 REFLECT adapter"（sleepTimeOrchestrator.ts:188-189）不符。
成本护栏只剩调用次数，单次价格没降。

**改什么**：两个宿主装配点改为 `llmFor?.('REFLECT') ?? 主模型`，复用 Harness E0.3
契约与既有配置面（9.2 的 `--think-model` 等，GUI 设置同源）。未配置 REFLECT 模型时
回退主模型——现状不变，零新配置面。

**验收**：mock 两阶段 adapter 测试（先例：E0.3 的 mock 测试）——sleep-time 周期的
反思与 overlay 起草走 REFLECT 通道；未配置时回退主模型。

### P0-3 子代理记忆注入——两柱焊点（M）

**现状洞（本次评审最重要的结构发现）**：编排器直接驱动 engine.run，baseCtx 里没有
IMemoryStore、没有 ContextEngine（SubagentOrchestrator.ts:493-519）——进化产物里
数量最大的 lessons/procedures 永远只到父 agent，到不了干活的人；子代理唯一吃到的
进化物是 persona overlay。"多 agent 是空间维、自进化是时间维"的图，焊点缺了。这
同时违反蓝图跨期纪律"父子同权检查：这项能力父有子有没有"。

**改什么（最小版，守住既有纪律）**：
- CodingAgent 构造编排器时透传可选 `memoryStore`（宿主装配，GUI/CLI 同源）；
- 编排器 spawn 时以 `role + args 摘要` 为 query **compose 一次**记忆注入，拼进
  system prompt 尾部（overlay 之后）——每支只 compose 一次、运行中不刷新，天然符合
  自我进化系统设计 §2.1 的"会话内冻结"决策；子代理本来就每支新 prompt，不存在打穿
  缓存断点的问题；
- 只注入非 low confidence 条目，k=4~6、字符预算收紧（复用 composeMemoryPrompt 既有
  语义，不新写检索逻辑）；error_pattern / tool_preference 优先；
- 归因：该委派的 DelegationObservation 记 memoryInjection 标记——贡献统计才能回答
  "给子代理的记忆有没有用"，这是后续一切子代理侧进化回路的尺子；
- 总开关关闭 ⇒ 零注入，逐字节一致。

**验收**：mock 编排器测试四条（注入出现 / 关闭后逐字节一致 / low 不注入 / 预算裁剪）；
delegations 观测带 injection 标记（parser 兼容旧记录）；e2e 可选。

**边界（本步不做）**：不做子代理写回记忆（子代理的教训仍由父侧反思器统一提炼）；
不做 ContextEngine 压缩下沉；不做 per-role 记忆分区。

## 3. 第二波 P1：飞轮转一圈

### P1-1 S1 真实样本 + 首次 ALLOW（半人工，半天–1 天）

这不是代码任务，是**整个项目从"基建全绿"到"进化实际发生过一次"的标志事件**
（北极星收官标准第 3 条原文）。

**做什么**：
1. 跑 2–3 个真实多 agent 会话：子主题独立、args 不重复，覆盖 researcher /
   code_reviewer / task_planner（建议真活，不用玩具任务——样本质量决定 13.3 的门）；
2. 设置页「收割真实样本」入口入库（T2 已有），确认各角色 case ≥ 5（MIN_ROLE_CASES）；
3. 触发一次 overlay 流（E1.4 建议卡 → 起草 → A/B），看着它第一次真实 ALLOW 落盘；
4. 记录性提交：收割产物 + 首次 ALLOW 的事实记进改进进度记录.md（对齐"进化发生过
   一次"的验收口径）。

**验收**：至少一个角色样本 ≥5、A/B 门槛 ALLOW 一次、overlay 真实落盘一次、仪表盘
徽章亮一次。**飞轮转过一圈之前，不再给系统加任何新的进化机制**——先把已建成的
机器开动。

### P1-2 overlay 落盘后自动回退护栏（M）

**现状洞**：overlay 是"起草 → A/B 一次 → allow 即落盘"的单候选爬坡；落盘后如果
角色持续回归，只有人工删文件。漂移报警只盖记忆，不盖 overlay。对照 MemSkill 的
"保留最优快照、退化即回滚"与 FlowEvo 的负迁移抑制，准入后这条腿是缺的。

**改什么**：
- 13.3 流程落盘 overlay 时，同时把落盘前的状态（无 overlay 或上一个 overlay）快照到
  `~/.pure/personas/<role>.overlay.md.bak`（或 `.history/<ts>/`，取简单的）；
- 落盘时记一条基线（该角色当时的失败率/样本数，进 overlay 落盘的观测记录）；
- 复用既有 decay/ratchet 调度周期加一条**角色级检查**：overlay 在场 且 该角色 30 天
  失败率较落盘基线恶化 ≥ 阈值 且 runs ≥ N ⇒ 自动回退到快照 + 出卡说明（不静默、
  不删除、退避账本记一笔防反复横跳）；
- **只回退"由 13.3 流程落盘且有快照"的 overlay**——用户手写的 overlay 无快照，
  结构上不受此护栏管辖（快照存在即授权，缺失即豁免）。

**验收**：单测——恶化触发回退、快照恢复后文件内容逐字节等于落盘前、用户手写
overlay（无快照）不触发、回退后 7 天内不重复尝试同一 overlay；与既有 deny 退避
账本的关系写进注释（退避管准入失败，回退管准入后退化，两层不同）。

### P1-3 held-out mini-set（S+，半天–1 天）

**现状洞**：v5 全套 15 fixtures 连 golden 解公开在仓库；角色 A/B 门 5 例；lesson
注入零准入度量。进化有在噪声上空转的风险——这是纪律 1（每个学习回路必须带度量）
与现状的最大距离。

**改什么（最小版）**：
- 建 `~/.pure/evals-heldout/`（本地、不进仓库）：5–8 条题目，从真实会话里挑没进过
  v5 套件的形状；
- `run-evals.ts` 加 `--heldout` 旗标：存在才跑、缺席不报错（CI 不受影响）；
- 角色 A/B 裁决报告多一列 held-out 侧对比——**先观测不阻断**（数据攒够再议是否
  硬化成第二道门，本步不改变 ALLOW/DENY 语义）；
- lesson 侧暂不动（量不出来，等 P0-3 的 injection 归因攒数据）。

**验收**：`--heldout` 跑通出对比列；仓库零新增文件依赖；A/B 语义不变的回归测试。

## 4. 第三波 P2：工具自进化（13.4 MVP）

> 用户目标口径里"工具"是自进化的明确组件。设计已定稿
> （capability-self-extension-design.md §13.4），接缝全现成（MCP 动态注册已证明
> 通路），是纯实现活。安全立场沿用设计原文：复用 execute_command 信任模型，不新建
> 安全面、不新增确认步骤（2026-09-17 定调不变）。

### P2-1 TOOL.json 装载半边（M）

**改什么**：
- Rust：`list_external_tools`（扫 `~/.pure/tools/<name>/TOOL.json`，与
  list_external_subagents 同型，PURE_TOOLS_DIR 可覆盖测试）；
- TS：`compileExternalTools` 单一编译器——manifest version:1（对齐 13.2 先例，
  不识别显式拒绝）、name 规则与内建/MCP 冲突拒、input_schema 校验、exec 脚本存在、
  timeout 钳制；TaggedTool 构造（权限按操作类型自动打标，与手写工具同一套门）；
- 注册走 `toolRegistry.register()`（MCP 同款通路）；启动扫描、每 app 运行一次、
  删目录即消失、总开关关闭不加载——原则一逐条对齐；
- GUI/CLI 两宿主同源装配（对齐 externalSubagents 的双宿主接法）。

**验收**：手写一个 `~/.pure/tools/hello/TOOL.json` + 脚本 → 工具列表可见、可调用、
过权限门；坏 manifest 不阻断启动；重名拒绝；cargo test + bun test 双绿。

### P2-2 procedure → 工具固化流（M）

**改什么**（全部用户触发，自动侧只出建议——E2.2 立场平移）：
- 观测侧：procedure 复用 ≥2 次的口径在既有观测里可查（step6 设计已预留），出
  建议卡"把这个做法固化成工具？"；
- 起草：模型出 TOOL.json + 脚本 → 过 P2-1 同一编译器（13.2 同款纪律：草稿必须过
  装载校验）；
- **试跑**：按 input_schema 造样例参数真跑一遍，成功才算起草完成（失败退回重写，
  最多 2 次）；
- 落盘前确认弹窗（与 13.2 三道门同款：处理器端重扫确认建议仍在 + 同名拒覆盖 +
  confirm）；
- 连续失败自动停用（隔离不删除）+ 出卡——边界表既有条目直接落。

**验收**：一条指令从 procedure 产出工具且下次会话 `<tools>` 可见可调用；试跑失败
不落盘；停用卡出现且可重新启用。

## 5. 第四波 P3：结构债（穿插刀）

### P3-1 lib.rs 三刀（各 M，机械移动 + 构建修复）

17,410 行 96 command 单文件，Rust 测试 37 个（TS 侧 3,144——密度失衡）。切缝注释
现成，按耦合最低序：`web_public_api.rs`（~1,200 行解析器栈，几乎零耦合）→
`mcp.rs`（子进程注册表 + OAuth）→ `llm_stream.rs`（chat_stream 一族 ~550 行）。
每刀验收：cargo test 绿 + tauri build 过 + 行数变化记账。

### P3-2 chat.ts 控制面出 UI（L，✅ 已收官 2026-10-08）

多 agent 控制面（steer 队列 / 折入闸 / 起飞闸 / 分支点名 / 暂停宽限状态机）住在
UI 层 7,924 行的 god-module 里，CLI 宿主没有等价能力——同一编排器两套宿主语义。
**本刀目标不是全拆**：把控制面抽成宿主无关模块（纯逻辑 + 注入回调），chat.ts 变
消费者。这是蓝图第 8 期"CLI 接 steering 通道"的前置，也是 runLoop/execute 拆方法
的前置（控制面抽走后再动引擎，不然一次改两处）。
验收：T01–T30 回放器 + 全部判例回放绿（行为逐字节等价）。

**落地（绞杀者序五刀，2411279 → 18e8583 + 收口提交）**：SteerBus（`2411279`）→
DelegationControlPlane（`4f9e40e`）→ 四本账全量切 plane（`d423cac`）→ FoldInLedger
+ 续跑账（`2c06f4c`）→ RoundClosePlane（`f1fbebb`）→ InterjectOrchestrator 五类裁决
序（`18e8583`）→ 暂停宽限收口 `upgradeToHardStop`。每刀独立检验对照 HEAD 逐分支
等价 + 变异抽查守卫有效性；判例回放 39 例文本零改、decisor 回放 byte-identical。
CLI 宿主真缝 delegation/roundClose/steerRunningTurn，send/abort/投影休眠（CLI 插话
输入路落地时一次接上）。**交棒**：S2 结构收益已拿满，主线回进化轨道（P1-3 held-out
mini-set）——飞轮转过一圈之前，不再给系统加新的进化机制，也不再开架构刀。

### P3-3 reads 并发池上限（S）

runPool 对 reads 不设上限——一批 N 个委派即 N 个并发子引擎 + N 条 LLM 流。加
`maxConcurrency`（默认 5，config 可调），超出排队（不拒绝）。真机多 agent 会话
（P1-1）若暴露别的瓶颈，按数据再调。
验收：并发 fixture 断言同时在飞数 ≤ 上限；4–6 并发 vs 无限的墙钟不劣化。

### P3-4 仓库卫生（S）

- 工作区根 107MB 未跟踪二进制 `pure` 移出（构建残留，gitignore 兜底）；
- `scripts/tmp-*` 探针脚本（~95K）归档或删除；
- 供应链两项（onnxruntime-web 钉 dev 构建、xlsx vendored）**只记录不动**——按
  2026-09-17 定调不做安全加固，账本里留一行知悉即可。

## 6. 明确不做 / 缓做（与评审结论对齐，防回潮）

1. **插件一等公民**：skills + MCP 已覆盖扩展面，等 13.4 落地后再评估——现在做是
   概念膨胀。
2. **父 prompt / Planner / 分类器 prompt 进化（GEPA 式候选池）**：等 P1-1 的数据 +
   P1-3 的 held-out 就位后再评估——薄度量上不加优化器。
3. **agent 自由对话网 / 孙代委派 / 运行中热替换**：维持北极星反面清单。
4. **沙箱 / 签名 / 权限加固**：维持 2026-09-17 定调。
5. **runLoop / execute 拆方法**：不单独开刀，等 P3-2 抽走控制面后顺势做。
6. **CLI 棘轮/漂移接线**：真实需要出现再做（CLI 与 GUI 记忆库分立是既状），记录在
   案不排期。

## 7. 完成定义（本计划整体的收官口径）

1. **红线真成立**：总开关关闭后，in-turn 反思、sleep-time 循环、子代理记忆注入、
   工具产物加载全部归零，行为逐字节一致——这次是全量真的，不是部分。
2. **飞轮转过一圈**：真实样本 ≥5、A/B ALLOW 一次、overlay 落盘一次且**带着回退
   护栏**、held-out 列在报告里。
3. **"工具"兑现**：一个由系统起草、试跑通过、真实注册的自生成工具在用。
4. **两柱焊上**：子代理带着记忆干活，且委派观测能回答"记忆有没有用"。
5. 红线不变：v5 基线不倒退、全量测试绿。
