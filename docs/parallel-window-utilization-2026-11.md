# 委派窗口利用：主线在子代理在飞时干自己的活（2026-11）

> 地位：档一已落（2026-11-18：runPool 带路径写与读池重叠开跑 + FileLockManager 进程级共享；写入并发上限 3），档二**改落点后已落地**（2026-11-18：委派后台执行 = 工具层 detach + 引擎三件物理事，见 §三），档三已落（Map-reduce fan-out 教学段 43b191d）。
> 源头：2026-11-18 用户判语「既然都派遣了子 agent 处理事情了，pure 的主 agent 可以利用这段时间干别的事情」——run6 首次构建路径委派实证后提出。
> 证据锚：run6（session_1794990780366_1）——nudge 81KB 注入 → 主线委派 code_editor（ag-79a5ed05）写 ECharts 面板，主线原话「先并行派出去写，我同时收事件编排」；周边 commit：cc5b144（nudge 引擎中途通道）、f702532（直播流体量折叠）。

## 一、思路判定：对，且一半已是现实

**已并行的部分**：委派工具走执行池的读池——同批多支委派天然并发（scale caps ≤4 约束并发数），多路 worker 同时生产是既有能力，fan-out 教学（2767157）教的「同批多支」即此。

**没并行的部分**（本刀的靶点）：`ToolExecutionCoordinator.runPool` 的排空顺序是「读池全部完成 → 再串行执行写」。今天同批塞 `[委派(4 分钟), write_file(主线自己认领的模块)]`，主线写会排在委派完成之后——**委派在飞的整个窗口，主线程纯等待**：不思考（引擎回合制，批不清空就没有下一个 THINK）、不写（写排在读池后）、只收最终结果。用户指出的「窗口浪费」成立。

## 二、为什么主线的窗口值得填

- **墙钟**：一支 code_editor 在飞 4-8 分钟，主线窗口里能塞下 1-3 个自己认领的小模块直接写。
- **角色分工天然匹配**：主线的独特职责（编排/集成/验证）天然串行，它「干别的事」的最好形态有两种——多派几支 worker（并行生产，已有能力）+ 把自己认领的小活塞进委派窗口（本文的刀）。两者互补不冲突。
- **不捅端点限流**：主线的直接 write_file 不是 LLM 调用，窗口填充不增加模型并发（与档二的本质区别，见档二）。

## 三、落地三刀

### 档一：执行池写入并发化（小刀，立即可落）

**改法**：`runPool` 的写入排空从「读池排空后」改为「读池启动后即可开跑」——写-写之间仍严格串行（现行为），读-写重叠由既有路径锁兜底。

**安全性论证**：
- 写-写串行保留：FileLockManager per-path 锁 + 串行排空，同路径冲突语义不变。
- 写 vs 委派（读池）：委派是子代理在自己的引擎实例里干活，主线写主线认领的文件——物理上互不相碰；若碰同一路径，需核实 FileLockManager 是否覆盖子代理引擎实例（子代理与主线同进程，锁应为进程级共享——落刀前先核这一条，是本刀的唯一前置检查项）。
- 不动 LLM 并发：主线不发新的模型请求，端点限流无感。

**验收判据**：单测——同批 `[code_editor(慢), write_file]` 的执行时间线中 write_file 的完成时刻早于 code_editor 的完成时刻；现有写串行/路径锁用例不回退。

### 档三：教学补一句（免费，依赖档一）

`MULTI_AGENT_MECHANICS_PROMPT` 的 Produce fan-out 段补一句：「委派批里同时塞进你自己认领模块的直接写活——窗口是贵的，别让它在等待里空着」。**依赖档一**：执行层不支持时教这句是空话，模型照做也不并发。

### 档二：委派后台执行（已落，落点从引擎状态机改到工具层）

**原方案的问题（评审裁定 2026-11-18）**：把档二写成「引擎交错 THINK 大手术」，风险估高了、机制写空了。五个机制空白里两个会静默出错：

