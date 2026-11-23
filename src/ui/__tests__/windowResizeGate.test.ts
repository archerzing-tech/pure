// src/ui/__tests__/windowResizeGate.test.ts

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  WINDOW_RESIZE_SETTLE_MS,
  installWindowResizeGate,
  isWindowResizing,
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

const settle = () => new Promise((resolve) => setTimeout(resolve, WINDOW_RESIZE_SETTLE_MS + 60));

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

  it('one-shot listener unsubscribes after the first settle', async () => {
    let calls = 0;
    onWindowResizeSettledOnce(() => { calls += 1; });

    resizeHandler!();
    await settle();
    resizeHandler!();
    await settle();

    expect(calls).toBe(1);
  });
});
