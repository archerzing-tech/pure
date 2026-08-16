# Changelog

All notable changes to **Pure**. Each release's section is shown as the GitHub
release summary when publishing (see `.github/workflows/release.yml`).

## v1.9.6-test

**测试构建：CLI 版本烘焙、Harness 收尾顺序修复与自定义供应商配置 UX 细化**

- CLI 版本号改为编译时烘焙：新增 `scripts/build-cli.ts`，用 `--define process.env.PURE_CLI_VERSION` 把 package.json 版本注入二进制，banner 与启动行永不漂移；dev 运行直接读 package.json，硬编码常量仅作最后兜底
- 修复 Harness 事件流收尾顺序：checkpoint 持久化与记忆写入移到 `yield` 之前——消费者在 `Completed` 处 break 时不再丢失状态；`Interrupted` 快照回退到当前消息列表；新增回归测试锁定该行为
- 修复上下文压缩摘要对空 content 消息的空引用风险
- 自定义供应商配置提示精确化：Base URL 缺失时停在连接设置，只缺模型时自动打开模型库抽屉并聚焦输入框；启用成功后收起全部配置抽屉
- 修复内置供应商端点被全局残留 Base URL 劫持的问题：早期版本在「连接设置」填过的地址（如阿里百炼）会残留在全局字段里，导致所有供应商卡片与请求都显示/打到该地址；v10 迁移清空全局字段（非默认地址转入对应供应商的覆盖），请求层与设置面板不再读取它
- 内置供应商（DeepSeek / Qwen / GLM）支持 per-provider 覆盖：名称、Base URL（代理 / 镜像网关，留空即默认端点）与各自独立的 API Key（桌面端存入 `llm.apiKey.<id>` 独立密钥槽，与自定义供应商同一机制；浏览器模式存 override 条目）；设置面板对内置供应商同样开放名称与 Base URL 编辑行
- CLI 同步 per-provider 覆盖：`~/.pure/config.json` 的 `providerOverrides` 现在对内置供应商生效——名称（`pure config` 列表与启动行）、Base URL（DeepSeek / Qwen / GLM 各 adapter 工厂接受覆盖端点，Qwen 有覆盖时不再强制要求 `DASHSCOPE_WORKSPACE_ID`）、API Key（优先读 config 明文条目，桌面端 `hasApiKey` 时从 `~/.pure/secrets.json` 的 `llm.apiKey.<id>` 槽读取，与 GUI 共享同一份密钥）；`pure config` 重跑不再丢弃已有覆盖
- README（中英）新增「优点 / 独特之处 / 与其他 coding agent 的差异」一览；架构图补充请求预检（intake → assess → probe → plan → confirm）与 GUI/CLI 共享控制平面；默认界面改用真实截图

## v1.9.6

**GUI 卡片布局、Default + Drawer 供应商配置、Event Loop 文档与 CLI Tier-2/3 Web 工具**

