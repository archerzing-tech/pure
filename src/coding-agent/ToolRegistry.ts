// src/coding-agent/ToolRegistry.ts
// v0.3 — Flat tagged tool registry implementing ToolAdapter.
// Each tool carries tags for permission control, risk classification, and routing.
// Subagent tools (Tags.AGENT) and MCP tools (Tags.MCP) are routed to separate executors.
// Tool schemas/descriptions live in shared/toolDefs.ts (single source of truth
// shared with the CLI/GUI adapters); this module only adds the permission-layer
// tags + risk levels on top.

import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../shared/types';
import type { TaggedTool, PermissionContext } from './types';
import type { WorkspaceSnapshotPort } from '../shared/workspaceSnapshot';
import type { PermissionManager } from './PermissionManager';
import { BUILT_IN_TOOL_DEFS, isPublicToolName } from '../shared/toolDefs';
import { safeParseArgs } from '../shared/format';

// ── Tag constants ──

export const Tags = {
  READ: 'read',
  WRITE: 'write',
  DESTRUCTIVE: 'destructive',
  SHELL: 'shell',
  AGENT: 'agent',
  PLAN: 'plan',
  FS: 'fs',
  SEARCH: 'search',
  MCP: 'mcp',
  DOWNLOAD: 'download',
} as const;

// ── Built-in tool definitions with tags ──
// The LLM-visible schema (name/description/input_schema) comes from the shared
// BUILT_IN_TOOL_DEFS; only the permission annotations live here, keyed by tool
// name so a new shared def can never silently run without its gate.

// Keyed by the exact tool-name union from BUILT_IN_TOOL_DEFS (`as const` in
// toolDefs.ts): adding a tool there without a permission mapping here is a
// compile error, so a new tool can never silently run un-gated.
type BuiltinToolName = (typeof BUILT_IN_TOOL_DEFS)[number]['name'];

const TOOL_TAGS: Record<BuiltinToolName, { tags: string[]; riskLevel?: 'low' | 'medium' | 'high' }> = {
  read_file: { tags: [Tags.FS, Tags.READ], riskLevel: 'low' },
  write_file: { tags: [Tags.FS, Tags.WRITE, Tags.DESTRUCTIVE], riskLevel: 'medium' },
  edit_file: { tags: [Tags.FS, Tags.WRITE, Tags.DESTRUCTIVE], riskLevel: 'medium' },
  list_files: { tags: [Tags.FS, Tags.READ], riskLevel: 'low' },
  find_files: { tags: [Tags.FS, Tags.READ, Tags.SEARCH], riskLevel: 'low' },
  search_files: { tags: [Tags.FS, Tags.READ, Tags.SEARCH], riskLevel: 'low' },
  execute_command: { tags: [Tags.SHELL, Tags.DESTRUCTIVE], riskLevel: 'high' },
  git_diff: { tags: [Tags.SHELL, Tags.READ], riskLevel: 'low' },
  git_log: { tags: [Tags.SHELL, Tags.READ], riskLevel: 'low' },
  git_status: { tags: [Tags.SHELL, Tags.READ], riskLevel: 'low' },
  sys_info: { tags: [Tags.READ], riskLevel: 'low' },
  create_directory: { tags: [Tags.FS, Tags.WRITE], riskLevel: 'low' },
  diff_files: { tags: [Tags.FS, Tags.READ], riskLevel: 'low' },
  researcher_web: { tags: [Tags.SEARCH, Tags.READ], riskLevel: 'low' },
  researcher_docs: { tags: [Tags.SEARCH, Tags.READ], riskLevel: 'low' },
  code_searcher: { tags: [Tags.FS, Tags.READ, Tags.SEARCH], riskLevel: 'low' },
  web_search: { tags: [Tags.SEARCH, Tags.READ], riskLevel: 'low' },
  web_fetch: { tags: [Tags.READ], riskLevel: 'low' },
  web_public_api: { tags: [Tags.SEARCH, Tags.READ], riskLevel: 'low' },
  web_scrape: { tags: [Tags.READ], riskLevel: 'low' },
  download_file: { tags: [Tags.DOWNLOAD, Tags.WRITE], riskLevel: 'medium' },
  glob_files: { tags: [Tags.FS, Tags.READ, Tags.SEARCH], riskLevel: 'low' },
  replace_files: { tags: [Tags.FS, Tags.WRITE, Tags.DESTRUCTIVE], riskLevel: 'medium' },
};

