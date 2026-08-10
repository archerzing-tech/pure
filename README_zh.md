# Pure

**Pure** 是一个本地优先的 AI 编程助手，核心只有两个坚持：**用一个不会轻易停下来的闭环完成任务，用会进化但不会无限膨胀的记忆延续经验**。它可以读取、写入和编辑文件，执行 Shell 命令，并在配置 verifier 时验证结果，再把紧凑的项目经验带到下一次会话 — 这一切都通过快速的终端 CLI 或原生 macOS 桌面应用完成。

<p align="center">
  <img src="https://img.shields.io/badge/version-1.8.2-blue" alt="version">
  <img src="https://img.shields.io/badge/platform-macOS%20|%20Linux-lightgrey" alt="platform">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
</p>

---

## 更新日志

### v1.8.2

**SVG 查看器优化**

- **SVG 放大查看更可靠** — 生成的 SVG 预览会在其他图表处理完成前绑定双击事件，保留图形内部交互元素，并确保百分比尺寸 SVG 在全屏查看器中正常显示

### v1.8.1

**体验与平台支持**

- **跨平台原生文件图标** — 文件卡片在 macOS、Linux、Windows 上优先使用系统关联图标，不可用时安全降级为扩展名图标
- **文件写入按文件分组** — 侧边栏按文件合并写入记录，并显示最近写入时间和成功/失败状态
- **文件卡片细节优化** — 改进布局、文件类型语义配色、原生图标加载反馈、点击打开、键盘操作和减少动效支持

---

### v1.8.0

**新功能**

- **自定义供应商** — 可在 GUI 设置面板或 CLI `pure config` 中添加任意 OpenAI 兼容端点（Ollama、LM Studio、vLLM 等）；每个条目保存自己的 API Key，无密钥的本地端点完全不发送 `Authorization` 请求头
- **智能容错解析层** — LLM 输出的 JSON / Mermaid / SVG 格式错误时自动修复（尾逗号、单引号、未加引号的键、全角标点、label 引号/括号不配对、混入散文等），修复后重试解析，仍失败才交由用户处理
- **修复差异查看器** — 点击任意「已自动修复」徽章，可并排对比原始源码与修复后源码
- **原生文件图标** — 文件卡片在 macOS、Linux、Windows 上优先使用系统关联图标；Linux 未安装桌面 `gio` 工具或图标主题不可用时会安全降级

**改进**

- 修复层接入引擎：`Planner` 计划、`Verifier` 裁决、`SubagentOrchestrator` / `MCPClient` 工具参数解析前都会先修复（工具调用保留参数，不再静默降级为 `{}`）
- `repairJsonSource` 增加 BFS 候选预算（默认 200）——防御对抗性输入下修复队列膨胀

**清理与内部**

- 工具 schema 统一收拢到共享 `toolDefs` 模块（CLI / GUI / 引擎单一事实来源）
- 删除死代码：`quickSort`、`EventBus`、`ui/tools`、半成品 `FileWatcher`
- 修复 CLI 版本横幅（停留在 v1.3.1，现与发布版本同步）

---

## 界面截图与架构图

<p align="center">
  <img src="docs/screenshots/landing.png" alt="Pure 首页" width="720" />
  <br />
  <em>当前首页 — 工作区选择、任务输入框、模式/模型控制和状态栏</em>
  <br /><br />
  <img src="docs/screenshots/memory-settings.png" alt="Pure 记忆设置 — 遗忘速度、诊断和导入导出" width="720" />
  <br />
  <em>当前记忆工作区 — 遗忘速度、运行时诊断和记忆导入/导出控制</em>
  <br /><br />
  <img src="docs/screenshots/pure-loop-memory.svg" alt="Pure Agent Loop 与进化项目记忆" width="720" />
  <br />
  <em>架构图 — 证据驱动的执行闭环与会进化的项目记忆</em>
</p>

---

## Pure 和普通 coding agent 的不同

很多 coding agent 的介绍重点是“能调用哪些工具”。Pure 更关注的是：**工具调用之后，智能体是否继续验证、如何从失败中退出，以及下一次是否真的记住了经验**。

| | 基础工具调用助手 | Pure |
|---|---|---|
| **执行方式** | Prompt → 工具 → 回答 | 可持续运行的 `THINK → ACT → OBSERVE → VERIFY` 闭环，直到证据支持完成 |
| **失败处理** | 重试同一路径，或直接报错 | 递进式恢复：`retry → reflect → degrade → stop`，识别重复错误和逻辑陷阱 |
| **上下文** | 对话不断增长，或手动清空 | 检查点、上下文裁剪和项目级记忆共同保持下一轮聚焦 |
| **学习方式** | 用户下次重新解释偏好 | 从成功任务、失败工具和用户偏好提取紧凑经验；明确记录或导入的项目惯例也可以进入记忆 |
| **记忆卫生** | 旧上下文持续堆积 | 健康分、命中次数、取代和衰减推动记忆经历 `活跃 → 降级 → 休眠 → 删除` |

