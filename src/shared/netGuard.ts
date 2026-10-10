// src/shared/netGuard.ts
// Host-level circuit breaker + network-failure classification, shared by the
// GUI (TauriToolAdapter) and CLI (NodeToolAdapter) tool adapters.
//
// Why: a dead host used to cost the agent a full network timeout on EVERY
// retry — the failure policy saw 3 identical failures only after the model
// had burned 1-2 minutes hammering the same wall. The breaker trips after 2
// consecutive network failures to the same host: further calls to it fail
// INSTANTLY with a skip-and-continue directive until the cooldown lapses.
// State is per app-run (in-memory); the geocode resolver in Rust keeps its
// own cooldowns for its backends.

import { primaryRewrite } from './sourceRewrite';

const HOST_COOLDOWN_MS = 5 * 60_000;
const HOST_TRIP_THRESHOLD = 2;

// Cross-session knowledge: trip events persist to localStorage for 24h so a
// NEW session's planner still avoids hosts that previous sessions proved
// dead. The live 5-minute cooldown (above) governs instant-fail behavior;
// the persisted history only widens the planner brief.
const STORE_KEY = 'pure.netGuard.hosts.v1';
const HISTORY_RETENTION_MS = 24 * 60 * 60_000;
const HISTORY_MAX_HOSTS = 50;

interface HostState {
  fails: number;
  blockedUntil: number;
}

const hosts = new Map<string, HostState>();

interface PersistedHost {
  host: string;
  lastTripAt: number;
}

function loadTripHistory(): PersistedHost[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedHost[];
    return Array.isArray(parsed) ? parsed.filter(p => typeof p?.host === 'string' && typeof p?.lastTripAt === 'number') : [];
  } catch {
    return [];
  }
}

