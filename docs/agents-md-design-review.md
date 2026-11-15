# AGENTS.md 设计评审：Claude Code / opencode 2.x / pure 对照

> 状态：评审结论（2026-11-15）；对照基线 Claude Code 2.1.299、opencode V2（2.0.30 前后文档口径）、pure 4.8.3
> 范围：指令文件的**加载机制**与**内容职责**两条线，不评各产品的工具层与模型接入
> 方法：pure 侧读代码（`src/shared/conventions.ts`、`src/shared/PromptAssembler.ts`、`src/cliRepl.ts`、`src-tauri/tauri.conf.json`）；另两家按官方文档与第三方对照页整理的二手口径，逐条可回查但不保证版本不变
> 结论：pure 的合并语义（整节覆盖）是三家唯一确定性的，但文件定位混了「产品默认」与「本仓库开发约定」，且缺项目事实层——P0 拆分已落地（见文末「落地记录」）

## 一、三家怎么放这个文件

| | Claude Code | opencode 2.x | pure |
|---|---|---|---|
| 认什么文件名 | `CLAUDE.md` / `.claude/CLAUDE.md` / `CLAUDE.local.md` + `.claude/rules/*.md`；2.1.277 起在**没有** CLAUDE.md 时才回退读 `AGENTS.md` | 只认 `AGENTS.md`（V2 已删 CLAUDE.md 回退）；2.0.30+ 额外支持 `instructions` 数组（可写 glob / HTTP(S) URL） | `AGENTS.md`，同层无 AGENTS.md 时回退 `CLAUDE.md`（同层不双读） |
| 作用域 | managed → user → 工作目录向上至 `/`；子目录文件在首次读写该目录时加载；`.claude/rules/*.md` 用 frontmatter `paths:` 做**路径作用域** | 全局 + 从 workspace 向 home 逐级上溯（home 外止于项目根）+ 读文件时加载下层目录 | app 默认 → `~/.pure/AGENTS.md` → workspace 根；**只读根**，无嵌套、无 glob、无 import |
| 冲突怎么解 | 全部拼接，不解决；文档明说「两条冲突时可能任选其一」 | 全部拼接，**不解决**，把责任交回作者（"put the rule where it belongs"） | 按标题分节，**子层整节覆盖父层** |
| 注入位置 | 作为 user message 跟在 system prompt 之后 | 拼进 system 槽 | user turn 的 `<project_conventions>`（`conventions.ts` + `envFacts`），system 前缀保持稳定 |
| 文件职责 | 项目记忆：构建命令、架构、约定、验证要求；明说「指导不是强制」，硬规则交给 hooks / permissions | 同 Claude 但更薄：build / architecture / conventions / verification 四条 | 可执行策略：多 agent 决策树、角色表、编排模式、交付格式、确认门限、提交约定 |
| 治理工具 | `/init` 生成、`/context` 看加载了什么、`claudeMdExcludes` 排除、`/doctor prompt-audit`、超长文件裁剪 | `OPENCODE_DISABLE_PROJECT_CONFIG`、`opencode debug paths config`、编辑后自动重载 | `agents:sync` 把根文件 base64 折成内置默认 + parity 测试。无 `/init`、无「加载了什么」视图、无预算 |

三种设计逻辑各一句话：

- **Claude**：文件是「项目知识库」，靠分层路由 + 按需加载把 token 花在该花的地方。
- **opencode**：文件是「分布式所有权」，不解决冲突是为了不假装能解决。
- **pure**：文件是「产品策略的可编辑副本」，既有决策规则又有覆盖语义——这是优点与病灶的共同来源。

## 二、pure 做对的地方

1. **唯一有确定性覆盖语义**。整节替换，比 opencode 的「不解决」和 Claude 的「任选其一」更可预测；多来源配置必须有优先级。
2. **唯一开箱即可用**。首次运行 seed `~/.pure/AGENTS.md`，新用户不改文件就有完整行为基线。另两家默认为空，只能 `/init` 生成骨架。
3. **内容是决策规则，不是事实清单**。负向门（小任务自己干）+ 成本上限（并发、回炉轮次）+ 交付格式（结论/证据/未决问题），可被检验。
4. **同层 AGENTS 优先、CLAUDE 兜底**，比 opencode V2 的硬切平滑，比 Claude 的「无 CLAUDE.md 才回退」更对称。
5. **注入点选得对**。放 user turn，切项目或改 conventions 不击穿 system 缓存。

