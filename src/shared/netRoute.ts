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
  const fallback = SURFACE_CLASS[surface] === 'proxy-first' ? 'proxy' : 'direct';
  const route = routeForKey(
    surfaceKey(surface),
    true,
    Date.now(),
    proxyFallbackFor(proxyUrl, Date.now(), fallback),
  );
  if (route === 'proxy') return { proxyUrl, fallbackProxyUrl: retryable ? '' : null };
  return { proxyUrl: '', fallbackProxyUrl: retryable ? proxyUrl : null };
}

// ── 决策与学习 ─────────────────────────────────────────────────────────────

interface RouteEntry {
  route: NetRoute;
  at: number;
  /** 死路半边：这条路由最近一次失败后，在此之前选路直接翻反向。
   *  缺省 = 没有死路信号（正常记忆）。 */
  deadUntil?: number;
  /** 旧版单槽时延（EMA α=0.3）：读档时按行的 route 迁进对应双路槽，
   *  之后不再写。保留字段仅为兼容旧存档。 */
  latencyEma?: number;
  /** 直连路的响应头时延 EMA（α=0.3，headers_ms 归槽）。「谁快用谁」
   *  的数据底座：换路不覆盖对立路的样本，两路各自积累。 */
  latencyEmaDirect?: number;
  /** 代理路的响应头时延 EMA。同上。 */
  latencyEmaProxy?: number;
  /** 最近一次成功时刻。 */
  lastOkAt?: number;
}

// ── 代理健康行（期2 路由脑） ────────────────────────────────────────────────
// 代理 endpoint 本身是路径健康表里的一等行：一个探测覆盖所有 proxy-first
// 主机——否则每个 proxy-first 主机都要各自撞一次死代理的墙才学会翻面
// （FlClash 停止态、127.0.0.1:7897 无监听的真机判例：配置里挂着代理不等于
// 代理可用）。语义反转（用户定调 2026-10-30）：配置里有代理 ≠ 优先走代理。

/** 代理健康条目：与 learned 同 map 存储，key = `proxy:<规范化代理地址>`。
 *  旧版读取端按 route 字段校验自然丢弃这类条目，v1 存档零迁移。 */
interface ProxyHealthEntry {
  proxy: true;
  at: number;
  /** 最近一次探测结论。 */
  ok: boolean;
  latencyMs?: number;
  /** 探测失败时刻起的死期；死期内所有 proxy-first 决策翻直连。 */
  deadUntil?: number;
}

type HealthEntry = RouteEntry | ProxyHealthEntry;

const isProxyEntry = (e: HealthEntry): e is ProxyHealthEntry => 'proxy' in e && (e as ProxyHealthEntry).proxy === true;
const isRouteEntry = (e: HealthEntry): e is RouteEntry => 'route' in e;

export type ProxyHealthState = 'unknown' | 'alive' | 'dead';

const PROXY_KEY_PREFIX = 'proxy:';
/** 代理死期的保质期：与死路半边同量级——代理恢复（用户点开 FlClash）
 *  常在分钟级，5 分钟后自动重探，复活即恢复代理优先。 */
export const PROXY_DEAD_TTL_MS = 5 * 60_000;

function proxyKey(proxyUrl: string): string {
  return `${PROXY_KEY_PREFIX}${proxyUrl.trim().toLowerCase()}`;
}

/** 从成功/失败结果里学习代理 endpoint 健康（探测或真实请求撞墙均可喂）。 */
export function recordProxyProbe(proxyUrl: string, ok: boolean, now = Date.now(), latencyMs?: number): void {
  const url = String(proxyUrl ?? '').trim();
  if (!url) return;
  ensureLoaded();
  learned.set(proxyKey(url), {
    proxy: true,
    at: now,
    ok,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(ok ? {} : { deadUntil: now + PROXY_DEAD_TTL_MS }),
  });
  persist();
}

/** 代理当前是否可用作首选路（unknown = 尚无探测数据，按可用处理——
 *  没探过就判死会把新配置一上来全打成直连）。 */
