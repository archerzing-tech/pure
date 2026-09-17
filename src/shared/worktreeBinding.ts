// src/shared/worktreeBinding.ts
// Session ↔ worktree binding (roadmap 4.1): when a SECOND session opens the
// same git repository, it does not share the directory — it automatically
// gets its own linked worktree (`git worktree add`) so both sessions can edit
// the same files without stepping on each other.
//
// For the future reader, the two naming conventions this module owns:
// - The worktree directory lives under `<pureHome>/worktrees/<repo-slug>-<hash>/<sessionId>`
//   — deliberately NOT inside the repo (the primary checkout's `git status`
//   must stay clean) and deliberately NOT in a temp dir (the worktree holds
//   uncommitted session work; a reboot must not be able to destroy it).
// - The branch prefix `pure/session-` marks auto-created bindings, so the
//   merge-back / cleanup flow (roadmap 4.4) can recognize its own worktrees.
//
// The session↔worktree mapping is recorded WITHOUT a new store:
// SessionMeta.workspace points at the worktree path (so a restored session
// reopens inside its worktree), and git itself keeps the reverse mapping
// (worktree → main repo + branch) — `describeWorktree` reads it back.
//
// This module is runtime-agnostic and dependency-free (the GUI bundle runs
// it in the browser, so no node:path): all git access goes through an
// injected GitRunner and all paths are plain strings.

/** Run `git args` with `cwd`; resolve stdout on exit 0, throw otherwise. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export interface SessionWorkspaceRequest {
  sessionId: string;
  /** The workspace path the session asked for (user pick / restore). */
  requestedWorkspace: string;
  /** Workspace paths currently bound to OTHER sessions (SessionMeta.workspace). */
  otherWorkspaces: readonly string[];
  /** pure home directory (~/.pure) hosting the worktree area. */
  pureHome: string;
}

export type SessionWorkspaceDecision =
  /** First session on this repo — bind the requested path directly. */
  | { kind: 'primary'; workspace: string }
  /** Not a git repo (or creation failed) — the directory IS the workspace. */
  | { kind: 'shared'; workspace: string }
  /** A collision — the session got its own linked worktree. */
  | { kind: 'linked-worktree'; workspace: string; branch: string; repoRoot: string };

/** Branch prefix that marks an auto-created session worktree (see header). */
export const SESSION_WORKTREE_BRANCH_PREFIX = 'pure/session-';

/** The durable directory that hosts every session worktree. */
export function pureWorktreeArea(pureHome: string): string {
  return `${trimSlashes(pureHome)}/worktrees`;
}

export async function resolveSessionWorkspace(
  request: SessionWorkspaceRequest,
  git: GitRunner,
): Promise<SessionWorkspaceDecision> {
  const requested = request.requestedWorkspace.trim();
  if (!requested) return { kind: 'shared', workspace: requested };

  let repoRoot: string;
  try {
    repoRoot = toNativePath((await git(['rev-parse', '--show-toplevel'], requested)).trim());
  } catch {
    // Not a git repository (or git unusable) — nothing to isolate, and the
    // directory is small enough that sharing it is the honest answer.
    return { kind: 'shared', workspace: requested };
  }
  if (!repoRoot) return { kind: 'shared', workspace: requested };

  // "Same repo" is judged on the repo ROOT, not the exact pick: one session
  // on the repo root and another on a subdirectory are still in each other's
  // way. Pure string containment covers both directions without running git
  // on every other session's path.
  const requestedNorm = normalizePath(requested);
  const repoNorm = normalizePath(repoRoot);
  const collides = request.otherWorkspaces.some((other) => {
    const otherNorm = normalizePath(other);
    return otherNorm === requestedNorm
      || isInside(otherNorm, repoNorm)
      || isInside(repoNorm, otherNorm);
  });
  if (!collides) return { kind: 'primary', workspace: requested };

  const sessionId = sanitizeSegment(request.sessionId);
  // The hash disambiguates two unrelated repos that share a basename
  // (~/work/a and ~/other/work/a never merge their worktree areas).
  // Split on BOTH separators: repoRoot is native by now (backslashes on
  // Windows), and taking the basename must not degrade to the whole path.
  const repoSlug = `${sanitizeSegment(repoRoot.split(/[\\/]/).pop() || 'repo')}-${hashPath(repoNorm)}`;
  const worktreePath = `${pureWorktreeArea(request.pureHome)}/${repoSlug}/${sessionId}`;
  // Branch is hyphenated + lowercased for hygiene: the GUI's `session_<ts>_<n>`
  // ids read as `pure/session-<ts>-<n>` (the id's own leading "session" is
  // dropped — the prefix already says it), and no tooling ever disagrees
  // about case in refnames.
  const branch = `${SESSION_WORKTREE_BRANCH_PREFIX}${sessionId.replace(/^session[-_]/, '').replace(/_+/g, '-').toLowerCase()}`;
  try {
    await git(['worktree', 'add', worktreePath, '-b', branch], repoRoot);
  } catch {
    // The branch/dir already exist — normally the same session resolving
    // twice (app restart re-picking the repo). Reuse the live worktree when
    // it is one of ours; otherwise fall back to sharing rather than blocking
    // the user's workspace pick on a worktree hiccup. The probe goes by the
    // checked-out BRANCH, not by path comparison: git reports realpaths, and
    // a lexical path through a symlinked home (macOS /var → /private/var,
    // network homes) would never string-equal it. A branch is checked out in
    // at most one worktree, and this one is namespaced by unique session id,
    // so "that branch is checked out here" means "this is our worktree".
    try {
      const branchNow = (await git(['branch', '--show-current'], worktreePath)).trim();
      if (branchNow === branch) {
        return { kind: 'linked-worktree', workspace: worktreePath, branch, repoRoot };
      }
    } catch {
      // Not a registered worktree — fall through to the shared fallback.
    }
    return { kind: 'shared', workspace: requested };
  }
  return { kind: 'linked-worktree', workspace: worktreePath, branch, repoRoot };
}

