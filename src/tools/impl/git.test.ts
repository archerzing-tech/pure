import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGitTool } from './git';
import type { ArgvRunOptions, ArgvRunResult, ToolRuntime } from '../runtime';

/** Records every argv it is handed; scripted replies or a per-call handler. */
function makeRuntime(handler: (argv: string[]) => ArgvRunResult) {
  const calls: string[][] = [];
  const runtime: ToolRuntime = {
    runArgv: async (argv: string[], _options?: ArgvRunOptions) => {
      calls.push(argv);
      return handler(argv);
    },
  };
  return { runtime, calls };
}

const ok = (stdout = ''): ArgvRunResult => ({ exitCode: 0, stdout, stderr: '' });
const err = (stderr: string, exitCode = 1): ArgvRunResult => ({ exitCode, stdout: '', stderr });

describe('runGitTool argv assembly (contract — one test suite covers both adapters)', () => {
  it('git_diff: default, staged, and path shapes', async () => {
    const { runtime, calls } = makeRuntime(() => ok('diff body'));
    await runGitTool('git_diff', {}, runtime);
    await runGitTool('git_diff', { staged: true }, runtime);
    await runGitTool('git_diff', { path: 'src/a.ts' }, runtime);
    await runGitTool('git_diff', { staged: true, path: ' src/b.ts ' }, runtime);
    // A blank path must not become an empty pathspec argument.
    await runGitTool('git_diff', { path: '   ' }, runtime);
    expect(calls).toEqual([
      ['git', 'diff'],
      ['git', 'diff', '--staged'],
      ['git', 'diff', '--', 'src/a.ts'],
      ['git', 'diff', '--staged', '--', 'src/b.ts'],
      ['git', 'diff'],
    ]);
  });

  it('git_log: defaults to -n 10 --oneline; maxCount/oneline honored', async () => {
    const { runtime, calls } = makeRuntime(() => ok('log body'));
    await runGitTool('git_log', {}, runtime);
    await runGitTool('git_log', { maxCount: 5, oneline: false }, runtime);
    expect(calls).toEqual([
      ['git', 'log', '-n', '10', '--oneline'],
      ['git', 'log', '-n', '5'],
    ]);
  });

  it('git_log: rejects non-positive and non-integer maxCount', async () => {
    const { runtime, calls } = makeRuntime(() => ok());
    for (const bad of [0, -1, 1.5, 'ten']) {
      const outcome = await runGitTool('git_log', { maxCount: bad }, runtime);
      expect(outcome.ok).toBe(false);
      expect(outcome.output).toContain('maxCount');
    }
    expect(calls).toEqual([]); // nothing spawned for invalid input
  });

  it('git_status: fixed short form', async () => {
    const { runtime, calls } = makeRuntime(() => ok(' M a.ts'));
    const outcome = await runGitTool('git_status', {}, runtime);
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual([['git', 'status', '--short']]);
  });

  it('git_commit: stages via argv (never a shell line), then commits', async () => {
    const { runtime, calls } = makeRuntime((argv) => (argv[1] === 'add' ? ok() : ok('[main abc] done')));
    const outcome = await runGitTool('git_commit', { message: ' fix: x ', paths: ['a b.ts', 'c.ts'] }, runtime);
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toBe('[main abc] done');
    expect(calls).toEqual([
      ['git', 'add', '--', 'a b.ts', 'c.ts'],
      ['git', 'commit', '-m', 'fix: x'],
    ]);
  });

  it('git_commit: without paths stages -A; empty output reads as Committed.', async () => {
    const { runtime, calls } = makeRuntime(() => ok(''));
    const outcome = await runGitTool('git_commit', { message: 'msg' }, runtime);
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toBe('Committed.');
    expect(calls).toEqual([['git', 'add', '-A'], ['git', 'commit', '-m', 'msg']]);
  });

  it('git_commit: missing message rejected before any spawn; add failure short-circuits', async () => {
    const { runtime, calls } = makeRuntime(() => err('fatal: not a git repository'));
    const noMessage = await runGitTool('git_commit', { paths: ['a'] }, runtime);
    expect(noMessage).toEqual({ ok: false, output: 'git_commit requires a non-empty commit message' });
    const addFails = await runGitTool('git_commit', { message: 'msg' }, runtime);
    expect(addFails.ok).toBe(false);
    expect(addFails.output).toBe('fatal: not a git repository');
    expect(calls).toEqual([['git', 'add', '-A']]); // no paths → stage -A; commit never spawned
  });

  it('git_branch: list/create/switch ride checkout; "-"-prefixed names rejected', async () => {
    const { runtime, calls } = makeRuntime(() => ok('branch out'));
    await runGitTool('git_branch', {}, runtime);
    await runGitTool('git_branch', { action: 'create', name: 'feat/x' }, runtime);
    await runGitTool('git_branch', { action: 'switch', name: 'main' }, runtime);
    expect(calls).toEqual([
      ['git', 'branch'],
      ['git', 'checkout', '-b', 'feat/x'],
      ['git', 'checkout', 'main'],
    ]);
    const noName = await runGitTool('git_branch', { action: 'create' }, runtime);
    expect(noName.ok).toBe(false);
    const dashName = await runGitTool('git_branch', { action: 'switch', name: '--force' }, runtime);
    expect(dashName.ok).toBe(false);
    const unknown = await runGitTool('git_branch', { action: 'delete', name: 'x' }, runtime);
    expect(unknown.output).toContain('unknown git_branch action');
  });

  it('failure material order: stderr first, then stdout, then the generic exit-code line', async () => {
    let call = 0;
    const { runtime } = makeRuntime(() => {
      call += 1;
      if (call === 1) return err('on stderr', 128);
      if (call === 2) return { exitCode: 1, stdout: 'on stdout', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: '' };
    });
    const viaStderr = await runGitTool('git_status', {}, runtime);
    expect(viaStderr).toEqual({ ok: false, output: 'on stderr' });
    const viaStdout = await runGitTool('git_log', {}, runtime);
    expect(viaStdout.output).toBe('on stdout');
    const generic = await runGitTool('git_diff', {}, runtime);
    expect(generic.output).toBe('git failed with exit code 1');
  });

  it('a runtime rejection (spawn ENOENT) surfaces as a failure with its message', async () => {
    const runtime: ToolRuntime = {
      runArgv: async () => {
        throw new Error('spawn git ENOENT');
      },
    };
    const outcome = await runGitTool('git_status', {}, runtime);
    expect(outcome).toEqual({ ok: false, output: 'spawn git ENOENT' });
  });
});

