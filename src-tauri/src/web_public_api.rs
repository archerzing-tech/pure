// src-tauri/src/web_public_api.rs
// P3-1 第一刀（2026-09-30，lib.rs 拆分）— Web Public API（Tier-2）解析器栈：
// 结构化直查的意图分类器 + 各 resolver（天气/空气质量/地理编码/新闻/wiki/
// IP/汇率/股价/GitHub/世界银行），镜像 src/adapter/node/publicApis.ts。
// 从 lib.rs 整段搬出（8113-9424，机械移动零语义变化）：HTTP 客户端、响应
// 缓存（cached_direct_public_api）与 L1 兜底（web_search_inner）仍住 lib.rs，
// 本模块经 crate:: 反向引用 —— 解析器栈与缓存/搜索基建的分界即此刀的切缝。
// 对 lib.rs 暴露的面：web_public_api 命令（generate_handler 用）、
// try_direct_public_api / PublicApiOutcome / IntentKind / parse_rss_items
// （缓存与搜索侧消费），以及测试引用的分类与解析辅助函数。

use crate::{
    backend_blocked, backend_mark_blocked, build_http_client, cached_direct_public_api,
    fetch_feed_text, is_chinese_query, response_text_with_charset, urlencoding, web_search_inner,
    BROWSER_UA,
};

//  Web Public API (Tier-2) — structured direct lookups
//  Curated no-key public APIs for STRUCTURED intents (weather / geocode / news
//  / wiki / IP / FX / stock / GitHub), mirroring
//  src/adapter/node/publicApis.ts. A deterministic intent classifier decides
//  whether a query is a structured lookup — the model is never asked to pick
//  from a huge endpoint registry. Every resolver returns Ok(None) on failure
//  so callers degrade to web search / web_fetch instead of an error wall.
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) enum IntentKind {
    Weather,
    AirQuality,
    Geocode,
    News,
    Wiki,
    Ip,
    Fx,
    Stock,
    Github,
    WorldBank,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct PublicApiOutcome {
    /// Which intent produced this outcome (drives the cache TTL class).
    pub(crate) intent: IntentKind,
    /// Human-readable answer text, ready to hand to the model.
    pub(crate) text: String,
    /// Source label for the result, e.g. "Open-Meteo".
    pub(crate) source: String,
}

// ── Intent classifier ──
// Conservative keyword routing with length caps + a build-request guard, so
// "写一个天气网站" can never be answered with weather data instead of being
// treated as a coding request. Only HIGH-confidence intents auto-route inside
// web_search; the model-facing web_public_api tool may force a category.

static_regex!(weather_re, r"(?i)天气|气温|温度|预报|会不会下雨|降雨|降雪|风力|湿度|weather|forecast|temperature|rain|snow|humidity|wind");
static_regex!(geocode_re, r"(?i)经纬度|坐标|geocode|latitude|longitude|lat\s*/?\s*lon|地理坐标");
static_regex!(news_re, r"(?i)新闻|资讯|头条|快讯|时讯|热点|报道|新闻头条|news|headlines|breaking");
static_regex!(wiki_re, r"(?i)维基|百科|是什么|是谁|简介|wikipedia|wiki");
static_regex!(ip_re, r"(?i)(?:我的)?\s*(?:ip地址|ip 地址|本机ip|外网ip|ip)$|(?:what is|my)?\s*(?:ip address|my ip)\b|ip地址|IP地址");
static_regex!(github_re, r"(?i)\bgithub\b|开源项目|最火的.*仓库|star.*最多");
static_regex!(air_quality_re, r"(?i)空气质量|空气指数|空气污染|雾霾|霾|pm2\.?5|pm10|AQI|air quality|air pollution|air index");
static_regex!(worldbank_re, r"(?i)gdp|国内生产总值|人均gdp|人口|总人口|失业率|通胀|通货膨胀|world bank|世界银行|population|unemployment|inflation");
static_regex!(time_words_re, r"今天|明天|后天|昨天|早上|上午|中午|下午|晚上|夜里|下周|上周|这周|周末|周[一二三四五六日天]|today|tomorrow|yesterday|this|next|last|week|morning|afternoon|evening|night|in|the|for|at|what|is|like|now|的|怎么样|如何|呢|吧|啊");
static_regex!(punct_re, r"[，。？?！!、,.，\s]+");

/// True for requests that want something BUILT (never auto-route these). CJK
/// prefixes match unconditionally (every Chinese build request continues with
/// CJK characters — the JS lookahead's practical equivalent); English prefixes
/// need a word boundary so "makeup" / "codex" never match.
pub(crate) fn is_build_request(query: &str) -> bool {
    let q = query.trim();
    if q.is_empty() {
        return false;
    }
    static_regex!(cjk_build_re, r"^(?:写|做|建|造|生成|开发|设计|创建一个|帮我(?:写|做|建|造|开发|设计|生成|创建一个))");
    static_regex!(en_build_re, r"^(?:make|build|create|write|generate|design|develop|code)");
    if cjk_build_re().is_match(q) {
        return true;
    }
    if let Some(m) = en_build_re().find(q) {
        return q[m.end()..]
            .chars()
            .next()
            .map_or(true, |c| !(c.is_ascii_alphanumeric() || c == '_'));
    }
    false
}

/// Classify a query's structured-data intent, or None when it does not fit.
pub(crate) fn classify_intent(query: &str) -> Option<IntentKind> {
    let q = query.trim();
    if q.is_empty() {
        return None;
    }
    if is_build_request(q) {
        return None;
    }
    let len = q.chars().count();
    if weather_re().is_match(q) && len <= 40 {
        return Some(IntentKind::Weather);
    }
    if air_quality_re().is_match(q) && len <= 60 {
        return Some(IntentKind::AirQuality);
    }
    if geocode_re().is_match(q) && len <= 60 {
        return Some(IntentKind::Geocode);
    }
    // FX is checked via its parseable currency-pair grammar, not keywords.
    if parse_fx_query(q).is_some() {
        return Some(IntentKind::Fx);
    }
    if ip_re().is_match(q) && len <= 40 {
        return Some(IntentKind::Ip);
    }
    if news_re().is_match(q) && len <= 60 {
        return Some(IntentKind::News);
    }
    if wiki_re().is_match(q) && len <= 60 {
        return Some(IntentKind::Wiki);
    }
    if github_re().is_match(q) && len <= 60 {
        return Some(IntentKind::Github);
    }
    if resolve_stock_symbol(q).is_some() && len <= 40 {
        return Some(IntentKind::Stock);
    }
    if worldbank_re().is_match(q) && len <= 60 && worldbank_indicator(q).is_some() && worldbank_country(q).is_some() {
        return Some(IntentKind::WorldBank);
    }
    None
}

/// Extract a location name from a weather/geocode query ("北京明天天气" → 北京).
pub(crate) fn extract_location(query: &str) -> String {
    let mut s = weather_re().replace(query, " ").to_string();
    s = time_words_re().replace(&s, " ").to_string();
    punct_re().replace(&s, " ").trim().to_string()
}

/// Extract a location name from an air-quality query ("北京PM2.5" → 北京).
fn extract_air_quality_location(query: &str) -> String {
    let mut s = air_quality_re().replace(query, " ").to_string();
    s = time_words_re().replace(&s, " ").to_string();
    punct_re().replace(&s, " ").trim().to_string()
}

// ── FX parsing ──

pub(crate) struct FxRequest {
    pub(crate) from: String,
    pub(crate) to: String,
    pub(crate) amount: f64,
}

fn currency_code(name: &str) -> Option<&'static str> {
    Some(match name {
        "美元" | "美金" => "USD",
        "人民币" => "CNY",
        "日元" => "JPY",
        "欧元" => "EUR",
        "英镑" => "GBP",
        "港币" => "HKD",
        "韩元" => "KRW",
        "卢布" => "RUB",
        "澳元" => "AUD",
        "加元" => "CAD",
        "新台币" => "TWD",
        "新加坡元" => "SGD",
        "泰铢" => "THB",
        "卢比" => "INR",
        "巴西雷亚尔" => "BRL",
        _ => return None,
    })
}

