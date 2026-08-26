// src/adapter/node/__tests__/NodeToolAdapter.test.ts

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeToolAdapter, detectNetworkSummary, detectRuntimeVersions, encodePowerShellCommand, extendedProbePath, tokenizeFindQuery } from '../NodeToolAdapter';
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

// Windows file-locking (Defender scan, or a still-exiting subprocess holding a
// handle) can make a single rmSync throw EBUSY/EPERM. Retry briefly so that
// afterAll cleanup never fails the whole suite on an environment race.
function safeRm(p: string, tries = 5): void {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(p, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === tries - 1) throw e;
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'EBUSY' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw e;
      Bun.sleepSync(200);
    }
  }
}

// The failure cases pick their command per platform: PowerShell runs via
// `powershell -Command` (whose stderr redirect is `1>&2`, not sh's `>&2`),
// while `exit N` works in both shells. The cross-platform cases (plain echo,
// unknown command, exit codes) still run everywhere. `shOnly` remains only
// for the diff_files case, whose Windows fallback reports missing paths
// differently (git diff exit codes) rather than failing to parse syntax.
const shOnly = process.platform === 'win32';

describe('NodeToolAdapter execute_command', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-node-tool-'));
    adapter = new NodeToolAdapter({ workspace, commandTimeout: 10000 });
  });

  afterAll(() => {
    safeRm(workspace);
  });

  it('reports success with exitCode 0 for a clean command', async () => {
    const r = await adapter.execute(makeCall('echo hello'));
    expect(r.success).toBe(true);
    expect(r.error).toBeUndefined();
    expect(resultOf(r).exitCode).toBe(0);
    expect(resultOf(r).stdout).toContain('hello');
  });

  it('reports failure with a non-zero exit code and stderr in the error', async () => {
    // Windows PowerShell 5.1 rejects `1>&2` ("reserved for future use" — added
    // in PS7), so write to stderr via [Console]::Error there.
    const failCmd = process.platform === 'win32' ? '[Console]::Error.WriteLine("boom"); exit 3' : 'echo boom >&2; exit 3';
    const r = await adapter.execute(makeCall(failCmd));
    expect(r.success).toBe(false);
    expect(r.error).toContain('exit code 3');
    expect(r.error).toContain('boom'); // stderr visible in the failure message
    expect(resultOf(r).exitCode).toBe(3);
    expect(resultOf(r).stderr).toContain('boom');
  });

  it('keeps stdout in the result even when the command fails', async () => {
    const r = await adapter.execute(makeCall('echo partial; exit 2'));
    expect(r.success).toBe(false);
    expect(r.error).toContain('exit code 2');
    expect(resultOf(r).stdout).toContain('partial');
  });

  // Windows-only: the exit-code wrapper (see NodeToolAdapter / Rust
  // powershell_command_wrapped) must turn a failing NATIVE command and a
  // failing cmdlet into a non-zero process exit code — without it, Windows
  // PowerShell 5.1 reports 0 for both.
  it.skipIf(process.platform !== 'win32')('propagates a failing native command exit code through PowerShell', async () => {
    const r = await adapter.execute(makeCall('cmd /c exit 7'));
    expect(r.success).toBe(false);
    expect(resultOf(r).exitCode).not.toBe(0);
    expect(r.error).toContain('exit code');
  });

  it.skipIf(process.platform !== 'win32')('reports a failing PowerShell cmdlet as a non-zero exit code', async () => {
    const r = await adapter.execute(makeCall('Get-Content C:/definitely-missing-pure-test-file.txt'));
    expect(r.success).toBe(false);
    expect(resultOf(r).exitCode).not.toBe(0);
  });

  it('reports failure when the command is not found', async () => {
    const r = await adapter.execute(makeCall('definitely-not-a-real-command-xyz'));
    expect(r.success).toBe(false);
    // sh reports the failure on stderr; the exit code must be non-zero.
    expect(resultOf(r).exitCode).not.toBe(0);
  }, 30000);

  it('allows reads through a symlink pointing outside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pure-node-outside-'));
    try {
      // Directory symlinks need an explicit 'dir' type on Windows (a missing
      // type creates a file link); the type argument is ignored on POSIX.
      symlinkSync(outside, join(workspace, 'linked'), 'dir');
      writeFileSync(join(outside, 'secret.txt'), 'outside content');

      const r = await adapter.execute({
        id: 'call-symlink',
        index: 0,
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'linked/secret.txt' }) },
      });
      expect(r.success).toBe(true);
      expect(r.result).toContain('outside content');
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

