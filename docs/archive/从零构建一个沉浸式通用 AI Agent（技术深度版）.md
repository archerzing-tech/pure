# 从零构建一个沉浸式通用 AI Agent

> 本文基于 pure v2.2.5（2026-09-16）的代码写成。文中引用的文件路径和常量都以这个版本为准——这类项目长得快，读的时候如果对不上，优先相信代码。

如果只允许用一句话介绍 pure，是这句 README 里的话：你所需的「获取、查看、使用」都在同一个对话里完成——文件、命令、搜索结果、图表与决策都直接出现在你当前的位置，你不必跳转到终端、浏览器或其他应用。这就是「沉浸式」的全部含义，剩下的都是工程。

先上一组数字，看看「沉浸式」三个字背后是多少东西（统计自 2026-09-16 的仓库）：

| 指标 | 数字 |
|---|---|
| 版本轨迹 | v0.6.0 → v2.2.5，**54 个 tag，跨 47 天** |
| 提交密度 | 当前可见历史 **302 个 commit**（8 天，平均每天约 38 个）※ |
| 作者 | 1 人 |
| TypeScript 源码 | 163 个文件，**58,136 行**（不含测试） |
| Rust 原生层 | 4 个文件，**16,019 行** |
| 测试代码 | 124 个文件，**1,849 个用例，25,961 行**——相当于源码的 45% |
| 内置工具 / 原生命令 | 24 个工具定义 / 76 个 `#[tauri::command]` |
| LLM 供应商预设 | 9 个（外加任意 OpenAI 兼容端点零成本接入） |
| 子代理角色 | 9 个 |

※ git 历史在 9 月初重置过一次，302 个 commit 只是最近八天的量；更早的轨迹保存在 tag 的创建日期里（v0.6.0 是 2026-07-31）。这个注脚本身也是个有趣的工程事实——仓库被重写过，tag 却完好无损。

行数本身说明不了什么，真正说明问题的是这些行里有多少**必须同时为真**的不变量：工具结果的回填顺序、压缩时的原子组、检查点的配对剪裁、权限缓存键的形状……后面四章就是把这些行拆开看。

落到架构上，会得到四个必须从零做的东西：

```
┌──────────────────────────────────────────────────┐
│  表面：桌面应用 (Tauri/WebView)   CLI (Bun)        │
├──────────────────────────────────────────────────┤
│  Layer 4  Coding Agent    编排、权限、子代理        │
│  Layer 3  Harness         有状态的会话管理          │
│  Layer 2  Event-Loop      无状态的五状态调度引擎     │
│  Layer 1  Adapter         LLM / 工具 / 存储 / MCP  │
│           Shared Kernel   类型与接口定义            │
└──────────────────────────────────────────────────┘
   Rust/Tauri IPC：OS 能力 + LLM 传输，不持有 agent 状态
```

一个循环让它动起来（第一章），一层会话管理让它记得住事、收得了场（第二章），一个工具层让模型的手长在闸门后面（第三章），一套分层 prompt 让所有行为契约有地方放（第四章）。最后一章讲这套设计换来了什么，以及一个更难的问题：47 天打了 54 个 tag 的项目，凭什么持续改进而不会越改越坏。

---

## 第一章 从 0 构建一个 Agent Loop：一个没有参照系的循环

先把一件事交代清楚：这个循环没有参考任何现成的 agent 框架。不是"参考了但不好意思说"——写这章之前我把仓库翻了一遍，设计文档、代码注释、README 里不存在 pi 或任何其他 agent 框架的名字（全库检索 "pi" 只在 `node_modules` 里捞到一个 `Math.PI`）。这个参照系根本不存在。

白纸黑字写下的灵感来源只有一个，README 第一段：**"Its Agent Loop is inspired by the Event Loop in JavaScript engines: it borrows the idea of event-driven phases that keep progressing until the work reaches a verified outcome."**

灵感来自 JS 引擎的事件循环，不是说去抄 V8 的实现。仓库里那张对比图（`docs/screenshots/event-loop-agentloop-comparison.svg`）把边界画得很清楚：JavaScript 的事件循环调度的是回调和微任务，pure 的循环调度的是**推理、工具调用、证据、验证和恢复**。借的是同一个思维方式——持续消费事件、分阶段推进、每一步都有明确的阶段名；没借的是调度器本身。README 里那句话值得原样抄在这里：

> The analogy is deliberately limited: JavaScript's runtime schedules callbacks and microtasks; Pure schedules reasoning, tools, observations, verification, and recovery. The borrowed idea is the continuously advancing, event-driven phase model — the agent-specific addition is that Pure refuses to terminate on plausibility alone.

最后半句是整个循环的灵魂：**没有证据支持，就不因为"看起来合理"而结束。**

### 1.1 先想清楚 while 循环会怎么死

剥掉所有包装，agent loop 就是一个 while 循环：调 LLM，模型要调工具就执行工具、把结果塞回消息数组，再调 LLM，直到模型不再要调工具。用 TypeScript 写个能跑的版本只要五十行。

问题是这个朴素版本有三种死法，每一种都死得很安静：

- **提前收工**。模型在多步任务的第一步之后输出一段"我已经完成了……"的漂亮总结，循环看它没再要工具，就结束了。答案听起来合理，事情没做完。
- **静默失败**。工具报错，下一轮模型换个说法再试，再错，再试。用户看到的永远是一句"正在思考下一步"，直到 token 烧完或者超时。
- **无限打转**。模型反复发起同一个注定失败的调用，或者用略微不同的关键词无限改写同一个搜索。

这三种死法对应循环里三个机制：VERIFY 与 continueGuard 管第一种，FailurePolicy 管第二种，预算与去重护栏管第三种。后面逐个说。

### 1.2 五状态机

