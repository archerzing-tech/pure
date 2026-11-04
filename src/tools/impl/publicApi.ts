// src/tools/impl/publicApi.ts
// Web Public API（Tier-2）解析器栈的单源实现（P2-5 收敛刀）：结构化直查的
// 意图分类器 + 10 个 resolver（天气/空气质量/地理编码/新闻/wiki/IP/汇率/
// 股价/GitHub/世界银行）。此前 CLI（src/adapter/node/publicApis.ts）与 GUI
// （src-tauri/src/web_public_api.rs，1318 行）各养一份、行为漂移不可控；
// 本刀绞杀归一到 TS，Rust 模块随刀退役。
//
// 零 node 依赖：网络走注入的 fetchPage 原语（CLI=cliFetch 包装，GUI=Rust
// fetch_page command + 学习到的 proxyUrl），缓存走 cacheGet/cacheSet 原语
// （CLI=webCache() 直读，GUI=web_cache_get/set IPC，同键同盘）。公共 API
// 全部免 key，因此没有 env 原语。cookie jar 不参与（全是 API 直查，无
// 反爬会话）。

import {
  containsCJK,
  decodeBody,
  fnv1a64,
  normalizeQuery,
  parseRssItems,
  quota,
  type PageFetchFn,
} from './webSearch';

export type { PageFetchFn };

/** HTTP 原语注入面：与 webSearch 的 WebSearchDeps 同形状（fetchPage 完全
 * 复用，两刀共用同一 CLI/GUI 包装）。缓存读写可异步（GUI 经 IPC）。 */
export interface PublicApiDeps {
  fetchPage: PageFetchFn;
  cacheGet?: (key: string) => string | undefined | Promise<string | undefined>;
  cacheSet?: (key: string, value: string, ttlMs: number) => void;
}

export type IntentKind = 'weather' | 'airquality' | 'geocode' | 'news' | 'wiki' | 'ip' | 'fx' | 'stock' | 'github' | 'worldbank';

export interface PublicApiOutcome {
  intent: IntentKind;
  /** Human-readable answer text, ready to hand to the model. */
  text: string;
  /** Source label for the result, e.g. "Open-Meteo". */
  source: string;
  /** 降级卡（如「地理编码服务不可达」）——形态是成功但内容不是答案。
   * cachedDirectPublicApi 见 degraded 不落盘：旧 Rust 把降级卡缓存 30 天
   * （geocode TTL），服务恢复后仍在回答「不可达」。 */
  degraded?: boolean;
}

// ── Result cache (per-intent TTLs) ──
// Structured answers have very different freshness needs: weather/stock/news
// change constantly, geocode/wiki barely ever. The TTL table below drives the
// cache; see webCache.ts for the shared file layout (CLI + GUI).

export const PUBLIC_API_TTL_MS: Record<IntentKind, number> = {
  weather: 20 * 60 * 1000,
  airquality: 30 * 60 * 1000,
  news: 10 * 60 * 1000,
  stock: 10 * 60 * 1000,
  fx: 6 * 60 * 60 * 1000,
  ip: 24 * 60 * 60 * 1000,
  github: 24 * 60 * 60 * 1000,
  geocode: 30 * 24 * 60 * 60 * 1000,
  wiki: 7 * 24 * 60 * 60 * 1000,
  worldbank: 7 * 24 * 60 * 60 * 1000,
};

/** Key for direct public-API outcomes (query + optional forced category +
 * location — weather answers differ by city). 与 adapter/node/webCache 的
 * 旧键完全同形：同一 FNV-1a、同一键序，盘上缓存键历史兼容。 */
export function publicApiCacheKey(query: string, category: string | undefined, location: string | undefined): string {
  return fnv1a64(['publicapi', category ?? '', normalizeQuery(query), location ?? '']);
}

// ── Intent classifier ──
// Deterministic keyword routing with conservative length caps + a build-request
// guard, so "写一个天气网站" can never be answered with weather data instead of
// being treated as a coding request. Only HIGH-confidence intents auto-route
// inside web_search; the model-facing web_public_api tool may force a category.

const WEATHER_WORDS = /天气|气温|温度|预报|会不会下雨|降雨|降雪|风力|湿度|weather|forecast|temperature|rain|snow|humidity|wind/i;
const AIR_QUALITY_WORDS = /空气质量|空气指数|空气污染|雾霾|霾|pm2\.?5|pm10|AQI|air quality|air pollution|air index/i;
const WORLD_BANK_WORDS = /gdp|国内生产总值|人均gdp|人口|总人口|失业率|通胀|通货膨胀|world bank|世界银行|population|unemployment|inflation/i;
const TIME_WORDS = /今天|明天|后天|昨天|早上|上午|中午|下午|晚上|夜里|下周|上周|这周|周末|周[一二三四五六日天]|today|tomorrow|yesterday|this|next|last|week|morning|afternoon|evening|night|in|the|for|at|what|is|like|now|的|怎么样|如何|呢|吧|啊/g;
const PUNCT = /[，。？?！!、,.，\s]+/g;
const GEOCODE_WORDS = /经纬度|坐标|geocode|latitude|longitude|lat\s*\/?\s*lon|地理坐标/i;
const NEWS_WORDS = /新闻|资讯|头条|快讯|时讯|热点|报道|新闻头条|news|headlines|breaking/i;
const WIKI_WORDS = /维基|百科|是什么|是谁|简介|wikipedia|wiki/i;
const IP_WORDS = /(?:我的)?\s*(?:ip地址|ip 地址|本机ip|外网ip|ip)$|(?:what is|my)?\s*(?:ip address|my ip)\b|ip地址|IP地址/i;
const GITHUB_WORDS = /\bgithub\b|开源项目|最火的.*仓库|star.*最多/i;

