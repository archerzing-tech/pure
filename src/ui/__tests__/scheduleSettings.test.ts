import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { defaults, invalidateConfigCache, STORAGE_KEY } from '../config';
import { renderSchedulesSettings } from '../scheduleSettings';

const storage = new Map<string, string>();

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { location: { search: '' } } });
  invalidateConfigCache();
});

afterEach(() => {
  invalidateConfigCache();
  delete (globalThis as any).localStorage;
  delete (globalThis as any).window;
});

function seed(schedules: unknown[]): void {
  storage.set(STORAGE_KEY, JSON.stringify({ ...defaults(), schedules, configVersion: 13 }));
  invalidateConfigCache();
}

describe('schedule settings interactions', () => {
  it('adds a default schedule and notifies the host', () => {
    seed([]);
    const host = document.createElement('div');
    let changes = 0;
    renderSchedulesSettings(host, () => { changes++; });

    (host.querySelector('.schedule-add') as HTMLButtonElement).click();

    const cfg = JSON.parse(storage.get(STORAGE_KEY)!);
    expect(cfg.schedules).toHaveLength(1);
    expect(cfg.schedules[0].kind).toBe('daily');
    expect(cfg.schedules[0].time).toBe('09:00');
    expect(cfg.schedules[0].enabled).toBe(true);
    expect(changes).toBe(1);
  });

  it('deletes the selected schedule without resurrecting it', () => {
    seed([{ id: 'a', text: 'first', kind: 'daily', time: '09:00', enabled: true }]);
    const host = document.createElement('div');
    let changes = 0;
    renderSchedulesSettings(host, () => { changes++; });

    (host.querySelector('.schedule-delete') as HTMLButtonElement).click();

    const cfg = JSON.parse(storage.get(STORAGE_KEY)!);
    expect(cfg.schedules).toEqual([]);
    expect(changes).toBe(1);
  });

  it('persists interval edits and clamps invalid minutes to one', () => {
    seed([{ id: 'a', text: 'poll', kind: 'daily', time: '09:00', enabled: true }]);
    const host = document.createElement('div');
    renderSchedulesSettings(host, () => {});

    const kind = host.querySelector('.schedule-kind') as HTMLSelectElement;
    kind.value = 'interval';
    kind.dispatchEvent(new Event('change'));
    renderSchedulesSettings(host, () => {});
    const minutes = host.querySelector('.schedule-minutes') as HTMLInputElement;
    minutes.value = '0';
    minutes.dispatchEvent(new Event('change'));

    const cfg = JSON.parse(storage.get(STORAGE_KEY)!);
    expect(cfg.schedules[0].kind).toBe('interval');
    expect(cfg.schedules[0].minutes).toBe(1);
  });
});
