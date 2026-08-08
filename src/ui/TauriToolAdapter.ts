// src/ui/TauriToolAdapter.ts
// v0.2 — ToolAdapter implementation that uses Tauri IPC invoke() for tool execution.
// For Vite dev (no Tauri runtime), falls back to returning no available tools.
// Removed tools that don't have Rust backend implementations (edit_file, search_files, list_files).

import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../shared/types';
import type { Channel } from '@tauri-apps/api/core';

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
    description: 'Search the web and return results with titles, snippets, and URLs. With a Serper or Tavily API key configured (Settings → Tools) searches go through the API backends first (Serper = real Google index, best for Chinese and English); otherwise free backends are probed in parallel (Sogou → cn.bing.com → DuckDuckGo → Bing for Chinese queries, DuckDuckGo → Bing otherwise).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'number', description: 'Max results (default 10, max 20)' },
      },
      required: ['query'],
    },
  },    {
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
        },      required: ['files', 'oldString', 'newString'],
    },
  },
  {
    name: 'sys_info',
    description: 'Get operating system information: timezone, language, current time, OS version, installed runtimes (node/bun/python3/rustc/git versions), and the user\'s configured location. When the user asks for the current time, date, timezone, language, OS version, a runtime version, a git capability, or anything that depends on where the user is (trip planning, weather, local services), call sys_info() FIRST — never guess from your training data.',
    input_schema: { type: 'object', properties: {} },
  },
];

/** Web-only subset of TOOL_DEFINITIONS — exported so chat.ts can pin this
 * exact list as the LLM-visible toolsDef in plain-chat mode without
 * duplicating the schema. Order is stable (matches declaration order). */
export function getWebToolDefs(): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((t) => t.name === 'web_search' || t.name === 'web_fetch');
}

/** sys_info tool def — workspace-independent (the Rust backend ignores the
 * workspace field), so plain-chat mode can always advertise it regardless of
 * the browser-tool toggle. */
export function getSysInfoToolDefs(): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((t) => t.name === 'sys_info');
}

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
  create_directory: { sideEffects: true, isWrite: true },
  diff_files: { sideEffects: false, isWrite: false },
  web_search: { sideEffects: false, isWrite: false },
  web_fetch: { sideEffects: false, isWrite: false },
  glob_files: { sideEffects: false, isWrite: false },
  replace_files: { sideEffects: true, isWrite: true },
  sys_info: { sideEffects: false, isWrite: false },
};

type InvokeFunction = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

// ── Static Tauri invoke loader ──
// Loads once at module level so adapters don't need async init per-constructor.

let tauriInvoke: InvokeFunction | null = null;
let tauriChannel: typeof Channel | null = null;

async function initTauriInvoke() {
  try {
    const mod = await import('@tauri-apps/api/core');
    if (typeof mod.invoke === 'function') {
      tauriInvoke = mod.invoke as InvokeFunction;
      tauriChannel = (mod as { Channel?: typeof Channel }).Channel ?? null;
    }
  } catch {
    // No Tauri runtime — tools will be unavailable
  }
}
initTauriInvoke();

// ── Live tool output listener ──
// The Rust backend's execute_command_stream pushes stdout/stderr lines over a
// Channel as the command runs (instead of buffering everything until exit).
// chat.ts registers a listener here so each line lands in the matching tool
// row's Output panel in real time — a long-running command shows progress
// instead of a silent wait. Keyed by the LLM tool call id, the same id the
// engine uses for the id-bearing TokenDelta and the ToolResult event.

export type ToolOutputKind = 'stdout' | 'stderr';
export type ToolOutputListener = (toolCallId: string, kind: ToolOutputKind, line: string) => void;

let toolOutputListener: ToolOutputListener | null = null;

export function setToolOutputListener(fn: ToolOutputListener | null): void {
  toolOutputListener = fn;
}

export class TauriToolAdapter implements ToolAdapter {
  private workspace: string;
  private tavilyApiKey: string;
  private serperApiKey: string;
  private location: string;

