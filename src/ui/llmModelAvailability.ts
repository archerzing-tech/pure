// src/ui/llmModelAvailability.ts
// LLM 可用性台账（2026-11 蓝图 v2，docs/llm-availability-gate-2026-11.md）：
// 对每个已配置端点维护最近探测结论，模型选择列表（下拉 + /model）只显示
// 「已配置 ∧ 可访问」的条目。感知层只记账——不改配置、不静默切换模型。
//
// 判据：复用 Rust test_llm_connection（GET models URL），与 chat_stream 全
// 同款（客户端构建 / key 解析 / 协议鉴权头 / 代理路线）。429 计数不立刻下
// 架：连续 3 次限流才降级隐藏，任一非 429 结果复位。已知上限：不鉴权的中
// 转站假 2xx 探不出 key 死——由回合失败信号兜底。
//
// 快照纪律：localStorage 只持久化 ok:true 条目（断网期的错误结论不进盘），
// 失效判据是配置身份失配（provider/baseURL 变了才废），不做墙钟过期。

import { loadConfig, providerHasKey, providerSecretKeyFor, type PureConfig } from './config';
import {
  PROVIDERS,
  providerDef,
  providerOverrideFor,
  customProviderFor,
  customBaseURL,
  resolveProviderProtocol,
} from '../shared/providers';
import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { normalizeProxyConfig, effectiveProxyUrl } from '../shared/proxy';
import { netRouteProxyPair } from '../shared/netRoute';
import { probeLlmEndpoint } from '../shared/llmProbe';

export type LlmProbeReason =
  | 'startup'
  | 'periodic'
  | 'backoff'
  | 'config-change'
  | 'manual'
  | 'warm-streak'
  | 'turn-failure';

export interface LlmAvailabilityInfo {
  ok: boolean;
  checkedAt: number;
  latencyMs?: number;
  error?: string;
  status?: number;
  /** 连续 429 计数；任一非 429 结果复位为 0。 */
  limitedStreak?: number;
}

export interface LlmProbeOutcome {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
}

// ── 节流参数 ──
const PROBE_INTERVAL_MS = 30 * 60_000; // 周期全量：恢复方向唯一的探测者
const SWEEP_INTERVAL_MS = 30_000; // 退避补探扫描
const PERIODIC_MIN_GAP_MS = 60_000; // periodic/backoff/warm-streak 同端点最小间隔
const TURN_FAILURE_MIN_GAP_MS = 15_000; // 回合失败重探防抖（引擎重试风暴）
const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_SECOND_MS = 5 * 60_000;
const LIMITED_STREAK_MAX = 3; // 连续第 3 次 429 才降级
const WARM_STREAK_TRIGGER = 3; // llmWarm 连败 3 轮触发正式重探

// ── 纯函数（导出供单测，不碰 window / 全局 config）──

/** 探测结果过账裁决：429 走连败计数（streak≥3 才判死），其余按 probe.ok，
 * 非 429 结果复位计数。 */
export function verdictFromProbe(
  prev: LlmAvailabilityInfo | undefined,
  probe: LlmProbeOutcome,
): LlmAvailabilityInfo {
  const now = Date.now();
  if (probe.status === 429) {
    const streak = (prev?.limitedStreak ?? 0) + 1;
    return {
      ok: streak < LIMITED_STREAK_MAX,
      checkedAt: now,
      latencyMs: probe.latencyMs,
      error: 'rate limited (429)',
      status: 429,
      limitedStreak: streak,
    };
  }
  return {
    ok: probe.ok === true,
    checkedAt: now,
    latencyMs: probe.latencyMs,
    error: probe.ok === true ? undefined : (probe.error || 'unreachable'),
    status: probe.status,
    limitedStreak: 0,
  };
}

/** 呈现门禁纯缝：模型选项按 provider 可访问性过滤。 */
export function filterModelOptionsByAvailability<T extends { provider: string }>(
  entries: T[],
  isAccessible: (provider: string) => boolean,
): T[] {
  return entries.filter((entry) => isAccessible(entry.provider));
}