## 三、硬伤（按严重度）

1. **一个文件两个身份**。根 `AGENTS.md` 既是 pure 仓库的开发约定，又被 `scripts/sync-default-agents-md.ts` 折成 `defaultAgentsMd.ts` 发给每个用户；`src-tauri/AGENTS.md` 还是第三份拷贝。仓库自身规则（如提交信息约定）因此泄漏成所有用户的全局默认，而用户整节覆盖又会静默吃掉产品基线。
2. **默认只 seed 一次，永不更新**。`ensureAgentsMdAt` 只补缺不覆盖，默认策略的后续改进到不了存量用户；没有版本标记与迁移。
3. **缺项目事实层**。全文没有 typecheck / test / lint / build，没有架构地图——对 coding agent 这是回报最高的一节（Claude / opencode 文档的第一性内容正是这些）。
4. **产品策略混进用户可编辑文件**。多 agent 触发测试已在 `task_planner` 工具描述，机制在 `MULTI_AGENT_MECHANICS_PROMPT`，回报格式在 spawn 时的 `subagentReportNote`。三处并存 = 双份 token + 双份维护 + 用户删掉即静默降质。
5. **覆盖粒度太粗**。想在某一节加一条必须整节重抄（复制漂移）；父层意图被整节丢弃，而 loader 不报告「哪层赢了」——与文件里「冲突要上报」的原则自相矛盾。
6. **无嵌套 / 无路径作用域**。只看 workspace 根，monorepo 的 `packages/*/AGENTS.md` 完全不生效。
7. **无生发与可观测**：没有 `/init` 等价物、没有 `/context` 等价物、没有大小预算。
8. **规则强度未分级**。Claude 明确「instructions 是指导，硬约束用 hooks / permissions」；pure 的默认文件用的是硬口气的软约束，模型不服从就没有兜底。

## 四、改进建议

### P0（已落地，见文末）

- **拆三份**：`templates/default-agents.md`（产品默认，跨项目通用）/ 根 `AGENTS.md`（本仓库开发约定与命令）/ 编排策略回迁 L1 提示层。
- **默认值单一来源**：`agents:sync` 从模板生成 `src/shared/defaultAgentsMd.ts` 与 `src-tauri/AGENTS.md`，根 `AGENTS.md` 不再参与默认值。
- **编排策略回迁 L1**：只补 L1 缺的三条（职能选角、检验独立性、并发与回炉上限），其余不重复。
- **项目事实层**：根 `AGENTS.md` 补命令、模块地图、验证顺序；模板里给出「按项目补充」的位置。

### P1

- **合并语义升级**：每节支持 `merge: append | override`（✅ 已落地：标题上一行写 `<!-- merge: append -->` 即追加不替换，可跨层叠加），覆盖时输出诊断（哪层覆盖了哪节），让「冲突上报」对 loader 也成立。
- **支持 `@import`（限跳数）+ 路径作用域 + 按需加载下层 AGENTS.md**（三项均已落地：@import 按层根展开；`<!-- paths: … -->` 标注 + `mergeLayers(layers, { paths })` 过滤；下层目录按**请求提及的路径**加载，越近越优先）。
- **规则分级**：`[hard]` / `[soft]`，hard 项必须同时落在 permissions / hooks 配置里。
- **默认可更新**（✅ 已落地）：默认文件带 `<!-- pure:default version=N -->`，基线记在 `~/.pure/AGENTS.default.json`；升级只替换用户未改过的节，缺的节追加，改过的节保留。

### P2

- **预算与可观测**（✅ 已落地）：单层 > 8000 字符、合并 > 16000 字符告警；`bun run agents:show` 打印各层来源、被覆盖/追加/新增的节、作用域、导入、预算警告。token 估算仍是粗口径（按字符数）。
- **表达瘦身**：判定阶梯配判例比堆阈值更容易被模型执行；标题去编号（已随 P0 的 key 归一化处理）。

## 五、落地记录（2026-11-15，P0）