function persistTrip(host: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const now = Date.now();
    const merged = new Map<string, number>(loadTripHistory().map(p => [p.host, p.lastTripAt]));
    merged.set(host, now);
    const entries = [...merged.entries()]
      .filter(([, ts]) => now - ts < HISTORY_RETENTION_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, HISTORY_MAX_HOSTS)
      .map(([h, ts]) => ({ host: h, lastTripAt: ts }));
    localStorage.setItem(STORE_KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable/full — the in-memory breaker still works.
  }
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Connection-level failures trip the breaker; HTTP status errors (404/403/…)
 *  do NOT — the host is clearly reachable, the resource is the problem. */
export function isNetworkError(message: string): boolean {
  // `unable to connect` / `unable to resolve` 是 Bun fetch 对连接拒绝、DNS 失败、
  // 坏代理的统一措辞（实测四种失败都吐这一句）；只认 `connection` 会漏掉最常见的
  // 真实失败，导致兜底路由重试、熔断、失败分类全都静默失效。
  return /error sending request|connection|unable to connect|unable to resolve|timed?[\s-]?out|unreachable|\bdns\b|econn|reset by peer|socket|certificate|tls|fetch failed|network|代理|连接|超时/i.test(message);
}

// ── 应答劫持检测 ────────────────────────────────────────────────────────────
//
// 大陆网络的 DNS 污染 / 中间设备劫持会把请求改写成 200 广告页或 403 挡板，
// 而两侧历史实现都只判 `status.is_success()`，于是这类响应被当成成功：内容
// 进了模型的上下文（比失败更糟——模型会把广告当事实），同时把错误的路由永久
// 钉进 netRoute 的学习表。
//
// 判定规则与 src-tauri/src/lib.rs 的 detect_response_hijack **逐条对齐**
// （阈值、组合式、可注册域表都取同一份语义）。两份实现此前是不一致的：
// Rust 侧有完整的四信号判定而 CLI 完全不生效，JS 侧只有三条更宽松的启发式。
// 现在 JS fetch 也能拿到 Rust 当年独占的三样东西——`Response.url`（follow 之后
// 的最终 URL）、原始 `content-type`、以及**抽文本之前**的完整 `response.text()`
// ——所以两边可以真正同源，而不是「JS 侧双保险，抓不到就放过」。
//
// 取向仍是宁可漏判不可误判：误判的代价是让本来成功的抓取变成网络失败（触发
// 兜底重试并 unlearn 一条其实没问题的路由）。每条判据都要多条信号叠加。

/**
 * 可见正文长度阈值。与 Rust 侧 HIJACK_VISIBLE_TEXT_MAX_CHARS 一致：两层用
 * 同一阈值，口径漂移会让「Rust 放过、JS 判死」在排查时变成玄学。
 */
export const HIJACK_VISIBLE_TEXT_MAX_CHARS = 200;

/**
 * meta refresh 延迟 ≤ 这个秒数才算「立即跳转」。劫持页给 0；站点自己的
 * 「我们搬家了」页通常给 5 秒以上并且带正文。与 Rust 侧
 * HIJACK_META_REFRESH_MAX_DELAY_SECS 一致。
 */
export const HIJACK_META_REFRESH_MAX_DELAY_SECS = 3;

/**
 * JS 跳转赋值只在文档头部这么多个字符内找。劫持页的跳转脚本紧跟 <head>；
 * 正文中间的 location.href 更可能是正常站点自己的跳转或分享控件。与 Rust 侧
 * HIJACK_JS_SCAN_CHARS 一致。
 */
export const HIJACK_JS_SCAN_CHARS = 4096;

/**
 * 多标签公共后缀表（ccTLD 二级后缀 + 托管平台）。
 *
 * 缺了它，`github.co.uk` 与 `evil.co.uk` 会被当成同一个站（裸切最后两段），
 * 而这正是最常见的钓鱼拼接形态。托管平台（github.io / s3.amazonaws.com /
 * vercel.app …）同样必须列：那些平台上每个子目录/子桶都是独立站点，按同一个
 * 可注册域看待会让跨域信号在这些平台上永远为假。
 *
 * 与 src-tauri/src/lib.rs 的 MULTI_LABEL_PUBLIC_SUFFIXES 保持一致（事实数据，
 * 不受版权保护；表达方式自研）。这里覆盖 Rust 表里全部 ccTLD 二级后缀与托管平台。
 */
const MULTI_LABEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // ── ccTLD 下的二级公共后缀 ──
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk', 'ltd.uk', 'plc.uk',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 're.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk', 'idv.hk',
  'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw', 'idv.tw',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'school.nz',
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za', 'web.za',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'edu.in', 'firm.in',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'net.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr', 'bel.tr',
  'com.pl', 'net.pl', 'org.pl', 'gov.pl', 'edu.pl', 'waw.pl',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua', 'in.ua', 'kiev.ua',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il', 'muni.il',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg', 'per.sg',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'co.th', 'in.th', 'ac.th', 'go.th', 'or.th',
  'co.id', 'or.id', 'web.id', 'go.id', 'ac.id',
  'com.es', 'org.es', 'nom.es', 'gob.es', 'edu.es',
  'com.pt', 'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
  'com.ru', 'net.ru', 'org.ru', 'msk.ru', 'spb.ru',
  'com.pe', 'com.ec', 'com.uy', 'com.ve', 'com.bo', 'com.py',
  'com.do', 'com.gt', 'com.cy', 'com.mt', 'com.ee', 'com.lv', 'com.hr',
  'com.ro', 'com.eg', 'com.sa', 'com.ng', 'com.gh', 'com.pk', 'com.bd',
  'com.kh', 'com.la', 'com.mm', 'com.np', 'com.lk', 'com.co',
  'co.zm', 'co.zw', 'co.tz', 'co.ke', 'co.ug', 'co.mz',
  // ── 托管平台：每个子目录/子桶都是独立站点 ──
  'github.io', 'gitlab.io', 'blogspot.com', 'herokuapp.com', 'appspot.com',
  'cloudfront.net', 's3.amazonaws.com', 'azurewebsites.net', 'web.app',
  'firebaseapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev',
  'r2.dev', 'surge.sh', 'gitbook.io', 'notion.site', 'readthedocs.io',
  'sourceforge.io', 'repl.co', 'replit.dev', 'glitch.me', 'neocities.org',
]);

/** 已知的 GFW/运营商劫持与挡板页指纹。要求组合出现，避免单关键词误伤。
 *  与 Rust 侧 hijack_blockpage_patterns() 逐条对应。 */
