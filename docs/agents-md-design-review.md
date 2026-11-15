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
- 未做：GUI 无预算告警展示。

### 落地记录（2026-11-15，P1 第六刀）

- 下层目录按需加载（两面对称）：`collectNestedConventions` 从请求里提到的路径向上走目录链，加载每一级的 `AGENTS.md`/`CLAUDE.md`，外层先、内层后（内层覆盖外层）。CLI 在装配时传 `nestedFrom`，GUI 用同一个纯函数 + invoke reader，缓存键加入提示文本。
- 定位说明：这是「按提及路径」的启发式，不是 Claude/opencode 那种「读到文件才注入」。误报只多花几个 token，漏报只是这一回合不带下层规则；真正按读写事件注入需要引擎钩子，仍未做。
