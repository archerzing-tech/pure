# Changelog

All notable changes to **Pure**. Each release's section is shown as the GitHub
release summary when publishing (see `.github/workflows/release.yml`).

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