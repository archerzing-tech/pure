// src/adapter/node/__tests__/NodeToolAdapter.test.ts

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeToolAdapter, detectLocalTimeLine, detectNetworkSummary, detectRuntimeVersions, encodePowerShellCommand, expandTilde, extendedProbePath, powershellFileLaunchArgs, powershellNeedsFileLaunch, powershellWrappedCommand, tokenizeFindQuery } from '../NodeToolAdapter';
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
  }, 30000); // PowerShell cold start on a loaded runner exceeds the 5s default (v4.1.3 Windows judge case); same budget as the not-found test below.

  it('reports failure when the command is not found', async () => {
    const r = await adapter.execute(makeCall('definitely-not-a-real-command-xyz'));
    expect(r.success).toBe(false);
    // A fast shell answers with a non-zero exit code. On a loaded CI runner
    // commandTimeout can fire first (2026-10-18 Windows), and a timed-out
    // command carries NO result object — nothing ran to completion, so there
    // is no exit code to report. Failure is still the correct answer there.
    const result = resultOf(r);
    if (result) expect(result.exitCode).not.toBe(0);
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
    // Windows 判例 2026-11-14：进度流源头抑制（$ProgressPreference）前置，
    // zh-CN 首次模块加载的 CLIXML 进度记录不再粘进 stderr。换行拼接 +
    // $__pure_prev 基线透传真实退出码（与 Rust powershell_command_wrapped
    // 同刀）：压码成 1 会与良性 exit-1 白名单叠加出假成功，2>&1 下的
    // NativeCommandError 会把成功打成失败。编码前导（Windows 判例
    // 2026-11-20，shared/powershellEncoding.ts 唯一源）：PS 5.1 文件 cmdlet
    // 缺省按 ANSI 落盘，中文写坏——全串 toBe 同时锁前导六行与 wrapper。
    expect(decoded).toBe(`try { [Console]::InputEncoding = [Text.UTF8Encoding]::new($false) } catch { }\ntry { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }\n$OutputEncoding = [Text.UTF8Encoding]::new($false)\n$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'\n$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'\n$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'\n$ProgressPreference='SilentlyContinue'\n$__pure_prev = $LASTEXITCODE\nWrite-Output "hello world"\nif (($null -ne $LASTEXITCODE) -and ($LASTEXITCODE -ne $__pure_prev)) { exit $LASTEXITCODE }\nif ($?) { exit 0 }\nexit 1`);
  });

  it('keeps double quotes and CJK intact (the point of -EncodedCommand)', () => {
    const encoded = encodePowerShellCommand('Get-Content "C:\\数据\\x.txt"');
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(decoded).toContain('"C:\\数据\\x.txt"');
  });

  it('puts the wrapper on its own lines so a trailing # comment cannot swallow it', () => {
    // 尾部 `# 注释` 在单行拼接下会吞掉整段 wrapper；换行后注释只管自己那行。
    // 编码前导六行居首（0-5），wrapper 各行索引随之整体后移。
    const decoded = Buffer.from(encodePowerShellCommand('cmd /c exit 3 # trailing comment'), 'base64').toString('utf16le');
    const lines = decoded.split('\n');
    expect(lines[5]).toBe(`$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'`);
    expect(lines[6]).toBe(`$ProgressPreference='SilentlyContinue'`);
    expect(lines[8]).toBe('cmd /c exit 3 # trailing comment');
    expect(lines[9]).toContain('exit $LASTEXITCODE');
  });
});

