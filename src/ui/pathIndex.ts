// src/ui/pathIndex.ts
// Roadmap 阶段 11.2 (P1) — workspace path repair for the GUI composer.
//
// A slipped character in a path ("src/ui/mian.ts") used to send the agent
// hunting for a file that does not exist; models do not stop and ask, they pick
// the closest-looking file and edit it. This module can rewrite such a token
// into a path that really exists in the workspace — and nothing else.
//
// Two halves, deliberately split so the composer never pays for the I/O:
//   warmPathIndex()          async (glob IPC + recent writes), fire-and-forget;
//                            the send path only ever reads a warm index
//   correctWorkspacePaths()  pure + synchronous, unit-tested without a harness
//
// Iron laws (roadmap 阶段 11): only a UNIQUE candidate within a small edit
// distance is applied — two candidates mean we cannot know which file the user
// meant, so the draft goes out untouched. Absolute paths, URLs, globs, fenced
// code and bare filenames are never touched either: this repairs a path the
// user typed, it does not guess which file they meant.

import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { buildContextCandidates } from './inlineAutocomplete';

export interface PathRepair {
  from: string;
  to: string;
}

export interface PathCorrection {
  /** Text to send. Identical to the input when nothing was corrected. */
  text: string;
  /** What changed — feeds the transcript note and "use my original words". */
  repairs: PathRepair[];
}

// ── Index (async side) ──

const INDEX_TTL_MS = 60_000;
const MAX_INDEX_FILES = 1200;

/** Extensions worth indexing: the files a coding request actually names. */
const INDEXED_EXTENSIONS = '{ts,tsx,js,jsx,mjs,cjs,md,mdx,json,css,html,py,rs,go,java,rb,php,toml,yaml,yml,sh,sql,vue,svelte}';

/** Directory names that are never the file the user meant, and would crowd the
 *  index out — the glob IPC truncates at a cap BEFORE we get to filter. */
const NOISE_DIRS = [
  'node_modules/', '.git/', 'dist/', 'build/', 'out/', 'target/', 'vendor/',
  '.next/', '__pycache__/', '.venv/', 'venv/', 'coverage/', '.cache/',
];

let index: readonly string[] = [];
let indexWorkspace = '';
let warmedAt = 0;
let warmingWorkspace = '';
let warming: Promise<void> | null = null;

/** Warm index as a plain list — the composer reads it synchronously. */
export function getPathIndex(): readonly string[] {
  return index;
}

/** Test seam: nothing in the app needs to drop a warm index. */
export function resetPathIndex(): void {
  index = [];
  indexWorkspace = '';
  warmedAt = 0;
  warmingWorkspace = '';
  warming = null;
}

/**
 * Build/refresh the index for a workspace in the background.
 *
 * Callers never await this on the send path: a cold index simply means "no
 * correction this turn", which is the honest failure mode (an unawaited local
 * glob must never delay the user's send, and it must never be required for
 * correctness).
 */
export function warmPathIndex(workspace: string, options: { force?: boolean } = {}): Promise<void> {
  if (!workspace) {
    index = [];
    indexWorkspace = '';
    return Promise.resolve();
  }
  if (indexWorkspace === workspace && !options.force && Date.now() - warmedAt < INDEX_TTL_MS) {
    return Promise.resolve();
  }
  if (warming && warmingWorkspace === workspace) return warming;
  warmingWorkspace = workspace;
  warming = buildIndex(workspace)
    .then((paths) => {
      // A workspace switch mid-warm must not publish the old tree.
      if (warmingWorkspace !== workspace) return;
      index = paths;
      indexWorkspace = workspace;
      warmedAt = Date.now();
    })
    .catch(() => {
      // No index is a working state (correction off); never surface I/O noise
      // into the composer.
    })
    .finally(() => {
      warming = null;
    });
  return warming;
}

async function buildIndex(workspace: string): Promise<string[]> {
  const paths = new Set<string>();
  // Recently written files first: they are exactly what the user is most likely
  // to name next, and they cost no IPC.
  for (const candidate of await recentWrittenPaths()) paths.add(candidate);
  for (const path of await globWorkspaceFiles(workspace)) paths.add(path);
  return [...paths].sort();
}

async function recentWrittenPaths(): Promise<string[]> {
  const candidates = await buildContextCandidates();
  return candidates.filter((candidate) => candidate.kind === 'path').map((candidate) => candidate.insert);
}

async function globWorkspaceFiles(workspace: string): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  const core = await loadTauriCore();
  if (!core) return [];
  const raw = await core.invoke<string>('glob_files', {
    workspace,
    pattern: `**/*${INDEXED_EXTENSIONS}`,
    path: null,
    maxResults: MAX_INDEX_FILES,
  });
  const text = String(raw ?? '');
  if (!text || text.startsWith('No files matching')) return [];
  return text
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter((line) => line && !NOISE_DIRS.some((dir) => line.includes(dir)));
}

