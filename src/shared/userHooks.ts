// src/shared/userHooks.ts
// User-configurable lifecycle hooks (`hooks.json`), the user-facing sibling of
// the engine's internal HookRouter.
//
// Three layers, same roots as AGENTS.md (see conventions.ts):
//   - app space root: hooks shipped with Pure (none by default);
//   - global user root (`~/.pure`): the user's personal hooks;
//   - workspace root: hooks scoped to the project.
//
// Merge rule differs from AGENTS.md text: commands are not "overridden" by a
// more specific layer — every layer's hooks RUN, in order app → global →
// workspace, so the most specific hooks fire last, closest to the action.
// Identical (command + matcher) pairs are deduplicated so a seeded default and
// a hand-copied entry never double-run.
//
// File I/O is kept behind dynamic imports so this module can be imported by the
// renderer (the loader is never invoked there), mirroring conventions.ts.

export const USER_HOOK_EVENTS = ['on_pre_tool', 'on_post_tool', 'on_turn_complete'] as const;

export type UserHookEvent = (typeof USER_HOOK_EVENTS)[number];

export interface UserHook {
  /** Shell command string; executed by the hook runner (with timeout and the
   * usual permission gate), never evaluated by the model. */
  command: string;
  /** Optional tool-name filter for on_pre_tool/on_post_tool. Exact name, or a
   * trailing `*` as prefix wildcard. Ignored for on_turn_complete. */
  matcher?: string;
  /** Per-hook timeout in ms. Non-positive or non-finite values are dropped;
   * the runner clamps this to its own ceiling. */
  timeoutMs?: number;
}

export type UserHooksConfig = Partial<Record<UserHookEvent, UserHook[]>>;

/** Per-event cap so a runaway hooks.json cannot grow without bound. */
const MAX_HOOKS_PER_EVENT = 64;

/** Parse a hooks.json document. Lenient by design: anything malformed is
 * dropped, never thrown — a broken config must not take the app down. */
export function parseUserHooks(text: string | null | undefined): UserHooksConfig {
  if (!text || !text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: UserHooksConfig = {};
  for (const event of USER_HOOK_EVENTS) {
    const raw = (parsed as Record<string, unknown>)[event];
    if (!Array.isArray(raw)) continue;
    const hooks: UserHook[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.command !== 'string' || !record.command.trim()) continue;
      const hook: UserHook = { command: record.command };
      if (typeof record.matcher === 'string' && record.matcher.trim()) hook.matcher = record.matcher;
      if (typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs) && record.timeoutMs > 0) {
        hook.timeoutMs = record.timeoutMs;
      }
      hooks.push(hook);
      if (hooks.length >= MAX_HOOKS_PER_EVENT) break;
    }
    if (hooks.length > 0) out[event] = hooks;
  }
  return out;
}

function hookKey(hook: UserHook): string {
  return JSON.stringify([hook.command, hook.matcher ?? null]);
}

/** Concatenate hook layers in run order (app → global → workspace), dropping
 * exact (command + matcher) duplicates. `null`/empty layers are tolerated. */
export function mergeUserHooks(...layers: (UserHooksConfig | null | undefined)[]): UserHooksConfig {
  const out: UserHooksConfig = {};
  for (const event of USER_HOOK_EVENTS) {
    const seen = new Set<string>();
    const hooks: UserHook[] = [];
    for (const layer of layers) {
      for (const hook of layer?.[event] ?? []) {
        const key = hookKey(hook);
        if (seen.has(key)) continue;
        seen.add(key);
        hooks.push(hook);
      }
    }
    if (hooks.length > 0) out[event] = hooks;
  }
  return out;
}

async function readHooksJsonNode(root: string | null | undefined): Promise<string | null> {
  if (!root) return null;
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const p = path.join(root, 'hooks.json');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch {
    /* ignore an unreadable layer */
  }
  return null;
}

/** Node-only: load + merge hooks.json from the app, global-user, and workspace
 * layers (same roots as loadMergedConventions). Missing or broken layers are
 * tolerated. Run order: app → global-user → workspace. */
export async function loadUserHooks(roots: {
  appSpaceRoot?: string | null;
  globalUserRoot?: string | null;
  userSpaceRoot?: string | null;
} = {}): Promise<UserHooksConfig> {
  const layers: UserHooksConfig[] = [];
  for (const root of [roots.appSpaceRoot ?? null, roots.globalUserRoot ?? null, roots.userSpaceRoot ?? null]) {
    layers.push(parseUserHooks(await readHooksJsonNode(root)));
  }
  return mergeUserHooks(...layers);
}