/** True for requests that want something BUILT (never auto-route these).
 * CJK 动词前缀无条件拦截：JS 的 lookahead 形态（原 CLI 版）在动词后接
 * 空格时会漏拦（「写 天气脚本」被误路由成天气）——中文请求动词后无条件
 * 视为 build（对齐旧 Rust is_build_request）。英文动词需词边界，否则
 * "makeup" / "codex" 永远命中。 */
export function isBuildRequest(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  if (/^(?:写|做|建|造|生成|开发|设计|创建一个|帮我(?:写|做|建|造|开发|设计|生成|创建一个))/.test(q)) return true;
  return /^(?:make|build|create|write|generate|design|develop|code)(?=$|[^a-zA-Z0-9_])/i.test(q);
}

/** Classify a query's structured-data intent, or null when it does not fit. */
export function classifyIntent(query: string): IntentKind | null {
  const q = query.trim();
  if (!q) return null;
  if (isBuildRequest(q)) return null;

  if (WEATHER_WORDS.test(q) && q.length <= 40) return 'weather';
  if (AIR_QUALITY_WORDS.test(q) && q.length <= 60) return 'airquality';
  if (GEOCODE_WORDS.test(q) && q.length <= 60) return 'geocode';
  // FX first checks the parseable currency-pair grammar, not just keywords.
  if (parseFxQuery(q)) return 'fx';
  if (IP_WORDS.test(q) && q.length <= 40) return 'ip';
  if (NEWS_WORDS.test(q) && q.length <= 60) return 'news';
  if (WIKI_WORDS.test(q) && q.length <= 60) return 'wiki';
  if (GITHUB_WORDS.test(q) && q.length <= 60) return 'github';
  if (resolveStockSymbol(q) && q.length <= 40) return 'stock';
  if (WORLD_BANK_WORDS.test(q) && q.length <= 60 && worldbankIndicator(q) && worldbankCountry(q)) return 'worldbank';
  return null;
}

/** Extract a location name from a weather/geocode query ("北京明天天气" → 北京). */
export function extractLocation(query: string): string {
  return query
    .replace(WEATHER_WORDS, ' ')
    .replace(TIME_WORDS, ' ')
    .replace(PUNCT, ' ')
    .trim();
}

/** Extract a location name from an air-quality query ("北京PM2.5" → 北京). */
function extractAirQualityLocation(query: string): string {
  return query
    .replace(AIR_QUALITY_WORDS, ' ')
    .replace(TIME_WORDS, ' ')
    .replace(PUNCT, ' ')
    .trim();
}

// ── FX parsing ──

const CURRENCY: Record<string, string> = {
  美元: 'USD', 美金: 'USD', 人民币: 'CNY', 日元: 'JPY', 欧元: 'EUR', 英镑: 'GBP',
  港币: 'HKD', 韩元: 'KRW', 卢布: 'RUB', 澳元: 'AUD', 加元: 'CAD', 新台币: 'TWD',
  新加坡元: 'SGD', 泰铢: 'THB', 卢比: 'INR', 巴西雷亚尔: 'BRL',
};

const CURRENCY_CODES = 'USD|CNY|JPY|EUR|GBP|HKD|KRW|RUB|AUD|CAD|TWD|SGD|THB|INR|BRL|CHF';

export interface FxRequest {
  from: string;
  to: string;
  amount: number;
}

/** Parse "100 USD to CNY", "usd cny", "1美元等于多少人民币", "美元汇率". */
export function parseFxQuery(query: string): FxRequest | null {
  const q = query.trim();
  // English pair: [amount] CODE to/in CODE
  const en = q.match(new RegExp(`^(\\d+(?:\\.\\d+)?)?\\s*(${CURRENCY_CODES})\\s*(?:to|in|→|->|兑|换成|换)?\\s*(${CURRENCY_CODES})$`, 'i'));
  if (en) {
    return { from: en[2].toUpperCase(), to: en[3].toUpperCase(), amount: en[1] ? Number(en[1]) : 1 };
  }
  // Chinese pair: N 美元等于多少人民币 / N 美元换人民币 / 美元兑人民币。
  // 结尾锚定（对齐旧 Rust）：无锚时「美元换人民币汇率」这类带后缀的查询
  // 会误入 fx——币对语法必须吃掉整个查询才算数。
  const zhCur = Object.keys(CURRENCY).join('|');
  const zh = q.match(new RegExp(`^(\\d+(?:\\.\\d+)?)?\\s*(${zhCur})(?:等于多少|换成多少|是多少|等于|换成|兑换成|兑|换|折合|多少)?\\s*(${zhCur})$`, 'i'));
  if (zh) {
    return { from: CURRENCY[zh[2]], to: CURRENCY[zh[3]], amount: zh[1] ? Number(zh[1]) : 1 };
  }
  // Bare single currency: "美元汇率" / "usd rate" → USD → CNY baseline.
  const single = q.match(new RegExp(`^(\\d+(?:\\.\\d+)?)?\\s*(${zhCur}|${CURRENCY_CODES})(?:汇率|兑人民币|换成人民币|和人民币|对人民币|rate)?$`, 'i'));
  if (single) {
    const code = /^[A-Z]{3}$/i.test(single[2]) ? single[2].toUpperCase() : CURRENCY[single[2]];
    if (!code) return null;
    return { from: code, to: 'CNY', amount: single[1] ? Number(single[1]) : 1 };
  }
  return null;
}

