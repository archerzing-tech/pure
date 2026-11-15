// src/shared/conventions.ts
// Three-layer AGENTS.md loading for Pure.
//   - app layer: the product default shipped with the app
//     (templates/default-agents.md → DEFAULT_AGENTS_MD); it is the baseline.
//   - global layer: `~/.pure/AGENTS.md`, seeded from the app default on first
//     run, user-editable, overrides the app layer.
//   - workspace layer: <workspace>/AGENTS.md, OPTIONAL (may not exist);
//     overrides both.
// Merge rule (override + inherit): for the SAME constraint (a section sharing
// the same normalized heading) the CHILD level OVERRIDES the parent ("black
// over white"); constraints present in only one layer are inherited as-is.
// Sections unique to either layer are kept.
// Every merge can report what happened (which layer a section came from, which
// section a child layer replaced) — see loadMergedConventionsWithDiagnostics.
// File I/O is kept out of the pure surface so this module can be imported by the
// renderer. The node loader uses a dynamic import, so the module is safe to
// bundle for the browser (and is never invoked there).

import { DEFAULT_AGENTS_MD } from './defaultAgentsMd';

export interface ConventionsRoots {
  /** Application space root — where the default AGENTS.md ships. When omitted,
   * the app layer is the baked DEFAULT_AGENTS_MD (never the current directory:
   * this repo's own AGENTS.md is dev conventions, not the product default). */
  appSpaceRoot?: string | null;
  /** Explicit app-layer text; wins over both appSpaceRoot and the baked
   * default. Pass null to disable the app layer entirely. */
  appText?: string | null;
  /** Global user root — `~/.pure`, holding an OPTIONAL, user-editable
   * AGENTS.md that seeds from the app default on first run and overrides the
   * app layer (but is itself overridden by the workspace layer). */
  globalUserRoot?: string | null;
  /** User workspace root — may or may not contain an AGENTS.md. */
  userSpaceRoot?: string | null;
}

export type ConventionsLayerName = 'app' | 'global' | 'workspace';

export interface ConventionsLayerReport {
  name: ConventionsLayerName;
  /** Where the layer was read from, or a marker describing why it is absent. */
  source: string;
  present: boolean;
  sections: string[];
  chars: number;
}

export interface ConventionsOverride {
  /** Normalized section key (heading text). */
  section: string;
  from: ConventionsLayerName;
  by: ConventionsLayerName;
  replacedChars: number;
}

export interface ConventionsAppend {
  section: string;
  by: ConventionsLayerName;
}

export interface ConventionsDiagnostics {
  layers: ConventionsLayerReport[];
  /** Child layers replacing a section an earlier layer already defined. */
  overrides: ConventionsOverride[];
  /** Sections only a child layer defines. */
  appends: ConventionsAppend[];
  mergedChars: number;
  mergedSections: number;
}

export interface MergedConventions {
  text: string;
  diagnostics: ConventionsDiagnostics;
}

let appSpaceRootOverride: string | null = null;

/** Override the application-space root (e.g. Tauri resourceDir at app bootstrap).
 * When unset, getAppSpaceRoot() falls back to process.cwd(). */
export function setAppSpaceRoot(root: string | null): void {
  appSpaceRootOverride = root ?? null;
}

export function getAppSpaceRoot(): string {
  return appSpaceRootOverride ?? process.cwd();
}

/** Normalize a heading into a merge key. Numbering, case, trailing
 * punctuation and inner whitespace are ignored so `## 1. 语言`,
 * `## 语言` and `## 语言：` are the SAME constraint — otherwise renumbering
 * a section silently turns an override into a duplicate.
 * Kept CJK-safe: only ASCII casefold, letters/digits are never stripped. */
