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

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      return {
        id: `tool_${Date.now()}`,
        toolName: 'execute_command',
        result: { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: proc.exitCode },
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
