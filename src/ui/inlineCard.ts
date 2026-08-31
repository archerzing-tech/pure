// src/ui/inlineCard.ts
// Inline confirmation cards appended to the chat transcript. Replaces the
// centered modal overlays: authorization / plan-review / delete-confirm prompts
// now render as a card in the conversation flow (same visual language as tool
// rows), so the user keeps full context and nothing pops over the interface.
// Each card owns its own buttons and resolves exactly once; if the card is
// removed externally (chat.clear(), transcript pruning) before the user decides
// it resolves with the esc value so the awaiting call can never hang.

import { scrollChatToBottomIfPinned } from './scrollPin';

export interface InlineCardAction {
  label: string;
  /** Value resolved to the caller when the button is clicked. */
  value: string;
  kind?: 'primary' | 'danger' | 'secondary';
}

let transcriptHost: HTMLElement | null = null;

export function setInlineCardHost(host: HTMLElement | null): void {
  transcriptHost = host;
}

export interface InlineCardOptions {
  /** Extra row class (e.g. 'permission', 'plan', 'confirm'). */
  cardClass: string;
  title: string;
  /** Already-escaped HTML for the card body (optional). */
  bodyHTML?: string;
  /** Buttons, rendered left → right. */
  actions: InlineCardAction[];
  /** Index of the button to focus initially (default 0). */
  focusIndex?: number;
  /** Esc resolves with this value. Omit to keep the card open on Esc. */
  escValue?: string;
  /** When aborted (e.g. user pressed stop), resolves with the esc value and closes. */
  signal?: AbortSignal;
  /** Optional transcript host for a live turn; defaults to #chat. */
  host?: HTMLElement;
}

export function showInlineCard(opts: InlineCardOptions): Promise<string> {
  return new Promise((resolve) => {
    const chatEl = opts.host ?? transcriptHost ?? document.getElementById('chat')!;
    // Already-aborted signal: never render the card, resolve as cancelled so
    // the awaiting caller (e.g. plan review) exits cleanly on a user stop.
    if (opts.signal?.aborted) {
      resolve(opts.escValue ?? 'cancel');
      return;
    }
    const row = document.createElement('div');
    row.className = `bubble-row inline-card ${opts.cardClass}`;

    const card = document.createElement('div');
    card.className = 'inline-card-box';

    const head = document.createElement('div');
    head.className = 'inline-card-head';
    const title = document.createElement('span');
    title.className = 'inline-card-title';
    title.textContent = opts.title;
    head.appendChild(title);
    card.appendChild(head);

    if (opts.bodyHTML) {
      const body = document.createElement('div');
      body.className = 'inline-card-body';
      body.innerHTML = opts.bodyHTML;
      card.appendChild(body);
    }

    const actions = document.createElement('div');
    actions.className = 'inline-card-actions';

    let decided = false;
    const decide = (value: string): void => {
      if (decided) return;
      decided = true;
      cleanup();
      resolve(value);
    };
    const cleanup = (): void => {
      row.remove();
      watchdog.disconnect();
      document.removeEventListener('keydown', onKeydown);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    // 用户点击「停止」时视为取消：关闭卡片并落定，避免 send() 永久挂起。
    const onAbort = (): void => decide(opts.escValue ?? 'cancel');
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const buttons: HTMLButtonElement[] = [];
    for (const a of opts.actions) {
      const btn = document.createElement('button');
      btn.className = `setting-btn ${a.kind ?? 'secondary'}`;
      btn.textContent = a.label;
      btn.addEventListener('click', () => decide(a.value));
      buttons.push(btn);
      actions.appendChild(btn);
    }

    card.appendChild(actions);
    row.appendChild(card);
    chatEl.appendChild(row);

    // Fail-safe: resolve if the card is removed before a decision is made.
    const watchdog = new MutationObserver(() => {
      if (!row.isConnected) decide(opts.escValue ?? 'cancel');
    });
    watchdog.observe(chatEl, { childList: true });

    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && opts.escValue !== undefined) {
        e.preventDefault();
        decide(opts.escValue);
      }
    };
    document.addEventListener('keydown', onKeydown);

    const focusIndex = Math.max(0, Math.min(opts.focusIndex ?? 0, buttons.length - 1));
    buttons[focusIndex]?.focus();
    scrollChatToBottomIfPinned(chatEl);
  });
}
