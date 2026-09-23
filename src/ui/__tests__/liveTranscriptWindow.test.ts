import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { LiveTranscriptWindow } from '../liveTranscriptWindow';

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = '<div id="chat"></div>';
  // These cases assert the folding MODEL (grouping, parking, adoption). The
  // viewport-driven mounting is a browser concern — scripts/verify-plan-restore
  // covers it against real Chrome, where IntersectionObserver exists.
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

// Small numbers so the folding rules are exercised by a short test session.
const SMALL = { groupThreshold: 4, recentPlainTurns: 2, groupSize: 2 };

function runTurns(window: LiveTranscriptWindow, count: number): void {
  for (let i = 1; i <= count; i++) {
    const turn = window.startTurn(`任务 ${i}`);
    turn.host.append(document.createElement('div'), document.createElement('div'));
    window.finishTurn(turn);
  }
}

describe('LiveTranscriptWindow', () => {
  it('keeps a short session entirely plain — nothing folds below the threshold', () => {
    const window = new LiveTranscriptWindow({ ...SMALL, groupThreshold: 10 });
    runTurns(window, 6);

    expect(window.getMountedTurnCount()).toBe(6);
    expect(window.getGroupedTurnCount()).toBe(0);
    expect(document.querySelectorAll('.transcript-history-group')).toHaveLength(0);
  });

  it('folds the oldest turns a chunk at a time and keeps the newest ones plain', () => {
    const window = new LiveTranscriptWindow(SMALL);
    runTurns(window, 10);

    // 10 turns, newest 2 stay plain → [1,2] [3,4] [5,6] [7,8] grouped.
    expect(window.getGroupedTurnCount()).toBe(8);
    expect(window.getMountedTurnCount()).toBe(2);
    const groups = [...document.querySelectorAll<HTMLDetailsElement>('.transcript-history-group')];
    expect(groups).toHaveLength(4);
    // Groups appear in transcript order, before the plain turns.
    expect(document.querySelectorAll('#chat > .bubble-turn')).toHaveLength(2);
  });

  it('leaves every group expanded and summarizes what it holds', () => {
    const window = new LiveTranscriptWindow(SMALL);
    runTurns(window, 10);

    const first = document.querySelector<HTMLDetailsElement>('.transcript-history-group')!;
    expect(first.open).toBe(true);
    const summary = first.querySelector('.transcript-history-group-summary')?.textContent ?? '';
    expect(summary).toContain('第 1–2 轮');
    expect(summary).toContain('共 2 轮');
    expect(summary).toContain('任务 1');
    // The folded nodes moved into the group body — history is not discarded.
    expect(first.querySelector('.transcript-history-group-body')?.childElementCount).toBe(4);
  });

  it('parks a collapsed group and mounts it again from the same nodes', () => {
    const window = new LiveTranscriptWindow(SMALL);
    runTurns(window, 10);

    const group = window.getGroupHandles()[0];
    const details = group.el;
    const body = group.body;
    // Group content is live and mounted while expanded.
    const before = body.childElementCount;
    expect(before).toBeGreaterThan(0);

    details.open = false;
    details.dispatchEvent(new Event('toggle'));
    expect(body.childElementCount).toBe(0);

    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    expect(body.childElementCount).toBe(before);
  });

  it('moves a folded turn node into the current turn without duplicating it', () => {
    const window = new LiveTranscriptWindow(SMALL);
    runTurns(window, 10);

    // The first turn is inside a history group now; the newest turn is plain.
    const group = window.getGroupHandles()[0];
    const folded = group.body.firstElementChild!;
    const current = window.startTurn('正在执行');
    expect(window.moveNodeToTurn(folded, current)).toBe(true);
    expect(current.host.contains(folded)).toBe(true);
    // Left the group rather than being duplicated into both places.
    expect(group.contains(folded)).toBe(false);
  });

  it('adopts a transcript node that was mounted outside a live turn', () => {
    const window = new LiveTranscriptWindow({ ...SMALL, groupThreshold: 10 });
    const outside = document.createElement('div');
    document.getElementById('chat')!.appendChild(outside);
    const turn = window.startTurn('当前任务');
    expect(window.moveNodeToTurn(outside, turn)).toBe(true);
    expect(turn.host.contains(outside)).toBe(true);
    expect(document.getElementById('chat')!.contains(outside)).toBe(true);
  });

  it('ignores a node that belongs to no turn and no group', () => {
    const window = new LiveTranscriptWindow(SMALL);
    runTurns(window, 10);
    const current = window.startTurn('新任务');
    const stray = document.createElement('div');
    document.body.appendChild(stray);
    expect(window.moveNodeToTurn(stray, current)).toBe(false);
  });
});