const HIJACK_BLOCKPAGE_PATTERNS: readonly RegExp[] = [
  // nginx 默认 403 挡板（部分劫持设备直接吐这个）
  /<title>\s*403\s+Forbidden\s*<\/title>/is,
  /<h1>\s*403\s+Forbidden\s*<\/h1>/is,
  // 运营商/云厂商的「访问受限」模板
  /网页无法打开|该页面暂时无法访问|访问被拒绝|您的访问被拒绝/,
  /由于以下原因.{0,120}无法访问/s,
  // Cloudflare / Akamai 人机墙（正常站点偶尔也会触发，但正文几乎为空时才采信）
  /<title>Just a moment\.\.\.\s*<\/title>/is,
  /Checking your browser before accessing/i,
  /Enable JavaScript and cookies to continue/i,
];

/** 文档里「立即跳站外」的两种形态。顺序与 Rust 侧一致（meta 优先）。 */
const META_REFRESH_RE = /<meta[^>]*>/gis;
const META_REFRESH_URL_RE = /(?:^|;)\s*url\s*=\s*(.+)/is;
const JS_ASSIGN_RE = /(?:window\.)?location(?:\.href)?\s*=\s*["']?(https?:\/\/[^"'\s<>]+)/is;
const JS_REPLACE_RE = /(?:window\.)?location\.replace\(\s*["']?(https?:\/\/[^"'\s<>]+)/is;

export interface HijackVerdict {
  hijacked: boolean;
  /** 触发判定的信号名，写进错误信息便于排查；未命中时为 null。 */
  signal: string | null;
  /** 一句话说明这组信号为什么足以定罪。 */
  why?: string;
}

const NOT_HIJACKED: HijackVerdict = { hijacked: false, signal: null };

/**
 * 可注册域（registrable domain）= 公共后缀 + 其上的那一个标签。跨可注册域才
 * 可能被劫持，跨子域不算（`github.com` → `api.github.com` 是站点自己的事）。
 *
 * 与 Rust 侧 registrable_domain 同算法：先看 host 本身就是一条公共后缀的情况，
 * 再从最长后缀往回找命中项，`github.com.evil.net` 走不到任何一条表项，落到
 * 「最后两段」兜底 → `evil.net`，与 `github.com` 不同，后缀拼接钓鱼因此判得出来。
 */
export function registrableDomain(host: string): string {
  const h = host.trim().replace(/\.$/, '').toLowerCase();
  if (!h) return '';
  const labels = h.split('.').filter(Boolean);
  if (labels.length <= 1) return labels.join('.');
  if (MULTI_LABEL_PUBLIC_SUFFIXES.has(h)) return h;
  for (let i = 1; i < labels.length; i++) {
    if (MULTI_LABEL_PUBLIC_SUFFIXES.has(labels.slice(i).join('.'))) {
      return labels.slice(i - 1).join('.');
    }
  }
  return labels.slice(labels.length - 2).join('.');
}

/**
 * 两个 host 是否属于同一个可注册域。解析不出 host、或任一侧是 IP 字面量时一律
 * 返回 true（视为同站）：跨域信号缺失不能被当成「跨域」，否则会把内网地址、
 * CDN 的 IP 直连等等正常请求误杀。与 Rust 侧 same_registrable_site 一致。
 */
export function sameRegistrableSite(a: string, b: string): boolean {
  if (!a || !b) return true;
  if (isIpLiteral(a) || isIpLiteral(b)) return true;
  return registrableDomain(a) === registrableDomain(b);
}

function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[/, '').replace(/\]$/, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
}

/** text/html 与 xhtml；**空的 Content-Type 也算 html** —— 缺头不该成为漏网的
 *  理由。与 Rust 侧 is_html_content_type 一致。 */
export function isHtmlContentType(contentType: string): boolean {
  const main = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return main === '' || main === 'text/html' || main === 'application/xhtml+xml';
}

/**
 * 可见正文长度：剥掉 script/style/标签、折叠空白之后还剩多少字符。
 *
 * 刻意与 Rust 侧 strip_html_full 的形状对齐（标签边界断行、逐行 trim 后连接），
 * 唯一已知差异是实体解码（Rust 解 &amp;，这里保持原文），那只会让字符数
 * 略偏大，而阈值 200 两侧同值，差异不足以改变判定。
 */
export function visibleTextLength(html: string): number {
  const src = String(html ?? '');
  // 手工扫而不是用正则：Rust 侧 strip_html_full 在标签**内部**的字符一个都不留，
  // 只在每个标签边界断行。用「把 < 换成换行」的正则会漏下标签名本身
  // （`<p>Clean</p>` 会算成 "p\nClean\np"），两侧口径就漂了。
  //
  // 逐字符扫（而不是 replace(/</g, '\n') 反复重扫）还有一个更实际的理由：这条函数
  // 跑在每个 2xx 应答上，body 可能是几百 KB 的整页。
  let raw = '';
  let skipTag = '';
  let inTag = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '<') {
      if (skipTag === '') {
        const m = /^<(script|style)(?=[\s>/])/i.exec(src.slice(i, i + 8));
        if (m) skipTag = m[1]!.toLowerCase();
      } else if (src.startsWith(`</${skipTag}>`, i)) {
        i += skipTag.length + 3;
        skipTag = '';
        inTag = false;
        continue;
      }
      inTag = true;
      raw += '\n';
      i++;
      continue;
    }
    if (c === '>') { inTag = false; i++; continue; }
    if (!inTag && skipTag === '') raw += c;
    i++;
  }
  const collapsed = raw.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  return [...collapsed].length;
}

