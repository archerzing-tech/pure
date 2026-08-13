import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeToolAdapter } from '../NodeToolAdapter';
import type { ToolCall } from '../../../shared/types';

function call(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${name}`,
    index: 0,
    function: { name, arguments: JSON.stringify(args) },
  };
}

describe('research tool migration', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-research-tools-'));
    writeFileSync(join(workspace, 'app.ts'), 'const answer = 42;\nconst other = answer + 1;\n');
    adapter = new NodeToolAdapter({ workspace });
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('exposes specialized tools while hiding legacy names', () => {
    const names = adapter.getTools().map((tool) => tool.name);
    expect(names).toContain('researcher_web');
    expect(names).toContain('researcher_docs');
    expect(names).toContain('code_searcher');
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('web_fetch');
    expect(names).not.toContain('search_files');
  });

  it('returns structured ripgrep matches with line and column evidence', async () => {
    const result = await adapter.execute(call('code_searcher', {
      query: 'answer',
      path: '.',
      maxResults: 10,
      globalMaxResults: 10,
    }));
    expect(result.success).toBe(true);
    const payload = JSON.parse(String(result.result)) as {
      kind: string;
      matches: Array<{ path: string; line: number; column?: number; text: string }>;
      truncated: boolean;
    };
    expect(payload.kind).toBe('code_search');
    expect(payload.matches.length).toBe(2);
    expect(payload.matches[0].path).toBe('app.ts');
    expect(payload.matches[0].line).toBe(1);
    expect(payload.matches[0].column).toBeGreaterThan(0);
    expect(payload.matches[0].text).toContain('answer');
    expect(payload.truncated).toBe(false);
  });

  it('surfaces invalid regex diagnostics instead of returning a false pass', async () => {
    const result = await adapter.execute(call('code_searcher', { query: '[' }));
    expect(result.success).toBe(false);
    expect(result.toolName).toBe('code_searcher');
    expect(result.error).toBeTruthy();
  });

  it('enforces the global match cap while rg is still producing output', async () => {
    writeFileSync(join(workspace, 'many.ts'), Array.from({ length: 40 }, (_, i) => `const needle${i} = true;`).join('\n'));
    const result = await adapter.execute(call('code_searcher', {
      query: 'needle',
      path: 'many.ts',
      maxResults: 100,
      globalMaxResults: 3,
    }));
    expect(result.success).toBe(true);
    const payload = JSON.parse(String(result.result)) as { matches: unknown[]; truncated: boolean };
    expect(payload.matches).toHaveLength(3);
    expect(payload.truncated).toBe(true);
  });

  it('uses the Bun fallback when rg is unavailable and preserves file scope', async () => {
    const result = await (adapter as any).handleCodeSearcherFallback(
      'needle',
      join(workspace, 'many.ts'),
      'many.ts',
      { maxResults: 100, globalMaxResults: 3 },
      Date.now(),
    );
    expect(result.success).toBe(true);
    const payload = JSON.parse(String(result.result)) as {
      matches: Array<{ path: string }>;
      truncated: boolean;
      diagnostics: string[];
    };
    expect(payload.matches).toHaveLength(3);
    expect(payload.matches.every((match) => match.path === 'many.ts')).toBe(true);
    expect(payload.truncated).toBe(true);
    expect(payload.diagnostics).toContain('ripgrep unavailable; used the Bun filesystem fallback');
  });
});