/** 快照只写 ok:true（checkedAt/latency 保留，错误结论不进盘）。 */
export function snapshotFromLedger(
  entries: Array<[string, LlmAvailabilityInfo]>,
): Record<string, LlmAvailabilityInfo> {
  const out: Record<string, LlmAvailabilityInfo> = {};
  for (const [key, info] of entries) {
    if (!info || info.ok !== true) continue;
    out[key] = { ok: true, checkedAt: info.checkedAt, latencyMs: info.latencyMs };
  }
  return out;
}

/** 快照 adoption：只接受当前配置身份下的 ok:true 条目（身份失配即废）。 */
export function adoptSnapshot(
  snap: Record<string, LlmAvailabilityInfo> | null | undefined,
  validKeys: Set<string>,
): Array<[string, LlmAvailabilityInfo]> {
  const out: Array<[string, LlmAvailabilityInfo]> = [];
  if (!snap) return out;
  for (const [key, info] of Object.entries(snap)) {
    if (!validKeys.has(key)) continue;
    if (!info || info.ok !== true) continue;
    out.push([key, { ...info, ok: true }]);
  }
  return out;
}

/** 设置保存是否触到 LLM 相关字段（provider/model/key/自定义供应商/模型库/
 * 代理——代理影响可达性）。主题、字号这类无关保存不触发全量重探。 */
const LLM_RELEVANT_FIELDS = [
  'provider',
  'model',
  'apiKey',
  'hasApiKey',
  'customProviders',
  'providerOverrides',
  'providerModels',
  'proxy',
] as const;

export function llmRelevantConfigChanged(a: PureConfig | null, b: PureConfig | null): boolean {
  for (const field of LLM_RELEVANT_FIELDS) {
    const av = a ? (a as unknown as Record<string, unknown>)[field] : undefined;
    const bv = b ? (b as unknown as Record<string, unknown>)[field] : undefined;
    if (JSON.stringify(av ?? null) !== JSON.stringify(bv ?? null)) return true;
  }
  return false;
}

/** 回合失败是否连接层（判据：DNS/TLS/拒绝/超时/401/403/网关拦截）；
 * 429/限流与业务错误不算——链路是通的，降架它们只会误伤。 */
export function isConnectionLayerTurnError(raw: string): boolean {
  const text = raw || '';
  if (!text) return false;
  if (/\b429\b|rate.?limit|限流/i.test(text)) return false;
  if (/\b40[13]\b/.test(text) && /api[\s-]?key|unauthorized|forbidden|凭证|拒绝/i.test(text)) return true;
  if (/stream_timeout|timeout|timed?\s?out|超时/i.test(text)) return true;
  if (/network error|connection|refused|econn|dns|tls|ssl|certificate|fetch failed|failed to fetch|socket/i.test(text)) return true;
  if (/拦截|blocked|gateway|网关/i.test(text)) return true;
  return false;
}

// ── 端点枚举单缝（与 createLLMAdapter 同款解析）──

export interface LlmEndpointDesc {
  provider: string;
  baseURL: string;
  /** Rust secret 槽名（'llm.apiKey.<id>'），桌面探测唯一钥匙来源。 */
  secretKey?: string;
  /** chat_stream 同款：内置 provider 允许回退 legacy 共享槽，custom 不允许。 */
  allowLegacyKeyFallback: boolean;
  anthropic: boolean;
  isCustom: boolean;
  /** 浏览器模式专用（config 存储的明文 key；桌面路径永不过 WebView）。 */
  plaintextKey: string;
}

/** 已配置端点清单 = PROVIDERS ∪ customProviders 过 providerHasKey 一条缝。
 *  枚举、key 解析、协议解析全部对齐 createLLMAdapter——探测与真实对话
 *  永不说两套话（此前枚举与门禁两套口径，配了 key 的非当前内置 provider
 *  被探成 401-dead）。 */
