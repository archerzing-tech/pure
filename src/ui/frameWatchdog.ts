// src/ui/frameWatchdog.ts
// 帧停摆探针（2026-11-21 画面冻结判例）。
//
// 背景：真机上出现过「DOM 一直在更新、屏幕停在旧帧」的冻结——进程全活、
// CPU 0、窗口 resize 生效，AX 读到的新内容比画面多。事后无法区分「遮挡
// 暂停/页面整体停」与「合成层不再提交帧」，只能靠猜。这里补一组最低成本
// 的现场取证：每 2s 统计 rAF 次数与 DOM 变更次数；页面可见且窗口聚焦时
// rAF 连续为 0，就落一行 frame_stall（mut>0 = DOM 活着、只是不出帧；
// mut=0 = 页面整体停）。恢复时落 frame_resume，形成「停了多久」的闭环。
//
// 刻意不做自动重载：GUI 的引擎与转录都住在渲染进程里，重载等于杀掉进行中
// 的回合；探针只记录，不替用户做破坏性决定。
//
// 埋点永远不能成为新的性能问题：MutationObserver 只计数不保留记录，
// 写盘走 gui_perf_log 的低频通道，失败静默。

import { loadTauriCore } from '../shared/tauri';

const TICK_MS = 2_000;
/** 帧停自愈阈值：rAF 连续停超过这个时长且从没 nudge 过，就发一次原生
 *  frame nudge（强制 WKWebView 重布局重绘制）。 */
export const FRAME_NUDGE_AFTER_MS = 12_000;
/** 两次 nudge 的最小间隔。 */
export const FRAME_NUDGE_EVERY_MS = 15_000;
/** 连续 nudge 到这个次数仍 stall，判定自愈无效，落升级信号（该重启了）。 */
export const FRAME_NUDGE_MAX = 3;

/** nudge 决策（纯函数，测试缝）：帧停够久、且距上次 nudge 超过节流窗。
 *  不看 mut：mut>0 且 frames=0（更新了却不画）恰是最强的呈现断链信号。 */
export function shouldNudge(
  deltaFrames: number,
  stalledMs: number,
  msSinceLastNudge: number,
): boolean {
  return deltaFrames === 0 && stalledMs >= FRAME_NUDGE_AFTER_MS && msSinceLastNudge >= FRAME_NUDGE_EVERY_MS;
}

export function startFrameWatchdog(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  let frames = 0;
  let mutations = 0;
  let lastFrames = -1;
  let stalledSince = 0;
  let announced = false;
  let lastNudgeAt = 0;
  let nudgeCount = 0;

  const raf = (): void => {
    frames += 1;
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);

  const observer = new MutationObserver((records) => {
    mutations += records.length;
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });

  setInterval(() => {
    const visible = document.visibilityState === 'visible';
    const focused = document.hasFocus();
    const deltaFrames = lastFrames < 0 ? 0 : frames - lastFrames;
    lastFrames = frames;
    const deltaMut = mutations;
    mutations = 0;

    if (deltaFrames === 0 && visible && focused) {
      if (stalledSince === 0) stalledSince = Date.now();
      const stalledMs = Date.now() - stalledSince;
      if (!announced && stalledMs >= TICK_MS) {
        announced = true;
        void logLine({ kind: 'frame_stall', stalledMs, mut: deltaMut });
      }
      // 呈现冻结自愈（2026-11-26 真机判例：occlusion 补丁缺位时窗口被覆盖
      // 后停帧 368s 不恢复，四进程全活全空闲——帧不呈现但事件链活着）。
      // nudge 是禁用补丁（occlusion 重试）缺位时的兜底唤醒；连发无效则落
      // 升级信号——剩下的路只有重启。
      if (shouldNudge(deltaFrames, stalledMs, lastNudgeAt === 0 ? Number.MAX_SAFE_INTEGER : Date.now() - lastNudgeAt)) {
        lastNudgeAt = Date.now();
        nudgeCount += 1;
        void logLine({ kind: 'frame_nudge', stalledMs, nudge: nudgeCount });
        void (async () => {
          try {
            const core = await loadTauriCore();
            const ok = (await core?.invoke('webview_frame_nudge')) === true;
            if (!ok && nudgeCount >= FRAME_NUDGE_MAX) {
              void logLine({ kind: 'frame_nudge_exhausted', stalledMs: Date.now() - stalledSince });
            }
          } catch { /* 尽力而为 */ }
        })();
      }
      return;
    }
    if (stalledSince !== 0) {
      void logLine({ kind: 'frame_resume', stalledMs: Date.now() - stalledSince, frames: deltaFrames, mut: deltaMut });
      stalledSince = 0;
      announced = false;
      nudgeCount = 0;
      lastNudgeAt = 0;
    }
  }, TICK_MS);
}

async function logLine(payload: Record<string, unknown>): Promise<void> {
  try {
    const core = await loadTauriCore();
    if (core) await core.invoke('gui_perf_log', { lines: [JSON.stringify({ ts: Date.now(), ...payload })] });
  } catch {
    // 埋点尽力而为：命令不可用/写盘失败都不影响页面。
  }
}
