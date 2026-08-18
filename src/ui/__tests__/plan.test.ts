// src/ui/__tests__/plan.test.ts
// Covers the pure helper that turns an approved plan into a system-prompt
// fragment. (The dialog controller itself is DOM-bound and exercised manually.)

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createPlanCard, createRestoredPlanCard, formatPlanForPrompt, formatPlanContinuation, formatPlanPauseMessage, matchPlanPhaseMarker, matchPlanProgressMarkers, matchPlanSubstepMarker, matchPlanSubstepMarkers, QUALITY_GATE_STEPS, updatePlanCardPhase, updatePlanCardSubstep, completePlanCardSubstep, canCompletePlanCardSubsteps, completePlanCardSubsteps } from '../plan';
import { t } from '../../shared/i18n';
import type { Plan } from '../../coding-agent/types';
import type { PlanCardSnapshot } from '../store';

describe('formatPlanForPrompt', () => {
  it('renders ordered steps into a prompt fragment', () => {
    const plan: Plan = {
      reasoning: 'complex task',
      steps: [
        { id: '1', action: 'Understand', description: 'Read relevant files.', expectedOutcome: 'Context' },
        { id: '2', action: 'Implement', description: 'Write the changes.', expectedOutcome: 'Working code' },
      ],
    };
    const out = formatPlanForPrompt(plan);
    const projectOut = formatPlanForPrompt(plan, true);
    expect(out).toContain('整体安排');
    expect(out).toContain('1. Understand: Read relevant files.');
    expect(out).toContain('2. Implement: Write the changes.');
    expect(out).toContain('Use the approved plan as a flexible guide');
    expect(out).toContain('show a Todo list only when it helps clarify the work');
    expect(projectOut).toContain('top-level plan list');
    expect(projectOut).toContain('todosRequired');
    expect(projectOut).toContain('supported progress markers');
    expect(projectOut).toContain('do not dictate execution granularity');
    expect(projectOut).toContain('## 计划 n 已完成');
    expect(projectOut).toContain('plain language');
    expect(projectOut).toContain('separate Todo list below the plan list');
    expect(projectOut).not.toContain('TWO INDEPENDENT progress lists');
    expect(projectOut).not.toContain('at most ONE Todo');
  });

  it('approved plans start executing immediately instead of pausing for a go-ahead', () => {
    const plan: Plan = {
      reasoning: 'complex',
      steps: [{ id: '1', action: '调研', description: '读文件', expectedOutcome: '范围清楚' }],
    };
    const approved = formatPlanForPrompt(plan, true, true);
    const pending = formatPlanForPrompt(plan, true, false);
    // 已批准（确认卡上点了“按计划执行”）：第一轮必须立即执行第一个 Todo，
    // 不能再要求“等用户下一条消息才开工”——否则模型第一轮不调用工具，
    // 引擎会空转完成，界面直接从计划跳到交付测试。
    expect(approved).toContain('already approved this plan, so start executing immediately');
    expect(approved).toContain('begin the most appropriate next action with real tool calls');
    expect(approved).not.toContain('at most ONE Todo');
    expect(approved).not.toContain('Never batch');
    // 未批准（自动检测复杂任务）：保留“计划就绪 → 等待用户回复开工”的安全暂停点，
    // 但不再把之后的执行粒度写死成一个 Todo。
    expect(pending).toContain('this first planning response is a pause point');
    expect(pending).toContain('Only after the user sends the next message may you begin execution');
  });

  it('keeps first-turn planning separate from later continuation context', () => {
    const plan: Plan = {
      reasoning: 'complex',
      steps: [{ id: '1', action: '需求深挖', description: '先确认范围', expectedOutcome: '范围清楚', substeps: [{ id: '1', action: '确认用户画像', description: '明确对象', expectedOutcome: '画像明确' }] }],
    };
    const pause = formatPlanPauseMessage(plan);
    const continuation = formatPlanContinuation(plan, 1, 1);
    expect(pause).toContain('计划先列到这里');
    expect(pause).toContain('□ 1. 确认用户画像');
    expect(continuation).toContain('<plan_continuation>');
    expect(continuation).toContain('当前阶段 Todos');
    expect(continuation).toContain('根据实际依赖选择下一步工作');
    // 续跑回合必须同样指示模型发出 `## 计划 n：` / `## 计划 n 已完成` 标记，
    // 否则执行期卡片/悬浮大纲停在第一步（只有首轮 formatPlanForPrompt 有该指令）。
    expect(continuation).toContain('## 计划 n：');
    expect(continuation).toContain('## 计划 n 已完成');
  });
});

