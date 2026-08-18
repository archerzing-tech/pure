// src/adapter/node/publicApis.ts
// Tier-2 web tool support: curated direct public APIs for STRUCTURED intents
// (weather / geocode / news / wiki / IP / FX / stock / GitHub), all no-key by
// default. This is deliberately a small hand-picked registry, not a runtime
// parse of public-apis/public-apis — that repo is stale with dead links, and
// an LLM cannot be trusted to pick the right one of 1,400 endpoints.
//
// Reachability-tested 2026-08 from this codebase's networks: Open-Meteo
// (geocode + forecast), Bing News RSS (China-reachable; Google News RSS as
// fallback), Wikipedia REST, ipify + ip-api.com, Frankfurter FX, Tencent
// qt.gtimg.cn (GBK, China-reachable) with Sina hq.sinajs.cn fallback, GitHub
// search API. Every resolver returns null on failure so callers degrade to
// web_search / web_scrape instead of surfacing an error wall.
//
// The routing policy lives in two places on purpose: a deterministic intent
// classifier here (used by the legacy web_search alias for fast structured
// answers), and the explicit tool-choice guidance in PromptAssembler for the
// model-facing tools. Tiers are NOT sequential: structured intent → this
// module first; general discovery → web search; known URL → web_scrape.
//
// Results are cached through webCache.ts with per-intent TTLs (weather/news/
// stock are minutes-fresh; geocode/wiki are weeks-fresh) — the same cache file
// and key scheme the Rust GUI mirror uses, so CLI and GUI share warm results.

import { publicApiCacheKey, webCache } from './webCache';

export type IntentKind = 'weather' | 'airquality' | 'geocode' | 'news' | 'wiki' | 'ip' | 'fx' | 'stock' | 'github' | 'worldbank';

export interface PublicApiOutcome {
  intent: IntentKind;
  /** Human-readable answer text, ready to hand to the model. */
  text: string;
  /** Source label for the result, e.g. "Open-Meteo". */
  source: string;
}

// ── Backend quota / cooldown (in-memory) ──
// Free tiers die silently: a used-up Serper key or a rate-limited SearXNG
// instance would otherwise be retried forever. This registry keeps per-key
// cooldowns + sliding-window usage counts for the whole process; the search
// backends in NodeToolAdapter use the same instance. In-memory only (a
// process restart resets it) — deliberately simple, no persistence.

export class BackendQuota {
  private blockedUntil = new Map<string, number>();
  private uses = new Map<string, number[]>();

  isBlocked(key: string): boolean {
    const until = this.blockedUntil.get(key);
    return until !== undefined && until > Date.now();
  }

  /** Block a backend for `ms` (rate limit, quota exhausted, dead instance). */
  markBlocked(key: string, ms: number): void {
    this.blockedUntil.set(key, Date.now() + ms);
  }

  /** Record one successful use; returns true when the window is over budget. */
  registerUse(key: string, windowMs: number, cap: number): boolean {
    const now = Date.now();
    const windowStart = now - windowMs;
    const list = (this.uses.get(key) ?? []).filter((t) => t > windowStart);
    list.push(now);
    this.uses.set(key, list);
    return list.length > cap;
  }

  /** Number of uses in the sliding window (for diagnostics). */
  countInWindow(key: string, windowMs: number): number {
    const now = Date.now();
    return (this.uses.get(key) ?? []).filter((t) => t > now - windowMs).length;
  }

  /** Drop all cooldowns and usage history (diagnostics / tests). */
  clear(): void {
    this.blockedUntil.clear();
    this.uses.clear();
  }
}

export const quota = new BackendQuota();

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

/** tryDirectPublicApi + cache: fresh answers are served from the shared cache
 * without hitting the network (free APIs are rate-limited too); misses resolve
 * through the real resolver and are stored under the intent's TTL. Returns
 * { outcome: null, cached: false } on any failure so callers degrade exactly
 * like the uncached path; `cached` tells callers a hit came from the cache
 * (for the `[cached]` freshness marker). */
