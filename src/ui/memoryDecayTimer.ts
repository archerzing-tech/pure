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
// P0 棘轮：decay 之后同一节流窗内追加一次淘汰 pass（容量封顶 + 贡献淘汰，
// 见 adapter/memory/ratchet.ts）；进化总开关关闭时该 pass 跳过。

import { memoryStore } from './memoryStore';
import { loadConfig } from './config';
import { planEviction, RATCHET_DEFAULTS } from '../adapter/memory/ratchet';
import { summarizeInjectionContributions } from '../shared/contributionStats';
import { promptObservability, type PromptObservation } from '../shared/promptObservability';
import { readGuiObservations } from './observationSource';
import { t } from '../shared/i18n';

/** 与 Harness.MEMORY_DECAY_INTERVAL_MS 一致：decay 至少间隔 1 小时。 */
export const MEMORY_DECAY_INTERVAL_MS = 60 * 60 * 1000;
/** 与 Harness.MEMORY_DECAY_MS 一致：只处理闲置超过 14 天的记忆。 */
export const MEMORY_DECAY_OLDER_THAN_MS = 14 * 24 * 3600 * 1000;

let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

/** 宿主接缝（main.ts 注入 —— toast 是 main 的局部件，不可反向依赖）。 */
export interface MemoryDecayTimerHost {
  /** 「出卡」这半句的落点：一条会自己消失的通知。overlay 回退改变用户的
   *  行为面（角色装载回到前版/base）——只写控制台等于替用户静默改了他的
   *  团队；没有这个缝的宿主（测试）只是少一条通知，不影响回退本身。 */
  notify?: (message: string, durationMs?: number) => void;
}

let host: MemoryDecayTimerHost = {};

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
    // P0 棘轮 — 同一节流窗内追加一次淘汰 pass（先 decay 后 prune：decay 先把
    // 生命周期推进 + 落盘，棘轮再按容量/贡献淘汰）。任何失败只降级本轮棘轮，
    // 绝不影响 decay 本身（degrade-don't-block 纪律）。
    try {
      await runRatchetPass();
    } catch (err) {
      console.error('[pure] memory ratchet pass failed:', err);
    }
    // P1-2 overlay 回退护栏 — 同窗追加：13.3 落盘的 overlay 若在落盘后持续
    // 回归（派发 ≥8 次且失败率较基线恶化），meta 打回退标记 + 原文归档，
    // 下次装载回到前版/base。失败只降级本轮，不碰 decay。
    try {
      await runOverlayGuardPass();
    } catch (err) {
      console.error('[pure] overlay guard pass failed:', err);
    }
    // 通知设置面板刷新诊断区/仪表盘（若打开）——下次衰减时间与统计已变化。
    document.dispatchEvent(new CustomEvent('pure:memory-decay-run'));
    scheduleNext(); // decay 已把 meta 推进到 now → 下一轮自动落在 1h 窗后
  } catch (err) {
    console.error('[pure] background memory decay failed:', err);
    scheduleNext(MEMORY_DECAY_INTERVAL_MS); // 失败 1 小时后重试
  }
}

/**
 * P0 棘轮淘汰 pass：planEviction 决定名单（纯函数），store.prune 执行。
 * 贡献切片读持久观测（app.jsonl 尾读），失败降级进程内 ring buffer；总开关
 * 关掉时整段跳过（decay 是现状行为，不受进化开关管辖）。
 */
async function runRatchetPass(): Promise<void> {
  const cfg = loadConfig();
  if (cfg?.skills?.evolution === false) return;
  if (typeof memoryStore.prune !== 'function') return; // 第三方 store 未实现 → 跳过
  let records: PromptObservation[] = [];
  try {
    records = (await readGuiObservations()).records;
  } catch {
    records = [];
  }
  if (records.length === 0) records = promptObservability.records();
  const contributions = summarizeInjectionContributions(records);
  const plan = planEviction(memoryStore.list(), contributions, RATCHET_DEFAULTS, Date.now());
  if (plan.removeIds.length === 0) return;
  const removed = await memoryStore.prune(plan.removeIds);
  if (removed > 0) console.info(`[pure] memory ratchet pruned ${removed} entries`);
}

/**
 * P1-2 — overlay 回退判定 pass：读 ~/.pure/personas 的 meta 基线，用持久观测
 * 里落盘窗口后的真实结局判卷。纯逻辑在 harness/overlayGuard（runOverlayGuardPass），
 * 这里只做 Tauri IO 与数据源接线；总开关关掉时跳过（overlay 属进化层）。
 */
async function runOverlayGuardPass(): Promise<void> {
  const cfg = loadConfig();
  if (cfg?.skills?.evolution === false) return;
  const { loadTauriCore, tauriInvoke } = await import('../shared/tauri');
  const { join, homeDir } = await import('@tauri-apps/api/path');
  const core = await loadTauriCore();
  if (!core) return;
  const pureHome = await join(await homeDir(), '.pure');
  let roles: string[] = [];
  try {
    const files = await tauriInvoke<Array<{ file: string }>>('list_persona_overlays');
    roles = (files ?? []).map((f) => f.file.replace(/\.overlay\.md$/, ''));
  } catch {
    return;
  }
  if (roles.length === 0) return;
  let records: PromptObservation[] = [];
  try {
    records = (await readGuiObservations()).records;
  } catch {
    records = [];
  }
  const { runOverlayGuardPass: run } = await import('../harness/overlayGuard');
  const report = await run(
    {
      readFile: async (path) => {
        try {
          return await core.invoke<string>('read_file', { workspace: pureHome, path });
        } catch {
          return undefined;
        }
      },
      writeFile: async (path, content) => {
        await core.invoke('write_file', { workspace: pureHome, path, content });
      },
    },
    roles,
    records,
  );
  if (report.reverted.length > 0) {
    console.warn(`[pure] overlay guard reverted: ${report.reverted.join(', ')}（原文见 .reverted.md，设置页可恢复）`);
    host.notify?.(
      t('evolution.overlayReverted.toast', '已自动回退角色 overlay：{roles}——派发失败率较落盘基线显著恶化，装载回到前版/基础人格，可在设置的进化面板查看与恢复。')
        .replace('{roles}', report.reverted.join('、')),
      12_000,
    );
    document.dispatchEvent(new CustomEvent('pure:evolution-cycle'));
  }
}

/** 启动后台衰减定时器（幂等；main.ts deferred init 调用，注入出卡缝）。 */
export function startMemoryDecayTimer(options?: MemoryDecayTimerHost): void {
  if (started) return;
  started = true;
  host = options ?? {};
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
