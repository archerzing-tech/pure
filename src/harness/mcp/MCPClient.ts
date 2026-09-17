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
  MCPResourceDescription,
  MCPResourceContents,
} from '../../adapter/mcp/MCPTransport';
import { mcpToolToDefinition } from '../../adapter/mcp/MCPTransport';

// Limits for injected resource context. Resources are OPTIONAL context that
// competes with the user's actual request: a chatty server (a docs site, a
// filesystem root full of notes) must not push skills, the task contract, or
// the conversation itself out of the window. Per-resource and per-connection
// caps keep the worst case bounded; the fragment is injected at skills'
// priority (30) so budget pressure drops it first.
const MAX_RESOURCES_PER_SERVER = 10;
const MAX_RESOURCE_CHARS = 2_000;
const MAX_TOTAL_RESOURCE_CHARS = 8_000;
/** Cap on waiting for the resource prefetch. A slow/remote server must not
 *  hold up the first turn — unread resources simply miss this turn. */
const RESOURCE_PREFETCH_WAIT_MS = 3_000;

/** MIME types whose text payload is worth injecting. Unknown MIME types are
 *  treated as text (many servers omit the field); image/audio/video/octet
 *  types carry only base64 blobs, which never belong in a prompt. */
function isTextMime(mimeType?: string): boolean {
  if (!mimeType) return true;
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('text/')) return true;
  return [
    'application/json',
    'application/xml',
    'application/x-yaml',
    'application/yaml',
    'application/javascript',
    'application/typescript',
    'application/x-httpd-php',
    'application/sql',
  ].includes(mime) || mime.endsWith('+json') || mime.endsWith('+xml');
}

/** One resource as a labeled block. URI and MIME type stay visible so the model
 *  can tell which server document it is reading and how it is encoded, and the
 *  description (when the server sent one) says what the document is for. */
function renderResource(resource: MCPResourceDescription, body: string): string {
  const label = [
    `- ${resource.uri}`,
    resource.mimeType ? `(${resource.mimeType})` : '',
    resource.description ? `— ${resource.description}` : '',
  ].filter(Boolean).join(' ');
  const safeUri = resource.uri.replace(/"/g, '%22');
  return `${label}\n<resource uri="${safeUri}">\n${body}\n</resource>`;
}

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
  /** Advertised via the initialize handshake's `capabilities.resources`; when
   *  false, `resources/list` is never called (spec: don't probe unsupported
   *  methods). */
  hasResources: boolean;
  /** Resource metadata from `resources/list` (empty when not advertised). */
  resources: MCPResourceDescription[];
  /** Rendered body for the prompt fragment — undefined until read, '' when the
   *  server advertised resources but none could be read. */
  resourceBody?: string;
}

export interface MCPResourceContextOptions {
  /** Max ms to wait for an in-flight prefetch (default RESOURCE_PREFETCH_WAIT_MS). */
  waitMs?: number;
}