// ── Stock symbol resolution ──

const KNOWN_STOCKS: Record<string, string> = {
  苹果: 'usAAPL', aapl: 'usAAPL', apple: 'usAAPL',
  特斯拉: 'usTSLA', tsla: 'usTSLA', tesla: 'usTSLA',
  英伟达: 'usNVDA', nvda: 'usNVDA', 微软: 'usMSFT', msft: 'usMSFT',
  谷歌: 'usGOOGL', 亚马逊: 'usAMZN', amzn: 'usAMZN', meta: 'usMETA',
  阿里巴巴: 'usBABA', baba: 'usBABA', 拼多多: 'usPDD', pdd: 'usPDD', 京东: 'usJD', jd: 'usJD',
  腾讯: 'hk00700', 腾讯控股: 'hk00700', 美团: 'hk03690', 小米: 'hk01810',
  茅台: 'sh600519', 贵州茅台: 'sh600519', 比亚迪: 'sz002594', 宁德时代: 'sz300750',
  中国平安: 'sh601318', 工商银行: 'sh601398', 招商银行: 'sh600036', 中国石油: 'sh601857',
};

/** Resolve a stock query to a Tencent-format symbol (sh600519 / usAAPL / hk00700). */
export function resolveStockSymbol(query: string): string | null {
  const q = query.trim().toLowerCase();
  for (const [name, symbol] of Object.entries(KNOWN_STOCKS)) {
    if (q.includes(name.toLowerCase())) return symbol;
  }
  // Explicit market codes: sh600519 / sz000001 / hk00700 / 0700.hk / aapl.us
  // (HK tickers are commonly written 4-digit, e.g. 0700.hk / hk0700; the
  // resolved Tencent symbol always pads to 5 digits — 00700.)
  const market = q.match(/\b(sh|sz)\d{6}\b|\bhk\d{4,5}\b|\b\d{4,5}\.hk\b|\b[a-z]{1,5}\.(us|hk|sh|sz)\b/i);
  if (market) {
    const m = market[0].toLowerCase();
    if (m.startsWith('sh') || m.startsWith('sz')) return m;
    if (m.startsWith('hk')) return `hk${m.slice(2).padStart(5, '0')}`;
    const [ticker, marketCode] = m.split('.');
    return marketCode === 'hk' ? `hk${ticker.padStart(5, '0')}` : `us${ticker.toUpperCase()}`;
  }
  // Bare ticker-ish token (2-5 letters) → US listing, only when it is the WHOLE query.
  const bare = q.match(/^[a-z]{2,5}$/);
  if (bare) return `us${bare[0].toUpperCase()}`;
  return null;
}

// ── WMO weather code → description ──

const WMO_DESC_EN: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog', 51: 'Light drizzle', 53: 'Drizzle',
  55: 'Dense drizzle', 56: 'Freezing drizzle', 57: 'Dense freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light rain showers', 81: 'Rain showers', 82: 'Violent rain showers',
  85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm',
  96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
};
const WMO_DESC_ZH: Record<number, string> = {
  0: '晴', 1: '基本晴朗', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇', 51: '小毛毛雨', 53: '毛毛雨', 55: '浓毛毛雨',
  56: '冻毛毛雨', 57: '浓冻毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
};

export function describeWmoCode(code: number, zh: boolean): string {
  return (zh ? WMO_DESC_ZH : WMO_DESC_EN)[code] ?? `code ${code}`;
}

// ── HTTP primitives (fetchPage wrappers) ──
// 公共 API 全是 JSON/文本直查：非 2xx 与解析失败一律 null（resolver 据此
// 降级），网络层异常也吞成 null —— 与两侧旧实现语义一致（resolve 失败
// 返回 null，调用方降级到搜索而不是错误墙）。

import { BROWSER_UA } from '../../shared/platformUa';

async function fetchJsonVia(deps: PublicApiDeps, url: string, timeoutMs = 8000, headers: Record<string, string> = {}): Promise<any | null> {
  try {
    const r = await deps.fetchPage(url, {
      headers: { 'User-Agent': BROWSER_UA, ...headers },
      timeoutMs,
    });
    if (r.status < 200 || r.status >= 300) return null;
    return JSON.parse(decodeBody(r));
  } catch {
    return null;
  }
}

async function fetchTextVia(deps: PublicApiDeps, url: string, timeoutMs = 8000, headers: Record<string, string> = {}): Promise<string | null> {
  try {
    const r = await deps.fetchPage(url, {
      headers: { 'User-Agent': BROWSER_UA, ...headers },
      timeoutMs,
    });
    if (r.status < 200 || r.status >= 300) return null;
    return decodeBody(r);
  } catch {
    return null;
  }
}

