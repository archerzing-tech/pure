// src/ui/thinkingCard.ts
// Live "thinking" trace for the chat transcript. It is expanded by default so
// the reasoning stream is visible live, and the native details control lets the
// user collapse and reopen it. Completed thinking remains in the transcript so
// it can be reviewed after the assistant answer or a tool call appears.
//
// Shared structure with toolRow.ts: `.bubble-row` wrapper + `<details>`, so
// live streaming (chat.ts) and any future replay render identically.

import { t } from '../shared/i18n';

/** Collapse verbatim-repeated reasoning blocks into one occurrence.
 * Reasoning models occasionally loop internally and emit the same sentence or
 * paragraph over and over ("I'll call sys_info() now:" × 4). Detect the shortest
 * period that reproduces the whole block sequence and keep only one period, so
 * the user sees a clean thought trace instead of a stuck loop. Only collapses
 * EXACT repetitions — varied reasoning is left untouched. */
export function collapseRepeatedReasoning(text: string): string {
  if (!text) return text;
  const blocks = text
    .split(/\n\s*\n/)
    .map(b => b.trim())
    .filter(b => b.length > 0);
  if (blocks.length < 3) return text;
  for (let period = 1; period <= Math.floor(blocks.length / 2); period++) {
    let periodic = true;
    for (let i = period; i < blocks.length; i++) {
      if (blocks[i] !== blocks[i % period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) {
      return blocks.slice(0, period).join('\n\n');
    }
  }
  return text;
}

export function appendStoredThinking(text: string, parent: HTMLElement): void {
  const handle = createThinkingCard();
  handle.card.classList.remove('thinking');
  handle.card.classList.add('complete');
  handle.card.querySelector('.thinking-dots')?.remove();
  handle.textEl.textContent = collapseRepeatedReasoning(text);
  parent.appendChild(handle.el);
}

export interface ThinkingCardHandle {
  el: HTMLElement;              // .bubble-row.thinking-row
  card: HTMLDetailsElement;     // .thinking-card
  body: HTMLElement;            // .thinking-body (non-scrolling; owns the padding)
  scrollEl: HTMLElement;        // .thinking-scroll (max-height scroll window)
  textEl: HTMLElement;          // .thinking-text (reasoning content)
}

// Honest live label for pre-flight phases (workspace probe, clarifying
// interview, task analysis, first-token wait). chat.ts sets the label the
// moment a REAL phase starts, so the card states what is actually happening
// instead of pretending. The first streamed reasoning token then replaces the
// waiting text with real content. There is deliberately no fake "what I'm
// doing" rotation: cycling claims of work that isn't happening reads as
// theater, and the animated dots already keep the card alive while waiting.
export function setThinkingLabel(handle: ThinkingCardHandle, text: string): void {
  const label = handle.card.querySelector<HTMLElement>('.thinking-label');
  if (!label) return;
  label.textContent = text;
}

// ── Live elapsed-time feedback ──
// A silent wait reads as a hung session ("正在思考下一步" could sit static for
// minutes with only animated dots). The timer chip ticks every second next to
// the label so the user can SEE time advancing, and after hintAfterMs with no
// reasoning text yet, one honest hint explains what long silences usually are
// (deep reasoning / network retries). No fake progress theater beyond that —
// matching the no-rotation policy documented above.

const THINKING_TIMER_DEFAULTS = { intervalMs: 1000, hintAfterMs: 15000 };

const timerIntervals = new WeakMap<ThinkingCardHandle, number>();

/** Tick an elapsed-seconds chip beside the label until the card finalizes,
 *  detaches (interval self-cancels), or stopThinkingTimer runs. */
export function startThinkingTimer(
  handle: ThinkingCardHandle,
  opts: { intervalMs?: number; hintAfterMs?: number; hintText?: string } = {},
): void {
  stopThinkingTimer(handle);
  const { intervalMs, hintAfterMs } = { ...THINKING_TIMER_DEFAULTS, ...opts };
  const hintText = opts.hintText
    ?? '模型响应较慢：可能在深度推理或网络重试中，会话并未卡死；可随时停止本轮。';
  const label = handle.card.querySelector<HTMLElement>('.thinking-label');
  if (!label || !handle.card.isConnected) return;
  const chip = document.createElement('span');
  chip.className = 'thinking-timer';
  chip.textContent = '0s';
  label.insertAdjacentElement('afterend', chip);
  const startedAt = Date.now();
  let hinted = false;
  const iv = window.setInterval(() => {
    // Self-cleanup for cards removed without stopThinkingTimer (abort paths).
    if (!handle.card.isConnected) {
      stopThinkingTimer(handle);
      return;
    }
    const ms = Date.now() - startedAt;
    chip.textContent = `${Math.floor(ms / intervalMs)}s`;
    if (!hinted && ms >= hintAfterMs && !handle.textEl.textContent) {
      hinted = true;
      const hint = document.createElement('div');
      hint.className = 'thinking-hint';
      hint.textContent = hintText;
      handle.body.insertBefore(hint, handle.scrollEl);
    }
  }, intervalMs);
  timerIntervals.set(handle, iv);
}

/** Remove the timer chip and cancel its interval (idempotent). */
export function stopThinkingTimer(handle: ThinkingCardHandle): void {
  const iv = timerIntervals.get(handle);
  if (iv !== undefined) {
    clearInterval(iv);
    timerIntervals.delete(handle);
  }
  handle.card.querySelector('.thinking-timer')?.remove();
}

/** Linger window between real output becoming visible on screen and the
 * slow-response hint starting its fade-out (the CSS fade adds ~0.35s on top).
 * The hint explains a silent wait; once output is actually rendering, one
 * readable second remains before it goes away. */
export const HINT_LINGER_MS = 1000;

/** Fade the slow-response hint out and remove it. Called once real reasoning
 * or answer text starts flowing. With `delayMs > 0` the hint lingers that long
 * AFTER the first visible output before fading — and the first call anchors
 * that deadline (later deltas are no-ops, they never push it further out).
 * Idempotent; safe when absent. */
export function dismissThinkingHint(handle: ThinkingCardHandle, delayMs = 0): void {
  const hint = handle.body.querySelector<HTMLElement>('.thinking-hint');
  if (!hint || hint.dataset.dismissing === '1') return;
  // Mark scheduled IMMEDIATELY so repeated deltas can't reschedule, and so
  // finalizeThinkingCard leaves an already-fading hint to its own timer.
  hint.dataset.dismissing = '1';
  const startFade = (): void => {
    // Card (and hint) may have left the DOM mid-dwell (abort / session switch).
    if (!hint.isConnected) return;
    hint.classList.add('fading');
    window.setTimeout(() => hint.remove(), 400);
  };
  if (delayMs > 0) window.setTimeout(startFade, delayMs);
  else startFade();
}

export function createThinkingCard(): ThinkingCardHandle {
  const el = document.createElement('div');
  el.className = 'bubble-row thinking-row';

  const card = document.createElement('details');
  card.className = 'thinking-card thinking';
  // Open by default → the reasoning stream is visible live (默认展开思考过程);
  // click the header to collapse it while keeping the transcript row.
  card.open = true;
  el.classList.add('expanded');

  const summary = document.createElement('summary');
  summary.className = 'thinking-toggle';

  const dots = document.createElement('span');
  dots.className = 'thinking-dots';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('i'));

  // Cyan-blue gem — the same #icon-gem graphic as the app icon, so the
  // thinking indicator matches the reference icon (引用图标一致).
  const icon = document.createElement('span');
  icon.className = 'thinking-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<svg viewBox="0 0 1024 1024" width="14" height="14"><use href="#icon-gem"/></svg>';

  const label = document.createElement('span');
  label.className = 'thinking-label';
  label.textContent = t('thinking.thinking');

  // Down-arrow affordance — hints the chip is expandable; flips up when open.
  const chevron = document.createElement('span');
  chevron.className = 'thinking-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  summary.append(icon, dots, label, chevron);

  const body = document.createElement('div');
  body.className = 'thinking-body';

  // Scroll window for the reasoning text. The body's bottom padding must stay
  // OUTSIDE it (same rationale as .tool-row-scroll in toolRow.ts): padding at
  // the end of a scroll container is below the fold, which used to clip long
  // reasoning flush against the card's bottom edge.
  const scrollEl = document.createElement('div');
  scrollEl.className = 'thinking-scroll';

  const textEl = document.createElement('div');
  textEl.className = 'thinking-text';

  scrollEl.appendChild(textEl);
  body.appendChild(scrollEl);
  card.append(summary, body);
  el.appendChild(card);

  // `<details>` toggles fire in all browsers including WKWebView. Keep the row
  // class synchronized so the same card can move between full-width and compact
  // presentation without replacing the user's open/closed state.
  card.addEventListener('toggle', () => {
    el.classList.toggle('expanded', card.open);
  });

  return { el, card, body, scrollEl, textEl };
}

/** Append a reasoning delta to the card body. */
export function appendThinkingText(handle: ThinkingCardHandle, text: string): void {
  if (!text) return;
  // Append a fresh text node instead of re-assigning textContent so long
  // reasoning streams don't re-serialize the whole buffer on every delta.
  handle.textEl.appendChild(document.createTextNode(text));
  // While expanded, keep the reasoning body pinned to the newest text so the
  // thinking "continuously scrolls" as requested.
  if (handle.card.open) {
    handle.scrollEl.scrollTop = handle.scrollEl.scrollHeight;
  }
}

/** Mark the thinking phase as complete while preserving its transcript row.
 *  The live timer chip is replaced by a frozen total ("思考完成 · 42s") so the
 *  transcript keeps the duration as reviewable information. */
export function finalizeThinkingCard(handle: ThinkingCardHandle): void {
  // Collapse any verbatim loop the model emitted before the card is reviewed
  // (the live stream may briefly show the repeats; the final card is clean).
  handle.textEl.textContent = collapseRepeatedReasoning(handle.textEl.textContent);
  // A lingering slow-response hint is obsolete the moment the phase ends —
  // remove it outright UNLESS a delayed dismissal is already scheduled (output
  // resumed and the hint is mid-linger): that timer owns the fade now.
  const hint = handle.body.querySelector<HTMLElement>('.thinking-hint');
  if (hint && hint.dataset.dismissing !== '1') hint.remove();
  const chip = handle.card.querySelector<HTMLElement>('.thinking-timer');
  const elapsedLabel = chip?.textContent ?? '';
  stopThinkingTimer(handle);
  handle.card.classList.remove('thinking');
  handle.card.classList.add('complete');
  const label = handle.card.querySelector<HTMLElement>('.thinking-label');
  if (label) {
    const secs = parseInt(elapsedLabel, 10);
    label.textContent = Number.isFinite(secs) && secs >= 1 ? `${t('thinking.done')} · ${elapsedLabel}` : t('thinking.done');
  }
  handle.card.querySelector('.thinking-dots')?.remove();
}