export class MCPClient implements ToolAdapter {
  private servers = new Map<string, ServerState>();
  private toolToServer = new Map<string, string>(); // toolName → serverName
  /** In-flight resource prefetches, keyed by server name. Awaiting them is
   *  bounded (see collectResourceContext), so a hung server costs one wait,
   *  not a per-turn stall. */
  private resourcePrefetch = new Map<string, Promise<void>>();

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
        : new HttpTransport(config.url ?? 'http://localhost:3000', this.config.proxyUrl ?? '', config.requestTimeoutMs));

    const state: ServerState = { config, transport, tools: [], connected: false, hasResources: false, resources: [] };
    this.servers.set(config.name, state);

    // Initialize handshake — offer the newest protocol version we speak
    // (2026-07-28); the server replies with the newest it supports and the
    // transport echoes that version on every later request.
    const initResult = (await transport.send('initialize', {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      clientInfo: { name: 'pure', version: '1.1.0' },
    })) as { capabilities?: { resources?: unknown } } | undefined;

    // Send initialized notification (no response expected)
    await transport.notify('notifications/initialized', {});

    // Resource discovery is capability-gated: a server that never advertised
    // `resources` must not be probed. Reading is prefetched off the connect
    // path (below) so a slow resource read can't delay tool registration —
    // connectAll() resolves as soon as the tools are known.
    state.hasResources = Boolean(initResult?.capabilities?.resources);
    if (state.hasResources) this.prefetchResources(state);

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
      state.resources = [];
      state.resourceBody = undefined;
      state.hasResources = false;
    }
    this.toolToServer.clear();
    this.resourcePrefetch.clear();
  }

  // ── Resources (server-published read-only context) ──

  /** Fire-and-forget: list + read resources for one server. Failures are
   *  logged and swallowed — a server that advertises resources but fails to
   *  serve them must not take down its (working) tools. */
  private prefetchResources(state: ServerState): void {
    const name = state.config.name;
    const pending = this.loadResources(state).catch((err) => {
      console.warn(`[MCP] resources for "${name}" unavailable:`, err instanceof Error ? err.message : err);
    });
    this.resourcePrefetch.set(name, pending);
  }

  private async loadResources(state: ServerState): Promise<void> {
    const listed = (await state.transport.send('resources/list', {})) as {
      resources?: MCPResourceDescription[];
    };
    state.resources = (listed?.resources ?? [])
      .filter((r) => r && typeof r.uri === 'string')
      .slice(0, MAX_RESOURCES_PER_SERVER);

    const blocks: string[] = [];
    let remaining = MAX_TOTAL_RESOURCE_CHARS;
    for (const resource of state.resources) {
      if (remaining <= 0) break;
      if (!isTextMime(resource.mimeType)) continue;
      const text = await this.readResourceText(state, resource);
      if (text === undefined) continue;
      const body = text.length > MAX_RESOURCE_CHARS
        ? `${text.slice(0, MAX_RESOURCE_CHARS)}\n…[truncated]`
        : text;
      remaining -= body.length;
      blocks.push(renderResource(resource, body));
    }
    state.resourceBody = blocks.join('\n\n');
  }

  /** One `resources/read` call, narrowed to injectable text. Returns undefined
   *  when the resource is blob-only, empty, or unreadable — a single bad
   *  resource must not abort the rest of the server's resources. */
  private async readResourceText(state: ServerState, resource: MCPResourceDescription): Promise<string | undefined> {
    try {
      const result = (await state.transport.send('resources/read', { uri: resource.uri })) as {
        contents?: MCPResourceContents[];
      };
      const parts = (result?.contents ?? [])
        .filter((part) => typeof part?.text === 'string')
        .map((part) => part.text as string);
      const text = parts.join('\n').trim();
      return text.length > 0 ? text : undefined;
    } catch (err) {
      console.warn(`[MCP] read resource "${resource.uri}" failed:`, err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  /** Rendered resource context for the system-prompt fragment, or '' when no
   *  connected server published readable text. Waits (bounded) for the
   *  in-flight prefetch so the first turn isn't systematically empty. */
  async collectResourceContext(options: MCPResourceContextOptions = {}): Promise<string> {
    const waitMs = options.waitMs ?? RESOURCE_PREFETCH_WAIT_MS;
    const pending = [...this.resourcePrefetch.values()];
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => setTimeout(resolve, waitMs)),
      ]);
    }
    const bodies: string[] = [];
    for (const [, state] of this.servers) {
      if (!state.connected || !state.resourceBody?.trim()) continue;
      bodies.push(`[${state.config.name}]\n${state.resourceBody}`);
    }
    return bodies.join('\n\n');
  }

  /** Resource metadata for every connected server (Settings / diagnostics). */
  getResources(): Array<MCPResourceDescription & { serverName: string }> {
    const out: Array<MCPResourceDescription & { serverName: string }> = [];
    for (const [, state] of this.servers) {
      for (const resource of state.resources) out.push({ ...resource, serverName: state.config.name });
    }
    return out;
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
