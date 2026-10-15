// src/ui/ambiguityHint.ts
// Roadmap 阶段 11.3 (P2) — the "we cannot know which file" half of path repair.
//
// 11.2 rewrites a path only when exactly one workspace file is close enough. The
// remaining case — two or more files fit equally well — is where guessing is
// most expensive and least defensible, so this module does the opposite of a
// rewrite: it says what the candidates are and leaves the draft alone. The
// clarification then happens on the model side, as an annotation carried with
// the message, instead of the app editing the user's words (iron law #1).
//
// Three keystrokes, three outcomes:
//   Tab    adopt — record the candidates for the send path; the textarea is NOT
//          touched (the note rides along with the message, not in the draft)
//   Esc    ignore — drop the candidates and close
//   Enter  send as written — never preventDefault, so the composer's own handler
//          still runs; with no Tab there is no annotation
//
// The popup positioning and the IME / defaultPrevented guards mirror
// InlineAutocomplete on purpose (this is the same composer corner), but this
// file is independent: 11.2/11.3 must not move a component with locked tests.

import { t } from '../shared/i18n';
import type { AmbiguityHint } from './pathIndex';

/** Same debounce the autocomplete query uses, so the two never feel different. */
const HINT_DEBOUNCE_MS = 120;

/** The autocomplete popup owns the composer while it is up: one layer at a time.
 *  Its own keydown runs first, so a Tab it claims leaves defaultPrevented set
 *  and this handler yields (see onKeydown). */
function acPopupOpen(): boolean {
  return document.querySelector('.ac-popup') !== null;
}

// ── Pure side (unit-tested without a DOM) ──

/** The note appended to the model's copy of an adopted draft. '' when nothing
 *  was adopted — the draft then goes out exactly as written. */
export function buildAmbiguityAnnotation(hints: readonly AmbiguityHint[]): string {
  if (hints.length === 0) return '';
  const lines = hints.map((hint) =>
    t('repair.ambiguityAnnotation')
      .replace('{token}', hint.token)
      .replace('{candidates}', hint.candidates.join(' / ')),
  );
  return `${t('repair.ambiguityAnnotationHeader')}\n${lines.join('\n')}`;
}

export interface AmbiguitySend {
  /** What the MODEL receives: the draft, plus the note when Tab adopted it. */
  text: string;
  /** What the transcript shows: the user's own words, or undefined to leave the
   *  existing display path (expanded prompt / path repair) in charge. */
  displayOverride: string | undefined;
}

/**
 * Compose the send channel for an accepted hint.
 *
 * The note is part of the model's body text — no new message field, no change
 * to chat.ts/store.ts — while the transcript keeps showing the original words.
 * A plain Enter (nothing adopted) returns the draft untouched and hands display
 * back to the caller.
 */
export function composeAmbiguitySend(text: string, hints: readonly AmbiguityHint[]): AmbiguitySend {
  const annotation = buildAmbiguityAnnotation(hints);
  if (!annotation) return { text, displayOverride: undefined };
  return { text: `${text}\n\n${annotation}`, displayOverride: text };
}

// ── DOM layer ──

export class ComposerAmbiguityHint {
  private readonly input: HTMLTextAreaElement;
  private popup: HTMLDivElement | null = null;
  private hints: AmbiguityHint[] = [];
  /** Candidates the user adopted with Tab, awaiting the send path. Survives
   *  close() (Tab closes the popup) and is dropped on the next keystroke. */
  private accepted: AmbiguityHint[] = [];
  private open = false;
  private scanTimer: number | null = null;
  /** IME (拼音→汉字) owns the keyboard and the input events while it runs. */
  private composing = false;

  constructor(input: HTMLTextAreaElement, private readonly getHints: () => AmbiguityHint[]) {
    this.input = input;
    input.addEventListener('input', this.onInput);
    input.addEventListener('keydown', this.onKeydown);
    input.addEventListener('compositionstart', this.onCompositionStart);
    input.addEventListener('compositionend', this.onCompositionEnd);
    input.addEventListener('blur', this.close);
    input.addEventListener('scroll', this.close);
  }

  destroy(): void {
    this.close();
    this.input.removeEventListener('input', this.onInput);
    this.input.removeEventListener('keydown', this.onKeydown);
    this.input.removeEventListener('compositionstart', this.onCompositionStart);
    this.input.removeEventListener('compositionend', this.onCompositionEnd);
    this.input.removeEventListener('blur', this.close);
    this.input.removeEventListener('scroll', this.close);
  }

