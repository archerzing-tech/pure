// src/adapter/node/__tests__/NodeToolAdapter.test.ts

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

describe('NodeToolAdapter edit_file', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-edit-file-'));
    adapter = new NodeToolAdapter({ workspace });
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const edit = (path: string, oldString: string, newString: string): ToolCall => ({
    id: `edit-${Date.now()}`,
    index: 0,
    function: { name: 'edit_file', arguments: JSON.stringify({ path, oldString, newString }) },
  });

  it('returns recovery guidance instead of inviting a blind retry when exact text is stale', async () => {
    writeFileSync(join(workspace, 'app.ts'), 'function renderList() {\n  return [];\n}\n');
    const result = await adapter.execute(edit('app.ts', 'function renderList() {\n  const list = $(\'vip-list\');\n', 'function renderList() {\n  const list = $(\'vip-list\');\n  return list;\n'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('String not found in file');
    expect(result.error).toContain('file may have changed');
    expect(result.error).toContain('Re-read app.ts');
    expect(result.error).toContain('do not retry this identical edit');
  });

  it('matches CRLF files without converting their line endings', async () => {
    writeFileSync(join(workspace, 'crlf.ts'), 'const a = 1;\r\nconst b = 2;\r\n');
    const result = await adapter.execute(edit('crlf.ts', 'const a = 1;\nconst b = 2;\n', 'const a = 3;\nconst b = 2;\n'));
    expect(result.success).toBe(true);
    expect(result.result).toContain('matched CRLF line endings');
    const content = await Bun.file(join(workspace, 'crlf.ts')).text();
    expect(content).toBe('const a = 3;\r\nconst b = 2;\r\n');
  });

  it('does not match the LF byte inside a CRLF pair when context starts at a newline', async () => {
    writeFileSync(join(workspace, 'newline.ts'), 'first();\r\nfoo();\r\nbar();\r\n');
    const result = await adapter.execute(edit('newline.ts', '\nfoo();\n', '\nchanged();\n'));
    expect(result.success).toBe(true);
    const content = await Bun.file(join(workspace, 'newline.ts')).text();
    expect(content).toBe('first();\r\nchanged();\r\nbar();\r\n');
    expect(content).not.toContain('\r\r\n');
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

  it('caps large listings and reports truncation', async () => {
    for (let i = 0; i < 4; i++) writeFileSync(join(workspace, `extra-${i}.ts`), '');
    const r = await adapter.execute(call({ path: '.', maxResults: 2 }));
    expect(r.success).toBe(true);
    const output = String(r.result);
    expect(output).toContain('[截断]');
    expect(output.split('\n\n[截断]')[0].split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('clamps an excessive listing limit to the hard maximum', async () => {
    const r = await adapter.execute(call({ path: '.', maxResults: 999999 }));
    expect(r.success).toBe(true);
    expect(String(r.result)).not.toContain('999999');
  });

  it('reports an explicit error for a missing directory', async () => {
    const r = await adapter.execute(call({ path: 'nope' }));
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('Directory not found');
  });
});

describe('NodeToolAdapter workspace snapshots', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-snapshot-'));
    adapter = new NodeToolAdapter({ workspace, sessionId: 'session-test' });
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown>): ToolCall => ({
    id: `snapshot-${name}`,
    index: 0,
    function: { name, arguments: JSON.stringify(args) },
  });

  it('restores an existing file and removes a newly-created file', async () => {
    writeFileSync(join(workspace, 'existing.txt'), 'before');
    expect((await adapter.execute(call('write_file', { path: 'existing.txt', content: 'after' }))).success).toBe(true);
    const port = adapter.getSnapshotPort();
    expect(port.getLatestWriteBatch()?.sessionId).toBe('session-test');
    const restored = await port.undoLastWriteBatch();
    expect(restored.restored).toBe(true);
    expect(await Bun.file(join(workspace, 'existing.txt')).text()).toBe('before');

    expect((await adapter.execute(call('write_file', { path: 'new.txt', content: 'new' }))).success).toBe(true);
    const removed = await port.undoLastWriteBatch();
    expect(removed.restored).toBe(true);
    expect(existsSync(join(workspace, 'new.txt'))).toBe(false);
  });

  it('does not overwrite a file changed after the agent write', async () => {
    expect((await adapter.execute(call('write_file', { path: 'conflict.txt', content: 'agent' }))).success).toBe(true);
    writeFileSync(join(workspace, 'conflict.txt'), 'user');
    const result = await adapter.getSnapshotPort().undoLastWriteBatch();
    expect(result.restored).toBe(false);
    expect(result.conflicts).toEqual(['conflict.txt']);
    expect(await Bun.file(join(workspace, 'conflict.txt')).text()).toBe('user');
  });

  it('restores every file in one replace_files batch', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'old a');
    writeFileSync(join(workspace, 'b.txt'), 'old b');
    const changed = await adapter.execute(call('replace_files', {
      files: ['a.txt', 'b.txt'], oldString: 'old', newString: 'new', allowMultiple: false,
    }));
    expect(changed.success).toBe(true);
    const result = await adapter.getSnapshotPort().undoLastWriteBatch();
    expect(result.restored).toBe(true);
    expect(await Bun.file(join(workspace, 'a.txt')).text()).toBe('old a');
    expect(await Bun.file(join(workspace, 'b.txt')).text()).toBe('old b');
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
