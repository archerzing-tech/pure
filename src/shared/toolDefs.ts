// src/shared/toolDefs.ts
// Canonical LLM-facing tool schemas + metadata for the built-in tools — the
// single source of truth shared by every runtime so the schemas the model sees
// never drift from what actually executes:
//   - CLI: NodeToolAdapter.getTools() (cli.ts advertises these directly)
//   - CLI/GUI permission layer: ToolRegistry derives BUILT_IN_TOOLS from these
//     (tags / riskLevel are permission-layer concerns, kept in ToolRegistry)
//   - GUI: TauriToolAdapter.TOOL_DEFINITIONS (getWebToolDefs/getSysInfoToolDefs)
// Descriptions are intentionally platform-neutral (e.g. web_search names no
// concrete backend order — Node and Rust probe different sets).

import type { ToolDefinition } from './types';

export const BUILT_IN_TOOL_DEFS: readonly ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace. Supports plain text/code (UTF-8, UTF-16, GBK/GB18030 Chinese Windows encoding), PDF (with ToUnicode CMap for Chinese fonts), DOCX/XLSX/PPTX/ODT, and RTF — binary/scanned files get an actionable error instead of mojibake. Optionally specify startLine and endLine to read a range.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path — relative paths resolve from the workspace root; absolute paths anywhere on disk work too (e.g. C:/tmp/a.docx, ~/Documents/notes.txt). The workspace is only the default base for relative paths, not a confinement boundary.' },
        startLine: { type: 'number', description: 'First line to read (1-indexed, optional)' },
        endLine: { type: 'number', description: 'Last line to read (1-indexed, optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the workspace. Parent directories are created automatically.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path — relative paths resolve from the workspace root; absolute paths anywhere on disk work too. The workspace is only the default base for relative paths, not a confinement boundary.' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in a file. Read the current file first; if the target is not found, re-read it and use shorter exact context instead of repeating the same edit. Line-ending differences are handled safely; approximate or fuzzy replacement is never used.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path — relative paths resolve from the workspace root; absolute paths anywhere on disk work too. The workspace is only the default base for relative paths, not a confinement boundary.' },
        oldString: { type: 'string', description: 'Exact string to find and replace' },
        newString: { type: 'string', description: 'Replacement string' },
        allowMultiple: { type: 'boolean', description: 'If true, replace all occurrences. Default: false' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for a text pattern inside files under the workspace (content search, not filename matching). Searches inside supported documents too: PDF, DOCX, XLSX, PPTX, ODT, RTF, and GBK-encoded text. Returns matching lines with file paths and line numbers; unreadable binary files are listed in a skip notice instead of being silently ignored.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text to search for (literal substring)' },
        path: { type: 'string', description: 'Directory to search in (relative to workspace), or a single file to search directly. Default: workspace root' },
        filePattern: { type: 'string', description: 'Glob to filter files. e.g. "*.ts", "*.{ts,js}", "*.pdf"' },
        maxResults: { type: 'number', description: 'Max results to return. Default: 50, max 500' },
        caseSensitive: { type: 'boolean', description: 'Match case exactly. Default: false' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'find_files',
    description: 'Smartly locate the files most likely to contain a topic or keyword (e.g. "学历", "education", "毕业证", "发票") without reading every file. Strategy: filename matches are ranked first (cheap, no content reads), then content hits across files are counted and the TOP candidate files are returned with a few snippet lines each (never full content). Works inside PDF/DOCX/XLSX/PPTX/ODT/RTF and GBK-encoded text. Use this FIRST when asked to find information spread across many files, then read_file only the top 1-2 candidates (optionally with startLine/endLine). Returns actionable fallback guidance when nothing matches.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The topic or keyword to find, e.g. "学历", "education", "毕业证". Fewer distinctive words work better than a long phrase.' },
        path: { type: 'string', description: 'Directory to search in (relative to workspace), or a single file to search directly. Default: workspace root' },
        filePattern: { type: 'string', description: 'Glob to filter files, e.g. "*.{ts,js}", "*.{docx,pdf}", "*.txt". Default: all files' },
        maxResults: { type: 'number', description: 'Top candidate files to return (default 10, max 30)' },
        caseSensitive: { type: 'boolean', description: 'Match case exactly. Default: false' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and directories in the workspace. Large results are capped and report when truncated.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list (relative to workspace). Default: workspace root' },
        recursive: { type: 'boolean', description: 'List recursively. Default: false' },
        maxResults: { type: 'number', description: 'Maximum entries to return (default 2000, hard max 5000)' },
      },
      required: [],
    },
  },
  {
    name: 'execute_command',
    description: 'Execute a shell command in the workspace directory. Returns stdout, stderr, and exit code. With background:true, starts a long-lived process (dev/static server, watcher) detached: returns {pid, logFile} immediately instead of waiting for exit.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        background: { type: 'boolean', description: 'Run detached without waiting for exit — required for dev/static servers, watchers, and any command that never exits. Verify afterwards with a bounded probe (curl the port), then report the URL.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'create_directory',
    description: 'Create a directory (and any missing parent directories) in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to workspace root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'diff_files',
    description: 'Show a unified diff between two files in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        pathA: { type: 'string', description: 'First file path relative to workspace' },
        pathB: { type: 'string', description: 'Second file path relative to workspace' },
      },
      required: ['pathA', 'pathB'],
    },
  },
  {
    name: 'researcher_web',
    description: 'Research a web question using search plus readable source evidence. Return cited sources, snippets, optional page content, retrieval time, and partial failures; prefer authoritative pages and do not repeat an unchanged query after a failure.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Natural-language research question to verify on the web' },
        maxSources: { type: 'number', description: 'Maximum cited sources (default 5, max 8)' },
        fetchContent: { type: 'boolean', description: 'Fetch readable content from the top sources (default true)' },
        maxCharsPerSource: { type: 'number', description: 'Maximum extracted characters per source (default 4000)' },
        allowedDomains: { type: 'array', items: { type: 'string' }, description: 'Optional host allowlist for returned sources' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'researcher_docs',
    description: 'Research an API or library from documentation-focused web sources. Include the library, topic, optional version, source URLs, exact evidence snippets, partial failures, and conservative official/version evidence status; do not rely on an unversioned guess when a version is supplied.',
    input_schema: {
      type: 'object',
      properties: {
        library: { type: 'string', description: 'Library, framework, SDK, or tool name' },
        topic: { type: 'string', description: 'Specific API, feature, error, or implementation question' },
        version: { type: 'string', description: 'Optional installed or required version' },
        maxSources: { type: 'number', description: 'Maximum cited documentation sources (default 5, max 8)' },
        fetchContent: { type: 'boolean', description: 'Fetch readable content from the top documentation sources (default true)' },
        maxCharsPerSource: { type: 'number', description: 'Maximum extracted characters per source (default 4000)' },
        allowedDomains: { type: 'array', items: { type: 'string' }, description: 'Optional host allowlist; official domains are preferred by the query' },
      },
      required: ['library', 'topic'],
    },
  },
  {
    name: 'code_searcher',
    description: 'Search repository source and configuration with ripgrep-style regex matching. Returns structured file paths, 1-indexed lines, columns, snippets, truncation state, and diagnostics. Respects gitignore while including relevant hidden project configuration.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal or regular-expression query' },
        path: { type: 'string', description: 'Directory or file scope relative to workspace (default workspace root)' },
        globs: { type: 'array', items: { type: 'string' }, description: 'Optional include/exclude globs, e.g. ["*.ts", "!*.test.ts"]' },
        caseSensitive: { type: 'boolean', description: 'Whether matching is case-sensitive (default true)' },
        maxResults: { type: 'number', description: 'Maximum matches per file (default 15, max 100)' },
        globalMaxResults: { type: 'number', description: 'Maximum matches across all files (default 250, max 1000)' },
        timeoutSeconds: { type: 'number', description: 'Hard search timeout in seconds (default 10, max 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_search',
    description: 'Legacy compatibility alias for researcher_web. Hidden from new model tool lists.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'number', description: 'Max results (default 10, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Legacy compatibility tool for fetching readable page text — follows meta-refresh redirects and falls back across Jina Reader / Wayback Machine / Firecrawl when the direct fetch is blocked or binary. Hidden from new model tool lists.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch (https://...)' },
        maxChars: { type: 'number', description: 'Max characters to return (default 20000)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_public_api',
    description: 'Structured-data lookup through curated no-key public APIs: weather, air quality, geocode, news, wiki, IP, FX, stock, GitHub, World Bank economic indicators (GDP / population / unemployment / inflation). Use for concrete factual lookups like "北京天气", "北京PM2.5", "中国GDP是多少", "100 usd to cny", or "苹果股价" — returns ready-to-use formatted data directly. When no structured source matches, it automatically falls back to web search (disable with searchOnMiss:false). Not for general discovery or ambiguous questions — use researcher_web for those.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The lookup question, e.g. "北京明天天气" or "100 usd to cny"' },
        category: { type: 'string', enum: ['weather', 'geocode', 'news', 'wiki', 'ip', 'fx', 'stock', 'github'], description: 'Optional intent override; defaults to automatic classification' },
        location: { type: 'string', description: 'Optional city for weather when the query has none (defaults to the configured location)' },
        searchOnMiss: { type: 'boolean', description: 'Fall back to web search when no structured source matches (default true)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_scrape',
    description: 'Fetch a KNOWN URL and extract readable text: strips navigation/boilerplate, supports an optional #id/.class/tag selector, auto-formats RSS/Atom feeds and JSON, follows meta-refresh redirects, extracts text-based PDFs directly, and falls back across Jina Reader (free) → Wayback Machine → Firecrawl (optional key) for blocked, removed, JS-heavy, or binary pages. Use when you already have the URL; use researcher_web when you need to find one.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch (https://...)' },
        selector: { type: 'string', description: 'Optional scope: #id, .class, or a tag name (article, main)' },
        maxChars: { type: 'number', description: 'Max characters to return (default 20000, max 50000)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'download_file',
    description: '下载网络资源（文件 / 压缩包 / 模型权重 / 数据集 / 安装包 / 图片 / 视频等）到本机。支持大文件、多线程加速、断点续传、暂停/继续；自动携带同源 Referer 与浏览器 UA 以绕过防盗链；优先采用服务器 Content-Disposition 文件名；失败依次换用 原生多线程 → curl → aria2c → wget → fetch 多种方式重试。当用户说"下载 xxx"或给出 http(s) 链接（如 http://example.com/a.zip）时使用。url 必填；destination 可为绝对路径，或 "downloads"（默认用户下载目录）/ "workspace"（当前项目目录）；filename 可指定文件名；connections 并行线程数（默认 4，服务器支持 Range 时启用分块加速）；resume 是否断点续传（默认 true）。完成后返回本机完整文件路径。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '资源 URL（以 http:// 或 https:// 开头）' },
        destination: { type: 'string', description: '保存目录：绝对路径，或 "downloads"（默认用户下载文件夹）/ "workspace"（当前项目目录）；留空则保存到用户下载目录' },
        filename: { type: 'string', description: '可选文件名，默认从 URL 推断' },
        connections: { type: 'number', description: '并行下载线程数（默认 4，仅当服务器支持 Range 时启用分块加速；设为 1 则单线程）' },
        resume: { type: 'boolean', description: '是否支持断点续传（默认 true）' },
      },
      required: ['url'],
    },
  },
  {
    name: 'glob_files',
    description: 'Find files matching a glob pattern. Returns sorted file paths relative to workspace.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts"' },
        path: { type: 'string', description: 'Directory to search within (default: workspace root)' },
        maxResults: { type: 'number', description: 'Max results (default 200)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'replace_files',
    description: 'Batch string replacement across multiple files. Replaces oldString with newString in each file independently.',
    input_schema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Array of file paths (relative to workspace) to process' },
        oldString: { type: 'string', description: 'Exact string to find and replace in each file' },
        newString: { type: 'string', description: 'Replacement string' },
        allowMultiple: { type: 'boolean', description: 'Replace all occurrences in each file. Default: false' },
      },
      required: ['files', 'oldString', 'newString'],
    },
  },
  {
    name: 'git_diff',
    description: 'Show git diff (unstaged changes). Set staged=true for staged changes.',
    input_schema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Show staged changes' },
        path: { type: 'string', description: 'Limit to a file path' },
      },
    },
  },
  {
    name: 'git_log',
    description: 'Show recent git commit history.',
    input_schema: {
      type: 'object',
      properties: {
        maxCount: { type: 'integer', description: 'Max commits (default 10)' },
        oneline: { type: 'boolean', description: 'One line per commit' },
      },
    },
  },
  {
    name: 'git_status',
    description: 'Show working tree status — modified, added, deleted, and untracked files.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'sys_info',
    description: 'Get operating system information: timezone (IANA name), language/locale, character encoding, public IP (masked — last octet redacted) with city-level geolocation, current time, OS version, network state (system/env proxy, VPN, domestic/international reachability), installed runtimes (node/bun/python3/rustc/git versions), and the user\'s configured location. When the user asks for the current time, date, timezone, language, OS version, network/proxy status, a runtime version, a git capability, or anything that depends on where the user is (trip planning, weather, local services), call sys_info() FIRST — never guess from your training data.',
    input_schema: { type: 'object', properties: {} },
  },
] as const satisfies readonly ToolDefinition[];

