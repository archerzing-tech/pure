// src/shared/pauseSignal.ts
// 阶段 12（暂停/续跑）：暂停不是另一种信号通道，而是同一个 abort 信号上的一段
// reason。controller.abort(PAUSE_ABORT_REASON) 之后：
//   - 引擎在 THINK 边界立即 yield Interrupted（reason 'paused'）——LLM 流被掐断；
//   - 工具协调器给在跑的工具一段**宽限期**（1c 暂停真即时，对话智能升格）：
//     宽限内自然收尾最理想；到期未完 → abort 以同一个 pause reason 转发——
//     reason 顺着 toolStop → parentSignal 送达子代理编排器（isPauseAbort 由此
//     在 GUI 活链路可达），「暂停存档」与「硬停不算」重新分得开；
//   - 排队未启动的工具直接跳过；
//   - 子 agent 编排器识别出暂停，落盘存档（本来就会做）并回报 paused 状态。
// 不支持 AbortSignal.reason 的旧 webview 上 reason 读不到，isPauseAbort 恒 false，
// 暂停优雅降级为今天的硬停——功能退一档，不出错。

/** Abort reason marker: "pause" — stop LLM output now, give in-flight tools a
 * grace window to finish, then interrupt them with this same reason so the
 * whole chain (tool result, subagent checkpoint, card state) knows this was a
 * pause, not a user cancel. Any other abort stays a hard stop. */
export const PAUSE_ABORT_REASON = 'pure:pause';

/** 1c — how long an in-flight tool may keep running after a pause before the
 * abort is forwarded to it. Long enough for a quick command to land, short
 * enough that "pause" feels like pause. Override per engine context with
 * pauseToolGraceMs (tests use milliseconds). */
export const PAUSE_TOOL_GRACE_MS = 8_000;

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