export function configuredEndpoints(cfg: PureConfig | null): LlmEndpointDesc[] {
  if (!cfg) return [];
  const customs = cfg.customProviders ?? [];
  const out: LlmEndpointDesc[] = [];
  for (const p of PROVIDERS) {
    // 被 custom 同 id 遮影时交给 customs 循环，避免双发。
    if (customProviderFor(customs, p.id)) continue;
    if (!providerHasKey(cfg, p.id)) continue;
    const override = providerOverrideFor(cfg.providerOverrides, p.id);
    const baseURL = customBaseURL(customs, p.id, cfg.providerOverrides);
    if (!baseURL) continue;
    const protocol = resolveProviderProtocol(
      providerDef(p.id)?.protocol,
      baseURL,
      Boolean(override?.baseURL),
      override?.protocol,
    );
    out.push({
      provider: p.id,
      baseURL,
      secretKey: providerSecretKeyFor(p.id, customs),
      allowLegacyKeyFallback: true,
      anthropic: protocol === 'anthropic',
      isCustom: false,
      plaintextKey: override?.apiKey ?? '',
    });
  }
  for (const c of customs) {
    if (!providerHasKey(cfg, c.id)) continue;
    const protocol = resolveProviderProtocol(undefined, c.baseURL, true, c.protocol);
    out.push({
      provider: c.id,
      baseURL: c.baseURL,
      secretKey: providerSecretKeyFor(c.id, customs),
      allowLegacyKeyFallback: false,
      anthropic: protocol === 'anthropic',
      isCustom: true,
      plaintextKey: c.apiKey ?? '',
    });
  }
  return out;
}

// ── 台账状态 ──

const availability = new Map<string, LlmAvailabilityInfo>();
const inFlight = new Set<string>();
const lastProbeAt = new Map<string, number>();
const backoffUntil = new Map<string, number>();
const failCount = new Map<string, number>();
const warmFailStreak = new Map<string, number>();
const SNAPSHOT_KEY = 'pure.llmAvailability.v1';

let refreshHook: (() => void) | null = null;
let loopStarted = false;
let loopTimer: number | null = null;
let sweepTimer: number | null = null;
let refreshScheduled = false;

function endpointKey(provider: string, baseURL: string): string {
  return `${provider}::${baseURL.trimEnd().replace(/\/+$/, '')}`;
}

function findEndpoint(provider: string): LlmEndpointDesc | undefined {
  return configuredEndpoints(loadConfig()).find((e) => e.provider === provider);
}

/** 呈现层刷新（注入缝；合批去抖，一轮探测潮只刷几次而不是逐端点刷）。 */
export function setModelAvailabilityRefreshHook(fn: (() => void) | null): void {
  refreshHook = fn;
}

function scheduleRefresh(): void {
  if (refreshScheduled) return;
  refreshScheduled = true;
  window.setTimeout(() => {
    refreshScheduled = false;
    try {
      refreshHook?.();
    } catch {}
  }, 50);
}

// ── 快照 ──

function loadSnapshot(): void {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return;
    const snap = JSON.parse(raw) as Record<string, LlmAvailabilityInfo>;
    const validKeys = new Set(configuredEndpoints(loadConfig()).map((e) => endpointKey(e.provider, e.baseURL)));
    for (const [key, info] of adoptSnapshot(snap, validKeys)) availability.set(key, info);
  } catch {}
}

function saveSnapshot(): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshotFromLedger([...availability])));
  } catch {}
}

// ── 探测 ──

/** 探一个 provider 的端点。同端点在飞即复用；periodic/backoff/warm-streak
 *  受最小间隔约束，manual/config-change/turn-failure 直发（用户动作与真实
 *  失败是最权威的信号）。 */