- 新增 `templates/default-agents.md`：产品默认，仅跨项目通用条款（语言 / 通用原则 / 确认门限 / 呈现纪律 / 提交信息 / 项目事实指引）。
- 根 `AGENTS.md` 重写为 pure 仓库开发约定：常用命令、模块地图、验证顺序、提交信息。
- 多 agent 编排策略自 `AGENTS.md` 迁入 `MULTI_AGENT_MECHANICS_PROMPT`（选角 / 检验独立 / 并发与回炉上限）。
- `scripts/sync-default-agents-md.ts` 改为「模板 → `defaultAgentsMd.ts` + `src-tauri/AGENTS.md`」单向生成；parity 测试改锁模板。
- `conventions.ts` 增加分节 key 归一化（去编号、大小写、空白）与合并诊断（各层来源、被覆盖节、新增节）。

### 落地记录（2026-11-15，P1 第一刀）

- 合并语义支持按节追加：标题上一行 `<!-- merge: append -->`，父层内容保留、子层内文追加在后，三层可叠加；指令行在合并前剥除，不进模型上下文。
- 诊断区分「覆盖（-N 字符）」与「追加」，`agents:show` 可直接看出某节是被替换还是被补充。
- 未做：`@import`、`paths:` 路径作用域、按需加载下层 `AGENTS.md`。

### 落地记录（2026-11-15，P1 第二刀）

- 默认约定可升级：模板头带版本标记，`syncSeededAgentsMd`（CLI）与 GUI 同一个纯函数 `upgradeSeededAgentsMd` 处理升级；基线在 `AGENTS.default.json`。
- 升级三分类：新增（用户文件没有的节）、采纳（用户未改过的节换成新版）、保留（用户改过的节）。无基线时保守：已存在的节一律不动，只记基线。
- 版本标记在任何合并前剥除，不进模型上下文；`agents:show` 同时报默认版本与基线版本。

### 落地记录（2026-11-15，P1 第三刀）

- `@file.md` 导入：单独一行即可把另一个约定文件展开进当前层，用于 monorepo 共享规则。
- 边界：限于当前层根目录内、最多 3 跳、按路径去环；代码块内的 `@...` 不展开；缺失/越界/成环的那一行原样保留（可见且无害）。
- `agents:show` 列出每个导入的来源与字符数；GUI 同源展开（同一 `expandImports`，reader 走 Tauri invoke），两面不会各自一套。
- 未做：下层目录按需加载（需引擎在读写文件时按目录注入）。

### 落地记录（2026-11-15，P1 第四刀 / P2 第一刀）

- 路径作用域：`<!-- paths: src/ui/** -->` 标记节的作用范围；合并文本带「生效范围」行，避免 UI 规则自称全局；`scopeMatchesPath` 支持 `**` / `*` 两种通配，`mergeLayers(layers, { paths })` 可按本次涉及的文件过滤不相关的节。
- 软预算：单层 8k、合计 16k 告警，`agents:show` 与 CLI（每进程一次）均可见。超额不阻断——它提醒的是“每个字符每回合都要付”，不是数据错误。

### 落地记录（2026-11-15，P1 第五刀）

- `@import` 两面同源：路径处理改成纯字符串（`cleanPath` / `joinPath` / `dirnameOf`），渲染进程无需 `node:path`；GUI 传入层根相对路径与 invoke reader，把护栏（≤3 跳、去环、不越层根、代码块不展开）完整复用。
- 预算告警 GUI 展示见下方 P2 第三刀。

### 落地记录（2026-11-15，P1 第六刀）

- 下层目录按需加载（两面对称）：`collectNestedConventions` 从请求里提到的路径向上走目录链，加载每一级的 `AGENTS.md`/`CLAUDE.md`，外层先、内层后（内层覆盖外层）。CLI 在装配时传 `nestedFrom`，GUI 用同一个纯函数 + invoke reader，缓存键加入提示文本。
- 定位说明：这一刀是「按提及路径」的提前量，不是「读到文件才注入」——请求里没点名、但模型自己决定去读的子目录，这一轮还带不上规则。误报只多花几个 token，漏报只是这一回合不带下层规则。