/** Side-effect / write classification per tool (same table the CLI and GUI
 * adapters used to maintain independently). */
export const PUBLIC_TOOL_NAMES = new Set([
  'read_file', 'write_file', 'edit_file', 'find_files', 'list_files', 'execute_command',
  'create_directory', 'diff_files', 'researcher_web', 'researcher_docs',
  'code_searcher', 'glob_files', 'replace_files', 'git_diff', 'git_log',
  'git_status', 'sys_info', 'generate_image', 'web_public_api', 'web_scrape', 'download_file',
]);

/**
 * Text-to-image tool schema. NOT part of BUILT_IN_TOOL_DEFS: it is only
 * advertised to the model when the connected provider/model supports image
 * generation (see imageGenEnabled / imageGenModelFor in providers.ts). When
 * unavailable, models answer image requests with ```svg blocks instead — the
 * SVG output contract is the automatic fallback (see promptLayers.ts).
 */
export const IMAGE_GEN_TOOL_DEF: ToolDefinition = {
  name: 'generate_image',
  description: 'Generate an image (PNG/JPEG) with the connected provider\'s text-to-image model and render it in the chat. Use this ONLY to CREATE new images from a text prompt — icon/logo/illustration/photo/poster requests ("创作一个小狗图标", "生成一张 xxx 图片"). This tool never explains or analyzes a picture: when the user attached an image and asks what it is / to describe or interpret it, answer directly from the attachment and do NOT call this tool. Never emit ```svg blocks for image requests while this tool is available — SVG is only for hand-drawn diagrams (flowcharts, architecture), and for falling back when this tool fails.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the image to generate. Describe subject, style, colors, composition, text to include, and aspect ratio as precisely as the user asked' },
      n: { type: 'integer', description: 'Number of images to generate (default 1, max 4)' },
      size: { type: 'string', description: 'Output size, e.g. 1024x1024, 1024x1792, 1792x1024 (provider-dependent; default 1024x1024)' },
    },
    required: ['prompt'],
  },
};