/** 与 fetchJsonVia 同形，但网络层异常上抛（geocode 要区分「网络挂了」与
 * 「服务说没有」——只有前者进 300s 冷却）。 */
async function fetchJsonStrict(deps: PublicApiDeps, url: string, timeoutMs = 8000): Promise<any | null> {
  const r = await deps.fetchPage(url, { headers: { 'User-Agent': BROWSER_UA }, timeoutMs });
  if (r.status < 200 || r.status >= 300) return null;
  return JSON.parse(decodeBody(r));
}

// ── Resolver implementations (each returns null on any failure) ──

interface GeoResult { name: string; latitude: number; longitude: number; country?: string; }

interface GeocodeAttempt {
  /** 命中坐标；null = 两后端都没给出结果。 */
  geo: GeoResult | null;
  /** 两个后端都网络级不可达时的降级文案；null = 只是查无此地（不降级，
   * 调用方照旧返 null 走搜索）。 */
  degraded: string | null;
}

/** 地理编码冷却：网络级失败后 300s 内跳过该后端（对齐旧 Rust 的
 * backend_blocked）。服务无结果不 mark——「查无此地」不是故障，冷却它会
 * 把正常查询误判成服务不可达。 */
const GEOCODE_COOLDOWN_MS = 300 * 1000;

/** Open-Meteo geocoding first, Nominatim fallback (1 req/s, needs a UA). */
async function geocode(deps: PublicApiDeps, location: string): Promise<GeocodeAttempt> {
  const zh = containsCJK(location);
  let openMeteoDown = quota.isBlocked('geocode.open-meteo');
  let nominatimDown = quota.isBlocked('geocode.nominatim');
  if (!openMeteoDown) {
    try {
      const data = await fetchJsonStrict(
        deps,
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=${zh ? 'zh' : 'en'}&format=json`,
      );
      const first = Array.isArray(data?.results) ? data.results[0] : undefined;
      if (first?.latitude != null && first?.longitude != null) {
        return { geo: { name: first.name ?? location, latitude: first.latitude, longitude: first.longitude, country: first.country }, degraded: null };
      }
    } catch {
      openMeteoDown = true;
      quota.markBlocked('geocode.open-meteo', GEOCODE_COOLDOWN_MS);
    }
  }
  if (!nominatimDown) {
    try {
      const nomi = await fetchJsonStrict(
        deps,
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(location)}`,
        6000,
      );
      const n = Array.isArray(nomi) ? nomi[0] : undefined;
      if (n?.lat != null && n?.lon != null) {
        return { geo: { name: n.display_name ?? location, latitude: Number(n.lat), longitude: Number(n.lon) }, degraded: null };
      }
    } catch {
      nominatimDown = true;
      quota.markBlocked('geocode.nominatim', GEOCODE_COOLDOWN_MS);
    }
  }
  if (openMeteoDown && nominatimDown) {
    return {
      geo: null,
      degraded:
        '地理编码服务当前不可达（Open-Meteo 与 Nominatim 均不可达）。请勿再次调用本工具获取坐标：主要城市、山川与知名景区的坐标在你的知识范围内' +
        '（例如西安约 34.26,108.94；三门峡约 34.77,111.19），直接使用已知坐标继续任务即可；确需实时检索再改用 web_search。',
    };
  }
  return { geo: null, degraded: null };
}

