// src/adapter/node/NodeToolAdapter.ts
// v0.4 — 6 file/command tools: read_file, write_file, edit_file, search_files, list_files, execute_command.
// Fixes: handleWriteFile uses proper fs.mkdir() instead of fragile .ensure hack.

import { resolve as pathResolve, relative as pathRelative } from 'node:path';
import { mkdir } from 'node:fs/promises';

import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../../shared/types';

export interface NodeToolConfig {
  workspace: string;
  commandTimeout?: number;
  maxFileSize?: number;
}

export class NodeToolAdapter implements ToolAdapter {
  private workspace: string;
  private commandTimeout: number;
  private maxFileSize: number;

  private tools: ToolDefinition[] = [
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
      description: 'Replace a string in a file. Must provide exact oldString to locate the replacement target.',
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
      description: 'Search the web and return results with titles, snippets, and URLs. Chinese-priority backends (cn.bing.com → DuckDuckGo → Bing) — no API key needed.',
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
      description: 'Get operating system information: timezone, language, current time, and OS version.',
      input_schema: { type: 'object', properties: {} },
    },
  ];

  constructor(config: NodeToolConfig) {
    this.workspace = config.workspace.endsWith('/')
      ? config.workspace.slice(0, -1)
      : config.workspace;
    this.commandTimeout = config.commandTimeout ?? 30000;
    this.maxFileSize = config.maxFileSize ?? 1_048_576; // 1MB
  }

  getTools(): ToolDefinition[] {
    return this.tools;
  }

  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean } | undefined {
    const meta: Record<string, { sideEffects: boolean; isWrite: boolean }> = {
      read_file: { sideEffects: false, isWrite: false },
      write_file: { sideEffects: true, isWrite: true },
      edit_file: { sideEffects: true, isWrite: true },
      search_files: { sideEffects: false, isWrite: false },
      list_files: { sideEffects: false, isWrite: false },
      execute_command: { sideEffects: true, isWrite: true },
      create_directory: { sideEffects: true, isWrite: true },
      diff_files: { sideEffects: false, isWrite: false },
      web_search: { sideEffects: false, isWrite: false },
      web_fetch: { sideEffects: false, isWrite: false },
      glob_files: { sideEffects: false, isWrite: false },
      replace_files: { sideEffects: true, isWrite: true },
      git_diff: { sideEffects: false, isWrite: false },
      git_log: { sideEffects: false, isWrite: false },
      git_status: { sideEffects: false, isWrite: false },
      sys_info: { sideEffects: false, isWrite: false },
    };
    return meta[toolName];
  }

  async execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const start = Date.now();
    const args = safeParseArgs(toolCall.function.arguments);

    try {
      switch (toolCall.function.name) {
        case 'read_file': return this.handleReadFile(args, start);
        case 'write_file': return this.handleWriteFile(args, start);
        case 'edit_file': return this.handleEditFile(args, start);
        case 'search_files': return this.handleSearchFiles(args, start);
        case 'list_files': return this.handleListFiles(args, start);
        case 'execute_command': return this.handleExecuteCommand(args, signal, start);
        case 'create_directory': return this.handleCreateDirectory(args, start);
        case 'diff_files': return this.handleDiffFiles(args, start);
        case 'web_search': return this.handleWebSearch(args, start);
        case 'web_fetch': return this.handleWebFetch(args, signal, start);
        case 'glob_files': return this.handleGlobFiles(args, start);
        case 'replace_files': return this.handleReplaceFiles(args, start);
        case 'git_diff': return this.handleGitCmd(args, ['diff', ...(args.staged ? ['--staged'] : []), ...(typeof args.path === 'string' ? ['--', args.path as string] : [])], signal, start);
        case 'git_log': return this.handleGitCmd(args, ['log', '-n', String(args.maxCount ?? 10), ...(args.oneline !== false ? ['--oneline'] : [])], signal, start);
        case 'git_status': return this.handleGitCmd(args, ['status', '--short'], signal, start);
        case 'sys_info': return this.handleSysInfo(start);
        default:
          return this.fail(toolCall, start, `Unknown tool: ${toolCall.function.name}`);
      }
    } catch (err: any) {
      return this.fail(toolCall, start, err?.message ?? String(err));
    }
  }

  // ── Tool handlers ──

  private async handleReadFile(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const path = this.resolve(String(args.path));
    const file = Bun.file(path);

    if (!(await file.exists())) {
      return this.fail(null!, start, `File not found: ${String(args.path)}`);
    }

    const size = file.size;
    if (size > this.maxFileSize) {
      return this.fail(null!, start, `File too large: ${(size / 1024 / 1024).toFixed(1)}MB (max ${this.maxFileSize / 1024 / 1024}MB)`);
    }

    let text = await file.text();
    const lines = text.split('\n');

    const startLine = typeof args.startLine === 'number' ? Math.max(1, args.startLine) : 1;
    const endLine = typeof args.endLine === 'number' ? Math.min(args.endLine, lines.length) : lines.length;

    if (startLine > 1 || endLine < lines.length) {
      text = lines.slice(startLine - 1, endLine).join('\n');
    }

    return {
      id: `tool_${Date.now()}`,
      toolName: 'read_file',
      result: text,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleWriteFile(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const path = this.resolve(String(args.path));
    const content = String(args.content);

    // Ensure parent directory exists
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (dir) {
      await mkdir(dir, { recursive: true });
    }

    await Bun.write(path, content);

    return {
      id: `tool_${Date.now()}`,
      toolName: 'write_file',
      result: `Wrote ${content.length} bytes to ${String(args.path)}`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleEditFile(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const path = this.resolve(String(args.path));
    const oldStr = String(args.oldString);
    const newStr = String(args.newString);
    const allowMultiple = Boolean(args.allowMultiple);

    const file = Bun.file(path);
    if (!(await file.exists())) {
      return this.fail(null!, start, `File not found: ${String(args.path)}`);
    }

    const text = await file.text();
    const idx = text.indexOf(oldStr);
    if (idx === -1) {
      return this.fail(null!, start, `String not found in file: ${oldStr.slice(0, 100)}`);
    }

    const occurrences = text.split(oldStr).length - 1;
    if (occurrences > 1 && !allowMultiple) {
      return this.fail(null!, start, `Found ${occurrences} occurrences of the string. Set allowMultiple:true to replace all, or provide more context to narrow the match.`);
    }

    const newText = allowMultiple ? text.replaceAll(oldStr, newStr) : text.replace(oldStr, newStr);
    await Bun.write(path, newText);

    return {
      id: `tool_${Date.now()}`,
      toolName: 'edit_file',
      result: `Replaced ${allowMultiple ? occurrences : 1} occurrence(s) in ${String(args.path)}`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleSearchFiles(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pattern = String(args.pattern);
    const searchDir = this.resolve(String(args.path || '.'));
    const fileGlob = String(args.filePattern || '*');
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 50;

    const results: string[] = [];
    let count = 0;

    const glob = new Bun.Glob(`**/${fileGlob}`);

    for await (const entry of glob.scan({ cwd: searchDir, absolute: false })) {
      if (count >= maxResults) break;

      try {
        const fullPath = `${searchDir}/${entry}`;
        const file = Bun.file(fullPath);
        const text = await file.text();
        const lines = text.split('\n');

        for (let i = 0; i < lines.length && count < maxResults; i++) {
          if (lines[i].includes(pattern)) {
            results.push(`${entry}:${i + 1}: ${lines[i].trim()}`);
            count++;
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    return {
      id: `tool_${Date.now()}`,
      toolName: 'search_files',
      result: results.length > 0 ? results.join('\n') : `No matches found for "${pattern}"`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleListFiles(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const dirPath = this.resolve(String(args.path || '.'));
    const recursive = Boolean(args.recursive);

    const dir = Bun.file(dirPath);
    if (!(await dir.exists())) {
      return this.fail(null!, start, `Directory not found: ${String(args.path || '.')}`);
    }

    const items: string[] = [];
    const glob = new Bun.Glob(recursive ? '**/*' : '*');

    for await (const entry of glob.scan({ cwd: dirPath, absolute: false, onlyFiles: false })) {
      items.push(entry);
    }

    return {
      id: `tool_${Date.now()}`,
      toolName: 'list_files',
      result: items.length > 0 ? items.sort().join('\n') : '(empty directory)',
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleExecuteCommand(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const command = String(args.command);

    const controller = new AbortController();
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    setTimeout(() => controller.abort(), this.commandTimeout);

    try {
      const proc = Bun.spawn(['sh', '-c', command], {
        cwd: this.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
        signal: controller.signal,
      });

      const stdout = (await new Response(proc.stdout).text()).trim();
      const stderr = (await new Response(proc.stderr).text()).trim();
      await proc.exited;
      const exitCode = proc.exitCode ?? -1;

      const result = { stdout, stderr, exitCode };
      // Exit code is the single source of truth for success: a command that
      // printed output but exited non-zero FAILED (a failed `npm install` or
      // `cargo build`). Report it as such so the LLM and the failure policy
      // can react instead of treating the run as successful. stderr stays in
      // the result (and the error message) so the model sees what went wrong.
      if (exitCode !== 0) {
        return {
          id: `tool_${Date.now()}`,
          toolName: 'execute_command',
          result,
          error: formatCommandError(exitCode, [stdout, stderr ? `[stderr]\n${stderr}` : ''].filter(Boolean).join('\n')),
          success: false,
          duration: Date.now() - start,
        };
      }
      return {
        id: `tool_${Date.now()}`,
        toolName: 'execute_command',
        result,
        success: true,
        duration: Date.now() - start,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return this.fail(null!, start, `Command timed out after ${this.commandTimeout}ms`);
      }
      return this.fail(null!, start, err?.message ?? 'Command execution failed');
    }
  }

  private async handleCreateDirectory(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const dirPath = this.resolve(String(args.path));

    await mkdir(dirPath, { recursive: true });

    return {
      id: `tool_${Date.now()}`,
      toolName: 'create_directory',
      result: `Created directory: ${String(args.path)}`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleDiffFiles(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pathA = this.resolve(String(args.pathA));
    const pathB = this.resolve(String(args.pathB));

    const proc = Bun.spawn(['diff', '-u', pathA, pathB], {
      cwd: this.workspace,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    if (proc.exitCode === 0) {
      return {
        id: `tool_${Date.now()}`,
        toolName: 'diff_files',
        result: '(files are identical)',
        success: true,
        duration: Date.now() - start,
      };
    }

    if (proc.exitCode === 1) {
      return {
        id: `tool_${Date.now()}`,
        toolName: 'diff_files',
        result: stdout.trim() || '(files differ)',
        success: true,
        duration: Date.now() - start,
      };
    }

    return this.fail(null!, start, stderr.trim() || `diff failed with exit code ${proc.exitCode}`);
  }

  private async handleWebSearch(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const query = String(args.query);
    const maxResults = Math.min(typeof args.maxResults === 'number' ? args.maxResults : 10, 20);

    // Multi-backend fallback: DuckDuckGo is unreachable on some networks
    // (timeouts / blocks), which used to make EVERY search fail. Try backends
    // in order and stop at the first that yields results; a backend that
    // errors OR returns nothing rolls over to the next one, so challenge pages
    // and empty result sets degrade gracefully instead of hard failures.
    //
    // Chinese-priority: CJK queries hit cn.bing.com FIRST — international Bing
    // frequently serves a block page and DuckDuckGo returns irrelevant results
    // for Chinese, which pushed the agent into repeated searches. Mirrors the
    // Rust web_search backend order.
    const backends: Array<{ label: string; fetch: () => Promise<SearchResult[]> }> = [
      ...(containsCJK(query)
        ? [{
            label: 'cn.bing.com',
            fetch: async () => {
              const resp = await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
                headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
                redirect: 'follow',
                signal: AbortSignal.timeout(8000),
              });
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              return parseBingResults(await resp.text(), maxResults);
            },
          }]
        : []),
      {
        label: 'DuckDuckGo',
        fetch: async () => {
          const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' },
            redirect: 'follow',
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return parseDuckDuckGoResults(await resp.text(), maxResults);
        },
      },
      {
        label: 'Bing',
        fetch: async () => {
          const resp = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
            headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' },
            redirect: 'follow',
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return parseBingResults(await resp.text(), maxResults);
        },
      },
    ];

    let results: SearchResult[] = [];
    const failed: string[] = [];
    let anyEmpty = false;
    for (const backend of backends) {
      if (results.length > 0) break;
      try {
        const r = await backend.fetch();
        if (r.length > 0) results = r;
        else anyEmpty = true;
      } catch (err: any) {
        failed.push(`${backend.label}: ${err?.message ?? String(err)}`);
      }
    }

    if (results.length === 0) {
      // At least one backend answered with an empty result set: the search
      // infrastructure works, the query just has no hits — rephrase, don't
      // repeat. (Other backends may have been unreachable; either way the
      // actionable guidance is the same.)
      if (anyEmpty) {
        return {
          id: `tool_${Date.now()}`,
          toolName: 'web_search',
          result: `No results found for "${query}" on the available search backends (cn.bing.com, DuckDuckGo, Bing). Do NOT repeat the same query — rephrase it (broader terms, simpler wording, or English), or use web_fetch on a URL you expect to contain the information.`,
          success: true,
          duration: Date.now() - start,
        };
      }
      // Every backend errored (none returned empty): almost always network /
      // rate-limit / geo-block, NOT a bad query — tell the model not to
      // blindly retry, and how to recover. This is the message the failure
      // policy feeds back on.
      const details = failed.length > 0 ? failed.join('; ') : 'all backends unreachable';
      return this.fail(null!, start, `Web search failed on all backends (${details}). This looks like a network or rate-limit issue rather than a bad query — do NOT retry web_search immediately with the same or similar queries. Retry later, or use web_fetch on a URL you expect to contain the information.`);
    }

    const output = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`)
      .join('\n\n');

    return {
      id: `tool_${Date.now()}`,
      toolName: 'web_search',
      result: output,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleWebFetch(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const url = String(args.url);
    const maxChars = typeof args.maxChars === 'number' ? args.maxChars : 20000;

    const controller = new AbortController();
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    setTimeout(() => controller.abort(), 30000);

    const resp = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: controller.signal,
    });

    if (!resp.ok) {
      return this.fail(null!, start, `Fetch failed: HTTP ${resp.status}`);
    }

    const contentType = resp.headers.get('content-type') || '';
    // Accept any text-ish media type (text/*, JSON, XML, JS, …) so repeated
    // web_fetch calls don't keep hitting the same "unsupported content type"
    // wall on common real-world pages; reject only clearly binary payloads.
    // The error guides the model toward recovery instead of blind retries.
    if (!isTextualContentType(contentType)) {
      // Empty content-type never reaches this branch (helper returns true),
      // so contentType is always a non-empty binary type here.
      return this.fail(null!, start, `Unsupported content type: ${contentType} — the URL serves a non-text payload, so web_fetch cannot extract readable text from it. Do NOT retry web_fetch on this URL; instead use web_search to find a text/HTML page with the information, or pick a different URL.`);
    }

    const html = await resp.text();
    // Decode HTML entities at the PIPELINE level (mirrors the Rust web_fetch
    // path, whose strip_html_full html-decodes after stripping). NOT inside
    // the shared stripHtml — that helper also feeds the DDG/Bing parsers,
    // which decode AFTER stripping themselves; decoding there would
    // double-decode (&amp;copy; → ©).
    const text = extractReadableText(html);
    const truncated = text.length > maxChars ? text.slice(0, maxChars) + '\n\n[truncated]' : text;

    return {
      id: `tool_${Date.now()}`,
      toolName: 'web_fetch',
      result: truncated || '(empty page)',
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleGlobFiles(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pattern = String(args.pattern);
    const searchDir = this.resolve(String(args.path || '.'));
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 200;

    const results: string[] = [];
    const glob = new Bun.Glob(pattern);

    for await (const entry of glob.scan({ cwd: searchDir, absolute: false, onlyFiles: true })) {
      if (results.length >= maxResults) break;
      results.push(entry);
    }

    results.sort();

    return {
      id: `tool_${Date.now()}`,
      toolName: 'glob_files',
      result: results.length > 0 ? results.join('\n') : `No files matching "${pattern}"`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleReplaceFiles(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const files = Array.isArray(args.files) ? args.files.map(String) : [];
    const oldStr = String(args.oldString);
    const newStr = String(args.newString);
    const allowMultiple = Boolean(args.allowMultiple);

    if (files.length === 0) {
      return this.fail(null!, start, 'No files specified');
    }

    const results: string[] = [];
    let totalOccurrences = 0;
    let errors = 0;

    for (const filePath of files) {
      try {
        const path = this.resolve(filePath);
        const file = Bun.file(path);
        if (!(await file.exists())) {
          results.push(`✗ ${filePath}: file not found`);
          errors++;
          continue;
        }

        const text = await file.text();
        const occurrences = text.split(oldStr).length - 1;

        if (occurrences === 0) {
          results.push(`− ${filePath}: string not found`);
          continue;
        }

        if (occurrences > 1 && !allowMultiple) {
          results.push(`✗ ${filePath}: found ${occurrences} occurrences — set allowMultiple:true or narrow match`);
          errors++;
          continue;
        }

        const newText = allowMultiple ? text.replaceAll(oldStr, newStr) : text.replace(oldStr, newStr);
        await Bun.write(path, newText);
        results.push(`✓ ${filePath}: replaced ${allowMultiple ? occurrences : 1} occurrence(s)`);
        totalOccurrences += allowMultiple ? occurrences : 1;
      } catch (err: any) {
        results.push(`✗ ${filePath}: ${err?.message ?? String(err)}`);
        errors++;
      }
    }

    const summary = `${results.length} file(s) processed, ${totalOccurrences} replacement(s), ${errors} error(s)`;

    return {
      id: `tool_${Date.now()}`,
      toolName: 'replace_files',
      result: `${summary}\n${results.join('\n')}`,
      success: errors === 0,
      duration: Date.now() - start,
    };
  }

  private async handleGitCmd(_args: Record<string, unknown>, gitArgs: string[], signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const controller = new AbortController();
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    setTimeout(() => controller.abort(), this.commandTimeout);

    try {
      const proc = Bun.spawn(['git', ...gitArgs], {
        cwd: this.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
        signal: controller.signal,
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      if (proc.exitCode !== 0) {
        return this.fail(null!, start, stderr.trim() || `git failed with exit code ${proc.exitCode}`);
      }

      return {
        id: `tool_${Date.now()}`,
        toolName: `git_${gitArgs[0] ?? 'unknown'}`,
        result: stdout.trim() || '(no output)',
        success: true,
        duration: Date.now() - start,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return this.fail(null!, start, `Git command timed out after ${this.commandTimeout}ms`);
      }
      return this.fail(null!, start, err?.message ?? 'Git command failed');
    }
  }

  private async handleSysInfo(start: number): Promise<ToolResult> {
    const tz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const lang = process.env.LANG ?? process.env.LC_ALL ?? process.env.LC_CTYPE ?? 'unknown';
    const time = new Date().toString();
    let osVersion = `${process.platform} ${process.arch}`;
    try {
      const uname = Bun.spawnSync({ cmd: ['uname', '-srm'], stdout: 'pipe', stderr: 'pipe' });
      if (uname.exitCode === 0) osVersion = new TextDecoder().decode(uname.stdout).trim();
    } catch {}

    return {
      id: `tool_${Date.now()}`,
      toolName: 'sys_info',
      result: `timezone:  ${tz}\nlanguage:  ${lang}\ntime:      ${time}\n      os:        ${osVersion}`,
      success: true,
      duration: Date.now() - start,
    };
  }

  // ── Helpers ──

  private resolve(filePath: string): string {
    const resolved = pathResolve(this.workspace, filePath);
    const rel = pathRelative(this.workspace, resolved);
    if (rel.startsWith('..') || pathResolve(this.workspace, rel) !== resolved) {
      throw new Error(`Path escapes workspace: ${filePath}`);
    }
    return resolved;
  }

  private fail(toolCall: ToolCall | null, start: number, error: string): ToolResult {
    return {
      id: `tool_${Date.now()}`,
      toolName: toolCall?.function?.name ?? 'unknown',
      error,
      success: false,
      duration: Date.now() - start,
    };
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw); } catch { return {}; }
}

/** Build the error message for a failed command (non-zero exit code). Mirrors
 * the GUI adapter's formatCommandError so CLI and GUI report failures the
 * same way. */
function formatCommandError(exitCode: number, output: string): string {
  const tail = output.trim() ? `:\n${output.trim()}` : '';
  return `Command failed with exit code ${exitCode}${tail}`;
}

// Browser User-Agent: search engines and many sites block the bare "Pure/1.0"
// string, which surfaced as a wall of generic HTTP errors. A real browser UA
// keeps both search backends and web_fetch targets responsive.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ── DuckDuckGo HTML result parser ──

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

/** True when the query contains CJK ideographs (CJK Unified Ideographs, CJK
 * Extension A, and CJK Compatibility Ideographs) — the trigger for routing a
 * search through the China Bing backend (cn.bing.com) first. Mirrors
 * src-tauri/src/lib.rs `is_chinese_query`; both sides have matching tests. */
export function containsCJK(query: string): boolean {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(query);
}

/** Parse DuckDuckGo HTML results (`<div class="result">` blocks containing
 * `<a class="result__a" href="…">TITLE</a>` plus a
 * `<div class="result__snippet">…</div>`). Exported for the mirror tests in
 * searchParser.test.ts, which lock behavior against the Rust parser
 * (src-tauri/src/lib.rs parse_duckduckgo_results). */
export function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Parse DuckDuckGo HTML search: each result is in a div with class "result"
  const resultBlockRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result|$)/gi;
  const blocks = html.match(resultBlockRegex);
  if (!blocks) return results;

  for (const block of blocks) {
    if (results.length >= maxResults) break;

    // Extract title + URL from <a class="result__a" href="...">Title</a>
    const linkMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const url = decodeHtmlEntities(linkMatch[1].trim());
    const title = decodeHtmlEntities(stripHtml(linkMatch[2])).trim();

    if (!title || !url) continue;

    // Extract snippet from <a class="result__snippet">
    const snippetMatch = block.match(/<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
    const snippet = snippetMatch ? decodeHtmlEntities(stripHtml(snippetMatch[1])).trim() : '';

    results.push({ title, snippet, url });
  }

  return results;
}

/** True when a Content-Type header is a text-like payload web_fetch can read.
 * Accepts text/* and common text-bearing application subtypes (JSON, XML, JS,
 * SVG, RSS/Atom, form data); a missing/empty header is treated as text so the
 * fetch still works on servers that omit it. Rejects only clearly binary
 * payloads (images, audio/video, fonts, archives, PDF, octet-stream). */
function isTextualContentType(contentType: string): boolean {
  const main = contentType.split(';')[0].trim().toLowerCase();
  if (!main) return true;
  if (main.startsWith('text/')) return true;
  if (main.endsWith('+json') || main.endsWith('+xml')) return true;
  return [
    'application/json',
    'application/xml',
    'application/xhtml+xml',
    'application/javascript',
    'application/x-javascript',
    'application/x-www-form-urlencoded',
    'application/svg+xml',
    'application/rss+xml',
    'application/atom+xml',
  ].includes(main);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    // Numeric character references (common in Bing snippets, e.g. &#0183;).
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

// ── Bing HTML result parser (multi-backend fallback) ──

/** Parse Bing results (`<li class="b_algo">` blocks): `<h2><a href="…">TITLE</a></h2>`
 * plus a `<p>…</p>` snippet. Mirrors the Rust parser in src-tauri/src/lib.rs — the
 * two MUST stay behaviorally identical (entity decoding, quote handling, block
 * skipping, max cap); tests on both sides lock the shared fixtures. INTENTIONAL
 * divergences: whitespace handling (TS stripHtml collapses block tags to
 * newlines — shared with the DDG/web_fetch paths — while Rust keeps raw
 * whitespace) and unquoted hrefs (TS skips, Rust would parse). Both favor TS
 * in practice and must not be "unified" blindly. */
export function parseBingResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  let rest = html;
  while (results.length < maxResults) {
    const idx = rest.indexOf('<li class="b_algo');
    if (idx === -1) break;
    const tail = rest.slice(idx);
    const liEnd = tail.indexOf('</li>');
    if (liEnd === -1) break;
    const block = tail.slice(0, liEnd + '</li>'.length);
    const parsed = parseBingBlock(block);
    if (parsed) results.push(parsed);
    rest = tail.slice(liEnd + '</li>'.length);
  }
  return results;
}

function parseBingBlock(block: string): SearchResult | undefined {
  // Result link lives inside <h2>: find <h2>, then the first <a after it.
  const h2 = block.indexOf('<h2');
  if (h2 === -1) return undefined;
  const afterH2 = block.slice(h2);
  const aIdx = afterH2.indexOf('<a');
  if (aIdx === -1) return undefined;
  const url = extractHref(afterH2, aIdx);
  if (url === undefined) return undefined;

  // Title: text between the anchor's '>' and the next '<'. A block whose
  // anchor never closes is skipped entirely (mirrors the Rust `?` on find).
  const afterA = afterH2.slice(aIdx);
  const gt = afterA.indexOf('>');
  if (gt === -1) return undefined;
  const afterGt = afterA.slice(gt + 1);
  const titleEnd = afterGt.indexOf('<');
  if (titleEnd === -1) return undefined;
  const title = decodeHtmlEntities(stripHtml(afterGt.slice(0, titleEnd))).trim();
  if (!title || !url) return undefined;

  // Snippet: first <p ...>…</p> in the block. Decoded like the title so
  // numeric/named entities in Bing snippets (&#0183; middle dots, &ensp;)
  // render as characters, matching the Rust parser.
  let snippet = '';
  const pIdx = block.indexOf('<p');
  if (pIdx !== -1) {
    const afterP = block.slice(pIdx);
    const pGt = afterP.indexOf('>');
    if (pGt !== -1) {
      const content = afterP.slice(pGt + 1);
      const pEnd = content.indexOf('</p>');
      if (pEnd !== -1) snippet = decodeHtmlEntities(stripHtml(content.slice(0, pEnd))).trim();
    }
  }

  return { title, snippet, url };
}

/** Extract an href attribute value after a `<a` marker, mirroring the Rust
 * parser's extract_href: read the quote char (single OR double) that follows
 * `href=`, then the text up to the matching quote. Returns undefined when the
 * attribute is missing or unquoted so the block is skipped. */
function extractHref(s: string, from: number): string | undefined {
  const rest = s.slice(from);
  const hrefIdx = rest.indexOf('href=');
  if (hrefIdx === -1) return undefined;
  const afterHref = rest.slice(hrefIdx + 'href='.length);
  const quote = afterHref[0];
  if (quote !== '"' && quote !== "'") return undefined;
  const end = afterHref.indexOf(quote, 1);
  if (end === -1) return undefined;
  return decodeHtmlEntities(afterHref.slice(1, end));
}

/** Strip HTML to readable text (shared by web_fetch and the DDG/Bing result
 * parsers). Mirror-tested against the Rust strip_html_full in
 * stripHtml.test.ts — the two must agree on the common core (tag stripping,
 * script/style removal, whitespace collapse, block breaks). Intentional
 * divergences (entities, inline tags, script case) are documented there. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(?:div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
}

/** web_fetch pipeline: strip tags, collapse whitespace, then decode HTML
 * entities — the same output shape as the Rust strip_html_full (which also
 * decodes after stripping). Decoding is intentionally NOT folded into
 * stripHtml (shared with the DDG/Bing parsers, which decode after stripping
 * themselves — decoding in the helper would double-decode). Mirror-tested in
 * stripHtml.test.ts. */
export function extractReadableText(html: string): string {
  return decodeHtmlEntities(stripHtml(html).trim());
}
