// src/adapter/memory/__tests__/FSMemoryStore.test.ts
// v0.10 — FSMemoryStore (Adapter Layer 设计文档 §12): per-project JSONL
// persistence + keyword search + session forget + time decay.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FSMemoryStore } from '../FSMemoryStore';
import { tokenize, searchMemories } from '../keywordSearch';
import type { MemoryEntry } from '../IMemoryStore';
import { GLOBAL_MEMORY_SCOPE } from '../../../shared/types';

let root: string;
let store: FSMemoryStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pure-mem-'));
  store = new FSMemoryStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const base = (over: Partial<Omit<MemoryEntry, 'id'>> = {}) => ({
  type: 'user_preference' as const,
  content: 'User prefers the TypeScript language',
  timestamp: Date.now(),
  sessionId: 's1',
  projectPath: '/proj/a',
  ...over,
});

describe('FSMemoryStore.add', () => {
  it('assigns an id and persists to the project-hashed jsonl', async () => {
    const id = await store.add(base());
    expect(id).toBeTruthy();
    // File must exist under root/{hash}/memories.jsonl
    const dirs = await import('node:fs').then(f => f.readdirSync(root));
    expect(dirs).toHaveLength(1);
    const file = join(root, dirs[0], 'memories.jsonl');
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe(id);
    expect(parsed.projectPath).toBe('/proj/a');
  });

  it('dedupes identical type+content within the same project', async () => {
    const id1 = await store.add(base());
    const id2 = await store.add(base());
    expect(id2).toBe(id1);
  });

  it('isolates identical content across different projects', async () => {
    const idA = await store.add(base({ projectPath: '/proj/a' }));
    const idB = await store.add(base({ projectPath: '/proj/b' }));
    expect(idB).not.toBe(idA);
  });
});

describe('FSMemoryStore.search', () => {
  beforeEach(async () => {
    await store.add(base({ content: 'User prefers the TypeScript language' }));
    await store.add(base({ content: 'User prefers the pnpm tool', type: 'user_preference' }));
    await store.add(base({
      content: 'Error TS2307 fails — fixed by adding the missing import',
      type: 'error_pattern',
    }));
  });

  it('returns keyword-matching memories for the project, newest first', async () => {
    const hits = await store.search('TypeScript', { projectPath: '/proj/a' });
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain('TypeScript');
  });

  it('respects the k limit and type filter', async () => {
    const all = await store.search('prefers the', { projectPath: '/proj/a', k: 10 });
    expect(all.length).toBeGreaterThanOrEqual(3);
    const errors = await store.search('fails', { projectPath: '/proj/a', type: 'error_pattern' });
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('error_pattern');
    const limited = await store.search('prefers the', { projectPath: '/proj/a', k: 2 });
    expect(limited.length).toBe(2);
  });

  it('does not cross project isolation boundaries', async () => {
    await store.add(base({ content: 'Project B secret', projectPath: '/proj/b' }));
    const hits = await store.search('secret', { projectPath: '/proj/a' });
    expect(hits).toHaveLength(0);
    const hitsB = await store.search('secret', { projectPath: '/proj/b' });
    expect(hitsB).toHaveLength(1);
  });

  it('returns nothing for a query with no keyword overlap', async () => {
    const hits = await store.search('zzzznomatch', { projectPath: '/proj/a' });
    expect(hits).toHaveLength(0);
  });
});

describe('FSMemoryStore in-memory cache', () => {
  it('serves repeat searches from the cache and invalidates on forget', async () => {
    await store.add(base({ sessionId: 's-c', content: 'cache me', projectPath: '/proj/c' }));
    // First search populates the cache; second hits it (no disk read).
    const hits1 = await store.search('cache', { projectPath: '/proj/c' });
    const hits2 = await store.search('cache', { projectPath: '/proj/c' });
    expect(hits1).toHaveLength(1);
    expect(hits2).toHaveLength(1);

    // forget() must invalidate the mirror even though its directory-key differs
    // from the cache's project-path key.
    await store.forget('s-c');
    const after = await store.search('cache', { projectPath: '/proj/c' });
    expect(after).toHaveLength(0);
  });

  it('invalidates the cache after decay rewrites decayScore', async () => {
    await store.add(base({ sessionId: 's-d', content: 'stale me', projectPath: '/proj/d', timestamp: Date.now() - 200_000 }));
    await store.decay(100_000);
    const hits = await store.search('stale', { projectPath: '/proj/d' });
    expect(hits).toHaveLength(1);
    expect(hits[0].decayScore).toBeLessThan(1);
  });
});

