// src/ui/TauriToolAdapter.ts
// v0.2 — ToolAdapter implementation that uses Tauri IPC invoke() for tool execution.
// For Vite dev (no Tauri runtime), falls back to returning no available tools.
// Built-in schemas stay shared with the CLI; researcher tools wrap the Rust web/file primitives while legacy names remain execution-compatible but hidden from new model tool lists.

import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../shared/types';
import type { Channel } from '@tauri-apps/api/core';
import { BUILT_IN_TOOL_DEFS, TOOL_METADATA, isPublicToolName } from '../shared/toolDefs';
import { filterResearchSources, isOfficialDocumentationSource, makeResearchPayload, parseWebSearchText, type ResearchSource } from '../shared/research';
export { filterResearchSources } from '../shared/research';
import { formatBytes, formatCommandError, safeParseArgs } from '../shared/format';
import type { WorkspaceRestoreResult, WorkspaceSnapshotBatch, WorkspaceSnapshotEntry, WorkspaceSnapshotPort } from '../shared/workspaceSnapshot';

// ── Tool definitions (single source of truth: shared/toolDefs.ts) ──

const TOOL_DEFINITIONS: ToolDefinition[] = [...BUILT_IN_TOOL_DEFS];

/** Web-only subset of TOOL_DEFINITIONS — exported so chat.ts can pin this
 * exact list as the LLM-visible toolsDef in plain-chat mode without
 * duplicating the schema. Order is stable (matches declaration order). */
export function getWebToolDefs(): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((t) => t.name === 'researcher_web' || t.name === 'researcher_docs');
}

/** sys_info tool def — workspace-independent (the Rust backend ignores the
 * workspace field), so plain-chat mode can always advertise it regardless of
 * the browser-tool toggle. */
export function getSysInfoToolDefs(): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((t) => t.name === 'sys_info');
}


