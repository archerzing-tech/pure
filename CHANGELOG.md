# Changelog

All notable changes to **Pure**. Each release's section is shown as the GitHub
release summary when publishing (see `.github/workflows/release.yml`).

## v1.9.12

**机器级工具偏好 + sys_info 缓存 + 系统环境 PATH 增强**

- 工具偏好改为机器级全局作用域：agent 在任意项目验证过的工具（pnpm / uv / bun …）跨项目常驻注入，不再依赖查询语义命中；带平台维度（darwin / win32 / linux），跨 OS 不串台
- 旧版本按项目隔离写入的工具偏好自动一次性迁移进全局作用域（按工具去重、保留使用频率与取代链），升级无感
- 用户明说「记住用 X」的偏好同样进入机器级作用域；设置 → 记忆面板新增「机器级」标签
- sys_info 性能：静态字段（OS / 语言 / 时区 / 运行时）进程级缓存，动态字段（代理 / VPN / 可达性）按 TTL 刷新，启动时预热——首个工具调用不再等网络探测
- 系统环境探测增强：PATH 补齐 nvm / bun / volta / fnm / asdf / Homebrew 等用户级运行时目录，Finder 启动的 GUI 也能找到 node / bun / python3
- Windows 命令执行改走 PowerShell -EncodedCommand（base64 UTF-16LE），规避命令行引号转义损坏，失败命令正确报非零退出码
- 修复：原生文件图标命令（get_file_icon）此前未注册进 Tauri 命令表导致静默失效，现已注册
- 设置 → 供应商卡片与展开面板新增「供应商 ID」展示：每个 provider 的机器标识（如 deepseek-openai / ollama）以代码样式 chip 显示，点击即复制，可直接粘贴到代理直连例外列表（直连例外只影响应用内配置的代理，系统 VPN / 环境变量代理不在应用管辖范围）
- 修复：图片请求（如「画一只小鸟」）在无文生图能力的供应商下，模型有时会用 write_file 把图存成 .svg 文件而非输出 ```svg 代码块，导致聊天里只看到 SVG 源码 + 一个文件卡片，图片不渲染——现在 SVG 输出契约覆盖单图/多图并明确禁止 write_file 存图片、禁止非 svg 代码块；同时模型写出的 .svg 工件卡片会内联渲染缩略图，即使模型仍写文件也能在对话里看到图

## v1.9.11

**路径边界移除 + find_files 智能定位 + 空气质量/经济指标直查 + sys_info 地理信息增强**

- 文件工具路径边界移除：`resolve()` 不再把访问范围限制在工作区内，绝对路径可指向磁盘任意位置（工作区只是相对路径的默认基准）；保留悬空 symlink 拒绝、`..` 越过根目录报错等路径合法性防护；read_file/write_file/edit_file 的工具描述同步为「绝对路径任意位置可用」
- 新增 find_files 工具（Rust + Node 双实现）：智能定位最可能包含主题词的文件——先按文件名关键词短路（零成本）、无命中时才对剩余文件按体积升序做受限内容扫描（预算 max×6+20）；CJK 查询分词为二元组并过滤「的/了/我」等停用字，无分词边界的中文查询（「我的学历」→「学历」）也能命中；每个候选只附前 3 行片段，绝不返回全文
- web_public_api 新增两类零 key 直查：空气质量（北京 PM2.5/AQI，Open-Meteo）+ 世界银行经济指标（GDP/人均 GDP/人口/失业率/通胀，含中英文国家名词边界匹配）；「人口」需带计数信号才路由，避免误伤分析类问题
- 公开 API 目录注入提示词：内置 public-apis / n0shake 两个目录地址，当内置 web_search/web_public_api/web_scrape 都拿不到数据时，模型可自行去目录找 no-key 端点调用（天气/酒店/交通/旅游/行业等），绝不编造
- sys_info 新增地理位置字段：语言（macOS 读 AppleLocale）、时区（/etc/localtime 符号链接 → IANA 名）、编码（locale 字符集后缀）；IP 地理定位（ipwho.is → ipinfo.io → ip-api.com）返回**掩码 IP + 城市/省/国家/时区**，进程级缓存只请求一次（IP 属敏感信息，绝不透出完整地址）
- 修复：信息类请求（制定规划/查询）不再误渲染成「项目目录」卡片；天气无真实数据时不再输出空图表（新增「暂无数据可绘制图表」友好文案）；记忆面板「运行时诊断 / 导出导入」卡片 padding 对齐
- MCP 噪音消除：MCP 服务器的 stderr 不再实时打印（bunx 启动的 web-search 服务器会输出「Resolving dependencies」等良性进度），改为缓冲、仅在服务器请求中途退出时附在错误信息里报告

## v1.9.10

**网络搜索全面增强 + 本地文件读取/搜索重做 + 系统环境预取注入 + 进度同步修复**

- 网络搜索多后端（适配国内 / 内网 / 代理多种网络条件）：新增搜狗、360、百度、Brave、Bing-via-Jina（免 key 兜底）与 SearXNG（内网聚合，可在设置中配置 URL）后端，桌面端补齐此前缺失的搜狗；请求共享 cookie 会话并预热百度，降低反爬验证码触发；复杂查询自动归一化后重试（引号 / 括号 / 操作符导致失败不再直接报错）；中文查询 mkt=zh-CN，Bing 结果真实 URL 解码
- 系统环境预取注入提示词：sys_info 新增 network 行——系统代理 / 环境代理变量 / VPN 连接 / 国内+国际可达性探测，会话开始时动态注入，模型据此判断该走哪个搜索后端（如国际不通时优先 cn.bing / 搜狗 / 百度 / 360）
- 本地文件读取重做：格式感知文本提取——UTF-8 / UTF-16 / GBK（GB18030）/ Big5 编码自动识别，PDF（ToUnicode CMap 中文映射）、DOCX / XLSX / PPTX / ODT（ZIP+XML）、RTF 均可直接读取；二进制、扫描版 PDF、旧版 .doc/.xls 返回带解决办法的错误（转换命令 / OCR 提示），不再乱码或报裸异常
- 本地文件搜索增强：search_files 可搜索 PDF / Office 文档 / GBK 文本内容，支持大小写敏感开关、单文件直搜（模型把文件路径直接传给 search_files 时可用）、跳过文件时列出原因；路径错误提示修复方法，Windows 反斜杠路径自动兼容
- 计划进度同步修复：浮动大纲与计划卡片不再错位——最后计划的完成标记、模型跨计划跳跃、回合末总结收尾、无计划轮次清空大纲四种脱节场景全部修复
- 代理设置增强：代理方式支持「手动地址 / 系统代理透明转发」（后端按请求解析系统代理）；测试连接探测端点改为 3 个可开关、可编辑（国内可达优先）
- Skill Hub 增加搜索过滤与常用技能源下拉（Vercel / NVIDIA / You.com / Zapier / OpenClaw）

## v1.9.9-adv

**代理增强版：系统代理检测、配置持久化到文件、企业代理兼容**

- 代理地址配置拆分：设置 → 网络代理 的地址改为「协议下拉（http/https/socks5/socks5h）+ 主机 + 端口」三个独立字段；端口占位默认 8080；粘贴完整地址或 `host:port` 简写进主机框时自动拆解，内嵌凭证被剥离
- 读取系统代理：一键检测 macOS 系统设置（scutil）/ Windows 系统设置（注册表）/ 标准代理环境变量，回填三字段表单；系统代理未开启时自动探测常见本地代理端口（7897/7890/1080 等）兜底
- 强制 HTTP/1.1：修复网康（netentsec）等企业安全网关在 SSL 解密/MITM 下 ALPN 协商出 HTTP/2 导致握手失败的问题，与 curl 默认行为对齐
- 测试连接改进：探测端点改为国内可达（百度），失败时展开底层原因（连接被拒 / 超时 / DNS / 证书），不再只显示笼统的 "error sending request for url"
- 配置持久化：整套 GUI 配置写入 `~/.pure/config.json`（pretty JSON），启动时文件为 source of truth——GUI 保存即写回，有能力的用户可直接手改文件、重启生效；密钥 / 代理密码仍单独存 `~/.pure/secrets.json`
- 代理设置布局：地址行的标题与表单分两行显示，按钮与输入框等高对齐，不再越界

## v1.9.9

**正式版：代理地址拆分为协议/主机/端口三字段，Windows 中文字体渲染优化**

- 代理地址配置拆分：设置 → 网络代理 的地址改为「协议下拉（http/https/socks5/socks5h）+ 主机 + 端口」三个独立字段，不再要求手拼完整 URL；粘贴完整地址或 `host:port` 简写进主机框时自动拆解，内嵌的 `user:pass@` 凭证会被剥离（用户名/密码仍走各自字段），端口为空且主机带端口时自动补全
- 存储格式保持 `scheme://host:port` 不变，请求时凭证注入逻辑零改动；半输入状态不会因 URL 解析失败清空其他字段
- Windows 中文字体渲染优化：Windows 上恢复 Chromium 默认的 ClearType 亚像素抗锯齿（此前全局 grayscale AA 让中文小字号发虚）；字体栈补充 Microsoft YaHei / Microsoft JhengHei / PingFang SC / Segoe UI Variable，跨平台中文观感更锐利

