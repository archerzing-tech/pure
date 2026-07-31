// src/ui/updater.ts
// Auto-update check using Tauri updater plugin.

let _checkedOnStartup = false;

export async function checkForUpdatesSilently(): Promise<void> {
  if (_checkedOnStartup) return;
  _checkedOnStartup = true;

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return;

    const status = document.getElementById('update-status-text');
    if (status) {
      status.textContent = `Update available: v${update.version}`;
      status.className = 'update-available';
    }
  } catch {
    // Silently ignore — likely not running in Tauri or no network
  }
}

export async function checkForUpdatesManual(): Promise<void> {
  const statusEl = document.getElementById('update-status-text');
  const btn = document.getElementById('cfg-check-update') as HTMLButtonElement | null;

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

export async function fetchAndDisplayVersion(): Promise<void> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    const v = await getVersion();
    setCurrentVersion(v);
  } catch {
    setCurrentVersion('0.5.5');
  }
}