这不是声称其他 agent 的实现都完全一样，而是 Pure 的明确取舍：**执行是状态机，经验是需要维护的记忆库**。

### 1. Agent Loop：在完成之前先拿到证据

Pure 的引擎是一个流式五状态事件循环：

```text
THINK → ACT → OBSERVE ──┐
  ↑                     │
  └────────── VERIFY ←──┘
              │
          TERMINATE
```

- **THINK** — 结合当前请求、工具、预算和相关记忆，规划下一步。
- **ACT** — 在权限、文件锁保护下执行工具调用；只读工作可并行，写入工作串行。
- **OBSERVE** — 把工具结果作为证据放回工作上下文，而不是隐藏的副作用。
- **VERIFY** — 在宣布完成前运行已配置的 verifier；内置 CodingAgent/CLI 路径包含规则检查，集成方也可以提供自定义 verifier。验证失败会带着反思提示回到 THINK。
- **TERMINATE** — 配置 verifier 时在通过验证后完成；未配置 verifier，或预算、策略、用户中断要求停止时安全结束。

循环内置轮次、Token、工具调用次数和时间预算，支持生命周期 Hook 与失败恢复。相同调用连续失败会被识别为死路，智能体会被要求换方法，而不是重复撞同一面墙。

### 2. 会进化的项目记忆

Pure 的记忆不是第二份聊天记录。Harness 会把已完成会话压缩为可复用的记忆条目，例如：

- **用户偏好** — 从用户明确表达的语言、框架、工具链或代码风格中提取。
- **流程与成功模式** — 什么方法有效、为什么有效、如何验证；成功会话会同时写入一条完整经验和一条更短、可直接复用的流程。
- **项目惯例** — 明确记录或导入的工作区规则，并与工作区路径绑定，不会和其他仓库的记忆混在一起。
- **错误模式** — 失败路径、恢复方式，以及不应再次尝试的调用。

下一次遇到相似任务时，Pure 只检索最相关的记忆，并注入专用的 `<session_memory>` prompt 区段。GUI 与 CLI 都按项目隔离记忆，避免一个仓库的惯例悄悄污染另一个仓库。

检索优先使用本地 WASM embedding；模型、网络或运行时不可用时自动回退到关键词搜索。记忆通过多维健康分持续维护：新经验可以取代旧策略，长期闲置的条目则从活跃降级到休眠，最终删除。GUI 还提供诊断、遗忘速度设置，以及 JSON / Markdown 导入导出。

> **实际体验上的区别：** Pure 能记住“这个项目偏好什么”和“那个失败调用已经走不通”，但不会把整个上次会话原封不动塞回上下文。

### 功能特性

- **终端 CLI** — 一次性问答或交互式 REPL，支持流式输出
- **桌面 GUI** — 原生 macOS 应用（Tauri），Notion 风格侧边栏和设置面板
- **多供应商** — DeepSeek、Qwen（通义）、GLM（智谱），以及自定义 OpenAI 兼容端点
- **自纠错 Agent Loop** — THINK → ACT → OBSERVE → VERIFY → TERMINATE，带预算、Hook、锁和恢复策略
- **进化项目记忆** — 语义检索、关键词回退、衰减、取代、诊断和导入导出
- **子智能体编排** — 并行调度文件搜索、代码搜索、Web 研究等子智能体
- **MCP 协议** — 接入 Model Context Protocol 服务器，扩展工具能力
- **权限系统** — 四种模式：YOLO（自动批准）、NORMAL（写入时确认）、PLAN（只读）、DONT_ASK（静默阻止）
- **会话持久化** — 基于检查点的状态管理，支持会话恢复（`pure --resume`）
- **智能容错解析** — 在报错前自动修复 JSON、Mermaid 和 SVG
- **自动更新** — GUI 通过签名的 `.app.tar.gz` 产物检查并安装更新
- **多语言界面** — 支持英文 / 中文

> 📖 English docs → [README.md](README.md)

---

## 快速开始

### CLI

```bash
# 1. 安装 Bun (https://bun.sh)
curl -fsSL https://bun.sh/install | bash

# 2. 克隆项目并安装依赖
git clone https://github.com/archerzing-tech/pure.git
cd pure
bun install

# 3. 配置 API Key（保存到 ~/.pure/config.json）
bun run cli -- config

# 4. 开始使用
bun run cli -- "解释一下这个项目的架构"
```

