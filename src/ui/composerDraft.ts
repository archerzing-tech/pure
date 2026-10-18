// src/ui/composerDraft.ts
// Per-session composer draft persistence — the "全场最弱一环" from the 2026-10
// industry sweep: mainstream products lose the box on refresh/restart, and
// pure additionally multiplies the loss across session switches (the composer
// is a single shared #prompt element, so before this module the outgoing
// session's half-typed text simply became the incoming session's text).
//
// Keyed per session in localStorage; every access is try/caught because a
// draft is a convenience, never a contract (private mode / quota must degrade
// to "no draft", not break the composer). Debounced at 400ms — keystroke-rate
// synchronous JSON writes are pointless and steal the main thread.

// House key style: `pure_<thing>:<sessionId>` (pure_session:, pure_stats:).
const keyOf = (sessionId: string): string => `pure_draft:${sessionId}`;

export function saveDraft(sessionId: string, text: string): void {
  try {
    localStorage.setItem(keyOf(sessionId), text);
  } catch {
    // Draft is a convenience — degrade silently.
  }
}

export function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(keyOf(sessionId)) ?? '';
  } catch {
    return '';
  }
}

export function clearDraft(sessionId: string): void {
  try {
    localStorage.removeItem(keyOf(sessionId));
  } catch {
    // Ditto.
  }
}

export interface ComposerDraftHandle {
  /** Session switch: stash the outgoing session's box under its own id, then
   * restore the incoming session's draft (empty box if it has none). */
  onSessionChanged(sessionId: string): void;
  /** Send path: the box was just cleared programmatically — input events
   * don't fire on programmatic writes, so without this the draft would
   * resurrect on reload. */
  onSent(): void;
}

export function wireComposerDraft(
  el: HTMLTextAreaElement,
  opts: {
    getSessionId: () => string;
    /** Runs after a programmatic value set — send-button state + auto-resize. */
    onRestored?: () => void;
    /** Test hook: shrink the store debounce instead of waiting out 400ms. */
    debounceMs?: number;
  },
): ComposerDraftHandle {
  // Lazy: getSessionId() lazily materializes the first session, and wire time
  // is module init — resolving here would spawn a session before the user
  // acts. The id only matters once something is stored or a switch lands,
  // both of which imply a live session.
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const store = (): void => {
    const id = current ?? opts.getSessionId();
    if (el.value.trim()) saveDraft(id, el.value);
    else clearDraft(id);
  };

  el.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(store, opts.debounceMs ?? 400);
  });

  return {
    onSessionChanged(sessionId) {
      // Flush a pending keystroke first so the last typed characters land
      // under the OLD session before the id moves.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      store();
      current = sessionId;
      el.value = loadDraft(sessionId);
      opts.onRestored?.();
    },
    onSent() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Safe to resolve: a send implies a live session. Skipping the clear
      // here (rather than resolving) would resurrect a sent message's text
      // on the next restart — the exact loss this module exists to prevent.
      clearDraft(current ?? opts.getSessionId());
    },
  };
}
