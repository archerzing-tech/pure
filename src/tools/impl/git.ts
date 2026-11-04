// src/tools/impl/git.ts
// Single-source implementation of the five git tools (W3/D1=A first migratee:
// the old pair of implementations — CLI spawning argv arrays, GUI shelling
// `git add -A && git commit -m '…'` through quoteShellArg over
// execute_command, plus three dedicated Rust commands — collapses into this
// one module). Behavior caliber is the CLI form, which was already the more
// careful one: every argument travels in argv, never through a shell, so
// quoting and escaping stop existing as a failure mode.
//
// Error material order is also inherited from the CLI form: some git
// failures explain themselves on stdout ("nothing to commit, working tree
// clean"), not stderr — stderr first, but fall back to stdout before the
// generic exit-code line so the model sees the actual reason.

import type { ArgvRunOptions, ArgvRunResult, ToolRuntime } from '../runtime';

export type GitToolName = 'git_diff' | 'git_log' | 'git_status' | 'git_commit' | 'git_branch';

export interface GitToolOutcome {
  ok: boolean;
  /** Command output on success; the failure reason on failure. */
  output: string;
}

function fail(output: string): GitToolOutcome {
  return { ok: false, output };
}

async function runOnce(runtime: ToolRuntime, argv: string[], options: ArgvRunOptions): Promise<GitToolOutcome> {
  let result: ArgvRunResult;
  try {
    result = await runtime.runArgv(argv, options);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Git command failed');
  }
  if (result.exitCode !== 0) {
    return fail(result.stderr.trim() || result.stdout.trim() || `git failed with exit code ${result.exitCode}`);
  }
  return { ok: true, output: result.stdout.trim() || '(no output)' };
}

/**
 * Run one git tool end to end: validate arguments, assemble git's argv, run
 * it over the injected runtime, and shape the outcome. Pure logic — the
 * adapters only wrap {@link GitToolOutcome} into their own ToolResult.
 */
export async function runGitTool(
  name: GitToolName,
  args: Record<string, unknown>,
  runtime: ToolRuntime,
  options: ArgvRunOptions = {},
): Promise<GitToolOutcome> {
  switch (name) {
    case 'git_diff': {
      const staged = args.staged === true;
      const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
      const argv = ['git', 'diff', ...(staged ? ['--staged'] : []), ...(rawPath ? ['--', rawPath] : [])];
      return await runOnce(runtime, argv, options);
    }
    case 'git_log': {
      const maxCount = args.maxCount === undefined || args.maxCount === null ? 10 : Number(args.maxCount);
      if (!Number.isInteger(maxCount) || maxCount < 1) return fail('git_log maxCount must be a positive integer');
      const oneline = args.oneline !== false;
      const argv = ['git', 'log', '-n', String(maxCount), ...(oneline ? ['--oneline'] : [])];
      return await runOnce(runtime, argv, options);
    }
    case 'git_status': {
      return await runOnce(runtime, ['git', 'status', '--short'], options);
    }
    case 'git_commit': {
      const message = typeof args.message === 'string' ? args.message.trim() : '';
      if (!message) return fail('git_commit requires a non-empty commit message');
      const paths = Array.isArray(args.paths) ? args.paths.map(String).filter((p) => p.trim().length > 0) : [];
      const staged = await runOnce(runtime, paths.length > 0 ? ['git', 'add', '--', ...paths] : ['git', 'add', '-A'], options);
      if (!staged.ok) return staged;
      const committed = await runOnce(runtime, ['git', 'commit', '-m', message], options);
      if (!committed.ok) return committed;
      return { ok: true, output: committed.output === '(no output)' ? 'Committed.' : committed.output };
    }
    case 'git_branch': {
      const action = typeof args.action === 'string' ? args.action : 'list';
      const branchName = typeof args.name === 'string' ? args.name.trim() : '';
      if (action === 'create' || action === 'switch') {
        if (!branchName) return fail(`git_branch action "${action}" requires a branch name`);
        // A leading "-" would re-enter git's flag parser; reject before spawn.
        if (branchName.startsWith('-')) return fail(`invalid branch name: ${branchName}`);
      }
      const argv = action === 'create' ? ['git', 'checkout', '-b', branchName]
        : action === 'switch' ? ['git', 'checkout', branchName]
        : action === 'list' ? ['git', 'branch']
        : null;
      if (!argv) return fail(`unknown git_branch action: ${action}`);
      return await runOnce(runtime, argv, options);
    }
  }
}
