// src/ui/__tests__/frameWatchdogNudge.test.ts
// 呈现冻结自愈的决策缝（2026-11-26 真机判例）：nudge 的触发/节流/上限。

import { describe, expect, it } from 'bun:test';
import {
  FRAME_NUDGE_AFTER_MS,
  FRAME_NUDGE_EVERY_MS,
  FRAME_NUDGE_MAX,
  shouldNudge,
} from '../frameWatchdog';

describe('shouldNudge（呈现冻结自愈决策）', () => {
  it('fires when frames stalled past threshold, never nudged', () => {
    expect(shouldNudge(0, FRAME_NUDGE_AFTER_MS + 1, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('does not fire while frames are still coming', () => {
    expect(shouldNudge(5, FRAME_NUDGE_AFTER_MS + 1, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('does not fire before the threshold', () => {
    expect(shouldNudge(0, FRAME_NUDGE_AFTER_MS - 1, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('respects the throttle window between nudges', () => {
    expect(shouldNudge(0, FRAME_NUDGE_AFTER_MS + 5_000, FRAME_NUDGE_EVERY_MS - 1_000)).toBe(false);
    expect(shouldNudge(0, FRAME_NUDGE_AFTER_MS + 20_000, FRAME_NUDGE_EVERY_MS + 1_000)).toBe(true);
  });

  it('mut > 0 with frames = 0 still nudges（更新了却不画 = 最强断链信号）', () => {
    // mut 不参与判定（由调用方传 deltaFrames），此处锁语义：决策只看帧。
    expect(shouldNudge(0, FRAME_NUDGE_AFTER_MS * 3, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('exhausted limit is 3', () => {
    expect(FRAME_NUDGE_MAX).toBe(3);
  });
});
