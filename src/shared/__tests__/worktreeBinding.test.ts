// src/shared/__tests__/worktreeBinding.test.ts
// Behavior tests for the session ↔ worktree binding (roadmap 4.1), run
// against REAL git in throwaway repos: the acceptance criterion is that two
// sessions pointed at the same repository end up in isolated directories and
// can edit the same file without interfering — that is a git behavior, so a
// fake runner would prove nothing.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeWorktree,
  pureWorktreeArea,
  resolveSessionWorkspace,
  type GitRunner,
  type SessionWorkspaceRequest,
} from '../worktreeBinding';

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
  // Resolve symlinks: git reports realpaths (macOS /var → /private/var), so
  // every path the tests hand to the module must be in resolved form too.
  root = await realpath(await mkdtemp(join(tmpdir(), 'pure-worktree-')));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

/** Seed a real repo with one commit so `worktree add` has a HEAD to branch from. */
async function seedRepo(name: string): Promise<string> {
  const repo = join(root, name);
  const init = Bun.spawn(['git', 'init', '-q', repo]);
  await init.exited;
  await git(['config', 'user.email', 'test@pure.local'], repo);
  await git(['config', 'user.name', 'pure-test'], repo);
  await writeFile(join(repo, 'README.md'), 'seed\n', 'utf8');
  await git(['add', '-A'], repo);
  await git(['commit', '-q', '-m', 'seed'], repo);
  return repo;
}

function request(partial: Partial<SessionWorkspaceRequest>): SessionWorkspaceRequest {
  return {
    sessionId: 'session_1726463643_1',
    requestedWorkspace: '',
    otherWorkspaces: [],
    pureHome: join(root, 'home', '.pure'),
    ...partial,
  };
}

function expectLinked(decision: { kind: string } & Record<string, unknown>): asserts decision is Extract<Awaited<ReturnType<typeof resolveSessionWorkspace>>, { kind: 'linked-worktree' }> {
  if (decision.kind !== 'linked-worktree') throw new Error(`expected linked-worktree, got ${decision.kind}: ${JSON.stringify(decision)}`);
}

describe('resolveSessionWorkspace', () => {
  it('binds the first session on a repo directly (primary)', async () => {
    const repo = await seedRepo('a');
    const decision = await resolveSessionWorkspace(request({ requestedWorkspace: repo }), git);
    expect(decision.kind).toBe('primary');
    expect(decision.workspace).toBe(repo);
  });

  it('gives the second session on the same repo its own linked worktree', async () => {
    const repo = await seedRepo('b');
    const first = await resolveSessionWorkspace(
      request({ sessionId: 'session_a', requestedWorkspace: repo }),
      git,
    );
    expect(first.kind).toBe('primary');

    const second = await resolveSessionWorkspace(
      request({ sessionId: 'session_b', requestedWorkspace: repo, otherWorkspaces: [repo] }),
      git,
    );
    expectLinked(second);
    // Isolation dir under the pure home, branch marks the auto-created binding.
    expect(second.workspace.startsWith(pureWorktreeArea(join(root, 'home', '.pure')))).toBe(true);
    expect(second.branch).toBe('pure/session-b');
    expect(second.repoRoot).toBe(repo);

    // git actually checked the worktree out, and the mapping reads back.
    const binding = await describeWorktree(git, second.workspace);
    expect(binding?.repoRoot).toBe(repo);
    expect(binding?.branch).toBe('pure/session-b');
  });

  it('keeps two sessions editing the same file from interfering (acceptance)', async () => {
    const repo = await seedRepo('c');
    const second = await resolveSessionWorkspace(
      request({ sessionId: 'session_b', requestedWorkspace: repo, otherWorkspaces: [repo] }),
      git,
    );
    expectLinked(second);

    // Both sessions write the SAME relative path in their own directory.
    await writeFile(join(repo, 'notes.txt'), 'session A was here\n', 'utf8');
    await writeFile(join(second.workspace, 'notes.txt'), 'session B was here\n', 'utf8');

    expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe('session A was here\n');
    expect(await readFile(join(second.workspace, 'notes.txt'), 'utf8')).toBe('session B was here\n');
    // Each working tree tracks only its own change...
    expect(await git(['status', '--porcelain'], repo)).toContain('?? notes.txt');
    expect(await git(['status', '--porcelain'], second.workspace)).toContain('?? notes.txt');
    // ...and the worktree is a real checkout of the same history.
    expect(await readFile(join(second.workspace, 'README.md'), 'utf8')).toBe('seed\n');
  });

  it('isolates when another session sits INSIDE the same repo (subdir bind)', async () => {
    const repo = await seedRepo('e');
    await mkdir(join(repo, 'sub'), { recursive: true });
    await writeFile(join(repo, 'sub', 'x.txt'), 'x\n', 'utf8');
    const decision = await resolveSessionWorkspace(
      request({
        sessionId: 'session_root',
        requestedWorkspace: repo,
        // The other session picked a path under the repo root — same repo.
        otherWorkspaces: [join(repo, 'sub')],
      }),
      git,
    );
    expectLinked(decision);
  });

  it('leaves non-git directories shared', async () => {
    const plain = await mkdtemp(join(root, 'plain-'));
    const decision = await resolveSessionWorkspace(request({ requestedWorkspace: plain }), git);
    expect(decision.kind).toBe('shared');
    expect(decision.workspace).toBe(plain);
  });

  it('re-resolving the same session reuses its existing worktree', async () => {
    const repo = await seedRepo('f');
    const otherWorkspaces = [repo];
    const first = await resolveSessionWorkspace(
      request({ sessionId: 'session_b', requestedWorkspace: repo, otherWorkspaces }),
      git,
    );
    expectLinked(first);

    // App restart: the session re-picks the same repo; branch already exists.
    const again = await resolveSessionWorkspace(
      request({ sessionId: 'session_b', requestedWorkspace: repo, otherWorkspaces }),
      git,
    );
    expectLinked(again);
    expect(again.workspace).toBe(first.workspace);
    expect(again.branch).toBe('pure/session-b');
  });

  it('falls back to sharing (never blocks the pick) when the worktree cannot be created', async () => {
    const repo = await seedRepo('g');
    // pureHome points at a FILE — the worktree area cannot exist under it.
    const blockedHome = join(root, 'blocked');
    await writeFile(blockedHome, 'not a dir\n', 'utf8');
    const decision = await resolveSessionWorkspace(
      request({ requestedWorkspace: repo, otherWorkspaces: [repo], pureHome: blockedHome }),
      git,
    );
    expect(decision.kind).toBe('shared');
    expect(decision.workspace).toBe(repo);
  });
});

describe('describeWorktree', () => {
  it('returns null outside any git worktree', async () => {
    const plain = await mkdtemp(join(root, 'plain-'));
    expect(await describeWorktree(git, plain)).toBeNull();
  });

  it('describes the MAIN worktree as its own root (not a linked one)', async () => {
    const repo = await seedRepo('h');
    const binding = await describeWorktree(git, repo);
    expect(binding?.repoRoot).toBe(repo);
    expect(binding?.worktreePath).toBe(repo);
    // The seeded repo's initial branch — whatever git's default names it.
    expect(['main', 'master']).toContain(binding?.branch ?? '');
  });
});