const CURRENCY_CODES: &str = "USD|CNY|JPY|EUR|GBP|HKD|KRW|RUB|AUD|CAD|TWD|SGD|THB|INR|BRL|CHF";

fn zh_currency_names() -> String {
    [
        "美元", "美金", "人民币", "日元", "欧元", "英镑", "港币", "韩元", "卢布", "澳元", "加元", "新台币", "新加坡元", "泰铢", "卢比", "巴西雷亚尔",
    ]
    .join("|")
}

/// Parse "100 USD to CNY", "usd cny", "1美元等于多少人民币", "美元汇率".
pub(crate) fn parse_fx_query(query: &str) -> Option<FxRequest> {
    let q = query.trim();
    let zh_cur = zh_currency_names();
    // English pair: [amount] CODE to/in CODE
    let en_re = regex::Regex::new(&format!(
        r"(?i)^(\d+(?:\.\d+)?)?\s*({})\s*(?:to|in|→|->|兑|换成|换)?\s*({})$",
        CURRENCY_CODES, CURRENCY_CODES
    ))
    .ok()?;
    if let Some(c) = en_re.captures(q) {
        return Some(FxRequest {
            from: c[2].to_uppercase(),
            to: c[3].to_uppercase(),
            amount: c.get(1).map(|m| m.as_str().parse().unwrap_or(1.0)).unwrap_or(1.0),
        });
    }
    // Chinese pair: N 美元等于多少人民币 / N 美元换人民币 / 美元兑人民币
    let zh_re = regex::Regex::new(&format!(
        r"^(\d+(?:\.\d+)?)?\s*({})(?:等于多少|换成多少|是多少|等于|换成|兑换成|兑|换|折合|多少)?\s*({})$",
        zh_cur, zh_cur
    ))
    .ok()?;
    if let Some(c) = zh_re.captures(q) {
        return Some(FxRequest {
            from: currency_code(&c[2])?.to_string(),
            to: currency_code(&c[3])?.to_string(),
            amount: c.get(1).map(|m| m.as_str().parse().unwrap_or(1.0)).unwrap_or(1.0),
        });
    }
    // Bare single currency: "美元汇率" / "usd rate" → USD → CNY baseline.
    let single_re = regex::Regex::new(&format!(
        r"(?i)^(\d+(?:\.\d+)?)?\s*({}|{})(?:汇率|兑人民币|换成人民币|和人民币|对人民币|rate)?$",
        zh_cur, CURRENCY_CODES
    ))
    .ok()?;
    if let Some(c) = single_re.captures(q) {
        let code = if c[2].len() == 3 && c[2].chars().all(|ch| ch.is_ascii_alphabetic()) {
            c[2].to_uppercase()
        } else {
            currency_code(&c[2])?.to_string()
        };
        return Some(FxRequest {
            from: code,
            to: "CNY".to_string(),
            amount: c.get(1).map(|m| m.as_str().parse().unwrap_or(1.0)).unwrap_or(1.0),
        });
    }
    None
}

// ── Stock symbol resolution ──

pub(crate) fn resolve_stock_symbol(query: &str) -> Option<String> {
    let q = query.trim().to_lowercase();
    static KNOWN: &[(&str, &str)] = &[
        ("苹果", "usAAPL"), ("aapl", "usAAPL"), ("apple", "usAAPL"),
        ("特斯拉", "usTSLA"), ("tsla", "usTSLA"), ("tesla", "usTSLA"),
        ("英伟达", "usNVDA"), ("nvda", "usNVDA"), ("微软", "usMSFT"), ("msft", "usMSFT"),
        ("谷歌", "usGOOGL"), ("亚马逊", "usAMZN"), ("amzn", "usAMZN"), ("meta", "usMETA"),
        ("阿里巴巴", "usBABA"), ("baba", "usBABA"), ("拼多多", "usPDD"), ("pdd", "usPDD"),
        ("京东", "usJD"), ("jd", "usJD"),
        ("腾讯", "hk00700"), ("腾讯控股", "hk00700"), ("美团", "hk03690"), ("小米", "hk01810"),
        ("茅台", "sh600519"), ("贵州茅台", "sh600519"), ("比亚迪", "sz002594"), ("宁德时代", "sz300750"),
        ("中国平安", "sh601318"), ("工商银行", "sh601398"), ("招商银行", "sh600036"), ("中国石油", "sh601857"),
    ];
    for (name, symbol) in KNOWN {
        if q.contains(name) {
            return Some(symbol.to_string());
        }
    }
    // Explicit market codes: sh600519 / sz000001 / hk00700 / 0700.hk / aapl.us
    // (HK tickers are commonly written 4-digit, e.g. 0700.hk / hk0700; the
    // resolved Tencent symbol always pads to 5 digits — 00700.)
    static_regex!(market_re, r"(?i)\b(sh|sz)\d{6}\b|\bhk\d{4,5}\b|\b\d{4,5}\.hk\b|\b[a-z]{1,5}\.(us|hk|sh|sz)\b");
    if let Some(m) = market_re().find(&q) {
        let raw = m.as_str().to_lowercase();
        if raw.starts_with("sh") || raw.starts_with("sz") {
            return Some(raw);
        }
        if raw.starts_with("hk") {
            let ticker = &raw[2..];
            return Some(format!("hk{}{}", "0".repeat(5usize.saturating_sub(ticker.len())), ticker));
        }
        if let Some(dot) = raw.find('.') {
            let (ticker, market) = (&raw[..dot], &raw[dot + 1..]);
            return if market == "hk" {
                Some(format!("hk{}{}", "0".repeat(5usize.saturating_sub(ticker.len())), ticker))
            } else {
                Some(format!("us{}", ticker.to_uppercase()))
            };
        }
    }
    // Bare ticker-ish token (2-5 letters) → US listing, only as the WHOLE query.
    static_regex!(bare_ticker_re, r"^[a-z]{2,5}$");
    if bare_ticker_re().is_match(&q) {
        return Some(format!("us{}", q.to_uppercase()));
    }
    None
}

