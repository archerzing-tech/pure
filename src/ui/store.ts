// src/ui/store.ts
// v0.6 — Tauri-first session persistence with localStorage fallback.
// Stores sessions to ~/.pure/sessions/ (FSStore-compatible) when running in Tauri,
// falls back to browser localStorage for plain Vite dev.
//
// Per-session usage stats (token totals, cost, tool activity) are FILE-BACKED
// in Tauri: ~/.pure/sessions/<id>/stats.json via the save_session_stats /
// load_session_stats commands, so they live and die with the session. An
// in-memory cache keeps reads synchronous; localStorage (`pure_stats:<id>`)
// is only the fallback for plain Vite dev.

import type { Message, MessageAttachment, MessageImage, TokenUsage, GeneratedImage } from '../shared/types';
import type { IntentAssessment, Plan } from '../coding-agent/types';
import type { PlanProgressSnapshot } from './planProgress';

export const SESSION_SNAPSHOT_VERSION = 3;

export interface TranscriptEntry {
  id: string;
  modelMessageIndex: number;
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  /** User-uploaded images shown in the restored conversation bubble. */
  images?: MessageImage[];
  attachments?: MessageAttachment[];
  displayOverride?: boolean;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: StoredToolCallInfo[];
  analysis?: string;
  thinking?: string;
  thinkingPhases?: Array<{ text: string; assistantIndex: number }>;
  artifacts?: Array<{ path: string }>;
  isPlanPause?: boolean;
  assessment?: IntentAssessment;
  toolExec?: ToolExecMeta;
  planCard?: PlanCardSnapshot;
}

export interface SessionAgentActivity {
  callId: string;
  agentName: string;
  agentRole?: string;
  state?: string;
  /** Explicit lifecycle used to answer which agents are active right now. */
  lifecycle?: 'queued' | 'started' | 'tool_running' | 'observing' | 'verifying' | 'done' | 'failed' | 'timed_out' | 'cancelled';
  /** Monotonic progress sequence for rejecting late concurrent updates. */
  sequence?: number;
  /** Epoch ms when this activity snapshot was emitted. */
  lastUpdatedAt?: number;
  toolName?: string;
  toolState?: 'running' | 'completed';
  success?: boolean;
  error?: string;
  output?: string;
  status?: 'running' | 'done' | 'failed' | 'timed_out' | 'cancelled';
  durationMs?: number;
  tokensUsed?: number;
  inputSnippet?: string;
  startedAt?: number;
  timeoutMs?: number;
  parentCallId?: string;
}

export interface SessionUiState {
  /** Canonical session-level plan cursor used by the transcript plan card. */
  planProgress?: PlanProgressSnapshot | null;
  /** Legacy cursor retained for migration and older exports. */
  planState?: PlanState | null;
  /** Latest multi-agent activity for the current task, retained on restore. */
  agentActivities?: SessionAgentActivity[];
}

export interface PlanState {
  plan: Plan;
  planNumber: number;
  todoNumber: number;
  started: boolean;
  /** True when the plan had finished: the cross-turn cursor is gone but the
   * completed chat plan card must still come back on session restore. */
  complete?: boolean;
}

/**
 * A snapshot of the in-chat plan-progress card, persisted so session restore
 * can rebuild the card in place (the card itself is a live DOM element and
 * never entered the stored transcript before). `complete` records whether the
 * plan had finished so a restored card re-renders its final all-done state.
 */
export interface PlanCardSnapshot {
  plan: Plan;
  currentPlan: number;
  currentTodo: number;
  complete: boolean;
}

export interface TranscriptDraft {
  message: Message;
  modelMessageIndex: number;
  content?: string | null;
  images?: MessageImage[];
  attachments?: MessageAttachment[];
  displayOverride?: boolean;
  analysis?: string;
  thinking?: string;
  thinkingPhases?: Array<{ text: string; assistantIndex: number }>;
  artifacts?: Array<{ path: string }>;
  isPlanPause?: boolean;
  assessment?: IntentAssessment;
  toolExec?: ToolExecMeta;
  planState?: PlanState | null;
  planCard?: PlanCardSnapshot;
}

export interface SessionEvent {
  id: string;
  type: 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result' | 'analysis' | 'assessment' | 'plan' | 'artifact' | 'status';
  content?: string;
  images?: MessageImage[];
  attachments?: MessageAttachment[];
  toolCallId?: string;
  toolName?: string;
  toolCalls?: StoredToolCallInfo[];
  toolExec?: ToolExecMeta;
  artifacts?: Array<{ path: string }>;
  assessment?: IntentAssessment;
  planCard?: PlanCardSnapshot;
  isPlanPause?: boolean;
}

export interface SessionSnapshotV2Legacy {
  version: 2;
  modelContext: {
    messages: Message[];
  };
  transcript: TranscriptEntry[];
  uiState: SessionUiState;
}

export interface SessionSnapshotV3 {
  version: 3;
  /** Monotonically increasing client save revision, optional for legacy sessions. */
  revision?: number;
  modelContext: {
    messages: Message[];
  };
  events: SessionEvent[];
  uiState: SessionUiState;
  transcript: TranscriptEntry[];
}

export type SessionSnapshot = SessionSnapshotV3;

/** Compatibility name used by existing callers; snapshots are now v3 event snapshots. */
export type SessionSnapshotV2 = SessionSnapshotV3;

export interface LoadedSession {
  snapshot: SessionSnapshot;
  workspace: string;
}

