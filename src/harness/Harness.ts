// src/harness/Harness.ts
// v0.5 — Harness with session persistence, context management, and stream integration.
// Fixes: ContextEngine used in run() too, StreamManager wired in, checkpoints saved at key transitions.

import { AgentLoopEngine } from '../engine/AgentLoopEngine';
import { StateManager } from './StateManager';
import { ContextEngine } from './ContextEngine';
import { FileWatcher, type FileChangeEvent } from './FileWatcher';
import { PromptComposer } from '../adapter/memory/PromptComposer';
import type {
  BudgetConfig,
  EngineContext,
  EngineEvent,
  FailureAction,
  FailurePolicy,
  FailureRecord,
  HookRouter,
  IMemoryStore,
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
  /**
   * Cross-session long-term memory (Adapter Layer 设计文档 §12): memories are
   * retrieved at session start (searched with the user prompt, injected into
   * the system prompt's <session_memory> section) and written back when the
   * session completes. When omitted the session runs without memory.
   */
  memory?: IMemoryStore;
  /** Project path used to isolate memories; defaults to process.cwd(). */
  projectPath?: string;
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
  /** Memories older than this (14 days) get decayed at the start of a turn. */
  static readonly MEMORY_DECAY_MS = 14 * 24 * 60 * 60 * 1000;
  /** Throttle window: decay() scans every project's memory file, so it must
   *  not run on every turn — once an hour is plenty and keeps it cheap. */
  static readonly MEMORY_DECAY_INTERVAL_MS = 60 * 60 * 1000;

  private engine: AgentLoopEngine;
  private config: HarnessConfig;
  private stateMgr?: StateManager;
  private writtenLessonKeys = new Set<string>();
  private lastDecayAt = 0;
  private verificationSummary = 'Engine VERIFY phase passed; no project-level command was recorded.';

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
    this.verificationSummary = 'Engine VERIFY phase passed; no project-level command was recorded.';
    this.scheduleMemoryDecay();
    let runningMessages: Message[] = [];
    let resumed = false;
    if (this.stateMgr) {
      const saved = this.stateMgr.loadLatest();
      if (saved && saved.messages.length > 0) {
        runningMessages = saved.messages;
        resumed = true;
      }
    }

    // ── Memory retrieval (Layer 2 per Harness 设计文档 §3.8): at session
    // start, search the IMemoryStore with the user prompt and inject the
    // relevant preferences / error patterns into the system prompt's
    // <session_memory> section via PromptComposer.
    let effectiveSystemPrompt = systemPrompt;
    if (this.config.memory) {
      effectiveSystemPrompt = await this.composeMemoryPrompt(systemPrompt, userPrompt);
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
        ? [{ role: 'system', content: effectiveSystemPrompt }, ...runningMessages.slice(1)]
        : [{ role: 'system', content: effectiveSystemPrompt }, ...runningMessages];
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
            systemPrompt: effectiveSystemPrompt,
            userPrompt,
            budget: this.config.budget,
          },
          this.buildContext(signal),
        );

    // §12.3: failures the policy chose to retry — if the session later
    // completes successfully they become error_pattern memories ("retry 且
    // 最终成功"). Reset per run() invocation.
    const retriedFailures: FailureRecord[] = [];
    // v0.11/v0.12 — repeated-failure learning with transient-fault exemption:
    // when the SAME call (tool + error) fails again, the "勿重试" memory is
    // DEFERRED to session end. seenFailures marks the first occurrence;
    // pendingRepeats records each repeated call (dedupe per key); a repeat
    // whose tool LATER succeeds (3rd retry) is a transient fault — recovered
    // via recoveredRepeats — so only "Recovered after retry" is kept, not
    // "Do not make this exact call again".
    const seenFailures = new Set<string>();
    const pendingRepeats = new Map<string, FailureRecord>();
    const recoveredRepeats = new Set<string>();

    for await (const event of stream) {
      yield event;

      // v0.12 — observe tool success: a repeated failure whose tool later
      // succeeds was transient. Mark the matching pending repeat key(s)
      // recovered so the "勿重试" memory is skipped at session end.
      if (event.type === 'ToolResult' && event.payload.result.success) {
        for (const [key, failure] of pendingRepeats) {
          if (failure.toolName === event.payload.toolName) recoveredRepeats.add(key);
        }
      }

      // Memory write driven by the failure policy (Adapter Layer 设计文档 §12.3):
      // decide() → stop   → write error_pattern now (session can't proceed)
      // decide() → retry  → remember the failure; written on eventual success
      if (event.type === 'FailurePolicyDecision' && this.config.memory) {
        const failure = event.payload.failure;
        const repeatKey = `${failure.toolName ?? ''}::${failure.message}`;
        if (seenFailures.has(repeatKey)) {
          // Defer the "勿重试" write: at session end we skip it if the tool
          // later succeeded (transient fault).
          if (!pendingRepeats.has(repeatKey)) {
            pendingRepeats.set(repeatKey, failure);
          }
        } else {
          seenFailures.add(repeatKey);
        }
        if (event.payload.action.kind === 'stop') {
          await this.writeErrorPattern(event.payload.action, failure).catch(() => {});
        } else if (event.payload.action.kind === 'retry') {
          retriedFailures.push(failure);
        }
      }

      // Track messages for checkpoint saving
      if (event.type === 'Completed' && event.payload.messages) {
        runningMessages = event.payload.messages;
        this.updateVerificationSummary(event.payload.messages);
        if (this.stateMgr) {
          await this.stateMgr.saveCheckpoint('turn_completed', event.payload.messages, event.payload.turnCount);
        }
        // Memory write at session end (Adapter Layer 设计文档 §12.3): a
        // successful completion becomes a successful_pattern memory; failures
        // the policy retried and that eventually succeeded become error_pattern
        // memories. Failures never block the session.
        if (this.config.memory) {
          // v0.12 — flush deferred "勿重试" memories: skip repeat keys whose
          // tool later succeeded (transient fault) — those keep only the
          // "Recovered after retry" memory written below.
          for (const [key, failure] of pendingRepeats) {
            if (recoveredRepeats.has(key)) continue;
            await this.writeRepeatedFailureMemory(failure).catch(() => {});
          }
          pendingRepeats.clear();
          if (event.payload.isComplete) {
            await this.writeSessionMemory(
              userPrompt,
              event.payload.finalOutput,
              event.payload.messages,
              retriedFailures,
            ).catch(() => {});
          }
          if (event.payload.isComplete && retriedFailures.length > 0) {
            await this.writeRetriedErrorPatterns(retriedFailures).catch(() => {});
          }
        }
      }
      if (this.stateMgr && event.type === 'Interrupted') {
        try {
          // P1-9: the Interrupted event now carries the engine's live messages
          // (previously we saved `runningMessages`, which only updates on
          // Completed — so interrupted checkpoints lost the in-flight turn).
          // Trim trailing assistant toolCalls whose results never arrived so a
          // resume never feeds the API an unpaired tool_use.
          const snapshot = trimUnresolvedToolCalls(event.payload.messages ?? runningMessages);
          await this.stateMgr.saveCheckpoint('interrupted', snapshot, event.payload.turnCount ?? 0);
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
    this.verificationSummary = 'Engine VERIFY phase passed; no project-level command was recorded.';
    this.scheduleMemoryDecay();
    // Memory refresh on continuation: compose the current prompt with memories
    // relevant to the new follow-up (same layer as run()).
    let effectiveSystemPrompt = systemPrompt;
    if (this.config.memory) {
      effectiveSystemPrompt = await this.composeMemoryPrompt(systemPrompt, newUserPrompt);
    }

    let msgs = messages[0]?.role === 'system'
      ? [{ role: 'system' as const, content: effectiveSystemPrompt }, ...messages.slice(1)]
      : [{ role: 'system' as const, content: effectiveSystemPrompt }, ...messages];

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

    // Same §12.3 error_pattern handling as run(): a stop in a continuation
    // turn is a real failure worth remembering too.
    const retriedFailures: FailureRecord[] = [];
    // v0.11/v0.12 — same repeated-failure learning as run() (deferred "勿重试"
    // write with transient-fault exemption).
    const seenFailures = new Set<string>();
    const pendingRepeats = new Map<string, FailureRecord>();
    const recoveredRepeats = new Set<string>();

    for await (const event of stream) {
      yield event;

      // v0.12 — observe tool success (transient-fault exemption, same as run()).
      if (event.type === 'ToolResult' && event.payload.result.success) {
        for (const [key, failure] of pendingRepeats) {
          if (failure.toolName === event.payload.toolName) recoveredRepeats.add(key);
        }
      }

      if (event.type === 'FailurePolicyDecision' && this.config.memory) {
        const failure = event.payload.failure;
        const repeatKey = `${failure.toolName ?? ''}::${failure.message}`;
        if (seenFailures.has(repeatKey)) {
          // Defer the "勿重试" write: at session end we skip it if the tool
          // later succeeded (transient fault).
          if (!pendingRepeats.has(repeatKey)) {
            pendingRepeats.set(repeatKey, failure);
          }
        } else {
          seenFailures.add(repeatKey);
        }
        if (event.payload.action.kind === 'stop') {
          await this.writeErrorPattern(event.payload.action, failure).catch(() => {});
        } else if (event.payload.action.kind === 'retry') {
          retriedFailures.push(failure);
        }
      }

      if (event.type === 'Completed' && event.payload.messages) {
        this.updateVerificationSummary(event.payload.messages);
        if (this.stateMgr) {
          await this.stateMgr.saveCheckpoint('turn_completed', event.payload.messages, event.payload.turnCount);
        }
      }
      // §12.3 retried-error write — NOT gated on stateMgr: the GUI runs
      // continuation turns without a state store but with memory.
      if (event.type === 'Completed' && this.config.memory) {
        // v0.12 — flush deferred "勿重试" memories (transient-fault exemption).
        for (const [key, failure] of pendingRepeats) {
          if (recoveredRepeats.has(key)) continue;
          await this.writeRepeatedFailureMemory(failure).catch(() => {});
        }
        pendingRepeats.clear();
        if (event.payload.isComplete) {
          await this.writeSessionMemory(
            newUserPrompt,
            event.payload.finalOutput,
            event.payload.messages,
            retriedFailures,
          ).catch(() => {});
          if (retriedFailures.length > 0) {
            await this.writeRetriedErrorPatterns(retriedFailures).catch(() => {});
          }
        }
      }
      if (this.stateMgr && event.type === 'Interrupted') {
        try {
          const snapshot = trimUnresolvedToolCalls(event.payload.messages ?? []);
          await this.stateMgr.saveCheckpoint('interrupted', snapshot, event.payload.turnCount ?? 0);
        } catch { /* persistence error is non-fatal */ }
      }
    }
  }

  /**
   * Fire-and-forget memory decay: old, unused memories get their decayScore
   * halved so stale entries sink in retrieval and eventually drop below the
   * relevance floor. Throttled to once per hour — decay() scans every
   * project's memory file, so running it on every turn would be needless I/O
   * on long sessions. Best-effort: never blocks or fails a turn.
   */
  private scheduleMemoryDecay(): void {
    if (!this.config.memory) return;
    const now = Date.now();
    if (now - this.lastDecayAt < Harness.MEMORY_DECAY_INTERVAL_MS) return;
    this.lastDecayAt = now;
    void this.config.memory.decay(Harness.MEMORY_DECAY_MS).catch(() => {});
  }

  /**
   * Search the IMemoryStore with the user prompt and inject the top relevant
   * preferences / error patterns into the system prompt. Never throws — a
   * memory failure degrades to the plain system prompt.
   */
  private async composeMemoryPrompt(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
      const memories = await this.config.memory!.search(userPrompt, {
        k: 5,
        projectPath: this.projectPath(),
      });
      const preferences = memories
        .filter(m => m.type === 'user_preference')
        .map(m => m.content);
      const errorPatterns = memories
        .filter(m => m.type === 'error_pattern')
        .map(m => m.content);
      const procedures = memories
        .filter(m => m.type === 'procedure')
        .map(m => m.content);
      if (preferences.length === 0 && errorPatterns.length === 0 && procedures.length === 0) return systemPrompt;
      return new PromptComposer().compose({
        template: systemPrompt,
        memory: { preferences, errorPatterns, procedures },
        project: this.projectPath(),
      });
    } catch {
      return systemPrompt;
    }
  }

  /**
   * Write an error_pattern memory when the failure policy stops the session
   * (Adapter Layer 设计文档 §12.3: decide() → stop). Non-fatal.
   */
  private async writeErrorPattern(action: FailureAction, failure: FailureRecord): Promise<void> {
    if (!this.config.memory) return;
    const tool = failure.toolName ? ` (tool: ${failure.toolName})` : '';
    const reason = action.kind === 'stop' || action.kind === 'degrade'
      ? action.reason
      : (action as { hint?: string }).hint;
    const content = `Stopped by failure policy: ${failure.message}${tool}. ${reason ?? ''}`.trim().slice(0, 300);
    await this.config.memory.add({
      type: 'error_pattern',
      content,
      timestamp: Date.now(),
      sessionId: this.config.sessionId,
      projectPath: this.projectPath(),
    });
  }

  /**
   * Write error_pattern memories for failures the policy retried and that the
   * session eventually overcame (Adapter Layer 设计文档 §12.3: decide() → retry
   * 且最终成功). Non-fatal; failures never block the session.
   */
  private async writeRetriedErrorPatterns(failures: FailureRecord[]): Promise<void> {
    if (!this.config.memory) return;
    const seen = new Set<string>();
    for (const failure of failures) {
      if (seen.has(failure.message)) continue; // dedupe within the session
      seen.add(failure.message);
      const tool = failure.toolName ? ` (tool: ${failure.toolName})` : '';
      const content = `Recovered after retry: ${failure.message}${tool}`.slice(0, 300);
      await this.config.memory.add({
        type: 'error_pattern',
        content,
        timestamp: Date.now(),
        sessionId: this.config.sessionId,
        projectPath: this.projectPath(),
      });
    }
  }

  /**
   * v0.11/v0.12 — write an error_pattern memory for a call that failed
   * repeatedly within a session. Called at session end for repeat keys whose
   * tool never succeeded afterward (genuine dead-ends; interrupted sessions).
   * Transient faults (the tool later succeeded) are skipped by the caller —
   * they keep only the "Recovered after retry" memory. The memory tells
   * future sessions (via PromptComposer's <session_memory> injection) not to
   * repeat the exact call. Non-fatal.
   */
  private async writeRepeatedFailureMemory(failure: FailureRecord): Promise<void> {
    if (!this.config.memory) return;
    const tool = failure.toolName ? ` (tool: ${failure.toolName})` : '';
    const content = `Repeated failure: ${failure.message}${tool}. Do not make this exact call again — switch to a different approach.`.slice(0, 300);
    await this.config.memory.add({
      type: 'error_pattern',
      content,
      timestamp: Date.now(),
      sessionId: this.config.sessionId,
      projectPath: this.projectPath(),
    });
  }

  /**
   * Persist a compact, reusable lesson rather than a generic completion log.
   * The next similar task can retrieve the symptom/tool/recovery path from the
   * existing <session_memory> pipeline without replaying the whole transcript.
   */
  private async writeSessionMemory(
    userPrompt: string,
    finalOutput?: string,
    messages?: Message[],
    retriedFailures: FailureRecord[] = [],
  ): Promise<void> {
    if (!this.config.memory) return;
    const tools = [...new Set((messages ?? [])
      .filter(m => m.role === 'tool' && m.toolName)
      .map(m => m.toolName!))];
    const recovery = retriedFailures.length > 0
      ? `Diagnosed and recovered from ${[...new Set(retriedFailures.map(f => f.message.substring(0, 120)))].join(' | ')}`
      : 'No retry was required';
    const symptom = userPrompt.substring(0, 180);
    const lesson = {
      symptom,
      rootCause: retriedFailures.length > 0
        ? [...new Set(retriedFailures.map(f => f.message.substring(0, 160)))].join(' | ')
        : 'Not determined by the engine; no retry or failure metadata was recorded',
      recoveryPath: recovery,
      verification: this.verificationSummary,
      avoidNextTime: retriedFailures.length > 0
        ? 'Do not repeat the failed approach without new evidence; use the recorded recovery path.'
        : 'Keep the same inspection and verification sequence for similar tasks.',
      ...(tools.length > 0 ? { tools } : {}),
    };
    const dedupeKey = `${this.config.sessionId}:${userPrompt.trim().toLowerCase()}`;
    if (this.writtenLessonKeys.has(dedupeKey)) return;
    const parts = [
      `Symptom: ${lesson.symptom}`,
      `Root cause: ${lesson.rootCause}`,
      `Recovery path: ${lesson.recoveryPath}`,
      `Verification: ${lesson.verification}`,
      `Avoid next time: ${lesson.avoidNextTime}`,
      tools.length > 0 ? `Tools used: ${tools.join(', ')}` : 'Tools used: none recorded',
    ];
    if (finalOutput) parts.push(`Outcome: ${finalOutput.substring(0, 180)}`);
    await this.config.memory.add({
      type: 'successful_pattern',
      content: `Reusable lesson — ${parts.join('. ')}.`.slice(0, 900),
      timestamp: Date.now(),
      sessionId: this.config.sessionId,
      projectPath: this.projectPath(),
      lesson,
      dedupeKey,
    });
    // Skill/experience sink (procedure layer): a compact, actionable version of
    // the lesson — WHAT was achieved and the verified HOW — so future sessions
    // can apply the proven procedure instead of rediscovering it. Kept short
    // (the full lesson lives in the successful_pattern entry above).
    const procedure = `When facing "${lesson.symptom}": apply the verified procedure — ${lesson.recoveryPath}. Verify via: ${lesson.verification}.${lesson.avoidNextTime.startsWith('Do not repeat') ? ` If it fails, ${lesson.avoidNextTime}` : ''}`;
    await this.config.memory.add({
      type: 'procedure',
      content: procedure.slice(0, 600),
      timestamp: Date.now(),
      sessionId: this.config.sessionId,
      projectPath: this.projectPath(),
      dedupeKey: `procedure:${dedupeKey}`,
    });
    this.writtenLessonKeys.add(dedupeKey);
  }

  private updateVerificationSummary(messages: Message[]): void {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === 'tool' && message.toolName === 'execute_command') {
        this.verificationSummary = `Engine VERIFY phase passed; execute_command output was observed, but its purpose was not classified by the engine: ${message.content.slice(0, 180)}`;
        return;
      }
    }
  }

  private projectPath(): string {
    return this.config.projectPath ?? (typeof process !== 'undefined' ? process.cwd() : '');
  }
}

/**
 * Remove trailing assistant messages whose toolCalls never received tool
 * results (e.g. an after_think hook abort). Persisting them would leave an
 * unpaired tool_use in the checkpoint, which LLM APIs reject on resume.
 */
function trimUnresolvedToolCalls(messages: Message[]): Message[] {
  const result = [...messages];
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (last.role === 'assistant' && last.toolCalls?.length) {
      result.pop();
    } else {
      break;
    }
  }
  return result;
}
