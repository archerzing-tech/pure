import { describe, expect, it } from 'bun:test';
import { mcpRegistrySearchUrl, parseMcpRegistryPayload, communityMcpCandidates } from '../mcpRegistry';

describe('MCP Registry discovery', () => {
  it('builds a query URL for the official Registry', () => {
    expect(mcpRegistrySearchUrl('github tools', 5)).toBe(
      'https://registry.modelcontextprotocol.io/v0.1/servers?search=github+tools&limit=5',
    );
  });

  it('keeps the latest server version and creates stdio/http recipes', () => {
    const candidates = parseMcpRegistryPayload(JSON.stringify({
      servers: [
        {
          server: {
            name: 'com.example/github',
            title: 'GitHub',
            description: 'GitHub tools',
            version: '1.0.0',
            packages: [{ registryType: 'npm', identifier: '@example/github-mcp', runtimeHint: 'npx' }],
          },
          _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: false } },
        },
        {
          server: {
            name: 'com.example/github',
            title: 'GitHub',
            description: 'GitHub tools latest',
            version: '1.1.0',
            remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
          },
          _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } },
        },
      ],
    }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].version).toBe('1.1.0');
    expect(candidates[0].config).toEqual({ name: 'com.example/github', transport: 'http', url: 'https://example.com/mcp' });
    expect(candidates[0].requiresAuth).toBe(false);
  });

  it('marks credentialed remotes as non-connectable', () => {
    const candidates = parseMcpRegistryPayload(JSON.stringify({
      servers: [{
        server: {
          name: 'ai.example/private',
          remotes: [{
            type: 'streamable-http',
            url: 'https://example.com/mcp',
            headers: [{ name: 'Authorization', isRequired: true, isSecret: true }],
          }],
        },
      }],
    }));
    expect(candidates[0].config).toBeUndefined();
    expect(candidates[0].requiresAuth).toBe(true);
  });

  it('keeps community results informational until manually configured', () => {
    const candidates = communityMcpCandidates([{ title: 'CRM MCP', url: 'https://mcp.so/crm', snippet: 'CRM tools' }]);
    expect(candidates[0].source).toBe('community-search');
    expect(candidates[0].config).toBeUndefined();
    expect(candidates[0].requiresAuth).toBe(true);
  });
});