### 落地记录（2026-11-15，P2 第二刀）

- 读到文件才注入（引擎钩子）：`EngineContext.workspaceConventions` 让宿主接管读盘——引擎在每批工具结果配平之后，把本批**成功读到**的文件路径（`read_file` / `edit_file` 的 path）交给宿主，宿主用 `conventionsForPaths` 取目录链上的 `AGENTS.md`/`CLAUDE.md`（外层先、内层后），引擎把它们作为内部 user 消息插进转录，下一轮 THINK 就带着该目录的规矩。
- 触发口径：只有真读到的文件算数——失败的读不触发（目录不在工作范围里，一条失败的 path 只多花 token）；`write_file` 不触发（新路径说明不了这轮是否在那个目录里干活）。
- 去重：引擎挡住同一回合内重复读同一目录；`conventionsDelivered`（会话级 Set，只记「已写进转录」的源）由宿主持有、跨轮传给引擎，引擎在注入时写入、在回合开始时并入去重账——同一份规则在长会话里只注入一次，消息留在历史中不重复付费。宿主读盘回调也用同一份账过滤结果（CLI 每个 harness 一份，GUI 每个会话一份、切会话重置）。
- 位置约束：注入发生在工具结果之后、中途检查点之前。内部 user 消息绝不能插在 `assistant.toolCalls` 与它的结果之间（400 的经典来路），检查点因此拿到的已是配平且带好规则的转录。
- 与提前量的关系：两条口子并存，共用 `conventionsForPaths` / `loadDirConventions` 一份实现。请求里点名的路径先到，真读到的路径补齐。
- 两条口子相互知悉：装配点把「本轮已随请求文本并入 system prompt 的下层源」通过 `conventionsPreloaded`（每轮求值的 getter）告诉引擎，引擎在回合开始时把这些源记入本轮去重账，但**不**记入 `conventionsDelivered`——prompt 每轮重建，某一轮没再带上的预加载源若后续真被读到，仍要补进转录一次以保持规则可见；补进后即进入会话账，此后不再重复。CLI 的清单来自 `merged.diagnostics.layers`（name === 'nested'），GUI 的来自 `collectNestedConventions` 并随 30s 缓存一并恢复。

### 落地记录（2026-11-15，P2 第三刀）

- 软预算告警进 GUI：GUI 自己逐层 `mergeConventions`（不走 `mergeLayers`），所以阈值判定抽成 `conventionsBudgetWarnings(text, layers)`，`mergeLayers` 与 GUI 共用一份；两面不会各自一套「算不算太大」。
- 展示口径：一次一进程（GUI 是模块级 flag，重载即重置），toast 显示 `AGENTS.md: …`，与 CLI 打到 stderr 的那行同文案。它说的是用户维护的文件，不是这一回合的异常，因此不重复弹。
- 分层计数：app / global / workspace 三层按展开后（含 `@import`）的字符数算，nested 层逐份计入——被 `@import` 撑大的层也在告警范围内。

### 落地记录（2026-11-15，P2 第四刀）

- paths 作用域诊断：`mergeLayers` 在按 `paths` 过滤 scoped 节时记录命中节（`scopes`）与被过滤节及原因（`filteredScopes`，含判定路径上下文 `pathContext`）；`formatConventionsDiagnostics`/设置页快照据此区分“命中（已生效）”与“未命中（已过滤）及原因”，便于定位局部规矩未生效。GUI 预装配按本次提及路径传入 `paths` 做判定；运行中注入按触发路径给出命中/未匹配分析（注入内容仍按整文件写入转录，诊断中标注未按路径裁剪，以保持既有去重与注入语义）。
- 长会话去重实测与恢复修复：引擎级多轮模拟确认同一 source 在“已写入转录（`conventionsDelivered`）∪ 本轮预加载（`conventionsPreloaded`）”下跨轮/跨 `continue` 不重复注入（注入开销近似唯一 source 数）；发现会话恢复/加载历史时若仅清空 delivered 集合，会导致历史中已有的 `<project_conventions>` 在后续同目录读取时重复注入。GUI 在从快照恢复消息后从转录回灌 delivered source，使跨恢复去重不断档（压缩若移除注入消息而保留集合仍需单独关注）。
