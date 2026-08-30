// src/__tests__/taskQueue.test.ts
// TaskQueue state machine: serial execution, failure continuation, cancel
// semantics, and localStorage persistence round-trip. Uses a controllable fake
// chat (send resolves only when the test resolves it) + in-memory storage.

import { beforeEach, describe, expect, it } from 'bun:test';
import { TaskQueue } from '../ui/taskQueue';

/** Fake chat: each send() is parked until resolveNext()/abortNext() is called. */
class FakeChat {
  calls: string[] = [];
  cancelCalls = 0;
  private failFor = new Set<string>();
  private deferred: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  constructor(failFor: string[] = []) {
    this.failFor = new Set(failFor);
  }

  send(text: string): Promise<void> {
    this.calls.push(text);
    return new Promise((resolve, reject) => {
      if (this.failFor.has(text)) {
        queueMicrotask(() => reject(new Error(`boom:${text}`)));
        return;
      }
      this.deferred.push({ resolve, reject });
    });
  }

  /** Resolve the oldest parked send (turn completed). */
  resolveNext(): void {
    this.deferred.shift()?.resolve();
  }

  /** Reject the oldest parked send like an aborted turn (supersede / cancel). */
  abortNext(): void {
    const d = this.deferred.shift();
    if (d) {
      const e = new Error('turn aborted');
      e.name = 'AbortError';
      d.reject(e);
    }
  }

  cancel(): void {
    this.cancelCalls++;
  }
}

/** A minimal Storage backed by a Map, installed as the global localStorage. */
function installFakeStorage(): Map<string, string> {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
  // lib.dom.d.ts types window.localStorage as readonly — defineProperty bypasses.
  // writable:true keeps the property assignable for other test files that stub
  // it with a plain assignment (e.g. configMigration.test.ts).
  Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true, configurable: true });
  return mem;
}

async function until(pred: () => boolean, timeout = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('condition timed out');
    await new Promise((r) => setTimeout(r, 0));
  }
}

let mem: Map<string, string>;

beforeEach(() => {
  mem = installFakeStorage();
});