// ── WMO weather code → description ──

fn describe_wmo_code(code: i64, zh: bool) -> String {
    let desc = if zh {
        match code {
            0 => "晴", 1 => "基本晴朗", 2 => "多云", 3 => "阴",
            45 => "雾", 48 => "雾凇", 51 => "小毛毛雨", 53 => "毛毛雨", 55 => "浓毛毛雨",
            56 => "冻毛毛雨", 57 => "浓冻毛毛雨", 61 => "小雨", 63 => "中雨", 65 => "大雨",
            66 => "冻雨", 67 => "强冻雨", 71 => "小雪", 73 => "中雪", 75 => "大雪", 77 => "米雪",
            80 => "小阵雨", 81 => "阵雨", 82 => "强阵雨", 85 => "阵雪", 86 => "强阵雪",
            95 => "雷阵雨", 96 => "雷阵雨伴冰雹", 99 => "强雷阵雨伴冰雹",
            _ => return format!("code {}", code),
        }
    } else {
        match code {
            0 => "Clear sky", 1 => "Mainly clear", 2 => "Partly cloudy", 3 => "Overcast",
            45 => "Fog", 48 => "Depositing rime fog", 51 => "Light drizzle", 53 => "Drizzle",
            55 => "Dense drizzle", 56 => "Freezing drizzle", 57 => "Dense freezing drizzle",
            61 => "Light rain", 63 => "Rain", 65 => "Heavy rain", 66 => "Freezing rain", 67 => "Heavy freezing rain",
            71 => "Light snow", 73 => "Snow", 75 => "Heavy snow", 77 => "Snow grains",
            80 => "Light rain showers", 81 => "Rain showers", 82 => "Violent rain showers",
            85 => "Snow showers", 86 => "Heavy snow showers",
            95 => "Thunderstorm", 96 => "Thunderstorm with hail", 99 => "Thunderstorm with heavy hail",
            _ => return format!("code {}", code),
        }
    };
    desc.to_string()
}

// ── RSS parsing (shared with the Tier-3 feed formatting) ──

pub(crate) struct RssItem {
    pub(crate) title: String,
    pub(crate) link: String,
    pub(crate) date: String,
    pub(crate) description: String,
}

fn clean_xml_text(s: &str) -> String {
    static_regex!(cdata_re, r"<!\[CDATA\[|\]\]>");
    static_regex!(tag_re, r"<[^>]+>");
    tag_re().replace_all(&cdata_re().replace_all(s, ""), "").trim().to_string()
}

/// Parse RSS/Atom <item>/<entry> blocks (no XML dependency, mirrors the
/// regex-based parsers in src/adapter/node/publicApis.ts).
pub(crate) fn parse_rss_items(xml: &str, max: usize) -> Vec<RssItem> {
    static_regex!(feed_block_re, r"(?is)<(item|entry)>([\s\S]*?)</(item|entry)>");
    let mut out: Vec<RssItem> = Vec::new();
    for caps in feed_block_re().captures_iter(xml) {
        if out.len() >= max {
            break;
        }
        let block = &caps[2];
        let pick = |tag: &str| -> String {
            let re = regex::Regex::new(&format!(r"(?is)<{}[^>]*>([\s\S]*?)</{}>", tag, tag)).ok();
            re.and_then(|r| r.captures(block))
                .map(|c| clean_xml_text(&c[1]))
                .unwrap_or_default()
        };
        let title = pick("title");
        if title.is_empty() {
            continue;
        }
        let mut date = pick("pubDate");
        if date.is_empty() {
            date = pick("published");
        }
        if date.is_empty() {
            date = pick("updated");
        }
        let mut description = pick("description");
        if description.is_empty() {
            description = pick("summary");
        }
        out.push(RssItem {
            title,
            link: pick("link").trim().to_string(),
            date,
            description,
        });
    }
    out
}

// ── Resolver implementations (each returns Ok(None) on any failure) ──

async fn fetch_json(
    url: &str,
    timeout_ms: u64,
    headers: &[(&str, &str)],
    proxy_url: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    let client = build_http_client(std::time::Duration::from_millis(timeout_ms), proxy_url)?;
    let mut req = client.get(url).header("User-Agent", BROWSER_UA);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let resp = req.send().await.map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    match resp.json::<serde_json::Value>().await {
        Ok(v) => Ok(Some(v)),
        Err(_) => Ok(None),
    }
}

struct GeoResult {
    name: String,
    latitude: f64,
    longitude: f64,
    country: Option<String>,
}

