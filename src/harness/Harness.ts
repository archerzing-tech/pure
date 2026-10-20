// src/harness/Harness.ts
// v0.5 — Harness with session persistence, context management, and stream integration.
// Fixes: ContextEngine used in run() too, StreamManager wired in, checkpoints saved at key transitions.

import { AgentLoopEngine } from '../engine/AgentLoopEngine';
import { StateManager } from './StateManager';
import { ContextEngine, type ContextCompactionResult } from './ContextEngine';
import { PromptAssembler, promptAssembler, resolvePromptBudget, estimatePromptTokens, estimateToolDefinitionTokens, type PromptBudgetConfig } from '../shared/PromptAssembler';
import { CharacterDriftGuard, type DriftReport } from '../character';
import { promptObservability, promptVersion, observeStrategy, type MemoryInjectionObservation, type PromptObservability } from '../shared/promptObservability';
import { AdaptiveControlPlane, adaptiveControlPlane, type AdaptiveStrategy } from '../shared/adaptiveControl';
import type {
  BudgetConfig,
  EngineContext,
  EngineEvent,
  EngineLlmPhase,
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
import {
  REFLECT_DEDUPE_PREFIX,
  REFLECTION_DEFAULTS,
  buildTurnEvidence,
  countReflectionsToday,
  lessonToMemoryAdds,
  reflectTurn,
  shouldReflect,
  type ReflectionConfig,
  type ReflectedLesson,
  type TurnEvidence,
} from './LessonReflector';
import { runUserHooksForEvent } from '../shared/userHookRunner';
import type { UserHookRunner } from '../shared/userHookRunner';
import { settleWithin, withTimeout } from '../shared/timing';
import type { UserHooksConfig } from '../shared/userHooks';
import type { SemanticRouteDecision } from '../coding-agent/types';

// Bounded wait for the memory retrieval that feeds the system prompt. The
// embedder's one-time load (WASM + ~80MB model) happens lazily inside the
// first search; capping it here keeps that cold load off the first token's
// critical path. A timeout degrades to the plain system prompt (memories are
// an enhancement, never a prerequisite).
const MEMORY_SEARCH_TIMEOUT_MS = 1500;
// withTimeout 本体已提为共享实现（src/shared/timing.ts）——本文件的这版是
// 审计批 3 认定的正确样板，七处漏清定时器的同型竞速全部收编到它上面。

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
  /** User hooks (hooks.json) run around tool calls and at turn completion.
   * CLI loads the global layer (~/.pure); hooks run only when a runner is
   * also wired (see userHookRunner.ts). */
  userHooks?: UserHooksConfig;
  userHookRunner?: UserHookRunner;
  /**
   * Failure recovery policy (retry → reflect → degrade → stop). When omitted
   * tool/verify failures fall back to the engine's default messaging.
   */
  failurePolicy?: FailurePolicy;
  /** Optional "is the task actually done?" guard consulted before TERMINATE
   * (see EngineContext.continueGuard). The GUI supplies a plan-state-aware
   * guard; omitted for CLI and subagents. */
  continueGuard?: EngineContext['continueGuard'];
  /** E0.3/E1.1 — per-phase adapter resolver (THINK / HANDOVER / REFLECT).
   * Threaded into the engine context (THINK/HANDOVER) and read by the lesson
   * reflector (REFLECT). A phase without a dedicated adapter — or an omitted
   * or throwing resolver — always falls back to llm: the single-model
   * contract from E0.3 holds no matter what. */
  llmFor?: (phase: EngineLlmPhase) => LLMAdapter | undefined;
  /** Mid-run steering queue (插话重构): drained by the engine at each THINK
   *  boundary so user messages typed mid-round steer the next round instead of
   *  restarting the turn. Omitted = no steering channel (CLI / subagents). */
  takeSteerMessages?: EngineContext['takeSteerMessages'];
  /** 代执行回合（2026-09-22 插话重设计）：宿主在 THINK 边界给出的本轮
   *  toolCalls，引擎跳过模型调用走原生 ACT 管线。Omitted = 无代执行。 */
  takeSyntheticToolCalls?: EngineContext['takeSyntheticToolCalls'];
  /** 委派起飞闸（2026-09-26 用户实测）：宿主在每批工具调用起飞前拦下被
   *  用户取消的委派。Omitted = 无闸（CLI / 子代理引擎照旧）。 */
  gateDelegations?: EngineContext['gateDelegations'];
  /** Live subagent activity feed (parallel multi-agent): the engine subscribes
   *  a reader per tool batch and re-emits the events as `SubagentActivity`.
   *  Omitted = silent tools (CLI / nested subagent runs), as before. */
  subagentEvents?: EngineContext['subagentEvents'];
  /** P3-3 — cap on concurrently in-flight reads per execution pool
   *  (default DEFAULT_MAX_READ_CONCURRENCY). Omitted = default. */
  maxReadConcurrency?: EngineContext['maxReadConcurrency'];
  /** E1.1 lesson reflector tuning; omitted = defaults (enabled, 20/day,
   * multi-step threshold 3 tool calls). */
  reflection?: ReflectionConfig;
  /** P0 棘轮 — 进化总开关（宿主从 config.skills.evolution / PURE_EVOLUTION_DISABLED
   *  解析后传入）。false 时 Harness 少记一笔归因（agent_run 不带 memoryInjection
   *  字段，与旧格式逐字节一致），并强制 E1.1 反思器关闭（P0-1：回合末零反思
   *  LLM 调用、落回模板 lesson）；记忆注入等现状行为一概不动。Omitted = on 的
   *  记账语义由字段缺席兜底（stash 不发生 ⇒ 记录无字段）。 */
  evolutionEnabled?: boolean;
  /** P0 棘轮 — 本次会话注入的技能名单（SKILL.md 侧，宿主装配系统提示时点
   *  名）。与记忆条目 id 一起进 memoryInjection 观测，供贡献切片聚合。
   *  Omitted = 无技能可记（CLI 装配点接线前的过渡形态）。 */
  injectedSkills?: string[];
  /**
   * 人格轨道 刀 5 — 长会话人格漂移探针（omitted = 关）。开启后，每个助手回合
   * 的收尾（与 E1.1 反思同一条 Completed 缝）会对**真实回答**跑三条红线断言
   * （零额外调用），并按间隔/命中用**本会话冻结的 system prompt** 单独问一条
   * 黄金探针（一次短调用，不进用户消息流、不入 transcript）。
   * 触发时机 / 判定口径 / 成本上界见 src/character/drift.ts 头注释。
   */
  characterDrift?: boolean;
  /** 漂移记账回调（宿主落事件账 / 遥测）。Omitted = 只往 stderr 打一行警告。 */
  onCharacterDrift?: (report: DriftReport) => void;
}

