// src/shared/githubAccel.ts
// GitHub 下载加速：URL 前缀代理 + 多级回退 + 证据驱动的 auto 模式。
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
// 信任边界（2026-10-31 用户定调修订）：公共前缀代理是第三方公益服务，无 SLA、
// 响应体可被任意替换，所以：
//   - 默认**智能**（githubMirror 默认 'auto'）：直连快就走直连（不经第三方）；
//     直连失败（含代理路由耗尽）被记住后自动改走加速节点，恢复后自动回到
//     直连——不再要求用户手动开关节点。愿意放弃智能路由的人仍可显式选固定
//     节点或 explicit direct（永不加速）；
//   - 只改写 GitHub 的**公开下载面**（release 资产 / raw / codeload / objects），
//     不改 api.github.com（那里带 Authorization，第三方代理解析不到凭证也拿不到
//     准确语义）；
//   - 改写必标注来源（download 结果的 rewrite 字段），全灭时如实列账，不做
//     静默替换。
//
// 节点清单只收本仓库 mirrorSources.ts 里核验过的几家（2026-10-09 实测），
// 不抄别处「9 个节点」的表——死掉一半的清单比短清单更误导人。

import { directRouteDead } from './netRoute';
//
// ── 优先级（2026-10-26 定稿；2026-10-31 auto 模式并入）：同一份 GitHub 下载
// 面上可能同时存在三套路由意愿，按「显式度」排成一条链，谁显式谁先手，任何
// 一级网络类失败都落到下一级：
//   1. 调用点显式镜像 —— download_file 的 url 已带已知镜像前缀（skill 教的
//      路由 / 模型自选）。赢法是「不二次包裹」；它失败时解出原 URL 重新入链
//      （unwrapGithubMirrorUrl + TauriToolAdapter.retryDownloadViaMirror）。
//   2. 系统设置链 —— 设置 → 通用 → GitHub 加速：
//      · 显式节点 / custom：mirror-first，链尾直连（用户表过态，照办）；
//      · auto（默认）：**证据先行**——netRoute 学习表里该 host 的直连路
//        5 分钟内刚被实测打死（directRouteDead）→ 镜像先行，省一次必死
//        超时；否则直连先行，镜像链留给网络类失败兜底。静态 proxy-first
//        分类**不参与**这个判定——「直连行不行」只有实测能回答。
//   3. 官方等价镜像（sourceRewrite t0/t1）与直连 —— 中立兜底。
// 熔断例外：hostBlocked 即时失败发生在整条链之前——已判死的 host 不再探路，
// 也不落优先级链（兜底交给模型层换 URL）。
// switch_package_source 的 github 生态不在链内：它管 git/包管理的源选择
// （codeload / raw 官方端点），与下载面前缀代理语义不同，互不接管。

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

/** 特殊项 auto + 公共节点 + custom / direct。公共节点的声明顺序就是回退链里
 *  “其余镜像”的顺序；auto / custom / direct 无前缀，不进回退链。 */
