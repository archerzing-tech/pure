// src/shared/worktreeFinish.ts
// Roadmap 4.4 — the wrap-up/merge flow for session worktrees. 4.1 gave every
// colliding session its own linked worktree (branch `pure/session-*`, dir
// under ~/.pure/worktrees); this module is its exit door:
//
//   inspectWorktreeFinish → what would merging bring? (commits, diff stat,
//                            uncommitted files) — the card's preview data
//   mergeWorktreeBack     → ONE click: auto-commit leftover edits, merge the
//                            branch into the main worktree's branch, remove
//                            the worktree, delete the (now merged) branch
//   discardWorktree       → the explicit destructive twin: worktree + branch
//                            gone, unmerged work included
//
// Contract details worth remembering:
// - A dirty worktree is auto-committed before merging ("one click" must not
//   silently drop uncommitted edits, and must not turn into a two-step
//   commit-then-merge dance either).
// - A merge CONFLICT aborts itself immediately. The user's main checkout must
//   never be left mid-merge by a UI button; the message names the manual
//   command instead.
// - Post-merge cleanup (worktree remove, branch -d) is best-effort: once the
//   merge succeeded the work is safe on the main branch, so a locked
//   worktree only demotes the result to "merged, cleanup pending" — it never
//   fails the click. Retention is the default everywhere: nothing here ever
//   destroys work except discardWorktree, which the UI confirms.
//
// Runtime-agnostic like worktreeBinding.ts: all git goes through an injected
// GitRunner, all paths are plain strings, no node imports.

import {
  describeWorktree,
  SESSION_WORKTREE_BRANCH_PREFIX,
  type GitRunner,
  type WorktreeBinding,
} from './worktreeBinding';

/** True when the binding is one of OUR auto-created session worktrees (4.1) —
 * the branch prefix is the marker the merge-back flow recognizes itself by. */
export function isSessionWorktree(binding: WorktreeBinding): boolean {
  return binding.branch.startsWith(SESSION_WORKTREE_BRANCH_PREFIX);
}

export interface WorktreeCommit {
  hash: string;
  subject: string;
}

export interface WorktreeFinishStatus {
  binding: WorktreeBinding;
  /** Commits on the session branch that the main branch does not have yet
   * (newest first, capped at 20 — a preview, not an export). */
  commits: WorktreeCommit[];
  /** Files the merge would touch (numstat line count for main...branch). */
  filesChanged: number;
  /** `git diff --stat` text — the card's diff preview body. */
  stat: string;
  /** Dirty entries inside the worktree (uncommitted work merge would miss). */
  uncommitted: number;
}

/** Gather everything the wrap-up card shows. Returns null when the path is
 * not inside a git worktree (workspace cleared, dir removed, non-git). */
export async function inspectWorktreeFinish(git: GitRunner, worktreePath: string): Promise<WorktreeFinishStatus | null> {
  const binding = await describeWorktree(git, worktreePath);
  if (!binding) return null;

  let uncommitted = 0;
  try {
    uncommitted = (await git(['status', '--porcelain'], binding.worktreePath)).split('\n').filter(Boolean).length;
  } catch {
    // The worktree vanished between describe and status — report the binding
    // level only; the GUI treats 0 uncommitted as "nothing held back".
  }

  const main = binding.mainBranch;
  if (!main) {
    // Main worktree in detached HEAD: nothing to diff/merge against by name.
    return { binding, commits: [], filesChanged: 0, stat: '', uncommitted };
  }

  let logRaw = '';
  let numstat = '';
  let stat = '';
  try {
    [logRaw, numstat, stat] = await Promise.all([
      git(['log', `--format=%h%x1f%s`, '-n', '20', `${main}..${binding.branch}`], binding.worktreePath),
      git(['diff', '--numstat', `${main}...${binding.branch}`], binding.worktreePath),
      git(['diff', '--stat', `${main}...${binding.branch}`], binding.worktreePath),
    ]);
  } catch {
    // Main branch renamed/deleted since describe — degrade to uncommitted-only
    // rather than hiding the card entirely.
    return { binding, commits: [], filesChanged: 0, stat: '', uncommitted };
  }
  const commits = logRaw.split('\n').filter(Boolean).map((line) => {
    const sep = line.indexOf('\x1f');
    return { hash: line.slice(0, sep), subject: line.slice(sep + 1) };
  });
  return {
    binding,
    commits,
    filesChanged: numstat.split('\n').filter(Boolean).length,
    stat: stat.trim(),
    uncommitted,
  };
}