export interface ToolExecMeta {
  toolName: string;
  success: boolean;
  duration: number;
  /**
   * The JSON parameters the LLM passed to the tool (e.g. `{ query: "..." }`
   * for `web_search`). Optional because older saved sessions don't carry it;
   * the UI demotes to the compact one-line summary when it's undefined.
   */
  args?: Record<string, unknown>;
  /**
   * Tag for special result renderers. `'search'` triggers the URL/title/snippet
   * parser; `'fetch'` shows a snippet of the de-noised page text; `'image'`
   * renders the generated images as <img> cards; `undefined` (or anything
   * else) renders the raw `resultText` in a `<pre>` body.
   */
  resultKind?: 'search' | 'fetch' | 'image';
  /**
   * Parsed result for `resultKind: 'search'`. Each item is a search hit the
   * web_search backends returned (cn.bing / Sogou / 360 / Baidu / Brave /
   * Bing-via-Jina / SearXNG; see src-tauri/src/lib.rs web_search).
   */
  resultItems?: Array<{ title: string; snippet: string; url: string }>;
  /**
   * Verbatim result string. Used by `resultKind === 'fetch'` (truncated) and by
   * the raw fallback when `resultItems` is missing.
   */
  resultText?: string;
  /**
   * Generated images for `resultKind: 'image'` (the generate_image tool).
   * Data URLs are persisted with the session so session replay renders the
   * same <img> cards; desktop sessions are file-backed (~/.pure/sessions/),
   * so the payload size is a non-issue there.
   */
  resultImages?: GeneratedImage[];
}

export interface StoredMessage {
  role: string;
  content: string | null;
  images?: MessageImage[];
  attachments?: MessageAttachment[];
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  /** Reasoning transcript shown in the GUI before this assistant message. */
  thinking?: string;
  /** Text actually rendered in the assistant bubble. Kept separately from
   * the model transcript because some adapters omit streamed final content. */
  displayContent?: string;
  /** Preflight task analysis shown before the first assistant response. */
  analysis?: string;
  /** Files shown as generated-artifact cards after this assistant response. */
  artifacts?: Array<{ path: string }>;
  /** Assistant message that is a plan pause point ("已暂停，等待你回复") —
   * re-applies the waiting bubble style on session restore. */
  isPlanPause?: boolean;
  /** The intent assessment snapshot for a plan-pause message, so the
   * assessment card can be rebuilt in its "waiting for reply" state on
   * session restore. */
  assessment?: IntentAssessment;
  /** Reasoning phases mapped to their assistant iteration for ordered replay. */
  thinkingPhases?: Array<{ text: string; assistantIndex: number }>;
  /** Legacy live/replay segments retained for older in-progress sessions. */
  thinkingSegments?: string[];
  toolExec?: ToolExecMeta;
  /** Cross-turn complex-task cursor, stored on the latest message. */
  planState?: PlanState;
}

export function getStoredThinkingSegments(message: Partial<StoredMessage>): string[] {
  if (message.thinkingPhases?.length) return message.thinkingPhases.map(phase => phase.text).filter(Boolean);
  if (message.thinkingSegments?.length) return message.thinkingSegments.filter(Boolean);
  return message.thinking ? [message.thinking] : [];
}

export function getStoredDisplayContent(message: Partial<StoredMessage>): string {
  return message.displayContent ?? message.content ?? '';
}

export function getTranscriptThinkingSegments(message: Partial<TranscriptEntry>): string[] {
  if (message.thinkingPhases?.length) return message.thinkingPhases.map(phase => phase.text).filter(Boolean);
  return message.thinking ? [message.thinking] : [];
}

export function getTranscriptContent(message: Partial<TranscriptEntry>): string {
  return message.content ?? '';
}

export function buildTranscriptToolExec(
  message: Partial<TranscriptEntry>,
): ToolExecMeta {
  const resultText = typeof message.content === 'string' ? message.content : '';
  return {
    toolName: message.toolName || message.toolExec?.toolName || 'tool',
    success: message.toolExec?.success ?? !/^Error:\s/i.test(resultText),
    duration: message.toolExec?.duration ?? 0,
    args: message.toolExec?.args ?? message.toolCalls?.[0]?.args,
    resultText: message.toolExec?.resultText ?? (resultText || undefined),
    resultKind: message.toolExec?.resultKind,
    resultItems: message.toolExec?.resultItems,
    resultImages: message.toolExec?.resultImages,
  };
}

function modelMessageFromStored(message: StoredMessage): Message {
  return {
    role: message.role as Message['role'],
    content: typeof message.content === 'string' ? message.content : '',
    images: message.images,
    toolCalls: message.tool_calls as Message['toolCalls'],
    toolCallId: message.tool_call_id,
    toolName: message.name,
  };
}

