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
    description: 'Read a file from the workspace. Optionally specify startLine and endLine to read a range.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
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
        path: { type: 'string', description: 'File path relative to workspace root' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace a string in a file. Must provide exact oldString and newString to locate the replacement target.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        oldString: { type: 'string', description: 'Exact string to find and replace' },
        newString: { type: 'string', description: 'Replacement string' },
        allowMultiple: { type: 'boolean', description: 'If true, replace all occurrences. Default: false' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for a pattern in files under the workspace. Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern to search for' },
        path: { type: 'string', description: 'Directory to search in (relative to workspace). Default: workspace root' },
        filePattern: { type: 'string', description: 'Glob to filter files. e.g. "*.ts", "*.{ts,js}"' },
        maxResults: { type: 'number', description: 'Max results to return. Default: 50' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and directories in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list (relative to workspace). Default: workspace root' },
        recursive: { type: 'boolean', description: 'List recursively. Default: false' },
      },
      required: [],
    },
  },
  {
    name: 'execute_command',
    description: 'Execute a shell command in the workspace directory. Returns stdout, stderr, and exit code.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
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
    name: 'web_search',
    description: 'Search the web and return results with titles, snippets, and URLs. With a Serper or Tavily API key configured (Settings → Tools, or the SERPER_API_KEY / TAVILY_API_KEY env vars in the CLI) searches go through the API backends first (Serper = real Google index, best for Chinese and English); otherwise free HTML backends are probed in parallel — the first backend to return relevant results wins, and the exact backend set varies by platform and query language. If a search returns no results or fails, do NOT repeat the same or a near-identical query — rephrase it (broader terms, simpler wording, or English), or use web_fetch on a URL you expect to be authoritative.',
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
    description: 'Fetch a URL and extract readable text content (strips HTML, scripts, and styles). Works on text/HTML/JSON pages; if it reports an unsupported content type, do NOT retry the same URL — use web_search instead or pick a different page.',
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
    description: 'Get operating system information: timezone, language, current time, OS version, installed runtimes (node/bun/python3/rustc/git versions), and the user\'s configured location. When the user asks for the current time, date, timezone, language, OS version, a runtime version, a git capability, or anything that depends on where the user is (trip planning, weather, local services), call sys_info() FIRST — never guess from your training data.',
    input_schema: { type: 'object', properties: {} },
  },
] as const satisfies readonly ToolDefinition[];

/** Side-effect / write classification per tool (same table the CLI and GUI
 * adapters used to maintain independently). */
export const TOOL_METADATA: Readonly<Record<string, { sideEffects: boolean; isWrite: boolean }>> = {
  read_file: { sideEffects: false, isWrite: false },
  write_file: { sideEffects: true, isWrite: true },
  edit_file: { sideEffects: true, isWrite: true },
  search_files: { sideEffects: false, isWrite: false },
  list_files: { sideEffects: false, isWrite: false },
  execute_command: { sideEffects: true, isWrite: true },
  git_diff: { sideEffects: false, isWrite: false },
  git_log: { sideEffects: false, isWrite: false },
  git_status: { sideEffects: false, isWrite: false },
  create_directory: { sideEffects: true, isWrite: true },
  diff_files: { sideEffects: false, isWrite: false },
  web_search: { sideEffects: false, isWrite: false },
  web_fetch: { sideEffects: false, isWrite: false },
  glob_files: { sideEffects: false, isWrite: false },
  replace_files: { sideEffects: true, isWrite: true },
  sys_info: { sideEffects: false, isWrite: false },
};
