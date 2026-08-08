// src/shared/providers.ts
// Declarative registry of supported LLM providers — the single source of
// truth for provider ids, display labels and default models, shared by the
// GUI (settings panel, sidebar, chat) and the CLI so the values never drift.
//
// Adding a new provider is a one-file change: add an entry here, its i18n
// labels in shared/i18n.ts and — if it should appear in the GUI dropdown — a
// matching <option> in index.html.

export type ProviderId = 'deepseek-openai' | 'deepseek-anthropic' | 'qwen' | 'glm';

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