export async function probeLlmProviderNow(
  provider: string,
  reason: LlmProbeReason = 'manual',
): Promise<LlmAvailabilityInfo | null> {
  const endpoint = findEndpoint(provider);
  if (!endpoint) return null;
  const key = endpointKey(endpoint.provider, endpoint.baseURL);
  if (inFlight.has(key)) return availability.get(key) ?? null;

  const now = Date.now();
  const last = lastProbeAt.get(key) ?? 0;
  const minGap =
    reason === 'periodic' || reason === 'backoff' || reason === 'warm-streak'
      ? PERIODIC_MIN_GAP_MS
      : reason === 'turn-failure'
        ? TURN_FAILURE_MIN_GAP_MS
        : 0;
  if (now - last < minGap) return availability.get(key) ?? null;
  if (reason === 'backoff' && now < (backoffUntil.get(key) ?? 0)) return availability.get(key) ?? null;

  inFlight.add(key);
  lastProbeAt.set(key, now);
  try {
    let outcome: LlmProbeOutcome;
    const cfg = loadConfig();
    if (isTauriRuntime()) {
      try {
        const core = await loadTauriCore();
        if (!core) throw new Error('Tauri runtime unavailable');
        // 路线 PARITY 与真实对话：同 netRoute 决策（直连优先/学习路线/
        // 对向 fallback），只跳过被 bypass 的 provider。
        const proxyCfg = normalizeProxyConfig(cfg?.proxy);
        const bypassed = proxyCfg.bypassProviders?.includes(endpoint.provider) ?? false;
        const rawProxy = bypassed ? '' : (effectiveProxyUrl(proxyCfg) ?? '');
        const pair = rawProxy
          ? netRouteProxyPair(endpoint.baseURL, rawProxy)
          : { proxyUrl: '', fallbackProxyUrl: null as string | null };
        outcome = (await core.invoke('test_llm_connection', {
          baseUrl: endpoint.baseURL,
          // 桌面同款：key 永不过 WebView，只传 secret 槽名。
          apiKey: '',
          secretKey: endpoint.secretKey ?? '',
          allowLegacyKeyFallback: endpoint.allowLegacyKeyFallback,
          proxyUrl: pair.proxyUrl,
          ...(pair.fallbackProxyUrl !== null ? { fallbackProxyUrl: pair.fallbackProxyUrl } : {}),
          proxyBypassProviders: proxyCfg?.bypassProviders ?? [],
          provider: endpoint.provider,
          protocol: endpoint.anthropic ? 'anthropic' : 'openai',
        })) as LlmProbeOutcome;
      } catch (e) {
        outcome = { ok: false, error: (e as Error)?.message || String(e) };
      }
    } else {
      // 浏览器 dev 模式：shared/llmProbe 是 Rust probe 的语义镜像（含协议头）。
      outcome = await probeLlmEndpoint(endpoint.baseURL, endpoint.plaintextKey, {
        anthropic: endpoint.anthropic,
      });
    }

    const info = verdictFromProbe(availability.get(key), outcome);
    availability.set(key, info);
    if (info.ok) {
      failCount.delete(key);
      backoffUntil.delete(key);
    } else {
      const fails = (failCount.get(key) ?? 0) + 1;
      failCount.set(key, fails);
      // 退避补探：首次失败 60s，再失败 5min，之后交给周期兜底。
      backoffUntil.set(key, Date.now() + (fails === 1 ? BACKOFF_FIRST_MS : BACKOFF_SECOND_MS));
    }
    return info;
  } finally {
    inFlight.delete(key);
    scheduleRefresh();
  }
}

/** 全量探测：先做身份对账（配置里已不存在的端点条目作废），当前 provider
 *  最先发车（用户最可能马上用），其余并发跟上。结束统一落快照。 */
export async function probeAllConfiguredProviders(reason: LlmProbeReason = 'startup'): Promise<void> {
  const cfg = loadConfig();
  const endpoints = configuredEndpoints(cfg);
  if (endpoints.length === 0) {
    scheduleRefresh();
    return;
  }
  const validKeys = new Set(endpoints.map((e) => endpointKey(e.provider, e.baseURL)));
  for (const key of [...availability.keys()]) {
    if (!validKeys.has(key)) availability.delete(key);
  }
  const current = cfg?.provider;
  const ordered = [...endpoints].sort(
    (a, b) => Number(b.provider === current) - Number(a.provider === current),
  );
  await Promise.allSettled(ordered.map((e) => probeLlmProviderNow(e.provider, reason)));
  saveSnapshot();
}

