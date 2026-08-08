// src/harness/mcp/MCPClient.ts
// v0.1 — MCP (Model Context Protocol) client: manages server connections,
// discovers tools, and invokes them. Implements ToolAdapter for ToolRegistry routing.

import { StdioTransport } from '../../adapter/mcp/StdioTransport';
import { HttpTransport } from '../../adapter/mcp/HttpTransport';
import { TauriStdioTransport } from '../../adapter/mcp/TauriStdioTransport';
import { isTauriRuntime } from '../../shared/tauri';
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
      config.transport === 'stdio'
        // Desktop WebView can't import node:child_process — spawn stdio MCP
        // servers through the Rust subprocess manager instead. Plain browser /
        // CLI keep the JS StdioTransport.
        ? (this.config.sessionId && isTauriRuntime()
            ? new TauriStdioTransport(this.config.sessionId, config.name, config.command ?? [], config.env)
            : new StdioTransport(config.command ?? [], config.env))
        : new HttpTransport(config.url ?? 'http://localhost:3000');

    const state: ServerState = { config, transport, tools: [], connected: false };
    this.servers.set(config.name, state);

    // Initialize handshake
    const initResult = await transport.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'pure', version: '1.0.3' },
    });

    // Send initialized notification (no response expected)
    await transport.notify('notifications/initialized', {});

    // Discover tools
    const toolsResult = (await transport.send('tools/list', {})) as {
      tools: MCPToolDescription[];
    };

    if (toolsResult?.tools) {
      for (const t of toolsResult.tools) {
        const tagged: TaggedTool = {
          ...mcpToolToDefinition(t, config.name),
          tags: [Tags.MCP],
          riskLevel: 'medium',
          serverName: config.name,
        };
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
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        // empty/invalid args
      }

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
