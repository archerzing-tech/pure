// src/ui/__tests__/windowResizeGate.test.ts

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  WINDOW_RESIZE_SETTLE_MS,
  installWindowResizeGate,
  isWindowResizing,
  noteWindowResize,
  onWindowResizeSettled,
  onWindowResizeSettledOnce,
} from '../windowResizeGate';

const originalWindow = globalThis.window;
let resizeHandler: (() => void) | null = null;

beforeEach(() => {
  resizeHandler = null;
  (globalThis as { window?: unknown }).window = {
    addEventListener: (_type: string, fn: () => void) => { resizeHandler = fn; },
  };
  installWindowResizeGate();
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, WINDOW_RESIZE_SETTLE_MS + 80));

describe('windowResizeGate', () => {
  it('marks dragging active and fires settled once after the last resize event', async () => {
    const seen: string[] = [];
    const off = onWindowResizeSettled(() => seen.push('settled'));

    resizeHandler!();
    expect(isWindowResizing()).toBe(true);
    resizeHandler!(); // 连续拖动帧只续期，不重复通知

    await settle();
    expect(isWindowResizing()).toBe(false);
    expect(seen).toEqual(['settled']);
    off();
  });

  it('native onResized feeds the same gate as the DOM resize event', async () => {
    // 真人拖动里 DOM resize 常被压到 1–4 条，原生通道才是按帧的那条。
    noteWindowResize(false);
    expect(isWindowResizing()).toBe(true);
    await settle();
    expect(isWindowResizing()).toBe(false);
  });

  it('a resize arriving mid-settle extends the drag instead of settling early', async () => {
    noteWindowResize(false);
    await new Promise((resolve) => setTimeout(resolve, WINDOW_RESIZE_SETTLE_MS - 60));
    noteWindowResize(true); // 拖动还在继续
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(isWindowResizing()).toBe(true);
    await settle();
    expect(isWindowResizing()).toBe(false);
  });

  it('one-shot listener unsubscribes after the first settle', async () => {
    let calls = 0;
    onWindowResizeSettledOnce(() => { calls += 1; });

    noteWindowResize(false);
    await settle();
    noteWindowResize(false);
    await settle();

    expect(calls).toBe(1);
  });
});
