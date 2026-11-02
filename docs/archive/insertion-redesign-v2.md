# 插话架构 v2：软暂停与九类处置（施工蓝图）

> **权威声明（2026-10-27 用户拍板）**：「所有之前实现和设计与最新设想不符的，按照最新的来；不需要妥协或者小打小闹，该更新的全换，从根上改变之前的实现。」
> 需求权威 = `~/Documents/用户插入会话的处理逻辑与流程.md`（下称《设想》）。本文档是《设想》到 pure 代码的施工映射，与旧实现冲突处一律以《设想》为准。`docs/dynamic-insertion-design.md` 中与本蓝图冲突的部分就此作废；`~/Documents/学习案例集.md` 降为判例参考库，冲突判例按 §十 裁决记录执行。

## 一、新架构总流程

```
插话到达（GUI Enter → chat.interject）
  │
  ▼
软暂停 hold on：宿主立即扣住【输出推进 + 写操作派发】；已发出的只读调用可完成
  │
  ▼
关系判断（判断在前，状态查询在后）：把插话放回「用户上一句 + 当前正在输出的内容」脉络
  三通道不变：rule 正则快路径（0 往返）/ judge LLM 裁决 / net 字面安全网
  输出 = 九类 relation + 契约字段（§五）
  │
  ├─(9) misunderstanding（自查确认后）/ (2) 中实质承载旧方向 → 真暂停链（§七）
  ├─(4) unrelated / (6) question → 不触碰当前任务：旁答 / 新任务另起，解除 hold 照常
  ├─(1) supplement / (3) emphasize → 不中断不清理；纳入执行 / 调权重
  ├─(2) change / (5) correction / (7) mixed → 查任务状态（§三 API）→
  │      未开始→拦截（起飞闸）；进行中→中断清理；已完成→副作用账，
  │      一期一律降级「冻结 + 询问用户」（不自动补偿）
  ├─(8) meta → 改执行/交互方式不改内容，解除 hold 前应用
  │
  ▼
解除 hold：软暂停路径按判断结果继续或转向；真暂停路径重新生成完成后恢复
```

**硬门槛**：运行时能产出关系判断和影响定位所需的结构化状态（§三）。此条不成立，其余无从谈起。

## 二、机制替换映射（旧 → 新）

| 旧机制 | 处置 | 新机制 |
|---|---|---|
| 判定窗口旁观（裁决期间主回合照常推进，interjectOrchestrator 判完才动手） | **删除** | 软暂停闸 holdGate（§四）：到达即扣，判完按类解除 |
| 七类 kind（stop/premise-change/goal-change/steer/question/task/chatter）+ KIND_POLICY | **替换** | 九类 relation（§五）；旧 kind 映射留档 §十.5 |
| 「不做新旧计划的结构化 diff，重入模型现判」（dynamic-insertion-design §7.1 自认取舍） | **推翻** | 任务状态结构化 taskState（§三），查询 API 供管线定位影响 |
| 墓碑/标记不用（stripSettledBranchOutput、标记不用于决策）作为唯一清理形态 | **扩展** | 真暂停清理链（§七）：上下文剔除 + **渲染层留底范式推广**；账本作废不删 UI 历史 |
| 押账插话 holdInsert + 回合收尾原话优先重入 | **保留并升级** | 真暂停「回到用户原话重新开始」的执行机制（§七.4） |
| 思考窗吸收 shouldAbsorbIntoThinkingWindow（掐流+作废+重启） | **并入** | 不再独立判定「吸收」；思考期插话由 hold + 处置管线自然覆盖（补充/纠偏在思考期=作废重想） |
| 起飞闸 pendingCancels / abort / pause 双档 / interruptible 豁免 / 8s 宽限 / hardStop | **保留** | 与新管线直接对接（(2) 未开始→起飞闸；进行中→abort/pause 按祈使或收活） |
| 三通道判定（STOP_RE 等正则快路径 / judge ≤8s / net 兜底）+ covered_branch 花名册核实（宿主零字面匹配） | **保留** | rule 通道在 hold 窗口内 0 往返完成；花名册机制照旧供 stop_branch/covered_branch 点名 |
| 置信门（<0.6 且破坏性 → clarify） | **保留并扩类** | 破坏性集合 = change / misunderstanding / correction |
| question 旁答 answerMidrunQuestion | **保留** | 即 (6) 的实现 |
| isFileMutating「算了不用，仅用于未来保守过滤」 | **启用** | holdGate 的写派发判定依据之一（工具元数据 sideEffects/isWrite） |

