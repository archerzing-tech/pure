// src/shared/netRoute.ts
// 全应用唯一的一张网络路由决策面：给定目标，回答两个问题——「先走哪条路」
// 与「第一条路失败后走哪条」。LLM、web_fetch、web_scrape、web_search、
// web_public_api、download_file、shell 子进程、MCP……每一个出口都必须经过
// 这里，否则同一个「proxy.ts 似乎没效果」的现象会在每个出口上各复现一次
// （历史上就是这样：LLM 走「直连优先且无兜底」，工具走「代理永远优先」，
// 两边各错一半）。
//
// 决策拆成彼此独立的两层：
//
//   1. 谁是首选 —— host 分三类，静态分类面：
//        neutral      本地/环回/局域网：永不走代理，也永远没有代理兜底。
//                     把 127.0.0.1 发给代理只会凭空造出一个死出口。
//        proxy-first  国内通常不通的境外服务：直连不是慢而是被静默丢包，
//                     每次都要烧满连接超时，所以代理优先。
//        direct-first 其余全部远程主机：直连优先。
//      「直连优先」仍然是总原则——可达性无法从静态名单得知（同一个域名在
//      公司能连、在家被墙），所以只有「直连确定不通」的那一小撮才代理优先。
//
//   2. 谁保证兜底 —— 通用契约，与名单无关：只要配了代理且目标是远程主机，
//      netRouteProxyPair 一定给出反向路由。direct-first 拿到「直连优先 +
//      代理兜底」，proxy-first 拿到「代理优先 + 直连兜底」。
//      早期版本只有 4 个 proxy-first 域名拿得到兜底（而且兜底是直连），
//      其余主机的 fallback 恒为空——于是「配了代理但仍然连不上」直接等价于
//      失败。名单只决定「谁是首选」，不决定「有没有兜底」。
//
// 学习（recordNetOutcome）：真实跑通的那条路被记住，带 30 分钟 TTL——用户
// 从家切到公司切到热点，旧的判断全部作废，一次误判不该被永久固化。失败
// 会清掉记忆让分类重新决策，但失败本身从不被「学习」。
// 持久化沿用 netGuard 的形态（localStorage，尽力而为）。

import { hostOf } from './netGuard';

export { hostOf };

export type NetRoute = 'direct' | 'proxy';

/** 分类面三层。direct-first 是默认层，名单里不必出现。 */
export type HostClass = 'neutral' | 'proxy-first' | 'direct-first';

/**
 * 无单一目标主机的出口：web_search / web_public_api 一次扇出到几十个后端，
 * execute_command / MCP stdio 则把代理注入子进程环境。它们没法拿某个具体
 * host 去分类，只能按「出口面」整体记忆。
 */
export type NetSurface = 'web_search' | 'web_public_api' | 'image' | 'command' | 'mcp';

const STORE_KEY = 'pure.netRoute.v1';

/**
 * 学习记忆的保质期。取 30 分钟：一次成功的直连/代理判定通常只反映「当前
 * 这张网、这一刻」，而切 Wi-Fi / 换网络 / 公司VPN 状态变化都发生在这个量级
 * 的时间尺度上。没有 TTL 时，家里的判定会把公司网络钉死一整天。
 */
export const LEARNED_ROUTE_TTL_MS = 30 * 60_000;

// ── 分类面 ────────────────────────────────────────────────────────────────

type HostMatchKind = 'suffix' | 'exact';

interface HostClassRule {
  kind: HostMatchKind;
  value: string;
  class: HostClass;
  /** 这条规则为什么存在。静态名单最难维护的就是「为什么」，逐条留档。 */
  why: string;
}

/**
 * suffix 匹配必须卡在点边界上：`evil-anthropic.com` 的结尾也是
 * `anthropic.com`，裸 endsWith 会把它误判成「已封锁」而白白把请求送去
 * 代理；反过来 `api.anthropic.com` / `api.z.ai` 这类子域又必须命中父域
 * 规则，否则真正的 API 端点漏判。
 */
function hostRuleMatches(host: string, kind: HostMatchKind, value: string): boolean {
  if (kind === 'exact') return host === value;
  return host === value || host.endsWith(`.${value}`);
}

