// src/ui/windowResizeGate.ts
// 窗口缩放期的重活总闸（2026-11-23 真机「流式渲染中拖窗口卡死」）。
//
// 11-20 把每条 resize/RO 回调各自合帧到一帧一次，但拖动时仍有六条回调与流式
// 渲染在同一帧交替读写布局：每条都触发一次全转录强制布局，主线程被吃满，
// WKWebView 连 resize 都来不及提交帧。单条节流解决不了「同一帧叠加」。
// 这里提供全局的「正在拖动」事实：重活在拖动期间整段停掉，停手统一补一次。

/** 停手多久算缩放结束。比各处的局部 debounce 略长，确保最后一批 resize 已到齐。 */
export const WINDOW_RESIZE_SETTLE_MS = 220;

let resizing = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let installedOn: unknown = null;
const settledListeners = new Set<() => void>();

/** 供流式渲染闸等热点路径判定：拖动期间为真。 */
export function isWindowResizing(): boolean {
  return resizing;
}

/** 订阅「缩放结束」：停手后补一次被跳过的测量/滚动/写入。返回退订函数。 */
export function onWindowResizeSettled(cb: () => void): () => void {
  settledListeners.add(cb);
  return () => { settledListeners.delete(cb); };
}

/** 一次性版本：停手补一拍就退订，免得长会话里每次拖动都往集合里堆监听。 */
export function onWindowResizeSettledOnce(cb: () => void): void {
  const off = onWindowResizeSettled(() => {
    off();
    cb();
  });
}

/** 全程只装一个 window.resize 监听，避免再给拖动帧多加一条回调。 */
export function installWindowResizeGate(): void {
  if (typeof window === 'undefined' || installedOn === window) return;
  installedOn = window;
  resizing = false;
  if (settleTimer !== null) clearTimeout(settleTimer);
  window.addEventListener('resize', () => {
    resizing = true;
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      resizing = false;
      for (const cb of settledListeners) cb();
    }, WINDOW_RESIZE_SETTLE_MS);
  }, { passive: true });
}
