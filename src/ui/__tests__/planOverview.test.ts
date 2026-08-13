import { describe, expect, it } from 'bun:test';
import { createPlanOverview } from '../planOverview';
import type { Plan } from '../../coding-agent/types';

function installFakeDocument(): () => void {
  const previous = (globalThis as any).document;
  const createElement = (tag: string): any => {
    const classes = new Set<string>();
    let serialized = '';
    // Real DOM keeps element-only children and all childNodes as separate
    // arrays; pushing an item into both must push exactly once per array.
    const children: any[] = [];
    const childNodes: any[] = [];
    const element: any = {
      // Each element owns its own class set (like a real DOM node).
      _classListSync: () => { element.className = serialized = [...classes].join(' '); },
      tagName: tag.toUpperCase(),
      children,
      childNodes,
      dataset: {},
      set className(value: string) {
        this._className = value;
        serialized = value;
        classes.clear();
        value.split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
      },
      get className(): string { return this._className ?? ''; },
      open: false,
      hidden: false,
      isConnected: true,
      set textContent(value: string) {
        // Rebuilding a list (steps.textContent = '') must drop old children,
        // like the real DOM does.
        this._textContent = value;
        if (value === '') {
          children.length = 0;
          childNodes.length = 0;
        }
      },
      get textContent(): string { return this._textContent ?? ''; },
      classList: {
        add: (...names: string[]) => { names.forEach((name) => classes.add(name)); element._classListSync(); },
        remove: (...names: string[]) => { names.forEach((name) => classes.delete(name)); element._classListSync(); },
        contains: (name: string) => classes.has(name),
        toggle: (name: string, force?: boolean) => {
          const on = force ?? !classes.has(name);
          if (on) classes.add(name); else classes.delete(name);
          element._classListSync();
          return on;
        },
      },
      append: (...items: any[]) => items.forEach((item) => { children.push(item); childNodes.push(item); }),
      appendChild: (item: any) => { children.push(item); childNodes.push(item); return item; },
      _listeners: {} as Record<string, () => void>,
      addEventListener: (name: string, listener: () => void) => { element._listeners[name] = listener; },
      setAttribute: (name: string, value: string) => {
        element[name] = value;
        if (name.startsWith('data-')) element.dataset[name.slice(5)] = value;
      },
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    return element;
  };
  (globalThis as any).document = { createElement };
  return () => { (globalThis as any).document = previous; };
}

function samplePlan(): Plan {
  return {
    steps: [
      { id: '1', action: '了解需求', description: 'd', expectedOutcome: 'o' },
      { id: '2', action: '设计方案', description: 'd', expectedOutcome: 'o' },
      { id: '3', action: '实现功能', description: 'd', expectedOutcome: 'o' },
    ],
    reasoning: 'r',
  };
}

// The fake document's appendChild returns the child, and createPlanOverview
// builds aside > .plan-overview-card > (head, activity, steps). Step rows live
// under the card's third child (.plan-overview-steps).
function cardOf(root: any): any {
  return root?.children?.[0];
}

function stepsOf(root: any): any[] {
  return cardOf(root)?.children?.[2]?.children ?? [];
}

function stepClasses(root: any): string[] {
  return stepsOf(root).map((s: any) => s.className);
}

describe('planOverview floating outline card', () => {
  it('renders a step list with the active step highlighted', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 2, 1, '拆模块');
      expect(overview.el.hidden).toBe(false);
      const classes = stepClasses(overview.el);
      expect(classes[0]).toBe('plan-overview-step done');
      expect(classes[1]).toContain('active');
      expect(classes[2]).toContain('pending');
      expect(cardOf(overview.el).className).toContain('active');
    } finally {
      restore();
    }
  });

  it('collapses to an execution status chip and expands on click', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 2, 1, '实现功能');
      const card = cardOf(overview.el);
      const compact = overview.el.children[1] as any;
      expect(card.hidden).toBe(false);
      expect(compact.hidden).toBe(true);
      expect(compact.children[1].textContent).toBe('执行中：实现功能');
      expect(compact.children[2].textContent).toBe('1/3');

      overview.setCollapsed(true);
      expect(card.hidden).toBe(true);
      expect(compact.hidden).toBe(false);
      expect(compact.children[1].textContent).toBe('执行中：实现功能');
      compact._listeners.click();
      expect(card.hidden).toBe(false);
      expect(compact.hidden).toBe(true);
    } finally {
      restore();
    }
  });

  it('keeps the collapsed status chip synchronized with waiting and completion', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 1, 1);
      overview.setCollapsed(true);
      overview.setStatus('waiting');
      const compact = overview.el.children[1] as any;
      expect(compact.children[1].textContent).toBe('等待回复');
      overview.setStatus('complete');
      expect(compact.children[1].textContent).toBe('执行完成');
      expect(compact.children[2].textContent).toBe('3/3');
    } finally {
      restore();
    }
  });

  it('switches to the waiting state at a plan pause', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 1, 1);
      overview.setStatus('waiting');
      expect(cardOf(overview.el).className).toContain('awaiting');
    } finally {
      restore();
    }
  });

  it('flips back to executing when the user sends the next message', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 1, 1);
      overview.setStatus('waiting');
      expect(cardOf(overview.el).className).toContain('awaiting');
      // The continuation path calls update(plan, 'active', ...): the awaiting
      // visual must clear and the active one must take over.
      overview.update(samplePlan(), 'active', 1, 1, '开始第一个 Todo');
      const card = cardOf(overview.el);
      expect(card.className).toContain('active');
      expect(card.className).not.toContain('awaiting');
      const activity = card?.children?.[1];
      expect(activity.textContent).toBe('正在执行：开始第一个 Todo');
    } finally {
      restore();
    }
  });

  it('marks everything done on completion', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 1, 1);
      overview.setStatus('complete');
      const card = cardOf(overview.el);
      expect(card.className).toContain('complete');
      const doneRows = stepsOf(overview.el).filter((s: any) => s.className.includes('done'));
      expect(doneRows.length).toBe(3);
    } finally {
      restore();
    }
  });

  it('clears and hides on reset', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 1, 1);
      overview.clear();
      expect(overview.el.hidden).toBe(true);
    } finally {
      restore();
    }
  });

  it('advances the current step with setCurrent', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 1, 1);
      overview.setCurrent(2, 1, '拆模块');
      const classes = stepClasses(overview.el);
      expect(classes[0]).toBe('plan-overview-step done');
      expect(classes[1]).toContain('active');
    } finally {
      restore();
    }
  });
});