const HOST_CLASS_RULES: readonly HostClassRule[] = [
  // ── neutral：本地/环回/局域网 ──
  { kind: 'suffix', value: 'localhost', class: 'neutral', why: '回环地址，任何代理都只会把它变成死路' },
  { kind: 'suffix', value: 'local', class: 'neutral', why: 'mDNS 局域网名（打印机/NAS/开发机）' },
  { kind: 'suffix', value: 'internal', class: 'neutral', why: '企业内网常见后缀' },
  { kind: 'suffix', value: 'home.arpa', class: 'neutral', why: 'RFC 8375 家庭网络保留后缀' },

  // ── proxy-first：国内通常不通的境外服务 ──
  { kind: 'suffix', value: 'openai.com', class: 'proxy-first', why: 'OpenAI API 直连被静默丢包' },
  { kind: 'suffix', value: 'anthropic.com', class: 'proxy-first', why: 'Claude API 同上（api./console. 子域一并命中）' },
  { kind: 'suffix', value: 'claude.ai', class: 'proxy-first', why: 'Claude 官网与 Web 端' },
  { kind: 'suffix', value: 'claudeusercontent.com', class: 'proxy-first', why: 'Claude 附件/静态资源 CDN' },
  { kind: 'suffix', value: 'huggingface.co', class: 'proxy-first', why: '模型权重站直连基本不可用' },
  { kind: 'suffix', value: 'hf.co', class: 'proxy-first', why: 'Hugging Face 短域名' },
  { kind: 'suffix', value: 'hf-mirror.com', class: 'direct-first', why: '国内镜像站：直连才是对的，别被上游的 proxy-first 传染' },
  { kind: 'suffix', value: 'openrouter.ai', class: 'proxy-first', why: '聚合网关，直连不通' },
  { kind: 'suffix', value: 'z.ai', class: 'proxy-first', why: '智谱国际版；api.z.ai 由父域规则覆盖' },
  { kind: 'suffix', value: 'groq.com', class: 'proxy-first', why: '推理 API 直连不通' },
  { kind: 'suffix', value: 'mistral.ai', class: 'proxy-first', why: '同上' },
  { kind: 'suffix', value: 'together.ai', class: 'proxy-first', why: '同上' },
  { kind: 'suffix', value: 'together.xyz', class: 'proxy-first', why: 'together.ai 的旧域名' },
  { kind: 'suffix', value: 'fireworks.ai', class: 'proxy-first', why: '同上' },
  { kind: 'suffix', value: 'replicate.com', class: 'proxy-first', why: '模型托管直连不通' },
  { kind: 'suffix', value: 'perplexity.ai', class: 'proxy-first', why: '搜索 API 直连不通' },
  { kind: 'suffix', value: 'cohere.ai', class: 'proxy-first', why: '同上' },
  { kind: 'suffix', value: 'x.ai', class: 'proxy-first', why: '同上' },
  { kind: 'exact', value: 'api.minimaxi.com', class: 'proxy-first', why: 'MiniMax 开放平台国际端点直连不通' },
  { kind: 'exact', value: 'generativelanguage.googleapis.com', class: 'proxy-first', why: 'Gemini API' },
  { kind: 'exact', value: 'integrate.api.nvidia.com', class: 'proxy-first', why: 'NVIDIA NIM 推理端点；www.nvidia.com 仍可直连，故只精确匹配' },
  { kind: 'suffix', value: 'github.com', class: 'proxy-first', why: 'GitHub 主站/api/codeload 直连不稳定' },
  { kind: 'suffix', value: 'githubusercontent.com', class: 'proxy-first', why: 'raw./objects. 内容 CDN，直连经常被重置' },
  { kind: 'suffix', value: 'githubassets.com', class: 'proxy-first', why: 'GitHub 静态资源 CDN' },
  { kind: 'suffix', value: 'github.io', class: 'proxy-first', why: 'Pages 站点同样走境外链路' },
  { kind: 'suffix', value: 'crates.io', class: 'proxy-first', why: 'Rust registry 直连不通（static.crates.io 一并命中）' },
  { kind: 'suffix', value: 'jsdelivr.net', class: 'proxy-first', why: '前端 CDN，直连被干扰' },
  { kind: 'suffix', value: 'pypi.org', class: 'proxy-first', why: 'PyPI 直连不通' },
  { kind: 'suffix', value: 'files.pythonhosted.org', class: 'proxy-first', why: 'PyPI 包文件 CDN' },
  { kind: 'exact', value: 'proxy.golang.org', class: 'proxy-first', why: 'Go module proxy 直连不通（golang.org 文档站仍可直连，故只精确匹配）' },
  { kind: 'exact', value: 'sum.golang.org', class: 'proxy-first', why: 'Go 校验和数据库' },
  { kind: 'suffix', value: 'goproxy.io', class: 'proxy-first', why: '海外 Go 代理' },

  // ── direct-first：写死「不要动」的国内站 ──
  { kind: 'suffix', value: 'npmmirror.com', class: 'direct-first', why: 'npm 国内镜像，走代理反而更慢；显式钉死以防被误升级为 proxy-first' },
  { kind: 'suffix', value: 'goproxy.cn', class: 'direct-first', why: 'Go 国内代理' },
  { kind: 'suffix', value: 'deepseek.com', class: 'direct-first', why: '国内厂商 API' },
  { kind: 'suffix', value: 'bigmodel.cn', class: 'direct-first', why: '智谱国内版' },
  { kind: 'suffix', value: 'moonshot.cn', class: 'direct-first', why: '月之暗面国内版' },
  { kind: 'suffix', value: 'siliconflow.cn', class: 'direct-first', why: '硅基流动国内版' },
];