export type WorktreeFinishResult =
  | { ok: true; autoCommitted: boolean; worktreeRemoved: boolean; branchDeleted: boolean }
  | { ok: false; stage: 'detached' | 'main-dirty' | 'commit' | 'merge'; message: string };

/** One-click merge back into the main worktree's branch, then clean up.
 * Runs everything against the MAIN repo root (merges and branch ops act on
 * the repo, not the worktree). See the header for the failure philosophy. */
export async function mergeWorktreeBack(git: GitRunner, status: WorktreeFinishStatus): Promise<WorktreeFinishResult> {
  const { binding } = status;
  const main = binding.mainBranch;
  if (!main) {
    return { ok: false, stage: 'detached', message: 'main worktree is in detached HEAD — no branch to merge into' };
  }

  // The main checkout must be clean: a three-way merge refusing midway over
  // dirty files is worse than refusing up front, and we never want to leave
  // the user's primary checkout in a conflicted state from a UI click.
  let mainDirty = '';
  try {
    mainDirty = (await git(['status', '--porcelain'], binding.repoRoot)).trim();
  } catch (err) {
    return { ok: false, stage: 'main-dirty', message: String(err) };
  }
  if (mainDirty) {
    return {
      ok: false,
      stage: 'main-dirty',
      message: 'main workspace has uncommitted changes — commit or stash there first, then merge again',
    };
  }

  // Auto-commit leftover edits so the merge carries EVERYTHING the session
  // produced (a branch merge alone would silently skip dirty files).
  let autoCommitted = false;
  if (status.uncommitted > 0) {
    try {
      await git(['add', '-A'], binding.worktreePath);
      await git(['commit', '-m', 'pure(session): wrap-up auto-commit before merge'], binding.worktreePath);
      autoCommitted = true;
    } catch (err) {
      return { ok: false, stage: 'commit', message: String(err) };
    }
  }

  try {
    await git(['merge', '--no-edit', binding.branch], binding.repoRoot);
  } catch (err) {
    // Roll the repo back out of the merge state before reporting — a conflicted
    // main checkout left behind by a UI button is the one unacceptable outcome.
    try {
      await git(['merge', '--abort'], binding.repoRoot);
    } catch {
      // Nothing to abort (merge refused before starting) — fine.
    }
    return { ok: false, stage: 'merge', message: String(err) };
  }

  // Post-merge cleanup is best-effort: the work is already on the main branch.
  let worktreeRemoved = false;
  let branchDeleted = false;
  try {
    await git(['worktree', 'remove', binding.worktreePath], binding.repoRoot);
    worktreeRemoved = true;
  } catch {
    // Locked or recreated files — the worktree stays (retention is safe).
  }
  if (worktreeRemoved) {
    try {
      await git(['branch', '-d', binding.branch], binding.repoRoot);
      branchDeleted = true;
    } catch {
      // `-d` refuses anything not fully merged — leaving it costs nothing.
    }
  }
  return { ok: true, autoCommitted, worktreeRemoved, branchDeleted };
}

export interface WorktreeDiscardResult {
  ok: boolean;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  message?: string;
}

/** Delete the worktree AND its branch, unmerged work included. The explicit
 * destructive twin of mergeWorktreeBack — the UI confirms before calling. */
export async function discardWorktree(git: GitRunner, binding: WorktreeBinding): Promise<WorktreeDiscardResult> {
  let worktreeRemoved = false;
  let branchDeleted = false;
  let message: string | undefined;
  try {
    await git(['worktree', 'remove', '--force', binding.worktreePath], binding.repoRoot);
    worktreeRemoved = true;
  } catch (err) {
    message = String(err);
  }
  if (worktreeRemoved) {
    try {
      // `-D` — the whole point of discard is that unmerged work is forfeit.
      await git(['branch', '-D', binding.branch], binding.repoRoot);
      branchDeleted = true;
    } catch (err) {
      message = String(err);
    }
  }
  return { ok: worktreeRemoved && branchDeleted, worktreeRemoved, branchDeleted, message };
}
