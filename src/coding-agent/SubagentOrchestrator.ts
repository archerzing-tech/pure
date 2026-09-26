// src/coding-agent/SubagentOrchestrator.ts
// v0.1 — Subagent orchestrator implementing ToolAdapter.
// When the parent LLM calls a subagent tool, the orchestrator spawns a new
// AgentLoopEngine instance, runs it to completion, and returns the result.

import { AgentLoopEngine } from '../engine/AgentLoopEngine';
import { parseToolArguments } from '../shared/parseRepair';
import { BRANCH_ABORT_REASON, isBranchAbort, isPauseAbort, PAUSE_ABORT_REASON } from '../shared/pauseSignal';
import { BranchLifecycle, type BranchState } from './branchLifecycle';
import type {
  BudgetConfig,
  EngineContext,
  FailurePolicy,
  IStateStore,
  LLMAdapter,
  Message,
  ToolAdapter,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../shared/types';
import { DefaultFailurePolicy } from '../engine/FailurePolicy';
import type { TokenUsage } from '../shared/types';
import { withRelaySchema } from '../engine/relayPipeline';
import { trimUnresolvedToolCalls } from '../harness/Harness';
import { applyPersonaOverlay } from '../harness/personaOverlays';
import { THIRD_PARTY_SCOPE_NOTE_EN, THIRD_PARTY_SCOPE_NOTE_ZH } from '../shared/thirdPartyScope';
import type { SubagentDefinition, SubagentResult } from './types';
import { Tags } from './ToolRegistry';
import { createDefaultVerifier, type Verifier } from './Verifier';

/** Terminal outcome of a subagent, used by the UI to color the badge and by
 * the orchestrator to distinguish a timeout/cancel from an ordinary failure.
 * 'paused' (阶段 12): the user paused the run — the checkpoint was saved and a
 * re-delegation of the SAME subtask resumes from it instead of starting over. */
export type SubagentStatus = 'running' | 'done' | 'failed' | 'timed_out' | 'cancelled' | 'paused';

/** Shared tail appended to EVERY built-in subagent system prompt: the reply is
 * consumed by the orchestrator agent, never shown raw to the user, so the
 * orchestrator's single-voice answer does not inherit a formal-report register.
 * English personas (code_reviewer / project_auditor) get the EN note, the
 * Chinese personas get the ZH note. */
const SUBAGENT_REPORT_NOTE_EN = `\n\nYour reply is read by the orchestrator agent, not shown to the user. Return compact findings only: conclusions, evidence (file:line, real command results), and open risks, as short bullets. No formal-report register, no pleasantries, no restating the task — the orchestrator will relay this conversationally. If your role protocol specifies a machine-readable final line (e.g. AUDIT: PASS/FAIL), still emit it exactly as instructed.`;
const SUBAGENT_REPORT_NOTE_ZH = `\n\n你的回复是给主 agent 汇总用的，不会直接展示给用户。只回要点：结论、证据（文件:行号、真实命令结果）、遗留风险，用简短列表。不要写成正式报告——不要标题、不要寒暄、不要复述任务，主 agent 会用口语向用户转述。`;

/** English-persona roles; everyone else gets the ZH note. */
const SUBAGENT_EN_PERSONA_ROLES = new Set(['code_reviewer', 'project_auditor']);

function subagentReportNote(name: string): string {
  return SUBAGENT_EN_PERSONA_ROLES.has(name) ? SUBAGENT_REPORT_NOTE_EN : SUBAGENT_REPORT_NOTE_ZH;
}

/**
 * A single progress snapshot emitted by the orchestrator while a subagent runs.
 * The host UI turns these into a live "which agent is working" view.
 */
/** One entry in a subagent's internal tool trace. The parent loop only hears
 * toolName via the old onTool path; this richer list (name + arg hint + state)
 * lets the activity panel show what a subagent actually did, not just that it
 * did something. */
export interface SubagentToolTrace {
  /** Tool the subagent invoked. */
  name: string;
  /** Short human-readable hint of the call's arguments (never full payloads). */
  args?: string;
  status: 'running' | 'completed' | 'failed';
}

export interface SubagentActivity {
  /** Parent tool-call id that spawned this subagent (stable UI key). */
  callId: string;
  /** Short quotable run id (ag-xxxxxxxx) shown on cards and embedded in
   *  terminal results — the locator when a specific run needs to be found in
   *  logs, transcripts, or a bug report. */
  agentId?: string;
  /** Subagent definition name, e.g. 'code_editor'. */
  agentName: string;
  /** Human description of the subagent's role. */
  agentRole?: string;
  /** Current engine state of the subagent (THINK / ACT / OBSERVE / ...). */
  state?: string;
  /** Last tool the subagent invoked. */
  toolName?: string;
  /** Outcome: true = finished successfully, false = failed / interrupted. */
  success?: boolean;
  error?: string;
  output?: string;
  /** Explicit lifecycle status used to derive the current active-agent set.
   * 'steered' (北极星第二步): a mid-run user steer was injected into this
   * subagent's next THINK — a momentary receipt, the run itself continues.
   * 'waiting': no progress for 30s (usually the model endpoint queueing) —
   * the run is alive but the provider is silent; reported so the card never
   * reads as dead.
   * 'retrying' (第 2 期第四刀): the failure policy chose retry/reflect inside
   * the subagent — a self-heal, the run continues and the state machine does
   * NOT move (the card lights up, the parent is not disturbed). */
  lifecycle?: 'queued' | 'started' | 'tool_running' | 'observing' | 'verifying' | 'done' | 'failed' | 'timed_out' | 'cancelled' | 'paused' | 'steered' | 'waiting' | 'retrying';
  /** High-level outcome (filled by onStart/onDone/onError). */
  status?: SubagentStatus;
  /** Monotonic per-call progress sequence; stale UI updates must be ignored. */
  sequence?: number;
  /** Epoch ms of the latest progress update. */
  lastUpdatedAt?: number;
  /** Whether the named tool is currently running or has returned. */
  toolState?: 'running' | 'completed';
  /** Wall-clock duration of the subagent run (ms), filled on done/error. */
  durationMs?: number;
  /** LLM tokens consumed (chunk count), filled on done/error. */
  tokensUsed?: number;
  /** Truncated summary of the delegated task (args.prompt/task) for the card header. */
  inputSnippet?: string;
  /** 分支级继续（第 2 期第三刀）：这一次委派命中了上一条 checkpoint（同参
   * 重派 → 稳定 sessionId），子引擎走的是 continue 而不是从头 run。血缘/
   * 续跑徽标的唯一事实来源，随 onStart / onDone 事件一起走。 */
  resumed?: boolean;
  /** 第 2 期第四刀：自愈重试的轮次（lifecycle 'retrying'）与原因摘要。 */
  attempt?: number;
  retryCause?: string;
  /** Epoch ms when the subagent started. */
  startedAt?: number;
  /** Subagent's hard timeout budget (ms). */
  timeoutMs?: number;
  /** Parent tool-call id that spawned this subagent (chain-of-delegation). */
  parentCallId?: string;
  /** Ordered, deduped-by-toolCallId trace of the tools the subagent ran so far. */
  toolTrace?: SubagentToolTrace[];
}

/** Optional UI progress sink — lets the host surface multi-agent activity. */
export interface SubagentProgress {
  onStart?: (a: SubagentActivity) => void;
  onState?: (a: SubagentActivity) => void;
  onTool?: (a: SubagentActivity) => void;
  onDone?: (a: SubagentActivity) => void;
  onError?: (a: SubagentActivity) => void;
}

/** Pure cap: derive a subagent's budget from the parent's so a single subagent
 * cannot burn the whole allocation. Exported so the code_reviewer fix — the
 * caps were once 6 turns / 20k tokens / 90s, far below what a multi-step
 * review (read several files, write a structured verdict) needs, so the
 * reviewer always aborted mid-review — is locked by a unit test. Most roles
 * stay tighter via their own `defaultTimeoutMs` AbortSignal. */
export function deriveSubagentBudget(parent: BudgetConfig): BudgetConfig {
  return {
    maxTurns: Math.min(parent.maxTurns, 20),
    maxTotalTokens: Math.min(parent.maxTotalTokens, 100_000),
    // Per-SEGMENT budget: one engine run inside a delegation. hardMaxTime is
    // the slice length — when it fires, the engine ends the run with a clean
    // "Budget exceeded" Interrupted carrying the full transcript, and the
    // orchestrator CONTINUES from that transcript in a fresh slice instead of
    // failing the delegation. Total wall clock is governed separately by the
    // role's defaultTimeoutMs; the parent's own budget still brackets all of
    // it. At the old 10-minute ceiling EVERY delegated generative agent died
    // mid-work ("four subagents, four timeouts") with no recovery but a
    // re-delegation hint the parent model could ignore.
    maxExecutionTime: Math.min(parent.maxExecutionTime, 1_800_000),
    hardMaxTime: Math.min(parent.maxExecutionTime, 600_000),
    // 首 token 90 秒（父会话默认 5 分钟）：免费档并发排队/僵死连接曾把一整批
    // 委派拖成无声灰卡 5 分钟（2026-09-20 "两个子 agent 无法执行"）。90 秒内
    // 一个字都没吐的连接是排队或挂了，快速失败进 failurePolicy 重试，健康但
    // 慢的生成不受影响——reasoning 模型思考时会持续吐 reasoning 增量。
    firstTokenTimeoutMs: 90_000,
    warningThreshold: parent.warningThreshold ?? 0.8,
    graceTurns: parent.graceTurns ?? 1,
  };
}

/** Short random run id (`ag-` + 8 lowercase hex). WebCrypto is available in
 *  every runtime pure runs in (WebView, bun tests, CLI); a module-level helper
 *  so tests can assert the shape. */
export function makeAgentId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `ag-${hex}`;
}

