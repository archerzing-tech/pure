# Changelog

All notable changes to **Pure**. Each release's section is shown as the GitHub
release summary when publishing (see `.github/workflows/release.yml`).

## v2.2.6-alpha

**MCP resources 进上下文：服务器发布的只读文档自动可见**

- 连接 MCP 服务器时，若服务器在 initialize 握手声明了 `resources` 能力，客户端会列目录并读取内容（`resources/list` + `resources/read`），渲染成 `<mcp_resources>` 片段随系统提示一起发给模型 —— 服务器发布的文档（笔记、项目约定、数据集说明）不再要靠用户手动粘贴。根因：此前 pure 只消费 MCP 的 tools，资源的发现与读取整条链路缺失，模型对已连接服务器里的文档一无所知。
- 注入有硬上限：每个服务器最多 10 条、单条最多 2000 字符（超出截断并标注 `…[truncated]`）、单连接合计最多 8000 字符；只有文本类型（`text/*` 与 json/xml/yaml/javascript 等，MIME 缺失时按文本处理）会进提示词，只带 base64 `blob` 的二进制资源一律跳过。片段优先级与 skills 同为 30，预算紧张时最先被裁。
- 读取是连接完成后的后台预取，等待上限 3 秒，慢服务器不会拖住连上之后的第一轮；`resources/list` / `resources/read` 失败只记一条警告并放弃该服务器的资源，工具注册与连接状态不受影响（单个话痨/故障服务器不能拖垮整条连接）。
- 资源正文来自第三方服务器，注入时显式标注为「参考数据，非指令」，为后续投毒特征扫描留出位置。GUI 与 CLI 共用同一条装配路径（`PromptAssembler.mcpResources`）。

## v2.2.5

**上下文压缩钉住用户消息：追问轮不再丢失附件路径**

- 修复连续对话第二轮找不到之前上传文件的问题（Windows 上表现为 read_file 报“文件路径被截断了”，然后翻遍工作区也一无所获）。根因：后台上下文压缩按 20 条消息的窗口驱逐最老消息，把携带附件绝对路径的原始用户消息整体丢掉；小规模驱逐连摘要都不留，模型只能凭记忆拼路径。现在用户消息固定保留在压缩窗口内，assistant/工具消息对照旧受窗口约束；只有用户消息自身撑爆 token 预算时才按最老优先淘汰，且最新一条永不丢弃。
- 压缩摘要的每条消息摘录改为先剥掉 `<task_context>` 包装块再按头+尾截取（用户消息 2000 字符），附件路径位于消息尾部，摘要中始终可见，不再被包装块挤出摘录窗口。
- 其余变更同 v2.2.5-beta（见下节）。

## v2.2.5-beta

**PlantUML 全离线渲染 + MCP 传输资源释放 + 会话存储配额兜底**

