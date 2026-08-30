// src/ui/inlineAutocomplete.ts
// Context-based inline autocomplete for the composer. On typing a prefix (or
// Ctrl+Space) a popup suggests recent session titles, past commands, and
// recently written file paths — real context from the local store, no fake
// slash macros. Insert replaces the current word; Tab/Enter accept, Esc closes.
//
// DOM is kept in this module (positioning mirrors composerSelect: fixed coords
// below the input, outside-mousedown/resize/scroll dismiss, arrow-key nav) so
// main.ts only constructs the class. The pure filter + candidate builder are
// exported for unit tests.

import { loadSessionList, loadSessionStats } from './store';

export interface AutocompleteCandidate {
  /** Display text. */
  label: string;
  /** Text inserted at the caret (replaces the current token). */
  insert: string;
  kind: 'session' | 'command' | 'path';
}

const KIND_LABEL: Record<AutocompleteCandidate['kind'], string> = {
  session: '⌘',
  command: '$',
  path: '📁',
};

/** Word characters for token extraction (incl. CJK, path separators, dots). */
const PREFIX_RE = /[\w一-鿿./-]+$/;

/** Case-insensitive prefix filter: starts-with matches sort first, then
 * containment, alpha-stable, deduped by insert, capped at `limit`. */
export function filterCandidates(prefix: string, candidates: AutocompleteCandidate[], limit = 8): AutocompleteCandidate[] {
  const p = prefix.trim().toLowerCase();
  if (!p) return [];
  const seen = new Set<string>();
  const matches: AutocompleteCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.insert)) continue;
    const hay = `${c.label} ${c.insert}`.toLowerCase();
    if (hay.includes(p)) {
      seen.add(c.insert);
      matches.push(c);
    }
  }
  matches.sort((a, b) => {
    const aStart = a.label.toLowerCase().startsWith(p) ? 0 : 1;
    const bStart = b.label.toLowerCase().startsWith(p) ? 0 : 1;
    if (aStart !== bStart) return aStart - bStart;
    return a.label.localeCompare(b.label);
  });
  return matches.slice(0, limit);
}

// ── Candidate sources (real store context, cached briefly) ──

const MAX_CANDIDATE_SESSIONS = 12;
const MAX_COMMANDS = 24;
const MAX_PATHS = 16;
const CACHE_TTL_MS = 30_000;

let candidatesCache: { at: number; items: AutocompleteCandidate[] } | null = null;

/** Build context candidates from the local store: recent session titles,
 * top past command strings, and recent file-write paths. Cached 30s. */
export async function buildContextCandidates(): Promise<AutocompleteCandidate[]> {
  const now = Date.now();
  if (candidatesCache && now - candidatesCache.at < CACHE_TTL_MS) return candidatesCache.items;

  const items: AutocompleteCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: AutocompleteCandidate): void => {
    if (!seen.has(c.insert)) {
      seen.add(c.insert);
      items.push(c);
    }
  };

  const metas = (await loadSessionList()).slice(0, MAX_CANDIDATE_SESSIONS);
  for (const meta of metas) {
    if (meta.title) push({ label: meta.title, insert: meta.title, kind: 'session' });
  }

  const commandCount = new Map<string, number>();
  const paths: string[] = [];
  for (const meta of metas) {
    const stats = loadSessionStats(meta.id);
    for (const cmd of stats.commands ?? []) commandCount.set(cmd.command, (commandCount.get(cmd.command) ?? 0) + 1);
    for (const w of stats.fileWrites ?? []) paths.push(w.path);
  }
  const topCommands = [...commandCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_COMMANDS);
  for (const [cmd] of topCommands) push({ label: cmd, insert: cmd, kind: 'command' });
  for (const p of paths.slice(0, MAX_PATHS)) push({ label: p, insert: p, kind: 'path' });

  candidatesCache = { at: now, items };
  return items;
}

// ── DOM layer ──

export class InlineAutocomplete {
  private readonly input: HTMLTextAreaElement;
  private popup: HTMLDivElement | null = null;
  private items: AutocompleteCandidate[] = [];
  private activeIndex = 0;
  private tokenStart = 0;
  private open = false;
  private queryTimer: number | null = null;
  private candidatesPromise: Promise<AutocompleteCandidate[]> | null = null;
  private suppressNextInput = false;

  constructor(input: HTMLTextAreaElement) {
    this.input = input;
    input.addEventListener('input', this.onInput);
    input.addEventListener('keydown', this.onKeydown);
    input.addEventListener('blur', this.close);
    input.addEventListener('scroll', this.close);
  }

  destroy(): void {
    this.close();
    this.input.removeEventListener('input', this.onInput);
    this.input.removeEventListener('keydown', this.onKeydown);
    this.input.removeEventListener('blur', this.close);
    this.input.removeEventListener('scroll', this.close);
  }

