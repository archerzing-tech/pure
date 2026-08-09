// src/ui/__tests__/memoryTransfer.test.ts
// Covers the memory-library export/import feature (Settings → Memory):
//  • buildMemoryExportJson — envelope + per-entry live health/lifecycle snapshots
//  • buildMemoryExportMarkdown — readable report grouped by lifecycle
//  • parseMemoryImport — envelope/bare-array acceptance, field validation, errors
//  • LocalStorageMemoryStore.importEntries — field-preserving merge + dedupe

import { describe, it, expect, afterEach } from 'bun:test';
import { LocalStorageMemoryStore } from '../../adapter/memory/LocalStorageMemoryStore';
import {
  buildMemoryExportJson,
  buildMemoryExportMarkdown,
  parseMemoryImport,
  MEMORY_EXPORT_APP,
  MEMORY_EXPORT_KIND,
} from '../memoryTransfer';
import type { MemoryEntry } from '../../adapter/memory/IMemoryStore';

const DAY = 24 * 3600 * 1000;
const NOW = 1_700_000_000_000;

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'e1',
    type: 'user_preference',
    content: 'User prefers tabs over spaces',
    timestamp: NOW - 3 * DAY,
    sessionId: 's-1',
    projectPath: '/proj/a',
    decayScore: 0.7,
    lifecycle: 'active',
    hitCount: 4,
    lastUsedAt: NOW - DAY,
    ...overrides,
  };
}

// ── JSON export ──

describe('buildMemoryExportJson', () => {
  it('emits the pure envelope with one entry per memory', () => {
    const text = buildMemoryExportJson([entry()], undefined, NOW);
    const parsed = JSON.parse(text);
    expect(parsed.app).toBe(MEMORY_EXPORT_APP);
    expect(parsed.kind).toBe(MEMORY_EXPORT_KIND);
    expect(parsed.version).toBe(1);
    expect(parsed.exportedAt).toBe(new Date(NOW).toISOString());
    expect(parsed.entries).toHaveLength(1);
  });

  it('includes raw fields AND live healthScore/lifecycle snapshots', () => {
    // 无 supersededBy：4 次检索 + 1 天前使用 → 实时分高于活跃线（active）。
    const parsed = JSON.parse(buildMemoryExportJson([entry({ hitCount: 9 })], undefined, NOW));
    const out = parsed.entries[0];
    expect(out.id).toBe('e1');
    expect(out.hitCount).toBe(9);
    expect(out.projectPath).toBe('/proj/a');
    // Live snapshot: 3 days old at full credibility → high but < 1.
    expect(typeof out.healthScore).toBe('number');
    expect(out.healthScore).toBeGreaterThan(0);
    expect(out.healthScore).toBeLessThanOrEqual(1);
    expect(out.liveLifecycle).toBe('active');
  });

  it('flags superseded entries with a degraded live lifecycle', () => {
    // 被取代惩罚（×0.4）把实时分压到降级区 —— 快照如实反映。
    const parsed = JSON.parse(buildMemoryExportJson([entry({ supersededBy: 'e2' })], undefined, NOW));
    const out = parsed.entries[0];
    expect(out.supersededBy).toBe('e2');
    expect(out.liveLifecycle).toBe('degraded');
  });

  it('round-trips through parseMemoryImport preserving id and usage signals', () => {
    const e = entry({ supersededBy: 'e2', dedupeKey: 'dk-1' });
    const text = buildMemoryExportJson([e], undefined, NOW);
    const restored = parseMemoryImport(text);
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe('e1');
    expect(restored[0].supersededBy).toBe('e2');
    expect(restored[0].dedupeKey).toBe('dk-1');
    expect(restored[0].hitCount).toBe(4);
    expect(restored[0].lastUsedAt).toBe(NOW - DAY);
    expect(restored[0].sessionId).toBe('s-1');
  });

  it('preserves the structured lesson on round-trip (error_pattern fidelity)', () => {
    const withLesson = entry({
      type: 'error_pattern',
      lesson: {
        symptom: 'Build fails on macOS',
        rootCause: 'Wrong linker flag',
        recoveryPath: 'Add -framework CoreFoundation',
        verification: 'bun build passes',
        avoidNextTime: 'Check the linker flags first',
        tools: ['bun', 'rustc'],
      },
    });
    const text = buildMemoryExportJson([withLesson], undefined, NOW);
    const restored = parseMemoryImport(text);
    expect(restored[0].lesson).toEqual(withLesson.lesson);
    // 残缺 lesson（缺必需字段）整体丢弃 —— 不导入损坏的结构化数据。
    const bad = parseMemoryImport(JSON.stringify([{ ...entry(), lesson: { symptom: 'x', evil: 'xss' } }]));
    expect(bad[0].lesson).toBeUndefined();
    // 非字符串字段也被拒绝。
    const badTools = parseMemoryImport(JSON.stringify([{
      ...withLesson, lesson: { ...withLesson.lesson, tools: [42] },
    }]));
    expect(badTools[0].lesson?.tools).toBeUndefined();
  });
});

