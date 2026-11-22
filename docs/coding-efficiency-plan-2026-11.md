# 编码任务效率与准确性改进计划（2026-11-22）

> 状态：P0（1–5）与 P1 的探索面收口（6/7）已落地（2026-11-22，未提交）；阶段 0 基准、P1 其余项与 P2 未开工。基线 commit `ad6ba56`（main，2026-11-22）。
> 对照口径：Claude Code 2.x / Codex CLI / opencode 2.x 的**工具契约**（读前强制、行号回显、edit 回显 diff、todo/plan、单一搜索面、验证入口），不引用榜单分数。
> 本文只谈编码类任务。渠道、呈现、记忆、人格不在范围内。

## 零、结论先行

1. **引擎的"救火层"不是短板**。失败阶梯（`FailurePolicy`）、流超时三分支、截断救援、断点续跑、验收即停，在同类产品里属于做得多的一档；继续往这里加机制，边际收益已经很低。
2. **差距在两条最朴素的回路**：
   - **读 → 改 → 复核**缺机械件。`read_file` 不带行号，`edit_file` 只回执「替换了几处」，`write_file` 覆写已有文件没有读前门。模型只能靠再读一遍来确认自己改对了——这恰好是 `execute_command` 描述里明令禁止的动作。同行三家里没有一家是这样。
   - **探索面把单选题做成了多选题**。`find_files` 的措辞是「Use this FIRST」，但它做的是主题排序而不是精确匹配；`code_searcher` 才是代码检索；`search_files` 还留在 discover 索引里；git 全家被 deferred 藏起来。模型每次都要先做一次工具选择，选错就多一轮。
3. **第三个差距是"并行委派"被写成了默认立场**。`PARALLEL_FIRST_DIRECTIVE` 只要 `hasSubagents` 就常驻，并明确要求"自干需要一句话辩护"。一个单文件 bug 修复在这种语境下会被推向 `code_editor` worker：worker 从零重读文件、父级等收执、再汇总，成本 3–10 倍，用户看到的就是"绕弯子"。

一句话概括：**pure 的循环很强，但工具契约与默认工作形状不像一个编码 agent。**

## 一、本机实测基线（2026-11-22，CLI 面组装）

用 `PromptAssembler.assemble()` 直接量，不估算：

| 项 | 数值 |
|---|---|
| 编码回合 system prompt | 13,032 字符（≈3.6k tokens） |
| 其中人格（`character_core` + `character_expression`） | 3,818 字符（29%） |
| 其中行为契约（`workflow` 2,001 + `completion` 830 + `work_invariant` 774） | 3,605 字符（28%） |
| 其中 GUI 编排协议（`insertion_protocol` + `ledger_protocol`） | 1,208 字符（9%） |
| 常驻 13 个核心工具的 schema | 15,518 字符（≈4.3k tokens） |
| 追加 subagent 角色（`CODING_AGENT_ROLES` + `BUILT_IN_SUBAGENTS`） | 4,520 字符（≈1.3k tokens） |
| **首轮固定开销** | **≈9k tokens（每轮都付）** |

单条 description 实测：`read_file` 1,308 字符、`write_file` 1,016、`execute_command` 885、`find_files` 761、`code_searcher` 253、`edit_file` 363。正文里混着 PDF/DOCX/GBK、图片、MCP、后台任务等与当前任务无关的能力说明——按需能力进了常驻表。

## 二、差距清单

编号即施工顺序。每条给：现状（带位置）/ 同行做法 / 影响 / 改法 / 验收。

### P0 · 直接影响正确性

#### 1. `read_file` 返回裸文本，没有行号

- 现状：`src/adapter/node/NodeToolAdapter.ts:409` 返回 `lines.join('\n')`；Rust 镜像 `src-tauri/src/lib.rs:1377` `finish_explicit_range` 拼回的也是纯文本。`outline` 给行号，正文不给。
- 同行：Claude Code 的 Read 输出每行带 `N→` 行号；Codex 的读文件结果同样把行号作为默认输出的一部分。行号是 `path:line` 引用、改后复核、跨文件定位共用的坐标系。
- 影响：模型报的行号靠数；改了 20 行后复核只能整段重读；`outline` 给的行号与随后读到的正文对不上。
- 改法：正文输出加 `N→` gutter（`lineNumbers:false` 可关）。同时在 `findEditMatch` 匹配前剥掉行首 `^\s*\d+→`，避免模型把 gutter 复制进 `oldString`；`edit_file`/`write_file` 描述各加一句「N→ 只是显示层」。
- 验收：`tests` 锁 gutter 格式；`edit_file` 用带 gutter 的 oldString 仍能命中；真机单文件任务里"为核对而重读"的次数下降。

#### 2. `edit_file` 结果不含改动上下文

