// src/ui/__tests__/scrollPin.test.ts
// Regression coverage for the shared rAF-coalesced transcript auto-scroll
// (scrollPin.ts), used by BOTH live streaming (chat.ts) and session restore
// (main.ts). The pin policy is a pure function (no DOM); the coalescing tests
// use a minimal element stub so they stay dependency-free like the rest of
// the UI suite.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { wireScrollPin, setPinnedToBottom, scrollChatToBottomIfPinned, forceScrollToBottom, isNearBottom, setScrollPinObservers, wireInnerFollowTail, followInnerTail, setFollowTailClock } from '../scrollPin';

// Deterministic rAF: collect callbacks and flush them on demand instead of
// depending on real animation frames.
const rafCallbacks: FrameRequestCallback[] = [];
const originalRaf = globalThis.requestAnimationFrame;

function flushRaf(): void {
  const pending = rafCallbacks.splice(0);
  for (const cb of pending) cb(performance.now());
}

beforeEach(() => {
  rafCallbacks.length = 0;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  };
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
});

// Minimal scrollable-element stub: no document / DOM required. scrollHeight is
// a FIXED constant (content size does not depend on scrollTop — a stub that
// derived it from scrollTop would feed back into itself: setting scrollTop to
// scrollHeight would grow scrollHeight again, so the target moved forever).
const SCROLL_HEIGHT = 900;
const CLIENT_HEIGHT = 600;

function makeChatEl() {
  let scrollTop = 0;
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const el = {
    dataset: {} as Record<string, string>,
    get scrollTop() { return scrollTop; },
    set scrollTop(v: number) { scrollTop = v; },
    get scrollHeight() { return SCROLL_HEIGHT; },
    get clientHeight() { return CLIENT_HEIGHT; },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    dispatchEvent(type: string) {
      for (const fn of listeners[type] ?? []) fn({});
    },
  };
  return { el, setTop: (v: number) => { scrollTop = v; } };
}

describe('isNearBottom (pure pin policy)', () => {
  it('treats positions within the threshold as near the bottom', () => {
    expect(isNearBottom(900, 261, 600)).toBe(true);   // 39px away = pinned
    expect(isNearBottom(900, 290, 600)).toBe(true);   // 10px away
    expect(isNearBottom(900, 300, 600)).toBe(true);   // exactly at bottom
  });

  it('treats positions far above the bottom as not pinned', () => {
    expect(isNearBottom(900, 200, 600)).toBe(false);  // 100px away
    expect(isNearBottom(900, 0, 600)).toBe(false);
    expect(isNearBottom(900, 260, 600)).toBe(false);  // exactly 40px = threshold edge
  });
});