也可以从 [Releases](https://github.com/archerzing-tech/pure/releases) 下载预编译的 CLI 二进制文件：

```bash
./pure "用 TypeScript 实现一个限流器"
./pure --workspace /path/to/project    # REPL 模式，可使用文件/命令工具
./pure --resume abc123                 # 恢复之前的会话
```

### GUI（macOS）

从 [Releases](https://github.com/archerzing-tech/pure/releases) 下载 `pure_*.dmg`，挂载后拖入 `/Applications`。或者从源码构建：

```bash
bun install
bun run gui          # 开发模式，带热重载
bun run gui:build    # 生产构建 → src-tauri/target/release/bundle/
```

---

## 架构

```
┌─────────────────────────────────────────────────┐
│                   桌面外壳                         │
│          (Tauri 2 · WebView · Vanilla TS)         │
├─────────────────────────────────────────────────┤
│  Coding Agent（编程智能体）                        │
│  Planner · Permission · Verifier · Subagents     │
├─────────────────────────────────────────────────┤
│  Harness（有状态会话管理器）                        │
│  StateManager · ContextEngine · StreamManager     │
├─────────────────────────────────────────────────┤
│  Agent-Event-Loop Engine（无状态 ReAct 循环）      │
│  思考 → 行动 → 观察 → 验证 → 终止                  │
├─────────────────────────────────────────────────┤
│  Adapter Layer（适配器层，所有 I/O）                │
│  LLM（DeepSeek/Qwen/GLM）· 工具 · 存储 · MCP     │
├─────────────────────────────────────────────────┤
│  Rust / Tauri IPC（操作系统能力）                   │
│  Shell PTY · 密钥存储 · HTTP/2                    │
└─────────────────────────────────────────────────┘
```

智能体核心使用 TypeScript 在 WebView 中运行。Rust（Tauri）提供操作系统级别的能力 — Shell PTY 流式输出、密钥存储访问和 LLM API 中继（确保 API Key 不会进入 JS 上下文）。

---

## 项目结构

```
pure/
├── src/
│   ├── cli.ts                    # CLI 入口（一次性 + REPL）
│   ├── engine/                   # 无状态 ReAct 事件循环
│   │   ├── AgentLoopEngine.ts    # 五状态循环，带预算 + 钩子
│   │   ├── BudgetManager.ts      # Token/轮次/时间 预算追踪
│   │   └── FailurePolicy.ts      # 递进式恢复策略：重试 → 反思 → 停止
│   ├── harness/                  # 有状态会话管理
│   │   ├── Harness.ts            # 会话生命周期 + 检查点持久化
│   │   ├── ContextEngine.ts      # 上下文窗口裁剪
│   │   ├── StateManager.ts       # 检查点保存/恢复
│   │   └── StreamManager.ts      # Token 流式输出 + UI 渲染
│   ├── coding-agent/             # 应用层
│   │   ├── CodingAgent.ts        # 智能体装配器
│   │   ├── Planner.ts            # 任务分析 + 计划生成
│   │   ├── ToolRegistry.ts       # 工具调度 + 权限门控
│   │   ├── PermissionManager.ts  # YOLO / NORMAL / PLAN 权限模式
│   │   ├── Verifier.ts           # 输出验证
│   │   └── SubagentOrchestrator.ts  # 并行子智能体调度
│   ├── adapter/                  # I/O 适配器（LLM、工具、存储、MCP）
│   │   ├── openai/               # OpenAI 兼容 API 适配器
│   │   ├── deepseek/             # DeepSeek Anthropic 风格适配器
│   │   ├── node/                 # 文件系统 + Shell 工具适配器
│   │   ├── mcp/                  # MCP 传输层（stdio、HTTP）
│   │   └── storage/              # FSStore + SQLiteStore
│   ├── ui/                       # WebView 界面（聊天、设置、Markdown）
│   └── shared/                   # 共享类型、i18n、记忆
├── src-tauri/                    # Rust / Tauri 后端
│   ├── src/                      # IPC 命令、会话管理器
│   └── tauri.conf.json           # 应用配置 + 更新密钥
├── scripts/                      # 构建、签名、部署脚本
├── system-prompt.md              # 智能体系统提示词（公开契约）
└── pure Spec.md                  # 架构主规范
```

---

## 配置

### 供应商 & API Key

通过 `pure config`（CLI）或设置面板（GUI）一次性配置。配置持久化在 `~/.pure/config.json`。

支持的供应商：

| 供应商 | CLI 参数 | 环境变量 |
|---|---|---|
| DeepSeek（OpenAI API） | `--provider deepseek-openai` | `DEEPSEEK_API_KEY` |
| DeepSeek（Anthropic API） | `--provider deepseek-anthropic` | `DEEPSEEK_API_KEY` |
| Qwen / DashScope | `--provider qwen` | `DASHSCOPE_API_KEY` |
| GLM / 智谱 | `--provider glm` | `ZHIPU_API_KEY` |

### 权限模式

| 模式 | 读取操作 | 写入 & Shell 命令 |
|---|---|---|
| **YOLO** | 自动批准 | 自动批准 |
| **NORMAL**（默认） | 自动批准 | 每次操作弹出确认 |
| **PLAN** | 允许 | 阻止 |
| **DONT_ASK** | 自动批准 | 静默阻止 |

---

## CLI 用法

```bash
# 一次性：提问或执行任务
pure "把认证模块重构为 JWT 方式"
pure "AgentLoopEngine.ts 是干什么的？"

# REPL：在当前目录启动交互式会话
pure --workspace .

# 恢复之前的会话
pure --resume session_1712345678901

# 单次覆盖供应商/模型
pure --provider qwen --model qwen3-coder-next "写一个 React 表单验证 Hook"

# REPL 命令
/exit       # 退出
/clear      # 清空对话上下文
Ctrl+C      # 取消当前生成（再按一次强制退出）
```

---

## 开发

```bash
# 安装依赖
bun install

# 类型检查
bun run typecheck

# 运行测试
bun test

# CLI（开发模式）
bun run cli

# GUI（开发模式，带热重载）
bun run gui

# 构建二进制文件
bun run cli:build          # → ./pure（独立 CLI 二进制）
bun run gui:build          # → .app + .dmg + .tar.gz（自动更新用）
```

### 构建发布版（macOS）

```bash
# 完整构建（含 Tauri 更新签名 + macOS 代码签名）
bun run build:gui:mac
```

项目包含 GitHub Actions 工作流（`.github/workflows/release.yml`），每次推送 `v*` 标签时会自动构建 CLI 和 GUI。

---

## 图表 DSL

聊天回复中的 ```` ```chart ```` 代码块会用极简 DSL 渲染为图表（柱状、横向柱状、折线或饼图）：

````markdown
```chart
type: line
title: 北京 vs 上海气温
unit: ℃
周一 25 27
周二 26 28
周三 24 26
```
````

除 `type:`/`title:`/`unit:` 外的每行是一条数据：单系列用 `标签 数值`，多系列用 `标签 数值1 数值2 …`。

### 多系列（表头 + 多列）

加上一行表头、且每行含两列以上数值时，**每列渲染为一条系列**——第一列是 x 轴标签，其余列名作为系列名。悬停某个类目时，tooltip 会联动显示所有系列在同一位置的数值对比。

````markdown
```chart
type: line
title: 三地气温对比
unit: ℃
日期 北京 上海 广州
周一 25 27 30
周二 26 28 31
周三 24 29 32
```
````

同样的数据结构也支持 **markdown 表格**（可含 `---` 分隔行）、**CSV** 或 **tab 分隔**：

````markdown
```chart
type: line
| 月份 | 电商 | 门店 | 批发 |
| --- | --- | --- | --- |
| 一月 | 120 | 80 | 60 |
| 二月 | 150 | 90 | 55 |
```
````

多系列同样适用于 `bar` / `hbar`；`pie` 恒用第一列作为数值（多系列会渲染成重叠圆环，已自动回退）。

### 规则与提示

- **类型**：`bar`、`hbar`、`line`、`pie` —— `type:` 行或裸首词均可；缺省为 `bar`。
- **系列名**：取自表头行；无表头时回退为 `系列1` / `系列2` / …。
- **数字开头的行**：首个数字 token 恒作为 x 轴标签——`2024 10 20` 表示年份是标签而非数据值。
- **单位**：`25℃`、`50%`、`1.2mm` 会被剥离并显示在 tooltip / 坐标轴。
- **JSON**：也接受 `{ "type": "pie", "data": [["a", 1], ["b", 2]] }` 形式。
- **交互**：双击任意图表可打开全屏缩放查看器；悬浮「下载图片」按钮可导出 PNG。
- 图表由懒加载的 echarts 构建（tree-shaken、SVG 渲染器）渲染，并自动跟随应用亮/暗主题。

---

## 自动更新

GUI 内置 Tauri 自动更新器。发布新版本时：

1. CI 构建产生 `pure.app.tar.gz` + `.sig`（minisign 签名）
2. 将产物托管在更新端点（`https://releases.pure.app/latest.json`）
3. 应用会轮询端点，提示用户安装更新

密钥生成和更新服务器配置详见 [SIGNING.md](SIGNING.md)。

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)