describe('powershell -File launch (32K 命令行上限守卫)', () => {
  it('routes a short command through -EncodedCommand', () => {
    expect(powershellNeedsFileLaunch('Get-ChildItem')).toBe(false);
  });

  it('routes an oversized command through -File (base64 would blow the 32K line)', () => {
    // ASCII 下膨胀 ≈ 2.67×（UTF-16LE ×2 再 base64 ×4/3），撞线点 ~12k 字符
    // （中文每字 UTF-8 3 字节 → 8×，撞线更早——判据测编码产物长度，与输入
    // 字符集无关，这里用明显越线/明显安全的两侧输入）。
    expect(powershellNeedsFileLaunch('echo ' + 'x'.repeat(13000))).toBe(true);
    expect(powershellNeedsFileLaunch('echo ' + 'x'.repeat(11000))).toBe(false);
  });

  it('launch args carry -ExecutionPolicy Bypass and the -File path', () => {
    // -File 受 ExecutionPolicy 管辖（-EncodedCommand 不受），默认 Restricted
    // 会直接拒绝运行落盘脚本。
    const args = powershellFileLaunchArgs('C:\\Temp\\pure-cmd-x.ps1');
    expect(args[args.length - 1]).toBe('C:\\Temp\\pure-cmd-x.ps1');
    expect(args).toContain('-ExecutionPolicy');
    expect(args).toContain('Bypass');
    expect(args).toContain('-File');
    expect(args[0]!.endsWith('powershell.exe')).toBe(true);
  });

  it('wrapper plaintext is shared verbatim between both paths', () => {
    const decoded = Buffer.from(encodePowerShellCommand('Get-Date'), 'base64').toString('utf16le');
    expect(powershellWrappedCommand('Get-Date')).toBe(decoded);
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
    // 读前门（2026-11-22）：覆写前先读一次，同时把真实调用顺序走一遍。
    expect((await adapter.execute(call('read_file', { path: 'existing.txt' }))).success).toBe(true);
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

describe('expandTilde', () => {
  // 纯函数注入 home，不碰进程环境——任何平台跑结果一致。
  const home = '/Users/tester';
  it('展开 ~、~/、$HOME、%USERPROFILE% 前缀', () => {
    expect(expandTilde('~', home)).toBe(home);
    expect(expandTilde('~/Downloads/a.md', home)).toBe('/Users/tester/Downloads/a.md');
    expect(expandTilde('$HOME', home)).toBe(home);
    expect(expandTilde('$HOME/doc.txt', home)).toBe('/Users/tester/doc.txt');
    expect(expandTilde('~/a', '/Users/tester/')).toBe('/Users/tester/a');
    // `~\`、`%USERPROFILE%\` 的展开产物含平台差异（非 Windows 上反斜杠是
    // 合法文件名字符），精确串会漂移——只锁行为（落在 home 下且内容没丢）。
    const backslashed = expandTilde('~\\Downloads\\a.md', home);
    expect(backslashed.startsWith(home)).toBe(true);
    expect(backslashed).toContain('Downloads');
    const profile = expandTilde('%USERPROFILE%\\doc.txt', home);
    expect(profile.startsWith(home)).toBe(true);
    expect(profile).toContain('doc.txt');
  });
  it('非边界与未知前缀按字面不动', () => {
    expect(expandTilde('~user/x', home)).toBe('~user/x');
    expect(expandTilde('$HOMEWORK/x', home)).toBe('$HOMEWORK/x');
    expect(expandTilde('relative/a.txt', home)).toBe('relative/a.txt');
    expect(expandTilde('', home)).toBe('');
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
  // Five sequential process spawns can legitimately take seconds on a cold
  // Windows runner — bun's 5s default per-test timeout killed this once in
  // CI (6030ms) with nothing actually wrong. Give it real headroom.
  }, 30_000);

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

// 刀 D1（2026-10-10）read_file 真杠杆：默认（未给范围）大文件只回头部切片
// + 总行数 + 建议范围，不做硬截断；显式范围原样给、不加脚注；小文件零变化。
describe('NodeToolAdapter read_file head-default（刀 D1）', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-node-readhead-'));
    adapter = new NodeToolAdapter({ workspace, commandTimeout: 10000 });
  });

  afterAll(() => {
    safeRm(workspace);
  });

  const read = async (args: Record<string, unknown>): Promise<ToolResult> =>
    adapter.execute({
      id: 'call-readhead',
      index: 0,
      function: { name: 'read_file', arguments: JSON.stringify(args) },
    });

  it('returns small files whole with no footer', async () => {
    writeFileSync(join(workspace, 'small.txt'), 'l1\nl2\nl3');
    const r = await read({ path: 'small.txt' });
    expect(r.success).toBe(true);
    expect(r.result).toBe('1→l1\n2→l2\n3→l3');
    expect(String(r.result)).not.toContain('read_file：');
    // 显式关掉行号时保持旧形态（逐字内容场景）。
    const bare = await read({ path: 'small.txt', lineNumbers: false });
    expect(bare.result).toBe('l1\nl2\nl3');
  });

  it('returns only the head plus total-lines footer for a big file without a range', async () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`).join('\n');
    writeFileSync(join(workspace, 'big.txt'), big);
    const r = await read({ path: 'big.txt' });
    expect(r.success).toBe(true);
    const text = String(r.result);
    expect(text).toContain('1→line-1\n');
    expect(text).toContain('2000→line-2000');
    expect(text).not.toContain('line-2001');
    // 脚注如实交代总行数 + 建议续读起点。
    expect(text).toContain('[read_file：以上是前 2000 行，文件共 2500 行。继续读用 startLine=2001');
  });

  it('outline:true returns declaration lines with line numbers instead of the body（2026-11-17）', async () => {
    const src = [
      'import x from "y";',
      'export class Foo {',
      '  bar() {',
      '    if (x) { return 1; }',
      '  }',
      '}',
      'export function baz() {}',
    ].join('\n');
    writeFileSync(join(workspace, 'outline.ts'), src);
    const text = String((await read({ path: 'outline.ts', outline: true })).result);
    expect(text).toContain('[outline: outline.ts — 7 lines, 3 symbols]');
    expect(text).toContain('2: export class Foo {');
    expect(text).toContain('3:   bar() {');
    expect(text).toContain('7: export function baz() {}');
    expect(text).not.toContain('import x');
    // 行范围不改变 outline 的全文语义（schema 已写明忽略）。
    const ranged = String((await read({ path: 'outline.ts', outline: true, startLine: 3, endLine: 3 })).result);
    expect(ranged).toContain('export class Foo');
  });

  it('outline:true is honest for non-code files', async () => {
    writeFileSync(join(workspace, 'outline-notes.txt'), 'hello');
    const text = String((await read({ path: 'outline-notes.txt', outline: true })).result);
    expect(text).toContain('no symbol outline for this file type');
  });

  it('returns an explicitly requested range verbatim with no footer', async () => {
    const r = await read({ path: 'big.txt', startLine: 2400, endLine: 2402 });
    expect(r.success).toBe(true);
    expect(r.result).toBe('2400→line-2400\n2401→line-2401\n2402→line-2402');
    expect(String(r.result)).not.toContain('read_file：');
  });

  it('stops the head at the char budget by whole lines, never mid-line', async () => {
    // 每行 8000 字符：第 4 行会撞上 32000 预算 → 只取前 3 行（按行整体取）。
    const fat = Array.from({ length: 10 }, (_, i) => `f${i}-${'a'.repeat(8000)}`).join('\n');
    writeFileSync(join(workspace, 'fat.txt'), fat);
    const r = await read({ path: 'fat.txt' });
    expect(r.success).toBe(true);
    const text = String(r.result);
    expect(text).toContain('f2-aaa');
    expect(text).not.toContain('f3-aaa');
    expect(text).toContain('[read_file：以上是前 3 行，文件共 10 行。继续读用 startLine=4');
  });

  it('clips an overlong line inside an explicit range with a length marker（2026-11-17）', async () => {
    // 单行 5000 字符落在显式范围里：截到 2000 + 标记，不再整行过桥。
    writeFileSync(join(workspace, 'clip.txt'), `head\n${'x'.repeat(5000)}\n`);
    const r = await read({ path: 'clip.txt', startLine: 2, endLine: 2 });
    expect(r.success).toBe(true);
    const text = String(r.result);
    expect(text.startsWith(`2→${'x'.repeat(2000)}`)).toBe(true);
    expect(text).toContain('本行共 5000 字符，已截断');
    expect(text.length).toBeLessThan(3000);
    expect(text).not.toContain('已按行截断');
  });

  it('adds a continuation footer when an explicit range exceeds the char budget（2026-11-17）', async () => {
    // 每行 1900 字符 ×20 行 ≈ 38k > 32k 预算 → 前 16 行 + 续读脚注；不再
    // 整段过桥撞引擎 40k 盲截、拿到无尾巴信息的半截。
    const fat = Array.from({ length: 20 }, (_, i) => `f${i + 1}-${'a'.repeat(1897)}`).join('\n');
    writeFileSync(join(workspace, 'range-fat.txt'), fat);
    const r = await read({ path: 'range-fat.txt', startLine: 1, endLine: 20 });
    expect(r.success).toBe(true);
    const text = String(r.result);
    expect(text).toContain('f16-aaa');
    expect(text).not.toContain('f17-aaa');
    expect(text).toContain('[read_file：范围共 20 行，以上显示前 16 行');
    expect(text).toContain('继续读用 startLine=17');
  });

  it('streams an interior range from a big file verbatim without loading it whole（A3 同刀）', async () => {
    // 流式首窗：50k 行文件只取最后 3 行——逐行流读到 endLine 即停，输出与
    // 全文路径逐字一致（1 基、含端点、内部行原样）。
    const big = Array.from({ length: 50_000 }, (_, i) => `line-${i + 1}`).join('\n');
    writeFileSync(join(workspace, 'streamed.txt'), big);
    const r = await read({ path: 'streamed.txt', startLine: 49_998, endLine: 50_000 });
    expect(r.success).toBe(true);
    expect(r.result).toBe('49998→line-49998\n49999→line-49999\n50000→line-50000');
    expect(String(r.result)).not.toContain('read_file：');
  });
});

// 撤销快照降级（2026-11-17）：快照是脚手架不是闸门——旧实现超预算 throw
// 把整次写入拒掉（append 到大日志被硬拦是「写入中断」类），现在降级为跳过
// 快照、写入照做，结果自带「未提供撤销快照」注记。
describe('NodeToolAdapter write_file snapshot degrade（2026-11-17）', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-node-snapdgr-'));
    adapter = new NodeToolAdapter({ workspace, commandTimeout: 10000 });
  });

  afterAll(() => {
    safeRm(workspace);
  });

  const run = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    adapter.execute({
      id: `call-${name}`,
      index: 0,
      function: { name, arguments: JSON.stringify(args) },
    });

  it('appends to an oversized existing file instead of refusing the write', async () => {
    const big = join(workspace, 'huge.log');
    writeFileSync(big, 'a'.repeat(9 * 1024 * 1024));
    const r = await run('write_file', { path: 'huge.log', content: 'tail', append: true });
    expect(r.success).toBe(true);
    expect(String(r.result)).toContain('Appended 4 bytes');
    expect(String(r.result)).toContain('(当前写入未提供撤销快照)');
    const after = readFileSync(big, 'utf8');
    expect(after.startsWith('aaaa')).toBe(true);
    expect(after.endsWith('tail')).toBe(true);
    // 降级批次不可撤销：撤销端口不提供任何可恢复批次。
    expect(adapter.getSnapshotPort().getLatestWriteBatch()).toBeNull();
  });

  it('overwrites an oversized existing file instead of refusing the write', async () => {
    writeFileSync(join(workspace, 'huge2.log'), 'b'.repeat(9 * 1024 * 1024));
    const r = await run('write_file', { path: 'huge2.log', content: 'fresh', overwrite: true });
    expect(r.success).toBe(true);
    expect(String(r.result)).toContain('Wrote 5 bytes');
    expect(readFileSync(join(workspace, 'huge2.log'), 'utf8')).toBe('fresh');
  });

  it('keeps the undo snapshot for a normal small write', async () => {
    writeFileSync(join(workspace, 'small.txt'), 'old');
    const r = await run('write_file', { path: 'small.txt', content: 'new', overwrite: true });
    expect(r.success).toBe(true);
    expect(String(r.result)).not.toContain('当前写入未提供撤销快照');
    expect(adapter.getSnapshotPort().getLatestWriteBatch()).not.toBeNull();
  });
});

describe('detectLocalTimeLine — sys_info time 行与 Rust 同形（2026-11-08 分叉盘点刀 ⑥）', () => {
  it('formats as YYYY-MM-DD HH:MM:SS TZ, never the long English toString shape', () => {
    // GUI 侧（Rust detect_current_time）是权威形状：date +%Y-%m-%d %H:%M:%S %Z。
    // 此前 CLI 用 new Date().toString()（"Fri Nov 07 2026 …"），同一字段两端
    // 两个形状。锁格式本体 + 禁旧形状。
    const line = detectLocalTimeLine(new Date(2026, 10, 7, 9, 41, 5), 'Asia/Shanghai');
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+$/);
    expect(line).not.toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/);
    expect(line.startsWith('2026-11-07 09:41:05')).toBe(true);
  });

  it('falls back to the tz name when no short zone abbrevation exists', () => {
    const line = detectLocalTimeLine(new Date(2026, 0, 2, 3, 4, 5), 'Etc/GMT-14');
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+$/);
  });
});

describe('NodeToolAdapter web_fetch netLedger 接线（P0b）', () => {
  let ledger: typeof import('../../../shared/network/ledger');
  let workspace2: string;
  let adapter2: NodeToolAdapter;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    ledger = await import('../../../shared/network/ledger');
    workspace2 = mkdtempSync(join(tmpdir(), 'pure-node-ledger-'));
    // 页面缓存落盘 ~/.pure/cache（跨进程共享）：不隔离的话，任何一次先跑的
    // 真实 fetch 都会把本 describe 的 URL 灌进用户真缓存，后续跑全部命中
    // 缓存短路、链路代码零执行（flaky-quartet 同族判例的 persist 型单例）。
    process.env.PURE_CACHE_DIR = workspace2;
    adapter2 = new NodeToolAdapter({ workspace: workspace2, commandTimeout: 10000 });
  });
  afterAll(() => {
    delete process.env.PURE_CACHE_DIR;
    safeRm(workspace2);
  });
  beforeEach(() => ledger.resetNetLedgerForTests());

  const mockFetch = (impl: () => Response): void => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => impl()) as unknown as typeof fetch;
  };
  const restoreFetch = (): void => { globalThis.fetch = originalFetch; };

  const fetchCall = (url: string): ToolCall => ({
    id: `ledger_${Date.now()}`,
    index: 0,
    function: { name: 'web_fetch', arguments: JSON.stringify({ url, maxChars: 5000 }) },
  });

  it('direct 成功样本入账；cache 命中不再产 Attempt（n 不变）', async () => {
    mockFetch(() => new Response('<html><body>ledger cli direct sample</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    try {
      const r = await adapter2.execute(fetchCall('https://ledger-cli.example.com/page'));
      expect(r.success).toBe(true);
      let snap = ledger.ledgerSnapshot();
      expect(snap.host['ledger-cli.example.com']?.direct?.n).toBe(1);
      expect(snap.host['ledger-cli.example.com']?.direct?.ok).toBe(1);
      expect(snap.class['web-page']?.direct?.n).toBe(1);
      // 同 URL 二调走页面缓存：账本不涨（cache 永不产证据，不变量 2 的行为面）。
      await adapter2.execute(fetchCall('https://ledger-cli.example.com/page'));
      snap = ledger.ledgerSnapshot();
      expect(snap.host['ledger-cli.example.com']?.direct?.n).toBe(1);
    } finally {
      restoreFetch();
    }
  });

  it('404 全链：direct/reader/mirror:wayback/mirror:firecrawl 各一条失败样本', async () => {
    mockFetch(() => new Response('nope', { status: 404 }));
    try {
      const url = `https://ledger-404.example.com/missing-${Date.now()}`;
      const r = await adapter2.execute(fetchCall(url));
      expect(r.success).toBe(false);
      expect(r.error).toContain('HTTP 404'); // 状态码随行：模型看得到「页面不存在」
      const snap = ledger.ledgerSnapshot();
      const host = snap.host['ledger-404.example.com']!;
      expect(host.direct?.n).toBe(1);
      expect(host.direct?.ok).toBe(0);
      expect(host.reader?.n).toBe(1);
      expect(host['mirror:wayback']?.n).toBe(1);
      expect(host['mirror:firecrawl']?.n).toBe(1);
      // 全失败：lastOkAt 缺席 → 读侧 TTL 判无效行。
      expect(ledger.hostStat(snap, 'ledger-404.example.com', 'direct')).toBeUndefined();
      // 2026-11-07 真机判例：内容性 404 不喂熔断器（主机可达，资源不存在）。
      const { hostBlocked } = await import('../../../shared/netGuard');
      expect(hostBlocked(url)).toBe(false);
    } finally {
      restoreFetch();
    }
  });
});

// 超时部分输出保留（2026-11-17 大项目测试超时判例）：echo 先产出、sleep 撞
// 超时——结果必须带回已产出的部分输出 + 机制出路指引，不再一句 timed out
// 配空输出。
describe('execute_command timeout partial output（2026-11-17）', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-node-timeout-'));
    adapter = new NodeToolAdapter({ workspace, commandTimeout: 10000 });
  });

  afterAll(() => {
    safeRm(workspace);
  });

  it('returns partial output and exit-path guidance on timeout', async () => {
    const r = await adapter.execute({
      id: 'call-timeout',
      index: 0,
      function: { name: 'execute_command', arguments: JSON.stringify({ command: 'echo partial-marker-kept; sleep 30', timeoutMs: 600 }) },
    });
    expect(r.success).toBe(false);
    const text = JSON.stringify(r.result);
    expect(text).toContain('partial-marker-kept');
    expect(String(r.error)).toContain('background:true');
    expect(String(r.error)).toContain('600000');
  }, 20000);
});