async function resolveWeather(deps: PublicApiDeps, query: string, opts: { location?: string }): Promise<PublicApiOutcome | null> {
  let location = extractLocation(query);
  if (!location && opts.location) location = opts.location;
  if (!location) {
    return {
      intent: 'weather',
      source: 'Open-Meteo',
      text: '需要知道城市才能查天气（例如“北京天气”或“weather in Tokyo”）；未检测到城市，也没有配置默认位置。',
    };
  }
  const { geo } = await geocode(deps, location);
  if (!geo) return null;
  const data = await fetchJsonVia(
    deps,
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}` +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
      '&timezone=auto&forecast_days=3',
  );
  const cur = data?.current;
  const daily = data?.daily;
  if (!cur || !daily) return null;
  const zh = containsCJK(location) || containsCJK(query);
  const lines: string[] = [];
  lines.push(`${geo.name}${geo.country ? ` (${geo.country})` : ''} 天气 · ${data?.timezone ?? ''} · 数据时间 ${cur.time ?? ''}`);
  lines.push(
    `当前: ${cur.temperature_2m ?? '?'}°C (体感 ${cur.apparent_temperature ?? '?'}°C) ` +
    `${describeWmoCode(cur.weather_code ?? -1, zh)} · 湿度 ${cur.relative_humidity_2m ?? '?'}% · ` +
    `风速 ${cur.wind_speed_10m ?? '?'} km/h${cur.precipitation ? ` · 降水 ${cur.precipitation}mm` : ''}`,
  );
  if (Array.isArray(daily.time)) {
    for (let i = 0; i < Math.min(3, daily.time.length); i++) {
      const label = i === 0 ? (zh ? '今日' : 'Today') : i === 1 ? (zh ? '明日' : 'Tomorrow') : daily.time[i];
      lines.push(
        `${label}: ${daily.temperature_2m_max?.[i] ?? '?'}°C / ${daily.temperature_2m_min?.[i] ?? '?'}°C · ` +
        `${describeWmoCode(daily.weather_code?.[i] ?? -1, zh)}` +
        (daily.precipitation_probability_max?.[i] != null ? ` · 降水概率 ${daily.precipitation_probability_max[i]}%` : ''),
      );
    }
  }
  return { intent: 'weather', source: 'Open-Meteo', text: lines.join('\n') };
}

async function resolveGeocode(deps: PublicApiDeps, query: string): Promise<PublicApiOutcome | null> {
  const location = extractLocation(query);
  if (!location) return null;
  const { geo, degraded } = await geocode(deps, location);
  // 全后端网络不可达：返回降级卡（教模型改用已知坐标），degraded:true
  // 让缓存层跳过落盘——否则服务恢复后还在回答「不可达」。
  if (degraded) {
    return { intent: 'geocode', source: 'Open-Meteo/Nominatim', degraded: true, text: degraded };
  }
  if (!geo) return null;
  return {
    intent: 'geocode',
    source: 'Open-Meteo/Nominatim',
    text: `地理位置: ${geo.name}${geo.country ? ` (${geo.country})` : ''}\n纬度: ${geo.latitude}\n经度: ${geo.longitude}`,
  };
}

async function resolveAirQuality(deps: PublicApiDeps, query: string, opts: { location?: string }): Promise<PublicApiOutcome | null> {
  let location = extractAirQualityLocation(query);
  if (!location && opts.location) location = opts.location;
  if (!location) {
    return {
      intent: 'airquality',
      source: 'Open-Meteo Air Quality',
      text: '需要知道城市才能查空气质量（例如“北京空气质量”或“北京PM2.5”）；未检测到城市，也没有配置默认位置。',
    };
  }
  const { geo } = await geocode(deps, location);
  if (!geo) return null;
  const data = await fetchJsonVia(
    deps,
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${geo.latitude}&longitude=${geo.longitude}` +
      '&current=pm10,pm2_5,nitrogen_dioxide,us_aqi&timezone=auto',
  );
  const cur = data?.current;
  if (!cur) return null;
  const lines: string[] = [];
  lines.push(`${geo.name}${geo.country ? ` (${geo.country})` : ''} 空气质量 · 数据时间 ${cur.time ?? ''}`);
  const pm25 = cur.pm2_5 ?? '?';
  const pm10 = cur.pm10 ?? '?';
  const usAqi = cur.us_aqi ?? '?';
  let current = `当前: PM2.5 ${pm25} µg/m³ · PM10 ${pm10} µg/m³ · 美标 AQI ${usAqi}`;
  if (typeof cur.us_aqi === 'number') current += ` · ${describeAqi(cur.us_aqi)}`;
  lines.push(current);
  if (cur.nitrogen_dioxide != null) lines.push(`二氧化氮 NO₂: ${cur.nitrogen_dioxide} µg/m³`);
  return { intent: 'airquality', source: 'Open-Meteo Air Quality', text: lines.join('\n') };
}

/** US-AQI → six-level Chinese health label (近似国标阈值，供快速判断). */
function describeAqi(usAqi: number): string {
  if (usAqi <= 50) return '优';
  if (usAqi <= 100) return '良';
  if (usAqi <= 150) return '轻度污染';
  if (usAqi <= 200) return '中度污染';
  if (usAqi <= 300) return '重度污染';
  return '严重污染';
}

// (English match, ISO2 code, Chinese display name). CJK names match by
// substring; English names require word boundaries so "us" never matches
// "must" / "house". Longest-first ordering lets "united states" beat "us".
const WORLD_BANK_COUNTRIES: Array<[string, string, string]> = [
  ['中国', 'CN', '中国'], ['美国', 'US', '美国'], ['日本', 'JP', '日本'], ['德国', 'DE', '德国'],
  ['英国', 'GB', '英国'], ['法国', 'FR', '法国'], ['印度', 'IN', '印度'], ['韩国', 'KR', '韩国'],
  ['俄罗斯', 'RU', '俄罗斯'], ['巴西', 'BR', '巴西'], ['加拿大', 'CA', '加拿大'],
  ['澳大利亚', 'AU', '澳大利亚'], ['澳洲', 'AU', '澳大利亚'], ['意大利', 'IT', '意大利'], ['新加坡', 'SG', '新加坡'],
  ['united states', 'US', '美国'], ['south korea', 'KR', '韩国'], ['united kingdom', 'GB', '英国'],
  ['china', 'CN', '中国'], ['japan', 'JP', '日本'], ['germany', 'DE', '德国'], ['france', 'FR', '法国'],
  ['india', 'IN', '印度'], ['korea', 'KR', '韩国'], ['russia', 'RU', '俄罗斯'], ['brazil', 'BR', '巴西'],
  ['canada', 'CA', '加拿大'], ['australia', 'AU', '澳大利亚'], ['italy', 'IT', '意大利'], ['singapore', 'SG', '新加坡'],
  ['usa', 'US', '美国'], ['uk', 'GB', '英国'], ['us', 'US', '美国'],
];

function asciiWordMatch(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(haystack);
}

function worldbankCountry(query: string): string | null {
  const q = query.toLowerCase();
  for (const [name, code] of WORLD_BANK_COUNTRIES) {
    if (/[㐀-鿿]/.test(name)) {
      if (query.includes(name)) return code;
    } else if (asciiWordMatch(q, name)) {
      return code;
    }
  }
  return null;
}