export function proxyHealthy(proxyUrl: string, now = Date.now()): boolean {
  const info = proxyHealthInfo(proxyUrl, now);
  return info.state !== 'dead';
}

/** 设置页/诊断用：代理健康三态与数据。 */
export function proxyHealthInfo(proxyUrl: string, now = Date.now()): {
  state: ProxyHealthState; latencyMs?: number; deadSince?: number;
} {
  const url = String(proxyUrl ?? '').trim();
  if (!url) return { state: 'unknown' };
  ensureLoaded();
  const entry = learned.get(proxyKey(url));
  if (!entry || !('proxy' in entry) || !(entry as ProxyHealthEntry).proxy) return { state: 'unknown' };
  const e = entry as ProxyHealthEntry;
  if (!e.ok) {
    // 失败的探测只有死期内的价值：死期中如实报「不可达」，死期一过回
    // unknown（该重探了）——绝不能落进下面的 alive 分支，把一次失败谎报
    // 成「可达 · N ms」。
    if (e.deadUntil !== undefined && now < e.deadUntil) {
      return { state: 'dead', deadSince: e.at, ...(e.latencyMs !== undefined ? { latencyMs: e.latencyMs } : {}) };
    }
    return { state: 'unknown' };
  }
  if (now - e.at > LEARNED_ROUTE_TTL_MS) {
    // 健康数据本身过期（30 分钟前的「活着」不保证现在活着）：回 unknown，
    // 让下一次探测/真实请求重新落行。
    return { state: 'unknown' };
  }
  return { state: 'alive', ...(e.latencyMs !== undefined ? { latencyMs: e.latencyMs } : {}) };
}

/** proxy-first 主机的分类兜底要不要因代理死期翻成直连。 */
function proxyFallbackFor(proxyUrl: string, now: number, fallback: NetRoute): NetRoute {
  if (fallback === 'proxy' && proxyUrl && !proxyHealthy(proxyUrl, now)) return 'direct';
  return fallback;
}

/** 死路半边的保质期：代理故障恢复常在分钟级，5 分钟内跳过刚失败的路，
 *  过期后照常重探，复活即恢复首选。 */
export const DEAD_ROUTE_TTL_MS = 5 * 60_000;

const learned = new Map<string, HealthEntry>();
let loaded = false;

/** 清空学习记忆（含未落盘部分）。仅供测试隔离使用：路由学习是模块级单例，
 *  任何真实下载路径都会写入记录，跨文件跑测试时会把 resolveNetRoute 的
 *  断言翻面（2026-10-26 download_file 镜像测试踩中）。 */
export function resetLearnedRoutes(): void {
  learned.clear();
  loaded = false;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, HealthEntry>;
    const now = Date.now();
    for (const [host, entry] of Object.entries(parsed)) {
      if (isProxyEntry(entry)) {
        // 代理健康行：结构完整即导入（自身带 at，过期由 proxyHealthInfo 判）。
        if (typeof entry.at === 'number' && (entry.ok === true || entry.ok === false)) {
          learned.set(host, entry);
        }
        continue;
      }
      // 读取时顺手丢弃过期条目：跨天启动时不必先做一次网络请求才知道记忆
      // 已经作废。
      if (isRouteEntry(entry)
        && (entry.route === 'direct' || entry.route === 'proxy')
        && typeof entry.at === 'number'
        && now - entry.at <= LEARNED_ROUTE_TTL_MS) {
        // 旧版单槽时延迁移：按该行钉着的路归进对应双路槽（期3「谁快用谁」
        // 的读档兼容），之后写档只写双槽。
        const legacy = typeof entry.latencyEma === 'number'
          ? (entry.route === 'direct' ? { latencyEmaDirect: entry.latencyEma } : { latencyEmaProxy: entry.latencyEma })
          : {};
        learned.set(host, {
          route: entry.route,
          at: entry.at,
          ...(typeof entry.deadUntil === 'number' ? { deadUntil: entry.deadUntil } : {}),
          ...legacy,
          ...(typeof entry.latencyEmaDirect === 'number' ? { latencyEmaDirect: entry.latencyEmaDirect } : {}),
          ...(typeof entry.latencyEmaProxy === 'number' ? { latencyEmaProxy: entry.latencyEmaProxy } : {}),
          ...(typeof entry.lastOkAt === 'number' ? { lastOkAt: entry.lastOkAt } : {}),
        });
      }
    }
  } catch {
    // 存档损坏 —— 从空记忆开始
  }
}

