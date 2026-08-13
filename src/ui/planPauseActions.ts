// src/ui/planPauseActions.ts
// Continue/cancel shortcuts on the "plan paused — waiting for your reply"
// bubble. The bar is appended to the bubble's ROW (a sibling of the bubble
// element) so the async markdown render that fills the bubble can never wipe
// it. Both buttons disable after the first click so a double-click cannot run
// the action twice (a second continue would otherwise abort the resumed turn).

export interface PlanPauseActions {
  bar: HTMLElement;
  continueBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
}

export function attachPlanPauseActions(
  row: HTMLElement,
  onContinue: () => boolean,
  onCancel: () => boolean,
): PlanPauseActions {
  const bar = document.createElement('div');
  bar.className = 'plan-pause-actions';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', '已暂停的计划操作');

  const continueBtn = document.createElement('button');
  continueBtn.type = 'button';
  continueBtn.className = 'plan-pause-action plan-pause-action-continue';
  continueBtn.textContent = '继续执行';
  continueBtn.setAttribute('aria-label', '继续执行已暂停的计划');

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'plan-pause-action plan-pause-action-cancel';
  cancelBtn.textContent = '取消计划';
  cancelBtn.setAttribute('aria-label', '取消本次执行计划');

  const lock = (): void => {
    continueBtn.disabled = true;
    cancelBtn.disabled = true;
  };
  // Lock only when the action actually ran: handlers report false when they
  // bailed early (e.g. a turn is still streaming), so the buttons stay usable
  // for a retry instead of silently dead-ending.
  continueBtn.addEventListener('click', () => {
    if (continueBtn.disabled) return;
    if (onContinue()) lock();
  });
  cancelBtn.addEventListener('click', () => {
    if (cancelBtn.disabled) return;
    if (onCancel()) lock();
  });

  bar.append(continueBtn, cancelBtn);
  row.appendChild(bar);
  return { bar, continueBtn, cancelBtn };
}