- ```` ```puml ```` 代码块改为 WebView 内本地渲染（TeaVM 版 PlantUML 引擎 + 本地 Graphviz 布局），彻底取代断网/被墙时白屏的 plantuml.com 在线图片路线；引擎与 themes/emoji/openiconic 数据包保持懒加载，不用 PlantUML 的会话零开销。模型常见的不规范写法（缺 `@enduml`、嵌套代码围栏、裸语法体）自动归一化，不再渲染成空白卡片。
- 流式 HTTP MCP 传输：请求超时不再打印虚假的 unhandled rejection；超时/关闭时立即释放仍在读取的 SSE reader，不再吊着连接等 fetch 自身超时；新增回归测试覆盖超时路径并断言 reader 释放。
- stdio MCP 传输：进程退出与 close() 时关闭 readline 接口并清空 stderr 尾部缓冲，重连不再带上一个进程的报错尾巴。
- localStorage 会话写入遇到 QuotaExceededError 时自动降级为更短历史重试（40 条上限），不再整轮丢失；同时移除从未被读取的 `:pending` 暂存副本，峰值配额占用减半。
- 新增约定检查脚本（`lint:conventions`）并接入 CI；`node:*` 外部化警告按约定静默。

## v2.2.4

**子代理超时根治 + 会话与图表体验修复**

- 子代理委派不再被引擎通用的 3 分钟工具上限掐死：按角色声明的预算运行（生成型角色 30 分钟）；单段 10 分钟时间片耗尽改为携带完整记录自动续段继续干，而不是报错把失败甩回给父代理重新委派。
- 新增无进展看门狗：按活性杀、不按时长杀——5 分钟内无任何输出/状态/工具活动才判卡死中止（工具执行期间自动暂停），健康的慢任务不再被总时长误杀。
- 只读型子代理（评审 / 研究 / 深思）并行执行：四个并行时耗时从"之和"变成"最大值"；写文件、跑命令的代理保持串行不抢工作区。
- 右侧子代理活动卡全部保留至任务结束，同名多次委派以（1）（2）（3）编号区分。
- LLM 流式响应不再在 3 分钟处断流；连通性测试改走真实聊天路由，延迟不再随代理路由波动。
- 代理网络直连优先、按真实结果学习路由；请求可跨代理变更自愈（对向回退、失败换路）。
- 新建对话不再杀掉运行中的会话，转入后台继续跑；后台会话在侧边栏可见，随时切回。
- 图表 / 地图模块加载失败自动重载一次并指名模块；图表解析接受模型实际产出的形态，行解析失败有修复兜底；echarts+zrender 合并为单 vendor chunk。
- 编辑过的文件每轮必出路径卡；产物卡按轮次呈现；空对话不落库，启动时清理历史空行。
- 修复 create_document 生成 pptx 崩溃；Skill Hub 支持无索引集合浏览、安装对被墙主机更稳。

## v2.2.2-beta

**上下文窗口计量修复 + 产物卡片一致性修复**

- 上下文条改为显示 ContextEngine 压缩后的最新估算（即下一个请求真实携带的负载）；压缩生效时显示 `·压` 后缀、强调色与 tooltip（含原始大小与被剔除消息数）。
- 修复项目目录卡片的 live/restore 分歧：恢复时无条件按写入记录重建，导致完工项目刷新前不显示路径卡；现改为轮次正常结束且存在产物即渲染，交付判定保留在其独立状态气泡中，优化建议卡仍以真实交付为准。

## v2.2.2-alpha

**生成性子 agent 超时调整 + Agent 轨道与主题变量修复**

- 所有生成角色超时提升至 600s（task_planner / bash_executor 300s），与子 agent 预算上限对齐，ui_designer 等长任务不再因超时中断。
- 超时错误以人类可读单位提示（"3m" 而非 "180000ms"），并说明子 agent 仍在工作、重派同一子任务可从检查点继续，以及是否存在部分输出。
- Agent 轨道修复：bash_executor 作为工具不再渲染成 agent 卡片；移除「本轮协作/协作现场」标题块；轨道随窗口收缩（`clamp(160px, 12vw, 200px)`），窄屏下卡片更透明。
- 修复 `--surface` / `--fg` 主题变量未定义导致 var() 回退 #fff 的暗色模式下载卡片不可读问题。

## v2.2.1

**原生 Rust 下载器 + 界面流畅度修复**

- 用原生 Rust 下载器替换 GUI 侧 `download_file` 的 shell 管道，下载流程更稳定可靠。
- 修复 backdrop blur 导致的长列表滚动卡顿。
- 优化 agent 活动卡片的视觉细节与呈现。

## v2.2.1-beta

**原生 Rust 下载器 + 界面流畅度修复**

- 用原生 Rust 下载器替换 GUI 侧 `download_file` 的 shell 管道，下载流程更稳定可靠。
- 修复 backdrop blur 导致的长列表滚动卡顿。
- 优化 agent 活动卡片的视觉细节与呈现。

## v2.2.0

**复杂多步任务端到端稳定执行**

- 多步任务可一气呵成跑通，无需中途卡顿或人工干预。
- （详见 v2.1.0 以来的累积改进）

## v2.1.0

**Provider 协议支持与输入框布局优化**

- 新增 LLM wire protocol 支持（`openai` / `anthropic` / `auto`），Provider 可配置协议，并按 URL 自动检测。
- 新增 Anthropic 协议适配器（浏览器端 `DeepSeekAnthropicAdapter` + Rust `chat_stream` Anthropic 分支），MiniMax 切换到 Anthropic 协议端点。
- GLM 默认模型升级为 glm-5.3-flash，端点切换到 z.ai coding 网关，GLM 输出 token 预算提升至 32768。
- 输入框/composer 布局修复：移除固定 min-height、防止 flex 溢出，多行输入不再撑破输入栏。
- 动态信息插入协调器：新增无关请求排队、补充信息、约束变化、目标变化和停止请求的分类与调度。

## v2.1.0-beta

**定时任务、动态插入与侧栏交互修复**

- 修复添加定时任务后必须切换菜单才能看到新任务的问题。
- 修复删除定时任务后面板不会立即更新的问题。
- 左侧菜单返回按钮箭头改为向右。
- 增加动态信息插入协调器，区分无关请求、补充信息、约束变化、目标变化和停止请求。
- 相关插入会中止当前回合并重新评估，无关请求会排队等待当前任务结束。

## v2.1.0-alpha

**长对话与多 Agent 执行可视化增强**

- 多 Agent 执行期间显示当前活跃 agent、阶段、工具和完成状态，并支持历史恢复。
- 长对话按用户轮次分组；历史轮次按需加载，控制 live DOM 数量。
- 实时对话保留当前轮和最近轮次，较早轮次可展开恢复，避免超长会话无限增长。
- 增加 200 轮会话恢复、SessionEvent 顺序、计划进度、会话切换和自动续跑中断验收。

## v2.0.2

**Vite 构建优化 + 构建警告抑制 + ANSI 剥离 + 上下文面板 overlay 重构 + 多 Agent 浮动卡片 + 规划预告**

- **ANSI 转义序列全链路剥离**：Rust（`lib.rs strip_ansi`）与 TypeScript（`shared/ansi.ts stripAnsi`）双端实现，覆盖 CSI / OSC / 单字节 ESC 序列与 C0 控制字符；在 `extract_file_text`、`execute_command`（stdout+stderr）、`decodeTextBytes`、`NodeToolAdapter` 命令捕获、`renderMarkdown` 五处统一拦截——终端彩色输出、日志色码不再渲染为乱码或污染模型上下文
- **上下文面板 overlay 化**：`#context-panel` 从 flex 布局改为 `position: absolute`（z-index:30），对话列 `#chat` 右侧常驻 328px 保护槽——面板展开/收起不再触发对话列回流，设置按钮、模态框等上层元素 z-index 不冲突
- **多 Agent 活动卡片重构**：移除右侧 `.agent-rail` 侧边栏与阶段流水线可视化，改为 `position: fixed` 浮动卡片（`.agent-float-card`）；卡片随子 agent 生命周期自动出现、任务完成后 ~1s 渐隐移除；不占用 flex 空间，不持久化，历史回放不显示
- **自适应策略预告**：`Harness` 新增 `getAdaptiveStrategy()` 暴露当前轮次的 `recommendedRoles`；首次引擎事件时在对话流中插入一行「🔀 本任务计划用这些子 agent：规划(task_planner) → 实现(code_editor) → …」，让用户对多 agent 编排一目了然
- **Vite 构建警告抑制**：在 `vite.config.ts` 的 `rollupOptions.onwarn` 中过滤 `node:*` externalization 警告——`conventions.ts` 和 `backgroundCommand.ts` 的动态导入/保护式 require 是有意为之的浏览器安全设计，警告属噪声
- **pure-onnx-wasm-assets 插件性能优化**：`transform` 钩子将 10 次顺序 `replaceAll` 合并为 2 次正则遍历；`writeBundle` 钩子新增 `dirEntries`/`fileCache` 缓存，消除重复 `readdirSync`/`readFileSync` I/O
- **.gitignore**：新增 `pure.exe`、`NUL`，防止构建产物与 Windows NUL 设备文件被误提交

## v2.0.1