- 统一 LLM 面板所有最外层卡片宽度，避免 Default 与 Drawer 边界错位
- “选择供应商”支持展开/收起 toggle；知名供应商默认只需 API Key
- 新增 GUI Default + Drawer 结构图，以及 JavaScript Event Loop 与 Pure AgentLoop 对比图
- README 更新 Pure 的证据驱动执行、会话投影记忆和可进化项目记忆说明
- CLI 新增 Tier-2/3 Web 工具：`web_public_api` 通过免 key 公共 API 直查结构化数据（天气/地理编码/新闻/维基/IP/汇率/股票/GitHub），`web_scrape` 对已知 URL 提取可读文本（导航剥离、`#id/.class/tag` selector、RSS/JSON 自动格式化、Jina Reader 兜底）；`web_search` 对结构化查询自动走直查快路径
- Web 搜索增强：新增 Exa 神经搜索后端（`EXA_API_KEY`，开户 $20 + 每月 $10 循环免费）；Serper/Tavily/Exa/免费 HTML 后端接入 BackendQuota 冷却与滑动窗口限流，失败或被限流的后端自动跳过而不是反复重试
- `web_public_api` 直查未命中时自动降级到 web 搜索（`searchOnMiss:false` 可关闭），避免多一轮模型调用
- Web 工具结果缓存：`web_search` / `web_public_api` / `web_scrape` / `web_fetch` 结果按 TTL 写入 `~/.pure/cache/web-cache.json`（CLI 与 GUI 共享同一文件与 key 方案，FNV-1a 交叉测试锁定），重复查询不再重复消耗免费额度；搜索 15 分钟、页面内容 1 小时、结构化直查按类别区分（天气/新闻/股票分钟级，地理编码/维基周级），缓存文件有上限（200 条，最旧优先淘汰）且容忍损坏；`PURE_WEB_CACHE=off` 可关闭，`PURE_CACHE_DIR` 可改目录
- 设置 → 工具页 Serper/Tavily 配置项旁新增「免费 Key ↗」一键申请链接；README 新增全部 Web 工具 key 表（含申请链接与免费额度）
- GUI（macOS 桌面端）同步移植 Tier-2/3 Web 工具：Rust 侧 `web_search` 获得结构化直查快路径与 location 参数，新增 `web_public_api`（天气/地理编码/新闻/维基/IP/汇率/股票/GitHub 等免 key 直查 + 未命中自动降级搜索）与 `web_scrape`（导航剥离、selector、RSS/JSON 格式化、Jina Reader 兜底）命令，与 CLI 行为对齐；`web_fetch` 同样获得 Jina 兜底
- 设置 → MCP 新增「＋ Scrapling 抓取」一键预设（`uvx --from "scrapling[ai]" scrapling mcp`，实测裸命令缺依赖），把 Scrapling 自适应隐身抓取能力以 MCP 工具形式接入（`scrapling__…` 前缀，权限管控同其他 MCP 工具）；浏览器类工具请求超时放宽到 120 秒（MCP 服务器配置新增 `requestTimeoutMs` 字段）
- CLI 支持 MCP 服务器：读取 `~/.pure/config.json` 的 `mcpServers`（GUI 设置页写入的同一份），或重复传 `--mcp-server "<name>:<命令或 URL>"`；终端用户可直接用 Scrapling 等 MCP 工具，工具列表含 `scrapling__*`；修复 one-shot/REPL 退出时 MCP 子进程管道挂起 CLI 的问题（显式 disconnect）
- MCP 工具前缀过滤：设置 → MCP 可配置「排除 MCP 工具前缀」（如 `scrapling__bulk_`），或 CLI 重复传 `--mcp-exclude-prefix`，匹配工具不进入模型工具列表，第三方 MCP 工具不再挤占内置工具选择
- 能力审计清理（端到端验证后删除）：移除航班动态意图（AviationStack）——无 key 时会劫持 `web_search` 快路径返回「需要 key」提示而非搜索结果，且真正交通类（高铁/地铁/路况/公交）本就不被覆盖；移除 Firecrawl 第二兜底——无 key 时完全不可达，Jina 免 key 已覆盖兜底角色；删除从未被生产代码引用的 `PromptComposer` 死代码（记忆注入实际走 PromptAssembler 直连）
- 修复「输入 key 后仍显示连不通」：连接测试改为**统一探测契约**——桌面端走 Rust 原生网络路径（新增 `test_llm_connection` 命令，与真实聊天完全同一条 reqwest 客户端 + 代理配置 + 密钥解析），浏览器开发模式走 `probeLlmEndpoint`（shared 镜像，语义与 Rust 完全一致：仅 2xx 成功、401/403 报 key 被拒、首个 /models 探测定论），两端展示同一结果结构，彻底消除 WebView fetch 与真实聊天之间的路径差异（系统代理、CORS、TLS 栈差异会导致百炼等厂商误报连不通）。同时：保存 key 后立即刷新供应商状态胶囊（此前仅面板重开才刷新）；新增第三状态「已保存，未启用」；API Key 输入框改为输入即防抖保存；`AbortSignal.timeout` 增加 AbortController 回退（旧版 WKWebView）
- 诉求合理性分析：任务分析阶段模型新增 `<request_review>` 结构化评审（逐条判定用户诉求的合理/存疑/不合理 + 理由 + 建议），「诉求合理性分析」卡展示在分析与计划之间；存在存疑/不合理项时执行前暂停，由评审卡上的「采纳建议调整后继续 / 仍按原诉求执行」决策按钮（或直接回复）让用户决定，决策并入暂停消息进入模型上下文；全部合理则紧凑一行确认，不打断流程
- 能力缺口自动补齐：系统提示新增 Capability-gap 协议——模型缺视觉/OCR/PDF/音视频等能力时不得拒绝或编造，先查本地已装技能，再从社区安装（`npx skills find/add`、GitHub 下载解压到 `~/.pure/skills/`、`pip/npm` 装到 `~/.pure/tools/`），装完必须真实验证并告知用户；`~/.pure/skills/<name>/SKILL.md` 与项目 `.agents/skills/` 自动加载注入系统提示（CLI 扫描本地目录，GUI 走 Rust `list_app_skills` 命令，30 秒缓存），模型装好的技能无需重启即生效

## v1.9.5

**正式版：多模型配置、工作区响应与资源生命周期优化**

