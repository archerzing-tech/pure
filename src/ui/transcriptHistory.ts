// src/ui/transcriptHistory.ts
// ONE folding model for the whole transcript.
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
// This module is the single implementation both paths now share:
//   • Groups are EXPANDED by default — history is never hidden behind a click.
//   • The viewport drives materialization: a group builds its content the first
//     time it approaches the viewport, and (when the caller opts in) parks that
//     content again once the group is scrolled well out of view. Old turns stop
//     costing layout without disappearing.
//   • One class vocabulary in CSS (`.transcript-history-group`) and one summary
//     format for both producers.
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

import { isWindowResizing, onWindowResizeSettledOnce } from './windowResizeGate';

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
/** Starvation cap: a queued group mounts after waiting this long even while
 *  the fling is still in motion. Without the cap a CONTINUOUS fling — every
 *  scroll event a fresh ≥240px jump, never quiet for FLING_SETTLE_MS — keeps
 *  the settle timer re-arming forever, and groups sitting in the visible
 *  viewport stay empty (summary-only) for as long as the user keeps flinging.
 *  That was the "甩动后历史内容一片空白" regression: the 2026-10-19 fling
 *  gate traded correctness for smoothness with no lower bound on latency. */
export const FLING_MAX_WAIT_MS = 300;

let flingDeltaPx = FLING_DELTA_PX;
let flingSettleMs = FLING_SETTLE_MS;
let parkIdleMs = PARK_IDLE_MS;
let flingMaxWaitMs = FLING_MAX_WAIT_MS;

/** Test seam: tighten the timings so bun tests don't sleep for seconds.
 *  Production never calls this. */
export function setTranscriptFlingTimings(opts: { flingDeltaPx?: number; flingSettleMs?: number; parkIdleMs?: number; flingMaxWaitMs?: number }): void {
  if (opts.flingDeltaPx !== undefined) flingDeltaPx = Math.max(1, opts.flingDeltaPx);
  if (opts.flingSettleMs !== undefined) flingSettleMs = Math.max(1, opts.flingSettleMs);
  if (opts.parkIdleMs !== undefined) parkIdleMs = Math.max(0, opts.parkIdleMs);
  if (opts.flingMaxWaitMs !== undefined) flingMaxWaitMs = Math.max(1, opts.flingMaxWaitMs);
}

let lastFlingAt = 0;
const flingWiredRoots = new WeakSet<HTMLElement>();
const prevScrollTops = new WeakMap<HTMLElement, number>();
/** 滚轮连发窗口判据：窗口内累计位移达到此值即视为 fling（滚轮单档只有
 *  ~100-120px，够不到触屏惯性的单事件阈值）。 */
const WHEEL_BURST_WINDOW_MS = 200;
const WHEEL_BURST_PX = 360;
let wheelBurstSince = 0;
let wheelBurstPx = 0;

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
  // 快速滚轮连发也判 fling（2026-11-19 用户判例「快速滚动鼠标翻动卡死」）：
  // 滚轮每档只有 ~100-120px，到不了触屏惯性调的单事件阈值（240px）——快速
  // 连滚时 fling 抑制从不生效，每个组边界都即时全量挂载=卡死。补窗口累计
  // 判据：200ms 内累计 ≥360px 同样标记 fling。慢速阅读（偶尔一格）不触发。
  root.addEventListener('scroll', () => {
    const now = Date.now();
    const prev = prevScrollTops.get(root) ?? root.scrollTop;
    const delta = Math.abs(root.scrollTop - prev);
    if (delta >= flingDeltaPx) lastFlingAt = now;
    if (now - wheelBurstSince > WHEEL_BURST_WINDOW_MS) {
      wheelBurstSince = now;
      wheelBurstPx = 0;
    }
    wheelBurstPx += delta;
    if (wheelBurstPx >= WHEEL_BURST_PX) lastFlingAt = now;
    prevScrollTops.set(root, root.scrollTop);
  }, { passive: true });
}

