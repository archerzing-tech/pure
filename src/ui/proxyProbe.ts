// src/ui/proxyProbe.ts
// 代理健康探测调度（期2 路由脑，2026-10-30）。数据落在 netRoute 的代理
// 健康行（recordProxyProbe），本模块只管「何时探」：应用启动、每 5 分钟、
// 真实请求撞墙后（30s 节流）、设置页打开/保存代理后。探测走 Rust
// probe_proxy（3s 总超时，经代理请求 generate_204）。
// 用户口径：代理是可选工具，配置挂了要及时识别——但识别是 pure 的内部
// 动作，对话内零打扰，结论只在设置页如实标注。

import { loadConfig } from './config';
import { effectiveProxyUrl } from '../shared/proxy';
import { recordProxyProbe, proxyHealthInfo } from '../shared/netRoute';
import { loadTauriCore } from '../shared/tauri';

export type ProxyProbeReason = 'startup' | 'periodic' | 'failure' | 'manual';

const PROXY_PROBE_INTERVAL_MS = 5 * 60_000;
/** 失败触发的节流窗：死代理撞墙是每请求级的，探测不能跟着每请求走。 */
const PROXY_PROBE_MIN_GAP_MS = 30_000;

let inFlight = false;
let lastProbeAt = 0;
let loopStarted = false;
let loopTimer: number | null = null;

export function lastProxyProbeAtMs(): number {
  return lastProbeAt;
}

/** 探测进行中（设置页据此显示「正在探测…」而不是误读旧结论）。 */
export function isProbeInFlight(): boolean {
  return inFlight;
}

/** 探一次当前配置的代理，结论写进路由脑。幂等（进行中不重复发）。 */
export async function probeProxyNow(reason: ProxyProbeReason = 'manual'): Promise<void> {
  const cfg = loadConfig();
  const raw = cfg ? effectiveProxyUrl(cfg.proxy) : '';
  if (!raw || inFlight) return;
  const now = Date.now();
  if (reason === 'failure' && now - lastProbeAt < PROXY_PROBE_MIN_GAP_MS) return;
  inFlight = true;
  lastProbeAt = now;
  try {
    const core = await loadTauriCore();
    if (!core) return;
    const r = await core.invoke('probe_proxy', { proxyUrl: raw }) as { ok?: boolean; latencyMs?: number };
    recordProxyProbe(raw, r?.ok === true, Date.now(), r?.latencyMs);
  } catch {
    // 命令不可用（旧后端）按死处理：设置页会如实标「不可达」，5 分钟后重探。
    recordProxyProbe(raw, false, Date.now());
  } finally {
    inFlight = false;
  }
}

/** 启动 + 每 5 分钟的常态探测循环。幂等，多处可安全调用。 */
export function startProxyProbeLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  void probeProxyNow('startup');
  loopTimer = window.setInterval(() => void probeProxyNow('periodic'), PROXY_PROBE_INTERVAL_MS);
}

export function stopProxyProbeLoop(): void {
  if (loopTimer !== null) {
    window.clearInterval(loopTimer);
    loopTimer = null;
  }
  loopStarted = false;
}

/** 真实请求撞墙后的及时重探（节流内跳过）。 */
export function notifyProxyFailure(): void {
  void probeProxyNow('failure');
}

/** 设置页渲染用：当前代理的健康三态快照。 */
export function proxyHealthSnapshot(): { state: ReturnType<typeof proxyHealthInfo>['state']; latencyMs?: number; deadSince?: number; configured: boolean } {
  const cfg = loadConfig();
  const raw = cfg ? effectiveProxyUrl(cfg.proxy) : '';
  if (!raw) return { state: 'unknown', configured: false };
  const info = proxyHealthInfo(raw);
  return { ...info, configured: true };
}

/** 供 settings 保存代理后立即刷新结论。返回探测完成的 Promise，调用方
 *  （设置页）可在其后重绘状态徽标。 */
export function reprobeProxyAfterConfigChange(): Promise<void> {
  lastProbeAt = 0; // 手动动作不受节流约束
  return probeProxyNow('manual');
}
