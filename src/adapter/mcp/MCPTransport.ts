// src/adapter/mcp/MCPTransport.ts
// v0.1 — MCP transport interface + JSON-RPC 2.0 types.

import type { ToolDefinition } from '../../shared/types';

// ── JSON-RPC 2.0 types ──

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse | JSONRPCNotification;

// ── MCP-specific result shapes ──

export interface MCPToolDescription {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

// ── MCP resources (server-published read-only context) ──

/** `resources/list` entry. `mimeType` and `description` are both optional in
 *  the spec, so both are narrowed at read time before anything is injected. */
export interface MCPResourceDescription {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** `resources/read` returns one entry per returned part: text resources carry
 *  `text`, binary ones carry base64 `blob` (never injected into the prompt). */
export interface MCPResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

// ── MCP prompts (server-published templates the USER invokes) ──

/** One declared argument of a prompt template. `required` args must be
 *  supplied by the caller; the composer command reports what is missing. */
export interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** `prompts/list` entry. Unlike tools, prompts are not model-callable — they
 *  are templates the user picks and fills in. */
export interface MCPPromptDescription {
  name: string;
  description?: string;
  arguments?: MCPPromptArgument[];
}

/** One content part of a prompt message. Only `text` parts carry printable
 *  text; image/audio parts are binary and resource parts may embed text. */
export interface MCPPromptContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

/** `prompts/get` message: content is a single part or a list of parts. */
export interface MCPPromptMessage {
  role?: string;
  content?: MCPPromptContent | MCPPromptContent[] | string;
}

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  /** For stdio: command to run (e.g. 'npx', '-y', '@anthropic/mcp-filesystem') */
  command?: string[];
  /** For http: base URL (e.g. 'http://localhost:3000') */
  url?: string;
  /** Environment variables for the subprocess */
  env?: Record<string, string>;
  /** Per-request timeout (ms). Defaults to 30s; heavy tools (browser-based
   * MCP servers like Scrapling's stealthy_fetch) need longer — set it on the
   * server config (e.g. the Scrapling preset uses 120s). */
  requestTimeoutMs?: number;
  /** OAuth (6.4) knobs for OAuth-protected HTTP servers. `clientId` skips
   *  dynamic registration for providers that don't offer it; `scopes`
   *  overrides the server-advertised scope list. */
  auth?: { scopes?: string[]; clientId?: string; clientSecret?: string };
}

/** A request came back 401 — the server wants a login (or a fresh one). The
 *  UI catches this (not string-matched errors) to offer the 登录 button. */
export class MCPAuthRequiredError extends Error {
  constructor(
    /** Raw WWW-Authenticate challenge from the 401, when present. */
    readonly challenge?: string,
    message = 'MCP server requires authentication (HTTP 401)',
  ) {
    super(message);
    this.name = 'MCPAuthRequiredError';
  }
}

// ── Transport interface ──

export interface MCPTransport {
  /** Send a JSON-RPC request and return the response. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  /** Close the transport connection. */
  close(): void;
}

// ── Helpers ──

let nextId = 1;

export function makeRequest(method: string, params?: Record<string, unknown>): JSONRPCRequest {
  return { jsonrpc: '2.0', id: nextId++, method, params };
}

export function mcpToolToDefinition(tool: MCPToolDescription, serverName: string): ToolDefinition {
  return {
    name: `${serverName}__${tool.name}`,
    description: `[MCP:${serverName}] ${tool.description ?? tool.name}`,
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
  };
}