const flingActive = (now = Date.now()): boolean => now - lastFlingAt < flingSettleMs;
const flingSettledFor = (ms: number, now = Date.now()): boolean => now - lastFlingAt >= ms;

// 泊车占位的宽度失效（2026-11-20 卡顿 P0）：park() 记下的 min-height 是旧
// 宽度量的像素值；拖窗口/开关侧栏改宽度后，窄了占位偏矮（滚动条缩、钉底被
// 拽走），宽了留大段空白。停手后把泊车组逐个「临时挂载→量高→再泊回」，
// 一帧一个，避免一次长任务。只认宽度变化，纯高度变化不动占位。
export const PARK_REMEASURE_SETTLE_MS = 200;
interface ParkedRemeasure {
  alive: () => boolean;
  isParked: () => boolean;
  remeasure: () => void;
}
const parkedGroups = new Set<ParkedRemeasure>();
let widthRemeasureTimer: ReturnType<typeof setTimeout> | null = null;
let widthRemeasureQueue: ParkedRemeasure[] = [];
let widthRemeasureFrame = 0;

const pumpWidthRemeasure = (): void => {
  if (widthRemeasureFrame) return;
  if (typeof requestAnimationFrame !== 'function') {
    while (widthRemeasureQueue.length > 0) widthRemeasureQueue.shift()!.remeasure();
    return;
  }
  widthRemeasureFrame = requestAnimationFrame(() => {
    widthRemeasureFrame = 0;
    widthRemeasureQueue.shift()?.remeasure();
    if (widthRemeasureQueue.length > 0) pumpWidthRemeasure();
  });
};

const scheduleWidthRemeasure = (): void => {
  if (widthRemeasureTimer !== null) clearTimeout(widthRemeasureTimer);
  widthRemeasureTimer = setTimeout(() => {
    widthRemeasureTimer = null;
    const groups = [...parkedGroups];
    // 直播窗口 reset() 只清组数组不逐个 disconnect：顺手把脱离文档的尸体
    // 从集合里摘掉，否则长会话反复切换会让这张表无界增长。
    for (const group of groups) if (!group.alive()) parkedGroups.delete(group);
    widthRemeasureQueue = groups.filter((group) => group.isParked());
    if (isWindowResizing()) {
      // 泊车组逐个「挂载→量高→泊回」每帧一次全转录布局，叠在拖动的
      // resize 帧上正是卡顿放大器；停手后补一次即可，宽度只有最终值有意义。
      onWindowResizeSettledOnce(() => pumpWidthRemeasure());
      return;
    }
    pumpWidthRemeasure();
  }, PARK_REMEASURE_SETTLE_MS);
};

let widthWatchInstalled = false;
function installWidthWatch(): void {
  if (widthWatchInstalled || typeof window === 'undefined') return;
  widthWatchInstalled = true;
  // 两条口子：窗口拖动（window resize）与侧栏开合（#chat 自身宽度变化）。
  let lastInnerWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastInnerWidth) return;
    lastInnerWidth = window.innerWidth;
    scheduleWidthRemeasure();
  }, { passive: true });
  if (typeof document !== 'undefined' && typeof ResizeObserver === 'function') {
    const chat = document.getElementById('chat');
    if (chat) {
      let lastChatWidth = chat.clientWidth;
      new ResizeObserver(() => {
        const width = chat.clientWidth;
        if (width === lastChatWidth) return;
        lastChatWidth = width;
        scheduleWidthRemeasure();
      }).observe(chat);
    }
  }
}

