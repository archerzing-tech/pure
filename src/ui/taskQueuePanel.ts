// src/ui/taskQueuePanel.ts
// DOM for the batch task queue popover above the composer. The queue is a pure
// model (taskQueue.ts); this layer renders it and translates clicks into
// TaskQueue calls. Outside-mousedown / Esc dismiss mirrors the ComposerSelect
// popover pattern. Task text always lands via textContent — never innerHTML —
// because it is user input.

import { t } from '../shared/i18n';
import type { QueueTask, TaskQueue } from './taskQueue';

const STATUS_ICON: Record<QueueTask['status'], string> = {
  pending: '○',
  running: '⟳',
  done: '✓',
  failed: '✕',
  cancelled: '–',
};

export function mountTaskQueuePanel(queue: TaskQueue): void {
  const panel = document.getElementById('task-queue-panel');
  const toggleBtn = document.getElementById('queue-btn');
  if (!panel || !toggleBtn) return;

  toggleBtn.classList.add('has-queue');
  (toggleBtn as HTMLButtonElement).disabled = false;

  // Badge on the composer button: number of queued+running tasks.
  const badge = document.createElement('span');
  badge.className = 'queue-btn-badge';
  toggleBtn.appendChild(badge);

  // ── Shell ──
  panel.classList.add('queue-panel');
  const head = document.createElement('div');
  head.className = 'queue-panel-head';
  const title = document.createElement('span');
  title.className = 'queue-panel-title';
  title.textContent = t('queue.title');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'queue-panel-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', t('queue.close'));
  head.append(title, closeBtn);

  const inputRow = document.createElement('div');
  inputRow.className = 'queue-input-row';
  const textarea = document.createElement('textarea');
  textarea.className = 'queue-input';
  textarea.rows = 2;
  textarea.placeholder = t('queue.inputPlaceholder');
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'setting-btn primary queue-add-btn';
  addBtn.textContent = t('queue.add');
  inputRow.append(textarea, addBtn);

  const list = document.createElement('div');
  list.className = 'queue-list';

  const foot = document.createElement('div');
  foot.className = 'queue-panel-foot';
  const cancelAll = document.createElement('button');
  cancelAll.type = 'button';
  cancelAll.className = 'setting-btn secondary queue-foot-btn';
  cancelAll.textContent = t('queue.cancelAll');
  const clearDone = document.createElement('button');
  clearDone.type = 'button';
  clearDone.className = 'setting-btn secondary queue-foot-btn';
  clearDone.textContent = t('queue.clearDone');
  foot.append(cancelAll, clearDone);

  panel.append(head, inputRow, list, foot);

  // ── Render ──
  const render = (): void => {
    const tasks = queue.getTasks();
    const active = tasks.filter((x) => x.status === 'pending' || x.status === 'running').length;
    badge.textContent = active > 0 ? String(active) : '';
    badge.classList.toggle('queue-btn-badge-on', active > 0);
    toggleBtn.title = active > 0 ? t('queue.count').replace('{n}', String(active)) : t('queue.title');
    toggleBtn.setAttribute('aria-label', toggleBtn.title);

    list.replaceChildren();
    if (tasks.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'queue-empty';
      empty.textContent = t('queue.empty');
      list.appendChild(empty);
      return;
    }
    for (const task of tasks) {
      const row = document.createElement('div');
      row.className = `queue-item queue-item-${task.status}`;
      const dot = document.createElement('span');
      dot.className = 'queue-dot';
      dot.textContent = STATUS_ICON[task.status];
      const text = document.createElement('span');
      text.className = 'queue-text';
      text.textContent = task.displayText;
      text.title = task.displayText;
      row.append(dot, text);
      if (task.status === 'pending' || task.status === 'running') {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'queue-cancel-btn';
        cancel.textContent = '✕';
        cancel.setAttribute('aria-label', t('queue.cancel'));
        cancel.addEventListener('click', () => queue.cancel(task.id));
        row.appendChild(cancel);
      }
      if (task.status === 'failed' && task.error) {
        const err = document.createElement('span');
        err.className = 'queue-error';
        err.textContent = task.error;
        err.title = task.error;
        row.appendChild(err);
      }
      list.appendChild(row);
    }
  };

  // ── Actions ──
  const toggle = (open?: boolean): void => {
    const show = open ?? panel.hidden;
    panel.hidden = !show;
    if (show) textarea.focus();
  };

  const submit = (): void => {
    if (!textarea.value.trim()) return;
    queue.enqueue(textarea.value);
    textarea.value = '';
    textarea.focus();
  };

  addBtn.addEventListener('click', submit);
  textarea.addEventListener('keydown', (e) => {
    // Plain Enter types newlines (one task per line); Ctrl/Cmd+Enter adds.
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  closeBtn.addEventListener('click', () => toggle(false));
  toggleBtn.addEventListener('click', () => toggle());
  cancelAll.addEventListener('click', () => queue.cancelAll());
  clearDone.addEventListener('click', () => queue.clearDone());

  const onDocDown = (e: MouseEvent): void => {
    if (panel.hidden) return;
    if (panel.contains(e.target as Node) || toggleBtn.contains(e.target as Node)) return;
    toggle(false);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !panel.hidden) toggle(false);
  };
  document.addEventListener('mousedown', onDocDown);
  document.addEventListener('keydown', onKey);

  queue.subscribe(render);
  render();
}
