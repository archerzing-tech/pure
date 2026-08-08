// src/ui/config.ts
// App configuration model: types, defaults, persistence and the API-key
// secret hand-off to Rust. Split out of settings.ts so the model (needed by
// chat.ts and main.ts at startup) never drags the settings panel DOM module
// into the eager bundle — the panel itself is lazy-loaded on first open.

import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { SECRET_KEY } from '../adapter/rust/RustLLMAdapter';
import type { ProviderId } from '../shared/providers';

export interface PureConfig {
  /** Provider id — typed from the registry so the two can never drift. */
  provider: ProviderId;
  apiKey: string;
  /**
   * True when an API key is stored outside the WebView (Rust secrets in the
   * desktop app). The raw key is then never persisted to localStorage.
   */
  hasApiKey: boolean;
  /**
   * User-configured location/city (Settings → General → Environment), used
   * as the location baseline when answering questions that depend on "where
   * the user is" (trip planning → departure point, weather, local services).
   * Can be filled manually or via the "auto-detect" IP lookup. Empty =
   * unknown; sys_info() reports it to the model as the location.
   */
  city: string;
  model: string;
  baseURL: string;
  language: 'zh-CN' | 'en';
  theme: 'light' | 'dark' | 'system';
  fontSize: 'small' | 'medium' | 'large';
  density: 'compact' | 'comfortable' | 'spacious';
  permissionMode: 'auto' | 'confirm' | 'restricted';
  autoPermRead: boolean;
  autoPermWrite: boolean;
  autoPermCmd: boolean;
  autoPermGit: boolean;
  toolFS: boolean;
  toolCmd: boolean;
  toolGit: boolean;
  toolBrowser: boolean;
  /**
   * Optional Tavily Search API key (Settings → Tools → Web Tools). When set,
   * web_search uses the Tavily API after Serper (stable index, no HTML
   * scraping) and falls back to the free HTML backends (Sogou / cn.bing /
   * DDG / Bing).
   */
  tavilyApiKey: string;
  /**
   * Optional Serper.dev Search API key (Settings → Tools → Web Tools). When
   * set, web_search uses the Serper API first — a real Google index, the best
   * quality for both Chinese and English (~2500 free trial queries).
   */
  serperApiKey: string;
  skills: Record<string, boolean>;
  mcpServers: Array<{ name: string; transport: 'stdio' | 'http'; command?: string[]; url?: string }>;
  /**
   * Bumped when a config migration changes field semantics. v2: toolBrowser
   * became a functional gate (was a decorative no-op defaulting to false);
   * legacy configs that stored the old meaningless `false` are migrated to
   * `true` so existing users keep web tools.
   */
  configVersion: number;
  /**
   * When true (default), assistant messages format progressively during
   * streaming (code blocks colorize, mermaid slots show source). When false,
   * the bubble's textContent stays raw for the entire stream and the full
   * renderMarkdown pipeline only runs once on Completed — saving CPU on
   * low-end hardware, at the cost of watching an inert plaintext bubble until
   * the assistant finishes.
   */
  streamingRender: boolean;
  /**
   * Manual task-mode override from the composer's mode selector (Settings-adjacent,
   * persisted with the rest of the config). 'auto' keeps the Planner's per-task
   * auto-detection (simple → yolo, complex → plan/build); a forced value wins
   * for every turn until switched back to auto. YOLO suppresses plan review,
   * plan/build always run it.
   */
  taskMode: 'auto' | 'yolo' | 'plan' | 'build';
}

export const STORAGE_KEY = 'pure_config';

/**
 * Built-in MCP servers shipped with pure. `web-search` wraps the
 * DuckDuckGo-based @sthbryan/web-search-mcp server (search / fetch_page /
 * query tools, no API key) — it strengthens web search, especially for
 * Chinese queries. Users can remove it in Settings → MCP like any other
 * server; the removal is persisted (the config v3 migration only re-adds it
 * once).
 */
export const DEFAULT_MCP_SERVERS: PureConfig['mcpServers'] = [
  {
    name: 'web-search',
    transport: 'stdio',
    command: ['bunx', '-y', '@sthbryan/web-search-mcp'],
  },
];

/** True when `name` is one of the built-in (non user-added) MCP servers. */
export function isDefaultMcpServer(name: string): boolean {
  return DEFAULT_MCP_SERVERS.some((s) => s.name === name);
}

export function defaults(): PureConfig {
  return {
    provider: 'deepseek-openai',
    apiKey: '',
    hasApiKey: false,
    city: '',
    model: '',
    baseURL: '',
    language: 'zh-CN',
    theme: 'light',
    fontSize: 'medium',
    density: 'comfortable',
    permissionMode: 'confirm',
    autoPermRead: true,
    autoPermWrite: false,
    autoPermCmd: false,
    autoPermGit: true,
    toolFS: true,
    toolCmd: true,
    toolGit: true,
    toolBrowser: true,
    tavilyApiKey: '',
    serperApiKey: '',
    skills: { 'code-review': true, 'web-research': true, memory: true, planning: true },
    mcpServers: [...DEFAULT_MCP_SERVERS],
    streamingRender: true,
    taskMode: 'auto',
    configVersion: 3,
  };
}

