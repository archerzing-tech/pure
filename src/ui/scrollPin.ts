// src/ui/scrollPin.ts
// Shared transcript auto-scroll for BOTH live streaming (chat.ts) and session
// restore (main.ts). All scroll-to-bottom writes go through ONE rAF-coalesced
// path so a burst of content changes (tokens, streamed command lines, reasoning
// deltas, restored bubbles) never triggers a forced layout per event.
//
// Pinned = the user hasn't manually scrolled away from the bottom. While
// pinned, every content change scrolls to the absolute bottom; once the user
// scrolls up, auto-scroll stops until they return to the bottom.

const pinnedStates = new WeakMap<HTMLElement, boolean>();

function isPinnedToBottom(el: HTMLElement): boolean {
  return pinnedStates.get(el) ?? true;
}

export function setPinnedToBottom(el: HTMLElement, v: boolean): void {
  pinnedStates.set(el, v);
}

// rAF-coalesced auto-scroll frames: tokens / streamed command lines / reasoning
// deltas can arrive many times per frame. Each direct scrollTop write reads
// scrollHeight (a forced layout on the WHOLE transcript — all bubbles, code
// blocks, SVGs), so per-event scrolling is the classic long-transcript stutter.
// One rAF-scheduled scroll per frame caps the cost at the display refresh rate.
const scrollFrames = new WeakMap<HTMLElement, number>();

// Wire once per element: a user scroll away from the bottom unpins; a return
// to the bottom (or a programmatic scroll-to-bottom while pinned) re-pins.
// Pure distance check: within `NEAR_BOTTOM_PX` of the bottom counts as pinned.
// Split out so the policy is unit-testable without a DOM.
export function isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number, nearBottomPx = 40): boolean {
  return scrollHeight - scrollTop - clientHeight < nearBottomPx;
}

export function wireScrollPin(el: HTMLElement): void {
  if (el.dataset.scrollPinWired === '1') return;
  el.dataset.scrollPinWired = '1';
  const NEAR_BOTTOM_PX = 40;
  el.addEventListener('scroll', () => {
    setPinnedToBottom(el, isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight, NEAR_BOTTOM_PX));
  }, { passive: true });
}

export function scrollChatToBottomIfPinned(el: HTMLElement): void {
  if (!isPinnedToBottom(el)) return;
  if (scrollFrames.has(el)) return;
  scrollFrames.set(el, requestAnimationFrame(() => {
    scrollFrames.delete(el);
    if (isPinnedToBottom(el)) el.scrollTop = el.scrollHeight;
  }));
}
