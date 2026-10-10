// src/shared/cliFetch.ts
// CLI 侧 fetch 的统一出口：按「直连 / 经代理 / 不可用」三态路由后发出。
//
// 为什么需要它：Bun 的 fetch 会隐式读 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
// 并遵守 NO_PROXY，但有三处它不管、也不该假装管：
//   1. 它**不自动绕过环回**。设了 HTTP_PROXY 又没写 NO_PROXY 时，本机 fetch
//      自己的 127.0.0.1 会走进代理 → 死循环（TUI 连本地 server 时尤其致命）。
//   2. SOCKS 会直接抛 UnsupportedProxyProtocol，必须给一句人话而不是堆栈。
//   3. 代理挂在运行时内部，出错时分不清是代理坏了还是目标挂了。
// 所以这里自己算一次路由并显式传原生 `proxy` 选项：决策在源码里、可测可解释。
//
// 为什么单独立文件：这份实现此前在 fetchFallback.ts 与 NodeToolAdapter.ts 各
// 有一份，两份都在用（NodeToolAdapter 自己那份还多带一句 curl/aria2c 提示），
// 于是「同一份代理配置在 web_fetch 生效、在 web_public_api 不生效」这类漂移迟早
// 发生。定义只有一份，调用点全走它。
//
// 明确不做的事：不用 undici ProxyAgent / setGlobalDispatcher（Bun 下静默失效，
// 已实测），不假装支持 SOCKS（那会让「代理配错了」变成一个查不出原因的玄学故障）。

import { isNetworkError } from './netGuard';
import { unblockAttemptsBeforeMirror } from './netRoute';

export interface CliProxyRoute {
  /** 要传给 fetch 原生 `proxy` 选项的地址；直连时为空串。 */
  proxy: string;
  /** 直连（不传 proxy 选项）。 */
  direct: boolean;
  /** 非空表示这条代理用不了，附一句人话原因。 */
  unsupported?: string;
}

/** 判断主机是否为私有/内网地址（直连，不经代理）。 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 0) return true;
  return false;
}

/** 主机是否匹配 NO_PROXY（支持域名后缀与 `*`）。 */
export function hostMatchesNoProxy(host: string, noProxy: string): boolean {
  const h = host.toLowerCase();
  return noProxy
    .split(/[,\s]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .some((entry) => {
      const e = entry.toLowerCase();
      if (e === '*') return true;
      if (e.startsWith('.')) return h === e.slice(1) || h.endsWith(e);
      return h === e;
    });
}

/** 把代理字符串规范为 URL；SOCKS 返回 'socks'，非法值返回 null。
 *  下载链（node:http）与 fetch 链共用同一套判断——否则同一份代理配置会出现
 *  「下载能用、搜索却炸」这种最难排查的不一致。 */
export function parseProxy(proxy: string): { url: URL; scheme: string } | 'socks' | null {
  try {
    const u = new URL(proxy);
    if (u.protocol === 'socks5:' || u.protocol === 'socks5h:' || u.protocol === 'socks4:' || u.protocol === 'socks4a:') {
      return 'socks';
    }
    if (u.protocol === 'http:' || u.protocol === 'https:') return { url: u, scheme: u.protocol };
    return null;
  } catch {
    return null;
  }
}

/** 环境变量里的代理地址。Bun 自己也会读这些，但我们显式算一遍才知道当前
 *  到底有没有代理——否则无法为 SOCKS 给出可解释的错误。 */
export function resolveEnvProxy(): string {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = process.env[key]?.trim();
    if (v) return v;
  }
  return '';
}

/**
 * CLI 侧 fetch 的出口路由：直连 / 经代理 / 不可用三态。
 *
 * 环回与私网**永远直连**：走代理访问本机 127.0.0.1 会形成自指死循环
 * （TUI 连本地 server 时是致命的，不是慢）。
 */
export function cliProxyFor(targetUrl: string, explicitProxy?: string): CliProxyRoute {
  const proxy = (explicitProxy ?? '').trim() || resolveEnvProxy();
  if (!proxy) return { proxy: '', direct: true };

  let host = '';
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    return { proxy: '', direct: true };
  }
  const noProxy = process.env['NO_PROXY'] || process.env['no_proxy'] || '';
  if (isPrivateHost(host) || hostMatchesNoProxy(host, noProxy)) {
    return { proxy: '', direct: true };
  }

  const parsed = parseProxy(proxy);
  if (parsed === 'socks') {
    return {
      proxy: '',
      direct: false,
      // 明确报错而不是「悄悄直连」：直连成功会让用户以为代理在工作，
      // 而失败时那句 UnsupportedProxyProtocol 对模型毫无归因价值。
      unsupported: `代理 ${proxy} 是 SOCKS，Bun fetch 不支持（传 socks5:// 会抛 UnsupportedProxyProtocol，已实测）。请改用 http:// 代理；download_file 有 curl/aria2c 降级链可处理 SOCKS。`,
    };
  }
  if (parsed === null) {
    return { proxy: '', direct: false, unsupported: `代理地址无法解析：${proxy}` };
  }
  return { proxy, direct: false };
}

/**
 * 统一的 fetch 出口：按上面的路由补 `proxy` 选项后发出。
 *
 * Bun 没有「强制直连」开关（proxy:'' 仍会退回读环境变量，实测），所以直连
 * 只能靠**不传 proxy** 实现。Bun 每次 fetch 都重读 process.env，所以改环境
 * 变量下一次请求即生效——这正是这里不做任何全局 dispatcher 设置的原因。
 *
 * 打通优先：配了可用代理时，按「首选 → 反向 → 首选·退避重试」的 75% 预算
 * 依次试（与 GUI 侧 runRouted 同一口径）；未配代理、或目标为环回/私网时只有
 * 一次直连。只在幂等请求（GET/HEAD）上重试，避免把非幂等请求重复发出。
 */
/** 取消 / 超时错误（AbortSignal）：信号已 abort，换路再试也会在同一信号上立即
 *  失败，所以不当作「可换路的网络失败」。（Bun 的 AbortSignal.timeout 拒绝为
 *  TimeoutError "The operation timed out."，其文本匹配 isNetworkError——必须
 *  先在这里拦下，否则会对一个已死的信号无意义地重试。） */
function isAbortOrTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

export async function cliFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const route = cliProxyFor(input);
  if (route.unsupported) throw new Error(route.unsupported);
  const plan = route.direct
    ? ['']
    : unblockAttemptsBeforeMirror(input, route.proxy).map((a) => a.proxyUrl);
  const method = (init.method ?? 'GET').toUpperCase();
  const attempts = method === 'GET' || method === 'HEAD' ? plan : plan.slice(0, 1);
  let lastErr: unknown = new Error('fetch failed');
  for (let i = 0; i < attempts.length; i++) {
    const proxy = attempts[i]!;
    try {
      return proxy ? await fetch(input, { ...init, proxy }) : await fetch(input, init);
    } catch (err) {
      lastErr = err;
      if (isAbortOrTimeout(err) || init.signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isNetworkError(msg)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}