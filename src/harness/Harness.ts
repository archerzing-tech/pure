// src/harness/Harness.ts
// v0.5 — Harness with session persistence, context management, and stream integration.
// Fixes: ContextEngine used in run() too, StreamManager wired in, checkpoints saved at key transitions.

import { AgentLoopEngine } from '../engine/AgentLoopEngine';
import { StateManager } from './StateManager';
import { ContextEngine, type ContextCompactionResult } from './ContextEngine';
import { PromptAssembler, promptAssembler, resolvePromptBudget, estimatePromptTokens, estimateToolDefinitionTokens, type PromptBudgetConfig } from '../shared/PromptAssembler';
import { promptObservability, promptVersion, type PromptObservability } from '../shared/promptObservability';
import { AdaptiveControlPlane, adaptiveControlPlane, type AdaptiveStrategy } from '../shared/adaptiveControl';
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
  MessageImage,
  ToolAdapter,
  ToolDefinition,
  VerificationSummary,
} from '../shared/types';
import { GLOBAL_MEMORY_SCOPE } from '../shared/types';
import type { SemanticRouteDecision } from '../coding-agent/types';

// Bounded wait for the memory retrieval that feeds the system prompt. The
// embedder's one-time load (WASM + ~80MB model) happens lazily inside the
// first search; capping it here keeps that cold load off the first token's
// critical path. A timeout degrades to the plain system prompt (memories are
// an enhancement, never a prerequisite).
const MEMORY_SEARCH_TIMEOUT_MS = 1500;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      promise.finally(() => clearTimeout(timer)).catch(() => {});
    }),
  ]);
}

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
  /** Shared prompt compiler used for runtime context and retrieved memory. */
  promptAssembler?: PromptAssembler;
  /** Provider/model context budget used for memory injection and history sizing. */
  promptBudget?: PromptBudgetConfig;
  /** Local-first trace collector; records hashes/metadata, never raw prompts by default. */
  observability?: PromptObservability;
  /** Runtime strategy selector; defaults to the shared adaptive control plane. */
  adaptiveControlPlane?: AdaptiveControlPlane;
  /** Project path used to isolate memories; defaults to process.cwd(). */
  projectPath?: string;
  /** Explicit capability signal; avoids treating a host cwd as a GUI workspace. */
  workspaceAvailable?: boolean;
  contextEngine?: ContextEngine;
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
  private verificationSummary = 'No project-level verification evidence was recorded.';
  private verificationPassed = false;
  private readonly promptAssembler: PromptAssembler;
  private readonly observability: PromptObservability;
  private readonly adaptiveControl: AdaptiveControlPlane;
  private currentAdaptiveStrategy?: AdaptiveStrategy;

  constructor(config: HarnessConfig) {
    this.engine = new AgentLoopEngine();
    this.config = config;
    this.promptAssembler = config.promptAssembler ?? promptAssembler;
    // The compiler is the source of truth when callers provide both objects;
    // this prevents assembly and run spans from landing in different sinks.
    this.observability = config.promptAssembler?.getObservability()
      ?? config.observability
      ?? promptObservability;
    this.adaptiveControl = config.adaptiveControlPlane ?? adaptiveControlPlane;
    if (config.contextEngine && config.promptBudget) {
      config.contextEngine.configureBudget(
        resolvePromptBudget(config.promptBudget).availableInputTokens,
        () => this.currentToolsDefs(),
      );
    }
    if (config.stateStore) {
      this.stateMgr = new StateManager(config.stateStore, config.sessionId);
    }
  }

  private currentToolsDefs(): ToolDefinition[] {
    return this.config.toolsDefsProvider ? this.config.toolsDefsProvider() : this.config.toolsDefs;
  }

  private buildContext(signal?: AbortSignal): EngineContext {
    return {
      llm: this.config.llm,
      tools: this.config.tools,
      toolsDefs: this.currentToolsDefs(),
      toolsDefsProvider: this.config.toolsDefsProvider,
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

  /** 上下文压缩引擎（GUI 在每轮完成后后台预压缩，避免下次发送时阻塞）。 */
  getContextEngine(): ContextEngine | undefined {
    return this.config.contextEngine;
  }

  /** The runtime strategy selected for the current/latest turn (includes
   * recommendedRoles / parallelRoles / complexity). */
  getAdaptiveStrategy(): AdaptiveStrategy | undefined {
    return this.currentAdaptiveStrategy;
  }

  async saveTranscriptCheckpoint(messages: Message[], turnCount = 1): Promise<void> {
    if (!this.stateMgr) return;
    await this.stateMgr.saveCheckpoint('transcript', messages, turnCount);
  }

  getLastContextCompactionResult(): ContextCompactionResult | undefined {
    return this.config.contextEngine?.getLastCompactionResult();
  }

  getObservability(): PromptObservability {
    return this.observability;
  }

  async *run(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
    images?: MessageImage[],
    semantic?: SemanticRouteDecision | null,
  ): AsyncGenerator<EngineEvent, void, void> {
    this.verificationSummary = 'No project-level verification evidence was recorded.';
    this.verificationPassed = false;
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
    // <session_memory> section (composeMemoryPrompt → promptAssembler).
    const effectiveSystemPrompt = await this.composeMemoryPrompt(systemPrompt, userPrompt, semantic);

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
            images,
            budget: this.config.budget,
          },
          this.buildContext(signal),
        );

    const traceId = this.observability.startRun({
      traceId: this.recordRuntimeAssembly(effectiveSystemPrompt, userPrompt, systemPrompt),
      sessionId: this.config.sessionId,
      provider: this.config.promptBudget?.provider,
      model: this.config.promptBudget?.model,
    });
    let traceFinished = false;
    const finishTrace = () => {
      if (traceFinished) return;
      traceFinished = true;
      this.observability.finishRun(traceId);
    };

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
    // v1.9.7 — every failed tool call this run (single failures included), so
    // abandoned dead-ends persist as error_pattern at session end; plus the
    // set of failure keys already written by an immediate stop decision.
    const failedCalls = new Map<string, FailureRecord>();
    const stopWrittenKeys = new Set<string>();

    try {
      for await (const event of stream) {
      this.observability.recordEvent(traceId, event);
      if (event.type === 'Completed') {
        finishTrace();
      } else if (event.type === 'Error' && !event.payload.recoverable) {
        finishTrace();
      }

      // v0.12 — observe tool success: a repeated failure whose tool later
      // succeeds was transient. Mark the matching pending repeat key(s)
      // recovered so the "勿重试" memory is skipped at session end.
      if (event.type === 'ToolResult' && event.payload.result.success) {
        for (const [key, failure] of pendingRepeats) {
          if (failure.toolName === event.payload.toolName) recoveredRepeats.add(key);
        }
        // v1.9.7 — the transient-fault exemption also covers single failures:
        // a tool that later succeeds was failing transiently, not a dead-end.
        for (const [key, failure] of failedCalls) {
          if (failure.toolName === event.payload.toolName) recoveredRepeats.add(key);
        }
      }
      // v1.9.7 — observe tool FAILURE: every failed execution is recorded so a
      // single (non-repeated) dead-end call is still persisted as an
      // error_pattern at session end — degradation must survive the session.
      if (event.type === 'ToolResult' && !event.payload.result.success) {
        const key = `${event.payload.toolName}::${event.payload.result.error ?? 'unknown'}`;
        if (!failedCalls.has(key)) {
          failedCalls.set(key, {
            type: 'tool_error',
            message: event.payload.result.error ?? 'unknown',
            turnNumber: 0,
            toolName: event.payload.toolName,
          });
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
          stopWrittenKeys.add(repeatKey);
          await this.writeErrorPattern(event.payload.action, failure, userPrompt).catch(() => {});
        } else if (event.payload.action.kind === 'retry') {
          retriedFailures.push(failure);
        }
      }

      // Track messages for checkpoint saving
      if (event.type === 'Completed' && event.payload.messages) {
        runningMessages = event.payload.messages;
        this.updateVerificationSummary(event.payload.messages, event.payload.verification);
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
          const writtenRepeatKeys = new Set<string>();
          for (const [key, failure] of pendingRepeats) {
            if (recoveredRepeats.has(key)) continue;
            writtenRepeatKeys.add(key);
            await this.writeRepeatedFailureMemory(failure, userPrompt).catch(() => {});
          }
          pendingRepeats.clear();
          // v1.9.7 — every failed execution is a candidate lesson: single
          // (non-repeated) failed calls the session abandoned are written as
          // error_pattern too — degradation must persist into new sessions,
          // not just for repeated or fatal failures. Transient faults (the
          // tool later succeeded) keep the v0.12 exemption.
          for (const [key, failure] of failedCalls) {
            if (recoveredRepeats.has(key)) continue;
            if (writtenRepeatKeys.has(key)) continue;
            if (retriedFailures.some(f => f.toolName === failure.toolName && f.message === failure.message)) continue;
            if (stopWrittenKeys.has(key)) continue;
            await this.writeSingleFailureMemory(failure, userPrompt).catch(() => {});
          }
          failedCalls.clear();
          if (event.payload.isComplete) {
            await this.writeSessionMemory(
              userPrompt,
              event.payload.finalOutput,
              event.payload.messages,
              retriedFailures,
            ).catch(() => {});
          }
          if (event.payload.isComplete && retriedFailures.length > 0) {
            await this.writeRetriedErrorPatterns(retriedFailures, userPrompt).catch(() => {});
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

      // Yield last: a consumer that breaks on Completed never resumes the
      // generator, so the checkpoint/memory side effects above must already
      // have run before the event is handed over.
      yield event;
      }
    } finally {
      finishTrace();
    }
  }

  async *continueTurn(
    systemPrompt: string,
    messages: Message[],
    newUserPrompt: string,
    signal?: AbortSignal,
    images?: MessageImage[],
    semantic?: SemanticRouteDecision | null,
  ): AsyncGenerator<EngineEvent, void, void> {
    this.verificationSummary = 'No project-level verification evidence was recorded.';
    this.verificationPassed = false;
    this.scheduleMemoryDecay();
    // Memory refresh on continuation: compose the current prompt with memories
    // relevant to the new follow-up (same layer as run()).
    const effectiveSystemPrompt = await this.composeMemoryPrompt(systemPrompt, newUserPrompt, semantic);

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
        images,
        messages: msgs,
        budget: this.config.budget,
      },
      this.buildContext(signal),
    );

    const traceId = this.observability.startRun({
      traceId: this.recordRuntimeAssembly(effectiveSystemPrompt, newUserPrompt, systemPrompt),
      sessionId: this.config.sessionId,
      provider: this.config.promptBudget?.provider,
      model: this.config.promptBudget?.model,
    });
    let traceFinished = false;
    const finishTrace = () => {
      if (traceFinished) return;
      traceFinished = true;
      this.observability.finishRun(traceId);
    };

    // Same §12.3 error_pattern handling as run(): a stop in a continuation
    // turn is a real failure worth remembering too.
    const retriedFailures: FailureRecord[] = [];
    // v0.11/v0.12 — same repeated-failure learning as run() (deferred "勿重试"
    // write with transient-fault exemption).
    const seenFailures = new Set<string>();
    const pendingRepeats = new Map<string, FailureRecord>();
    const recoveredRepeats = new Set<string>();
    // v1.9.7 — every failed tool call this run (single failures included), so
    // abandoned dead-ends persist as error_pattern at session end; plus the
    // set of failure keys already written by an immediate stop decision.
    const failedCalls = new Map<string, FailureRecord>();
    const stopWrittenKeys = new Set<string>();

    try {
      for await (const event of stream) {
      this.observability.recordEvent(traceId, event);
      if (event.type === 'Completed') {
        finishTrace();
      } else if (event.type === 'Error' && !event.payload.recoverable) {
        finishTrace();
      }

      // v0.12 — observe tool success (transient-fault exemption, same as run()).
      if (event.type === 'ToolResult' && event.payload.result.success) {
        for (const [key, failure] of pendingRepeats) {
          if (failure.toolName === event.payload.toolName) recoveredRepeats.add(key);
        }
        // v1.9.7 — the transient-fault exemption also covers single failures:
        // a tool that later succeeds was failing transiently, not a dead-end.
        for (const [key, failure] of failedCalls) {
          if (failure.toolName === event.payload.toolName) recoveredRepeats.add(key);
        }
      }
      // v1.9.7 — observe tool FAILURE: every failed execution is recorded so a
      // single (non-repeated) dead-end call is still persisted as an
      // error_pattern at session end — degradation must survive the session.
      if (event.type === 'ToolResult' && !event.payload.result.success) {
        const key = `${event.payload.toolName}::${event.payload.result.error ?? 'unknown'}`;
        if (!failedCalls.has(key)) {
          failedCalls.set(key, {
            type: 'tool_error',
            message: event.payload.result.error ?? 'unknown',
            turnNumber: 0,
            toolName: event.payload.toolName,
          });
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
          stopWrittenKeys.add(repeatKey);
          await this.writeErrorPattern(event.payload.action, failure, newUserPrompt).catch(() => {});
        } else if (event.payload.action.kind === 'retry') {
          retriedFailures.push(failure);
        }
      }

      if (event.type === 'Completed' && event.payload.messages) {
        this.updateVerificationSummary(event.payload.messages, event.payload.verification);
        if (this.stateMgr) {
          await this.stateMgr.saveCheckpoint('turn_completed', event.payload.messages, event.payload.turnCount);
        }
      }
      // §12.3 retried-error write — NOT gated on stateMgr: the GUI runs
      // continuation turns without a state store but with memory.
      if (event.type === 'Completed' && this.config.memory) {
        // v0.12 — flush deferred "勿重试" memories (transient-fault exemption).
        const writtenRepeatKeys = new Set<string>();
        for (const [key, failure] of pendingRepeats) {
          if (recoveredRepeats.has(key)) continue;
          writtenRepeatKeys.add(key);
          await this.writeRepeatedFailureMemory(failure, newUserPrompt).catch(() => {});
        }
        pendingRepeats.clear();
        // v1.9.7 — single (non-repeated) failed calls persist as error_pattern
        // too (see run() for the same flush); transient faults are exempt.
        for (const [key, failure] of failedCalls) {
          if (recoveredRepeats.has(key)) continue;
          if (writtenRepeatKeys.has(key)) continue;
          if (retriedFailures.some(f => f.toolName === failure.toolName && f.message === failure.message)) continue;
          if (stopWrittenKeys.has(key)) continue;
          await this.writeSingleFailureMemory(failure, newUserPrompt).catch(() => {});
        }
        failedCalls.clear();
        if (event.payload.isComplete) {
          await this.writeSessionMemory(
            newUserPrompt,
            event.payload.finalOutput,
            event.payload.messages,
            retriedFailures,
          ).catch(() => {});
          if (retriedFailures.length > 0) {
            await this.writeRetriedErrorPatterns(retriedFailures, newUserPrompt).catch(() => {});
          }
        }
      }
      if (this.stateMgr && event.type === 'Interrupted') {
        try {
          const snapshot = trimUnresolvedToolCalls(event.payload.messages ?? msgs);
          await this.stateMgr.saveCheckpoint('interrupted', snapshot, event.payload.turnCount ?? 0);
        } catch { /* persistence error is non-fatal */ }
      }

      // Yield last: a consumer that breaks on Completed never resumes the
      // generator, so the checkpoint/memory side effects above must already
      // have run before the event is handed over.
      yield event;
      }
    } finally {
      finishTrace();
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

  private recordRuntimeAssembly(systemPrompt: string, userPrompt: string, baseSystemPrompt: string): string {
    const budget = resolvePromptBudget(this.config.promptBudget);
    const toolDefinitions = this.currentToolsDefs();
    const estimatedToolTokens = estimateToolDefinitionTokens(toolDefinitions);
    const estimatedInputTokens = estimatePromptTokens(systemPrompt) + estimatePromptTokens(userPrompt) + estimatedToolTokens;
    const includedFragmentIds = ['runtime_context'];
    if (systemPrompt.includes('<adaptive_context>')) includedFragmentIds.push('adaptive_strategy');
    if (systemPrompt.includes('<session_memory>')) includedFragmentIds.push('session_memory');
    const omittedFragmentIds = systemPrompt.includes('<adaptive_context>') ? [] : ['adaptive_strategy'];
    return this.observability.recordAssembly({
      traceId: this.observability.findAssemblyTrace({
        sessionId: this.config.sessionId,
        systemPrompt: baseSystemPrompt,
        userPrompt,
      }),
      sessionId: this.config.sessionId,
      provider: budget.provider,
      model: budget.model,
      systemPrompt,
      userPrompt,
      promptVersion: promptVersion(systemPrompt),
      budget: {
        ...budget,
        estimatedInputTokens,
        estimatedToolTokens,
        includedFragmentIds,
        omittedFragmentIds,
        overBudget: estimatedInputTokens > budget.availableInputTokens,
      },
    });
  }

  /**
   * Search the IMemoryStore with the user prompt and inject the top relevant
   * preferences / error patterns into the system prompt. Never throws — a
   * memory failure degrades to the plain system prompt.
   */
  private async composeMemoryPrompt(systemPrompt: string, userPrompt: string, semantic?: SemanticRouteDecision | null): Promise<string> {
    let memories = [] as Awaited<ReturnType<IMemoryStore['search']>>;
    try {
      if (this.config.memory) {
        // v1.9.7 — k=10 so verified successes/procedures are not squeezed out
        // by a heap of error patterns; fragment priority in the assembler
        // orders proven approaches above avoid-lists when budget-constrained.
        // The search is raced against a timeout: the embedder's one-time load
        // (WASM + ~80MB model) must never delay the first LLM token — a slow
        // search degrades to the plain system prompt (same as a failure).
        memories = await withTimeout(
          this.config.memory.search(userPrompt, {
            k: 12,
            projectPath: this.projectPath(),
          }),
          MEMORY_SEARCH_TIMEOUT_MS,
          'memory search',
        );
      }
    } catch {
      memories = [];
    }

    const preferences = memories
      .filter(m => m.type === 'user_preference')
      .map(m => m.content);
    // Platform-verified tool preferences: only entries matching the CURRENT
    // platform (or platform-agnostic user-stated ones) are injected, so "works
    // on this machine" never leaks across OSes.
    const currentPlatform = this.currentPlatform();
    // Machine-global tool preferences are ALWAYS injected (not query-scoped):
    // a tool verified on this machine in ANY project should be visible in
    // every session, and tool names rarely share tokens with the user prompt
    // (semantic/keyword retrieval would miss them). Only non-dormant entries
    // qualify; per-project tool_preference entries (written before the global
    // scope existed) still ride in via the search results below.
    let globalToolPrefs: Awaited<ReturnType<IMemoryStore['list']>> = [];
    try {
      if (this.config.memory) {
        globalToolPrefs = this.config.memory.list({
          projectPath: GLOBAL_MEMORY_SCOPE,
          type: 'tool_preference',
          activeOnly: true,
        });
      }
    } catch {
      globalToolPrefs = [];
    }
    const toolPreferenceSeen = new Set<string>();
    const toolPreferences: string[] = [];
    for (const m of [...globalToolPrefs, ...memories]) {
      if (m.type !== 'tool_preference') continue;
      if (m.platform && m.platform !== currentPlatform) continue;
      if (toolPreferenceSeen.has(m.content)) continue;
      toolPreferenceSeen.add(m.content);
      toolPreferences.push(m.content);
    }
    // v1.9.7 — verified successes are injected with priority (they appear
    // before error patterns in <session_memory>), so the model prefers proven
    // approaches over unproven ones and treats failures as avoid-lists.
    const successes = memories
      .filter(m => m.type === 'successful_pattern')
      .map(m => m.content);
    const errorPatterns = memories
      .filter(m => m.type === 'error_pattern')
      .map(m => m.content);
    const procedures = memories
      .filter(m => m.type === 'procedure')
      .map(m => m.content);
    const strategy = this.adaptiveControl.select({
      prompt: userPrompt,
      environment: {
        now: Date.now(),
        timezone: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
        projectPath: this.projectPath(),
        hasWorkspace: this.config.workspaceAvailable ?? Boolean(this.projectPath()),
        toolCount: this.currentToolsDefs().length,
        verifierAvailable: Boolean(this.config.verifier),
        memoryAvailable: Boolean(this.config.memory),
      },
      learnedProcedures: procedures,
      recentFailures: errorPatterns,
      // 理解驱动的角色分配：把 LLM 语义路由的意图/复杂度/角色选择喂给策略层，
      // 让委托建议来自对任务的理解而不是关键词。undefined（路由超时/失败/续跑
      // 置 null）时策略层照旧走关键词兜底。
      semantic: semantic
        ? { tags: [semantic.intent], complexity: semantic.complexity, roles: semantic.subagents }
        : undefined,
    });
    this.currentAdaptiveStrategy = strategy;
    return this.promptAssembler.composeMemoryPrompt({
      template: systemPrompt,
      memory: {
        preferences,
        successes,
        errorPatterns,
        procedures,
        toolPreferences,
        project: this.config.memory ? this.projectPath() : undefined,
        adaptiveStrategy: strategy.directive,
      },
      budget: this.config.promptBudget,
      toolDefinitions: this.currentToolsDefs(),
    });
  }

  /**
   * Write an error_pattern memory when the failure policy stops the session
   * (Adapter Layer 设计文档 §12.3: decide() → stop). Non-fatal.
   */
  private async writeErrorPattern(action: FailureAction, failure: FailureRecord, symptom?: string): Promise<void> {
    if (!this.config.memory) return;
    const tool = failure.toolName ? ` (tool: ${failure.toolName})` : '';
    const reason = action.kind === 'stop' || action.kind === 'degrade'
      ? action.reason
      : (action as { hint?: string }).hint;
    const content = this.withSymptom(symptom, `Stopped by failure policy: ${failure.message}${tool}. ${reason ?? ''}`.trim()).slice(0, 300);
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
  private async writeRetriedErrorPatterns(failures: FailureRecord[], symptom?: string): Promise<void> {
    if (!this.config.memory) return;
    const seen = new Set<string>();
    for (const failure of failures) {
      if (seen.has(failure.message)) continue; // dedupe within the session
      seen.add(failure.message);
      const tool = failure.toolName ? ` (tool: ${failure.toolName})` : '';
      const content = this.withSymptom(symptom, `Recovered after retry: ${failure.message}${tool}`).slice(0, 300);
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
   * future sessions (via the <session_memory> injection) not to repeat the
   * exact call. Non-fatal.
   */
  private async writeRepeatedFailureMemory(failure: FailureRecord, symptom?: string): Promise<void> {
    if (!this.config.memory) return;
    const tool = failure.toolName ? ` (tool: ${failure.toolName})` : '';
    const content = this.withSymptom(symptom, `Repeated failure: ${failure.message}${tool}. Do not make this exact call again — switch to a different approach.`).slice(0, 300);
    await this.config.memory.add({
      type: 'error_pattern',
      content,
      timestamp: Date.now(),
      sessionId: this.config.sessionId,
      projectPath: this.projectPath(),
    });
  }

  /**
   * v1.9.7 — write an error_pattern for a SINGLE (non-repeated) failed tool
   * call that the session abandoned: the call failed, was never retried, and
   * the tool never succeeded later. Future sessions are told not to walk the
   * same dead-end — degradation persists even when the failure was neither
   * repeated nor fatal. Non-fatal.
   */
  private async writeSingleFailureMemory(failure: FailureRecord, symptom?: string): Promise<void> {
    if (!this.config.memory) return;
    const tool = failure.toolName ? ` (tool: ${failure.toolName})` : '';
    const content = this.withSymptom(symptom, `Failed during execution: ${failure.message}${tool}. Do not make this exact call again — switch to a different approach.`).slice(0, 300);
    await this.config.memory.add({
      type: 'error_pattern',
      content,
      timestamp: Date.now(),
      sessionId: this.config.sessionId,
      projectPath: this.projectPath(),
    });
  }

  /**
   * v1.9.7 — prefix a failure lesson with the original request so future
   * sessions asking a similar question can retrieve it by keyword overlap
   * (the raw error text alone rarely shares tokens with the user prompt).
   */
  private withSymptom(symptom: string | undefined, body: string): string {
    return symptom?.trim()
      ? `Symptom: ${symptom.trim().slice(0, 120)}. ${body}`
      : body;
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
    if (this.currentAdaptiveStrategy) {
      parts.push(`Runtime strategy: ${this.currentAdaptiveStrategy.exploration} exploration, ${this.currentAdaptiveStrategy.verification} verification, ${this.currentAdaptiveStrategy.recovery} recovery`);
    }
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
    const strategyNote = this.currentAdaptiveStrategy
      ? ` Runtime strategy selected from live signals: ${this.currentAdaptiveStrategy.exploration} exploration, ${this.currentAdaptiveStrategy.verification} verification, ${this.currentAdaptiveStrategy.recovery} recovery. Re-evaluate it against the next workspace evidence.`
      : '';
    const hasVerifiedEvidence = this.verificationPassed;
    const procedure = `When facing "${lesson.symptom}": apply the verified procedure — ${lesson.recoveryPath}. Verify via: ${lesson.verification}.${strategyNote}${lesson.avoidNextTime.startsWith('Do not repeat') ? ` If it fails, ${lesson.avoidNextTime}` : ''}`;
    if (hasVerifiedEvidence) {
      await this.config.memory.add({
        type: 'procedure',
        content: procedure.slice(0, 600),
        timestamp: Date.now(),
        sessionId: this.config.sessionId,
        projectPath: this.projectPath(),
        dedupeKey: `procedure:${dedupeKey}`,
      });
    }
    // Tool preferences: every distinct command tool this completed session ran
    // is, on balance, part of the working set on this platform. Persisted as
    // platform-bound tool_preference in the MACHINE-GLOBAL scope so future
    // sessions on the same OS — in ANY project — prefer tools that actually
    // work here (pnpm, uv, bun, …). Shell built-ins and trivial system
    // utilities are filtered out; dedupeKey keeps one entry per platform+tool
    // no matter how many sessions run it.
    const platform = this.currentPlatform();
    const commandTools = [...new Set((messages ?? [])
      .filter(m => m.role === 'assistant' && m.toolCalls)
      .flatMap(m => (m.toolCalls ?? []))
      .filter(tc => tc.function?.name === 'execute_command')
      .map(tc => {
        try { return (JSON.parse(tc.function.arguments) as { command?: unknown })?.command; } catch { return undefined; }
      })
      .filter((c): c is string => typeof c === 'string')
      .map(commandTool)
      .filter((t): t is string => !!t))];
    for (const tool of commandTools) {
      await this.config.memory.add({
        type: 'tool_preference',
        content: `Verified on ${platform}: the ${tool} tool works on this machine`,
        timestamp: Date.now(),
        sessionId: this.config.sessionId,
        projectPath: GLOBAL_MEMORY_SCOPE,
        platform,
        dedupeKey: `tool:${platform}:${tool}`,
      }).catch(() => {});
    }
    // [remember] markers the model deliberately emitted: a tool name →
    // platform-bound tool_preference in the machine-global scope (the model
    // judged it notably good on THIS machine); any other concise insight →
    // successful_pattern (a reusable approach/idea, project-scoped).
    for (const item of parseRememberMarkers(finalOutput ?? '')) {
      const tool = commandTool(item);
      if (tool) {
        await this.config.memory.add({
          type: 'tool_preference',
          content: `Notably good on ${platform}: the ${tool} tool (agent-verified)`,
          timestamp: Date.now(),
          sessionId: this.config.sessionId,
          projectPath: GLOBAL_MEMORY_SCOPE,
          platform,
          dedupeKey: `tool:${platform}:${tool}`,
        }).catch(() => {});
      } else {
        await this.config.memory.add({
          type: 'successful_pattern',
          content: `Effective approach: ${item.slice(0, 300)}`,
          timestamp: Date.now(),
          sessionId: this.config.sessionId,
          projectPath: this.projectPath(),
          dedupeKey: `remember:${item.trim().toLowerCase().slice(0, 80)}`,
        }).catch(() => {});
      }
    }
    this.writtenLessonKeys.add(dedupeKey);
  }

  private updateVerificationSummary(messages: Message[], verification?: VerificationSummary): void {
    this.verificationPassed = Boolean(verification?.status === 'passed' && verification.evidence.length > 0);
    if (verification && verification.evidence.length > 0) {
      const evidence = verification.evidence
        .map((item) => `${item.status}: ${item.summary}${item.command ? ` (${item.command})` : ''}`)
        .join(' | ')
        .slice(0, 700);
      this.verificationSummary = `Engine verification status: ${verification.status}. Evidence: ${evidence}`;
      return;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === 'tool' && message.toolName === 'execute_command') {
        this.verificationSummary = `An execute_command result was observed, but no structured verification evidence was recorded: ${message.content.slice(0, 180)}`;
        return;
      }
    }
  }

  private projectPath(): string {
    return this.config.projectPath ?? (typeof process !== 'undefined' ? process.cwd() : '');
  }

  /** process.platform-style label (darwin / win32 / linux / unknown) for the
   *  current host. GUI runs in a WebView (no process), so it falls back to the
   *  user agent. tool_preference memories are bound to this so "works on THIS
   *  machine" only applies on the same OS. */
  private currentPlatform(): string {
    if (typeof process !== 'undefined' && process.platform) return process.platform;
    if (typeof navigator !== 'undefined') {
      const ua = navigator.userAgent;
      if (/Windows/i.test(ua)) return 'win32';
      if (/Mac/i.test(ua)) return 'darwin';
      if (/Linux/i.test(ua)) return 'linux';
    }
    return 'unknown';
  }
}

/** Shell built-ins and trivial system utilities — present on every platform,
 * so persisting them as a "tool preference" would be pure noise. This is a
 * filter (what NOT to remember), not a whitelist (the model may remember any
 * other tool it finds useful). */
const TOOL_NOISE = new Set([
  'cd', 'echo', 'pwd', 'export', 'ls', 'dir', 'cat', 'less', 'more', 'head', 'tail',
  'grep', 'egrep', 'fgrep', 'find', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch',
  'chmod', 'chown', 'chgrp', 'ln', 'curl', 'wget', 'which', 'where', 'type', 'source',
  'exit', 'clear', 'printf', 'test', 'set', 'unset', 'alias', 'unalias', 'history',
  'sleep', 'env', 'printenv', 'pushd', 'popd', 'sh', 'bash', 'zsh', 'ksh', 'true',
  'false', 'read', 'wc', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk', 'diff', 'patch',
  'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'xargs', 'basename', 'dirname', 'time',
]);

/** First token of a command (the tool name), or undefined for shell noise /
 *  non-tool syntax. Strips a leading `./` or `C:\` path prefix so `./node`
 *  and `node` both yield "node". */
function commandTool(command: string): string | undefined {
  const first = command.trim().split(/\s+/)[0] ?? '';
  const tool = first.replace(/^[./\\]+/, '');
  if (!tool || TOOL_NOISE.has(tool)) return undefined;
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(tool)) return undefined;
  return tool;
}

/** Parse `[remember] …` markers the model appended to its final output. Each
 *  marker is one line: a tool name (→ tool_preference) or a concise "what
 *  worked and why" (→ successful_pattern). */
function parseRememberMarkers(text: string): string[] {
  const out: string[] = [];
  const re = /\[remember\]([^\[]+)/gi;
  let m: RegExpMatchArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = (m[1] ?? '').trim();
    if (value) out.push(value);
  }
  return out;
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
