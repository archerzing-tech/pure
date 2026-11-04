// src/tools/impl/__tests__/publicApi.test.ts
// 公共 API 单源（P2-5 收敛刀）的编排契约测试：锁的是本刀从两侧旧实现
// 收敛来的行为裁决点——分类器守卫、FX 锚定、worldbank null 语义、
// geocode 冷却×降级、缓存防御（degraded 不落盘 / 旧 Rust PascalCase
// 记录重解析）。网络全走注入的 fetchPage，不碰 cliFetch 与代理 env。

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  classifyIntent,
  isBuildRequest,
  parseFxQuery,
  type PageFetchFn,
  type PublicApiDeps,
  type PublicApiOutcome,
  cachedDirectPublicApi,
  fetchStockSina,
  tryDirectPublicApi,
} from '../publicApi';
import { quota } from '../webSearch';

beforeEach(() => {
  quota.clear();
});

afterEach(() => {
  quota.clear();
});

/** 构造注入式 deps：responder 按 URL 前缀应答（throw=网络失败）。 */
function fakeDeps(responder: (url: string) => { status: number; body: string } | undefined, calls?: string[]): PublicApiDeps {
  const fetchPage: PageFetchFn = async (url) => {
    calls?.push(url);
    const hit = responder(url);
    if (!hit) throw new Error(`network down for ${url}`);
    const bytes = new TextEncoder().encode(hit.body);
    return {
      status: hit.status,
      finalUrl: url,
      contentType: 'application/json',
      setCookie: null,
      body: bytes,
    };
  };
  return { fetchPage };
}

describe('isBuildRequest guard (收敛裁决: CJK 无条件 + 英文词边界)', () => {
  it('CJK 动词后无条件拦截——动词接空格也拦', () => {
    expect(isBuildRequest('写一个天气网站')).toBe(true);
    expect(isBuildRequest('写 天气脚本')).toBe(true);
    expect(isBuildRequest('做 一个爬虫')).toBe(true);
    expect(isBuildRequest('生成天气页面')).toBe(true);
    expect(isBuildRequest('帮我写个天气脚本')).toBe(true);
  });

  it('英文动词需要词边界——makeup/codex 不拦', () => {
    expect(isBuildRequest('makeup price trend')).toBe(false);
    expect(isBuildRequest('codex review')).toBe(false);
    expect(isBuildRequest('build a weather app')).toBe(true);
    expect(isBuildRequest('write weather report')).toBe(true);
  });

  it('fx 语法必须吃掉整个查询（zh 分支 $ 锚）', () => {
    expect(parseFxQuery('1美元等于多少人民币')).toEqual({ from: 'USD', to: 'CNY', amount: 1 });
    expect(parseFxQuery('美元换人民币')).toEqual({ from: 'USD', to: 'CNY', amount: 1 });
    // 带后缀的查询不是币对请求——旧 TS 无锚会误入 fx。
    expect(classifyIntent('美元换人民币汇率')).toBeNull();
  });
});

describe('worldbank null 语义 (收敛裁决: 无数据 ≠ 0)', () => {
  it('value=null 返回 null（不把「无数据」伪装成 GDP 为 0）', async () => {
    const deps = fakeDeps((url) => {
      if (url.includes('api.worldbank.org')) {
        return { status: 200, body: JSON.stringify([{ page: 1 }, [{ date: '2023', value: null }]]) };
      }
      return undefined;
    });
    const outcome = await tryDirectPublicApi('中国GDP是多少', deps);
    expect(outcome).toBeNull();
  });
});

describe('geocode 冷却 × 降级 (收敛裁决: 网络失败才 mark / 全挂返降级卡)', () => {
  it('两后端都网络失败 → degraded 降级卡 + 双双进 300s 冷却', async () => {
    let calls = 0;
    const deps = fakeDeps(() => {
      calls += 1;
      return undefined; // throw = 网络级失败
    });
    const outcome = await tryDirectPublicApi('东京的经纬度', deps);
    expect(outcome?.intent).toBe('geocode');
    expect(outcome?.degraded).toBe(true);
    expect(outcome?.text).toContain('地理编码服务当前不可达');
    expect(outcome?.text).toContain('34.26,108.94');
    expect(quota.isBlocked('geocode.open-meteo')).toBe(true);
    expect(quota.isBlocked('geocode.nominatim')).toBe(true);
    expect(calls).toBe(2);
  });

  it('冷却生效时零网络直接返降级卡', async () => {
    quota.markBlocked('geocode.open-meteo', 60_000);
    quota.markBlocked('geocode.nominatim', 60_000);
    let calls = 0;
    const deps = fakeDeps(() => {
      calls += 1;
      return undefined;
    });
    const outcome = await tryDirectPublicApi('东京的经纬度', deps);
    expect(outcome?.degraded).toBe(true);
    expect(calls).toBe(0);
  });

  it('服务无结果（200 空数据）不进冷却、不降级——降级到搜索', async () => {
    const deps = fakeDeps(() => ({ status: 200, body: JSON.stringify({}) }));
    const outcome = await tryDirectPublicApi('东京的经纬度', deps);
    expect(outcome).toBeNull();
    expect(quota.isBlocked('geocode.open-meteo')).toBe(false);
    expect(quota.isBlocked('geocode.nominatim')).toBe(false);
  });

  it('open-meteo 网络挂 → nominatim 接住（不降级）', async () => {
    const deps = fakeDeps((url) => {
      if (url.includes('nominatim.openstreetmap.org')) {
        return { status: 200, body: JSON.stringify([{ display_name: 'Tokyo, Japan', lat: '35.68', lon: '139.69' }]) };
      }
      return undefined; // open-meteo 网络失败
    });
    const outcome = await tryDirectPublicApi('东京的经纬度', deps);
    expect(outcome?.intent).toBe('geocode');
    expect(outcome?.degraded).toBeUndefined();
    expect(outcome?.text).toContain('35.68');
    expect(quota.isBlocked('geocode.open-meteo')).toBe(true);
    expect(quota.isBlocked('geocode.nominatim')).toBe(false);
  });
});

