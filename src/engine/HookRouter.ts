// src/engine/HookRouter.ts
// v0.1 — Lifecycle hook router for the Agent Loop Engine.
// Registers handlers for 7 hook events and dispatches them at appropriate engine phases.

import type { HookEventType, HookEventHandler, HookResult, Message, AgentStateType } from '../shared/types';

export class DefaultHookRouter {
  private handlers = new Map<HookEventType, HookEventHandler[]>();

  register(hookType: HookEventType, handler: HookEventHandler): void {
    const list = this.handlers.get(hookType) ?? [];
    list.push(handler);
    this.handlers.set(hookType, list);
  }

  async dispatch(
    hookType: HookEventType,
    ctx: { messages: Message[]; turnCount: number; phase: AgentStateType },
  ): Promise<HookResult[]> {
    const list = this.handlers.get(hookType);
    if (!list || list.length === 0) return [];

    const results: HookResult[] = [];
    for (const handler of list) {
      try {
        results.push(await handler(hookType, ctx));
      } catch {
        results.push({ action: 'continue' });
      }
    }
    return results;
  }
}