循环的状态定义在 `src/shared/types.ts`，一行：

```ts
export type AgentStateType = 'THINK' | 'ACT' | 'OBSERVE' | 'VERIFY' | 'TERMINATE';
```

主循环在 `src/engine/AgentLoopEngine.ts` 的 `runLoop` 里，整个文件 785 行。每一轮迭代的顺序是固定的：

1. **abort 预检**——用户按了停止就直接发 `Interrupted` 收尾，不浪费一轮 LLM 往返；
2. **预算检查**——软上限只告警，硬上限还有宽限轮（后面细说）；
3. **THINK**——流式调 LLM。每个 token 增量、每段 reasoning、每个 tool call 都作为事件实时吐出去；
4. **有 toolCalls 就进 ACT**——执行工具，结果逐条作为 `ToolResult` 事件发出，然后**先回写消息数组再干任何别的事**。这个顺序是神圣的：assistant 的 toolCalls 和 tool 结果必须成对，不配对的尾巴会让下一次请求直接被 provider 打回 400；
5. **ACT 之后是 OBSERVE**——这一态没有自己的处理逻辑，它的存在是为了给 UI 一个明确的阶段语义：证据已经产生，正在被消费。随后发 `YieldControl`，回到 THINK；
6. **没有 toolCalls 就进 VERIFY**——把这一轮的证据归约成 passed / failed / incomplete。失败就带着证据回 THINK 重来；通过则再过一道 continueGuard，确认不是提前收工；
7. **TERMINATE**——循环外统一发 `Completed`，携带最终输出、轮数、完整消息历史和用量。

事件类型一共 11 种（`types.ts` 里的 `EngineEvent` 联合类型）：`TokenDelta`、`ReasoningDelta`、`StateChange`、`ToolStarted`、`ToolResult`、`YieldControl`、`FailurePolicyDecision`、`BudgetWarning`、`Error`、`Completed`、`Interrupted`。

这里有一个刻意的设计：**引擎是事件生产者，不是执行控制器**（这句是设计文档的原话）。`run()` 的返回类型是 `AsyncGenerator<EngineEvent>`，引擎只管把发生的事作为事件逐个 `yield` 出去，谁来消费、消费了做什么，它一概不知。GUI 拿同一股事件流渲染思考卡和工具卡片，CLI 拿同一股事件流打印进度行，观测层也只从这股流旁边路过——设计文档里写死了"观测是旁路能力，不能改变 Engine 的状态转移"。

每轮迭代底部都发 `YieldControl`——包括 VERIFY 通过的那一轮。这是 JS 事件循环思路最直接的落地：一个"tick"结束了，控制权交出去，外面的人有机会说话，然后下一轮才开始。代码注释里特意解释过为什么通过的那轮也不省：语义一致性比省一次事件更值钱。

还有一个不起眼但救命的性质：**终态事件保证**。`AgentLoopEngine.ts` 里有一段注释，说早先版本在异常路径上一个裸 `return` 会既不发 `Completed` 也不发 `Interrupted`，GUI 的 `finalMessages` 就永远是空的——所有消费方的清理逻辑都挂在"收到这两个事件之一"上，所以任何退出路径必须以这两个事件收尾。这类约束不写下来，三个月后一定有人改出一个不发声的 return。

### 1.3 没有证据，不许结束

VERIFY 态做两件事。

第一件是跑 verifier：把这一轮产生的证据（工具结果、命令输出、diff）归约成一个结论。verifier 调用有 60 秒的 deadline，超时就当 incomplete 处理——验证环节自己不能变成新的卡点。失败不是简单重试：引擎会把失败证据注入一条反思提示（哪里没过、差什么），带着这些回 THINK，让下一轮 THINK 是知情的。

第二件是 continueGuard：模型用纯文本收尾且 VERIFY 通过时，多问一句"真的做完了吗"。`types.ts` 里这个字段的注释写得很直白——对多步计划来说，模型报告了进度然后安静下来，**经常是提前收工**，guard 返回的指令会作为一条内部用户消息注入，把循环拽回 THINK。空输出也过不了这关：一句"什么都没说"不可接受。当然 guard 本身要有界，`MAX_GUARD_CONTINUES = 3`——弱模型配一个严格的 guard 会在"输出文本 → 被戳一下 → 再输出文本"里死锁，注释里明确写了这个坑。

真正的失败处理在 `FailurePolicy.ts`，一个升级式的阶梯：

- 同一个调用失败 1–2 次：retry，附一条轻提示；
- 3–4 次：reflect，升级成结构化反思（换方法，不是换措辞）；
- 5 次以上：degrade，启动"救援梯"——告诉模型这条路走不通，选一条替代路线，任务本身继续；
- 同一个调用还有一条独立的加速线：重复失败 2 次就 reflect 并且**禁止原样重发**，3–4 次直接"跳过它继续任务"，5 次 stop。

v0.13 补了一类漏洞：同类的失败。三个不同的 URL 连续失败，如果只盯着"完全相同的调用"，这个检测是躲过去的——所以失败分类里加了"同类错误"维度，同一个死宿主换三个网址骗不过去。每次失败都发 `FailurePolicyDecision` 事件，UI 上能看到"正在重试（连续第 N 次）"而不是一句沉默的"思考中"。到了 stop 也不是一刀切：`emitHandover` 会给模型最后一轮"禁用工具"的总结请求——完成了什么、卡在哪、下一步建议是什么——把断点体面地交还给用户。

### 1.4 循环必须有界

"agent 停不下来"和"agent 提前停"是同一个问题的两面。这套循环里的界有五层：

