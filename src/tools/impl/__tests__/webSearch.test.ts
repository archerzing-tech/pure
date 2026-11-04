// src/tools/impl/__tests__/webSearch.test.ts
// 编排层契约测试（runWebSearch）：单源编排的层次序、缓存短路、冷却语义
// （含换路重试的 ignoreCooldown）、全失败/空结果两文案、CJK 相关性门。
// 后端解析器的网络形状在 searchParser.test.ts；这里全部用假 fetchPage。

import { describe, expect, it, beforeEach } from 'bun:test';
import {
  runWebSearch,
  quota,
  resetSearchCookieJar,
  resultsRelevant,
  type PageFetchResult,
  type SearchNetDeps,
} from '../webSearch';

const ok = (body: string, contentType = 'application/json'): PageFetchResult => ({
  status: 200,
  finalUrl: 'https://backend.example/',
  contentType,
  setCookie: null,
  body: new TextEncoder().encode(body),
});

const serperHit = JSON.stringify({
  organic: [{ title: 'Rust language', link: 'https://rust-lang.org/', snippet: 'systems language' }],
});

/** 只会应答 serper 的假网：URL 含 serper.dev 返回命中，其余全空对象。 */
function serperOnlyNet(calls: string[]): SearchNetDeps {
  return {
    fetchPage: async (url) => {
      calls.push(url);
      return url.includes('serper.dev') ? ok(serperHit) : ok('{}');
    },
    env: (key) => (key === 'SERPER_API_KEY' ? 'test-key' : ''),
  };
}

function keylessNet(calls: string[], respond: (url: string) => PageFetchResult): SearchNetDeps {
  return {
    fetchPage: async (url) => {
      calls.push(url);
      return respond(url);
    },
    env: () => '',
  };
}

beforeEach(() => {
  quota.clear();
  resetSearchCookieJar();
});

