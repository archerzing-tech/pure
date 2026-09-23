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

/** Turns per folded group. */
export const TRANSCRIPT_GROUP_TURNS = 10;
/** Newest turns that always stay as plain, ungrouped turns. */
export const TRANSCRIPT_RECENT_PLAIN_TURNS = 8;
/** A short session keeps every turn plain; folding only starts past this. */
export const TRANSCRIPT_GROUP_THRESHOLD = 50;

const DEFAULT_ROOT_MARGIN = '900px 0px';

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

  const scrollRoot = (): HTMLElement | null =>
    options.scrollRoot ?? document.getElementById('chat');
  const rootMargin = options.rootMargin ?? DEFAULT_ROOT_MARGIN;

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
      renderPromise = Promise.resolve(renderer()).then(() => {
        materialized = true;
      }).finally(() => {
        renderPromise = null;
        // Park again when the user collapsed the group, or when it finished
        // building after it had already been scrolled out of view.
        if (!details.open) park();
        else if (options.parkOffscreen && !inViewport) park();
      });
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
          mount();
          void renderNow();
        } else if (options.parkOffscreen && !renderPromise) {
          // Give the layout back while the group is off screen; the content is
          // still here and comes straight back on scroll.
          park();
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
      observer?.disconnect();
      observer = null;
    },
  };
}
