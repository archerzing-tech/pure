// src/ui/__tests__/resizeZones.test.ts
// 无边框窗口边缘热区的两条纪律(2026-11-09 / 11-10 Windows 卡死判例):
//   1. 纯点击 / 连点 / 手抖绝不进系统模态 sizing 循环——只有真的拖拽才算;
//   2. 命中方向必须一路带到 startResizeDragging,一次拖拽只发起一次。
// 策略走 setResizeAction 测试缝验证(不碰真窗口),Rust 侧的灭活调用顺带钉住。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import {
  computeResizeGeometry,
  exceedsResizeDragThreshold,
  RESIZE_DRAG_THRESHOLD_PX,
  RESIZE_MIN_HEIGHT,
  RESIZE_MIN_WIDTH,
  setNonModalResizeAction,
  setResizeAction,
  setupResizeZones,
  type ResizeDirection,
  type ResizeGeometry,
} from '../resizeZones';

let registeredHere = false;
beforeAll(() => {
  if (typeof document === 'undefined') {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterAll(() => {
  if (registeredHere) GlobalRegistrator.unregister();
});

// Rust 侧配套命令的调用记录(灭活原生热区):setup 每个窗口 boot 调一次。
let invokeCalls: string[] = [];
// 被策略放行的 resize 方向。
let resized: ResizeDirection[] = [];
// 非模态路径(Windows)按帧送来的几何。
let nonModalGeometries: ResizeGeometry[] = [];
// 预先断粮信号的轨迹(true=按下/false=收尾)。
let dragSignals: boolean[] = [];

beforeEach(() => {
  invokeCalls = [];
  resized = [];
  nonModalGeometries = [];
  dragSignals = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    // getCurrentWindow() 读 metadata.currentWindow.label,缺了整个 Window API 不可用。
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      // 未知命令拒绝自愈(bun mock 污染判例):绝不静默 resolve。
      if (cmd === 'disable_resize_hotzones') { invokeCalls.push(cmd); return Promise.resolve(); }
      if (cmd === 'plugin:window|is_maximized') return Promise.resolve(false);
      if (cmd === 'plugin:window|inner_size') return Promise.resolve({ width: 1200, height: 800 });
      if (cmd === 'plugin:window|outer_position') return Promise.resolve({ x: 100, y: 80 });
      if (cmd === 'plugin:window|scale_factor') return Promise.resolve(1);
      if (cmd === 'set_resize_drag_active') { dragSignals.push(Boolean(args?.active)); return Promise.resolve(); }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    },
  };
  setResizeAction((dir) => resized.push(dir));
  setNonModalResizeAction((g) => nonModalGeometries.push(g));
});

afterEach(() => {
  setResizeAction();
  setNonModalResizeAction();
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (navigator as unknown as Record<string, unknown>).platform; // 拆掉用例钉的平台
});

function zone(cls: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.rz-${cls}`);
  if (!el) throw new Error(`missing resize zone .rz-${cls}`);
  return el;
}

function down(el: HTMLElement, x: number, y: number): void {
  el.dispatchEvent(new window.MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, bubbles: true }));
}

function move(x: number, y: number, buttons = 1): void {
  window.dispatchEvent(new window.MouseEvent('mousemove', { clientX: x, clientY: y, buttons }));
}

function up(): void {
  window.dispatchEvent(new window.MouseEvent('mouseup', { button: 0, buttons: 0 }));
}

describe('exceedsResizeDragThreshold', () => {
  it('treats a still pointer as a click', () => {
    expect(exceedsResizeDragThreshold(100, 100, 100, 100)).toBe(false);
    // 抖动按像素取整后仍算点击:阈值内不进模态循环。
    expect(exceedsResizeDragThreshold(100, 100, 103, 100)).toBe(false);
    expect(exceedsResizeDragThreshold(100, 100, 100, 103)).toBe(false);
  });

  it('accepts any direction once the threshold is passed', () => {
    expect(exceedsResizeDragThreshold(100, 100, 104, 100)).toBe(true);
    expect(exceedsResizeDragThreshold(100, 100, 100, 96)).toBe(true);
    expect(exceedsResizeDragThreshold(100, 100, 95, 95)).toBe(true);
    expect(RESIZE_DRAG_THRESHOLD_PX).toBe(3);
    expect(exceedsResizeDragThreshold(0, 0, 10, 10, 20)).toBe(false);
  });
});

describe('computeResizeGeometry（Windows 非模态 resize）', () => {
  const start = { width: 1200, height: 800, x: 100, y: 80 };

  it('E/S 只改尺寸,左上角不动', () => {
    expect(computeResizeGeometry('East', 50, 0, start)).toEqual({ width: 1250, height: 800, x: 100, y: 80 });
    expect(computeResizeGeometry('South', 0, 40, start)).toEqual({ width: 1200, height: 840, x: 100, y: 80 });
  });

  it('W/N 反向改位置,钉住对边', () => {
    expect(computeResizeGeometry('West', -50, 0, start)).toEqual({ width: 1250, height: 800, x: 50, y: 80 });
    expect(computeResizeGeometry('North', 0, -40, start)).toEqual({ width: 1200, height: 840, x: 100, y: 40 });
  });

  it('四角同时改尺寸与位置', () => {
    expect(computeResizeGeometry('NorthWest', -50, -40, start)).toEqual({ width: 1250, height: 840, x: 50, y: 40 });
    expect(computeResizeGeometry('SouthEast', 50, 40, start)).toEqual({ width: 1250, height: 840, x: 100, y: 80 });
  });

  it('触到最小尺寸后夹住,位置按夹后的尺寸算,对边不漂移', () => {
    const east = computeResizeGeometry('East', -500, 0, start);
    expect(east.width).toBe(RESIZE_MIN_WIDTH);
    const west = computeResizeGeometry('West', 500, 0, start);
    expect(west.width).toBe(RESIZE_MIN_WIDTH);
    // 初始右边界 = 100 + 1200 = 1300;夹住后仍应是 1300。
    expect(west.x + west.width).toBe(1300);
    const north = computeResizeGeometry('North', 0, 900, start);
    expect(north.height).toBe(RESIZE_MIN_HEIGHT);
    expect(north.y + north.height).toBe(880);
  });

  it('最小尺寸与 tauri.conf.json 锁在一起', () => {
    const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    const win = conf.app.windows[0]; // Tauri v2 结构：窗口配置在 app.windows
    expect(RESIZE_MIN_WIDTH).toBe(win.minWidth);
    expect(RESIZE_MIN_HEIGHT).toBe(win.minHeight);
  });
});

describe('setupResizeZones', () => {
  it('boots once and asks Rust to kill the native hotzones', async () => {
    setupResizeZones();
    setupResizeZones(); // 幂等:同一次 boot 不重复建热区
    expect(document.querySelectorAll('.win-resize-zone').length).toBe(8);
    // 灭活调用走动态 import,给它一个真实 tick 落地。
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeCalls).toEqual(['disable_resize_hotzones']);
  });

  it('a plain click on the edge never starts a resize（2026-11-27 全平台非模态）', async () => {
    setupResizeZones();
    pdown(zone('n'), 500, 2);
    pup();
    await tick();
    expect(nonModalGeometries).toEqual([]);
    // 松手后残留的 move 也不许反过来触发 resize。
    pmove(500, 40);
    await tick();
    expect(nonModalGeometries).toEqual([]);
  });

  it('a click that only jitters inside the threshold stays a click', async () => {
    setupResizeZones();
    pdown(zone('n'), 500, 2);
    pmove(502, 3);
    await tick();
    expect(nonModalGeometries).toEqual([]);
  });

  it('a real drag drives the non-modal path (mac 无原生 resize 后的唯一路径)', async () => {
    setupResizeZones();
    pdown(zone('n'), 500, 2);
    await tick(); // 起始几何落地
    pmove(500, 40); // 越过阈值 → 逐帧几何
    await tick();
    expect(nonModalGeometries.length).toBeGreaterThan(0);
    // 上边缘向下拖 38px = 高度收 38、y 增 38（对边钉住）。
    expect(nonModalGeometries[0]).toEqual({ width: 1200, height: 762, x: 100, y: 118 });
    pup();
  });

  it('ignores moves that arrive after the button is already up', async () => {
    setupResizeZones();
    pdown(zone('w'), 2, 400);
    await tick();
    pmove(2, 430, 0); // 左键已抬(切窗/系统接管)
    pmove(2, 430); // 之后迟到的 move 也没人听了
    await tick();
    expect(nonModalGeometries).toEqual([]);
  });

  it('non-left buttons never arm a resize', async () => {
    setupResizeZones();
    zone('s').dispatchEvent(new window.PointerEvent('pointerdown', {
      button: 2, pointerId: 1, screenX: 400, screenY: 900, bubbles: true,
    }));
    pmove(400, 860);
    await tick();
    expect(nonModalGeometries).toEqual([]);
  });
});

// ---- Windows 非模态路径(pointerdown → 逐帧几何 → Rust SetWindowPos) ----
// 这条路径不再有任何模态循环入口;测试锁三件事:阈值内零动作、几何值正确、
// 松手/按钮抬起后彻底冻结。

function pinPlatform(value: string): void {
  Object.defineProperty(navigator, 'platform', { value, configurable: true });
}

function pdown(el: HTMLElement, x: number, y: number): void {
  el.dispatchEvent(new window.PointerEvent('pointerdown', {
    button: 0, pointerId: 1, screenX: x, screenY: y, clientX: x, clientY: y, bubbles: true,
  }));
}

function pmove(x: number, y: number, buttons = 1): void {
  window.dispatchEvent(new window.PointerEvent('pointermove', {
    pointerId: 1, screenX: x, screenY: y, buttons, bubbles: true,
  }));
}

function pup(): void {
  window.dispatchEvent(new window.PointerEvent('pointerup', { pointerId: 1, button: 0, buttons: 0 }));
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

describe('armNonModalResize（Windows 非模态路径）', () => {
  beforeAll(async () => {
    // 预热动态 import,让首个用例的计时只测异步 invoke 链,不测模块加载。
    await import('@tauri-apps/api/window');
    await import('@tauri-apps/api/core');
  });

  it('阈值内零动作;越阈值后按帧发几何,同帧合并,松手即冻结', async () => {
    pinPlatform('Win32');
    setupResizeZones();
    pdown(zone('se'), 1100, 20);
    await tick(); // 起始几何(3 次 IPC)落地;未动不发帧
    expect(nonModalGeometries).toEqual([]);

    pmove(1150, 70); // dx=50, dy=50 越阈值 → 首帧
    await tick();
    expect(nonModalGeometries).toEqual([{ width: 1250, height: 850, x: 100, y: 80 }]);

    pmove(1200, 120);
    pmove(1250, 170); // 同帧内两次 move 合成一次;之后按 15fps 节流,每 4 个 rAF 一拍
    await tick();
    await tick();
    await tick();
    await tick();
    expect(nonModalGeometries.length).toBe(2);
    expect(nonModalGeometries[1]).toEqual({ width: 1350, height: 950, x: 100, y: 80 });

    // 指针停住:节流链发现位移没变,断掉等下一个 move——按住不动零 invoke。
    await tick();
    await tick();
    await tick();
    await tick();
    expect(nonModalGeometries.length).toBe(2);

    pup();
    pmove(1300, 220); // 松手后的迟到 move 无效
    await tick();
    expect(nonModalGeometries.length).toBe(2);
    // 预先断粮信号:按下即 true,收尾即 false(不等几何 IPC 就绪)。
    expect(dragSignals[0]).toBe(true);
    expect(dragSignals[dragSignals.length - 1]).toBe(false);
  });

  it('W 边横向拖反向改位置,钉住右边界', async () => {
    pinPlatform('Win32');
    setupResizeZones();
    pdown(zone('w'), 2, 400);
    await tick();
    // W 边只吃水平分量(与原生 HTLEFT 一致),竖向拖不动它;dx=-50 → 左移 50 加宽 50,
    // 右边界钉在 100+1200=1300。
    pmove(-48, 400);
    await tick();
    expect(nonModalGeometries).toEqual([{ width: 1250, height: 800, x: 50, y: 80 }]);
    pup();
  });

  it('pointerup 丢失时 buttons=0 的 move 也收尾', async () => {
    pinPlatform('Win32');
    setupResizeZones();
    pdown(zone('e'), 1100, 20);
    await tick();
    pmove(1150, 20); // 发出首帧
    await tick();
    pmove(1200, 20, 0); // 左键已抬(系统接管/切窗)
    pmove(1250, 20); // 之后迟到的 move 没人听
    await tick();
    expect(nonModalGeometries.length).toBe(1);
  });
});