export function sectionKey(heading: string): string {
  return heading
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*(?:\d+(?:\.\d+)*[.、)]?|[（(]\d+[)）]|[一二三四五六七八九十]+[、.])\s*/u, '')
    .replace(/[\s:：.。,，;；]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Split a markdown conventions doc into ordered sections keyed by heading text.
 * A leading block before the first heading uses the empty key. */
export function splitSections(text: string): { key: string; body: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { key: string; body: string }[] = [];
  let key = '';
  let buf: string[] = [];
  const flush = () => {
    if (buf.length > 0) {
      out.push({ key, body: buf.join('\n').trim() });
      buf = [];
    }
  };
  for (const line of lines) {
    const m = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (m) {
      flush();
      key = sectionKey(m[1]);
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

interface MergeInput {
  name: ConventionsLayerName;
  source: string;
  text: string | null;
}

function layerReport(layer: MergeInput): ConventionsLayerReport {
  const text = (layer.text ?? '').trim();
  return {
    name: layer.name,
    source: layer.source,
    present: text.length > 0,
    sections: text ? splitSections(text).map((s) => s.key || '(前言)') : [],
    chars: text.length,
  };
}

/** Fold layers parent → child with section-level override, collecting what
 * happened along the way. Exported for tests and for `agents:show`. */
export function mergeLayers(layers: MergeInput[]): MergedConventions {
  const kept: { key: string; body: string; by: ConventionsLayerName }[] = [];
  const index = new Map<string, number>();
  const overrides: ConventionsOverride[] = [];
  const appends: ConventionsAppend[] = [];
  // The first layer that exists defines the baseline: its sections are not
  // "added by a child", so they stay out of the appends report.
  let seenLayer = false;
  for (const layer of layers) {
    const text = (layer.text ?? '').trim();
    if (!text) continue;
    const isChild = seenLayer;
    seenLayer = true;
    for (const section of splitSections(text)) {
      const body = section.body;
      const at = index.get(section.key);
      if (at === undefined) {
        if (isChild && section.key) appends.push({ section: section.key, by: layer.name });
        index.set(section.key, kept.length);
        kept.push({ key: section.key, body, by: layer.name });
        continue;
      }
      const prev = kept[at];
      overrides.push({
        section: section.key || '(前言)',
        from: prev.by,
        by: layer.name,
        replacedChars: prev.body.length,
      });
      kept[at] = { key: section.key, body, by: layer.name };
    }
  }
  const text = kept
    .map((s) => s.body)
    .filter((b) => b.length > 0)
    .join('\n\n');
  return {
    text,
    diagnostics: {
      layers: layers.map(layerReport),
      overrides,
      appends,
      mergedChars: text.length,
      mergedSections: kept.length,
    },
  };
}

/** Merge app-level (default) and user-level conventions with override semantics.
 * `null`/empty inputs are tolerated; passing only one layer returns it as-is. */
export function mergeConventions(appText: string | null, userText: string | null): string {
  return mergeLayers([
    { name: 'app', source: 'app', text: appText },
    { name: 'workspace', source: 'workspace', text: userText },
  ]).text;
}

/** Convention filename precedence within one layer: AGENTS.md is the open
 *  standard (60k+ projects); CLAUDE.md is the Claude Code dialect honored as
 *  a fallback so projects from that ecosystem load with zero migration.
 *  Same layer never reads both — AGENTS.md wins, no double-source conflicts.
 *  Seeding always targets AGENTS.md (the canonical name) regardless. */
const CONVENTION_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

/** Node-only: read the first convention file that exists in `root`, and say
 *  which name won. Returns null when the layer is missing. */
async function readLayerFile(
  root: string | null | undefined,
): Promise<{ text: string; file: string; path: string } | null> {
  if (!root) return null;
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const name of CONVENTION_FILENAMES) {
      const p = path.join(root, name);
      if (fs.existsSync(p)) return { text: fs.readFileSync(p, 'utf8').trim(), file: name, path: p };
    }
  } catch {
    /* ignore an unreadable layer */
  }
  return null;
}

async function readAgentsMdNode(root: string | null | undefined): Promise<string | null> {
  return (await readLayerFile(root))?.text ?? null;
}

/** Node-only: read <root>/AGENTS.md (exported for callers that seed the
 * global user layer from the app default). Returns null when missing. */
export const readAgentsMdAt = readAgentsMdNode;

/** Node-only: ensure <root>/AGENTS.md exists, seeding it from `content` when
 * missing. Best-effort; never overwrites an existing user file. */
export async function ensureAgentsMdAt(
  root: string | null | undefined,
  content?: string | null,
): Promise<void> {
  if (!root) return;
  if (!content || !content.trim()) return;
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    const p = path.join(root, 'AGENTS.md');
    if (!fs.existsSync(p)) fs.writeFileSync(p, content.trim() + '\n', 'utf8');
  } catch {
    /* ignore — seeding is best-effort */
  }
}

/** Node-only: load + merge the app, global-user, and workspace layers from
 * disk, together with the merge report (layer sources, overridden sections,
 * sections a child layer added). Browser/renderer callers should read the
 * files via their own mechanism and pass the merged text directly.
 * Merge precedence (override + inherit): workspace > global-user
 * (`~/.pure`) > app. */
export async function loadMergedConventionsWithDiagnostics(
  roots: ConventionsRoots = {},
): Promise<MergedConventions> {
  const appFolder = roots.appSpaceRoot ?? null;
  const appFile = appFolder ? await readLayerFile(appFolder) : null;
  const appText =
    roots.appText !== undefined
      ? roots.appText
      : appFile
        ? appFile.text
        : DEFAULT_AGENTS_MD;
  const appSource = appFile && roots.appText === undefined
    ? appFile.path
    : '内置默认 (templates/default-agents.md)';
  const globalFile = await readLayerFile(roots.globalUserRoot);
  const userFile = await readLayerFile(roots.userSpaceRoot);
  return mergeLayers([
    { name: 'app', source: appSource, text: appText },
    {
      name: 'global',
      source: roots.globalUserRoot
        ? `${roots.globalUserRoot}${globalFile ? `/${globalFile.file}` : ' (缺失)'}`
        : '(未配置)',
      text: globalFile?.text ?? null,
    },
    {
      name: 'workspace',
      source: roots.userSpaceRoot
        ? `${roots.userSpaceRoot}${userFile ? `/${userFile.file}` : ' (缺失)'}`
        : '(未配置)',
      text: userFile?.text ?? null,
    },
  ]);
}

/** Node-only: merged conventions text only (no report). */
export async function loadMergedConventions(roots: ConventionsRoots = {}): Promise<string> {
  return (await loadMergedConventionsWithDiagnostics(roots)).text;
}

/** Human-readable merge report for `bun run agents:show` / in-session debug. */
export function formatConventionsDiagnostics(d: ConventionsDiagnostics): string {
  const layerName: Record<ConventionsLayerName, string> = {
    app: 'app',
    global: 'global',
    workspace: 'workspace',
  };
  const lines: string[] = [
    `AGENTS.md 合并结果：${d.mergedSections} 节 / ${d.mergedChars} 字符`,
  ];
  for (const l of d.layers) {
    const count = l.present ? `${l.sections.length} 节 / ${l.chars} 字符` : '缺失';
    lines.push(`  ${layerName[l.name].padEnd(9)} ${l.source}  —  ${count}`);
  }
  if (d.overrides.length === 0) {
    lines.push('  覆盖：无');
  } else {
    lines.push('  覆盖（子层替换父层同名节）：');
    for (const o of d.overrides) {
      lines.push(`    「${o.section}」  ${o.from} → ${o.by}  （-${o.replacedChars} 字符）`);
    }
  }
  if (d.appends.length > 0) {
    lines.push('  新增（仅子层定义）：');
    for (const a of d.appends) lines.push(`    「${a.section}」  by ${a.by}`);
  }
  return lines.join('\n');
}
