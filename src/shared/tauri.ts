// src/shared/tauri.ts
// Tauri runtime detection. In the packaged app the webview exposes
// window.__TAURI_INTERNALS__; in plain Vite dev / tests it is absent.

let cached: boolean | null = null;

/** Synchronous detection — safe in browser, test and Node runtimes. */
export function isTauriRuntime(): boolean {
  if (cached !== null) return cached;
  try {
    cached = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  } catch {
    cached = false;
  }
  return cached;
}

/** Lazily load @tauri-apps/api/core — null outside the Tauri runtime. */
export async function loadTauriCore(): Promise<typeof import('@tauri-apps/api/core') | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await import('@tauri-apps/api/core');
  } catch {
    return null;
  }
}

/**
 * Resolve the application-owned temporary workspace for a session. Plain web
 * development has no filesystem-backed application space, so it returns an
 * empty string and retains the no-workspace behavior there.
 */
export async function getApplicationTmpWorkspace(sessionId: string): Promise<string> {
  const core = await loadTauriCore();
  if (!core) return '';
  return await core.invoke<string>('get_tmp_workspace', { sessionId });
}