- 现状：`NodeToolAdapter.ts:737` 只返回 `Replaced 1 occurrence(s) in path`。
- 同行：Claude Code 的 Edit 回显改后片段的若干行；Codex 的 patch 回执也带定位。
- 影响：模型无法确认改在了预期位置，于是要么再读一遍（多一轮 + 多一份上下文），要么直接宣称完成（错）。错位编辑是最常见的事故形态。
- 改法：返回 `path:line` 起点的 ±3 行 hunk（带行号，总长 ≤400 字符）+ 文件总行数。失败分支同样给「最接近的 3 个候选片段」，把 `editStringNotFoundError` 从"没找到"升级成"你可能想改的是这里"。
- 验收：`edit_file` 结果含 hunk；连续编辑同一文件的任务里工具轮次下降。

#### 3. `write_file` 覆写已有文件没有读前门

- 现状：`NodeToolAdapter.ts:672` 无条件 `Bun.write`；`edit_file` 描述里写了「Read the current file first」，但只是措辞。
- 同行：Claude Code 强制先 Read 再 Write；Codex 的 apply_patch 本身就要求上下文行。
- 影响：整文件重写会静默丢掉未读过的内容（配置、导出、测试）。这是用户最难接受的一类损坏。
- 改法：目标已存在、且本会话未成功读过该文件、且未显式传 `overwrite:true` → 返回可执行的拒绝（"先 read_file 或传 overwrite:true"）。新建文件、临时脚本不受影响。
- 验收：新增用例覆盖三条路径（未读拒绝 / 读过放行 / overwrite 放行）；GUI（Rust）同语义。

#### 4. 项目验证入口没有机械化

- 现状：`buildEnvFacts`（`src/ui/chat.ts:1252`）与 CLI（`src/cliRepl.ts:396`）只注入时间、运行时、网络、shell、约定、仓库地图；没有任何"这个项目怎么验证"。`stopAtGreen` 能识别 `bun test` / `tsc --noEmit` / `pytest`，但它只在**已经跑绿之后**说话。
- 对照：验证入口是项目的不变事实，同行把它放在模型第一眼就能看到的位置（项目清单/约定文件），不需要为"怎么验证"单独花一轮试错。这里模型也能自己读，但第一次尝试经常是错的（`npm test` → 没有该脚本 → 换 `bun test`），而这次试错的代价是一条红命令进了转录。
- 影响：每个编码任务固定多 1–2 轮试错；验证面选错（跑单测而不是类型检查）时"绿"是假绿。
- 改法：工作区首次进入（或清单指纹变化）时探测一次：`package.json` 的 `test`/`typecheck`/`lint`/`build`/`check`、`pyproject.toml`、`Cargo.toml`、`go.mod`、`Makefile`、`scripts/verify.*`。拼成一行事实注入 envFacts：
  `Verification (from this repo): typecheck \`bun run typecheck\`; tests \`bun test\`; green = exit 0 of a whole-project run.`
  复用 `isProjectVerificationCommand` 的判定面，别再造一套词表；结果按清单指纹缓存。
- 验收：`bun run typecheck` + 该模块单测；真机上"第一条验证命令就跑对"的比例。

#### 5. 委派默认立场把小事放大

- 现状：`src/shared/promptLayers.ts:544` `PARALLEL_FIRST_DIRECTIVE` 只要 `hasSubagents` 就常驻（CLI 也注册了全部角色，`src/cliHarness.ts:788`）；`mode` 为 build/plan 时再叠 2.4k 字符的 `MULTI_AGENT_MECHANICS_PROMPT`（`:552`）。
- 同行：三家都把子 agent 当**按需**工具；单文件修改由主线直接做是默认。
- 影响：单文件/单链路的修复被拆成 brief → worker 重读 → 汇总；延迟与 token 成倍，且 worker 看不到父级的现场判断，改错概率更高。这是"绕弯子"最直接的体感来源。
- 改法：
  - 常驻只留一句「互不依赖的工作并行；有依赖的按顺序并说清依赖」。
  - 完整并行/委派机制段改为按规模闸门：多模块构建、N 个来源调研、批量文件、明确要求并行时才带。
  - 加一条反向判据：「改动落在 ≤2 个文件、或一条调用链能一次说清 → 自己做完，不要拆」。
  - 闸门是提示词事实，不是宿主裁决——拆不拆仍归模型，但默认从"拆"改回"自己判断"。
- 验收：真机单文件任务里委派率（`code_editor`/`bash_executor` 调用占比）；同一任务的总 tokens 与墙钟。

### P1 · 效率与一致性

#### 6. 搜索面收敛成一个入口