## 三、任务状态结构化（地基，新模块 `src/coding-agent/taskState.ts`）

```ts
export interface TaskNode {
  id: string;                 // 步骤/分支节点 id
  title: string;
  state: 'pending' | 'running' | 'done' | 'stale' | 'cancelled';
  dependsOn: string[];        // 数据依赖边
  branchCallId?: string;      // 关联委派支（BranchState 七态缝）
  origin: 'plan' | 'delegation' | 'queue' | 'interject';
}
export interface ConstraintEntry {      // 约束血缘：约束 → 依附节点
  id: string;
  text: string;                // 约束/前提原文片段
  source: 'user' | 'plan' | 'interject';
  status: 'active' | 'removed' | 'superseded';
  attachedNodes: string[];     // 「因这条约束才做这些节点」——因果依赖的载体
}
export interface SideEffectEntry {
  id: string; ts: number; tool: string; callId?: string;
  write: boolean; irreversible: boolean;
  target?: string;
  compensable: 'auto' | 'manual' | 'none';
  status: 'done' | 'frozen' | 'compensated';
}
export interface TaskStateSnapshot {
  nodes: TaskNode[]; constraints: ConstraintEntry[];
  sideEffects: SideEffectEntry[];
  safetyMarks: { nodeId: string; reason: string }[];   // 不可逆边界标记
}
```

- **折算器（宿主折算为主，模型修正为辅）**：`foldTaskState(signals, plan, branches) → snapshot`——从 TaskScript signals（planReplaced/phaseStart/phaseDone/tool/delegation/delegationRetracted/verification）+ Plan/PlanStep（补 `dependsOn` 边）+ BranchState 缝折算；回合收尾调用，FoldedStep 现推逻辑改持久落账。**不让模型每轮自报告全图**。
- **查询 API**（处置管线唯一入口，禁止管线自己扫上下文）：
  - `affectedByChange(nodeIds | constraintIds): TaskNode[]` —— 沿 dependsOn 下游 + 约束 attachedNodes（数据依赖必须处理）
  - `causalDependents(nodeId): TaskNode[]` —— 因果依赖：下游本身独立有效可保留，标注触发原因已撤回（《设想》§五.6）
  - `pendingWrites(): SideEffectEntry[]`；`freezeUncompensable(): SideEffectEntry[]`
- **副作用账落账点**：工具完成回调按 sideEffects/isWrite 元数据落账（irreversible 以工具元数据+安全标记为准）。
- **约束来源（一期务实）**：用户原话中的显式条件（判定器 `targets_constraint` 指认时登记）、Plan verification 依附、处置管线新增。API 完整，数据源一期尽力、二期补精度。

## 四、软暂停闸 holdGate（宿主机制，执行者=宿主，模型只产出判定）

- **到达即扣**：`interject()` 入口第一步 `holdGate.close()`，再入裁决链。rule 快路径 0 往返判完即处置即解除。
- **hold 语义**：扣【输出推进（模型 token 流在下一停顿点挂起）+ 写操作派发】；**只读调用派发与在飞完成放行**（`isWrite:false` 直通；在飞一律不掐，等自然完成）。
- **实现锚点**：主回合 THINK 边界 + 工具批次派发前查闸；挂起时已有的 ack 行（「插话处理中…」）即用户可见的 hold on 形态。
- **死线**：hold 最长 = judge 预算 ≤8s + 处置预算；judge 倒下 → net 兜底；net 也倒下 → 强制解除 + 如实收执。**绝无永久扣死路径**。
- **解除**：`holdGate.open(outcome)`——按处置结论放行/转向/交棒真暂停链。

## 五、九类判定契约（重写 `INSERTION_CLASSIFY_PROMPT`）

