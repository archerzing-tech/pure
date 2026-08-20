import { describe, expect, it } from 'bun:test';
import { createRequestReviewCard, formatRequestReviewSection, hasFlaggedReviewItems, shouldPauseForRequestReview, shouldShowRequestReview, flaggedReviewItems, type RequestReviewItem } from '../requestReview';

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
      append: (...items: any[]) => items.forEach((item) => { item.parentNode = element; element.children.push(item); element.childNodes.push(item); }),
      appendChild: (item: any) => { item.parentNode = element; element.children.push(item); element.childNodes.push(item); return item; },
      addEventListener: (name: string, fn: () => void) => {
        if (!handlers.has(element)) handlers.set(element, {});
        handlers.get(element)![name] = fn;
      },
      setAttribute: (name: string, value: string) => {
        element[name] = value;
        if (name.startsWith('data-')) element.dataset[name.slice(5)] = value;
      },
      remove: () => {
        if (element.parentNode) {
          element.parentNode.children = element.parentNode.children.filter((c: any) => c !== element);
          element.parentNode.childNodes = element.parentNode.childNodes.filter((c: any) => c !== element);
          element.parentNode = null;
        }
      },
      querySelectorAll: (sel: string) => element.children.filter((c: any) => c.className?.includes(sel.split(' ')[1] ?? '')),
    };
    return element;
  };
  (globalThis as any).document = { createElement };
  return { handlers, restore: () => { (globalThis as any).document = previous; } };
}

const mixed: RequestReviewItem[] = [
  { part: '直接删除旧版本目录', verdict: 'unreasonable', reason: '有迁移脚本在引用', suggestion: '先归档再删除' },
  { part: '保留新功能接口', verdict: 'reasonable', reason: '与现有架构一致' },
];

