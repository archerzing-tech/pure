// src/ui/memoryDecayTimer.ts
// GUI 后台记忆衰减定时器。Harness 只在会话开始时（1 小时节流）触发衰减——
// 用户不发起聊天时旧记忆永远不会被降级/删除。本模块让 app 空闲时也在节流
// 窗过后自动执行 decay()：一条记忆从创建起就会按遗忘速度随时间走完
// active → degraded → dormant → 删除 的生命周期，即使没有任何新会话。
//
// 语义与 Harness 完全一致（见 src/harness/Harness.ts）：
//   • MEMORY_DECAY_INTERVAL_MS    — 节流窗：decay 至少间隔 1 小时
//   • MEMORY_DECAY_OLDER_THAN_MS  — 只处理闲置超过 14 天的记忆
// 调度依据存储层记录的 lastDecayAt（LocalStorageMemoryStore/FSMemoryStore 的
// meta），所以 Harness 触发过的衰减（会话开始时）会被本定时器感知，不会重复
// 提前执行。Memory 技能关闭时跳过 decay（但继续调度，用户随时可能开启）。

import { memoryStore } from './memoryStore';
import { loadConfig } from './config';

/** 与 Harness.MEMORY_DECAY_INTERVAL_MS 一致：decay 至少间隔 1 小时。 */
export const MEMORY_DECAY_INTERVAL_MS = 60 * 60 * 1000;
/** 与 Harness.MEMORY_DECAY_MS 一致：只处理闲置超过 14 天的记忆。 */
export const MEMORY_DECAY_OLDER_THAN_MS = 14 * 24 * 3600 * 1000;

let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

/** 距下次衰减调度还有多久（ms）。从未运行 → 0（启动后立即触发第一轮）。 */
export function computeNextDecayDelayMs(
  lastDecayAt: number | undefined,
  now = Date.now(),
): number {
  if (!lastDecayAt) return 0;
  return Math.max(0, lastDecayAt + MEMORY_DECAY_INTERVAL_MS - now);
}

function scheduleNext(delayMs?: number): void {
  if (!started) return;
  const info = memoryStore.getLastDecayInfo();
  const delay = delayMs ?? computeNextDecayDelayMs(info.lastDecayAt);
  timer = setTimeout(() => { void runDecay(); }, delay);
}

async function runDecay(): Promise<void> {
  try {
    const cfg = loadConfig();
    const memoryEnabled = cfg?.skills?.memory !== false;
    // 触发时刻是唯一决策点：先重读 meta。若 Harness / 手动「立即执行衰减」
    // 在我们调度之后已经跑过 decay，store 的 lastDecayAt 已推进 —— 窗口未满
    // 则只重排、不重复执行（避免同一小时内重复全量扫描 + 落盘）。
    const info = memoryStore.getLastDecayInfo();
    const remaining = computeNextDecayDelayMs(info.lastDecayAt);
    if (remaining > 0) {
      scheduleNext(remaining);
      return;
    }
    if (!memoryEnabled) {
      // 技能关闭：跳过衰减但继续轮询，用户随时可能开启。必须用 1h 下限
      // 调度 —— 若沿用 computeNextDecayDelayMs（lastDecayAt 陈旧/从未运行
      // 时为 0），会陷入 0ms 忙循环空转主线程。
      scheduleNext(MEMORY_DECAY_INTERVAL_MS);
      return;
    }
    await memoryStore.decay(MEMORY_DECAY_OLDER_THAN_MS);
    // 通知设置面板刷新诊断区/仪表盘（若打开）——下次衰减时间与统计已变化。
    document.dispatchEvent(new CustomEvent('pure:memory-decay-run'));
    scheduleNext(); // decay 已把 meta 推进到 now → 下一轮自动落在 1h 窗后
  } catch (err) {
    console.error('[pure] background memory decay failed:', err);
    scheduleNext(MEMORY_DECAY_INTERVAL_MS); // 失败 1 小时后重试
  }
}

/** 启动后台衰减定时器（幂等；main.ts deferred init 调用）。 */
export function startMemoryDecayTimer(): void {
  if (started) return;
  started = true;
  scheduleNext();
}

/** 停止后台衰减定时器（幂等；清理测试/卸载用）。 */
export function stopMemoryDecayTimer(): void {
  started = false;
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
}