describe('matchPlanPhaseMarker', () => {
  it('matches Chinese phase markers at line start', () => {
    expect(matchPlanPhaseMarker('## 阶段 2/4')).toBe(2);
    expect(matchPlanPhaseMarker('步骤 1/3\n开始工作')).toBe(1);
    expect(matchPlanPhaseMarker('\n阶段 3/4 完成')).toBe(3);
  });

  it('matches English step/phase markers', () => {
    expect(matchPlanPhaseMarker('## Step 3 of 5')).toBe(3);
    expect(matchPlanPhaseMarker('## Step 2/4')).toBe(2);
    expect(matchPlanPhaseMarker('> Phase 4/6')).toBe(4);
  });

  it('returns the highest phase mentioned in a chunk', () => {
    expect(matchPlanPhaseMarker('## 阶段 1/4 调研\n## 阶段 2/4 实现')).toBe(2);
  });

  it('matches humanized 第 n 步 step headings', () => {
    expect(matchPlanPhaseMarker('## 第 1 步：搭建大屏页面骨架')).toBe(1);
    expect(matchPlanPhaseMarker('## 第 2 步：接入数据层\n开始工作')).toBe(2);
    expect(matchPlanPhaseMarker('\n第 3 步：联调接口')).toBe(3);
    // Mid-line mentions stay ignored.
    expect(matchPlanPhaseMarker('按第 2 步的说法来')).toBe(null);
  });

  it('matches only explicit substep markers and ignores ordinary numbered prose', () => {
    expect(matchPlanSubstepMarker('### 子步骤 1/3：读取文件')).toBe(1);
    expect(matchPlanSubstepMarker('## 子步骤 2/3：开始改动')).toBe(2);
    expect(matchPlanSubstepMarker('(2) 示例说明')).toBe(null);
    expect(matchPlanSubstepMarker('普通文本')).toBe(null);
  });

  it('ignores mid-line mentions and plain text', () => {
    expect(matchPlanPhaseMarker('请按阶段 1/4 执行')).toBe(null);
    expect(matchPlanPhaseMarker('README 里写了一个"阶段 1/4"的示例')).toBe(null);
    expect(matchPlanPhaseMarker('普通文本')).toBe(null);
  });
});

