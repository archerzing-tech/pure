// src/shared/asyncQueue.ts
// The bridge between "events produced inside a running tool" and "the engine's
// async-generator event stream". The engine can only yield from its own
// generator body, so tool-interior happenings (subagent activity) must be
// buffered somewhere the engine can concurrently await while it also awaits
// the tool results themselves. AsyncQueue is that buffer; EventFanout lets one
// publisher (CodingAgent's progress sink) serve the per-batch readers the
// engine opens and closes around each tool-execution phase.

/** IteratorResult value type is awkward to spell for `T` that could contain
 * undefined; this alias keeps next() honest for object payloads. */
export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<{ resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }> = [];
  private closed = false;
  private error: unknown = undefined;

  /** Publisher side: hand one item to a pending waiter or buffer it. Pushes
   * after close() are silently dropped — a reader that stopped listening must
   * never slow down or resurrect for the publisher. */
  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.buffer.push(item);
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift()!, done: false });
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Synchronous read of everything buffered RIGHT NOW. Events that arrived
   * between two awaits of the consumer come out here instead of waiting for
   * the next racy next() — ordering beats microtask luck at phase edges. */
  drainAvailable(): T[] {
    return this.buffer.splice(0);
  }

  /** Consumer side, called by the engine when its batch ends: resolves any
   * dangling next() (done) and turns later pushes into no-ops. The fanout
   * prunes closed queues, so a per-batch reader never accumulates. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined as unknown as T, done: true });
  }

  isClosed(): boolean {
    return this.closed;
  }

  fail(err: unknown): void {
    if (this.closed) return;
    this.error = err;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  [Symbol.asyncIterator](): AsyncQueue<T> {
    return this;
  }
}

/** One publisher, N live readers. The engine subscribes a fresh reader per
 * tool-execution batch and closes it when the batch settles; publish() prunes
 * closed readers so a long session cannot accumulate dead queues. */
export class EventFanout<T> {
  private readers = new Set<AsyncQueue<T>>();

  subscribe(): AsyncQueue<T> {
    const q = new AsyncQueue<T>();
    this.readers.add(q);
    return q;
  }

  publish(item: T): void {
    for (const q of [...this.readers]) {
      if (q.isClosed()) this.readers.delete(q);
      else q.push(item);
    }
  }

  /** Test/teardown hook: how many live readers exist right now. */
  readerCount(): number {
    return this.readers.size;
  }
}
