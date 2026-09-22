import type { EngineEvent, TokenUsage, ToolResult, VerificationSummary } from './types';
import type { AdaptiveStrategy } from './adaptiveControl';

export interface VerificationObservation {
  status: VerificationSummary['status'];
  evidence: Array<{
    id: string;
    checkName: string;
    status: VerificationSummary['evidence'][number]['status'];
    summary: TextObservation;
    command?: TextObservation;
    output?: TextObservation;
    durationMs?: number;
    timestamp: number;
  }>;
}
import type { PromptBudgetReport } from './PromptAssembler';

export interface TextObservation {
  chars: number;
  hash: string;
}

export interface PromptAssemblyObservation {
  type: 'prompt_assembly';
  traceId: string;
  timestamp: number;
  sessionId?: string;
  turnId?: string;
  surface?: string;
  provider?: string;
  model?: string;
  promptVersion: string;
  system: TextObservation;
  user?: TextObservation;
  budget: Pick<PromptBudgetReport, 'contextWindowTokens' | 'outputReserveTokens' | 'safetyMarginTokens' | 'availableInputTokens' | 'estimatedInputTokens' | 'estimatedToolTokens' | 'includedFragmentIds' | 'omittedFragmentIds' | 'overBudget'>;
}

export interface ToolObservation {
  toolName: string;
  success: boolean;
  durationMs: number;
  result?: TextObservation;
  error?: { kind: string; hash: string; chars: number };
}

/** E4.1 — the slice-able dimensions of the runtime-selected strategy,
 *  recorded ON the agent_run record so strategy → outcome correlation needs
 *  no join: the same record already carries toolCalls, verification, and
 *  outcome. Prose fields (signals / rationale / directive) are deliberately
 *  left out — they can't be sliced and would bloat the JSONL. */
export interface StrategyObservation {
  exploration: AdaptiveStrategy['exploration'];
  verification: AdaptiveStrategy['verification'];
  delegation: AdaptiveStrategy['delegation'];
  recovery: AdaptiveStrategy['recovery'];
  autonomy: AdaptiveStrategy['autonomy'];
  complexity: AdaptiveStrategy['complexity'];
  confidence: number;
  intentTags: string[];
  recommendedRoles: string[];
  parallelRoles: string[];
  priorArtHint: boolean;
}

/** Map the live strategy onto its slice-able observation shape. undefined when
 *  no strategy was selected (plain subagent/aux harnesses). */
export function observeStrategy(strategy: AdaptiveStrategy | undefined): StrategyObservation | undefined {
  if (!strategy) return undefined;
  return {
    exploration: strategy.exploration,
    verification: strategy.verification,
    delegation: strategy.delegation,
    recovery: strategy.recovery,
    autonomy: strategy.autonomy,
    complexity: strategy.complexity,
    confidence: Math.round(strategy.confidence * 100) / 100,
    intentTags: [...strategy.intentTags],
    recommendedRoles: [...strategy.recommendedRoles],
    parallelRoles: [...strategy.parallelRoles],
    priorArtHint: strategy.priorArtHint,
  };
}

/** 8.3 — provider context-cache outcome for a run's input, derived from the
 *  Completed usage the provider reported (DeepSeek prompt_cache_hit_tokens,
 *  Anthropic cache_read_input_tokens — both normalized into TokenUsage).
 *  Written next to the hash-based metadata so a trace answers "was this
 *  input cache-served, and how much of it?" without storing prompt text. */
export interface CacheObservation {
  hitTokens?: number;
  missTokens?: number;
  /** Percentage 0–100 (one decimal); null when the provider billed no
   *  split input at all. */
  hitRate: number | null;
}

