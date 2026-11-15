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

/** Version marker in the product default template. Metadata: stripped before
 * merging and never shown to the model. Bumping it is what tells an existing
 * `~/.pure/AGENTS.md` that a newer default exists. */
const DEFAULT_VERSION_MARKER = /^\s*<!--\s*pure:default\s+version=(\d+)\s*-->\s*$/i;

export function defaultVersionOf(text: string | null | undefined): number {
  if (!text) return 0;
  for (const line of text.split(/\r?\n/)) {
    const m = DEFAULT_VERSION_MARKER.exec(line);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Drop version-marker lines from a conventions text. */
export function stripDefaultMarkers(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .split(/\r?\n/)
    .filter((line) => !DEFAULT_VERSION_MARKER.test(line))
    .join('\n');
}

export type SectionMergeMode = 'override' | 'append';

/** Per-section merge directive: a line IMMEDIATELY above the heading makes the
 * child layer ADD to the parent section instead of replacing it. Written as an
 * HTML comment so it is invisible in rendered markdown.
 *    <!-- merge: append -->
 *    ## 语言
 * Without it a child section replaces the parent one (the default). */
const APPEND_DIRECTIVE = /^<!--\s*(?:pure:)?merge:\s*append\s*-->\s*$/i;

export interface ConventionsOverride {
  /** Normalized section key (heading text). */
  section: string;
  from: ConventionsLayerName;
  by: ConventionsLayerName;
  /** `override` replaced the parent body; `append` kept it and added to it. */
  mode: SectionMergeMode;
  /** Chars of the parent body this layer replaced (override only). */
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
 * A leading block before the first heading uses the empty key. `mode` is the
 * per-section merge mode declared by an `<!-- merge: append -->` directive. */
export function splitSections(
  text: string,
): { key: string; body: string; mode: SectionMergeMode }[] {
  const lines = text.split(/\r?\n/);
  const out: { key: string; body: string; mode: SectionMergeMode }[] = [];
  let key = '';
  let mode: SectionMergeMode = 'override';
  let buf: string[] = [];
  const flush = () => {
    if (buf.length > 0) {
      out.push({ key, body: buf.join('\n').trim(), mode });
      buf = [];
    }
  };
  for (const line of lines) {
    const m = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (m) {
      // The directive binds to the heading directly below it: scan back past
      // blank lines, and drop the directive line so it never reaches the model.
      let nextMode: SectionMergeMode = 'override';
      for (let i = buf.length - 1; i >= 0; i--) {
        if (!buf[i].trim()) continue;
        if (APPEND_DIRECTIVE.test(buf[i].trim())) {
          nextMode = 'append';
          buf.splice(i, 1);
        }
        break;
      }
      flush();
      key = sectionKey(m[1]);
      mode = nextMode;
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** Drop a body's leading heading line — appended content keeps the parent's
 * heading, so the child's copy of it would otherwise print twice. */
function bodyWithoutHeading(body: string): string {
  return body.replace(/^#{1,6}[^\n]*\n?/, '').trim();
}

interface MergeInput {
  name: ConventionsLayerName;
  source: string;
  text: string | null;
}

function layerReport(layer: MergeInput): ConventionsLayerReport {
  const text = stripDefaultMarkers(layer.text).trim();
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
    const text = stripDefaultMarkers(layer.text).trim();
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
      const appending = section.mode === 'append';
      overrides.push({
        section: section.key || '(前言)',
        from: prev.by,
        by: layer.name,
        mode: appending ? 'append' : 'override',
        replacedChars: appending ? 0 : prev.body.length,
      });
      kept[at] = {
        key: section.key,
        body: appending ? `${prev.body}\n\n${bodyWithoutHeading(body)}` : body,
        by: layer.name,
      };
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

/** What was last written into the user's global file, per section. Lets an
 * upgrade tell "this section is still our text" from "the user rewrote it". */
export interface SeedState {
  version: number;
  sections: Record<string, string>;
}

export interface SeedUpgradeResult {
  text: string;
  version: number;
  /** Sections replaced by the newer default (user had not touched them). */
  adopted: string[];
  /** Sections the user file did not have (safe, purely additive). */
  added: string[];
  /** Sections left exactly as the user wrote them. */
  kept: string[];
  state: SeedState;
}

export function parseSeedState(raw: string | null | undefined): SeedState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SeedState>;
    if (!parsed || typeof parsed !== 'object') return null;
    const sections: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.sections ?? {})) {
      if (typeof v === 'string') sections[k] = v;
    }
    return { version: Number(parsed.version) || 0, sections };
  } catch {
    return null;
  }
}

/** Move an existing seeded global file toward a newer product default without
 * ever clobbering user edits: sections the user rewrote are left alone,
 * sections still byte-identical to what we last seeded are updated, and
 * sections the file is missing are appended. Pure — no I/O. */
export function upgradeSeededAgentsMd(
  userText: string,
  defaultsText: string,
  state: SeedState | null,
): SeedUpgradeResult {
  const defaults = splitSections(stripDefaultMarkers(defaultsText));
  const version = defaultVersionOf(defaultsText);
  const userSections = splitSections(userText).filter((s) => s.body.length > 0);
  const byKey = new Map(userSections.map((s, i) => [s.key, i]));
  const nextState: SeedState = { version, sections: {} };
  const adopted: string[] = [];
  const added: string[] = [];
  const kept: string[] = [];
  const bodies = userSections.map((s) => s.body);

  for (const def of defaults) {
    const label = def.key || '(前言)';
    const at = byKey.get(def.key);
    if (at === undefined) {
      // Missing in the user file: appending is safe either way.
      if (def.body.trim()) {
        bodies.push(def.body.trim());
        byKey.set(def.key, bodies.length - 1);
        added.push(label);
        nextState.sections[def.key] = def.body.trim();
      }
      continue;
    }
    const current = bodies[at];
    const untouched = state ? state.sections[def.key] === current : false;
    if (untouched) {
      bodies[at] = def.body.trim();
      adopted.push(label);
      nextState.sections[def.key] = def.body.trim();
    } else {
      kept.push(label);
      // Baseline becomes what the user actually has: from now on an upgrade
      // only fires when the user leaves that text alone.
      nextState.sections[def.key] = current;
    }
  }
  // Sections the user added that the default does not define: keep their
  // baseline entries so a later default can note them as user-owned.
  for (const [key, body] of Object.entries(state?.sections ?? {})) {
    if (!(key in nextState.sections)) nextState.sections[key] = body;
  }

  return {
    text: bodies.filter((b) => b.length > 0).join('\n\n'),
    version,
    adopted,
    added,
    kept,
    state: nextState,
  };
}

/** Node-only: seed or upgrade <root>/AGENTS.md from the product default,
 * keeping `<root>/AGENTS.default.json` as the "what we last wrote" baseline.
 * Returns a one-line summary when anything changed, null otherwise. */
export async function syncSeededAgentsMd(
  root: string | null | undefined,
  defaultsText: string | null | undefined,
): Promise<string | null> {
  if (!root || !defaultsText?.trim()) return null;
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    const mdPath = path.join(root, 'AGENTS.md');
    const statePath = path.join(root, 'AGENTS.default.json');
    const rawState = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
    const state = parseSeedState(rawState);
    const current = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : null;

    if (current === null) {
      const seeded = stripDefaultMarkers(defaultsText).trim();
      const seededState: SeedState = {
        version: defaultVersionOf(defaultsText),
        sections: Object.fromEntries(splitSections(seeded).map((s) => [s.key, s.body.trim()])),
      };
      fs.writeFileSync(mdPath, `${seeded}\n`, 'utf8');
      fs.writeFileSync(statePath, `${JSON.stringify(seededState, null, 2)}\n`, 'utf8');
      return '已写入默认约定 (~/.pure/AGENTS.md)';
    }

    const result = upgradeSeededAgentsMd(current, defaultsText, state);
    const nextStateJson = `${JSON.stringify(result.state, null, 2)}\n`;
    let changed = false;
    if (result.text.trim() !== current.trim()) {
      fs.writeFileSync(mdPath, `${result.text.trim()}\n`, 'utf8');
      changed = true;
    }
    if (rawState !== nextStateJson) {
      fs.writeFileSync(statePath, nextStateJson, 'utf8');
      changed = true;
    }
    if (!changed) return null;
    const parts = [
      result.added.length ? `新增 ${result.added.length} 节` : '',
      result.adopted.length ? `采纳新版 ${result.adopted.length} 节` : '',
      result.kept.length ? `保留你的改动 ${result.kept.length} 节` : '',
    ].filter(Boolean);
    return `默认约定已更新到 v${result.version}：${parts.join('，') || '无变化'}`;
  } catch {
    return null;
  }
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
      const effect = o.mode === 'append' ? '追加' : `-${o.replacedChars} 字符`;
      lines.push(`    「${o.section}」  ${o.from} → ${o.by}  （${effect}）`);
    }
  }
  if (d.appends.length > 0) {
    lines.push('  新增（仅子层定义）：');
    for (const a of d.appends) lines.push(`    「${a.section}」  by ${a.by}`);
  }
  return lines.join('\n');
}
