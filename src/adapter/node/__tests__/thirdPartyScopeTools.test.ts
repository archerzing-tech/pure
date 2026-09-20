// src/adapter/node/__tests__/thirdPartyScopeTools.test.ts
// 三方件默认不在理解范围：list_files / glob_files / find_files 默认跳过依赖
// 目录；path / pattern 明确指名时放行（用户要求审计三方件的那扇门）。

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeToolAdapter } from '../NodeToolAdapter';
import type { ToolCall, ToolResult } from '../../../shared/types';

let workspace = '';
let adapter: NodeToolAdapter;

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: 'call-1',
  index: 0,
  function: { name, arguments: JSON.stringify(args) },
});

/** Adapter output paths are platform-native (backslashes on Windows);
 *  normalize so assertions are separator-agnostic. */
const norm = (s: string): string => s.replaceAll('\\', '/');

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'pure-third-party-'));
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'dist'), { recursive: true });
  mkdirSync(join(workspace, 'node_modules/pkg'), { recursive: true });
  mkdirSync(join(workspace, '.venv/lib'), { recursive: true });
  mkdirSync(join(workspace, 'deep/nested/node_modules'), { recursive: true });
  writeFileSync(join(workspace, 'src/a.ts'), 'export const needle = 1;\n');
  writeFileSync(join(workspace, 'dist/b.js'), 'console.log("bundle");\n');
  writeFileSync(join(workspace, 'node_modules/pkg/index.js'), 'module.exports = "needle";\n');
  writeFileSync(join(workspace, '.venv/lib/x.py'), 'print("venv")\n');
  writeFileSync(join(workspace, 'deep/nested/node_modules/q.js'), 'q();\n');
  adapter = new NodeToolAdapter({ workspace, commandTimeout: 10_000 });
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('list_files skips dependency directories by default', () => {
  it('recursive listing hides node_modules / dist / .venv, keeps first-party files', async () => {
    const r: ToolResult = await adapter.execute(call('list_files', { recursive: true }));
    expect(r.success).toBe(true);
    const out = norm(String(r.result));
    expect(out).toContain('src/a.ts');
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('dist/b.js');
    expect(out).not.toContain('.venv');
  });

  it('an explicitly named dependency directory is still listable', async () => {
    const r = await adapter.execute(call('list_files', { path: 'node_modules', recursive: true }));
    expect(r.success).toBe(true);
    expect(norm(String(r.result))).toContain('pkg/index.js');
  });
});

describe('glob_files skips dependency directories by default', () => {
  it('**/*.js never returns vendored files', async () => {
    const r = await adapter.execute(call('glob_files', { pattern: '**/*.js' }));
    expect(r.success).toBe(true);
    const out = norm(String(r.result));
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('dist/b.js');
  });

  it('a pattern naming the dependency directory passes through', async () => {
    const r = await adapter.execute(call('glob_files', { pattern: 'node_modules/**/*.js' }));
    expect(r.success).toBe(true);
    expect(norm(String(r.result))).toContain('pkg/index.js');
  });
});

describe('find_files skips dependency directories by default', () => {
  it('content hits come from first-party files only', async () => {
    const r = await adapter.execute(call('find_files', { query: 'needle' }));
    expect(r.success).toBe(true);
    const out = norm(String(r.result));
    expect(out).toContain('src/a.ts');
    expect(out).not.toContain('node_modules');
  });
});
