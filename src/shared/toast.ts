// src/shared/toast.ts
// Single toast helper shared by main.ts and pathLink.ts. Both used to own an
// independent `_timer` on the same #toast element, so two toasts within
// 2.5s of each other could hide the newer one early. One module-level timer
// removes that race.

let timer: number | undefined;

export function showToast(msg: string, ms = 2500): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(timer);
  timer = window.setTimeout(() => el.classList.add('hidden'), ms);
}

/**
 * Same toast, but with trusted innerHTML (used for messages that embed a
 * clickable `.path-link` span — e.g. "stats exported, double-click to open").
 * The caller MUST pass escaped HTML only (paths escaped via escapeHtml); never
 * pass raw user input here. Defaults to a longer duration than showToast so a
 * clickable path stays visible long enough to click.
 */
export function showToastHtml(msg: string, ms = 8000): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.innerHTML = msg;
  el.classList.remove('hidden');
  clearTimeout(timer);
  timer = window.setTimeout(() => el.classList.add('hidden'), ms);
}
