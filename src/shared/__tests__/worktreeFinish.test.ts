// src/shared/__tests__/worktreeFinish.test.ts
// Behavior tests for the wrap-up/merge flow (roadmap 4.4), against REAL git
// in throwaway repos. The worktrees under test are produced by the actual
// 4.1 producer (resolveSessionWorkspace), so the tests cover the full
// lifecycle: bind → work → inspect → merge back (or discard) → cleanup.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSessionWorkspace } from '../worktreeBinding';
import {
  discardWorktree,
  inspectWorktreeFinish,
  isSessionWorktree,
  mergeWorktreeBack,
} from '../worktreeFinish';

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr.trim()}`);
  return stdout;
}

let root: string;

beforeEach(async () => {
  // Resolve symlinks: git reports realpaths (macOS /var → /private/var).
  root = await realpath(await mkdtemp(join(tmpdir(), 'pure-finish-')));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function seedRepo(name: string): Promise<string> {
  const repo = join(root, name);
  const init = Bun.spawn(['git', 'init', '-q', repo]);
  await init.exited;
  await git(['config', 'user.email', 'test@pure.local'], repo);
  await git(['config', 'user.name', 'pure-test'], repo);
  // Windows git defaults to core.autocrlf=true: it would rewrite the LF
  // fixtures to CRLF on checkout (worktree add, merge) and fail the content
  // assertions for a reason that has nothing to do with the merge flow.
  await git(['config', 'core.autocrlf', 'false'], repo);
  await writeFile(join(repo, 'README.md'), 'seed\n', 'utf8');
  await git(['add', '-A'], repo);
  await git(['commit', '-q', '-m', 'seed'], repo);
  return repo;
}

/** The real 4.1 producer: the second session on the repo gets its worktree. */
async function makeSessionWorktree(repo: string): Promise<{ worktree: string; branch: string }> {
  const decision = await resolveSessionWorkspace(
    { sessionId: 'session_b', requestedWorkspace: repo, otherWorkspaces: [repo], pureHome: join(root, 'home', '.pure') },
    git,
  );
  if (decision.kind !== 'linked-worktree') throw new Error(`expected linked-worktree, got ${decision.kind}`);
  return { worktree: decision.workspace, branch: decision.branch };
}

/** Commit a file inside the worktree — one named session commit. */
async function commitInWorktree(worktree: string, file: string, content: string): Promise<void> {
  const path = join(worktree, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  await git(['add', '-A'], worktree);
  await git(['commit', '-q', '-m', `session: ${file}`], worktree);
}

describe('isSessionWorktree', () => {
  it('recognizes its own branch prefix only', async () => {
    const repo = await seedRepo('i');
    const { worktree } = await makeSessionWorktree(repo);
    const binding = await inspectWorktreeFinish(git, worktree);
    expect(binding && isSessionWorktree(binding.binding)).toBe(true);
    // A plain checkout is nobody's session worktree.
    const main = await inspectWorktreeFinish(git, repo);
    expect(main && isSessionWorktree(main.binding)).toBe(false);
  });
});

describe('inspectWorktreeFinish', () => {
  it('returns null outside git', async () => {
    const plain = await mkdtemp(join(root, 'plain-'));
    expect(await inspectWorktreeFinish(git, plain)).toBeNull();
  });

  it('reports commits, file count, stat and uncommitted work', async () => {
    const repo = await seedRepo('a');
    const { worktree } = await makeSessionWorktree(repo);
    await commitInWorktree(worktree, 'src/feature.ts', 'export const x = 1;\n');
    await commitInWorktree(worktree, 'src/more.ts', 'export const y = 2;\n');
    await writeFile(join(worktree, 'scratch.txt'), 'not committed yet\n', 'utf8');

    const status = await inspectWorktreeFinish(git, worktree);
    expect(status).not.toBeNull();
    expect(status!.commits.map((c) => c.subject)).toEqual(['session: src/more.ts', 'session: src/feature.ts']);
    expect(status!.commits.every((c) => /^[0-9a-f]+$/.test(c.hash))).toBe(true);
    expect(status!.filesChanged).toBe(2);
    // The diff preview names the files the merge would touch.
    expect(status!.stat).toContain('src/feature.ts');
    expect(status!.stat).toContain('src/more.ts');
    expect(status!.uncommitted).toBe(1);
  });

  it('reports nothing to settle on a fresh session worktree', async () => {
    const repo = await seedRepo('b');
    const { worktree } = await makeSessionWorktree(repo);
    const status = await inspectWorktreeFinish(git, worktree);
    expect(status).not.toBeNull();
    expect(status!.commits).toEqual([]);
    expect(status!.uncommitted).toBe(0);
  });
});

describe('mergeWorktreeBack', () => {
  it('carries commits AND dirty files into the main workspace, then cleans up', async () => {
    const repo = await seedRepo('c');
    const { worktree, branch } = await makeSessionWorktree(repo);
    await commitInWorktree(worktree, 'src/committed.ts', 'one\n');
    await writeFile(join(worktree, 'src/dirty.ts'), 'uncommitted\n', 'utf8');

    const status = await inspectWorktreeFinish(git, worktree);
    expect(status).not.toBeNull();
    const result = await mergeWorktreeBack(git, status!);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.autoCommitted).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);

    // Content landed in the MAIN workspace...
    expect(await Bun.file(join(repo, 'src/committed.ts')).text()).toBe('one\n');
    expect(await Bun.file(join(repo, 'src/dirty.ts')).text()).toBe('uncommitted\n');
    // ...the worktree dir and the branch are gone...
    expect(existsSync(worktree)).toBe(false);
    await expect(git(['rev-parse', '--verify', branch], repo)).rejects.toThrow();
    // ...and the main checkout is clean (nothing mid-merge).
    expect(await git(['status', '--porcelain'], repo)).toBe('');
  });

  it('refuses when the main workspace is dirty and leaves everything intact', async () => {
    const repo = await seedRepo('d');
    const { worktree, branch } = await makeSessionWorktree(repo);
    await commitInWorktree(worktree, 'src/feature.ts', 'one\n');
    // The user's own uncommitted work in the MAIN checkout.
    await writeFile(join(repo, 'README.md'), 'user is mid-edit\n', 'utf8');

    const status = await inspectWorktreeFinish(git, worktree);
    const result = await mergeWorktreeBack(git, status!);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('main-dirty');
    // Nothing moved: branch still exists, worktree still holds the commit,
    // and the user's dirty file is exactly as they left it.
    expect((await git(['rev-parse', '--verify', branch], repo)).trim()).not.toBe('');
    expect(await Bun.file(join(repo, 'README.md')).text()).toBe('user is mid-edit\n');
    expect(await git(['status', '--porcelain'], repo)).toContain(' M README.md');
  });

  it('rolls a conflicting merge back cleanly instead of leaving main mid-merge', async () => {
    const repo = await seedRepo('e');
    const { worktree, branch } = await makeSessionWorktree(repo);
    await commitInWorktree(worktree, 'shared.txt', 'session version\n');
    // The main workspace moves the same file forward after the branch split.
    await writeFile(join(repo, 'shared.txt'), 'main moved on\n', 'utf8');
    await git(['add', '-A'], repo);
    await git(['commit', '-q', '-m', 'main: shared.txt'], repo);

    const status = await inspectWorktreeFinish(git, worktree);
    const result = await mergeWorktreeBack(git, status!);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('merge');
    // The one unacceptable outcome (a conflicted primary checkout) did not
    // happen: no merge in progress, clean tree, worktree still intact.
    await expect(git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], repo)).rejects.toThrow();
    expect(await git(['status', '--porcelain'], repo)).toBe('');
    expect(existsSync(worktree)).toBe(true);
    expect((await git(['rev-parse', '--verify', branch], repo)).trim()).not.toBe('');
  });

  it('refuses to merge when the main worktree is in detached HEAD', async () => {
    const repo = await seedRepo('f');
    const { worktree } = await makeSessionWorktree(repo);
    await commitInWorktree(worktree, 'src/x.ts', 'x\n');
    await git(['checkout', '--detach', '-q', 'HEAD'], repo);

    const status = await inspectWorktreeFinish(git, worktree);
    expect(status!.binding.mainBranch).toBe('');
    const result = await mergeWorktreeBack(git, status!);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('detached');
    expect(existsSync(worktree)).toBe(true);
  });
});

describe('discardWorktree', () => {
  it('removes the worktree and branch even with unmerged, uncommitted work', async () => {
    const repo = await seedRepo('g');
    const { worktree, branch } = await makeSessionWorktree(repo);
    await commitInWorktree(worktree, 'src/doomed.ts', 'gone soon\n');
    await writeFile(join(worktree, 'notes.txt'), 'uncommitted\n', 'utf8');

    const status = await inspectWorktreeFinish(git, worktree);
    expect(status).not.toBeNull();
    const result = await discardWorktree(git, status!.binding);
    expect(result.ok).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(existsSync(worktree)).toBe(false);
    await expect(git(['rev-parse', '--verify', branch], repo)).rejects.toThrow();
    // The main workspace never saw any of it.
    expect(existsSync(join(repo, 'src/doomed.ts'))).toBe(false);
  });
});