**预算**。`BudgetManager` 区分软上限和硬上限：软上限（轮数 / token / 时间）到了只发 `BudgetWarning` 并触发钩子，循环继续——注释原话："SOFT limits: warn once, then continue. The agent is never hard-stopped by the soft budget."硬上限命中后还留有 `graceTurns` 宽限轮。`streamDeadlineMs()` 的注释里记录了一个真实事故：软预算过后 `remaining().time` 被钳到 0，流式 deadline 变成了 1 毫秒的断头台，每一轮瞬间超时。这种注释是这个仓库的常态——bug 修完，尸体留在注释里当路标。

**流式 deadline 与自动续跑**。首 token 等 5 分钟，后续每个 chunk 之间空闲上限 2 分钟，超时不代表失败：最多自动续跑 5 次（工具调用内 2 次），续跑提示是"从上一条 assistant 消息结束的地方**精确继续**，不要重复"。这修的是"LLM 流死在三分钟"这类长输出被网络抖动腰斩的问题。

**工具层护栏**。单工具默认 180 秒上限（子代理这类可以自报更大预算，与剩余运行时间取 min）；回填进对话的工具结果截断到 40k 字符，`read_file` 超限时附一句"用 startLine/endLine 分段读"；同一轮内连续全 web 搜索超过 4 轮会触发收尾护栏——小众查询无限改写搜索词是最常见的打转方式。

**去重**。只对"紧邻"的完全相同调用去重——跨轮和同批次并行的都算，命中的复用上次结果并附一条说明；但中间执行过别的调用之后，世界已经变了，同样的调用是合法的。失败的调用**永远不去重**：失败后重试是正当的瞬态故障恢复路径。

**取消**。`AbortSignal` 在循环顶部、流式 catch、VERIFY 之前、verifier catch 四个地方检查。中断时已经流出来的纯文本会被 flush 进消息历史——注释说这是修过的 bug："被中断的回合从历史里消失了"。用户看到了半截回答，那半截就真的存在过，不能装没发生。

### 1.5 引擎无状态

最后是整个分层架构的地基：**引擎不保存任何跨轮状态**。所有可变状态——消息历史、轮数、预算快照——都在入参 `LoopInputState` 里，可选的 `stateStore` 能在关键点存检查点、从检查点续跑。引擎自己是一个纯函数式的调度器：给它消息数组和工具，它吐事件流。

顺带交代这颗心脏的体积：`src/engine/` 一共 8 个文件、约 1,545 行 TypeScript——主循环 785 行，其余七个是各司其职的小件（流式 deadline、预算、失败策略、文件锁、钩子路由、工具协调、单轮 LLM 封装）。一个通用 agent 的核心循环，比很多项目的路由层还小。

这就意味着一定有一层在它外面替它记事。那是第二章的事。

---

## 第二章 从 0 构建 Harness：给无状态的引擎一个家

Harness 的定义写在设计文档第一段：**有状态、每会话独立的会话管理层**，为上层提供会话管理、上下文压缩、持久化和 MCP 集成。如果说引擎是"一个 tick 怎么走"，Harness 管的就是"tick 与 tick 之间、会话与会话之间，所有需要被记住和被收拾的东西"。这层的体量对比很能说明问题：`src/harness/` 主体七个文件约 1,800 行 TypeScript，是引擎（1,545 行）的体量，管的却是引擎十倍数量的"万一"。

这一层最容易写歪。设计文档里记录了一次自觉的减法：早期版本设计了细粒度的版本链，每次状态变更记 diff，后来承认"Coding Agent 的核心需求是'能恢复当前会话'，而非'任意微观版本回滚'"，砍成了检查点模型——`StateManager.ts` 最终只有 49 行，保存的东西只有 label、消息数组和轮数。**会话状态只需要能恢复，不需要无限回滚**，这句话省掉了不知道多少复杂度。

### 2.1 两份历史

Harness 最基本的决定：模型上下文和界面转录是**两份历史**。GUI 的会话快照分三层——`modelContext`（真正发给模型的 `Message[]`）、`transcript`（用户看到的）、`uiState`（卡片、计划状态这些）。设计文档里写死了哪些东西不许进 canonical 消息：思考卡、工具执行卡、评估、计划状态——展示层永远无法反向污染下一次 LLM 请求。

这个分离是"沉浸式"能成立的前提：界面上可以尽情铺陈图表、卡片、进度条，而模型看到的始终是一份干净的、它该看到的对话。

### 2.2 上下文压缩：压缩的是窗口，不倒的是锚点

压缩发生在进循环之前——`Harness` 在调 `engine.run()` 之前先过 `contextEngine.trim(msgs)`，循环内部不做压缩。这个位置选择修过一个大 bug：早期压缩逻辑会把 system prompt 也压掉。

`ContextEngine.ts`（287 行）的压缩不是"砍掉最老的 N 条"，而是一条纪律：

- **tool-call 组是原子的**。assistant 带 toolCalls 的消息和它的全部 tool 结果合成一组，组内不完整的（比如中断留下的孤儿结果）整体淘汰——"孤儿 tool 结果离开它的 tool call 就没有合法的 provider 上下文"。最新的那组哪怕自己就超过窗口大小也保持完整，拆开它，下一次请求就是非法的。
- **用户消息是钉住的**。这条是 v2.2.5 刚修的回归，注释值得整段读："User messages are pinned: they carry the request itself and the attachment paths the app tells the model to read by absolute path, so aging them out of the window is how a follow-up turn loses the task anchor and goes hunting for a file it can no longer name."用户消息不占 assistant/tool 的窗口预算，只有 token 层面真的撑爆了才从最老的开始丢，且最新的永不丢。上下文压缩按 20 条窗口驱逐最老消息、把携带附件绝对路径的原始请求丢掉——这就是"后续回合找不到文件"的根因。
- **LLM 摘要只是兜底**。被逐出的消息超过阈值（40 条）才触发，60 秒超时，失败也绝不能阻止有界的近期窗口生效——只标记"摘要不可用"。摘录用户消息前还要先剥掉 `<task_context>` 包装，否则摘要器看不到附件路径那几行，又被要求"包含提到的文件路径"，就只能编一个。超长摘录按 70/30 切头尾，尾部往往正是那些路径。

