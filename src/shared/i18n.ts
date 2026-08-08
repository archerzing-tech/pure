// src/shared/i18n.ts
// Complete i18n translation system for pure UI

export type Language = 'zh-CN' | 'en';
export type I18nKey = string;

const translations: Record<Language, Record<string, string>> = {
  'zh-CN': {
    // ── Sidebar ──
    'sidebar.newChat': '+ 新对话',
    'sidebar.newChat.title': '新建对话 (⌘N)',
    'sidebar.sessions': '会话记录',
    'sidebar.noSessions': '暂无会话',
    'sidebar.settings.title': '设置 (⌘,)',
    'sidebar.delete.title': '删除',
    'sidebar.clearAll.title': '清空全部会话',

    // ── Workspace picker (user workspace space) ──
    'workspace.picker.title': '切换工作区',
    'workspace.none': '未设置工作区',
    'workspace.placeholder': '/path/to/project',
    'workspace.browse': '浏览…',
    'workspace.apply': '应用',
    'workspace.clear': '清除',
    'workspace.recent': '最近使用',
    'workspace.recentEmpty': '暂无最近工作区',
    'workspace.saved': '工作区已更新',
    'workspace.cleared': '工作区已清除',
    'workspace.browseTitle': '选择工作区文件夹',
    'workspace.dropHint': '拖拽文件或文件夹到窗口，松开即可导入或切换工作区',
    'workspace.changeHint': '点击更换工作区',
    'workspace.pin': '固定',
    'workspace.unpin': '取消固定',
    'workspace.remove': '移除',

    // ── Clickable paths ──
    'path.open': '打开路径',
    'path.copied': '路径已复制',
    'path.openFailed': '无法打开路径',
    'paste.openWithDefault': '用系统默认应用打开',
    'diagram.openViewer': '打开图像查看器',
    'diagram.viewControls': '图形视图切换',
    'diagram.loading': '正在渲染图形…',
    'diagram.renderFailed': '图形渲染失败',
    'diagram.retry': '重试',
    'diagram.plantumlAlt': 'PlantUML 图形',
    'diagram.missingTarget': '图形目标不存在',
    'diagram.timeout': '图形加载超时',
    'diagram.imageLoadFailed': 'PlantUML 图形加载失败',
    'diagram.download': '下载图片',
    'diagram.downloadError': '图片尚未生成',

    // ── Thinking card ──
    'thinking.thinking': '思考',
    'thinking.show': '查看思考过程',

    // ── Code block actions ──
    'codeBlock.copy': '复制',
    'codeBlock.copied': '已复制',
    'codeBlock.copyError': '复制失败',
    'codeBlock.save': '保存代码',
    'codeBlock.saved': '已保存',
    'codeBlock.savedTo': '已保存到',
    'codeBlock.saveError': '保存失败',

    // ── Main ──
    'main.toggleSidebar': '切换侧边栏',
    'main.rightSettings': '设置 (⌘,)',
    'landing.placeholder': '描述您的任务...',
    'landing.placeholderDisabled': '先描述任务，发送时再配置 API Key',
    'input.placeholder': '尽情提问...',
    'input.placeholderDisabled': '请先在设置中配置 API Key',
    'input.streaming': '正在生成… (Esc 停止)',
    'input.queued': '已排队，生成完成后自动发送…',
    'input.send.title': '发送',
    'input.stop.title': '停止',
    'input.attach.title': '附加文件',
    'input.copied': '已复制输入内容',
    'input.copyFailed': '复制输入内容失败',
    'assistant.copied': '已复制回复内容',
    'assistant.copyFailed': '复制回复内容失败',

    // ── Context panel ──
    'context.kicker': '项目上下文',
    'context.panel.ariaLabel': '项目上下文',
    'context.tabs.ariaLabel': '项目上下文视图',
    'context.title': '当前工作区',
    'context.tab.preview': '预览',
    'context.tab.changes': '变更',
    'context.tab.structure': '结构',
    'context.preview.live': '实时预览',
    'context.preview.caption': '智能体构建过程中，生成的界面会显示在这里。',
    'context.activity': '智能体活动',
    'context.changes.none': '暂无变更',
    'context.changes.count': '{n} 项变更',
    'context.changes.empty': '智能体编辑项目后，变更会显示在这里。',
    'context.projectMap': '项目结构',
    'context.workspace': '工作区',
    'context.status.waiting': '等待中',
    'context.status.updating': '更新中',
    'context.status.ready': '就绪',
    'context.stage.ready': '准备开始',
    'context.stage.next': '可以继续下一步',
    'context.stage.building': '正在构建项目',
    'context.show': '显示项目上下文',
    'context.hide': '隐藏项目上下文',
    'context.model.notConfigured': '未配置',
    'context.role.you': '你',
    'context.role.pure': 'pure',

    // ── Status footer ──
    'status.ready': '就绪',
    'status.generating': '正在生成…',

    // ── Settings Panel ──
    'settings.back.title': '返回聊天',
    'settings.title': '设置',
    'settings.categories': '设置分类',
    'settings.autosave': '更改会自动保存',
    'settings.close.title': '关闭 (Esc)',

    // ── Nav ──
    'nav.general': '通用',
    'nav.llm': 'LLM',
    'nav.tools': '工具',
    'nav.skills': '技能',
    'nav.mcp': 'MCP',
    'nav.appearance': '外观',
    'nav.updates': '更新',

    // ── General Page ──
    'general.title': '通用',
    'general.desc': '语言和渲染设置',
    'general.language': '语言',
    'general.language.hint': '界面语言',
    'general.streaming': '流式渲染',
    'general.streaming.hint': '逐字格式化助手的回复',

    // ── Environment (Settings → General) ──
    'env.title': '环境上下文',
    'env.city': '城市 / 位置',
    'env.city.hint': '回答问题时以它为位置基准（如旅行规划的出发地）',
    'env.city.placeholder': '如 上海 / Shanghai',
    'env.detect': '自动检测',
    'env.detect.hint': '通过 IP 定位所在城市（免费服务，精度到城市级）',
    'env.detectBtn': '检测',
    'env.detecting': '检测中…',
    'env.detected': '已检测到位置：{city}',
    'env.detectFailed': '自动检测失败，请手动填写',

    // ── LLM Page ──
    'llm.title': 'LLM 提供商',
    'llm.desc': '配置 AI 模型提供商',
    'llm.choose': '选择供应商',
    'llm.choose.hint': '选中的供应商将用于新的对话。',
    'llm.protocol.openai': 'OpenAI 兼容',
    'llm.protocol.anthropic': 'Anthropic 兼容',
    'llm.connection.kicker': '连接配置',
    'llm.active': '当前使用',
    'llm.selected': '已选择',
    'llm.chooseCard': '选择',
    'llm.provider': '提供商',
    'llm.provider.hint': 'AI 模型服务',
    'llm.apiKey': 'API Key',
    'llm.apiKey.hint': '您的 API 密钥',
    'llm.apiKey.placeholder': 'sk-...',
    'llm.apiKey.savedPlaceholder': '密钥已安全保存在系统中 (清空并保存以移除)',
    'llm.apiKey.toggle': '切换可见性',
    'llm.model': '模型',
    'llm.model.hint': '模型标识符',
    'llm.baseURL': 'Base URL',
    'llm.baseURL.hint': '自定义端点（可选）',
    'llm.baseURL.placeholder': '自动检测',

    // ── Provider options ──
    'provider.deepseek-openai': 'DeepSeek (OpenAI)',
    'provider.deepseek-anthropic': 'DeepSeek (Anthropic)',
    'provider.qwen': '通义千问 (Tongyi)',
    'provider.glm': '智谱 GLM (Zhipu)',

    // ── Tools Page ──
    'tools.title': '工具',
    'tools.desc': '可用工具集成',
    'tools.fs': '文件系统',
    'tools.fs.hint': '读、写、编辑、搜索',
    'tools.cmd': '命令执行',
    'tools.cmd.hint': '运行 Shell 命令',
    'tools.git': 'Git 集成',
    'tools.git.hint': '差异、日志、状态',
    'tools.browser': '网页工具',
    'tools.browser.hint': '网页搜索与抓取',
    'tools.serper': 'Serper.dev 搜索 API',
    'tools.serper.hint': '可选：填写 Serper 密钥以启用 Google 索引搜索（serper.dev 有 2500 次免费查询）——留空则回退到 Tavily / 免费后端',
    'tools.tavily': 'Tavily 搜索 API',
    'tools.tavily.hint': '可选：填写 Tavily 密钥以启用高质量搜索（tavily.com 有免费额度）——留空则回退到免费后端',
    'tools.permissionSection': '权限与审批',
    'tools.permissionMode': '权限模式',
    'tools.permissionMode.hint': '工具调用的审批策略',
    'tools.permissionMode.auto': '自动放行',
    'tools.permissionMode.confirm': '每次询问',
    'tools.permissionMode.restricted': '只读模式',
    'tools.perm.read': '自动放行读取',
    'tools.perm.read.hint': '文件读取、网页搜索/抓取',
    'tools.perm.write': '自动放行写入',
    'tools.perm.write.hint': '文件写入与编辑',
    'tools.perm.cmd': '自动放行命令',
    'tools.perm.cmd.hint': 'Shell 命令执行',
    'tools.perm.git': '自动放行 Git',
    'tools.perm.git.hint': 'Git 只读操作',

    // ── Skills Page ──
    'skills.title': '技能',
    'skills.desc': '启用或禁用智能体技能',
    'skills.code-review': '代码审查',
    'skills.code-review.desc': '审查代码正确性和风格',
    'skills.web-research': '网页搜索',
    'skills.web-research.desc': '搜索网页文档',
    'skills.memory': '记忆',
    'skills.memory.desc': '记住偏好和上下文',
    'skills.planning': '规划',
    'skills.planning.desc': '分解复杂任务',
    'hub.title': 'Skill Hub',
    'hub.desc': '浏览并从开源智能体技能中心（skills.sh 生态）安装技能',
    'hub.repoPlaceholder': 'vercel-labs/agent-skills（owner/repo 或完整 GitHub URL）',
    'hub.browse': '浏览',
    'hub.loading': '加载中…',
    'hub.installed': '已安装技能',
    'hub.installedBadge': '已安装',
    'hub.install': '安装',
    'hub.installing': '安装中…',
    'hub.remove': '移除',
    'hub.empty': '该仓库没有可用的技能',
    'hub.loaded': '找到 {n} 个技能，点击“安装”添加到下方列表',
    'hub.failed': '无法连接技能中心，请检查网络或仓库地址',
    'hub.bodyFailed': '无法获取技能 {s} 的内容（SKILL.md 不存在）',
    'hub.alreadyInstalled': '技能 {s} 已安装',
    'hub.installedToast': '已安装技能 {s}，启用后将在对话中生效',
    'hub.removed': '已移除技能',
    'hub.allSkills': '全部技能',

    // ── MCP Page ──
    'mcp.title': 'MCP 服务器',
    'mcp.desc': '连接模型上下文协议服务器以扩展工具',
    'mcp.empty': '暂无 MCP 服务器',
    'mcp.serverName.placeholder': '服务器名称（如 filesystem）',
    'mcp.transport.stdio': 'stdio（子进程）',
    'mcp.transport.http': 'http (SSE)',
    'mcp.command.placeholder': 'npx -y @anthropic/mcp-filesystem /路径',
    'mcp.url.placeholder': 'http://localhost:3000',
    'mcp.addBtn': '+ 添加 MCP 服务器',
    'mcp.saveBtn': '保存',
    'mcp.cancelBtn': '取消',
    'mcp.remove.title': '移除',
    'mcp.builtin': '内置',

    // ── Appearance Page ──
    'appearance.title': '外观',
    'appearance.desc': '自定义视觉风格',
    'appearance.theme': '主题',
    'appearance.theme.hint': '配色方案',
    'appearance.theme.light': '浅色',
    'appearance.theme.dark': '深色',
    'appearance.theme.system': '跟随系统',
    'appearance.fontSize': '字体大小',
    'appearance.fontSize.small': '小',
    'appearance.fontSize.medium': '中',
    'appearance.fontSize.large': '大',
    'appearance.density': '密度',
    'appearance.density.compact': '紧凑',
    'appearance.density.comfortable': '舒适',
    'appearance.density.spacious': '宽松',

    // ── Updates Page ──
    'updates.title': '更新',
    'updates.desc': '检查并安装更新',
    'updates.currentVersion': '当前版本',
    'updates.notChecked': '尚未检查',
    'updates.checkBtn': '检查更新',

    // ── Toast messages ──
    'toast.serverNameRequired': '请输入服务器名称',
    'toast.serverNameExists': '服务器名称已存在',
    'toast.commandRequired': 'stdio 传输需要命令',
    'toast.urlRequired': 'http 传输需要 URL',
    'toast.setApiKey': '请先在设置中配置 API Key (⌘,)',
    'toast.sendFailed': '发送失败',
    'toast.sessionsCleared': '已删除全部会话',
    'toast.deleteFailed': '删除失败',

    // ── Confirm dialogs ──
    'confirm.title': '确认',
    'confirm.cancel': '取消',
    'confirm.ok': '删除',
    'confirm.deleteSession': '确定删除此会话？',
    'confirm.deleteAllSessions': '确定删除全部会话？此操作不可撤销。',

    // ── Plan review dialog ──
    'plan.title': '任务计划确认',
    'plan.complex': '复杂任务',
    'plan.approve': '按计划执行',
    'plan.skip': '跳过计划,直接执行',
    'plan.cancel': '取消',
    'plan.progress.title': '📋 执行计划',
    'plan.progress.phases': '共 {n} 个阶段',
    'plan.mode.build': 'Build 模式',
    'plan.mode.plan': 'Plan 模式',
    'plan.mode.yolo': 'YOLO 模式',
    'plan.modeSwitch': '🧭 检测到复杂任务，切换为 {mode} 模式，正在生成执行计划…',
    'plan.modeActive': '🧭 已切换为 {mode} 模式，按计划分步执行',
    'plan.modeForced': '🧭 已按你的选择进入 {mode} 模式，正在生成执行计划…',
    'plan.modeNoWorkspace': '🧭 计划/构建模式需要先选择工作区，本次按普通对话继续',
    'plan.modeDisabled': '🧭 计划/构建模式已被禁用（设置 → Skills → Planning），本次按普通对话继续',

    // ── Composer quick selectors ──
    'composer.mode.title': '任务模式 — 自动:智能判断 · YOLO:直接执行 · 计划:先看计划再执行 · 构建:分阶段构建并汇报',
    'composer.mode.auto': '自动',
    'composer.mode.yolo': 'YOLO',
    'composer.mode.plan': '计划',
    'composer.mode.build': '构建',
    'composer.modeSaved': '模式已切换',
    'composer.model.title': '模型',
    'composer.modelSaved': '模型已切换',

    // ── Permission dialog ──
    'permission.title': '需要权限确认',
    'permission.titleHigh': '⚠ 高风险操作确认',
    'permission.risk.low': '低风险',
    'permission.risk.medium': '中风险',
    'permission.risk.high': '高风险',
    'permission.deny': '拒绝',
    'permission.allowOnce': '允许一次',
    'permission.allowAlways': '始终允许(本次会话)',

    // ── Paste chips ──
    'paste.memory': '应用临时空间（内存）',
    'paste.dblclickHint': '双击查看内容',
    'paste.clickHint': '点击查看内容',
    'paste.remove': '移除',
    'paste.removeLabel': '移除粘贴文件',
    'paste.close': '关闭',
    'paste.closeTitle': '关闭 (Esc)',
    'paste.truncated': '内容过长，仅显示前 {shown} 字符（共 {total} 字符）',
    'paste.truncatedFile': '文件过大，仅显示前 {shown}（文件共 {total}）',
    'paste.attachmentMarker': '[粘贴文件: {name} ({size})]',
    'paste.imageMarker': '[粘贴图片/截图: {name} ({size})]',
    'paste.loading': '图片加载中…',
    'paste.imageTooLarge': '图片超过 25MB，未添加',
    'paste.binaryInfo': '这是 {type} 文件，已保存到应用临时目录。可从上方路径打开。',
    'paste.unknownType': '未知类型',

    // ── Temp paste files (Settings → General) ──
    'tmp.title': '临时粘贴文件',
    'tmp.desc': '清理 ~/.pure/tmp 下超过 N 天的粘贴文件（不影响会话工作区文件）',
    'tmp.usage': '当前占用',
    'tmp.usageNone': '无粘贴文件',
    'tmp.daysHint': '保留天数',
    'tmp.cleanBtn': '清理',
    'tmp.cleaned': '已清理 {n} 个粘贴文件，释放 {size}',
    'tmp.nothing': '没有需要清理的粘贴文件',
    'tmp.cleanFailed': '清理失败',

    // ── Session list ──
    'session.loadError': '无法加载会话',
    'session.sessionDeleteBtn': '删除',
  },

  en: {
    // ── Sidebar ──
    'sidebar.newChat': '+ New chat',
    'sidebar.newChat.title': 'New chat (⌘N)',
    'sidebar.sessions': 'Sessions',
    'sidebar.noSessions': 'No sessions yet',
    'sidebar.settings.title': 'Settings (⌘,)',
    'sidebar.delete.title': 'Delete',
    'sidebar.clearAll.title': 'Delete all sessions',

    // ── Workspace picker (user workspace space) ──
    'workspace.picker.title': 'Switch workspace',
    'workspace.none': 'No workspace',
    'workspace.placeholder': '/path/to/project',
    'workspace.browse': 'Browse…',
    'workspace.apply': 'Apply',
    'workspace.clear': 'Clear',
    'workspace.recent': 'Recent',
    'workspace.recentEmpty': 'No recent workspaces',
    'workspace.saved': 'Workspace updated',
    'workspace.cleared': 'Workspace cleared',
    'workspace.browseTitle': 'Select workspace folder',
    'workspace.dropHint': 'Drop a file or folder to import it or switch workspace',
    'workspace.changeHint': 'Click to change workspace',
    'workspace.pin': 'Pin',
    'workspace.unpin': 'Unpin',
    'workspace.remove': 'Remove',

    // ── Clickable paths ──
    'path.open': 'Open path',
    'path.copied': 'Path copied',
    'path.openFailed': 'Could not open path',
    'paste.openWithDefault': 'Open with default app',
    'diagram.openViewer': 'Open image viewer',
    'diagram.viewControls': 'Diagram view controls',
    'diagram.loading': 'Rendering diagram…',
    'diagram.renderFailed': 'Diagram rendering failed',
    'diagram.retry': 'Retry',
    'diagram.plantumlAlt': 'PlantUML diagram',
    'diagram.missingTarget': 'Diagram target is missing',
    'diagram.timeout': 'Diagram loading timed out',
    'diagram.imageLoadFailed': 'PlantUML diagram failed to load',
    'diagram.download': 'Download image',
    'diagram.downloadError': 'Image not ready yet',

    // ── Thinking card ──
    'thinking.thinking': 'Thinking',
    'thinking.show': 'Show thinking',

    // ── Code block actions ──
    'codeBlock.copy': 'Copy',
    'codeBlock.copied': 'Copied',
    'codeBlock.copyError': 'Copy failed',
    'codeBlock.save': 'Save code',
    'codeBlock.saved': 'Saved',
    'codeBlock.savedTo': 'Saved to',
    'codeBlock.saveError': 'Save failed',

    // ── Main ──
    'main.toggleSidebar': 'Toggle sidebar',
    'main.rightSettings': 'Settings (⌘,)',
    'landing.placeholder': 'Describe your task...',
    'landing.placeholderDisabled': 'Describe your task; set an API key when you send',
    'input.placeholder': 'Ask pure anything...',
    'input.placeholderDisabled': 'Set API key in Settings to send…',
    'input.streaming': 'Generating… (Esc to stop)',
    'input.queued': 'Queued — will send when generation finishes…',
    'input.send.title': 'Send',
    'input.stop.title': 'Stop',
    'input.attach.title': 'Attach files',
    'input.copied': 'Input copied',
    'input.copyFailed': 'Could not copy input',
    'assistant.copied': 'Reply copied',
    'assistant.copyFailed': 'Could not copy reply',

    // ── Context panel ──
    'context.kicker': 'PROJECT CONTEXT',
    'context.panel.ariaLabel': 'Project context',
    'context.tabs.ariaLabel': 'Project context views',
    'context.title': 'Live workspace',
    'context.tab.preview': 'Preview',
    'context.tab.changes': 'Changes',
    'context.tab.structure': 'Structure',
    'context.preview.live': 'Live preview',
    'context.preview.caption': 'Your generated interface will appear here as the agent builds it.',
    'context.activity': 'AGENT ACTIVITY',
    'context.changes.none': 'No changes yet',
    'context.changes.count': '{n} change(s)',
    'context.changes.empty': 'Changes will collect here as the agent edits your project.',
    'context.projectMap': 'PROJECT MAP',
    'context.workspace': 'WORKSPACE',
    'context.status.waiting': 'Waiting',
    'context.status.updating': 'Updating',
    'context.status.ready': 'Ready',
    'context.stage.ready': 'Ready to build',
    'context.stage.next': 'Ready for next step',
    'context.stage.building': 'Building project',
    'context.show': 'Show project context',
    'context.hide': 'Hide project context',
    'context.model.notConfigured': 'Not configured',
    'context.role.you': 'You',
    'context.role.pure': 'pure',

    // ── Status footer ──
    'status.ready': 'Ready',
    'status.generating': 'Generating…',

    // ── Settings Panel ──
    'settings.back.title': 'Back to chat',
    'settings.title': 'Settings',
    'settings.categories': 'Settings categories',
    'settings.autosave': 'Changes save automatically',
    'settings.close.title': 'Close (Esc)',

    // ── Nav ──
    'nav.general': 'General',
    'nav.llm': 'LLM',
    'nav.tools': 'Tools',
    'nav.skills': 'Skills',
    'nav.mcp': 'MCP',
    'nav.appearance': 'Appearance',
    'nav.updates': 'Updates',

    // ── General Page ──
    'general.title': 'General',
    'general.desc': 'Language and rendering settings',
    'general.language': 'Language',
    'general.language.hint': 'Interface language',
    'general.streaming': 'Streaming render',
    'general.streaming.hint': 'Format assistant reply progressively',

    // ── Environment (Settings → General) ──
    'env.title': 'Environment',
    'env.city': 'City / location',
    'env.city.hint': 'Location baseline for answers (e.g. trip-planning departure point)',
    'env.city.placeholder': 'e.g. Shanghai',
    'env.detect': 'Auto-detect',
    'env.detect.hint': 'Detect city from your IP address (free service, city-level accuracy)',
    'env.detectBtn': 'Detect',
    'env.detecting': 'Detecting…',
    'env.detected': 'Location detected: {city}',
    'env.detectFailed': 'Auto-detection failed — set it manually',

    // ── LLM Page ──
    'llm.title': 'LLM Provider',
    'llm.desc': 'Configure your AI model provider',
    'llm.choose': 'Choose a provider',
    'llm.choose.hint': 'Your selected provider powers every new conversation.',
    'llm.protocol.openai': 'OpenAI compatible',
    'llm.protocol.anthropic': 'Anthropic compatible',
    'llm.connection.kicker': 'CONNECTION',
    'llm.active': 'Active',
    'llm.selected': 'Selected',
    'llm.chooseCard': 'Choose',
    'llm.provider': 'Provider',
    'llm.provider.hint': 'AI model service',
    'llm.apiKey': 'API Key',
    'llm.apiKey.hint': 'Your API key',
    'llm.apiKey.placeholder': 'sk-...',
    'llm.apiKey.savedPlaceholder': 'Key saved securely on this system (clear & save to remove)',
    'llm.apiKey.toggle': 'Toggle visibility',
    'llm.model': 'Model',
    'llm.model.hint': 'Model identifier',
    'llm.baseURL': 'Base URL',
    'llm.baseURL.hint': 'Custom endpoint (optional)',
    'llm.baseURL.placeholder': 'Auto-detected',

    // ── Provider options ──
    'provider.deepseek-openai': 'DeepSeek (OpenAI)',
    'provider.deepseek-anthropic': 'DeepSeek (Anthropic)',
    'provider.qwen': 'Qwen (Tongyi)',
    'provider.glm': 'GLM (Zhipu)',

    // ── Tools Page ──
    'tools.title': 'Tools',
    'tools.desc': 'Available tool integrations',
    'tools.fs': 'File System',
    'tools.fs.hint': 'Read, write, edit, search',
    'tools.cmd': 'Command Execution',
    'tools.cmd.hint': 'Run shell commands',
    'tools.git': 'Git Integration',
    'tools.git.hint': 'Diff, log, status',
    'tools.browser': 'Web Tools',
    'tools.browser.hint': 'Web search & fetch',
    'tools.serper': 'Serper.dev Search API',
    'tools.serper.hint': 'Optional: Serper key for Google-index web search (2500 free queries at serper.dev) — falls back to Tavily / free backends when empty',
    'tools.tavily': 'Tavily Search API',
    'tools.tavily.hint': 'Optional: Tavily key for high-quality web search (free tier at tavily.com) — falls back to free backends when empty',
    'tools.permissionSection': 'Permission & approval',
    'tools.permissionMode': 'Permission mode',
    'tools.permissionMode.hint': 'Tool call approval policy',
    'tools.permissionMode.auto': 'Auto-approve all',
    'tools.permissionMode.confirm': 'Ask each time',
    'tools.permissionMode.restricted': 'Read-only',
    'tools.perm.read': 'Auto-approve reads',
    'tools.perm.read.hint': 'File reads, web search/fetch',
    'tools.perm.write': 'Auto-approve writes',
    'tools.perm.write.hint': 'File writes & edits',
    'tools.perm.cmd': 'Auto-approve commands',
    'tools.perm.cmd.hint': 'Shell command execution',
    'tools.perm.git': 'Auto-approve git',
    'tools.perm.git.hint': 'Git read operations',

    // ── Skills Page ──
    'skills.title': 'Skills',
    'skills.desc': 'Enable or disable agent skills',
    'skills.code-review': 'Code Review',
    'skills.code-review.desc': 'Review code for correctness and style',
    'skills.web-research': 'Web Research',
    'skills.web-research.desc': 'Search the web for documentation',
    'skills.memory': 'Memory',
    'skills.memory.desc': 'Remember preferences and context',
    'skills.planning': 'Planning',
    'skills.planning.desc': 'Break down complex tasks',
    'hub.title': 'Skill Hub',
    'hub.desc': 'Browse and install skills from open-source agent skill hubs (skills.sh ecosystem)',
    'hub.repoPlaceholder': 'vercel-labs/agent-skills (owner/repo or full GitHub URL)',
    'hub.browse': 'Browse',
    'hub.loading': 'Loading…',
    'hub.installed': 'Installed skills',
    'hub.installedBadge': 'Installed',
    'hub.install': 'Install',
    'hub.installing': 'Installing…',
    'hub.remove': 'Remove',
    'hub.empty': 'No skills available in this repository',
    'hub.loaded': 'Found {n} skills — click Install to add them below',
    'hub.failed': 'Could not reach the skill hub — check your network or repo address',
    'hub.bodyFailed': 'Could not fetch skill {s} content (SKILL.md not found)',
    'hub.alreadyInstalled': 'Skill {s} is already installed',
    'hub.installedToast': 'Installed skill {s} — it will take effect in chat when enabled',
    'hub.removed': 'Skill removed',
    'hub.allSkills': 'All skills',

    // ── MCP Page ──
    'mcp.title': 'MCP Servers',
    'mcp.desc': 'Connect to Model Context Protocol servers for extended tools',
    'mcp.empty': 'No MCP servers configured',
    'mcp.serverName.placeholder': 'Server name (e.g. filesystem)',
    'mcp.transport.stdio': 'stdio (subprocess)',
    'mcp.transport.http': 'http (SSE)',
    'mcp.command.placeholder': 'npx -y @anthropic/mcp-filesystem /path',
    'mcp.url.placeholder': 'http://localhost:3000',
    'mcp.addBtn': '+ Add MCP Server',
    'mcp.saveBtn': 'Save',
    'mcp.cancelBtn': 'Cancel',
    'mcp.remove.title': 'Remove',
    'mcp.builtin': 'Built-in',

    // ── Appearance Page ──
    'appearance.title': 'Appearance',
    'appearance.desc': 'Customize the visual style',
    'appearance.theme': 'Theme',
    'appearance.theme.hint': 'Color scheme',
    'appearance.theme.light': 'Light',
    'appearance.theme.dark': 'Dark',
    'appearance.theme.system': 'System',
    'appearance.fontSize': 'Font Size',
    'appearance.fontSize.small': 'Small',
    'appearance.fontSize.medium': 'Medium',
    'appearance.fontSize.large': 'Large',
    'appearance.density': 'Density',
    'appearance.density.compact': 'Compact',
    'appearance.density.comfortable': 'Comfortable',
    'appearance.density.spacious': 'Spacious',

    // ── Updates Page ──
    'updates.title': 'Updates',
    'updates.desc': 'Check for and install updates',
    'updates.currentVersion': 'Current version',
    'updates.notChecked': 'Not checked yet',
    'updates.checkBtn': 'Check for Updates',

    // ── Toast messages ──
    'toast.serverNameRequired': 'Server name is required',
    'toast.serverNameExists': 'Server name already exists',
    'toast.commandRequired': 'Command is required for stdio transport',
    'toast.urlRequired': 'URL is required for http transport',
    'toast.setApiKey': 'Set an API key in Settings first (⌘,)',
    'toast.sendFailed': 'Send failed',
    'toast.sessionsCleared': 'All sessions deleted',
    'toast.deleteFailed': 'Failed to delete',

    // ── Confirm dialogs ──
    'confirm.title': 'Confirm',
    'confirm.cancel': 'Cancel',
    'confirm.ok': 'Delete',
    'confirm.deleteSession': 'Delete this session?',
    'confirm.deleteAllSessions': 'Delete all sessions? This cannot be undone.',

    // ── Plan review dialog ──
    'plan.title': 'Plan review',
    'plan.complex': 'Complex task',
    'plan.approve': 'Approve & execute',
    'plan.skip': 'Execute without plan',
    'plan.cancel': 'Cancel',
    'plan.progress.title': '📋 Execution plan',
    'plan.progress.phases': '{n} phases',
    'plan.mode.build': 'Build mode',
    'plan.mode.plan': 'Plan mode',
    'plan.mode.yolo': 'YOLO mode',
    'plan.modeSwitch': '🧭 Complex task detected — switched to {mode} mode, generating execution plan…',
    'plan.modeActive': '🧭 Switched to {mode} mode — executing the plan step by step',
    'plan.modeForced': '🧭 Entering {mode} mode as you selected — generating execution plan…',
    'plan.modeNoWorkspace': '🧭 Plan/Build mode needs a workspace first — continuing as a normal chat',
    'plan.modeDisabled': '🧭 Plan/Build mode is disabled (Settings → Skills → Planning) — continuing as a normal chat',

    // ── Composer quick selectors ──
    'composer.mode.title': 'Task mode — Auto: decide per task · YOLO: run directly · Plan: review a plan first · Build: build in phases',
    'composer.mode.auto': 'Auto',
    'composer.mode.yolo': 'YOLO',
    'composer.mode.plan': 'Plan',
    'composer.mode.build': 'Build',
    'composer.modeSaved': 'Mode switched',
    'composer.model.title': 'Model',
    'composer.modelSaved': 'Model switched',

    // ── Permission dialog ──
    'permission.title': 'Permission required',
    'permission.titleHigh': '⚠ High-risk action',
    'permission.risk.low': 'Low risk',
    'permission.risk.medium': 'Medium risk',
    'permission.risk.high': 'High risk',
    'permission.deny': 'Deny',
    'permission.allowOnce': 'Allow once',
    'permission.allowAlways': 'Always allow',

    // ── Paste chips ──
    'paste.memory': 'App temp space (memory)',
    'paste.dblclickHint': 'Double-click to view',
    'paste.clickHint': 'Click to view',
    'paste.remove': 'Remove',
    'paste.removeLabel': 'Remove pasted file',
    'paste.close': 'Close',
    'paste.closeTitle': 'Close (Esc)',
    'paste.truncated': 'Content too long — showing first {shown} characters (of {total})',
    'paste.truncatedFile': 'File is large — showing first {shown} (of {total})',
    'paste.attachmentMarker': '[Pasted file: {name} ({size})]',
    'paste.imageMarker': '[Pasted screenshot/image: {name} ({size})]',
    'paste.loading': 'Loading image…',
    'paste.imageTooLarge': 'Image over 25MB, not attached',
    'paste.binaryInfo': 'This is a {type} file. It was saved in the app temp directory; use the path above to open it.',
    'paste.unknownType': 'unknown type',

    // ── Temp paste files (Settings → General) ──
    'tmp.title': 'Temp pasted files',
    'tmp.desc': 'Delete pasted files older than N days in ~/.pure/tmp (session workspace files are untouched)',
    'tmp.usage': 'Current usage',
    'tmp.usageNone': 'No pasted files',
    'tmp.daysHint': 'Days to keep',
    'tmp.cleanBtn': 'Clean up',
    'tmp.cleaned': 'Cleaned {n} pasted files, freed {size}',
    'tmp.nothing': 'Nothing to clean',
    'tmp.cleanFailed': 'Cleanup failed',

    // ── Session list ──
    'session.loadError': 'Could not load sessions',
    'session.sessionDeleteBtn': 'Delete',
  },
};

