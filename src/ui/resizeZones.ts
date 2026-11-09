// src/ui/resizeZones.ts
// 无边框窗口的自绘边缘 resize 热区(4 边 + 4 角)。
//
// 判例(2026-11-09 Windows 真机卡死):系统给带 shadow 的无边框窗口注入的
// 原生热区(tao WM_NCHITTEST 顶边 HTTOP)会把连点拖进模态 sizing 循环——
// 输入全吞、光标变上下双箭头,而 WebView2 独立进程照常渲染。Rust 侧已把
// WM_NCHITTEST 一律答 HTCLIENT(hotzone.rs),原生热区不复存在;边缘 resize
// 改由这里接手:mousedown → startResizeDragging(方向),与原生热区走同一条
// WM_NCLBUTTONDOWN 消息链,零新增行为面。顺带修掉一个既有缺陷:原生方案下
// Windows 其实只有顶边能 resize(shadow 分支只答 HTTOP),左右下从来没生效。
//
// 最大化时隐藏:resize 对最大化窗口无意义,且会白白挡住标题栏顶部 6px 的
// 拖拽——windowChrome 的 onResized 同步 body.window-maximized,CSS 直接吃。
import { isTauriRuntime } from '../shared/tauri';

type ResizeDirection = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest';

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
      void resizeWith(dir);
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