export interface SubagentOrchestratorConfig {
  llm: LLMAdapter;
  parentTools?: ToolAdapter;
  parentToolsDefs?: ToolDefinition[];
  /** Optional: recompute the tool list when spawning each subagent. */
  parentToolsDefsProvider?: () => ToolDefinition[];
  defaultBudget: BudgetConfig;
  /** Optional UI progress sink — lets the host show which subagent is working. */
  progress?: SubagentProgress;
  /** Optional limited budget for each subagent. When omitted, a constrained
   * budget is derived from defaultBudget so a single subagent cannot burn the
   * parent's entire allocation. */
  subagentBudget?: BudgetConfig;
  /** Optional checkpoint store: gives subagents a stable sessionId + resume so a
   * re-delegated identical sub-task continues instead of starting fresh. */
  stateStore?: IStateStore;
  /** Parent session id (used to build the stable subagent sessionId). */
  parentSessionId?: string;
  /** Nesting depth of the caller (0 = top-level). The orchestrator refuses to
   * spawn a subagent when depth+1 would exceed maxDepth. */
  depth?: number;
  maxDepth?: number;
  /** Optional verifier for subagents (defaults to the built-in rule checks so a
   * subagent also verifies its output instead of ending unverified). */
  verifier?: Verifier;
  /** Optional failure-recovery policy for subagents. When omitted, subagents
   * get the same escalating DefaultFailurePolicy as the parent (retry →
   * reflect → degrade → stop), so a single transient LLM/API error no longer
   * kills the subagent outright. */
  failurePolicy?: FailurePolicy;
  /** Liveness bound: abort a subagent only when NO progress event (token,
   * state, tool) has arrived for this long — healthy-but-slow work is never
   * killed by it, a wedged run is. Defaults to 5 minutes; injectable so
   * tests can exercise the watchdog in milliseconds. */
  noProgressTimeoutMs?: number;
  /** 北极星第二步（插话通道进子 agent）：mid-run user steers, queued by the
   * host's interject classifier. While a delegation is in flight the PARENT is
   * blocked inside the tool batch, so its THINK-boundary drain can't run —
   * handing the same queue to the subagent's engine lets the correction reach
   * whoever is actually working ("纠偏直达干活的人").
   * 1a 定向投递（对话智能升格）: the orchestrator wraps the host closure with
   * the branch's identity ({branchCallId, branchName}) so the host can filter —
   * a remark addressed at this branch is delivered here and nowhere else; a
   * broadcast remark is copied to every working branch and still consumed by
   * the parent at the confluence round. */
  takeSteerMessages?: (recipient?: import('../shared/steerTargeting').SteerRecipient) => Message[] | Promise<Message[]>;
  /** 阶段 13.3 — role name → 进化 overlay 文本（~/.pure/personas/<role>.overlay.md）。
   * 命中的角色在 spawn 时把 overlay 追加在 base persona 之后（只增补，不重写）；
   * 无命中的角色 prompt 逐字节不变。宿主装载（启动扫描），运行中不热删。 */
  personaOverlays?: Map<string, string>;
}

export class SubagentOrchestrator implements ToolAdapter {
  private engine = new AgentLoopEngine();
  private defs = new Map<string, SubagentDefinition>();
  private config: SubagentOrchestratorConfig;
  /** 对话智能升格第 2 期（分支中断）：在飞分支注册表——每支委派的 abort
   * 把手（controller）+ 生命周期账本（machine）+ 点名匹配面（任务书片段，
   * 用户按主题停/续一支时名字里未必有那个词）。abortBranch/pauseBranch
   * 按它定向叫停；结算出账后即删（暂停支的续跑 = 同参重派新调用，新账
   * 本）。这是「能 abort 的把手」账本，别与宿主 agentActivities（观测投
   * 影）混同。 */
  private readonly branches = new Map<string, { controller: AbortController; machine: BranchLifecycle; inputSnippet?: string }>();

  constructor(config: SubagentOrchestratorConfig) {
    this.config = config;
  }

  register(def: SubagentDefinition): void {
    this.defs.set(def.name, def);
  }

  getTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const def of this.defs.values()) {
      tools.push({
        name: def.name,
        description: def.description,
        // 接力流水线（北极星第 5 步）：每个委派工具的 schema 都带上保留参数
        // relay（as/from），模型用它在同一条消息里声明串行依赖链，运行时在
        // ToolExecutionCoordinator 里按拓扑序交接。克隆注入——定义是共享
        // 单例，不能被 schema 扩展污染。
        input_schema: withRelaySchema(def.input_schema),
      });
    }
    return tools;
  }

  /** Parallel/serial classification (2026-09-20): delegations are NEVER
   * isWrite — side-effecting agents (WRITE/SHELL/DESTRUCTIVE tags) overlap in
   * the parent's reads pool like read-only ones; `sideEffects` stays in the
   * metadata contract as information only (the coordinator no longer keys a
   * serial pool on it). Same-file safety between concurrent siblings is the
   * shared FileLockManager at the inner file-tool level. `timeoutMs` publishes
   * the definition's own budget so the parent's tool-execution wrapper brackets
   * the delegation by IT instead of the generic tool cap — a review agent
   * legitimately runs longer than three minutes. */
  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean; timeoutMs?: number } | undefined {
    const def = this.defs.get(toolName);
    if (!def) return { sideEffects: true, isWrite: false };
    const tags = def.tags ?? [];
    const mutates = tags.includes(Tags.WRITE) || tags.includes(Tags.SHELL) || tags.includes(Tags.DESTRUCTIVE);
    return { sideEffects: mutates, isWrite: false, timeoutMs: def.defaultTimeoutMs };
  }

  /** Derive a constrained per-subagent budget from the parent's, so a single
   * subagent cannot burn the whole allocation. Independent (not net-shared)
   * — the parent's wall-clock deadline still brackets the subagent via the
   * engine's runWithDeadline. */
  private subagentBudget(): BudgetConfig {
    return deriveSubagentBudget(this.config.subagentBudget ?? this.config.defaultBudget);
  }

  /** FNV-1a 64-bit over the UTF-8 bytes of a string (stable, no Date/random —
   * reused so a re-delegated identical sub-task maps to the same sessionId).
   * Mirrors the webCache hashKey convention. */
  private stableHash(parts: string[]): string {
    let h = 0xcbf29ce484222325n;
    for (const p of parts) {
      for (const b of new TextEncoder().encode(p)) {
        h ^= BigInt(b);
        h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
      }
    }
    return h.toString(16);
  }

  private inputSnippet(args: Record<string, unknown>): string {
    const raw = (typeof args.prompt === 'string' ? args.prompt
      : typeof args.task === 'string' ? args.task
      : typeof args.question === 'string' ? args.question
      : typeof args.topic === 'string' ? args.topic
      : typeof args.instructions === 'string' ? args.instructions
      : '')
      .replace(/\s+/g, ' ')
      .trim();
    return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
  }

  async execute(toolCall: ToolCall, parentSignal?: AbortSignal): Promise<ToolResult> {
    const def = this.defs.get(toolCall.function.name);
    const startTime = Date.now();
    const done = (durationMs: number): number => Date.now() - startTime;

    if (!def) {
      return {
        id: toolCall.id,
        toolName: toolCall.function.name,
        error: `Unknown subagent: ${toolCall.function.name}`,
        success: false,
        duration: 0,
      };
    }

    // Recursion budget: refuse to nest deeper than maxDepth (default 1).
    const maxDepth = this.config.maxDepth ?? 1;
    const depth = (this.config.depth ?? 0) + 1;
    if (depth > maxDepth) {
      return {
        id: toolCall.id,
        toolName: def.name,
        error: `子 agent 嵌套超过层级限制 (depth ${depth} > maxDepth ${maxDepth}) — 子 agent 不再委派子 agent。`,
        success: false,
        duration: 0,
      };
    }

    // 生命周期账本 + abort 把手（第 2 期分支中断）：每个受理的委派一支账。
    // machine 是 status/lifecycle 的唯一写手（结算处统一 describe()），branch
    // controller 并进 combinedSignal——abortBranch 只点这一支的火。
    const machine = new BranchLifecycle(toolCall.id, def.name);
    const branchController = new AbortController();
    this.branches.set(toolCall.id, { controller: branchController, machine });

    // Per-call tool trace: keyed by the subagent's internal toolCallId so
    // parallel tool calls inside one round cannot clobber each other. Derived
    // from the subagent engine's ToolStarted/ToolResult events; emitted with
    // onTool/onDone/onError so the UI can expand what the subagent actually
    // did rather than showing a single "agentName" row.
    const toolTrace = new Map<string, SubagentToolTrace>();
    // Compact arg hint: pull the fields users actually care about (path, files,
    // query, command …) out of the tool-call JSON. Never a full payload.
    const summarizeToolArgs = (raw: string | undefined): string | undefined => {
      if (!raw) return undefined;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') return undefined;
        const parts: string[] = [];
        for (const key of ['path', 'files', 'query', 'topic', 'command', 'prompt', 'package', 'name', 'url']) {
          const value = parsed[key];
          if (typeof value === 'string' && value.trim()) {
            const v = value.replace(/\s+/g, ' ').trim();
            parts.push(v.length > 40 ? `${v.slice(0, 40)}…` : v);
          } else if (value !== null && typeof value === 'object') {
            const s = JSON.stringify(value);
            parts.push(s.length > 40 ? `${s.slice(0, 40)}…` : s);
          }
        }
        return parts.length > 0 ? parts.join(' · ') : undefined;
      } catch {
        const flat = raw.replace(/\s+/g, ' ').trim();
        return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
      }
    };
    // UI progress sink: emit a live "which agent is working" trace so the host
    // UI can show the multi-agent nature of the run instead of a black box.
    // CRITICAL: a display/UI error MUST NOT break the agent's actual work
    // (code/image/plan generation) — every emit is swallowed. The orchestrator's
    // return value (the ToolResult handed back to the parent agent) is never
    // touched by these callbacks, so message pass-through stays intact.
    const progress = this.config.progress;
    const timeoutMs = def.defaultTimeoutMs;
    let progressSequence = 0;
    const nextProgressMeta = (): Pick<SubagentActivity, 'sequence' | 'lastUpdatedAt'> => ({
      sequence: ++progressSequence,
      lastUpdatedAt: Date.now(),
    });
    // Short, quotable run id (ag- + 8 hex): the locator a user pastes back when
    // something went wrong. The toolCallId is the durable key but it is a
    // UUID — useless to read aloud or grep casually. The agentId rides EVERY
    // activity emit, the terminal tool result, and the persisted roster, so a
    // card, an error line, and a session.json dump all point at the same run.
    const agentId = makeAgentId();
    const activity = (): SubagentActivity => ({
      callId: toolCall.id,
      agentId,
      agentName: def.name,
      agentRole: def.description,
      timeoutMs,
      parentCallId: toolCall.id,
      ...nextProgressMeta(),
    });
    const emit = (
      cb: ((a: SubagentActivity) => void) | undefined,
      extra: Partial<SubagentActivity> = {},
    ): void => {
      if (!cb) return;
      try {
        cb({ ...activity(), ...extra });
      } catch {
        // Host UI failed to render — ignore so the subagent keeps working.
      }
    };

    // Parse args — slightly-broken LLM JSON is repaired first, so a single
    // trailing comma or unquoted key no longer drops the whole prompt payload.
    const args = parseToolArguments(toolCall.function.arguments);
    // 注册表补点名匹配面（第 2 期）：branchView 的 snippet 供宿主按主题
    // 点名停/续一支——名字是代号（researcher），主题在任务书里。
    const registered = this.branches.get(toolCall.id);
    if (registered) registered.inputSnippet = this.inputSnippet(args);
    // Stable subagent sessionId for checkpoint resume; only meaningful when a
    // stateStore is configured (CLI / GUI 进程内). Same parent session + agent
    // + task input → same sessionId → a re-delegated identical sub-task
    // continues. Use `_`/`.`/`-` only — FSStore rejects sessionIds with `:` or
    // other path characters (path-traversal guard).
    const parentSessionId = (this.config.parentSessionId ?? 'cli').replace(/[^A-Za-z0-9._-]/g, '_');
    const sessionId = this.config.stateStore
      ? `sub_${parentSessionId}_${def.name}_${this.stableHash([def.name, JSON.stringify(args)])}`
      : `subagent_${def.name}_${startTime}`;
    // 分支级继续（第 2 期第三刀）：同参重派命中上一条 checkpoint = 续跑，
    // 不是从头跑。这是血缘/续跑徽标的唯一事实来源，onStart 起可见。
    const resumedFromCheckpoint = Boolean(this.config.stateStore?.loadSession(sessionId)?.state?.messages?.length);
    emit(progress?.onStart, { inputSnippet: this.inputSnippet(args), startedAt: startTime, resumed: resumedFromCheckpoint, ...machine.describe() });

    // Liveness watchdog: abort only when NO progress event (token / state /
    // tool) has arrived for a while — a wedged run dies in minutes while
    // healthy-but-slow work is never killed by it. Paused while a tool
    // executes: a long command produces no events by design.
    const noProgressMs = this.config.noProgressTimeoutMs ?? 300_000;
    const watchdog = new AbortController();
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    let toolInFlight = false;
    let lastProgressAt = Date.now();
    // 卡片活性播报（2026-09-20 "两个子 agent 无法执行"）：子代理卡在"模型不吐
    // 字"时（免费档并发排队是常态），卡片不该一声不吭地灰着——每 30s 无进展
    // 就报一条 waiting，用户看得见"在等模型"，而不是"死了"。工具在跑时安静：
    // trace 行已经显示它在执行什么。
    const STALL_TICK_MS = 30_000;
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    const stopWatchdogTimer = (): void => {
      if (watchdogTimer !== undefined) {
        clearTimeout(watchdogTimer);
        watchdogTimer = undefined;
      }
      if (stallTimer !== undefined) {
        clearInterval(stallTimer);
        stallTimer = undefined;
      }
    };
    const kickWatchdog = (): void => {
      lastProgressAt = Date.now();
      if (toolInFlight) return;
      stopWatchdogTimer();
      watchdogTimer = setTimeout(() => watchdog.abort(), noProgressMs);
      stallTimer = setInterval(() => {
        if (toolInFlight) return;
        if (Date.now() - lastProgressAt < STALL_TICK_MS) return;
        emit(progress?.onState, { state: 'THINK', lifecycle: 'waiting' });
      }, STALL_TICK_MS);
    };

    // Build combined signal: parent abort OR branch-targeted abort OR total
    // wall clock OR liveness.
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = parentSignal
      ? AbortSignal.any([parentSignal, branchController.signal, timeoutSignal, watchdog.signal])
      : AbortSignal.any([branchController.signal, timeoutSignal, watchdog.signal]);

    // Engine context is per-segment (fresh budget per slice); the static
    // parts are hoisted. The subagent also verifies (default rule-based
    // verifier) and re-computes its tool list each THINK instead of a
    // spawn-time snapshot.
    const baseCtx = {
      llm: this.config.llm,
      tools: this.config.parentTools,
      toolsDefs: this.config.parentToolsDefsProvider?.() ?? this.config.parentToolsDefs ?? [],
      toolsDefsProvider: this.config.parentToolsDefsProvider,
      signal: combinedSignal,
      verifier: this.config.verifier ?? createDefaultVerifier(),
      // Subagents must recover from transient failures like the parent does.
      // Without a failurePolicy the engine aborts the subagent on the FIRST
      // LLM error (network blip, rate limit, stream timeout) — the "子 agent
      // 经常失败" the GUI surfaced. Escalating retry → reflect → degrade →
      // stop mirrors the parent harness.
      failurePolicy: this.config.failurePolicy ?? new DefaultFailurePolicy(),
      depth,
      maxDepth: this.config.maxDepth ?? 1,
      // 插话通道：与父引擎共享宿主的 steer 队列（见 config 注释）。引擎在
      // THINK 边界拉取并注入为 user 消息，随子代理 transcript 一起存档。
      // 1a 定向投递：宿主闭包被包上本分支的身份——用户点名这一支的话在这里
      // 被取走，广播话人人可读但只有父边界能收走（见 steerTargeting 语义）。
      takeSteerMessages: this.config.takeSteerMessages
        ? (recipient?: import('../shared/steerTargeting').SteerRecipient) => this.config.takeSteerMessages!({
            ...recipient,
            branchCallId: toolCall.id,
            branchName: def.name,
          })
        : undefined,
    };

    try {
      // 13.3 合并点：base（代码里，不动）+ 进化 overlay（命中才追加）+ 机械性
      // 汇报格式说明。删 overlay 文件即回滚——下一个会话自然回原样。
      const overlay = this.config.personaOverlays?.get(def.name);
      const systemPrompt = applyPersonaOverlay(def.createSystemPrompt(args), overlay) + subagentReportNote(def.name);
      const userPrompt = typeof args.prompt === 'string'
        ? args.prompt
        : JSON.stringify(args);

      let finalOutput: string | undefined;
      let tokensUsed = 0;
      let usage: TokenUsage | undefined;
      // 第 2 期第四刀：子代理内部自愈重试的轮次（failurePolicy retry/reflect）。
      // 不迁移状态机——卡片亮灯 + 一条 branch_retrying 一等事件，父不被打扰。
      let retryAttempt = 0;

      const persist = async (label: string, messages: Message[] | undefined, turnCount: number): Promise<void> => {
        const store = this.config.stateStore;
        if (!store || !messages || messages.length === 0) return;
        // Same resume-safety contract as the parent Harness: a checkpoint that
        // ends in an unresolved assistant.toolCalls gets the resume request
        // rejected with 400, which would silently break the "re-delegate to
        // continue from its checkpoint" recovery this store exists for.
        const trimmed = trimUnresolvedToolCalls(messages);
        if (trimmed.length === 0) return;
        try {
          await store.saveCheckpoint(sessionId, {
            version: 1,
            label,
            state: { messages: trimmed, turnCount },
            createdAt: Date.now(),
          });
        } catch {
          // Persistence is best-effort — a read-only store must not break the run.
        }
      };

      // Resume: when a checkpoint for this stable sessionId exists, continue the
      // previous sub-run instead of starting fresh (mirrors parent Harness.run).
      const saved = this.config.stateStore?.loadSession(sessionId)?.state;
      const resumedMessages = saved && saved.messages.length > 0 ? saved.messages : undefined;

      // Segment slicing: each engine run gets a hard time slice; when it ends
      // with the engine's clean "Budget exceeded" Interrupted (full transcript
      // intact), continue in a fresh slice instead of failing the delegation.
      // The role's defaultTimeoutMs stays the TOTAL wall the parent waits —
      // this loop is what makes "ran out of time" mean "keep going" rather
      // than "failed, hope the parent model re-delegates".
      const segmentBudget = this.subagentBudget();
      const segmentSliceMs = segmentBudget.hardMaxTime ?? segmentBudget.maxExecutionTime;
      const maxSegments = Math.max(1, Math.min(5, Math.ceil(timeoutMs / segmentSliceMs)));
      const SEGMENT_RESUME_HINT = '[system] Your previous work slice ended (its time budget ran out). Nothing is broken — continue EXACTLY where the transcript above leaves off: do not restart, do not redo completed steps; finish the remaining work and deliver the final result.';
      let segment = 0;
      let carryMessages: Message[] | undefined;
      let firstEventSeen = false;
      kickWatchdog();

      segmentLoop: while (true) {
        segment++;
        kickWatchdog();
        const budget = segment === 1 ? segmentBudget : this.subagentBudget();
        const ctx: EngineContext = { ...baseCtx, budget };
        if (segment > 1) {
          // Re-mark the roster card active so a slice boundary never reads as
          // the agent dying and respawning.
          emit(progress?.onStart, { inputSnippet: this.inputSnippet(args), startedAt: startTime, resumed: resumedFromCheckpoint, ...machine.describe() });
        }
        const stream = segment === 1
          ? (resumedMessages
              ? this.engine.continue(
                  { sessionId, newUserPrompt: userPrompt, messages: resumedMessages, budget },
                  ctx,
                )
              : this.engine.run(
                  { sessionId, systemPrompt, userPrompt, budget },
                  ctx,
                ))
          : this.engine.continue(
              { sessionId, newUserPrompt: SEGMENT_RESUME_HINT, messages: carryMessages!, budget },
              ctx,
            );

        for await (const event of stream) {
        if (!firstEventSeen) {
          // 地面真相：子引擎吐出第一个事件 = 委派中 → 运行中。
          firstEventSeen = true;
          machine.apply('spawned');
        }
        if (event.type === 'TokenDelta') {
          tokensUsed++;
          kickWatchdog();
        } else if (event.type === 'StateChange') {
          kickWatchdog();
          const lifecycle = event.payload.to === 'ACT' ? 'started'
            : event.payload.to === 'OBSERVE' ? 'observing'
              : event.payload.to === 'VERIFY' ? 'verifying'
                : event.payload.to === 'TERMINATE' ? 'done'
                  : 'started';
          emit(progress?.onState, { state: event.payload.to, lifecycle, toolState: event.payload.to === 'ACT' ? undefined : 'completed' });
        } else if (event.type === 'FailurePolicyDecision') {
          // 第 2 期第四刀：failurePolicy 的 retry/reflect 是子代理自己的自愈
          // 线（不清状态、不动状态机）——发 branch_retrying 让卡片亮灯，父与
          // 兄弟支零感知。degrade/stop 是往失败走的路，不在此列（重试耗尽
          // 落已失败是另一条结算路）。
          const action = event.payload.action;
          if (action.kind === 'retry' || action.kind === 'reflect') {
            retryAttempt++;
            kickWatchdog();
            emit(progress?.onState, {
              state: 'RETRY',
              lifecycle: 'retrying',
              attempt: retryAttempt,
              retryCause: event.payload.failure?.message,
            });
          }
        } else if (event.type === 'SteerInjected') {
          // 插话已并入子代理的下一轮 THINK —— 给活动卡一条可见回执（lifecycle
          // 'steered' → 卡片 trace 行 📨），别让用户猜"话到底递到没有"。
          kickWatchdog();
          emit(progress?.onState, { state: 'STEER', lifecycle: 'steered' });
        } else if (event.type === 'ToolStarted') {
          toolInFlight = true;
          stopWatchdogTimer();
          toolTrace.set(event.payload.toolCallId, {
            name: event.payload.toolName,
            args: summarizeToolArgs(event.payload.toolCallArgs),
            status: 'running',
          });
          emit(progress?.onTool, { toolName: event.payload.toolName, toolState: 'running', lifecycle: 'tool_running', toolTrace: [...toolTrace.values()] });
        } else if (event.type === 'ToolResult') {
          toolInFlight = false;
          kickWatchdog();
          const entry = toolTrace.get(event.payload.toolCallId);
          if (entry) entry.status = event.payload.result?.success ? 'completed' : 'failed';
          emit(progress?.onTool, { toolName: event.payload.toolName, toolState: 'completed', lifecycle: 'observing', toolTrace: [...toolTrace.values()] });
        } else if (event.type === 'Completed') {
          finalOutput = event.payload.finalOutput;
          // T1 — copy the delegation's own token split for per-role cost
          // accounting. `tokensUsed` (the TokenDelta count) stays as-is: both
          // observers keep their existing semantics.
          usage = event.payload.usage;
          // finalOutput is only the LAST THINK round's text — empty when the
          // sub-agent ended on an empty response (reasoning models burning the
          // whole output budget on thinking are the known case). The rail card
          // still turns done via onDone, so an empty payload desyncs the two
          // views (done card above, blank tool-row Output below). Fall back to
          // the transcript: the closest preceding non-empty assistant text is
          // the best available summary voice — last resort only, it never
          // overrides a real finalOutput.
          if (!finalOutput || !finalOutput.trim()) {
            const transcript = event.payload.messages ?? [];
            for (let i = transcript.length - 1; i >= 0; i--) {
              const m = transcript[i];
              if (m.role !== 'assistant' || m.internal) continue;
              if (typeof m.content === 'string' && m.content.trim()) {
                finalOutput = m.content;
                break;
              }
            }
          }
          await persist('subagent_completed', event.payload.messages, event.payload.turnCount ?? 0);
          machine.apply('complete');
          emit(progress?.onDone, { success: true, output: finalOutput, ...machine.describe(), durationMs: done(0), tokensUsed, toolTrace: [...toolTrace.values()] });
          return {
            id: toolCall.id,
            toolName: def.name,
            result: {
              id: toolCall.id,
              agentId,
              agentName: def.name,
              success: true,
              output: finalOutput,
              resumed: resumedFromCheckpoint,
              duration: done(0),
              tokensUsed,
              usage,
            },
            success: true,
            duration: done(0),
          };
        } else if (event.type === 'Interrupted') {
          await persist('subagent_interrupted', event.payload.messages, event.payload.turnCount ?? 0);
          if (combinedSignal.aborted) {
            // 第 2 期分支中断（persist-before-settle：存档已在上一行落盘，才
            // 结算）。branchController 是 abortBranch/pauseBranch 的私有把手
            // ——往它上面写 reason 的只有编排器自己，所以按 reason 分流是可
            // 靠的，而且必须如此：中止（BRANCH_ABORT_REASON）与暂停（PAUSE_
            // ABORT_REASON）都要点这支的火，只有 reason 分得开两者终态。
            // 产出不入账、断点照存、可另起续——两条路共享这组语义。
            if (isBranchAbort(branchController.signal)) {
              // 2026-09-26 大bug 复盘：note 是给父模型的行动指引，不是机制
              // 说明书。"To continue it later, re-delegate…" 被父模型读成
              // "该重派"，等兄弟支一交付就自作主张去续用户亲手停掉的支。
              // 用户的去留是用户的决定：默认不重派、不等它，只有用户明确
              // 要续才重派（机制本身不变——同参重派仍从存档续）。
              const branchAbortNote = 'The user STOPPED this subtask mid-run — their deliberate choice to drop it. Do NOT re-delegate it and do NOT wait for it: it will NOT be counted toward the overall task. Proceed with the remaining work without it and note the stop in the final summary. Only re-delegate the SAME subtask (it resumes from its checkpoint, not start over) if the user EXPLICITLY asks to continue this branch later.';
              machine.apply('abort', { abortCause: 'user-branch' });
              // 用户叫停不是失败（2026-09-25 复测）：success:false 曾把
              // "Error: undefined" 喂给父模型、触发失败策略、让汇总把
              // "已暂停/已取消"写成"分支挂了"。success:true + outcome 标识
              // 才是这套语义的正名；reason 留给模型，summary 留给界面。
              emit(progress?.onDone, { success: true, ...machine.describe(), durationMs: done(0), tokensUsed, toolTrace: [...toolTrace.values()] });
              return {
                id: toolCall.id,
                toolName: def.name,
                result: { aborted: true, agentId, outcome: 'stopped', reason: branchAbortNote, summary: '已按你的要求停止，进度已存档', finalOutput, resumed: resumedFromCheckpoint },
                success: true,
                duration: done(0),
              };
            }
            // 阶段 12 pause: the pause reason on any of the three signals —
            // NOT a cancellation. 哪个信号带 reason 决定 note 的去向：
            // parentSignal 被暂停 = 整轮暂停，「继续」条承诺子 agent 从存档
            // 续，恢复后父模型同参重派是对的，note 保留续跑指引；只有
            // branchController 带 reason = 用户点名收掉这一支，去留是用户的
            // 决定（2026-09-26 大bug：旧文案 "to continue, re-delegate" 被父
            // 模型读成行动指令，兄弟支一交付就去续用户亲手暂停的支）。
            if (isPauseAbort(parentSignal) || isPauseAbort(combinedSignal) || isPauseAbort(branchController.signal)) {
              const pausedNote = isPauseAbort(parentSignal)
                ? 'The whole conversation turn was PAUSED by the user. This subtask\'s progress is saved; when the turn resumes, re-delegate the SAME subtask with identical arguments — it will resume from its checkpoint, not start over.'
                : 'The user PAUSED this subtask mid-run — their deliberate choice to drop it from the current run. Do NOT re-delegate it and do NOT wait for it: proceed with the remaining work without it and mention the pause in the final summary. Only if the user EXPLICITLY asks to continue this branch later should you re-delegate the SAME subtask (it resumes from its checkpoint, not start over).';
              machine.apply('pauseSettled');
              // 同上：暂停不是失败，也不进失败策略。outcome:'paused' 是
              // 界面的静音标识（灰卡 ⏸，不是红 ✗）；reason 对整轮暂停是
              // "恢复后同参重派即断点续跑"，对点名暂停是"别重派，等用户
              // 发话"。
              emit(progress?.onDone, { success: true, ...machine.describe(), durationMs: done(0), tokensUsed, toolTrace: [...toolTrace.values()] });
              return {
                id: toolCall.id,
                toolName: def.name,
                result: { aborted: true, agentId, outcome: 'paused', reason: pausedNote, summary: '已暂停，进度已存档', finalOutput, resumed: resumedFromCheckpoint },
                success: true,
                duration: done(0),
              };
            }
            const cancelled = parentSignal?.aborted === true && !timeoutSignal.aborted && !watchdog.signal.aborted && !branchController.signal.aborted;
            const stalled = watchdog.signal.aborted && !timeoutSignal.aborted && !branchController.signal.aborted;
            // A timeout here is the delegation's TOTAL wall (defaultTimeoutMs)
            // or the liveness watchdog, not a malfunction of any single slice.
            // The error tells the parent how to recover (re-delegate to
            // continue from the checkpoint) and that partial output may exist.
            const timeoutNote = cancelled
              ? 'cancelled'
              : stalled
                ? `no progress for ${Math.max(1, Math.round(noProgressMs / 60_000))} minutes — the subagent appeared wedged (no tokens, no tool activity). Re-delegate the SAME subtask to retry from its checkpoint${finalOutput ? '; partial output was produced' : ''}.`
                : `timed out after ${Math.round(def.defaultTimeoutMs / 1000)}s — the subagent used all ${maxSegments} work segment${maxSegments > 1 ? 's' : ''} and was still mid-task (generative tasks take a while). Re-delegate the SAME subtask to continue from its checkpoint${finalOutput ? '; partial output was produced' : ''}.`;
            machine.apply(cancelled ? 'abort' : 'fail', cancelled ? { abortCause: 'tree-cancel' } : { failCause: stalled ? 'stalled' : 'timeout' });
            emit(progress?.onDone, { success: false, error: timeoutNote, ...machine.describe(), durationMs: done(0), tokensUsed, toolTrace: [...toolTrace.values()] });
            return {
              id: toolCall.id,
              toolName: def.name,
              result: { aborted: true, agentId, reason: timeoutNote, finalOutput },
              success: false,
              duration: done(0),
            };
          }
          // Clean slice end: the segment's hard budget fired with the
          // transcript intact — carry it into a fresh slice and keep going.
          // This converts "ran out of time" from a failure into a continuation.
          const sliceTranscript = event.payload.messages;
          if (event.payload.reason === 'Budget exceeded' && segment < maxSegments && sliceTranscript && sliceTranscript.length > 0) {
            carryMessages = sliceTranscript;
            await persist(`subagent_segment_${segment}`, carryMessages, event.payload.turnCount ?? 0);
            continue segmentLoop;
          }
          machine.apply('fail', { failCause: 'error' });
          emit(progress?.onDone, { success: false, error: event.payload.reason, output: finalOutput, ...machine.describe(), durationMs: done(0), tokensUsed, toolTrace: [...toolTrace.values()] });
          // A non-abort Interrupted (failure-policy stop, or the LAST slice's
          // budget exhaustion) is a REAL failure — report it as such to the
          // parent instead of falling through to the success result below
          // (which used to mask the subagent's death as `success: true` with
          // empty output).
          return {
            id: toolCall.id,
            toolName: def.name,
            error: event.payload.reason,
            result: { aborted: false, agentId, reason: event.payload.reason, finalOutput },
            success: false,
            duration: done(0),
          };
        } else if (event.type === 'Error') {
          // RECOVERABLE engine errors (VERIFY_FAILED, VERIFIER_ERROR) are part
          // of the engine's self-correction loop: it emits the event, folds a
          // recovery hint into the messages, and loops again. Returning here
          // used to kill a healthy subagent mid-recovery and report the
          // delegation as failed. Surface the bump on the state channel only
          // and keep consuming — the run's real outcome arrives via
          // Completed/Interrupted.
          if (event.payload.recoverable) {
            kickWatchdog();
            emit(progress?.onState, { state: event.payload.stateType, lifecycle: 'verifying' });
            continue;
          }
          // A timeout is not a malfunction: generative subagents (ui_designer
          // writing a whole site design, deep_thinker reasoning for minutes)
          // simply need longer than their budget. Tell the parent HOW to
          // recover — the checkpoint store lets a re-delegation of the SAME
          // subtask continue instead of starting over.
          const isTimeout = event.payload.code === 'LLM_STREAM_ERROR' && /timed out/i.test(event.payload.message);
          const errorText = isTimeout
            ? `${event.payload.message} — the subagent was still working when its time budget ran out (generative tasks take a while). Re-delegate the SAME subtask to continue from its checkpoint, or do the work directly in the main session.`
            : event.payload.message;
          machine.apply('fail', { failCause: 'error' });
          emit(progress?.onError, { error: errorText, ...machine.describe(), durationMs: done(0), tokensUsed, toolTrace: [...toolTrace.values()] });
          return {
            id: toolCall.id,
            toolName: def.name,
            error: errorText,
            result: { agentId },
            success: false,
            duration: done(0),
          };
        }
        }

        // The stream ended without a terminal event (the engine guarantees
        // one — this is defensive). Do NOT slice again; report via the
        // fall-through below.
        break;
      }

      const result: SubagentResult = {
        id: toolCall.id,
        agentId,
        agentName: def.name,
        success: true,
        output: finalOutput,
        duration: done(0),
        tokensUsed,
      };

      return {
        id: toolCall.id,
        toolName: def.name,
        result: result,
        success: true,
        duration: done(0),
      };
    } catch (err: any) {
      machine.apply('fail', { failCause: 'error' });
      emit(progress?.onError, { error: err?.message ?? String(err), ...machine.describe(), durationMs: done(0), tokensUsed: 0, toolTrace: [...toolTrace.values()] });
      return {
        id: toolCall.id,
        toolName: def.name,
        error: err?.message ?? String(err),
        result: { agentId },
        success: false,
        duration: done(0),
      };
    } finally {
      stopWatchdogTimer();
      // 结算出账即销户（注册表只挂在飞分支；暂停支的续跑 = 同参重派新调用）。
      this.branches.delete(toolCall.id);
    }
  }

  /** 对话智能升格第 2 期（分支中断）：按 callId 叫停一支在飞委派。只点这一
   * 支的火（branchController 并在 combinedSignal 里，父级信号不动）——子引擎
   * 照走 Interrupted+checkpoint 链，编排器按「已中止」结算：产出不入账、断
   * 点照存、可另起续。同批其余支零感知。找不到这一支/它已结算 = false。 */
  abortBranch(callId: string): boolean {
    const entry = this.branches.get(callId);
    if (!entry) return false;
    const applied = entry.machine.apply('abort', { abortCause: 'user-branch' });
    if (!applied.ok) return false;
    entry.controller.abort(BRANCH_ABORT_REASON);
    return true;
  }

  /** 同 abortBranch 的点名通路，但落「暂停」不落「中止」（2026-09-25 复测
   * 案例二：用户收掉一项说的是「先停下」，不是「不要了」——暂停支断点照
   * 存、产出不入账，想续随时同参重派，比中止留的活口更大）。已在暂停中/
   * 已暂停/已结算 = false（幂等，调用方退回折入兜底）。 */
  pauseBranch(callId: string): boolean {
    const entry = this.branches.get(callId);
    if (!entry) return false;
    const applied = entry.machine.apply('pause');
    if (!applied.ok) return false;
    entry.controller.abort(PAUSE_ABORT_REASON);
    return true;
  }

  /** 在飞分支的只读视图（宿主点名寻址可用的权威面；宿主 agentActivities 是
   * 它的观测投影，不是反过来）。inputSnippet 是按主题点名的匹配面——名字
   * 是代号，主题在任务书里。 */
  branchView(): Array<{ callId: string; agentName: string; state: BranchState; cause?: string; inputSnippet?: string }> {
    return Array.from(this.branches.entries()).map(([callId, entry]) => ({
      callId,
      agentName: entry.machine.agentName,
      state: entry.machine.state(),
      cause: entry.machine.cause(),
      inputSnippet: entry.inputSnippet,
    }));
  }
}