/**
 * v2.0（四问题②，2026-10-12）——工具失败教训的观察账本，run() 与
 * continueTurn() 共用同一套（此前两处手抄，已经养出 v0.11/v1.9.7 双份
 * 注释）。三个缺口三针：
 * 1. 落库时机——retry 路径的「勿重试」第二𐌥同样失败就即时落库（此前
 *    defer 到 Completed flush，会话半路崩掉教训全丢、只剩本会话模型看得见
 *    的 policy hint）；transient 成立时 removeById 撤回——「写了再删」与
 *    「不写」语义等价，但中断的窗口里教训已经活着。
 * 2. 豁免粒度——transient 豁免从 toolName 收窄到同一调用（args 相同）：
 *    此前同工具任意一次成功就洗掉全部失败教训，write_file 权限失败的
 *    「勿重试」被写别的文件的成功抵消；args 不可知时退回旧口径（保守，
 *    不漏真 transient）。
 * 3. 教训资格——探索性失败（文件不存在/无匹配/命令名猜错）不配单失败
 *    教训：一次 read 落空是正常试错，落「勿重试」只会吓唬下一会话；重复
 *    失败不受挡——同参硬试两次没改参数，对下一会话是真实信号。
 */
class FailureLedger {
  readonly retriedFailures: FailureRecord[] = [];
  private readonly argsByCallId = new Map<string, string>();
  private readonly argsByKey = new Map<string, string>();
  private readonly seenFailures = new Set<string>();
  private readonly pendingRepeats = new Map<string, FailureRecord>();
  private readonly pendingMemoryIds = new Map<string, string>();
  private readonly recoveredRepeats = new Set<string>();
  private readonly failedCalls = new Map<string, FailureRecord>();
  private readonly stopWrittenKeys = new Set<string>();

  constructor(private readonly write: {
    repeated(failure: FailureRecord, symptom?: string): Promise<string | undefined>;
    single(failure: FailureRecord, symptom?: string): Promise<void>;
    stopped(action: FailureAction, failure: FailureRecord, symptom?: string): Promise<void>;
    remove(id: string): Promise<boolean>;
  }) {}

  /** Consume one engine event. Only the immediate "勿重试" write inside a
   *  FailurePolicyDecision is async — every other branch returns inline. */
  async observe(event: EngineEvent, symptom: string): Promise<void> {
    if (event.type === 'ToolStarted') {
      // 同参豁免的原料：callId → args。args 缺席的调用不登记（豁免走旧口径）。
      if (event.payload.toolCallArgs !== undefined) {
        this.argsByCallId.set(event.payload.toolCallId, event.payload.toolCallArgs);
      }
      return;
    }
    if (event.type === 'ToolResult' && event.payload.result.success) {
      const okArgs = this.argsByCallId.get(event.payload.toolCallId);
      for (const [key, failure] of this.pendingRepeats) {
        if (this.isTransientRecovery(failure, event.payload.toolName, okArgs)) this.recoveredRepeats.add(key);
      }
      // v1.9.7 — the transient-fault exemption also covers single failures:
      // a tool that later succeeds was failing transiently, not a dead-end.
      for (const [key, failure] of this.failedCalls) {
        if (this.isTransientRecovery(failure, event.payload.toolName, okArgs)) this.recoveredRepeats.add(key);
      }
      // 即时落库的「勿重试」在 transient 成立时撤回：中断窗口里教训活着，
      // 恢复的证据一到就删——教训库不该只进不出。
      for (const key of this.recoveredRepeats) {
        const id = this.pendingMemoryIds.get(key);
        if (id !== undefined) {
          this.pendingMemoryIds.delete(key);
          void this.write.remove(id).catch(() => {});
        }
      }
      return;
    }
    if (event.type === 'ToolResult' && !event.payload.result.success) {
      const key = `${event.payload.toolName}::${event.payload.result.error ?? 'unknown'}`;
      if (!this.failedCalls.has(key)) {
        this.failedCalls.set(key, {
          type: 'tool_error',
          message: event.payload.result.error ?? 'unknown',
          turnNumber: 0,
          toolName: event.payload.toolName,
          callArgs: this.argsByCallId.get(event.payload.toolCallId),
        });
      }
      // FailurePolicyDecision 的 failure 由引擎构造（不带 args）——按同形
      // key 关联最近一次失败的 args（tool_error 的 message 就是 error 原文）。
      this.argsByKey.set(key, this.argsByCallId.get(event.payload.toolCallId) ?? '');
      return;
    }
    if (event.type === 'FailurePolicyDecision') {
      const failure = event.payload.failure;
      const repeatKey = `${failure.toolName ?? ''}::${failure.message}`;
      if (this.seenFailures.has(repeatKey)) {
        if (!this.pendingRepeats.has(repeatKey)) {
          failure.callArgs = this.argsByKey.get(repeatKey) || undefined;
          this.pendingRepeats.set(repeatKey, failure);
          // 针 1 — 第二𐌥同样失败立即落「勿重试」：教训在会话崩掉时也活着。
          const id = await this.write.repeated(failure, symptom).catch(() => undefined);
          if (id) this.pendingMemoryIds.set(repeatKey, id);
        }
      } else {
        this.seenFailures.add(repeatKey);
      }
      // A stop OR a degrade on repeated identical failures is a proven
      // dead-end worth persisting immediately — the degrade path keeps the
      // turn alive (skip + continue), but the "don't repeat this call"
      // lesson must survive even a successful session. Written once per
      // failure key.
      if (event.payload.action.kind === 'stop' || event.payload.action.kind === 'degrade') {
        if (!this.stopWrittenKeys.has(repeatKey)) {
          this.stopWrittenKeys.add(repeatKey);
          await this.write.stopped(event.payload.action, failure, symptom).catch(() => {});
        }
      }
      if (event.payload.action.kind === 'retry') {
        this.retriedFailures.push(failure);
      }
    }
  }

