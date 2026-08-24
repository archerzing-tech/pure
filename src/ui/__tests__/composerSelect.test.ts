// src/ui/__tests__/composerSelect.test.ts
// Coverage for the custom composer dropdown (ComposerSelect): option sync,
// selection callback, popup open/close, and outside-click dismissal. The
// component exists because macOS WKWebView under Tauri's drag-drop handler
// dismisses native <select> popups instantly (models were unselectable).

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ComposerSelect } from '../composerSelect';

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

function makeHost(): HTMLElement {
  const host = document.createElement('div');
  host.className = 'composer-select-host';
  document.body.appendChild(host);
  return host;
}

describe('ComposerSelect', () => {
  it('renders a trigger and selects the first option when no match given', () => {
    const host = makeHost();
    const cs = new ComposerSelect(host, () => {});
    cs.setOptions([
      { value: 'a::0', label: 'model-a', hint: 'Provider A' },
      { value: 'b::0', label: 'model-b', hint: 'Provider B' },
    ]);
    expect(host.querySelector('.cs-trigger')).not.toBeNull();
    expect(cs.getValue()).toBe('a::0');
    expect(host.querySelector('.cs-trigger-label')?.textContent).toBe('model-a');
  });

  it('keeps the requested selection when it matches an option', () => {
    const host = makeHost();
    const cs = new ComposerSelect(host, () => {});
    cs.setOptions([
      { value: 'a::0', label: 'model-a' },
      { value: 'b::1', label: 'model-b' },
    ], 'b::1');
    expect(cs.getValue()).toBe('b::1');
    expect(host.querySelector('.cs-trigger-label')?.textContent).toBe('model-b');
  });

  it('opens the popup on trigger click and closes after choosing', () => {
    const host = makeHost();
    let chosen = '';
    const cs = new ComposerSelect(host, (value) => { chosen = value; });
    cs.setOptions([
      { value: 'x::0', label: 'model-x' },
      { value: 'y::0', label: 'model-y' },
    ], 'x::0');
    const trigger = host.querySelector<HTMLButtonElement>('.cs-trigger')!;
    trigger.click();
    expect(document.querySelector('.cs-popup')).not.toBeNull();
    const items = document.querySelectorAll<HTMLElement>('.cs-item');
    expect(items.length).toBe(2);
    items[1].click();
    expect(chosen).toBe('y::0');
    expect(cs.getValue()).toBe('y::0');
    expect(document.querySelector('.cs-popup')).toBeNull();
  });

  it('does not fire the callback when re-selecting the current value', () => {
    const host = makeHost();
    let calls = 0;
    const cs = new ComposerSelect(host, () => { calls++; });
    cs.setOptions([{ value: 'm::0', label: 'only' }], 'm::0');
    const trigger = host.querySelector<HTMLButtonElement>('.cs-trigger')!;
    trigger.click();
    document.querySelector<HTMLElement>('.cs-item')!.click();
    expect(calls).toBe(0);
  });

  it('closes the popup on outside mousedown', () => {
    const host = makeHost();
    const cs = new ComposerSelect(host, () => {});
    cs.setOptions([{ value: 'a::0', label: 'model-a' }]);
    host.querySelector<HTMLButtonElement>('.cs-trigger')!.click();
    expect(document.querySelector('.cs-popup')).not.toBeNull();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.cs-popup')).toBeNull();
  });

  it('positions the popup with fixed coordinates inside the viewport', () => {
    const host = makeHost();
    const cs = new ComposerSelect(host, () => {});
    cs.setOptions([
      { value: 'a::0', label: 'model-a' },
      { value: 'b::0', label: 'model-b' },
    ]);
    host.querySelector<HTMLButtonElement>('.cs-trigger')!.click();
    const popup = document.querySelector<HTMLElement>('.cs-popup')!;
    expect(popup.style.left).not.toBe('');
    expect(popup.style.top).not.toBe('');
    expect(parseFloat(popup.style.left)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(popup.style.top)).toBeGreaterThanOrEqual(8);
    expect(popup.getAttribute('role')).toBe('listbox');
  });

  it('replaces options via setOptions without duplicating listeners', () => {
    const host = makeHost();
    let calls = 0;
    const cs = new ComposerSelect(host, () => { calls++; });
    cs.setOptions([{ value: 'a::0', label: 'one' }]);
    cs.setOptions([
      { value: 'b::0', label: 'two' },
      { value: 'c::0', label: 'three' },
    ]);
    expect(cs.getValue()).toBe('b::0');
    const trigger = host.querySelector<HTMLButtonElement>('.cs-trigger')!;
    trigger.click();
    expect(document.querySelectorAll('.cs-item').length).toBe(2);
    document.querySelectorAll<HTMLElement>('.cs-item')[1].click();
    expect(calls).toBe(1);
  });
});