describe('TaskQueue', () => {
  it('runs tasks strictly in order, one at a time', async () => {
    const chat = new FakeChat();
    const queue = new TaskQueue({ chat, storageKey: 'k' });
    queue.enqueue(['one', 'two', 'three']);

    // First task starts synchronously on enqueue; the second must wait.
    expect(chat.calls).toEqual(['one']);
    expect(queue.getTasks()[0].status).toBe('running');
    expect(queue.getTasks()[1].status).toBe('pending');

    chat.resolveNext(); // one → done
    await until(() => chat.calls.length === 2);
    expect(chat.calls).toEqual(['one', 'two']);

    chat.resolveNext(); // two → done
    await until(() => chat.calls.length === 3);
    expect(chat.calls).toEqual(['one', 'two', 'three']);
    expect(queue.getTasks()[2].status).toBe('running');

    chat.resolveNext(); // three → done
    await until(() => queue.getTasks().every((x) => x.status === 'done'));
    expect(queue.getTasks().map((x) => x.status)).toEqual(['done', 'done', 'done']);
  });

  it('does not start the next task until the previous send resolves', async () => {
    const chat = new FakeChat();
    const queue = new TaskQueue({ chat, storageKey: 'k' });
    queue.enqueue(['a', 'b']);
    expect(chat.calls).toEqual(['a']);

    // Give the queue many turns to (wrongly) advance — b must stay parked.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(chat.calls).toEqual(['a']);

    chat.resolveNext();
    await until(() => chat.calls.length === 2);
    expect(chat.calls).toEqual(['a', 'b']);
  });

  it('marks a failed task failed and continues with the rest', async () => {
    const chat = new FakeChat(['two']);
    const queue = new TaskQueue({ chat, storageKey: 'k' });
    queue.enqueue(['one', 'two', 'three']);

    chat.resolveNext(); // one → done
    await until(() => queue.getTasks()[1].status === 'failed');
    expect(queue.getTasks()[1].error).toBe('boom:two');

    chat.resolveNext(); // three → done
    await until(() => queue.getTasks()[2].status === 'done');
    const statuses = queue.getTasks().map((x) => x.status);
    expect(statuses).toEqual(['done', 'failed', 'done']);
  });

  it('cancels a pending task without touching the running one', async () => {
    const chat = new FakeChat();
    const queue = new TaskQueue({ chat, storageKey: 'k' });
    queue.enqueue(['a', 'b', 'c']);
    expect(chat.calls).toEqual(['a']);

    queue.cancel(queue.getTasks()[1].id); // cancel 'b'
    expect(queue.getTasks()[1].status).toBe('cancelled');

    chat.resolveNext(); // a done → queue advances to c
    await until(() => chat.calls.join() === 'a,c');
    chat.resolveNext(); // c done
    await until(() => queue.getTasks().every((x) => x.status !== 'running'));
    expect(queue.getTasks().map((x) => x.status)).toEqual(['done', 'cancelled', 'done']);
  });

  it('cancelling the running task aborts the turn and marks it cancelled', async () => {
    const chat = new FakeChat();
    const queue = new TaskQueue({ chat, storageKey: 'k' });
    queue.enqueue(['a']);
    expect(chat.calls).toEqual(['a']);

    queue.cancel(queue.getTasks()[0].id);
    expect(chat.cancelCalls).toBe(1);
    chat.abortNext(); // the abort surfaces as AbortError from send
    await until(() => queue.getTasks()[0].status !== 'running');

    const task = queue.getTasks()[0];
    expect(task.status).toBe('cancelled');
    expect(task.error).toBeUndefined();
  });

  it('treats a user-interjection abort as cancelled, not failed', async () => {
    const chat = new FakeChat();
    const queue = new TaskQueue({ chat, storageKey: 'k' });
    queue.enqueue(['long running task']);
    expect(chat.calls).toEqual(['long running task']);

    // A new message sent by the user aborts the queue's in-flight turn.
    chat.abortNext();
    await until(() => queue.getTasks()[0].status !== 'running');
    expect(queue.getTasks()[0].status).toBe('cancelled');
    expect(queue.getTasks()[0].error).toBeUndefined();
  });

  it('persists pending/running tasks and resumes after reload', async () => {
    const chat1 = new FakeChat();
    const q1 = new TaskQueue({ chat: chat1, storageKey: 'k' });
    q1.enqueue(['one', 'two']);
    expect(q1.getTasks()[0].status).toBe('running');
    expect(q1.getTasks()[1].status).toBe('pending');

    // On disk: one is mid-run, two is queued.
    const stored = JSON.parse(mem.get('k')!) as Array<{ text: string; status: string }>;
    expect(stored.find((x) => x.text === 'one')?.status).toBe('running');
    expect(stored.find((x) => x.text === 'two')?.status).toBe('pending');

    // A fresh queue over the same storage resumes: a mid-run task reloads as
    // pending, then restarts automatically.
    const chat2 = new FakeChat();
    const q2 = new TaskQueue({ chat: chat2, storageKey: 'k' });
    expect(q2.getTasks()[0].status).toBe('pending'); // running → pending on load
    await until(() => q2.getTasks()[0].status === 'running' && chat2.calls.length === 1);
    expect(chat2.calls).toEqual(['one']);
    expect(q2.getTasks()[1].status).toBe('pending');
  });

  it('cancelAll flattens every pending task', async () => {
    const chat = new FakeChat();
    const queue = new TaskQueue({ chat, storageKey: 'k' });
    queue.enqueue(['a', 'b', 'c']);
    expect(chat.calls).toEqual(['a']);

    queue.cancelAll();
    expect(chat.cancelCalls).toBe(1); // the running turn is aborted too
    chat.abortNext();
    await until(() => queue.getTasks().every((x) => x.status !== 'running'));
    expect(queue.getTasks().map((x) => x.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });
});
