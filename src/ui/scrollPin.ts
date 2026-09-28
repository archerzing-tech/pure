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
    if (isPinnedToBottom(el) && el.scrollHeight > el.clientHeight) {
      // Mark the self-write ONLY when the browser will actually fire a scroll
      // event for it. Assigning an out-of-range scrollTop clamps silently, and
      // at the bottom the clamp lands on the CURRENT value (target = full
      // scrollHeight, real max = scrollHeight − clientHeight) — a pre-set
      // marker for a no-op write would linger unconsumed and swallow the
      // user's next GENUINE scroll: their scroll-away would be eaten and the
      // transcript would yank them back down on the next append. (Content
      // that fits the viewport skips the write entirely — scrollTop is
      // clamped to 0 and nothing needs consuming.)
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      if (el.scrollTop !== before) {
        selfScrollWrites.set(el, true);
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

// ── Interior follow-tail (tool cards: 子 agent 委派卡、流式命令面板) ──
// A tool card's Output panel (.tool-row-scroll) owns its OWN scrollbar. While
// a sub-agent streams its interior trace (or a command streams its log), new
// lines land below the fold every few hundred ms — the panel follows the tail
// on its own so the newest line stays in view without the user chasing it.
// Same pin policy as the transcript, scoped to the card: the moment the user
// scrolls up inside the panel to re-read an earlier trace line, following
// stops; it resumes when they scroll back to the bottom. Deliberately a
// SEPARATE wiring from wireScrollPin, and with NO observers: a card's scroll
// events must never reach the #chat affordances — the「有新内容」pill is a
// transcript signal, and an interior panel is not the transcript.

export function wireInnerFollowTail(el: HTMLElement): void {
  if (el.dataset.innerFollowWired === '1') return;
  el.dataset.innerFollowWired = '1';
  el.addEventListener('scroll', () => {
    // Same self-write swallow as the transcript pin: the scroll event our own
    // tail-follow fired is not user intent (see selfScrollWrites above).
    if (selfScrollWrites.get(el)) {
      selfScrollWrites.delete(el);
      return;
    }
    // A genuine user scroll both starts the idle clock and cancels any armed
    // auto-resume: while the hand is still on the wheel, the pause stands.
    // (Same clock as followInnerTail reads — the injectable test clock must
    // see one timeline, not a real-now vs fake-now mismatch.)
    lastUserScrollAt.set(el, followTailClock.now());
    const armed = resumeTimers.get(el);
    if (armed !== undefined) {
      armed();
      resumeTimers.delete(el);
    }
    setPinnedToBottom(el, isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight));
  }, { passive: true });
}

// ── Streaming panels must not strand the reader above the fold ──
// While a panel's content is still streaming, a user who scrolled up once used
// to stay unpinned FOREVER: re-reaching the exact bottom is a moving target
// when lines land every few hundred ms (the 40px re-pin zone grows away about
// as fast as a wheel tick approaches it), so the panel never found the newest
// content again for the rest of the run. Instead, the scroll-away pause is a
// LEASE: the tail auto-resumes once the user's last manual scroll has been
// idle past the grace window — a glance back at an earlier line is respected,
// then the newest line wins again. Finished panels never append, so they never
// arm a timer and keep the plain manual pin policy (read in peace).
export const FOLLOW_TAIL_IDLE_RESUME_MS = 3_000;

const lastUserScrollAt = new WeakMap<HTMLElement, number>();
const resumeTimers = new WeakMap<HTMLElement, () => void>();

// Injectable clock for the bun suite (deterministic "now" and timers, no real
// event-loop wait). Production never calls the setter.
export interface FollowTailClock {
  now(): number;
  schedule(fn: () => void, ms: number): () => void;
}

let followTailClock: FollowTailClock = {
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

/** Test seam: replace the idle clock/timer backend; call with no argument to
 *  restore the production clock. */
export function setFollowTailClock(clock?: FollowTailClock): void {
  followTailClock = clock ?? {
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  };
}

export function followInnerTail(el: HTMLElement): void {
  if (!isPinnedToBottom(el)) {
    // Unpinned by a user scroll. While the panel keeps streaming, that pause
    // expires: once the last manual scroll has been idle past the grace
    // window, hand the panel back to the tail (the NEXT append follows; this
    // call never scrolls mid-read). Active scrolling keeps refreshing
    // lastUserScrollAt via the wiring above, so reading stays yank-free.
    const idleFor = followTailClock.now() - (lastUserScrollAt.get(el) ?? 0);
    if (idleFor < FOLLOW_TAIL_IDLE_RESUME_MS) {
      if (resumeTimers.has(el)) return; // already armed — the deadline stands
      resumeTimers.set(el, followTailClock.schedule(() => {
        resumeTimers.delete(el);
        if (!isPinnedToBottom(el)) setPinnedToBottom(el, true);
      }, FOLLOW_TAIL_IDLE_RESUME_MS - idleFor));
      return;
    }
    setPinnedToBottom(el, true);
  }
  if (scrollFrames.has(el)) return;
  if (typeof requestAnimationFrame !== 'function') return;
  scrollFrames.set(el, requestAnimationFrame(() => {
    scrollFrames.delete(el);
    if (!isPinnedToBottom(el)) return;
    if (el.scrollHeight <= el.clientHeight) return; // nothing to scroll — no write, no marker
    // Same write-only-if-it-moves rule as scrollChatToBottomIfPinned: a no-op
    // bottom write must not leave a marker that swallows the user's next
    // genuine scroll.
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    if (el.scrollTop !== before) {
      selfScrollWrites.set(el, true);
    }
  }));
}
