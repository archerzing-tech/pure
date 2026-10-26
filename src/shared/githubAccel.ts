// src/shared/githubAccel.ts
// GitHub 下载加速：URL 前缀代理 + 多级回退。
//
// 手法只有一个：把 GitHub 原始 URL 整体拼到镜像域名后面——
//   https://ghfast.top/https://github.com/owner/repo/releases/download/x.zip
// 镜像只在服务端转发请求，所以协议、路径、Range 语义都跟着原样走；不需要
// 客户端 SDK，也不需要用户配代理。
//
// 灵魂是**回退链**，不是某一个镜像：`githubFallbackPrefixes()` 把「用户选中的
// 节点 → 其余公共节点（声明顺序）→ 直连」摊成一条链，任何单个镜像挂掉都不会
// 让下载死掉。注意链的每一级都是完整前缀，而不是 host 替换——镜像地址可能带
// 路径（https://example.com/gh），拼法必须按「前缀 + 原 URL」处理。
//
// 信任边界（与 shared/mirrorSources.ts 同一套政策）：公共前缀代理是第三方公益
// 服务，无 SLA、响应体可被任意替换，所以：
//   - 默认关闭（githubMirror 默认 'direct'），必须由用户在 设置 → 通用 显式打开；
//   - 只改写 GitHub 的**公开下载面**（release 资产 / raw / codeload / objects），
//     不改 api.github.com（那里带 Authorization，第三方代理解析不到凭证也拿不到
//     准确语义）；
//   - 不碰用户自定义前缀之外的地址：选 custom 但地址非法时退化为直连，而不是
//     悄悄替用户选一个他没同意过的公共代理。
//
// 节点清单只收本仓库 mirrorSources.ts 里核验过的几家（2026-10-09 实测），
// 不抄别处「9 个节点」的表——死掉一半的清单比短清单更误导人。

export interface GithubMirror {
  /** 稳定 key，存进配置（githubMirror）。 */
  key: string;
  /** 展示名（公共节点是品牌名，不翻译）。 */
  label: string;
  /** 前缀地址；custom / direct 为空（前者读配置，后者就是原 URL）。 */
  prefix: string;
  /** 已知陷阱，给设置页的说明用。 */
  note: string;
}

/** 公共节点 + 两个特殊项（custom / direct）。顺序就是回退链里“其余镜像”的顺序。 */
export const GITHUB_MIRRORS: readonly GithubMirror[] = [
  {
    key: 'ghfast',
    label: 'GHFast',
    prefix: 'https://ghfast.top',
    note: '2026-10-09 实测可达，但单次 8s 左右；无 SLA，响应体可被替换',
  },
  {
    key: 'gh-proxy',
    label: 'gh-proxy',
    prefix: 'https://gh-proxy.com',
    note: '2026-10-09 实测 429 限流——公益节点里常见，故排在其后',
  },
  {
    key: 'ghproxy-net',
    label: 'ghproxy.net',
    prefix: 'https://ghproxy.net',
    note: '2026-10-09 实测可达，耗时约 8.8s',
  },
  {
    key: 'custom',
    label: '自定义',
    prefix: '',
    note: '自建或自选的代理地址；只代理你填的这个，不参与公共节点回退',
  },
  {
    key: 'direct',
    label: '直连',
    prefix: '',
    note: '关闭加速：所有请求回到 GitHub 官方地址',
  },
];

/** 默认关闭。第三方公益代理不该在用户没点过开关时接管下载。 */
export const DEFAULT_GITHUB_MIRROR = 'direct';

/** 测速用的固定资源：一个长期存在的 jq release 资产。
 *  刻意选 release 而不是仓库首页——前缀代理的价值就在 release 资产，仓库首页
 *  各家的转发行为并不一致。 */
export const GITHUB_MIRROR_PROBE_URL =
  'https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64';

/** 允许走前缀代理的主机：全是 GitHub 的公开下载面，无鉴权语义。 */
const GITHUB_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'gist.githubusercontent.com',
  'gist.github.com',
  'media.githubusercontent.com',
]);

export function isGithubMirrorKey(value: unknown): boolean {
  return GITHUB_MIRRORS.some((m) => m.key === value);
}

/** 未知 / 空值回退到默认（direct），不抛——手改配置或版本回退留下的陈旧 key
 *  不该让设置页和下载链炸掉。 */
export function normalizeGithubMirrorKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return isGithubMirrorKey(key) ? key : DEFAULT_GITHUB_MIRROR;
}

/**
 * 规范化自定义前缀：补 https://、去掉尾部斜杠、丢掉 query/hash。
 * 只接受 http(s)；返回 '' 表示不可用（调用方据此退回直连）。
 */
export function normalizeGithubMirrorPrefix(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (!trimmed) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname) return '';
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return '';
  }
}

/** 用户选的 key → 前缀地址。direct / 非法 custom → ''（直连）。 */
export function githubMirrorPrefix(key: unknown, customPrefix = ''): string {
  const normalized = normalizeGithubMirrorKey(key);
  if (normalized === 'direct') return '';
  if (normalized === 'custom') return normalizeGithubMirrorPrefix(customPrefix);
  return GITHUB_MIRRORS.find((m) => m.key === normalized)?.prefix ?? '';
}

/**
 * 回退链：[选中节点] → 其余公共节点（声明顺序）→ 直连('')。
 *
 * direct 是链尾而不是「没有链」：只要开了加速，单个镜像失败就必须还能落到
 * 官方地址，否则「加速」会变成「把本来能直连的人拦在墙外」。
 *
 * custom 地址非法时**只返回直连**，不拿公共节点顶替：用户选自定义往往正是不
 * 想把流量交给第三方，静默换节点违背这个选择。
 */
