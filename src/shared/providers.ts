// src/shared/providers.ts
// Declarative registry of supported LLM providers — the single source of
// truth for provider ids, display labels and default models, shared by the
// GUI (settings panel, sidebar, chat) and the CLI so the values never drift.
//
// Adding a new provider is a one-file change: add an entry here, its i18n
// labels in shared/i18n.ts and — if it should appear in the GUI dropdown — a
// matching <option> in index.html.

export type ProviderId = 'deepseek-openai' | 'deepseek-anthropic' | 'qwen' | 'glm';

/**
 * A user-defined OpenAI-compatible provider (Settings → LLM → 添加自定义供应商).
 * Unlike the built-in registry above, custom providers are persisted per-user
 * (GUI: PureConfig.customProviders in localStorage; CLI: ~/.pure/config.json)
 * and may be keyless — local endpoints like Ollama / LM Studio need no API key,
 * in which case the Authorization header is omitted entirely.
 */
export interface CustomProvider {
  /** Stable slug used as the provider id (e.g. 'ollama', 'openrouter'). */
  id: string;
  /** Display name (e.g. 'Ollama (local)'). */
  name: string;
  /** OpenAI-compatible base URL (e.g. http://localhost:11434/v1). */
  baseURL: string;
  /** Suggested models, comma-separated in the settings form. */
  models: string[];
  /** Default model used when config.model is empty. */
  defaultModel: string;
  /** API key when the endpoint requires one; empty = keyless (local). */
  apiKey: string;
  /** True when the key lives in Rust secrets (desktop) instead of storage. */
  hasApiKey: boolean;
}

/**
 * One-click Ollama preset (Settings → LLM → Ollama 一键预设). Uses the
 * OpenAI-compatible endpoint of a local Ollama daemon (default port 11434) and
 * a set of common coding-oriented tags — the user can edit models later.
 */
export const OLLAMA_PRESET: CustomProvider = {
  id: 'ollama',
  name: 'Ollama (local)',
  baseURL: 'http://localhost:11434/v1',
  models: ['qwen2.5-coder:7b', 'llama3.1:8b', 'deepseek-r1:8b'],
  defaultModel: 'qwen2.5-coder:7b',
  apiKey: '',
  hasApiKey: false,
};

export interface ProviderDef {
  id: ProviderId;
  /** Short label for the sidebar / status bar / context panel. */
  label: string;
  /** Default model used when config.model is empty (placeholder + fallback). */
  defaultModel: string;
  /** i18n key for the full display name in settings dropdowns. */
  i18nKey: string;
  /** Default base URL for the OpenAI-compatible HTTP fallback (browser mode). */
  baseURL: string;
  /**
   * DeepSeek-family providers share the same API base / budget tuning; other
   * providers get their own (larger) token budget (see ui/chat.ts).
   */
  deepSeekFamily: boolean;
}

export const PROVIDERS: readonly ProviderDef[] = [
  { id: 'deepseek-openai', label: 'DeepSeek', defaultModel: 'deepseek-v4-flash', i18nKey: 'provider.deepseek-openai', baseURL: 'https://api.deepseek.com', deepSeekFamily: true },
  { id: 'deepseek-anthropic', label: 'DeepSeek', defaultModel: 'deepseek-v4-flash', i18nKey: 'provider.deepseek-anthropic', baseURL: 'https://api.deepseek.com', deepSeekFamily: true },
  { id: 'qwen', label: 'Qwen', defaultModel: 'qwen3-coder-next', i18nKey: 'provider.qwen', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', deepSeekFamily: false },
  { id: 'glm', label: 'GLM', defaultModel: 'glm-5.2', i18nKey: 'provider.glm', baseURL: 'https://open.bigmodel.cn/api/paas/v4', deepSeekFamily: false },
];

const PROVIDER_BY_ID = new Map<string, ProviderDef>(PROVIDERS.map((p) => [p.id, p]));

/** True when `value` is a known provider id (narrows to ProviderId). */
export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_BY_ID.has(value);
}

// ── Custom-provider resolution (built-ins + user-defined, same lookups) ──

/** Find a custom provider by id (undefined when absent). */
export function customProviderFor(
  customs: readonly CustomProvider[] | undefined | null,
  id: string | undefined | null,
): CustomProvider | undefined {
  if (!customs || !id) return undefined;
  return customs.find((p) => p.id === id);
}

/** True when `id` refers to a user-defined custom provider. */
export function isCustomProviderId(
  customs: readonly CustomProvider[] | undefined | null,
  id: string | undefined | null,
): boolean {
  return !!customProviderFor(customs, id);
}

/** Display label for a provider id, resolving custom providers by name. */
export function customProviderLabel(
  customs: readonly CustomProvider[] | undefined | null,
  id: string | undefined | null,
): string {
  return customProviderFor(customs, id)?.name ?? providerLabel(id);
}

/** Default model for a provider id, custom-aware; falls back to built-in. */
export function customDefaultModel(
  customs: readonly CustomProvider[] | undefined | null,
  id: string | undefined | null,
): string {
  return customProviderFor(customs, id)?.defaultModel ?? defaultModelFor(id ?? '');
}

/** Base URL for a provider id, custom-aware; falls back to built-in. */
export function customBaseURL(
  customs: readonly CustomProvider[] | undefined | null,
  id: string | undefined | null,
): string {
  return customProviderFor(customs, id)?.baseURL ?? baseURLFor(id ?? '');
}

/**
 * True when the provider is a custom, keyless endpoint (Ollama / LM Studio):
 * sending works without any API key — the Authorization header is omitted.
 */
export function isCustomKeyless(
  customs: readonly CustomProvider[] | undefined | null,
  id: string | undefined | null,
): boolean {
  const custom = customProviderFor(customs, id);
  return !!custom && !custom.apiKey && !custom.hasApiKey;
}

export function providerDef(id: string | undefined | null): ProviderDef | undefined {
  return id ? PROVIDER_BY_ID.get(id) : undefined;
}

/** Short display label ('DeepSeek', 'Qwen', …) or the raw id when unknown. */
export function providerLabel(id: string | undefined | null): string {
  return providerDef(id)?.label ?? (id || '');
}

/** Default model for a provider; falls back to the DeepSeek default. */
export function defaultModelFor(id: string): string {
  return providerDef(id)?.defaultModel ?? 'deepseek-v4-flash';
}

/** Default base URL for a provider; falls back to the DeepSeek endpoint. */
export function baseURLFor(id: string): string {
  return providerDef(id)?.baseURL ?? 'https://api.deepseek.com';
}

/** True for the deepseek-* providers (shared API base / budget tuning). */
export function isDeepSeekFamily(id: string | undefined | null): boolean {
  return providerDef(id)?.deepSeekFamily ?? false;
}