// ── Built-in subagent definitions ──

export const BUILT_IN_SUBAGENTS: SubagentDefinition[] = [
  {
    name: 'code_reviewer',
    description: 'Review code changes for correctness, style, and security — the independent quality gate (T1 role separation): use whenever a deliverable needs a verdict that should NOT come from its own author (never grade your own work). Returns a structured review with issues and suggestions.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Description of what to review, with relevant code context' },
        files: { type: 'string', description: 'File paths or code snippets to review (comma-separated)' },
      },
      required: ['prompt'],
    },
    tags: [Tags.AGENT, Tags.READ],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const filesHint = typeof input.files === 'string' ? `\nFocus on these files: ${input.files}` : '';
      return `You are a code reviewer. Review the provided code for:
1. Correctness — does it do what it claims?
2. Style — does it follow conventions?
3. Security — are there any vulnerabilities?
4. Performance — are there obvious optimizations?
5. Edge cases — what might break?

Be concise. Structure your review with clear sections.${filesHint}${THIRD_PARTY_SCOPE_NOTE_EN}`;
    },
    // A real review reads several files then writes a structured verdict; keep
    // this above the subagent budget cap so the budget (not a stray timeout)
    // governs. 90s/120s was consistently too short.
    defaultTimeoutMs: 1_800_000,
  },
  {
    name: 'project_auditor',
    description: 'Audit a project for dependency vulnerabilities, unsafe configuration, exposed secrets, and reproducible verification evidence. Uses read-only checks and returns a structured AUDIT: PASS or AUDIT: FAIL verdict. Read-only and parallel-safe: run it as the verification/audit role (T2/T3) when delivery needs independent evidence.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The project audit scope and delivery constraints' },
        files: { type: 'string', description: 'Project manifests, lockfiles, configuration, and source paths to inspect' },
      },
      required: ['prompt'],
    },
    tags: [Tags.AGENT, Tags.READ],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const filesHint = typeof input.files === 'string' ? `\nPrioritize these paths: ${input.files}` : '';
      return `You are a project security and delivery auditor. Perform a read-only audit using the available filesystem and command tools.

Check:
1. Dependency manifests and lockfiles for known vulnerabilities using the project's existing audit tool when available. Never run npm audit fix, cargo update, or other mutating remediation.
2. Secret exposure in tracked and untracked source/config files, including common API-key and private-key patterns. Avoid printing full secrets; report only the file and line context needed to fix them.
3. Unsafe scripts, shell injection surfaces, permissive configuration, and missing validation around external input.
4. Whether the project's documented typecheck, test, lint, and build commands are reproducible and whether their real output supports the conclusion.

Distinguish a vulnerability/finding from an unavailable audit tool, missing lockfile, network failure, or inconclusive result. Do not call an unavailable check a pass. Report evidence under concise headings, then end with exactly one line: AUDIT: PASS when no blocking finding remains and all required checks have evidence, otherwise AUDIT: FAIL.${filesHint}${THIRD_PARTY_SCOPE_NOTE_EN}`;
    },
    // Same reasoning as code_reviewer: a read-only audit walks manifests and
    // runs checks, so 120s was too tight. Bounded by the subagent budget cap.
    defaultTimeoutMs: 1_800_000,
  },
];