GUI 侧还有个体贴的优化：每轮结束后在 idle 时后台预压缩，下次发送直接复用压缩结果，LLM 摘要永远不在发送的关键路径上。

### 2.3 检查点：三种 label，一个语义

持久化只有三个写入点：`turn_completed`、`interrupted`、`transcript`。后端是 `FSStore`，写 `~/.pure/sessions/<id>/checkpoints/`，sessionId 有白名单校验防路径穿越；CLI 可以换 SQLite。

这里有两个用真 bug 换来的细节。其一：中断检查点必须携带引擎的**实时**消息——早期存的是只在 Completed 时才更新的副本，导致 `--resume` 恢复出来的会话丢掉了在途那一轮。其二：Completed 时如果带着 `interrupted=true`，要先剪掉未配对的 toolCalls 再存——否则未剪的 `turn_completed` 检查点会遮住剪过的 `interrupted` 检查点（恢复读的是最新的那个），把本该防住的悬空 tool_use 重新武装起来。恢复逻辑本身也有历史：早期加载的消息只用于存档、没喂回引擎，"恢复运行忘了整场对话"。

### 2.4 流式渲染：两条管线，一个契约

GUI 走事件直驱：`for await (const event of events)` 逐事件渲染，流顶部有一道代际守卫（`gen !== this.generation` 就 break）——会话切换、排队任务顶掉旧回合时，旧的消费循环立即退出，绝不往新会话的转录里写东西。CLI 走 `StreamManager` 合帧：16 毫秒间隔、200 条缓冲上限，把 token 增量拼成大块输出，每个增量进缓冲前过一遍 ANSI 清洗——模型偶尔泄漏的转义序列在终端里是真实伤害（光标乱跳、颜色渗漏）。

两个表面，同一股 `EngineEvent`，不同的渲染策略，契约只有一个。

### 2.5 排队与插入：打断是常态，不是异常

任务队列（`src/ui/taskQueue.ts`，纯逻辑、无 DOM、可单测）建立在 chat 的单飞语义上：每次发送会中止上一轮，所以队列严格串行，上一个 send 落定才启动下一个。每个任务绑定 `{workspace, sessionId}`——对错误的项目自动执行排队任务，正是这个绑定要防的事。刷新后 `running` 一律降级为 `pending`："重载的队列绝不恢复半截回合"。还有个 boot-time adoption：关闭前排队但没跑的任务，重启后重绑到本次启动的会话——旧绑定永远不可能再跑了，不解绑的话"刷新恢复待办工作"就是一句空话。

用户在流式中途打字，走动态插入：先过一道硬编码的 STOP 正则（"停"就是停，不过分类器），其余送进串行分类链，五分类：unrelated / supplement / constraint-change / goal-change / stop。unrelated 的进队列回一句"已排队"，相关的中止当前回合、把插入内容折进上下文重来。这条分类链最初是并发的，早到的消息还在判断时后到的会被静默丢弃——而输入框已经被清空了，那些字就真的没了。现在这条链严格串行，分类期间回合被硬停也不丢输入。

### 2.6 停下来的每一处都要善后

Harness 的大部分代码不是在"做事"，是在**收拾做事的残局**。这一节的清单本身就是这层的职责描述：

- 会话切换：代际守卫让所有在途消费循环退出；`permissionManager.clearCache()` 丢掉旧会话的批准（epoch 机制保证跨会话悬浮的确认卡失效）；主动断开 MCP 连接——杀掉 stdio 子进程，不留孤儿。
- 回合被顶替：被 generation guard break 出去的回合不会走 Interrupted 分支，thinking 卡和工具 spinner 要单独停掉——不然界面上一堆永远的"加载中"。
- 用户停止：TS 侧 abort 传到 Rust 的取消注册表，原生多线程下载收到 oneshot 信号就保留半成品、以 cancelled 应答，不再回退 shell 下载链；`kill_command` 是唯一的 kill 入口。
- 中断抢救：以 DOM 上已经流出的可见文本为准，把用户**真正看到过**的半截回答存回历史。

### 2.7 记忆：会进化，但不会无限膨胀

Harness 还管跨会话记忆，原则写在 README 里：**用会进化但不会无限膨胀的记忆延续经验**。

检索端：语义搜索和 1500 毫秒超时竞速——嵌入模型的首次加载（WASM + 约 80MB）绝不许挡住第一个 LLM token，超时就退化为纯 system prompt。工具偏好按平台过滤，"在这台机器上好用"的教训不许泄漏到别的操作系统。

写入端讲究时机和资格。降级决策发生的那一刻就写 error_pattern——"这一课必须比会话活得久"；"勿重试"类的记忆反而延迟到会话结束才写，且带瞬态故障豁免：重试第三次成功的那种，记成"重试后恢复"，不记成"别用这个"。晋升有门槛：只有带真实验证证据的会话教训才能晋升为 procedure——无验证的结果不得污染长期策略记忆。膨胀控制靠 14 天半衰的衰减分，每小时最多扫一次（每轮都扫是毫无必要的 I/O）。

模型自己也能主动记：最终输出里写 `[remember] ...`，工具相关的进机器全局偏好，其余进成功模式。

### 2.8 MCP 也住在这一层