1. **配对契约**：`assistant.tool_calls` 与 `tool` 结果必须一一配对，缺一条下一次请求 400。异步收结果必须先给一条合成受理收执。
2. **终局闸**：模型在支在飞时给纯文本会直接 VERIFY → TERMINATE，结果永久丢在回合外，汇总还把没跑完的活说成完成。
3. **送达通道**：`subagentEvents` 的 reader 是**批级**的（`runBatch` 的 finally 关闭），分支活过这一批，卡片 trace 从下一批起失明。**（2026-11-18 续已解：THINK 与终局等待各持一个自己的 reader 转发，见下）**
4. **控制面**：`executeOne` 的 abort 监听随调用结束移除、编排器在 finally 里删在飞账——委派提前返回等于把分支变成没人能停的孤儿。
5. **其他**：relay 上游被后台化后下游拿不到产出；同参重派会命中去重游标里的「成功」快照；检查点只带 messages；worker 在飞数不再受「一批」约束。

**新落点（工具层 detach，2026-11-18 落地）**：委派工具支持保留参数 `detach`（默认 true）。受理时立刻返回**受理收执**（`ToolResult.deferred: true`，`success: true` 是配对契约的要求），子引擎在后台继续跑；引擎只加三件物理事：

- **配平点送达**：每个工具批结束后（`TurnCheckpoint` 之前，与 `workspaceConventions` / `pullTurnParallelNudge` 同一缝）取走已结算支，作为 internal user 消息进转录 + 一条 `backgroundSettle` 的 ToolResult 事件（宿主据此把委派卡从「后台运行中」结算成真结果，不新开卡）。
- **终局闸**：模型给最终答复时还有支在飞 → 先等收齐（30s 片，暂停/硬停即时打断），送达后重入 THINK 让模型拿真产出重写答复；兜底上限 45min（分支自身 30min 总墙钟 + 5min 活性看门狗，正常不可达）。
- **中止线与账本寿命**：受执是 `deferred` 时工具执行器**保留**回合信号的 abort 监听——暂停/Esc 照旧到达子引擎（现有 paused-checkpoint 路径复用）；编排器的在飞账一直在，`stop_branch` 对后台支仍可见、可停。

**边界（均为机制，不替模型决策）**：

- **relay 链成员强制同步**：下游参数槽要直接吃上游产出，后台化会拿不到东西。
- **同参去重**：stableSessionId 命中在飞的支 → 新调用拿指向那支的收执，不重复派工（两支同参委派会互相踩同一份断点存档）。
- **并发上限 6**：detach 后 worker 数不再受「一批」约束，scale cap 退化成软约束；超限的委派退回同步执行（不拒绝、不丢活）。
- **去重游标不记受理收执**：它不是产出，同参重发必须真派。
- **默认开 + kill switch**：产品路径（CodingAgent / CLI）默认开；`config.detachDelegations === false`（GUI）/ `PURE_DETACHED_DELEGATION=0`（CLI）回到档一行为。编排器自身默认关——嵌入方（overlay 运行、测试、第三方宿主）没有回合循环，拿到收执而无处送达等于静默丢结果。
- **嵌套委派保持同步**：子代理引擎不接后台端口（maxDepth 1 的现状不变）。

**验收判据（已落测试）**：

- 时间线：同批 `[detach code_editor(慢), 主线 write_file]` 里写的 ToolResult 在委派完成前就吐（`ToolExecutionCoordinator` 切片 0）；委派工具返回的收执 `deferred: true`、不含产出文本（`SubagentOrchestrator.detach`）。
- 送达：工具批复平点把后台结果作为内部消息送达，同时发出 `backgroundSettle` 事件，转录配对完整（`AgentLoopEngine.detachedBranches`）。
- 终局闸：模型在支在飞时给草稿 → 不 TERMINATE，等收齐后重入 THINK，最终答复用的是收到产出后的那一版。
- 去重：同参重派真执行两次，不被合成复用顶替。
- 控制面：detach 后在飞账仍在（`branchControlToolDefs` 可见 `stop_branch`）。

**被放弃的形态**：引擎部分批次推进 / 交错 THINK。工具一旦立刻返回，批次照常清空，回合制状态机（配对点、失败恢复批次语义、TurnCheckpoint/插话/relay 拓扑）完全不用动——那场手术是不必要的。

## 四、判例与边界