export async function cachedDirectPublicApi(
  query: string,
  category?: string,
  location?: string,
): Promise<{ outcome: PublicApiOutcome | null; cached: boolean }> {
  const key = publicApiCacheKey(query, category, location);
  const hit = webCache().get(key);
  if (hit !== undefined) {
    try {
      return { outcome: JSON.parse(hit) as PublicApiOutcome, cached: true };
    } catch {
      // Corrupt record — resolve fresh.
    }
  }
  const outcome = await tryDirectPublicApi(query, { category, location });
  if (outcome) {
    webCache().set(key, JSON.stringify(outcome), PUBLIC_API_TTL_MS[outcome.intent]);
  }
  return { outcome, cached: false };
}

// ── Intent classifier ──
// Deterministic keyword routing with conservative length caps + a build-request
// guard, so "写一个天气网站" can never be answered with weather data instead of
// being treated as a coding request. Only HIGH-confidence intents auto-route
// inside web_search; the model-facing web_public_api tool may force a category.

/** True for requests that want something BUILT (never auto-route these).
 * The boundary is CJK-aware: \b alone never matches between two CJK word
 * characters (写|一 are both \w), which would silently disable the guard
 * for every Chinese build request. */
export function isBuildRequest(query: string): boolean {
  return /^(?:写|做|建|造|生成|开发|设计|创建一个|帮我(?:写|做|建|造|开发|设计|生成|创建一个)|make|build|create|write|generate|design|develop|code)(?=[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]|\b)/i.test(query.trim());
}

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
  // Chinese pair: N 美元等于多少人民币 / N 美元换人民币 / 美元兑人民币
  const zhCur = Object.keys(CURRENCY).join('|');
  const zh = q.match(new RegExp(`^(\\d+(?:\\.\\d+)?)?\\s*(${zhCur})(?:等于多少|换成多少|是多少|等于|换成|兑换成|兑|换|折合|多少)?\\s*(${zhCur})`, 'i'));
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

// ── Resolver implementations (each returns null on any failure) ──

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchJson(url: string, timeoutMs = 8000, headers: Record<string, string> = {}): Promise<any | null> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

interface GeoResult { name: string; latitude: number; longitude: number; country?: string; }

/** Open-Meteo geocoding first, Nominatim fallback (1 req/s, needs a UA). */
async function geocode(location: string): Promise<GeoResult | null> {
  const zh = containsCJK(location);
  const data = await fetchJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=${zh ? 'zh' : 'en'}&format=json`,
  );
  const first = Array.isArray(data?.results) ? data.results[0] : undefined;
  if (first?.latitude != null && first?.longitude != null) {
    return { name: first.name ?? location, latitude: first.latitude, longitude: first.longitude, country: first.country };
  }
  const nomi = await fetchJson(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(location)}`,
    6000,
  );
  const n = Array.isArray(nomi) ? nomi[0] : undefined;
  if (n?.lat != null && n?.lon != null) {
    return { name: n.display_name ?? location, latitude: Number(n.lat), longitude: Number(n.lon) };
  }
  return null;
}

function containsCJK(s: string): boolean {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(s);
}

