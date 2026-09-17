// src/ui/__tests__/mcpResourcesRow.test.ts
// Settings → MCP server card, resources row: count + chips after a probe, a
// distinct line when the server offers/publishes none, and nothing at all
// before a probe (resources are only discoverable by connecting).

import { describe, expect, it } from 'bun:test';
import { renderMcpResourcesRow } from '../mcpProbe';
import type { McpProbeResult } from '../mcpProbe';

function result(overrides: Partial<McpProbeResult> = {}): McpProbeResult {
  return { serverName: 'fs', tools: [], resources: [], resourcesSupported: true, durationMs: 5, ...overrides };
}

describe('renderMcpResourcesRow', () => {
  it('renders nothing before a probe', () => {
    expect(renderMcpResourcesRow(undefined)).toBe('');
  });

  it('renders nothing when the probe failed (the tools row already shows why)', () => {
    expect(renderMcpResourcesRow(result({ error: '连接失败' }))).toBe('');
  });

  it('counts the resources and chips them with uri/mime/description tooltips', () => {
    const html = renderMcpResourcesRow(result({
      resources: [
        { uri: 'file:///notes.md', name: 'notes', description: 'Project notes', mimeType: 'text/markdown' },
        { uri: 'file:///shot.png', name: 'shot', mimeType: 'image/png' },
      ],
    }));

    expect(html).toContain('2');
    expect(html).toContain('notes');
    expect(html).toContain('shot');
    expect(html).toContain('title="file:///notes.md — text/markdown — Project notes"');
    expect(html).toContain('mcp-resource-chip');
  });

  it('falls back to the uri path when a resource has no name', () => {
    const html = renderMcpResourcesRow(result({ resources: [{ uri: 'file:///a/b/schema.json', name: '' }] }));
    expect(html).toContain('a/b/schema.json');
  });

  it('distinguishes "publishes none" from "offers none"', () => {
    const none = renderMcpResourcesRow(result());
    expect(none).toContain('mcp-probe-status');
    expect(none).not.toContain('mcp-tool-chips');

    const unsupported = renderMcpResourcesRow(result({ resourcesSupported: false }));
    expect(unsupported).toContain('mcp-probe-status');
    expect(unsupported).not.toBe(none);
  });

  it('marks live-session rows so they do not read as a verified probe', () => {
    const probeRow = renderMcpResourcesRow(result({ resources: [{ uri: 'file:///a.md', name: 'a' }] }));
    const liveRow = renderMcpResourcesRow(result({ resources: [{ uri: 'file:///a.md', name: 'a' }] }), 'live');

    expect(liveRow).toContain('来自当前会话');
    expect(probeRow).not.toContain('来自当前会话');
    expect(liveRow).toContain('a');
  });

  it('escapes resource names and tooltips', () => {
    const html = renderMcpResourcesRow(result({
      resources: [{ uri: 'file:///<script>', name: '<img src=x onerror=alert(1)>', description: '"quoted"' }],
    }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('onerror=alert(1)">');
  });
});
