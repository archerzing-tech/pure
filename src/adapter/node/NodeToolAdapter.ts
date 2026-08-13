// src/adapter/node/NodeToolAdapter.ts
// v0.4 — 16 built-in file/command/web/git tools. Schemas come from
// shared/toolDefs.ts (single source of truth shared with the GUI adapter).
// Fixes: handleWriteFile uses proper fs.mkdir() instead of fragile .ensure hack.

import { basename, dirname, isAbsolute, join, resolve as pathResolve, relative as pathRelative, sep } from 'node:path';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';

import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../../shared/types';
import { BUILT_IN_TOOL_DEFS, TOOL_METADATA } from '../../shared/toolDefs';
import { formatCommandError, safeParseArgs } from '../../shared/format';
import { filterResearchSources, isOfficialDocumentationSource, makeResearchPayload, parseWebSearchText, type ResearchSource } from '../../shared/research';
import { isPublicToolName } from '../../shared/toolDefs';
import type { WorkspaceRestoreResult, WorkspaceSnapshotBatch, WorkspaceSnapshotEntry, WorkspaceSnapshotPort } from '../../shared/workspaceSnapshot';

/** Windows has no POSIX shell (`sh`) or `diff` binary — cmd.exe / Git for
 * Windows provide the equivalents. Module-level so every handler branches
 * consistently. */
const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_MAX_LIST_RESULTS = 2000;
const ABSOLUTE_MAX_LIST_RESULTS = 5000;

export interface NodeToolConfig {
  workspace: string;
  sessionId?: string;
  commandTimeout?: number;
  maxFileSize?: number;
  maxSnapshotBytes?: number;
  /**
   * User-configured location/city (CLI: PURE_LOCATION / PURE_CITY env var).
   * Reported by sys_info() as the location baseline for answers that depend
   * on where the user is (trip planning, weather, local services).
   */
  location?: string;
}

export class NodeToolAdapter implements ToolAdapter {
  private workspace: string;
  private commandTimeout: number;
  private maxFileSize: number;
  private maxSnapshotBytes: number;
  private location: string;
  private sessionId: string;
  private latestWriteBatch: WorkspaceSnapshotBatch | null = null;
  private snapshotSequence = 0;

  private tools: ToolDefinition[] = [...BUILT_IN_TOOL_DEFS];

  constructor(config: NodeToolConfig) {
    this.workspace = pathResolve(config.workspace);
    this.sessionId = config.sessionId ?? '';
    this.commandTimeout = config.commandTimeout ?? 30000;
    this.maxFileSize = config.maxFileSize ?? 1_048_576; // 1MB
    this.maxSnapshotBytes = config.maxSnapshotBytes ?? 8 * 1024 * 1024;
    this.location = (config.location ?? '').trim();
  }