## v1.9.8-beta

**本地 beta 构建：代理认证（用户名/密码）、代理密码安全存储、架构图重绘与稳定性修复**

- 代理支持认证：设置 → 网络代理 新增「用户名 / 密码」字段，HTTP / HTTPS / SOCKS5 / SOCKS5H 代理均可携带 Basic / SOCKS5 认证；凭证按 `scheme://user:pass@host` 内嵌，含特殊字符的密码经百分号编码后由 reqwest 正确解码回传
- 代理密码安全存储：桌面端密码写入 Rust 密钥库 `~/.pure/secrets.json`（0600，槽位 `proxy.password`），localStorage 只保留 `hasPassword` 标志——密码不再进入 WebView、也不明文落盘；用户名仍留在配置中
- 密码注入统一收敛到 Rust 侧：`build_http_client`（LLM / 搜索 / 抓取 / 图片 / MCP HTTP）、命令执行环境变量、stdio MCP 子进程均从密钥库解析并填入密码，WebView 不再拼装含密码的 URL
- 设置页密码框与 API Key 同体验：已保存时显示「已安全保存」占位且不回填真实值，清空并保存即吊销；历史明文密码在启动时惰性迁移进密钥库并擦除
- README 架构图重绘：按当前实现改为分层大块图（GUI/CLI 双表面 → 共享控制平面 requestWorkflow/PromptAssembler/adaptiveControl → Coding Agent → Harness → Engine → Adapter → Rust/Tauri IPC → 外部世界），侧边保留项目进化记忆，替代旧的「预检 + 循环 + 记忆」概念图
- 模型下拉只展示「已配置」的供应商（内置/自定义有 Key，或本地免 Key 端点），与设置页 LLM 卡片状态（已配置/未配置）一致
- 修复工具卡片放大/还原动画快速连点时，旧超时回调误清除新动画的问题（每行独立清理，弱引用持有）
- 修复 macOS 系统权限申请：定位权限改为轮询直到用户应答（或 60 秒超时）再返回状态；摄像头/麦克风复用已解析的媒体类型