export const BUILT_IN_TOOLS: readonly TaggedTool[] = Object.freeze(
  BUILT_IN_TOOL_DEFS.map((def) => ({ ...def, ...TOOL_TAGS[def.name] })),
);

// ── ToolRegistry ──

/** Return true for shell commands that mutate Git repository state. */
export function isGitMutationCommand(command: string): boolean {
  return /\bgit(?:\s+(?:-C\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+))*\s+(?:init|add|commit|reset|clean|checkout|switch|restore|push|pull|config|stash|tag|mv|rm|rebase|merge)\b/i.test(command);
}

export class ToolRegistry implements ToolAdapter {
  private tools: TaggedTool[] = [...BUILT_IN_TOOLS];
  private subagentExecutor?: ToolAdapter;
  private mcpExecutor?: ToolAdapter;
  private permissionManager?: PermissionManager;
  private commandGuard?: (command: string) => string | null;

  constructor(private delegate: ToolAdapter) {}

  /** Set the executor for subagent (Tags.AGENT) tools. */
  setSubagentExecutor(executor: ToolAdapter): void {
    this.subagentExecutor = executor;
  }

  /** Set the executor for MCP (Tags.MCP) tools. */
  setMCPExecutor(executor: ToolAdapter): void {
    this.mcpExecutor = executor;
  }

  /** Set the permission manager consulted before every tool execution. */
  setPermissionManager(pm: PermissionManager): void {
    this.permissionManager = pm;
  }

  /** Temporarily reject dangerous command patterns for a scoped workflow. */
  setCommandGuard(guard?: (command: string) => string | null): void {
    this.commandGuard = guard;
  }

  /** Register an MCP or custom tool. */
  register(tool: TaggedTool): void {
    const existing = this.tools.findIndex(t => t.name === tool.name);
    if (existing >= 0) {
      this.tools[existing] = tool;
    } else {
      this.tools.push(tool);
    }
  }

  getTools(): ToolDefinition[] {
    return this.tools
      .filter(({ name }) => isPublicToolName(name))
      .map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  }

