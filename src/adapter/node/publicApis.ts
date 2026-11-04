// src/adapter/node/publicApis.ts
// Tier-2 公共 API 直查的 CLI 装配层。解析器栈的单源在
// tools/impl/publicApi（P2-5 收敛刀：此前与 Rust web_public_api.rs 双份
// 养护、行为漂移不可控，现已绞杀归一，Rust 模块随刀退役）。
// 本文件只剩三件事：把 cliFetch/webCache 注入单源的 PublicApiDeps、保持
// 旧的函数签名（cachedDirectPublicApi(query, category?, location?) 等）
// 让调用方与测试零改动、re-export 仍在用的类型与常量。

import { webCache } from './webCache';
// 出口代理语义与 web_fetch 的兜底链共用同一份实现：结构化 API 后端
// （Open-Meteo / ipify / Frankfurter / 腾讯行情）在墙内同样可能不可达，
// 直连死掉时不能让它们静默降级成「查不到数据」——那会被模型读成事实。
import { cliFetch } from '../../shared/cliFetch';
import {
  cachedDirectPublicApi as cachedDirectPublicApiImpl,
  fetchStockSina as fetchStockSinaImpl,
  fetchStockTencent as fetchStockTencentImpl,
  tryDirectPublicApi as tryDirectPublicApiImpl,
  type PageFetchFn,
  type PublicApiDeps,
  type PublicApiOptions,
  type PublicApiOutcome,
} from '../../tools/impl/publicApi';

export type {
  FxRequest,
  IntentKind,
  PublicApiOutcome,
  PublicApiOptions,
} from '../../tools/impl/publicApi';
export {
  classifyIntent,
  describeWmoCode,
  extractLocation,
  isBuildRequest,
  parseFxQuery,
  PUBLIC_API_TTL_MS,
  publicApiCacheKey,
  resolveStockSymbol,
} from '../../tools/impl/publicApi';
// BackendQuota / quota 的单源在 tools/impl/webSearch（P2-5 收敛：搜索编排
// 与这层的冷却共用同一实例，Web 端 WebView 也跑同一份）。
export { BackendQuota, quota } from '../../tools/impl/webSearch';
export { parseRssItems, type RssItem } from '../../tools/impl/webSearch';

/** CLI 侧的 PublicApiDeps 装配：网络走 cliFetch（env 代理自动），缓存直读
 * 共享盘 ~/.pure/cache/web-cache.json（与 GUI 同键同盘）。 */
function publicApiDeps(): PublicApiDeps {
  const fetchPage: PageFetchFn = async (url, init) => {
    const resp = await cliFetch(url, {
      headers: init?.headers,
      method: init?.method,
      body: init?.body,
      redirect: 'follow',
      ...(init?.timeoutMs ? { signal: AbortSignal.timeout(init.timeoutMs) } : {}),
    });
    return {
      status: resp.status,
      finalUrl: resp.url || url,
      contentType: resp.headers.get('content-type') || '',
      setCookie: resp.headers.get('set-cookie'),
      body: new Uint8Array(await resp.arrayBuffer()),
    };
  };
  return {
    fetchPage,
    cacheGet: (key) => webCache().get(key),
    cacheSet: (key, value, ttlMs) => webCache().set(key, value, ttlMs),
  };
}

/** 旧签名保持：调用方（NodeToolAdapter fast path / handleWebPublicApi）与
 * publicApis.test.ts 零改动。 */
export async function cachedDirectPublicApi(
  query: string,
  category?: string,
  location?: string,
): Promise<{ outcome: PublicApiOutcome | null; cached: boolean }> {
  return cachedDirectPublicApiImpl(query, category, location, publicApiDeps());
}

export async function tryDirectPublicApi(query: string, opts: PublicApiOptions = {}) {
  return tryDirectPublicApiImpl(query, publicApiDeps(), opts);
}

export async function fetchStockTencent(symbol: string): Promise<string | null> {
  return fetchStockTencentImpl(publicApiDeps(), symbol);
}

export async function fetchStockSina(symbol: string): Promise<string | null> {
  return fetchStockSinaImpl(publicApiDeps(), symbol);
}
