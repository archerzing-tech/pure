// src/ui/resizeZones.ts
// 无边框窗口的自绘边缘 resize 热区(4 边 + 4 角)。
//
// 判例(2026-11-09 / 11-10 Windows 真机卡死):系统给无边框窗口注入的
// 原生热区(tauri-runtime-wry 的 TAURI_DRAG_RESIZE_BORDERS 子窗,顶边答
// HTTOP)会把按下拖进 DefWindowProc 的模态 sizing 循环——输入全吞、光标变
// 上下双箭头,而 WebView2 独立进程照常渲染。Rust 侧已把该子窗隐藏并把顶层
// WM_NCHITTEST 一律答 HTCLIENT(hotzone.rs),原生热区不复存在。
//
// 2026-11-24 用户复验:4.10.6 在 Windows 上「回复中拖窗口 → 整个窗口连尺寸
// 都不再变化」——原来自绘热区接手后调用的 startResizeDragging,底层仍是
// tao 的 PostMessageW(WM_NCLBUTTONDOWN),只是换了个入口钻进同一条模态循环。
// 3px 阈值的 11-10 补丁只挡连点,真拖拽照样进循环。这次在 Windows 上彻底不
// 走那条消息:pointermove 里按帧算几何,调 Rust 命令直接 SetWindowPos。
// 非模态路径没有系统级的 mouseup 兜底,因此用 setPointerCapture 保证指针移出
// 窗口仍能跟住;松手/取消/失焦都收尾。macOS 没有这条循环,继续走原生路径,
// 避免把已经验证过的行为一起改掉。
//
// 最大化时隐藏:resize 对最大化窗口无意义,且会白白挡住标题栏顶部 6px 的
// 拖拽——windowChrome 的 onResized 同步 body.window-maximized,CSS 直接吃。
import { isWindowsPlatform } from '../shared/backgroundCommand';
import { isTauriRuntime } from '../shared/tauri';

export type ResizeDirection = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest';

/** 边在前、角在后:同级 z-index 下后插入者接住重叠处的按下,角优先于边。 */
const ZONES: ReadonlyArray<readonly [ResizeDirection, string]> = [
  ['North', 'n'],
  ['South', 's'],
  ['West', 'w'],
  ['East', 'e'],
  ['NorthWest', 'nw'],
  ['NorthEast', 'ne'],
  ['SouthWest', 'sw'],
  ['SouthEast', 'se'],
];

/** 按下到「算一次真拖拽」的位移阈值(px)。小于这个数只可能是点击/手抖/连点,
 *  那几条都不该启动 resize。 */
export const RESIZE_DRAG_THRESHOLD_PX = 3;

/** 必须与 tauri.conf.json 的 minWidth/minHeight 一致:tao 在 WM_GETMINMAXINFO
 *  里也会夹一次,前端按同一个值算位置才不会让 N/W 边在被夹住时漂移。 */
export const RESIZE_MIN_WIDTH = 1000;
export const RESIZE_MIN_HEIGHT = 600;

/** 拖帧节流:每 N 个 rAF 发一次 invoke(60fps 下 ≈15fps)。resize 不需要
 *  60fps,而每次 invoke 都在宿主主线程走一轮 SetWindowPos→put_Bounds 消息
 *  链——Windows 真机判例(2026-11-25):流式中这条链与渲染进程排队互撞会
 *  挂起整个应用(零 CPU 全员等待)。降帧=降撞链频率,拖拽跟手度不受影响。
 *  帧计数不用时钟:测试里 rAF 是手动 tick 的,时钟断言会抖。 */
export const RESIZE_SEND_EVERY_N_FRAMES = 4;

/** 纯判定:按下点与当前点的位移是否已构成一次拖拽(坐标同坐标系即可,client
 *  或 screen 都行,只用来算差值)。 */
export function exceedsResizeDragThreshold(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  threshold = RESIZE_DRAG_THRESHOLD_PX,
): boolean {
  return Math.abs(x1 - x0) > threshold || Math.abs(y1 - y0) > threshold;
}

/** 窗口几何,单位为 CSS/logical px。innerSize / outerPosition 都按 scaleFactor
 *  折算到这里,Rust 命令再用 LogicalSize/LogicalPosition 折回物理像素。 */
export interface ResizeGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
}

/** 非模态 resize 的几何:按拖拽方向改尺寸,N/W 边还要反向改位置以钉住对边。
 *  用 screen 坐标的累计位移而不是 client 坐标——窗口自己一移动,client 坐标
 *  就会跟着跳,反馈回来把位移抵消掉。 */
