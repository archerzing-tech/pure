// src/ui/__tests__/taskQueue.test.ts
// TaskQueue boot-time adoption: pending work persisted before a reload is
// bound to the pre-reload session id. At boot the chat sits in a fresh
// session, so without adoption the stored "reload resumes pending work"
// contract was dead — scheduled tasks stranded forever (never runnable, no
// UI to release them). The constructor rebinds same-workspace tasks to the
// boot session; other-workspace tasks stay bound (running them against the
// wrong project is what the binding prevents).

import { describe, expect, it } from 'bun:test';
import { TaskQueue, type QueueChat } from '../taskQueue';

interface FakeStorage {
  store: Record<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function makeChat(): QueueChat & { sends: string[] } {
  const sends: string[] = [];
  return {
    sends,
    send: (text: string) => {
      sends.push(text);
      return Promise.resolve();
    },
  };
}

function fakeStorage(seed: unknown): FakeStorage {
  const store: Record<string, string> = {
    pure_task_queue_test: JSON.stringify(seed),
  };
  return {
    store,
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => {
      store[key] = value;
    },
  };
}

// The real environment defines localStorage on globalThis; these tests run in
// bun, so install the fake before constructing the queue.
function installStorage(storage: FakeStorage): void {
  (globalThis as { localStorage?: unknown }).localStorage = storage;
}

describe('TaskQueue resume after reload', () => {
  it('adopts same-workspace pending tasks stranded by a reload and runs them', async () => {
    installStorage(fakeStorage([
      { id: 'q1', text: '跑一遍测试', displayText: '跑一遍测试', status: 'pending', ts: 1, workspace: '/proj', sessionId: 'sess-before-reload' },
    ]));
    const chat = makeChat();
    void new TaskQueue({
      chat,
      storageKey: 'pure_task_queue_test',
      getContext: () => ({ workspace: '/proj', sessionId: 'sess-boot' }),
    });
    // The constructor defers via queueMicrotask; yield past it and the send.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(chat.sends).toEqual(['跑一遍测试']);
  });

  it('leaves other-workspace tasks bound — they must not run against the wrong project', async () => {
    installStorage(fakeStorage([
      { id: 'q2', text: '别的项目的任务', displayText: '别的项目的任务', status: 'pending', ts: 1, workspace: '/other', sessionId: 'sess-old' },
    ]));
    const chat = makeChat();
    void new TaskQueue({
      chat,
      storageKey: 'pure_task_queue_test',
      getContext: () => ({ workspace: '/proj', sessionId: 'sess-boot' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(chat.sends).toEqual([]);
  });

  it('still runs a task already bound to the boot context (unchanged path)', async () => {
    installStorage(fakeStorage([
      { id: 'q3', text: '直接可跑', displayText: '直接可跑', status: 'pending', ts: 1, workspace: '/proj', sessionId: 'sess-boot' },
    ]));
    const chat = makeChat();
    void new TaskQueue({
      chat,
      storageKey: 'pure_task_queue_test',
      getContext: () => ({ workspace: '/proj', sessionId: 'sess-boot' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(chat.sends).toEqual(['直接可跑']);
  });
});
