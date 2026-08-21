// src/ui/config.ts
// App configuration model: types, defaults, persistence and the API-key
// secret hand-off to Rust. Split out of settings.ts so the model (needed by
// chat.ts and main.ts at startup) never drags the settings panel DOM module
// into the eager bundle — the panel itself is lazy-loaded on first open.

import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { SECRET_KEY } from '../adapter/rust/RustLLMAdapter';
import { customProviderFor, defaultModelFor, isProviderId, providerDef, providerOverrideFor, PROVIDERS, type CustomProvider, type ProviderId, type ProviderOverride } from '../shared/providers';
import type { EvolutionConfig } from '../adapter/memory/evolution';
import type { HubSkill } from './skillHub';
import type { ProxyConfig } from '../shared/proxy';
import { normalizeProxyConfig } from '../shared/proxy';

export interface PureConfig {
  /** Provider id — typed from the registry so the two can never drift. */
  provider: ProviderId | string;
  /**
   * User-defined OpenAI-compatible providers (Settings → LLM → 添加自定义供应商).
   * Keyless local endpoints (Ollama / LM Studio) are send-ready without a key;
   * desktop keys live in Rust secrets under `llm.apiKey.<id>` (see
   * customSecretKey). Config v5.
   */
  customProviders: CustomProvider[];
  /** Model lists for built-in providers; custom-provider lists stay on their provider entry for compatibility. */
  providerModels: Record<string, string[]>;
  /** Optional display names per built-in model (provider id → model id → human label). */
  providerModelNames: Record<string, Record<string, string>>;
  /**
   * Per-provider overrides for the built-in providers (config v10): a custom
   * display name, endpoint (proxy / mirror) and per-provider API key, edited
   * in Settings → LLM → 连接设置. Custom providers already own these fields,
   * so this map only ever holds entries for the built-ins.
   */
  providerOverrides: Record<string, ProviderOverride>;
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
   * scraping) and falls back to the free HTML backends (cn.bing / DDG / Bing).
   */
  tavilyApiKey: string;
  /**
   * Optional Serper.dev Search API key (Settings → Tools → Web Tools). When
   * set, web_search uses the Serper API first — a real Google index, the best
   * quality for both Chinese and English (~2500 free trial queries).
   */
  serperApiKey: string;
  /**
   * Optional SearXNG instance URL (Settings → Tools → Web Tools). Intranet /
   * self-hosted metasearch: aggregates dozens of upstream engines behind one
   * JSON endpoint — the standard answer for corporate networks where the
   * public engines are blocked. Mirrors the SEARXNG_URL env var in the CLI.
   */
  searxngUrl: string;
  skills: Record<string, boolean>;
  /**
   * Third-party skills installed from an open-source skill hub (Settings →
   * Skills → Skill Hub). Each entry carries the downloaded SKILL.md body;
   * enabled entries are injected into the system prompt (chat.ts / cli.ts).
   */
  hubSkills: HubSkill[];
  mcpServers: Array<{ name: string; transport: 'stdio' | 'http'; command?: string[]; url?: string; requestTimeoutMs?: number }>;
  /**
   * MCP tool-name prefixes to hide from the model (e.g. ['scrapling__bulk_']).
   * Filtered tools stay connected server-side but are never registered, so
   * third-party MCP tool lists don't crowd out built-in tool selection.
   */
  mcpExcludedPrefixes: string[];
  /** Network proxy used by desktop LLM and agent requests. It is opt-in; an empty or invalid URL means direct connection. LLM and tool traffic have independent switches. */
  proxy: ProxyConfig;
  /**
   * Bumped when a config migration changes field semantics. v2: toolBrowser
   * became a functional gate (was a decorative no-op defaulting to false);
   * legacy configs that stored the old meaningless `false` are migrated to
   * `true` so existing users keep web tools. v7: proxy defaults and per-scope
   * proxy switches were made explicit. v13: added autoContinue /
   * autoContinueMaxRounds (long-task auto-continue, default off).
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
  /**
   * Long-task auto-continue (see docs/auto-continue-design.md): when enabled,
   * a complex plan task automatically keeps executing after each stage
   * boundary instead of waiting for a manual "继续". Default off — off keeps
   * the historical per-stage human confirmation rhythm. Works in every
   * permission mode; in confirm mode a pending permission prompt is a natural
   * stop point (the turn stays streaming until the user decides).
   */
  autoContinue: boolean;
  /**
   * Max auto rounds per user message (loop protection; also enforced by stall
   * detection). Not exposed in the settings panel — kept as a config field for
   * power users / future UI.
   */
  autoContinueMaxRounds: number;
  /**
   * Memory evolution thresholds (Settings → Memory → 遗忘速度). Engine units:
   * recencyHalfLifeMs / dormantGraceMs in milliseconds, scores in 0..1 — the
   * settings panel converts days↔ms and percent↔fraction. Undefined (or
   * partial) entries fall back to the engine defaults (EVOLUTION_DEFAULTS).
   */
  evolution?: Partial<EvolutionConfig>;
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