export interface AgentRunObservation {
  type: 'agent_run';
  traceId: string;
  sessionId?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  provider?: string;
  model?: string;
  eventCounts: Record<string, number>;
  toolCalls: ToolObservation[];
  usage?: TokenUsage;
  cache?: CacheObservation;
  reasoningChars: number;
  outputChars: number;
  verification?: VerificationObservation;
  outcome?: { isComplete: boolean; interrupted: boolean; turnCount?: number; finalOutput?: TextObservation };
  /** E4.1 — the strategy this run ran under; absent on records from before
   *  this field existed (the aggregator skips those). */
  strategy?: StrategyObservation;
  /** Team observability T1 — per-delegation identity and outcome, parallel
   *  to `toolCalls` (whose anonymous entries keep their E4.2 semantics and
   *  aggregators untouched). Absent on pre-T1 records; the parser and the
   *  aggregators treat a missing array as "no data", never as zero. */
  delegations?: DelegationObservation[];
}

/** T1 — one role delegation observed with its identity (`ag-xxxxxxxx`),
 *  timing, and usage split. Fields that only exist at delegation end
 *  (duration/success/usage) are filled in when the ToolResult lands.
 *  Hashes only: no args, no output text — the archive keeps those. */
export interface DelegationObservation {
  agentId: string;
  role: string;
  startedAt: number;
  durationMs?: number;
  success?: boolean;
  usage?: TokenUsage;
  outputChars?: number;
  errorKind?: string;
}

/** T1 seam — decides whether a ToolResult for `toolName` is a subagent role
 *  delegation. Injected because the role roster lives in coding-agent and the
 *  shared layer must not import it (same split as the observation sink). */
export type DelegationRolePredicate = (toolName: string) => boolean;

export type PromptObservation = PromptAssemblyObservation | AgentRunObservation;

/**
 * E4.2 — parse a JSONL dump back into records. The GUI dashboard (Rust tail
 * read of app.jsonl) and the CLI file store both read the same file format, so
 * "what counts as a readable line" lives here instead of being re-implemented
 * on each side. Malformed or truncated lines are skipped: one broken line must
 * never hide the later observations.
 */
export function parsePromptObservations(jsonl: string): PromptObservation[] {
  const records: PromptObservation[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PromptObservation;
      if (parsed && (parsed.type === 'prompt_assembly' || parsed.type === 'agent_run')) records.push(parsed);
    } catch {
      // Ignore the bad line, keep reading.
    }
  }
  return records;
}

export interface PromptAssemblyObservationInput {
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  surface?: string;
  provider?: string;
  model?: string;
  systemPrompt: string;
  userPrompt?: string;
  promptVersion: string;
  budget: PromptAssemblyObservation['budget'];
}

export interface AgentRunObservationInput {
  traceId?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  startedAt?: number;
  strategy?: StrategyObservation;
}

export interface PromptObservabilityOptions {
  maxRecords?: number;
  enabled?: boolean;
  sink?: PromptObservationSink;
}

export interface PromptObservationStore {
  append(record: PromptObservation): void;
  list(): PromptObservation[];
  clear(): void;
}

/**
 * E0.1 — durable mirror for records that land in the in-process store. The
 * product historically wrote to a memory ring buffer with zero readers
 * ("只写不读"); a sink makes every record durable without changing the
 * read model. Failures are swallowed by the observability layer —
 * persistence must never break a run.
 */
export interface PromptObservationSink {
  append(record: PromptObservation): void;
}

export class InMemoryPromptObservationStore implements PromptObservationStore {
  private records: PromptObservation[] = [];
  constructor(private readonly maxRecords = 500) {}

  append(record: PromptObservation): void {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }

  list(): PromptObservation[] {
    return this.records.map((record) => structuredClone(record));
  }

  clear(): void {
    this.records.length = 0;
  }
}

function nextId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Stable non-cryptographic hash for correlation without storing prompt text. */
export function hashObservationText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function observeText(text: string | undefined): TextObservation | undefined {
  if (text === undefined) return undefined;
  return { chars: text.length, hash: hashObservationText(text) };
}

function errorKind(error: string): string {
  const value = error.toLowerCase();
  if (/timeout|timed out|abort/.test(value)) return 'timeout';
  if (/permission|denied|forbidden|unauthorized|401|403/.test(value)) return 'permission';
  if (/not found|enoent|missing/.test(value)) return 'not_found';
  if (/network|fetch|http|connection|dns/.test(value)) return 'network';
  if (/parse|json|syntax/.test(value)) return 'parse';
  return 'tool_error';
}