/// Open-Meteo geocoding first, Nominatim fallback (1 req/s, needs a UA).
/// Transport-level failures never abort the chain: an unreachable backend is
/// put on a 300s cooldown and skipped (Nominatim is routinely unreachable
/// from mainland China — connection errors there used to bubble up as tool
/// failures, which the model then retried until the failure policy aborted
/// the whole turn). Ok(None) = definitively no result; Err = every backend
/// failed at the transport level (last error).
async fn geocode(location: &str, proxy_url: Option<&str>) -> Result<Option<GeoResult>, String> {
    let zh = is_chinese_query(location);
    let mut last_err: Option<String> = None;

    if !backend_blocked("geocode.open-meteo") {
        let url = format!(
            "https://geocoding-api.open-meteo.com/v1/search?name={}&count=1&language={}&format=json",
            urlencoding(location),
            if zh { "zh" } else { "en" }
        );
        match fetch_json(&url, 8000, &[], proxy_url).await {
            Ok(Some(data)) => {
                if let Some(first) = data.get("results").and_then(|v| v.as_array()).and_then(|a| a.first()) {
                    if let (Some(lat), Some(lon)) = (
                        first.get("latitude").and_then(|v| v.as_f64()),
                        first.get("longitude").and_then(|v| v.as_f64()),
                    ) {
                        return Ok(Some(GeoResult {
                            name: first.get("name").and_then(|v| v.as_str()).unwrap_or(location).to_string(),
                            latitude: lat,
                            longitude: lon,
                            country: first.get("country").and_then(|v| v.as_str()).map(String::from),
                        }));
                    }
                }
            }
            Ok(_) => {}
            Err(e) => {
                backend_mark_blocked("geocode.open-meteo", 300);
                last_err = Some(e);
            }
        }
    }

    if !backend_blocked("geocode.nominatim") {
        let nomi = format!(
            "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q={}",
            urlencoding(location)
        );
        match fetch_json(&nomi, 6000, &[], proxy_url).await {
            Ok(Some(arr)) => {
                if let Some(n) = arr.as_array().and_then(|a| a.first()) {
                    let lat = n.get("lat").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok());
                    let lon = n.get("lon").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok());
                    if let (Some(lat), Some(lon)) = (lat, lon) {
                        return Ok(Some(GeoResult {
                            name: n.get("display_name").and_then(|v| v.as_str()).unwrap_or(location).to_string(),
                            latitude: lat,
                            longitude: lon,
                            country: None,
                        }));
                    }
                }
            }
            Ok(_) => {}
            Err(e) => {
                backend_mark_blocked("geocode.nominatim", 300);
                last_err = Some(e);
            }
        }
    }

    match last_err {
        Some(e) => Err(e),
        None => Ok(None),
    }
}

/// Geocoding is down at the transport level (every backend unreachable).
/// Return an actionable notice instead of a raw reqwest error string — the
/// raw error gave the model nothing to act on, so it retried the same
/// unreachable host until the failure policy killed the turn. The notice
/// points at the one-shot fallback that actually works: the model's own
/// knowledge of major-place coordinates.
fn geocode_unavailable_outcome(err: String) -> PublicApiOutcome {
    PublicApiOutcome {
        intent: IntentKind::Geocode,
        source: "Open-Meteo/Nominatim".to_string(),
        text: format!(
            "地理编码服务当前不可达（{err}）。请勿再次调用本工具获取坐标：主要城市、山川与知名景区的坐标在你的知识范围内（例如西安约 34.26,108.94；三门峡约 34.77,111.19），直接使用已知坐标继续任务即可；确需实时检索再改用 web_search。"
        ),
    }
}

fn json_num(v: &serde_json::Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

fn fmt_opt(opt: Option<f64>) -> String {
    opt.map(|x| x.to_string()).unwrap_or_else(|| "?".to_string())
}

async fn resolve_weather(
    query: &str,
    location_opt: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<Option<PublicApiOutcome>, String> {
    let mut location = extract_location(query);
    if location.is_empty() {
        location = location_opt.unwrap_or("").to_string();
    }
    if location.is_empty() {
        return Ok(Some(PublicApiOutcome {
            intent: IntentKind::Weather,
            source: "Open-Meteo".to_string(),
            text: "需要知道城市才能查天气（例如“北京天气”或“weather in Tokyo”）；未检测到城市，也没有配置位置。".to_string(),
        }));
    }
    let geo = match geocode(&location, proxy_url).await {
        Ok(Some(g)) => g,
        // Geocoder unreachable → let the tool fall through to the search
        // backends instead of failing outright.
        _ => return Ok(None),
    };
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=3",
        geo.latitude, geo.longitude
    );
    let data = match fetch_json(&url, 8000, &[], proxy_url).await? {
        Some(d) => d,
        None => return Ok(None),
    };
    let (Some(cur), Some(daily)) = (data.get("current"), data.get("daily")) else {
        return Ok(None);
    };
    let zh = is_chinese_query(&location) || is_chinese_query(query);
    let mut lines: Vec<String> = Vec::new();
    let name = match &geo.country {
        Some(country) => format!("{} ({})", geo.name, country),
        None => geo.name.clone(),
    };
    let timezone = data.get("timezone").and_then(|v| v.as_str()).unwrap_or("");
    let cur_time = cur.get("time").and_then(|v| v.as_str()).unwrap_or("");
    lines.push(format!("{} 天气 · {} · 数据时间 {}", name, timezone, cur_time));
    let precip = json_num(cur, "precipitation").unwrap_or(0.0);
    let mut current_line = format!(
        "当前: {}°C (体感 {}°C) {} · 湿度 {}% · 风速 {} km/h",
        fmt_opt(json_num(cur, "temperature_2m")),
        fmt_opt(json_num(cur, "apparent_temperature")),
        describe_wmo_code(json_num(cur, "weather_code").unwrap_or(-1.0) as i64, zh),
        fmt_opt(json_num(cur, "relative_humidity_2m")),
        fmt_opt(json_num(cur, "wind_speed_10m")),
    );
    if precip > 0.0 {
        current_line.push_str(&format!(" · 降水 {}mm", precip));
    }
    lines.push(current_line);
    if let Some(times) = daily.get("time").and_then(|v| v.as_array()) {
        for (i, _) in times.iter().enumerate().take(3) {
            let label = match i {
                0 => (if zh { "今日" } else { "Today" }).to_string(),
                1 => (if zh { "明日" } else { "Tomorrow" }).to_string(),
                _ => times[i].as_str().unwrap_or("").to_string(),
            };
            let day_max = daily.get("temperature_2m_max").and_then(|v| v.as_array()).and_then(|a| a.get(i)).and_then(|x| x.as_f64());
            let day_min = daily.get("temperature_2m_min").and_then(|v| v.as_array()).and_then(|a| a.get(i)).and_then(|x| x.as_f64());
            let day_code = daily.get("weather_code").and_then(|v| v.as_array()).and_then(|a| a.get(i)).and_then(|x| x.as_i64()).unwrap_or(-1);
            let prob = daily.get("precipitation_probability_max").and_then(|v| v.as_array()).and_then(|a| a.get(i)).and_then(|x| x.as_f64());
            let mut line = format!(
                "{}: {}°C / {}°C · {}",
                label,
                fmt_opt(day_max),
                fmt_opt(day_min),
                describe_wmo_code(day_code, zh)
            );
            if let Some(p) = prob {
                line.push_str(&format!(" · 降水概率 {}%", p));
            }
            lines.push(line);
        }
    }
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::Weather,
        source: "Open-Meteo".to_string(),
        text: lines.join("\n"),
    }))
}

