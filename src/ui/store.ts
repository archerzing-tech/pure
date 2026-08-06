// src/ui/store.ts
// v0.5.3 — Tauri-first session persistence with localStorage fallback.
// Stores sessions to ~/.pure/sessions/ (FSStore-compatible) when running in Tauri,
// falls back to browser localStorage for plain Vite dev.

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
   * parser; `'fetch'` shows a snippet of the de-noised page text; `undefined`
   * (or anything else) renders the raw `resultText` in a `<pre>` body.
   */
  resultKind?: 'search' | 'fetch';
  /**
   * Parsed result for `resultKind: 'search'`. Each item is a search hit the
   * web_search backends returned (Sogou → cn.bing.com → DuckDuckGo → Bing; see
   * src-tauri/src/lib.rs web_search).
   */
  resultItems?: Array<{ title: string; snippet: string; url: string }>;
  /**
   * Verbatim result string. Used by `resultKind === 'fetch'` (truncated) and by
   * the raw fallback when `resultItems` is missing.
   */
  resultText?: string;
}

export interface StoredMessage {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  /** Reasoning transcript shown in the GUI before this assistant message. */
  thinking?: string;
  /** Reasoning phases mapped to their assistant iteration for ordered replay. */
  thinkingPhases?: Array<{ text: string; assistantIndex: number }>;
  /** Legacy live/replay segments retained for older in-progress sessions. */
  thinkingSegments?: string[];
  toolExec?: ToolExecMeta;
}

export function getStoredThinkingSegments(message: Partial<StoredMessage>): string[] {
  if (message.thinkingPhases?.length) return message.thinkingPhases.map(phase => phase.text).filter(Boolean);
  if (message.thinkingSegments?.length) return message.thinkingSegments.filter(Boolean);
  return message.thinking ? [message.thinking] : [];
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

// Runtime detection: previously this did `!!(await import('@tauri-apps/api/core')).invoke`,
// which is ALWAYS true — @tauri-apps/api/core exports `invoke` even outside the
// Tauri runtime (plain Vite dev), so deleteSession/deleteAllSessions/saveSessionWorkspace
// would try to call window.__TAURI_INTERNALS__ (undefined) and throw. isTauriRuntime()
// checks for the actual __TAURI_INTERNALS__ global instead.
import { isTauriRuntime } from '../shared/tauri';
const tauriAvailable = isTauriRuntime();

// ── Tauri backend (filesystem via Rust commands) ──

async function tauriSave(sessionId: string, messages: StoredMessage[], workspace: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('save_session', { sessionId, messages, workspace });
}

async function tauriSaveWorkspace(sessionId: string, workspace: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('save_session_workspace', { sessionId, workspace });
}

async function tauriLoadLast(): Promise<{ sessionId: string; messages: StoredMessage[]; workspace: string } | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const data: any = await invoke('load_last_session');
  if (!data) return null;
  return { sessionId: data.sessionId, messages: data.messages ?? [], workspace: data.workspace ?? '' };
}

async function tauriLoad(sessionId: string): Promise<{ messages: StoredMessage[]; workspace: string } | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const data: any = await invoke('load_session', { sessionId });
  if (!data) return null;
  return { messages: data.messages ?? [], workspace: data.workspace ?? '' };
}

async function tauriLoadList(): Promise<SessionMeta[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  const list: any[] = await invoke('load_session_list');
  return list.map((s: any) => ({
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messageCount,
    workspace: s.workspace ?? '',
  }));
}

async function tauriDelete(sessionId: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('delete_session', { sessionId });
}

async function tauriDeleteAll(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('delete_all_sessions');
}

// ── localStorage fallback ──

const SESSIONS_KEY = 'pure_sessions';
const LAST_SESSION_KEY = 'pure_last_session';

function lsSave(sessionId: string, messages: StoredMessage[], workspace: string) {
  // Store the workspace exactly as passed ('' clears a previous override), so
  // the localStorage fallback behaves identically to the Tauri path.
  const data = { messages, updatedAt: Date.now(), messageCount: messages.length, workspace };
  localStorage.setItem(`pure_session:${sessionId}`, JSON.stringify(data));

  const list = lsLoadList();
  const existing = list.findIndex(s => s.id === sessionId);
  const meta: SessionMeta = {
    id: sessionId,
    title: extractTitle(messages),
    createdAt: existing >= 0 ? list[existing].createdAt : Date.now(),
    updatedAt: Date.now(),
    messageCount: messages.length,
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
  const data = { messages: prev.messages, updatedAt: Date.now(), messageCount: prev.messages.length, workspace };
  localStorage.setItem(`pure_session:${sessionId}`, JSON.stringify(data));

  const list = lsLoadList();
  const existing = list.findIndex(s => s.id === sessionId);
  if (existing >= 0) {
    list[existing] = { ...list[existing], workspace, updatedAt: Date.now() };
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
  }
}

function lsLoad(sessionId: string): { messages: StoredMessage[]; workspace: string } | null {
  const raw = localStorage.getItem(`pure_session:${sessionId}`);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data.messages) return null;
    return { messages: data.messages, workspace: data.workspace ?? '' };
  } catch {
    return null;
  }
}

function lsLoadLast(): { sessionId: string; messages: StoredMessage[]; workspace: string } | null {
  const id = localStorage.getItem(LAST_SESSION_KEY);
  if (!id) return null;
  const loaded = lsLoad(id);
  if (!loaded || loaded.messages.length === 0) return null;
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

export async function saveSession(sessionId: string, messages: StoredMessage[], workspace = ''): Promise<void> {
  if (tauriAvailable) {
    try { await tauriSave(sessionId, messages, workspace); return; } catch {}
  }
  lsSave(sessionId, messages, workspace);
}

/**
 * Persist ONLY the workspace override for an already-saved session (used when
 * the user edits the workspace chip without sending a new message, so the
 * change survives an app restart).
 */
export async function saveSessionWorkspace(sessionId: string, workspace: string): Promise<void> {
  if (tauriAvailable) {
    await tauriSaveWorkspace(sessionId, workspace);
    return;
  }
  lsSaveWorkspace(sessionId, workspace);
}

export async function loadLastSession(): Promise<{ sessionId: string; messages: StoredMessage[]; workspace: string } | null> {
  if (tauriAvailable) {
    try { return await tauriLoadLast(); } catch {}
  }
  return lsLoadLast();
}

export async function loadSession(sessionId: string): Promise<{ messages: StoredMessage[]; workspace: string } | null> {
  if (tauriAvailable) {
    try { return await tauriLoad(sessionId); } catch {}
  }
  return lsLoad(sessionId);
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
    return;
  }
  lsDelete(sessionId);
}

export async function deleteAllSessions(): Promise<void> {
  if (tauriAvailable) {
    await tauriDeleteAll();
    return;
  }
  lsDeleteAll();
}

function extractTitle(messages: StoredMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user' && m.content);
  if (firstUser?.content) {
    return firstUser.content.slice(0, 60);
  }
  return 'New chat';
}
