// src/ui/taskQueue.ts
// 批量任务队列: submit a batch of tasks, run them SEQUENTIALLY through the
// ChatController, persist pending state to localStorage so a reload resumes.
//
// Chat is single-flight — every send() aborts the previous turn — so the queue
// is strictly serial: start the next task only after the previous send()
// promise settles. A user interjecting mid-run supersedes the queue's turn; the
// queue sees the superseded send settle and simply advances.
//
// Model-only (no DOM): the panel lives in taskQueuePanel.ts, the runner drives
// the injected ChatController. Unit-tested with a fake chat + fake storage.

import type { ChatController } from './chat';

export type QueueTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface QueueTask {
  id: string;
  text: string;
  displayText: string;
  status: QueueTaskStatus;
  ts: number;
  workspace: string;
  sessionId: string;
  error?: string;
}

/** Minimal chat surface the queue drives (ChatController satisfies it). */
export interface QueueChat {
  send(userText: string): Promise<void>;
  /** Abort the in-flight turn (ChatController.cancel). Optional for fakes. */
  cancel?: () => void;
}

const STORAGE_KEY = 'pure_task_queue';

let nextId = 1;
function genId(): string {
  return `q${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

function loadStored(key: string): QueueTask[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueueTask[];
    if (!Array.isArray(parsed)) return [];
    // A reloaded queue never resumes a half-finished turn; running → pending.
    return parsed
      .filter((t) => t && typeof t.text === 'string')
      .map((t) => (t.status === 'running' ? { ...t, status: 'pending' as const } : t));
  } catch {
    return [];
  }
}

export interface TaskQueueContext {
  workspace: string;
  sessionId: string;
}

export interface TaskQueueOptions {
  chat: QueueChat;
  storageKey?: string;
  getContext?: () => TaskQueueContext;
}

export class TaskQueue {
  private readonly chat: QueueChat;
  private readonly storageKey: string;
  private readonly getContext: () => TaskQueueContext;
  private tasks: QueueTask[] = [];
  private running = false;
  private listeners = new Set<() => void>();

  constructor(opts: TaskQueueOptions) {
    this.chat = opts.chat;
    this.storageKey = opts.storageKey ?? STORAGE_KEY;
    this.getContext = opts.getContext ?? (() => ({ workspace: '', sessionId: '' }));
    this.tasks = loadStored(this.storageKey).map((task) => ({
      ...task,
      workspace: task.workspace ?? '',
      sessionId: task.sessionId ?? '',
    }));
    if (this.tasks.some((t) => t.status === 'pending' && this.isRunnable(t))) {
      // Kick off any pending work restored from storage once the caller has
      // fully wired the chat (defer so the UI can subscribe first).
      queueMicrotask(() => void this.runNext());
    }
  }

  getTasks(): QueueTask[] {
    const context = this.getContext();
    return this.tasks.filter((task) =>
      task.workspace === context.workspace && task.sessionId === context.sessionId,
    );
  }

  /** True when no queue task is currently driving the chat. */
  isIdle(): boolean {
    return !this.running;
  }

  /** Tasks without an owner are legacy records and require explicit handling. */
  private isRunnable(task: QueueTask): boolean {
    const context = this.getContext();
    return task.workspace === context.workspace && task.sessionId === context.sessionId;
  }

  hasLegacyTasks(): boolean {
    return this.tasks.some((task) => !task.workspace && !task.sessionId && task.status === 'pending');
  }

  /** Explicitly assign legacy tasks to the current context before running them. */
  adoptLegacyTasks(): void {
    const context = this.getContext();
    let changed = false;
    for (const task of this.tasks) {
      if (task.status === 'pending' && !task.workspace && !task.sessionId) {
        task.workspace = context.workspace;
        task.sessionId = context.sessionId;
        changed = true;
      }
    }
    if (!changed) return;
    this.persist();
    this.emit();
    void this.runNext();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Enqueue one or more tasks (strings may contain newlines → one per line). */
  enqueue(texts: string | string[]): void {
    const list = (Array.isArray(texts) ? texts : [texts]).flatMap((t) => t.split(/\r?\n/));
    const now = Date.now();
    const context = this.getContext();
    for (const text of list) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      this.tasks.push({
        id: genId(),
        text: trimmed,
        displayText: trimmed,
        status: 'pending',
        ts: now,
        workspace: context.workspace,
        sessionId: context.sessionId,
      });
    }
    this.persist();
    this.emit();
    void this.runNext();
  }

  cancel(id: string): void {
    const task = this.tasks.find((t) => t.id === id && this.isRunnable(t));
    if (!task) return;
    if (task.status === 'running') {
      // Abort the in-flight turn; it settles and runNext advances past it.
      this.cancelRunning = true;
      // The chat's own cancel stops the active stream.
      this.chat.cancel?.();
    }
    if (task.status !== 'running') {
      task.status = 'cancelled';
      this.persist();
      this.emit();
    }
  }

  private cancelRunning = false;

  cancelAll(): void {
    let anyRunning = false;
    for (const t of this.tasks) {
      if (!this.isRunnable(t)) continue;
      if (t.status === 'pending') t.status = 'cancelled';
      else if (t.status === 'running') anyRunning = true;
    }
    if (anyRunning) {
      this.cancelRunning = true;
      this.chat.cancel?.();
    }
    this.persist();
    this.emit();
  }

  clearDone(): void {
    const context = this.getContext();
    this.tasks = this.tasks.filter((t) =>
      t.status === 'pending'
      || t.status === 'running'
      || t.workspace !== context.workspace
      || t.sessionId !== context.sessionId,
    );
    this.persist();
    this.emit();
  }

  private async runNext(): Promise<void> {
    if (this.running) return;
    const next = this.tasks.find((t) => t.status === 'pending' && this.isRunnable(t));
    if (!next) return;
    this.running = true;
    this.cancelRunning = false;
    next.status = 'running';
    this.persist();
    this.emit();
    try {
      await this.chat.send(next.text);
      if (this.cancelRunning && next.status === 'running') next.status = 'cancelled';
      else next.status = 'done';
    } catch (err) {
      // A user interjection aborts our in-flight turn (chat is single-flight),
      // surfacing as AbortError; that's a supersede, not a task failure.
      const superseded = this.cancelRunning || (err as Error)?.name === 'AbortError';
      next.status = superseded ? 'cancelled' : 'failed';
      if (!superseded) next.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.running = false;
      this.cancelRunning = false;
      this.persist();
      this.emit();
      void this.runNext();
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.tasks));
    } catch {
      // Storage full / unavailable — the in-memory queue still works this run.
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