### 5.0 判定上下文构成（用户 2026-10-27 强调的关键：软暂停后开始思考关系）

关系判断的质量取决于判定器能读到什么。《设想》§一前提：「同一句『预算改成 50 万』在『还没用到预算』和『已基于旧预算产出』两种情况下无法区分」——**判定上下文必须三要素齐备**，判定输入 payload 定义为：

1. **用户上一句原话**（当前任务的目标原点，原样不可摘要丢失关键条件）；
2. **当前输出脉络**：正在生成/执行的内容到哪了（最近几个 THINK 段的实质进展 + 当前批次在做什么），不是 token 级全文，是「做到哪」的忠实脉络；
3. **任务状态投影**：taskState snapshot 的轻量投影（running/pending 节点、依附约束、最近副作用）——「依据什么条件在做」。

现状 `buildInsertionContext()` 只投花名册（call_id/role/80 字任务书），**不满足三要素**，须改造为三要素投影（chat.ts 侧实现，接口由本节定义；judge 提示词按三要素消费）。rule/net 通道不依赖此 payload。

### 5.1 判定器输出 JSON

```json
{
  "relation": "supplement|change|emphasize|unrelated|correction|question|mixed|meta|misunderstanding",
  "unrelated_kind": "new_task|chatter",        // relation=unrelated 时必填
  "reason": "…", "confidence": 0.0,
  "atoms": [ { "relation": "…", "text": "…" } ],  // relation=mixed 时必填
  "cancels_part": true,                         // 影响/取消当前工作的部分
  "stop_branch": { "call_id": "…" },            // 从 <live_branches> 照抄确切 id（祈使停=abort / 收活=pause）
  "covered_branch": { "call_id": "…" },         // 范围确认去重，花名册核实照旧
  "adds_along": true,
  "urgent": true,
  "targets_constraint": "被改变的约束/前提原文片段",
  "self_check_needed": true                     // 疑似 misunderstanding 时请求自查
}
```

- 判据定调**保留**：「时机 × 内容对结果的影响」，不看关键词（2026-09-28 定调）。
- **(9) misunderstanding 双重触发**（《设想》§五.2）：插话意图指向纠偏 **且** `self_check_needed` 触发的自查确认「当前输出不忠实于用户上一句」→ 才走真暂停；自查通过 → 降级为 correction/supplement 处置。
- **(5) correction ≠ 真暂停**：中断+清理+回退理解节点（押账重入实现），不掐 token 流。真暂停专属 (9) 与 (2) 中实质承载旧方向的节点。
- **(7) mixed**：atoms 按原子分流；一期的已完成节点副作用一律「冻结+询问」。
- **(8) meta**：一期路由 = 记录并应用执行方式调整（不改任务内容）；复杂元指令二期能动执行面后再扩。
- net 安全网正则族按九类对齐（粗判即可，仅 judge 倒下时用）。

## 六、处置管线（重写 `interjectOrchestrator` 分发臂）

| relation | 查任务状态 | 处置 |
|---|---|---|
| supplement (1) | 仅冲突检查 | 纳入执行（steer 通道/adds_along）；不停受影响之外的步骤 |
| change (2) | **是，重点** | 拆 targets → `affectedByChange` 定位 → 未开始=起飞闸拦截；进行中=abort/pause+清理；已完成=副作用账，一期冻结+询问；实质承载旧方向的节点→真暂停 |
| emphasize (3) | 可能需要 | 调权重不改约束值：running→steer 带 emphasize；pending→排序提前 |
| unrelated (4) | 否 | new_task→排队/汇合轮（原 task 语义）；chatter→收下。**必须回告，绝不静默** |
| correction (5) | 是 | 清理基于歧义表述的产出+回退理解节点（押账重入），一期已完成副作用冻结+询问 |
| question (6) | 只读 | 旁答，主循环零感知 |
| mixed (7) | 按原子 | atoms 逐个分流；口径同各原子类 |
| meta (8) | 否 | 应用执行方式调整后继续 |
| misunderstanding (9) | **是，重点查副作用** | 自查确认 → **真暂停链**（§七） |