/** 环回 / 私网 / 链路本地地址：走代理只会被网关拒掉。 */
function isNeutralIpLiteral(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254);
  }
  const v6 = bare.toLowerCase();
  if (!v6.includes(':')) return false;
  // ::1 / :: 与 fc00::/7（唯一本地）、fe80::/10（链路本地）
  return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

function classifyHostName(host: string): HostClass {
  if (isNeutralIpLiteral(host)) return 'neutral';
  for (const rule of HOST_CLASS_RULES) {
    if (hostRuleMatches(host, rule.kind, rule.value)) return rule.class;
  }
  return 'direct-first';
}

/**
 * 分类一个 host（接受裸 host 或完整 URL）。第一条命中的规则决定层级，
 * 所以规则表按「中性 → 代理优先 → 钉死直连」的顺序书写，语义上后者覆盖
 * 前者只是为了让显式钉死的规则更醒目。
 */
export function classifyHost(hostOrUrl: string): HostClass {
  const host = normalizeRouteHost(hostOrUrl);
  return host ? classifyHostName(host) : 'direct-first';
}

/** True where a direct connection is not merely slow but reliably blocked. */
export function blockedDirectHost(hostOrUrl: string): boolean {
  return classifyHost(hostOrUrl) === 'proxy-first';
}

export function hostSuffixMatch(host: string, suffixes: string[]): string | null {
  const h = host.toLowerCase();
  for (const suffix of suffixes) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return suffix;
  }
  return null;
}

// ── host 归一化 ────────────────────────────────────────────────────────────

/**
 * 把「调用方传的东西」收敛成同一个 key。历史上 recordNetOutcome 的调用点
 * 传的是完整 URL（`https://github.com/x`），而读侧用的是 hostOf(url)
 * （`github.com`），两边永不相等——学习写进去的是死条目，命中率恒为 0。
 * 归一化收口在这里，调用点传 URL 还是传 host 都正确。
 */
export function normalizeRouteHost(input: string): string | null {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(withScheme).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}



// ── 出口面（无单一目标主机） ────────────────────────────────────────────────

/**
 * 各出口面的静态默认层级。分成两组的理由不是「谁更快」，而是「猜错的代价
 * 能不能自己兜回来」：
 *  - 可重试面（搜索/公共 API/图像）：猜错最多多烧一个连接超时，反向路由
 *    立刻兜住，所以直连优先。
 *  - 不可重试面（shell / MCP stdio）：把 HTTP_PROXY 注入一个任意子进程后
 *    无法安全地换一条路重跑——`git push`、`npm publish`、`rm` 重跑是有害的。
 *    猜错没有第二次机会，所以宁可押用户显式配置过的代理，让学习面在真的
 *    失败之后自己翻面。
 */
const SURFACE_CLASS: Record<NetSurface, 'direct-first' | 'proxy-first'> = {
  web_search: 'direct-first',
  web_public_api: 'direct-first',
  image: 'direct-first',
  command: 'proxy-first',
  mcp: 'proxy-first',
};

