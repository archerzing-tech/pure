// src/shared/conventions.ts
// Two-layer AGENTS.md loading for Pure.
//
//   - Application-level AGENTS.md: ships with the Pure app at the application
//     space root; it is the default convention baseline.
//   - User-level AGENTS.md: lives in the user's workspace; OPTIONAL (may not
//     exist).
//
// Merge rule (override + inherit): for the SAME constraint (a section sharing
// the same heading) the USER level OVERRIDES the app level ("black over white");
// constraints present in only one layer are inherited as-is. Sections unique to
// either layer are kept.
//
// File I/O is kept out of the pure surface so this module can be imported by the
// renderer. The node loader uses a dynamic import, so the module is safe to
// bundle for the browser (and is never invoked there).

export interface ConventionsRoots {
  /** Application space root — where the default AGENTS.md ships. */
  appSpaceRoot?: string | null;
  /** Global user root — `~/.pure`, holding an OPTIONAL, user-editable
   * AGENTS.md that seeds from the app default on first run and overrides the
   * app layer (but is itself overridden by the workspace layer). */
  globalUserRoot?: string | null;
  /** User workspace root — may or may not contain an AGENTS.md. */
  userSpaceRoot?: string | null;
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
      key = m[1].trim().toLowerCase();
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** Merge app-level (default) and user-level conventions with override semantics.
 * `null`/empty inputs are tolerated; passing only one layer returns it as-is. */
export function mergeConventions(appText: string | null, userText: string | null): string {
  if (!appText && !userText) return '';
  if (!userText) return (appText ?? '').trim();
  if (!appText) return (userText ?? '').trim();
  const app = splitSections(appText);
  const user = splitSections(userText);
  const userByKey = new Map(user.map((s) => [s.key, s]));
  const out: string[] = [];
  for (const s of app) {
    const override = userByKey.get(s.key);
    out.push((override ?? s).body);
  }
  for (const s of user) {
    if (!app.some((a) => a.key === s.key)) out.push(s.body);
  }
  return out.filter((b) => b.length > 0).join('\n\n');
}

async function readAgentsMdNode(root: string | null | undefined): Promise<string | null> {
  if (!root) return null;
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const p = path.join(root, 'AGENTS.md');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch {
    /* ignore an unreadable layer */
  }
  return null;
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
 * disk. Browser/renderer callers should read the files via their own mechanism
 * and pass the merged text directly. Merge precedence (override + inherit):
 * workspace > global-user (`~/.pure`) > app. */
export async function loadMergedConventions(roots: ConventionsRoots = {}): Promise<string> {
  const app = await readAgentsMdNode(roots.appSpaceRoot ?? getAppSpaceRoot());
  const global = roots.globalUserRoot ? await readAgentsMdNode(roots.globalUserRoot) : null;
  const user = await readAgentsMdNode(roots.userSpaceRoot);
  const appPlusGlobal = mergeConventions(app, global);
  return mergeConventions(appPlusGlobal || null, user);
}