function persist(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const obj: Record<string, HealthEntry> = {};
    const now = Date.now();
    for (const [host, entry] of learned) {
      if (isProxyEntry(entry)) {
        obj[host] = entry;
        continue;
      }
      if (now - entry.at > LEARNED_ROUTE_TTL_MS) continue;
      obj[host] = {
        route: entry.route,
        at: entry.at,
        ...(entry.deadUntil !== undefined ? { deadUntil: entry.deadUntil } : {}),
        ...(entry.latencyEmaDirect !== undefined ? { latencyEmaDirect: entry.latencyEmaDirect } : {}),
        ...(entry.latencyEmaProxy !== undefined ? { latencyEmaProxy: entry.latencyEmaProxy } : {}),
        ...(entry.lastOkAt !== undefined ? { lastOkAt: entry.lastOkAt } : {}),
      };
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(obj));
  } catch {
    // 存储不可用 —— 内存中的路由照常工作
  }
}

// ── 谁快用谁（期3） ────────────────────────────────────────────────────────
// 双路都有真实请求的 headers_ms EMA 样本时，显著快的一路优先。阈值刻意
// 保守（快一倍以上且绝对省 ≥500ms）——本地代理典型开销 0.2-0.4s，为两三
// 百毫秒翻路不值当；真正该翻的是「直连 0.2s / 代理 1.5s 爬行」这类量级差。
// 数据不足或差距不大时返回 undefined，维持分类面/既有记忆，不折腾。
/** 显著快判据：快路 < 慢路 × 比例 且 绝对差 ≥ 门槛。 */
export const FASTER_ROUTE_RATIO = 0.5;
export const FASTER_ROUTE_MIN_GAP_MS = 500;

function fasterRouteOf(directMs: number | undefined, proxyMs: number | undefined): NetRoute | undefined {
  if (directMs === undefined || proxyMs === undefined) return undefined;
  if (directMs < proxyMs * FASTER_ROUTE_RATIO && proxyMs - directMs >= FASTER_ROUTE_MIN_GAP_MS) return 'direct';
  if (proxyMs < directMs * FASTER_ROUTE_RATIO && directMs - proxyMs >= FASTER_ROUTE_MIN_GAP_MS) return 'proxy';
  return undefined;
}

function routeForKey(key: string, hasProxy: boolean, now: number, fallback: NetRoute): NetRoute {
  if (!hasProxy) return 'direct';
  ensureLoaded();
  const entry = learned.get(key);
  if (entry && isRouteEntry(entry)) {
    if (now - entry.at <= LEARNED_ROUTE_TTL_MS) {
      // 死路半边：刚失败的路在死期内直接翻反向。只删记忆不够——删掉后
      // 分类面下一轮照样把 proxy-first 主机判给代理，每个请求重演一次
      // 「失败→换路」，UI 就是反复闪「这条路不通」。死期优先于快路裁定：
      // 死路绝不因「曾几何时更快」被选回。
      if (entry.deadUntil !== undefined && now < entry.deadUntil) {
        return entry.route === 'proxy' ? 'direct' : 'proxy';
      }
      // 谁快用谁：双路样本都在时，显著快的一路压过钉着的记忆与分类面。
      return fasterRouteOf(entry.latencyEmaDirect, entry.latencyEmaProxy) ?? entry.route;
    }
    // 记忆过期：行删掉，但双路样本跟着陪葬太可惜——抢救出来喂一次
    // 快路裁定，过期的只是「钉哪条路」的结论，不是两条路的时延事实。
    const samples = { direct: entry.latencyEmaDirect, proxy: entry.latencyEmaProxy };
    learned.delete(key);
    persist();
    return fasterRouteOf(samples.direct, samples.proxy) ?? fallback;
  }
  return fallback;
}