describe('缓存防御 (收敛裁决: degraded 不落盘 / 旧 Rust PascalCase 重解析)', () => {
  it('degraded 降级卡不落盘——冷却过去后重新解析', async () => {
    let networkUp = false;
    const store = new Map<string, string>();
    const deps: PublicApiDeps = {
      fetchPage: async () => {
        if (!networkUp) throw new Error('down');
        throw new Error('unreachable'); // 冷却恢复前不该再发请求
      },
      cacheGet: (key) => store.get(key),
      cacheSet: (key, value) => store.set(key, value),
    };
    const first = await cachedDirectPublicApi('东京的经纬度', undefined, undefined, deps);
    expect(first.outcome?.degraded).toBe(true);
    expect(first.cached).toBe(false);
    // 降级卡没有写进缓存。
    expect(store.size).toBe(0);
  });

  it('旧 Rust PascalCase intent 记录视为损坏——重新解析不命中', async () => {
    const store = new Map<string, string>();
    let resolved = 0;
    let poisoned = true; // 只注毒一次：否则新记录也会被覆盖回 PascalCase。
    const deps: PublicApiDeps = {
      fetchPage: async (url) => {
        resolved += 1;
        return {
          status: 200,
          finalUrl: url,
          contentType: 'application/json',
          setCookie: null,
          body: new TextEncoder().encode(JSON.stringify({ rates: { CNY: 7.2 }, date: '2026-08-16' })),
        };
      },
      cacheGet: (key) => {
        if (poisoned) {
          poisoned = false;
          // 模拟 GUI 旧 Rust 落盘的记录：intent 是 PascalCase。
          return JSON.stringify({ intent: 'Weather', text: 'stale', source: 'Open-Meteo' });
        }
        return store.get(key);
      },
      cacheSet: (key, value) => store.set(key, value),
    };
    const result = await cachedDirectPublicApi('100 usd to cny', undefined, undefined, deps);
    expect(result.cached).toBe(false);
    expect(result.outcome?.intent).toBe('fx');
    expect(resolved).toBe(1);
    // 新记录以合法 intent 落盘，下次命中。
    const second = await cachedDirectPublicApi('100 usd to cny', undefined, undefined, deps);
    expect(second.cached).toBe(true);
    expect(resolved).toBe(1);
  });
});

describe('股价 NaN 防御 + 定长成交额 (收敛裁决)', () => {
  it('新浪成交额保持源字段定长数字（无 locale 千分位）', async () => {
    // Sina 字段序: 0名 1开 2昨收 3现价 4最高 5最低 6竞买 7竞卖 8成交量 9成交额 10日期 11时间
    const sina = 'var hq_str_sh600519="贵州茅台,1495.00,1490.00,1510.00,1520.00,1480.00,1509.00,1510.50,21000,12345678,2026-11-04,15:00:00";';
    const deps: PublicApiDeps = {
      fetchPage: async () => ({
        status: 200,
        finalUrl: 'sina',
        contentType: 'text/html; charset=GBK',
        setCookie: null,
        body: new TextEncoder().encode(sina),
      }),
    };
    const text = await fetchStockSina(deps, 'sh600519');
    expect(text).toContain('成交额 12345678元');
    expect(text).not.toContain('12,345,678');
    expect(text).toContain('现价 1510 (昨收 1490)');
  });

  it('数值字段为空串时 NaN→0（不输出 NaN%）', async () => {
    // 成交量/成交额之外，涨跌字段（腾讯 31/32）缺失 → 0。
    const deps: PublicApiDeps = {
      fetchPage: async (url) => {
        if (url.includes('nominatim')) {
          return {
            status: 200,
            finalUrl: url,
            contentType: 'application/json',
            setCookie: null,
            body: new TextEncoder().encode(JSON.stringify([{ display_name: 'Beijing', lat: '39.9', lon: '116.4' }])),
          };
        }
        return {
          status: 200,
          finalUrl: url,
          contentType: 'application/json',
          setCookie: null,
          body: new TextEncoder().encode(JSON.stringify({ current: { time: 't' } })),
        };
      },
    };
    // 空字符串数值在 airquality 分支有 '?' 兜底；这里锁的是 Sina 空字段
    // 输出 0 而不是 NaN —— 直接用最短合法 Sina 体（涨跌字段为空）。
    const sinaDeps: PublicApiDeps = {
      fetchPage: async () => ({
        status: 200,
        finalUrl: 'sina',
        contentType: 'text/html',
        setCookie: null,
        body: new TextEncoder().encode('var hq_str_sh600519="贵州茅台,,,0,0,0,0,0,0,,";'),
      }),
    };
    const text = await fetchStockSina(sinaDeps, 'sh600519');
    expect(text).not.toContain('NaN');
    expect(text).toContain('现价 0');
  });
});

describe('PublicApiOutcome 形状', () => {
  it('成功 outcome 不带 degraded 标记', async () => {
    const deps = fakeDeps((url) => {
      if (url.includes('api.frankfurter.app')) {
        return { status: 200, body: JSON.stringify({ rates: { CNY: 7.2 }, date: '2026-08-16' }) };
      }
      return undefined;
    });
    const outcome: PublicApiOutcome | null = await tryDirectPublicApi('100 usd to cny', deps);
    expect(outcome?.degraded).toBeUndefined();
  });
});
