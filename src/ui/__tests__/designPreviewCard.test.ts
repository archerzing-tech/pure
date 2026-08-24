// src/ui/__tests__/designPreviewCard.test.ts
// Design-first builds: the preview card must show the mockup in a sandboxed
// iframe and route confirmation back to the caller exactly once.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createDesignPreviewCard } from '../designPreviewCard';

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('designPreviewCard', () => {
  it('renders the mockup in a sandboxed iframe with the file name', () => {
    const card = createDesignPreviewCard('<h1>三蹦子官网</h1>', 'design.html', () => {});
    document.body.appendChild(card.el);
    const frame = card.el.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame!.getAttribute('srcdoc')).toContain('三蹦子官网');
    expect(card.el.textContent).toContain('设计稿预览');
    expect(card.el.textContent).toContain('design.html');
    card.el.remove();
  });

  it('fires onConfirm once per click and locks the button after confirming', () => {
    let calls = 0;
    const card = createDesignPreviewCard('<p>x</p>', 'design.html', () => { calls++; });
    document.body.appendChild(card.el);
    const confirm = card.el.querySelector<HTMLButtonElement>('.design-preview-confirm')!;
    confirm.click();
    confirm.click();
    expect(calls).toBe(1);
    expect(confirm.disabled).toBe(true);
    card.setConfirmed();
    expect(card.el.classList.contains('confirmed')).toBe(true);
    card.el.remove();
  });
});
