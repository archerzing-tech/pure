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
import { escapeHtml } from '../shared/html';
import { t } from '../shared/i18n';

export interface McpProbeTool {
  /** Full registered name, e.g. `filesystem__read_file`. */
  name: string;
  description: string;
  /** True when the full name hits one of the user's excluded prefixes —
   *  discovered here anyway so the UI can show it as hidden instead of
   *  silently omitting it. */
  excluded: boolean;
}

export interface McpProbeResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpProbeResult {
  serverName: string;
  tools: McpProbeTool[];
  /** `resources/list` metadata. Empty when the server does not advertise the
   *  capability — the card distinguishes "none published" from "not offered"
   *  via `resourcesSupported`. */
  resources: McpProbeResource[];
  resourcesSupported: boolean;
  /** Set when connect / tools/list failed or timed out. */
  error?: string;
  durationMs: number;
}

let probeCounter = 0;

/**
 * Resource row of an MCP server card: the count plus one chip per resource
 * (the tooltip carries uri / mime type / description). Text resources are the
 * ones that reach the model as context (6.1), which the summary tooltip says.
 *
 * `source` distinguishes a fresh probe from the resources the running session
 * already discovered — the second is merely "what this session can see right
 * now", so it must not look like a verified inventory.
 *
 * Pure and exported for tests — the Settings panel only mounts the string.
 */
export function renderMcpResourcesRow(probe?: McpProbeResult, source: 'probe' | 'live' = 'probe'): string {
  if (!probe || probe.error) return '';
  if (!probe.resourcesSupported) {
    return `<div class="mcp-server-tools mcp-resource-row"><span class="mcp-probe-status">${t('mcp.resources.unsupported')}</span></div>`;
  }
  if (probe.resources.length === 0) {
    return `<div class="mcp-server-tools mcp-resource-row"><span class="mcp-probe-status">${t('mcp.resources.none')}</span></div>`;
  }
  const count = t('mcp.resources.count').replace('{n}', String(probe.resources.length));
  const summary = source === 'live' ? `${count} · ${t('mcp.resources.live')}` : count;
  const chips = probe.resources.map((resource) => {
    const short = resource.name || resource.uri.replace(/^[a-z+]+:\/\//i, '');
    const title = [resource.uri, resource.mimeType, resource.description].filter(Boolean).join(' — ');
    return `<span class="mcp-tool-chip mcp-resource-chip" title="${escapeHtml(title)}">${escapeHtml(short)}</span>`;
  }).join('');
  return `<div class="mcp-server-tools mcp-resource-row">
      <div class="mcp-probe-summary" title="${escapeHtml(t('mcp.resources.hint'))}">${escapeHtml(summary)}</div>
      <div class="mcp-tool-chips">${chips}</div>
    </div>`;
}

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
    /** Bound on waiting for the resource-list prefetch that starts at connect
     *  (metadata only — contents are never read here). */
    resourceWaitMs?: number;
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
    // The card lists resources; pulling every text body into the settings
    // process would be wasted work (and this client is thrown away anyway).
    readResourceContents: false,
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
    // Resource metadata only: the same client already listed them in the
    // background at connect, so this is a bounded wait, not a second probe.
    const resources = await client.listResources(opts.resourceWaitMs ?? 5_000);
    return {
      serverName: server.name,
      tools,
      resources: resources.map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })),
      resourcesSupported: client.supportsResources(server.name),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { serverName: server.name, tools: [], resources: [], resourcesSupported: false, error: message, durationMs: Date.now() - started };
  } finally {
    client.disconnectAll();
  }
}
