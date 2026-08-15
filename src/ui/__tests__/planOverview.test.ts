import { describe, expect, it } from 'bun:test';
import { createPlanOverview, fitOverviewToHost, restoreStoredPosition, setOverviewPositionSession } from '../planOverview';
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
      // Drag support: geometry + pointer-capture spy (real DOM would resolve
      // offsetLeft against the positioned #view-container host).
      parentElement: null,
      style: {} as Record<string, string>,
      offsetLeft: 0,
      offsetTop: 0,
      offsetWidth: 0,
      offsetHeight: 0,
      getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
      setPointerCapture: () => { element._captureCount = (element._captureCount ?? 0) + 1; },
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
// builds aside > .plan-overview-card > (head, steps). Step rows live under
// the card's second child (.plan-overview-steps).
function cardOf(root: any): any {
  return root?.children?.[0];
}

function stepsOf(root: any): any[] {
  return cardOf(root)?.children?.[1]?.children ?? [];
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
      expect(compact.children[0].textContent).toBe('2');
      expect(compact.className).toContain('active');

      overview.setCollapsed(true);
      expect(card.hidden).toBe(true);
      expect(compact.hidden).toBe(false);
      expect(compact.children[0].textContent).toBe('2');
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
      expect(compact.children[0].textContent).toBe('1');
      expect(compact.className).toContain('awaiting');
      overview.setStatus('complete');
      expect(compact.children[0].textContent).toBe('3');
      expect(compact.className).toContain('complete');
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

describe('planOverview drag to reposition', () => {
  // Minimal event dispatch with bubbling up through parentElement, mirroring
  // how a pointerdown on a child (close) reaches the card's drag listener.
  function dispatch(el: any, type: string, init: Record<string, unknown> = {}): void {
    const event = {
      type,
      pointerId: init.pointerId ?? 1,
      button: init.button ?? 0,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
      preventDefault: () => {},
    };
    let node = el;
    while (node) {
      node._listeners?.[type]?.(event);
      node = node.parentElement;
    }
  }

  function setupHost(overview: any): void {
    // Mirrors the singleton anchor (#view-container, position: relative).
    overview.el.parentElement = { getBoundingClientRect: () => ({ width: 800, height: 600 }) };
    overview.el.offsetWidth = 252;
    overview.el.offsetHeight = 200;
    overview.el.offsetLeft = 12;
    overview.el.offsetTop = 12;
  }

  it('drags the expanded card to a clamped position inside the host', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 2, 1);
      setupHost(overview);
      const card = cardOf(overview.el);
      dispatch(card, 'pointerdown', { clientX: 100, clientY: 100 });
      dispatch(card, 'pointermove', { clientX: 160, clientY: 140 });
      expect(overview.el.style.left).toBe('72px');
      expect(overview.el.style.top).toBe('52px');
      expect(overview.el.style.right).toBe('auto');
      expect(overview.el.classList.contains('dragging')).toBe(true);
      // Over-drag past the host edge clamps to the host bounds.
      dispatch(card, 'pointermove', { clientX: 2000, clientY: 2000 });
      expect(overview.el.style.left).toBe('548px'); // 800 - 252
      expect(overview.el.style.top).toBe('400px'); // 600 - 200
      dispatch(card, 'pointerup', { clientX: 2000, clientY: 2000 });
      expect(overview.el.classList.contains('dragging')).toBe(false);
    } finally {
      restore();
    }
  });

  it('drags the compact circle once collapsed', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 2, 1);
      setupHost(overview);
      overview.setCollapsed(true);
      const compact = overview.el.children[1] as any;
      expect(compact.hidden).toBe(false);
      dispatch(compact, 'pointerdown', { clientX: 20, clientY: 20 });
      dispatch(compact, 'pointermove', { clientX: 70, clientY: 35 });
      expect(overview.el.style.left).toBe('62px');
      expect(overview.el.style.top).toBe('27px');
      dispatch(compact, 'pointerup', { clientX: 70, clientY: 35 });
    } finally {
      restore();
    }
  });

  it('toggles the compact circle on click but not after a real drag', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 2, 1);
      const card = cardOf(overview.el);
      const compact = overview.el.children[1] as any;
      overview.setCollapsed(true);
      // Plain click (no movement) expands.
      dispatch(compact, 'pointerdown', { clientX: 10, clientY: 10 });
      dispatch(compact, 'pointerup', { clientX: 10, clientY: 10 });
      dispatch(compact, 'click', {});
      expect(card.hidden).toBe(false);
      // Drag then release: the trailing click must NOT re-collapse.
      overview.setCollapsed(true);
      dispatch(compact, 'pointerdown', { clientX: 10, clientY: 10 });
      dispatch(compact, 'pointermove', { clientX: 60, clientY: 60 });
      dispatch(compact, 'pointerup', { clientX: 60, clientY: 60 });
      dispatch(compact, 'click', {});
      expect(card.hidden).toBe(true);
    } finally {
      restore();
    }
  });

  it('fits an already-positioned overview back inside the host after a resize', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      setupHost(overview);
      overview.el.style.left = '700px';
      overview.el.style.top = '500px';
      (overview.el as any).offsetLeft = 700;
      (overview.el as any).offsetTop = 500;
      fitOverviewToHost(overview.el);
      expect(overview.el.style.left).toBe('548px');
      expect(overview.el.style.top).toBe('400px');
    } finally {
      restore();
    }
  });

  it('keeps the close button clickable after pointer interactions', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 2, 1);
      setupHost(overview);
      overview.el.style.right = '12px';
      const card = cardOf(overview.el);
      const close = card.children[0].children[2];
      // A click on × goes through card pointerdown/pointerup (bubbled) then
      // its own click — the collapse must still fire without switching the
      // right-anchored widget into a new left/top position.
      dispatch(card, 'pointerdown', { clientX: 30, clientY: 30 });
      dispatch(card, 'pointerup', { clientX: 30, clientY: 30 });
      expect(overview.el.style.right).toBe('12px');
      expect(overview.el.style.left ?? '').toBe('');
      dispatch(close, 'click', {});
      expect(card.hidden).toBe(true);
      expect((overview.el.children[1] as any).hidden).toBe(false);
    } finally {
      restore();
    }
  });

  it('engages pointer capture only once a drag actually starts', () => {
    const restore = installFakeDocument();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 2, 1);
      overview.setCollapsed(true);
      const compact = overview.el.children[1] as any;
      // Plain press: no capture, so the subsequent click keeps its target.
      dispatch(compact, 'pointerdown', { clientX: 5, clientY: 5 });
      expect(compact._captureCount ?? 0).toBe(0);
      // Crossing the 4px threshold engages capture for the real drag.
      dispatch(compact, 'pointermove', { clientX: 30, clientY: 5 });
      expect(compact._captureCount).toBe(1);
      expect(overview.el.classList.contains('dragging')).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('planOverview dragged-position persistence', () => {
  function installFakeStorage(): () => void {
    const previous = (globalThis as any).localStorage;
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };
    return () => { (globalThis as any).localStorage = previous; };
  }

  function dispatch(el: any, type: string, init: Record<string, unknown> = {}): void {
    const event = {
      type,
      pointerId: init.pointerId ?? 1,
      button: init.button ?? 0,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
      preventDefault: () => {},
    };
    let node = el;
    while (node) {
      node._listeners?.[type]?.(event);
      node = node.parentElement;
    }
  }

  function setupHost(overview: any): void {
    overview.el.parentElement = { getBoundingClientRect: () => ({ width: 800, height: 600 }) };
    overview.el.offsetWidth = 252;
    overview.el.offsetHeight = 200;
    overview.el.offsetLeft = 12;
    overview.el.offsetTop = 12;
  }

  it('saves the dragged position so the next launch restores it', () => {
    const restoreDoc = installFakeDocument();
    const restoreStorage = installFakeStorage();
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 2, 1);
      setupHost(overview);
      const card = cardOf(overview.el);
      dispatch(card, 'pointerdown', { clientX: 100, clientY: 100 });
      dispatch(card, 'pointermove', { clientX: 160, clientY: 140 });
      dispatch(card, 'pointerup', { clientX: 160, clientY: 140 });
      const saved = JSON.parse((globalThis as any).localStorage.getItem('pure_plan_overview_pos'));
      expect(saved).toEqual({ left: 72, top: 52 });
    } finally {
      restoreDoc();
      restoreStorage();
    }
  });

  it('restores the stored position on launch and clamps it to the current host', () => {
    const restoreDoc = installFakeDocument();
    const restoreStorage = installFakeStorage();
    try {
      (globalThis as any).localStorage.setItem('pure_plan_overview_pos', JSON.stringify({ left: 5000, top: -20 }));
      const overview = createPlanOverview();
      const el = overview.el as any;
      el.parentElement = { getBoundingClientRect: () => ({ width: 800, height: 600 }) };
      el.offsetWidth = 252;
      el.offsetHeight = 200;
      restoreStoredPosition(el);
      expect(el.style.right).toBe('auto');
      expect(el.style.left).toBe('548px'); // 800 - 252
      expect(el.style.top).toBe('0px');
    } finally {
      restoreDoc();
      restoreStorage();
    }
  });

  it('ignores corrupt stored positions without touching the default corner', () => {
    const restoreDoc = installFakeDocument();
    const restoreStorage = installFakeStorage();
    try {
      (globalThis as any).localStorage.setItem('pure_plan_overview_pos', '{not json');
      const overview = createPlanOverview();
      const el = overview.el as any;
      restoreStoredPosition(el);
      expect(el.style.left ?? '').toBe('');
      expect(el.style.top ?? '').toBe('');
      // A plain click without movement never writes anything to storage.
      const card = cardOf(overview.el);
      dispatch(card, 'pointerdown', { clientX: 5, clientY: 5 });
      dispatch(card, 'pointerup', { clientX: 5, clientY: 5 });
      expect((globalThis as any).localStorage.getItem('pure_plan_overview_pos')).toBe('{not json');
    } finally {
      restoreDoc();
      restoreStorage();
    }
  });
});

