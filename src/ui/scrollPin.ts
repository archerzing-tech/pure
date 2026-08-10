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

// Observers bridge scrollPin's policy to UI affordances (the "new content
// below" pill in chat.ts). Module-level singletons: exactly one chat view
// exists, and the wiring is registered once per transcript (idempotent).
export interface ScrollPinObservers {
  /** New content arrived while the user has scrolled away from the bottom
   *  (auto-scroll was skipped) — the UI shows its "there is more below" hint. */
  onUnpinnedNewContent?: (el: HTMLElement) => void;
  /** A GENUINE user scroll produced this pin state — the UI hides the hint
   *  when the user returns to the bottom. Programmatic self-scrolls never
   *  fire this (the selfScrollWrites marker swallows their events). */
  onPinStateChange?: (el: HTMLElement, pinned: boolean) => void;
}

let scrollPinObservers: ScrollPinObservers = {};

/** (Re)register the scroll-pin observers (pass {} to clear). */
export function setScrollPinObservers(obs: ScrollPinObservers): void {
  scrollPinObservers = obs;
}

// A programmatic `scrollTop = scrollHeight` write ALSO fires a 'scroll' event.
// If the content grows in the window between the write and the event dispatch
// (a 100ms-throttled markdown pass, an async diagram render, or the session-
// restore loop appending more bubbles), the handler below would read the STALE
// scrollTop against the NEW scrollHeight — a distance beyond the threshold —
// and wrongly flip the pin to false. Auto-scroll then silently stops for the
// rest of the session even though the user never scrolled away ("the chat
// suddenly stopped scrolling while content kept streaming"). Track our own
// writes so the handler skips re-evaluating them; only a genuine user scroll
// can unpin.
const selfScrollWrites = new WeakMap<HTMLElement, boolean>();

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
    // The scroll event fired by OUR OWN scroll-to-bottom write is not user
    // intent — re-evaluating it there is exactly what misreads a transient
    // content-growth race as a scroll-away (see selfScrollWrites above).
    // Consume the marker and leave the pin untouched.
    if (selfScrollWrites.get(el)) {
      selfScrollWrites.delete(el);
      return;
    }
    const pinned = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight, NEAR_BOTTOM_PX);
    setPinnedToBottom(el, pinned);
    scrollPinObservers.onPinStateChange?.(el, pinned);
  }, { passive: true });
}

export function scrollChatToBottomIfPinned(el: HTMLElement): void {
  if (!isPinnedToBottom(el)) {
    // New content arrived while the user is reading history — the UI shows
    // its "new content below" affordance instead of hijacking the scroll.
    scrollPinObservers.onUnpinnedNewContent?.(el);
    return;
  }
  if (scrollFrames.has(el)) return;
  scrollFrames.set(el, requestAnimationFrame(() => {
    scrollFrames.delete(el);
    if (isPinnedToBottom(el)) {
      const target = el.scrollHeight;
      // Skip the write (and the flag) when already at the bottom, or when the
      // content fits the viewport (scrollHeight ≤ clientHeight — scrollTop is
      // clamped to 0, so no scroll event would fire and the marker would
      // linger, silently swallowing a later genuine user-scroll event):
      // nothing needs consuming in either case.
      if (el.scrollHeight > el.clientHeight && el.scrollTop !== target) {
        selfScrollWrites.set(el, true);
        el.scrollTop = target;
      }
    }
  }));
}

/**
 * Force the transcript back to pinned and scroll to the bottom — the explicit
 * "continue at the bottom" intent (a new user message, a session restore).
 * Overrides a previous scroll-away: scrolling up to re-read history is a
 * per-session preference, but a FRESH user turn always resumes following the
 * newest content — otherwise the chat would stay frozen above the new reply
 * for the rest of the session.
 */
export function forceScrollToBottom(el: HTMLElement): void {
  setPinnedToBottom(el, true);
  scrollChatToBottomIfPinned(el);
}