function observeError(error: string | undefined): ToolObservation['error'] {
  if (!error) return undefined;
  return { kind: errorKind(error), hash: hashObservationText(error), chars: error.length };
}

function observeVerification(summary: VerificationSummary | undefined): VerificationObservation | undefined {
  if (!summary) return undefined;
  return {
    status: summary.status,
    evidence: summary.evidence.map((evidence) => ({
      id: evidence.id,
      checkName: evidence.checkName,
      status: evidence.status,
      summary: observeText(evidence.summary)!,
      command: observeText(evidence.command),
      output: observeText(evidence.output),
      durationMs: evidence.durationMs,
      timestamp: evidence.timestamp,
    })),
  };
}

function observeCache(usage: TokenUsage | undefined): CacheObservation | undefined {
  const hit = usage?.cacheHitTokens;
  const miss = usage?.cacheMissTokens;
  // A provider with no cache concept reports neither field — no marker,
  // so a record without `cache` cleanly means "nothing to say".
  if (hit === undefined && miss === undefined) return undefined;
  const hitTokens = hit ?? 0;
  const missTokens = miss ?? 0;
  const total = hitTokens + missTokens;
  return {
    hitTokens: hitTokens || undefined,
    missTokens: missTokens || undefined,
    hitRate: total > 0 ? Math.round((hitTokens / total) * 1000) / 10 : null,
  };
}

export class PromptObservability {
  private readonly store: PromptObservationStore;
  private readonly enabled: boolean;
  private sink?: PromptObservationSink;
  private isDelegationRole?: DelegationRolePredicate;
  private readonly activeRuns = new Map<string, AgentRunObservation>();

  constructor(options: PromptObservabilityOptions = {}, store?: PromptObservationStore) {
    this.enabled = options.enabled ?? true;
    this.store = store ?? new InMemoryPromptObservationStore(options.maxRecords ?? 500);
    this.sink = options.sink;
  }

  /** T1 — attach the role predicate; unset (or set to undefined) keeps the
   *  pre-T1 behavior byte-identical: every ToolResult lands only in
   *  `toolCalls`, no delegations are ever written. */
  setDelegationRolePredicate(predicate: DelegationRolePredicate | undefined): void {
    this.isDelegationRole = predicate;
  }

  /** Attach (or replace) the durable mirror; safe to call before any recording. */
  setSink(sink: PromptObservationSink | undefined): void {
    this.sink = sink;
  }

