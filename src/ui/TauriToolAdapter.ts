// src/ui/TauriToolAdapter.ts
// v0.2 — ToolAdapter implementation that uses Tauri IPC invoke() for tool execution.
// For Vite dev (no Tauri runtime), falls back to returning no available tools.
// Removed tools that don't have Rust backend implementations (edit_file, search_files, list_files).

import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../shared/types';

// ── Tool definitions (mirrors src/ui/tools.ts TOOL_DEFS, only tools with Rust backend) ──

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace. Optionally specify startLine and endLine to read a range.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        startLine: { type: 'integer', description: 'Optional: first line to read (1-indexed)' },
        endLine: { type: 'integer', description: 'Optional: last line to read (inclusive)' },
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
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace a string in a file. Must provide exact oldString and newString.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        oldString: { type: 'string', description: 'Exact string to find and replace' },
        newString: { type: 'string', description: 'Replacement string' },
        allowMultiple: { type: 'boolean', description: 'Replace all occurrences' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for a pattern in workspace files. Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern' },
        path: { type: 'string', description: 'Directory to search (relative to workspace)' },
        filePattern: { type: 'string', description: 'Glob filter, e.g. "*.ts"' },
        maxResults: { type: 'integer', description: 'Max results (default 50)' },
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
        path: { type: 'string', description: 'Directory to list (relative to workspace)' },
        recursive: { type: 'boolean', description: 'List recursively' },
      },
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
];

const TOOL_METADATA: Record<string, { sideEffects: boolean; isWrite: boolean }> = {
  read_file: { sideEffects: false, isWrite: false },
  write_file: { sideEffects: true, isWrite: true },
  edit_file: { sideEffects: true, isWrite: true },
  search_files: { sideEffects: false, isWrite: false },
  list_files: { sideEffects: false, isWrite: false },
  execute_command: { sideEffects: true, isWrite: true },
  git_diff: { sideEffects: false, isWrite: false },
  git_log: { sideEffects: false, isWrite: false },
  git_status: { sideEffects: false, isWrite: false },
};

type InvokeFunction = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

// ── Static Tauri invoke loader ──
// Loads once at module level so adapters don't need async init per-constructor.

let tauriInvoke: InvokeFunction | null = null;

async function initTauriInvoke() {
  try {
    const mod = await import('@tauri-apps/api/core');
    if (typeof mod.invoke === 'function') {
      tauriInvoke = mod.invoke as InvokeFunction;
    }
  } catch {
    // No Tauri runtime — tools will be unavailable
  }
}
initTauriInvoke();

export class TauriToolAdapter implements ToolAdapter {
  private workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  getTools(): ToolDefinition[] {
    return tauriInvoke ? TOOL_DEFINITIONS : [];
  }

  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean } | undefined {
    return TOOL_METADATA[toolName];
  }

  async execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    if (!tauriInvoke) {
      return {
        id: toolCall.id,
        toolName: toolCall.function.name,
        error: 'Tauri runtime not available — tools disabled',
        success: false,
        duration: 0,
      };
    }

    const start = Date.now();
    const args = safeParseArgs(toolCall.function.arguments);
    const name = toolCall.function.name;
    const ws = this.workspace;

    try {
      switch (name) {
        case 'read_file': {
          const content = await tauriInvoke('read_file', { workspace: ws, path: String(args.path ?? '') }) as string;
          const s = typeof args.startLine === 'number' ? args.startLine - 1 : 0;
          const e = typeof args.endLine === 'number' ? args.endLine : undefined;
          if (s > 0 || e !== undefined) {
            const lines = content.split('\n');
            return { id: toolCall.id, toolName: name, result: lines.slice(s, e).join('\n'), success: true, duration: Date.now() - start };
          }
          return { id: toolCall.id, toolName: name, result: content, success: true, duration: Date.now() - start };
        }
        case 'write_file': {
          const msg = await tauriInvoke('write_file', { workspace: ws, path: String(args.path ?? ''), content: String(args.content ?? '') }) as string;
          return { id: toolCall.id, toolName: name, result: msg, success: true, duration: Date.now() - start };
        }
        case 'edit_file': {
          const editMsg = await tauriInvoke('edit_file', {
            workspace: ws,
            path: String(args.path ?? ''),
            oldString: String(args.oldString ?? ''),
            newString: String(args.newString ?? ''),
            allowMultiple: Boolean(args.allowMultiple),
          }) as string;
          return { id: toolCall.id, toolName: name, result: editMsg, success: true, duration: Date.now() - start };
        }
        case 'search_files': {
          const searchResult = await tauriInvoke('search_files', {
            workspace: ws,
            pattern: String(args.pattern ?? ''),
            path: args.path ?? null,
            filePattern: args.filePattern ?? null,
            maxResults: args.maxResults ?? 50,
          }) as string;
          return { id: toolCall.id, toolName: name, result: searchResult, success: true, duration: Date.now() - start };
        }
        case 'list_files': {
          const listing = await tauriInvoke('list_files', {
            workspace: ws,
            path: String(args.path ?? '.'),
            recursive: Boolean(args.recursive),
          }) as string;
          return { id: toolCall.id, toolName: name, result: listing, success: true, duration: Date.now() - start };
        }
        case 'execute_command': {
          const output = await tauriInvoke('execute_command', { workspace: ws, command: String(args.command ?? '') }) as string;
          return { id: toolCall.id, toolName: name, result: output, success: true, duration: Date.now() - start };
        }
        case 'git_diff': {
          const diff = await tauriInvoke('git_diff', { workspace: ws, staged: args.staged ?? false, path: args.path ?? null }) as string;
          return { id: toolCall.id, toolName: name, result: diff, success: true, duration: Date.now() - start };
        }
        case 'git_log': {
          const log = await tauriInvoke('git_log', { workspace: ws, maxCount: args.maxCount ?? null, oneline: args.oneline ?? true }) as string;
          return { id: toolCall.id, toolName: name, result: log, success: true, duration: Date.now() - start };
        }
        case 'git_status': {
          const status = await tauriInvoke('git_status', { workspace: ws }) as string;
          return { id: toolCall.id, toolName: name, result: status, success: true, duration: Date.now() - start };
        }
        default:
          return {
            id: toolCall.id,
            toolName: name,
            error: `Unknown tool: ${name}. Available: read_file, write_file, execute_command, git_diff, git_log, git_status`,
            success: false,
            duration: Date.now() - start,
          };
      }
    } catch (err: any) {
      return { id: toolCall.id, toolName: name, error: err?.message ?? String(err), success: false, duration: Date.now() - start };
    }
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw); } catch { return {}; }
}
