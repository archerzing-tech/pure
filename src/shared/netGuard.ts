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

const HOST_COOLDOWN_MS = 5 * 60_000;
const HOST_TRIP_THRESHOLD = 2;

interface HostState {
  fails: number;
  blockedUntil: number;
}

const hosts = new Map<string, HostState>();

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
  return /error sending request|connection|timed?[\s-]?out|unreachable|\bdns\b|econn|reset by peer|socket|certificate|tls|fetch failed|network|代理|连接|超时/i.test(message);
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
  }
  hosts.set(host, state);
  return { tripped, host };
}

export function recordNetSuccess(url: string): void {
  const host = hostOf(url);
  if (host) hosts.delete(host);
}

/** Hosts currently circuit-broken — surfaced in the environment brief so the
 *  planner does not schedule steps that depend on them. */
export function blockedHosts(): string[] {
  const now = Date.now();
  return [...hosts.entries()]
    .filter(([, state]) => state.blockedUntil > now)
    .map(([host]) => host)
    .sort();
}

/** Synthetic failure for a blocked host: instant, with the skip-and-continue
 *  directive (mirrors the failure policy's degrade wording). */
export function blockedHostMessage(url: string, lastError?: string): string {
  const host = hostOf(url) ?? url;
  return `此来源（${host}）连续网络失败，已熔断 5 分钟——请勿再请求该主机上的任何地址。改用替代来源、内联或本地替代内容，或跳过此资源继续任务。${lastError ? `最近错误：${lastError}` : ''}`;
}

/** One-line guidance appended to a FIRST network failure of a host, so the
 *  model self-corrects before the breaker even trips. */
export function netFailureHint(url: string, message: string): string {
  return `${message} — 若为网络不可达，请勿原样重试：换镜像/来源、内联替代或跳过此资源继续任务。`;
}

/** Failure classes for the failure policy's class-level loop detection. */
export type FailureClass =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'permission'
  | 'not-found'
  | 'rate-limit'
  | 'content'
  | 'generic';

export function classifyFailure(message: string): FailureClass {
  const m = message.toLowerCase();
  if (/error sending request|connection|unreachable|\bdns\b|econn|reset by peer|fetch failed|network|证书|certificate|tls|连接/.test(m)) return 'network';
  if (/timed?[\s-]?out|超时/.test(m)) return 'timeout';
  if (/401|403|unauthorized|forbidden|api[- ]?key|invalid.*key|凭证|未授权/.test(m)) return 'auth';
  if (/permission denied|eacces|eperm|access denied|权限/.test(m)) return 'permission';
  if (/404|not found|no such file|does not exist|不存在|无法找到/.test(m)) return 'not-found';
  if (/429|rate limit|too many requests|限流/.test(m)) return 'rate-limit';
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
  content: '此类失败 = 返回内容不符合预期。换解析方式或来源；不要原样重试。',
  generic: '',
};