describe('planOverview per-session position memory', () => {
  function installFakeStorage(): () => void {
    const previous = (globalThis as any).localStorage;
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };
    return () => { (globalThis as any).localStorage = previous; };
  }

  function dispatch(el: any, type: string, init: Record<string, unknown> = {}): void {
    const event = {
      type,
      pointerId: init.pointerId ?? 1,
      button: init.button ?? 0,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
      preventDefault: () => {},
    };
    let node = el;
    while (node) {
      node._listeners?.[type]?.(event);
      node = node.parentElement;
    }
  }

  function setupHost(overview: any): void {
    overview.el.parentElement = { getBoundingClientRect: () => ({ width: 800, height: 600 }) };
    overview.el.offsetWidth = 252;
    overview.el.offsetHeight = 200;
    overview.el.offsetLeft = 12;
    overview.el.offsetTop = 12;
  }

  it('saves the dragged position under the active session key', () => {
    const restoreDoc = installFakeDocument();
    const restoreStorage = installFakeStorage();
    setOverviewPositionSession('s1');
    try {
      const overview = createPlanOverview();
      overview.show(samplePlan(), 'active', 2, 1);
      setupHost(overview);
      const card = cardOf(overview.el);
      dispatch(card, 'pointerdown', { clientX: 100, clientY: 100 });
      dispatch(card, 'pointermove', { clientX: 160, clientY: 140 });
      dispatch(card, 'pointerup', { clientX: 160, clientY: 140 });
      const saved = JSON.parse((globalThis as any).localStorage.getItem('pure_plan_overview_pos:s1'));
      expect(saved).toEqual({ left: 72, top: 52 });
      // The global key stays untouched for other sessions.
      expect((globalThis as any).localStorage.getItem('pure_plan_overview_pos')).toBeNull();
    } finally {
      setOverviewPositionSession(null);
      restoreDoc();
      restoreStorage();
    }
  });

  it('restores each session\'s own remembered position', () => {
    const restoreDoc = installFakeDocument();
    const restoreStorage = installFakeStorage();
    setOverviewPositionSession('s1');
    try {
      (globalThis as any).localStorage.setItem('pure_plan_overview_pos:s1', JSON.stringify({ left: 30, top: 40 }));
      (globalThis as any).localStorage.setItem('pure_plan_overview_pos:s2', JSON.stringify({ left: 200, top: 300 }));
      const overview = createPlanOverview();
      const el = overview.el as any;
      restoreStoredPosition(el, 's1');
      expect(el.style.left).toBe('30px');
      expect(el.style.top).toBe('40px');
      // Switching sessions re-reads that session's key.
      restoreStoredPosition(el, 's2');
      expect(el.style.left).toBe('200px');
      expect(el.style.top).toBe('300px');
    } finally {
      setOverviewPositionSession(null);
      restoreDoc();
      restoreStorage();
    }
  });

  it('resets to the default corner for a session that never had a position', () => {
    const restoreDoc = installFakeDocument();
    const restoreStorage = installFakeStorage();
    setOverviewPositionSession('s1');
    try {
      (globalThis as any).localStorage.setItem('pure_plan_overview_pos:s1', JSON.stringify({ left: 30, top: 40 }));
      const overview = createPlanOverview();
      const el = overview.el as any;
      restoreStoredPosition(el, 's1');
      expect(el.style.left).toBe('30px');
      // s2 never had a position: inline placement must be cleared so the CSS
      // default (top-right corner) takes over — never the previous session's.
      restoreStoredPosition(el, 's2');
      expect(el.style.left ?? '').toBe('');
      expect(el.style.top ?? '').toBe('');
      expect(el.style.right ?? '').toBe('');
    } finally {
      setOverviewPositionSession(null);
      restoreDoc();
      restoreStorage();
    }
  });
});
