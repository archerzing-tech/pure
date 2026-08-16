// src/harness/mcp/MCPClient.ts
// v0.1 — MCP (Model Context Protocol) client: manages server connections,
// discovers tools, and invokes them. Implements ToolAdapter for ToolRegistry routing.

import { StdioTransport } from '../../adapter/mcp/StdioTransport';
import { HttpTransport } from '../../adapter/mcp/HttpTransport';
import { TauriStdioTransport } from '../../adapter/mcp/TauriStdioTransport';
import { isTauriRuntime } from '../../shared/tauri';
import { parseToolArguments } from '../../shared/parseRepair';
import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../../shared/types';
import type { TaggedTool } from '../../coding-agent/types';
import { Tags } from '../../coding-agent/ToolRegistry';
import type {
  MCPTransport,
  MCPServerConfig,
  MCPToolDescription,
} from '../../adapter/mcp/MCPTransport';
import { mcpToolToDefinition } from '../../adapter/mcp/MCPTransport';

export interface MCPClientConfig {
  servers: MCPServerConfig[];
  onToolDiscovered?: (tool: TaggedTool) => void;
  /** Session id — passed to the Rust subprocess registry in the desktop app. */
  sessionId?: string;
  proxyUrl?: string;
  /**
   * Tool-name prefix filter: discovered tools whose full name (serverName__tool)
   * starts with any of these prefixes are NOT registered / exposed — e.g.
   * ['scrapling__bulk_'] hides Scrapling's bulk variants so third-party tool
   * lists don't crowd out built-in tool selection. Set in Settings → MCP
   * (mcpExcludedPrefixes) and honored by CLI --mcp-exclude-prefix.
   */
  excludedPrefixes?: string[];
  /** Test seam: inject a transport factory (defaults to stdio/http by config). */
  transportFactory?: (config: MCPServerConfig) => MCPTransport;
}

interface ServerState {
  config: MCPServerConfig;
  transport: MCPTransport;
  tools: TaggedTool[];
  connected: boolean;
}

export class MCPClient implements ToolAdapter {
  private servers = new Map<string, ServerState>();
  private toolToServer = new Map<string, string>(); // toolName → serverName

  constructor(private config: MCPClientConfig) {}

  // ── Connection management ──

  async connectAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.config.servers.map((s) => this.connectServer(s)),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[MCP] connect error:', r.reason);
      }
    }
  }

  private connecting = new Map<string, Promise<void>>();

  async connectServer(config: MCPServerConfig): Promise<void> {
    const existing = this.connecting.get(config.name);
    if (existing) return existing;
    const connection = this.connectServerInternal(config);
    this.connecting.set(config.name, connection);
    try {
      await connection;
    } finally {
      if (this.connecting.get(config.name) === connection) this.connecting.delete(config.name);
    }
  }

  private async connectServerInternal(config: MCPServerConfig): Promise<void> {
    const previous = this.servers.get(config.name);
    if (previous) {
      previous.transport.close();
      this.removeServerTools(config.name);
    }

    const transport: MCPTransport =
      this.config.transportFactory?.(config) ??
      (config.transport === 'stdio'
        // Desktop WebView can't import node:child_process — spawn stdio MCP
        // servers through the Rust subprocess manager instead. Plain browser /
        // CLI keep the JS StdioTransport. Per-server requestTimeoutMs (e.g.
        // the Scrapling preset's 120s for browser tools) is honored by both.
        ? (this.config.sessionId && isTauriRuntime()
            ? new TauriStdioTransport(this.config.sessionId, config.name, config.command ?? [], config.env, this.config.proxyUrl ?? '', config.requestTimeoutMs)
            : new StdioTransport(config.command ?? [], config.env, config.requestTimeoutMs))
        : new HttpTransport(config.url ?? 'http://localhost:3000', this.config.proxyUrl ?? ''));

    const state: ServerState = { config, transport, tools: [], connected: false };
    this.servers.set(config.name, state);

    // Initialize handshake
    const initResult = await transport.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'pure', version: '1.1.0' },
    });

    // Send initialized notification (no response expected)
    await transport.notify('notifications/initialized', {});

    // Discover tools
    const toolsResult = (await transport.send('tools/list', {})) as {
      tools: MCPToolDescription[];
    };

    if (toolsResult?.tools) {
      const excluded = this.config.excludedPrefixes ?? [];
      for (const t of toolsResult.tools) {
        const tagged: TaggedTool = {
          ...mcpToolToDefinition(t, config.name),
          tags: [Tags.MCP],
          riskLevel: 'medium',
          serverName: config.name,
        };
        // Prefix filter: excluded tools are not registered/exposed at all, so
        // third-party MCP servers (e.g. scrapling__bulk_*) can't crowd out
        // built-in tool selection. The server stays connected; only its
        // filtered tools are hidden from the model.
        if (excluded.some((p) => p && tagged.name.startsWith(p))) continue;
        state.tools.push(tagged);
        this.toolToServer.set(tagged.name, config.name);
        this.config.onToolDiscovered?.(tagged);
      }
    }

    state.connected = true;
  }

  disconnectAll(): void {
    for (const [, state] of this.servers) {
      state.transport.close();
      state.connected = false;
      state.tools = [];
    }
    this.toolToServer.clear();
  }

  private removeServerTools(serverName: string): void {
    for (const [toolName, owner] of this.toolToServer) {
      if (owner === serverName) this.toolToServer.delete(toolName);
    }
  }

  getServerNames(): string[] {
    return [...this.servers.keys()];
  }

  isConnected(serverName: string): boolean {
    return this.servers.get(serverName)?.connected ?? false;
  }

  // ── ToolAdapter implementation ──

  getTools(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const [, state] of this.servers) {
      for (const t of state.tools) {
        defs.push({ name: t.name, description: t.description, input_schema: t.input_schema });
      }
    }
    return defs;
  }

  getTaggedTools(): TaggedTool[] {
    const tools: TaggedTool[] = [];
    for (const [, state] of this.servers) {
      tools.push(...state.tools);
    }
    return tools;
  }

  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean } | undefined {
    for (const [, state] of this.servers) {
      const tool = state.tools.find((t) => t.name === toolName);
      if (tool) {
        return {
          sideEffects: true,
          isWrite: tool.tags.includes('destructive'),
        };
      }
    }
    return undefined;
  }

  async execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const start = Date.now();
    const fullName = toolCall.function.name;
    const serverName = this.toolToServer.get(fullName);

    if (!serverName) {
      return {
        id: toolCall.id,
        toolName: fullName,
        error: `Unknown MCP tool: ${fullName}`,
        success: false,
        duration: Date.now() - start,
      };
    }

    const state = this.servers.get(serverName);
    if (!state || !state.connected) {
      return {
        id: toolCall.id,
        toolName: fullName,
        error: `MCP server "${serverName}" not connected`,
        success: false,
        duration: Date.now() - start,
      };
    }

    // Strip server prefix to get the actual MCP tool name
    const mcpToolName = fullName.replace(`${serverName}__`, '');

    try {
      // Parse args — slightly-broken LLM JSON is repaired first (trailing
      // commas, single quotes, unquoted keys, fences), so a formatting slip
      // no longer strips every argument from the MCP tool call.
      const args = parseToolArguments(toolCall.function.arguments);

      const result = await state.transport.send('tools/call', {
        name: mcpToolName,
        arguments: args,
      });

      return {
        id: toolCall.id,
        toolName: fullName,
        result,
        success: true,
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        id: toolCall.id,
        toolName: fullName,
        error: err instanceof Error ? err.message : String(err),
        success: false,
        duration: Date.now() - start,
      };
    }
  }
}
