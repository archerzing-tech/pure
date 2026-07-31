// src/ui/tools.ts
// Tauri tool adapter — bridges the GUI to native file/command/git tools via invoke().

import { invoke } from '@tauri-apps/api/core';

export interface ToolResult {
  toolName: string;
  output: string;
  success: boolean;
  error?: string;
}

const TOOL_DEFS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace. Optionally specify startLine and endLine to read a range.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
          startLine: { type: 'integer', description: 'Optional: first line to read (1-indexed)' },
          endLine: { type: 'integer', description: 'Optional: last line to read (inclusive)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file in the workspace. Parent directories are created automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'execute_command',
      description: 'Execute a shell command in the workspace directory. Returns stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  // ── v0.5.4: Git tools ──
  {
    type: 'function' as const,
    function: {
      name: 'git_diff',
      description: 'Show git diff (unstaged changes) in the workspace. Set staged=true to show staged changes. Optionally limit to a specific file path.',
      parameters: {
        type: 'object',
        properties: {
          staged: { type: 'boolean', description: 'Show staged changes instead of unstaged' },
          path: { type: 'string', description: 'Limit diff to a specific file path' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_log',
      description: 'Show recent git commit history. Defaults to last 10 commits, one line each.',
      parameters: {
        type: 'object',
        properties: {
          maxCount: { type: 'integer', description: 'Maximum number of commits to show (default: 10)' },
          oneline: { type: 'boolean', description: 'Show one line per commit (default: true)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_status',
      description: 'Show working tree status — modified, added, deleted, and untracked files.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

export function getToolDefs() {
  return TOOL_DEFS;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'read_file': {
        const content = await invoke<string>('read_file', {
          workspace,
          path: String(args.path ?? ''),
        });
        const start = typeof args.startLine === 'number' ? args.startLine - 1 : 0;
        const end = typeof args.endLine === 'number' ? args.endLine : undefined;
        if (start > 0 || end !== undefined) {
          const lines = content.split('\n');
          const sliced = lines.slice(start, end);
          return { toolName: name, output: sliced.join('\n'), success: true };
        }
        return { toolName: name, output: content, success: true };
      }
      case 'write_file': {
        const msg = await invoke<string>('write_file', {
          workspace,
          path: String(args.path ?? ''),
          content: String(args.content ?? ''),
        });
        return { toolName: name, output: msg, success: true };
      }
      case 'execute_command': {
        const output = await invoke<string>('execute_command', {
          workspace,
          command: String(args.command ?? ''),
        });
        return { toolName: name, output, success: true };
      }
      case 'git_diff': {
        const output = await invoke<string>('git_diff', {
          workspace,
          staged: args.staged ?? false,
          path: args.path ?? null,
        });
        return { toolName: name, output, success: true };
      }
      case 'git_log': {
        const output = await invoke<string>('git_log', {
          workspace,
          maxCount: args.maxCount ?? null,
          oneline: args.oneline ?? true,
        });
        return { toolName: name, output, success: true };
      }
      case 'git_status': {
        const output = await invoke<string>('git_status', { workspace });
        return { toolName: name, output, success: true };
      }
      default:
        return { toolName: name, output: '', success: false, error: `unknown tool: ${name}` };
    }
  } catch (err: any) {
    return { toolName: name, output: '', success: false, error: String(err) };
  }
}
