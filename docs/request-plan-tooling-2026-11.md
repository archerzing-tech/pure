# request_plan 工具化设计（决策边界刀 2，2026-11-07）

> 出处：回合预判层退役（c248e42 / v4.3.2）挂账刀 2。铁律：新机制只准答
> 「怎么做成」，不准答「何时做」——何时规划归模型，机制只配手脚。

## 目标态

主引擎首回合给模型一个 `request_plan` 工具。模型自己判断这轮复杂不复杂、
方向未不未定、要不要当着用户先想一遍——想规划就流内调用；宿主桥接既有
planByThinking 编排（流式思考 + 步骤卡 + 插话吸收窗），规划产物回填工具
结果，引擎按卡继续。宿主不再拿形态判据（长文 / 代码块 / 工程创作）替模
型决定「这轮要规划」。

## 判据分界（退役面）

| 判据 | 现状（抬 wantsPlan） | 目标态 |
| --- | --- | --- |
| forcedMode = plan/build | 抬 wantsPlan + 确认对话 | **保留机械**（用户显式意图） |
| continuingPlan / planPauseRequested | 抬 wantsPlan | **保留机械**（已批准流程的接续） |
| riskReview（requiresConfirmation 毁灭性词表） | 抬 wantsPlan | **保留机械**（安全闸只升不降） |
| shape.codeShaped / longForm / buildShaped | 抬 requiresPlanReview | **退役** → 模型自决 |
| complexity complex && plan（词表认复杂） | 抬 requiresPlanReview | **退役** → 模型自决 |
| needsDeliveryGate 单独抬 wantsPlan | 无 plan 也强制走思考 | **退役这条耦合**——交付闸本体（探针 / 落盘协议 / 收尾闸）保留机械，但不再强制「先想一遍」 |

`compileRequestWorkflow.requiresPlanReview` 的抬升源同步收窄为机械事实三
族（continuingPlan / planPauseRequested / requiresConfirmation / forcedMode）；
`chat.ts` 的 wantsPlan、shouldRunTaskAnalysis 总闸、死代码
shouldEnterPlanReview（仅测试消费）一并收窄 / 退役。turnShape 本身保留
——它还服务 needsDeliveryGate / buildRequested / buildProtocol（交付闸
与落盘协议是流程手脚，不随规划自决退役）。

## 机械结构（全部有先例）

1. **REQUEST_PLAN_TOOL_DEF**：条件在场——首回合 && !continuingPlan &&
   !planPauseRequested && !forcedMode && planBridge 在场。装配点 =
   CodingAgent.modelToolsDefs（stop_branch 的 branchControlToolDefs 同款）。
   description 只写手脚不写决策规则：「调用后宿主会当着用户展开一轮规划
   （流式思考 + 步骤卡），结果回来后按卡执行」。
2. **按名转发**：ToolRegistry.execute 顶部、known 名单检查之前转发桥回调
   （stop_branch 同款：天然不进公共/委派 defs，不占权限面）。
3. **桥缝**：CodingAgent.config 增 planBridge?: (input) =>
   Promise<PlanBridgeResult>；ChatController 构造 CodingAgent 时注入
   （闭包捕获 userText / chatEl / needsDeliveryGate / workOrderRegister）。
   CLI 不注入桥 → 工具不在场，CLI 维持现状（CLI 规划另立刀）。
4. **执行器内 await**（排序保证选 a 路线）：规划全链（openPreflightWindow
   → planByThinking 循环 → closePreflightWindow → 出卡 → 批准语义）在工具
   执行器里跑完，结果文本 = formatPlanForPrompt 输出（approved 语义）+ 叙
   事概要，回填后下一 THINK 模型直接带着计划语境开工。同批并行工具受牵连
   可接受（模型不会在需要规划结果时同批发其他写工具）。
5. **自有 timeoutMs**：规划自身上限 180s + 出卡/批准等待，工具声明比
   TOOL_EXECUTION_TIMEOUT_MS 更长的独立上限（AGENT 委派工具同款先例）。
6. **失败兜底**：规划没落地（thought=null / abort）→ 工具结果仍是
   success，文本「规划没有落地，按你的判断直接推进」——模型自决兜底，
   不计 tool_error 失败账。

## 行为变化（真机可感知）

- 「帮我创建一个项目」类工程创作不再宿主强制走规划——模型不调工具就直
  接开干（交付闸 / 落盘协议 / 收尾闸仍在，只是没有先导思考卡）。GLM 的
  自决率待真机复验；这是本刀的验收主判据。
- 规划押账时序反而更顺：规划发生在引擎轮内，叙述天然排在用户请求之后，
  pendingPlanNarration 三消费点契约不变。

## 顺手核清（调研发现的两笔）

1. **暂停轮 narration 疑似不入账**：pendingPlanNarration 只在
   4561/7791/8002 消费，暂停分支（6527-6586）不消费、下一 send 开头作废
   ——暂停轮思考叙述只活在 DOM。确认后单独小刀修。
2. **effectiveIntent 注释失真**：5725 之后恒为词表 assessIntent（LLM 合
   并层已随路由退役消失），5672-5674/5766 注释还在描述已删行为——本刀
   顺手修注释。
3. repaired 计划注入契约（Planner.ts:677-679 明言不得回注，approvePlan
   却原样注入）：超出本刀范围，挂账观察。

## 测试锁

- chat.test.ts 三处源码字符串断言重写（planByThinking 调用形态 / 出卡前
  必须有思考 / 思考窗吸收三件套）。
- 新锚：工具条件在场矩阵（首回合/续跑/forcedMode/无桥）、按名转发、桥
  回调入参、结果回填形态、退役判据消失（requiresPlanReview 只剩机械源）。

## 验收

1. tsc + bun test 全量双门禁。
2. 真机：工程创作句（「做个小游戏」）观察 GLM 是否调 request_plan；不调
   也不算红（无卡直接干是合法路径），连失手（复杂工程直接乱干）才算。

## 后续刀（2026-11-17）：规划先读真实代码

原设计里 `planByThinking` 是一次**不带工具**的孤立调用（`llm.stream(request, [], …)`），
计划里的路径与命令只能靠措辞联想，而 `planThinkingContext` 又要求模型「不要另起炉灶
重新规划」——读到真实代码后假设不成立，只能在旧框架里打补丁。补两件机制：

- **出卡前采证据**：`gatherPlanEvidence` 机械读一遍工作区（`list_files` 递归目录、
  请求点名文件的真实头部、`package.json` 的 scripts），拼进规划提示词的
  `<workspace_evidence>` 并附「以证据为准、不许编路径/命令」的判据。采集失败
  （无工作区/fs 工具关闭/读取报错）时提示词明说「没有证据」，而不是留白。
- **解析时核对路径**：`parsePlanJsonWithMeta(text, register, { pathExists })` 把步骤、
  子步、验证命令里的路径与同一份快照对一遍，没找到的进 `Plan.unresolvedPaths`，随
  执行语境与 `request_plan` 的工具结果交回模型。快照被截断时不做核对——少扫到 ≠
  不存在。Windows 的 `list_files` 回反斜杠，快照先归一化再比对。

核对只交事实、不改计划：新建目标本来就不存在，是新建还是写错由模型裁决。宿主不替
模型决定「这步该不该做」，只保证它决定时眼前有真实代码。