  getTools(): ToolDefinition[] {
    return this.tools.filter((tool) => isPublicToolName(tool.name));
  }

  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean } | undefined {
    return TOOL_METADATA[toolName];
  }

  getSnapshotPort(): WorkspaceSnapshotPort {
    return {
      getLatestWriteBatch: () => this.latestWriteBatch,
      undoLastWriteBatch: () => this.undoLastWriteBatch(),
    };
  }

  async execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const start = Date.now();
    const args = safeParseArgs(toolCall.function.arguments);

    try {
      switch (toolCall.function.name) {
        case 'read_file': return await this.handleReadFile(args, start);
        case 'write_file': return await this.handleWriteFile(args, start);
        case 'edit_file': return await this.handleEditFile(args, start);
        case 'search_files': return await this.handleSearchFiles(args, start);
        case 'list_files': return await this.handleListFiles(args, start);
        case 'execute_command': return await this.handleExecuteCommand(args, signal, start);
        case 'create_directory': return await this.handleCreateDirectory(args, start);
        case 'diff_files': return await this.handleDiffFiles(args, start);
        case 'researcher_web': return await this.handleResearcherWeb(args, signal, start);
        case 'researcher_docs': return await this.handleResearcherDocs(args, signal, start);
        case 'code_searcher': return await this.handleCodeSearcher(args, signal, start);
        case 'web_search': return await this.handleWebSearch(args, start);
        case 'web_fetch': return await this.handleWebFetch(args, signal, start);
        case 'glob_files': return await this.handleGlobFiles(args, start);
        case 'replace_files': return await this.handleReplaceFiles(args, start);
        case 'git_diff': return await this.handleGitCmd(args, ['diff', ...(args.staged ? ['--staged'] : []), ...(typeof args.path === 'string' ? ['--', args.path as string] : [])], signal, start);
        case 'git_log': return await this.handleGitCmd(args, ['log', '-n', String(args.maxCount ?? 10), ...(args.oneline !== false ? ['--oneline'] : [])], signal, start);
        case 'git_status': return await this.handleGitCmd(args, ['status', '--short'], signal, start);
        case 'sys_info': return await this.handleSysInfo(start);
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
    const pathArg = String(args.path);
    const path = this.resolve(pathArg);
    const content = String(args.content);
    const batch = await this.captureWriteBatch('write_file', [pathArg]);

    // Ensure parent directory exists
    const dir = dirname(path);
    if (dir && dir !== path) {
      await mkdir(dir, { recursive: true });
    }

    await Bun.write(path, content);
    const undoAvailable = await this.tryFinishWriteBatch(batch, [pathArg]);

    return {
      id: `tool_${Date.now()}`,
      toolName: 'write_file',
      result: `Wrote ${content.length} bytes to ${String(args.path)}${undoAvailable ? '' : ' (当前写入未提供撤销快照)'}`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleEditFile(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pathArg = String(args.path);
    const path = this.resolve(pathArg);
    const oldStr = String(args.oldString);
    const newStr = String(args.newString);
    const allowMultiple = Boolean(args.allowMultiple);

    const file = Bun.file(path);
    if (!(await file.exists())) {
      return this.fail(null!, start, `File not found: ${String(args.path)}`);
    }

    const text = await file.text();
    const match = findEditMatch(text, oldStr);
    if (!match) {
      return this.fail(null!, start, editStringNotFoundError(String(args.path), oldStr), 'edit_file');
    }

    const occurrences = match.normalizedText.split(match.normalizedOld).length - 1;
    if (occurrences > 1 && !allowMultiple) {
      return this.fail(null!, start, `Found ${occurrences} occurrences of the string. Set allowMultiple:true to replace all, or provide more context to narrow the match.`);
    }

    const replacement = match.lineEnding === 'crlf' ? newStr.replace(/\r?\n/g, '\r\n') : newStr.replace(/\r\n/g, '\n');
    const newText = allowMultiple
      ? match.text.replaceAll(match.old, replacement)
      : match.text.slice(0, match.index) + replacement + match.text.slice(match.index + match.old.length);
    const batch = await this.captureWriteBatch('edit_file', [pathArg]);
    await Bun.write(path, newText);
    const undoAvailable = await this.tryFinishWriteBatch(batch, [pathArg]);

    return {
      id: `tool_${Date.now()}`,
      toolName: 'edit_file',
      result: `Replaced ${allowMultiple ? occurrences : 1} occurrence(s) in ${String(args.path)}${match.lineEnding === 'crlf' ? ' (matched CRLF line endings)' : ''}${undoAvailable ? '' : ' (当前写入未提供撤销快照)'}`,
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
        const fullPath = join(searchDir, entry);
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

    // Bun.file(dirPath).exists() returns false for DIRECTORIES (Bun.file only
    // resolves regular files) — every real directory was misreported as
    // missing. existsSync + statSync().isDirectory() accept both; statSync
    // follows symlinks, matching how the glob below resolves the cwd.
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      return this.fail(null!, start, `Directory not found: ${String(args.path || '.')}`);
    }

    const requestedMax = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
      ? Math.floor(args.maxResults)
      : DEFAULT_MAX_LIST_RESULTS;
    const maxResults = Math.min(Math.max(1, requestedMax), ABSOLUTE_MAX_LIST_RESULTS);
    const items: string[] = [];
    const glob = new Bun.Glob(recursive ? '**/*' : '*');
    let truncated = false;

    for await (const entry of glob.scan({ cwd: dirPath, absolute: false, onlyFiles: false })) {
      if (items.length >= maxResults) {
        truncated = true;
        break;
      }
      items.push(entry);
    }

    items.sort();
    const listing = items.length > 0 ? items.join('\n') : '(empty directory)';
    const result = truncated
      ? `${listing}\n\n[截断] 仅显示前 ${maxResults} 项；目录还有更多内容，请缩小 path 或使用 search_files/glob_files。`
      : listing;
    return {
      id: `tool_${Date.now()}`,
      toolName: 'list_files',
      result,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleExecuteCommand(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const command = String(args.command);
    const abort = createAbortController(signal, this.commandTimeout);

    try {
      const shellArgs = IS_WINDOWS ? ['cmd', '/C', command] : ['sh', '-c', command];
      const proc = Bun.spawn(shellArgs, {
        cwd: this.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
        signal: abort.signal,
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
    } finally {
      abort.cleanup();
    }
  }

  private async handleCreateDirectory(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pathArg = String(args.path);
    const dirPath = this.resolve(pathArg);
    const batch = await this.captureWriteBatch('create_directory', [pathArg]);

    await mkdir(dirPath, { recursive: true });
    if (!batch.entries[0]?.existed) await this.tryFinishWriteBatch(batch, [pathArg]);

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

    // Windows ships no `diff`; fall back to `git diff --no-index` (Git for
    // Windows ships git.exe) with the same exit-code convention.
    let proc;
    try {
      proc = Bun.spawn(['diff', '-u', pathA, pathB], {
        cwd: this.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch {
      proc = Bun.spawn(['git', 'diff', '--no-index', '--', pathA, pathB], {
        cwd: this.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    }

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

  private async handleResearcherWeb(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const prompt = String(args.prompt ?? args.query ?? '').trim();
    return this.runResearch(prompt, 'researcher_web', args, signal, start);
  }

  private async handleResearcherDocs(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const library = String(args.library ?? '').trim();
    const topic = String(args.topic ?? '').trim();
    const version = typeof args.version === 'string' ? args.version.trim() : '';
    const query = [library, topic, version, 'official documentation API reference'].filter(Boolean).join(' ');
    return this.runResearch(query, 'researcher_docs', args, signal, start, { library, topic, version });
  }

  private async runResearch(
    query: string,
    kind: 'researcher_web' | 'researcher_docs',
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    start: number,
    context: { library?: string; topic?: string; version?: string } = {},
  ): Promise<ToolResult> {
    if (!query) return this.fail(null!, start, 'Research prompt/query must not be empty', kind);
    const requestedSources = typeof args.maxSources === 'number' && Number.isFinite(args.maxSources)
      ? Math.min(8, Math.max(1, Math.floor(args.maxSources)))
      : 5;
    const maxChars = typeof args.maxCharsPerSource === 'number' && Number.isFinite(args.maxCharsPerSource)
      ? Math.min(12000, Math.max(500, Math.floor(args.maxCharsPerSource)))
      : 4000;
    const allowedDomains = Array.isArray(args.allowedDomains)
      ? args.allowedDomains.map(String).map((domain) => domain.trim().toLowerCase()).filter(Boolean)
      : [];
    const search = await this.handleWebSearch({ query, maxResults: Math.min(20, Math.max(requestedSources, requestedSources * 2)) }, start);
    if (!search.success) return { ...search, toolName: kind };

    const rawSources = parseWebSearchText(typeof search.result === 'string' ? search.result : '');
    const filteredSources = filterResearchSources(rawSources, allowedDomains);
    const filtered = rawSources.length - filteredSources.length;
    let sources = filteredSources;
    const failed: string[] = [];
    const fetchContent = args.fetchContent !== false;
    const selected = sources.slice(0, requestedSources);
    if (fetchContent) {
      const enriched = await Promise.all(selected.map(async (source): Promise<ResearchSource> => {
        const page = await this.handleWebFetch({ url: source.url, maxChars }, signal, Date.now());
        if (!page.success) {
          failed.push(`${source.url}: ${page.error ?? 'fetch failed'}`);
          return source;
        }
        return { ...source, content: typeof page.result === 'string' ? page.result : String(page.result ?? '') };
      }))
      .catch((error) => {
        failed.push(error instanceof Error ? error.message : String(error));
        return selected;
      });
      sources = enriched;
    } else {
      sources = selected;
    }

    if (sources.length === 0) {
      const detail = allowedDomains.length > 0
        ? `No usable research sources matched the allowed domains: ${allowedDomains.join(', ')}`
        : 'No usable research sources were returned by the available search backends';
      return this.fail(null!, start, `${detail}. Rephrase the query or broaden the allowed domain list; do not repeat the unchanged query.`, kind);
    }

    const result = makeResearchPayload(kind, query, sources, {
      failed,
      filtered,
      officialVerified: kind === 'researcher_docs'
        ? sources.some((source) => isOfficialDocumentationSource(context.library ?? '', source.url))
        : undefined,
      versionMatched: kind === 'researcher_docs' && context.version
        ? sources.some((source) => `${source.url} ${source.snippet} ${source.content ?? ''}`.includes(context.version!))
        : kind === 'researcher_docs',
      truncated: filteredSources.length > selected.length,
      ...context,
    });
    return {
      id: `tool_${Date.now()}`,
      toolName: kind,
      result,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleCodeSearcher(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const query = String(args.query ?? args.pattern ?? '').trim();
    if (!query) return this.fail(null!, start, 'code_searcher query must not be empty', 'code_searcher');
    const searchDir = this.resolve(String(args.path || '.'));
    const workspaceRoot = realpathSync(this.workspace);
    const scope = pathRelative(workspaceRoot, searchDir) || '.';
    const perFile = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
      ? Math.min(100, Math.max(1, Math.floor(args.maxResults)))
      : 15;
    const globalMax = typeof args.globalMaxResults === 'number' && Number.isFinite(args.globalMaxResults)
      ? Math.min(1000, Math.max(1, Math.floor(args.globalMaxResults)))
      : 250;
    const timeoutSeconds = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds)
      ? Math.min(30, Math.max(1, args.timeoutSeconds))
      : 10;
    const rgArgs = ['--json', '--no-config', '--line-number', '--color', 'never', '--hidden', '--max-filesize', '8M', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!dist/**', '--glob', '!build/**', '--glob', '!target/**'];
    if (args.caseSensitive === false) rgArgs.push('--ignore-case');
    if (Array.isArray(args.globs)) {
      for (const glob of args.globs) {
        if (typeof glob === 'string' && glob.trim()) rgArgs.push('--glob', glob.trim());
      }
    }
    rgArgs.push('--', query, scope);

    const abort = createAbortController(signal, timeoutSeconds * 1000);
    try {
      const proc = Bun.spawn(['rg', ...rgArgs], { cwd: this.workspace, stdout: 'pipe', stderr: 'pipe', signal: abort.signal });
      const matches: Array<{ path: string; line: number; column?: number; text: string }> = [];
      const perFileCounts = new Map<string, number>();
      let truncated = false;
      let buffer = '';
      const decoder = new TextDecoder();
      const consumeLine = (line: string): void => {
        if (!line || truncated) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type !== 'match') return;
        const data = event.data ?? {};
        const rawPath = typeof data.path?.text === 'string' ? data.path.text : '';
        if (!rawPath) return;
        const rawRelativePath = isAbsolute(rawPath) ? pathRelative(workspaceRoot, rawPath) : rawPath;
        const relativePath = rawRelativePath.startsWith('./') ? rawRelativePath.slice(2) : rawRelativePath;
        const count = perFileCounts.get(relativePath) ?? 0;
        if (count >= perFile) {
          truncated = true;
          abort.abort();
          return;
        }
        perFileCounts.set(relativePath, count + 1);
        const submatch = Array.isArray(data.submatches) ? data.submatches[0] : undefined;
        matches.push({
          path: relativePath,
          line: Number(data.line_number ?? 0),
          ...(typeof submatch?.start === 'number' ? { column: submatch.start + 1 } : {}),
          text: typeof data.lines?.text === 'string' ? data.lines.text.replace(/\n$/, '') : '',
        });
        if (matches.length >= globalMax) {
          truncated = true;
          abort.abort();
        }
      };

      const reader = proc.stdout.getReader();
      try {
        while (!truncated) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            consumeLine(line);
            if (truncated) break;
          }
        }
        if (!truncated) {
          buffer += decoder.decode();
          consumeLine(buffer);
        }
      } catch (error: any) {
        if (!truncated) throw error;
      } finally {
        reader.releaseLock();
      }

      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      const exitCode = proc.exitCode ?? -1;
      if (!truncated && exitCode !== 0 && exitCode !== 1) {
        return this.fail(null!, start, stderr.trim() || `rg failed with exit code ${exitCode}`, 'code_searcher');
      }

      return {
        id: `tool_${Date.now()}`,
        toolName: 'code_searcher',
        result: JSON.stringify({
          kind: 'code_search',
          query,
          scope,
          matches,
          truncated,
          diagnostics: [],
          fileSizeLimitBytes: 8 * 1024 * 1024,
          searchedAt: new Date().toISOString(),
        }),
        success: true,
        duration: Date.now() - start,
      };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        const message = signal?.aborted
          ? 'code_searcher cancelled by the caller'
          : `code_searcher timed out after ${timeoutSeconds}s`;
        return this.fail(null!, start, message, 'code_searcher');
      }
      return this.fail(null!, start, error?.message ?? 'rg is unavailable; install ripgrep or use the legacy search tool', 'code_searcher');
    } finally {
      abort.cleanup();
    }
  }

  private async handleWebSearch(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const query = String(args.query);
    const maxResults = Math.min(typeof args.maxResults === 'number' ? args.maxResults : 10, 20);
    const cjk = containsCJK(query);

    // 1) Serper API backend (real Google index — best quality for Chinese AND
    // English): opt-in via the SERPER_API_KEY env var. Mirrors the Rust
    // web_search — on failure or (for CJK) a relevance-gated-out set, degrade
    // to Tavily and then the free HTML backends below.
    let results: SearchResult[] = [];
    const failed: string[] = [];
    let anyEmpty = false;
    let irrelevant = 0;
    if (process.env.SERPER_API_KEY?.trim()) {
      try {
        const r = await serperSearch(query, maxResults);
        if (r.length > 0) {
          if (!cjk || resultsRelevant(query, r)) results = dedupeResults(r);
          else irrelevant += 1;
        } else {
          anyEmpty = true;
        }
      } catch (err: any) {
        failed.push(`Serper: ${err?.message ?? String(err)}`);
      }
    }

    // 2) Tavily API backend (the approach Claude Code / opencode use): opt-in
    // via the TAVILY_API_KEY env var. Mirrors the Rust web_search — on
    // failure or (for CJK) a relevance-gated-out set, degrade to the free
    // HTML backends below.
    if (process.env.TAVILY_API_KEY?.trim()) {
      try {
        const r = await tavilySearch(query, maxResults);
        if (r.length > 0) {
          // API results are usually on-topic; the CJK relevance gate still
          // applies so a bad API answer degrades to scraping.
          if (!cjk || resultsRelevant(query, r)) results = dedupeResults(r);
          else irrelevant += 1;
        } else {
          anyEmpty = true;
        }
      } catch (err: any) {
        failed.push(`Tavily: ${err?.message ?? String(err)}`);
      }
    }

    // Free HTML backends, probed IN PARALLEL by firstRelevantResult below
    // (first set that passes the CJK relevance gate wins). CJK queries add
    // Sogou + cn.bing.com — Sogou is the only major Chinese engine reachable
    // without a captcha that returns genuinely relevant results (cn.bing.com
    // returns Xi'an tourism guides for "西安到重庆 机票", Baidu redirects to a
    // captcha); non-CJK probes DuckDuckGo + Bing. Same parallel first-win
    // design as the Rust desktop backend, which probes cn.bing.com →
    // DuckDuckGo → Bing (no Sogou on the Rust side).
    const backends: Array<{ label: string; fetch: () => Promise<SearchResult[]> }> = [
      ...(cjk
        ? [
            {
              label: 'Sogou',
              fetch: async () => {
                const resp = await fetch(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`, {
                  headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
                  redirect: 'follow',
                  signal: AbortSignal.timeout(8000),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return parseSogouResults(await readResponseText(resp), maxResults);
              },
            },
            {
              label: 'cn.bing.com',
              fetch: async () => {
                const resp = await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
                  headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
                  redirect: 'follow',
                  signal: AbortSignal.timeout(8000),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return parseBingResults(await readResponseText(resp), maxResults);
              },
            },
          ]
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
          return parseDuckDuckGoResults(await readResponseText(resp), maxResults);
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
          return parseBingResults(await readResponseText(resp), maxResults);
        },
      },
    ];

    // 2) Free HTML backends, probed IN PARALLEL — first relevant set wins
    // ("first win"), so a dead/slow/irrelevant backend no longer serializes
    // the search. Mirrors the Rust run_html_backends_parallel.
    if (results.length === 0) {
      const outcome = await firstRelevantResult(query, backends);
      if (outcome.results) {
        results = outcome.results;
      } else {
        failed.push(...outcome.failed);
        anyEmpty = anyEmpty || outcome.anyEmpty;
        irrelevant += outcome.irrelevant;
      }
    }

    if (results.length === 0) {
      // Backends answered but nothing usable (empty OR relevance-gated-out OR
      // all unreachable): the actionable guidance is the same — the query
      // itself needs rephrasing, or the search infra is down.
      if (anyEmpty || irrelevant > 0) {
        // When some backends were unreachable, say so — the model should not
        // conclude the query is bad when the real cause was network.
        const unreachable = failed.length > 0 ? ` (some backends unreachable: ${failed.join('; ')})` : '';
        return {
          id: `tool_${Date.now()}`,
          toolName: 'web_search',
          result: `No results found for "${query}" on the available search backends (Tavily, Sogou, cn.bing.com, DuckDuckGo, Bing) — the backends returned either no hits or only content unrelated to the query${unreachable}. Do NOT repeat the same query — rephrase it (broader terms, simpler wording, or English), or use web_fetch on a URL you expect to contain the information.`,
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
    const abort = createAbortController(signal, 30000);

    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: abort.signal,
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

      const html = await readResponseText(resp);
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
    } finally {
      abort.cleanup();
    }
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
    const batch = await this.captureWriteBatch('replace_files', files);

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
    const undoAvailable = totalOccurrences > 0 ? await this.tryFinishWriteBatch(batch, files) : false;

    return {
      id: `tool_${Date.now()}`,
      toolName: 'replace_files',
      result: `${summary}${totalOccurrences > 0 && !undoAvailable ? ' (当前写入未提供撤销快照)' : ''}\n${results.join('\n')}`,
      success: errors === 0,
      duration: Date.now() - start,
    };
  }

  private async handleGitCmd(_args: Record<string, unknown>, gitArgs: string[], signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const abort = createAbortController(signal, this.commandTimeout);

    try {
      const proc = Bun.spawn(['git', ...gitArgs], {
        cwd: this.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
        signal: abort.signal,
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
    } finally {
      abort.cleanup();
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
    // Mirrors the Rust sys_info output shape (timezone/language/time/os
    // aligned under the same 10-char label column) plus the user-configured
    // location when present (CLI: PURE_LOCATION / PURE_CITY env var) and the
    // installed runtimes (node / bun / python3 / rustc / git --version).
    const location = this.location
      ? `${this.location} (user-set)`
      : 'not set';
    const runtimes = detectRuntimeVersions().join('  ');

    return {
      id: `tool_${Date.now()}`,
      toolName: 'sys_info',
      result: `timezone:  ${tz}\nlanguage:  ${lang}\ntime:      ${time}\nos:        ${osVersion}\nlocation:  ${location}\nruntimes:  ${runtimes}`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async captureWriteBatch(toolName: string, paths: string[]): Promise<WorkspaceSnapshotBatch> {
    this.latestWriteBatch = null;
    const entries: WorkspaceSnapshotEntry[] = [];
    for (const path of [...new Set(paths)]) {
      if (hasSymlinkComponent(this.workspace, path)) {
        throw new Error(`Snapshot refuses symlink path: ${path}`);
      }
      const full = this.resolve(path);
      if (!existsSync(full)) {
        entries.push({ path, existed: false, kind: 'file' });
        continue;
      }
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        entries.push({ path, existed: true, kind: 'directory' });
      } else {
        const content = await Bun.file(full).text();
        if (new TextEncoder().encode(content).byteLength > this.maxSnapshotBytes) {
          throw new Error(`Snapshot too large for ${path}; write was not performed.`);
        }
        entries.push({ path, existed: true, kind: 'file', content });
      }
    }
    return {
      id: `snapshot_${this.sessionId || 'session'}_${++this.snapshotSequence}`,
      sessionId: this.sessionId,
      workspace: this.workspace,
      toolName,
      createdAt: Date.now(),
      entries,
    };
  }

  private async finishWriteBatch(batch: WorkspaceSnapshotBatch, changedPaths: string[]): Promise<boolean> {
    const changed = new Set(changedPaths);
    const finished: WorkspaceSnapshotEntry[] = [];
    for (const entry of batch.entries) {
      if (!changed.has(entry.path)) continue;
      const full = this.resolve(entry.path);
      if (existsSync(full) && !lstatSync(full).isDirectory()) {
        entry.afterContent = await Bun.file(full).text();
        if (new TextEncoder().encode(entry.afterContent).byteLength > this.maxSnapshotBytes) continue;
        if (!entry.existed || entry.afterContent !== entry.content) finished.push(entry);
      } else if (!entry.existed && existsSync(full)) {
        finished.push(entry);
      }
    }
    batch.entries = finished;
    if (finished.length > 0) this.latestWriteBatch = batch;
    return finished.length > 0;
  }

  private async tryFinishWriteBatch(batch: WorkspaceSnapshotBatch, changedPaths: string[]): Promise<boolean> {
    try {
      return await this.finishWriteBatch(batch, changedPaths);
    } catch {
      return false;
    }
  }

  private async undoLastWriteBatch(): Promise<WorkspaceRestoreResult> {
    const batch = this.latestWriteBatch;
    if (!batch) {
      return { restored: false, restoredPaths: [], removedPaths: [], conflicts: [], message: '没有可撤销的写入。' };
    }
    this.latestWriteBatch = null;
    const restoredPaths: string[] = [];
    const removedPaths: string[] = [];
    const conflicts: string[] = [];
    for (const entry of [...batch.entries].reverse()) {
      try {
      if (hasSymlinkComponent(this.workspace, entry.path)) {
        conflicts.push(entry.path);
        continue;
      }
      let full: string;
      try { full = this.resolve(entry.path); } catch { conflicts.push(entry.path); continue; }
      const exists = existsSync(full);
      const currentIsDirectory = exists && lstatSync(full).isDirectory();
      if (!entry.existed) {
        if (!exists) continue;
        if ((entry.kind === 'directory') !== currentIsDirectory) {
          conflicts.push(entry.path);
          continue;
        }
        if (entry.kind === 'directory') {
          try { await rm(full, { recursive: false }); removedPaths.push(entry.path); }
          catch { conflicts.push(entry.path); }
          continue;
        }
        if (entry.afterContent !== undefined && (await Bun.file(full).text()) !== entry.afterContent) {
          conflicts.push(entry.path);
          continue;
        }
        try { await rm(full); removedPaths.push(entry.path); } catch { conflicts.push(entry.path); }
        continue;
      }
      if (entry.kind === 'directory') {
        if (!exists || !currentIsDirectory) {
          conflicts.push(entry.path);
          continue;
        }
        await mkdir(full, { recursive: true });
        restoredPaths.push(entry.path);
        continue;
      }
      if (!exists || currentIsDirectory) {
        conflicts.push(entry.path);
        continue;
      }
      if (entry.afterContent !== undefined && (await Bun.file(full).text()) !== entry.afterContent) {
        conflicts.push(entry.path);
        continue;
      }
      await mkdir(dirname(full), { recursive: true });
      await Bun.write(full, entry.content ?? '');
      restoredPaths.push(entry.path);
      } catch {
        conflicts.push(entry.path);
      }
    }
    this.latestWriteBatch = conflicts.length > 0
      ? { ...batch, entries: batch.entries.filter((entry) => conflicts.includes(entry.path)) }
      : null;
    const restored = conflicts.length === 0;
    return {
      restored,
      batchId: batch.id,
      restoredPaths,
      removedPaths,
      conflicts,
      message: restored
        ? `已撤销最近一次写入：${[...restoredPaths, ...removedPaths].join('、') || '无文件变化'}`
        : `撤销遇到并发修改，未覆盖：${conflicts.join('、')}`,
    };
  }

  // ── Helpers ──

  private resolve(filePath: string): string {
    const resolved = pathResolve(this.workspace, filePath);
    const rel = pathRelative(this.workspace, resolved);
    // Path escape check mirroring the Rust resolve(): the relative path must
    // stay strictly inside the workspace. On Windows pathRelative uses a
    // single `\` separator (path.sep) and returns an ABSOLUTE path when the
    // two inputs are on different drives — both must be handled, or a
    // different-drive absolute path would slip past the prefix checks.
    if (!isWithin(this.workspace, resolved)) {
      throw new Error(`Path escapes workspace: ${filePath}`);
    }

    const baseCanonical = realpathSync(this.workspace);
    let existing = resolved;
    const missing: string[] = [];
    while (!existsSync(existing)) {
      if (lstatSync(existing, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error(`Path uses an unresolved symlink: ${filePath}`);
      }
      const parent = dirname(existing);
      if (parent === existing) throw new Error(`Path cannot be resolved: ${filePath}`);
      missing.push(basename(existing));
      existing = parent;
    }

    const canonicalExisting = realpathSync(existing);
    if (!isWithin(baseCanonical, canonicalExisting)) {
      throw new Error(`Path escapes workspace: ${filePath}`);
    }

    let safePath = canonicalExisting;
    for (const component of missing.reverse()) safePath = pathResolve(safePath, component);
    return safePath;
  }

  private fail(toolCall: ToolCall | null, start: number, error: string, fallbackToolName?: string): ToolResult {
    return {
      id: `tool_${Date.now()}`,
      toolName: toolCall?.function?.name ?? fallbackToolName ?? 'unknown',
      error,
      success: false,
      duration: Date.now() - start,
    };
  }
}

type EditMatch = {
  text: string;
  old: string;
  normalizedText: string;
  normalizedOld: string;
  index: number;
  lineEnding: 'lf' | 'crlf';
};

/** Match an exact edit first, then retry only for a line-ending difference.
 * The fallback never changes whitespace or chooses an approximate snippet: it
 * maps the normalized match back to the exact bytes currently on disk. */
function findEditMatch(text: string, oldString: string): EditMatch | null {    const lineEnding = text.includes('\r\n') ? 'crlf' : 'lf';
    const exactIndex = lineEnding === 'crlf' && oldString.includes('\n') && !oldString.includes('\r\n')
      ? -1
      : text.indexOf(oldString);
  if (exactIndex >= 0) {
    return {
      text,
      old: oldString,
      normalizedText: text.replace(/\r\n/g, '\n'),
      normalizedOld: oldString.replace(/\r\n/g, '\n'),
      index: exactIndex,
      lineEnding,
    };
  }

  if (!oldString.includes('\n') && !oldString.includes('\r\n')) return null;
  const normalizedText = text.replace(/\r\n/g, '\n');
  const normalizedOld = oldString.replace(/\r\n/g, '\n');
  const normalizedIndex = normalizedText.indexOf(normalizedOld);
  if (normalizedIndex < 0) return null;

  let normalizedOffset = 0;
  let originalIndex = 0;
  while (normalizedOffset < normalizedIndex) {
    if (text.startsWith('\r\n', originalIndex)) {
      originalIndex += 2;
    } else {
      originalIndex += 1;
    }
    normalizedOffset += 1;
  }
  const old = normalizedText.slice(normalizedIndex, normalizedIndex + normalizedOld.length)
    .replace(/\n/g, lineEnding === 'crlf' ? '\r\n' : '\n');
  return {
    text,
    old,
    normalizedText,
    normalizedOld,
    index: originalIndex,
    lineEnding,
  };
}

function editStringNotFoundError(path: string, oldString: string): string {
  const preview = oldString.replace(/\r?\n/g, '\\n').slice(0, 160);
  return `String not found in file: ${preview}. The file may have changed since it was read. Re-read ${path}, do not retry this identical edit, then use a shorter exact context from the current file.`;
}

/** Probe installed runtime versions (node / bun / python3 / rustc / git --version),
 * mirroring detect_runtime_versions in src-tauri/src/lib.rs. python3 prints
 * to stderr, so both streams are checked. Never throws. */
export function detectRuntimeVersions(): string[] {
  const out: string[] = [];
  for (const [label, args] of [
    ['node', ['--version']],
    ['bun', ['--version']],
    ['python3', ['--version']],
    ['rustc', ['--version']],
    ['git', ['--version']],
  ] as const) {
    let version = 'not installed';
    try {
      const r = Bun.spawnSync({ cmd: [label, ...args], stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode === 0) {
        // Collapse internal whitespace/newlines: version output lands in the
        // system prompt verbatim, so multi-line banners must not break out of
        // the context sentence (also mirrors the chat.ts first-line regex).
        const text = (new TextDecoder().decode(r.stdout).trim() || new TextDecoder().decode(r.stderr).trim()).replace(/\s+/g, ' ');
        if (text) version = text;
      }
    } catch {}
    out.push(`${label}: ${version}`);
  }
  return out;
}

/** True when `target` resolves strictly inside `base` (both canonicalized
 * before comparison). Uses the platform separator (path.sep) — a single `\`
 * on Windows, which a hardcoded escaped `\\` would never match — and treats
 * an absolute relative() result (different drives on Windows) as an escape.
 * Mirrors the Rust resolve() containment check. */
function isWithin(base: string, target: string): boolean {
  const rel = pathRelative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
  return !isAbsolute(rel);
}

function hasSymlinkComponent(base: string, filePath: string): boolean {
  const candidate = pathResolve(base, filePath);
  if (!isWithin(base, candidate)) return true;
  const rel = pathRelative(base, candidate);
  let current = base;
  for (const component of rel.split(sep)) {
    if (!component || component === '.') continue;
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      break;
    }
  }
  return false;
}

function createAbortController(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  abort: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

// Browser User-Agent: search engines and many sites block the bare "Pure/1.0"
// string, which surfaced as a wall of generic HTTP errors. A real browser UA
// keeps both search backends and web_fetch targets responsive.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ── Charset-aware HTTP body decoding ──
// `Response.text()` always decodes the body as UTF-8 (the Fetch spec mandates
// it), so GBK/GB2312 pages — very common on Chinese sites (Sogou, many 门户
// sites) — would otherwise come back as mojibake. The charset is resolved in
// priority order: Content-Type header charset → HTML <meta> charset sniff →
// UTF-8. Mirrors decode_response_with_charset in src-tauri/src/lib.rs.

/** Extract the charset parameter from a Content-Type header, if declared. */
export function charsetFromContentType(contentType: string): string | undefined {
  const m = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return m?.[1];
}

/** Sniff `<meta charset=…>` / `<meta http-equiv="Content-Type" content="…charset=…">`
 * from the first bytes of an HTML page. The meta tag is ASCII, so scanning a
 * lossily-UTF-8-decoded head slice is safe even when the body is GBK. */
export function sniffHtmlCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('utf-8').decode(bytes.slice(0, 2048));
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_\-]+)/i);
  return m?.[1];
}

/** Decode a response body with the resolved charset, falling back to UTF-8.
 * `TextDecoder` itself normalizes WHATWG labels (GB2312/gb_2312-80 → GBK), so
 * the declared label is passed through; utf-8-family and latin1 labels (the
 * common mislabel for actually-UTF-8 pages) skip re-decoding to avoid
 * regressions. */
export async function readResponseText(resp: Response): Promise<string> {
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const label = normalizeCharsetLabel(
    charsetFromContentType(resp.headers.get('content-type') || '') ?? sniffHtmlCharset(bytes),
  );
  if (!label) return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function normalizeCharsetLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const l = label.trim().toLowerCase();
  // UTF-8 family needs no re-decode; iso-8859-1/latin1 is the classic
  // mislabel on pages that are actually UTF-8, so keep the UTF-8 behavior
  // rather than windows-1252-decode them into mojibake.
  if (!l || /^(utf-?8|us-ascii|ascii|iso-?8859-?1|latin-?1)$/.test(l)) return undefined;
  return l;
}

// ── DuckDuckGo HTML result parser ──

// ── Web search helpers (Tavily API + parallel first-win, mirrors lib.rs) ──

/**
 * Serper.dev Google SERP API backend: a real Google index — the best quality
 * for both Chinese and English, captcha-free. ~2500 free trial queries, then
 * prepaid credits (~$0.3–1 per 1k). Enabled when SERPER_API_KEY is set;
 * throws otherwise so callers degrade to Tavily / scraping. Mirrors the Rust
 * search_backend_serper in lib.rs (same gl/hl selection for CJK).
 */
export async function serperSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY?.trim();
  if (!apiKey) throw new Error('SERPER_API_KEY not set');
  const cjk = containsCJK(query);
  const resp = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({
      q: query,
      gl: cjk ? 'cn' : 'us',
      hl: cjk ? 'zh-cn' : 'en',
      num: maxResults,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data: { organic?: Array<{ title?: string; link?: string; snippet?: string }> } = await resp.json();
  return (data.organic ?? [])
    .filter((r) => r.title && r.link)
    .map((r) => ({ title: r.title!, snippet: r.snippet ?? '', url: r.link! }));
}

/**
 * Tavily Search API backend (used by Claude Code / opencode-class agents):
 * stable index, captcha-free, good Chinese coverage. Enabled when
 * TAVILY_API_KEY is set; throws otherwise so callers degrade to scraping.
 */
export async function tavilySearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) throw new Error('TAVILY_API_KEY not set');
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data: { results?: Array<{ title?: string; url?: string; content?: string }> } = await resp.json();
  return (data.results ?? [])
    .filter((r) => r.title && r.url)
    .map((r) => ({ title: r.title!, snippet: r.content ?? '', url: r.url! }));
}

/**
 * Probe all HTML backends concurrently and return the first result set that
 * passes the relevance gate ("first win"). A backend that errors, returns
 * empty, or fails the gate just drops out; if none survives, the aggregated
 * failure info lets the caller compose the right message. O(backends) memory
 * for the pending-promise set is fine (≤4 backends).
 */
export async function firstRelevantResult(
  query: string,
  backends: Array<{ label: string; fetch: () => Promise<SearchResult[]> }>,
): Promise<{ results?: SearchResult[]; failed: string[]; anyEmpty: boolean; irrelevant: number }> {
  const failed: string[] = [];
  let anyEmpty = false;
  let irrelevant = 0;
  let pending = backends.map((b, i) =>
    b.fetch().then(
      (r) => ({ i, r }),
      (err: any) => ({ i, error: err?.message ?? String(err) }),
    ),
  );
  while (pending.length > 0) {
    // Race the current pending set; the resolved VALUE carries the ORIGINAL
    // backend index (captured at creation) while pendingIndex is the index
    // within the CURRENT (shrinking) array — the two must stay separate so
    // removing a finished task never mislabels a later one.
    const { value, pendingIndex } = await Promise.race(
      pending.map((p, idx) => p.then((v) => ({ value: v, pendingIndex: idx }))),
    );
    pending = pending.filter((_, k) => k !== pendingIndex);
    if ('error' in value) {
      failed.push(`${backends[value.i].label}: ${value.error}`);
      continue;
    }
    if (value.r.length > 0) {
      // Relevance gate: a set that does not address the query must not be
      // handed to the model — it is what pushed the agent into repeated
      // searches. Gated-out sets drop out like empty ones.
      if (resultsRelevant(query, value.r)) {
        return { results: dedupeResults(value.r), failed, anyEmpty, irrelevant };
      }
      irrelevant += 1;
    } else {
      anyEmpty = true;
    }
  }
  return { failed, anyEmpty, irrelevant };
}

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

// ── Sogou HTML result parser (CJK-priority backend) ──

/** Parse Sogou results (`<h3 class="vr-title …">` blocks with a single
 * `<a href="…">TITLE</a>`, snippet in the block's trailing
 * `<p class="star-wiki …">` or `<div class="fz-mid space-txt">`). Sogou
 * highlights matched terms with `<em><!--red_beg-->…<!--red_end--></em>` inside
 * titles — the title is stripped to `</a>` (NOT to the first '<' like the Bing
 * parser, whose titles have no nested tags). `/link?url=…` redirects are
 * absolutized to `https://www.sogou.com/…` so the model can still web_fetch
 * them. Dedupes by URL/title. Mirrors src-tauri/src/lib.rs
 * `parse_sogou_results` — both sides have matching tests. */
export function parseSogouResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  let pos = 0;
  while (results.length < maxResults) {
    const relH3 = html.indexOf('<h3', pos);
    if (relH3 === -1) break;
    // Block = this <h3> through the start of the next <h3> (or end of page):
    // the anchor/title live inside the h3, while the snippet container
    // (<p class="star-wiki"> / <div class="fz-mid space-txt">) sits right
    // AFTER </h3>, before the next result block.
    const afterH3 = relH3 + 3;
    const nextRel = html.indexOf('<h3', afterH3);
    const nextH3 = nextRel === -1 ? html.length : nextRel;
    const block = html.slice(relH3, nextH3);
    const parsed = parseSogouBlock(block);
    if (parsed && !results.some(x => x.url === parsed.url || x.title === parsed.title)) {
      results.push(parsed);
    }
    pos = nextH3;
  }
  return results;
}

function parseSogouBlock(block: string): SearchResult | undefined {
  const aIdx = block.indexOf('<a');
  if (aIdx === -1) return undefined;
  const rawUrl = extractHref(block, aIdx);
  if (!rawUrl) return undefined;
  // Absolutize Sogou's relative redirect links (/link?url=…, //www.sogou.com/…).
  let url = rawUrl;
  if (url.startsWith('//')) url = `https:${url}`;
  else if (url.startsWith('/')) url = `https://www.sogou.com${url}`;

  // Title: anchor text, stripped to </a> — Sogou bolds matched terms with <em>
  // INSIDE the title text, so stripping to the first '<' would cut the title
  // short; strip tags and keep everything up to </a>.
  const afterA = block.slice(aIdx);
  const gt = afterA.indexOf('>');
  if (gt === -1) return undefined;
  const afterGt = afterA.slice(gt + 1);
  const anchorEnd = afterGt.indexOf('</a>');
  if (anchorEnd === -1) return undefined;
  const title = decodeHtmlEntities(stripHtml(afterGt.slice(0, anchorEnd))).trim();

  // Snippet: star-wiki <p> first (organic results), else the fz-mid div
  // (zhihu/other layouts). Both sit after the anchor inside the h3 block.
  let snippet = '';
  const region = afterGt.slice(anchorEnd + '</a>'.length);
  const star = region.indexOf('<p class="star-wiki');
  if (star !== -1) {
    const afterStar = region.slice(star);
    const starGt = afterStar.indexOf('>');
    if (starGt !== -1) {
      const content = afterStar.slice(starGt + 1);
      const end = content.indexOf('</p>');
      if (end !== -1) snippet = content.slice(0, end);
    }
  } else {
    // fz-mid div (zhihu/other layouts). Substring search so a reordered class
    // list ("space-txt fz-mid") still matches; the star-wiki <p> was already
    // ruled out above, so a stray match here is a genuine snippet container.
    const fz = region.indexOf('fz-mid');
    if (fz !== -1) {
      const afterFz = region.slice(fz);
      const fzGt = afterFz.indexOf('>');
      if (fzGt !== -1) {
        const content = afterFz.slice(fzGt + 1);
        const end = content.indexOf('</div>');
        if (end !== -1) snippet = content.slice(0, end);
      }
    }
  }
  snippet = decodeHtmlEntities(stripHtml(snippet)).trim();

  if (!title || !url) return undefined;
  return { title, snippet, url };
}

// ── Relevance gate (keeps garbage result sets from reaching the model) ──

/** Chars that glue Chinese queries together (particles / prepositions /
 * function words) — a CJK bigram containing one is NOT a meaningful content
 * token ("西安到重庆" keeps 西安/重庆; 安到/到重 are dropped). Content words like
 * 时间/价格/大小 are deliberately NOT here — they are what relevance is
 * measured against. Mirrors src-tauri/src/lib.rs `significant_cjk_bigrams`
 * (same table, same semantics). */
const CJK_FUNCTION_CHARS = new Set(
  // Particles / prepositions / function words that glue CJK queries together.
  // Direction/position words (上下左右前后内外中) are deliberately ABSENT — 上/中
  // etc. start too many content words (上海/中国) for them to be safe to drop.
  '到从的与和及了在是这那之而或把被让为对于等些个吗呢吧啊呀过并但可就最很也都' +
  '不没无来去要将会正已经还又请问想有里给做用得着所以且者起向往自从于对'.split(''),
);

function isCJKChar(c: string): boolean {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(c);
}

/** Significant CJK content bigrams of a query (deduped, glue chars dropped).
 * Mirrors the Rust side; exported for the mirror tests. */
export function significantCJKBigrams(query: string): string[] {
  const chars = [...query];
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) {
    const a = chars[i];
    const b = chars[i + 1];
    if (isCJKChar(a) && isCJKChar(b) && !CJK_FUNCTION_CHARS.has(a) && !CJK_FUNCTION_CHARS.has(b)) {
      out.add(a + b);
    }
  }
  return [...out];
}

/** Relevance gate: accept a backend's result set only if the top-5 results
 * actually address the query. For CJK queries this means covering the query's
 * significant bigrams (cn.bing.com returning Xi'an tourism guides for
 * "西安到重庆 机票" covers only 西安 → 1/3 → REJECTED, so the chain rolls over
 * instead of handing the model garbage that triggers repeated searches).
 * Accept when ≥2 distinct bigrams are covered, or ≥ half of a short query's
 * bigrams. Non-CJK queries and queries with <2 significant bigrams are always
 * accepted. Mirrors src-tauri/src/lib.rs `results_relevant`. */
export function resultsRelevant(query: string, results: SearchResult[]): boolean {
  const sig = significantCJKBigrams(query);
  if (sig.length < 2) return true;
  const covered = new Set<string>();
  for (const r of results.slice(0, 5)) {
    const hay = `${r.title}\n${r.snippet}\n${r.url}`;
    for (const bg of sig) {
      if (hay.includes(bg)) covered.add(bg);
    }
  }
  if (covered.size >= 2) return true;
  return covered.size / sig.length >= 0.5;
}

/** Drop duplicate results (same URL or same title) — search pages repeat
 * entries across sections, and duplicated titles confuse the LLM. */
export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter(r => {
    const key = r.url || r.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
