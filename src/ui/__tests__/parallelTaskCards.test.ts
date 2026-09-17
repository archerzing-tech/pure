// src/ui/__tests__/parallelTaskCards.test.ts
// Pure rendering/state tests for the parallel-task dock (roadmap 4.3). The
// roadmap's acceptance criterion — "3 parallel sessions, UI never bleeds" —
// is a property of the rendered card SET: each card carries its own session
// id, elapsed, and queue chip, and the visible session never gets a card.

import { describe, expect, it } from 'bun:test';
import {
  formatElapsed,
  renderParallelTasks,
  visibleParallelSessions,
  type ParallelTask,
} from '../parallelTaskCards';

function task(partial: Partial<ParallelTask>): ParallelTask {
  return {
    sessionId: 's1',
    title: 'Session One',
    workspace: '/tmp/proj-a',
    startedAt: 1_000_000,
    queuedTasks: 0,
    ...partial,
  };
}

describe('visibleParallelSessions', () => {
  it('excludes the visible session and empty ids', () => {
    expect(visibleParallelSessions(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(visibleParallelSessions(['', 'a'], 'a')).toEqual([]);
    expect(visibleParallelSessions(['a'], undefined)).toEqual(['a']);
    expect(visibleParallelSessions([], 'a')).toEqual([]);
  });
});

describe('formatElapsed', () => {
  it('renders seconds, minutes, and hours compactly', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(185_000)).toBe('3m05s');
    expect(formatElapsed(4_320_000)).toBe('1h12m');
    // A clock that has not started yet (startedAt === now edge) never goes
    // negative.
    expect(formatElapsed(-5)).toBe('0s');
  });
});

describe('renderParallelTasks', () => {
  const now = 1_000_000 + 65_000; // 65s after every startedAt below

  it('renders one independent card per background session (3-way no-bleed)', () => {
    const html = renderParallelTasks({
      now,
      tasks: [
        task({ sessionId: 's-a', title: '重构登录', workspace: '/work/alpha' }),
        task({ sessionId: 's-b', title: '修 CI', workspace: '/work/beta', queuedTasks: 2 }),
        task({ sessionId: 's-c', title: '写文档', workspace: '/work/gamma' }),
      ],
    });

    const ids = [...html.matchAll(/data-session-id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['s-a', 's-b', 's-c']);
    // Stop buttons target their OWN session, one per card.
    expect([...html.matchAll(/data-stop-session="([^"]+)"/g)].map((m) => m[1])).toEqual(['s-a', 's-b', 's-c']);
    // Per-card elapsed + queue chip: only the queued session carries a chip.
    expect((html.match(/parallel-card-elapsed/g) ?? []).length).toBe(3);
    expect(html).toContain('1m05s');
    expect(html).toContain('parallel-card-queue');
    expect(html).toContain('队列 2');
    expect((html.match(/parallel-card-queue"/g) ?? []).length).toBe(1);
    // Workspace basenames, not full paths.
    expect(html).toContain('alpha');
    expect(html).not.toContain('/work/beta');
    // The dock label exists exactly once for the whole stack.
    expect((html.match(/parallel-dock-label/g) ?? []).length).toBe(1);
  });

  it('escapes hostile titles and paths (cards are innerHTML)', () => {
    const html = renderParallelTasks({
      now,
      tasks: [task({ sessionId: 's-x', title: '<script>alert(1)</script>', workspace: '/a"><img onerror=x>' })],
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
  });

  it('renders nothing for an empty set (dock hides itself)', () => {
    expect(renderParallelTasks({ now, tasks: [] })).toBe('');
  });
});
