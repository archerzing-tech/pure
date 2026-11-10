// src/ui/composerSelect.ts
// Custom dropdown for the composer's mode/model pickers.
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

/** 空态动作条目（如「在设置中检查 LLM」）：选项全灭时弹层里唯一可点的行。 */
export interface ComposerSelectEmptyAction {
  label: string;
  onPick: () => void;
}

export interface ComposerSelectSetOptionsOpts {
  /** 诚实显示：当前值不在选项中时 trigger 显示「—」，不认领第一个选项。
   *  默认（false）保留原行为——选中的值失配就回退第一个选项，mode 选择
   *  等消费者依赖它。模型选择列表用 true：显示撒谎会让用户以为自己在用
   *  另一个模型。 */
  strictSelection?: boolean;
  /** 选项为空时的空态动作；没有它，空选项的弹层根本打不开。 */
  emptyAction?: ComposerSelectEmptyAction;
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
  private emptyAction: ComposerSelectEmptyAction | null = null;
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
      // 空态（emptyAction 唯一行）也接受 Enter/Space：options 为空时
      // activeIndex 指向动作行，choose 内部走 onPick 分支。
      if (this.activeIndex >= 0 && (this.options.length > 0 || this.emptyAction)) {
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

  /** Replace the option list and mark `selectedValue` as current. Without
   * `opts.strictSelection`, a value that matches nothing falls back to the
   * FIRST option (native-select legacy behavior). With it, the trigger shows
   * "—" instead — the dropdown must never claim a model the session isn't
   * using. */
  setOptions(options: ComposerSelectOption[], selectedValue?: string, opts?: ComposerSelectSetOptionsOpts): void {
    this.options = [...options];
    this.emptyAction = opts?.emptyAction ?? null;
    let next = selectedValue ?? '';
    if (!next || !this.options.some((o) => o.value === next)) {
      next = opts?.strictSelection ? '' : (this.options[0]?.value ?? '');
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

  /** Programmatic open — the /model command surfaces the picker this way.
   *  Same guards as a click (disabled / already open / nothing to show are
   *  no-ops — "nothing to show" = no options AND no emptyAction, the same
   *  rule openPopup applies), and the trigger takes focus so arrow keys
   *  work without a second click. */
  showPicker(): void {
    if (this.open || this.trigger.disabled) return;
    if (this.options.length === 0 && !this.emptyAction) return;
    this.openPopup();
    this.trigger.focus();
  }

  private openPopup(): void {
    if (this.open || this.trigger.disabled) return;
    if (this.options.length === 0 && !this.emptyAction) return;
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
    // 空态：唯一一行是引导动作（去设置检查），不可选中、点了就跳。
    if (this.options.length === 0 && this.emptyAction) {
      const action = this.emptyAction;
      const item = document.createElement('div');
      item.className = 'cs-item cs-item-action';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      const text = document.createElement('span');
      text.className = 'cs-item-text';
      text.textContent = action.label;
      item.appendChild(text);
      item.addEventListener('click', () => {
        this.close();
        action.onPick();
      });
      this.popup.appendChild(item);
      return;
    }
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
    if (!option) {
      // 空态唯一行（emptyAction）走这里：键盘 Enter 与点击同路。
      if (this.options.length === 0 && this.emptyAction) {
        const action = this.emptyAction;
        this.close();
        action.onPick();
      }
      return;
    }
    this.close();
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
