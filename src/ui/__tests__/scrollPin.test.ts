// src/ui/__tests__/scrollPin.test.ts
// Regression coverage for the shared rAF-coalesced transcript auto-scroll
// (scrollPin.ts), used by BOTH live streaming (chat.ts) and session restore
// (main.ts). The pin policy is a pure function (no DOM); the coalescing tests
// use a minimal element stub so they stay dependency-free like the rest of
// the UI suite.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { wireScrollPin, setPinnedToBottom, scrollChatToBottomIfPinned, forceScrollToBottom, isNearBottom } from '../scrollPin';

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