// ── Markdown export ──

describe('buildMemoryExportMarkdown', () => {
  it('groups entries by lifecycle with health and supersession markers', () => {
    const entries = [
      entry(),
      entry({ id: 'e2', type: 'procedure', content: 'Run npm test first', lifecycle: 'degraded', supersededBy: 'e3' }),
    ];
    const md = buildMemoryExportMarkdown(entries, undefined, NOW);
    expect(md).toContain('# Pure 记忆库导出');
    expect(md).toContain('## 活跃（1）');
    expect(md).toContain('## 降级（1）');
    // 内容以反引号内联代码包裹（防 markdown 结构字符破坏报告）。
    expect(md).toContain('[偏好] `User prefers tabs over spaces`');
    expect(md).toContain('[流程] `Run npm test first`');
    expect(md).toContain('**被取代**');
    expect(md).toContain('**检索次数**: 4');
  });

  it('renders an empty note when there are no memories', () => {
    const md = buildMemoryExportMarkdown([], undefined, NOW);
    expect(md).toContain('_暂无记忆。_');
  });
});

// ── Import parsing ──

describe('parseMemoryImport', () => {
  it('throws on non-JSON input', () => {
    expect(() => parseMemoryImport('not json {')).toThrow();
  });

  it('throws on an unsupported envelope (wrong app/kind)', () => {
    expect(() => parseMemoryImport(JSON.stringify({ app: 'other', kind: 'memory-library', version: 1, entries: [] })))
      .toThrow('unsupported-envelope');
  });

  it('throws on a NEWER envelope version (forward-compat guard)', () => {
    expect(() => parseMemoryImport(JSON.stringify({ app: MEMORY_EXPORT_APP, kind: MEMORY_EXPORT_KIND, version: 99, entries: [entry()] })))
      .toThrow('unsupported-version');
    // Same version / older versions are accepted.
    expect(() => parseMemoryImport(JSON.stringify({ app: MEMORY_EXPORT_APP, kind: MEMORY_EXPORT_KIND, version: 1, entries: [entry()] })))
      .not.toThrow();
  });

  it('accepts a bare array (tolerant legacy format)', () => {
    const restored = parseMemoryImport(JSON.stringify([entry()]));
    expect(restored).toHaveLength(1);
    expect(restored[0].content).toBe('User prefers tabs over spaces');
  });

  it('skips entries with invalid type/content and fills missing timestamps', () => {
    const restored = parseMemoryImport(JSON.stringify([
      { id: 'bad-type', type: 'mystery', content: 'x', timestamp: NOW },
      { id: 'bad-content', type: 'procedure', content: '  ', timestamp: NOW },
      { id: 'ok', type: 'error_pattern', content: 'Error X happens', timestamp: NOW, hitCount: 2.7 },
    ]));
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe('ok');
    expect(restored[0].hitCount).toBe(2); // floored to an integer
  });

  it('does not carry unknown keys from the file into entries', () => {
    const restored = parseMemoryImport(JSON.stringify([{ ...entry(), evil: 'xss', healthScore: 0.9, liveLifecycle: 'active' }]));
    expect(restored[0]).not.toHaveProperty('evil');
    expect(restored[0]).not.toHaveProperty('healthScore');
    expect(restored[0]).not.toHaveProperty('liveLifecycle');
  });

  it('clamps imported decayScore to the 0..1 contract', () => {
    const restored = parseMemoryImport(JSON.stringify([
      { ...entry(), id: 'hi', decayScore: 99 },
      { ...entry(), id: 'lo', decayScore: -3 },
    ]));
    const byId = new Map(restored.map(e => [e.id, e]));
    expect(byId.get('hi')?.decayScore).toBe(1);
    expect(byId.get('lo')?.decayScore).toBe(0);
  });
});

