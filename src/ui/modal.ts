// src/ui/modal.ts
// In-app modal dialog (centered overlay) for destructive confirmations like
// session deletion. Tauri's WKWebView does not implement window.confirm(), and
// the inline-card confirmations used for permission / plan review intentionally
// live inside the chat transcript — destructive actions instead get a real
// modal overlay so the user can't lose their place in the conversation.

export interface ConfirmModalOptions {
  title: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  /** Danger-styled OK button (delete-red) instead of the accent primary. */
  danger?: boolean;
  /** Focus the OK button instead of Cancel. Destructive dialogs default to
   * Cancel: Esc cancels, and a habitual Enter on the focused Cancel button can
   * never confirm a delete. */
  focusOk?: boolean;
}

/** Show a modal confirm dialog. Resolves `true` on OK, `false` on cancel /
 * backdrop click / Escape. Exactly one modal can be open at a time. */
export function showConfirmModal(opts: ConfirmModalOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    // Remember where focus was before the overlay — closing restores it so
    // the next Tab/Space can't fire a stray click on the first body element.
    const focusBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const close = (result: boolean) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (focusBeforeOpen?.isConnected) focusBeforeOpen.focus();
      resolve(result);
    };

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'modal-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', opts.title);

    const title = document.createElement('h3');
    title.className = 'modal-title';
    title.textContent = opts.title;

    const message = document.createElement('div');
    message.className = 'modal-message';
    message.textContent = opts.message;

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'setting-btn secondary modal-btn';
    cancelBtn.textContent = opts.cancelLabel ?? 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = `setting-btn ${opts.danger ? 'danger' : 'primary'} modal-btn`;
    okBtn.textContent = opts.okLabel ?? 'OK';

    actions.append(cancelBtn, okBtn);
    dialog.append(title, message, actions);
    overlay.appendChild(dialog);

    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    // Backdrop click = cancel — a destructive action must never be the easy
    // accidental path (same reasoning as focusing Cancel by default).
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(false);
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
        return;
      }
      // Tab trap: keep focus cycling inside the dialog (only the action
      // buttons are focusable) so Tab can never escape to the page behind the
      // overlay. Wraps at both ends, and also catches the case where focus is
      // still on the previously-focused element behind the modal.
      if (e.key === 'Tab') {
        const focusables = [...dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )].filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !dialog.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    (opts.focusOk ? okBtn : cancelBtn).focus();
  });
}