/**
 * In the desktop app the API key lives in Rust secrets (~/.pure/secrets.json,
 * 0600) and must never round-trip through localStorage. When one is supplied
 * via the settings form or the ?apikey= launch URL, store it with the Rust
 * backend and scrub it from the config object before it is persisted.
 */
async function syncSecretToRust(value: string): Promise<void> {
  const core = await loadTauriCore();
  if (!core) return;
  try {
    await core.invoke('secret_set', { key: SECRET_KEY, value });
  } catch (e) {
    console.warn('[pure] failed to store API key in Rust secrets:', e);
  }
}

async function deleteSecretFromRust(): Promise<void> {
  const core = await loadTauriCore();
  if (!core) return;
  try {
    await core.invoke('secret_delete', { key: SECRET_KEY });
  } catch (e) {
    console.warn('[pure] failed to remove API key from Rust secrets:', e);
  }
}

/**
 * True when an API key is available (localStorage in browser / Rust secrets
 * in Tauri). Declared as a type predicate so `if (!hasConfiguredKey(cfg))`
 * narrows `cfg` to a non-null PureConfig for the rest of the block.
 */
export function hasConfiguredKey(cfg: PureConfig | null): cfg is PureConfig {
  return !!(cfg && (cfg.apiKey || cfg.hasApiKey));
}

// Cached parse of the config: loadConfig() JSON.parses localStorage and is
// called on hot paths (every send, every streaming-state change, sidebar
// updates). Re-parsing hundreds of times per turn is wasted work — cache the
// result until a save actually rewrites it. The apikey URL param is constant
// for the page session, so caching is safe there too. Returns a shallow copy
// so callers can't mutate the shared cache.
let configCache: PureConfig | null | undefined;

export function invalidateConfigCache(): void {
  configCache = undefined;
}

export function loadConfig(): PureConfig | null {
  if (configCache !== undefined) {
    return configCache === null ? null : { ...configCache };
  }
  const params = new URLSearchParams(window.location.search);
  if (params.get('apikey')) {
    const base: PureConfig = defaults();
    const cfg: PureConfig = {
      ...base,
      provider: (params.get('provider') as PureConfig['provider']) || base.provider,
      apiKey: params.get('apikey')!,
      model: params.get('model') || '',
    };
    if (isTauriRuntime()) {
      // CLI-launched desktop flow passes the key via URL: store it in Rust
      // secrets (once) and drop it from the in-memory config.
      void syncSecretToRust(cfg.apiKey);
      cfg.hasApiKey = true;
      cfg.apiKey = '';
    }
    configCache = cfg;
    return cfg;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const cfg: PureConfig = { ...defaults(), ...parsed };
      // Both migrations below mutate `cfg` and mark it dirty; the single write
      // at the end persists the result ONCE. Doing the writes inline would be
      // wrong in the Tauri case: a pre-scrub localStorage.setItem(cfg) could
      // leak the raw API key into WebView storage before the legacy-key block
      // cleans it below.
      let needsPersist = false;
      // Config v2 migration: pre-v2 toolBrowser was a decorative toggle that
      // always saved `false` and gated nothing. Once it became a real gate,
      // those legacy `false` values would silently strip web tools from
      // existing installs — restore them once via the version bump.
      if ((parsed.configVersion ?? 1) < 2) {
        cfg.toolBrowser = true;
        cfg.configVersion = 2;
        needsPersist = true;
      }
      // Config v3 migration: the built-in web-search MCP server was added.
      // Existing configs get it ONCE; users who later delete it in Settings →
      // MCP save an explicit list without it (configVersion stays 3), so it
      // never silently returns.
      if ((parsed.configVersion ?? 1) < 3) {
        const current = cfg.mcpServers ?? [];
        if (!current.some((s) => s.name === DEFAULT_MCP_SERVERS[0].name)) {
          cfg.mcpServers = [...DEFAULT_MCP_SERVERS, ...current];
        }
        cfg.configVersion = 3;
        needsPersist = true;
      }
      if (isTauriRuntime() && cfg.apiKey) {
        // Legacy migration: move a key previously persisted to localStorage
        // into Rust secrets, then scrub it.
        void syncSecretToRust(cfg.apiKey);
        cfg.hasApiKey = true;
        cfg.apiKey = '';
        needsPersist = true;
      }
      if (needsPersist) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
        } catch { /* ignore */ }
      }
      configCache = cfg;
      return cfg;
    }
  } catch { /* ignore */ }
  configCache = null;
  return null;
}

/**
 * Store (or revoke) the Rust-side API key from the settings panel. Exported
 * so the panel can hand the raw key to the backend without ever persisting it.
 */
export async function storeSecretInRust(value: string): Promise<void> {
  await syncSecretToRust(value);
}

export async function revokeSecretFromRust(): Promise<void> {
  await deleteSecretFromRust();
}
