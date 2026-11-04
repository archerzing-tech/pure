// src/shared/__tests__/webExtract.test.ts
// 期4 抓取后提炼层的纯逻辑:阈值、prompt、包裹形态、缓存(键桶化/FIFO
// 淘汰/LRU 触碰/TTL 过期)、编排(condenseToolBody——2026-11-04 起为
// TauriToolAdapter 与 NodeToolAdapter 两端共用的单源)。

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import {
  buildExtractPrompt,
  cacheExtract,
  condenseToolBody,
  EXTRACT_CACHE_CAP,
  EXTRACT_TARGET_CHARS,
  EXTRACT_THRESHOLD_CHARS,
  extractCacheKey,
  getCachedExtract,
  resetExtractCache,
  shouldExtractText,
  wrapSummary,
  type SummarizeForExtract,
} from '../webExtract';

describe('shouldExtractText', () => {
  it('lets pages at or under the threshold through untouched', () => {
    expect(shouldExtractText('a'.repeat(EXTRACT_THRESHOLD_CHARS))).toBe(false);
    expect(shouldExtractText('a'.repeat(EXTRACT_THRESHOLD_CHARS - 1))).toBe(false);
  });

  it('flags pages over the threshold', () => {
    expect(shouldExtractText('a'.repeat(EXTRACT_THRESHOLD_CHARS + 1))).toBe(true);
  });
});

describe('buildExtractPrompt', () => {
  it('carries the url, the page text and the length cap', () => {
    const prompt = buildExtractPrompt('https://example.com/a', 'PAGE BODY');
    expect(prompt).toContain('https://example.com/a');
    expect(prompt).toContain('PAGE BODY');
    expect(prompt).toContain(String(EXTRACT_TARGET_CHARS));
    expect(prompt).toContain('不编造');
  });
});

describe('wrapSummary', () => {
  it('announces condensation, the original size and the raw escape hatch', () => {
    const wrapped = wrapSummary('  要点正文  ', 'https://example.com/a', 20000);
    expect(wrapped).toContain('[已提炼');
    expect(wrapped).toContain('约 20k 字符');
    expect(wrapped).toContain('raw: true');
    // 正文被 trim 且跟在包裹头之后。
    expect(wrapped.endsWith('要点正文')).toBe(true);
  });
});

describe('extractCacheKey', () => {
  it('differentiates url and selector', () => {
    expect(extractCacheKey('https://a', '.main')).not.toBe(extractCacheKey('https://a'));
    expect(extractCacheKey('https://a')).not.toBe(extractCacheKey('https://b'));
  });

  it('buckets maxChars into std/big so nearby values share one entry', () => {
    expect(extractCacheKey('https://a', undefined, 20000)).toBe(extractCacheKey('https://a'));
    expect(extractCacheKey('https://a', undefined, 15000)).toBe(extractCacheKey('https://a', undefined, 20000));
    expect(extractCacheKey('https://a', undefined, 20001)).not.toBe(extractCacheKey('https://a', undefined, 20000));
  });
});

describe('extract cache', () => {
  beforeEach(() => resetExtractCache());
  afterEach(() => {
    resetExtractCache();
    // setSystemTime 是进程全局 mock(bun test 单进程、跨文件泄漏):TTL 用例
    // 拨快 31min 后必须拨回真实时钟,否则排在后面的文件里所有 timer/Date.now
    // 间隔型用例全被带崩——2026-10-30 CI(windows 66+linux 6)与本地全量
    // 4 连红真凶。「隔离单跑全绿」恰是泄漏型污染的特征:单跑时污染源不在场,
    // 不能当抖动放行,要看全量。
    setSystemTime();
  });

  it('round-trips a summary and misses unknown keys', () => {
    cacheExtract(extractCacheKey('https://a'), '要点');
    expect(getCachedExtract(extractCacheKey('https://a'))).toBe('要点');
    expect(getCachedExtract(extractCacheKey('https://b'))).toBeUndefined();
  });

  it('evicts the oldest entry once the cap is reached', () => {
    for (let i = 0; i < EXTRACT_CACHE_CAP; i++) {
      cacheExtract(extractCacheKey(`https://p/${i}`), `s${i}`);
    }
    cacheExtract(extractCacheKey('https://fresh'), 'fresh');
    expect(getCachedExtract(extractCacheKey('https://p/0'))).toBeUndefined();
    expect(getCachedExtract(extractCacheKey('https://fresh'))).toBe('fresh');
  });

  it('touches on hit: a recently used entry survives eviction', () => {
    cacheExtract(extractCacheKey('https://old'), 'keep');
    // 再填满到容量(old 沉到队首),命中一次把 old 挪回队尾,随后再插入
    // 新条目——被挤掉的必须是真最久未用的 p/0,而不是刚被用过的 old。
    for (let i = 0; i < EXTRACT_CACHE_CAP - 1; i++) {
      cacheExtract(extractCacheKey(`https://p/${i}`), `s${i}`);
    }
    expect(getCachedExtract(extractCacheKey('https://old'))).toBe('keep');
    cacheExtract(extractCacheKey('https://fresh'), 'fresh');
    expect(getCachedExtract(extractCacheKey('https://old'))).toBe('keep');
    expect(getCachedExtract(extractCacheKey('https://p/0'))).toBeUndefined();
    expect(getCachedExtract(extractCacheKey('https://fresh'))).toBe('fresh');
  });

  it('expires entries past the TTL', () => {
    const now = Date.now();
    setSystemTime(now);
    cacheExtract(extractCacheKey('https://a'), '要点');
    setSystemTime(now + 31 * 60_000);
    expect(getCachedExtract(extractCacheKey('https://a'))).toBeUndefined();
  });
});

describe('condenseToolBody · 两端共用的提炼编排', () => {
  const big = 'x'.repeat(EXTRACT_THRESHOLD_CHARS + 100);

  it('passes raw:true, short pages and missing callbacks through untouched', async () => {
    const never: SummarizeForExtract = async () => { throw new Error('must not be called'); };
    await expect(condenseToolBody('https://r', { raw: true }, big, never)).resolves.toBe(big);
    await expect(condenseToolBody('https://s', {}, 'short', never)).resolves.toBe('short');
    await expect(condenseToolBody('https://n', {}, big, undefined)).resolves.toBe(big);
  });

  it('condenses via the callback and wraps with the raw escape hatch', async () => {
    resetExtractCache();
    const served = await condenseToolBody('https://x', {}, big, async () => '  要点  ');
    expect(served).toContain('要点');
    expect(served).toContain('raw: true');
  });

  it('falls back to the original when the callback fails, empties or lengthens', async () => {
    resetExtractCache();
    await expect(condenseToolBody('https://f', {}, big, async () => { throw new Error('llm down'); })).resolves.toBe(big);
    // 空要点不冒充提炼。
    await expect(condenseToolBody('https://e', {}, big, async () => '   ')).resolves.toBe(big);
    // 越提越长=没提炼出东西。
    await expect(condenseToolBody('https://l', {}, big, async () => `${big}更长`)).resolves.toBe(big);
  });

  it('serves the cached summary for the same key without recalling the LLM', async () => {
    resetExtractCache();
    let calls = 0;
    const cb: SummarizeForExtract = async () => { calls += 1; return '要点'; };
    await condenseToolBody('https://c', {}, big, cb);
    await condenseToolBody('https://c', {}, big, cb);
    expect(calls).toBe(1);
  });
});
