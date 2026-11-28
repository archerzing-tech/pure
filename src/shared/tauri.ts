// src/shared/tauri.ts
// Tauri runtime detection. In the packaged app the webview exposes
// window.__TAURI_INTERNALS__; in plain Vite dev / tests it is absent.

let cached: boolean | null = null;

/** Synchronous detection — safe in browser, test and Node runtimes.
 *
 *  只缓存「是」：`__TAURI_INTERNALS__` 由 WebView 的初始化脚本注入，早于它的
 *  一次探测不能代表此后——把 false 也钉住，等于让整个进程从此认不出宿主。
 *  判例：bun 单进程跑整包测试时，先跑的用例文件（Node 环境，无 window）把
 *  false 写进缓存，后面的 UI 用例即便注入了 __TAURI_INTERNALS__ 也读不到，
 *  resizeZones 因此一例都建不出热区（CI Linux 9 例全红，mac 单文件跑却全绿）。
 *  反向代价是一次 `in` 判断，可以忽略。 */
export function isTauriRuntime(): boolean {
  if (cached === true) return true;
  try {
    cached = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  } catch {
    cached = false;
  }
  return cached === true;
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

/**
 * Single choke-point for invoking Rust commands. Callers must already be
 * inside a runtime check (isTauriRuntime()) — outside the Tauri runtime this
 * throws instead of failing with a confusing undefined access.
 */
export async function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await loadTauriCore();
  if (!core) throw new Error(`tauriInvoke: Tauri runtime unavailable for command '${cmd}'`);
  return await core.invoke<T>(cmd, args);
}