export function isPublicToolName(name: string): boolean {
  return PUBLIC_TOOL_NAMES.has(name);
}

export interface ToolSideEffectMetadata {
  sideEffects: boolean;
  isWrite: boolean;
}

/**
 * Per-tool side-effect metadata (drives the pre-write snapshot). The
 * `satisfies` guard makes completeness a COMPILE error: adding a built-in
 * tool to BUILT_IN_TOOL_DEFS without its entry here (or vice versa) fails
 * typecheck, mirroring the enforcement TOOL_TAGS already gets from
 * Record<BuiltinToolName, …> in ToolRegistry.ts. The export stays widened to
 * Record<string, …> so runtime lookups for MCP / dynamic tool names work.
 */
const TOOL_METADATA_TABLE = {
  read_file: { sideEffects: false, isWrite: false },
  write_file: { sideEffects: true, isWrite: true },
  edit_file: { sideEffects: true, isWrite: true },
  search_files: { sideEffects: false, isWrite: false },
  find_files: { sideEffects: false, isWrite: false },
  list_files: { sideEffects: false, isWrite: false },
  execute_command: { sideEffects: true, isWrite: true },
  git_diff: { sideEffects: false, isWrite: false },
  git_log: { sideEffects: false, isWrite: false },
  git_status: { sideEffects: false, isWrite: false },
  create_directory: { sideEffects: true, isWrite: true },
  diff_files: { sideEffects: false, isWrite: false },
  researcher_web: { sideEffects: false, isWrite: false },
  researcher_docs: { sideEffects: false, isWrite: false },
  code_searcher: { sideEffects: false, isWrite: false },
  web_search: { sideEffects: false, isWrite: false },
  web_fetch: { sideEffects: false, isWrite: false },
  web_public_api: { sideEffects: false, isWrite: false },
  web_scrape: { sideEffects: false, isWrite: false },
  glob_files: { sideEffects: false, isWrite: false },
  replace_files: { sideEffects: true, isWrite: true },
  sys_info: { sideEffects: false, isWrite: false },
  // Image generation hits a paid provider API but never touches the workspace.
  generate_image: { sideEffects: false, isWrite: false },
  download_file: { sideEffects: true, isWrite: true },
} satisfies Readonly<Record<(typeof BUILT_IN_TOOL_DEFS)[number]['name'], ToolSideEffectMetadata>>;

export const TOOL_METADATA: Readonly<Record<string, ToolSideEffectMetadata>> = TOOL_METADATA_TABLE;