  /** 「Recovered after retry」的资格（四问题② 针3 的另一半）：真 overcome
   *  ——该失败后来同参成功过（recoveredRepeats 是同一把尺子），且非探索性
   *  （read 落空后换路径成功不值得记）。v2.0 前 Harness 对「policy 说
   *  retry」的失败一律写「Recovered」——没 overcome 也写，假教训与黑名单
   *  架空同源，一并收紧。 */
  overcameFailures(): FailureRecord[] {
    return this.retriedFailures.filter(f => {
      if (isExploratoryFailure(f.message)) return false;
      // 工具失败：同参成功才算真 overcome（与豁免同一把尺子）；llm_error
      // 没有调用可比——其后流能跑完本身就是恢复证据，保持旧口径。
      if (!f.toolName) return true;
      return this.recoveredRepeats.has(`${f.toolName}::${f.message}`);
    });
  }

  /** Completed 与不可恢 Error 出口共用的死路教训 flush。返回全部单失败
   *  记录（含被豁免/黑名单跳过的——那是反射器的证据材料，不是教训本身）。 */
  async flushDeadEnds(symptom: string): Promise<FailureRecord[]> {
    // v0.12 — skip repeat keys whose tool later succeeded (transient fault)
    // and keys already written immediately (stop/degrade, 针 1 的即时落库)。
    const writtenRepeatKeys = new Set<string>();
    for (const [key, failure] of this.pendingRepeats) {
      if (this.recoveredRepeats.has(key)) continue;
      if (this.stopWrittenKeys.has(key)) continue;
      if (this.pendingMemoryIds.has(key)) continue; // 即时已写（或已撤回），不重写不复活
      writtenRepeatKeys.add(key);
      await this.write.repeated(failure, symptom).then(() => undefined).catch(() => {});
    }
    this.pendingRepeats.clear();
    this.pendingMemoryIds.clear();
    // v1.9.7 — single (non-repeated) failed calls persist as error_pattern
    // too; transient faults are exempt, and 针 3 挡掉探索性失败。retried 过的
    // key 只有真 overcome（写了「Recovered after retry」）才让位——v2.0 前
    // 「policy 说 retry」一律让位，配合 Recovered 的假写正好两头都吞掉
    // retried-but-never-overcame 的失败（一条假教训 + 一条丢失的真痕迹）。
    const overcameKeys = new Set(this.overcameFailures().map(f => `${f.toolName ?? ''}::${f.message}`));
    for (const [key, failure] of this.failedCalls) {
      if (this.recoveredRepeats.has(key)) continue;
      if (writtenRepeatKeys.has(key)) continue;
      if (this.pendingMemoryIds.has(key)) continue; // 重复教训已即时写，一条死路一条教训
      if (overcameKeys.has(key)) continue;
      if (this.stopWrittenKeys.has(key)) continue;
      if (isExploratoryFailure(failure.message)) continue;
      await this.write.single(failure, symptom).catch(() => {});
    }
    const drained = [...this.failedCalls.values()];
    this.failedCalls.clear();
    return drained;
  }

  /** 针 2 — transient 豁免=同一调用：工具相同且 args 相同才算。args 不可知
   *  （ToolStarted 没带、或失败根本不来自工具调用）时退回旧口径——保守侧，
   *  宁可多豁免也不把真 transient 写成勿重试。 */
  private isTransientRecovery(failure: FailureRecord, succeededTool: string, succeededArgs: string | undefined): boolean {
    if (failure.toolName !== succeededTool) return false;
    if (!failure.callArgs || succeededArgs === undefined) return true;
    return failure.callArgs === succeededArgs;
  }
}

/** 针 3 — 探索性失败的教训资格黑名单：这些错误是正常试错的一部分（读一个
 *  可能不存在的文件、grep 一个没命中的 pattern、猜一个命令名），单次发生
 *  落「勿重试」只会拿噪声淹没教训库、吓唬下一会话。只挡单失败教训；重复
 *  失败（同参硬试两次没改参数）仍留教训。 */
const LESSON_NOISE: RegExp[] = [
  /file (or directory )?not found/i,
  /no such file/i,
  /does not exist/i,
  /\bENOENT\b/,
  /no matches?/i,
  /command not found/i,
  /is not recognized/i,
];