describe('scrollPin auto-scroll', () => {
  it('coalesces multiple scroll requests into a single rAF frame', () => {
    const { el } = makeChatEl();
    wireScrollPin(el as unknown as HTMLElement);

    scrollChatToBottomIfPinned(el as unknown as HTMLElement);
    scrollChatToBottomIfPinned(el as unknown as HTMLElement);
    scrollChatToBottomIfPinned(el as unknown as HTMLElement);

    expect(rafCallbacks.length).toBe(1);
    flushRaf();
    // The helper assigns the element's full scrollHeight (900) — the actual
    // bottom for a 900px-tall transcript; the stub's scrollTop must reflect it.
    expect(el.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('does not schedule a frame when the user has scrolled away (unpinned)', () => {
    const { el, setTop } = makeChatEl();
    wireScrollPin(el as unknown as HTMLElement);
    setTop(200);
    el.dispatchEvent('scroll'); // far from bottom → unpinned

    scrollChatToBottomIfPinned(el as unknown as HTMLElement);
    expect(rafCallbacks.length).toBe(0);
  });

  it('user scroll near the bottom keeps the chat pinned to bottom', () => {
    const { el, setTop } = makeChatEl();
    wireScrollPin(el as unknown as HTMLElement);
    setTop(270); // 30px from the bottom (threshold is 40px) → still pinned
    el.dispatchEvent('scroll');

    scrollChatToBottomIfPinned(el as unknown as HTMLElement);
    flushRaf();
    expect(el.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('user scroll far from the bottom unpins and stops auto-scroll', () => {
    const { el, setTop } = makeChatEl();
    wireScrollPin(el as unknown as HTMLElement);
    setTop(100); // 200px from the bottom → unpinned
    el.dispatchEvent('scroll');

    scrollChatToBottomIfPinned(el as unknown as HTMLElement);
    expect(rafCallbacks.length).toBe(0);
  });

  it('a scroll event fired by OUR OWN write never unpins, even when content grew in between', () => {
    // Regression for the "chat suddenly stops scrolling while content streams"
    // bug: a programmatic `scrollTop = scrollHeight` write fires a 'scroll'
    // event. If content grows between the write and the event dispatch (a
    // throttled markdown pass / async diagram / restore loop), a naive handler
    // reads the stale scrollTop against the NEW scrollHeight → distance past
    // the threshold → wrongly unpins → auto-scroll dies for the session.
    let scrollHeight = 900;
    let scrollTop = 0;
    const listeners: Record<string, Array<(ev: unknown) => void>> = {};
    const el = {
      dataset: {} as Record<string, string>,
      get scrollTop() { return scrollTop; },
      set scrollTop(v: number) { scrollTop = v; },
      get scrollHeight() { return scrollHeight; },
      get clientHeight() { return 600; },
      addEventListener(type: string, fn: (ev: unknown) => void) {
        (listeners[type] ??= []).push(fn);
      },
      dispatchEvent(type: string) {
        for (const fn of listeners[type] ?? []) fn({});
      },
    };
    const chatEl = el as unknown as HTMLElement;

    wireScrollPin(chatEl);
    scrollTop = 850; // user is at the bottom (within the 40px threshold)
    el.dispatchEvent('scroll'); // → pinned

    // Content change schedules a coalesced scroll-to-bottom.
    scrollChatToBottomIfPinned(chatEl);
    flushRaf(); // the write lands at the bottom as of THIS moment (900)
    expect(scrollTop).toBe(900);

    // Async content growth lands AFTER the write but BEFORE the write's own
    // scroll event is handled — the exact race that used to unpin the chat.
    scrollHeight = 1200;
    el.dispatchEvent('scroll'); // the event the programmatic write fired

    // Still pinned: the next content change must scroll to the NEW bottom.
    scrollChatToBottomIfPinned(chatEl);
    flushRaf();
    expect(scrollTop).toBe(1200);
  });

  it('forceScrollToBottom re-pins and scrolls even after a scroll-away (new user turn)', () => {
    const { el, setTop } = makeChatEl();
    wireScrollPin(el as unknown as HTMLElement);
    setTop(100); // 200px from the bottom → unpinned
    el.dispatchEvent('scroll');

    // A fresh user message is explicit intent to continue at the bottom —
    // forceScrollToBottom must override the previous scroll-away.
    forceScrollToBottom(el as unknown as HTMLElement);
    expect(rafCallbacks.length).toBe(1);
    flushRaf();
    expect(el.scrollTop).toBe(SCROLL_HEIGHT);

    // The pin survived: a later content change keeps following the bottom
    // (the regression — after scrolling up, subsequent turns never scrolled).
    scrollChatToBottomIfPinned(el as unknown as HTMLElement);
    flushRaf();
    expect(el.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('wireScrollPin is idempotent and setPinnedToBottom re-pins explicitly', () => {
    const { el } = makeChatEl();
    wireScrollPin(el as unknown as HTMLElement);
    wireScrollPin(el as unknown as HTMLElement);

    setPinnedToBottom(el as unknown as HTMLElement, false);
    scrollChatToBottomIfPinned(el as unknown as HTMLElement);
    expect(rafCallbacks.length).toBe(0);

    // Explicit re-pin (the session-restore path forces this) restores scrolling.
    setPinnedToBottom(el as unknown as HTMLElement, true);
    scrollChatToBottomIfPinned(el as unknown as HTMLElement);
    flushRaf();
    expect(el.scrollTop).toBe(SCROLL_HEIGHT);
  });
});

describe('scrollPin observers (new-content-below hint)', () => {
  afterEach(() => {
    // The observers are module-level singletons — always clear them so no
    // other test picks up a stale callback.
    setScrollPinObservers({});
  });

  it('fires onUnpinnedNewContent when content arrives while the user scrolled away', () => {
    const { el } = makeChatEl();
    wireScrollPin(el as unknown as HTMLElement);
    setPinnedToBottom(el as unknown as HTMLElement, false);
    const calls: string[] = [];
    setScrollPinObservers({ onUnpinnedNewContent: () => calls.push('new') });

    scrollChatToBottomIfPinned(el as unknown as HTMLElement);
    expect(calls).toEqual(['new']);
    // No scroll is scheduled while unpinned — the UI hint replaces it.
    expect(rafCallbacks.length).toBe(0);
  });

  it('does not fire onUnpinnedNewContent while pinned (auto-scroll runs instead)', () => {
    const { el } = makeChatEl();
    wireScrollPin(el as unknown as HTMLElement);
    const calls: string[] = [];
    setScrollPinObservers({ onUnpinnedNewContent: () => calls.push('new') });

    scrollChatToBottomIfPinned(el as unknown as HTMLElement);
    flushRaf();
    expect(calls).toEqual([]);
  });

  it('fires onPinStateChange with the new pin state on a genuine user scroll', () => {
    const { el, setTop } = makeChatEl();
    wireScrollPin(el as unknown as HTMLElement);
    const pins: boolean[] = [];
    setScrollPinObservers({ onPinStateChange: (_el, p) => pins.push(p) });

    setTop(200); // scroll away from the bottom (100px > 40px threshold)
    el.dispatchEvent('scroll');
    expect(pins).toEqual([false]);

    setTop(300); // back at the bottom (0px away)
    el.dispatchEvent('scroll');
    expect(pins).toEqual([false, true]);
  });

  it('never fires onPinStateChange for programmatic self-scrolls', () => {
    const { el } = makeChatEl();
    wireScrollPin(el as unknown as HTMLElement);
    const pins: boolean[] = [];
    setScrollPinObservers({ onPinStateChange: (_el, p) => pins.push(p) });

    scrollChatToBottomIfPinned(el as unknown as HTMLElement);
    flushRaf(); // the self-scroll write leaves the marker for the scroll event
    el.dispatchEvent('scroll');
    expect(pins).toEqual([]);
  });
});

// 工具卡片内嵌滚动面的尾随（2026-09-27 子 agent 卡片自动滚到最新内容）：
// .tool-row-scroll 有自己的滚动条，策略与转写 pin 完全同构但互不相干——
// 卡片内部滚动绝不能碰 #chat 的「有新内容」pill 观察者。
describe('inner follow-tail (tool-card interior panels)', () => {
  it('follows the tail while pinned, coalescing bursts into one frame', () => {
    const { el } = makeChatEl();
    wireInnerFollowTail(el as unknown as HTMLElement);

    followInnerTail(el as unknown as HTMLElement);
    followInnerTail(el as unknown as HTMLElement);
    followInnerTail(el as unknown as HTMLElement);
    expect(rafCallbacks.length).toBe(1);
    flushRaf();
    expect(el.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('stops following once the user scrolled up inside the panel', () => {
    const { el, setTop } = makeChatEl();
    wireInnerFollowTail(el as unknown as HTMLElement);
    setTop(100); // 200px above the bottom — user is re-reading an earlier trace line
    el.dispatchEvent('scroll'); // → unpinned

    followInnerTail(el as unknown as HTMLElement);
    expect(rafCallbacks.length).toBe(0);
    expect(el.scrollTop).toBe(100);
  });

  it('resumes following when the user returns to the panel bottom', () => {
    const { el, setTop } = makeChatEl();
    wireInnerFollowTail(el as unknown as HTMLElement);
    setTop(100);
    el.dispatchEvent('scroll');
    followInnerTail(el as unknown as HTMLElement);
    expect(rafCallbacks.length).toBe(0);

    setTop(SCROLL_HEIGHT); // scrolled back down to the newest line → re-pinned
    el.dispatchEvent('scroll');
    followInnerTail(el as unknown as HTMLElement);
    flushRaf();
    expect(el.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('a scroll event fired by our own tail write never unpins, even when content grew in between', () => {
    let scrollHeight = 900;
    let scrollTop = 0;
    const listeners: Record<string, Array<(ev: unknown) => void>> = {};
    const el = {
      dataset: {} as Record<string, string>,
      get scrollTop() { return scrollTop; },
      set scrollTop(v: number) { scrollTop = v; },
      get scrollHeight() { return scrollHeight; },
      get clientHeight() { return 320; },
      addEventListener(type: string, fn: (ev: unknown) => void) {
        (listeners[type] ??= []).push(fn);
      },
      dispatchEvent(type: string) {
        for (const fn of listeners[type] ?? []) fn({});
      },
    };

    wireInnerFollowTail(el as unknown as HTMLElement);
    followInnerTail(el as unknown as HTMLElement);
    flushRaf();
    expect(scrollTop).toBe(900);

    // The write's own scroll event arrives AFTER an async content growth —
    // exactly the race that must not unpin the panel (same as the transcript).
    scrollHeight = 1200;
    el.dispatchEvent('scroll');

    followInnerTail(el as unknown as HTMLElement);
    flushRaf();
    expect(scrollTop).toBe(1200);
  });

  it('skips the write when the content fits the panel (no lingering self-write marker)', () => {
    // 300px of content in a 600px panel: nothing to scroll (a collapsed
    // <details> or a short Output reads the same — zero geometry).
    const listeners: Record<string, Array<(ev: unknown) => void>> = {};
    const fitEl = {
      dataset: {} as Record<string, string>,
      get scrollTop() { return 0; },
      set scrollTop(_v: number) { throw new Error('must not write scrollTop when content fits'); },
      get scrollHeight() { return 300; },
      get clientHeight() { return 600; },
      addEventListener(type: string, fn: (ev: unknown) => void) {
        (listeners[type] ??= []).push(fn);
      },
      dispatchEvent(type: string) {
        for (const fn of listeners[type] ?? []) fn({});
      },
    };
    wireInnerFollowTail(fitEl as unknown as HTMLElement);
    followInnerTail(fitEl as unknown as HTMLElement);
    flushRaf(); // no write, no crash — and no marker left behind

    // A later genuine user scroll (impossible here, but the event could still
    // fire from any cause) must not be swallowed by a stale marker.
    fitEl.dispatchEvent('scroll');
    followInnerTail(fitEl as unknown as HTMLElement);
    flushRaf();
  });

  it('never touches the #chat observers — an interior panel is not the transcript', () => {
    const { el, setTop } = makeChatEl();
    const pins: boolean[] = [];
    const news: string[] = [];
    setScrollPinObservers({ onPinStateChange: (_el, p) => pins.push(p), onUnpinnedNewContent: () => news.push('new') });
    wireInnerFollowTail(el as unknown as HTMLElement);

    setTop(100);
    el.dispatchEvent('scroll'); // a genuine user scroll INSIDE the card
    followInnerTail(el as unknown as HTMLElement);

    expect(pins).toEqual([]); // pill policy untouched by card scrolling
    expect(news).toEqual([]);
  });
});

// ── 流式面板不再把读者永远晾在旧位置（2026-09-28 用户反馈）──
// 旧策略要求「回到距底 40px 内」才续跟，但流式期间内容每几百毫秒涨一截，
// 那个窗口是移动靶——上翻一次就等于整个运行期再也看不到最新内容。现在
// 上翻是租约：宽限窗（3s）内尊重回读，空闲超窗自动把面板交还给尾随。

class ManualClock {
  nowMs = 1_000_000;
  timers: Array<{ fn: () => void; at: number; cancelled: boolean }> = [];
  now = (): number => this.nowMs;
  schedule = (fn: () => void, ms: number): (() => void) => {
    const t = { fn, at: this.nowMs + ms, cancelled: false };
    this.timers.push(t);
    return () => { t.cancelled = true; };
  };
  advance(ms: number): void {
    this.nowMs += ms;
    for (const t of this.timers) {
      if (!t.cancelled && t.at <= this.nowMs) {
        t.cancelled = true;
        t.fn();
      }
    }
  }
}

describe('inner follow-tail idle resume (streaming panels never strand the reader)', () => {
  const originalRaf = globalThis.requestAnimationFrame;
  beforeEach(() => {
    rafCallbacks.length = 0;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    setFollowTailClock();
  });

  it('hands the tail back after the grace window — the user never has to return to the bottom', () => {
    const clock = new ManualClock();
    setFollowTailClock(clock);
    const { el, setTop } = makeChatEl();
    wireInnerFollowTail(el as unknown as HTMLElement);

    setTop(100);
    el.dispatchEvent('scroll'); // unpinned — the user re-reads an earlier line
    followInnerTail(el as unknown as HTMLElement); // an append lands immediately
    expect(rafCallbacks.length).toBe(0); // inside the grace window: no yank

    clock.advance(2_000);
    followInnerTail(el as unknown as HTMLElement);
    expect(rafCallbacks.length).toBe(0); // still inside 3s — the armed deadline stands

    clock.advance(1_100); // past 3s idle — the armed resume fires, panel re-pins
    followInnerTail(el as unknown as HTMLElement);
    expect(rafCallbacks.length).toBe(1); // the tail owns the panel again
    flushRaf();
    expect(el.scrollTop).toBe(SCROLL_HEIGHT); // newest line in view, no manual scroll needed
  });

  it('a fresh user scroll re-arms the resume — a stale deadline must not fire early', () => {
    const clock = new ManualClock();
    setFollowTailClock(clock);
    const { el, setTop } = makeChatEl();
    wireInnerFollowTail(el as unknown as HTMLElement);

    setTop(100);
    el.dispatchEvent('scroll'); // t0
    followInnerTail(el as unknown as HTMLElement); // arms resume for t0+3s

    clock.advance(2_000);
    setTop(140);
    el.dispatchEvent('scroll'); // still reading at t0+2s → cancels the armed timer
    followInnerTail(el as unknown as HTMLElement); // re-arms for t0+5s

    clock.advance(1_500); // t0+3.5s — the OLD deadline would have fired here
    followInnerTail(el as unknown as HTMLElement);
    expect(rafCallbacks.length).toBe(0); // the pause stands (a stale timer would have yanked)

    clock.advance(1_600); // t0+5.1s — the re-armed deadline
    followInnerTail(el as unknown as HTMLElement);
    expect(rafCallbacks.length).toBe(1);
    flushRaf();
    expect(el.scrollTop).toBe(SCROLL_HEIGHT);
  });
});

// ── 底部无效写不留幽灵标记 ──
// 面板已在底部时，尾随写赋值被 clamp 到当前值（浏览器不为此发 scroll 事件）；
// 旧代码仍会预设 self-write 标记——标记无人消费，把用户下一次真实滚动吞掉
// （上翻被静默吃掉，下一次追加又把人拽回底部）。修法：写前后比对，没动就
// 不留标记。真实 DOM 的 clamp 用这个桩模拟。

function makeClampingEl(maxScrollTop: number) {
  const CLIENT_H = 300;
  let scrollTop = maxScrollTop; // born at the bottom, like a tailing panel
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const el = {
    dataset: {} as Record<string, string>,
    get scrollTop() { return scrollTop; },
    set scrollTop(v: number) { scrollTop = Math.max(0, Math.min(v, maxScrollTop)); },
    get scrollHeight() { return maxScrollTop + CLIENT_H; },
    get clientHeight() { return CLIENT_H; },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    dispatchEvent(type: string) {
      for (const fn of listeners[type] ?? []) fn({});
    },
  };
  return { el, setTop: (v: number) => { scrollTop = v; } };
}

describe('no-op bottom writes leave no self-write marker', () => {
  it('inner panel: the user s scroll-away right after a bottom write still unpins', () => {
    const { el, setTop } = makeClampingEl(600);
    wireInnerFollowTail(el as unknown as HTMLElement);
    followInnerTail(el as unknown as HTMLElement);
    flushRaf();
    expect(el.scrollTop).toBe(600); // the write clamped to the current value — no move, no marker

    setTop(100);
    el.dispatchEvent('scroll'); // genuine user scroll — must NOT be swallowed
    followInnerTail(el as unknown as HTMLElement);
    expect(rafCallbacks.length).toBe(0); // unpin respected (a stale marker would yank to bottom)
    expect(el.scrollTop).toBe(100);
  });

  it('transcript: the same write leaves the pin verdict to the user s scroll', () => {
    const { el, setTop } = makeClampingEl(600);
    wireScrollPin(el as unknown as HTMLElement);
    const pins: boolean[] = [];
    setScrollPinObservers({ onPinStateChange: (_el, p) => pins.push(p) });
    scrollChatToBottomIfPinned(el as unknown as HTMLElement);
    flushRaf();

    setTop(100);
    el.dispatchEvent('scroll');
    expect(pins).toEqual([false]); // a stale marker would have eaten this event
    setScrollPinObservers({});
  });
});