`src/harness/mcp/MCPClient.ts` 自己就实现了 `ToolAdapter` 接口——MCP 工具和内置工具在类型系统层面就是同一物种。连接用 `Promise.allSettled` 容忍单个 server 失败；重连先关旧传输、注销旧工具；`excludedPrefixes` 可以整段隐藏第三方工具，防止一个话痨 server 挤占内置工具的选择空间——server 保持连接，只是它的某些工具对模型不可见。WebView 里没有 `child_process`，stdio 传输走 Rust 子进程注册表，代理密码从 Rust secrets 解析，不经过前端。执行前还有一道 `parseToolArguments`，修复模型吐出的"差一点点的 JSON"（尾逗号、单引号、没引号的 key、带着代码围栏的）。

---

## 第三章 从 0 构建一个工具层：模型的手要长在闸门后面

工具层要回答的问题只有一个：模型说"我要调工具 X"，从这句话到真实世界被改变之间，要经过哪些闸门？

### 3.1 最小形状

核心类型只有四个（`src/shared/types.ts`）：

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  index: number;
  function: { name: string; arguments: string }; // arguments 是 JSON 字符串
}

export interface ToolResult {
  id: string; toolName: string;
  result?: unknown; error?: string;
  success: boolean; duration: number;
}

export interface ToolAdapter {
  execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
  getMetadata(toolName): { sideEffects?; isWrite?; timeoutMs? } | undefined;
  getTools(): ToolDefinition[];
}
```

刻意不用 zod：这个 schema 不是给运行时校验用的，是**原样进模型上下文**的——它本身就是提示词的一部分。手写 JSON Schema 让"模型看到什么"和"实际执行什么"的关系一目了然，也让 shared kernel 少一个依赖。

### 3.2 单一事实源

24 个内置工具的 schema 全部集中在一个数组里：`src/shared/toolDefs.ts` 的 `BUILT_IN_TOOL_DEFS`。CLI 的 `NodeToolAdapter`、GUI 的 `TauriToolAdapter`、权限层 `ToolRegistry` 都从这一个数组派生——文件头注释一句话说明动机："schemas the model sees never drift from what actually executes"，模型看到的和实际执行的永不漂移。

24 个工具按职能分五组：**文件系统**（read/write/edit/search/find/list/glob/diff/replace/create_directory，读文件支持 PDF、DOCX、表格和 GBK 编码）、**执行**（execute_command，支持 background 模式返回 pid 和日志文件）、**研究**（web 搜索/抓取/公共 API、代码搜索）、**环境**（sys_info——时区语言网络这些环境事实，"never guess from your training data"）、**产出**（create_document 直接生成真实的 .pptx/.docx/.xlsx 二进制）。另有条件注册的 `generate_image`（仅当 provider 支持）、四个动态能力工具（搜技能/装技能/搜 MCP/连 MCP）和一组子代理工具。

还有个小机制：`search_files`、`web_search`、`web_fetch` 三个老工具还在数组里、执行上完全兼容，但不在 `PUBLIC_TOOL_NAMES` 白名单里——被更新的工具取代后**从模型的工具列表里隐藏**，旧会话回放却不会坏。工具的退役也可以是不动声色的。

### 3.3 执行管线：五道闸门

一次 tool call 从 THINK 态吐出来到结果回填，依次经过：

1. **去重**——和上一轮或同批次紧邻相同的调用复用结果，不碰真实世界（写工具也去重：原样重写一份相同内容是 no-op）。失败的调用永远真实重跑，绝不伪造复用。
2. **调度**——`ToolExecutionCoordinator` 按元数据分流：读操作 `Promise.all` 并行，写操作 `for...of await` 串行。每个调用前按 `args.path` 拿 `FileLockManager` 的读写锁，写偏好、FIFO 唤醒——"一旦有写者排队，后来的读者排在它后面"是防止写者饿死的关键。
3. **权限门**——下一节单说。
4. **tag 路由**——`Tags.AGENT` 走子代理执行器，`Tags.MCP` 走 MCP 客户端，其余进底层 adapter。子代理不能再生成子代理：嵌套委派从工具列表层面就不暴露。
5. **回填**——结果截断到 40k 字符，按**原始调用顺序**以 `role:'tool'` 消息推回消息数组。顺序对齐是给 UI 卡片对位用的，乱序的后果用户看得见。

### 3.4 权限：闸门本身要经得住模型的博弈

四种模式一句话说完：YOLO 全放行，NORMAL 按风险问，PLAN 只读，DONT_ASK 读放行写静默拒绝。风险分级里 `execute_command` 是唯一的 high，write/edit/replace/download 这类是 medium，纯读是 low（自动放行）。

`PermissionManager` 里有三处值得抄的细节：

- **会话缓存键故意不含参数**：`${serverName}:${tool}`。注释解释：模型重发"相同"调用时 JSON 细节总在变（key 顺序、可选字段），按参数哈希会导致"点了始终允许还是会问"。只有用户显式选"始终允许"才写缓存。
- **同批次并发去重**：同一批并行调用里同一个工具请求两次，共享一个 in-flight Promise、一张确认卡，不叠两层。
- **epoch 守卫**：清理缓存时递增 epoch，跨会话切换还悬着的确认卡落地时发现 epoch 变了，批准作废——旧会话的授权不能播种进新会话。

GUI 确认卡上写操作有内容预览（write_file 截 4000 字、edit_file 生成 -old/+new 摘要），高风险默认焦点在 Deny、Esc 就是拒绝。权限弹窗是第一道控制，但不是最后一道：macOS 上 YOLO 模式的 `execute_command` 外面还套着 Seatbelt 沙箱——写限定 workspace 加 tmp、网络仅出站，内核级兜底。顺带一提 Rust 侧 `path_policy` 的哲学："workspace 不是囚笼"——只做词法规范化和拒绝 `..` 穿越、悬空 symlink，绝对路径允许指向磁盘任意处。沙箱防的是逃逸，不是圈养。

### 3.5 双执行端，一套 schema

同样的 24 个工具，两套执行端：CLI 的 `NodeToolAdapter` 纯 TypeScript，`node:fs` 和 `node:child_process` 直接实现；GUI 的 `TauriToolAdapter` 每个工具一个 `invoke()`，真实 IO、shell 子进程（Windows 走 PowerShell -EncodedCommand）、流式输出 Channel、断点续传下载都在 Rust 侧——`src-tauri` 四个文件 16,019 行 Rust，其中 `lib.rs` 一个文件就占去约 15,700 行，76 个 `#[tauri::command]` 里大半是工具实现。schema 两端共享同一个 `toolDefs.ts`，分工原则一句话：**TS 管决策，Rust 管手和脚**。