describe('FSMemoryStore.forget / decay', () => {
  it('forget removes every entry for the given session across projects', async () => {
    await store.add(base({ sessionId: 's-del', projectPath: '/proj/a' }));
    await store.add(base({ sessionId: 's-del', content: 'other', projectPath: '/proj/b' }));
    await store.add(base({ sessionId: 's-keep', content: 'keep me' }));
    await store.forget('s-del');
    const hitsA = await store.search('TypeScript', { projectPath: '/proj/a' });
    const hitsB = await store.search('other', { projectPath: '/proj/b' });
    expect(hitsA).toHaveLength(0);
    expect(hitsB).toHaveLength(0);
    const kept = await store.search('keep', { projectPath: '/proj/a' });
    expect(kept).toHaveLength(1);
  });

  it('decay recomputes the multi-dim health score of memories idle past the threshold', async () => {
    const now = Date.now();
    await store.add(base({ content: 'old memory', timestamp: now - 10 * 24 * 3600 * 1000 }));
    await store.add(base({ content: 'fresh memory', timestamp: now }));
    await store.decay(7 * 24 * 3600 * 1000);
    const file = join(root, (await import('node:fs')).readdirSync(root).filter(d => d !== 'meta.json')[0], 'memories.jsonl');
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    const old = lines.map(l => JSON.parse(l)).find(e => e.content === 'old memory');
    const fresh = lines.map(l => JSON.parse(l)).find(e => e.content === 'fresh memory');
    // fresh（闲置 < 阈值）保持 add 时的新鲜分 0.72；old 按绝对时间重算：
    // recency 2^(-10/30) × 0.72 ≈ 0.5715（确定性，不叠加）。
    expect(fresh.decayScore).toBeCloseTo(0.72, 5);
    expect(old.decayScore).toBeCloseTo(0.7937005 * 0.72, 5);
    expect(old.lifecycle).toBe('active');
  });

  it('decay is deterministic — repeated passes converge instead of compounding', async () => {
    const now = Date.now();
    await store.add(base({ content: 'old', timestamp: now - 10 * 24 * 3600 * 1000 }));
    await store.decay(7 * 24 * 3600 * 1000);
    const first = JSON.parse(readFileSync(join(root, (await import('node:fs')).readdirSync(root).filter(d => d !== 'meta.json')[0], 'memories.jsonl'), 'utf-8').trim());
    await store.decay(7 * 24 * 3600 * 1000);
    const second = JSON.parse(readFileSync(join(root, (await import('node:fs')).readdirSync(root).filter(d => d !== 'meta.json')[0], 'memories.jsonl'), 'utf-8').trim());
    // 按绝对时间重算（≈0.5715），不叠加 —— 旧实现第二次会再减半到 0.25。
    expect(first.decayScore).toBeCloseTo(0.7937005 * 0.72, 5);
    expect(second.decayScore).toBeCloseTo(0.7937005 * 0.72, 5);
  });

  it('decay deletes memories whose health score sinks below the floor', async () => {
    const now = Date.now();
    // 200 天闲置、从未使用：recency 2^(-200/30) ≈ 0.0098 → 健康分 ≈ 0.007 < 0.05。
    await store.add(base({ content: 'very stale', timestamp: now - 200 * 24 * 3600 * 1000 }));
    await store.decay(7 * 24 * 3600 * 1000);
    const file = join(root, (await import('node:fs')).readdirSync(root).filter(d => d !== 'meta.json')[0], 'memories.jsonl');
    expect(readFileSync(file, 'utf-8').trim()).toBe('');
    const hits = await store.search('very', {});
    expect(hits).toHaveLength(0);
  });

  it('dormant 记忆在宽限期内保留、超期删除（被取代策略更快走完生命周期）', async () => {
    const now = Date.now();
    // 40 天闲置 + 被取代：健康分 = 2^(-40/30) × 0.775 × 0.4 ≈ 0.123 → dormant，
    // 40 天 < 60 天宽限 → 首次 decay 后仍保留在文件里。
    await store.add(base({ content: 'retained', timestamp: now - 40 * 24 * 3600 * 1000, supersededBy: 'new' }));
    await store.decay(7 * 24 * 3600 * 1000);
    let file = join(root, (await import('node:fs')).readdirSync(root).filter(d => d !== 'meta.json')[0], 'memories.jsonl');
    expect(readFileSync(file, 'utf-8').trim()).toContain('retained');
    // 65 天闲置 + 被取代：健康分 ≈ 0.069 → dormant，65 天 ≥ 60 天宽限 → 删除。
    await store.add(base({ content: 'purged', timestamp: now - 65 * 24 * 3600 * 1000, supersededBy: 'new' }));
    await store.decay(7 * 24 * 3600 * 1000);
    file = join(root, (await import('node:fs')).readdirSync(root).filter(d => d !== 'meta.json')[0], 'memories.jsonl');
    const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.some(l => l.includes('retained'))).toBe(true);
    expect(lines.some(l => l.includes('purged'))).toBe(false);
  });
});

