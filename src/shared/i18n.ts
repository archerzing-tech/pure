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
    'workspace.dropHint': '拖拽文件夹到窗口，松开即可切换工作区',
    'workspace.changeHint': '点击更换工作区',
    'workspace.pin': '固定',
    'workspace.unpin': '取消固定',
    'workspace.remove': '移除',

    // ── Clickable paths ──
    'path.open': '打开路径',
    'path.copied': '路径已复制',
    'path.openFailed': '无法打开路径',

    // ── Thinking card ──
    'thinking.thinking': '思考中',
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
    'input.placeholder': '尽情提问...',
    'input.placeholderDisabled': '请先在设置中配置 API Key',
    'input.streaming': '正在生成… (Esc 停止)',
    'input.queued': '已排队，生成完成后自动发送…',
    'input.send.title': '发送',
    'input.stop.title': '停止',

    // ── Settings Panel ──
    'settings.back.title': '返回聊天',
    'settings.title': '设置',
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

    // ── LLM Page ──
    'llm.title': 'LLM 提供商',
    'llm.desc': '配置 AI 模型提供商',
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

    // ── Permission dialog ──
    'permission.title': '需要权限确认',
    'permission.titleHigh': '⚠ 高风险操作确认',
    'permission.risk.low': '低风险',
    'permission.risk.medium': '中风险',
    'permission.risk.high': '高风险',
    'permission.deny': '拒绝',
    'permission.allowOnce': '允许一次',
    'permission.allowAlways': '始终允许(本次会话)',

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
    'workspace.dropHint': 'Drop a folder to switch workspace',
    'workspace.changeHint': 'Click to change workspace',
    'workspace.pin': 'Pin',
    'workspace.unpin': 'Unpin',
    'workspace.remove': 'Remove',

    // ── Clickable paths ──
    'path.open': 'Open path',
    'path.copied': 'Path copied',
    'path.openFailed': 'Could not open path',

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
    'input.placeholder': 'Ask pure anything...',
    'input.placeholderDisabled': 'Set API key in Settings to send…',
    'input.streaming': 'Generating… (Esc to stop)',
    'input.queued': 'Queued — will send when generation finishes…',
    'input.send.title': 'Send',
    'input.stop.title': 'Stop',

    // ── Settings Panel ──
    'settings.back.title': 'Back to chat',
    'settings.title': 'Settings',
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

    // ── LLM Page ──
    'llm.title': 'LLM Provider',
    'llm.desc': 'Configure your AI model provider',
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

    // ── Permission dialog ──
    'permission.title': 'Permission required',
    'permission.titleHigh': '⚠ High-risk action',
    'permission.risk.low': 'Low risk',
    'permission.risk.medium': 'Medium risk',
    'permission.risk.high': 'High risk',
    'permission.deny': 'Deny',
    'permission.allowOnce': 'Allow once',
    'permission.allowAlways': 'Always allow',

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
