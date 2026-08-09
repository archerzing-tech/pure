// src/adapter/memory/__tests__/evolution.test.ts
// v1.5 — 智能进化记忆系统（§12.8）：多维健康分、生命周期、取代判定与 store 集成。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FSMemoryStore } from '../FSMemoryStore';
import { LocalStorageMemoryStore } from '../LocalStorageMemoryStore';
import {
  EVOLUTION,
  applyHits,
  comparisonText,
  decayEntry,
  findSupersedeTarget,
  healthScore,
  lifecycleOf,
  similarityTokens,
} from '../evolution';
import type { MemoryEntry, MemoryType } from '../IMemoryStore';

const DAY = 24 * 3600 * 1000;
const NOW = Date.now();

const entry = (over: Partial<MemoryEntry> & { type: MemoryType }): MemoryEntry => ({
  id: over.id ?? 'e1',
  content: 'content',
  timestamp: NOW,
  sessionId: 's1',
  projectPath: '/proj/a',
  ...over,
});

describe('healthScore — 多维打分', () => {
  it('新鲜已验证记忆 ≈ 0.775，偏好 ≈ 0.72，错误 ≈ 0.665（可信度维度）', () => {
    expect(healthScore(entry({ type: 'successful_pattern' }), NOW)).toBeCloseTo(0.775, 10);
    expect(healthScore(entry({ type: 'procedure' }), NOW)).toBeCloseTo(0.775, 10);
    expect(healthScore(entry({ type: 'user_preference' }), NOW)).toBeCloseTo(0.72, 10);
    expect(healthScore(entry({ type: 'project_convention' }), NOW)).toBeCloseTo(0.6925, 10);
    expect(healthScore(entry({ type: 'error_pattern' }), NOW)).toBeCloseTo(0.665, 10);
  });

  it('时间维度：闲置 30 天（一个半衰期）分数减半', () => {
    const e = entry({ type: 'user_preference' });
    const fresh = healthScore(e, NOW);
    const aged = healthScore(e, NOW + EVOLUTION.RECENCY_HALF_LIFE_MS);
    expect(aged).toBeCloseTo(fresh / 2, 10);
  });

  it('使用频率维度：hitCount 抬升分数，4 次饱和', () => {
    const e = entry({ type: 'user_preference', hitCount: 4 });
    expect(healthScore(e, NOW)).toBeCloseTo(0.945, 10);
    const saturated = entry({ type: 'user_preference', hitCount: 99 });
    expect(healthScore(saturated, NOW)).toBeCloseTo(0.945, 10);
  });

  it('进化维度：被取代的记忆 ×0.4 惩罚', () => {
    const e = entry({ type: 'procedure', supersededBy: 'new-id' });
    expect(healthScore(e, NOW)).toBeCloseTo(0.775 * EVOLUTION.SUPERSEDED_PENALTY, 10);
  });
});

describe('lifecycleOf — 生命周期阈值', () => {
  it('≥0.45 active，>0.15 degraded，≤0.15 dormant', () => {
    expect(lifecycleOf(0.5)).toBe('active');
    expect(lifecycleOf(EVOLUTION.ACTIVE_MIN)).toBe('active');
    expect(lifecycleOf(0.3)).toBe('degraded');
    expect(lifecycleOf(EVOLUTION.DORMANT_MAX)).toBe('dormant');
    expect(lifecycleOf(0.05)).toBe('dormant');
  });
});

describe('decayEntry — 单条衰减', () => {
  const olderThan = 7 * DAY;

  it('最近使用过的不动', () => {
    expect(decayEntry(entry({ type: 'user_preference' }), NOW, olderThan)).toBe('untouched');
  });

  it('闲置超过阈值按绝对时间重算（确定性收敛）', () => {
    const e = entry({ type: 'user_preference', timestamp: NOW - 10 * DAY });
    const first = decayEntry(e, NOW, olderThan);
    expect(first).toBe('updated');
    // recency 2^(-10/30) × 0.72 ≈ 0.5715
    expect(e.decayScore).toBeCloseTo(0.7937005 * 0.72, 5);
    expect(e.lifecycle).toBe('active');
    // 再次执行得到同一分数（不叠加）
    const second = decayEntry(e, NOW, olderThan);
    expect(second).toBe('untouched');
    expect(e.decayScore).toBeCloseTo(0.7937005 * 0.72, 5);
  });

  it('健康分跌破删除线直接删除', () => {
    const e = entry({ type: 'user_preference', timestamp: NOW - 200 * DAY });
    expect(decayEntry(e, NOW, olderThan)).toBe('deleted');
  });

  it('休眠超过宽限期删除（即使分数未跌破删除线）', () => {
    // 100 天闲置 → 健康分 ≈ 0.0714 → dormant（保留在文件里）
    const e = entry({ type: 'user_preference', timestamp: NOW - 100 * DAY });
    expect(decayEntry(e, NOW, olderThan)).toBe('updated');
    expect(e.lifecycle).toBe('dormant');
    // 下一次 decay：已 dormant 且闲置 100 天 ≥ 60 天宽限 → 删除
    expect(decayEntry(e, NOW, olderThan)).toBe('deleted');
  });
});