回合收尾 RoundClosePlane 派发序保持：回执结算 → 折入核验 → 续跑兜底 → **押账/真暂停重入优先** → steer → 队列。

## 七、真暂停链路（宿主执行）

1. **触发**：(9) 自查确认，或 (2) 中节点经查状态确认「已生成内容实质承载旧方向」（通用铺垫不算——《设想》§五.2 双重触发）。
2. **中断 token 流**：复用 abort/pauseSignal 管道（可掐工具有宽限，interruptible:false 排空）。
3. **清理**：基于错误理解已产出的内容做**上下文剔除 + 渲染层留底**（推广 stripSettledBranchOutput 范式：现场清、UI 留底、账本作废）；工具暂存结果按副作用账处置。
4. **回原话重入**：押账重入升级——新回合开场 = 用户上一句原话 + 纠偏插话，旧理解节点的产出不入新上下文。
5. **已驱动写操作** → 副作用账 → 一期「冻结 + 询问用户」，二期三级补偿。

## 八、提示词层

- `INSERTION_PROTOCOL_PROMPT`（常驻）：改写为软暂停语义 + 九类消化视角（运行中的模型：插话被宿主押放、解除后怎么继续）；**保留不冲突判例锚**：宿主停支模型永不停支、幸存者合并、cancel 折入等话术契约（insertionMessaging INV 契约锚同步对齐）。
- `INSERTION_CLASSIFY_PROMPT`（裁决器）：§五契约全文重写。
- **预算红线**：改写后常驻动手轮不得超出现值 9,978 tokens 的 5%（量入量出，禁止借机回涨）。

## 九、分期范围（照《设想》§六）

- **一期（本次实施）**：taskState 结构化产出（节点状态+约束血缘+副作用账+安全标记）；holdGate 软暂停；九类分类层；(4)(6)(1)(3) 轻量路径；(2) 未开始拦截+进行中中断；(9) 真暂停链；(2)(5)(7) 已完成副作用一律冻结+询问。
- **二期（后续）**：依赖遍历四类划分（不受影响/partial-stale/产物过期/运行中基于旧约束）；三级补偿；(7) 原子拆分精度；hold 期间并发的「需重验」第三态；纠错窗口。
- CLI 插话路仍休眠，本次不接（GUI 全量生效）。

## 十、与既有判例的裁决记录（用户拍板：不符者按新设想来）

1. **案例集时序 vs 软暂停**：软暂停为准。《设想》的 hold on 是判定前的宿主扣压，取代「暂停永远是判定之后施加」的旧时序；案例 1「不暂停当前原子步骤」解读为处置结论（不受影响的步骤照跑），扣压本身由 holdGate 统一执行。
2. **「标记不删」vs 真暂停清理**：清理 = 上下文剔除 + 渲染留底 + 账本作废——现场清、UI 历史不删、账不灭。已取外部数据在非真暂停路径仍走「标记不用」（降级保留）。
3. **「取消绝不排队」（起飞闸判例）**：保留——(2) 未开始→拦截正是起飞闸语义。
4. **「宿主负责停」**：保留并强化——holdGate/真暂停/abort 全部宿主执行，模型只判定。
5. **旧七类 kind 映射留档**：steer→supplement/emphasize；premise-change→misunderstanding/correction；goal-change→change；question→question；task→unrelated(new_task)；chatter→unrelated(chatter)；stop→change 全停特例（relation=change + stop_branch 全点名）。
6. **收执纪律**：保留——收执只说宿主机械事实、对接上下文点名具体的事、模板句照抄就是错的。

## 十一、验收

- `bun test` 全绿 + `tsc` 零错；九类契约用例、holdGate 死线用例、foldTaskState 折算用例有测试锁定。
- 部署本机六项验证（四处落位特征串 + 签名 + Info.plist）。
- 真机复验清单：hold 观感（插话后输出扣压+ack）、九类抽查（案例 1 补充 / 案例 3 即时止损 / 案例 4 无关回告 / 案例 7 翻转按最终意图 / 案例 11 不可逆澄清）、真暂停回原话、任务状态查询命中（(2) 类插话的影响定位）。