### 3.6 加一个新工具要动几处

四处，其中两处是编译期强制的：

1. `toolDefs.ts` 加 schema（要公开就进 `PUBLIC_TOOL_NAMES`）；
2. `ToolRegistry` 的 `TOOL_TAGS` 加权限注解——类型是 `Record<BuiltinToolName, …>`，**漏加即编译错误**。注释原话："adding a tool there without a permission mapping here is a compile error, so a new tool can never silently run un-gated"——新工具不可能在无门控状态下静默运行；
3. `TOOL_METADATA_TABLE` 加副作用标注——同样 `satisfies` 全量键约束，漏加 typecheck 失败；
4. 执行端加一个 case（CLI 纯 TS，GUI 通常再配一个 Rust command）。

不想动代码的扩展路径也齐了：MCP 运行时注册、子代理注册、动态能力工具、条件注册的 `generate_image`。工具层的扩展性不是靠插件系统堆出来的，是靠"类型系统当闸门清单"省出来的。

---

## 第四章 从 0 构建分层 Prompt：提示词是编译出来的，不是拼出来的

这一章从一段忏悔开始。`system-prompt.md` 里写着早期版本的三宗罪：

> 早期把 trap 警告 / artifact 协议 / 计划全部 `systemPrompt +=` 进 system 消息，导致 ① system 消息在长会话中膨胀、每轮重复计费；② 每请求指令与身份规则混在一起、注意力被稀释；③ GUI 与 CLI 各维护一份重复行为契约，容易漂移。

分层就是对着这三宗罪设计的。

### 4.1 三层与归属判定

`src/shared/promptLayers.ts` 的文件头注释定义了全部三层：

- **L0 System**：身份、全局操作原则、权限模式、运行时契约、响应格式。"immutable core — changes only when the product's contract changes"。运行时唯一来源是 `SYSTEM_CORE_PROMPT` 常量，`system-prompt.md` 是它的人读镜像，注释要求保持同步。
- **L1 Application**：工具规则、工作流与交付契约、多代理协议、输出风格、逻辑陷阱、合理性审查、环境上下文、已装技能——"per-session / per-run behavior"。
- **L2 User**：本次请求的陷阱警告、已批准计划、澄清回答——**组装进用户消息**，永不进 system prompt。

归属判定就三条：产品契约变了才变 → L0；依赖应用状态但不依赖本次请求 → L1；依赖这一次请求 → L2。

L2 进用户消息的理由写在 `promptLayers.ts` 里：模型对最近的上下文注意力最强，而稳定的 system 消息让长会话**不必为每次请求的碎片重复付费**。L0 刻意精简的理由更直接："这里的每个 token 在每个会话的每一轮都要付钱，所以只放与工作区、工具、请求都无关的事实。"详细的流程规则（诊断、验证、经验教训）被**故意**下沉到 L1——L0 只留不容复述的身份、安全和输出契约，不重复 L1 已有的内容。

### 4.2 组装器：一处编译，两个表面

运行时的统一入口是 `src/shared/PromptAssembler.ts`：`buildSystemFragments()` 列出全部 30 多个片段及优先级——静态的身份与工作流契约、动态的环境与能力探测，外加 L2 的任务级片段，每片一个优先级数字；`assemble()` 一次产出 systemPrompt、userPrompt、预算报告和 traceId。GUI 和 CLI 调用的是同一个组装器——注释写明目的："compiled by the shared PromptAssembler for GUI, CLI, and Harness so the surfaces do not drift"，两个表面不漂移。还有专门的测试断言"GUI 和 CLI 编译出相同的探测与构建上下文"。

片段分两类。静态的：身份、工作不变量（"Work step by step. Read before you write. Verify after you change. Be concise."）、工作流、交付契约、语气……动态注入的：当前模型身份、GUI/CLI 能力差异、环境、运行时版本、网络可达性、shell、技能、项目约定。

动态注入里有个反直觉的决定：**时间不进 system prompt**。`chat.ts` 的注释："Time/timezone intentionally stay OUT (they go stale immediately — the model calls sys_info() for those); only the location + answer language are stable enough to pre-seed."一切立即过期的信息都不预置——模型有 `sys_info` 工具，想问自己问。运行时和网络探测每会话只做一次并缓存，不做每轮探测。

拼接是确定性的：按片段声明顺序 `join('\n\n')`，与优先级无关（优先级只管预算裁剪），所以同一会话内 system prompt **字节级稳定**——观测层靠系统消息的哈希做关联比对，输入变了哈希一定变。

### 4.3 预算：优先级装包

prompt 也有预算管理：`可用输入 = 上下文窗口 − 输出预留 − 安全边际`，工具 schema 的 token 单独估算并计入同一窗口。超预算时 required 片段全保留，optional 按优先级降序装包，装不下的输出一行诊断：`[prompt-budget] estimated=… omitted=…`——裁了什么，明说。