async function resolveWeather(query: string, opts: { location?: string }): Promise<PublicApiOutcome | null> {
  let location = extractLocation(query);
  if (!location && opts.location) location = opts.location;
  if (!location) {
    return {
      intent: 'weather',
      source: 'Open-Meteo',
      text: '需要知道城市才能查天气（例如“北京天气”或“weather in Tokyo”）；未检测到城市，也没有配置 PURE_LOCATION。',
    };
  }
  const geo = await geocode(location);
  if (!geo) return null;
  const data = await fetchJson(
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

async function resolveGeocode(query: string): Promise<PublicApiOutcome | null> {
  const location = extractLocation(query);
  if (!location) return null;
  const geo = await geocode(location);
  if (!geo) return null;
  return {
    intent: 'geocode',
    source: 'Open-Meteo/Nominatim',
    text: `地理位置: ${geo.name}${geo.country ? ` (${geo.country})` : ''}\n纬度: ${geo.latitude}\n经度: ${geo.longitude}`,
  };
}

async function resolveAirQuality(query: string, opts: { location?: string }): Promise<PublicApiOutcome | null> {
  let location = extractAirQualityLocation(query);
  if (!location && opts.location) location = opts.location;
  if (!location) {
    return {
      intent: 'airquality',
      source: 'Open-Meteo Air Quality',
      text: '需要知道城市才能查空气质量（例如“北京空气质量”或“北京PM2.5”）；未检测到城市，也没有配置 PURE_LOCATION。',
    };
  }
  const geo = await geocode(location);
  if (!geo) return null;
  const data = await fetchJson(
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
    if (/[\u3400-\u9FFF]/.test(name)) {
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

async function resolveWorldbank(query: string): Promise<PublicApiOutcome | null> {
  const indicator = worldbankIndicator(query);
  if (!indicator) return null;
  const code = worldbankCountry(query);
  if (!code) return null;
  const data = await fetchJson(
    `https://api.worldbank.org/v2/country/${code}/indicator/${indicator.code}?format=json&per_page=1`,
  );
  const entry = Array.isArray(data) ? data[1]?.[0] : undefined;
  const value = typeof entry?.value === 'number' ? entry.value : Number(entry?.value);
  if (!Number.isFinite(value)) return null;
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

function cleanXmlText(s: string): string {
  return s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
}

export interface RssItem { title: string; link: string; date: string; description: string; }

/** Parse RSS/Atom <item>/<entry> blocks (no XML dependency, mirrors the
 * regex-based HTML parsers elsewhere in the codebase). */
export function parseRssItems(xml: string, maxItems = 8): RssItem[] {
  const items: RssItem[] = [];
  const re = /<(item|entry)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && items.length < maxItems) {
    const block = m[2];
    const pick = (tag: string): string => {
      const mm = block.match(new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return mm ? cleanXmlText(mm[1]) : '';
    };
    const title = pick('title');
    const link = pick('link').trim();
    if (!title) continue;
    items.push({ title, link, date: pick('pubDate') || pick('published') || pick('updated'), description: pick('description') || pick('summary') });
  }
  return items;
}

async function resolveNews(query: string): Promise<PublicApiOutcome | null> {
  const zh = containsCJK(query);
  const q = query.replace(NEWS_WORDS, '').trim() || (zh ? '热点新闻' : 'top news');
  const fetchFeed = async (url: string): Promise<string | null> => {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      return resp.ok ? await resp.text() : null;
    } catch {
      return null;
    }
  };
  // Bing News RSS is China-reachable; Google News RSS is the fallback.
  let xml = await fetchFeed(
    `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS&setlang=${zh ? 'zh-hans' : 'en-us'}`,
  );
  let source = 'Bing News RSS';
  if (!xml) {
    xml = await fetchFeed(
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

async function resolveWiki(query: string): Promise<PublicApiOutcome | null> {
  const zh = containsCJK(query);
  const lang = zh ? 'zh' : 'en';
  // Strip intent words: "JavaScript 是什么" → JavaScript.
  let title = query.replace(WIKI_WORDS, '').trim();
  if (!title) return null;
  // Resolve to the real page title via opensearch (handles redirects/aliases).
  const search = await fetchJson(
    `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(title)}&limit=1&format=json`,
  );
  const resolved = Array.isArray(search?.[1]) ? search[1][0] : undefined;
  if (typeof resolved === 'string' && resolved) title = resolved;
  const summary = await fetchJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  const extract = typeof summary?.extract === 'string' && summary.extract ? summary.extract : undefined;
  if (!extract) return null;
  const pageUrl = summary?.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
  const desc = summary?.description ? `${summary.description}\n` : '';
  return { intent: 'wiki', source: `Wikipedia (${lang})`, text: `${title}\n${desc}${extract}\n\n来源: ${pageUrl}` };
}

async function resolveIp(): Promise<PublicApiOutcome | null> {
  const ip = await fetchJson('https://api.ipify.org?format=json');
  const addr = typeof ip?.ip === 'string' ? ip.ip : undefined;
  if (!addr) return null;
  const detail = await fetchJson(`http://ip-api.com/json/${addr}?fields=status,country,regionName,city,isp,org,as,timezone`);
  if (detail?.status !== 'success') {
    return { intent: 'ip', source: 'ipify', text: `IP 地址: ${addr}` };
  }
  return {
    intent: 'ip',
    source: 'ipify + ip-api.com',
    text: `IP 地址: ${addr}\n位置: ${detail.city ?? ''} ${detail.regionName ?? ''} ${detail.country ?? ''}\n运营商: ${detail.isp ?? detail.org ?? ''}\n时区: ${detail.timezone ?? ''}`,
  };
}

async function resolveFx(req: FxRequest): Promise<PublicApiOutcome | null> {
  const data = await fetchJson(`https://api.frankfurter.app/latest?from=${req.from}&to=${req.to}`);
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

async function resolveStock(symbol: string, query: string): Promise<PublicApiOutcome | null> {
  const zh = containsCJK(query);
  const tencent = await fetchStockTencent(symbol);
  if (tencent) return { intent: 'stock', source: '腾讯行情', text: tencent };
  if (symbol.startsWith('sh') || symbol.startsWith('sz')) {
    const sina = await fetchStockSina(symbol);
    if (sina) return { intent: 'stock', source: '新浪行情', text: sina };
  }
  return null;
}

/** Tencent qt.gtimg.cn quote (GBK body, China-reachable, no key). */
export async function fetchStockTencent(symbol: string): Promise<string | null> {
  try {
    const resp = await fetch(`http://qt.gtimg.cn/q=${encodeURIComponent(symbol)}`, {
      headers: { 'User-Agent': BROWSER_UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const body = await resp.text();
    const m = body.match(/"([\s\S]*?)"/);
    if (!m) return null;
    const f = m[1].split('~');
    if (f.length < 40 || !f[3]) return null;
    const change = Number(f[31]);
    const changePct = Number(f[32]);
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
export async function fetchStockSina(symbol: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://hq.sinajs.cn/list=${encodeURIComponent(symbol)}`, {
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://finance.sina.com.cn' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const body = await resp.text();
    const m = body.match(/"([\s\S]*?)"/);
    if (!m) return null;
    const f = m[1].split(',');
    if (f.length < 10 || !f[3]) return null;
    const name = f[0] ?? '';
    const prevClose = Number(f[2]);
    const current = Number(f[3]);
    const change = current - prevClose;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;
    const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '—';
    return [
      `新浪行情 · ${symbol} ${name}`,
      `现价 ${current} (昨收 ${prevClose})  ${arrow} ${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`,
      `今开 ${f[1]}  最高 ${f[4]}  最低 ${f[5]}`,
      `成交量 ${f[8]}股  成交额 ${Number(f[9] ?? 0).toLocaleString()}元  日期 ${f[30] ?? ''} ${f[31] ?? ''}`,
    ].join('\n');
  } catch {
    return null;
  }
}

async function resolveGithub(query: string): Promise<PublicApiOutcome | null> {
  const q = query.replace(GITHUB_WORDS, '').replace(/^[：:]\s*/, '').trim();
  if (!q) return null;
  const data = await fetchJson(
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
export async function tryDirectPublicApi(query: string, opts: PublicApiOptions = {}): Promise<PublicApiOutcome | null> {
  const q = query.trim();
  if (!q && !opts.category) return null;
  const category = (opts.category ?? '').trim();
  const forced = ['weather', 'airquality', 'geocode', 'news', 'wiki', 'ip', 'fx', 'stock', 'github', 'worldbank'].includes(category)
    ? category as IntentKind
    : undefined;
  const intent = forced ?? classifyIntent(q);
  if (!intent) return null;

  switch (intent) {
    case 'weather': return await resolveWeather(q, opts);
    case 'airquality': return await resolveAirQuality(q, opts);
    case 'geocode': return await resolveGeocode(q);
    case 'news': return await resolveNews(q);
    case 'wiki': return await resolveWiki(q);
    case 'ip': return await resolveIp();
    case 'fx': {
      const req = parseFxQuery(q) ?? { from: 'USD', to: 'CNY', amount: 1 };
      return await resolveFx(req);
    }
    case 'stock': {
      const symbol = resolveStockSymbol(q);
      return symbol ? await resolveStock(symbol, q) : null;
    }
    case 'github': return await resolveGithub(q);
    case 'worldbank': return await resolveWorldbank(q);
    default: return null;
  }
}
