// src/ui/resizeZones.ts
// 无边框窗口的自绘边缘 resize 热区(4 边 + 4 角)。
//
// 判例(2026-11-09 / 2026-11-10 Windows 真机卡死):系统给无边框窗口注入的
// 原生热区(tauri-runtime-wry 的 TAURI_DRAG_RESIZE_BORDERS 子窗,顶边答
// HTTOP)会把按下拖进 DefWindowProc 的模态 sizing 循环——输入全吞、光标变
// 上下双箭头,而 WebView2 独立进程照常渲染。Rust 侧已把该子窗隐藏并把顶层
// WM_NCHITTEST 一律答 HTCLIENT(hotzone.rs),原生热区不复存在;边缘 resize
// 改由这里接手:mousedown → startResizeDragging(方向),与原生热区走同一条
// WM_NCLBUTTONDOWN 消息链,零新增行为面。
//
// 但「按下即发」本身就是那条消息链的另一个入口:tao 的 begin_resize_drag 是
// PostMessageW(WM_NCLBUTTONDOWN, HT方向, 光标点),异步投递——连点时上一次
// 投递还没被分发,鼠标已经抬起,模态循环拿到的是一次「按着却再也等不到抬起」
// 的 sizing,窗口就此钉死在循环里(11-10 判例的忙碌态)。所以这里给按下加一道
// 闸:只有按下后指针真的位移超过阈值才进模态循环,纯点击/连点永远不进。
//
// 最大化时隐藏:resize 对最大化窗口无意义,且会白白挡住标题栏顶部 6px 的
// 拖拽——windowChrome 的 onResized 同步 body.window-maximized,CSS 直接吃。
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
 *  那几条都不该进系统模态 sizing 循环。 */
export const RESIZE_DRAG_THRESHOLD_PX = 3;

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

export function setupResizeZones(): void {
  if (!isTauriRuntime()) return;
  if (document.getElementById('resize-zones')) return;
  const host = document.createElement('div');
  host.id = 'resize-zones';
  for (const [dir, cls] of ZONES) {
    const zone = document.createElement('div');
    zone.className = `win-resize-zone rz-${cls}`;
    zone.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
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

/** 按下后再等「真正的位移」才发起 resize:纯点击不进模态循环(见文件头判例)。
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

/** 动态导入(模块缓存后零成本)+ 失败落日志:capabilities 漏授权时 resize
 * 会「按了没反应」,与窗口键同一条判例(2026-10-11),不静默。 */
async function resizeWith(dir: ResizeDirection): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startResizeDragging(dir);
  } catch (err) {
    console.warn('[resize-zones] startResizeDragging failed:', err);
  }
}
