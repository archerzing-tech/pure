# Changelog

All notable changes to **Pure**. Each release's section is shown as the GitHub
release summary when publishing (see `.github/workflows/release.yml`).

## v1.9.3

**代理能力、会话回放与 GUI 执行体验**

- 新增桌面端统一网络代理：支持 HTTP/HTTPS、SOCKS5/SOCKS5H，并覆盖大模型、内置网络工具、HTTP MCP、stdio MCP 和命令行网络环境
- 代理默认全部关闭；总开关、模型请求和工具网络分别控制；代理地址为空或无效时安全直连；支持按供应商或模型豁免大模型代理
- 修复历史会话恢复：完整保存并恢复思考、分析、Markdown 图表/图片、生成文件卡片、工具调用参数和工具输出，并兼容旧会话数据
- 优化工具执行卡片：增加闪动终端光标、输出字节统计和文件写入进度；高频工具输出按帧批量刷新，避免阻塞输入、Esc、暂停和停止操作
- 执行大纲支持右上角展开/收起，收起后保留带呼吸提示的执行状态胶囊
- 优化任务分析与计划展示，减少固定模板、重复确认和界面空白
- 修复设置页权限与审批布局和代理菜单结构
- 修复 SSE 流式响应跨网络分块时的 UTF-8 字符损坏

## v1.9.2

**Prompt observability 与真实编码任务评测基线**

- PromptAssembler / Harness 共享隐私安全 trace，记录预算、工具 schema、事件、usage、verification 和终态，不默认保存原始内容
- GUI 与 CLI 共用 `requestWorkflow` 编译用户诉求前置流程；动态决定 direct/probe/plan/confirm，区分探针需求与探针能力，并在 GUI 语义分析后重新编译最终风险上下文
- 新增显式 JSONL trace sink、损坏记录容错和跨 assembly/run trace 关联
- 新增隔离 workspace 的 bugfix / feature / refactor 评测 fixture、control baseline、provider-backed CodingAgent executor 和 strict 退出码
- README、中文 README、Prompt/Engine/Harness/Adapter/Coding Agent/master spec 文档同步更新
- 更新应用界面截图与截图引用
- 新增共享自适应控制平面：按工作区、工具、时间、记忆和验证反馈动态选择探索/委派/恢复/验证策略，通过 `<adaptive_context>` 注入；只有真实验证过的结果才晋升为可复用 procedure
- `code_searcher` 在 CI 或精简环境缺少 ripgrep 时自动回退到受工作区边界保护的 Bun 文件扫描，并保持单文件范围、隐藏文件、glob 和结果上限语义
- 修复 Windows CI 下 Tauri mock invoke 误走 Channel 流式分支及源码契约测试的 CRLF 不兼容，保证跨平台发布门禁一致

## v1.9.2-beta5

**主动意图评估与风险前置**

- 每轮请求先由 Planner 判断意图、影响范围、风险等级和可逆性，不再只按“简单/复杂”机械执行
- 低风险任务直接处理；中风险任务先进行只读工作区探针，再小步修改并验证；高风险删除、覆盖和破坏性迁移先解释影响与更窄替代方案，并在 GUI/CLI 写入前要求明确确认；CLI 普通请求默认自动放行，`--prompt-on-tool` 提供所有工具的逐次交互确认
- 主动评估通过 `<intent_assessment>` 进入 GUI/CLI 的本轮 user context；两端可以有不同展示方式，但共享同一功能契约
- 高风险后续请求不会绕过正在进行或暂停中的复杂计划，安全评估会重新打开确认流程
- 新增 Planner、prompt composer 和 GUI 计划门控回归测试；最终 Bun 833/833、TypeScript 类型检查和生产构建通过

## v1.9.0

**拟人化协作体验（像同事一样干活）**

- 检测到复杂任务时不再弹确认框：拟人化开场（「你这次提的诉求比较复杂，我先把目标拆解成几步…」）→ 计划卡直接列出步骤 → 无需确认逐步执行，做完一步打一个勾；中途随时可 Esc / 停止中断
- 全局拟人化沟通基调：像一位靠谱的同事一样自然交流，杜绝「我来分析一下这个问题」「好的，以下是…」式开场白套话；含糊诉求先用大白话承认再拆解，追问像问朋友一样自然
- 项目构建完成时像同事一样汇报：用几句话讲清做了什么、能跑什么、接下来可以试什么，而不是列 changelog 式的清单

**计划卡体验升级**

- 计划卡零等待出现：开场白后立即渲染启发式骨架步骤（不依赖 LLM 往返），避免数秒空白等待
- LLM 专属计划就绪后原位平滑升级：旧卡在原位置淡出收起、新步骤逐条淡入滑入，视觉连续不生硬
- 「完善中…」徽标每 3 秒轮换提示文案：正在参考工作区文件 → 正在分析你的需求 → 正在生成专属执行计划，等待期更有信息量；定时器双重清理零泄漏
- 计划生成失败/超时自动回退到骨架计划并移除完善中状态，不会误导

**多图渲染**