describe('supersession — 新策略取代旧策略', () => {
  const procOld = entry({
    type: 'procedure',
    content: 'When facing "vite build failure": apply the verified procedure — clear the .cache dir. Verify via: engine pass.',
  });
  const procNew = entry({
    type: 'procedure',
    sessionId: 's2', // 跨会话 —— 同会话内不取代（并列清单保护）
    content: 'When facing "vite build failure": apply the verified procedure — use esbuild instead. Verify via: engine pass.',
  });
  const procOther = entry({
    type: 'procedure',
    sessionId: 's2',
    content: 'When facing "docker port conflict": apply the verified procedure — remap the ports. Verify via: engine pass.',
  });

  it('同情境新流程取代旧流程（模板样板不干扰）', () => {
    const target = findSupersedeTarget([procOld], procNew);
    expect(target).toBeDefined();
    expect(target!.id).toBe(procOld.id);
  });

  it('同会话内不取代 —— 一条消息收割的并列清单（TypeScript + Python）不互杀', () => {
    const ts = entry({ type: 'user_preference', content: 'User prefers the TypeScript language', sessionId: 's-batch' });
    const py = entry({ type: 'user_preference', content: 'User prefers the Python language', sessionId: 's-batch' });
    expect(findSupersedeTarget([ts], py)).toBeUndefined();
    expect(findSupersedeTarget([py], ts)).toBeUndefined();
    const react = entry({ type: 'user_preference', content: 'User frequently uses the React framework', sessionId: 's-batch' });
    const vue = entry({ type: 'user_preference', content: 'User frequently uses the Vue framework', sessionId: 's-batch' });
    expect(findSupersedeTarget([react], vue)).toBeUndefined();
  });

  it('不同情境不取代', () => {
    expect(findSupersedeTarget([procOld], procOther)).toBeUndefined();
  });

  it('错误模式永不被取代（模板噪音）', () => {
    const err = entry({ type: 'error_pattern', content: 'Repeated failure: web_search timeout (tool: web_search). Do not make this exact call again' });
    expect(findSupersedeTarget([err], { ...err })).toBeUndefined();
  });

  it('用户偏好反转（tabs → spaces，跨会话）取代旧偏好', () => {
    const old = entry({ type: 'user_preference', content: 'User prefers tabs for indentation' });
    const next = entry({ type: 'user_preference', sessionId: 's2', content: 'User prefers spaces for indentation' });
    expect(findSupersedeTarget([old], next)?.id).toBe(old.id);
  });

  it('“TypeScript vs pnpm”这类并列偏好不误伤', () => {
    const ts = entry({ type: 'user_preference', content: 'User prefers the TypeScript language' });
    const pnpm = entry({ type: 'user_preference', content: 'User prefers the pnpm tool' });
    expect(findSupersedeTarget([ts], pnpm)).toBeUndefined();
    expect(findSupersedeTarget([pnpm], ts)).toBeUndefined();
  });

  it('已取代的条目不再成为取代目标；跨项目不取代', () => {
    const old = entry({ type: 'procedure', content: procOld.content, supersededBy: 'x' });
    expect(findSupersedeTarget([old], procNew)).toBeUndefined();
    const otherProject = entry({ type: 'procedure', content: procOld.content, projectPath: '/proj/b' });
    expect(findSupersedeTarget([otherProject], procNew)).toBeUndefined();
  });

  it('successful_pattern 按 lesson.symptom 判定（跨会话）', () => {
    const old = entry({ type: 'successful_pattern', content: 'irrelevant', lesson: { symptom: 'fix vite build failure', rootCause: 'a', recoveryPath: 'b', verification: 'c', avoidNextTime: 'd' } });
    const next = entry({ type: 'successful_pattern', sessionId: 's2', content: 'irrelevant', lesson: { symptom: 'fix vite build failure with esbuild', rootCause: 'x', recoveryPath: 'y', verification: 'z', avoidNextTime: 'w' } });
    expect(findSupersedeTarget([old], next)?.id).toBe(old.id);
  });

  it('comparisonText 剥离模板样板', () => {
    expect(comparisonText(procOld)).not.toContain('When facing');
    expect(comparisonText(procOld)).not.toContain('apply the verified procedure');
    expect(similarityTokens(comparisonText(procOld))).toContain('vite');
  });
});