/** meta refresh 的延迟秒数：content 以数字开头，没有数字就是「立即」。 */
function metaRefreshDelaySecs(content: string): number {
  const digits = /^\d*/.exec(content)?.[0] ?? '';
  const n = Number(digits);
  return Number.isFinite(n) ? n : 0;
}

/** 从 HTML 里取出「延迟够短的 meta refresh 跳转目标」（取不到则 null）。
 *  语义与 Rust 侧 extract_meta_refresh + immediate_offsite_redirect_host 对齐：
 *  延迟必须 ≤ HIJACK_META_REFRESH_MAX_DELAY_SECS，且只认绝对 URL——相对跳转
 *  必然同站，没有判定价值。 */
function immediateMetaRefreshHost(html: string): string | null {
  for (const tag of html.match(META_REFRESH_RE) ?? []) {
    const lower = tag.toLowerCase();
    if (!lower.includes('http-equiv') || !lower.includes('refresh')) continue;
    // 值的定界符必须与开引号匹配：双引号值里可以含单引号（url='/rel/path'）。
    const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/is.exec(tag);
    const value = content?.[1] ?? content?.[2];
    // 没有 url= 的标签要 continue 而不是放弃：`content="5"` 这种形态很常见，
    // 提前 return 会让后面真正的跳转目标再也扫不到（Rust 侧同一个坑）。
    if (!value) continue;
    if (metaRefreshDelaySecs(value) > HIJACK_META_REFRESH_MAX_DELAY_SECS) continue;
    const um = META_REFRESH_URL_RE.exec(value);
    const target = um?.[1]?.trim();
    if (!target) continue;
    const unquoted = target.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1').trim();
    if (unquoted) return hostOf(unquoted) ?? hostOf(`https://${unquoted}`);
  }
  return null;
}

/** 文档头部 JS 里的跳站外目标（meta refresh 之外的那一路）。 */
function jsRedirectHost(html: string, baseHost: string): string | null {
  const raw = String(html ?? '');
  // 只在文档真的超过阈值时才切头部；切的是**字符**，所以先按代码单元多切一倍再收，
  // 避免对整页做一次完整的字符数组展开。
  const head = raw.length > HIJACK_JS_SCAN_CHARS
    ? [...raw.slice(0, HIJACK_JS_SCAN_CHARS * 2)].slice(0, HIJACK_JS_SCAN_CHARS).join('')
    : raw;
  // 全局扫描而不是取第一个匹配：页面常在头部先写一个同域的
  // location.href（渲染时的回退基准地址），真正的站外跳转在后面。Rust 侧用
  // captures_iter 逐个定位，只取第一个**站外**的；只看第一个匹配会漏掉真正的信号。
  for (const re of [JS_ASSIGN_RE, JS_REPLACE_RE]) {
    const g = new RegExp(re.source, `${re.flags}g`);
    for (const m of head.matchAll(g)) {
      const host = hostOf(m[1] ?? '');
      if (host && !sameRegistrableSite(host, baseHost)) return host;
    }
  }
  return null;
}