  /** The send path takes the adopted candidates and clears them. Empty when the
   *  user never pressed Tab (Enter sends the draft as written). */
  consumeAccepted(): AmbiguityHint[] {
    const accepted = this.accepted;
    this.accepted = [];
    return accepted;
  }

  private readonly onCompositionStart = (): void => {
    this.composing = true;
    this.close();
  };

  private readonly onCompositionEnd = (): void => {
    this.composing = false;
  };

  private readonly onInput = (): void => {
    // Mid-composition text is a pinyin buffer, not a path the user meant.
    if (this.composing) return;
    // A new keystroke invalidates an earlier Tab: the note described the old
    // draft, and the scan below may re-open on the new one.
    this.accepted = [];
    this.close();
    this.scheduleScan();
  };

  private scheduleScan(): void {
    if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => this.runScan(), HINT_DEBOUNCE_MS);
  }

  private runScan(): void {
    this.scanTimer = null;
    if (document.activeElement !== this.input) return;
    if (acPopupOpen()) return; // the autocomplete popup wins the corner
    const hints = this.getHints();
    if (hints.length === 0) {
      this.close();
      return;
    }
    this.openPopup(hints);
  }

  private openPopup(hints: AmbiguityHint[]): void {
    this.closePopupDom();
    this.hints = hints;

    this.popup = document.createElement('div');
    this.popup.className = 'ambiguity-hint';
    this.popup.setAttribute('role', 'listbox');

    const head = document.createElement('div');
    head.className = 'ambiguity-hint-head';
    head.textContent = t('repair.ambiguityHint');
    this.popup.appendChild(head);

    for (const hint of hints) {
      const row = document.createElement('div');
      row.className = 'ambiguity-hint-item';
      const token = document.createElement('span');
      token.className = 'ambiguity-hint-token';
      token.textContent = hint.token;
      const candidates = document.createElement('span');
      candidates.className = 'ambiguity-hint-candidates';
      candidates.textContent = hint.candidates.join(' / ');
      row.append(token, candidates);
      this.popup.appendChild(row);
    }

    const keys = document.createElement('div');
    keys.className = 'ambiguity-hint-keys';
    keys.textContent = t('repair.ambiguityKeys');
    this.popup.appendChild(keys);

    document.body.appendChild(this.popup);

    // Position below the input via fixed coordinates (same approach as
    // InlineAutocomplete / composerSelect) so transforms/overflow never clip it.
    const rect = this.input.getBoundingClientRect();
    const popupRect = this.popup.getBoundingClientRect();
    const below = Math.max(8, rect.bottom + 6);
    const fitsBelow = below + popupRect.height <= window.innerHeight - 8;
    this.popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popupRect.width - 8))}px`;
    this.popup.style.top = `${fitsBelow ? below : Math.max(8, rect.top - popupRect.height - 6)}px`;
    this.popup.style.width = `${Math.min(420, Math.max(240, rect.width))}px`;
    this.open = true;
    document.addEventListener('mousedown', this.onDocumentMouseDown, true);
    window.addEventListener('resize', this.close);
    window.addEventListener('scroll', this.close, { passive: true });
  }

  private readonly onKeydown = (e: KeyboardEvent): void => {
    // Another composer layer already claimed this key (InlineAutocomplete runs
    // first) — never answer a key someone else handled.
    if (e.defaultPrevented) return;
    if (!this.open) return;
    // The IME gets the keyboard first — that Enter is a候选字 commit, not ours.
    if (this.composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Tab') {
      // Tab is an EXPLICIT adopt, and it changes nothing the user sees: the
      // candidates become an annotation on the message, never a rewrite of the
      // textarea.
      e.preventDefault();
      this.accepted = [...this.hints];
      this.close();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.accepted = [];
      this.close();
    } else if (e.key === 'Enter') {
      // Enter means "send": fall through to the composer untouched. Any earlier
      // Tab adoption still rides along; with none, nothing is annotated.
      this.close();
    }
  };

  private readonly onDocumentMouseDown = (e: MouseEvent): void => {
    if (this.popup && !this.popup.contains(e.target as Node)) this.close();
  };

  private closePopupDom(): void {
    this.popup?.remove();
    this.popup = null;
    this.hints = [];
    this.open = false;
    document.removeEventListener('mousedown', this.onDocumentMouseDown, true);
    window.removeEventListener('resize', this.close);
    window.removeEventListener('scroll', this.close);
  }

  private readonly close = (): void => {
    if (this.scanTimer !== null) {
      window.clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.closePopupDom();
  };
}