export function computeResizeGeometry(
  dir: ResizeDirection,
  dx: number,
  dy: number,
  start: ResizeGeometry,
  minWidth = RESIZE_MIN_WIDTH,
  minHeight = RESIZE_MIN_HEIGHT,
): ResizeGeometry {
  let { width, height, x, y } = start;
  if (dir.includes('East')) width = Math.max(minWidth, start.width + dx);
  if (dir.includes('West')) {
    width = Math.max(minWidth, start.width - dx);
    x = start.x + (start.width - width);
  }
  if (dir.includes('South')) height = Math.max(minHeight, start.height + dy);
  if (dir.includes('North')) {
    height = Math.max(minHeight, start.height - dy);
    y = start.y + (start.height - height);
  }
  return { width, height, x, y };
}

export function setupResizeZones(): void {
  if (!isTauriRuntime()) return;
  if (document.getElementById('resize-zones')) return;
  const host = document.createElement('div');
  host.id = 'resize-zones';
  for (const [dir, cls] of ZONES) {
    const zone = document.createElement('div');
    zone.className = `win-resize-zone rz-${cls}`;
    // Windows:非模态路径走 pointer 事件(setPointerCapture 要 pointerId)。
    zone.addEventListener('pointerdown', (ev) => {
      if (!isWindowsPlatform() || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      armNonModalResize(dir, ev, zone);
    });
    // 其他平台维持已验证过的原生路径。
    zone.addEventListener('mousedown', (ev) => {
      if (isWindowsPlatform() || ev.button !== 0) return;
      // 拦住气泡选择/拖拽区等一切下层语义:这 6px 属于窗口边缘。
      ev.preventDefault();
      ev.stopPropagation();
      armResizeOnDrag(dir, ev);
    });
    host.appendChild(zone);
  }
  document.body.appendChild(host);

  // Rust 侧配套:灭掉原生顶边热区(hotzone.rs)。失败必须落日志——漏授权或
  // 命令缺席时原生热区还在,卡死判例会原样复发,静默吞掉就成了无头案。
  void (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('disable_resize_hotzones');
    } catch (err) {
      console.warn('[resize-zones] disable_resize_hotzones failed:', err);
    }
  })();
}

/** resize 动作本体。测试缝见 setResizeAction:策略(何时进模态循环)必须能
 *  在无 Tauri 的 DOM 测试里验证。 */
let resizeAction: (dir: ResizeDirection) => void = (dir) => void resizeWith(dir);

/** 测试缝:替换真正的窗口 resize 动作(生产从不调用;传空复位)。 */
export function setResizeAction(action?: (dir: ResizeDirection) => void): void {
  resizeAction = action ?? ((dir) => void resizeWith(dir));
}

/** 非模态路径的动作缝:收的是算好的几何,不是方向。 */
let nonModalAction: (geometry: ResizeGeometry) => void = (g) => void invokeResize(g);

export function setNonModalResizeAction(action?: (geometry: ResizeGeometry) => void): void {
  nonModalAction = action ?? ((g) => void invokeResize(g));
}

/** 按下后再等「真正的位移」才发起 resize:纯点击不进任何 resize 路径。
 *  捕获阶段挂 window 监听:指针移出热区/窗口也照样跟得住;松手即拆,零残留。 */
function armResizeOnDrag(dir: ResizeDirection, down: MouseEvent): void {
  const x0 = down.clientX;
  const y0 = down.clientY;
  const cleanup = (): void => {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', cleanup, true);
  };
  const onMove = (mv: MouseEvent): void => {
    // 松手事件丢了(切窗/系统接管)也要拆:没有左键按着就没有 resize 可言。
    if ((mv.buttons & 1) === 0) {
      cleanup();
      return;
    }
    if (!exceedsResizeDragThreshold(x0, y0, mv.clientX, mv.clientY)) return;
    cleanup();
    resizeAction(dir);
  };
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', cleanup, true);
}

/** Windows:非模态 resize。没有原生 modal loop 替我们抓鼠标,所以自己抓 pointer,
 *  并按帧把几何送到 Rust;所有收尾路径都走 finish,绝不留悬挂监听。 */