/**
 * One-click preset for the Scrapling MCP server (D4Vinci/Scrapling): adaptive
 * stealth web scraping via `uvx --from "scrapling[ai]" scrapling mcp`. The
 * `--from "scrapling[ai]"` is REQUIRED — the bare `scrapling` PyPI package
 * ships no CLI deps (verified 2026-08: `uvx scrapling mcp` dies with
 * `ModuleNotFoundError: No module named 'click'`; the MCP server ships in the
 * `[ai]` extra, which pulls `[fetchers]` → click). requestTimeoutMs is 120s
 * because the browser-backed tools (stealthy_fetch / fetch) launch a browser
 * and may solve Cloudflare challenges — the default 30s is too short.
 * Opt-in (not a default) because it needs Python + uv and ships a browser
 * fetcher; users install it once with `pip install "scrapling[ai]"` (README).
 */
export const SCRAPLING_MCP_PRESET: PureConfig['mcpServers'][number] = {
  name: 'scrapling',
  transport: 'stdio',
  command: ['uvx', '--from', 'scrapling[ai]', 'scrapling', 'mcp'],
  requestTimeoutMs: 120_000,
};

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
    searxngUrl: '',
    skills: { 'code-review': true, 'web-research': true, memory: true, planning: true },
    hubSkills: [],
    mcpServers: [...DEFAULT_MCP_SERVERS],
    mcpExcludedPrefixes: [],
    customProviders: [],
    providerModels: {},
    providerModelNames: {},
    providerOverrides: {},
    proxy: normalizeProxyConfig({ enabled: false, llmEnabled: false, toolsEnabled: false, url: '', username: '', password: '', hasPassword: false, bypassProviders: [], bypassModels: [] }),
    streamingRender: true,
    taskMode: 'auto',
    autoContinue: false,
    autoContinueMaxRounds: 8,
    configVersion: 13,
  };
}

/**
 * In the desktop app the API key lives in Rust secrets (~/.pure/secrets.json,
 * 0600) and must never round-trip through localStorage. When one is supplied
 * via the settings form or the ?apikey= launch URL, store it with the Rust
 * backend and scrub it from the config object before it is persisted.
 */
async function syncSecretToRust(key: string, value: string): Promise<void> {
  const core = await loadTauriCore();
  if (!core) return;
  try {
    await core.invoke('secret_set', { key, value });
  } catch (e) {
    console.warn('[pure] failed to store API key in Rust secrets:', e);
  }
}

async function deleteSecretFromRust(key: string): Promise<void> {
  const core = await loadTauriCore();
  if (!core) return;
  try {
    await core.invoke('secret_delete', { key });
  } catch (e) {
    console.warn('[pure] failed to remove API key from Rust secrets:', e);
  }
}

const MAX_PROVIDER_MODELS = 30;

