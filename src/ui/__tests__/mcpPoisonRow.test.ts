// src/ui/__tests__/mcpPoisonRow.test.ts
// Settings → MCP server card, poisoning-scan row (6.3): silent for clean
// servers, one chip per flagged tool with the evidence in its tooltip, and a
// danger tone only for high-severity verdicts. Display-only by design.

import { describe, expect, it } from 'bun:test';
import { renderMcpPoisonRow, type McpProbeResult } from '../mcpProbe';

function result(overrides: Partial<McpProbeResult> = {}): McpProbeResult {
  return { serverName: 'fs', tools: [], resources: [], resourcesSupported: true, durationMs: 5, ...overrides };
}

describe('renderMcpPoisonRow', () => {
  it('renders nothing before a probe', () => {
    expect(renderMcpPoisonRow(undefined)).toBe('');
  });

  it('renders nothing when every tool is clean', () => {
    const probe = result({
      tools: [{ name: 'fs__read_file', description: 'ok', excluded: false, findings: [] }],
    });
    expect(renderMcpPoisonRow(probe)).toBe('');
  });

  it('shows the count and one chip per flagged tool, evidence in the tooltip', () => {
    const probe = result({
      tools: [
        {
          name: 'evil__read_fi1e',
          description: 'ok',
          excluded: false,
          findings: [{ kind: 'name-collision', severity: 'high', evidence: '近似 read_file' }],
        },
        { name: 'evil__clean_tool', description: 'ok', excluded: false, findings: [] },
      ],
    });
    const html = renderMcpPoisonRow(probe);
    expect(html).toContain('mcp-poison-row');
    expect(html).toContain('mcp-poison-high');
    expect(html).toContain('mcp-poison-chip');
    expect(html).toContain('read_fi1e');
    expect(html).not.toContain('clean_tool');
    // Evidence lands in the escaped tooltip, not the visible text.
    expect(html).toContain('name-collision');
  });

  it('stays amber when only medium findings exist', () => {
    const probe = result({
      tools: [{
        name: 'fs__verbose',
        description: 'ok',
        excluded: false,
        findings: [{ kind: 'description-too-long', severity: 'medium', evidence: '2500 字符' }],
      }],
    });
    const html = renderMcpPoisonRow(probe);
    expect(html).toContain('mcp-poison-medium');
    expect(html).not.toContain('mcp-poison-high');
  });
});
