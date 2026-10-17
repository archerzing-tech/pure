// src/ui/__tests__/taskCheckboxes.test.ts
// GFM task-list checkbox interaction: `- [ ]` must arrive as a live checkbox,
// not a dead disabled control. Rendering pipeline under test is
// markdown.ts's bindTaskCheckboxes (exported for this test) + the DOMPurify
// pass it runs behind — verified end-to-end through renderMarkdown's sanitize
// config shape (ADD_ATTR target/loading) since that's what ships.
import { describe, it, expect, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { marked } from 'marked';
import { bindTaskCheckboxes } from '../markdown';

GlobalRegistrator.register();
afterAll(() => {
  GlobalRegistrator.unregister();
});

// Minimal re-implementation of the sanitize call in renderMarkdown — the real
// one is exercised in chat-level tests; here we pin that nothing in the
// checkbox markup is sanitize-hostile (no ADD_ATTR needed for task lists).
function renderToDom(mdText: string): HTMLElement {
  const html = marked.parse(mdText, { gfm: true, breaks: true }) as string;
  const el = document.createElement('div');
  // DOMPurify default config, same as pure's call site plus its two attrs.
  // Importing dompurify here keeps the test honest about what survives it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const createDOMPurify = require('dompurify') as (w: Window) => { sanitize: (s: string, o?: object) => string };
  const clean = createDOMPurify(window).sanitize(html, { ADD_ATTR: ['target', 'loading'] });
  el.innerHTML = clean;
  return el;
}

describe('GFM task list checkboxes', () => {
  it('marked emits disabled checkboxes that survive DOMPurify', () => {
    const el = renderToDom('- [ ] 未完成项\n- [x] 已完成项');
    const boxes = el.querySelectorAll<HTMLInputElement>('li > input[type="checkbox"]');
    expect(boxes.length).toBe(2);
    // Both arrive disabled (marked's output); bindTaskCheckboxes re-enables.
    expect(boxes[0].hasAttribute('disabled')).toBe(true);
    expect(boxes[1].hasAttribute('checked')).toBe(true);
  });

  it('bindTaskCheckboxes enables boxes and marks authored-done items', () => {
    const el = renderToDom('- [ ] 买牛奶\n- [x] 写周报\n- 普通项');
    bindTaskCheckboxes(el);
    const boxes = el.querySelectorAll<HTMLInputElement>('li > input[type="checkbox"]');
    expect(boxes.length).toBe(2);
    for (const b of boxes) expect(b.hasAttribute('disabled')).toBe(false);
    const lis = el.querySelectorAll('li.task-item');
    expect(lis.length).toBe(2);
    expect(el.querySelectorAll('li.task-done').length).toBe(1);
    // The plain list item stays untouched.
    expect(el.querySelectorAll('li').length).toBe(3);
  });

  it('clicking a checkbox toggles the done style on its <li>', () => {
    const el = renderToDom('- [ ] 待办一\n- [ ] 待办二');
    bindTaskCheckboxes(el);
    const boxes = el.querySelectorAll<HTMLInputElement>('li > input[type="checkbox"]');
    // click() flips checked (true) BEFORE dispatching — the listener sees the
    // post-toggle state, same as a real browser.
    boxes[0].click();
    expect(boxes[0].closest('li')!.classList.contains('task-done')).toBe(true);
    boxes[0].click();
    expect(boxes[0].closest('li')!.classList.contains('task-done')).toBe(false);
  });
});
