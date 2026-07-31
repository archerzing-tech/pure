// src/coding-agent/ToolRegistry.ts
// v0.3 — Flat tagged tool registry implementing ToolAdapter.
// Each tool carries tags for permission control, risk classification, and routing.
// Subagent tools (Tags.AGENT) and MCP tools (Tags.MCP) are routed to separate executors.

import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../shared/types';
import type { TaggedTool, PermissionContext } from './types';
import type { PermissionManager } from './PermissionManager';

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
} as const;

// ── Built-in tool definitions with tags ──

export const BUILT_IN_TOOLS: readonly TaggedTool[] = Object.freeze([
  {
    name: 'read_file',
    description: 'Read a file from the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        startLine: { type: 'number', description: 'First line to read (1-indexed)' },
        endLine: { type: 'number', description: 'Last line to read (1-indexed)' },
      },
      required: ['path'],
    },
    tags: [Tags.FS, Tags.READ],
    riskLevel: 'low',
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
    tags: [Tags.FS, Tags.WRITE, Tags.DESTRUCTIVE],
    riskLevel: 'medium',
  },
  {
    name: 'edit_file',
    description: 'Replace a string in a file.',
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
    tags: [Tags.FS, Tags.WRITE, Tags.DESTRUCTIVE],
    riskLevel: 'medium',
  },
  {
    name: 'list_files',
    description: 'List files and directories in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list' },
        recursive: { type: 'boolean', description: 'List recursively' },
      },
    },
    tags: [Tags.FS, Tags.READ],
    riskLevel: 'low',
  },
  {
    name: 'search_files',
    description: 'Search for a pattern in files under the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern' },
        path: { type: 'string', description: 'Directory to search' },
        filePattern: { type: 'string', description: 'Glob filter, e.g. "*.ts"' },
        maxResults: { type: 'number', description: 'Max results (default 50)' },
      },
      required: ['pattern'],
    },
    tags: [Tags.FS, Tags.READ, Tags.SEARCH],
    riskLevel: 'low',
  },
  {
    name: 'execute_command',
    description: 'Execute a shell command in the workspace directory.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
    tags: [Tags.SHELL, Tags.DESTRUCTIVE],
    riskLevel: 'high',
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
    tags: [Tags.SHELL, Tags.READ],
    riskLevel: 'low',
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
    tags: [Tags.SHELL, Tags.READ],
    riskLevel: 'low',
  },
  {
    name: 'git_status',
    description: 'Show working tree status.',
    input_schema: { type: 'object', properties: {} },
    tags: [Tags.SHELL, Tags.READ],
    riskLevel: 'low',
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
    tags: [Tags.FS, Tags.WRITE],
    riskLevel: 'low',
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
    tags: [Tags.FS, Tags.READ],
    riskLevel: 'low',
  },
  {
    name: 'web_search',
    description: 'Search the web and return results with titles, snippets, and URLs. Uses DuckDuckGo — no API key needed.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'number', description: 'Max results (default 10, max 20)' },
      },
      required: ['query'],
    },
    tags: [Tags.SEARCH, Tags.READ],
    riskLevel: 'low',
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and extract readable text content (strips HTML, scripts, and styles).',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch (https://...)' },
        maxChars: { type: 'number', description: 'Max characters to return (default 20000)' },
      },
      required: ['url'],
    },
    tags: [Tags.READ],
    riskLevel: 'low',
  },
]);

// ── ToolRegistry ──

export class ToolRegistry implements ToolAdapter {
  private tools: TaggedTool[] = [...BUILT_IN_TOOLS];
  private subagentExecutor?: ToolAdapter;
  private mcpExecutor?: ToolAdapter;
  private permissionManager?: PermissionManager;

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
    return this.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  }

  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean } | undefined {
    const tool = this.tools.find(t => t.name === toolName);
    if (!tool) return this.delegate.getMetadata(toolName);
    return {
      sideEffects: tool.tags.includes(Tags.DESTRUCTIVE) || tool.tags.includes(Tags.SHELL),
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

    // ── Permission gate: consult PermissionManager before executing ──
    if (this.permissionManager) {
      const args = safeParseJSON(toolCall.function.arguments);
      const isWrite = known.tags.includes(Tags.WRITE) || known.tags.includes(Tags.DESTRUCTIVE);
      const preview = buildWritePreview(toolCall.function.name, args);
      const ctx: PermissionContext = {
        tool: toolCall.function.name,
        command: typeof args.command === 'string' ? args.command : undefined,
        description: known.description,
        isRead: !isWrite,
        riskLevel: known.riskLevel ?? 'medium',
        serverName: known.serverName,
        argsHash: !isWrite ? JSON.stringify(args) : undefined,
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
  if (toolName !== 'write_file' && toolName !== 'edit_file') return undefined;
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

function safeParseJSON(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw); } catch { return {}; }
}
