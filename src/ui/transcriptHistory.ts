// src/ui/transcriptHistory.ts
// ONE folding model for the whole transcript.
//
// The transcript has two producers — the live session (turns stream into the
// DOM as they happen) and the disk restore (a snapshot is projected into
// blocks). They used to fold history with two separate implementations, two
// thresholds and two visual languages:
//   • live    — LiveTranscriptWindow parked every turn past the newest 8 into a
//               closed `live-turn-archive` <details> (the user had to click).
//   • restore — every 10 turns past the newest 8 went into a closed
//               `conversation-segment` <details> (the user also had to click).
// A reopened conversation therefore "lost" its history, and the same session
// changed its folding style depending on how you got there.
//
// This module is the single implementation both paths now share:
//   • Groups are EXPANDED by default — history is never hidden behind a click.
//   • The viewport drives materialization: a group builds its content the first
//     time it approaches the viewport, and (when the caller opts in) parks that
//     content again once the group is scrolled well out of view. Old turns stop
//     costing layout without disappearing.
//   • One class vocabulary in CSS (`.transcript-history-group`) and one summary
//     format for both producers.
//
// FLING POLICY (2026-10-19). mount/park are whole-group DOM detach/reattach and
// materialization is a whole-group markdown render — all priced per GROUP. The
// original wiring ("enter the 900px band → mount, leave it → park") had zero
// hysteresis, so one fast fling swept EVERY group boundary twice and each
// crossing performed full-subtree DOM surgery plus a whole-transcript relayout.
// Height changes move scroll positions, scroll moves flip intersections, and
// the storm feeds itself — on WKWebView this ends as a multi-second wedge and
// (after enough repetitions) a dead WebContent process: blank window, buttons
// unresponsive, while the Rust shell samples fully idle. The policy now:
//   • A scroll burst with a large per-event delta marks a FLING. Heavy group
//     work (mount/materialize) is deferred to the settle queue while a fling
//     is in motion; slow reading (small deltas) keeps instant mount, so the
//     900px look-ahead still fills before content reaches the screen.
//   • Parking waits out an idle window after the group leaves the band AND
//     requires the fling to have settled — the boundary can no longer
//     ping-pong park/mount faster than once per idle window.
//   • All renderer invocations run on ONE module-level chain — a restore
//     fling can no longer start N concurrent whole-group markdown renders.
//   • The settle queue flushes only groups STILL inside the band, so a fling
//     that blew past a group never materializes it point-blank, and no group
//     is left unmaterialized while its summary is on screen.

/** Turns per folded group. */
export const TRANSCRIPT_GROUP_TURNS = 10;
/** Newest turns that always stay as plain, ungrouped turns. */
export const TRANSCRIPT_RECENT_PLAIN_TURNS = 8;
/** A short session keeps every turn plain; folding only starts past this. */
export const TRANSCRIPT_GROUP_THRESHOLD = 50;

const DEFAULT_ROOT_MARGIN = '900px 0px';

// ── Fling detection + settle scheduling ────────────────────────────────────

/** A single scroll jump at least this large marks a fling (a wheel tick is
 *  tens of px; a trackpad fling coast moves hundreds per event). */
export const FLING_DELTA_PX = 240;
/** A fling stays "in motion" until the transcript has been quiet this long. */
export const FLING_SETTLE_MS = 160;
/** After leaving the band, a group stays mounted at least this long, and only
 *  parks once the fling has ALSO been quiet this long (hysteresis). */
export const PARK_IDLE_MS = 900;

let flingDeltaPx = FLING_DELTA_PX;
let flingSettleMs = FLING_SETTLE_MS;
let parkIdleMs = PARK_IDLE_MS;

/** Test seam: tighten the timings so bun tests don't sleep for seconds.
 *  Production never calls this. */
export function setTranscriptFlingTimings(opts: { flingDeltaPx?: number; flingSettleMs?: number; parkIdleMs?: number }): void {
  if (opts.flingDeltaPx !== undefined) flingDeltaPx = Math.max(1, opts.flingDeltaPx);
  if (opts.flingSettleMs !== undefined) flingSettleMs = Math.max(1, opts.flingSettleMs);
  if (opts.parkIdleMs !== undefined) parkIdleMs = Math.max(0, opts.parkIdleMs);
}

let lastFlingAt = 0;
const flingWiredRoots = new WeakSet<HTMLElement>();
const prevScrollTops = new WeakMap<HTMLElement, number>();

function observedRoot(options: HistoryGroupOptions): HTMLElement | null {
  if (options.scrollRoot) return options.scrollRoot;
  if (typeof document === 'undefined') return null;
  return document.getElementById('chat');
}