/** 这些面不允许调用方「换路重试」，pair 里一律不给 fallback。 */
const NO_RETRY_SURFACES = new Set<NetSurface>(['command', 'mcp']);

const surfaceKey = (surface: NetSurface): string => `surface:${surface}`;

export function netRouteSurfacePair(
  surface: NetSurface,
  proxyUrl: string,
): { proxyUrl: string; fallbackProxyUrl: string | null } {
  if (!proxyUrl) return { proxyUrl: '', fallbackProxyUrl: null };
  const retryable = !NO_RETRY_SURFACES.has(surface);
  const route = routeForKey(
    surfaceKey(surface),
    true,
    Date.now(),
    SURFACE_CLASS[surface] === 'proxy-first' ? 'proxy' : 'direct',
  );
  if (route === 'proxy') return { proxyUrl, fallbackProxyUrl: retryable ? '' : null };
  return { proxyUrl: '', fallbackProxyUrl: retryable ? proxyUrl : null };
}

// ── 决策与学习 ─────────────────────────────────────────────────────────────

interface RouteEntry {
  route: NetRoute;
  at: number;
}

const learned = new Map<string, RouteEntry>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, RouteEntry>;
    const now = Date.now();
    for (const [host, entry] of Object.entries(parsed)) {
      // 读取时顺手丢弃过期条目：跨天启动时不必先做一次网络请求才知道记忆
      // 已经作废。
      if ((entry.route === 'direct' || entry.route === 'proxy')
        && typeof entry.at === 'number'
        && now - entry.at <= LEARNED_ROUTE_TTL_MS) {
        learned.set(host, { route: entry.route, at: entry.at });
      }
    }
  } catch {
    // 存档损坏 —— 从空记忆开始
  }
}

function persist(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const obj: Record<string, RouteEntry> = {};
    const now = Date.now();
    for (const [host, entry] of learned) {
      if (now - entry.at > LEARNED_ROUTE_TTL_MS) continue;
      obj[host] = { route: entry.route, at: entry.at };
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(obj));
  } catch {
    // 存储不可用 —— 内存中的路由照常工作
  }
}

function routeForKey(key: string, hasProxy: boolean, now: number, fallback: NetRoute): NetRoute {
  if (!hasProxy) return 'direct';
  ensureLoaded();
  const entry = learned.get(key);
  if (entry) {
    if (now - entry.at <= LEARNED_ROUTE_TTL_MS) return entry.route;
    learned.delete(key);
    persist();
  }
  return fallback;
}

/** Route decision for a host (accepts a bare host or a full URL). */
export function resolveNetRoute(hostOrUrl: string, hasProxy: boolean, now = Date.now()): NetRoute {
  const host = normalizeRouteHost(hostOrUrl);
  if (!host) return 'direct';
  return routeForKey(host, hasProxy, now, classifyHostName(host) === 'proxy-first' ? 'proxy' : 'direct');
}

/**
 * 从真实结果里学习：成功的那条路被记住（带时间戳），失败把「正在用的那条
 * 路」的记忆清掉，让分类重新决策。失败的路由从不被「学习」——否则重试会
 * 被自己的记忆堵死。
 */
export function recordNetOutcome(hostOrUrl: string, route: NetRoute, ok: boolean, now = Date.now()): void {
  const host = normalizeRouteHost(hostOrUrl);
  if (!host) return;
  // 本地/环回没有「代理优先」可言，记了也只会污染分类面。
  if (classifyHostName(host) === 'neutral') return;
  recordRouteForKey(host, route, ok, now);
}

/** 出口面的学习入口（key 已是内部形态，不做 URL 解析）。 */
export function recordNetSurfaceOutcome(surface: NetSurface, route: NetRoute, ok: boolean, now = Date.now()): void {
  recordRouteForKey(surfaceKey(surface), route, ok, now);
}

function recordRouteForKey(key: string, route: NetRoute, ok: boolean, now: number): void {
  ensureLoaded();
  const entry = learned.get(key);
  if (ok) {
    if (entry?.route === route) return;
    learned.set(key, { route, at: now });
    persist();
  } else if (entry?.route === route) {
    learned.delete(key);
    persist();
  }
}

// ── 出口契约 ───────────────────────────────────────────────────────────────

