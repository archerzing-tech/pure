// src/evaluation/heldOutSets.ts
// P1-3 — held-out 题目装载（纯 IO 边界，无 LLM、无网络）。
//
// 为什么需要它：仓库里 v5 全套 15 个 fixture 连 golden 解都公开，角色 A/B 门
// 用的也是同一批 case。overlay 是在这批样本上起草、在这批样本上判 ALLOW 的——
// 「进化有效」这个结论没有任何样本外证据。held-out 就是留一批**从未参与起草
// 也从未参与判卷**的题目，只观测、不阻断，等数据攒够再议是否硬化成第二道门。
//
// 目录约定（本地、不进仓库 —— 题目本身是评测资产，公开即失去 held-out 性质）：
//   ~/.pure/evals-heldout/coding/*.json   CodingTaskFixture 形状（命令验证）
//   ~/.pure/evals-heldout/roles/<role>/*.json  RoleCaseFixture 形状（内容断言）
//
// **缺席不是错误**：目录不存在、没有 json、role 目录不存在——一律返回空数组。
// 仓库零新增文件依赖，CI 的 eval:sanity 完全不受影响（它连本模块都不 import）。

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CODING_TASK_CATEGORIES,
  CODING_TASK_DIFFICULTIES,
  type CodingTaskFixture,
} from './codingTaskBaseline';
import { isRoleCaseFixture, type RoleCaseFixture } from './roleRegression';

/** Expand a leading `~` the way every shell-ish config path in this repo does.
 *  Three call sites needed it; a fourth copy is how one of them ends up
 *  resolving `~/x` against the process cwd. */
export function expandHome(path: string): string {
  return resolve(path.replace(/^~(?=$|\/|\\)/, homedir()));
}

/** held-out 根目录。默认在用户主目录下（不进仓库）；PURE_EVAL_HELDOUT_DIR 覆盖。 */
export function heldOutRoot(): string {
  const override = process.env.PURE_EVAL_HELDOUT_DIR;
  if (override && override.trim()) return expandHome(override);
  return join(homedir(), '.pure', 'evals-heldout');
}

/** One fixture file that failed to parse, kept so callers can REPORT it rather
 *  than silently under-count (a held-out set that quietly drops half its cases
 *  would understate the very risk it exists to measure). */
export interface HeldOutLoadIssue {
  file: string;
  reason: string;
}

export interface HeldOutLoad<T> {
  fixtures: T[];
  issues: HeldOutLoadIssue[];
}

/** `readdir` failing because the path is not there is the normal "user hasn't
 *  built one yet" path — an empty set, not a failure. ENOENT covers a missing
 *  directory; ENOTDIR covers pointing --heldout-dir at a FILE, which is just
 *  as absent as far as this loader is concerned and must not become a crash in
 *  the middle of a verdict that has already been computed. Everything else
 *  (permissions, EIO) propagates so a real IO problem stays visible. */
async function readDirOrEmpty(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

async function loadJsonDir<T>(
  dir: string,
  label: string,
  isFixture: (value: unknown) => value is T,
): Promise<HeldOutLoad<T>> {
  const fixtures: T[] = [];
  const issues: HeldOutLoadIssue[] = [];
  for (const entry of await readDirOrEmpty(dir)) {
    const file = join(dir, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      issues.push({ file, reason: `JSON 解析失败: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (!isFixture(parsed)) {
      issues.push({ file, reason: `不是合法的 ${label} fixture（字段形状不符）` });
      continue;
    }
    fixtures.push(parsed);
  }
  return { fixtures, issues };
}

// ── coding held-out ──

const CATEGORIES = new Set<string>(CODING_TASK_CATEGORIES);
const DIFFICULTIES = new Set<string>(CODING_TASK_DIFFICULTIES);

function isVerificationCommand(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && typeof v.command === 'string' && Array.isArray(v.args) && v.args.every((a) => typeof a === 'string');
}

/** Shape check only — this loader does NOT reject an id that collides with the
 *  committed suite. Overlap is a property of the SET, not of one file, so the
 *  runners compare the whole loaded set against the gate and refuse a polluted
 *  run; doing it here would silently drop the very fixture a reader needs to
 *  see named in the error. */
export function isCodingTaskFixture(value: unknown): value is CodingTaskFixture {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id.trim()) return false;
  if (typeof v.category !== 'string' || !CATEGORIES.has(v.category)) return false;
  if (typeof v.difficulty !== 'string' || !DIFFICULTIES.has(v.difficulty)) return false;
  if (typeof v.prompt !== 'string' || !v.prompt.trim()) return false;
  if (!v.files || typeof v.files !== 'object' || Array.isArray(v.files)) return false;
  if (!Object.values(v.files as Record<string, unknown>).every((content) => typeof content === 'string')) return false;
  if (!Array.isArray(v.verification) || v.verification.length === 0) return false;
  return v.verification.every(isVerificationCommand);
}

/** Coding-task held-out fixtures. Absent directory ⇒ empty. */
export async function loadHeldOutCodingTasks(root = heldOutRoot()): Promise<HeldOutLoad<CodingTaskFixture>> {
  return loadJsonDir(join(root, 'coding'), 'coding task', isCodingTaskFixture);
}

// ── role held-out ──

/** Role-case held-out fixtures for one role. Absent role directory ⇒ empty.
 *  Shape comes from roleRegression's single definition (see the note there). */
export async function loadHeldOutRoleCases(role: string, root = heldOutRoot()): Promise<HeldOutLoad<RoleCaseFixture>> {
  if (!role.trim()) return { fixtures: [], issues: [] };
  return loadJsonDir(join(root, 'roles', role), 'role case', isRoleCaseFixture);
}

/** One-line human note for the report header, so a reader can tell an empty
 *  held-out set ("nobody has authored any") from a broken one ("3 files were
 *  unreadable"). Absent → says absent; issues → says how many were dropped. */
export function describeHeldOut(label: string, loaded: HeldOutLoad<unknown>): string {
  if (loaded.issues.length > 0) {
    return `${label}: ${loaded.fixtures.length} 份可用，${loaded.issues.length} 份被丢弃`;
  }
  if (loaded.fixtures.length === 0) return `${label}: 无（目录不存在或为空）`;
  return `${label}: ${loaded.fixtures.length} 份`;
}
