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

/** 对话智能升格第 2 期（分支中断）：单支叫停的 abort reason。只打在被点名
 * 分支自己的 controller 上（编排器分支注册表的把手），父级信号不动——同批
 * 其余支零感知。子代理的引擎照走 Interrupted+checkpoint 链（存档不分原因），
 * 编排器结算时按这个 reason 记「已中止」：产出不入账、断点照存、可另起续。 */
export const BRANCH_ABORT_REASON = 'pure:branch-abort';

export function isBranchAbort(signal: AbortSignal | null | undefined): boolean {
  if (!signal?.aborted) return false;
  return (signal as { reason?: unknown }).reason === BRANCH_ABORT_REASON;
}

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

/** 插话重入（2026-10-28 并线/另线改版，docs/interjection-inline-sideline.md
 *  细化 1「嘴/手分开」）：思考流在吐字时来了并线插话——立即掐流，判定完带
 *  原话重新开口。与 PAUSE_ABORT_REASON 的语义差：pause 是「存档等续跑」（落
 *  暂停账、在飞支结算成已暂停、渲染停止态、等用户放行）；reenter 是「立即
 *  带原话重开思考」（不落暂停账、不渲染停止态、宿主收到 Interrupted 后马上
 *  重开 THINK，插话原话经 steerBus 在新轮边界注入）。半截思考丢弃是刻意的：
 *  前缀缓存使重想便宜，而「被打断后接着说」本来就是重说。 */
export const INTERJECT_REENTER_REASON = 'pure:interject-reenter';

export function abortReenter(controller: AbortController | null | undefined): void {
  controller?.abort(INTERJECT_REENTER_REASON);
}

export function isInterjectReenter(signal: AbortSignal | null | undefined): boolean {
  if (!signal?.aborted) return false;
  return (signal as { reason?: unknown }).reason === INTERJECT_REENTER_REASON;
}

/** 1c 升级硬停（S2 第四刀收口）：暂停的宽限窗里再叫停，不等宽限——立即打断
 * 硬停第二通道（工具协调器的宽限定时器当场作废；在飞工具按暂停记账掐断，
 * 断点照存、卡片如实标 ⏸）。判定必须先于主信号的 abort——abort 会把暂停
 * reason 冲掉（已 aborted 的 controller 二次 abort 是 no-op，reason 保留，
 * 但新回合换了控制器后这个读数就再也拿不到了）。返回是否发生了升级；主信号
 * 的 abort 由调用方执行（顺序在工具协调器侧与升级可交换：escalate 与转发
 * 两路监听幂等——clearTimeout 幂等、abort 幂等——最终态一致）。 */
export function upgradeToHardStop(mainSignal: AbortSignal | null | undefined, hardStop: AbortController | null | undefined): boolean {
  const upgrade = isPauseAbort(mainSignal);
  if (upgrade) hardStop?.abort();
  return upgrade;
}

/** The Interrupted event reason an engine should yield for the current signal
 * state — 'paused' for a drain-style pause, 'reenter' for an interjection
 * restarting the THINK stream, 'aborted' for a hard stop. 优先级 pause >
 * reenter > aborted：升级路径（reenter 追在 pause 后）不能把「存档等续跑」
 * 降格成重开，也不能反过来把暂停读成硬停。 */
export function interruptedReasonFor(signal: AbortSignal | null | undefined): string {
  if (isPauseAbort(signal)) return 'paused';
  if (isInterjectReenter(signal)) return 'reenter';
  return 'aborted';
}