function stableMessageId(message: Message, occurrence: number): string {
  const source = `${JSON.stringify(message)}:${occurrence}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `message-${(hash >>> 0).toString(16)}`;
}

function messageToolCallInfos(message: Message): StoredToolCallInfo[] {
  return (message.toolCalls ?? []).flatMap(call => {
    try {
      const args = JSON.parse(call.function.arguments);
      return [{ id: call.id, toolName: call.function.name, args: recordArgs(args) }];
    } catch {
      return [{ id: call.id, toolName: call.function.name, args: {} }];
    }
  });
}

function legacyToTranscriptDrafts(messages: StoredMessage[]): TranscriptDraft[] {
  return messages.flatMap((message, index): TranscriptDraft[] => {
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') return [];
    const modelMessage = modelMessageFromStored(message);
    return [{
      message: modelMessage,
      modelMessageIndex: index,
      content: message.role === 'assistant' ? getStoredDisplayContent(message) : message.content,
      displayOverride: message.role === 'assistant' && !!message.displayContent,
      images: message.images,
      attachments: message.attachments,
      analysis: message.analysis,
      thinking: message.thinking,
      thinkingPhases: message.thinkingPhases,
      artifacts: message.artifacts,
      isPlanPause: message.isPlanPause,
      assessment: message.assessment,
      toolExec: message.toolExec,
      planState: message.planState,
    }];
  });
}

export function createSessionSnapshot(
  modelMessages: Message[],
  source: TranscriptDraft[] | StoredMessage[],
  uiState: Partial<SessionUiState> = {},
): SessionSnapshotV3 {
  const drafts = source.length > 0 && 'message' in source[0]
    ? source as TranscriptDraft[]
    : legacyToTranscriptDrafts(source as StoredMessage[]);
  const occurrences = new Map<string, number>();
  const transcript = drafts.map((draft): TranscriptEntry => {
    const message = draft.message;
    const occurrenceKey = JSON.stringify(message);
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const calls = messageToolCallInfos(message);
    return {
      id: stableMessageId(message, occurrence),
      modelMessageIndex: draft.modelMessageIndex,
      role: message.role as TranscriptEntry['role'],
      content: draft.content ?? message.content,
      images: draft.images ?? message.images,
      attachments: draft.attachments ?? message.attachments,
      displayOverride: draft.displayOverride,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      toolCalls: calls.length > 0 ? calls : undefined,
      analysis: draft.analysis,
      thinking: draft.thinking,
      thinkingPhases: draft.thinkingPhases,
      artifacts: draft.artifacts,
      isPlanPause: draft.isPlanPause,
      assessment: draft.assessment,
      toolExec: draft.toolExec,
      planCard: draft.planCard,
    };
  });
  const latestPlanState = [...drafts].reverse().find(draft => draft.planState !== undefined)?.planState;
  const legacy = {
    version: 2 as const,
    modelContext: { messages: modelMessages },
    transcript,
    uiState: { planState: latestPlanState ?? null, ...uiState },
  };
  return { ...snapshotV2ToV3(legacy), transcript, revision: 0 };
}

export function createSessionSnapshotFromLegacy(messages: StoredMessage[]): SessionSnapshotV3 {
  return createSessionSnapshot(messages.map(modelMessageFromStored), messages);
}

export function mergeSessionSnapshotMetadata(
  previous: SessionSnapshotV2 | null,
  next: SessionSnapshotV2,
): SessionSnapshotV2 {
  if (!previous) return next;

  /* Legacy v2 metadata merge retained below for migration documentation. */
  const previousById = new Map<string, TranscriptEntry>();
  const previousByIndex = new Map<number, TranscriptEntry>();
  for (const entry of previous.transcript) {
    if (!previousByIndex.has(entry.modelMessageIndex)) previousByIndex.set(entry.modelMessageIndex, entry);
  }
  const transcript = (next.transcript ?? []).map(entry => {
    const priorById = previousById.get(entry.id);
    const prior = priorById && priorById.role === entry.role
      ? priorById
      : previousByIndex.get(entry.modelMessageIndex);
    if (!prior || prior.role !== entry.role) return entry;
    return {
      ...entry,
      content: entry.displayOverride ? entry.content : prior.content || entry.content,
      images: entry.images ?? prior.images,
      attachments: entry.attachments ?? prior.attachments,
      displayOverride: entry.displayOverride || prior.displayOverride,
      analysis: entry.analysis ?? prior.analysis,
      thinking: entry.thinking ?? prior.thinking,
      thinkingPhases: entry.thinkingPhases ?? prior.thinkingPhases,
      artifacts: entry.artifacts ?? prior.artifacts,
      isPlanPause: entry.isPlanPause ?? prior.isPlanPause,
      assessment: entry.assessment ?? prior.assessment,
      toolExec: entry.toolExec ?? prior.toolExec,
      toolCalls: entry.toolCalls ?? prior.toolCalls,
      planCard: entry.planCard ?? prior.planCard,
    };
  });
  return { ...next, transcript, uiState: next.uiState };
}

function eventId(index: number, type: SessionEvent['type']): string {
  return `event-${index}-${type}`;
}

function snapshotV2ToV3(snapshot: SessionSnapshotV2Legacy): SessionSnapshotV3 {
  const events: SessionEvent[] = [];
  for (const entry of snapshot.transcript) {
    if (entry.role === 'user') {
      events.push({ id: entry.id, type: 'user', content: entry.content ?? '', images: entry.images, attachments: entry.attachments });
      continue;
    }
    if (entry.analysis) events.push({ id: `${entry.id}-analysis`, type: 'analysis', content: entry.analysis });
    if (entry.planCard) events.push({ id: `${entry.id}-plan`, type: 'plan', planCard: entry.planCard });
    for (const phase of entry.thinkingPhases ?? (entry.thinking ? [{ text: entry.thinking, assistantIndex: 0 }] : [])) {
      events.push({ id: `${entry.id}-thinking-${events.length}`, type: 'thinking', content: phase.text });
    }
    if (entry.role === 'assistant') {
      if (entry.assessment) events.push({ id: `${entry.id}-assessment`, type: 'assessment', assessment: entry.assessment });
      if (entry.content) events.push({ id: `${entry.id}-assistant`, type: 'assistant', content: entry.content, isPlanPause: entry.isPlanPause });
      for (const call of entry.toolCalls ?? []) events.push({ id: `${entry.id}-call-${call.id}`, type: 'tool_call', toolCallId: call.id, toolName: call.toolName, toolCalls: [call] });
      if (entry.artifacts?.length) events.push({ id: `${entry.id}-artifacts`, type: 'artifact', artifacts: entry.artifacts });
    } else if (entry.role === 'tool') {
      events.push({ id: `${entry.id}-result`, type: 'tool_result', content: entry.content ?? '', toolCallId: entry.toolCallId, toolName: entry.toolName, toolExec: entry.toolExec });
    }
  }
  return { version: 3, modelContext: snapshot.modelContext, events, uiState: snapshot.uiState, transcript: snapshot.transcript };
}

function normalizeSessionSnapshot(raw: unknown): SessionSnapshot {
  if (raw && typeof raw === 'object') {
    const candidate = raw as { version?: unknown; modelContext?: { messages?: unknown }; events?: unknown; transcript?: unknown; messages?: unknown; uiState?: SessionUiState };
    if (candidate.version === 3 && candidate.modelContext && Array.isArray(candidate.events)) {
      return { version: 3, revision: typeof (candidate as { revision?: unknown }).revision === 'number' ? (candidate as { revision: number }).revision : 0, modelContext: { messages: (candidate.modelContext.messages ?? []) as Message[] }, events: candidate.events as SessionEvent[], uiState: candidate.uiState ?? {}, transcript: Array.isArray(candidate.transcript) ? candidate.transcript as TranscriptEntry[] : [] };
    }
    if (candidate.version === 2 && candidate.modelContext && Array.isArray(candidate.transcript)) {
      return snapshotV2ToV3(candidate as SessionSnapshotV2Legacy);
    }
    if (Array.isArray(candidate.messages)) return createSessionSnapshotFromLegacy(candidate.messages as StoredMessage[]);
  }
  return { version: 3, modelContext: { messages: [] }, events: [], transcript: [], uiState: {} };
}

/**
 * Preserve stored-only transcript metadata across re-persists. persistSession
 * rebuilds the entire stored transcript from the in-memory Message[] on every
 * turn, and in-memory messages never carry these fields (analysis, thinking
 * phases, the rendered display snapshot) — so without this merge a follow-up
 * turn would silently wipe the preflight analysis and reasoning trace of every
 * earlier turn. Messages are matched by position (the transcript is a
 * monotonic sequence, trimmed identically on both sides by limitStoredMessages)
 * and only when the role agrees; the current turn's values always win.
 */
export function mergeStoredMetadata(prev: StoredMessage[], next: StoredMessage[]): StoredMessage[] {
  const prevByIndex = new Map<number, StoredMessage>();
  prev.forEach((message, index) => prevByIndex.set(index, message));
  return next.map((message, index) => {
    const prior = prevByIndex.get(index);
    if (!prior || prior.role !== message.role) return message;
    return {
      ...message,
      analysis: message.analysis ?? prior.analysis,
      thinkingPhases: message.thinkingPhases ?? prior.thinkingPhases,
      thinking: message.thinking ?? prior.thinking,
      thinkingSegments: message.thinkingSegments ?? prior.thinkingSegments,
      displayContent: message.displayContent ?? prior.displayContent,
    };
  });
}

export interface StoredToolCallInfo {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}

function recordArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function getStoredToolCallInfos(message: Partial<StoredMessage>): StoredToolCallInfo[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.flatMap((raw): StoredToolCallInfo[] => {
    if (!raw || typeof raw !== 'object') return [];
    const call = raw as { id?: unknown; name?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const fn = call.function;
    const id = typeof call.id === 'string' ? call.id : '';
    const toolName = typeof fn?.name === 'string'
      ? fn.name
      : typeof call.name === 'string' ? call.name : '';
    if (!toolName) return [];
    let args: Record<string, unknown> = {};
    const rawArgs = fn?.arguments;
    if (typeof rawArgs === 'string') {
      try { args = recordArgs(JSON.parse(rawArgs)); } catch { args = {}; }
    } else {
      args = recordArgs(rawArgs);
    }
    return [{ id, toolName, args }];
  });
}

export function buildStoredToolExec(
  message: Partial<StoredMessage>,
  call?: StoredToolCallInfo,
): ToolExecMeta {
  const resultText = typeof message.content === 'string' ? message.content : '';
  const toolName = message.name || call?.toolName || 'tool';
  return {
    toolName,
    success: !/^Error:\s/i.test(resultText),
    duration: 0,
    args: call?.args,
    resultText: resultText || undefined,
  };
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Per-session workspace ('' = no workspace; sessions are fully independent). */
  workspace?: string;
}

/**
 * Aggregated stats for ONE conversation (session id), shown in the right
 * panel's 统计 tab. Token/cost data comes from the provider's billing usage
 * (see src/shared/usage.ts); tool activity is recorded from tool executions.
 */
export const MAX_PERSISTED_MESSAGES = 400;

/** Keep complete user turns so assistant tool calls never detach from their results. */
export function limitConversationMessages<T extends { role: string }>(messages: T[], max = MAX_PERSISTED_MESSAGES): T[] {
  if (messages.length <= max) return messages;
  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const body = messages.slice(system.length);
  const turns: T[][] = [];
  let current: T[] = [];
  for (const message of body) {
    if (message.role === 'user' && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);

  const budget = Math.max(1, max - system.length);
  const selected: T[][] = [];
  let count = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (count + turn.length > budget) {
      if (selected.length === 0) {
        // A single pathological turn may exceed the bound. Keep only its user
        // message rather than splitting an assistant/tool round into the next
        // context window. The persisted plan cursor is also mirrored onto the
        // latest user message by chat.ts, so it remains recoverable here.
        selected.unshift(turn.slice(0, 1));
      }
      break;
    }
    selected.unshift(turn);
    count += turn.length;
  }
  return system.concat(selected.flat()).slice(0, max);
}

export function limitStoredMessages(messages: StoredMessage[], max = MAX_PERSISTED_MESSAGES): StoredMessage[] {
  const bounded = limitConversationMessages(messages, max);
  const latestPlanState = [...messages].reverse().find((message) => message.planState)?.planState;
  if (!latestPlanState || bounded.some((message) => message.planState === latestPlanState)) return bounded;
  if (bounded.length === 0) return bounded;
  const last = bounded.length - 1;
  bounded[last] = { ...bounded[last], planState: latestPlanState };
  return bounded;
}

export interface SessionStats {
  /** Provider id the session ran on (cost is priced per provider family). */
  provider?: string;
  /** Aggregated billing usage across every turn in this session. */
  usage?: TokenUsage;
  /** Number of internal LLM interaction rounds in the latest agent run. */
  turns?: number;
  /** web_search history (query + timestamp). */
  searches: Array<{ query: string; ts: number }>;
  /** One latest entry per normalized file path. */
  fileWrites: Array<{ path: string; ts: number; success: boolean }>;
  /** read_file history. */
  fileReads: Array<{ path: string; ts: number }>;
  /** execute_command history. */
  commands: Array<{ command: string; ts: number; success: boolean }>;
}

/** Normalize the spelling used as the identity key for a written file. */
export function normalizeFileWritePath(path: string, workspace = ''): string {
  const raw = path.trim().replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  if (!raw) return '';
  const drive = raw.match(/^[A-Za-z]:\//)?.[0] ?? '';
  const absolute = raw.startsWith('/') || !!drive;
  const body = drive ? raw.slice(drive.length) : raw.replace(/^\//, '');
  const parts: string[] = [];
  for (const part of body.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') {
      parts.pop();
    } else if (part !== '..' || !absolute) {
      parts.push(part);
    }
  }
  const normalized = parts.join('/');
  const result = drive ? `${drive}${normalized}` : absolute ? `/${normalized}` : normalized;
  const workspaceKey = workspace ? normalizeFileWritePath(workspace) : '';
  if (workspaceKey && result !== workspaceKey && result.startsWith(`${workspaceKey}/`)) {
    return result.slice(workspaceKey.length + 1);
  }
  return result;
}

/** Collapse legacy/repeated write entries to the latest state for each file. */
export function dedupeFileWrites(
  entries: Array<{ path: string; ts: number; success: boolean }>,
  workspace = '',
): Array<{ path: string; ts: number; success: boolean }> {
  const unique = new Map<string, { path: string; ts: number; success: boolean }>();
  for (const entry of entries) {
    const key = normalizeFileWritePath(entry.path, workspace);
    if (!key) continue;
    const current = unique.get(key);
    if (!current || entry.ts >= current.ts) {
      unique.set(key, { path: key, ts: entry.ts, success: entry.success });
    }
  }
  return [...unique.values()];
}

/** Group file-write activity by normalized path and expose each file's latest status. */
export function groupFileWrites(
  entries: Array<{ path: string; ts: number; success: boolean }>,
  workspace = '',
): Array<{ path: string; ts: number; success: boolean }> {
  const latest = new Map<string, { path: string; ts: number; success: boolean }>();
  for (const entry of entries) {
    const key = normalizeFileWritePath(entry.path, workspace);
    if (!key) continue;
    const current = latest.get(key);
    if (!current || entry.ts >= current.ts) {
      latest.set(key, { path: key, ts: entry.ts, success: entry.success });
    }
  }
  return [...latest.values()].sort((a, b) => b.ts - a.ts);
}

function normalizeStats(stats: SessionStats): SessionStats {
  const turns = Number.isFinite(stats.turns) ? Math.max(0, Math.floor(stats.turns as number)) : 0;
  return { ...stats, turns, fileWrites: dedupeFileWrites(stats.fileWrites ?? []) };
}

/** Update one file's activity without adding a duplicate sidebar row. */
export function upsertFileWrite(
  entries: Array<{ path: string; ts: number; success: boolean }>,
  entry: { path: string; ts: number; success: boolean },
  workspace = '',
): void {
  const key = normalizeFileWritePath(entry.path, workspace);
  if (!key) return;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (normalizeFileWritePath(entries[i].path, workspace) === key) entries.splice(i, 1);
  }
  entries.push({ path: key, ts: entry.ts, success: entry.success });
}

function normalizeLoadedStats(data: Partial<SessionStats>): SessionStats {
  return normalizeStats({
    provider: data.provider,
    usage: data.usage,
    turns: data.turns,
    searches: data.searches ?? [],
    fileWrites: data.fileWrites ?? [],
    fileReads: data.fileReads ?? [],
    commands: data.commands ?? [],
  });
}

function fileWritesNeedMigration(raw: unknown, normalized: SessionStats['fileWrites']): boolean {
  if (!Array.isArray(raw) || raw.length !== normalized.length) return Array.isArray(raw) || normalized.length > 0;
  return raw.some((entry, index) => {
    const item = entry as Partial<SessionStats['fileWrites'][number]> | null;
    const current = normalized[index];
    return !item || item.path !== current.path || item.ts !== current.ts || item.success !== current.success;
  });
}

// Runtime detection: previously this did `!!(await import('@tauri-apps/api/core')).invoke`,
// which is ALWAYS true — @tauri-apps/api/core exports `invoke` even outside the
// Tauri runtime (plain Vite dev), so deleteSession/deleteAllSessions/saveSessionWorkspace
// would try to call window.__TAURI_INTERNALS__ (undefined) and throw. isTauriRuntime()
// checks for the actual __TAURI_INTERNALS__ global instead.
import { isTauriRuntime, tauriInvoke } from '../shared/tauri';
import { t } from '../shared/i18n';
import { showToast } from '../shared/toast';
const tauriAvailable = isTauriRuntime();
const TAURI_IO_TIMEOUT_MS = 10_000;

function withTauriTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${TAURI_IO_TIMEOUT_MS}ms`));
    }, TAURI_IO_TIMEOUT_MS);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function resolveWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    promise.then(finish, finish);
  });
}