export function githubFallbackPrefixes(key: unknown, customPrefix = ''): string[] {
  const normalized = normalizeGithubMirrorKey(key);
  if (normalized === 'direct') return [''];
  const selected = githubMirrorPrefix(normalized, customPrefix);
  if (normalized === 'custom' && !selected) return [''];

  const chain: string[] = [];
  if (selected) chain.push(selected);
  for (const mirror of GITHUB_MIRRORS) {
    if (mirror.key === normalized || mirror.key === 'custom' || mirror.key === 'direct') continue;
    if (mirror.prefix) chain.push(mirror.prefix);
  }
  chain.push('');
  return [...new Set(chain)];
}

/** 该 URL 是否属于可加速的 GitHub 下载面。 */
export function isGithubDownloadUrl(rawUrl: unknown): boolean {
  const raw = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return GITHUB_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** 前缀 + 原 URL。已经是该前缀开头的地址原样返回（防二次拼接）。 */
export function withGithubMirrorPrefix(prefix: string, url: string): string {
  const base = prefix.trim().replace(/\/+$/, '');
  if (!base) return url;
  if (url.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return url;
  return `${base}/${url}`;
}

/** 该 URL 是否已经被某个前缀代理包过（回退链不能套娃）。 */
export function isAlreadyMirrored(rawUrl: string, prefixes: readonly string[]): boolean {
  const lower = rawUrl.toLowerCase();
  return prefixes.some((prefix) => {
    const base = prefix.trim().replace(/\/+$/, '').toLowerCase();
    return base !== '' && lower.startsWith(`${base}/`);
  });
}

export interface GithubDownloadAttempt {
  url: string;
  /** '' = 直连；公共节点 key；'custom'。 */
  prefix: string;
  mirrorKey: string;
  label: string;
}

function mirrorKeyForPrefix(prefix: string): string {
  if (!prefix) return 'direct';
  const match = GITHUB_MIRRORS.find((m) => m.prefix && m.prefix === prefix);
  return match?.key ?? 'custom';
}

function mirrorLabelForPrefix(prefix: string): string {
  if (!prefix) return GITHUB_MIRRORS.find((m) => m.key === 'direct')!.label;
  const match = GITHUB_MIRRORS.find((m) => m.prefix && m.prefix === prefix);
  return match?.label ?? prefix;
}

/**
 * 一次下载的全部候选 URL，按回退链顺序。
 * 非 GitHub 地址、已镜像地址、加速关闭（direct）→ []，调用方按原路径走。
 */
export function githubDownloadAttempts(
  rawUrl: unknown,
  key: unknown,
  customPrefix = '',
): GithubDownloadAttempt[] {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!isGithubDownloadUrl(url)) return [];
  const prefixes = githubFallbackPrefixes(key, customPrefix);
  if (prefixes.length === 1 && prefixes[0] === '') return [];
  if (isAlreadyMirrored(url, prefixes)) return [];
  return prefixes.map((prefix) => ({
    url: withGithubMirrorPrefix(prefix, url),
    prefix,
    mirrorKey: mirrorKeyForPrefix(prefix),
    label: mirrorLabelForPrefix(prefix),
  }));
}

/** 设置页测速的候选：公共节点 → 自定义（地址有效时）→ 直连。 */
export function githubProbeEntries(customPrefix = ''): Array<{ key: string; label: string; prefix: string }> {
  const entries = GITHUB_MIRRORS
    .filter((m) => m.key !== 'custom' && m.key !== 'direct')
    .map((m) => ({ key: m.key, label: m.label, prefix: m.prefix }));
  const custom = normalizeGithubMirrorPrefix(customPrefix);
  if (custom) entries.push({ key: 'custom', label: '自定义', prefix: custom });
  entries.push({ key: 'direct', label: '直连', prefix: '' });
  return entries;
}

export type LatencyBucket = 'good' | 'warn' | 'bad' | 'dead';

/**
 * 延迟分档：绿 / 黄 / 红 / 不可达。
 * 阈值按「下载大文件时的可用性」定，不按 ping 直觉——3s 内握手完的节点传大文件
 * 仍然可用；8s 量级（公益节点实测）只能算黄。不可达单独一档，不并进红。
 */
export function latencyBucket(latencyMs: number, ok: boolean): LatencyBucket {
  if (!ok) return 'dead';
  if (latencyMs <= 1200) return 'good';
  if (latencyMs <= 4000) return 'warn';
  return 'bad';
}

export interface MirrorProbeResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

/**
 * 单节点测速（浏览器 / 非 Tauri 路径）。判据刻意宽松：**任何 HTTP 应答**
 * （含 401/403/429）都算链路可达——测的是连通性与延迟，不是鉴权；只有连接
 * 失败 / 超时才判死。桌面端走 Rust 的同名命令（能带应用代理），这里的实现
 * 供开发模式和单元测试使用。
 */
export async function probeGithubMirrorLatency(
  prefix: string,
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    probeUrl?: string;
  } = {},
): Promise<MirrorProbeResult> {
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { ok: false, latencyMs: 0, error: 'fetch unavailable' };
  const target = withGithubMirrorPrefix(prefix, opts.probeUrl ?? GITHUB_MIRROR_PROBE_URL);
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? 8000);
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  timer = setTimeout(() => controller.abort(), timeoutMs);
  // HEAD：只要一个应答头，不下载资产本身。
  try {
    const resp = await fetchImpl(target, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    return { ok: true, latencyMs: Date.now() - started, status: resp.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs: Date.now() - started, error: message };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