export function uniqueModels(models: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of models) {
    if (typeof value !== 'string') continue;
    const model = value.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
    if (result.length >= MAX_PROVIDER_MODELS) break;
  }
  return result;
}

export function normalizeProviderModels(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, string[]> = {};
  for (const [provider, models] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = uniqueModels(Array.isArray(models) ? models : []);
    if (normalized.length > 0) result[provider] = normalized;
  }
  return result;
}

/**
 * Apply a default-model choice picked from the LLM page's top bar: the
 * provider is derived from the model's library, the model is ensured to be
 * in that library, and custom providers remember it as their defaultModel.
 * Pure function (no storage) so the choice logic is unit-testable.
 */
export function withDefaultModel(cfg: PureConfig, provider: string, model: string): PureConfig {
  const custom = customProviderFor(cfg.customProviders ?? [], provider);
  const next: PureConfig = { ...cfg, provider: provider as PureConfig['provider'], model };
  if (custom) {
    next.customProviders = (cfg.customProviders ?? []).map(p =>
      p.id === provider ? { ...p, defaultModel: model } : p);
  } else {
    next.providerModels = {
      ...normalizeProviderModels(cfg.providerModels),
      [provider]: uniqueModels([...(cfg.providerModels?.[provider] ?? []), model]),
    };
  }
  return next;
}

/** Return the models shown for one provider, with built-ins retaining a usable fallback. */
export function modelListForProvider(cfg: PureConfig, provider: string): string[] {
  const custom = customProviderFor(cfg.customProviders ?? [], provider);
  const stored = custom ? custom.models : cfg.providerModels?.[provider];
  const current = provider === cfg.provider ? cfg.model?.trim() : '';
  const def = providerDef(provider);
  if (custom) {
    return uniqueModels([...(custom.models ?? []), current, custom.defaultModel?.trim() || def?.defaultModel || '']);
  }
  // A user-configured library wins as-is; only empty libraries fall back to
  // the registry's default model list (so new registry entries never get
  // mixed into a library the user deliberately built).
  if (stored && stored.length > 0) {
    return uniqueModels([...stored, current]);
  }
  return uniqueModels([...(def?.models ?? [defaultModelFor(provider)]), current]);
}

/**
 * True when an API key is available (localStorage in browser / Rust secrets
 * in Tauri). Declared as a type predicate so `if (!hasConfiguredKey(cfg))`
 * narrows `cfg` to a non-null PureConfig for the rest of the block.
 */
export function hasConfiguredKey(cfg: PureConfig | null): cfg is PureConfig {
  if (!cfg) return false;
  if (cfg.apiKey || cfg.hasApiKey) return true;
  // A custom provider is always send-ready: keyed ones carry their own key
  // (entry, or Rust secrets via hasApiKey), keyless locals (Ollama / LM
  // Studio) need none — the transport omits the Authorization header.
  const custom = (cfg.customProviders ?? []).find((p) => p.id === cfg.provider);
  if (custom) return true;
  // A built-in provider may carry its own per-provider key (override).
  const override = providerOverrideFor(cfg.providerOverrides, cfg.provider);
  if (override?.apiKey || override?.hasApiKey) return true;
  return false;
}

/**
 * True when one provider is usable from the model dropdown and shows 已配置 on
 * the Settings → LLM card: it must have a Base URL plus either an API key
 * (keyed built-in or custom provider) or be a keyless local endpoint
 * (Ollama / LM Studio need no key). A provider missing its endpoint or its
 * key is 未配置 — a key without a Base URL is unusable, and vice versa.
 */