- LLM 设置页正式采用方案 4：默认突出当前供应商和默认模型，供应商列表、模型库与连接字段按需展开，减少配置页面的视觉负担
- 一个供应商可维护多个模型，支持添加、删除、设置默认模型；切换供应商时同步切换对应模型库
- 增加供应商连接测试，显示测试中、可达延迟和失败状态；添加新供应商后自动进入连接设置
- LLM 供应商支持紧凑的多模型列表，可添加、删除并选择默认模型，同时兼容旧版单模型配置
- CSS 拆分为首屏关键样式与延迟加载的功能样式，减少初始阻塞资源
- 工作区选择即时更新界面，持久化改用轻量 sidecar 并移出 UI 线程，避免长会话选择目录后停顿
- 修复图表实例、ResizeObserver 和 native 文件图标缓存的生命周期问题，降低长会话内存增长
- 生成图片/文档/工程时按最终交付物展示，隐藏临时辅助脚本和中间文件

## v1.9.5-beta4

**本地 beta4 构建：结果展示与历史会话体验优化**

- 生成图片、文档等最终交付物时隐藏 Agent 为完成任务临时生成的 Python、JavaScript、Shell 等辅助脚本；明确要求脚本时仍显示脚本卡片
- Coding 项目不再逐个铺开源码和配置文件，改为显示可点击的项目目录入口；实时生成和历史会话恢复使用同一展示规则
- 历史会话恢复改为分批渲染，减少逐条让帧和 Markdown 重复等待，提升长会话打开速度
- 工具卡片支持放大到整行，避免并行工具卡片分列时内容被挤压
- 修复执行大纲点击收起按钮时误触拖拽导致位置移动

## v1.9.5-beta2

**本地 beta2 构建：会话上下文与界面转录分离**

- V2 会话快照严格拆分 `modelContext`、`transcript` 和 `uiState`
- 历史会话通过独立转录投影恢复分析、思考、工具调用、计划评估和产物卡片
- 补充会话持久化与界面转录架构文档及兼容性优化路线
- 优化 beta2 前端生产构建：macOS WebView target 调整为 Safari 14，消除 Transformers.js / ONNX Runtime 的 BigInt target 警告；ECharts 按图表类型拆包，最大 ECharts chunk 从约 582KB 降至约 331KB；Mermaid parser 保持独立懒加载 chunk
- 完整 Bun 回归测试通过：67 个测试文件、1080 个测试全部通过，0 失败，共 3218 个断言

## v1.9.5-beta

**1.9.5 首个 beta 预览（发布流程验证）**

- 版本号升级至 1.9.5-beta，验证 beta 标签的发布流水线与更新链路
- 修复实时任务分析在推理模型下必现「分析未完成」：DeepSeek 等推理模型的思考链（reasoning_content）现在流入思考卡实时展示，并在 content 为空时兜底解析任务专属计划与意图评估；分析超时由固定 20 秒改为 60 秒总时限 + 30 秒空闲时钟，活跃流不再被提前切断
- 会话回放恢复实时分析内容：分析文本随会话持久化，历史消息回放重新显示分析思考卡（此前因分析从未成功生成而缺失）
- 修复询问天气等纯信息查询生成 weather.js / weather_raw.js 中间产物文件：提示词规则禁止信息查询写入文件，文件卡片对中间产物展示更克制

## v1.9.4

**执行大纲交互升级、文生图与 GUI 可靠性加固**

- 会话回放滚动可靠性验证：深入排查「恢复历史会话后拖动滚动条导致部分内容消失」，在真实 WKWebView 合成器下脚本化滚动逐项验证，恢复完成并稳定后的转录逐像素一致；移除 `#chat` 的 `contain: layout` 并修正末条气泡入场动画填充模式
- 文生图能力自动适配：接入支持 OpenAI 兼容 `/images/generations` 的模型/供应商（如 gpt-image-1 / dall-e-3，或模型名含 gpt-image/dall-e/cogview/flux 等）时，图片请求自动切换为真实图片渲染——以 `<img>` 卡片展示（多图并排、点击放大、原生保存对话框下载），图片随会话持久化、回放同样显示；模型不支持或工具失败时自动回退原 SVG 输出契约；自定义供应商设置新增「图片生成」开关与图片模型名，图片数据只经侧通道送达界面
- 执行大纲悬浮卡支持拖动重定位，位置按会话记忆自动恢复；收起态胶囊改为「当前第 n 步/共 n 步」数字 + 呼吸光圈；计划全部执行完后大纲正确显示全部勾选
- 计划卡/思考卡失败态如实展示「分析未完成」并给出通用执行步骤，不再静默回退为误导性的默认计划
- 工具输出结构化展示：JSON/YAML 输出与 JSON 型参数自动检测、美化并高亮
- CLI 终端线框图渲染：`mermaid` 与 `puml`/`plantuml` 围栏代码块自动转换为盒式线框图（box-drawing 字符、CJK 标签自适应宽度、流式即时替换），残缺代码块保持原文兜底
- 用户气泡双击全选整条消息（会话回放同样支持），assistant 气泡双击复制到剪贴板
- 全链路中止/超时加固：工作区解析、运行时探针、MCP 初始化、工作区扫描等预检均有超时与中止保护，Esc/停止可中断慢启动

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
