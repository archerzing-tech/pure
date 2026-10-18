// src/ui/__tests__/taskCheckboxes.test.ts
// GFM task-list checkbox interaction: `- [ ]` must arrive as a live checkbox,
// not a dead disabled control. The behavior under test is bindTaskCheckboxes
// (exported from markdown.ts for this file): strip disabled, tag the <li>,
// toggle a done class on click.
//
// Deliberately does NOT import dompurify: streaming test files
// mock.module('dompurify') as an identity OBJECT, bun test is single-process,
// and a later-loading file that calls createDOMPurify(window) dies on the mock
// (2026-10-18 full-suite case). The marked output is injected as-is here; the
// fact that DOMPurify's default allow-list keeps input[type=checkbox] (with
// disabled/checked attrs) is library behavior, not pure's contract.
import { describe, it, expect, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { marked } from 'marked';
import { bindTaskCheckboxes } from '../markdown';

GlobalRegistrator.register();
afterAll(() => {
  GlobalRegistrator.unregister();
});

function renderToDom(mdText: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = marked.parse(mdText, { gfm: true, breaks: true }) as string;
  return el;
}

describe('GFM task list checkboxes', () => {
  it('marked emits disabled checkboxes for - [ ] / - [x]', () => {
    const el = renderToDom('- [ ] 未完成项\n- [x] 已完成项');
    const boxes = el.querySelectorAll<HTMLInputElement>('li > input[type="checkbox"]');
    expect(boxes.length).toBe(2);
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