## v1.9.7

**正式版：系统权限申请（macOS 原生弹窗）、LLM 供应商表单式配置、暗色模式修复、工具卡片过渡动画与技能生态**

- 新增：LLM 模型库「＋ 添加模型」按钮；「全部删除」按钮与连通性验证按钮同尺寸、同主题色；修复快速连点连通性测试出现两个对号
- 新增：工具卡片「放大到整行 / 还原卡片」FLIP 缓动过渡动画（0.32s，尊重 prefers-reduced-motion）
- 修复：Bash / 文件 / Git / 搜索类工具（终端面板）body 恢复深色控制台背景（亮色黑底 / 暗色 #141414），Web / sys_info 蓝色表面保持
- 新增：项目级安装开源技能 find-skills（vercel-labs/skills）；桌面 GUI list_app_skills 同步扫描项目 .agents/skills/（与 CLI 一致）；用户「生成 skill / MCP 工具」直接写入应用空间（~/.pure/skills/、~/.pure/tools/）

- 修复：暗色模式下 sys-info / web 工具结构化输出（JSON 高亮）的 token 颜色沿用亮色系深藏青，在深蓝表面 #1b3d61 上不可读——蓝色表面补齐暗色 hljs 调色板（与终端面板一致的 GitHub-dark 色系），亮色不变
- 新增：Settings → 通用 → 系统权限——地理位置 / 摄像头 / 麦克风三项，显示实时状态（彩色圆点：已授权 / 未请求 / 已拒绝 / 受限 / 关闭）
- 新增：点击「申请权限」触发 macOS 原生系统弹窗（CoreLocation requestWhenInUseAuthorization / AVFoundation requestAccess），由用户在系统弹窗中决定；已拒绝时提示去 系统设置 → 隐私与安全性 修改
- 新增：Info.plist 权限用途声明（NSLocationWhenInUseUsageDescription / NSCameraUsageDescription / NSMicrophoneUsageDescription）——没有这些声明 macOS 不会弹窗
- 非 macOS 平台自动隐藏该区块