- 现状：常驻里有 `find_files`（`toolDefs.ts:80`，描述写着「Use this FIRST」）、`code_searcher`（`:196`）、`list_files`、`glob_files`；`search_files` 已从常驻撤下（`CORE_TOOL_NAMES`，`:501`）但仍留在 schema 表、discover 候选与 UI 清单里，而且 `src/shared/shellEnv.ts:36` 的 Windows shell 事实还在教模型「prefer search_files」——模型看得见的工具表里没有它，照着做就是 `Unknown tool`。
- 影响：模型在"找符号定义"这类最常见的动作上先做一次工具选择；选 `find_files` 得到的是主题排序片段，不是精确命中，于是再搜一次。Windows 上还会多一次从错导引来的失败往返。
- 改法：编码回合里 `code_searcher` 是唯一内容检索入口；`find_files` 描述改成"文档/模糊主题定位，不用于符号查找"，删掉 FIRST 推销；`search_files` 从 discover 索引与 `BUILT_IN_TOOL_DEFS` 移除（执行面保留兼容），并清掉 `shellEnv`、`toolRow`、`toolInventory` 里指向它的文案。`code_searcher` 描述补三句：先搜后读、`globs` 排除测试、命中行直接用 `startLine` 读窗口。
- 验收：schema 体积下降；"同一意图搜两次"的比例。

#### 7. git 家族与未知工具指路

- 现状：`git_status`/`git_diff`/`git_commit` 不在 `CORE_TOOL_NAMES`，编码任务收尾要提交时得先 `discover_tools`；未知工具错误是裸的 `Unknown tool: X`（`src/coding-agent/ToolRegistry.ts:462`）。
- 影响：每次提交多一轮；模型不知道这是"被藏起来的工具"还是"写错了名字"。更糟的是 `src/ui/TauriToolAdapter.ts:2521` 的未知工具错误会把**已隐藏**的工具名（`search_files`、`git_*`）列成 "Available"，模型据此重试仍然失败。
- 改法：`git_status` / `git_diff` / `git_commit` 回常驻（schema 很小）；`git_log` / `git_branch` 继续 deferred。未知工具错误改为：`Unknown tool "X". If it is a deferred built-in or MCP tool, call discover_tools with "<keywords>" and retry.`（关键词取工具名），并停止列举不在当前工具表里的名字。
- 验收：提交路径少一轮；未知工具后的恢复率。

#### 8. `write_file` 的 5,000 字符拆分纪律

- 现状：`toolDefs.ts:38` 把「超过 ~5,000 字符默认拆」写成纪律，配合 `append:true` 分段。
- 影响：一个 12k 的文件被拆成 3 次写入，任何一次截断/顺序错乱都会留下半成品；而模型的真实输出上限远高于 5k。这条纪律是为 8k 输出窗口设的，现在反而制造了最多轮的写入形状。
- 改法：阈值抬到接近实际输出上限（~24k 字符），措辞从"默认拆"改成"接近输出上限才拆，且先写完再 append"；保留现有截断救援（`salvageTruncatedWriteArgs`），救援成功时回执明确写「已写入前 N 字符，继续用 append:true 续写」。
- 验收：单文件中位写入次数；截断导致的失败率。

#### 9. 失败输出没有聚焦

- 现状：`execute_command` 超过 30k 的输出落盘并给头尾预览（`NodeToolAdapter.ts:1196`），但测试失败的关键行可能在中段。
- 影响：模型拿到 30k 里的头尾，真正的 `AssertionError` 看不见，于是重跑、加 `-v`、再重跑。
- 改法：非零退出且输出超阈值时，附一段机械抽取的「失败索引」：匹配 `FAIL|✗|Error:|AssertionError|panic:|expected|received` 的行，各带前 2 行上下文，最多 40 行，并注明完整输出文件路径。
- 验收：失败测试任务里，定位到根因前的工具轮次。

#### 10. CLI / 子 agent 没有计划清单

- 现状：`request_plan` 只接在 GUI（`src/ui/chat.ts:6208`）；CLI 注册了全部子 agent，却没有计划面。`Planner` 只服务分析，不向模型回显状态。
- 同行：Claude Code 的 TodoWrite、Codex 的 update_plan 都是多步任务防偏航的核心件——它不替模型决定做什么，只让"还剩什么"在上下文里可见。
- 改法：新增模型自有的 `update_plan` 工具（无审批闸、不阻塞执行）：入参是条目数组（`content` / `status`），宿主只负责存进会话状态并在下一轮以一行摘要回显。GUI 可映射到既有计划卡；CLI 以纯文本回显。属于"系统的手脚"，不越决策边界。
- 验收：多步任务里重复动作与漏步的比例；任务完成率。

#### 11. 角色描述瘦身

