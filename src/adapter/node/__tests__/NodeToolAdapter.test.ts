// src/adapter/node/__tests__/NodeToolAdapter.test.ts

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeToolAdapter, detectRuntimeVersions } from '../NodeToolAdapter';
import type { ToolCall, ToolResult } from '../../../shared/types';

function makeCall(command: string): ToolCall {
  return {
    id: 'call-1',
    index: 0,
    function: { name: 'execute_command', arguments: JSON.stringify({ command }) },
  };
}

function resultOf(r: ToolResult): { stdout: string; stderr: string; exitCode: number } {
  return r.result as { stdout: string; stderr: string; exitCode: number };
}

// POSIX shell syntax tests (redirects, `;`) only apply on Unix — Windows runs
// cmd.exe via `cmd /C`, whose grammar differs. The cross-platform cases (plain
// echo, unknown command, exit codes) still run everywhere.
const shOnly = process.platform === 'win32';

describe('NodeToolAdapter execute_command', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-node-tool-'));
    adapter = new NodeToolAdapter({ workspace, commandTimeout: 10000 });
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('reports success with exitCode 0 for a clean command', async () => {
    const r = await adapter.execute(makeCall('echo hello'));
    expect(r.success).toBe(true);
    expect(r.error).toBeUndefined();
    expect(resultOf(r).exitCode).toBe(0);
    expect(resultOf(r).stdout).toContain('hello');
  });

  it.skipIf(shOnly)('reports failure with a non-zero exit code and stderr in the error', async () => {
    const r = await adapter.execute(makeCall('echo boom >&2; exit 3'));
    expect(r.success).toBe(false);
    expect(r.error).toContain('exit code 3');
    expect(r.error).toContain('boom'); // stderr visible in the failure message
    expect(resultOf(r).exitCode).toBe(3);
    expect(resultOf(r).stderr).toContain('boom');
  });

  it.skipIf(shOnly)('keeps stdout in the result even when the command fails', async () => {
    const r = await adapter.execute(makeCall('echo partial; exit 2'));
    expect(r.success).toBe(false);
    expect(r.error).toContain('exit code 2');
    expect(resultOf(r).stdout).toContain('partial');
  });

  it('reports failure when the command is not found', async () => {
    const r = await adapter.execute(makeCall('definitely-not-a-real-command-xyz'));
    expect(r.success).toBe(false);
    // sh reports the failure on stderr; the exit code must be non-zero.
    expect(resultOf(r).exitCode).not.toBe(0);
  });

  it('rejects reads through a symlink that escapes the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pure-node-outside-'));
    try {
      // Directory symlinks need an explicit 'dir' type on Windows (a missing
      // type creates a file link and the escape check is bypassed); the type
      // argument is ignored on POSIX.
      symlinkSync(outside, join(workspace, 'linked'), 'dir');

      const r = await adapter.execute({
        id: 'call-symlink',
        index: 0,
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'linked/secret.txt' }) },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Path escapes workspace');
    } finally {
      rmSync(outside, { recursive: true, force: true });
      // Windows: rmSync on a symlink raises EFAULT; unlink the link itself.
      try {
        unlinkSync(join(workspace, 'linked'));
      } catch {
        rmSync(join(workspace, 'linked'), { force: true });
      }
    }
  });
});

describe('NodeToolAdapter list_files', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-list-files-'));
    adapter = new NodeToolAdapter({ workspace });
    // Seed: a root file + a subdirectory containing a file.
    writeFileSync(join(workspace, 'b.ts'), '');
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'a.ts'), '');
    // Symlink to a directory: statSync follows links, so listing must work.
    symlinkSync('src', join(workspace, 'src-link'), 'dir');
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const call = (args: Record<string, unknown>): ToolCall => ({
    id: 'call-list',
    index: 0,
    function: { name: 'list_files', arguments: JSON.stringify(args) },
  });

  it('lists the workspace root — regression: Bun.file().exists() on a directory returned false', async () => {
    const r = await adapter.execute(call({}));
    expect(r.success).toBe(true);
    expect(r.error).toBeUndefined();
    const out = String(r.result);
    expect(out).toContain('src');
    expect(out).toContain('b.ts');
  });

  it('lists a subdirectory path', async () => {
    const r = await adapter.execute(call({ path: 'src' }));
    expect(r.success).toBe(true);
    expect(String(r.result)).toContain('a.ts');
  });

  it('lists through a symlink to a directory (statSync follows links)', async () => {
    const r = await adapter.execute(call({ path: 'src-link' }));
    expect(r.success).toBe(true);
    expect(String(r.result)).toContain('a.ts');
  });

  it('lists with an explicit absolute path', async () => {
    const r = await adapter.execute(call({ path: join(workspace, 'src') }));
    expect(r.success).toBe(true);
    expect(String(r.result)).toContain('a.ts');
  });

  it('supports recursive listing', async () => {
    const r = await adapter.execute(call({ path: '.', recursive: true }));
    expect(r.success).toBe(true);
    const out = String(r.result).replaceAll('\\', '/');
    expect(out).toContain('src/a.ts');
    expect(out).toContain('b.ts');
  });

  it('reports an explicit error for a missing directory', async () => {
    const r = await adapter.execute(call({ path: 'nope' }));
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('Directory not found');
  });
});

describe('detectRuntimeVersions', () => {
  it('reports node, bun, python3, rustc and git entries in a stable order', () => {
    const out = detectRuntimeVersions();
    expect(out.length).toBe(5);
    // Every entry is "label: version" — never an empty label or value.
    for (const entry of out) {
      expect(entry).toMatch(/^(node|bun|python3|rustc|git): .+$/);
    }
    // Labels appear in the documented order (node, bun, python3, rustc, git).
    expect(out[0].startsWith('node:')).toBe(true);
    expect(out[1].startsWith('bun:')).toBe(true);
    expect(out[2].startsWith('python3:')).toBe(true);
    expect(out[3].startsWith('rustc:')).toBe(true);
    expect(out[4].startsWith('git:')).toBe(true);
  });

  it('never injects multi-line banners (whitespace collapsed)', () => {
    const out = detectRuntimeVersions();
    for (const entry of out) {
      // Version output lands in the system prompt verbatim; it must stay on
      // one line so it cannot break out of the context sentence.
      expect(entry).not.toContain('\n');
      expect(entry).not.toMatch(/ {2,}/);
    }
  });
});