describe('QUALITY_GATE_STEPS (delivery checklist card)', () => {
  it('keeps the quality gate visibly alive with activity, elapsed time, and cleanup hooks', () => {
    const src = readFileSync(new URL('../plan.ts', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(src).toContain('quality-gate-live');
    expect(src).toContain('quality-gate-evidence');
    expect(src).toContain("status === 'degraded'");
    expect(src).toContain('setEvidence(check: QualityGateCheck)');
    expect(src).toContain('后台运行中');
    expect(src).toContain('已用时');
    expect(src).toContain('const setActivity = (message: string)');
    expect(src).toContain("dispose(outcome: 'passed' | 'failed' | 'cancelled')");
    expect(src).toContain('clearInterval(timer)');
    expect(src).toContain("检查已取消");
    expect(src).toContain("!el.isConnected");
    expect(src).toContain('Do not start the timer here');
    expect(css).toContain('.quality-gate-live.active .quality-gate-live-dot');
    expect(css).toContain('@keyframes quality-gate-pulse');
    expect(css).toContain('@keyframes quality-gate-sweep');
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain('.quality-gate-live.failed .quality-gate-live-dot');
  });

  it('lists the verification steps in gate execution order', () => {
    expect(QUALITY_GATE_STEPS.map((s) => s.phase)).toEqual(['review', 'audit', 'verify']);
  });

  it('describes each step in user-facing language, not internal phrasing', () => {
    for (const step of QUALITY_GATE_STEPS) {
      expect(step.action.length).toBeGreaterThan(0);
      expect(step.description.length).toBeGreaterThan(10);
      expect(step.description).not.toMatch(/Understand|Plan|Implement|Verify|How to/i);
    }
  });
});

describe('right-sidebar command history layout', () => {
  it('keeps command rows readable inside their own scroll window', () => {
    const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(html).toContain('class="stats-list-section stats-command-section"');
    expect(html).toContain('class="stats-list-section stats-write-section"');
    expect(html).toContain('id="stat-write-list" class="stats-list" role="region" data-i18n-aria-label="stats.fileWrites" aria-label="文件写入" aria-live="polite" tabindex="0"');
    expect(html).toContain('id="stat-cmd-list" class="stats-list" role="region" data-i18n-aria-label="stats.commands" aria-label="命令执行" aria-live="polite" tabindex="0"');
    expect(css).toContain('#stat-write-list {');
    expect(css).toContain('#context-panel #stat-write-list {');
    expect(css).toContain('max-height: min(28vh, 260px);');
    expect(css).toContain('#context-panel #stat-write-list::-webkit-scrollbar-thumb');
    expect(css).toContain('#context-panel #stat-write-list .stats-file-group {');
    expect(css).toContain('flex: 0 0 auto;');
    expect(css).toContain('min-height: 54px;');
    expect(css).toContain('#stat-cmd-list {');
    expect(css).toContain('max-height: min(38vh, 360px);');
    expect(css).toContain('scrollbar-gutter: stable;');
    expect(css).toContain('#stat-cmd-list .stats-list-item {');
    expect(css).toContain('padding-top: 34px;');
    expect(css).toContain('min-height: 42px;');
    expect(css).toContain('gap: 8px;');
    expect(css).toContain('overflow-wrap: anywhere;');
    expect(css).toContain('#context-panel #stat-cmd-list::-webkit-scrollbar-thumb');
    // Hover-revealed copy button on each command row.
    expect(css).toContain('#context-panel #stat-cmd-list .stats-cmd-copy');
    expect(css).toContain('top: 6px;');
    expect(css).toContain('right: 6px;');
    expect(css).toContain('transform: none;');
    expect(css).toContain('outline: 2px solid color-mix(in srgb, var(--term-accent) 65%, transparent);');
    expect(css).toContain('.stats-list-item:hover .stats-cmd-copy');
    expect(css).toContain('opacity: 1;');
  });
});

describe('nested execution plan progression', () => {
  it('requires explicit sequential substeps before a verification can complete a plan', () => {
    const oldDocument = (globalThis as any).document;
    const fakeDocument = {
      createElement: (tag: string) => {
        const children: any[] = [];
        const classes = new Set<string>();
        const element: any = {
          tagName: tag.toUpperCase(),
          children,
          childNodes: children,
          className: '',
          classList: {
            add: (...names: string[]) => names.forEach((name) => classes.add(name)),
            remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
            contains: (name: string) => classes.has(name),
          },
          append: (...items: any[]) => items.forEach((item) => children.push(item)),
          appendChild: (item: any) => { children.push(item); return item; },
          querySelector: () => null,
          setAttribute: () => {},
          textContent: '',
          isConnected: true,
        };
        return element;
      },
    };
    (globalThis as any).document = fakeDocument;
    try {
      const plan: Plan = {
        reasoning: 'nested',
        steps: [
          { id: '1', action: '计划一', description: '先做第一部分', expectedOutcome: '完成一', todosRequired: true, substeps: [
            { id: '1', action: '小步骤一', description: '读取', expectedOutcome: '已读' },
            { id: '2', action: '小步骤二', description: '修改', expectedOutcome: '已改' },
            { id: '3', action: '小步骤三', description: '检查', expectedOutcome: '已查' },
          ] },
          { id: '2', action: '计划二', description: '再做第二部分', expectedOutcome: '完成二', todosRequired: true, substeps: [
            { id: '1', action: '小步骤甲', description: '接入', expectedOutcome: '已接入' },
          ] },
        ],
      };
      const handle = createPlanCard(plan);
      expect(handle.current).toBe(1);
      expect(handle.currentSubstep).toBe(1);
      expect(canCompletePlanCardSubsteps(handle)).toBe(false);
      updatePlanCardPhase(handle, 3);
      expect(handle.current).toBe(1);
      updatePlanCardPhase(handle, 2);
      expect(handle.current).toBe(1);
      updatePlanCardSubstep(handle, 3);
      expect(handle.currentSubstep).toBe(1);
      updatePlanCardSubstep(handle, 1);
      expect(handle.currentSubstep).toBe(1);
      completePlanCardSubstep(handle, 1);
      expect(handle.currentSubstep).toBe(2);
      updatePlanCardSubstep(handle, 2);
      completePlanCardSubstep(handle, 2);
      expect(handle.currentSubstep).toBe(3);
      updatePlanCardSubstep(handle, 3);
      completePlanCardSubstep(handle, 3);
      expect(handle.currentSubstep).toBe(4);
      expect(canCompletePlanCardSubsteps(handle)).toBe(true);
      completePlanCardSubsteps(handle);
      updatePlanCardPhase(handle, 2);
      expect(handle.current).toBe(2);
    } finally {
      if (oldDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = oldDocument;
    }
  });

  it('completes the card from the LAST plan\'s own completion marker (total + 1)', () => {
    const oldDocument = (globalThis as any).document;
    const fakeDocument = {
      createElement: (tag: string) => {
        const children: any[] = [];
        const classes = new Set<string>();
        return {
          tagName: tag.toUpperCase(), children, childNodes: children, className: '', dataset: {},
          classList: { add: (...names: string[]) => names.forEach((name) => classes.add(name)), remove: (...names: string[]) => names.forEach((name) => classes.delete(name)), contains: (name: string) => classes.has(name) },
          append: (...items: any[]) => items.forEach((item) => children.push(item)), appendChild: (item: any) => { children.push(item); return item; },
          querySelector: () => null, setAttribute: () => {}, textContent: '', isConnected: true,
        } as any;
      },
    };
    (globalThis as any).document = fakeDocument;
    try {
      const handle = createPlanCard({ reasoning: 'last', steps: [
        { id: '1', action: '一', description: '一', expectedOutcome: '一', todosRequired: false },
        { id: '2', action: '二', description: '二', expectedOutcome: '二', todosRequired: true, substeps: [
          { id: '1', action: '二·一', description: '', expectedOutcome: '' },
        ] },
      ] });
      // Plan 1 is atomic: its own completion marker advances to plan 2.
      updatePlanCardPhase(handle, 2);
      expect(handle.current).toBe(2);
      // The last plan's substep is never explicitly reported as done — the
      // model just emits `## 计划 2 已完成`. finishPlan force-completes the
      // substeps, then updatePlanCardPhase(3) must reach total + 1 (the
      // completed state) instead of being clamped to total.
      completePlanCardSubsteps(handle, true);
      expect(handle.currentSubstep).toBe(2);
      expect(canCompletePlanCardSubsteps(handle)).toBe(true);
      updatePlanCardPhase(handle, 3);
      expect(handle.current).toBe(3);
      expect(handle.current).toBe(handle.total + 1);
      // Every top-level row is done like finalizePlanCard.
      handle.stepEls.forEach((el) => expect(el.classList.contains('done')).toBe(true));
      expect(handle.checkEls[0].textContent).toBe('✓');
      expect(handle.checkEls[1].textContent).toBe('✓');
    } finally {
      if (oldDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = oldDocument;
    }
  });

  it('force-completes substeps even when they were never explicitly entered', () => {
    const oldDocument = (globalThis as any).document;
    const fakeDocument = {
      createElement: (tag: string) => {
        const children: any[] = [];
        const classes = new Set<string>();
        return {
          tagName: tag.toUpperCase(), children, childNodes: children, className: '', dataset: {},
          classList: { add: (...names: string[]) => names.forEach((name) => classes.add(name)), remove: (...names: string[]) => names.forEach((name) => classes.delete(name)), contains: (name: string) => classes.has(name) },
          append: (...items: any[]) => items.forEach((item) => children.push(item)), appendChild: (item: any) => { children.push(item); return item; },
          querySelector: () => null, setAttribute: () => {}, textContent: '', isConnected: true,
        } as any;
      },
    };
    (globalThis as any).document = fakeDocument;
    try {
      const handle = createPlanCard({ reasoning: 'force', steps: [
        { id: '1', action: '一', description: '', expectedOutcome: '', todosRequired: true, substeps: [
          { id: '1', action: '子一', description: '', expectedOutcome: '' },
          { id: '2', action: '子二', description: '', expectedOutcome: '' },
        ] },
      ] });
      // Nothing was ever started: the guarded call is a no-op, the forced one
      // completes every substep and moves the cursor past the last one.
      completePlanCardSubsteps(handle);
      expect(handle.currentSubstep).toBe(1);
      completePlanCardSubsteps(handle, true);
      expect(handle.currentSubstep).toBe(3);
      expect(canCompletePlanCardSubsteps(handle)).toBe(true);
      handle.substepEls[0].forEach((row) => expect(row.classList.contains('done')).toBe(true));
    } finally {
      if (oldDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = oldDocument;
    }
  });

  it('supports optional Todos for atomic plans and explicit Todo completion markers', () => {
    const oldDocument = (globalThis as any).document;
    const fakeDocument = {
      createElement: (tag: string) => {
        const children: any[] = [];
        const classes = new Set<string>();
        return {
          tagName: tag.toUpperCase(), children, childNodes: children, className: '', dataset: {},
          classList: { add: (...names: string[]) => names.forEach((name) => classes.add(name)), remove: (...names: string[]) => names.forEach((name) => classes.delete(name)), contains: (name: string) => classes.has(name) },
          append: (...items: any[]) => items.forEach((item) => children.push(item)), appendChild: (item: any) => { children.push(item); return item; },
          querySelector: () => null, setAttribute: () => {}, textContent: '', isConnected: true,
        } as any;
      },
    };
    (globalThis as any).document = fakeDocument;
    try {
      const handle = createPlanCard({ reasoning: 'mixed', steps: [
        { id: '1', action: '原子改动', description: '一次完成', expectedOutcome: '完成', todosRequired: false },
        { id: '2', action: '复杂改动', description: '拆开执行', expectedOutcome: '完成', todosRequired: true, substeps: [
          { id: '1', action: '第一项', description: '做一', expectedOutcome: '完成一' },
          { id: '2', action: '第二项', description: '做二', expectedOutcome: '完成二' },
        ] },
      ] });
      expect(handle.currentTodosRequired).toBe(false);
      expect(canCompletePlanCardSubsteps(handle)).toBe(true);
      updatePlanCardPhase(handle, 2);
      expect(handle.current).toBe(2);
      expect(handle.currentTodosRequired).toBe(true);
      updatePlanCardSubstep(handle, 1);
      completePlanCardSubstep(handle, 1);
      expect(handle.substepEls[1][0].classList.contains('done')).toBe(true);
      expect(handle.substepNumEls[1][0].textContent).toBe('(1)');
      expect(srcForPlanPresentation()).toContain('plan-progress-substep-check');
      expect(handle.substepEls[1][1].classList.contains('active')).toBe(true);
      expect(handle.currentSubstep).toBe(2);
      completePlanCardSubstep(handle, 2);
      expect(handle.currentSubstep).toBe(3);
      expect(canCompletePlanCardSubsteps(handle)).toBe(true);
    } finally {
      if (oldDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = oldDocument;
    }
    const markers = matchPlanProgressMarkers('## 计划 1：准备\n### 子步骤 1/2：第一项\n### 子步骤 1/2 已完成\n## 计划 1 已完成');
    const markerKinds = markers.map(({ kind, number }) => ({ kind, number }));
    expect(markerKinds).toContainEqual({ kind: 'phase', number: 1 });
    expect(markerKinds).toContainEqual({ kind: 'substepDone', number: 1 });
    expect(markerKinds).toContainEqual({ kind: 'phaseDone', number: 1 });
  });

  it('does not let verification text or ordinary numbering act as substep progress', () => {
    expect(matchPlanSubstepMarker('验证通过，进入下一步')).toBe(null);
    expect(matchPlanSubstepMarker('1. 读取文件\\n2. 修改文件')).toBe(null);
    expect(matchPlanSubstepMarker('### 子步骤 3/3：检查')).toBe(3);
    expect(matchPlanSubstepMarkers('### 子步骤 1/3：读取\n### 子步骤 2/3：修改\n### 子步骤 3/3：检查')).toEqual([1, 2, 3]);
  });
});

describe('live execution plan presentation', () => {
  it('renders two sibling plain-language lists instead of a nested card tree', () => {
    const src = readFileSync(new URL('../plan.ts', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../plain-text-plan.css', import.meta.url), 'utf8');
    expect(src).toContain('根据刚才的判断，接下来按这个顺序推进：');
    expect(src).toContain('先从「${firstAction}」开始：');
    expect(src).toContain('plan-progress-text-plan');
    expect(src).toContain('plan-progress-text-todos');
    expect(src).toContain('el.appendChild(card)');
    expect(src).toContain('for (const todoList of todoLists) el.appendChild(todoList);');
    expect(src).toContain("plan-text-progress-row");
    expect(src).toContain('plan-progress-todo-hidden');
    expect(css).toContain('.plan-text-progress-row {');
    expect(css).not.toMatch(/^\.plan-progress-row\s*\{/m);
    expect(src).not.toContain('nested.appendChild(subRow)');
    expect(css).toContain('background: transparent;');
    expect(css).toContain('border: 0;');
    expect(css).toContain('.plan-progress-todo-title');
    expect(css).toContain('.plan-progress-todo-hidden');
    expect(css).toContain('text-decoration: line-through');
  });
});

function srcForPlanPresentation(): string {
  return readFileSync(new URL('../plan.ts', import.meta.url), 'utf8');
}

describe('completed plan step presentation', () => {
  it('uses the done state and strike-through styling for completed step text', () => {
    const src = readFileSync(new URL('../plan.ts', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    const plainCss = readFileSync(new URL('../plain-text-plan.css', import.meta.url), 'utf8');
    expect(src).toContain("el.classList.add('done')");
    expect(src).toContain('if (!h.substepStarted)');
    expect(css).toContain('.plan-progress-step.done .plan-progress-step-action');
    expect(css).toContain('text-decoration: line-through');
    expect(css).toContain('.plan-progress-step-check');
    expect(plainCss).toContain('.plan-progress-steps > .plan-progress-step');
    expect(plainCss).toContain('.plan-progress-substep-check');
    expect(src).toContain("check.textContent = '✓'");
    expect(src).toContain('row.append(check, num, body)');
    expect(src).not.toContain("h.numEls[i].textContent = '✓'");
  });

  it('finalizes every plan step through the same done-state path', () => {
    const src = readFileSync(new URL('../plan.ts', import.meta.url), 'utf8');
    expect(src).toContain('setPlanPhase(h, h.total + 1)');
    expect(src).toContain("if (checks[i]) checks[i]!.textContent = '✓'");
  });
});

describe('createRestoredPlanCard (session restore)', () => {
  function installFakeDocument(): () => void {
    const previous = (globalThis as any).document;
    (globalThis as any).document = {
      createElement: (tag: string) => {
        const children: any[] = [];
        const classes = new Set<string>();
        const element: any = {
          tagName: tag.toUpperCase(),
          children,
          childNodes: children,
          className: '',
          dataset: {},
          isConnected: true,
          classList: {
            add: (...names: string[]) => names.forEach((name) => classes.add(name)),
            remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
            contains: (name: string) => classes.has(name),
          },
          append: (...items: any[]) => items.forEach((item) => children.push(item)),
          appendChild: (item: any) => { children.push(item); return item; },
          querySelector: () => null,
          setAttribute: () => {},
          textContent: '',
        };
        return element;
      },
    };
    return () => { (globalThis as any).document = previous; };
  }

  const plan: Plan = {
    reasoning: 'r',
    steps: [
      { id: '1', action: '计划一', description: 'd', expectedOutcome: 'o', todosRequired: true, substeps: [
        { id: '1', action: '小步骤一', description: 'd', expectedOutcome: 'o' },
        { id: '2', action: '小步骤二', description: 'd', expectedOutcome: 'o' },
      ] },
      { id: '2', action: '计划二', description: 'd', expectedOutcome: 'o' },
    ],
  };

  it('rebuilds the card with its saved top-level progress', () => {
    const restore = installFakeDocument();
    try {
      const card = createRestoredPlanCard({ plan, currentPlan: 2, currentTodo: 1, complete: false } satisfies PlanCardSnapshot);
      expect(card.plan).toBe(plan);
      expect(card.total).toBe(2);
      expect(card.current).toBe(2);
      expect(card.stepEls[0].classList.contains('done')).toBe(true);
      expect(card.stepEls[1].classList.contains('active')).toBe(true);
    } finally {
      restore();
    }
  });

  it('restores an advanced substep cursor inside the active plan', () => {
    const restore = installFakeDocument();
    try {
      const card = createRestoredPlanCard({ plan, currentPlan: 1, currentTodo: 2, complete: false } satisfies PlanCardSnapshot);
      expect(card.current).toBe(1);
      expect(card.currentSubstep).toBe(2);
      expect(card.substepEls[0][0].classList.contains('done')).toBe(true);
      expect(card.substepEls[0][1].classList.contains('active')).toBe(true);
    } finally {
      restore();
    }
  });

  it('re-renders a completed snapshot with every step checked off', () => {
    const restore = installFakeDocument();
    try {
      const card = createRestoredPlanCard({ plan, currentPlan: 3, currentTodo: 3, complete: true } satisfies PlanCardSnapshot);
      expect(card.current).toBe(3); // total + 1, the finalize sentinel
      expect(card.stepEls.every((el) => el.classList.contains('done'))).toBe(true);
      expect(card.checkEls.every((el) => el.textContent === '✓')).toBe(true);
      expect(card.substepEls[0].every((el) => el.classList.contains('done'))).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('plan refining badge (3s hint rotation)', () => {
  it('rotates the hint every 3 seconds and self-cleans when the badge leaves the DOM', () => {
    const src = readFileSync(new URL('../plan.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/setInterval\(\(\) =>/);
    expect(src).toMatch(/3000\)/);
    expect(src).toMatch(/!badge\.isConnected/);
    expect(src).toMatch(/clearInterval\(timer\)/);
  });

  it('provides localized rotating hints', () => {
    for (const key of ['plan.refining.files', 'plan.refining.analyzing', 'plan.refining.planning'] as const) {
      const text = t(key);
      expect(text).not.toBe(key);
      expect(text.length).toBeGreaterThan(4);
    }
  });
});
