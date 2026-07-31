// src/harness/FileWatcher.ts
// v0.1 — File change monitor for the workspace. Uses chokidar in Node.js;
// in browser/Tauri mode receives events from Rust notify via IPC callback.

export interface FileChangeEvent {
  path: string;
  type: 'add' | 'change' | 'unlink';
  timestamp: number;
}

export type FileChangeHandler = (event: FileChangeEvent) => void;

export interface FileWatcherConfig {
  /** Workspace root to watch (default: cwd). */
  cwd?: string;
  /** Glob patterns to ignore. */
  ignored?: string[];
  /** Whether to watch recursively (default: true). */
  recursive?: boolean;
}

export class FileWatcher {
  private handlers = new Set<FileChangeHandler>();
  private watcher: unknown = null; // chokidar FSWatcher in Node.js
  private config: FileWatcherConfig;
  private active = false;

  constructor(config: FileWatcherConfig = {}) {
    this.config = {
      cwd: config.cwd ?? process.cwd(),
      ignored: config.ignored ?? ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/target/**'],
      recursive: config.recursive ?? true,
    };
  }

  /** Start watching the workspace. */
  async start(): Promise<void> {
    if (this.active) return;

    try {
      const chokidar = await (new Function('return import("chokidar")')() as Promise<any>);
      this.watcher = chokidar.watch(this.config.cwd!, {
        ignored: this.config.ignored,
        ignoreInitial: true,
        persistent: true,
        depth: this.config.recursive ? undefined : 0,
      });

      const watcher = this.watcher as { on: (event: string, cb: (path: string) => void) => void; close: () => Promise<void> };
      watcher.on('add', (path: string) => this.emit({ path, type: 'add', timestamp: Date.now() }));
      watcher.on('change', (path: string) => this.emit({ path, type: 'change', timestamp: Date.now() }));
      watcher.on('unlink', (path: string) => this.emit({ path, type: 'unlink', timestamp: Date.now() }));
      this.active = true;
    } catch {
      // chokidar not available — running in browser/Tauri, Rust handles watching
      this.active = true;
    }
  }

  /** Stop watching and release resources. */
  async stop(): Promise<void> {
    this.active = false;
    if (this.watcher) {
      const w = this.watcher as { close: () => Promise<void> };
      await w.close();
      this.watcher = null;
    }
  }

  /** Subscribe to file change events. */
  onChange(handler: FileChangeHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  /** Push an event from an external source (Tauri IPC bridge). */
  pushEvent(event: FileChangeEvent): void {
    this.emit(event);
  }

  get isActive(): boolean {
    return this.active;
  }

  private emit(event: FileChangeEvent): void {
    for (const handler of this.handlers) {
      try { handler(event); } catch { /* handler errors don't propagate */ }
    }
  }
}
