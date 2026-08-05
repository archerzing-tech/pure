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