describe('applyHits — 检索命中副作用', () => {
  it('hitCount +1 并刷新 lastUsedAt', () => {
    const e = entry({ type: 'user_preference' });
    applyHits([e], NOW);
    expect(e.hitCount).toBe(1);
    expect(e.lastUsedAt).toBe(NOW);
    applyHits([e], NOW + 1000);
    expect(e.hitCount).toBe(2);
    expect(e.lastUsedAt).toBe(NOW + 1000);
  });
});

describe('FSMemoryStore 集成', () => {
  let root: string;
  let store: FSMemoryStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pure-evol-'));
    store = new FSMemoryStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('add 时新流程取代旧流程并持久化标记', async () => {
    const oldContent = 'When facing "vite build failure": apply the verified procedure — clear the .cache dir. Verify via: engine pass.';
    const newContent = 'When facing "vite build failure": apply the verified procedure — use esbuild instead. Verify via: engine pass.';
    const oldId = await store.add({ type: 'procedure', content: oldContent, timestamp: NOW, sessionId: 's1', projectPath: '/proj/a' });
    const newId = await store.add({ type: 'procedure', content: newContent, timestamp: NOW, sessionId: 's2', projectPath: '/proj/a' });
    expect(newId).not.toBe(oldId);
    const listed = store.list('/proj/a');
    const old = listed.find(e => e.id === oldId)!;
    expect(old.supersededBy).toBe(newId);
    expect(old.lifecycle).toBe('degraded');
    expect(listed.find(e => e.id === newId)!.lifecycle).toBe('active');
  });

  it('search 记录命中（hitCount/lastUsedAt），dormant 记忆不进检索', async () => {
    await store.add({ type: 'user_preference', content: 'prefers pnpm', timestamp: NOW, sessionId: 's1', projectPath: '/proj/a' });
    const hits1 = await store.search('pnpm', { projectPath: '/proj/a' });
    expect(hits1[0].hitCount).toBe(1);
    const hits2 = await store.search('pnpm', { projectPath: '/proj/a' });
    expect(hits2[0].hitCount).toBe(2);
    expect(hits2[0].lastUsedAt).toBeGreaterThanOrEqual(NOW - 1);

    // 被取代 + 45 天闲置：健康分 = 2^(-45/30) × 0.72 × 0.4 ≈ 0.102 → dormant
    // （未超 60 天宽限）：仍在文件，但不进检索。普通偏好要到 ~68 天才休眠，
    // 被取代的惩罚（×0.4）让旧策略更快进入休眠期。
    await store.add({ type: 'user_preference', content: 'sleepy memory', timestamp: NOW - 45 * DAY, sessionId: 's2', projectPath: '/proj/a', supersededBy: 'new' });
    await store.decay(7 * DAY);
    const dormant = await store.search('sleepy', { projectPath: '/proj/a' });
    expect(dormant).toHaveLength(0); // dormant 不进检索
    expect(store.list('/proj/a').some(e => e.content === 'sleepy memory')).toBe(true); // 但仍保留
  });

  it('decay 合并 search 命中数据后落盘（不丢使用频率）', async () => {
    await store.add({ type: 'user_preference', content: 'old but used', timestamp: NOW - 10 * DAY, sessionId: 's1', projectPath: '/proj/a' });
    await store.search('old but used', { projectPath: '/proj/a' }); // 内存 +1
    await store.decay(7 * DAY); // 触发重算 + 落盘（并合并缓存命中）
    const reloaded = new FSMemoryStore(root).list('/proj/a');
    expect(reloaded[0].hitCount).toBe(1);
    expect(reloaded[0].decayScore).toBeCloseTo(0.7937005 * 0.72, 5);
  });

  it('构造参数自定义阈值驱动 add 种子化与 decay 重算', async () => {
    const fast = new FSMemoryStore(root, '', { recencyHalfLifeMs: 7 * DAY });
    await fast.add({ type: 'user_preference', content: 'fast decay', timestamp: NOW - 14 * DAY, sessionId: 's1', projectPath: '/proj/f' });
    await fast.decay(7 * DAY);
    // 半衰期 7 天：闲置 14 天 → 2^(-2) × 0.72 = 0.18（add 时已按自定义阈值种子化）
    expect(fast.list('/proj/f')[0].decayScore).toBeCloseTo(0.18, 5);
  });

  it('decay 记录运行信息（时间 + 删除/更新统计，meta.json）', async () => {
    await store.add({ type: 'user_preference', content: 'stale', timestamp: NOW - 200 * DAY, sessionId: 's1', projectPath: '/proj/meta' });
    await store.add({ type: 'user_preference', content: 'active', timestamp: NOW, sessionId: 's1', projectPath: '/proj/meta' });
    await store.decay(7 * DAY);
    const info = store.getLastDecayInfo();
    expect(info.lastDecayAt).toBeGreaterThanOrEqual(NOW - 1);
    // 200 天 → 跌破删除线删除；活跃条目闲置不足 → untouched
    expect(info.lastDeleted).toBe(1);
    expect(info.lastUpdated).toBe(0);
    // 新实例也能从磁盘读回
    expect(new FSMemoryStore(root).getLastDecayInfo().lastDeleted).toBe(1);
  });
});