function armNonModalResize(dir: ResizeDirection, down: PointerEvent, zone: HTMLElement): void {
  const x0 = down.screenX;
  const y0 = down.screenY;
  let active = true;
  let start: ResizeGeometry | null = null;
  let latestDx = 0;
  let latestDy = 0;
  let frame = 0;

  const finish = (): void => {
    if (!active) return;
    active = false;
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', finish, true);
    window.removeEventListener('pointercancel', finish, true);
    window.removeEventListener('blur', finish);
    zone.removeEventListener('lostpointercapture', finish);
    try {
      if (zone.hasPointerCapture?.(down.pointerId)) zone.releasePointerCapture(down.pointerId);
    } catch { /* 指针已失效:收尾不能因此抛错 */ }
  };

  // 首帧立即发(计数从 N-1 起步),之后每 N 帧一拍。lastSent* 兜住空转:指针
  // 停住时节流拍到的帧发现位移没变,断掉 rAF 链等下一个 move——否则按住不动
  // 也会每 N 帧白发一帧等值几何。finish 不重置——下一次 arm 是全新闭包。
  let framesSinceSend = RESIZE_SEND_EVERY_N_FRAMES - 1;
  let lastSentDx = Number.NaN;
  let lastSentDy = Number.NaN;
  const schedule = (): void => {
    if (frame || !start || !active) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!active || !start) return;
      framesSinceSend += 1;
      if (framesSinceSend < RESIZE_SEND_EVERY_N_FRAMES) {
        schedule(); // 未到节流拍:继续排帧
        return;
      }
      if (latestDx === lastSentDx && latestDy === lastSentDy) return; // 无新位移:断链等下一个 move
      framesSinceSend = 0;
      lastSentDx = latestDx;
      lastSentDy = latestDy;
      nonModalAction(computeResizeGeometry(dir, latestDx, latestDy, start));
    });
  };

  const onMove = (mv: PointerEvent): void => {
    if (!active) return;
    if ((mv.buttons & 1) === 0) { finish(); return; }
    if (!exceedsResizeDragThreshold(x0, y0, mv.screenX, mv.screenY)) return;
    latestDx = mv.screenX - x0;
    latestDy = mv.screenY - y0;
    schedule();
  };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', finish, true);
  window.addEventListener('pointercancel', finish, true);
  window.addEventListener('blur', finish);
  zone.addEventListener('lostpointercapture', finish);
  try { zone.setPointerCapture(down.pointerId); } catch { /* 捕获失败仍可用窗口级事件 */ }

  // 起始几何只在按下时取一次(三次只读 IPC)。最大化时直接放弃:那跟窗口壳一起
  // 缩放,逐帧 SetWindowPos 反而会破坏最大化态。
  void (async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      if (await win.isMaximized()) { finish(); return; }
      const [size, pos, factor] = await Promise.all([
        win.innerSize(), win.outerPosition(), win.scaleFactor(),
      ]);
      if (!active) return;
      start = {
        width: size.width / factor,
        height: size.height / factor,
        x: pos.x / factor,
        y: pos.y / factor,
      };
      // 不在这里 schedule:起始就绪即发会放出一帧等值几何(白付一次 IPC +
      // 一轮 resize 事件)。首个越阈值的 move 自会带 schedule 进来;拖拽过程
      // 中 move 是连续的,不缺这最后一脚。
    } catch (err) {
      console.warn('[resize-zones] non-modal resize init failed:', err);
      finish();
    }
  })();
}

/** 动态导入(模块缓存后零成本)+ 失败落日志:capabilities 漏授权时 resize
 * 会「按了没反应」,与窗口键同一条判例(2026-10-11),不静默。
 * 双保险:Windows 永不走这条路——它是模态 sizing 循环的入口。 */
async function resizeWith(dir: ResizeDirection): Promise<void> {
  if (isWindowsPlatform()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startResizeDragging(dir);
  } catch (err) {
    console.warn('[resize-zones] startResizeDragging failed:', err);
  }
}

/** 每帧一次 IPC,把一个完整的几何交给 Rust 一次落地。窗口侧不并发多个调用:
 *  rAF 已经把同一帧内的多次 pointermove 合成一次。 */
async function invokeResize(geometry: ResizeGeometry): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // 显式铺开字段：ResizeGeometry 没有索引签名，直接传会卡 InvokeArgs。
    await invoke('resize_window_nonmodal', {
      width: geometry.width,
      height: geometry.height,
      x: geometry.x,
      y: geometry.y,
    });
  } catch (err) {
    console.warn('[resize-zones] resize_window_nonmodal failed:', err);
  }
}