- run6 是构建路径委派第一例，但**委派窗口利用率的量化基线还没建**：本轮 code_editor 在飞约 4-8 分钟，主线在此窗口的实际产出为零（排空顺序所限）。档一落地后同场景复测，量化「窗口填充率」（委派在飞时长内主线完成的直接写活字节数）。
- 决策边界遵守：档一是执行池的物理并发语义（系统手脚），档三是教学（给形状），都不替模型决定「何时委派、派什么」——那是 parallelNudge + 模型自己的裁决（cc5b144 已落）。
- 本文档不覆盖档二之外的引擎重写动机；若未来出现「主线异步任务账本」的完整设计，另立文档并在此处挂链接。

## 五、落地记录（2026-11-18，档二）

- 工具层：`src/coding-agent/SubagentOrchestrator.ts`（`detach` schema 集中注入、`execute` 受理面、`startDetached` / `acceptedReceipt` / 结算队列与等待者 / 同参 sessionId 去重 / 并发上限 / `DetachedBranchPort` 实现）。
- 引擎：`src/engine/AgentLoopEngine.ts`（配平点送达、终局闸、`backgroundBranchNote`）、`src/engine/ToolExecutionCoordinator.ts`（切片 0 写结果随完成即吐；detach 时保留 abort 监听）。
- 契约：`src/shared/types.ts`（`ToolResult.deferred`、`DetachedBranchPort`、`backgroundSettle` 事件标记）。
- 宿主：`CodingAgent` / `cliHarness` 注入端口；`src/ui/toolRow.ts` + `chat.ts` 的「⏳ 后台运行中 → 已收」两态；`config.detachDelegations` 回滚面。
- 教学：`PARALLEL_FIRST_DIRECTIVE` 一句 + `MULTI_AGENT_MECHANICS` 的 Background delegation 段（收执不是产出、不轮询、不重派；下一步依赖产出时 `detach:false`）。

**崩溃恢复环（2026-11-18 续）**：进程被杀时在飞的支没有结果——后台腿活在父进程的定时器与子引擎里。不另设存档字段：受理收执的工具消息带 `deferred: true`（`Message.deferred`），送达时引擎置 false，所以最后一份 TurnCheckpoint 里「还挂着 true 的收执」就是丢了的那批。恢复时刻（GUI `loadFromStorage`、`Harness.run` 恢复分支与 `continueTurn`）由 `shared/detachedResume.ts` 就地把那条工具结果改写成 `[detached resume]` 通告：没回来、别当完成、要就同参重派（子代理断点续跑），并清掉标记。就地改写而不是另插 internal user 消息——工具结果是配对契约的一部分，且落盘走的就是这条消息（另插的消息在合并转录时会被当成回合前历史丢掉，于是每轮都会重喊）。

**批次外 trace（2026-11-18 续）**：上面第 3 条空白的落地——批级 reader 之外，THINK 期间（`withThinkActivity`，逐块排空、竞态纪律与 `runBatch` 同形）与终局等待期间（每片等待后排空）各自持一个 reader，后台支的活动不再在批次之间丢失。CLI 同时补两态：收执打 `⏳ 后台运行中`、结算打 `⤷ 后台结果已送达`（此前收执被印成 ✓、结算像同一条重跑）。

**这一环未做**：恢复后委派卡仍按存档的 `toolExec` 重建，不显「已中断」态（模型面已如实，用户面的卡还是旧两态）。

**复测口径（下一步数据）**：同一构建回合内，记录「委派在飞总时长」「该窗口内主线完成的真实工具调用数与 THINK 轮数」「收执→结果送达的间隔」三个量；档二的收益判据是前两者从「零产出」变为正向，而不是墙钟单项。

## 六、增量（2026-11-18 晚）：map-reduce 教学泛化落地

run6 现场证据（逐场馆 3D 手写几何的重循环串行研磨）催生「多场景多 3D agent」提案，经裁定**泛化落地**——不锚死 3D，按成本维度裁决：`MULTI_AGENT_MECHANICS` 的 Produce fan-out 段新增 **Map-reduce fan-out (shared-engine families)** 规则，决策维度=单实例调优循环成本 × 实例数量 × 引擎可冻结性（金标准先行）× 协调开销；含 fan-out 后的引擎缺陷出口（停 fan-out→修引擎→重金标准→再展开）与 solo 条件（实例 ≤3 / 引擎未稳 / 实例共享状态）。适用族举例：3D 场景族、图表族、多页样式系统、按平台变体、批量生成文件。commit 锚见本文提交史（promptLayers.ts Map-reduce fan-out 段）。