describe('LocalStorageMemoryStore 集成', () => {
  const mem: Record<string, string> = {};
  beforeEach(() => {
    Object.keys(mem).forEach(k => delete mem[k]);
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => { mem[k] = v; },
      removeItem: (k: string) => { delete mem[k]; },
    };
  });

  it('取代标记与 recordHits 均持久化', async () => {
    const store = new LocalStorageMemoryStore();
    const oldId = await store.add({ type: 'procedure', content: 'When facing "vite build failure": apply the verified procedure — clear the .cache dir. Verify via: engine pass.', timestamp: NOW, sessionId: 's1', projectPath: '/p' });
    const newId = await store.add({ type: 'procedure', content: 'When facing "vite build failure": apply the verified procedure — use esbuild instead. Verify via: engine pass.', timestamp: NOW, sessionId: 's2', projectPath: '/p' });

    await store.search('vite build failure', { projectPath: '/p' });

    // 重新读（新 store 实例）验证确实持久化
    const fresh = new LocalStorageMemoryStore().list('/p');
    const old = fresh.find(e => e.id === oldId)!;
    expect(old.supersededBy).toBe(newId);
    const newEntry = fresh.find(e => e.id === newId)!;
    expect(newEntry.hitCount).toBe(1);
    expect(newEntry.lastUsedAt).toBeGreaterThanOrEqual(NOW - 1);
  });

  it('getConfig 注入的自定义阈值驱动 add 种子化与 decay 重算', async () => {
    const store = new LocalStorageMemoryStore(() => ({ recencyHalfLifeMs: 7 * DAY }));
    await store.add({ type: 'user_preference', content: 'fast decay', timestamp: NOW - 14 * DAY, sessionId: 's1', projectPath: '/p' });
    await store.decay(7 * DAY);
    const listed = store.list('/p');
    // 半衰期 7 天：闲置 14 天 → 2^(-2) × 0.72 = 0.18
    expect(listed[0].decayScore).toBeCloseTo(0.18, 5);
    expect(listed[0].lifecycle).toBe('degraded');
  });

  it('decay 记录运行信息（时间 + 删除/更新统计）', async () => {
    const store = new LocalStorageMemoryStore();
    await store.add({ type: 'user_preference', content: 'stale', timestamp: NOW - 200 * DAY, sessionId: 's1', projectPath: '/p' });
    await store.add({ type: 'user_preference', content: 'active', timestamp: NOW, sessionId: 's1', projectPath: '/p' });
    await store.decay(7 * DAY);
    const info = store.getLastDecayInfo();
    expect(info.lastDecayAt).toBeGreaterThanOrEqual(NOW - 1);
    expect(info.lastDeleted).toBe(1);
    expect(info.lastUpdated).toBe(0);
    // 新实例也从 localStorage 读回同一 meta
    expect(new LocalStorageMemoryStore().getLastDecayInfo().lastDeleted).toBe(1);
  });
});

