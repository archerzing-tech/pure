import type { EngineEvent, TokenUsage, VerificationSummary } from './types';

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
  reasoningChars: number;
  outputChars: number;
  verification?: VerificationObservation;
  outcome?: { isComplete: boolean; interrupted: boolean; turnCount?: number; finalOutput?: TextObservation };
}

export type PromptObservation = PromptAssemblyObservation | AgentRunObservation;

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
}

export interface PromptObservabilityOptions {
  maxRecords?: number;
  enabled?: boolean;
}

export interface PromptObservationStore {
  append(record: PromptObservation): void;
  list(): PromptObservation[];
  clear(): void;
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

export class PromptObservability {
  private readonly store: PromptObservationStore;
  private readonly enabled: boolean;
  private readonly activeRuns = new Map<string, AgentRunObservation>();

  constructor(options: PromptObservabilityOptions = {}, store?: PromptObservationStore) {
    this.enabled = options.enabled ?? true;
    this.store = store ?? new InMemoryPromptObservationStore(options.maxRecords ?? 500);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  recordAssembly(input: PromptAssemblyObservationInput): string {
    const traceId = input.traceId ?? nextId('prompt');
    if (!this.enabled) return traceId;
    this.store.append({
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
        break;
      case 'Completed':
        record.usage = event.payload.usage;
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
    this.store.append(record);
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
}

export const promptObservability = new PromptObservability();

export function promptVersion(systemPrompt: string): string {
  return `prompt_${hashObservationText(systemPrompt)}`;
}
