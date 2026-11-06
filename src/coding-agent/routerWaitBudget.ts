// src/coding-agent/routerWaitBudget.ts
// 语义路由等待线的自适应预算（2026-11-06）。固定 3s 线是盲的：judge 的回话
// 能力跟着端点时段波动（首字节 1.4-5.3s 实测），慢时段判定九字段也要 3s+，
// 每轮等满线白等再走 fallback——白等对闲聊轮是纯伤（超时无损但时间照付）。
// 「等多久」是宿主的物理预算（2026-11-05 判例原话），这里只校准这个数字，
// 「这轮是什么」的裁决权仍在路由模型。
//
// 状态机（机械、可测）：
// - 基线 BASE_TIMEOUT_MS；基线下连续 FAIL_STREAK_TO_SHRINK 笔「没拿到判定」
//   → 降线 SHRUNK_TIMEOUT_MS（少白等，拿不到就早点 fallback）。
// - 降线下连续 RECOVER_STREAK 笔拿到判定（降线内成功必然快于线，天然是
//   「快成功」）→ 回基线（端点恢复后别漏掉判定）。
// - 30min 断档清零：隔了时段量级的旧失败不是现状证据（endpointCacheQuality
//   同构）。不分 provider 键：judge 跟主 provider 走，换 provider 是罕见事件，
//   断档清零兜底。
// - caller abort（用户停轮/切会话）不记账：那是人手掐的，不是端点慢。

/** 基线等待线：judge 在端点常态下九字段判定时刻的覆盖线（2026-11-05 判例
 *  从 8s 压到 3s 的取值，判定前移后九字段 ~2-3s，3s 保持）。 */
export const BASE_ROUTE_TIMEOUT_MS = 3_000;
/** 慢时段降线：连续超时后的少白等值——判定大概率拿不到，早点 fallback。 */
export const SHRUNK_ROUTE_TIMEOUT_MS = 2_200;
/** 基线下连续这么多个判定落空才降线（1 笔可能是偶发）。 */
const FAIL_STREAK_TO_SHRINK = 2;
/** 降线下连续拿到判定这么多笔就回基线（端点缓过来的证据）。 */
const RECOVER_STREAK = 2;
/** 失败 streak 的时间断档重置线：与 GAP_RESET 同源（时段量级中值）。 */
const GAP_RESET_MS = 30 * 60 * 1000;

let shrunk = false;
let timeoutStreak = 0;
let recoveredStreak = 0;
let lastAt = 0;

/** 记一笔 judge 往返的结果。gotVerdict=false 含超时与「回了但 JSON 不可
 *  用」——对等待预算而言两者都是白等。elapsedMs 目前只作观测留痕，判据
 *  全在成功/失败二值上。 */
export function recordRouterOutcome(gotVerdict: boolean, now: number = Date.now()): void {
  if (lastAt > 0 && now - lastAt > GAP_RESET_MS) {
    shrunk = false;
    timeoutStreak = 0;
    recoveredStreak = 0;
  }
  lastAt = now;
  if (gotVerdict) {
    timeoutStreak = 0;
    if (shrunk) {
      recoveredStreak++;
      if (recoveredStreak >= RECOVER_STREAK) {
        shrunk = false;
        recoveredStreak = 0;
      }
    }
    return;
  }
  recoveredStreak = 0;
  if (!shrunk && ++timeoutStreak >= FAIL_STREAK_TO_SHRINK) {
    shrunk = true;
    timeoutStreak = 0;
  }
}

/** 当前轮的 judge 等待线：发请求那一刻读，streamUntilParsed 的超时 race 用它。 */
export function routerTimeoutMs(now: number = Date.now()): number {
  if (lastAt > 0 && now - lastAt > GAP_RESET_MS) return BASE_ROUTE_TIMEOUT_MS;
  return shrunk ? SHRUNK_ROUTE_TIMEOUT_MS : BASE_ROUTE_TIMEOUT_MS;
}

/** 测试隔离钩子：模块级状态是进程全局，测试必须显式清账
 *  （bun test 单进程判例——泄漏进别的用例就是顺序地雷）。 */
export function resetRouterWaitBudgetForTests(): void {
  shrunk = false;
  timeoutStreak = 0;
  recoveredStreak = 0;
  lastAt = 0;
}
