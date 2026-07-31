// src/engine/FileLockManager.ts
// v0.3 — path-level read/write locks for safe concurrent tool execution.

type LockType = 'read' | 'write';

interface LockEntry {
  type: LockType;
  count: number;
  queue: Array<() => void>;
}

export class FileLockManager {
  private locks = new Map<string, LockEntry>();

  async acquireRead(path: string): Promise<void> {
    return this.acquire(path, 'read');
  }

  async acquireWrite(path: string): Promise<void> {
    return this.acquire(path, 'write');
  }

  release(path: string): void {
    const entry = this.locks.get(path);
    if (!entry) return;

    entry.count--;

    // Grant one waiting waiter — next release will grant the next
    if (entry.count === 0 && entry.queue.length > 0) {
      entry.type = 'read';
      const next = entry.queue.shift();
      if (next) {
        next(); // callback in acquire() does entry.count++ and sets type
      }
    }

    if (entry.count === 0) {
      this.locks.delete(path);
    }
  }

  private async acquire(path: string, type: LockType): Promise<void> {
    if (!this.locks.has(path)) {
      this.locks.set(path, { type, count: 0, queue: [] });
    }

    const entry = this.locks.get(path)!;

    const canAcquire =
      entry.count === 0 ||
      (entry.type === 'read' && type === 'read');

    if (canAcquire) {
      entry.count++;
      entry.type = type;
      return;
    }

    return new Promise(resolve => {
      entry.queue.push(() => {
        entry.count++;
        entry.type = type;
        resolve();
      });
    });
  }
}