- 展开面板重构为纵向表单：名称（60px 行）→ Base URL（60px，输入框更长）→ API Key + 连通性验证按钮（60px，文字上下居中、按钮等高）→ 模型列表（60px 表头）→ 模型行列表
- 模型列表改为**可编辑行**：默认至少 2 行、每行 50px，每行包含 2 个输入框——模型 ID（必填）+ 名称（可选）；点击圆点设为默认，× 删除（仅剩 1 个时禁用），回车提交新行，行内输入即时自动保存且不抢焦点
- 连通性验证按钮移到 API Key 行：用当前默认模型跑与真实对话相同的探针（桌面端 Rust reqwest / 浏览器 fetch 镜像），按钮短暂显示 ✓ / ✗
- 模型名称随配置持久化（内置供应商 `providerModelNames` / 自定义供应商 `modelNames`），默认模型下拉菜单同步显示 `模型ID · 名称`

- 设置 → LLM 全面重构：删除旧的「当前供应商 + 抽屉」结构，改为顶部默认模型横条 + 两列供应商卡片网格；没有「默认供应商」概念，只有「默认模型」——从横条下拉选择任一供应商的模型即成为新对话的默认模型（下拉按供应商分组，当前默认打勾）
- 默认内置 8 家供应商卡片：国内 5 家（DeepSeek `api.deepseek.com` / 通义千问 `dashscope.aliyuncs.com/compatible-mode/v1` / 智谱 GLM `open.bigmodel.cn/api/paas/v4` / Moonshot Kimi `api.moonshot.cn/v1` / MiniMax `api.minimaxi.com/v1`）+ 国外 3 家（OpenAI `api.openai.com/v1` / OpenRouter `openrouter.ai/api/v1` / NVIDIA NIM `integrate.api.nvidia.com/v1`），端点全部官方核实
- 每张卡片点击展开为全宽配置面板：供应商名称、Base URL（内置留空即官方端点）、API Key（每个供应商独立）、模型库多模型管理、图片生成（自定义供应商）；「保存」或 ✕ 收起为小卡片
- 模型库每个模型行带独立连通性测试按钮（复用 Rust 统一探测契约，传具体模型 id，无效模型名会报错）
- 可新增供应商：点击「＋ 新增供应商」立即展开空白配置面板，保存后成为一张普通卡片
- 内置供应商注册表扩展：Moonshot / MiniMax / OpenAI / OpenRouter / NVIDIA 转正为内置条目（含默认模型库），CLI 同步支持（`--provider` 新 id、各供应商独立 env key、`pure config` 列表）；OpenAI 内置默认开启文生图（gpt-image-1）
- v12 配置迁移：DeepSeek 视为一家，退役 `deepseek-anthropic` id——旧配置的模型库 / 覆盖项自动合并到 `deepseek-openai`（惰性迁移，无残留的配置不重写）
- Web 搜索 / 抓取 / 系统类工具（sys_info）的内容区统一为深一档的蓝色表面，与用户输入气泡同一蓝族（亮色 `#d6e4f6 → #c8daf0` 渐变 / 暗色 `#21486f → #1b3d61`，都比 `--bg-user` 深一档）；系统工具（Bash / 文件 / Git）终端面板同步蓝化（亮 `#cfdff4` / 暗 `#1e4168`），文字、字段名、链接、语法高亮按主题配套——暗色下修正 web 工具正文被亮色硬编码色覆盖导致对比度不足的问题
- **失败执行即刻降级、成功经验优先**：① 同会话——每次工具调用失败后，引擎在下一次思考前显式注入降级指令（「此调用已失败：禁止重复完全相同的调用，改用不同参数/工具/策略，优先本会话已证明可行的路径」），与失败策略的重试提示互补；② 跨会话——被放弃的**单一**失败调用（未重复、未恢复）也会在会话结束时沉淀为 `error_pattern`（「Failed during execution … Do not make this exact call again」），不再只记重复失败/致命失败；瞬态故障豁免保留（同一工具后来成功过则不记）；③ **检索锚点**——四类失败教训统一携带 `Symptom: <原始请求>` 前缀（错误文本本身与用户请求往往零关键词重叠，不加锚点新会话检索不到）；④ 成功经验优先——`successful_pattern` 教训从记忆库检索后以更高优先级注入 `<session_memory>`，排在错误教训之前（「Proven successful approaches (prefer these when the situation matches)」，错误清单改为 avoid-list 措辞），预算紧张时成功经验先于错误教训被保留；`<session_memory>` 系统提示同步更新指导文案
- Web 搜索 / 抓取 / 系统类工具内容区改为**纯色无边框**表面：亮色 `#c8daf0` / 暗色 `#1b3d61`（去掉渐变与 body 内框线，外层工具卡 frame 边框保留）
- 工具输出中的错误 / 告警文字改为**大红** `#ff4d4f`（stderr 流式行、error / warning token 高亮，两主题一致，在任何工具表面都醒目）
- 修复暗色模式下 System Info 工具正文难读：section 标签与字段名补上 `#9db4cf` 暗色覆盖（此前漏掉，落在 `--text-tertiary` 灰蓝上几乎看不见）；字段值保持 `#d8e8fb`
- 所有工具 header（summary）改为**透明**（亮/暗一致）：去掉 web 工具外层 frame 的底色（`#e2edf9` / `#1a3b5c` 之前从透明 header 透出，看起来像有色头条），header 现在直接落在聊天背景上，仅内容区保留蓝色表面与卡片边框