  getSnapshotPort(): WorkspaceSnapshotPort | undefined {
    return this.delegate.getSnapshotPort?.();
  }

  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean } | undefined {
    const tool = this.tools.find(t => t.name === toolName);
    if (!tool) return this.delegate.getMetadata(toolName);
    return {
      sideEffects: tool.tags.includes(Tags.DESTRUCTIVE)
        || tool.tags.includes(Tags.SHELL)
        || tool.tags.includes(Tags.MCP)
        || tool.tags.includes(Tags.AGENT),
      isWrite: tool.tags.includes(Tags.WRITE) || tool.tags.includes(Tags.DESTRUCTIVE),
    };
  }

  async execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const known = this.tools.find(t => t.name === toolCall.function.name);
    if (!known) {
      return {
        id: toolCall.id,
        toolName: toolCall.function.name,
        error: `Unknown tool: ${toolCall.function.name}`,
        success: false,
        duration: 0,
      };
    }

    if (toolCall.function.name === 'execute_command' && this.commandGuard) {
      const args = safeParseArgs(toolCall.function.arguments);
      const command = typeof args.command === 'string' ? args.command : '';
      const blocked = this.commandGuard(command);
      if (blocked) {
        return {
          id: toolCall.id,
          toolName: toolCall.function.name,
          error: blocked,
          success: false,
          duration: 0,
        };
      }
    }

    // ── Permission gate: consult PermissionManager before executing ──
    if (this.permissionManager) {
      const args = safeParseArgs(toolCall.function.arguments);
      const isWrite = known.tags.includes(Tags.WRITE) || known.tags.includes(Tags.DESTRUCTIVE);
      const preview = buildWritePreview(toolCall.function.name, args);
      const ctx: PermissionContext = {
        tool: toolCall.function.name,
        command: typeof args.command === 'string' ? args.command : undefined,
        description: known.description,
        isRead: !isWrite,
        riskLevel: known.riskLevel ?? 'medium',
        serverName: known.serverName,
        path: preview?.path,
        contentPreview: preview?.contentPreview,
        signal,
      };
      const decision = await this.permissionManager.askUser(ctx);
      if (!decision.allowed) {
        return {
          id: toolCall.id,
          toolName: toolCall.function.name,
          error: `Permission denied${decision.reason ? `: ${decision.reason}` : ''}`,
          success: false,
          duration: 0,
        };
      }
    }

    // Route subagent tools to the orchestrator
    if (known.tags.includes(Tags.AGENT) && this.subagentExecutor) {
      return this.subagentExecutor.execute(toolCall, signal);
    }

    // Route MCP tools to the MCP client
    if (known.tags.includes(Tags.MCP) && this.mcpExecutor) {
      return this.mcpExecutor.execute(toolCall, signal);
    }

    return this.delegate.execute(toolCall, signal);
  }

  /** Get full tagged tool definitions (for permission UI). */
  getTaggedTools(): TaggedTool[] {
    return [...this.tools];
  }

  /** Look up a tool's tags. */
  getTags(toolName: string): string[] {
    return this.tools.find(t => t.name === toolName)?.tags ?? [];
  }
}

/**
 * Build a content preview for write tools so the confirmation dialog can show
 * exactly what will be written:
 * - write_file → the full target path + the content that will be written
 * - edit_file  → the target path + a compact `-old / +new` diff snippet
 * Returns undefined for non-write tools (nothing to preview).
 */
const WRITE_FILE_PREVIEW_MAX = 4000;
const EDIT_SNIPPET_MAX = 200;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Build a content preview for write tools so the confirmation dialog can show
 * exactly what will be written:
 * - write_file → the full target path + the content that will be written
 *   (capped so a large generated file doesn't flood the dialog)
 * - edit_file  → the target path + a compact `-old / +new` diff snippet
 * Returns undefined for non-write tools (nothing to preview).
 */
export function buildWritePreview(
  toolName: string,
  args: Record<string, unknown>,
): { path?: string; contentPreview?: string } | undefined {
  if (toolName !== 'write_file' && toolName !== 'edit_file' && toolName !== 'replace_files') return undefined;
  if (toolName === 'replace_files') {
    const files = Array.isArray(args.files) ? args.files.map(String) : [];
    const oldStr = typeof args.oldString === 'string' ? args.oldString : '';
    const newStr = typeof args.newString === 'string' ? args.newString : '';
    return {
      path: files.length > 0 ? files.join(', ') : undefined,
      contentPreview: `- ${clip(oldStr, EDIT_SNIPPET_MAX)}\n+ ${clip(newStr, EDIT_SNIPPET_MAX)}`,
    };
  }
  const path = typeof args.path === 'string' ? args.path : undefined;
  if (toolName === 'write_file') {
    const content = typeof args.content === 'string' ? args.content : '';
    return { path, contentPreview: clip(content, WRITE_FILE_PREVIEW_MAX) };
  }
  const oldStr = typeof args.oldString === 'string' ? args.oldString : '';
  const newStr = typeof args.newString === 'string' ? args.newString : '';
  return {
    path,
    contentPreview: `- ${clip(oldStr, EDIT_SNIPPET_MAX)}\n+ ${clip(newStr, EDIT_SNIPPET_MAX)}`,
  };
}

