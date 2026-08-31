// src/ui/scheduleSettings.ts
// 定时任务设置页: list + add/delete of ScheduleDef rows (kind, trigger field,
// task text, enabled). Edits are applied straight to the persisted config and
// the panel's onChange fires so main.ts re-arms the Scheduler immediately.
// Reads the live config on every interaction (not a snapshot), so stale row
// closures can never resurrect a deleted schedule.

import { defaults, invalidateConfigCache, loadConfig, persistConfig, type ScheduleDef } from './config';
import { t } from '../shared/i18n';
import { parseHhMm } from './scheduler';

let seq = 0;
function nextScheduleId(): string {
  return `sch${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

/** Re-read config, mutate cfg.schedules by id, persist, notify. */
function applyById(id: string, patch: Partial<ScheduleDef>, onChange: () => void): void {
  const cfg = loadConfig() ?? defaults();
  cfg.schedules = cfg.schedules ?? [];
  const target = cfg.schedules.find((x) => x.id === id);
  if (target) Object.assign(target, patch);
  persistConfig(cfg);
  invalidateConfigCache();
  onChange();
}

export function renderSchedulesSettings(host: HTMLElement, onChange: () => void): void {
  host.replaceChildren();

  const hint = document.createElement('p');
  hint.className = 'settings-page-desc schedule-hint';
  hint.textContent = t('schedule.hint');
  host.appendChild(hint);

  const list = document.createElement('div');
  list.className = 'schedule-list';
  host.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'setting-btn secondary schedule-add';
  addBtn.textContent = t('schedule.add');
  addBtn.addEventListener('click', () => {
    const cfg = loadConfig() ?? defaults();
    cfg.schedules = cfg.schedules ?? [];
    cfg.schedules.push({ id: nextScheduleId(), text: '', kind: 'daily', time: '09:00', enabled: true });
    persistConfig(cfg);
    invalidateConfigCache();
    onChange();
  });
  host.appendChild(addBtn);

  const renderRow = (s: ScheduleDef): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'schedule-row';

    const kind = document.createElement('select');
    kind.className = 'schedule-kind';
    const optDaily = document.createElement('option');
    optDaily.value = 'daily';
    optDaily.textContent = t('schedule.kind.daily');
    const optInterval = document.createElement('option');
    optInterval.value = 'interval';
    optInterval.textContent = t('schedule.kind.interval');
    kind.append(optDaily, optInterval);
    kind.value = s.kind;
    kind.addEventListener('change', () =>
      applyById(s.id, { kind: kind.value === 'interval' ? 'interval' : 'daily' }, onChange));

    const timeInput = document.createElement('input');
    timeInput.type = 'time';
    timeInput.className = 'schedule-time';
    timeInput.value = parseHhMm(s.time ?? '') ? s.time! : '09:00';
    timeInput.title = t('schedule.timeTitle');
    timeInput.addEventListener('change', () => applyById(s.id, { time: timeInput.value || undefined }, onChange));

    const minutesInput = document.createElement('input');
    minutesInput.type = 'number';
    minutesInput.min = '1';
    minutesInput.className = 'schedule-minutes';
    minutesInput.value = String(s.minutes ?? 30);
    minutesInput.title = t('schedule.minutesTitle');
    minutesInput.addEventListener('change', () =>
      applyById(s.id, { minutes: Math.max(1, Math.floor(Number(minutesInput.value) || 1)) }, onChange));

    const trigger = document.createElement('span');
    trigger.className = 'schedule-trigger';
    trigger.append(s.kind === 'daily' ? timeInput : minutesInput);

    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'schedule-text';
    text.placeholder = t('schedule.textPlaceholder');
    text.value = s.text;
    text.addEventListener('change', () => applyById(s.id, { text: text.value }, onChange));

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.className = 'schedule-enabled';
    enabled.checked = s.enabled !== false;
    enabled.title = t('schedule.enabled');
    enabled.addEventListener('change', () => applyById(s.id, { enabled: enabled.checked }, onChange));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'schedule-delete';
    del.textContent = '✕';
    del.title = t('schedule.delete');
    del.addEventListener('click', function() {
      const cfg = loadConfig() ?? defaults();
      cfg.schedules = (cfg.schedules ?? []).filter((x) => x.id !== s.id);
      persistConfig(cfg);
      invalidateConfigCache();
      onChange();
    });

    row.append(kind, trigger, text, enabled, del);
    return row;
  };

  for (const s of (loadConfig() ?? defaults()).schedules ?? []) {
    list.appendChild(renderRow(s));
  }
}
