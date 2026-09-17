// src/ui/__tests__/notify.test.ts
// Roadmap 5.2 — the notification logic: transcript-tail classification
// (done / failed / needs-confirm), task excerpt extraction, the notify-gating
// rule, and the running-set edge that turns transitions into notifications.
// DOM bits run under happy-dom, same as the session manager tests.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import {
  classifySettleHost,
  extractTaskExcerpt,
  SettleNotifier,
  shouldNotifyFor,
  type SettleNotifierDeps,
} from '../notify';

beforeAll(() => {
  if (!('window' in globalThis)) GlobalRegistrator.register();
});
// Release the global DOM so files running after this one can register their
// own (same contract as sessionChatManager.test.ts — a second register()
// while globals are already installed fails on readonly assignment).
afterAll(() => {
  if ('window' in globalThis) GlobalRegistrator.unregister();
});
afterEach(() => {
  // Keep document content from leaking between cases.
  document.body.innerHTML = '';
});

function hostWith(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('classifySettleHost', () => {
  it('reads the transcript tail', () => {
    expect(classifySettleHost(null)).toBe('done');
    expect(classifySettleHost(hostWith(''))).toBe('done');
    // A normal finish: last row is an ordinary bubble.
    expect(classifySettleHost(hostWith('<div class="bubble-row"><div class="bubble">done</div></div>'))).toBe('done');
    // Failure: the tail row carries the error marker.
    expect(classifySettleHost(hostWith('<div class="bubble-row"><div class="bubble">ok</div></div><div class="bubble-row status error"><div class="bubble error">boom</div></div>'))).toBe('failed');
    // Confirmation wait: the tail is the plan-pause row.
    expect(classifySettleHost(hostWith('<div class="bubble-row"><div class="bubble">plan ready</div></div><div class="bubble-row"><div class="bubble plan-pause-message">等待你回复</div></div>'))).toBe('needs-confirm');
  });

  it('ignores old markers deeper in the transcript (tail decides)', () => {
    // An error from an earlier turn followed by a successful finish.
    const host = hostWith(
      '<div class="bubble-row status error"><div class="bubble error">old boom</div></div>' +
      '<div class="bubble-row"><div class="bubble">all good now</div></div>',
    );
    expect(classifySettleHost(host)).toBe('done');
  });

  it('walks back over empty rows left by a render pass', () => {
    const host = hostWith(
      '<div class="bubble-row status error"><div class="bubble error">boom</div></div>' +
      '<div></div><div>   </div>',
    );
    expect(classifySettleHost(host)).toBe('failed');
  });
});

describe('extractTaskExcerpt', () => {
  const messages = [
    { role: 'user', content: 'first task' },
    { role: 'assistant', content: 'working…' },
    { role: 'user', content: 'internal recovery', internal: true },
    { role: 'user', content: '  the\n actual  task  ' },
  ];

  it('takes the last non-internal user message, whitespace collapsed', () => {
    expect(extractTaskExcerpt(messages)).toBe('the actual task');
  });

  it('caps long tasks with an ellipsis', () => {
    const long = 'x'.repeat(120);
    const out = extractTaskExcerpt([{ role: 'user', content: long }]);
    expect(out.length).toBe(81);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty when there is nothing quotable', () => {
    expect(extractTaskExcerpt([{ role: 'user', content: '  ', internal: true }])).toBe('');
    expect(extractTaskExcerpt([])).toBe('');
  });
});

describe('shouldNotifyFor', () => {
  it('notifies background sessions, and the visible one only when hidden', () => {
    expect(shouldNotifyFor('s1', 's2', true)).toBe(true);
    expect(shouldNotifyFor('s1', 's1', true)).toBe(false);
    expect(shouldNotifyFor('s1', 's1', false)).toBe(true);
    expect(shouldNotifyFor('s1', 's2', false)).toBe(true);
  });
});

describe('SettleNotifier', () => {
  interface Call { sessionId: string; title: string; body: string }

  function makeDeps(partial: Partial<SettleNotifierDeps> & { running?: string[] }): {
    deps: SettleNotifierDeps;
    calls: Call[];
    setRunning(ids: string[]): void;
  } {
    const calls: Call[] = [];
    let running = partial.running ?? [];
    const deps: SettleNotifierDeps = {
      runningIds: () => running,
      currentId: () => 'current',
      windowVisible: () => Promise.resolve(true),
      hostOf: () => null,
      messagesOf: (id) => [{ role: 'user', content: `task for ${id}` }],
      titleOf: (id) => Promise.resolve(`Session ${id}`),
      notify: async (payload) => {
        calls.push({ ...payload });
      },
      ...partial,
    };
    return { deps, calls, setRunning: (ids) => { running = ids; } };
  }

  it('notifies once per session that leaves the running set', async () => {
    const { deps, calls, setRunning } = makeDeps({ running: ['a', 'b'] });
    const notifier = new SettleNotifier(deps);
    notifier.refresh();
    expect(calls).toEqual([]);
    setRunning(['b']);
    notifier.refresh();
    await Promise.resolve(); // let the settle promise settle
    await Promise.resolve();
    expect(calls.map((c) => c.sessionId)).toEqual(['a']);
    // A second refresh with no change notifies nobody.
    notifier.refresh();
    expect(calls.map((c) => c.sessionId)).toEqual(['a']);
  });

  it('builds title (session · kind) and body (task excerpt)', async () => {
    const { deps, calls, setRunning } = makeDeps({ running: ['a'] });
    const notifier = new SettleNotifier(deps);
    notifier.refresh();
    setRunning([]);
    notifier.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBe(1);
    expect(calls[0].title).toBe('Session a · 任务完成');
    expect(calls[0].body).toBe('task for a');
  });

  it('stays silent when the controller is already gone', async () => {
    const { deps, calls, setRunning } = makeDeps({ running: ['gone'] });
    deps.messagesOf = () => null;
    const notifier = new SettleNotifier(deps);
    notifier.refresh();
    setRunning([]);
    notifier.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  it('respects the gating rule (visible + watched → silent)', async () => {
    const { deps, calls, setRunning } = makeDeps({ running: ['current'] });
    const notifier = new SettleNotifier(deps);
    notifier.refresh();
    setRunning([]);
    notifier.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([]);
  });
});