async fn resolve_geocode(query: &str, proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    let location = extract_location(query);
    if location.is_empty() {
        return Ok(None);
    }
    let geo = match geocode(&location, proxy_url).await {
        Ok(Some(g)) => g,
        Ok(None) => return Ok(None),
        // Transport failure is a degraded state, not a tool error: hand the
        // model the use-what-you-know fallback instead of an error it will
        // retry until the turn aborts.
        Err(e) => return Ok(Some(geocode_unavailable_outcome(e))),
    };
    let country = geo.country.as_deref().map(|c| format!(" ({})", c)).unwrap_or_default();
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::Geocode,
        source: "Open-Meteo/Nominatim".to_string(),
        text: format!(
            "地理位置: {}{}\n纬度: {}\n经度: {}",
            geo.name, country, geo.latitude, geo.longitude
        ),
    }))
}

async fn resolve_air_quality(
    query: &str,
    location_opt: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<Option<PublicApiOutcome>, String> {
    let mut location = extract_air_quality_location(query);
    if location.is_empty() {
        location = location_opt.unwrap_or("").to_string();
    }
    if location.is_empty() {
        return Ok(Some(PublicApiOutcome {
            intent: IntentKind::AirQuality,
            source: "Open-Meteo Air Quality".to_string(),
            text: "需要知道城市才能查空气质量（例如“北京空气质量”或“北京PM2.5”）；未检测到城市，也没有配置位置。".to_string(),
        }));
    }
    let geo = match geocode(&location, proxy_url).await {
        Ok(Some(g)) => g,
        // Geocoder unreachable → fall through to the search backends.
        _ => return Ok(None),
    };
    let url = format!(
        "https://air-quality-api.open-meteo.com/v1/air-quality?latitude={}&longitude={}&current=pm10,pm2_5,nitrogen_dioxide,us_aqi&timezone=auto",
        geo.latitude, geo.longitude
    );
    let data = match fetch_json(&url, 8000, &[], proxy_url).await? {
        Some(d) => d,
        None => return Ok(None),
    };
    let Some(cur) = data.get("current") else {
        return Ok(None);
    };
    let name = match &geo.country {
        Some(country) => format!("{} ({})", geo.name, country),
        None => geo.name.clone(),
    };
    let cur_time = cur.get("time").and_then(|v| v.as_str()).unwrap_or("");
    let pm25 = json_num(cur, "pm2_5");
    let pm10 = json_num(cur, "pm10");
    let us_aqi = json_num(cur, "us_aqi");
    let no2 = json_num(cur, "nitrogen_dioxide");
    let mut lines = vec![format!("{} 空气质量 · 数据时间 {}", name, cur_time)];
    let mut current_line = format!(
        "当前: PM2.5 {} µg/m³ · PM10 {} µg/m³ · 美标 AQI {}",
        fmt_opt(pm25),
        fmt_opt(pm10),
        fmt_opt(us_aqi)
    );
    if let Some(aqi) = us_aqi {
        current_line.push_str(&format!(" · {}", describe_aqi(aqi)));
    }
    lines.push(current_line);
    if no2.is_some() {
        lines.push(format!("二氧化氮 NO₂: {} µg/m³", fmt_opt(no2)));
    }
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::AirQuality,
        source: "Open-Meteo Air Quality".to_string(),
        text: lines.join("\n"),
    }))
}

/// US-AQI → six-level Chinese health label (近似国标阈值，供快速判断).
fn describe_aqi(us_aqi: f64) -> String {
    if us_aqi <= 50.0 {
        "优".to_string()
    } else if us_aqi <= 100.0 {
        "良".to_string()
    } else if us_aqi <= 150.0 {
        "轻度污染".to_string()
    } else if us_aqi <= 200.0 {
        "中度污染".to_string()
    } else if us_aqi <= 300.0 {
        "重度污染".to_string()
    } else {
        "严重污染".to_string()
    }
}

/// Look up a World Bank country ISO2 code + Chinese display name from the
/// query. CJK names match by substring; English names require word boundaries
/// (longest first so "united states" wins over "us").
pub(crate) fn worldbank_country(query: &str) -> Option<(&'static str, &'static str)> {
    let q = query.to_lowercase();
    for (name, code, zh) in [
        ("中国", "CN", "中国"),
        ("美国", "US", "美国"),
        ("日本", "JP", "日本"),
        ("德国", "DE", "德国"),
        ("英国", "GB", "英国"),
        ("法国", "FR", "法国"),
        ("印度", "IN", "印度"),
        ("韩国", "KR", "韩国"),
        ("俄罗斯", "RU", "俄罗斯"),
        ("巴西", "BR", "巴西"),
        ("加拿大", "CA", "加拿大"),
        ("澳大利亚", "AU", "澳大利亚"),
        ("澳洲", "AU", "澳大利亚"),
        ("意大利", "IT", "意大利"),
        ("新加坡", "SG", "新加坡"),
    ] {
        if query.contains(name) {
            return Some((code, zh));
        }
    }
    for (name, code, zh) in [
        ("united states", "US", "美国"),
        ("south korea", "KR", "韩国"),
        ("united kingdom", "GB", "英国"),
        ("china", "CN", "中国"),
        ("japan", "JP", "日本"),
        ("germany", "DE", "德国"),
        ("france", "FR", "法国"),
        ("india", "IN", "印度"),
        ("korea", "KR", "韩国"),
        ("russia", "RU", "俄罗斯"),
        ("brazil", "BR", "巴西"),
        ("canada", "CA", "加拿大"),
        ("australia", "AU", "澳大利亚"),
        ("italy", "IT", "意大利"),
        ("singapore", "SG", "新加坡"),
        ("usa", "US", "美国"),
        ("uk", "GB", "英国"),
        ("us", "US", "美国"),
    ] {
        if ascii_word_match(&q, name) {
            return Some((code, zh));
        }
    }
    None
}

/// ASCII word-boundary match so "us" never matches "must" / "house".
fn ascii_word_match(haystack: &str, needle: &str) -> bool {
    let pattern = format!(r"(?i)(?:^|[^a-z0-9]){}(?:[^a-z0-9]|$)", regex::escape(needle));
    regex::Regex::new(&pattern)
        .map(|re| re.is_match(haystack))
        .unwrap_or(false)
}

