// src/engine/FileLockManager.ts
// v0.10 — path-level read/write locks for safe concurrent tool execution.
// Scheduling is writer-preference: once a writer queues, later readers must
// queue behind it (no starvation), and when the lock frees, the head of the
// queue is granted — a writer alone, or all consecutive queued readers at once.

type LockType = 'read' | 'write';

interface Waiter {
  type: LockType;
  resolve: () => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

interface LockEntry {
  type: LockType;
  count: number;
  queue: Waiter[];
  waitingWriters: number;
}

export class FileLockManager {
  private locks = new Map<string, LockEntry>();

  async acquireRead(path: string, signal?: AbortSignal): Promise<void> {
    return this.acquire(path, 'read', signal);
  }

  async acquireWrite(path: string, signal?: AbortSignal): Promise<void> {
    return this.acquire(path, 'write', signal);
  }

  release(path: string): void {
    const entry = this.locks.get(path);
    if (!entry) return;

    entry.count--;

    // Grant the queue whenever the lock is fully free. With multiple
    // concurrent readers this only happens when the LAST reader releases —
    // granting there (not on every decrement) keeps readers/readers fair.
    if (entry.count === 0) {
      this.grant(entry);
    }

    if (entry.count === 0 && entry.queue.length === 0) {
      this.locks.delete(path);
    }
  }

  private async acquire(path: string, type: LockType, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error(`Lock acquire aborted (${path})`);
    }
    let entry = this.locks.get(path);
    if (!entry) {
      entry = { type, count: 0, queue: [], waitingWriters: 0 };
      this.locks.set(path, entry);
    }

    // Writer-preference admission: a new reader may only enter immediately when
    // (a) the lock is free, or (b) it is already read-held AND no writer is
    // waiting. Once a writer is queued, new readers join the queue behind it —
    // this is what prevents writer starvation under continuous reader traffic.
    const canAcquire =
      entry.count === 0 ||
      (entry.type === 'read' && type === 'read' && entry.waitingWriters === 0);

    if (canAcquire) {
      entry.count++;
      entry.type = type;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { type, resolve, reject, signal };
      if (type === 'write') entry.waitingWriters++;
      // Abort support: a cancelled turn must not leave a waiter parked in the
      // queue forever (the lock owner may run for a long time). Remove it and
      // reject so the caller's catch treats it like any other tool failure.
      waiter.onAbort = () => {
        const idx = entry.queue.indexOf(waiter);
        if (idx >= 0) {
          entry.queue.splice(idx, 1);
          if (type === 'write') entry.waitingWriters--;
        }
        reject(new Error(`Lock acquire aborted (${path})`));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      entry.queue.push(waiter);
    });
  }

  /**
   * Wake the waiters now that the lock is free. FIFO: the head of the queue
   * decides. A writer takes the lock alone (exclusive); a reader is granted
   * together with every consecutive reader behind it (they share), stopping
   * before the next queued writer.
   */
  private grant(entry: LockEntry): void {
    if (entry.queue.length === 0) return;

    const head = entry.queue[0];
    if (head.type === 'write') {
      entry.queue.shift();
      entry.waitingWriters--;
      entry.type = 'write';
      entry.count = 1;
      if (head.signal && head.onAbort) head.signal.removeEventListener('abort', head.onAbort);
      head.resolve();
      return;
    }

    // Grant all consecutive readers at the head of the queue.
    let n = 0;
    while (n < entry.queue.length && entry.queue[n].type === 'read') n++;
    const granted = entry.queue.splice(0, n);
    entry.type = 'read';
    entry.count = granted.length;
    for (const w of granted) {
      // The waiter won the lock — its abort listener must not fire later and
      // reject an already-resolved promise (or worse, remove a granted waiter).
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      w.resolve();
    }
  }
}