function isExploratoryFailure(message: string): boolean {
  return LESSON_NOISE.some(re => re.test(message));
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
  // P0 棘轮 — composeMemoryPrompt 选定的记忆条目/技能（ids only）。与
  // currentAdaptiveStrategy 同一冻结语义：run() 组装会话系统提示时落值，
  // 后续 continueTurn 复用冻结提示，归因到同一批条目是忠实的（模型看到的
  // 就是它们）。总开关关掉时保持 undefined —— startRun 因此不写字段。
  private currentMemoryInjection?: MemoryInjectionObservation;
  // E0.2 §2.1 — system prompt frozen for the whole session: composed once at
  // run() (or first continueTurn on a restored session), reused verbatim by
  // every later continueTurn so provider-side prompt-cache breakpoints on the
  // system prefix are never invalidated by a re-searched <session_memory>
  // block or a shifted adaptive directive. Mid-session lessons still reach
  // the model through the failure-policy hint channel (engine user messages).
  private sessionSystemPrompt?: string;
  // E1.1 — lesson reflections launched at turn end. Fire-and-forget on the
  // turn's critical path, but tracked so entrypoints that exit right after a
  // one-shot turn can drain them (settleReflections) instead of killing the
  // reflection call mid-flight.
  private readonly inFlightReflections = new Set<Promise<void>>();
  // 人格轨道 刀 5 — 漂移探针（config.characterDrift 开启时才建）。与反思同一
  // 语义：回合收尾 fire-and-forget，但被追踪，退出前由 settleReflections 一并排空。
  private readonly driftGuard?: CharacterDriftGuard;
  private readonly inFlightDrift = new Set<Promise<unknown>>();
  private characterDriftTurn = 0;
  private readonly reflection: Required<ReflectionConfig>;

  constructor(config: HarnessConfig) {
    this.engine = new AgentLoopEngine();
    this.config = config;
    // P0-1（2026-09-30）— 进化总开关压过 reflection 自身的 enabled：false 时
    // 无论宿主怎么调 reflection 配置，回合末都零反思 LLM 调用、零结构化 lesson，
    // 落回同步模板写入（= E1.1 诞生前的行为）。收口在构造点而不是两个宿主装配
    // 点，是让「开关关 = 进化层不存在」这同一个语义对所有传 evolutionEnabled
    // 的调用方（GUI / CLI / 通道）零漂移地成立——此前反思器是这个语义唯一的
    // 漏网面：开关关了，回合末的反思调用照发。undefined 时不改调用方的
    // reflection 调优（测试与未接开关的直接构造保持原行为）。
    this.reflection = {
      ...REFLECTION_DEFAULTS,
      ...config.reflection,
      ...(config.evolutionEnabled === false ? { enabled: false } : {}),
    };
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
    if (config.characterDrift) {
      // 贵层用宿主自己的 llm：探针与主线走同一家provider、同一份模型预算，
      // 不另开渠道。omit onDrift 时只打一行警告（开发者能看到，UI 不被打扰）——
      // 人格漂移是「这次变更让人格在某场景漂了」的线索，不是用户要处理的错误。
      this.driftGuard = new CharacterDriftGuard({
        probe: (systemPrompt, userText) => config.llm
          .complete([{ role: 'system', content: systemPrompt }, { role: 'user', content: userText }], [])
          .then((response) => response.content),
        onDrift: config.onCharacterDrift ?? ((report) => {
          const failures = [
            ...report.turnGrade.failures,
            ...(report.probeGrade?.failures ?? []),
          ].join('; ');
          console.warn(`[pure] character drift (${report.characterProfileId}, turn ${report.turnIndex}): ${failures}`);
        }),
      });
    }
  }

  private currentToolsDefs(): ToolDefinition[] {
    return this.config.toolsDefsProvider ? this.config.toolsDefsProvider() : this.config.toolsDefs;
  }

  private buildContext(signal?: AbortSignal, hardStopSignal?: AbortSignal): EngineContext {
    return {
      llm: this.config.llm,
      // E0.3 — per-phase adapter selection (THINK/HANDOVER); the engine reads
      // it through llmForPhase and falls back to llm per phase.
      llmFor: this.config.llmFor,
      // Mid-run steering: the engine drains this at each THINK boundary.
      takeSteerMessages: this.config.takeSteerMessages,
      // 代执行回合：宿主给出的本轮 toolCalls，非空则本轮跳过模型调用。
      takeSyntheticToolCalls: this.config.takeSyntheticToolCalls,
      // 委派起飞闸：宿主在批次起飞前拦下被用户取消的委派。
      gateDelegations: this.config.gateDelegations,
      // Live subagent interior events, re-emitted during tool batches.
      subagentEvents: this.config.subagentEvents,
      // P3-3 — 同一执行池内在飞读调用上限（缺省走协调器默认值）。
      maxReadConcurrency: this.config.maxReadConcurrency,
      tools: this.config.tools,
      toolsDefs: this.currentToolsDefs(),
      toolsDefsProvider: this.config.toolsDefsProvider,
      budget: this.config.budget,
      verifier: this.config.verifier,
      hooks: this.config.hooks,
      userHooks: this.config.userHooks,
      userHookRunner: this.config.userHookRunner,
      failurePolicy: this.config.failurePolicy,
      continueGuard: this.config.continueGuard,
      // 9.1 — the engine compacts reactively when a provider rejects the
      // request as over its context window (see AgentLoopEngine's THINK
      // catch). Sharing the SAME engine instance as the pre-flight trim keeps
      // its budget/tools view and lastCompactionResult in one place.
      contextEngine: this.config.contextEngine,
      signal,
      // 1c 升级硬停第二通道：暂停宽限期内宿主再叫停时立即掐掉在飞工具。
      hardStopSignal,
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
    hardStopSignal?: AbortSignal,
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
    // §2.1 cache freeze: this composed prompt is the session's system prompt
    // from now on — continueTurn reuses it instead of recomposing.
    this.sessionSystemPrompt = effectiveSystemPrompt;

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
          this.buildContext(signal, hardStopSignal),
        )
      : this.engine.run(
          {
            sessionId: this.config.sessionId,
            systemPrompt: effectiveSystemPrompt,
            userPrompt,
            images,
            budget: this.config.budget,
          },
          this.buildContext(signal, hardStopSignal),
        );

    const traceId = this.observability.startRun({
      traceId: this.recordRuntimeAssembly(effectiveSystemPrompt, userPrompt, systemPrompt),
      sessionId: this.config.sessionId,
      provider: this.config.promptBudget?.provider,
      model: this.config.promptBudget?.model,
      // E4.1 — the strategy selected in composeMemoryPrompt governs THIS run's
      // prompt; recording it on the run record makes strategy → outcome a
      // zero-join slice (same record holds toolCalls/verification/outcome).
      strategy: observeStrategy(this.currentAdaptiveStrategy),
      // P0 棘轮 — same zero-join logic for the frozen memory/skill injection:
      // the run record carries which entries the model actually saw.
      memoryInjection: this.currentMemoryInjection,
    });
    let traceFinished = false;
    const finishTrace = () => {
      if (traceFinished) return;
      traceFinished = true;
      this.observability.finishRun(traceId);
    };

    // §12.3 error_pattern learning (四问题② v2.0 起由 FailureLedger 承担):
    // retry-lesson timing, transient-fault exemption, lesson eligibility —
    // one ledger per run() invocation, shared with continueTurn().
    const ledger = this.newFailureLedger();

    try {
      for await (const event of stream) {
      this.observability.recordEvent(traceId, event);
      if (event.type === 'Completed') {
        finishTrace();
      } else if (event.type === 'Error' && !event.payload.recoverable) {
        finishTrace();
        // 会话死也要把死路教训带走（四问题②）：此前死路 flush 只挂在
        // Completed 分支，policy 之外的引擎死亡出口把 failedCalls 全丢。
        await ledger.flushDeadEnds(userPrompt);
      }

      // §12.3 — failure lessons (v0.12/v1.9.7/四问题② v2.0): one ledger call
      // replaces the hand-copied observation blocks. Immediate "勿重试" write
      // on the second identical failure, transient recovery scoped to the
      // SAME call, exploratory failures kept out of single-failure lessons.
      await ledger.observe(event, userPrompt);

      // Track messages for checkpoint saving
      if (event.type === 'Completed' && event.payload.messages) {
        // The engine ALWAYS emits a final Completed — including right after an
        // Interrupted (interrupted=true). Persisting those messages raw would
        // let the untrimmed 'turn_completed' checkpoint shadow the trimmed
        // 'interrupted' one (resume reads the LATEST checkpoint), re-arming the
        // unpaired tool_use the trim exists to prevent — so interrupted rounds
        // get the same trim here, for both the checkpoint and the next turn's
        // seed.
        const nextMessages = event.payload.interrupted
          ? trimUnresolvedToolCalls(event.payload.messages)
          : event.payload.messages;
        runningMessages = nextMessages;
        this.updateVerificationSummary(event.payload.messages, event.payload.verification);
        if (this.stateMgr) {
          await this.stateMgr.saveCheckpoint('turn_completed', nextMessages, event.payload.turnCount);
        }
        // Memory write at session end (Adapter Layer 设计文档 §12.3): a
        // successful completion becomes a successful_pattern memory; failures
        // the policy retried and that eventually succeeded become error_pattern
        // memories. Failures never block the session.
        if (this.config.memory) {
          const drainedFailures = await ledger.flushDeadEnds(userPrompt);
          if (event.payload.isComplete) {
            // E1.1 — reflection-triggered turns write their lesson through the
            // reflector (fire-and-forget); everything else keeps the template.
            await this.writeSessionLesson(
              userPrompt,
              event.payload.finalOutput,
              event.payload.messages,
              ledger.retriedFailures,
              drainedFailures,
            );
            // 刀 5 — 漂移探针与反思同一条缝（fire-and-forget，退出前排空）。
            this.observeCharacterDrift(event.payload.finalOutput);
          }
          if (event.payload.isComplete) {
            const overcame = ledger.overcameFailures();
            if (overcame.length > 0) {
              await this.writeRetriedErrorPatterns(overcame, userPrompt).catch(() => {});
            }
          }
        }
      }
      // User on_turn_complete hooks (hooks.json) fire after the run settles,
      // awaited so a notify-style hook finishes before the CLI exits. v1: the
      // hook's real-world side effect is the value; output is not fed back
      // into context. Gated on Completed: without the check every streamed
      // TokenDelta would spawn the hook processes once per delta.
      if (
        event.type === 'Completed' &&
        this.config.userHooks?.on_turn_complete?.length && this.config.userHookRunner
      ) {
        await runUserHooksForEvent(this.config.userHooks, 'on_turn_complete', { event: 'on_turn_complete' }, this.config.userHookRunner);
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
    hardStopSignal?: AbortSignal,
    userInternal?: boolean,
  ): AsyncGenerator<EngineEvent, void, void> {
    this.verificationSummary = 'No project-level verification evidence was recorded.';
    this.verificationPassed = false;
    this.scheduleMemoryDecay();
    // §2.1 cache freeze — do NOT recompose here. Re-searching memory against
    // the follow-up prompt (and re-running the adaptive strategy) rewrites the
    // system prompt between turns, which invalidates provider-side cache
    // breakpoints that assume an identical system prefix. Reuse the prompt
    // frozen at run(); compose only when this Harness never ran in this
    // process (session restored from a checkpoint) and freeze that instead.
    if (this.sessionSystemPrompt === undefined) {
      this.sessionSystemPrompt = await this.composeMemoryPrompt(systemPrompt, newUserPrompt, semantic);
    }
    const effectiveSystemPrompt = this.sessionSystemPrompt;

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
        userInternal,
      },
      this.buildContext(signal, hardStopSignal),
    );

    const traceId = this.observability.startRun({
      traceId: this.recordRuntimeAssembly(effectiveSystemPrompt, newUserPrompt, systemPrompt),
      sessionId: this.config.sessionId,
      provider: this.config.promptBudget?.provider,
      model: this.config.promptBudget?.model,
      // E4.1 — continueTurn reuses the strategy frozen with the session prompt
      // (§2.1 cache freeze); attributing later turns to it is faithful, since
      // that directive is literally what the model saw.
      strategy: observeStrategy(this.currentAdaptiveStrategy),
      // P0 棘轮 — same freeze semantics: later turns attribute to the entries
      // frozen at session start (undefined when the evolution switch is off).
      memoryInjection: this.currentMemoryInjection,
    });
    let traceFinished = false;
    const finishTrace = () => {
      if (traceFinished) return;
      traceFinished = true;
      this.observability.finishRun(traceId);
    };

    // Same §12.3 error_pattern handling as run(): a stop in a continuation
    // turn is a real failure worth remembering too. (v2.0 — the shared
    // FailureLedger, one per turn.)
    const ledger = this.newFailureLedger();

    try {
      for await (const event of stream) {
      this.observability.recordEvent(traceId, event);
      if (event.type === 'Completed') {
        finishTrace();
      } else if (event.type === 'Error' && !event.payload.recoverable) {
        finishTrace();
        // Same dead-end flush on the error exit as run()（四问题②）。
        await ledger.flushDeadEnds(newUserPrompt);
      }

      // §12.3 — failure lessons via the shared FailureLedger (same contract
      // as run(), including the degrade branch continueTurn used to miss).
      await ledger.observe(event, newUserPrompt);

      if (event.type === 'Completed' && event.payload.messages) {
        this.updateVerificationSummary(event.payload.messages, event.payload.verification);
        if (this.stateMgr) {
          await this.stateMgr.saveCheckpoint('turn_completed', event.payload.messages, event.payload.turnCount);
        }
      }
      // §12.3 retried-error write — NOT gated on stateMgr: the GUI runs
      // continuation turns without a state store but with memory.
      if (event.type === 'Completed' && this.config.memory) {
        const drainedFailures = await ledger.flushDeadEnds(newUserPrompt);
        if (event.payload.isComplete) {
          // E1.1 — same Completed seam as run(): reflector for triggered
          // turns (fire-and-forget), template write for the rest.
          await this.writeSessionLesson(
            newUserPrompt,
            event.payload.finalOutput,
            event.payload.messages,
            ledger.retriedFailures,
            drainedFailures,
          );
          // 刀 5 — 与 run() 同一条缝：真实回答的免层抽查 + 按间隔的黄金探针。
          this.observeCharacterDrift(event.payload.finalOutput);
          const overcame = ledger.overcameFailures();
          if (overcame.length > 0) {
            await this.writeRetriedErrorPatterns(overcame, newUserPrompt).catch(() => {});
          }
        }
      }
      // User on_turn_complete hooks — same contract as run(): Completed only,
      // never per streamed delta.
      if (
        event.type === 'Completed' &&
        this.config.userHooks?.on_turn_complete?.length && this.config.userHookRunner
      ) {
        await runUserHooksForEvent(this.config.userHooks, 'on_turn_complete', { event: 'on_turn_complete' }, this.config.userHookRunner);
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
    // E1.1 防幻觉纪律：反思器拿不出本轮证据的 lesson 打 confidence:'low'，
    // 默认不注入（条目仍在库里，供设置页/仪表盘查看）。模板 lesson 不带
    // confidence 字段，照旧注入。
    memories = memories.filter(m => m.confidence !== 'low');

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
    // E1 落地（2026-10-13）——机器级教训的无条件注入通道（与上面的
    // tool_preference 同构）：反思器判 scope:'machine' 的条目落全局库，这里
    // 常驻注入。环境/网络/平台类事实与工具偏好一样够不着关键词检索（教训
    // 文本与新 prompt 几乎不共享 token），只能常驻；cap 5 + activeOnly 控制
    // 注入面，decay/棘轮负责淘汰。correction 类草稿与 tool_preference 在
    // 此滤除——前者是项目域、后者有自己的通道。
    let globalLessons: Awaited<ReturnType<IMemoryStore['list']>> = [];
    try {
      if (this.config.memory) {
        globalLessons = this.config.memory
          .list({ projectPath: GLOBAL_MEMORY_SCOPE, activeOnly: true })
          .filter(m => m.type === 'successful_pattern' || m.type === 'error_pattern' || m.type === 'procedure')
          // E1.1 同一道防幻觉闸门（审计批 5④）：反思器拿不出证据的 lesson
          // 打 confidence:'low'，机器通道此前只按 type 过滤、漏了这一刀，
          // 低置信条目借常驻通道绕过闸门直接进每个会话的 system prompt。
          // 模板条目不带 confidence 字段，照旧注入（与项目通道同口径）。
          .filter(m => m.confidence !== 'low')
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 5);
      }
    } catch {
      globalLessons = [];
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
    // 刀 3 漏斗先同症状去重再过 8000 字符帽：垃圾/重复 lesson 不再挤占注入面，
    // 相关性序保头去尾。
    const successes = capMemoryChars(dedupeBySymptom(memories
      .filter(m => m.type === 'successful_pattern'))
      .map(m => m.content));
    const errorPatterns = capMemoryChars(dedupeBySymptom(memories
      .filter(m => m.type === 'error_pattern'))
      .map(m => m.content));
    const procedures = capMemoryChars(dedupeBySymptom(memories
      .filter(m => m.type === 'procedure'))
      .map(m => m.content));
    // E3.1 — confirmed project conventions ride the same confidence filter as
    // everything else: drafts stay out (low), user-confirmed ones inject.
    const projectConventions = memories
      .filter(m => m.type === 'project_convention')
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
    const composed = this.promptAssembler.composeMemoryPrompt({
      template: systemPrompt,
      memory: {
        preferences,
        successes,
        errorPatterns,
        procedures,
        projectConventions,
        toolPreferences,
        machineLessons: globalLessons.map(m => m.content),
        project: this.config.memory ? this.projectPath() : undefined,
        adaptiveStrategy: strategy.directive,
      },
      budget: this.config.promptBudget,
      toolDefinitions: this.currentToolsDefs(),
    });
    // P0 棘轮归因 — 记下这批进过候选池的条目（ids only，E0.1 纪律不破）。
    // memories 已在上方滤掉 confidence:'low'，globalToolPrefs 本就 activeOnly；
    // 个别条目可能被 toolPreference 去重或 fragment 预算挤掉——前者罕见、后者
    // 由 injected 布尔兜底（聚合器跳过 false 的 run）。总开关关掉时整个 stash
    // 不发生，currentMemoryInjection 维持 undefined。
    if (this.config.evolutionEnabled) {
      const entryIds: string[] = [];
      const entryTypes: Record<string, number> = {};
      const seen = new Set<string>();
      for (const m of [...globalToolPrefs, ...globalLessons, ...memories]) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        entryIds.push(m.id);
        entryTypes[m.type] = (entryTypes[m.type] ?? 0) + 1;
      }
      this.currentMemoryInjection = {
        entryIds,
        entryTypes,
        skills: this.config.injectedSkills?.length ? [...this.config.injectedSkills] : undefined,
        injected: composed.includes('<session_memory>'),
      };
    }
    return composed;
  }

  /** The shared failure-lesson ledger (四问题② v2.0): writing stays in the
   *  Harness's private methods (same memory/session plumbing as before); the
   *  ledger owns the observation state and the three-policy semantics. */
  private newFailureLedger(): FailureLedger {
    return new FailureLedger({
      repeated: (failure, symptom) => this.writeRepeatedFailureMemory(failure, symptom),
      single: (failure, symptom) => this.writeSingleFailureMemory(failure, symptom),
      stopped: (action, failure, symptom) => this.writeErrorPattern(action, failure, symptom),
      remove: (id) => (this.config.memory ? this.config.memory.removeById(id) : Promise.resolve(false)),
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
  private async writeRepeatedFailureMemory(failure: FailureRecord, symptom?: string): Promise<string | undefined> {
    if (!this.config.memory) return undefined;
    const tool = failure.toolName ? ` (tool: ${failure.toolName})` : '';
    const content = this.withSymptom(symptom, `Repeated failure: ${failure.message}${tool}. Do not make this exact call again — switch to a different approach.`).slice(0, 300);
    // 返回 id（四问题②）：教训改为第二𐌥失败即时落库，transient 成立时
    // 按 id 撤回——没有 id 就撤不了。
    return await this.config.memory.add({
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
  /**
   * E1.1 — the Completed seam for session lessons. Triggered turns (failures,
   * or a genuinely multi-step process) spend ONE reflection call on the cheap
   * REFLECT adapter and persist its structured lesson fire-and-forget — the
   * turn ends while it runs and settleReflections() drains it before process
   * exit. Everything else keeps the synchronous template write, unchanged.
   * The template version is also the reflector's designed fallback: a
   * reflection that throws, times out, or returns garbage degrades to it.
   * Turns with zero evidence (no failures, no tool activity) write nothing —
   * their template lesson is boilerplate noise, not knowledge.
   */
  private async writeSessionLesson(
    userPrompt: string,
    finalOutput: string | undefined,
    messages: Message[] | undefined,
    retriedFailures: FailureRecord[],
    failedCalls: FailureRecord[],
  ): Promise<void> {
    if (!this.config.memory) return;
    const evidence = buildTurnEvidence(messages ?? []);
    const failureCount = retriedFailures.length + failedCalls.length;
    if (!shouldReflect(evidence.length, failureCount, this.reflection)) {
      await this.writeSessionMemory(userPrompt, finalOutput, messages, retriedFailures).catch(() => {});
      return;
    }
    // Daily cap counts today's already-written reflections straight from the
    // store (the reflect: dedupe prefix marks them) — no second state file.
    if (countReflectionsToday(this.config.memory, this.projectPath()) >= this.reflection.dailyCap) {
      await this.writeSessionMemory(userPrompt, finalOutput, messages, retriedFailures).catch(() => {});
      return;
    }
    const task = this.reflectLesson({ userPrompt, finalOutput, messages, retriedFailures, failedCalls, evidence });
    this.inFlightReflections.add(task);
    void task.finally(() => { this.inFlightReflections.delete(task); });
  }

  /**
   * Run the reflection and persist the result. NEVER rejects: every failure
   * mode (resolver, transport, timeout, unusable reply) falls back to the
   * template write. A grounded lesson lands as a successful_pattern entry
   * carrying the structured lesson + evidence hashes + confidence, and — on a
   * verified multi-step success — an extra procedure entry (E2.1 piggyback).
   */
  private async reflectLesson(input: {
    userPrompt: string;
    finalOutput: string | undefined;
    messages: Message[] | undefined;
    retriedFailures: FailureRecord[];
    failedCalls: FailureRecord[];
    evidence: TurnEvidence[];
  }): Promise<void> {
    const memory = this.config.memory;
    if (!memory) return;
    let lesson: ReflectedLesson | undefined;
    try {
      // E0.3 single-model contract: a missing or throwing REFLECT resolver
      // falls back to the main adapter, same as the engine phases do.
      let llm: LLMAdapter;
      try {
        llm = this.config.llmFor?.('REFLECT') ?? this.config.llm;
      } catch {
        llm = this.config.llm;
      }
      lesson = await reflectTurn(llm, {
        userPrompt: input.userPrompt,
        finalOutput: input.finalOutput,
        evidence: input.evidence,
        failures: [...input.retriedFailures, ...input.failedCalls].map((f) => ({
          toolName: f.toolName,
          message: f.message,
        })),
        verificationSummary: this.verificationSummary,
        verificationPassed: this.verificationPassed,
      });
    } catch {
      lesson = undefined;
    }
    if (!lesson) {
      await this.writeSessionMemory(input.userPrompt, input.finalOutput, input.messages, input.retriedFailures).catch(() => {});
      return;
    }
    const dedupeKey = `${REFLECT_DEDUPE_PREFIX}${this.config.sessionId}:${input.userPrompt.trim().toLowerCase()}`;
    if (this.writtenLessonKeys.has(dedupeKey)) return;
    this.writtenLessonKeys.add(dedupeKey);
    const adds = lessonToMemoryAdds(lesson, {
      sessionId: this.config.sessionId,
      projectPath: this.projectPath(),
      dedupeKey,
      verificationSummary: this.verificationSummary,
      verificationPassed: this.verificationPassed,
    });
    // 主条目失败照旧上抛（fire-and-forget task 的兜底纪律不变），便车失败只
    // 降级 —— 与抽取前逐字节同语义；条目构造在 LessonReflector.lessonToMemoryAdds。
    const [main, ...piggybacks] = adds;
    if (main) await memory.add(main);
    for (const add of piggybacks) await memory.add(add).catch(() => {});
  }

  /**
   * E1.1 — resolve every in-flight lesson reflection. Entrypoints that exit
   * right after a one-shot turn (CLI runOneShot) await this so the
   * fire-and-forget reflection still lands instead of dying with the process;
   * the timeout bounds the wait when the reflect LLM is slow or dead. No-op
   * when nothing is in flight.
   */
  async settleReflections(timeoutMs = 30_000): Promise<void> {
    // 漂移探针也算在飞（刀 5）：它同样是回合末的后台调用，退出前该排空——否则
    // 一条-shot 场景下探针永远报不出来。
    const inFlight = [...this.inFlightReflections, ...this.inFlightDrift];
    if (inFlight.length === 0) return;
    // 输掉竞速的定时器必须被清掉：runOneShot await 完这里的返回就该退进程，
    // 挂着 30s 孤儿 timer 会让每次 CLI 单发都白停满额（审计实测复现）。
    await settleWithin(Promise.allSettled(inFlight), timeoutMs);
  }

  /**
   * 人格轨道 刀 5 — 观测一个已完成回合并记账。fire-and-forget：探针的那一次
   * 短调用不该拖慢也没必要拖慢用户这一轮（observeTurn 自身永不抛）。
   * 用**冻结的会话提示**（sessionSystemPrompt）而不是当前重算的提示：探针要探的
   * 是「模型这几轮实际看到的那份人设还在不在」，不是「如果现在重新装配会怎样」。
   */
  private observeCharacterDrift(finalOutput: string | undefined): void {
    if (!this.driftGuard) return;
    this.characterDriftTurn += 1;
    const task = this.driftGuard.observeTurn({
      turnIndex: this.characterDriftTurn,
      output: finalOutput ?? '',
      systemPrompt: this.sessionSystemPrompt ?? '',
    });
    this.inFlightDrift.add(task);
    void task.finally(() => { this.inFlightDrift.delete(task); });
  }

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
    // 零证据闸门：无失败、无工具活动的回合（纯问候/闲聊）写出的模板 lesson
    // 全是固定样板串，只会污染注入面（实测 hello 垃圾曾占 system prompt 9%）。
    // 与 shouldReflect 的 evidence=0 判据天然对齐：有失败仍写（恢复路径有价值），
    // 有工具活动仍写（工作集/过程层有价值）。[remember] 标记是显式持久化信号，
    // 不受闸门影响，照常落盘。
    if (retriedFailures.length > 0 || tools.length > 0) {
      await this.writeTemplateLesson(userPrompt, finalOutput, retriedFailures, tools);
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
  }

  /**
   * The synchronous template lesson + procedure write (the noise-prone pair the
   * zero-evidence gate conditionalizes). dedupeKey drops the sessionId so
   * FSMemoryStore's per-project dedupe collapses the same prompt across
   * sessions; the reflect:/procedure: channels keep their own prefixes.
   */
  private async writeTemplateLesson(
    userPrompt: string,
    finalOutput: string | undefined,
    retriedFailures: FailureRecord[],
    tools: string[],
  ): Promise<void> {
    const memory = this.config.memory;
    if (!memory) return;
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
    // 跨会话去重：FSMemoryStore.add 按同项目 dedupeKey 去重，键里去掉
    // sessionId 后同一 prompt 全项目只留一条模板 lesson（reflect:/procedure:
    // 前缀通道不受影响）。
    const dedupeKey = `lesson:${userPrompt.trim().toLowerCase()}`;
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
    await memory.add({
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
      await memory.add({
        type: 'procedure',
        content: procedure.slice(0, 600),
        timestamp: Date.now(),
        sessionId: this.config.sessionId,
        projectPath: this.projectPath(),
        dedupeKey: `procedure:${dedupeKey}`,
      });
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

/** 注入侧漏斗（刀 3）——同症状去重。模板 lesson 的 content 以 `Symptom: `
 *  开头，同一 prompt 跨回合/跨会话重复时检索会捞回多条同义条目；以症状前缀
 *  （≤120 字符）为键，同键只留 timestamp 最新的一条。非该格式的条目原样
 *  透传；存活者保持输入序（即检索相关性序）。 */
export function dedupeBySymptom<T extends { content: string; timestamp: number }>(entries: T[]): T[] {
  const PREFIX = 'Symptom: ';
  const newestByKey = new Map<string, T>();
  for (const e of entries) {
    if (!e.content.startsWith(PREFIX)) continue;
    const key = e.content.slice(PREFIX.length, PREFIX.length + 120);
    const prev = newestByKey.get(key);
    if (!prev || e.timestamp >= prev.timestamp) newestByKey.set(key, e);
  }
  if (newestByKey.size === 0) return entries;
  const kept = new Set(newestByKey.values());
  return entries.filter(e => !e.content.startsWith(PREFIX) || kept.has(e));
}

/** 注入侧漏斗（刀 3）——字符预算帽。successes/errorPatterns/procedures 三张
 *  清单合计注入 <session_memory>，垃圾 lesson 堆积时曾把注入面顶到 3k tokens。
 *  以 8000 字符封顶：检索相关性序保头去尾，第一行永远保留（防御性下限）。 */
export function capMemoryChars(lines: string[], maxChars = 8000): string[] {
  const kept: string[] = [];
  let total = 0;
  for (const line of lines) {
    if (kept.length > 0 && total + line.length > maxChars) break;
    kept.push(line);
    total += line.length;
  }
  return kept;
}

/**
 * Remove trailing assistant messages whose toolCalls never received tool
 * results (e.g. an after_think hook abort). Persisting them would leave an
 * unpaired tool_use in the checkpoint, which LLM APIs reject on resume.
 * Exported for the subagent orchestrator's checkpoint persistence, which must
 * uphold the same resume-safety contract.
 */
export function trimUnresolvedToolCalls(messages: Message[]): Message[] {
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
