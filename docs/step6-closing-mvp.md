# 北极星第 6 步收官 MVP：按优先级的落地设计

状态：**方案定稿（2026-09-22），未实施**。上游：`team-observability-design.md`
（团队可观测总设计）、`capability-self-extension-design.md`（13.1/13.2/13.4）。
本文回答一个问题：第 6 步还差的四件事（13.1 接真实样本、团队可观测、13.2 完整版、
13.4 工具生成），**按什么顺序做、每个的最小落地是什么、做到哪算完**。

## 0. 一条勘误（比任何新功能都重要）

设计总方案（team-observability-design.md）里 G2 的修法写的是"新增
`sessionRef` 字段"——** redundant，撤回**。核实 `Harness.run()` 的观测链后确认：
`agent_run.sessionId` 的取值就是会话存档目录名（`~/.pure/sessions/<sessionId>/`），
观测与存档**本来就共享同一个 id**。G2 的真缺口只剩两个：

1. **委派无身份**（G1）：观测里数得出"researcher 被派了 30 次"，指不出"哪一次"；
2. **删除无提示**（G3）：会话删了，观测记录变孤儿，收割永远配不上。

所以 T1 砍掉 sessionRef，T2 的"按 id 精确配对"退化为"按 sessionId 配对"——
工作量更小，收益不变。

## 1. 优先级（判断依据：数据先于产物，样本先于生成）

```
P0  T1 委派观测下放（delegations 进 agent_run）      ← 一切度量的地基，最小改动
P0  T2 收割落袋为安（会话删除提示 + 收割常驻入口）      ← 样本不再凭空消失
P1  T3 团队卡最小版（阵容表 + 样本存量列）             ← 望楼可见，用户知道该干嘛
P1  S1 样本过门槛（多跑多 agent 会话 + 收割入库）       ← 门的钥匙是人不是代码
P2  T4 成本视图（依赖价目拆分，先记 usage 拆分）        ← 有数据但暂无页面
P2  13.1 建议一键应用                                  ← 零风险收尾，接进度量闭环
P3  13.2 完整版（模型起草 + 试用制准入）                ← 等 T1 的观测数据做准入尺
P3  13.4 工具生成                                      ← 等阶段 10 沙箱结论，缓做不变
```

原则只有一条：**先让"看"与"攒"就位（P0–P1），再让"生成"上路（P2–P3）**。
13.2/13.4 的准入都依赖"足够多的真实委派结局数据"——这批数据只能靠 T1 落盘、
靠 S1 攒量。跳过 P0 直接做 13.2 完整版，等于没有尺子先造尺子量东西。

## 2. 各项 MVP 定义（做到哪算完）

### T1 委派观测下放（P0，S–M）

**改什么**（全部是增量字段，`ToolObservation`/`toolCalls` 语义不动）：

```ts
// promptObservability.ts
interface DelegationObservation {
  agentId: string;        // ag-xxxxxxxx
  role: string;
  startedAt: number;
  durationMs?: number;    // 收尾补
  success?: boolean;      // 收尾补
  usage?: TokenUsage;     // 子代理 Completed usage 抄过来（拆分，不冒充）
  outputChars?: number;   // 产出规模
  errorKind?: string;     // 复用 errorKind()
}

// AgentRunObservation 增量
delegations?: DelegationObservation[];
```

**接线**：`Harness` 是唯一拥有 `observability` 的地方（`CodingAgent` 只 import
类型）。子代理委派的 ToolResult 事件已经在 `recordEvent` 里流过 `toolCalls`
（`toolName` = 角色名）——在 `recordEvent` 的 `ToolResult` 分支加一条旁路：当
`toolName` 是注册角色时，从 `SubagentResult`（result payload 里已有）抽
agentId/tokensUsed/output 规模，落到当前 run 记录的 `delegations[]`。委派开始
时间用 `Date.now() - duration` 反推即可，**不用**为开始事件开新通道。

orchestrator 加可选 `usage?: TokenUsage` 到 `SubagentResult`（从子代理引擎自己的
Completed payload 抄），`tokensUsed` 保留不动（既有消费者零改动）。

**不做**：relay 字段（T4 评估）、sessionRef（勘误撤回）、任何运行时行为变化。

**验收**：mock provider 集成测试断言 delegations 落盘且带 ag-id；parser 兼容旧
记录（无 delegations 字段不报错）；E4.2 既有聚合器测试全绿（toolCalls 语义未动）。

### T2 收割落袋为安（P0，S）

**改什么**：

1. **删除确认卡提示行**：Rust 只读命令 `summarize_session_delegations(session_id)`
   返回 `{delegationCount, byRole}`（读单份 session.json 数角色 toolCall）；
   GUI 删除确认卡有委派时加一行「该会话含 N 条角色委派存档（researcher×2、
   code_reviewer×1…），删除后不可再收割样本」。只提示，不拦截。