/// World Bank indicator lookup: (code, display label, is_percent). "人口" is
/// ambiguous ("人口老龄化"), so it requires a count/lookup signal alongside.
fn worldbank_indicator(query: &str) -> Option<(&'static str, &'static str, bool)> {
    let q = query.to_lowercase();
    if q.contains("人均gdp") || q.contains("人均国内生产总值") || q.contains("gdp per capita") {
        return Some(("NY.GDP.PCAP.CD", "人均GDP(现价美元)", false));
    }
    if q.contains("gdp") || q.contains("国内生产总值") {
        return Some(("NY.GDP.MKTP.CD", "GDP(现价美元)", false));
    }
    if (q.contains("人口") || q.contains("population"))
        && (q.contains("多少") || q.contains("总数") || q.contains("数量") || q.contains("几") || q.contains("how many"))
    {
        return Some(("SP.POP.TOTL", "人口总数", false));
    }
    if q.contains("失业率") || q.contains("unemployment") {
        return Some(("SL.UEM.TOTL.ZS", "失业率", true));
    }
    if q.contains("通胀") || q.contains("通货膨胀") || q.contains("inflation") {
        return Some(("FP.CPI.TOTL.ZG", "通胀率", true));
    }
    None
}

async fn resolve_worldbank(
    query: &str,
    proxy_url: Option<&str>,
) -> Result<Option<PublicApiOutcome>, String> {
    let Some((indicator, label, is_percent)) = worldbank_indicator(query) else {
        return Ok(None);
    };
    let Some((code, zh_name)) = worldbank_country(query) else {
        return Ok(None);
    };
    let url = format!(
        "https://api.worldbank.org/v2/country/{}/indicator/{}?format=json&per_page=1",
        code, indicator
    );
    let Some(data) = fetch_json(&url, 8000, &[], proxy_url).await? else {
        return Ok(None);
    };
    let entry = data
        .as_array()
        .and_then(|a| a.get(1))
        .and_then(|v| v.as_array())
        .and_then(|a| a.first());
    let Some(entry) = entry else {
        return Ok(None);
    };
    let value = entry
        .get("value")
        .and_then(|v| v.as_f64())
        .or_else(|| {
            entry
                .get("value")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
        });
    let Some(value) = value else {
        return Ok(None);
    };
    let year = entry.get("date").and_then(|v| v.as_str()).unwrap_or("最新");
    let number = if is_percent {
        format!("{:.1}%", value)
    } else if value >= 1e12 {
        format!("{:.2} 万亿", value / 1e12)
    } else if value >= 1e8 {
        format!("{:.2} 亿", value / 1e8)
    } else {
        format!("{:.1}", value)
    };
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::WorldBank,
        source: "World Bank".to_string(),
        text: format!(
            "{} {}（{}年）: {}\n数据来源: World Bank Open Data ({})",
            zh_name, label, year, number, indicator
        ),
    }))
}

async fn resolve_news(query: &str, proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    let zh = is_chinese_query(query);
    let mut q = news_re().replace(query, "").trim().to_string();
    if q.is_empty() {
        q = if zh { "热点新闻".to_string() } else { "top news".to_string() };
    }
    // Bing News RSS is China-reachable; Google News RSS is the fallback.
    let lang = if zh { "zh-hans" } else { "en-us" };
    let mut xml = fetch_feed_text(
        &format!(
            "https://www.bing.com/news/search?q={}&format=RSS&setlang={}",
            urlencoding(&q),
            lang
        ),
        proxy_url,
    )
    .await?;
    let mut source = "Bing News RSS";
    if xml.is_none() {
        let (hl, gl, ceid) = if zh {
            ("zh-CN", "CN", "CN:zh-Hans")
        } else {
            ("en-US", "US", "US:en")
        };
        xml = fetch_feed_text(
            &format!(
                "https://news.google.com/rss/search?q={}&hl={}&gl={}&ceid={}",
                urlencoding(&q),
                hl,
                gl,
                ceid
            ),
            proxy_url,
        )
        .await?;
        source = "Google News RSS";
    }
    let xml = match xml {
        Some(x) => x,
        None => return Ok(None),
    };
    let items = parse_rss_items(&xml, 8);
    if items.is_empty() {
        return Ok(None);
    }
    let lines: Vec<String> = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let mut line = format!("{}. {}", i + 1, item.title);
            if !item.date.is_empty() {
                line.push_str(&format!("\n   {}", item.date));
            }
            line.push_str(&format!("\n   {}", item.link));
            line
        })
        .collect();
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::News,
        source: source.to_string(),
        text: format!("新闻: {}\n\n{}", q, lines.join("\n\n")),
    }))
}

async fn resolve_wiki(query: &str, proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    let zh = is_chinese_query(query);
    let lang = if zh { "zh" } else { "en" };
    let mut title = wiki_re().replace(query, "").trim().to_string();
    if title.is_empty() {
        return Ok(None);
    }
    // Resolve to the real page title via opensearch (handles redirects/aliases).
    let search = fetch_json(
        &format!(
            "https://{}.wikipedia.org/w/api.php?action=opensearch&search={}&limit=1&format=json",
            lang,
            urlencoding(&title)
        ),
        8000,
        &[],
        proxy_url,
    )
    .await?;
    if let Some(arr) = search.as_ref().and_then(|v| v.get(1)).and_then(|v| v.as_array()) {
        if let Some(first) = arr.first().and_then(|v| v.as_str()) {
            if !first.is_empty() {
                title = first.to_string();
            }
        }
    }
    let summary = fetch_json(
        &format!(
            "https://{}.wikipedia.org/api/rest_v1/page/summary/{}",
            lang,
            urlencoding(&title)
        ),
        8000,
        &[],
        proxy_url,
    )
    .await?;
    let extract = summary
        .as_ref()
        .and_then(|v| v.get("extract"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let extract = match extract {
        Some(e) => e,
        None => return Ok(None),
    };
    let page_url = summary
        .as_ref()
        .and_then(|v| v.get("content_urls"))
        .and_then(|v| v.get("desktop"))
        .and_then(|v| v.get("page"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("https://{}.wikipedia.org/wiki/{}", lang, urlencoding(&title)));
    let desc = summary
        .as_ref()
        .and_then(|v| v.get("description"))
        .and_then(|v| v.as_str())
        .map(|d| format!("{}\n", d))
        .unwrap_or_default();
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::Wiki,
        source: format!("Wikipedia ({})", lang),
        text: format!("{}\n{}{}\n\n来源: {}", title, desc, extract, page_url),
    }))
}