  private currentToken(): { token: string; start: number } | null {
    const caret = this.input.selectionStart ?? this.input.value.length;
    const before = this.input.value.slice(0, caret);
    const m = before.match(PREFIX_RE);
    if (!m) return null;
    return { token: m[0], start: caret - m[0].length };
  }

  private readonly onInput = (): void => {
    if (this.suppressNextInput) {
      this.suppressNextInput = false;
      return;
    }
    this.close();
    const tok = this.currentToken();
    if (!tok || tok.token.length < 2) return;
    this.scheduleQuery(tok.token, tok.start);
  };

  private scheduleQuery(prefix: string, start: number): void {
    if (this.queryTimer !== null) window.clearTimeout(this.queryTimer);
    this.queryTimer = window.setTimeout(() => void this.runQuery(prefix, start), 120);
  }

  private async runQuery(prefix: string, start: number): Promise<void> {
    this.queryTimer = null;
    if (document.activeElement !== this.input) return;
    if (!this.candidatesPromise) this.candidatesPromise = buildContextCandidates();
    const candidates = await this.candidatesPromise;
    const matches = filterCandidates(prefix, candidates);
    if (matches.length === 0) {
      this.close();
      return;
    }
    this.openPopup(matches, start);
  }

  private openPopup(items: AutocompleteCandidate[], tokenStart: number): void {
    this.closePopupDom();
    this.items = items;
    this.tokenStart = tokenStart;
    this.activeIndex = 0;

    this.popup = document.createElement('div');
    this.popup.className = 'ac-popup';
    this.popup.setAttribute('role', 'listbox');
    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'ac-item';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
      row.dataset.index = String(index);
      const kind = document.createElement('span');
      kind.className = 'ac-item-kind';
      kind.textContent = KIND_LABEL[item.kind];
      const text = document.createElement('span');
      text.className = 'ac-item-text';
      text.textContent = item.label;
      row.append(kind, text);
      row.addEventListener('mouseenter', () => {
        this.activeIndex = index;
        this.highlight();
      });
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => this.choose(index));
      this.popup!.appendChild(row);
    });
    document.body.appendChild(this.popup);

    // Position below the input via fixed coordinates (same approach as
    // composerSelect) so transforms/overflow can never clip the list.
    const rect = this.input.getBoundingClientRect();
    const popupRect = this.popup.getBoundingClientRect();
    const below = Math.max(8, rect.bottom + 6);
    const fitsBelow = below + popupRect.height <= window.innerHeight - 8;
    this.popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popupRect.width - 8))}px`;
    this.popup.style.top = `${fitsBelow ? below : Math.max(8, rect.top - popupRect.height - 6)}px`;
    this.popup.style.width = `${Math.min(360, Math.max(240, rect.width))}px`;
    this.open = true;
    this.highlight();
    document.addEventListener('mousedown', this.onDocumentMouseDown, true);
    window.addEventListener('resize', this.close);
    window.addEventListener('scroll', this.close, { passive: true });
  }

  private highlight(): void {
    this.popup?.querySelectorAll<HTMLElement>('.ac-item').forEach((el) => {
      const active = Number(el.dataset.index) === this.activeIndex;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    this.popup?.querySelector<HTMLElement>(`.ac-item[data-index="${this.activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  private choose(index: number): void {
    const item = this.items[index];
    if (!item) return;
    const caret = this.input.selectionStart ?? this.input.value.length;
    const value = this.input.value;
    const next = value.slice(0, this.tokenStart) + item.insert + value.slice(caret);
    this.close();
    this.input.value = next;
    const pos = this.tokenStart + item.insert.length;
    this.input.setSelectionRange(pos, pos);
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
    this.input.focus();
  }

  private readonly onKeydown = (e: KeyboardEvent): void => {
    if (!this.open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.activeIndex = (this.activeIndex + 1) % this.items.length;
      this.highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.activeIndex = (this.activeIndex - 1 + this.items.length) % this.items.length;
      this.highlight();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      this.choose(this.activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  };

  private readonly onDocumentMouseDown = (e: MouseEvent): void => {
    if (this.popup && !this.popup.contains(e.target as Node)) this.close();
  };

  private closePopupDom(): void {
    this.popup?.remove();
    this.popup = null;
    this.open = false;
    document.removeEventListener('mousedown', this.onDocumentMouseDown, true);
    window.removeEventListener('resize', this.close);
    window.removeEventListener('scroll', this.close);
  }

  private readonly close = (): void => {
    if (this.queryTimer !== null) {
      window.clearTimeout(this.queryTimer);
      this.queryTimer = null;
    }
    this.closePopupDom();
  };
}