// ── Matcher (pure side) ──

/** Path-ish runs of text. CJK is included: this project (and many of its
 *  users') files carry Chinese names, e.g. 改进进度记录.md. */
const TOKEN_RE = /[\w./@\-\u4e00-\u9fff]+/g;

/** Fenced code is quoted material, not an instruction. Rewriting a path inside
 *  it would edit the snippet the user is asking about. */
const FENCE_RE = /```[\s\S]*?```/g;

/** Sentence punctuation that HAPPENS to be in the token character class. */
const TRAILING_PUNCT = /[.:]+$/;

/**
 * "Create a new file at this path" intent. A path the user is about to CREATE
 * does not exist by definition, and the nearest existing path is by definition
 * NOT what they meant — rewriting "新建 src/ui/main2.ts" into the existing
 * main.ts would silently redirect a brand-new file onto an existing one. This
 * is the one case where a near match must be ignored rather than trusted.
 */
const CREATION_INTENT_RE = /(?:新建|创建|新增|另建|另建一个|建一个|新的?文件|create\s+(?:a\s+)?new|new\s+file|add\s+a\s+new\s+file)/i;

/** The clause a token sits in: the note has to judge intent from the sentence,
 *  not from the whole draft ("新建一个文件，另外改一下 src/ui/mian.ts" — the
 *  first half must not shield the second). */
function enclosingClause(text: string, start: number): string {
  const before = text.slice(Math.max(0, start - 60), start);
  const after = text.slice(start, start + 60);
  const cutter = /[。！？；\n，,]/;
  const head = before.split(cutter).pop() ?? '';
  const tail = after.split(cutter)[0] ?? '';
  return `${head}${tail}`;
}

function looksLikePath(token: string): boolean {
  if (token.length < 3 || token.length > 200) return false;
  // Absolute paths, URLs, globs and package scopes are out of scope: we cannot
  // tell a typo from a path that lives outside the workspace.
  if (token.includes('://') || token.startsWith('/') || token.startsWith('~') || token.startsWith('@')) return false;
  if (/[*?[\]{}<>|"']/.test(token)) return false;
  if (/\.[A-Za-z0-9]{1,8}$/.test(token)) return true;
  return token.includes('/') && /[A-Za-z0-9\u4e00-\u9fff]/.test(token);
}

/** How many characters may differ: tight enough that a real filename the user
 *  typed is never rewritten into a neighbour. */
function distanceLimit(token: string): number {
  if (token.length <= 6) return 1;
  if (token.length <= 14) return 2;
  return 3;
}

/** Levenshtein with an early exit once a whole row exceeds `limit`. */
function boundedDistance(a: string, b: string, limit: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

/** The single closest index path, or null when nothing (or more than one thing)
 *  is close enough to be certain. */
function nearestPath(token: string, paths: readonly string[]): string | null {
  const limit = distanceLimit(token);
  const lower = token.toLowerCase();
  let best: string | null = null;
  let bestDistance = limit + 1;
  for (const candidate of paths) {
    const haystack = candidate.toLowerCase();
    const distance = boundedDistance(lower, haystack, limit);
    if (distance > limit) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
      continue;
    }
    if (distance === bestDistance) best = null; // tie → ambiguous → leave it alone
  }
  return best;
}

function insideSpan(index: number, spans: Array<[number, number]>): boolean {
  return spans.some(([start, end]) => index >= start && index < end);
}

/**
 * Rewrite path tokens that are one slip away from a path that exists.
 *
 * Returns the text to send plus what changed; with no confident match the input
 * is returned untouched. Repeated occurrences are all corrected, and each
 * distinct slip is reported once (the note reads as a list of corrections, not
 * as a list of positions).
 */
export function correctWorkspacePaths(text: string, paths: readonly string[]): PathCorrection {
  if (!text || paths.length === 0) return { text, repairs: [] };
  const exact = new Set(paths);
  const fences: Array<[number, number]> = [...text.matchAll(FENCE_RE)]
    .map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as [number, number]);
  const memo = new Map<string, string | null>();
  const edits: Array<{ start: number; end: number; from: string; to: string }> = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0;
    const token = match[0].replace(TRAILING_PUNCT, '');
    if (!token || insideSpan(start, fences)) continue;
    if (exact.has(token)) continue;
    if (!looksLikePath(token)) continue;
    if (CREATION_INTENT_RE.test(enclosingClause(text, start))) continue;
    if (!memo.has(token)) memo.set(token, nearestPath(token, paths));
    const target = memo.get(token);
    if (!target) continue;
    edits.push({ start, end: start + token.length, from: token, to: target });
  }
  if (edits.length === 0) return { text, repairs: [] };
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.to + out.slice(edit.end);
  }
  const repairs: PathRepair[] = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    if (seen.has(edit.from)) continue;
    seen.add(edit.from);
    repairs.push({ from: edit.from, to: edit.to });
  }
  return { text: out, repairs };
}
