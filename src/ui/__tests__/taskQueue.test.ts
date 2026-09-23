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

// ── Roadmap 4.2: single-flight is per worktree ──
// Different worktrees drain in parallel through their own live chats; tasks
// inside ONE worktree stay strictly serial; a context the host has no live
// chat for stays pending.

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

interface StoredTask {
  id: string;
  text: string;
  displayText: string;
  status: string;
  ts: number;
  workspace: string;
  sessionId: string;
}

function storedTask(partial: Partial<StoredTask>): StoredTask {
  return {
    id: partial.id ?? `q${Math.random().toString(36).slice(2)}`,
    text: partial.text ?? '',
    displayText: partial.text ?? '',
    status: 'pending',
    ts: 1,
    workspace: partial.workspace ?? '',
    sessionId: partial.sessionId ?? '',
    ...partial,
  } as StoredTask;
}

describe('TaskQueue per-worktree lanes (4.2)', () => {
  it('drains different worktrees in parallel while keeping each worktree serial', async () => {
    const gateA1 = deferred();
    const sendsA: string[] = [];
    const chatA: QueueChat = {
      send: (text) => {
        sendsA.push(text);
        // Only the FIRST task blocks; a2 must not start until it settles.
        return text === 'a1' ? gateA1.promise : Promise.resolve();
      },
    };
    const sendsB: string[] = [];
    const chatB: QueueChat = {
      send: (text) => {
        sendsB.push(text);
        return Promise.resolve();
      },
    };
    installStorage(fakeStorage([
      storedTask({ id: 'a1', text: 'a1', workspace: '/proj-a', sessionId: 'sess-a' }),
      storedTask({ id: 'a2', text: 'a2', workspace: '/proj-a', sessionId: 'sess-a' }),
      storedTask({ id: 'b1', text: 'b1', workspace: '/proj-b', sessionId: 'sess-b' }),
    ]));
    const queue = new TaskQueue({
      chat: chatA,
      chatFor: (ctx) => (ctx.workspace === '/proj-b' ? chatB : chatA),
      storageKey: 'pure_task_queue_test',
      getContext: () => ({ workspace: '/proj-a', sessionId: 'sess-a' }),
    });
    await flush();

    // b1 is ALREADY running even though a1 (current context) still blocks —
    // that is the parallelism the old global single-flight could never do.
    expect(sendsA).toEqual(['a1']);
    expect(sendsB).toEqual(['b1']);

    gateA1.resolve();
    await flush();
    // a2 started only after a1 settled — same worktree stays serial.
    expect(sendsA).toEqual(['a1', 'a2']);
    queue.cancelAll();
  });

  it('leaves a context pending when the host has no live chat for it', async () => {
    const sendsA: string[] = [];
    const chatA: QueueChat = { send: (text) => { sendsA.push(text); return Promise.resolve(); } };
    const sendsB: string[] = [];
    const chatB: QueueChat = { send: (text) => { sendsB.push(text); return Promise.resolve(); } };
    installStorage(fakeStorage([
      storedTask({ id: 'b1', text: 'b1', workspace: '/proj-b', sessionId: 'sess-b' }),
    ]));
    const queue = new TaskQueue({
      chat: chatA,
      // /proj-b was never opened this run → controllerFor returns null.
      chatFor: (ctx) => (ctx.workspace === '/proj-a' ? chatA : null),
      storageKey: 'pure_task_queue_test',
      getContext: () => ({ workspace: '/proj-a', sessionId: 'sess-a' }),
    });
    await flush();
    expect(sendsB).toEqual([]);
    expect(queue.isIdle()).toBe(true);

    // Enqueueing into the current context still runs — the pending foreign
    // task does not block the queue.
    queue.enqueue('a1');
    await flush();
    expect(sendsA).toEqual(['a1']);
    queue.cancelAll();
  });

  it('cancels a background running task through its own lane chat', async () => {
    const gateB1 = deferred();
    let cancelledB = 0;
    const chatA: QueueChat = { send: () => Promise.resolve() };
    const chatB: QueueChat = {
      send: () => gateB1.promise,
      cancel: () => { cancelledB++; },
    };
    installStorage(fakeStorage([
      storedTask({ id: 'b1', text: 'b1', workspace: '/proj-b', sessionId: 'sess-b' }),
    ]));
    const queue = new TaskQueue({
      chat: chatA,
      chatFor: (ctx) => (ctx.workspace === '/proj-b' ? chatB : chatA),
      storageKey: 'pure_task_queue_test',
      getContext: () => ({ workspace: '/proj-a', sessionId: 'sess-a' }),
    });
    await flush();
    expect(cancelledB).toBe(0);

    // The visible session is /proj-a; cancelling b1 must reach chatB, not the
    // facade — that is exactly what the old isRunnable guard made impossible.
    queue.cancel('b1');
    expect(cancelledB).toBe(1);

    gateB1.resolve();
    await flush();
    const persisted = JSON.parse(globalThis.localStorage.getItem('pure_task_queue_test') ?? '[]') as StoredTask[];
    expect(persisted.find((t) => t.id === 'b1')?.status).toBe('cancelled');
    queue.cancelAll();
  });

  it('isIdle tracks only the current context while a background lane runs', async () => {
    const gateB1 = deferred();
    const chatA: QueueChat = { send: () => Promise.resolve() };
    const chatB: QueueChat = { send: () => gateB1.promise };
    installStorage(fakeStorage([
      storedTask({ id: 'b1', text: 'b1', workspace: '/proj-b', sessionId: 'sess-b' }),
    ]));
    const queue = new TaskQueue({
      chat: chatA,
      chatFor: (ctx) => (ctx.workspace === '/proj-b' ? chatB : chatA),
      storageKey: 'pure_task_queue_test',
      getContext: () => ({ workspace: '/proj-a', sessionId: 'sess-a' }),
    });
    await flush();
    // b1 runs in the background; THIS context is idle, so the scheduler may
    // still enqueue here.
    expect(queue.isIdle()).toBe(true);
    gateB1.resolve();
    await flush();
    queue.cancelAll();
  });
});