interface PendingGroupWork {
  /** Runs only if the group is still inside the band (and not disconnected). */
  run: () => Promise<void> | void;
  /** When the work was queued — the starvation clock for FLING_MAX_WAIT_MS. */
  enqueuedAt: number;
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
    const now = Date.now();
    if (flingActive(now)) {
      // Still mid-fling. Deferral is bounded: work older than the starvation
      // cap flushes anyway — one bounded batch per settle tick beats a blank
      // viewport for as long as the user's hand keeps the fling alive.
      const aged = settleQueue.some(work => now - work.enqueuedAt >= flingMaxWaitMs);
      if (aged) flushSettleQueue();
      else armSettleTimer();
    } else {
      flushSettleQueue();
    }
  }, flingSettleMs);
}

/** Defer heavy group work until the fling settles — or until the starvation
 *  cap; dropped silently if the group left the band before then (its observer
 *  re-fires on re-entry). */
function enqueueSettleWork(run: () => Promise<void> | void): void {
  settleQueue.push({ run, enqueuedAt: Date.now() });
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
   * Park the group's content again once it is scrolled out of view. Both
   * producers turn this on: live transcripts need it because their nodes
   * already exist, and restores need it because their viewport sweep
   * materializes every group while the page is still short — without parking,
   * a reopened giant session keeps its whole history mounted (the 2026-11-14
   * mac WebContent freeze).
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
  /** 泊车开关（2026-11-19 直播折叠判例）：流式回合中泊车/重挂载循环会踩
   *  WKWebView「已画行向上滚回变空白」的已知疾病（#chat 注释同族），直播
   *  侧折叠组在回合落定前保持挂载、落定后交还 IO 泊车。 */
  setParkOffscreen(v: boolean): void;
}

export function createHistoryGroup(options: HistoryGroupOptions = {}): HistoryGroupHandle {
  // 泊车开关可变（2026-11-19 直播折叠判例）：流式回合落定前禁泊车，落定后
  // 交还 IO——见 HistoryGroupHandle.setParkOffscreen 注释。
  let parkOffscreen = options.parkOffscreen === true;
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

  // 分级虚拟化的最后一块（2026-11-19 用户提案）：泊车不塌高度。泊车卸内容
  // 后组体塌成一行摘要，滚动几何大幅摆动——快速 fling 时摆幅峰值就是合成器
  // 卡死的触发面。泊车前把实测内容高记到 body 的 min-height 占位（滚动几何
  // 稳定），挂载时清除。卸载的行不画、占位撑高度——绕开 WKWebView
  // content-visibility 的空白行疾病（不引入该属性）。
  const park = (): void => {
    if (!body.style.minHeight) {
      const h = body.getBoundingClientRect().height;
      if (h > 1) body.style.minHeight = `${Math.round(h)}px`;
    }
    while (body.firstChild) parked.push(body.removeChild(body.firstChild));
  };
  const mount = (): void => {
    body.style.minHeight = '';
    while (parked.length > 0) body.appendChild(parked.shift()!);
  };

  const parkedRemeasure: ParkedRemeasure = {
    alive: () => !disconnected && details.isConnected,
    isParked: () => !disconnected && details.isConnected && details.open && parked.length > 0 && body.firstChild === null,
    remeasure: () => {
      // 排队到执行之间可能被 IO 挂回；再判一次，别把正在看的组又泊掉。
      if (!parkedRemeasure.isParked()) return;
      mount();
      park(); // park 会在清空后的 min-height 上写入新宽度量到的高度
    },
  };
  parkedGroups.add(parkedRemeasure);
  installWidthWatch();

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
        else if (parkOffscreen && !inViewport) armParkTimer();
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
        } else if (parkOffscreen) {
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
    setParkOffscreen(v) {
      parkOffscreen = v;
      if (!parkOffscreen) {
        // 禁泊车 = 直播流需要内容保持挂载：撤掉待泊定时器，若已泊则先挂回。
        cancelParkTimer();
        if (!details.open) mount();
      }
    },
    disconnect() {
      disconnected = true;
      cancelParkTimer();
      parkedGroups.delete(parkedRemeasure);
      observer?.disconnect();
      observer = null;
    },
  };
}