describe('EvolutionConfig — 可配置进化阈值（遗忘速度）', () => {
  it('自定义半衰期加速/减速时间衰减', () => {
    const e = entry({ type: 'user_preference' });
    const agedDefault = healthScore(e, NOW + 30 * DAY);          // 2^(-1) × 0.72 = 0.36
    const agedSlow = healthScore(e, NOW + 30 * DAY, { recencyHalfLifeMs: 90 * DAY }); // 2^(-1/3) × 0.72
    const agedFast = healthScore(e, NOW + 30 * DAY, { recencyHalfLifeMs: 10 * DAY }); // 2^(-3) × 0.72 = 0.09
    expect(agedDefault).toBeCloseTo(0.36, 10);
    expect(agedSlow).toBeGreaterThan(agedDefault);
    expect(agedFast).toBeCloseTo(0.09, 10);
    expect(agedFast).toBeLessThan(agedDefault);
  });

  it('自定义生命周期阈值重划阶段', () => {
    expect(lifecycleOf(0.5, { activeMin: 0.6 })).toBe('degraded');
    expect(lifecycleOf(0.2, { dormantMax: 0.25 })).toBe('dormant');
    expect(lifecycleOf(0.2, { dormantMax: 0.1 })).toBe('degraded');
  });

  it('更严格的删除线把降级中的记忆直接删除', () => {
    const e = entry({ type: 'user_preference', timestamp: NOW - 60 * DAY });
    // 默认删除线 0.05：60 天 → 0.18 → updated（还在）
    expect(decayEntry(e, NOW, 7 * DAY)).toBe('updated');
    // 删除线提到 0.2：0.18 < 0.2 → deleted
    const e2 = entry({ type: 'user_preference', timestamp: NOW - 60 * DAY });
    expect(decayEntry(e2, NOW, 7 * DAY, { deleteFloor: 0.2 })).toBe('deleted');
  });

  it('自定义休眠宽限决定休眠记忆存活时间', () => {
    // 70 天闲置的记忆重算后才是真休眠（≈0.143 ≤ 0.15）—— 40 天（≈0.286）
    // 按默认阈值是 degraded，若手工标 dormant 属于不一致状态（会按“复活”处理）。
    const mk = () => entry({ type: 'user_preference', timestamp: NOW - 70 * DAY, lifecycle: 'dormant', decayScore: 0.72 * Math.pow(2, -70 / 30) });
    // 宽限 30 天：闲置 70 天 ≥ 30 且重算仍 dormant → 删除
    expect(decayEntry(mk(), NOW, 7 * DAY, { dormantGraceMs: 30 * DAY })).toBe('deleted');
    // 宽限 90 天：70 < 90 → 重算保留（不删）
    const kept = decayEntry(mk(), NOW, 7 * DAY, { dormantGraceMs: 90 * DAY });
    expect(kept).not.toBe('deleted');
  });

  it('取代覆盖率阈值越高越难触发取代', () => {
    const old = entry({ type: 'user_preference', content: 'User prefers the TypeScript language' });
    const next = entry({ type: 'user_preference', sessionId: 's2', content: 'User prefers the TypeScript language for backend' });
    // 覆盖率 4/5 = 0.8 → 默认 0.55 触发取代；提到 0.85 则不触发
    expect(findSupersedeTarget([old], next)?.id).toBe(old.id);
    expect(findSupersedeTarget([old], next, { supersedeSimilarity: 0.85 })).toBeUndefined();
  });

  it('部分配置只覆盖对应维度（其余用默认）', () => {
    const e = entry({ type: 'user_preference' });
    // 只给 halfLife，其他默认 → 分数 = 2^(-30/90) × 0.72（默认可信度/饱和/惩罚不变）
    expect(healthScore(e, NOW + 30 * DAY, { recencyHalfLifeMs: 90 * DAY }))
      .toBeCloseTo(0.72 * Math.pow(2, -30 / 90), 10);
  });

  it('调低休眠线后“复活”的记忆不被宽限删除误杀', () => {
    // 闲置 70 天、存储为 dormant（旧配置下 ≤0.15）、已超 60 天宽限的记忆。
    const score70 = 0.72 * Math.pow(2, -70 / 30); // ≈ 0.143
    // 默认休眠线 0.15：重算仍 dormant 且超宽限 → 删除
    const e1 = entry({ type: 'user_preference', timestamp: NOW - 70 * DAY, lifecycle: 'dormant', decayScore: score70 });
    expect(decayEntry(e1, NOW, 7 * DAY)).toBe('deleted');
    // 休眠线降到 0.05：重算为 degraded（复活）→ 即使超宽限也不删，只更新
    const e2 = entry({ type: 'user_preference', timestamp: NOW - 70 * DAY, lifecycle: 'dormant', decayScore: score70 });
    expect(decayEntry(e2, NOW, 7 * DAY, { dormantMax: 0.05 })).toBe('updated');
    expect(e2.lifecycle).toBe('degraded');
  });
});