export type InvokeFunction = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

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
  private proxyUrl: string;
  private sessionId: string;
  private invokeFn: InvokeFunction | null;
  private latestWriteBatch: WorkspaceSnapshotBatch | null = null;
  private snapshotSequence = 0;
  private readonly maxSnapshotBytes = 8 * 1024 * 1024;

  constructor(workspace: string, tavilyApiKey = '', serperApiKey = '', location = '', invoke?: InvokeFunction, sessionId = '', proxyUrl = '') {
    this.workspace = workspace;
    this.tavilyApiKey = tavilyApiKey;
    this.serperApiKey = serperApiKey;
    this.location = location;
    this.proxyUrl = proxyUrl;
    this.invokeFn = invoke ?? null;
    this.sessionId = sessionId;
  }

  private call(command: string, args?: Record<string, unknown>): Promise<unknown> {
    const invoke = this.invokeFn ?? tauriInvoke;
    if (!invoke) return Promise.reject(new Error('Tauri runtime not available — tools disabled'));
    return invoke(command, args);
  }

  getTools(): ToolDefinition[] {
    return (tauriInvoke || this.invokeFn) ? TOOL_DEFINITIONS.filter((tool) => isPublicToolName(tool.name)) : [];
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
    if (!tauriInvoke && !this.invokeFn) {
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
          const content = await this.call('read_file', { workspace: ws, path: String(args.path ?? '') }) as string;
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
          const batch = await this.captureWriteBatch('write_file', [path]);
          // Stream byte-level progress while the file is written so the tool
          // row shows "正在写入 … 45% (230/512 KB)" instead of a silent
          // "等待输出" wait for the whole (possibly large) write to finish.
          // Progress lines go to the live tool-output listener only — the LLM
          // still gets the single "Wrote N bytes" result, not the noise.
          if (tauriChannel && !this.invokeFn) {
            const channel = new tauriChannel<string>();
            channel.onmessage = (raw: string) => {
              let parsed: { type?: string; written?: number; total?: number } | null = null;
              try { parsed = JSON.parse(raw); } catch { parsed = null; }
              if (!parsed || parsed.type !== 'progress') return;
              toolOutputListener?.(toolCall.id, 'stdout', formatWriteProgress(path, parsed.written ?? 0, parsed.total ?? 0));
            };
            const msg = await this.call('write_file_stream', {
              workspace: ws,
              path,
              content,
              onProgress: channel,
            }) as string;
            const undoAvailable = await this.tryFinishWriteBatch(batch, [path]);
            return { id: toolCall.id, toolName: name, result: `${msg}${undoAvailable ? '' : ' (当前写入未提供撤销快照)'}`, success: true, duration: Date.now() - start };
          }
          const msg = await this.call('write_file', { workspace: ws, path, content }) as string;
          const undoAvailable = await this.tryFinishWriteBatch(batch, [path]);
          return { id: toolCall.id, toolName: name, result: `${msg}${undoAvailable ? '' : ' (当前写入未提供撤销快照)'}`, success: true, duration: Date.now() - start };
        }
        case 'edit_file': {
          const path = String(args.path ?? '');
          const batch = await this.captureWriteBatch('edit_file', [path]);
          const editMsg = await this.call('edit_file', {
            workspace: ws,
            path,
            oldString: String(args.oldString ?? ''),
            newString: String(args.newString ?? ''),
            allowMultiple: Boolean(args.allowMultiple),
          }) as string;
          const undoAvailable = await this.tryFinishWriteBatch(batch, [path]);
          return { id: toolCall.id, toolName: name, result: `${editMsg}${undoAvailable ? '' : ' (当前写入未提供撤销快照)'}`, success: true, duration: Date.now() - start };
        }
        case 'search_files': {
          const searchResult = await this.call('search_files', {
            workspace: ws,
            pattern: String(args.pattern ?? ''),
            path: args.path ?? null,
            filePattern: args.filePattern ?? null,
            maxResults: args.maxResults ?? 50,
          }) as string;
          return { id: toolCall.id, toolName: name, result: searchResult, success: true, duration: Date.now() - start };
        }
        case 'list_files': {
          const listing = await this.call('list_files', {
            workspace: ws,
            path: String(args.path ?? '.'),
            recursive: Boolean(args.recursive),
            maxResults: typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : undefined,
          }) as string;
          return { id: toolCall.id, toolName: name, result: listing, success: true, duration: Date.now() - start };
        }
        case 'execute_command': {
          // Stream the command's output as it is produced so a long-running
          // command (bundle, install, test) shows live progress in the tool
          // row instead of waiting silently for the full buffered result.
          if (tauriChannel && !this.invokeFn) {
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
              if (tauriInvoke || this.invokeFn) {
                this.call('kill_command', { id: toolCall.id }).catch(() => {});
              }
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
            try {
              const code = await this.call('execute_command_stream', {
                id: toolCall.id,
                workspace: ws,
                command: String(args.command ?? ''),
                proxyUrl: this.proxyUrl,
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
          const exec = await this.call('execute_command', { workspace: ws, command: String(args.command ?? ''), proxyUrl: this.proxyUrl }) as { exitCode: number; stdout: string; stderr: string };
          const execLines: Array<{ kind: 'stdout' | 'stderr'; line: string }> = [
            ...(exec.stdout ? [{ kind: 'stdout' as const, line: exec.stdout }] : []),
            ...(exec.stderr ? [{ kind: 'stderr' as const, line: exec.stderr }] : []),
          ];
          return { id: toolCall.id, toolName: name, ...buildCommandResult(exec.exitCode, execLines), duration: Date.now() - start };
        }
        case 'git_diff': {
          const diff = await this.call('git_diff', { workspace: ws, staged: args.staged ?? false, path: args.path ?? null }) as string;
          return { id: toolCall.id, toolName: name, result: diff, success: true, duration: Date.now() - start };
        }
        case 'git_log': {
          const log = await this.call('git_log', { workspace: ws, maxCount: args.maxCount ?? null, oneline: args.oneline ?? true }) as string;
          return { id: toolCall.id, toolName: name, result: log, success: true, duration: Date.now() - start };
        }
        case 'git_status': {
          const status = await this.call('git_status', { workspace: ws }) as string;
          return { id: toolCall.id, toolName: name, result: status, success: true, duration: Date.now() - start };
        }
        case 'create_directory': {
          const path = String(args.path ?? '');
          const batch = await this.captureWriteBatch('create_directory', [path]);
          const dirMsg = await this.call('create_directory', { workspace: ws, path }) as string;
          if (!batch.entries[0]?.existed) await this.tryFinishWriteBatch(batch, [path]);
          return { id: toolCall.id, toolName: name, result: dirMsg, success: true, duration: Date.now() - start };
        }
        case 'diff_files': {
          const diff = await this.call('diff_files', {
            workspace: ws,
            pathA: String(args.pathA ?? ''),
            pathB: String(args.pathB ?? ''),
          }) as string;
          return { id: toolCall.id, toolName: name, result: diff, success: true, duration: Date.now() - start };
        }
        case 'researcher_web': {
          const prompt = String(args.prompt ?? args.query ?? '').trim();
          const limits = researchLimits(args);
          const searchData = await this.call('web_search', buildWebSearchArgs(ws, { ...args, query: prompt, maxResults: Math.min(20, limits.maxSources * 2) }, this.tavilyApiKey, this.serperApiKey, this.proxyUrl)) as string;
          const rawSources = parseWebSearchText(searchData);
          const filteredSources = filterResearchSources(rawSources, args.allowedDomains);
          const filtered = rawSources.length - filteredSources.length;
          let sources = filteredSources;
          const failed: string[] = [];
          const selected = sources.slice(0, limits.maxSources);
          if (args.fetchContent !== false) {
            const enriched = await Promise.all(selected.map(async (source): Promise<ResearchSource> => {
              try {
                const content = await this.call('web_fetch', { workspace: ws, url: source.url, maxChars: limits.maxCharsPerSource, proxyUrl: this.proxyUrl }) as string;
                return { ...source, content };
              } catch (error) {
                failed.push(`${source.url}: ${error instanceof Error ? error.message : String(error)}`);
                return source;
              }
            }));
            sources = enriched;
          } else {
            sources = selected;
          }
          if (sources.length === 0) {
            return researchFailure(toolCall.id, name, start, 'No usable research sources were returned by the available search backends or allowed domain filter. Rephrase the query or broaden allowedDomains; do not repeat the unchanged query.');
          }
          const result = makeResearchPayload('researcher_web', prompt, sources, {
            failed,
            filtered,
            truncated: filteredSources.length > selected.length,
          });
          return { id: toolCall.id, toolName: name, result, success: true, duration: Date.now() - start };
        }
        case 'researcher_docs': {
          const library = String(args.library ?? '').trim();
          const topic = String(args.topic ?? '').trim();
          const version = typeof args.version === 'string' ? args.version.trim() : '';
          const prompt = [library, topic, version, 'official documentation API reference'].filter(Boolean).join(' ');
          if (!library || !topic) {
            return researchFailure(toolCall.id, name, start, 'researcher_docs requires both library and topic');
          }
          const limits = researchLimits(args);
          const searchData = await this.call('web_search', buildWebSearchArgs(ws, { ...args, query: prompt, maxResults: Math.min(20, limits.maxSources * 2) }, this.tavilyApiKey, this.serperApiKey, this.proxyUrl)) as string;
          const rawSources = parseWebSearchText(searchData);
          const filteredSources = filterResearchSources(rawSources, args.allowedDomains);
          const filtered = rawSources.length - filteredSources.length;
          let sources = filteredSources;
          const selected = sources.slice(0, limits.maxSources);
          const failed: string[] = [];
          if (args.fetchContent !== false) {
            const enriched = await Promise.all(selected.map(async (source): Promise<ResearchSource> => {
              try {
                const content = await this.call('web_fetch', { workspace: ws, url: source.url, maxChars: limits.maxCharsPerSource, proxyUrl: this.proxyUrl }) as string;
                return { ...source, content };
              } catch (error) {
                failed.push(`${source.url}: ${error instanceof Error ? error.message : String(error)}`);
                return source;
              }
            }));
            sources = enriched;
          } else {
            sources = selected;
          }
          if (sources.length === 0) {
            return researchFailure(toolCall.id, name, start, 'No usable documentation sources were returned by the available search backends or allowed domain filter. Rephrase the query or broaden allowedDomains; do not repeat the unchanged query.');
          }
          const result = makeResearchPayload('researcher_docs', prompt, sources, {
            library,
            topic,
            version,
            failed,
            filtered,
            officialVerified: sources.some((source) => isOfficialDocumentationSource(library, source.url)),
            versionMatched: version ? sources.some((source) => `${source.url} ${source.snippet} ${source.content ?? ''}`.includes(version)) : true,
            truncated: filteredSources.length > selected.length,
          });
          return { id: toolCall.id, toolName: name, result, success: true, duration: Date.now() - start };
        }
        case 'code_searcher': {
          const query = String(args.query ?? args.pattern ?? '').trim();
          if (!query) return researchFailure(toolCall.id, name, start, 'code_searcher query must not be empty');
          const raw = await this.call('code_searcher', buildCodeSearchArgs(ws, args)) as string;
          return { id: toolCall.id, toolName: name, result: raw, success: true, duration: Date.now() - start };
        }
        case 'web_search': {
          const searchData = await this.call('web_search', buildWebSearchArgs(ws, args, this.tavilyApiKey, this.serperApiKey, this.proxyUrl)) as string;
          return { id: toolCall.id, toolName: name, result: searchData, success: true, duration: Date.now() - start };
        }
        case 'web_fetch': {
          const pageText = await this.call('web_fetch', {
            workspace: ws,
            url: String(args.url ?? ''),
            maxChars: args.maxChars ?? 20000,
            proxyUrl: this.proxyUrl,
          }) as string;
          return { id: toolCall.id, toolName: name, result: pageText, success: true, duration: Date.now() - start };
        }
        case 'glob_files': {
          const globResult = await this.call('glob_files', {
            workspace: ws,
            pattern: String(args.pattern ?? ''),
            path: args.path ?? null,
            maxResults: args.maxResults ?? 200,
          }) as string;
          return { id: toolCall.id, toolName: name, result: globResult, success: true, duration: Date.now() - start };
        }
        case 'replace_files': {
          const files = Array.isArray(args.files) ? args.files.map(String) : [];
          const batch = await this.captureWriteBatch('replace_files', files);
          const replaceResult = await this.call('replace_files', {
            workspace: ws,
            files,
            oldString: String(args.oldString ?? ''),
            newString: String(args.newString ?? ''),
            allowMultiple: Boolean(args.allowMultiple),
          }) as string;
          const undoAvailable = await this.tryFinishWriteBatch(batch, files);
          const replaceText = String(replaceResult);
          const errorCount = Number(replaceText.match(/,\s*(\d+)\s+error\(s\)/)?.[1] ?? 0);
          return {
            id: toolCall.id,
            toolName: name,
            result: `${replaceText}${errorCount === 0 && !undoAvailable ? ' (当前写入未提供撤销快照)' : ''}`,
            ...(errorCount > 0 ? { error: replaceText } : {}),
            success: errorCount === 0,
            duration: Date.now() - start,
          };
        }
        case 'sys_info': {
          // The user-configured location (Settings → General → Environment) is
          // forwarded so the model gets the location baseline without a round
          // trip — the Rust command treats it as optional.
          const info = await this.call('sys_info', { workspace: ws, location: this.location }) as string;
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

  private async captureWriteBatch(toolName: string, paths: string[]): Promise<WorkspaceSnapshotBatch> {
    this.latestWriteBatch = null;
    const entries: WorkspaceSnapshotEntry[] = [];
    for (const path of [...new Set(paths)]) {
      const info = await this.call('path_info', { workspace: this.workspace, path }) as { exists?: boolean; isDirectory?: boolean; size?: number; isSymlink?: boolean };
      if (info.isSymlink) {
        throw new Error(`Snapshot refuses symlink path: ${path}`);
      }
      if (!info.exists) {
        entries.push({ path, existed: false, kind: 'file' });
      } else if (info.isDirectory) {
        entries.push({ path, existed: true, kind: 'directory' });
      } else {
        if ((info.size ?? 0) > this.maxSnapshotBytes) {
          throw new Error(`Snapshot too large for ${path}; write was not performed.`);
        }
        const content = await this.call('read_file', { workspace: this.workspace, path }) as string;
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
      const info = await this.call('path_info', { workspace: this.workspace, path: entry.path }) as { exists?: boolean; isDirectory?: boolean; size?: number; isSymlink?: boolean };
      if (info.exists && !info.isDirectory) {
        entry.afterContent = await this.call('read_file', { workspace: this.workspace, path: entry.path }) as string;
        if (new TextEncoder().encode(entry.afterContent).byteLength > this.maxSnapshotBytes) continue;
        if (!entry.existed || entry.afterContent !== entry.content) finished.push(entry);
      } else if (!entry.existed && info.exists) {
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
      let info: { exists?: boolean; isDirectory?: boolean; isSymlink?: boolean };
      try {
        info = await this.call('path_info', { workspace: this.workspace, path: entry.path }) as { exists?: boolean; isDirectory?: boolean };
      } catch {
        conflicts.push(entry.path);
        continue;
      }
      if (!entry.existed) {
        if (!info.exists) continue;
        if (info.isSymlink || (entry.kind === 'directory') !== Boolean(info.isDirectory)) {
          conflicts.push(entry.path);
          continue;
        }
        if (entry.kind === 'directory') {
          try {
            await this.call('remove_path', { workspace: this.workspace, path: entry.path, recursive: false });
            removedPaths.push(entry.path);
          } catch {
            conflicts.push(entry.path);
          }
          continue;
        }
        if (entry.afterContent !== undefined) {
          const current = await this.call('read_file', { workspace: this.workspace, path: entry.path }) as string;
          if (current !== entry.afterContent) {
            conflicts.push(entry.path);
            continue;
          }
        }
        try {
          await this.call('remove_path', { workspace: this.workspace, path: entry.path, recursive: false });
          removedPaths.push(entry.path);
        } catch {
          conflicts.push(entry.path);
        }
        continue;
      }
      if (entry.kind === 'directory') {
        if (!info.exists || !info.isDirectory || info.isSymlink) {
          conflicts.push(entry.path);
          continue;
        }
        await this.call('create_directory', { workspace: this.workspace, path: entry.path });
        restoredPaths.push(entry.path);
        continue;
      }
      if (!info.exists || info.isDirectory || info.isSymlink) {
        conflicts.push(entry.path);
        continue;
      }
      if (entry.afterContent !== undefined) {
        const current = await this.call('read_file', { workspace: this.workspace, path: entry.path }) as string;
        if (current !== entry.afterContent) {
          conflicts.push(entry.path);
          continue;
        }
      }
      await this.call('write_file', { workspace: this.workspace, path: entry.path, content: entry.content ?? '' });
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
}

export function buildCodeSearchArgs(workspace: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    workspace,
    query: String(args.query ?? args.pattern ?? '').trim(),
    path: args.path ?? null,
    globs: Array.isArray(args.globs) ? args.globs : null,
    caseSensitive: args.caseSensitive !== false,
    maxResults: args.maxResults ?? 15,
    globalMaxResults: args.globalMaxResults ?? 250,
    timeoutSeconds: args.timeoutSeconds ?? 10,
  };
}

export function researchLimits(args: Record<string, unknown>): { maxSources: number; maxCharsPerSource: number } {
  const maxSources = typeof args.maxSources === 'number' && Number.isFinite(args.maxSources)
    ? Math.min(8, Math.max(1, Math.floor(args.maxSources)))
    : 5;
  const maxCharsPerSource = typeof args.maxCharsPerSource === 'number' && Number.isFinite(args.maxCharsPerSource)
    ? Math.min(12000, Math.max(500, Math.floor(args.maxCharsPerSource)))
    : 4000;
  return { maxSources, maxCharsPerSource };
}

function researchFailure(id: string, toolName: string, start: number, error: string): ToolResult {
  return { id, toolName, error, success: false, duration: Date.now() - start };
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
  proxyUrl = '',
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
    ...(proxyUrl ? { proxyUrl } : {}),
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

