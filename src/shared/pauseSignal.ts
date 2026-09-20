// src/shared/pauseSignal.ts
// 阶段 12（暂停/续跑）：暂停不是另一种信号通道，而是同一个 abort 信号上的一段
// reason。controller.abort(PAUSE_ABORT_REASON) 之后：
//   - 引擎在 THINK 边界立即 yield Interrupted（reason 'paused'）——LLM 流被掐断；
//   - 工具协调器不把这个 abort 转发给在跑的工具——手头的命令/委派安全收尾，
//     排队未启动的工具直接跳过；
//   - 子 agent 编排器识别出暂停，落盘存档（本来就会做）并回报 paused 状态。
// 不支持 AbortSignal.reason 的旧 webview 上 reason 读不到，isPauseAbort 恒 false，
// 暂停优雅降级为今天的硬停——功能退一档，不出错。

/** Abort reason marker: "drain gracefully" — stop LLM output, let in-flight
 * tools finish, never start queued ones. Any other abort stays a hard stop. */
export const PAUSE_ABORT_REASON = 'pure:pause';

export function abortPaused(controller: AbortController | null | undefined): void {
  controller?.abort(PAUSE_ABORT_REASON);
}

export function isPauseAbort(signal: AbortSignal | null | undefined): boolean {
  if (!signal?.aborted) return false;
  return (signal as { reason?: unknown }).reason === PAUSE_ABORT_REASON;
}

/** The Interrupted event reason an engine should yield for the current signal
 * state — 'paused' for a drain-style pause, 'aborted' for a hard stop. */
export function interruptedReasonFor(signal: AbortSignal | null | undefined): string {
  return isPauseAbort(signal) ? 'paused' : 'aborted';
}