export interface WorktreeBinding {
  worktreePath: string;
  /** The MAIN repository root this worktree branches from. */
  repoRoot: string;
  /** The worktree's checked-out branch (without refs/heads/). */
  branch: string;
  /** The MAIN worktree's checked-out branch — the default target the
   * merge-back flow (4.4) diffs and merges into. Empty when the main
   * worktree is in detached HEAD (nothing to merge "into" by name). */
  mainBranch: string;
}

/**
 * Read a session↔worktree binding back from git's own metadata (nothing was
 * persisted outside git — see the header). `git worktree list --porcelain`
 * always lists the MAIN worktree first; the block whose path equals the
 * queried one carries its branch. Used by the merge-back flow (roadmap 4.4)
 * and as the mapping's read-back proof in tests. Returns null when the path
 * is not inside any git worktree.
 */
export async function describeWorktree(git: GitRunner, worktreePath: string): Promise<WorktreeBinding | null> {
  let here: string;
  let list: string;
  try {
    here = toNativePath((await git(['rev-parse', '--show-toplevel'], worktreePath)).trim());
    list = await git(['worktree', 'list', '--porcelain'], worktreePath);
  } catch {
    return null;
  }
  const hereNorm = normalizePath(here);
  let mainRoot = '';
  let mainBranch = '';
  let branch = '';
  for (const block of list.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const wtLine = lines.find((line) => line.startsWith('worktree '));
    if (!wtLine) continue;
    const path = toNativePath(wtLine.slice('worktree '.length).trim());
    const blockBranch = (lines.find((line) => line.startsWith('branch ')) ?? '').slice('branch '.length).trim();
    // The main worktree is always listed first — its branch is the merge
    // target the finish flow (4.4) diffs against.
    if (!mainRoot) {
      mainRoot = path;
      mainBranch = blockBranch.replace(/^refs\/heads\//, '');
    }
    if (normalizePath(path) === hereNorm) {
      branch = blockBranch;
    }
  }
  if (!mainRoot) return null;
  return { worktreePath: here, repoRoot: mainRoot, branch: branch.replace(/^refs\/heads\//, ''), mainBranch };
}

function trimSlashes(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

/**
 * git prints paths with forward slashes even on Windows (`C:/Users/...`,
 * `git worktree list` included). Callers compare these against natively
 * formatted workspace paths — the session's own workspace, the recent-workspace
 * list, FS APIs — so the platform form is restored here. Detected from the
 * string rather than from `process.platform` because this module is bundled
 * into the browser, where node is not available: a drive letter or an existing
 * backslash means Windows. POSIX paths pass through untouched.
 */
function toNativePath(path: string): string {
  const trimmed = path.trim();
  return /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes('\\')
    ? trimmed.replace(/\//g, '\\')
    : trimmed;
}

function normalizePath(path: string): string {
  return trimSlashes(path).replace(/\\/g, '/').toLowerCase();
}

function isInside(child: string, parent: string): boolean {
  return child !== parent && child.startsWith(`${parent}/`);
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}

function hashPath(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