let currentLanguage: Language = 'zh-CN';

export function setLanguage(lang: Language): void {
  currentLanguage = lang;
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function t(key: string, fallback?: string): string {
  return translations[currentLanguage]?.[key] ?? translations['en']?.[key] ?? fallback ?? key;
}

/**
 * Apply current language translations to all elements with data-i18n attributes.
 * - data-i18n → element.textContent
 * - data-i18n-placeholder → element.placeholder
 * - data-i18n-title → element.title
 * - data-i18n-label → <option> or <span> label text
 * - data-i18n-options → for <select> options (comma-separated keys)
 *   format: "optionValue1:key1,optionValue2:key2"
 */
export function applyTranslations(): void {
  // data-i18n → textContent
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n')!;
    el.textContent = t(key);
  });

  // data-i18n-placeholder → placeholder
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder')!;
    (el as HTMLInputElement).placeholder = t(key);
  });

  // data-i18n-title → title
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title')!;
    el.setAttribute('title', t(key));
  });

  // data-i18n-aria-label → accessible name for icon-only controls
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    const key = el.getAttribute('data-i18n-aria-label')!;
    el.setAttribute('aria-label', t(key));
  });

  // data-i18n-label → textContent for labels/spans (used for option text)
  document.querySelectorAll('[data-i18n-label]').forEach(el => {
    const key = el.getAttribute('data-i18n-label')!;
    el.textContent = t(key);
  });

  // data-i18n-options → <select> options
  // format: "optionValue1:key1,optionValue2:key2"
  document.querySelectorAll('[data-i18n-options]').forEach(el => {
    const mapping = el.getAttribute('data-i18n-options')!;
    const pairs = mapping.split(',').map(s => s.trim());
    const select = el as HTMLSelectElement;
    pairs.forEach(pair => {
      const [value, key] = pair.split(':').map(s => s.trim());
      const option = select.querySelector(`option[value="${value}"]`);
      if (option) {
        option.textContent = t(key);
      }
    });
  });
}

/**
 * Update the language setting and re-apply translations to the DOM.
 */
export function updateLanguage(lang: Language): void {
  setLanguage(lang);
  document.documentElement.lang = lang;
  applyTranslations();
}