/** Route decision for a host (accepts a bare host or a full URL). proxyUrl
 *  提供时，代理健康行参与决策：代理死期内 proxy-first 主机直接判直连，
 *  不必每个主机各自撞一次墙。 */
export function resolveNetRoute(hostOrUrl: string, hasProxy: boolean, now = Date.now(), proxyUrl?: string): NetRoute {
  const host = normalizeRouteHost(hostOrUrl);
  if (!host) return 'direct';
  const fallback = classifyHostName(host) === 'proxy-first' ? 'proxy' : 'direct';
  return routeForKey(host, hasProxy, now, proxyFallbackFor(proxyUrl ?? '', now, fallback));
}

// ── 证据读侧 ────────────────────────────────────────────────────────────────
// 「直连这会儿到底行不行」只有学习表里的真实结局能回答，任何静态名单都回答
// 不了（同一个域名在家被墙、在公司能连）。GitHub 加速的 auto 模式在这里读
// 直连面的死活证据，决定要不要镜像先行；静态分类面**不参与**这个判定——
// 分类只回答冷启动「第一条路猜谁」，猜完之后一切以实测为准。

/**
 * 只读：该 host 的直连路是否刚被实测打死（死期内）。
 * 与选路用的死路半边同源（recordNetOutcome 落的 deadUntil），5 分钟 TTL，
 * 过期即 false——自动回到直连探路，直连恢复则自然走直连。
 */
export function directRouteDead(hostOrUrl: string, now = Date.now()): boolean {
  const host = normalizeRouteHost(hostOrUrl);
  if (!host) return false;
  ensureLoaded();
  const entry = learned.get(host);
  if (!entry || !isRouteEntry(entry)) return false;
  if (now - entry.at > LEARNED_ROUTE_TTL_MS) return false;
  return entry.deadUntil !== undefined && now < entry.deadUntil && entry.route === 'direct';
}

/**
 * 从真实结果里学习：成功的那条路被记住（带时间戳），失败把「正在用的那条
 * 路」的记忆清掉，让分类重新决策。失败的路由从不被「学习」——否则重试会
 * 被自己的记忆堵死。
 */
export function recordNetOutcome(
  hostOrUrl: string,
  route: NetRoute,
  ok: boolean,
  now = Date.now(),
  /** 响应头耗时（TCP+TLS+代理协商，Rust 侧回传）。undefined = 旧后端/其他
   *  调用方没量——慢直连判据跳过，行为与不加此参逐字节一致。 */
  headersMs?: number,
): void {
  const host = normalizeRouteHost(hostOrUrl);
  if (!host) return;
  // 本地/环回没有「代理优先」可言，记了也只会污染分类面。
  if (classifyHostName(host) === 'neutral') return;
  recordRouteForKey(host, route, ok, now, headersMs);
}

/** 出口面的学习入口（key 已是内部形态，不做 URL 解析）。 */
export function recordNetSurfaceOutcome(surface: NetSurface, route: NetRoute, ok: boolean, now = Date.now()): void {
  recordRouteForKey(surfaceKey(surface), route, ok, now);
}

/** 响应头慢判据：健康直连 ~0.1s、经本地代理 ~0.3s；超过它说明这条路的
 *  连接层在爬（丢包/网关排队），即使请求最终成功也不算可用性证据。 */
const SLOW_HEADERS_MS = 4000;

/** 响应头时延 EMA 的归槽键：样本按路进自己的槽，两路互不覆盖。 */
function emaSlotOf(route: NetRoute): 'latencyEmaDirect' | 'latencyEmaProxy' {
  return route === 'direct' ? 'latencyEmaDirect' : 'latencyEmaProxy';
}

