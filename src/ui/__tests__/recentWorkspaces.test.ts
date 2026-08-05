// src/ui/__tests__/recentWorkspaces.test.ts
// Covers the independent recent-workspaces store (pin + MRU + eviction).

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  loadRecentWorkspaces,
  touchRecentWorkspace,
  setRecentPinned,
  removeRecentWorkspace,
} from '../recentWorkspaces';

// bun:test has no DOM — provide a minimal in-memory localStorage stub so the
// module's storage calls work in the test runtime.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, value); }
}

// MRU ordering relies on lastUsedAt (ms resolution); several touch calls in
// one synchronous block would share the same millisecond and tie the sort.
// Stub Date.now() with a monotonic counter so ordering is deterministic.
let clock = 1000;
const realNow = Date.now;

beforeEach(() => {
  (globalThis as any).localStorage = new MemoryStorage();
  clock = 1000;
  Date.now = () => ++clock;
});

afterEach(() => {
  Date.now = realNow;
});

describe('recentWorkspaces', () => {
  it('records usage and returns most-recently-used first', () => {
    touchRecentWorkspace('/a');
    touchRecentWorkspace('/b');
    touchRecentWorkspace('/c');
    expect(loadRecentWorkspaces().map(r => r.path)).toEqual(['/c', '/b', '/a']);
  });

  it('bumping an existing path moves it to the front (MRU)', () => {
    touchRecentWorkspace('/a');
    touchRecentWorkspace('/b');
    touchRecentWorkspace('/a');
    expect(loadRecentWorkspaces().map(r => r.path)).toEqual(['/a', '/b']);
  });

  it('pinned entries always sort above unpinned ones', () => {
    touchRecentWorkspace('/new');
    touchRecentWorkspace('/pinned-old');
    setRecentPinned('/pinned-old', true);
    // A newer unpinned entry must still sort below the older pinned one.
    const list = loadRecentWorkspaces();
    expect(list[0].path).toBe('/pinned-old');
    expect(list[0].pinned).toBe(true);
    expect(list[1].path).toBe('/new');
  });

  it('unpinned entries beyond the cap are evicted, pinned ones are kept', () => {
    touchRecentWorkspace('/keep');
    setRecentPinned('/keep', true);
    for (let i = 0; i < 20; i++) touchRecentWorkspace(`/p${i}`);
    const list = loadRecentWorkspaces();
    expect(list.some(r => r.path === '/keep')).toBe(true);
    expect(list.filter(r => r.path.startsWith('/p')).length).toBeLessThanOrEqual(8);
  });

  it('pinning survives a later touch (recency bump does not unpin)', () => {
    touchRecentWorkspace('/a');
    setRecentPinned('/a', true);
    touchRecentWorkspace('/b');
    const item = loadRecentWorkspaces().find(r => r.path === '/a');
    expect(item?.pinned).toBe(true);
  });

  it('unpins cleanly', () => {
    touchRecentWorkspace('/a');
    setRecentPinned('/a', true);
    setRecentPinned('/a', false);
    const list = loadRecentWorkspaces();
    expect(list[0].pinned).toBe(false);
  });

  it('removes a path entirely', () => {
    touchRecentWorkspace('/a');
    touchRecentWorkspace('/b');
    removeRecentWorkspace('/a');
    expect(loadRecentWorkspaces().map(r => r.path)).toEqual(['/b']);
  });

  it('ignores empty paths', () => {
    touchRecentWorkspace('');
    expect(loadRecentWorkspaces()).toEqual([]);
  });
});