// ── Store importEntries (merge + dedupe) ──

describe('LocalStorageMemoryStore.importEntries', () => {
  const mem: Record<string, string> = {};
  let store: LocalStorageMemoryStore;

  afterEach(() => {
    Object.keys(mem).forEach(k => delete mem[k]);
    delete (globalThis as Record<string, unknown>).localStorage;
    delete (globalThis as Record<string, unknown>).window;
  });

  function stubGlobals(): void {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => { mem[k] = v; },
      removeItem: (k: string) => { delete mem[k]; },
    };
    (globalThis as Record<string, unknown>).window = { location: { search: '' } };
    store = new LocalStorageMemoryStore();
  }

  it('imports fresh entries preserving ids, timestamps and usage signals', async () => {
    stubGlobals();
    const { imported, skipped } = await store.importEntries([
      entry({ id: 'a1', timestamp: NOW - 10 * DAY, hitCount: 7, lastUsedAt: NOW - DAY, supersededBy: 'a2' }),
      entry({ id: 'a2', content: 'Newer strategy', timestamp: NOW - DAY }),
    ]);
    expect(imported).toBe(2);
    expect(skipped).toBe(0);
    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all.find(e => e.id === 'a1')?.hitCount).toBe(7);
    expect(all.find(e => e.id === 'a1')?.supersededBy).toBe('a2');
    expect(all.find(e => e.id === 'a1')?.timestamp).toBe(NOW - 10 * DAY);
  });

  it('skips entries with an existing id or identical (type, project, content)', async () => {
    stubGlobals();
    await store.add({ type: 'user_preference', content: 'Tabs rule', timestamp: NOW, sessionId: 's1', projectPath: '/proj/a' });
    const { imported, skipped } = await store.importEntries([
      entry({ id: 'x1', content: 'Tabs rule', projectPath: '/proj/a' }), // dup content
      entry({ id: 'x2', content: 'Tabs rule', projectPath: '/proj/b' }), // diff project → ok
    ]);
    expect(imported).toBe(1);
    expect(skipped).toBe(1);
    expect(store.list().map(e => e.id)).toContain('x2');
  });

  it('writes nothing when every entry is a duplicate', async () => {
    stubGlobals();
    const e = entry();
    const first = await store.importEntries([e]);
    const second = await store.importEntries([e]);
    expect(first.imported).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  it('surfaces storage-quota failures instead of a false success', async () => {
    // setItem throws (quota exceeded) — importEntries must NOT swallow it:
    // the in-memory cache is restored so a retry after cleanup can work, and
    // the error is recognizable ('storage-full') for the UI toast.
    stubGlobals();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => null,
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
      removeItem: () => {},
    };
    await expect(store.importEntries([entry({ id: 'q1' })])).rejects.toThrow('storage-full');
    // Cache rolled back — the entry is NOT visible in-memory either.
    expect(store.list()).toHaveLength(0);
  });
});