describe('requestReview card', () => {
  it('shows a subjective scope concern without interrupting execution', () => {
    const buildAssessment = {
      intent: 'build' as const,
      riskLevel: 'medium' as const,
      reversibility: 'partially-reversible' as const,
      impact: 'isolated prototype files',
      recommendation: 'build incrementally',
      requiresProbe: true,
      requiresConfirmation: false,
    };
    const concern = [{ part: '生成四个独立原型', verdict: 'questionable' as const, reason: '范围较大' }];
    // The model's concern is surfaced — the user gets to see it…
    expect(shouldShowRequestReview(concern)).toBe(true);
    // …but a subjective opinion never forces the turn to pause.
    expect(shouldPauseForRequestReview(concern, buildAssessment, false)).toBe(false);
  });

  it('keeps real traps and destructive or migration risks pausing', () => {
    const buildAssessment = {
      intent: 'build' as const,
      riskLevel: 'low' as const,
      reversibility: 'reversible' as const,
      impact: 'isolated prototype files',
      recommendation: 'proceed',
      requiresProbe: false,
      requiresConfirmation: false,
    };
    const destructiveAssessment = {
      ...buildAssessment,
      intent: 'delete' as const,
      riskLevel: 'high' as const,
      reversibility: 'irreversible' as const,
      requiresProbe: true,
      requiresConfirmation: true,
    };
    const flagged = [{ part: '删除旧目录', verdict: 'unreasonable' as const, reason: '不可逆' }];
    expect(shouldShowRequestReview(flagged)).toBe(true);
    expect(shouldPauseForRequestReview(flagged, buildAssessment, true)).toBe(true);
    expect(shouldPauseForRequestReview(flagged, destructiveAssessment, false)).toBe(true);
  });

  it('pauses only on a genuine blocker, never on an opinion', () => {
    const buildAssessment = {
      intent: 'build' as const,
      riskLevel: 'low' as const,
      reversibility: 'reversible' as const,
      impact: 'isolated prototype files',
      recommendation: 'proceed',
      requiresProbe: false,
      requiresConfirmation: false,
    };
    // Subjective doubts stay non-blocking, including under medium risk.
    expect(shouldPauseForRequestReview([{ part: '风格差异大', verdict: 'questionable' as const, reason: '可能不统一' }], buildAssessment, false)).toBe(false);
    expect(shouldPauseForRequestReview([{ part: '范围较大', verdict: 'questionable' as const, reason: '需要更多时间' }], { ...buildAssessment, riskLevel: 'medium' }, false)).toBe(false);
    // An explicitly unreasonable verdict (infeasible / self-contradictory /
    // destructive to existing work) does pause for a decision.
    expect(shouldPauseForRequestReview([{ part: '删除被引用的目录', verdict: 'unreasonable' as const, reason: '迁移脚本在引用' }], buildAssessment, false)).toBe(true);
  });

  it('flags only non-reasonable items', () => {
    expect(hasFlaggedReviewItems(mixed)).toBe(true);
    expect(hasFlaggedReviewItems([{ part: 'A', verdict: 'reasonable', reason: '' }])).toBe(false);
    expect(flaggedReviewItems(mixed).map((i) => i.part)).toEqual(['直接删除旧版本目录']);
  });

  const kids = (el: any): any[] => el.children as any[];

  it('renders a compact ok line when nothing needs a decision', () => {
    const { restore } = installFakeDocument();
    const handle = createRequestReviewCard([]);
    expect(kids(kids(handle.el)[0])[1].children[0].className).toContain('request-review-ok');
    restore();
  });

  it('renders one row per item with verdict styling', () => {
    const { restore } = installFakeDocument();
    const handle = createRequestReviewCard(mixed);
    const body = kids(kids(handle.el)[0])[1];
    expect(kids(body)).toHaveLength(2);
    expect(kids(body)[0].className).toContain('request-review-unreasonable');
    expect(kids(body)[1].className).toContain('request-review-reasonable');
    expect(kids(kids(body)[0])[1].children[0].textContent).toContain('直接删除旧版本目录');
    restore();
  });

  it('no decision buttons until enableDecisions is called', () => {
    const { restore } = installFakeDocument();
    const handle = createRequestReviewCard(mixed);
    expect(kids(handle.el).some((c: any) => c.className === 'request-review-actions')).toBe(false);
    restore();
  });

  it('enableDecisions adds buttons that fire once and lock', () => {
    const { handlers, restore } = installFakeDocument();
    const handle = createRequestReviewCard(mixed);
    let adjustCalls = 0;
    let proceedCalls = 0;
    handle.enableDecisions(
      () => { adjustCalls += 1; return true; },
      () => { proceedCalls += 1; return true; },
    );
    const actions = kids(handle.el).find((c: any) => c.className === 'request-review-actions');
    expect(actions).toBeTruthy();
    const buttons = kids(actions).filter((c: any) => c.tagName === 'BUTTON');
    expect(buttons).toHaveLength(2);
    // Fire adjust twice — the second click must be ignored (locked).
    handlers.get(buttons[0])!.click();
    handlers.get(buttons[0])!.click();
    expect(adjustCalls).toBe(1);
    expect(buttons[0].disabled).toBe(true);
    expect(proceedCalls).toBe(0);
    restore();
  });

  it('setDecided removes the decision bar and records the outcome', () => {
    const { restore } = installFakeDocument();
    const handle = createRequestReviewCard(mixed);
    handle.enableDecisions(() => true, () => true);
    handle.setDecided('已按你的决策继续');
    expect(kids(handle.el).some((c: any) => c.className === 'request-review-actions')).toBe(false);
    expect(kids(handle.el).some((c: any) => c.className === 'request-review-decided')).toBe(true);
    restore();
  });
});

describe('formatRequestReviewSection', () => {
  it('returns empty when nothing is flagged (never pollutes the pause message)', () => {
    expect(formatRequestReviewSection([{ part: 'A', verdict: 'reasonable', reason: '' }])).toBe('');
    expect(formatRequestReviewSection([])).toBe('');
  });

  it('summarizes flagged items with suggestions for the model context', () => {
    const section = formatRequestReviewSection(mixed);
    expect(section).toContain('<request_review>');
    expect(section).toContain('[不合理] 直接删除旧版本目录');
    expect(section).toContain('建议：先归档再删除');
    expect(section).not.toContain('保留新功能接口'); // reasonable parts stay out
  });
});
