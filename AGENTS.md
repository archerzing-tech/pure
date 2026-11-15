# pure 仓库开发约定

> 这份文件是**在本仓库里改代码**的约定。给终端用户的产品默认基线是
> [`templates/default-agents.md`](templates/default-agents.md)，由 `bun run agents:sync`
> 生成 `src/shared/defaultAgentsMd.ts` 与 `src-tauri/AGENTS.md`——**不要手改那两个生成物**。

## 语言

- 对话回复使用用户输入所用的语言；代码、命令、标识符、报错原文保持原样。
- 注释与文档用中文，写「为什么」；不要复述代码在做什么。
- 提交信息正文用中文（见文末）。

## 常用命令

```bash
bun run typecheck                  # tsc --noEmit，改完必跑
bun test                           # 全量
bun test src/shared/__tests__/conventions.test.ts   # 单文件
bun test -t "merge"                # 按用例名过滤
bun run lint:conventions           # 约定检查（scripts/check-conventions.ts）
bun run build                      # typecheck + vite + cli 打包
bun run cli                        # 本地跑 CLI
bun run agents:sync                # 改 templates/default-agents.md 后重新生成默认值
bun run agents:show                # 看 AGENTS.md 各层来源与被覆盖的节
```

`package.json` 里还有 `verify:*`（计划恢复、自动续跑、通道回路等真机探针）与
`eval:*`（基线与角色回归）。这些是针对性探针，改到对应模块时按需跑，不要当全量回归。

## 代码地图

| 路径 | 职责 |
|---|---|
| `src/shared/` | 纯函数与装配层：renderer 也可复用，顶层不得静态 `import 'node:*'`（需要时动态 import） |
| `src/shared/PromptAssembler.ts` + `promptLayers.ts` | L0/L1/L2 提示词分层与按请求闸门；改提示词前先看这两处的分层注释 |
| `src/ui/` | Tauri GUI（`chat.ts` 是主体） |
| `src/cli*.ts` + `src/cliHarness.ts` | CLI / REPL / 一次性 `-p` |
| `src/engine/` | 事件循环、工具调用、失败恢复 |
| `src/harness/` | 单回合编排、子 agent 编排入口 |
| `src/coding-agent/` | 工具定义、角色（`SubagentOrchestrator.ts`）、Verifier |
| `src/channels/` | 飞书 / 钉钉 / QQ / WebChat 网关 |
| `src/character/` | 人格内核与投影（红线：不删不改写） |
| `src-tauri/` | Rust 外壳与打包资源（`AGENTS.md` 是生成物） |
| `docs/` | 文档索引见 `docs/README.md`；归档文档不作施工依据 |

## 验证顺序

1. `bun run typecheck`——类型不过不算完成。
2. 针对改动文件的 `bun test`（改 `src/shared/` 至少跑该目录下相关用例；改提示词跑 `promptLayers` / `PromptAssembler`）。
3. `bun run lint:conventions` 当改动涉及命名、目录、导出约定时。
4. `bun run build` 仅当改动碰到打包、入口或 Tauri 资源时。

跑不动或有已知失败，要在交付里如实说明是哪一项、什么现象，不能报成通过。

## 编码约定

- 沿用现有风格：注释写动机与判例（真机 session id 很值钱），不写注释解释显而易见的代码。
- 共享层新逻辑先想清楚它属于哪一层（模型决策 / 系统手脚 / 物理不变量 / 契约），判据见 `docs/decision-boundary-2026-11.md`。
- 不引入新依赖除非现有能力确实不够；引入前先确认仓库里有没有等价实现。
- 生成物与孪生文件必须同步：`src/shared/defaultAgentsMd.ts`、`src-tauri/AGENTS.md`、以及测试里锁住的字符串快照（很多测试按源码文本断言装配接线，改调用点要一起改）。
- 文档纪律：活文档带状态行与 commit 锚；实现与文档冲突以代码为准。

## AGENTS.md 合并语义

- 三层：内置默认（`templates/default-agents.md`）→ `~/.pure/AGENTS.md` → 工作区 `AGENTS.md`；同层 `AGENTS.md` 优先，`CLAUDE.md` 兜底。
- 子层按**归一化标题**（去编号、大小写、尾标点）整节覆盖父层。要在某一节上追加而不是替换，就在该节标题上一行写 `<!-- merge: append -->`：父层内容保留，子层内文追加在后，可跨层叠加。
- 模板头部带 `<!-- pure:default version=N -->`：改动模板语义就把它 +1。启动时 `syncSeededAgentsMd` 把 `~/.pure/AGENTS.md` 向新版靠：用户文件里**没改过**的节换成新版、没有的节追加，用户改过的节保留不动；基线记在 `~/.pure/AGENTS.default.json`。
- 跨文件复用：单独一行 `@rules/xxx.md` 会把该文件展开进来（相对当前层根目录，最多 3 跳，有环检测；代码块里不展开，越出层根不展开）。
- 看合并结果：`bun run agents:show`（或 `PURE_DEBUG_CONVENTIONS=1` 跑 CLI）；改模板后必须 `bun run agents:sync`。

## 提交信息约定

- 提交信息不写任何工具署名尾行：不加 `Generated with ...`，不加 `Co-Authored-By:`（Codebuff / Claude / 其他一律不加）。
- 结构：一句话主题 + 讲「为什么」的正文段落（动机、影响、被放弃的方案）；不列文件清单、不加 emoji 尾行。