describe('FSMemoryStore.removeById', () => {
  it('removes exactly the targeted entry and reports success', async () => {
    const idA = await store.add(base({ content: 'keep A', projectPath: '/proj/a' }));
    const idB = await store.add(base({ content: 'delete B', projectPath: '/proj/a' }));
    const removed = await store.removeById(idB);
    expect(removed).toBe(true);
    const hits = await store.search('delete', { projectPath: '/proj/a' });
    expect(hits).toHaveLength(0);
    const kept = await store.search('keep', { projectPath: '/proj/a' });
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe(idA);
  });

  it('reports false for an unknown id and changes nothing', async () => {
    await store.add(base({ content: 'stay', projectPath: '/proj/a' }));
    const removed = await store.removeById('nope');
    expect(removed).toBe(false);
    const hits = await store.search('stay', { projectPath: '/proj/a' });
    expect(hits).toHaveLength(1);
  });

  it('clears the supersededBy reference of the deleted entry\'s replacer', async () => {
    const idNew = await store.add(base({ content: 'new approach', projectPath: '/proj/a' }));
    const idOld = await store.add(base({ content: 'old approach', projectPath: '/proj/a', supersededBy: idNew }));
    // 删除取代者（新条目）后，被取代的旧条目不应再残留指向已删除 id 的 supersededBy。
    await store.removeById(idNew);
    const kept = await store.search('old', { projectPath: '/proj/a' });
    expect(kept).toHaveLength(1);
    expect(kept[0].supersededBy).toBeUndefined();
  });
});

describe('keywordSearch helpers', () => {
  it('tokenize handles latin and CJK', () => {
    const tokens = tokenize('TypeScript 支持 pnpm');
    expect(tokens).toContain('typescript');
    expect(tokens).toContain('pnpm');
    expect(tokens).toContain('支');
    expect(tokens).toContain('持');
  });

  it('searchMemories ranks multi-keyword matches above single-keyword ones', () => {
    const entries: MemoryEntry[] = [
      { ...base({ content: 'user prefers pnpm over npm' }), id: '1' },
      { ...base({ content: 'user prefers pnpm' }), id: '2' },
    ];
    const hits = searchMemories(entries, 'pnpm npm', { projectPath: '/proj/a' });
    expect(hits[0].id).toBe('1');
  });

  it('decayed memories sink in the ranking', () => {
    const entries: MemoryEntry[] = [
      { ...base({ content: 'fresh pnpm preference', timestamp: Date.now() }), id: '1' },
      { ...base({ content: 'old pnpm preference', timestamp: Date.now() - 1e9, decayScore: 0.25 }), id: '2' },
    ];
    const hits = searchMemories(entries, 'pnpm', { projectPath: '/proj/a', k: 2 });
    expect(hits[0].id).toBe('1');
  });
});

