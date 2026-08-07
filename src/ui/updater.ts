// src/ui/updater.ts
// Auto-update check using Tauri updater plugin.

// Injected by Vite (build time) as a fallback for non-Tauri / dev runs.
declare const __APP_VERSION__: string;

let _checkedOnStartup = false;

export async function checkForUpdatesSilently(): Promise<void> {
  if (_checkedOnStartup) return;
  _checkedOnStartup = true;

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return;

    const status = document.getElementById('updater-status');
    if (status) {
      status.textContent = `Update available: v${update.version}`;
      status.className = 'update-available';
    }
  } catch {
    // Silently ignore — likely not running in Tauri or no network
  }
}

export async function checkForUpdatesManual(): Promise<void> {
  const statusEl = document.getElementById('updater-status');
  const btn = document.getElementById('cfg-check-updates') as HTMLButtonElement | null;

  const setStatus = (text: string, cls: string) => {
    if (statusEl) {
      statusEl.textContent = text;
      statusEl.className = cls;
    }
  };

  try {
    setStatus('Checking for updates…', 'update-checking');
    if (btn) btn.disabled = true;

    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();

    if (!update) {
      setStatus('You are up to date ✓', 'update-up-to-date');
      if (btn) btn.disabled = false;
      return;
    }

    setStatus(`Found v${update.version} — downloading…`, 'update-downloading');

    let downloaded = 0;
    let total = 0;
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          total = event.data.contentLength ?? 0;
          break;
        case 'Progress':
          downloaded += event.data.chunkLength;
          if (total > 0) {
            const pct = Math.round((downloaded / total) * 100);
            setStatus(`Downloading… ${pct}%`, 'update-downloading');
          }
          break;
        case 'Finished':
          setStatus('Installing…', 'update-downloading');
          break;
      }
    });

    setStatus('Update installed! Restarting…', 'update-up-to-date');

    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`Update failed: ${msg}`, 'update-error');
    if (btn) btn.disabled = false;
  }
}

export function setCurrentVersion(version: string): void {
  const el = document.getElementById('update-current-version');
  if (el) el.textContent = version;
}

/**
 * Current app version: the real bundle version inside Tauri, otherwise the
 * version baked in at build time (vite.config.ts define).
 */
export async function fetchAppVersion(): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return __APP_VERSION__;
  }
}

export async function fetchAndDisplayVersion(): Promise<void> {
  setCurrentVersion(await fetchAppVersion());
}
