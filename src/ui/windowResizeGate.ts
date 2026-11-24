// src/ui/windowResizeGate.ts
// 窗口缩放期的重活总闸（2026-11-23 真机「流式渲染中拖窗口卡死」）。
//
// 11-20 把每条 resize/RO 回调各自合帧到一帧一次，但拖动时仍有六条回调与流式
// 渲染在同一帧交替读写布局：每条都触发一次全转录强制布局，主线程被吃满，
// WKWebView 连 resize 都来不及提交帧。单条节流解决不了「同一帧叠加」。
// 这里提供全局的「正在拖动」事实：重活在拖动期间整段停掉，停手统一补一次。
//
// 双通道（2026-11-24 真机取证）：真机拖动里 DOM `resize` 只到 1–4 条——原生
// sizing 循环期间 WebKit 把 resize 事件压掉了，不是每帧一条。Tauri 的 onResized
// 在同一台机器上给出的条数与 DOM 通道完全相同，所以它不是「更细的那条」，保留
// 它只为兜住 DOM 事件被整段吞掉的情形（Windows 的模态 sizing 判例即此类）。
// 闸门不靠事件密度工作：从第一条到最后一条之间 resizing 恒为真，最后一条之后
// 再等一个 settle，整段拖动都被盖住。两个通道的条数分别记进取证行，下次卡死能
// 直接看出哪条在发事件、有没有一条都没发。
//
// 取证：每次拖动结束落一行 resize_gate（多少条 resize、持续多久、有没有热点
// 真的来问过闸）。卡死再来时这行能区分「闸没装上/没被问过」（= 重活照跑）
// 与「闸生效了但仍然卡」（= 另有成本源），否则又只剩一句用户口述。低频且只在
// 真有热点问过时落，不构成噪声。

/** 停手多久算缩放结束。比各处的局部 debounce 略长，确保最后一批 resize 已到齐。 */
export const WINDOW_RESIZE_SETTLE_MS = 220;

let resizing = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let lastResizeAt = 0;
let installedOn: unknown = null;
const settledListeners = new Set<() => void>();

// 取证计数：只在拖动窗口内累积，settle 时归零。
let domResizes = 0;
let nativeResizes = 0;
let dragStartedAt = 0;
let consultedDuringDrag = false;

/** 供流式渲染闸等热点路径判定：拖动期间为真。 */
export function isWindowResizing(): boolean {
  // 有人来问 = 这条路径确实被闸住过。探针必须记在「问」上而不是「拦」上：
  // 各调用点自己决定停什么，这里不该知道有哪些调用点。
  if (resizing) consultedDuringDrag = true;
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

/** 拖动中的一拍。dom=true 表示来自 DOM resize，false 表示来自原生 onResized。 */
export function noteWindowResize(dom: boolean): void {
  const now = Date.now();
  if (!resizing) dragStartedAt = now;
  resizing = true;
  lastResizeAt = now;
  if (dom) domResizes += 1;
  else nativeResizes += 1;
  // 不每拍 clearTimeout+setTimeout（60Hz 下就是每秒 60 次定时器churn）：
  // 只保证有一个在飞，醒来时不够就按剩余时间续。
  if (settleTimer === null) settleTimer = setTimeout(onSettleTick, WINDOW_RESIZE_SETTLE_MS);
}

function onSettleTick(): void {
  const remain = WINDOW_RESIZE_SETTLE_MS - (Date.now() - lastResizeAt);
  if (remain > 0) {
    settleTimer = setTimeout(onSettleTick, remain);
    return;
  }
  settleTimer = null;
  resizing = false;
  // 先记取证（同步归零），再放补活：补的那一拍如果自己又改了窗口，新一轮
  // 拖动会重新计数，不会被这次归零吃掉。
  const shouldLog = consultedDuringDrag;
  const dom = domResizes;
  const native = nativeResizes;
  const heldMs = Math.round(Date.now() - dragStartedAt);
  domResizes = 0;
  nativeResizes = 0;
  dragStartedAt = 0;
  consultedDuringDrag = false;
  if (shouldLog) void logDragSample(dom, native, heldMs);
  for (const cb of settledListeners) cb();
}

async function logDragSample(dom: number, native: number, heldMs: number): Promise<void> {
  const line = JSON.stringify({
    ts: Date.now(),
    kind: 'resize_gate',
    dom,
    native,
    heldMs,
    consulted: true,
  });
  try {
    const { loadTauriCore } = await import('../shared/tauri');
    const core = await loadTauriCore();
    if (core) await core.invoke('gui_perf_log', { lines: [line] });
  } catch {
    // 埋点失败静默：取证不能成为新的失败面。
  }
}

/** 全程只装一次：DOM resize + 原生 onResized 双通道，避免给拖动帧多加回调。 */
export function installWindowResizeGate(): void {
  if (typeof window === 'undefined' || installedOn === window) return;
  installedOn = window;
  resizing = false;
  if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
  window.addEventListener('resize', () => noteWindowResize(true), { passive: true });
  void (async () => {
    try {
      const { isTauriRuntime } = await import('../shared/tauri');
      if (!isTauriRuntime()) return;
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      // 回调只记一拍事实：不读布局、不发 IPC，成本是两次整数自增。
      await getCurrentWindow().onResized(() => noteWindowResize(false));
    } catch {
      // 窗口 API 不可用（浏览器预览/老注入缺失）：DOM resize 通道仍在。
    }
  })();
}