优先级表本身值得看两眼，最高和最低的两端都有故事。`project_conventions`（AGENTS.md 合并结果）是 250，全表最高，pinned required——项目约定永远可见。`human_tone` 是 108、required，注释讲了一段历史："Tone is REQUIRED: it is the persona of the product, not decoration — it used to be priority 35, optional, and was silently dropped first under budget pressure on small-context models."语气曾是可选的 35 档，在小上下文模型上第一个被预算压力静默裁掉——产品的人格没了。现在它低于 `delivery_contract`（112）是有意的：证据纪律和语气冲突时，证据赢。`skills` 是 30，预算紧张时最先裁的可选项。

### 4.4 语气是工程品，不是装修

pure 的语气要求是"资深结对工程师"：直接、有温度、务实——先给答案，说真实想法，让对话像人话。这套语气在 `HUMAN_TONE_PROMPT` 里的写法有个讲究：**只写原则，不写例句**。头部注释解释了为什么——被引用的"好例句"会被模型原样回收，变成下一代的套话。所以禁令是结构性的：不许用固定开场白（"好的，以下是""我来分析一下"）、不许用固定收尾客套（"希望对你有帮助"）、不许用"首先/其次/最后/总之"搭脚手架，也**不许发明新的仪式句来替代被禁的**。交付要像同事递回键盘：几行自然的句子，不是更新日志式的清单。

有一个例外被明文豁免：**计划/阶段控制行**。UI 协议需要 `## 计划 n：<阶段名称>`、`### 子步骤 k 已完成` 这类机器可读的进度标记（`plan.ts` 里的 `PLAN_STAGE_PROTOCOL`），规则是"these are for the interface, not for the user: emit them exactly as specified, and keep every sentence you write around them natural"——控制行照原样发（界面上它们会被折叠掉，用户根本读不到），控制行周围的句子保持自然。界面的归界面，人话的归人话。

### 4.5 约定、技能与门控注入

AGENTS.md 有三层：应用级（随应用发行）、用户级（`~/.pure/AGENTS.md`，首启从应用默认播种）、工作区级。合并语义写成文了：**同一个标题（同一条约束）用户级覆盖应用级**，单侧独有的继承——`splitSections` 按标题切节再合并，优先级 workspace > 用户 > 应用。合并结果作为 pinned required 片段包进 `<project_conventions>`。

技能有三个来源（Skill Hub 安装的、用户目录的、项目 `.agents/skills/` 的），统一包成 `<skill name="…">正文</skill>` 注入，TTL 缓存保证会话中装的技能 30 秒内可见。多代理协议是门控注入的样本：只有子代理工具真实存在才注入，注释说得很清楚——纯问答或无工作区的回合没有子代理工具，就不该被告知去委派。**提示词许诺的能力必须与工具列表对账**。

### 4.6 提示词也有回归测试

观测层只记哈希、长度和结构化元数据，不存原文，JSONL 落盘要显式开启。测试里有一个专门断言：系统提示词的每个章节标题**恰好出现一次**——注释说这是一个历史上的拼接 bug 把 "Output style:" 复制了一份之后加的。提示词在这个项目里不是文案，是和代码同级别的、有测试守护的契约。

---

## 第五章 总结：这套设计换来了什么

把四章收拢，回头看这套架构买到的东西：

**执行是状态机，经验是记忆库。** 这是 README 里明确的取舍。循环的五种状态、失败的四阶升级、预算的两级 semantics，让"跑任务"这件事可观测、可中断、可恢复；记忆的准入门槛（无验证不晋升）和衰减机制（14 天半衰）让"学到的经验"不会变质成包袱。

**两个表面，一套大脑。** GUI 和 CLI 共享同一个 PromptAssembler、同一个 requestWorkflow、同一个默认装配工厂（`createDefaultHarnessConfig`，注释就一句："one factory, no drift between the two entrypoints"）。功能做一遍，测试写一遍，两个表面一致是结构保证的，不是靠自觉。

**供应商是配置，不是代码。** `LLMAdapter` 接口只有 `stream()` 和 `complete()` 两个方法；内置 9 个 provider 预设（DeepSeek、Qwen、GLM、Moonshot、MiniMax、OpenAI、OpenRouter、NVIDIA、Ollama）；v2.1.0 引入 wire protocol 维度（openai / anthropic / auto，按 URL 自动检测）之后，兼容 OpenAI 协议的供应商——Ollama、LM Studio、vLLM——接入成本是一条预设，零新代码。新协议才需要一个 adapter 类。

**克制本身是特性。** 引擎 785 行，`StateManager` 49 行，`StreamManager` 63 行，`LLMAdapter` 两个方法。每一处"少"都是一次有记录的减法：版本链砍成检查点、GUI 专用的 StreamManager 不进 GUI、CLI 刻意不跑同步 LLM 复核（"复核往返让 CLI 卡在 verifying…，失败的裁决还会重写刚打印的答案"）。

**可复现的评测基线。** `evals/` 里三个确定性 fixture（bugfix / feature / refactor 各一），跑在隔离临时工作区的真实 Bun 验证命令上，每次发布前当作回归门。评分信条写在 README 第一屏："The evaluator never trusts the model's text as a pass signal"——模型自己说做完了不算数，验证命令说了才算。无 agent 的对照运行应该得 0/3，这是 fixture 本身的体检。

---

## 第六章 为什么持续改进不会越改越坏

先把这个问题的本质说破。**"越改越坏"就是回归**：改动 A 无意识地破坏了行为 B，而 B 没有任何代言人，等用户发现时已经坏了很久。防止它靠的不是"改的时候小心一点"——那是人治，看看这个项目的节奏：47 天 54 个 tag，最近八天的可见历史里 302 个 commit、平均每天 38 个左右，出自一位作者之手。这个节奏下人治必输，靠的是**结构**：让每一个正确的行为都有一个名字，名字后面站着执法者。

这个仓库里的执法者有五层，从快到慢：

### 6.1 编译期：漏标即编译错误

