import type { EngineContext, ToolCall, ToolResult } from '../shared/types';
import { safeParseArgs } from '../shared/format';
import { FileLockManager } from './FileLockManager';
import { runWithDeadline } from './streamDeadline';

export const TOOL_EXECUTION_TIMEOUT_MS = 180_000;

export interface ExecutedToolResult {
  toolName: string;
  result: ToolResult;
  duration: number;
  toolCallId: string;
}

export interface ToolExecutionBudget {
  incrementToolCall(): void;
  remaining(): { time: number };
}

export class ToolExecutionCoordinator {
  private readonly fallbackLock = new FileLockManager();

  async execute(
    toolCalls: ToolCall[],
    ctx: EngineContext,
    budget: ToolExecutionBudget,
  ): Promise<ExecutedToolResult[]> {
    if (!ctx.tools) return [];
    const reads: ToolCall[] = [];
    const writes: ToolCall[] = [];
    for (const call of toolCalls) {
      budget.incrementToolCall();
      const metadata = ctx.tools.getMetadata(call.function.name);
      if (metadata?.isWrite || metadata?.sideEffects) writes.push(call);
      else reads.push(call);
    }

    const readResults = await Promise.all(reads.map(call => this.executeOne(call, ctx, budget, false)));
    const writeResults: ExecutedToolResult[] = [];
    for (const call of writes) writeResults.push(await this.executeOne(call, ctx, budget, true));
    return [...readResults, ...writeResults];
  }

  private async executeOne(
    call: ToolCall,
    ctx: EngineContext,
    budget: ToolExecutionBudget,
    write: boolean,
  ): Promise<ExecutedToolResult> {
    let path = '';
    try {
      const args = safeParseArgs(call.function.arguments);
      path = typeof args.path === 'string' ? args.path : '';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        toolName: call.function.name,
        result: { id: call.id, toolName: call.function.name, error: message || 'invalid tool arguments', success: false, duration: 0 },
        duration: 0,
        toolCallId: call.id,
      };
    }
    const lockManager = ctx.lockManager ?? this.fallbackLock;
    try {
      if (path) {
        if (write) await lockManager.acquireWrite(path, ctx.signal);
        else await lockManager.acquireRead(path, ctx.signal);
      }
      try {
        const controller = new AbortController();
        const forwardAbort = (): void => controller.abort();
        ctx.signal?.addEventListener('abort', forwardAbort, { once: true });
        try {
          const result = await runWithDeadline(
            () => ctx.tools!.execute(call, controller.signal),
            ctx.signal,
            Math.min(TOOL_EXECUTION_TIMEOUT_MS, Math.max(1, budget.remaining().time)),
            `tool ${call.function.name}`,
            () => controller.abort(),
          );
          return { toolName: call.function.name, result, duration: result.duration, toolCallId: call.id };
        } finally {
          ctx.signal?.removeEventListener('abort', forwardAbort);
        }
      } finally {
        if (path) lockManager.release(path);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        toolName: call.function.name,
        result: { id: call.id, toolName: call.function.name, error: message || 'unknown', success: false, duration: 0 },
        duration: 0,
        toolCallId: call.id,
      };
    }
  }
}
