// src/ui/composerSelect.ts
// Custom dropdown for the composer's mode/model pickers.
//
// WHY NOT A NATIVE <select>: on macOS, WKWebView renders <select> popups as
// native NSMenu panels, and under Tauri's drag-drop handler
// (dragDropEnabled:true — required for OS file drops) those panels flash open
// and immediately dismiss, making models unselectable. This component draws
// the listbox in-page instead: identical behavior in dev/browser preview and a
// stable popup inside the desktop app.

export interface ComposerSelectOption {
  value: string;
  label: string;
  hint?: string;
}

const CHEVRON_SVG =
  '<svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg>';

const CHECK_SVG =
  '<svg class="cs-item-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

export class ComposerSelect {
  private trigger: HTMLButtonElement;
  private labelEl: HTMLSpanElement;
  private popup: HTMLDivElement | null = null;
  private options: ComposerSelectOption[] = [];
  private value = '';
  private activeIndex = -1;
  private open = false;
  private readonly onSelect: (value: string) => void;
  private readonly onDocumentMouseDown = (e: MouseEvent) => {
    if (!this.open) return;
    const target = e.target as Node;
    if (this.popup?.contains(target) || this.trigger.contains(target)) return;
    this.close();
  };
  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.openPopup();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      this.trigger.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      this.activeIndex = (this.activeIndex + delta + this.options.length) % Math.max(1, this.options.length);
      this.highlightActive();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (this.activeIndex >= 0 && this.options[this.activeIndex]) {
        this.choose(this.activeIndex);
      }
    }
  };

  constructor(host: HTMLElement, onSelect: (value: string) => void, ariaLabel = '') {
    this.onSelect = onSelect;
    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'cs-trigger';
    if (ariaLabel) {
      this.trigger.title = ariaLabel;
      this.trigger.setAttribute('aria-label', ariaLabel);
      this.trigger.setAttribute('aria-haspopup', 'listbox');
    }
    this.labelEl = document.createElement('span');
    this.labelEl.className = 'cs-trigger-label';
    const chevron = document.createElement('span');
    chevron.className = 'cs-trigger-chevron';
    chevron.innerHTML = CHEVRON_SVG;
    chevron.setAttribute('aria-hidden', 'true');
    this.trigger.append(this.labelEl, chevron);
    this.trigger.addEventListener('click', () => (this.open ? this.close() : this.openPopup()));
    this.trigger.addEventListener('keydown', this.onKeyDown);
    host.appendChild(this.trigger);
  }

  /** Replace the option list and mark `selectedValue` as current. When it
   * does not match any option the FIRST option becomes current (mirrors the
   * previous native-select fallback so the config always has a valid pair). */
  setOptions(options: ComposerSelectOption[], selectedValue?: string): void {
    this.options = [...options];
    let next = selectedValue ?? '';
    if (!next || !this.options.some((o) => o.value === next)) {
      next = this.options[0]?.value ?? '';
    }
    this.value = next;
    this.syncTrigger();
    if (this.open) this.renderPopupItems();
  }

  getValue(): string {
    return this.value;
  }

  setDisabled(disabled: boolean): void {
    this.trigger.disabled = disabled;
    if (disabled) this.close();
  }

  /** Refresh the accessible label (i18n language switches re-populate). */
  setTriggerTitle(title: string): void {
    this.trigger.title = title;
    this.trigger.setAttribute('aria-label', title);
  }

  private currentOption(): ComposerSelectOption | undefined {
    return this.options.find((o) => o.value === this.value);
  }

  private syncTrigger(): void {
    const current = this.currentOption();
    this.labelEl.textContent = current?.label ?? '—';
    this.labelEl.title = current?.hint ? `${current.hint} · ${current.label}` : current?.label ?? '';
  }

  private readonly onWindowDismiss = () => this.close();

  private openPopup(): void {
    if (this.open || this.options.length === 0 || this.trigger.disabled) return;
    this.popup = document.createElement('div');
    this.popup.className = 'cs-popup';
    this.popup.setAttribute('role', 'listbox');
    this.renderPopupItems();
    document.body.appendChild(this.popup);
    // Position BELOW the trigger via fixed coordinates so page overflow,
    // transforms, or ancestor clipping can never cut the list off.
    const rect = this.trigger.getBoundingClientRect();
    const popupRect = this.popup.getBoundingClientRect();
    const below = Math.max(8, rect.bottom + 6);
    const fitsBelow = below + popupRect.height <= window.innerHeight - 8;
    this.popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popupRect.width - 8))}px`;
    this.popup.style.top = `${fitsBelow ? below : Math.max(8, rect.top - popupRect.height - 6)}px`;
    this.activeIndex = Math.max(0, this.options.findIndex((o) => o.value === this.value));
    this.highlightActive();
    this.open = true;
    this.trigger.classList.add('open');
    this.trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', this.onDocumentMouseDown, true);
    window.addEventListener('resize', this.onWindowDismiss);
    window.addEventListener('scroll', this.onWindowDismiss, { passive: true });
  }

  private renderPopupItems(): void {
    if (!this.popup) return;
    this.popup.replaceChildren();
    this.options.forEach((option, index) => {
      const item = document.createElement('div');
      item.className = 'cs-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', option.value === this.value ? 'true' : 'false');
      item.dataset.index = String(index);
      const check = document.createElement('span');
      check.className = 'cs-item-check-slot';
      check.innerHTML = option.value === this.value ? CHECK_SVG : '';
      const text = document.createElement('span');
      text.className = 'cs-item-text';
      text.textContent = option.label;
      item.append(check, text);
      if (option.hint) {
        const hint = document.createElement('span');
        hint.className = 'cs-item-hint';
        hint.textContent = option.hint;
        item.appendChild(hint);
      }
      item.addEventListener('mouseenter', () => {
        this.activeIndex = index;
        this.highlightActive();
      });
      item.addEventListener('click', () => this.choose(index));
      this.popup!.appendChild(item);
    });
  }

  private highlightActive(): void {
    if (!this.popup) return;
    this.popup.querySelectorAll<HTMLElement>('.cs-item').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.index) === this.activeIndex);
    });
    const active = this.popup.querySelector<HTMLElement>(`.cs-item[data-index="${this.activeIndex}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }

  private choose(index: number): void {
    const option = this.options[index];
    this.close();
    if (!option) return;
    const changed = option.value !== this.value;
    this.value = option.value;
    this.syncTrigger();
    if (changed) this.onSelect(option.value);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.popup?.remove();
    this.popup = null;
    this.trigger.classList.remove('open');
    this.trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', this.onDocumentMouseDown, true);
    window.removeEventListener('resize', this.onWindowDismiss);
    window.removeEventListener('scroll', this.onWindowDismiss);
  }
}
