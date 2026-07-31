// src/harness/Harness.ts
// v0.5 — Harness with session persistence, context management, and stream integration.
// Fixes: ContextEngine used in run() too, StreamManager wired in, checkpoints saved at key transitions.

import { AgentLoopEngine } from '../engine/AgentLoopEngine';
import { StateManager } from './StateManager';
import { ContextEngine } from './ContextEngine';
import { FileWatcher, type FileChangeEvent } from './FileWatcher';
import type {
  BudgetConfig,
  EngineContext,
  EngineEvent,
  FailurePolicy,
  HookRouter,
  IStateStore,
  LLMAdapter,
  Message,
  ToolAdapter,
  ToolDefinition,
} from '../shared/types';

export interface HarnessConfig {
  sessionId: string;
  llm: LLMAdapter;
  tools?: ToolAdapter;
  toolsDefs: ToolDefinition[];
  /**
   * Optional: recompute toolsDefs at every run()/continueTurn().
   * Lets tools registered after construction (e.g. MCP tools discovered
   * asynchronously) reach the LLM on the next run.
   */
  toolsDefsProvider?: () => ToolDefinition[];
  budget: BudgetConfig;
  stateStore?: IStateStore;
  contextEngine?: ContextEngine;
  fileWatcher?: FileWatcher;
  /**
   * Verifier consulted by the engine's VERIFY phase. When omitted the phase
   * passes trivially (the LLM's final output is trusted as-is).
   */
  verifier?: EngineContext['verifier'];
  /**
   * Lifecycle hooks dispatched at engine phases (before/after think/act/
   * verify, on_budget_warning). When omitted the engine runs without hooks.
   */
  hooks?: HookRouter;
  /**
   * Failure recovery policy (retry → reflect → degrade → stop). When omitted
   * tool/verify failures fall back to the engine's default messaging.
   */
  failurePolicy?: FailurePolicy;
}

export class Harness {
  private engine: AgentLoopEngine;
  private config: HarnessConfig;
  private stateMgr?: StateManager;

  constructor(config: HarnessConfig) {
    this.engine = new AgentLoopEngine();
    this.config = config;
    if (config.stateStore) {
      this.stateMgr = new StateManager(config.stateStore, config.sessionId);
    }
  }

  private buildContext(signal?: AbortSignal): EngineContext {
    return {
      llm: this.config.llm,
      tools: this.config.tools,
      toolsDefs: this.config.toolsDefsProvider ? this.config.toolsDefsProvider() : this.config.toolsDefs,
      budget: this.config.budget,
      verifier: this.config.verifier,
      hooks: this.config.hooks,
      failurePolicy: this.config.failurePolicy,
      signal,
    };
  }

  getStateManager(): StateManager | undefined {
    return this.stateMgr;
  }

  getFileWatcher(): FileWatcher | undefined {
    return this.config.fileWatcher;
  }

  async *run(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
  ): AsyncGenerator<EngineEvent, void, void> {
    let runningMessages: Message[] = [];
    let resumed = false;
    if (this.stateMgr) {
      const saved = this.stateMgr.loadLatest();
      if (saved && saved.messages.length > 0) {
        runningMessages = saved.messages;
        resumed = true;
      }
    }

    // ── Resume (P1-7): feed the checkpoint as initial context ──
    // Previously the loaded messages were only used for checkpoint saving —
    // the engine restarted from a blank [system, user] context, so `--resume`
    // runs forgot the conversation. When a checkpoint exists, route through
    // engine.continue() with the saved history (swapping in the current
    // system prompt so fresh memory/instructions apply), and trim long
    // histories the same way continueTurn does.
    let msgs = runningMessages;
    if (resumed) {
      msgs = runningMessages[0]?.role === 'system'
        ? [{ role: 'system', content: systemPrompt }, ...runningMessages.slice(1)]
        : [{ role: 'system', content: systemPrompt }, ...runningMessages];
      if (this.config.contextEngine) {
        msgs = await this.config.contextEngine.trim(msgs);
      }
    }

    const stream = resumed
      ? this.engine.continue(
          {
            sessionId: this.config.sessionId,
            newUserPrompt: userPrompt,
            messages: msgs,
            budget: this.config.budget,
          },
          this.buildContext(signal),
        )
      : this.engine.run(
          {
            sessionId: this.config.sessionId,
            systemPrompt,
            userPrompt,
            budget: this.config.budget,
          },
          this.buildContext(signal),
        );

    for await (const event of stream) {
      yield event;

      // Track messages for checkpoint saving
      if (event.type === 'Completed' && event.payload.messages) {
        runningMessages = event.payload.messages;
        if (this.stateMgr) {
          await this.stateMgr.saveCheckpoint('turn_completed', event.payload.messages, event.payload.turnCount);
        }
      }
      if (this.stateMgr && event.type === 'Interrupted') {
        try {
          await this.stateMgr.saveCheckpoint('interrupted', runningMessages, 0);
        } catch { /* persistence error is non-fatal */ }
      }
    }
  }

  async *continueTurn(
    systemPrompt: string,
    messages: Message[],
    newUserPrompt: string,
    signal?: AbortSignal,
  ): AsyncGenerator<EngineEvent, void, void> {
    let msgs = messages[0]?.role === 'system'
      ? messages
      : [{ role: 'system' as const, content: systemPrompt }, ...messages];

    // Context compression before continuing
    if (this.config.contextEngine) {
      msgs = await this.config.contextEngine.trim(msgs);
    }

    const stream = this.engine.continue(
      {
        sessionId: this.config.sessionId,
        newUserPrompt,
        messages: msgs,
        budget: this.config.budget,
      },
      this.buildContext(signal),
    );

    for await (const event of stream) {
      yield event;

      if (this.stateMgr && event.type === 'Completed' && event.payload.messages) {
        await this.stateMgr.saveCheckpoint('turn_completed', event.payload.messages, event.payload.turnCount);
      }
    }
  }
}