describe('runWebSearch 编排契约', () => {
  it('缓存命中直接短路，零网络调用', async () => {
    const calls: string[] = [];
    const outcome = await runWebSearch('rust async', 10, {
      ...serperOnlyNet(calls),
      cacheGet: () => '早前的搜索结果',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toBe('[cached] 早前的搜索结果');
    expect(calls).toEqual([]);
  });

  it('API 后端命中即返回，不再打结构化/HTML 扇出', async () => {
    const calls: string[] = [];
    const outcome = await runWebSearch('rust async', 10, serperOnlyNet(calls));
    expect(outcome.ok).toBe(true);
    expect(calls.filter((u) => u.includes('serper.dev'))).toHaveLength(1);
    // 结构化层（RSS/JSON API）与 HTML 引擎一个都不该被打。
    expect(calls.every((u) => u.includes('serper.dev'))).toBe(true);
    expect(outcome.output).toContain('https://rust-lang.org/');
  });

  it('全后端网络级失败 → ok:false 文案（GUI 换路重试依赖它上抛）', async () => {
    const outcome = await runWebSearch('rust async', 10, {
      fetchPage: async () => {
        throw new Error('unable to connect');
      },
      env: () => '',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain('Web search failed on all backends');
    expect(outcome.output).toContain('unable to connect');
  });

  it('后端应答但无命中 → ok:true 空结果文案（不触发换路）', async () => {
    const outcome = await runWebSearch('rust async', 10, keylessNet([], () => ok('<html></html>', 'text/html')));
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain('No results found for');
  });

  it('冷却默认生效：进过冷却的后端下一轮直接跳过', async () => {
    const first: string[] = [];
    await runWebSearch('rust async', 10, keylessNet(first, () => {
      throw new Error('unable to connect');
    }));
    expect(first.length).toBeGreaterThan(0);
    const second: string[] = [];
    await runWebSearch('rust async', 10, keylessNet(second, () => ok('<html></html>', 'text/html')));
    expect(second).toEqual([]); // 全部处于 30s 冷却，零调用
  });

  it('ignoreCooldown（换路重试轮）跳过冷却重新打后端', async () => {
    const first: string[] = [];
    await runWebSearch('rust async', 10, keylessNet(first, () => {
      throw new Error('unable to connect');
    }));
    const retried: string[] = [];
    const outcome = await runWebSearch('rust async', 10, keylessNet(retried, () => ok('<html></html>', 'text/html')), { ignoreCooldown: true });
    expect(retried.length).toBeGreaterThan(0);
    expect(outcome.ok).toBe(true);
  });

  it('CJK 相关性门：应答与查询无重叠 bigram → 结果被拒，降级后续层', async () => {
    // 查询含 ≥2 个显著 CJK bigram；serper 返回纯英文无关结果 → 门拒收，
    // 编排继续往下（这里后续层全空 → 空结果文案带 irrelevant 计数语义）。
    const calls: string[] = [];
    const unrelated = JSON.stringify({
      organic: [{ title: 'Angular framework', link: 'https://angular.dev/', snippet: 'web framework' }],
    });
    const outcome = await runWebSearch('重庆到成都的高铁时刻表', 10, {
      fetchPage: async (url) => {
        calls.push(url);
        return url.includes('serper.dev') ? ok(unrelated) : ok('<html></html>', 'text/html');
      },
      env: (key) => (key === 'SERPER_API_KEY' ? 'test-key' : ''),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.output).not.toContain('angular.dev');
    // 被拒后编排没有提前收尾：HTML/结构化扇出仍被尝试过。
    expect(calls.some((u) => !u.includes('serper.dev'))).toBe(true);
  });

  it('成功结果写缓存（cacheSet 收到编排输出）', async () => {
    let stored: { key: string; value: string; ttlMs: number } | null = null;
    await runWebSearch('rust async', 10, {
      ...serperOnlyNet([]),
      cacheGet: () => undefined,
      cacheSet: (key, value, ttlMs) => {
        stored = { key, value, ttlMs };
      },
    });
    expect(stored).not.toBeNull();
    expect(stored!.value).toContain('https://rust-lang.org/');
    expect(stored!.ttlMs).toBe(15 * 60 * 1000);
  });
});

describe('resultsRelevant 纯函数判例（原 Rust relevance_gate 行为锁随收敛刀搬 TS）', () => {
  // 2026-11-03 真机案例 session_1793706272041_1：cn.bing.com 用天眼查
  // 企业/税号页回答「西安未来7天天气预报」。查询的显著 bigram
  // 西安/安未/天天/天气/气预/预报 在垃圾集 0 覆盖 → 拒收，竞速滚动到
  // 下一个后端，而不是把诱发反复搜索的垃圾递给模型。
  const garbage = [
    {
      title: '南方电网公司企业信息免费查询平台_年报/公示信息查询 - 天眼查',
      snippet: '南方电网公司 热门公司有哪些？天眼查热门公司频道为您提供南方电网公司企业查询、公司查询、工商信息查询',
      url: 'https://www.tianyancha.com/8509c0',
    },
    {
      title: '至本医疗科技（上海）有限公司税号查询_纳税人识别号',
      snippet: '至本医疗科技 (上海) 有限公司，成立于2016年，位于上海市',
      url: 'https://tax.tianyancha.com/3052820770',
    },
  ];

  it('0 覆盖的垃圾集被拒收', () => {
    expect(resultsRelevant('西安未来7天天气预报', garbage)).toBe(false);
  });

  it('覆盖 ≥2 个显著 bigram 的真实结果被接受', () => {
    const real = [{
      title: '西安天气预报7天查询',
      snippet: '西安未来7天天气预报，今日多云，气温 8~14°C',
      url: 'https://www.weather.com.cn/xian7d',
    }];
    expect(resultsRelevant('西安未来7天天气预报', real)).toBe(true);
  });

  it('显著 bigram <2 的查询恒接受（无法判断）', () => {
    expect(resultsRelevant('的了吗', garbage)).toBe(true);
  });

  it('非 CJK 查询恒接受', () => {
    expect(resultsRelevant('rust async runtime', garbage)).toBe(true);
  });
});