describe('runGitTool against a real git repo (same argv the GUI runtime runs)', () => {
  it('status → commit → log round-trips through plain argv', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pure-git-impl-'));
    try {
      const runtime: ToolRuntime = {
        runArgv: async (argv, options) => {
          const proc = Bun.spawn(argv, { cwd: options?.cwd ?? dir, stdout: 'pipe', stderr: 'pipe' });
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          await proc.exited;
          return { exitCode: proc.exitCode ?? -1, stdout, stderr };
        },
      };
      const bootstrap = Bun.spawn(['git', 'init', '-b', 'main'], { cwd: dir, stdout: 'ignore', stderr: 'ignore' });
      await bootstrap.exited;
      await Bun.spawn(['git', 'config', 'user.email', 'test@pure.local'], { cwd: dir, stdout: 'ignore' }).exited;
      await Bun.spawn(['git', 'config', 'user.name', 'pure test'], { cwd: dir, stdout: 'ignore' }).exited;

      const empty = await runGitTool('git_status', {}, runtime);
      expect(empty.ok).toBe(true);

      await writeFile(join(dir, 'hello.txt'), 'hi', 'utf8');
      const committed = await runGitTool('git_commit', { message: 'init: hello' }, runtime);
      expect(committed.ok).toBe(true);
      expect(committed.output).toContain('init: hello');

      const log = await runGitTool('git_log', { maxCount: 1 }, runtime);
      expect(log.ok).toBe(true);
      expect(log.output).toContain('init: hello');

      const clean = await runGitTool('git_status', {}, runtime);
      expect(clean.ok).toBe(true);
      expect(clean.output).toBe('(no output)');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