// ── Tauri backend (filesystem via Rust commands) ──

// Raw shapes returned by the Rust commands. These mirror the serde structs in
// src-tauri and are validated/normalized by the normalize* helpers below;
// typing them here catches schema drift at compile time instead of leaking
// `any` through every load path. `snapshot` is `unknown` because the raw
// session payload predates SESSION_SNAPSHOT_VERSION and normalizeSessionSnapshot
// accepts both the bare snapshot and the legacy whole-object form.
interface RawLoadLastPayload {
  sessionId?: string;
  snapshot?: unknown;
  workspace?: string;
}
interface RawLoadSessionPayload {
  snapshot?: unknown;
  workspace?: string;
}
interface RawSessionMeta {
  id?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount?: number;
  workspace?: string;
}

async function tauriSave(sessionId: string, snapshot: SessionSnapshotV2, workspace: string): Promise<void> {
  await withTauriTimeout(tauriInvoke('save_session', { sessionId, snapshot, workspace }), 'save_session');
}

async function tauriSaveWorkspace(sessionId: string, workspace: string): Promise<void> {
  await withTauriTimeout(tauriInvoke('save_session_workspace', { sessionId, workspace }), 'save_session_workspace');
}

async function tauriLoadLast(): Promise<{ sessionId: string; snapshot: SessionSnapshotV2; workspace: string } | null> {
  const data = await withTauriTimeout<RawLoadLastPayload | null>(tauriInvoke<RawLoadLastPayload | null>('load_last_session'), 'load_last_session');
  if (!data) return null;
  return { sessionId: data.sessionId ?? '', snapshot: normalizeSessionSnapshot(data.snapshot ?? data), workspace: data.workspace ?? '' };
}