// ── Input-level time semantics ──
// A task the user scheduled ("下午三点再跑一遍") is HELD, not skipped: it must
// still run if nothing else happens to call runNext(), which is why the queue
// arms its own wake-up timer instead of waiting for an unrelated event.

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('TaskQueue scheduled input (dueAt)', () => {
  it('holds a timed task until its moment and then runs it', async () => {
    installStorage(fakeStorage([]));
    const chat = makeChat();
    const queue = new TaskQueue({
      chat,
      storageKey: 'pure_task_queue_test',
      getContext: () => ({ workspace: '/proj', sessionId: 'sess' }),
    });
    queue.enqueue('下午三点再跑一遍测试', { dueAt: Date.now() + 40 });
    await wait(15);
    expect(chat.sends).toEqual([]);
    expect(queue.getTasks().map((t) => t.status)).toEqual(['pending']);

    await wait(60);
    expect(chat.sends).toEqual(['下午三点再跑一遍测试']);
    queue.cancelAll();
  });

  it('keeps a timed task pending while the current lane is busy with other work', async () => {
    installStorage(fakeStorage([]));
    const gate = deferred();
    const sends: string[] = [];
    const chat: QueueChat = {
      send: (text) => {
        sends.push(text);
        return text === '先跑这个' ? gate.promise : Promise.resolve();
      },
    };
    const queue = new TaskQueue({
      chat,
      storageKey: 'pure_task_queue_test',
      getContext: () => ({ workspace: '/proj', sessionId: 'sess' }),
    });
    queue.enqueue('先跑这个');
    queue.enqueue('10 分钟后再跑那个', { dueAt: Date.now() + 10 * 60_000 });
    await flush();
    expect(sends).toEqual(['先跑这个']);
    // The queue chip counts the HELD item — the running one is not pending.
    expect(queue.pendingCountFor('sess')).toBe(1);
    expect(queue.getTasks().find((t) => t.text.includes('10 分钟'))?.status).toBe('pending');

    gate.resolve();
    await flush();
    // The lane drained, but the timed task is still not due — "not skipped"
    // and "not early" are different things.
    expect(sends).toEqual(['先跑这个']);
    queue.cancelAll();
  });

  it('runs a past dueAt immediately instead of rejecting it', async () => {
    installStorage(fakeStorage([]));
    const chat = makeChat();
    const queue = new TaskQueue({
      chat,
      storageKey: 'pure_task_queue_test',
      getContext: () => ({ workspace: '/proj', sessionId: 'sess' }),
    });
    queue.enqueue('补跑一次', { dueAt: Date.now() - 1000 });
    await flush();
    expect(chat.sends).toEqual(['补跑一次']);
    queue.cancelAll();
  });

  it('re-arms its own timer for a timed task restored from storage', async () => {
    // Without the boot-time arm the restored task would sit until some
    // unrelated event happened to call runNext().
    installStorage(fakeStorage([
      { ...storedTask({ id: 'q1', text: '到点就跑', workspace: '/proj', sessionId: 'sess' }), dueAt: Date.now() + 40 },
    ]));
    const chat = makeChat();
    void new TaskQueue({
      chat,
      storageKey: 'pure_task_queue_test',
      getContext: () => ({ workspace: '/proj', sessionId: 'sess' }),
    });
    await wait(15);
    expect(chat.sends).toEqual([]);
    await wait(60);
    expect(chat.sends).toEqual(['到点就跑']);
  });

  it('persists dueAt so a reload before the moment still holds the task', async () => {
    const storage = fakeStorage([]);
    installStorage(storage);
    const queue = new TaskQueue({
      chat: makeChat(),
      storageKey: 'pure_task_queue_test',
      getContext: () => ({ workspace: '/proj', sessionId: 'sess' }),
    });
    const dueAt = Date.now() + 60_000;
    queue.enqueue('晚点再跑', { dueAt });
    const persisted = JSON.parse(storage.store.pure_task_queue_test) as Array<{ dueAt?: number }>;
    expect(persisted[0].dueAt).toBe(dueAt);
    queue.cancelAll();
  });
});
