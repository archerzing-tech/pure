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

import type { TokenUsage } from '../shared/types';

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
   * web_search backends returned (cn.bing.com → DuckDuckGo → Bing; see
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

/**
 * Aggregated stats for ONE conversation (session id), shown in the right
 * panel's 统计 tab. Token/cost data comes from the provider's billing usage
 * (see src/shared/usage.ts); tool activity is recorded from tool executions.
 */
export interface SessionStats {
  /** Provider id the session ran on (cost is priced per provider family). */
  provider?: string;
  /** Aggregated billing usage across every turn in this session. */
  usage?: TokenUsage;
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
  return { ...stats, fileWrites: dedupeFileWrites(stats.fileWrites ?? []) };
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
const tauriAvailable = isTauriRuntime();

// ── Tauri backend (filesystem via Rust commands) ──

async function tauriSave(sessionId: string, messages: StoredMessage[], workspace: string): Promise<void> {
  await tauriInvoke('save_session', { sessionId, messages, workspace });
}

async function tauriSaveWorkspace(sessionId: string, workspace: string): Promise<void> {
  await tauriInvoke('save_session_workspace', { sessionId, workspace });
}

async function tauriLoadLast(): Promise<{ sessionId: string; messages: StoredMessage[]; workspace: string } | null> {
  const data: any = await tauriInvoke('load_last_session');
  if (!data) return null;
  return { sessionId: data.sessionId, messages: data.messages ?? [], workspace: data.workspace ?? '' };
}

async function tauriLoad(sessionId: string): Promise<{ messages: StoredMessage[]; workspace: string } | null> {
  const data: any = await tauriInvoke('load_session', { sessionId });
  if (!data) return null;
  return { messages: data.messages ?? [], workspace: data.workspace ?? '' };
}

async function tauriLoadList(): Promise<SessionMeta[]> {
  const list: any[] = await tauriInvoke('load_session_list');
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
  await tauriInvoke('delete_session', { sessionId });
}

async function tauriDeleteAll(): Promise<void> {
  await tauriInvoke('delete_all_sessions');
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

function extractTitle(messages: StoredMessage[]): string {
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
  return { searches: [], fileWrites: [], fileReads: [], commands: [] };
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
    const data: any = await tauriInvoke('load_session_stats', { sessionId });
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
      const data: Record<string, any> = await tauriInvoke('load_all_session_stats', { sessionIds: uncached });
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
