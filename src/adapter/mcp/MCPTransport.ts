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