async fn resolve_ip(proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    let ip = fetch_json("https://api.ipify.org?format=json", 8000, &[], proxy_url).await?;
    let addr = ip.as_ref().and_then(|v| v.get("ip")).and_then(|v| v.as_str()).map(String::from);
    let addr = match addr {
        Some(a) => a,
        None => return Ok(None),
    };
    let detail = fetch_json(
        &format!(
            "http://ip-api.com/json/{}?fields=status,country,regionName,city,isp,org,as,timezone",
            urlencoding(&addr)
        ),
        8000,
        &[],
        proxy_url,
    )
    .await?;
    if detail.as_ref().and_then(|v| v.get("status")).and_then(|v| v.as_str()) != Some("success") {
        return Ok(Some(PublicApiOutcome {
            intent: IntentKind::Ip,
            source: "ipify".to_string(),
            text: format!("IP 地址: {}", addr),
        }));
    }
    let d = detail.unwrap_or_default();
    let city = d.get("city").and_then(|v| v.as_str()).unwrap_or("");
    let region = d.get("regionName").and_then(|v| v.as_str()).unwrap_or("");
    let country = d.get("country").and_then(|v| v.as_str()).unwrap_or("");
    let isp = d
        .get("isp")
        .and_then(|v| v.as_str())
        .or_else(|| d.get("org").and_then(|v| v.as_str()))
        .unwrap_or("");
    let tz = d.get("timezone").and_then(|v| v.as_str()).unwrap_or("");
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::Ip,
        source: "ipify + ip-api.com".to_string(),
        text: format!("IP 地址: {}\n位置: {} {} {}\n运营商: {}\n时区: {}", addr, city, region, country, isp, tz),
    }))
}

async fn resolve_fx(req: &FxRequest, proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    let data = match fetch_json(
        &format!("https://api.frankfurter.app/latest?from={}&to={}", req.from, req.to),
        8000,
        &[],
        proxy_url,
    )
    .await?
    {
        Some(d) => d,
        None => return Ok(None),
    };
    let rate = data.get("rates").and_then(|v| v.get(&req.to)).and_then(|v| v.as_f64());
    let rate = match rate {
        Some(r) => r,
        None => return Ok(None),
    };
    let total = rate * req.amount;
    let date = data.get("date").and_then(|v| v.as_str()).unwrap_or("");
    let precision = if req.amount >= 100.0 { 2 } else { 4 };
    let date_suffix = if date.is_empty() {
        String::new()
    } else {
        format!(", {}", date)
    };
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::Fx,
        source: "Frankfurter (ECB)".to_string(),
        text: format!(
            "{} {} = {:.*} {} (1 {} = {} {}{})",
            req.amount, req.from, precision, total, req.to, req.from, rate, req.to, date_suffix
        ),
    }))
}

/// Tencent qt.gtimg.cn quote (GBK body, China-reachable, no key).
async fn fetch_stock_tencent(symbol: &str, proxy_url: Option<&str>) -> Result<Option<String>, String> {
    let client = build_http_client(std::time::Duration::from_secs(8), proxy_url)?;
    let resp = client
        .get(format!("http://qt.gtimg.cn/q={}", urlencoding(symbol)))
        .header("User-Agent", BROWSER_UA)
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body = response_text_with_charset(resp).await?;
    let start = match body.find('"') {
        Some(i) => i,
        None => return Ok(None),
    };
    let end = match body[start + 1..].find('"') {
        Some(i) => i + start + 1,
        None => return Ok(None),
    };
    let f: Vec<&str> = body[start + 1..end].split('~').collect();
    if f.len() < 40 || f[3].is_empty() {
        return Ok(None);
    }
    let num = |i: usize| f.get(i).and_then(|s| s.parse::<f64>().ok());
    let change = num(31).unwrap_or(0.0);
    let change_pct = num(32).unwrap_or(0.0);
    let arrow = if change > 0.0 { "▲" } else if change < 0.0 { "▼" } else { "—" };
    let sign = |v: f64| if v >= 0.0 { "+" } else { "" };
    let at = |i: usize| f.get(i).copied().unwrap_or("");
    Ok(Some(format!(
        "腾讯行情 · {} {}\n现价 {} (昨收 {})  {} {}{} ({}{}%)\n今开 {}  最高 {}  最低 {}\n成交量 {}手  成交额 {}万  市盈率 {}  换手 {}%\n时间 {}",
        symbol,
        at(1),
        at(3),
        at(4),
        arrow,
        sign(change),
        change,
        sign(change_pct),
        change_pct,
        at(5),
        at(33),
        at(34),
        at(6),
        at(37),
        at(39),
        at(38),
        at(30),
    )))
}

/// Sina hq.sinajs.cn quote fallback (GBK body; needs a finance Referer).
async fn fetch_stock_sina(symbol: &str, proxy_url: Option<&str>) -> Result<Option<String>, String> {
    let client = build_http_client(std::time::Duration::from_secs(8), proxy_url)?;
    let resp = client
        .get(format!("https://hq.sinajs.cn/list={}", urlencoding(symbol)))
        .header("User-Agent", BROWSER_UA)
        .header("Referer", "https://finance.sina.com.cn")
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body = response_text_with_charset(resp).await?;
    let start = match body.find('"') {
        Some(i) => i,
        None => return Ok(None),
    };
    let end = match body[start + 1..].find('"') {
        Some(i) => i + start + 1,
        None => return Ok(None),
    };
    let f: Vec<&str> = body[start + 1..end].split(',').collect();
    if f.len() < 10 || f[3].is_empty() {
        return Ok(None);
    }
    let prev_close = f[2].parse::<f64>().unwrap_or(0.0);
    let current = f[3].parse::<f64>().unwrap_or(0.0);
    let change = current - prev_close;
    let change_pct = if prev_close != 0.0 { change / prev_close * 100.0 } else { 0.0 };
    let arrow = if change > 0.0 { "▲" } else if change < 0.0 { "▼" } else { "—" };
    let sign = |v: f64| if v >= 0.0 { "+" } else { "" };
    let amount = f.get(9).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    let at = |i: usize| f.get(i).copied().unwrap_or("");
    Ok(Some(format!(
        "新浪行情 · {} {}\n现价 {} (昨收 {})  {} {}{:.2} ({}{:.2}%)\n今开 {}  最高 {}  最低 {}\n成交量 {}股  成交额 {}元  日期 {} {}",
        symbol,
        at(0),
        at(3),
        at(2),
        arrow,
        sign(change),
        change,
        sign(change_pct),
        change_pct,
        at(1),
        at(4),
        at(5),
        at(8),
        amount,
        at(30),
        at(31),
    )))
}