## v1.9.6

**正式版：内置供应商 per-provider 覆盖与官方端点修复、思考过程实时可视化、CLI Tier-2/3 Web 工具与能力审计清理**

- CLI 版本号改为编译时烘焙：新增 `scripts/build-cli.ts`，用 `--define process.env.PURE_CLI_VERSION` 把 package.json 版本注入二进制，banner 与启动行永不漂移；dev 运行直接读 package.json，硬编码常量仅作最后兜底
- 修复 Harness 事件流收尾顺序：checkpoint 持久化与记忆写入移到 `yield` 之前——消费者在 `Completed` 处 break 时不再丢失状态；`Interrupted` 快照回退到当前消息列表；新增回归测试锁定该行为
- 修复上下文压缩摘要对空 content 消息的空引用风险
- 自定义供应商配置提示精确化：Base URL 缺失时停在连接设置，只缺模型时自动打开模型库抽屉并聚焦输入框；启用成功后收起全部配置抽屉
- 修复内置供应商端点被全局残留 Base URL 劫持的问题：早期版本在「连接设置」填过的地址（如阿里百炼）会残留在全局字段里，导致所有供应商卡片与请求都显示/打到该地址；v10 迁移清空全局字段（非默认地址转入对应供应商的覆盖），请求层与设置面板不再读取它
- 内置供应商（DeepSeek / Qwen / GLM）支持 per-provider 覆盖：名称、Base URL（代理 / 镜像网关，留空即默认端点）与各自独立的 API Key（桌面端存入 `llm.apiKey.<id>` 独立密钥槽，与自定义供应商同一机制；浏览器模式存 override 条目）；设置面板对内置供应商同样开放名称与 Base URL 编辑行
- CLI 同步 per-provider 覆盖：`~/.pure/config.json` 的 `providerOverrides` 现在对内置供应商生效——名称（`pure config` 列表与启动行）、Base URL（DeepSeek / Qwen / GLM 各 adapter 工厂接受覆盖端点，Qwen 有覆盖时不再强制要求 `DASHSCOPE_WORKSPACE_ID`）、API Key（优先读 config 明文条目，桌面端 `hasApiKey` 时从 `~/.pure/secrets.json` 的 `llm.apiKey.<id>` 槽读取，与 GUI 共享同一份密钥）；`pure config` 重跑不再丢弃已有覆盖
- 内置供应商默认端点复核并全部对齐官方地址（DeepSeek `api.deepseek.com` / 百炼 `dashscope.aliyuncs.com/compatible-mode/v1` / 智谱 `open.bigmodel.cn/api/paas/v4`）；v11 迁移自动清理残留的默认值变体（带尾斜杠、大小写/空白变体、跨供应商交叉污染的注册表地址），每个内置卡片重新显示官方端点；设置面板保存 Base URL 时统一去除尾部斜杠
- README（中英）新增「优点 / 独特之处 / 与其他 coding agent 的差异」一览；架构图补充请求预检（intake → assess → probe → plan → confirm）与 GUI/CLI 共享控制平面；默认界面改用真实截图
- 思考过程实时可视化：思考卡片提前到 preflight 起点，全程展示「正在准备… → 正在读取工作区… → 正在分析你的请求… → 实时思考文字」；分析路径复用同一张卡不再叠加；取消 / 中断时自动移除——简单问题不再有 3-7 秒静默等待
- Web 工具卡片视觉升级：搜索 / 抓取 / 直查类工具（web_search / web_fetch / web_scrape / web_public_api）内容区（Input + Output）改为与主题一致的深蓝紫渐变表面（暗色 `#1E2340 → #161A31`、亮色 `#F2F0FC → #E9E5F7`），头部保持原蓝色层次；`web_scrape` / `web_public_api` 补全 web-tool 表面、名称 / 图标与参数摘要

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