/** 失败端点退避补探扫描（30s 一拍，到期才发车）。 */
async function sweepBackoff(): Promise<void> {
  const now = Date.now();
  const due: string[] = [];
  for (const [key, until] of backoffUntil) {
    if (now >= until) due.push(key.split('::')[0] ?? key);
  }
  if (due.length === 0) return;
  await Promise.allSettled([...new Set(due)].map((provider) => probeLlmProviderNow(provider, 'backoff')));
  saveSnapshot();
}

// ── 信号接线 ──

/** llmWarm 连败信号：预热 GET 每 30s 已在打当前端点，连续 N 轮全路失败 =
 *  端点死亡的最便宜前兆 → 触发正式重探（受最小间隔约束，不轰炸）。
 *  成功或重新计数前先清零。 */
export function notifyLlmWarmFailure(provider: string): void {
  const endpoint = findEndpoint(provider);
  if (!endpoint) return;
  const key = endpointKey(endpoint.provider, endpoint.baseURL);
  const streak = (warmFailStreak.get(key) ?? 0) + 1;
  warmFailStreak.set(key, streak);
  if (streak >= WARM_STREAK_TRIGGER) {
    warmFailStreak.set(key, 0);
    void probeLlmProviderNow(provider, 'warm-streak').then((info) => {
      if (info) saveSnapshot();
    });
  }
}

export function notifyLlmWarmSuccess(provider: string): void {
  const endpoint = findEndpoint(provider);
  if (!endpoint) return;
  warmFailStreak.set(endpointKey(endpoint.provider, endpoint.baseURL), 0);
}

/** 回合失败信号：判据最真、零额外请求。连接层失败才失效 + 即时重探；
 *  429/业务错误不碰台账。 */
export function notifyLlmTurnFailure(provider: string): void {
  const endpoint = findEndpoint(provider);
  if (!endpoint) return;
  const key = endpointKey(endpoint.provider, endpoint.baseURL);
  availability.delete(key);
  void probeLlmProviderNow(provider, 'turn-failure').then((info) => {
    if (info) saveSnapshot();
  });
}

/** 设置页「测试连接」直接过账（成功失败都记——按钮自己已发过探测，
 *  不重复发）。 */
export function recordLlmProbeOutcome(provider: string, outcome: LlmProbeOutcome): void {
  const endpoint = findEndpoint(provider);
  if (!endpoint) return;
  const key = endpointKey(endpoint.provider, endpoint.baseURL);
  const info = verdictFromProbe(availability.get(key), outcome);
  availability.set(key, info);
  if (info.ok) {
    failCount.delete(key);
    backoffUntil.delete(key);
  }
  saveSnapshot();
  scheduleRefresh();
}

// ── 呈现层查询 ──

/** 单缝判据：已配置 ∧ 台账最近结论 ok。未知（没探过）= 不可访问 = 不显示。 */
export function isLlmProviderAccessible(provider: string): boolean {
  const endpoint = findEndpoint(provider);
  if (!endpoint) return false;
  return availability.get(endpointKey(endpoint.provider, endpoint.baseURL))?.ok === true;
}

// ── 生命周期 ──

/** 启动：恢复快照（列表立即有内容）→ 后台探测潮纠偏；30min 周期全量 +
 *  30s 退避扫描。幂等，多会话共享。 */
export function startLlmAvailabilityProbeLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  loadSnapshot();
  void probeAllConfiguredProviders('startup');
  loopTimer = window.setInterval(() => void probeAllConfiguredProviders('periodic'), PROBE_INTERVAL_MS);
  sweepTimer = window.setInterval(() => void sweepBackoff(), SWEEP_INTERVAL_MS);
}

export function stopLlmAvailabilityProbeLoopForTests(): void {
  if (loopTimer !== null) window.clearInterval(loopTimer);
  if (sweepTimer !== null) window.clearInterval(sweepTimer);
  loopTimer = null;
  sweepTimer = null;
  loopStarted = false;
  availability.clear();
  inFlight.clear();
  lastProbeAt.clear();
  backoffUntil.clear();
  failCount.clear();
  warmFailStreak.clear();
}