function recordRouteForKey(key: string, route: NetRoute, ok: boolean, now: number, headersMs?: number): void {
  ensureLoaded();
  const existing = learned.get(key);
  // route key 空间（host/surface）与 proxy: 前缀天然隔离，但类型上仍收窄。
  const entry = existing && isRouteEntry(existing) ? existing : undefined;
  if (ok) {
    // 慢直连判据（2026-10-20）：proxy-first 主机经直连「连上了但响应头爬了
    // 秒级」不是可用性证据——头时间只含连接层，不受模型 prefill/思考污染。
    // 这种成功不钉路线；若记忆正钉在 direct 上，翻回代理（保留代理路样本，
    // 「谁快用谁」的对比数据不因一次慢直连陪葬）。此前「慢而不断」的直连
    // 每次都把 direct 钉 30 分钟，下一轮继续爬。
    if (
      headersMs !== undefined && headersMs > SLOW_HEADERS_MS
      && route === 'direct' && classifyHostName(key) === 'proxy-first'
    ) {
      if (entry?.route === 'direct') {
        learned.set(key, {
          route: 'proxy',
          at: now,
          ...(entry.latencyEmaProxy !== undefined ? { latencyEmaProxy: entry.latencyEmaProxy } : {}),
        });
        persist();
      }
      return;
    }
    if (entry?.route === route) {
      // 同路成功：该路槽 EMA 更新（α=0.3，新样本权重适中），刷新活路时间戳。
      // 实测成功高于死路推断：成功一刻必须清掉本路的死期——否则「直连刚
      // 跑通」却仍被上一次失败的死期翻面，学习表自相矛盾（证据读侧
      // directRouteDead 也会把刚成功的路读成死）。成功样本靠 EMA 槽位区分，
      // 死期只属于失败。
      const { deadUntil: _clearedDeath, ...alive } = entry;
      if (headersMs !== undefined && headersMs > 0) {
        const slot = emaSlotOf(route);
        const prev = entry[slot];
        const ema = prev === undefined ? headersMs : Math.round(prev * 0.7 + headersMs * 0.3);
        learned.set(key, { ...alive, at: now, [slot]: ema, lastOkAt: now });
        persist();
      } else if (entry.at !== now) {
        learned.set(key, { ...alive, at: now, lastOkAt: now });
        persist();
      }
      return;
    }
    // 换路成功（或首钉）：钉新路、新路槽吃首样本；对立路的样本原样保留——
    // 那是它上次真实 serving 的时延，正是「谁快用谁」要的对比数据。
    const opposite = route === 'direct' ? 'proxy' : 'direct';
    const oppositeSlot = emaSlotOf(opposite);
    learned.set(key, {
      route,
      at: now,
      lastOkAt: now,
      ...(entry && entry[oppositeSlot] !== undefined ? { [oppositeSlot]: entry[oppositeSlot] } : {}),
      ...(headersMs !== undefined && headersMs > 0 ? { [emaSlotOf(route)]: headersMs } : {}),
    });
    persist();
  } else if (
    entry === undefined || entry.route === route
    // 钉着的反向路自身带着未过期死期时，它不是活路证据而是尸检报告：
    // 两条路先后死光（代理死→直连也死）时若不放行，direct 的死因永远进不了
    // 表，直连面的证据读侧（directRouteDead）就永远读不到死——「代理死、
    // 直连也死」的机器上，镜像自动先行就永远不会触发。放行 = 保留最新死因。
    || (entry.deadUntil !== undefined && now < entry.deadUntil)
  ) {
    // 失败记死路半边，覆盖两种情形：表里根本没有记忆（这次是分类面选的
    // 路，比如 proxy-first 主机首选代理首连失败——只删记忆的话表还是空
    // 的，下一轮分类面原地再选它，永远学不会），以及记忆钉的正是这条
    // 失败路（旧记忆失效）。死期内选路翻反向，过期后照常重探。
    learned.set(key, { route, at: now, deadUntil: now + DEAD_ROUTE_TTL_MS });
    persist();
  }
  // else：钉着的是反向记忆（活路证据），死路信号不覆盖它——选路本来就
  // 先走钉着的路，无需再改。
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
  const fallback = classifyHostName(host) === 'proxy-first' ? 'proxy' : 'direct';
  return routeForKey(host, true, Date.now(), proxyFallbackFor(proxyUrl, Date.now(), fallback)) === 'proxy'
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
  const primary: NetRoute = resolveNetRoute(host, true, Date.now(), proxyUrl);
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