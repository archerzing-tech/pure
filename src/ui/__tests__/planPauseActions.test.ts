import { describe, expect, it } from 'bun:test';
import { attachPlanPauseActions } from '../planPauseActions';

function installFakeDocument(): { handlers: Map<any, Record<string, () => void>>; restore: () => void } {
  const previous = (globalThis as any).document;
  const handlers = new Map<any, Record<string, () => void>>();
  const createElement = (tag: string): any => {
    const element: any = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      disabled: false,
      children: [],
      childNodes: [],
      dataset: {},
      append: (...items: any[]) => items.forEach((item) => { element.children.push(item); element.childNodes.push(item); }),
      appendChild: (item: any) => { element.children.push(item); element.childNodes.push(item); return item; },
      addEventListener: (name: string, fn: () => void) => {
        if (!handlers.has(element)) handlers.set(element, {});
        handlers.get(element)![name] = fn;
      },
      setAttribute: (name: string, value: string) => {
        element[name] = value;
        if (name.startsWith('data-')) element.dataset[name.slice(5)] = value;
      },
    };
    return element;
  };
  (globalThis as any).document = { createElement };
  return { handlers, restore: () => { (globalThis as any).document = previous; } };
}

function click(el: any, handlers: Map<any, Record<string, () => void>>): void {
  handlers.get(el)?.click?.();
}

describe('plan pause action shortcuts', () => {
  it('renders a continue and a cancel button on the bubble row', () => {
    const { restore } = installFakeDocument();
    try {
      const row: any = { children: [], appendChild: (item: any) => { row.children.push(item); return item; } };
      const actions = attachPlanPauseActions(row, () => true, () => true);
      expect(row.children).toHaveLength(1);
      const bar = row.children[0];
      expect(bar.className).toBe('plan-pause-actions');
      const buttons = bar.children;
      expect(buttons).toHaveLength(2);
      expect(buttons[0].textContent).toBe('继续执行');
      expect(buttons[1].textContent).toBe('取消计划');
      expect(actions.continueBtn.disabled).toBe(false);
      expect(actions.cancelBtn.disabled).toBe(false);
    } finally {
      restore();
    }
  });

  it('fires the continue handler once and locks both buttons', () => {
    const { handlers, restore } = installFakeDocument();
    try {
      let continues = 0;
      const row: any = { children: [], appendChild: (item: any) => { row.children.push(item); return item; } };
      const actions = attachPlanPauseActions(row, () => { continues++; return true; }, () => true);
      click(actions.continueBtn, handlers);
      click(actions.continueBtn, handlers); // double click must be inert
      expect(continues).toBe(1);
      expect(actions.continueBtn.disabled).toBe(true);
      expect(actions.cancelBtn.disabled).toBe(true);
    } finally {
      restore();
    }
  });

  it('does not lock the buttons when the action bails early (streaming)', () => {
    const { handlers, restore } = installFakeDocument();
    try {
      let attempts = 0;
      const row: any = { children: [], appendChild: (item: any) => { row.children.push(item); return item; } };
      // Handler reports the action did NOT run — buttons must stay enabled so
      // the user can retry.
      const actions = attachPlanPauseActions(row, () => { attempts++; return false; }, () => true);
      click(actions.continueBtn, handlers);
      expect(attempts).toBe(1);
      expect(actions.continueBtn.disabled).toBe(false);
      expect(actions.cancelBtn.disabled).toBe(false);
    } finally {
      restore();
    }
  });

  it('fires the cancel handler once and locks both buttons', () => {
    const { handlers, restore } = installFakeDocument();
    try {
      let cancels = 0;
      const row: any = { children: [], appendChild: (item: any) => { row.children.push(item); return item; } };
      const actions = attachPlanPauseActions(row, () => true, () => { cancels++; return true; });
      click(actions.cancelBtn, handlers);
      click(actions.cancelBtn, handlers);
      expect(cancels).toBe(1);
      expect(actions.continueBtn.disabled).toBe(true);
      expect(actions.cancelBtn.disabled).toBe(true);
    } finally {
      restore();
    }
  });
});
