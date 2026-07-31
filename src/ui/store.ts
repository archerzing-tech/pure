// src/ui/store.ts
// v0.5.3 — Tauri-first session persistence with localStorage fallback.
// Stores sessions to ~/.pure/sessions/ (FSStore-compatible) when running in Tauri,
// falls back to browser localStorage for plain Vite dev.

export interface ToolExecMeta {
  toolName: string;
  success: boolean;
  duration: number;
}

export interface StoredMessage {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  toolExec?: ToolExecMeta;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

let tauriAvailable = false;
try {
  // Dynamic check: only in Tauri does @tauri-apps/api/core resolve
  const mod = await import('@tauri-apps/api/core');
  tauriAvailable = !!mod.invoke;
} catch {
  tauriAvailable = false;
}

// ── Tauri backend (filesystem via Rust commands) ──

async function tauriSave(sessionId: string, messages: StoredMessage[]): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('save_session', { sessionId, messages });
}

async function tauriLoadLast(): Promise<{ sessionId: string; messages: StoredMessage[] } | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const data: any = await invoke('load_last_session');
  if (!data) return null;
  return { sessionId: data.sessionId, messages: data.messages ?? [] };
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
  }));
}

async function tauriDelete(sessionId: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('delete_session', { sessionId });
}

// ── localStorage fallback ──

const SESSIONS_KEY = 'pure_sessions';
const LAST_SESSION_KEY = 'pure_last_session';

function lsSave(sessionId: string, messages: StoredMessage[]) {
  const data = { messages, updatedAt: Date.now(), messageCount: messages.length };
  localStorage.setItem(`pure_session:${sessionId}`, JSON.stringify(data));

  const list = lsLoadList();
  const existing = list.findIndex(s => s.id === sessionId);
  const meta: SessionMeta = {
    id: sessionId,
    title: extractTitle(messages),
    createdAt: existing >= 0 ? list[existing].createdAt : Date.now(),
    updatedAt: Date.now(),
    messageCount: messages.length,
  };
  if (existing >= 0) {
    list[existing] = meta;
  } else {
    list.push(meta);
  }
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
  localStorage.setItem(LAST_SESSION_KEY, sessionId);
}

function lsLoadLast(): { sessionId: string; messages: StoredMessage[] } | null {
  const id = localStorage.getItem(LAST_SESSION_KEY);
  if (!id) return null;
  const raw = localStorage.getItem(`pure_session:${id}`);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data.messages || data.messages.length === 0) return null;
    return { sessionId: id, messages: data.messages };
  } catch {
    return null;
  }
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

// ── Unified public API ──

export async function saveSession(sessionId: string, messages: StoredMessage[]): Promise<void> {
  if (tauriAvailable) {
    try { await tauriSave(sessionId, messages); return; } catch {}
  }
  lsSave(sessionId, messages);
}

export async function loadLastSession(): Promise<{ sessionId: string; messages: StoredMessage[] } | null> {
  if (tauriAvailable) {
    try { return await tauriLoadLast(); } catch {}
  }
  return lsLoadLast();
}

export async function loadSession(sessionId: string): Promise<StoredMessage[] | null> {
  if (tauriAvailable) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const data: any = await invoke('load_session', { sessionId });
      if (!data) return null;
      return data.messages ?? [];
    } catch {}
  }
  const raw = localStorage.getItem(`pure_session:${sessionId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw).messages ?? [];
  } catch {
    return null;
  }
}

export async function loadSessionList(): Promise<SessionMeta[]> {
  if (tauriAvailable) {
    try { return await tauriLoadList(); } catch {}
  }
  return lsLoadList();
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (tauriAvailable) {
    try { await tauriDelete(sessionId); return; } catch {}
  }
  lsDelete(sessionId);
}

function extractTitle(messages: StoredMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user' && m.content);
  if (firstUser?.content) {
    return firstUser.content.slice(0, 60);
  }
  return 'New chat';
}