// 2026-11-22 coding loop: read-before-write gate + edit hunk echo.
describe('NodeToolAdapter write_file read-before-write gate', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-node-gate-'));
    adapter = new NodeToolAdapter({ workspace, commandTimeout: 10000 });
  });

  afterAll(() => {
    safeRm(workspace);
  });

  const exec = (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    adapter.execute({ id: `gate-${name}`, index: 0, function: { name, arguments: JSON.stringify(args) } });

  it('refuses to overwrite an existing file that was never read', async () => {
    writeFileSync(join(workspace, 'unread.txt'), 'original');
    const r = await exec('write_file', { path: 'unread.txt', content: 'replaced' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('has not been read in this session');
    expect(readFileSync(join(workspace, 'unread.txt'), 'utf8')).toBe('original');
  });

  it('allows the overwrite after a read in the same session', async () => {
    writeFileSync(join(workspace, 'read-first.txt'), 'original');
    expect((await exec('read_file', { path: 'read-first.txt' })).success).toBe(true);
    const r = await exec('write_file', { path: 'read-first.txt', content: 'replaced' });
    expect(r.success).toBe(true);
    expect(readFileSync(join(workspace, 'read-first.txt'), 'utf8')).toBe('replaced');
  });

  it('allows creating a new file without a read', async () => {
    const r = await exec('write_file', { path: 'brand-new.txt', content: 'hello' });
    expect(r.success).toBe(true);
  });

  it('allows an explicit overwrite:true', async () => {
    writeFileSync(join(workspace, 'force.txt'), 'original');
    const r = await exec('write_file', { path: 'force.txt', content: 'forced', overwrite: true });
    expect(r.success).toBe(true);
    expect(readFileSync(join(workspace, 'force.txt'), 'utf8')).toBe('forced');
  });

  it('never blocks append:true (chunked write flow)', async () => {
    writeFileSync(join(workspace, 'chunked.txt'), 'part1');
    const r = await exec('write_file', { path: 'chunked.txt', content: '-part2', append: true });
    expect(r.success).toBe(true);
    expect(readFileSync(join(workspace, 'chunked.txt'), 'utf8')).toBe('part1-part2');
  });

  it('accepts a copied gutter block in edit_file and echoes the changed region', async () => {
    writeFileSync(join(workspace, 'edit.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const r = await exec('edit_file', {
      path: 'edit.ts',
      // 模型把 read_file 的显示层整块复制进来的真实形态。
      oldString: '2→const b = 2;',
      newString: 'const b = 20;',
    });
    expect(r.success).toBe(true);
    const text = String(r.result);
    expect(text).toContain('(now 4 lines)');
    expect(text).toContain('Changed region:');
    expect(text).toContain('2→const b = 20;');
    expect(text).toContain('1→const a = 1;');
  });
});