export interface NetRoutePair {
  /** 先试的路由；'' = 直连。 */
  proxyUrl: string;
  /** 网络类失败后的反向路由；'' = 直连，null = 没有兜底。 */
  fallbackProxyUrl: string | null;
  host: string | null;
}

/**
 * For a URL: the proxyUrl to try FIRST, and — whenever a proxy is configured
 * and the destination is a REMOTE host — the OPPOSITE route as the one-shot
 * fallback for network-class failures. 分类面只回答「谁是首选」；有没有兜底
 * 由这条通用契约回答：远程主机一律有兜底，neutral 主机（环回/内网）一律没有。
 * 适配器契约：先试 proxyUrl，网络类失败（以及被劫持伪装成的成功响应）就用
 * fallbackProxyUrl 再试一次，最后把真实结局交给 recordNetOutcome。
 */
export function netRouteProxyPair(url: string, proxyUrl: string): NetRoutePair {
  // 归一化吃端口：学习表按 hostname 存，否则同一个站用 :443/:8443 各记一条。
  const host = normalizeRouteHost(url);
  if (!proxyUrl || !host) return { proxyUrl: '', fallbackProxyUrl: null, host: null };
  if (classifyHostName(host) === 'neutral') return { proxyUrl: '', fallbackProxyUrl: null, host };
  return routeForKey(host, true, Date.now(), classifyHostName(host) === 'proxy-first' ? 'proxy' : 'direct') === 'proxy'
    ? { proxyUrl, fallbackProxyUrl: '', host }
    : { proxyUrl: '', fallbackProxyUrl: proxyUrl, host };
}

// ── 打通路径：枚举与预算 ─────────────────────────────────────────────────
// 「打通」是让对**目标主机本身**的访问成立；镜像是它失败后的兵底，绝不是主路。
// 但也不死磕到最后一步：用户定的口径是——在枚举的打通路径里试到 75% 仍不行，
// 就迅速切镜像（效率优先：快速拿到资源）。
//
// 枚举按「出口路线 × 是否退避重试」展开成四步：
//   1 首选出口  2 反向出口  3 首选出口·退避重试  4 反向出口·退避重试
// 预算 = ceil(4 × 0.75) = 3：试到第 3 步还不行就切镜像（跳过第 4 步）。
// 配了代理的路线上代理与直连互为反向；没配代理、或目标为本地/环回时，
// 只有一个直连出口（不会凭空造出两条一样的路）。
export const UNBLOCK_ATTEMPT_STEPS = 4;
export const UNBLOCK_BUDGET_RATIO = 0.75;
/** 切镜像之前应实试的出口尝试数（75% 预算）。 */
export const MIRROR_AFTER_ATTEMPTS = Math.ceil(UNBLOCK_ATTEMPT_STEPS * UNBLOCK_BUDGET_RATIO);

export interface UnblockAttempt {
  route: NetRoute;
  /** 这条出口的代理地址（'' = 直连）。 */
  proxyUrl: string;
  /** 是否为本轮的退避重试（枚举的第 3/4 步）。 */
  retry: boolean;
}

/** 该目标的完整打通路径枚举（四步，或没有代理时的单一直连）。 */
export function unblockAttemptPlan(hostOrUrl: string, proxyUrl: string): UnblockAttempt[] {
  const host = normalizeRouteHost(hostOrUrl);
  if (!host || !proxyUrl || classifyHostName(host) === 'neutral') {
    return [{ route: 'direct', proxyUrl: '', retry: false }];
  }
  const primary: NetRoute = resolveNetRoute(host, true);
  const opposite: NetRoute = primary === 'proxy' ? 'direct' : 'proxy';
  const toUrl = (r: NetRoute): string => (r === 'proxy' ? proxyUrl : '');
  return [
    { route: primary, proxyUrl: toUrl(primary), retry: false },
    { route: opposite, proxyUrl: toUrl(opposite), retry: false },
    { route: primary, proxyUrl: toUrl(primary), retry: true },
    { route: opposite, proxyUrl: toUrl(opposite), retry: true },
  ];
}

/** 切镜像之前应该实试的那一段（枚举的前 75%）。 */
export function unblockAttemptsBeforeMirror(hostOrUrl: string, proxyUrl: string): UnblockAttempt[] {
  return unblockAttemptPlan(hostOrUrl, proxyUrl).slice(0, MIRROR_AFTER_ATTEMPTS);
}