import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { LiveTranscriptWindow, summarizeLiveTurn } from '../liveTranscriptWindow';

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = '<div id="chat"></div>';
});

describe('LiveTranscriptWindow', () => {
  it('keeps the newest completed turns mounted and archives older whole turns', () => {
    const window = new LiveTranscriptWindow({ maxMountedTurns: 3 });
    for (let i = 1; i <= 6; i++) {
      const turn = window.startTurn(`任务 ${i}`);
      turn.host.append(document.createElement('div'), document.createElement('div'));
      window.finishTurn(turn);
    }

    expect(window.getArchivedTurnCount()).toBe(3);
    expect(window.getMountedTurnCount()).toBe(3);
    expect(document.querySelectorAll('.live-turn-archive')).toHaveLength(3);
    expect(document.querySelectorAll('#chat > .bubble-turn:not(.archived)')).toHaveLength(3);
    expect(document.querySelectorAll('.live-turn-archive-body > *')).toHaveLength(0);
  });

  it('keeps eight completed turns mounted when the window is idle', () => {
    const window = new LiveTranscriptWindow({ maxMountedTurns: 8 });
    for (let i = 1; i <= 12; i++) {
      const turn = window.startTurn(`任务 ${i}`);
      turn.host.append(document.createElement('div'));
      window.finishTurn(turn);
    }
    expect(window.getArchivedTurnCount()).toBe(4);
    expect(window.getMountedTurnCount()).toBe(8);
  });

  it('keeps the active turn mounted while reserving the rest of the window for completed turns', () => {
    const window = new LiveTranscriptWindow({ maxMountedTurns: 8 });
    for (let i = 1; i <= 12; i++) {
      const turn = window.startTurn(`任务 ${i}`);
      turn.host.appendChild(document.createElement('div'));
      window.finishTurn(turn);
    }
    window.startTurn('正在执行');
    expect(window.getArchivedTurnCount()).toBe(5);
    expect(window.getMountedTurnCount()).toBe(8);
    expect(document.querySelector('#chat > .bubble-turn[data-turn-state="active"]')).not.toBeNull();
  });

  it('moves a parked node into the current turn without duplicating it', () => {
    const window = new LiveTranscriptWindow({ maxMountedTurns: 1 });
    const first = window.startTurn('第一项');
    const node = document.createElement('div');
    first.host.appendChild(node);
    window.finishTurn(first);
    const second = window.startTurn('第二项');
    expect(window.moveNodeToTurn(node, second)).toBe(true);
    expect(second.host.contains(node)).toBe(true);
    expect(document.querySelectorAll('.live-turn-archive-body > *')).toHaveLength(0);
  });

  it('adopts a transcript node that was mounted outside a live turn', () => {
    const window = new LiveTranscriptWindow({ maxMountedTurns: 2 });
    const outside = document.createElement('div');
    document.getElementById('chat')!.appendChild(outside);
    const turn = window.startTurn('当前任务');
    expect(window.moveNodeToTurn(outside, turn)).toBe(true);
    expect(turn.host.contains(outside)).toBe(true);
    expect(document.getElementById('chat')!.contains(outside)).toBe(true);
  });

  it('mounts an archived turn only while it is expanded', () => {
    const window = new LiveTranscriptWindow({ maxMountedTurns: 1 });
    const first = window.startTurn('第一项');
    first.host.append(document.createElement('div'));
    window.finishTurn(first);
    const second = window.startTurn('第二项');
    second.host.append(document.createElement('div'), document.createElement('div'));
    window.finishTurn(second);

    const details = document.querySelector<HTMLDetailsElement>('.live-turn-archive');
    const body = details?.querySelector<HTMLElement>('.live-turn-archive-body');
    expect(details).not.toBeNull();
    expect(body?.childElementCount).toBe(0);

    details!.open = true;
    details!.dispatchEvent(new Event('toggle'));
    expect(body?.childElementCount).toBe(1);

    details!.open = false;
    details!.dispatchEvent(new Event('toggle'));
    expect(body?.childElementCount).toBe(0);
  });

  it('summarizes long requests without growing the archive header', () => {
    const summary = summarizeLiveTurn('  alpha\n beta  '.repeat(20), 4);
    expect(summary).toStartWith('第 4 轮 · alpha beta');
    expect(summary.length).toBeLessThan(100);
  });
});