async function tauriLoad(sessionId: string): Promise<LoadedSession | null> {
  const data = await withTauriTimeout<RawLoadSessionPayload | null>(tauriInvoke<RawLoadSessionPayload | null>('load_session', { sessionId }), 'load_session');
  if (!data) return null;
  return { snapshot: normalizeSessionSnapshot(data.snapshot ?? data), workspace: data.workspace ?? '' };
}

async function tauriLoadList(): Promise<SessionMeta[]> {
  const list = await withTauriTimeout<RawSessionMeta[]>(tauriInvoke<RawSessionMeta[]>('load_session_list'), 'load_session_list');
  return list.map((s) => ({
    id: s.id ?? '',
    title: s.title ?? '',
    createdAt: s.createdAt ?? 0,
    updatedAt: s.updatedAt ?? 0,
    messageCount: s.messageCount ?? 0,
    workspace: s.workspace ?? '',
  }));
}

async function tauriDelete(sessionId: string): Promise<void> {
  await tauriInvoke('delete_session', { sessionId });
}

async function tauriDeleteAll(): Promise<void> {
  await tauriInvoke('delete_all_sessions');
}

// ── localStorage fallback ──

const SESSIONS_KEY = 'pure_sessions';
const LAST_SESSION_KEY = 'pure_last_session';