第三章讲过，`TOOL_TAGS` 和 `TOOL_METADATA_TABLE` 都是 `Record<BuiltinToolName, …>` 加 `satisfies` 全量键约束：加一个工具而忘了配权限注解或副作用标注，typecheck 直接失败。新工具**不可能**在无门控状态下静默上线——这条安全性质不需要任何人记得，类型系统替所有人记着。typecheck 是 CI 第一道门。

### 6.2 测试期：测行为契约，不测实现细节

截至 v2.2.5，仓库有 124 个测试文件、1849 个用例、约 2.6 万行测试代码。关键是测的东西：随便抽几个名字感受一下——

- `preserves tool_call atomic pairs`（压缩不拆散 tool-call 组）
- `trims assistant/tool chatter to maxMessages while pinning user messages`（v2.2.5 那个修复的回归测试）
- `passes proxy settings and provider identity to Rust without sending the API key`
- `compiles the same probe and build context for GUI and CLI callers`
- `rejects guarded Git mutations without delegating to the shell`

每个测试名都是一条**行为契约**。实现可以推倒重来，契约不破测试就不破；反过来谁改坏了契约，测试名就是 bug 报告。此外还有镜像测试的纪律：`FSStore` 的 18 个测试镜像 `SQLiteStore` 的测试集再加文件系统损坏恢复——同一个接口的两个实现互为对方的正确性对照。有真实浏览器参与的场景（计划卡恢复、评审门禁）用无头 Chromium 的 `verify:*` 脚本盖一遍，连"已删除的浮动大纲不许再出现"都断言到了。

### 6.3 评测期：模型不许自证清白

测试盖得住确定性逻辑，盖不住"模型变笨了/提示词改坏了"。evals 体系就是给这类回归准备的：三个 fixture、真实验证命令、`--strict` 非零退出码，跑在 CI 之外但卡在发布之前。prompt observability 记录每次运行 prompt 版本的哈希、用量和成本——提示词改动造成的能力退化，可以定位到"哪个版本开始"。

### 6.4 文化的层面：每个修复都要留下化石

这是最难学也最值钱的一条。看三个例子：

- **1 毫秒断头台**。软预算过后剩余时间钳到 0、每轮秒超时。修复之后，`streamDeadlineMs()` 的注释里完整记录了这个事故。下一个改预算逻辑的人会撞见这块化石。
- **被裁掉的语气**。tone 从 optional 35 档改成 required 108 档，动机写在优先级注释里。下一个想"省点 token"的人会先读到产品人格被静默裁掉的前科。
- **消失的中断回合**。interrupted 检查点改存引擎实时消息，P1-9 的编号和"为什么"都留在注释里。

共同点：**修复不是改完就完，而是把教训物化成三样东西——一条写给未来读者的注释、一个以行为命名的回归测试、（值得的话）一条带根因的 changelog**。看 v2.2.5 的 changelog：先写根因（压缩按 20 条窗口驱逐最老消息、丢掉带附件路径的原始请求），再写修复规则，再写边界情况（只有用户消息自身撑爆 token 才最老优先淘汰、最新一条永不丢），最后一句"新增回归测试覆盖"。

教训一旦物化，就不再依赖任何人的记忆。团队可以换人、上下文可以被压缩、半年后改这段代码的人可以是谁都行——注释会说话，测试会咬人，类型会拦路。

### 6.5 结构的层面：爆炸半径被依赖方向锁死

最后兜底的是分层本身，规则在 `pure Spec.md` 里是成文的：

```
Coding Agent      depends on Harness + Engine + Adapter
Harness           depends on Engine + Adapter     （有状态，按会话，检查点式）
Agent-Event-Loop  纯 TS，零依赖                    （无状态）
Adapter Layer     LLM / 工具 / 存储 / MCP          （所有 I/O）
Shared Kernel     类型、接口定义
```

依赖只许向下。引擎层被验证过真的零运行时依赖（`src/engine/` 的全部 import 只有测试框架）——它是纯函数，改它的影响一目了然；adapter 注入而非单例，任何一层都能用 mock 独立测试；跨层契约（tool-call 组原子保留、模型上下文与转录分离）白纸黑字。Rust 不持有 Harness——agent 核心全部跑在 TS 里，Rust 只提供 OS 能力和传输，这条边界是早期草稿自相矛盾之后专门用一版 Spec 钉死的。

爆炸半径因此是可计算的：改一个 provider 的流式解析，半径是这个 adapter 类；改压缩策略，半径是 `ContextEngine.ts` 加它那几个测试；改提示词，半径是一个 fragment 加优先级表。**大部分改动根本没有机会触碰到另一层的正确性**——这才是"持续"二字的地基。

还有一条成文的不变量清单压底："权限、路径边界、破坏性操作确认、预算和验证证据仍是程序级不变量"——自适应策略、跨会话记忆、提示词的进化，都不许绕过或降低它们。会进化的东西（策略、记忆、语气）和不许进化的东西（安全与正确性的底线）在架构上就分了家。

### 6.6 收束

回到最初的问题：为什么这个项目可以持续改进，而不会越改越坏？

因为每一次"变好"都被钉死成了三样东西：**一个测试名，一条注释，一道编译错误**。测试名让正确行为有代言人，注释让事故有化石，类型约束让结构性错误活不过 CI。在这个结构里，改坏一件事需要的不是一次疏忽，而是同时穿过五层执法者——而每一层的通过都会留下痕迹。

CHANGELOG 里那 54 个 tag，一半以上是"修复"而不是"新增"。一个 47 天的项目把大多数版本花在修自己和防自己再坏上，这不叫慢，这叫**改进在复利**。

---

*本系列到此为一个完整的闭环：循环、会话、工具、提示词，以及让它们可以一直改下去的机制。文中所有引用出自仓库内文档与代码注释原文，版本 v2.2.5。*