/** One passive scroll listener per observed root: large per-event deltas mark
 *  the fling clock. wireScrollPin-style dataset guard — the root is shared by
 *  every group's observer, the listener must install exactly once. */
function wireFlingClock(root: HTMLElement | null): void {
  if (!root || flingWiredRoots.has(root)) return;
  flingWiredRoots.add(root);
  prevScrollTops.set(root, root.scrollTop);
  root.addEventListener('scroll', () => {
    const prev = prevScrollTops.get(root) ?? root.scrollTop;
    if (Math.abs(root.scrollTop - prev) >= flingDeltaPx) lastFlingAt = Date.now();
    prevScrollTops.set(root, root.scrollTop);
  }, { passive: true });
}

const flingActive = (now = Date.now()): boolean => now - lastFlingAt < flingSettleMs;
const flingSettledFor = (ms: number, now = Date.now()): boolean => now - lastFlingAt >= ms;

interface PendingGroupWork {
  /** Runs only if the group is still inside the band (and not disconnected). */
  run: () => Promise<void> | void;
}
const settleQueue: PendingGroupWork[] = [];
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function flushSettleQueue(): void {
  const batch = settleQueue.splice(0, settleQueue.length);
  for (const work of batch) void Promise.resolve().then(work.run).catch(() => {});
}

function armSettleTimer(): void {
  if (settleTimer !== null) return;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (flingActive()) armSettleTimer();
    else flushSettleQueue();
  }, flingSettleMs);
}

/** Defer heavy group work until the fling settles; dropped silently if the
 *  group left the band before then (its observer re-fires on re-entry). */
function enqueueSettleWork(run: () => Promise<void> | void): void {
  settleQueue.push({ run });
  armSettleTimer();
}

// One chain for ALL whole-group renders (restore path): the observer batch
// delivers every newly-intersecting group in one callback — unchained, a fling
// started N concurrent whole-group markdown renders on the same JS thread.
let renderChain: Promise<void> = Promise.resolve();

export interface HistoryGroupSummaryParts {
  /** 1-based turn numbers, when the caller knows them. */
  startTurn?: number;
  endTurn?: number;
  turnCount: number;
  toolCalls?: number;
  artifacts?: number;
  /** First user request in the group — the reader's best clue about what it was. */
  preview?: string;
}

/**
 * The summary line both producers render: where the group sits in the
 * conversation, how much work it holds, and what it was about. A folded group
 * must never read as "empty history" — that was the original complaint.
 */
export function formatHistoryGroupSummary(parts: HistoryGroupSummaryParts): string {
  const head = parts.startTurn !== undefined && parts.endTurn !== undefined
    ? `第 ${parts.startTurn}–${parts.endTurn} 轮`
    : `第 ${parts.turnCount} 轮`;
  const line = [head, `共 ${parts.turnCount} 轮`];
  if (parts.toolCalls) line.push(`${parts.toolCalls} 次工具调用`);
  if (parts.artifacts) line.push(`${parts.artifacts} 个产物`);
  const preview = parts.preview?.trim().replace(/\s+/g, ' ').slice(0, 42) ?? '';
  line.push(preview || '历史内容');
  return line.join(' · ');
}

export interface HistoryGroupOptions {
  /** Scrolling container observed for visibility. Defaults to `#chat`. */
  scrollRoot?: HTMLElement | null;
  /** How far ahead of the viewport a group materializes. */
  rootMargin?: string;
  /**
   * Park the group's content again once it is scrolled out of view. Live
   * transcripts turn this on: their nodes already exist, so parking is the only
   * way to keep hundreds of old turns off the layout. Restores leave it off and
   * instead build on demand.
   */
  parkOffscreen?: boolean;
}

export interface HistoryGroupHandle {
  readonly el: HTMLDetailsElement;
  readonly summaryEl: HTMLElement;
  readonly body: HTMLElement;
  /** True once the lazy renderer has run (or content was adopted). */
  readonly materialized: boolean;
  setSummary(text: string): void;
  /** Register the content builder. Runs once, when the group first approaches
   *  the viewport (and immediately when IntersectionObserver is unavailable). */
  setLazyRenderer(render: () => Promise<void> | void): void;
  /** Materialize now (idempotent). */
  renderNow(): Promise<void>;
  /** Take ownership of already-built nodes as this group's content. */
  adopt(nodes: Node[]): void;
  contains(node: Node): boolean;
  /** Remove `node` from this group (body or parked) if it lives here. */
  detach(node: Node): boolean;
  park(): void;
  mount(): void;
  disconnect(): void;
}