export function providerHasKey(cfg: PureConfig, id: string): boolean {
  const custom = customProviderFor(cfg.customProviders ?? [], id);
  if (custom) {
    if (!custom.baseURL) return false;
    return !!custom.apiKey || custom.hasApiKey === true || custom.local === true;
  }
  const override = providerOverrideFor(cfg.providerOverrides, id);
  // Built-ins always carry a default endpoint; an override may blank it.
  const baseURL = override?.baseURL ?? providerDef(id)?.baseURL ?? '';
  if (!baseURL) return false;
  return !!cfg.apiKey || cfg.hasApiKey === true || !!override?.apiKey || override?.hasApiKey === true;
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

/** Fire-and-forget write of the config to ~/.pure/config.json (desktop). The
 * WebView mirrors the file into localStorage at startup and writes it back on
 * every save, so a user who hand-edits config.json sees the change after the
 * next launch. Secrets are never in this object — autoSave scrubs them first. */
async function saveConfigToRust(cfg: PureConfig): Promise<void> {
  if (!isTauriRuntime()) return;
  const core = await loadTauriCore();
  if (!core) return;
  try {
    await core.invoke('save_config', { config: cfg });
  } catch (e) {
    console.warn('[pure] failed to save config file:', e);
  }
}

/**
 * Single choke point for persisting a changed config: writes localStorage
 * (runtime + browser mirror), drops the cache, and mirrors to the desktop
 * config file. Every settings/main write should go through here instead of
 * a raw localStorage.setItem so the file stays in sync.
 */
export function persistConfig(cfg: PureConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch { /* ignore */ }
  invalidateConfigCache();
  if (isTauriRuntime()) void saveConfigToRust(cfg);
}

/**
 * Desktop startup: make ~/.pure/config.json the source of truth for this
 * launch. If the file exists, mirror it into localStorage (where the sync
 * loadConfig() reads) so a hand edit applies now; if it doesn't, seed it from
 * the existing localStorage config (one-time migration). Browser mode is a
 * no-op — localStorage is the only store there.
 */
export async function initConfigFile(): Promise<void> {
  if (!isTauriRuntime()) return;
  const core = await loadTauriCore();
  if (!core) return;
  try {
    const fileCfg = await core.invoke<unknown>('load_config');
    if (fileCfg != null) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fileCfg));
      invalidateConfigCache();
    } else {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          await core.invoke('save_config', { config: JSON.parse(raw) });
        } catch { /* ignore */ }
      }
    }
  } catch (err) {
    console.warn('[pure] config file init failed:', err);
  }
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
      void syncSecretToRust(SECRET_KEY, cfg.apiKey);
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
      // Config v4 migration: third-party hub skills (Settings → Skills →
      // Skill Hub) were added. Legacy configs simply start with an empty list.
      if ((parsed.configVersion ?? 1) < 4) {
        cfg.hubSkills = Array.isArray(cfg.hubSkills) ? cfg.hubSkills : [];
        cfg.configVersion = 4;
        needsPersist = true;
      }
      // Config v5 migration: custom providers (Settings → LLM → 添加自定义供应商)
      // were added. Legacy configs start with an empty list.
      if ((parsed.configVersion ?? 1) < 5) {
        cfg.customProviders = Array.isArray(cfg.customProviders) ? cfg.customProviders : [];
        cfg.configVersion = 5;
        needsPersist = true;
      }
      if ((parsed.configVersion ?? 1) < 7) {
        const legacyProxy = normalizeProxyConfig(parsed.proxy);
        // v6 defaults accidentally persisted enabled=true with an empty URL.
        // Treat that shape as the old default, not as an explicit opt-in; a
        // configured proxy URL remains enabled during migration.
        if (!String(parsed.proxy?.url ?? '').trim()) legacyProxy.enabled = false;
        cfg.proxy = legacyProxy;
        cfg.configVersion = 7;
        needsPersist = true;
      } else {
        cfg.proxy = normalizeProxyConfig(cfg.proxy);
      }
      // Config v8: built-in providers gained the same multi-model editor as
      // custom providers. Seed the active provider from the old single model
      // field so existing configurations keep their selected model.
      if ((parsed.configVersion ?? 1) < 8) {
        const lists = normalizeProviderModels(parsed.providerModels);
        const activeModel = typeof cfg.model === 'string' ? cfg.model.trim() : '';
        if (activeModel && !customProviderFor(cfg.customProviders, cfg.provider)) {
          lists[cfg.provider] = uniqueModels([activeModel, ...(lists[cfg.provider] ?? [])]);
        }
        cfg.providerModels = lists;
        cfg.configVersion = 8;
        needsPersist = true;
      } else {
        cfg.providerModels = normalizeProviderModels(cfg.providerModels);
      }
      // Config v9: MCP tool prefix filtering (Settings → MCP → excluded
      // prefixes). Legacy configs start with nothing excluded.
      if ((parsed.configVersion ?? 1) < 9) {
        cfg.mcpExcludedPrefixes = Array.isArray(cfg.mcpExcludedPrefixes) ? cfg.mcpExcludedPrefixes : [];
        cfg.configVersion = 9;
        needsPersist = true;
      }
      // Config v10: built-in providers gained editable name / Base URL / key
      // overrides (providerOverrides). Before v10 the GUI kept a single global
      // baseURL that hijacked EVERY provider's endpoint once filled (the form
      // prefilled it and chat.ts preferred it over the registry URL) — a
      // stale value like a DashScope URL would show on DeepSeek/GLM cards and
      // route every request to it. Migrate a non-default leftover to the
      // provider it was most recently edited for, then scrub the global field
      // so the registry URLs take over again; the user can still override any
      // built-in per provider in the connection drawer.
      if ((parsed.configVersion ?? 1) < 10) {
        cfg.providerOverrides = { ...(cfg.providerOverrides ?? {}) };
        const legacy = typeof parsed.baseURL === 'string' ? parsed.baseURL.trim() : '';
        const isBuiltin = isProviderId(String(cfg.provider));
        const matchesAnyDefault = PROVIDERS.some((p) => p.baseURL === legacy);
        if (legacy && isBuiltin && !matchesAnyDefault && !cfg.providerOverrides[String(cfg.provider)]?.baseURL) {
          cfg.providerOverrides[String(cfg.provider)] = {
            ...cfg.providerOverrides[String(cfg.provider)],
            baseURL: legacy,
          };
        }
        cfg.baseURL = '';
        cfg.configVersion = 10;
        needsPersist = true;
      } else {
        cfg.providerOverrides = { ...(cfg.providerOverrides ?? {}) };
      }
      // Config v11: after the v10 hijack fix, scrub leftover built-in override
      // endpoints that are NOT deliberate. A user-set endpoint would never be
      // one of our own registry URLs (case / whitespace / trailing-slash
      // variants included), and a cross-provider default (e.g. a DashScope
      // URL sitting on DeepSeek, or a trailing-slash copy of the v10
      // migration) is exactly the contamination the fix targeted. Removing
      // them makes every built-in card show its official endpoint again;
      // per-provider overrides entered in the connection drawer stay.
      if ((parsed.configVersion ?? 1) < 11) {
        const overrides = { ...(cfg.providerOverrides ?? {}) };
        const normalize = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();
        const registryURLs = new Set(PROVIDERS.map((p) => normalize(p.baseURL)));
        for (const [pid, ovr] of Object.entries(overrides)) {
          if (!ovr?.baseURL) continue;
          if (!registryURLs.has(normalize(ovr.baseURL))) continue;
          const next = { ...ovr };
          delete next.baseURL;
          if (!next.name && !next.apiKey && !next.hasApiKey) delete overrides[pid];
          else overrides[pid] = next;
        }
        cfg.providerOverrides = overrides;
        cfg.baseURL = ''; // belt-and-suspenders: the global field stays empty
        cfg.configVersion = 11;
        needsPersist = true;
      } else {
        cfg.providerOverrides = { ...(cfg.providerOverrides ?? {}) };
      }
      // Config v12: the registry treats DeepSeek as ONE provider (its
      // OpenAI-compatible entry); the separate 'deepseek-anthropic' id is
      // retired. Merge its model list / override into 'deepseek-openai' so
      // existing configs keep working, then drop the stale id everywhere.
      // Lazy: configs that never used the anthropic id are not rewritten.
      if ((parsed.configVersion ?? 1) < 12) {
        const hadAnthropic = String(cfg.provider) === 'deepseek-anthropic'
          || !!cfg.providerModels?.['deepseek-anthropic']
          || !!cfg.providerOverrides?.['deepseek-anthropic'];
        if (String(cfg.provider) === 'deepseek-anthropic') cfg.provider = 'deepseek-openai';
        if (cfg.providerModels?.['deepseek-anthropic']) {
          const merged = uniqueModels([
            ...(cfg.providerModels['deepseek-openai'] ?? []),
            ...cfg.providerModels['deepseek-anthropic'],
          ]);
          cfg.providerModels = { ...cfg.providerModels, 'deepseek-openai': merged };
          delete cfg.providerModels['deepseek-anthropic'];
        }
        if (cfg.providerOverrides?.['deepseek-anthropic']) {
          const merged = { ...(cfg.providerOverrides['deepseek-openai'] ?? {}), ...cfg.providerOverrides['deepseek-anthropic'] };
          cfg.providerOverrides = { ...cfg.providerOverrides };
          delete cfg.providerOverrides['deepseek-anthropic'];
          if (merged.name || merged.baseURL || merged.apiKey || merged.hasApiKey) {
            cfg.providerOverrides['deepseek-openai'] = merged;
          }
        }
        cfg.configVersion = 12;
        if (hadAnthropic) needsPersist = true;
      }
      // Config v13: long-task auto-continue (autoContinue /
      // autoContinueMaxRounds, Settings → General). Purely additive — legacy
      // configs keep running with the default (off); the bump just records the
      // schema so future migrations can assume the fields exist.
      if ((parsed.configVersion ?? 1) < 13) {
        cfg.configVersion = 13;
        needsPersist = true;
      }
      if (isTauriRuntime() && cfg.apiKey) {
        // Legacy migration: move a key previously persisted to localStorage
        // into Rust secrets, then scrub it.
        void syncSecretToRust(SECRET_KEY, cfg.apiKey);
        cfg.hasApiKey = true;
        cfg.apiKey = '';
        needsPersist = true;
      }
      if (isTauriRuntime() && cfg.proxy?.password) {
        // Lazy migration: a proxy password previously persisted to
        // localStorage moves into Rust secrets (slot `proxy.password`), and
        // the plaintext is scrubbed from the saved config.
        void syncSecretToRust(PROXY_PASSWORD_SECRET_KEY, cfg.proxy.password);
        cfg.proxy = { ...cfg.proxy, hasPassword: true, password: '' };
        needsPersist = true;
      }
      if (needsPersist) {
        persistConfig(cfg);
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
  await syncSecretToRust(SECRET_KEY, value);
}

export async function revokeSecretFromRust(): Promise<void> {
  await deleteSecretFromRust(SECRET_KEY);
}

/** Rust secrets slot holding the proxy password (desktop only). */
export const PROXY_PASSWORD_SECRET_KEY = 'proxy.password';

export async function storeProxyPasswordInRust(value: string): Promise<void> {
  await syncSecretToRust(PROXY_PASSWORD_SECRET_KEY, value);
}

export async function revokeProxyPasswordFromRust(): Promise<void> {
  await deleteSecretFromRust(PROXY_PASSWORD_SECRET_KEY);
}

/** Rust secrets key under which a provider's own API key is stored
 *  ('llm.apiKey.<id>' — custom providers and per-provider built-in keys). */
export function customSecretKey(id: string): string {
  return `llm.apiKey.${id}`;
}

export async function storeCustomSecretInRust(id: string, value: string): Promise<void> {
  await syncSecretToRust(customSecretKey(id), value);
}

export async function revokeCustomSecretFromRust(id: string): Promise<void> {
  await deleteSecretFromRust(customSecretKey(id));
}