2. **收割常驻入口**：进化区阵容表（T3 之前的过渡位：E1.4 建议卡旁）加「收割
   真实样本」按钮 → 干跑预览（每角色差几条、离门槛多远）→ 用户确认 → 复用
   `personaOverlayFlow` 同款依赖注入编排（adapter 可注入 mock，e2e 可测）。

**不做**：自动收割、自动写盘、阻止删除。

**验收**：删除含委派的会话时确认卡出现统计行；收割入口干跑 → 确认 → `~/.pure/roles/`
出现 case 文件；全流程注入式 e2e 绿。

### T3 团队卡最小版（P1，M）

**砍到只剩一张表**：设置页「进化」区新增团队卡 = 角色阵容表，列：30 天派发数 /
成功率 / 平均耗时 / token 占比 / overlay 徽章（已有）/ **样本存量列**（case 数 vs
`MIN_ROLE_CASES`，差几条一目了然）。点行展开委派明细（ag-id / 时长 / 错误类 /
所属会话）——这依赖 T1 的 delegations，没有 T1 就没有这张卡的价值。

**不做**：成本卡（T4）、趋势图、导出、多窗口切换。e2e 用既有
`__PURE_OBSERVATION_FEED__` 注入。

**验收**：聚合器纯函数 `teamObservability.ts` 单测覆盖"缺字段=无数据不冒充 0"；
e2e 注入 feed 驱动渲染；浏览器模式空态沿用 `available:false` 语义。

### S1 样本过门槛（P1，人工动作 + 已有代码）

**这不是代码任务**：T1/T2 落地后，跑 2–3 个多 agent 会话（子主题独立、args
不重复、覆盖 researcher / code_reviewer / task_planner），然后点收割入口。门开
（≥5）后 13.3 part 3 的落盘路径第一次真正可走通——**这是整个第 6 步从"基建全绿"
到"进化实际发生过一次"的标志事件**。

### T4 成本视图（P2，M，依赖 T1）

T1 已把 usage 拆分记进 delegations，本项只剩聚合 + 渲染：角色 × provider 成本
占比表。价目表复用 usage.ts；未定价显示「未定价」（同一把尺子）。可以等真实
数据攒两周再做——记录先行、展示后行，是本设计刻意留的余地。

### 13.1 建议一键应用（P2，S）

capability-self-extension-design.md §13.1 原样执行：建议卡加「应用」——E1.4
skill-gate 类写技能开关、E1.3 工具注意落记忆，应用记录进观测。改动面
optimizeCard/进化设置页 + i18n，零新风险面。

### 13.2 完整版（P3，L）

在 T1 观测数据攒够前**不动**。触发条件：delegations 数据 ≥ 2 周且 E1.4 能从
里面看出"同类任务被反复手工拆解"的真实模式。到时按 capability 设计的试用制
准入做，尺子就是 T1 的数据。

### 13.4 工具生成（P3，L）

维持缓做（阶段 10 沙箱有结论前不启动）。唯一前置动作已随 T1 完成：procedure
复用次数的观测口径在 delegations 落地后顺带可查。

## 3. 提交切分（每笔独立可回滚）

| 提交 | 内容 | 依赖 |
|---|---|---|
| C1 | T1：DelegationObservation + SubagentResult.usage + recordEvent 旁路 + 测试 | — |
| C2 | T2：Rust summarize 命令 + 删除提示行 + 收割入口编排 + e2e | C1（干跑预览要显示差距，读 delegations 更准；无 C1 也可跑，读 toolCalls 兜底） |
| C3 | T3：teamObservability 聚合器 + 团队卡渲染 + 测试/e2e | C1 |
| C4 | S1：真机会话攒样本 + 收割入库 + 13.3 落盘路径首次走通（记录性提交） | C2 |
| C5 | T4：成本聚合 + 成本卡（可延后） | C3 |
| C6 | 13.1：建议一键应用 | — |

## 4. 验收口径（第 6 步整体收官标准）

1. **看得住**：不翻文件，设置页一屏回答"团队都有谁、谁在掉链子、门还差几条样本"。
2. **攒得下**：删除会话不再无声丢样本；收割一键入库；存活会话 100% 可配对
   （对照 2026-09-22 盘点的 25/25 基线不退步）。
3. **进化发生过**：至少一个角色样本 ≥5、A/B 门槛 ALLOW 一次、overlay 真实落盘
   一次、仪表盘徽章亮一次——第 6 步完成的定义不是"代码齐了"，是**回路转过一圈**。
4. **红线**：v5 基线不倒退；全量测试绿；观测开关关闭时 delegations 不写、
   运行时行为逐字节不变。
