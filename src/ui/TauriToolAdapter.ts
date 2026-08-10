// src/ui/TauriToolAdapter.ts
// v0.2 — ToolAdapter implementation that uses Tauri IPC invoke() for tool execution.
// For Vite dev (no Tauri runtime), falls back to returning no available tools.
// Removed tools that don't have Rust backend implementations (edit_file, search_files, list_files).

import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../shared/types';
import type { Channel } from '@tauri-apps/api/core';
import { BUILT_IN_TOOL_DEFS, TOOL_METADATA } from '../shared/toolDefs';
import { formatBytes, formatCommandError, safeParseArgs } from '../shared/format';

// ── Tool definitions (single source of truth: shared/toolDefs.ts) ──

const TOOL_DEFINITIONS: ToolDefinition[] = [...BUILT_IN_TOOL_DEFS];

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