describe('encodePowerShellCommand', () => {
  it('round-trips through base64 UTF-16LE with the exit-code wrapper appended', () => {
    const encoded = encodePowerShellCommand('Write-Output "hello world"');
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(decoded).toBe('Write-Output "hello world"; if ($?) { exit $LASTEXITCODE } else { exit 1 }');
  });

  it('keeps double quotes and CJK intact (the point of -EncodedCommand)', () => {
    const encoded = encodePowerShellCommand('Get-Content "C:\\数据\\x.txt"');
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(decoded).toContain('"C:\\数据\\x.txt"');
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
    safeRm(workspace);
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
    safeRm(workspace);
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
    safeRm(workspace);
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

describe('NodeToolAdapter diff_files', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-diff-files-'));
    adapter = new NodeToolAdapter({ workspace, commandTimeout: 10000 });
  });

  afterAll(() => {
    safeRm(workspace);
  });

  const diffCall = (pathA: string, pathB: string): ToolCall => ({
    id: `diff-${Date.now()}`,
    index: 0,
    function: { name: 'diff_files', arguments: JSON.stringify({ pathA, pathB }) },
  });

  it('reports identical files as a success with no diff', async () => {
    writeFileSync(join(workspace, 'same-a.txt'), 'alpha\nbeta\n');
    writeFileSync(join(workspace, 'same-b.txt'), 'alpha\nbeta\n');
    const r = await adapter.execute(diffCall('same-a.txt', 'same-b.txt'));
    expect(r.success).toBe(true);
    expect(String(r.result)).toContain('files are identical');
  });

  it('returns the unified diff when the files differ', async () => {
    writeFileSync(join(workspace, 'diff-a.txt'), 'alpha\nbeta\n');
    writeFileSync(join(workspace, 'diff-b.txt'), 'alpha\ngamma\n');
    const r = await adapter.execute(diffCall('diff-a.txt', 'diff-b.txt'));
    expect(r.success).toBe(true);
    const out = String(r.result);
    expect(out).toContain('beta');
    expect(out).toContain('gamma');
  });

  it.skipIf(shOnly)('fails cleanly when a path is missing instead of hanging', async () => {
    // POSIX diff exits 2 for missing paths; the Windows fallback (git diff
    // --no-index) reports the same condition on stderr with a different code.
    const r = await adapter.execute(diffCall('present.txt', 'missing.txt'));
    expect(r.success).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('NodeToolAdapter find_files', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-find-files-'));
    adapter = new NodeToolAdapter({ workspace });
    // Seed a small tree with a filename match and a content-only match.
    writeFileSync(join(workspace, '学历证明.pdf'), 'certificate of education');
    mkdirSync(join(workspace, 'docs'));
    writeFileSync(join(workspace, 'docs', 'resume.txt'), '我的学历：清华大学硕士\n工作经历：五年\n');
    writeFileSync(join(workspace, 'docs', 'notes.txt'), '无相关内容');
  });

  afterAll(() => {
    safeRm(workspace);
  });

  const call = (args: Record<string, unknown>): ToolCall => ({
    id: 'call-find',
    index: 0,
    function: { name: 'find_files', arguments: JSON.stringify(args) },
  });

  it('finds a file by CJK content after stripping stop words from the query', async () => {
    const r = await adapter.execute(call({ query: '我的学历' }));
    expect(r.success).toBe(true);
    const out = String(r.result);
    expect(out).toContain('resume.txt');
    expect(out).toContain('1 处命中');
  });

  it('ranks a content hit above a filename-only match (strongest proof first)', async () => {
    const r = await adapter.execute(call({ query: '学历' }));
    expect(r.success).toBe(true);
    const out = String(r.result);
    // resume.txt has a content hit (stronger proof); 学历证明.pdf is a
    // filename-only match and must rank after content hits.
    expect(out.indexOf('resume.txt')).toBeLessThan(out.indexOf('学历证明.pdf'));
    expect(out).toContain('1 处命中');
    expect(out).toContain('仅文件名命中');
  });

  it('reports a fallback with guidance when nothing matches', async () => {
    const r = await adapter.execute(call({ query: '太空旅行' }));
    expect(r.success).toBe(true);
    const out = String(r.result);
    expect(out).toContain('未找到匹配文件');
    expect(out).toContain('兜底建议');
  });

  it('rejects an empty query', async () => {
    const r = await adapter.execute(call({ query: '  ' }));
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('query 不能为空');
  });

  it('rejects a query that tokenizes to only stop words', async () => {
    const r = await adapter.execute(call({ query: '的的的' }));
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('无法从查询');
  });

  it('does not double-count a filename-only match that cannot be content-scanned', async () => {
    const bin = join(workspace, '学历.bin');
    writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]));
    try {
      const r = await adapter.execute(call({ query: '学历' }));
      expect(r.success).toBe(true);
      const out = String(r.result);
      expect(out).toContain('学历.bin');
      expect(out).toContain('仅文件名命中');
      expect(out).toContain('0 个跳过');
    } finally {
      unlinkSync(bin);
    }
  });
});

describe('tokenizeFindQuery', () => {
  const cases: Array<[string, string[]]> = [
    ['我的学历', ['学历']],
    ['毕业证', ['业证', '毕业']],
    ['太空旅行', ['太空', '旅行', '空旅']],
    ['education', ['education']],
    ['Education', ['education']],
    ['abc', ['abc']],
    ['ab', []],
    ['a1', ['a1']],
    ['123', ['123']],
    ['发票 学历', ['发票', '学历']],
    ['的的的', []],
    ['abc学历', ['ab', 'bc', 'c学', '学历']],
  ];
  for (const [input, expected] of cases) {
    it(`tokenizes ${JSON.stringify(input)}`, () => {
      expect(tokenizeFindQuery(input)).toEqual(expected);
    });
  }
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

describe('extendedProbePath', () => {
  it('keeps every inherited PATH entry and dedupes', () => {
    // PATH separator differs per platform (':' POSIX, ';' Windows).
    const sep = process.platform === 'win32' ? ';' : ':';
    const parts = extendedProbePath().split(sep).filter(Boolean);
    const inherited = (process.env.PATH ?? '').split(sep).filter(Boolean);
    expect(inherited.every((dir) => parts.includes(dir))).toBe(true);
    expect(new Set(parts).size).toBe(parts.length);
  });
});

describe('detectNetworkSummary', () => {
  it('reports proxy / env / vpn fields on one line, never throwing', () => {
    const out = detectNetworkSummary();
    // Field order is stable (proxy, env, vpn) and every field is populated —
    // the summary lands in the system prompt and sys_info output verbatim.
    expect(out).toMatch(/^proxy: .+; env: .+; vpn: .+$/);
    expect(out).not.toContain('\n');
  });
});
