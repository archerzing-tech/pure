# Changelog

All notable changes to **Pure**. Each release's section is shown as the GitHub
release summary when publishing (see `.github/workflows/release.yml`).

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