export function createHistoryGroup(options: HistoryGroupOptions = {}): HistoryGroupHandle {
  const details = document.createElement('details');
  details.className = 'transcript-history-group';
  details.open = true;
  const summary = document.createElement('summary');
  summary.className = 'transcript-history-group-summary';
  const body = document.createElement('div');
  body.className = 'transcript-history-group-body';
  details.append(summary, body);

  const parked: Node[] = [];
  let renderer: (() => Promise<void> | void) | null = null;
  let renderPromise: Promise<void> | null = null;
  let materialized = false;
  let disconnected = false;
  // Whether the group currently intersects the scrolling viewport. The first
  // observer callback always reports this, so `true` must not be assumed
  // before it arrives.
  let inViewport = false;
  // Park hysteresis: leaving the band arms this timer; re-entering cancels it.
  // The timer only parks when the group is STILL out and the fling has settled.
  let parkTimer: ReturnType<typeof setTimeout> | null = null;

  const scrollRoot = (): HTMLElement | null =>
    options.scrollRoot ?? document.getElementById('chat');
  const rootMargin = options.rootMargin ?? DEFAULT_ROOT_MARGIN;
  if (typeof IntersectionObserver === 'function') {
    wireFlingClock(observedRoot(options));
  }

  const cancelParkTimer = (): void => {
    if (parkTimer !== null) {
      clearTimeout(parkTimer);
      parkTimer = null;
    }
  };
  const armParkTimer = (): void => {
    if (parkTimer !== null || disconnected) return;
    parkTimer = setTimeout(() => {
      parkTimer = null;
      if (disconnected || inViewport || renderPromise) return;
      if (!flingSettledFor(parkIdleMs)) {
        armParkTimer();
        return;
      }
      park();
    }, parkIdleMs);
  };

  const park = (): void => {
    while (body.firstChild) parked.push(body.removeChild(body.firstChild));
  };
  const mount = (): void => {
    while (parked.length > 0) body.appendChild(parked.shift()!);
  };

  const renderNow = async (): Promise<void> => {
    mount();
    if (materialized || disconnected) return;
    if (renderer && !renderPromise) {
      // The renderer BODY goes on the shared chain (not just the awaiting):
      // scheduling `run` outside the chain would start every batched group's
      // render on the same microtask queue — exactly the concurrent-storm
      // this chain exists to prevent. The chain itself swallows failures so
      // one bad group can't stall the ones queued behind it; `run` still
      // rejects for this group's own awaiters, as before.
      const run = renderChain.then(() => renderer!()).then(() => {
        materialized = true;
      });
      renderPromise = run.finally(() => {
        renderPromise = null;
        // Park again when the user collapsed the group, or when it finished
        // building after it had already been scrolled out of view.
        if (!details.open) park();
        else if (options.parkOffscreen && !inViewport) armParkTimer();
      });
      renderChain = run.then(() => {}, () => {});
    } else if (!renderer) {
      // No builder (content is adopted later) — nothing to materialize yet.
      return;
    }
    await renderPromise;
  };

  details.addEventListener('toggle', () => {
    if (details.open) void renderNow();
    else if (!renderPromise) park();
  });

  let observer: IntersectionObserver | null = null;
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        inViewport = entry.isIntersecting;
        if (entry.isIntersecting) {
          cancelParkTimer();
          if (flingActive()) {
            // Mid-fling: whole-group DOM surgery goes to the settle queue.
            enqueueSettleWork(() => {
              if (disconnected || !inViewport) return;
              mount();
              return renderNow();
            });
          } else {
            mount();
            void renderNow();
          }
        } else if (options.parkOffscreen) {
          // Don't park mid-fling — the boundary would ping-pong against the
          // mount side. The timer re-checks distance AND fling idleness.
          armParkTimer();
        }
      }
    }, { root: scrollRoot(), rootMargin });
    observer.observe(details);
  }

  return {
    el: details,
    summaryEl: summary,
    body,
    get materialized() { return materialized; },
    setSummary(text: string) { summary.textContent = text; },
    setLazyRenderer(render) {
      renderer = render;
      // Without IntersectionObserver (tests, older webviews) there is nothing
      // to wait for, so build right away. When one exists, the first callback
      // reports the initial visibility — including "already on screen" — so
      // the builder stays lazy until then.
      if (!observer) void renderNow();
    },
    renderNow,
    adopt(nodes) {
      for (const node of nodes) parked.push(node);
      mount();
      materialized = true;
    },
    contains(node) {
      return body.contains(node) || parked.includes(node);
    },
    detach(node) {
      const parkedIndex = parked.indexOf(node);
      if (parkedIndex >= 0) {
        parked.splice(parkedIndex, 1);
        return true;
      }
      if (node.parentNode === body) {
        body.removeChild(node);
        return true;
      }
      return false;
    },
    park,
    mount,
    disconnect() {
      disconnected = true;
      cancelParkTimer();
      observer?.disconnect();
      observer = null;
    },
  };
}