// ── Extended coding agent roles (Phase 1) ──
// These agents form the core multi-agent collaboration system for coding tasks.
// They are designed to work together: planner → editor → reviewer → basher.

export const CODING_AGENT_ROLES: SubagentDefinition[] = [
  // === 规划器 (Task Planner) ===
  // Breaks down complex tasks into ordered, actionable steps
  {
    name: 'task_planner',
    description: '制定详细的修改计划，决定修改哪些文件及执行顺序。用于复杂多文件/重构任务：先出计划（T1 规划），再让 code_editor 执行。',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '用户任务描述' },
        context: { type: 'string', description: '项目上下文信息（当前代码结构、技术栈等）' },
        constraints: { type: 'string', description: '约束条件（如代码风格、技术要求）' },
      },
      required: ['task'],
    },
    tags: [Tags.AGENT, Tags.PLAN],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const task = String(input.task || '');
      const context = String(input.context || '无');
      const constraints = String(input.constraints || '无');
      return `你是一个专业的任务规划师。分析任务并制定详细的修改计划。

任务：${task}
上下文：${context}
约束：${constraints}

请制定包含以下信息的计划：
1. 步骤编号和具体动作
2. 涉及的文件列表（按依赖顺序）
3. 每个步骤的预期结果
4. 步骤间的依赖关系

保持步骤原子化，每个步骤一个清晰动作。`;
    },
    defaultTimeoutMs: 1_800_000,
  },

  // === 编辑器 (Code Editor) ===
  // Executes precise code modifications based on plans
  {
    name: 'code_editor',
    description: '根据计划执行精确的代码修改。先读取文件，然后按指令修改。用于独立可并行的子块实现（T2）：把每个子块交给一个 code_editor 同时跑，最后整合。',
    input_schema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: '执行计划（JSON格式或文字描述）' },
        files: { type: 'string', description: '需要修改的文件列表（逗号分隔）' },
        instructions: { type: 'string', description: '具体的修改指令' },
      },
      required: ['instructions'],
    },
    tags: [Tags.AGENT, Tags.WRITE],
    riskLevel: 'medium',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const plan = String(input.plan || '无特定计划');
      const files = String(input.files || '待确定');
      const instructions = String(input.instructions || '');
      return `你是一个精确的代码编辑器。根据计划执行代码修改。

计划：${plan}
需要修改的文件：${files}
修改指令：${instructions}

执行时请：
1. 先读取目标文件的当前内容
2. 精确执行计划中的修改
3. 保持代码风格一致
4. 必要时添加注释说明修改原因

只使用 write_file、edit_file 或 replace_files 工具修改文件。`;
    },
    defaultTimeoutMs: 1_800_000,
  },

  // === 思考器 (Deep Thinker) ===
  // Handles complex reasoning and multi-step analysis
  {
    name: 'deep_thinker',
    description: '专门处理复杂、需要深度推理的问题（算法分析、架构设计、权衡决策）。用于想把深度推理隔离出主循环的场景（T3 上下文隔离），避免长篇推理刷屏主会话。',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '复杂问题描述' },
        context: { type: 'string', description: '相关上下文信息' },
        approach: { type: 'string', description: '思考方式：分析|推理|创造|评估' },
      },
      required: ['question'],
    },
    tags: [Tags.AGENT],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const question = String(input.question || '');
      const context = String(input.context || '无');
      const approach = String(input.approach || '全面分析');
      return `你是一个深度思考专家。处理复杂问题和需要多步推理的场景。

问题：${question}
上下文：${context}
思考方式：${approach}

请进行深度分析：
1. 分解问题为多个子问题
2. 分析各子问题的关系和依赖
3. 探索多种解决路径
4. 评估每个路径的优劣
5. 给出推荐方案及详细理由

请以结构化的方式输出你的思考过程和结论。`;
    },
    defaultTimeoutMs: 1_800_000,
  },

  // === UI设计器 (UI Designer) ===
  // Handles interface design, layout planning, and interaction design
  {
    name: 'ui_designer',
    description: '负责界面设计、布局规划和交互设计。处理UI/UX相关的需求：当任务含设计视角（T1）、且是独立并可并行的界面/交互子块时委派（T2）。',
    input_schema: {
      type: 'object',
      properties: {
        requirement: { type: 'string', description: 'UI需求描述' },
        design_type: { type: 'string', description: '设计类型：interface|layout|interaction|both' },
        context: { type: 'string', description: '现有设计上下文或参考' },
      },
      required: ['requirement'],
    },
    tags: [Tags.AGENT],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const requirement = String(input.requirement || '');
      const designType = String(input.design_type || 'both');
      const context = String(input.context || '新设计');
      return `你是一个专业的UI设计师。

需求：${requirement}
设计类型：${designType}
现有上下文：${context}

请提供完整的设计方案：

**1. 界面设计**
- 视觉元素（颜色、字体、图标）
- 整体风格和调性

**2. 布局设计**
- 页面结构
- 层次和优先级
- 响应式策略

**3. 交互设计**
- 用户操作流程
- 状态和反馈机制
- 动画和过渡效果

使用清晰的格式输出，便于开发者实现。对于代码相关的内容，提供具体的代码示例。`;
    },
    // 5 minutes: a full design scheme (colors/typography/layout/interaction +
    // concrete examples) with a reasoning model often exceeds 2 minutes; the
    // old 120s wall-clock AbortSignal made ui_designer the most-failed subagent.
    defaultTimeoutMs: 1_800_000,
  },

  // === 执行器 (Bash Executor) ===
  // Executes terminal commands with safety checks
  {
    name: 'bash_executor',
    description: '执行终端命令，返回执行结果。用于运行测试、构建、检查等：把命令输出隔离出主会话（T3 上下文隔离），只回传结论。',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录（可选）' },
        description: { type: 'string', description: '命令用途说明' },
      },
      required: ['command'],
    },
    tags: [Tags.AGENT, Tags.SHELL],
    riskLevel: 'high',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const description = String(input.description || '');
      return `你是一个命令执行专家。安全地执行终端命令。

${description ? `命令用途：${description}` : ''}

请注意：
1. 解释将要执行的命令的作用
2. 使用 execute_command 工具执行
3. 分析结果是否成功
4. 如有错误，提供诊断信息和修复建议

避免执行破坏性命令（如 rm -rf 除非明确要求）。`;
    },
    defaultTimeoutMs: 300_000,
  },

  // === 研究者 (Researcher) ===
  // Researches topics and summarizes findings
  {
    name: 'researcher',
    description: '研究主题并总结发现，包括查阅网络资源和文档。用于技术调研、API研究等：调研前置（先出事实 baseline 再给生产环节），只读且可并行（T2/T3），把检索源与引用隔离出主会话。一个任务含 N 个独立子主题时，在同一批里发起 N 个 researcher 调用（每调用一个主题），它们会并发执行——不要让一个调用包办全部主题。',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '研究主题或问题' },
        sources: { type: 'string', description: '优先的信息来源类型：web|docs|both' },
        scope: { type: 'string', description: '研究范围或限制' },
      },
      required: ['topic'],
    },
    tags: [Tags.AGENT, Tags.SEARCH, Tags.READ],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => {
      const topic = String(input.topic || '');
      const sources = String(input.sources || 'both');
      const scope = String(input.scope || '');
      return `你是一个专业的研究员。

研究主题：${topic}
信息来源：${sources}
研究范围：${scope || '无限制'}

研究方法：
1. 使用 researcher_web、web_public_api 和 web_scrape 工具查找相关信息（researcher_web 一站式研究并带回引用来源与证据，web_public_api 适合天气/汇率/股票等结构化查询，web_scrape 适合已知 URL 的页面抓取）
2. 识别关键概念和术语
3. 查找权威来源和官方文档
4. 整理发现，用清晰简洁的方式总结
5. 包含相关的代码示例或API签名
6. 标注版本相关注意事项和最佳实践

保持研究全面但简洁，使用清晰的标题组织。最终输出结构化的研究报告。${THIRD_PARTY_SCOPE_NOTE_ZH}`;
    },
    defaultTimeoutMs: 1_800_000,
  },
];
