import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { LiveTranscriptWindow } from '../liveTranscriptWindow';
import { setPinnedToBottom } from '../scrollPin';

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
  // 体量观察器同理：真实 MutationObserver 的增量估算在浏览器里跑，测试直接
  // 驱动 noteLiveWeight（折叠规则的判定面）。
  delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
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

// ── 单回合巨物的体量折叠（2026-11-18 run5 判例）─────────────────────────
// 工程构建是单个 send 内的 auto-continue 巨回合：按「轮数」分箱的直播窗口
// 对它整体失明（一个 turn 装下 21MB，WKWebView 弃画早期图层=「渲染了一半」）。
// 体量帽 + 部分折叠：老节点折进泊车组，尾部 4 节点留挂给直播流。

const HEAVY = { groupThreshold: 50, recentPlainTurns: 8, groupSize: 10, liveTurnWeightBytes: 2000 };

function appendHeavyChild(turn: { host: HTMLElement }, chars = 250): void {
  const el = document.createElement('div');
  el.textContent = 'x'.repeat(chars); // 估算 500 字节
  turn.host.appendChild(el);
}

describe('LiveTranscriptWindow 体量折叠（单回合巨物）', () => {
  it('越帽把活跃 turn 的老节点折进泊车组（折后即泊），尾部留挂', () => {
    const window = new LiveTranscriptWindow(HEAVY);
    const turn = window.startTurn('构建一个大项目');
    for (let i = 0; i < 10; i++) appendHeavyChild(turn);
    // 一次记账 5000 字节（观察器在真实浏览器里本就合批后调用）。
    window.noteLiveWeight(10 * 500);

    const groups = window.getGroupHandles();
    expect(groups.length).toBe(1);
    // 折后立即泊车（组在钉底视图上方，挂了也没观众）：body 空、内容在
    // parked 里，mount() 可完整恢复——2026-11-19 泊车回归。
    expect(groups[0]!.body.childElementCount).toBe(0);
    groups[0]!.mount();
    expect(groups[0]!.body.childElementCount).toBe(6);
    // 尾部 4 节点留挂在活跃 turn 里——直播流正在写的气泡在文档上。
    expect(turn.host.childElementCount).toBe(4);
    expect(turn.host.isConnected).toBe(true);
    // 组排在 turn 之前，转录顺序不变。
    const chatChildren = [...document.getElementById('chat')!.children];
    expect(chatChildren.indexOf(groups[0]!.el)).toBeLessThan(chatChildren.indexOf(turn.host));
  });

  it('继续增长会再次折叠（多组累积），组序在前', () => {
    const window = new LiveTranscriptWindow(HEAVY);
    const turn = window.startTurn('构建一个大项目');
    for (let i = 0; i < 10; i++) appendHeavyChild(turn);
    window.noteLiveWeight(10 * 500);
    for (let i = 0; i < 3; i++) {
      appendHeavyChild(turn);
      window.noteLiveWeight(4 * 500 + 500);
    }
    expect(window.getGroupHandles().length).toBeGreaterThanOrEqual(2);
    expect(turn.host.childElementCount).toBe(4);
  });

  it('没钉在底部时不折叠（用户正在翻史，折叠会拽走视野）', () => {
    const window = new LiveTranscriptWindow(HEAVY);
    const turn = window.startTurn('构建一个大项目');
    for (let i = 0; i < 10; i++) appendHeavyChild(turn);
    setPinnedToBottom(document.getElementById('chat')!, false);
    window.noteLiveWeight(10 * 500);
    expect(window.getGroupHandles().length).toBe(0);
    // 恢复钉底后再记账，折叠照常发生。
    setPinnedToBottom(document.getElementById('chat')!, true);
    window.noteLiveWeight(0);
    expect(window.getGroupHandles().length).toBe(1);
  });

  it('顶层节点不足 keep+1 时不折（单巨气泡留挂，另一刀的范围）', () => {
    const window = new LiveTranscriptWindow(HEAVY);
    const turn = window.startTurn('一个大文件');
    appendHeavyChild(turn, 5000); // 单节点 10000 字节估算，远超帽
    window.noteLiveWeight(10_000);
    expect(window.getGroupHandles().length).toBe(0);
    expect(turn.host.childElementCount).toBe(1);
  });
});