async fn resolve_stock(symbol: &str, proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    if let Some(text) = fetch_stock_tencent(symbol, proxy_url).await? {
        return Ok(Some(PublicApiOutcome {
            intent: IntentKind::Stock,
            source: "腾讯行情".to_string(),
            text,
        }));
    }
    if symbol.starts_with("sh") || symbol.starts_with("sz") {
        if let Some(text) = fetch_stock_sina(symbol, proxy_url).await? {
            return Ok(Some(PublicApiOutcome {
                intent: IntentKind::Stock,
                source: "新浪行情".to_string(),
                text,
            }));
        }
    }
    Ok(None)
}

async fn resolve_github(query: &str, proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    let mut q = github_re().replace(query, "").trim().to_string();
    while q.starts_with('：') || q.starts_with(':') {
        q = q[1..].trim_start().to_string();
    }
    if q.is_empty() {
        return Ok(None);
    }
    let data = match fetch_json(
        &format!(
            "https://api.github.com/search/repositories?q={}&sort=stars&order=desc&per_page=5",
            urlencoding(&q)
        ),
        8000,
        &[("Accept", "application/vnd.github+json")],
        proxy_url,
    )
    .await?
    {
        Some(d) => d,
        None => return Ok(None),
    };
    let items = data.get("items").and_then(|v| v.as_array()).map(|a| a.to_vec()).unwrap_or_default();
    let items: Vec<&serde_json::Value> = items.iter().take(5).collect();
    if items.is_empty() {
        return Ok(None);
    }
    let lines: Vec<String> = items
        .iter()
        .enumerate()
        .map(|(i, repo)| {
            let full_name = repo.get("full_name").and_then(|v| v.as_str()).unwrap_or("");
            let stars = repo.get("stargazers_count").and_then(|v| v.as_i64()).unwrap_or(0);
            let lang = repo.get("language").and_then(|v| v.as_str()).filter(|l| !l.is_empty());
            let lang_suffix = lang.map(|l| format!(" · {}", l)).unwrap_or_default();
            let url = repo.get("html_url").and_then(|v| v.as_str()).unwrap_or("");
            let desc = repo
                .get("description")
                .and_then(|v| v.as_str())
                .filter(|d| !d.is_empty())
                .map(|d| format!("\n   {}", d))
                .unwrap_or_default();
            format!("{}. {} (⭐ {}{}){}\n   {}", i + 1, full_name, stars, lang_suffix, desc, url)
        })
        .collect();
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::Github,
        source: "GitHub Search API".to_string(),
        text: format!("GitHub 仓库 (按 star 排序):\n\n{}", lines.join("\n\n")),
    }))
}

// ── Main entry ──

/// Try to answer a query from the direct public API tier. Returns Ok(None)
/// when the query is not a structured intent or every endpoint failed —
/// callers then fall through to web search / scraping.
pub(crate) async fn try_direct_public_api(
    query: &str,
    category: Option<&str>,
    location: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<Option<PublicApiOutcome>, String> {
    let q = query.trim();
    if q.is_empty() && category.is_none() {
        return Ok(None);
    }
    let forced = category.and_then(|c| match c {
        "weather" => Some(IntentKind::Weather),
        "airquality" => Some(IntentKind::AirQuality),
        "geocode" => Some(IntentKind::Geocode),
        "news" => Some(IntentKind::News),
        "wiki" => Some(IntentKind::Wiki),
        "ip" => Some(IntentKind::Ip),
        "fx" => Some(IntentKind::Fx),
        "stock" => Some(IntentKind::Stock),
        "github" => Some(IntentKind::Github),
        "worldbank" => Some(IntentKind::WorldBank),
        _ => None,
    });
    let intent = forced.or_else(|| classify_intent(q));
    let Some(intent) = intent else {
        return Ok(None);
    };
    match intent {
        IntentKind::Weather => resolve_weather(q, location, proxy_url).await,
        IntentKind::AirQuality => resolve_air_quality(q, location, proxy_url).await,
        IntentKind::Geocode => resolve_geocode(q, proxy_url).await,
        IntentKind::News => resolve_news(q, proxy_url).await,
        IntentKind::Wiki => resolve_wiki(q, proxy_url).await,
        IntentKind::Ip => resolve_ip(proxy_url).await,
        IntentKind::Fx => {
            let req = parse_fx_query(q).unwrap_or(FxRequest {
                from: "USD".to_string(),
                to: "CNY".to_string(),
                amount: 1.0,
            });
            resolve_fx(&req, proxy_url).await
        }
        IntentKind::Stock => match resolve_stock_symbol(q) {
            Some(symbol) => resolve_stock(&symbol, proxy_url).await,
            None => Ok(None),
        },
        IntentKind::Github => resolve_github(q, proxy_url).await,
        IntentKind::WorldBank => resolve_worldbank(q, proxy_url).await,
    }
}

#[tauri::command]
pub async fn web_public_api(
    _workspace: String,
    query: String,
    category: Option<String>,
    location: Option<String>,
    api_key: Option<String>,
    serper_api_key: Option<String>,
    search_on_miss: Option<bool>,
    proxy_url: Option<String>,
    searxng_url: Option<String>,
) -> Result<String, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("web_public_api query must not be empty".to_string());
    }
    match cached_direct_public_api(&q, category.as_deref(), location.as_deref(), proxy_url.as_deref()).await? {
        (Some(outcome), cached) => {
            return Ok(format!("{}[{}] {}", if cached { "[cached] " } else { "" }, outcome.source, outcome.text));
        }
        (None, _) => {}
    }
    // Auto-escalation (L2 → L1): the direct tier had nothing for this query,
    // so fall through to web search instead of forcing a second model
    // round-trip. Opt out with searchOnMiss:false.
    if search_on_miss.unwrap_or(true) {
        return web_search_inner(
            &q,
            Some(8),
            api_key.as_deref(),
            serper_api_key.as_deref(),
            location.as_deref(),
            proxy_url.as_deref(),
            searxng_url.as_deref(),
        )
        .await;
    }
    Err(format!(
        "No structured-data source matched \"{}\" — web_public_api covers weather/air quality/geocode/news/wiki/IP/FX/stock/GitHub/World-Bank lookups; for anything else use web_search instead of retrying this tool with the same query (auto-fallback to search is off when searchOnMiss:false).",
        q
    ))
}