/** 文档里的「立即跳站外」目标 host（没有则 null）。 */
function offsiteRedirectHost(body: string, baseHost: string): string | null {
  const metaHost = immediateMetaRefreshHost(body);
  if (metaHost && !sameRegistrableSite(metaHost, baseHost)) return metaHost;
  return jsRedirectHost(body, baseHost);
}

/** 一次「成功」应答的劫持判定输入。三个字段都与 Rust 侧 HijackProbe 同名同义。 */
export interface HijackProbe {
  /** 工具请求的原始 URL。 */
  requestUrl: string;
  /** follow（HTTP 重定向 + meta refresh）之后的最终 URL（JS 侧 = Response.url）。 */
  finalUrl: string;
  /** 最后一跳响应的原始 Content-Type 头。 */
  contentType: string;
  /** 最后一跳响应的原始 body（未经文本抽取，meta refresh 与 title 都在里面）。 */
  body: string;
}

/**
 * 判定一个「2xx 成功」应答是否其实是被劫持/挡板页。返回 null 表示放过。
 *
 * 四条信号（全部满足才算数，单条弱信号绝不下判定），与 Rust 侧同名实现一致：
 *
 * ```text
 * A 跨可注册域      finalUrl 的 registrable domain ≠ request host 的
 * B 短 html 正文   content-type 是 html/xhtml 且可见正文 < 200 字符
 * C 挡板指纹       正文命中已知拦截/劫持页的组合正则
 * D 立即跳站外      meta refresh(延迟 ≤ 3s) 或头部脚本里的 location 指向站外域
 *
 * 判定为劫持：C && B            挡板页（人机墙/403 模板，同域出现即可定罪）
 *             A && (B || C)    跨可注册域 + 正文小或命中指纹
 *             A && D            跨可注册域 + 立即跳站外
 * 其余一律放过。
 * ```
 *
 * 为什么 D 必须配 A：正常站点做跨站跳转是常事（短链展开、SSO、品牌改名），
 * 单看「文档里有站外跳转」会误杀。
 */
export function detectResponseHijack(probe: HijackProbe): HijackVerdict | null {
  const requestHost = hostOf(probe.requestUrl);
  const finalHost = hostOf(probe.finalUrl);
  const baseHost = requestHost ?? finalHost ?? '';
  const crossSite = requestHost && finalHost ? !sameRegistrableSite(requestHost, finalHost) : false;
  const html = isHtmlContentType(probe.contentType);
  const body = String(probe.body ?? '');
  const short = html && visibleTextLength(body) < HIJACK_VISIBLE_TEXT_MAX_CHARS;
  const fingerprint = html && HIJACK_BLOCKPAGE_PATTERNS.some((re) => re.test(body));
  const offsite = crossSite && offsiteRedirectHost(body, baseHost) !== null;

  if (fingerprint && short) {
    return {
      hijacked: true,
      signal: 'blockpage-fingerprint',
      why: '命中已知拦截/挡板页指纹，且可见正文几乎为空——正常内容页不会长这样',
    };
  }
  if (crossSite && (short || fingerprint)) {
    return fingerprint
      ? { hijacked: true, signal: 'cross-domain-blockpage', why: '应答来自另一个可注册域，且命中已知拦截/挡板页指纹' }
      : { hijacked: true, signal: 'cross-domain-short-html', why: '应答来自另一个可注册域，且是一张几乎空白的 html 页面' };
  }
  if (offsite) {
    return {
      hijacked: true,
      signal: 'cross-domain-immediate-redirect',
      why: '应答来自另一个可注册域，且文档自身要求立即跳转到站外地址',
    };
  }
  return null;
}

/**
 * 面向模型/上层的错误文案。
 *
 * 这里**必须**出现 `network` 这个词：上层 netGuard 的 `isNetworkError` 与
 * `classifyFailure` 都靠它把这次失败归类成网络类，才会去跑兜底路由重试并
 * `recordNetOutcome(路由, false)`。靠错误文本传递分类是隐式契约（与 Rust 侧
 * HijackVerdict::error_message 同一条）。
 */