/** World Bank indicator lookup. "人口" is ambiguous ("人口老龄化"), so it
 * requires a count/lookup signal alongside. */
function worldbankIndicator(query: string): { code: string; label: string; percent: boolean } | null {
  const q = query.toLowerCase();
  if (q.includes('人均gdp') || q.includes('人均国内生产总值') || q.includes('gdp per capita')) {
    return { code: 'NY.GDP.PCAP.CD', label: '人均GDP(现价美元)', percent: false };
  }
  if (q.includes('gdp') || q.includes('国内生产总值')) {
    return { code: 'NY.GDP.MKTP.CD', label: 'GDP(现价美元)', percent: false };
  }
  if ((q.includes('人口') || q.includes('population'))
    && (q.includes('多少') || q.includes('总数') || q.includes('数量') || q.includes('几') || q.includes('how many'))) {
    return { code: 'SP.POP.TOTL', label: '人口总数', percent: false };
  }
  if (q.includes('失业率') || q.includes('unemployment')) {
    return { code: 'SL.UEM.TOTL.ZS', label: '失业率', percent: true };
  }
  if (q.includes('通胀') || q.includes('通货膨胀') || q.includes('inflation')) {
    return { code: 'FP.CPI.TOTL.ZG', label: '通胀率', percent: true };
  }
  return null;
}

async function resolveWorldbank(deps: PublicApiDeps, query: string): Promise<PublicApiOutcome | null> {
  const indicator = worldbankIndicator(query);
  if (!indicator) return null;
  const code = worldbankCountry(query);
  if (!code) return null;
  const data = await fetchJsonVia(
    deps,
    `https://api.worldbank.org/v2/country/${code}/indicator/${indicator.code}?format=json&per_page=1`,
  );
  const entry = Array.isArray(data) ? data[1]?.[0] : undefined;
  const rawValue = entry?.value;
  const value = typeof rawValue === 'number' ? rawValue : Number(rawValue);
  // value=null（该国该年无数据）必须返回 null 而不是 0——Number(null)=0
  // 会把「无数据」伪装成「GDP 为 0」（旧 CLI 版 bug，对齐旧 Rust）。
  if (rawValue == null || !Number.isFinite(value)) return null;
  const year = entry?.date ?? '最新';
  const zhName = WORLD_BANK_COUNTRIES.find(([, c]) => c === code)?.[2] ?? code;
  const number = indicator.percent
    ? `${value.toFixed(1)}%`
    : value >= 1e12
      ? `${(value / 1e12).toFixed(2)} 万亿`
      : value >= 1e8
        ? `${(value / 1e8).toFixed(2)} 亿`
        : value.toFixed(1);
  return {
    intent: 'worldbank',
    source: 'World Bank',
    text: `${zhName} ${indicator.label}（${year}年）: ${number}\n数据来源: World Bank Open Data (${indicator.code})`,
  };
}

async function resolveNews(deps: PublicApiDeps, query: string): Promise<PublicApiOutcome | null> {
  const zh = containsCJK(query);
  const q = query.replace(NEWS_WORDS, '').trim() || (zh ? '热点新闻' : 'top news');
  // Bing News RSS is China-reachable; Google News RSS is the fallback.
  let xml = await fetchTextVia(
    deps,
    `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS&setlang=${zh ? 'zh-hans' : 'en-us'}`,
  );
  let source = 'Bing News RSS';
  if (!xml) {
    xml = await fetchTextVia(
      deps,
      `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${zh ? 'zh-CN' : 'en-US'}&gl=${zh ? 'CN' : 'US'}&ceid=${zh ? 'CN:zh-Hans' : 'US:en'}`,
    );
    source = 'Google News RSS';
  }
  if (!xml) return null;
  const items = parseRssItems(xml, 8);
  if (items.length === 0) return null;
  const lines = items.map((item, i) => `${i + 1}. ${item.title}${item.date ? `\n   ${item.date}` : ''}\n   ${item.link}`);
  return { intent: 'news', source, text: `新闻: ${q}\n\n${lines.join('\n\n')}` };
}