export const GITHUB_MIRRORS: readonly GithubMirror[] = [
  {
    key: 'auto',
    label: '智能',
    prefix: '',
    note: '直连快就走直连；直连失败被记住后自动改走加速节点，恢复后自动回到直连',
  },
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
    key: 'gh-ddlc',
    label: 'gh.ddlc.top',
    prefix: 'https://gh.ddlc.top',
    note: '2026-10-verified 内部测速节点',
  },
  {
    key: 'cors-isteed',
    label: 'cors.isteed.cc',
    prefix: 'https://cors.isteed.cc',
    note: '2026-10-verified CDN镜像节点',
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

/** 默认智能：直连快就走直连（不经第三方），直连被实测打死才自动换镜像。
 *  显式选固定节点 / custom / direct 仍然有效——auto 只是「没人表过态」时的
 *  默认态，不是「替用户选公共代理」的强制态（2026-10-31 用户定调：智能使用，
 *  不要人工开关）。 */
export const DEFAULT_GITHUB_MIRROR = 'auto';

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

export interface UnwrappedGithubMirror {
  /** 前缀后面的原始 GitHub 下载面 URL。 */
  original: string;
  /** 被剥掉的镜像前缀。 */
  prefix: string;
  /** 前缀对应的节点 key（custom 前缀即 'custom'）。 */
  mirrorKey: string;
}

/**
 * 已带镜像前缀的 URL → 还原出原始下载面 URL。只认 GITHUB_MIRRORS 清单内的
 * 前缀 + 用户自定义前缀：skill/模型给的显式镜像跳网络类失败后，靠它解出原
 * URL 落回系统链（优先级第 1 级 → 第 2/3 级）。陌生前缀一律不解——把任意
 * host 当镜像剥壳等于给劫持页洗白；尾巴也必须是 GitHub 下载面 URL。
 */
export function unwrapGithubMirrorUrl(rawUrl: unknown, customPrefix = ''): UnwrappedGithubMirror | null {
  const raw = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!raw) return null;
  const prefixes: Array<{ prefix: string; mirrorKey: string }> = GITHUB_MIRRORS
    .filter((m) => m.prefix)
    .map((m) => ({ prefix: m.prefix, mirrorKey: m.key }));
  const custom = normalizeGithubMirrorPrefix(customPrefix);
  if (custom) prefixes.push({ prefix: custom, mirrorKey: 'custom' });
  for (const { prefix, mirrorKey } of prefixes) {
    const base = prefix.replace(/\/+$/, '');
    if (!raw.toLowerCase().startsWith(`${base.toLowerCase()}/`)) continue;
    const original = raw.slice(base.length + 1);
    if (!isGithubDownloadUrl(original)) return null;
    return { original, prefix: base, mirrorKey };
  }
  return null;
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

/** 设置页测速的候选：公共节点 → 自定义（地址有效时）→ 直连。
 *  auto 不在列：它是一条决策而不是一条链路，没有可测的前缀——auto 的
 *  「实测结果」就是面板上各节点与直连自身的延迟行。 */
export function githubProbeEntries(customPrefix = ''): Array<{ key: string; label: string; prefix: string }> {
  const entries = GITHUB_MIRRORS
    .filter((m) => m.key !== 'custom' && m.key !== 'direct' && m.key !== 'auto')
    .map((m) => ({ key: m.key, label: m.label, prefix: m.prefix }));
  const custom = normalizeGithubMirrorPrefix(customPrefix);
  if (custom) entries.push({ key: 'custom', label: '自定义', prefix: custom });
  entries.push({ key: 'direct', label: '直连', prefix: '' });
  return entries;
}

/** 下拉列表：auto（默认态）在最前，其后公共节点 → 自定义 → 直连。 */
export function githubMirrorDropdownEntries(customPrefix = ''): string {
  const auto = GITHUB_MIRRORS.find((m) => m.key === 'auto');
  const entries = githubProbeEntries(customPrefix);
  return [
    ...(auto ? [`<option value="auto">${auto.label}</option>`] : []),
    ...entries.map((entry) => `<option value="${entry.key}">${entry.label}</option>`),
  ].join('');
}

/**
 * auto 模式的唯一判定：这个 GitHub host 的直连路是否刚被实测打死（netRoute
 * 学习表的死期半边，5 分钟 TTL）。判定完全证据驱动：
 *   · 直连活着 / 没有证据 → false，直连先行（探一次的成本换「直连好就别绕路」）；
 *   · 直连死期内 → true，镜像先行，不为直连烧第二次必死超时；
 *   · 死期一过 → false，自动重探，直连恢复即回到直连。
 * 静态分类面（github 的 proxy-first）只影响**配了代理时**哪条出口先手，
 * 与「要不要镜像先行」无关——后者只认实测证据。
 */
export function githubAutoMirrorFirst(url: string, now = Date.now()): boolean {
  return directRouteDead(url, now);
}

/**
 * hub 类小文件抓取（SKILL.md / hub index）的镜像档前缀：与下载面同一套
 * 显式度语义——显式节点 / custom 恒给链（用户表过态）；auto 只在目标 host
 * 的直连被实测打死时才给（证据先行，健康直连绝不绕镜像）；显式 direct
 * 永不给。抓取方拿到 [] 时按自己的无镜像路径走（Rust 阶梯 / 直连候选）。
 */
export function githubMirrorLadderPrefixes(url: string, key: unknown, customPrefix = '', now = Date.now()): string[] {
  const normalized = normalizeGithubMirrorKey(key);
  if (normalized === 'direct') return [];
  if (normalized === 'auto') return githubAutoMirrorFirst(url, now) ? githubFallbackPrefixes(key, customPrefix) : [];
  return githubFallbackPrefixes(key, customPrefix);
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

// ── 节点健康缓存（会话级，测速面板与下载链共用的唯一数据源）────────────
//
// 「全部节点都不可用」要快、说清、记住：下载链挨个白打已知死节点（每跳一
// 个完整连接超时）是全灭场景最痛的开销；而设置页测速学到的 dead 与下载链
// 学到的失败此前各记各的，两处都在重复交学费。这里统一记账：成功标活、
// 失败标死，TTL 与 netGuard 的 host 熔断同数量级（5 分钟）——节点恢复后
// 自然重新入选，不需要用户手动刷新。

const MIRROR_HEALTH_TTL_MS = 5 * 60_000;

export { MIRROR_HEALTH_TTL_MS };

interface MirrorHealthEntry {
  ok: boolean;
  at: number;
  error?: string;
}

const mirrorHealth = new Map<string, MirrorHealthEntry>();

function mirrorHealthFresh(key: string, now: number): MirrorHealthEntry | null {
  const entry = mirrorHealth.get(key);
  if (!entry) return null;
  if (now - entry.at > MIRROR_HEALTH_TTL_MS) {
    mirrorHealth.delete(key);
    return null;
  }
  return entry;
}

/** 下载链每一跳、设置页每次测速都从这里记账。 */
export function recordMirrorOutcome(key: string, ok: boolean, error?: string): void {
  if (!key || key === 'direct') return;
  mirrorHealth.set(key, { ok, at: Date.now(), error: ok ? undefined : (error ?? '').slice(0, 200) || undefined });
}

/** 清空健康记忆。测试隔离用；运行时节点状态本就随 TTL 自然过期。 */
export function resetMirrorHealth(): void {
  mirrorHealth.clear();
}

/** TTL 内已知死亡（下载链据此跳过该节点）。 */
export function mirrorIsDead(key: string, now = Date.now()): boolean {
  const entry = mirrorHealthFresh(key, now);
  return entry?.ok === false;
}

/** 全灭聚合消息：列出试过/跳过的每条路 + 直连的最后错误 + 出口建议。
 *  模型读到就不会再重试同一路径，用户知道下一步（等恢复 / 配代理 / 手动
 *  下载）。tried = 本次真打过且失败的节点；skipped = 因健康缓存跳过的。 */
export function githubAllPathsDeadNotice(
  tried: Array<{ label: string; error?: string }>,
  skipped: string[],
  directError: string,
): string {
  const lines: string[] = ['下载失败：所有路径均不可用。'];
  for (const t of tried) {
    lines.push(`- 加速节点 ${t.label}：${t.error?.trim() || '失败'}`);
  }
  for (const label of skipped) {
    lines.push(`- 加速节点 ${label}：近期已失败，本次跳过`);
  }
  lines.push(`- 直连：${directError.trim() || '失败'}`);
  lines.push('建议：稍后重试（节点恢复后自动重新启用）、在 设置 → 网络代理 配置代理，或从可直连的网络环境手动下载该文件后放入目标目录。');
  return lines.join('\n');
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
