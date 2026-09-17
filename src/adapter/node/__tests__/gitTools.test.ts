// src/adapter/node/__tests__/gitTools.test.ts
// 3.2 — git_commit / git_branch on the Node adapter, against a real throwaway
// repository: argv-only argument passing (no shell), subset staging, branch
// create/switch/list, and the confirmation-card preview from buildWritePreview.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeToolAdapter } from '../NodeToolAdapter';
import { buildWritePreview } from '../../../coding-agent/ToolRegistry';

let repo: string;
let adapter: NodeToolAdapter;

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

function toolCall(name: string, args: Record<string, unknown>) {
  return { id: 'c1', index: 0, function: { name, arguments: JSON.stringify(args) } };
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'pure-git-tools-'));
  adapter = new NodeToolAdapter({ workspace: repo, sessionId: 'test' });
  const run = async (args: string[]): Promise<void> => {
    const proc = Bun.spawn(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
  };
  await run(['init', '-q']);
  await run(['config', 'user.email', 'pure@test.local']);
  await run(['config', 'user.name', 'pure test']);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('git_commit', () => {
  it('stages everything and commits', async () => {
    writeFileSync(join(repo, 'a.txt'), 'hello');
    const result = await adapter.execute(toolCall('git_commit', { message: 'add a.txt' }));
    expect(result.success).toBe(true);
    expect(result.toolName).toBe('git_commit');
    expect(await git(['log', '--oneline', '-1'])).toContain('add a.txt');
  });

  it('with paths, stages only the subset and leaves the rest untouched', async () => {
    writeFileSync(join(repo, 'b.txt'), 'commit me');
    writeFileSync(join(repo, 'c.txt'), 'not yet');
    const result = await adapter.execute(toolCall('git_commit', { message: 'only b', paths: ['b.txt'] }));
    expect(result.success).toBe(true);
    const status = await git(['status', '--short']);
    expect(status).toContain('?? c.txt');   // never staged
    expect(status).not.toContain('b.txt');  // committed
  });

  it('surfaces nothing-to-commit as a failure, not a fake success', async () => {
    // Park any leftover changes from earlier tests so the tree is clean —
    // then `git add -A` succeeds but the commit itself must fail.
    await adapter.execute(toolCall('git_commit', { message: 'park leftovers' }));
    const result = await adapter.execute(toolCall('git_commit', { message: 'empty' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('nothing to commit');
  });

  it('rejects an empty message before touching git', async () => {
    const result = await adapter.execute(toolCall('git_commit', { message: '   ' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty commit message');
  });

  it('keeps quotes and newlines in the message intact (argv, not shell)', async () => {
    writeFileSync(join(repo, 'q.txt'), 'quoted');
    const message = "keep 'these' and\nnewlines; rm -rf would be data here";
    const result = await adapter.execute(toolCall('git_commit', { message }));
    expect(result.success).toBe(true);
    expect(await git(['log', '-1', '--format=%B'])).toContain(message);
  });
});

describe('git_branch', () => {
  it('creates and switches branches, and lists them', async () => {
    const initial = (await git(['branch', '--show-current'])).trim();

    const created = await adapter.execute(toolCall('git_branch', { action: 'create', name: 'feature/x' }));
    expect(created.success).toBe(true);
    expect(created.toolName).toBe('git_branch');
    expect(await git(['branch', '--show-current'])).toContain('feature/x');

    const listed = await adapter.execute(toolCall('git_branch', { action: 'list' }));
    expect(listed.success).toBe(true);
    expect(listed.result).toContain('feature/x');

    const back = await adapter.execute(toolCall('git_branch', { action: 'switch', name: initial }));
    expect(back.success).toBe(true);
    expect((await git(['branch', '--show-current'])).trim()).toBe(initial);
  });

  it('rejects a branch name that tries to re-enter the flag parser', async () => {
    const result = await adapter.execute(toolCall('git_branch', { action: 'create', name: '--force' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid branch name');
  });
});

describe('buildWritePreview for git tools', () => {
  it('shows the commit scope and the message on the confirmation card', () => {
    expect(buildWritePreview('git_commit', { message: 'fix login race', paths: ['src/a.ts'] }))
      .toEqual({ path: 'src/a.ts', contentPreview: 'fix login race' });
    expect(buildWritePreview('git_commit', { message: 'fix login race' }))
      .toEqual({ path: '(all changes)', contentPreview: 'fix login race' });
  });

  it('shows the branch action and name', () => {
    expect(buildWritePreview('git_branch', { action: 'create', name: 'feature/x' }))
      .toEqual({ path: 'feature/x', contentPreview: 'create' });
  });

  it('still returns undefined for read tools', () => {
    expect(buildWritePreview('git_status', {})).toBeUndefined();
  });
});
