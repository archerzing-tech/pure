// src/ui/thinkingCard.ts
// Live "thinking" trace for the chat transcript. It is expanded by default so
// the reasoning stream is visible live, and the native details control lets the
// user collapse and reopen it. Completed thinking remains in the transcript so
// it can be reviewed after the assistant answer or a tool call appears.
//
// Shared structure with toolRow.ts: `.bubble-row` wrapper + `<details>`, so
// live streaming (chat.ts) and any future replay render identically.

import { t } from '../shared/i18n';

export function appendStoredThinking(text: string, parent: HTMLElement): void {
  const handle = createThinkingCard();
  handle.card.classList.remove('thinking');
  handle.card.classList.add('complete');
  handle.card.querySelector('.thinking-dots')?.remove();
  handle.textEl.textContent = text;
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

/** Mark the thinking phase as complete while preserving its transcript row. */
export function finalizeThinkingCard(handle: ThinkingCardHandle): void {
  handle.card.classList.remove('thinking');
  handle.card.classList.add('complete');
  const label = handle.card.querySelector<HTMLElement>('.thinking-label');
  if (label) label.textContent = t('thinking.done');
  handle.card.querySelector('.thinking-dots')?.remove();
}