  constructor(workspace: string, tavilyApiKey = '', serperApiKey = '', location = '') {
    this.workspace = workspace;
    this.tavilyApiKey = tavilyApiKey;
    this.serperApiKey = serperApiKey;
    this.location = location;
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
          const path = String(args.path ?? '');
          const content = String(args.content ?? '');
          // Stream byte-level progress while the file is written so the tool
          // row shows "正在写入 … 45% (230/512 KB)" instead of a silent
          // "等待输出" wait for the whole (possibly large) write to finish.
          // Progress lines go to the live tool-output listener only — the LLM
          // still gets the single "Wrote N bytes" result, not the noise.
          if (tauriChannel) {
            const channel = new tauriChannel<string>();
            channel.onmessage = (raw: string) => {
              let parsed: { type?: string; written?: number; total?: number } | null = null;
              try { parsed = JSON.parse(raw); } catch { parsed = null; }
              if (!parsed || parsed.type !== 'progress') return;
              toolOutputListener?.(toolCall.id, 'stdout', formatWriteProgress(path, parsed.written ?? 0, parsed.total ?? 0));
            };
            const msg = await tauriInvoke('write_file_stream', {
              workspace: ws,
              path,
              content,
              onProgress: channel,
            }) as string;
            return { id: toolCall.id, toolName: name, result: msg, success: true, duration: Date.now() - start };
          }
          const msg = await tauriInvoke('write_file', { workspace: ws, path, content }) as string;
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
          // Stream the command's output as it is produced so a long-running
          // command (bundle, install, test) shows live progress in the tool
          // row instead of waiting silently for the full buffered result.
          if (tauriChannel) {
            const channel = new tauriChannel<string>();
            // Collected lines keep their stream identity (stdout vs stderr) so
            // the final result can label stderr sections — the LLM needs to
            // tell a warning from an error even when a command fails.
            const collected: Array<{ kind: 'stdout' | 'stderr'; line: string }> = [];
            channel.onmessage = (raw: string) => {
              let parsed: { type?: string; content?: unknown } | null = null;
              try { parsed = JSON.parse(raw); } catch { parsed = null; }
              if (!parsed) return;
              if (parsed.type === 'stdout' || parsed.type === 'stderr') {
                const line = String(parsed.content ?? '');
                collected.push({ kind: parsed.type, line });
                toolOutputListener?.(toolCall.id, parsed.type, line);
              }
            };
            // Cancel wiring: when the engine aborts this tool call (user
            // clicked Stop, or the turn was superseded), ask the Rust backend
            // to kill the running shell tree. Without this, the command keeps
            // running in the background after the GUI stopped listening — a
            // ghost process holding locks, ports, and file handles. The exit
            // code then arrives as -1 (signal-killed); we surface a clear
            // "cancelled" result instead of a confusing exit-code error.
            let cancelled = false;
            const onAbort = () => {
              cancelled = true;
              if (tauriInvoke) {
                tauriInvoke('kill_command', { id: toolCall.id }).catch(() => {});
              }
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
            try {
              const code = await tauriInvoke('execute_command_stream', {
                id: toolCall.id,
                workspace: ws,
                command: String(args.command ?? ''),
                onOutput: channel,
              }) as number;
              if (cancelled) {
                return {
                  id: toolCall.id,
                  toolName: name,
                  result: 'Command cancelled by user.',
                  error: 'Command cancelled by user.',
                  success: false,
                  duration: Date.now() - start,
                };
              }
              return { id: toolCall.id, toolName: name, ...buildCommandResult(code, collected), duration: Date.now() - start };
            } finally {
              // { once: true } already removed it if it fired; this covers the
              // normal-completion case so a reused signal can't fire a stale
              // kill for a command that already exited.
              signal?.removeEventListener('abort', onAbort);
            }
          }
          const exec = await tauriInvoke('execute_command', { workspace: ws, command: String(args.command ?? '') }) as { exitCode: number; stdout: string; stderr: string };
          const execLines: Array<{ kind: 'stdout' | 'stderr'; line: string }> = [
            ...(exec.stdout ? [{ kind: 'stdout' as const, line: exec.stdout }] : []),
            ...(exec.stderr ? [{ kind: 'stderr' as const, line: exec.stderr }] : []),
          ];
          return { id: toolCall.id, toolName: name, ...buildCommandResult(exec.exitCode, execLines), duration: Date.now() - start };
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
        case 'create_directory': {
          const dirMsg = await tauriInvoke('create_directory', { workspace: ws, path: String(args.path ?? '') }) as string;
          return { id: toolCall.id, toolName: name, result: dirMsg, success: true, duration: Date.now() - start };
        }
        case 'diff_files': {
          const diff = await tauriInvoke('diff_files', {
            workspace: ws,
            pathA: String(args.pathA ?? ''),
            pathB: String(args.pathB ?? ''),
          }) as string;
          return { id: toolCall.id, toolName: name, result: diff, success: true, duration: Date.now() - start };
        }
        case 'web_search': {
          const searchData = await tauriInvoke('web_search', buildWebSearchArgs(ws, args, this.tavilyApiKey, this.serperApiKey)) as string;
          return { id: toolCall.id, toolName: name, result: searchData, success: true, duration: Date.now() - start };
        }
        case 'web_fetch': {
          const pageText = await tauriInvoke('web_fetch', {
            workspace: ws,
            url: String(args.url ?? ''),
            maxChars: args.maxChars ?? 20000,
          }) as string;
          return { id: toolCall.id, toolName: name, result: pageText, success: true, duration: Date.now() - start };
        }
        case 'glob_files': {
          const globResult = await tauriInvoke('glob_files', {
            workspace: ws,
            pattern: String(args.pattern ?? ''),
            path: args.path ?? null,
            maxResults: args.maxResults ?? 200,
          }) as string;
          return { id: toolCall.id, toolName: name, result: globResult, success: true, duration: Date.now() - start };
        }
        case 'replace_files': {
          const replaceResult = await tauriInvoke('replace_files', {
            workspace: ws,
            files: Array.isArray(args.files) ? args.files : [],
            oldString: String(args.oldString ?? ''),
            newString: String(args.newString ?? ''),
            allowMultiple: Boolean(args.allowMultiple),
          }) as string;
          return { id: toolCall.id, toolName: name, result: replaceResult, success: true, duration: Date.now() - start };
        }
        case 'sys_info': {
          // The user-configured location (Settings → General → Environment) is
          // forwarded so the model gets the location baseline without a round
          // trip — the Rust command treats it as optional.
          const info = await tauriInvoke('sys_info', { workspace: ws, location: this.location }) as string;
          return { id: toolCall.id, toolName: name, result: info, success: true, duration: Date.now() - start };
        }
        default:
          return {
            id: toolCall.id,
            toolName: name,
            error: `Unknown tool: ${name}. Available: read_file, write_file, edit_file, search_files, list_files, execute_command, create_directory, diff_files, web_search, web_fetch, glob_files, replace_files, git_diff, git_log, git_status, sys_info`,
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

/** Pure arg builder for the web_search invoke. Exported so a unit test locks
 * the exact Tauri arg names (apiKey → Rust api_key, serperApiKey → Rust
 * serper_api_key) — a typo here would only fail at runtime in the packaged
 * app, since tauriInvoke is unavailable in tests. */
export function buildWebSearchArgs(
  workspace: string,
  args: Record<string, unknown>,
  tavilyApiKey: string,
  serperApiKey: string,
): Record<string, unknown> {
  return {
    workspace,
    query: String(args.query ?? ''),
    maxResults: args.maxResults ?? 10,
    // Optional API keys from Settings → Tools: when set, the Rust backend
    // searches via Serper (Google index) then Tavily first, falling back to
    // the free HTML backends otherwise.
    apiKey: tavilyApiKey,
    serperApiKey,
  };
}

// ── Command output formatting (shared by the streamed and buffered paths) ──
// Streamed lines are captured with their stream identity; the final result
// must keep stderr distinguishable so the LLM sees errors as errors. Grouping
// stderr sections under a `[stderr]` marker (mirroring the old Rust-side
// execute_command text format) keeps output readable without interleaving.

/** Build the ToolResult fields for an execute_command run: success is decided
 * by the exit code (the single source of truth), the result keeps the full
 * output, and a non-zero exit produces an error naming the code + output.
 * Pure so the exit-code → success mapping is unit-testable without a Tauri
 * runtime. */
export function buildCommandResult(
  exitCode: number,
  lines: Array<{ kind: 'stdout' | 'stderr'; line: string }>,
): Pick<ToolResult, 'result' | 'error' | 'success'> {
  const output = formatCommandOutput(lines);
  if (exitCode !== 0) {
    return { result: output, error: formatCommandError(exitCode, output), success: false };
  }
  return { result: output, success: true };
}

/** Human-readable byte size ("512 B", "12.3 KB", "1.5 MB") — used by the
 * write_file progress lines and the tool row's pending label. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Format ONE write_file progress event (the exact protocol the Rust
 * write_file_stream command pushes over its Channel: `{ type: 'progress',
 * written, total }`) as the live tool-row line. Pure + exported so the
 * Rust/TS protocol is locked by a unit test, mirroring buildCommandResult. */
export function formatWriteProgress(path: string, written: number, total: number): string {
  const pct = total > 0 ? Math.round((written / total) * 100) : 100;
  return `正在写入 ${path} — ${pct}% (${formatBytes(written)}/${formatBytes(total)})`;
}

export function formatCommandOutput(lines: Array<{ kind: 'stdout' | 'stderr'; line: string }>): string {
  const out: string[] = [];
  let inStderr = false;
  for (const { kind, line } of lines) {
    if (kind === 'stderr') {
      if (!inStderr) {
        if (out.length > 0) out.push('');
        out.push('[stderr]');
        inStderr = true;
      }
    } else {
      inStderr = false;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Build the error message for a failed command (non-zero exit code). */
export function formatCommandError(exitCode: number, output: string): string {
  const tail = output.trim() ? `:\n${output.trim()}` : '';
  return `Command failed with exit code ${exitCode}${tail}`;
}
