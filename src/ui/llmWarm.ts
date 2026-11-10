// src/ui/llmWarm.ts
// LLM 预热循环（期3 路由脑，2026-10-30）。每 30s 对当前 LLM 端点的两条
// 物理路（直连 + 当前配置的代理）各发一个零费用 GET（Rust warm_llm_routes，
// 5s 封顶），把 TCP+TLS 会话建好、连接塞进 Rust 侧的连接池（reqwest 池
// idle 90s > 周期，热连接永不过期）。下一个回合因此省掉整段
// DNS+TCP+TLS 握手——首字时延的传输层部分直接归零，代理路收益更大。
// 预热只是尽力：失败静默（不进学习表——GET 的失败不证路由死，判定权留给
// 真实请求），对话内零打扰。流式中 Rust 侧自己跳过（在飞计数 busy guard）。

import { loadConfig, type PureConfig } from './config';
import { effectiveProxyUrl } from '../shared/proxy';
import { customBaseURL } from '../shared/providers';
import { loadTauriCore } from '../shared/tauri';
import { recordWarmPrior } from '../shared/netRoute';
import { notifyLlmWarmFailure, notifyLlmWarmSuccess } from './llmModelAvailability';

const WARM_INTERVAL_MS = 30_000;

let loopStarted = false;
let loopTimer: number | null = null;
let warmInFlight = false;
let lastWarm: { baseUrl: string; proxied: boolean } | null = null;
/** 窗口级模型覆盖的读取口（main.ts 注入，2026-11-06 多窗口各自选模型）：
 *  预热目标必须跟本窗口生效模型走——全局 config 被 B 窗口写成 deepseek 时，
 *  A 窗口 override 的 glm 端点若不跟着覆盖，每回合都付全套 DNS+TCP+TLS
 *  握手（真机取证：glm 窗口 TTFT 均值 10s，传输层白付约 3-4s）。 */
let windowModelOverrideGetter: (() => { provider: string; model: string } | null) | null = null;

export function setWindowModelOverrideGetter(fn: () => { provider: string; model: string } | null): void {
  windowModelOverrideGetter = fn;
}

export function isWarmInFlight(): boolean {
  return warmInFlight;
}

/** 调试用快照：最近一轮预热打了哪个端点、代理路有没有参与。 */
export function lastWarmRouteInfo(): { baseUrl: string; proxied: boolean } | null {
  return lastWarm;
}

/** 当前会话的 LLM 端点（与 chat_stream 用同一套解析，永不各说各话）。
 *  窗口覆盖优先：override 的 provider 生效时预热它的端点，全局兜底。 */
export function resolveWarmEndpoint(config: PureConfig, override: { provider: string } | null): string {
  const customs = config.customProviders ?? [];
  const provider = override?.provider ?? config.provider;
  return customBaseURL(customs, provider, config.providerOverrides);
}

/**
 * 预热一轮：读当前配置（端点 + 代理），invoke warm_llm_routes。幂等
 * （进行中不重复发），失败静默——预热是尽力而为，不该有可观察的失败面。
 */
export async function warmLlmRoutesNow(): Promise<void> {
  if (warmInFlight) return;
  const cfg = loadConfig();
  const override = windowModelOverrideGetter?.() ?? null;
  const baseUrl = cfg ? resolveWarmEndpoint(cfg, override) : '';
  const proxyUrl = cfg ? effectiveProxyUrl(cfg.proxy) : '';
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) return;
  warmInFlight = true;
  try {
    const core = await loadTauriCore();
    if (!core) return;
    const r = (await core.invoke('warm_llm_routes', {
      baseUrl,
      proxyUrl: proxyUrl || undefined,
    })) as { skipped?: string; direct?: { ok: boolean; ms: number } | null; proxy?: { ok: boolean; ms: number } | null };
    lastWarm = { baseUrl, proxied: r?.proxy != null };
    // P0 前移刀（2026-11-07）：耗时留痕——两路毫秒写进 warmPrior，冷启动
    // 选路按它定首选（网络层蓝图）。skipped 轮（busy/无端点）无样本可写。
    if (!r?.skipped) recordWarmPrior(baseUrl, { direct: r?.direct ?? undefined, proxy: r?.proxy ?? undefined });
    // 可用性台账信号（v2 P1）：预热本就每 30s 在打当前端点，全路失败是
    // 端点死亡的最便宜前兆——连败计数喂给台账，台账攒够 3 轮自己发正式
    // 重探。弱证据不直接下架（预热 GET 失败不证端点死，判定权在正式探测）。
    const warmProvider = override?.provider ?? cfg?.provider;
    if (warmProvider) {
      const anyRouteOk = r?.direct?.ok === true || r?.proxy?.ok === true;
      if (anyRouteOk) notifyLlmWarmSuccess(warmProvider);
      else if (r?.direct?.ok === false || r?.proxy?.ok === false) notifyLlmWarmFailure(warmProvider);
    }
  } catch {
    // 命令不可用（旧后端）或网络失败：静默。下一个 tick 自然重试。
  } finally {
    warmInFlight = false;
  }
}

/** 启动 + 每 30s 的预热循环。幂等，多处可安全调用。 */
export function startLlmWarmLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  void warmLlmRoutesNow();
  loopTimer = window.setInterval(() => void warmLlmRoutesNow(), WARM_INTERVAL_MS);
}