function limitSessionSnapshot(snapshot: SessionSnapshotV3): SessionSnapshotV3 {
  const messages = limitConversationMessages(snapshot.modelContext.messages);
  const dropped = snapshot.modelContext.messages.length - messages.length;
  const events = dropped > 0
    ? snapshot.events.slice(Math.max(0, snapshot.events.length - Math.max(1, messages.length * 8)))
    : snapshot.events;
  return { ...snapshot, modelContext: { messages }, events, transcript: snapshot.transcript.filter(entry => entry.modelMessageIndex >= dropped) };
}

function lsSave(sessionId: string, snapshot: SessionSnapshotV2, workspace: string) {
  // Store the workspace exactly as passed ('' clears a previous override), so
  // the localStorage fallback behaves identically to the Tauri path.
  const boundedSnapshot = limitSessionSnapshot(snapshot);
  const payload = JSON.stringify({ snapshot: boundedSnapshot, updatedAt: Date.now(), messageCount: boundedSnapshot.modelContext.messages.length, workspace });
  const key = `pure_session:${sessionId}`;
  const tempKey = `${key}:pending`;
  localStorage.setItem(tempKey, payload);
  localStorage.setItem(key, payload);
  localStorage.removeItem(tempKey);

  const list = lsLoadList();
  const existing = list.findIndex(s => s.id === sessionId);
  const meta: SessionMeta = {
    id: sessionId,
    title: extractTitle(boundedSnapshot.modelContext.messages),
    createdAt: existing >= 0 ? list[existing].createdAt : Date.now(),
    updatedAt: Date.now(),
    messageCount: boundedSnapshot.modelContext.messages.length,
    workspace,
  };
  if (existing >= 0) {
    list[existing] = meta;
  } else {
    list.push(meta);
  }
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
  localStorage.setItem(LAST_SESSION_KEY, sessionId);
}

function lsSaveWorkspace(sessionId: string, workspace: string) {
  const prev = lsLoad(sessionId);
  if (!prev) return;
  const data = { snapshot: prev.snapshot, updatedAt: Date.now(), messageCount: prev.snapshot.modelContext.messages.length, workspace };
  localStorage.setItem(`pure_session:${sessionId}`, JSON.stringify(data));

  const list = lsLoadList();
  const existing = list.findIndex(s => s.id === sessionId);
  if (existing >= 0) {
    list[existing] = { ...list[existing], workspace, updatedAt: Date.now() };
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
  }
}

function lsLoad(sessionId: string): LoadedSession | null {
  const raw = localStorage.getItem(`pure_session:${sessionId}`);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const snapshot = normalizeSessionSnapshot(data.snapshot ?? data);
    if (snapshot.modelContext.messages.length === 0) return null;
    return { snapshot: limitSessionSnapshot(snapshot), workspace: data.workspace ?? '' };
  } catch {
    return null;
  }
}

function lsLoadLast(): { sessionId: string; snapshot: SessionSnapshotV2; workspace: string } | null {
  const id = localStorage.getItem(LAST_SESSION_KEY);
  if (!id) return null;
  const loaded = lsLoad(id);
  if (!loaded || loaded.snapshot.modelContext.messages.length === 0) return null;
  return { sessionId: id, ...loaded };
}

