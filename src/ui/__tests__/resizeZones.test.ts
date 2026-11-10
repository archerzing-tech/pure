// src/ui/__tests__/resizeZones.test.ts
// 无边框窗口边缘热区的两条纪律(2026-11-09 / 11-10 Windows 卡死判例):
//   1. 纯点击 / 连点 / 手抖绝不进系统模态 sizing 循环——只有真的拖拽才算;
//   2. 命中方向必须一路带到 startResizeDragging,一次拖拽只发起一次。
// 策略走 setResizeAction 测试缝验证(不碰真窗口),Rust 侧的灭活调用顺带钉住。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import {
  exceedsResizeDragThreshold,
  RESIZE_DRAG_THRESHOLD_PX,
  setResizeAction,
  setupResizeZones,
  type ResizeDirection,
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

beforeEach(() => {
  invokeCalls = [];
  resized = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (cmd: string) => {
      invokeCalls.push(cmd);
      return Promise.resolve();
    },
  };
  setResizeAction((dir) => resized.push(dir));
});

afterEach(() => {
  setResizeAction();
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
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

  it('a plain click on the top edge never enters the sizing loop', () => {
    setupResizeZones();
    down(zone('n'), 500, 2);
    up();
    expect(resized).toEqual([]);
    // 松手后残留的 move 也不许反过来触发 resize。
    move(500, 40);
    expect(resized).toEqual([]);
  });

  it('a click that only jitters inside the threshold stays a click', () => {
    setupResizeZones();
    down(zone('n'), 500, 2);
    move(502, 3);
    up();
    expect(resized).toEqual([]);
  });

  it('a real drag starts one resize with the pressed direction', () => {
    setupResizeZones();
    down(zone('ne'), 900, 2);
    move(902, 2); // 仍在阈值内
    expect(resized).toEqual([]);
    move(910, 2); // 越过阈值 → 发起
    expect(resized).toEqual(['NorthEast']);
    move(960, 2); // 已发起,不再重复
    expect(resized).toEqual(['NorthEast']);
  });

  it('ignores moves that arrive after the button is already up', () => {
    setupResizeZones();
    down(zone('w'), 2, 400);
    move(2, 430, 0); // 左键已抬(切窗/系统接管)
    expect(resized).toEqual([]);
    move(2, 430); // 之后迟到的 move 也没人听了
    expect(resized).toEqual([]);
  });

  it('non-left buttons never arm a resize', () => {
    setupResizeZones();
    zone('s').dispatchEvent(new window.MouseEvent('mousedown', { button: 2, clientX: 400, clientY: 900, bubbles: true }));
    move(400, 860);
    expect(resized).toEqual([]);
  });
});