async function resolveWiki(deps: PublicApiDeps, query: string): Promise<PublicApiOutcome | null> {
  const zh = containsCJK(query);
  const lang = zh ? 'zh' : 'en';
  // Strip intent words: "JavaScript 是什么" → JavaScript.
  let title = query.replace(WIKI_WORDS, '').trim();
  if (!title) return null;
  // Resolve to the real page title via opensearch (handles redirects/aliases).
  const search = await fetchJsonVia(
    deps,
    `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(title)}&limit=1&format=json`,
  );
  const resolved = Array.isArray(search?.[1]) ? search[1][0] : undefined;
  if (typeof resolved === 'string' && resolved) title = resolved;
  const summary = await fetchJsonVia(deps, `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  const extract = typeof summary?.extract === 'string' && summary.extract ? summary.extract : undefined;
  if (!extract) return null;
  const pageUrl = summary?.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
  const desc = summary?.description ? `${summary.description}\n` : '';
  return { intent: 'wiki', source: `Wikipedia (${lang})`, text: `${title}\n${desc}${extract}\n\n来源: ${pageUrl}` };
}

async function resolveIp(deps: PublicApiDeps): Promise<PublicApiOutcome | null> {
  const ip = await fetchJsonVia(deps, 'https://api.ipify.org?format=json');
  const addr = typeof ip?.ip === 'string' ? ip.ip : undefined;
  if (!addr) return null;
  const detail = await fetchJsonVia(deps, `http://ip-api.com/json/${addr}?fields=status,country,regionName,city,isp,org,as,timezone`);
  if (detail?.status !== 'success') {
    return { intent: 'ip', source: 'ipify', text: `IP 地址: ${addr}` };
  }
  return {
    intent: 'ip',
    source: 'ipify + ip-api.com',
    text: `IP 地址: ${addr}\n位置: ${detail.city ?? ''} ${detail.regionName ?? ''} ${detail.country ?? ''}\n运营商: ${detail.isp ?? detail.org ?? ''}\n时区: ${detail.timezone ?? ''}`,
  };
}

async function resolveFx(deps: PublicApiDeps, req: FxRequest): Promise<PublicApiOutcome | null> {
  const data = await fetchJsonVia(deps, `https://api.frankfurter.app/latest?from=${req.from}&to=${req.to}`);
  const rate = data?.rates?.[req.to];
  if (typeof rate !== 'number') return null;
  const total = rate * req.amount;
  const date = data.date ?? '';
  return {
    intent: 'fx',
    source: 'Frankfurter (ECB)',
    text: `${req.amount} ${req.from} = ${total.toFixed(req.amount >= 100 ? 2 : 4)} ${req.to} (1 ${req.from} = ${rate} ${req.to}${date ? `, ${date}` : ''})`,
  };
}

async function resolveStock(deps: PublicApiDeps, symbol: string, query: string): Promise<PublicApiOutcome | null> {
  const zh = containsCJK(query);
  const tencent = await fetchStockTencent(deps, symbol);
  if (tencent) return { intent: 'stock', source: '腾讯行情', text: tencent };
  if (symbol.startsWith('sh') || symbol.startsWith('sz')) {
    const sina = await fetchStockSina(deps, symbol);
    if (sina) return { intent: 'stock', source: '新浪行情', text: sina };
  }
  return null;
}

/** Tencent qt.gtimg.cn quote (GBK body, China-reachable, no key). GBK 解码
 * 走 decodeBody（与 CLI readResponseText 同一字符集归一）。 */
export async function fetchStockTencent(deps: PublicApiDeps, symbol: string): Promise<string | null> {
  try {
    const r = await deps.fetchPage(`http://qt.gtimg.cn/q=${encodeURIComponent(symbol)}`, { timeoutMs: 8000 });
    if (r.status < 200 || r.status >= 300) return null;
    const body = decodeBody(r);
    const m = body.match(/"([\s\S]*?)"/);
    if (!m) return null;
    const f = m[1].split('~');
    if (f.length < 40 || !f[3]) return null;
    // 数值字段 NaN→0 防御（对齐旧 Rust parse().unwrap_or(0.0)）：停牌或
    // 字段缺失时 Number('') = NaN 会把输出污染成 "NaN%"。
    const numOr = (s: string | undefined): number => (Number.isFinite(Number(s)) ? Number(s) : 0);
    const change = numOr(f[31]);
    const changePct = numOr(f[32]);
    const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '—';
    // Tencent field layout: 1 name, 2 code, 3 current, 4 prev close, 5 open,
    // 6 volume(手), 30 time, 31 change, 32 change%, 33 high, 34 low,
    // 37 amount(万), 38 turnover%, 39 PE, 44 float cap(亿).
    return [
      `腾讯行情 · ${symbol} ${f[1] ?? ''}`,
      `现价 ${f[3]} (昨收 ${f[4]})  ${arrow} ${change >= 0 ? '+' : ''}${change} (${changePct >= 0 ? '+' : ''}${changePct}%)`,
      `今开 ${f[5]}  最高 ${f[33]}  最低 ${f[34]}`,
      `成交量 ${f[6]}手  成交额 ${f[37]}万  市盈率 ${f[39] ?? ''}  换手 ${f[38] ?? ''}%`,
      `时间 ${f[30] ?? ''}`,
    ].join('\n');
  } catch {
    return null;
  }
}

/** Sina hq.sinajs.cn quote fallback (GBK body; needs a finance Referer). */
export async function fetchStockSina(deps: PublicApiDeps, symbol: string): Promise<string | null> {
  try {
    const r = await deps.fetchPage(`https://hq.sinajs.cn/list=${encodeURIComponent(symbol)}`, {
      headers: { Referer: 'https://finance.sina.com.cn' },
      timeoutMs: 8000,
    });
    if (r.status < 200 || r.status >= 300) return null;
    const body = decodeBody(r);
    const m = body.match(/"([\s\S]*?)"/);
    if (!m) return null;
    const f = m[1].split(',');
    if (f.length < 10 || !f[3]) return null;
    const name = f[0] ?? '';
    // 数值字段 NaN→0 防御（同腾讯）；成交额保持源字段定长数字——
    // toLocaleString 的千分位随 locale 漂移，且测试锚的是定长形态。
    const numOr = (s: string | undefined): number => (Number.isFinite(Number(s)) ? Number(s) : 0);
    const prevClose = numOr(f[2]);
    const current = numOr(f[3]);
    const change = current - prevClose;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;
    const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '—';
    return [
      `新浪行情 · ${symbol} ${name}`,
      `现价 ${current} (昨收 ${prevClose})  ${arrow} ${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`,
      `今开 ${f[1]}  最高 ${f[4]}  最低 ${f[5]}`,
      `成交量 ${f[8]}股  成交额 ${f[9] ?? '0'}元  日期 ${f[30] ?? ''} ${f[31] ?? ''}`,
    ].join('\n');
  } catch {
    return null;
  }
}

async function resolveGithub(deps: PublicApiDeps, query: string): Promise<PublicApiOutcome | null> {
  // 前导冒号/空白一次剥净（连续「：：」会残留——旧 Rust while 循环同语义）。
  const q = query.replace(GITHUB_WORDS, '').replace(/^[：:\s]+/, '').trim();
  if (!q) return null;
  const data = await fetchJsonVia(
    deps,
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=5`,
    8000,
    { Accept: 'application/vnd.github+json' },
  );
  const items = Array.isArray(data?.items) ? data.items.slice(0, 5) : [];
  if (items.length === 0) return null;
  const lines = items.map((repo: any, i: number) => {
    const lang = repo.language ? ` · ${repo.language}` : '';
    const desc = typeof repo.description === 'string' && repo.description ? `\n   ${repo.description}` : '';
    return `${i + 1}. ${repo.full_name ?? ''} (⭐ ${repo.stargazers_count ?? 0}${lang})${desc}\n   ${repo.html_url ?? ''}`;
  });
  return { intent: 'github', source: 'GitHub Search API', text: `GitHub 仓库 (按 star 排序):\n\n${lines.join('\n\n')}` };
}

// ── Main entry ──

export interface PublicApiOptions {
  /** Explicit intent override (from web_public_api's category arg). */
  category?: string;
  /** User-configured location fallback for weather without a city. */
  location?: string;
}

/** Try to answer a query from the direct public API tier. Returns null when
 * the query is not a structured intent or every endpoint failed — callers
 * then fall through to web search / scraping. */
export async function tryDirectPublicApi(query: string, deps: PublicApiDeps, opts: PublicApiOptions = {}): Promise<PublicApiOutcome | null> {
  const q = query.trim();
  if (!q && !opts.category) return null;
  const category = (opts.category ?? '').trim();
  const forced = ['weather', 'airquality', 'geocode', 'news', 'wiki', 'ip', 'fx', 'stock', 'github', 'worldbank'].includes(category)
    ? category as IntentKind
    : undefined;
  const intent = forced ?? classifyIntent(q);
  if (!intent) return null;

  switch (intent) {
    case 'weather': return await resolveWeather(deps, q, opts);
    case 'airquality': return await resolveAirQuality(deps, q, opts);
    case 'geocode': return await resolveGeocode(deps, q);
    case 'news': return await resolveNews(deps, q);
    case 'wiki': return await resolveWiki(deps, q);
    case 'ip': return await resolveIp(deps);
    case 'fx': {
      const req = parseFxQuery(q) ?? { from: 'USD', to: 'CNY', amount: 1 };
      return await resolveFx(deps, req);
    }
    case 'stock': {
      const symbol = resolveStockSymbol(q);
      return symbol ? await resolveStock(deps, symbol, q) : null;
    }
    case 'github': return await resolveGithub(deps, q);
    case 'worldbank': return await resolveWorldbank(deps, q);
    default: return null;
  }
}

/** tryDirectPublicApi + cache: fresh answers are served from the shared cache
 * without hitting the network (free APIs are rate-limited too); misses resolve
 * through the real resolver and are stored under the intent's TTL. Returns
 * { outcome: null, cached: false } on any failure so callers degrade exactly
 * like the uncached path; `cached` tells callers a hit came from the cache
 * (for the `[cached]` freshness marker). */
export async function cachedDirectPublicApi(
  query: string,
  category: string | undefined,
  location: string | undefined,
  deps: PublicApiDeps,
): Promise<{ outcome: PublicApiOutcome | null; cached: boolean }> {
  const key = publicApiCacheKey(query, category, location);
  const hit = deps.cacheGet ? await deps.cacheGet(key) : undefined;
  if (hit !== undefined && hit !== null) {
    try {
      const parsed = JSON.parse(hit) as PublicApiOutcome;
      // intent 合法性防御：GUI 旧 Rust 记录的 intent 是 PascalCase
      // （"Weather"），解析成合法对象但 TTL 表查不到——视为损坏重解析。
      if (parsed && typeof parsed === 'object' && typeof parsed.intent === 'string' && (parsed.intent as string) in PUBLIC_API_TTL_MS) {
        return { outcome: parsed, cached: true };
      }
    } catch {
      // Corrupt record — resolve fresh.
    }
  }
  const outcome = await tryDirectPublicApi(query, deps, { category, location });
  // 降级卡（服务不可达）不落盘：形态是成功但内容不是答案，缓存它会让
  // 服务恢复后还在回答「不可达」。
  if (outcome && deps.cacheSet && !outcome.degraded) {
    deps.cacheSet(key, JSON.stringify(outcome), PUBLIC_API_TTL_MS[outcome.intent]);
  }
  return { outcome, cached: false };
}
