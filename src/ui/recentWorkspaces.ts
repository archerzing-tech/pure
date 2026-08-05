// src/ui/recentWorkspaces.ts
// Independent persistence for the workspace picker's "Recent" list — separate
// from session records so the list survives even if every session is deleted.
// Each entry tracks whether it is pinned (pinned entries never get evicted and
// always sort above unpinned ones) and its last-used timestamp (MRU order).

export interface RecentWorkspace {
  path: string;
  pinned: boolean;
  lastUsedAt: number;
}

const RECENT_KEY = 'pure_recent_workspaces';
const MAX_UNPINNED = 8;

function readRaw(): RecentWorkspace[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is RecentWorkspace =>
      !!r && typeof r.path === 'string' && r.path.length > 0);
  } catch {
    return [];
  }
}

function writeRaw(items: RecentWorkspace[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(items));
  } catch { /* ignore */ }
}

/** MRU order; pinned entries always first (by recency within the pinned set). */
export function loadRecentWorkspaces(): RecentWorkspace[] {
  const items = readRaw();
  const pinned = items.filter(i => i.pinned).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  const unpinned = items.filter(i => !i.pinned).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  return [...pinned, ...unpinned];
}

/**
 * Record a workspace use: bump its recency (or add it), then evict the least
 * recently used unpinned entries beyond the cap. Pinned entries are never
 * evicted.
 */
export function touchRecentWorkspace(path: string): void {
  if (!path) return;
  const items = readRaw();
  const existing = items.find(i => i.path === path);
  if (existing) {
    existing.lastUsedAt = Date.now();
  } else {
    items.push({ path, pinned: false, lastUsedAt: Date.now() });
  }
  const pinned = items.filter(i => i.pinned);
  const unpinned = items.filter(i => !i.pinned)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_UNPINNED);
  writeRaw([...pinned, ...unpinned]);
}

/** Toggle a path's pinned flag (no-op if the path isn't in the list). */
export function setRecentPinned(path: string, pinned: boolean): void {
  const items = readRaw();
  const item = items.find(i => i.path === path);
  if (!item) return;
  item.pinned = pinned;
  item.lastUsedAt = Date.now();
  writeRaw(items);
}

/** Remove a path from the recent list entirely (pinned or not). */
export function removeRecentWorkspace(path: string): void {
  writeRaw(readRaw().filter(i => i.path !== path));
}