function lsLoadList(): SessionMeta[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function lsDelete(sessionId: string) {
  localStorage.removeItem(`pure_session:${sessionId}`);
  const list = lsLoadList().filter(s => s.id !== sessionId);
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
  if (localStorage.getItem(LAST_SESSION_KEY) === sessionId) {
    localStorage.removeItem(LAST_SESSION_KEY);
  }
}

function lsDeleteAll() {
  const list = lsLoadList();
  for (const s of list) {
    localStorage.removeItem(`pure_session:${s.id}`);
  }
  localStorage.removeItem(SESSIONS_KEY);
  localStorage.removeItem(LAST_SESSION_KEY);
}

// ── Unified public API ──

// Throttle the disk-save failure toast: a persistently failing disk must not
// spam the user on every message — at most one warning per 30s window.
let lastDiskSaveWarning = 0;
const sessionSaveChains = new Map<string, Promise<void>>();
const sessionSaveRevisions = new Map<string, number>();
const sessionLoadedRevisions = new Map<string, number>();
const sessionSaveRetries = 2;

async function saveWithRetry(sessionId: string, snapshot: SessionSnapshotV2, workspace: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= sessionSaveRetries; attempt++) {
    try {
      if (tauriAvailable) {
        await tauriSave(sessionId, snapshot, workspace);
      } else {
        lsSave(sessionId, snapshot, workspace);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < sessionSaveRetries) {
        await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('session save failed');
}

export interface SessionPlanProgressPersistence {
  persist(snapshot: PlanProgressSnapshot): void;
  flush(): Promise<void>;
  dispose(): void;
}

export async function persistSessionPlanProgress(
  sessionId: string,
  progress: PlanProgressSnapshot,
  workspace = '',
): Promise<void> {
  const loaded = await loadSession(sessionId);
  if (!loaded) return;
  const complete = progress.status === 'complete';
  const planState: PlanState = {
    plan: progress.plan,
    planNumber: progress.currentPlan,
    todoNumber: progress.currentTodo,
    started: progress.status !== 'waiting',
    ...(complete ? { complete: true } : {}),
  };
  const snapshot: SessionSnapshotV2 = {
    ...loaded.snapshot,
    uiState: {
      ...loaded.snapshot.uiState,
      planProgress: progress,
      planState,
    },
  };
  await saveSession(sessionId, snapshot, workspace);
}

export function createSessionPlanProgressPersistence(
  sessionId: string,
  workspace = '',
): SessionPlanProgressPersistence {
  let pending: PlanProgressSnapshot | null = null;
  let scheduled = false;
  let disposed = false;
  let chain = Promise.resolve();

  const runPending = (): void => {
    scheduled = false;
    const next = pending;
    pending = null;
    if (!next || disposed) return;
    chain = chain
      .then(() => persistSessionPlanProgress(sessionId, next, workspace))
      .catch(() => {});
  };

  return {
    persist(snapshot): void {
      if (disposed) return;
      pending = snapshot;
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(runPending);
      }
    },
      flush(): Promise<void> {
      if (scheduled) runPending();
      return resolveWithin(chain, 5_000);
    },
    dispose(): void {
      disposed = true;
      pending = null;
      scheduled = false;
    },
  };
}

/**
 * Persist a session. On the desktop the canonical copy lives on disk via the
 * Rust save_session command; a write failure (permissions, disk full, I/O
 * error) falls back to browser localStorage so the conversation survives
 * mid-session — but unlike the old silent catch, the user is told the save
 * was NOT durable, so a restart losing the session is not a surprise.
 */
export async function saveSession(sessionId: string, snapshot: SessionSnapshotV2, workspace = ''): Promise<void> {
  const boundedSnapshot = limitSessionSnapshot(snapshot);
  const revision = Math.max(
    sessionSaveRevisions.get(sessionId) ?? 0,
    sessionLoadedRevisions.get(sessionId) ?? 0,
    boundedSnapshot.revision ?? 0,
  ) + 1;
  sessionSaveRevisions.set(sessionId, revision);
  sessionLoadedRevisions.set(sessionId, revision);
  const revisionedSnapshot = { ...boundedSnapshot, revision };
  const previous = sessionSaveChains.get(sessionId) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      try {
        await saveWithRetry(sessionId, revisionedSnapshot, workspace);
      } catch (err) {
        console.error('[pure] save_session failed:', err);
        const now = Date.now();
        if (now - lastDiskSaveWarning > 30_000) {
          lastDiskSaveWarning = now;
          showToast(t('toast.saveDiskFailed'), 6000);
        }
        throw err;
      }
    });
  sessionSaveChains.set(sessionId, current);
  try {
    await current;
  } finally {
    if (sessionSaveChains.get(sessionId) === current) sessionSaveChains.delete(sessionId);
    if (!sessionSaveChains.has(sessionId) && sessionSaveRevisions.get(sessionId) === revision) {
      sessionSaveRevisions.delete(sessionId);
    }
  }
}

/**
 * Persist ONLY the workspace override for an already-saved session (used when
 * the user edits the workspace chip without sending a new message, so the
 * change survives an app restart).
 */
export async function flushSessionSaves(): Promise<void> {
  await Promise.all([...sessionSaveChains.values()].map(chain => chain.catch(() => {})));
}

export async function saveSessionWorkspace(sessionId: string, workspace: string): Promise<void> {
  if (tauriAvailable) {
    await tauriSaveWorkspace(sessionId, workspace);
    return;
  }
  lsSaveWorkspace(sessionId, workspace);
}

export async function loadLastSession(): Promise<{ sessionId: string; snapshot: SessionSnapshotV2; workspace: string } | null> {
  if (tauriAvailable) {
    try { return await tauriLoadLast(); } catch {}
  }
  return lsLoadLast();
}

export async function loadSession(sessionId: string): Promise<LoadedSession | null> {
  let loaded: LoadedSession | null;
  if (tauriAvailable) {
    try { loaded = await tauriLoad(sessionId); } catch { loaded = null; }
  } else {
    loaded = lsLoad(sessionId);
  }
  if (loaded) sessionLoadedRevisions.set(sessionId, loaded.snapshot.revision ?? 0);
  return loaded;
}

export async function loadSessionList(): Promise<SessionMeta[]> {
  if (tauriAvailable) {
    try { return await tauriLoadList(); } catch {}
  }
  return lsLoadList();
}

// Tauri mode: let the error propagate (no silent localStorage fallback) so the
// caller can show a failure instead of claiming success while nothing was
// deleted on disk — the localStorage path cannot touch ~/.pure/sessions data.
export async function deleteSession(sessionId: string): Promise<void> {
  if (tauriAvailable) {
    await tauriDelete(sessionId);
  } else {
    lsDelete(sessionId);
  }
  // Stats live in localStorage on BOTH backends — clear them either way so a
  // deleted conversation never leaves orphaned usage data behind.
  clearSessionStats(sessionId);
}

export async function deleteAllSessions(): Promise<void> {
  if (tauriAvailable) {
    await tauriDeleteAll();
  } else {
    lsDeleteAll();
  }
  // Wipe every per-session stats key (no list survives in Tauri mode, so
  // sweep the prefix defensively) and drop the in-memory mirror.
  statsCache.clear();
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(STATS_PREFIX));
    for (const k of keys) localStorage.removeItem(k);
  } catch { /* ignore */ }
}

function extractTitle(messages: Message[]): string {
  const firstUser = messages.find(m => m.role === 'user' && m.content);
  if (firstUser?.content) {
    return firstUser.content.slice(0, 60);
  }
  return 'New chat';
}

