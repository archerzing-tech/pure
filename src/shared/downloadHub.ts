// src/shared/downloadHub.ts
// Live progress + pause/resume/cancel control for the `download_file` tool.
//
// The engine yields a ToolResult only at completion, so a long download needs a
// side-channel to surface a progress bar and to let the UI pause/resume. The
// Node adapter emits progress here and reads a per-download controller; the GUI
// subscribes to render the bar and sends pause/resume/cancel back.

export type DownloadState =
  | 'downloading'
  | 'paused'
  | 'merging'
  | 'done'
  | 'error'
  | 'hidden';

export interface DownloadProgress {
  downloaded: number;
  total: number; // -1 when unknown
  percent: number; // 0..100, -1 when unknown
  speed: number; // bytes/sec (0 when unknown)
  state: DownloadState;
  filename?: string;
  via?: string; // native-chunked | native | native-resume | curl | fetch
}

/**
 * Per-download controller owned by the running download. `pause()` aborts the
 * in-flight fetches so they stop promptly; `resume()` clears the pause flag and
 * issues a fresh AbortSignal for the next range request. `waitWhilePaused()`
 * lets the download loop block cheaply until the UI resumes (or cancels).
 */
export class DownloadController {
  aborted = false;
  paused = false;
  private ctl = new AbortController();

  pause(): void {
    this.paused = true;
    this.ctl.abort();
  }

  resume(): void {
    if (this.aborted) return;
    this.paused = false;
    this.ctl = new AbortController();
  }

  abort(): void {
    this.aborted = true;
    this.paused = false;
    this.ctl.abort();
  }

  get signal(): AbortSignal {
    return this.ctl.signal;
  }

  async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.aborted) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

type ProgressCb = (id: string, p: DownloadProgress) => void;
type ControlCb = (id: string) => void;

class DownloadHub {
  private progressCbs = new Set<ProgressCb>();
  private pauseCbs = new Set<ControlCb>();
  private resumeCbs = new Set<ControlCb>();
  private cancelCbs = new Set<ControlCb>();
  private controllers = new Map<string, DownloadController>();

  onProgress(cb: ProgressCb): () => void {
    this.progressCbs.add(cb);
    return () => this.progressCbs.delete(cb);
  }

  emitProgress(id: string, p: DownloadProgress): void {
    for (const cb of this.progressCbs) cb(id, p);
  }

  /** Tell the UI to tear down any progress bar for this download — used when a
   * download ultimately fails so a stuck/partial bar never lingers (only
   * successful downloads should leave a visible bar). */
  clearProgress(id: string): void {
    this.emitProgress(id, { downloaded: 0, total: -1, percent: -1, speed: 0, state: 'hidden', filename: '' });
  }

  registerController(id: string): DownloadController {
    const c = new DownloadController();
    this.controllers.set(id, c);
    return c;
  }

  getController(id: string): DownloadController | undefined {
    return this.controllers.get(id);
  }

  dispose(id: string): void {
    this.controllers.delete(id);
  }

  pause(id: string): void {
    this.controllers.get(id)?.pause();
    for (const cb of this.pauseCbs) cb(id);
  }

  resume(id: string): void {
    this.controllers.get(id)?.resume();
    for (const cb of this.resumeCbs) cb(id);
  }

  cancel(id: string): void {
    this.controllers.get(id)?.abort();
    for (const cb of this.cancelCbs) cb(id);
  }

  onPause(cb: ControlCb): () => void {
    this.pauseCbs.add(cb);
    return () => this.pauseCbs.delete(cb);
  }

  onResume(cb: ControlCb): () => void {
    this.resumeCbs.add(cb);
    return () => this.resumeCbs.delete(cb);
  }

  onCancel(cb: ControlCb): () => void {
    this.cancelCbs.add(cb);
    return () => this.cancelCbs.delete(cb);
  }
}

export const downloadHub = new DownloadHub();