export function hijackErrorMessage(verdict: HijackVerdict, probe: HijackProbe): string {
  return `Network interception (hijack: ${verdict.signal}): ${verdict.why ?? ''}. Requested ${probe.requestUrl} but the response was served by ${probe.finalUrl} (content-type: ${probe.contentType || '(none)'}). This is NOT the content the site would serve — do not trust it and do not retry the same URL directly: retry through the configured proxy, use a mirror, or switch to another source.`;
}

/**
 * 判断一个「成功」响应是否其实是被劫持/挡板页。参数刻意给得保守：
 *  - `expectContent`：调用方知道这个 URL 本该有正文（web_fetch/web_scrape 的
 *    页面抓取为 true，JSON/API 为 false）。只有 true 时空正文才参与判定。
 *  - `url`：请求 URL，用于比对跨域跳转的目标。
 *
 * 这条是**已经抽过文本**的兜底（调用方手上只有纯文本，meta refresh 与 title
 * 早就被剥掉了），所以能抓的只有残留特征：跨可注册域的立即跳转、挡板页指纹
 * 配空正文、以及调用方声明「本该有正文」时的空正文。完整的四信号判定走
 * `detectResponseHijack`（需要在抽文本之前调）。
 */
export function detectHijack(
  body: string | null | undefined,
  opts: { url?: string; expectContent?: boolean } = {},
): HijackVerdict {
  const html = String(body ?? '');
  const trimmed = html.trim();
  if (!trimmed) {
    return opts.expectContent ? { hijacked: true, signal: 'empty-body' } : NOT_HIJACKED;
  }

  const host = opts.url ? hostOf(opts.url) : null;
  if (host) {
    // 跨可注册域的立即跳转：同站（含子域/父域）跳转是站点自己的正常行为。
    const offsite = offsiteRedirectHost(trimmed, host);
    if (offsite) return { hijacked: true, signal: `redirect-to-${offsite}` };
  }

  const pattern = HIJACK_BLOCKPAGE_PATTERNS.find((re) => re.test(trimmed));
  if (!pattern) return NOT_HIJACKED;
  // 指纹命中但页面确有实质正文时放过：正常页面引用一句挡板文案不算被劫持。
  if (visibleTextLength(trimmed) >= HIJACK_VISIBLE_TEXT_MAX_CHARS) return NOT_HIJACKED;
  return { hijacked: true, signal: 'blockpage-fingerprint' };
}

/** 一句话说明，让失败信息能自证「为什么这页不算数」。 */
export function hijackReason(verdict: HijackVerdict): string {
  return verdict.signal === 'empty-body'
    ? '响应正文为空，疑似被中间设备改写'
    : `响应疑似拦截/劫持页（${verdict.signal ?? 'unknown'}），不是真实内容`;
}

export function hostBlocked(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  const state = hosts.get(host);
  return !!state && state.blockedUntil > Date.now();
}

export function recordNetFailure(url: string): { tripped: boolean; host: string | null } {
  const host = hostOf(url);
  if (!host) return { tripped: false, host: null };
  const state = hosts.get(host) ?? { fails: 0, blockedUntil: 0 };
  state.fails += 1;
  let tripped = false;
  if (state.fails >= HOST_TRIP_THRESHOLD) {
    state.blockedUntil = Date.now() + HOST_COOLDOWN_MS;
    tripped = true;
    persistTrip(host);
  }
  hosts.set(host, state);
  return { tripped, host };
}

export function recordNetSuccess(url: string): void {
  const host = hostOf(url);
  if (host) hosts.delete(host);
}

/** Hosts the planner should avoid: the live 5-minute cooldown set UNION the
 *  persisted 24h trip history. The wide list feeds the environment brief
 *  (planning knowledge); it does NOT drive hostBlocked()'s instant-fail —
 *  cooldown expiry means "maybe recovered", and only a fresh trip re-blocks. */
export function blockedHosts(): string[] {
  const now = Date.now();
  const live = [...hosts.entries()]
    .filter(([, state]) => state.blockedUntil > now)
    .map(([host]) => host);
  const history = loadTripHistory()
    .filter(p => now - p.lastTripAt < HISTORY_RETENTION_MS)
    .map(p => p.host);
  return [...new Set([...live, ...history])].sort();
}

/** Synthetic failure for a blocked host: instant, with the skip-and-continue
 *  directive (mirrors the failure policy's degrade wording). */
