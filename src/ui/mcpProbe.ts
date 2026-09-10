// src/ui/mcpProbe.ts
// On-demand MCP tool discovery for Settings → MCP ("查看工具"). A short-lived
// MCPClient connects, lists tools, and is always torn down — nothing here is
// auto-triggered (probing spawns a third-party subprocess; a cold `npx` can
// even download packages), and results are cached by the caller per server.
//
// INVARIANT (do not bypass): the probe MUST use a throwaway sessionId, never a
// real chat session's. The Rust subprocess registry (spawn_mcp) keys by
// `sessionId:name` and OVERWRITES an existing entry, so reusing a live
// session's id would orphan its subprocess — reachable by nothing, killable by
// no shutdown path. A unique id means spawn registers a fresh child and
// disconnectAll() → TauriStdioTransport.close() → mcp_shutdown retires exactly
// that child, on success, failure, and timeout alike.

import { MCPClient } from '../harness/mcp/MCPClient';
import type { MCPServerConfig, MCPTransport } from '../adapter/mcp/MCPTransport';

export interface McpProbeTool {
  /** Full registered name, e.g. `filesystem__read_file`. */
  name: string;
  description: string;
  /** True when the full name hits one of the user's excluded prefixes —
   *  discovered here anyway so the UI can show it as hidden instead of
   *  silently omitting it. */
  excluded: boolean;
}

export interface McpProbeResult {
  serverName: string;
  tools: McpProbeTool[];
  /** Set when connect / tools/list failed or timed out. */
  error?: string;
  durationMs: number;
}

let probeCounter = 0;

/** Same rule as MCPClient's connect-time filter (MCPClient.ts:128). */
function isExcluded(fullName: string, prefixes: string[]): boolean {
  return prefixes.some((p) => p && fullName.startsWith(p));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function probeMcpServerTools(
  server: MCPServerConfig,
  opts: {
    excludedPrefixes: string[];
    proxyUrl?: string;
    timeoutMs?: number;
    timeoutLabel?: string;
    /** Test seam: inject a transport factory (same as MCPClient's). */
    transportFactory?: (config: MCPServerConfig) => MCPTransport;
  },
): Promise<McpProbeResult> {
  const started = Date.now();
  // excludedPrefixes deliberately empty: hidden tools are discovered too and
  // marked client-side, so the settings UI can show "已隐藏" chips instead of
  // the tools silently vanishing.
  const client = new MCPClient({
    servers: [],
    sessionId: `settings-probe-${Date.now()}-${++probeCounter}`,
    proxyUrl: opts.proxyUrl ?? '',
    excludedPrefixes: [],
    transportFactory: opts.transportFactory,
  });
  try {
    const label = opts.timeoutLabel ?? '连接 MCP 服务器超时';
    await withTimeout(client.connectServer(server), opts.timeoutMs ?? 30_000, label);
    const tools = client.getTaggedTools()
      .filter((t) => t.name.startsWith(`${server.name}__`))
      .map((t) => ({
        name: t.name,
        // mcpToolToDefinition prefixes descriptions with "[MCP:server]" —
        // redundant next to the server card it renders in.
        description: t.description.replace(/^\[MCP:[^\]]+\]\s*/, ''),
        excluded: isExcluded(t.name, opts.excludedPrefixes),
      }));
    return { serverName: server.name, tools, durationMs: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { serverName: server.name, tools: [], error: message, durationMs: Date.now() - started };
  } finally {
    client.disconnectAll();
  }
}