// ── Per-session stats (file-backed in Tauri, localStorage fallback in dev) ──
// Durable backing store is ~/.pure/sessions/<id>/stats.json (Rust commands),
// so stats survive with the session itself and are deleted alongside it. An
// in-memory cache keeps the synchronous API (chat.ts reads stats mid-turn);
// writes go to disk (or localStorage in plain Vite dev) best-effort.

const STATS_PREFIX = 'pure_stats:';

/** In-memory mirror of every session's stats for synchronous reads. */
const statsCache = new Map<string, SessionStats>();

// Bound the in-memory stats mirror: a long-lived session list must not grow
// the Map without limit. LRU eviction (insertion order) keeps the most recent
// sessions cached; older ones fall back to the disk/localStorage read.
const STATS_CACHE_MAX = 100;

function cacheStats(id: string, stats: SessionStats): void {
  statsCache.set(id, stats);
  while (statsCache.size > STATS_CACHE_MAX) {
    const oldest = statsCache.keys().next().value;
    if (oldest === undefined) break;
    statsCache.delete(oldest);
  }
}

function emptyStats(): SessionStats {
  return { turns: 0, searches: [], fileWrites: [], fileReads: [], commands: [] };
}

export function loadSessionStats(sessionId: string): SessionStats {
  const cached = statsCache.get(sessionId);
  if (cached) return cached;
  let stats = emptyStats();
  try {
    const raw = localStorage.getItem(`${STATS_PREFIX}${sessionId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SessionStats>;
      stats = normalizeLoadedStats(parsed);
      if (fileWritesNeedMigration(parsed.fileWrites, stats.fileWrites)) {
        try { localStorage.setItem(`${STATS_PREFIX}${sessionId}`, JSON.stringify(stats)); } catch { /* ignore migration write */ }
      }
    }
  } catch {
    // fall through to empty
  }
  cacheStats(sessionId, stats);
  // Kick off an async read of the durable file (Tauri only) so disk data wins
  // over any stale localStorage entry; the sync path above returns instantly.
  void refreshStatsFromDisk(sessionId);
  return stats;
}

async function refreshStatsFromDisk(sessionId: string): Promise<void> {
  if (!tauriAvailable) return;
  try {
    const data = await tauriInvoke<Partial<SessionStats> | null>('load_session_stats', { sessionId });
    if (!data) return;
    const stats = normalizeLoadedStats(data);
    cacheStats(sessionId, stats);
    if (fileWritesNeedMigration(data.fileWrites, stats.fileWrites)) {
      void tauriInvoke('save_session_stats', { sessionId, stats }).catch(() => {});
    }
  } catch {
    // Disk read is best-effort; the cache/localStorage already has a value.
  }
}

/**
 * Re-read a session's stats from disk (Tauri only; no-op in browser dev) and
 * update the in-memory cache. chat.ts awaits this after session switches so the
 * stats panel re-renders with the durable numbers, not just the sync cache.
 */
export async function refreshSessionStatsFromDisk(sessionId: string): Promise<void> {
  await refreshStatsFromDisk(sessionId);
}

/**
 * Bulk-load stats for a batch of sessions (one IPC round-trip in Tauri; the
 * in-memory cache + localStorage cover browser dev). Used by the session
 * sidebar to render the per-session token/cost summary line. Missing entries
 * are simply absent from the result map.
 */
export async function loadSessionStatsForList(sessionIds: string[]): Promise<Map<string, SessionStats>> {
  const result = new Map<string, SessionStats>();
  const uncached: string[] = [];
  for (const id of sessionIds) {
    const cached = statsCache.get(id);
    if (cached) {
      result.set(id, cached);
    } else {
      uncached.push(id);
    }
  }
  if (uncached.length === 0) return result;

  if (tauriAvailable) {
    try {
      // Pass only the uncached ids so the Rust side reads just those
      // stats.json files instead of sweeping every session on disk.
      const data = await tauriInvoke<Record<string, Partial<SessionStats>> | null>('load_all_session_stats', { sessionIds: uncached });
      for (const id of uncached) {
        const raw = data?.[id];
        if (!raw) continue;
        const stats = normalizeLoadedStats(raw);
        cacheStats(id, stats);
        result.set(id, stats);
        if (fileWritesNeedMigration(raw.fileWrites, stats.fileWrites)) {
          void tauriInvoke('save_session_stats', { sessionId: id, stats }).catch(() => {});
        }
      }
      return result;
    } catch {
      // Fall through to the localStorage sweep below.
    }
  }

  for (const id of uncached) {
    try {
      const raw = localStorage.getItem(`${STATS_PREFIX}${id}`);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Partial<SessionStats>;
      const stats = normalizeLoadedStats(parsed);
      cacheStats(id, stats);
      result.set(id, stats);
      if (fileWritesNeedMigration(parsed.fileWrites, stats.fileWrites)) {
        try { localStorage.setItem(`${STATS_PREFIX}${id}`, JSON.stringify(stats)); } catch { /* ignore migration write */ }
      }
    } catch {
      // skip unparseable entries
    }
  }
  return result;
}

export function saveSessionStats(sessionId: string, stats: SessionStats): void {
  const normalized = normalizeStats(stats);
  cacheStats(sessionId, normalized);
  if (tauriAvailable) {
    // Durable copy: ~/.pure/sessions/<id>/stats.json. Fire-and-forget — the
    // in-memory cache is authoritative for the current session.
    void tauriInvoke('save_session_stats', { sessionId, stats: normalized }).catch(() => {});
    return;
  }
  try {
    localStorage.setItem(`${STATS_PREFIX}${sessionId}`, JSON.stringify(normalized));
  } catch {
    // Quota / disabled storage — stats are best-effort, never break the chat.
  }
}

function clearSessionStats(sessionId: string): void {
  statsCache.delete(sessionId);
  try { localStorage.removeItem(`${STATS_PREFIX}${sessionId}`); } catch { /* ignore */ }
}