- 现状：`task_planner`、`code_editor`、`deep_thinker`、`ui_designer`、`bash_executor`、`researcher`、`code_reviewer`、`project_auditor` 的 `description` 合计 4,520 字符，**每轮**随 tools 数组计费。
- 改法：`description` 压到 1–2 句触发条件；长操作纪律搬进各自的 `createSystemPrompt`（只在 spawn 时付费）。预计降到 ~1.2k 字符。
- 验收：tools 体积读数；委派选择准确率不下降。

### P2 · 提示词与结构

#### 12. 编码回合提示词减重

- 现状：13k 字符里，人格两张投影 3.8k、GUI 编排协议 1.2k、workflow 2k。
- 改法：编码回合不注入 `insertion_protocol` / `ledger_protocol`（CLI 面整面不需要，GUI 也只在有插话/委派时才有意义）；`character_expression` 在编码回合压成一行场景语气；`workflow` 从 2k 压到 ~800（保留"复用教训 / 失败换路线 / 验证 / 危险动作问询"四条）。
- 目标：编码回合 system prompt ≤ 9k 字符，且不损失任何行为契约条目。
- 验收：`promptLayers` / `PromptAssembler` 用例锁"编码回合不含某段"；A/B 读数不退化。

#### 13. 失败阶梯注入瘦身

- 现状：`DefaultFailurePolicy` 的 1–2 次失败提示已含 trap-escape 长段；前半段与 `TRAP_ESCAPE_HINT`、`webHint` 叠加后单条可达 500+ 字符。
- 改法：同一回合内去重（`noteBudget` 已有分类能力，扩到 failure hint）；trap-escape 只在"重复失败 ≥3"时出现。
- 验收：同一失败序列注入的总字符数。

#### 14. 子 agent 与主线共享读取结果

- 现状：每个 worker 从零重读父级已经读过的文件。
- 这是成本最高的一项，**先量再做**：在阶段 0 的基准里记录"worker 重读的字节数 / 父级已读文件命中率"，只有占比显著才立项。共享只读缓存涉及隔离与陈旧性，别为了省 token 引入新的错误面。

## 三、施工顺序

### 阶段 0 — 先有尺子（3–5 天）

没有读数就无法证明任何一条改动是收益。仓库已有 `evals/` 与 `eval:baseline` 骨架，扩展即可。

- fixture：本仓、一个 300 文件 TS 应用、一个 Python 包、一个"测试红着"的最小 repo。
- 任务集（12–15 条）：单文件修 bug、补一个测试、多文件重构、加一个接口、修红测试、读 PR 并给结论。
- 指标：轮数、工具调用数、输入/输出 tokens、`edit_file` 首次命中率、第一条验证命令正确率、绿后巡游次数、任务成功率。
- 落地：`bun run eval:coding`，结果落 `docs/evals/coding-baseline-YYYY-MM-DD.md`。
- 每条改动都带 `PURE_*` 开关，两臂跑同一份代码。

### 阶段 1 — P0 五件（约 1 周）

1/2/3 是同一个文件的两个适配器（Node + Rust），一次改完、双端锁测试；4 接 envFacts；5 只改提示词闸门。预期读数：首次编辑命中率 +15pp 以上，验证命令首次正确率 >90%，平均轮数 −15%。

### 阶段 2 — P1（约 1 周）

6/7 是工具表与措辞；8/9 是适配器；10 是新工具（需要 GUI/CLI 两个宿主接线）；11 是纯文本压缩。预期：单文件任务的委派率 <10%，工具 schema 体积 −30%。

### 阶段 3 — P2（按读数决定）

12/13 是提示词；14 先看阶段 0 的数据再定。

## 四、边界与风险

- **不新增决策机制**。本仓决策边界（`docs/decision-boundary-2026-11.md`）要求宿主只答"怎么做成"。行号、diff 回显、读前门、验证入口探测都是工具契约与物理事实，符合；"是否该拆任务"仍归模型，闸门只调默认倾向。
- **行号会污染编辑内容**。匹配层剥 gutter + 双端测试，是这项改动的准入条件。
- **读前门不能误伤**。新建文件、临时脚本、用户明确要求整文件替换（`overwrite:true`）三条路必须畅通。
- **拆分纪律放宽有截断风险**。保留救援路径，并在回执里说清"写到哪了"，而不是静默成功。
- **不做**：重写 Planner、换工具调用协议、引入 `apply_patch` 格式。前两项超出本次范围；第三项在行号 + diff 回显落地后先用基准量一次，没有明显收益就不做。

## 五、验证方式

每条改动：`bun run typecheck` → 对应单测 → 涉及工具表/命名时 `bun run lint:conventions`。涉及打包入口时 `bun run build`。
阶段收口：`bun run eval:coding` 前后对照 + 一次真机 probe（`bun run probe:gui`）。
跑不动或有已知失败，在交付里如实写明，不报成通过。