export function blockedHostMessage(url: string, lastError?: string): string {
  const host = hostOf(url) ?? url;
  // S2：若该 URL 有一个字节一致的镜像端点，把确切地址直接给出——比「改用替代
  // 来源」这类泛泛措辞可执行得多，且不需要模型再去猜/再花一轮搜索。
  const rw = primaryRewrite(url);
  const rewrite = rw ? `字节一致的替代端点（单请求改写、不落盘）：${rw.url}` : '';
  return `此来源（${host}）连续网络失败，已熔断 5 分钟——请勿再请求该主机上的任何地址。改用替代来源、内联或本地替代内容，或跳过此资源继续任务。${rewrite}${lastError ? `最近错误：${lastError}` : ''}`;
}

/** One-line guidance appended to a FIRST network failure of a host, so the
 *  model self-corrects before the breaker even trips. */
export function netFailureHint(url: string, message: string): string {
  // S2：把「换到哪个镜像」具体化到 URL 级——诊断出被墙后最便宜的解药常常不是
  // 去配代理，而是把这一次请求换成字节一致的镜像端点。
  const rw = primaryRewrite(url);
  const rewrite = rw ? ` 这个 URL 有字节一致的镜像端点，可直接改用 ${rw.url}（${rw.rule}，单请求改写、不落盘），无需先配代理。` : '';
  return `${message} — 若为网络不可达，请勿原样重试：换镜像/来源、内联替代或跳过此资源继续任务。${rewrite}`;
}

/** Failure classes for the failure policy's class-level loop detection. */
export type FailureClass =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'permission'
  | 'not-found'
  | 'rate-limit'
  | 'context'
  | 'content'
  | 'generic';

export function classifyFailure(message: string): FailureClass {
  const m = message.toLowerCase();
  if (/error sending request|connection|unable to connect|unable to resolve|unreachable|\bdns\b|econn|reset by peer|fetch failed|network|证书|certificate|tls|连接/.test(m)) return 'network';
  if (/timed?[\s-]?out|超时/.test(m)) return 'timeout';
  if (/401|403|unauthorized|forbidden|api[- ]?key|invalid.*key|凭证|未授权/.test(m)) return 'auth';
  if (/permission denied|eacces|eperm|access denied|权限/.test(m)) return 'permission';
  if (/404|not found|no such file|does not exist|不存在|无法找到/.test(m)) return 'not-found';
  if (/429|rate limit|too many requests|限流/.test(m)) return 'rate-limit';
  // Before 'content': provider 400 bodies say "maximum context length" /
  // "context_length_exceeded" — a structural overflow, not a malformed
  // payload. Class-level loop detection must see it, or the request ladder
  // grinds through retry/reflect rounds that only inflate the context further.
  // "prompt is too long" is the Anthropic route's wording for the same 400.
  if (/maximum context|context length|context_length_exceeded|input length exceeds|prompt is too long/.test(m)) return 'context';
  if (/unsupported content type|invalid json|parse|decode|encoding|乱码/.test(m)) return 'content';
  return 'generic';
}

/** Per-class recovery guidance (what "skip / work around" MEANS for this
 *  class — the model gets an actionable escape, not just "try differently"). */
export const FAILURE_CLASS_HINTS: Record<FailureClass, string> = {
  network: '此类失败 = 该主机/网络在此环境不可达。换镜像或离线替代、内联内容，或跳过该资源；不要请求同一主机的其他地址。',
  timeout: '此类失败 = 操作超时。把任务拆小、换更快路径或改后台执行；不要原样重试。',
  auth: '此类失败 = 凭证缺失或无效。停止重试，向用户索要正确的密钥/登录。',
  permission: '此类失败 = 此环境不允许该操作。不要重试；换合规路径或向用户说明。',
  'not-found': '此类失败 = 目标不存在。核对路径/名称/来源一次，仍失败就换目标或跳过。',
  'rate-limit': '此类失败 = 被限流。换后端或降低频率，不要立即原样重试。',
  context: '此类失败 = 对话已超出模型上下文窗口，属结构性失败。任何重试都只会原样 400（注入的指令还在加长上下文）；立即停止回合，交回用户压缩或新开会话。',
  content: '此类失败 = 返回内容不符合预期。换解析方式或来源；不要原样重试。',
  generic: '',
};