describe('FSMemoryStore.list filters', () => {
  it('filters by type / platform and drops dormant entries with activeOnly', async () => {
    await store.add(base({ projectPath: '/proj/a', type: 'tool_preference', content: 'Verified on darwin: the brew tool works', platform: 'darwin' }));
    await store.add(base({ projectPath: '/proj/a', type: 'tool_preference', content: 'Verified on win32: the choco tool works', platform: 'win32' }));
    await store.add(base({ projectPath: '/proj/a', type: 'user_preference', content: 'User prefers tabs' }));
    // 休眠条目：activeOnly 下必须被过滤（实时健康分低于 dormantMax ——
    // 70 天前的旧条目 recency 已把分数拖到 0.15 线以下）。
    await store.add(base({ projectPath: '/proj/a', type: 'tool_preference', content: 'Verified on darwin: the stale tool works', platform: 'darwin', lifecycle: 'dormant', timestamp: Date.now() - 70 * 24 * 3600 * 1000 }));

    const all = store.list('/proj/a');
    expect(all).toHaveLength(4);

    const darwin = store.list({ projectPath: '/proj/a', type: 'tool_preference', platform: 'darwin' });
    expect(darwin.map(e => e.content)).toEqual([
      'Verified on darwin: the brew tool works',
      'Verified on darwin: the stale tool works',
    ]);

    const activeDarwin = store.list({ projectPath: '/proj/a', type: 'tool_preference', platform: 'darwin', activeOnly: true });
    expect(activeDarwin.map(e => e.content)).toEqual(['Verified on darwin: the brew tool works']);
  });

  it('isolates the machine-global scope in its own storage bucket', async () => {
    const id = await store.add(base({ projectPath: GLOBAL_MEMORY_SCOPE, type: 'tool_preference', content: 'Verified on darwin: the pnpm tool works', platform: 'darwin' }));
    // 项目作用域看不到它；全局作用域看得到。
    expect(store.list('/proj/a').some(e => e.id === id)).toBe(false);
    expect(store.list({ projectPath: GLOBAL_MEMORY_SCOPE }).some(e => e.id === id)).toBe(true);
  });
});

describe('legacy tool_preference migration', () => {
  it('moves project-scoped tool preferences into the global scope, deduping by tool', async () => {
    const mk = (projectPath: string, content: string, platform?: string, dedupeKey?: string) =>
      base({ projectPath, type: 'tool_preference', content, platform, dedupeKey });
    // 同工具在两个项目各一条（去重后应只保留一条）+ 另一工具 + 用户明说（无 platform/无 dedupeKey）
    const a = await store.add(mk('/proj/a', 'Verified on darwin: the pnpm tool works on this machine', 'darwin', 'tool:darwin:pnpm'));
    const b = await store.add(mk('/proj/b', 'Verified on darwin: the pnpm tool works on this machine', 'darwin', 'tool:darwin:pnpm'));
    await store.add(mk('/proj/b', 'Verified on win32: the choco tool works on this machine', 'win32', 'tool:win32:choco'));
    await store.add(mk('/proj/a', 'User wants to use the uv tool'));
    await store.add(base({ projectPath: '/proj/a', type: 'user_preference', content: 'User prefers tabs' }));

    // 新实例构造时执行迁移（旧实例缓存已失效，断言一律走新实例）
    const migrated = new FSMemoryStore(root);

    // 项目作用域不再有工具偏好；user_preference 不受影响
    expect(migrated.list('/proj/a').filter(e => e.type === 'tool_preference')).toHaveLength(0);
    expect(migrated.list('/proj/b').filter(e => e.type === 'tool_preference')).toHaveLength(0);
    expect(migrated.list('/proj/a').some(e => e.content === 'User prefers tabs')).toBe(true);

    const globalTools = migrated.list({ projectPath: GLOBAL_MEMORY_SCOPE, type: 'tool_preference' });
    expect(globalTools.map(t => t.content).sort()).toEqual([
      'User wants to use the uv tool',
      'Verified on darwin: the pnpm tool works on this machine',
      'Verified on win32: the choco tool works on this machine',
    ]);
    // 去重只保留两条之一（保留哪条取决于目录扫描顺序），条目归属全局作用域
    expect([a, b]).toContain(globalTools.find(t => t.content.includes('pnpm'))!.id);
    expect(globalTools.every(t => t.projectPath === GLOBAL_MEMORY_SCOPE)).toBe(true);
    // meta 标记：只迁移一次
    expect(migrated.getLastDecayInfo().migratedToolPrefsAt).toBeGreaterThan(0);
    const again = new FSMemoryStore(root);
    expect(again.list({ projectPath: GLOBAL_MEMORY_SCOPE, type: 'tool_preference' })).toHaveLength(3);
  });

  it('skips migration when no legacy tool preferences exist (no meta marker)', async () => {
    await store.add(base({ projectPath: '/proj/a', type: 'user_preference', content: 'User prefers tabs' }));
    const migrated = new FSMemoryStore(root);
    expect(migrated.getLastDecayInfo().migratedToolPrefsAt).toBeUndefined();
    expect(migrated.list('/proj/a')).toHaveLength(1);
  });
});