- 新增多 SVG 并排输出契约：要求模型「每张图一个独立 ```svg 代码块、禁止把多个主体塞进同一张图、代码块紧挨输出」；GUI 自动把相邻代码块收进并排网格，每张各占聊天宽度一半、一行排开

**自定义供应商（上一版未发布，随本版一同发布）**

- 「用户自定义」快捷预设：点击一键生成空白供应商卡片，与 OpenAI / OpenRouter / NVIDIA NIM / Ollama 并列展示；选中后在配置卡填写名称 / Base URL / 模型 / API Key
- 模型列表一键自动获取（/v1/models），默认模型自动填入；未配置的供应商红色醒目提示「⚠ 未配置」
- 供应商卡片悬停右上角出现删除 ×，可随时删除；删除当前选中的供应商自动回退默认配置

**Freebuff 式项目构建流程（上一版未发布，随本版一同发布）**

- 规划前澄清提问：含糊的项目需求先弹 1–3 个关键问题让用户确认，回答作为硬约束注入计划与构建上下文
- 计划基于代码库生成：生成前扫描工作区目录结构与 package.json / Cargo.toml / README 等清单，步骤引用真实文件
- 逐步构建强制验证：每个阶段真实运行验证命令并报告输出，验证缺失自动补跑（仅自动权限模式）
- 交付前测试与审计清单卡：按 代码审查 → 依赖/安全审计 → 自动化验证 逐条打钩，失败进入修复→复查循环

**发布流程**

- 变更日志迁移到独立 CHANGELOG.md，GitHub Release 摘要自动提取对应版本章节 + 下载说明；README 不再维护 changelog

## v1.8.5

**自定义供应商交互改版**

- 「用户自定义」成为快捷预设之一 —— 点击一键生成一张空白供应商卡片，与 OpenAI / OpenRouter / NVIDIA NIM / Ollama 并列展示
- 选中卡片后直接在下方配置卡填写：供应商名称（实时同步卡片文字）、Base URL、模型、API Key，与知名供应商完全一致
- 模型列表一键自动获取 —— 点击「⟳ 获取模型」从 Base URL 拉取 OpenAI 兼容的模型列表，默认模型自动填入，完整列表持久化到该供应商
- 未配置的自定义供应商（还没填 Base URL）在配置卡端点处红色醒目提示「⚠ 未配置」，避免静默回落到内置默认端点
- 移除旧的「＋ 添加自定义供应商」大表单，流程更简洁

## v1.8.4

**Freebuff 式项目构建流程**

- **规划前澄清提问** —— 检测到项目需求后先由模型判断需求是否含糊，含糊则弹出 1–3 个问题让用户确认（目标、约束、技术栈），回答作为硬约束注入计划与构建上下文
- **计划基于代码库生成** —— 生成计划前扫描工作区目录结构与 package.json / Cargo.toml / README 等清单，步骤引用真实文件
- **逐步构建强制验证** —— 每个阶段必须真实运行验证命令并报告输出；模型推进到下一阶段时若缺少该阶段的验证证据，自动补跑标准验证（仅自动权限模式）
- **交付前测试与审计清单卡** —— 构建完成后按 代码审查 → 依赖/安全审计 → 自动化验证 逐条打钩，与计划卡一致；失败进入修复→复查循环

**自定义供应商**

- 添加表单精简为紧凑样式（移除大虚线框）
- 支持的供应商自带默认 Base URL；模型列表支持一键自动获取（/v1/models）

## v1.8.3

**Cross-platform release fix**

- Normalize recursive file-listing assertions across `/` and `\` path separators so the Windows release workflow passes its test gate.

## v1.8.2

**SVG viewer polish**

- **Reliable SVG zoom viewer** — generated SVG previews bind double-click activation before other diagram work completes, preserve embedded interactive shapes, and keep percentage-sized SVGs visible in the fullscreen viewer

## v1.8.1

**Polish & platform support**

- **Cross-platform native file icons** — generated-file cards now use the associated macOS, Linux, or Windows system icon when available, with a safe extension-based fallback
- **Grouped file-write activity** — the sidebar groups entries by file and shows the most recent write time and success/failure state
- **Refined artifact cards** — improved layout, semantic file-type colors, native-icon loading feedback, click-to-open behavior, keyboard activation, and reduced-motion support

## v1.8.0

**New features**

- **Custom providers** — add any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, …) from the GUI Settings or `pure config` in the CLI; each entry keeps its own API key, and keyless local endpoints send no `Authorization` header at all
- **Fault-tolerant parsing layer** — when the LLM outputs malformed JSON / Mermaid / SVG, the renderer auto-repairs (trailing commas, single quotes, unquoted keys, full-width punctuation, unbalanced label quotes/brackets, prose-wrapped output, …), retries, and only falls back to the user on failure
- **Repair diff viewer** — click any "auto-repaired" badge to compare the original source against the repaired source side-by-side
- **Native file icons** — artifact cards use the OS-associated icon on macOS, Linux, and Windows when available; Linux falls back safely when the desktop `gio` tool or icon theme is unavailable

**Improvements**

- Repair layer wired into the engine: `Planner` plans, `Verifier` verdicts, and `SubagentOrchestrator` / `MCPClient` tool arguments are all repaired before use (tool calls keep their arguments instead of silently degrading to `{}`)
- `repairJsonSource` gains a BFS candidate budget (default 200) — a defensive cap against repair-queue explosion on adversarial input

**Cleanup & internal**

- Tool schemas consolidated into a single shared `toolDefs` module (single source of truth across CLI/GUI/engine)
- Dead code removed: `quickSort`, `EventBus`, `ui/tools`, half-finished `FileWatcher`
- CLI version banner fixed (was stuck at v1.3.1, now in sync with the release)
