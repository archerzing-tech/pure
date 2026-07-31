// src/shared/EventBus.ts

type EventHandler<T = any> = (event: T) => void | Promise<void>;

export interface EventMap {
  [event: string]: any;
}

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    const key = event as string;
    if (!this.handlers.has(key)) this.handlers.set(key, new Set());
    this.handlers.get(key)!.add(handler);
  }

  off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    this.handlers.get(event as string)?.delete(handler);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    for (const handler of this.handlers.get(event as string) ?? []) {
      try { handler(payload); } catch { /*订阅者错误不传播*/ }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