  private persist(record: PromptObservation): void {
    this.store.append(record);
    if (!this.sink) return;
    try {
      this.sink.append(record);
    } catch {
      // Durability is best-effort; recording must not throw into the run loop.
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  recordAssembly(input: PromptAssemblyObservationInput): string {
    const traceId = input.traceId ?? nextId('prompt');
    if (!this.enabled) return traceId;
    this.persist({
      type: 'prompt_assembly',
      traceId,
      timestamp: Date.now(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      surface: input.surface,
      provider: input.provider,
      model: input.model,
      promptVersion: input.promptVersion,
      system: observeText(input.systemPrompt)!,
      user: observeText(input.userPrompt),
      budget: input.budget,
    });
    return traceId;
  }

  startRun(input: AgentRunObservationInput = {}): string {
    const traceId = input.traceId ?? nextId('run');
    if (!this.enabled) return traceId;
    const record: AgentRunObservation = {
      type: 'agent_run',
      traceId,
      sessionId: input.sessionId,
      startedAt: input.startedAt ?? Date.now(),
      provider: input.provider,
      model: input.model,
      strategy: input.strategy,
      eventCounts: {},
      toolCalls: [],
      reasoningChars: 0,
      outputChars: 0,
    };
    this.activeRuns.set(traceId, record);
    return traceId;
  }

  /** Find the most recent assembly for this turn without storing raw prompt text. */
  findAssemblyTrace(input: { sessionId?: string; systemPrompt: string; userPrompt?: string }): string | undefined {
    const systemHash = hashObservationText(input.systemPrompt);
    const userHash = input.userPrompt === undefined ? undefined : hashObservationText(input.userPrompt);
    const records = this.store.list();
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (record.type !== 'prompt_assembly') continue;
      if (record.sessionId !== input.sessionId) continue;
      if (record.system.hash !== systemHash) continue;
      if (record.user?.hash !== userHash) continue;
      return record.traceId;
    }
    return undefined;
  }

  recordEvent(traceId: string, event: EngineEvent): void {
    if (!this.enabled) return;
    const record = this.activeRuns.get(traceId);
    if (!record) return;
    record.eventCounts[event.type] = (record.eventCounts[event.type] ?? 0) + 1;
    switch (event.type) {
      case 'ReasoningDelta':
        record.reasoningChars += event.payload.content.length;
        break;
      case 'TokenDelta':
        if (!event.payload.isToolCall) record.outputChars += event.payload.content.length;
        break;
      case 'ToolResult':
        record.toolCalls.push({
          toolName: event.payload.toolName,
          success: event.payload.result.success,
          durationMs: event.payload.duration,
          result: observeText(typeof event.payload.result.result === 'string' ? event.payload.result.result : undefined),
          error: observeError(event.payload.result.error),
        });
        // T1 — subagent delegations additionally land in `delegations[]` with
        // their identity. `result.result` is the whole SubagentResult on the
        // success path (the orchestrator returns it verbatim); parse leniently
        // — a missing/foreign shape must not break the record.
        if (this.isDelegationRole?.(event.payload.toolName)) {
          record.delegations ??= [];
          record.delegations.push(this.observeDelegation(event.payload));
        }
        break;
      case 'Completed':
        record.usage = event.payload.usage;
        record.cache = observeCache(event.payload.usage);
        record.verification = observeVerification(event.payload.verification);
        record.outcome = {
          isComplete: event.payload.isComplete,
          interrupted: event.payload.interrupted,
          turnCount: event.payload.turnCount,
          finalOutput: observeText(event.payload.finalOutput),
        };
        break;
      default:
        break;
    }
  }

  finishRun(traceId: string, outcome?: AgentRunObservation['outcome']): void {
    if (!this.enabled) return;
    const record = this.activeRuns.get(traceId);
    if (!record) return;
    const endedAt = Date.now();
    record.endedAt = endedAt;
    record.durationMs = endedAt - record.startedAt;
    if (outcome) record.outcome = outcome;
    this.persist(record);
    this.activeRuns.delete(traceId);
  }

  records(): PromptObservation[] {
    return this.store.list();
  }

  clear(): void {
    this.activeRuns.clear();
    this.store.clear();
  }

  toJsonl(): string {
    return this.records().map((record) => JSON.stringify(record)).join('\n');
  }

  /** T1 — extract delegation identity from a ToolResult payload. The success
   *  path carries the whole SubagentResult in `result.result` (agentId,
   *  tokensUsed, output, duration); the failure path carries `{agentId}`.
   *  startedAt is derived (now − duration): the delegation has just ended by
   *  construction, and no new event channel is opened for its start. */
  private observeDelegation(payload: { toolName: string; result: ToolResult; duration: number }): DelegationObservation {
    const inner = (typeof payload.result.result === 'object' && payload.result.result !== null
      ? payload.result.result as Partial<SubagentResultLike>
      : {}) as Partial<SubagentResultLike>;
    const error = payload.result.error;
    return {
      agentId: typeof inner.agentId === 'string' && inner.agentId ? inner.agentId : `ag-unknown-${hashObservationText(`${payload.toolName}:${payload.result.id}`)}`,
      role: payload.toolName,
      startedAt: Date.now() - payload.duration,
      durationMs: payload.duration,
      success: payload.result.success,
      usage: inner.usage,
      outputChars: typeof inner.output === 'string' ? inner.output.length : undefined,
      errorKind: error ? errorKind(error) : undefined,
    };
  }
}

/** T1 — the slice of SubagentResult the observer is allowed to read. Defined
 *  structurally so the shared layer never imports coding-agent. */
interface SubagentResultLike {
  agentId?: string;
  output?: string;
  usage?: TokenUsage;
}

export const promptObservability = new PromptObservability();

export function promptVersion(systemPrompt: string): string {
  return `prompt_${hashObservationText(systemPrompt)}`;
}
