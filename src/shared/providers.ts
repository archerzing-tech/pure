// src/shared/providers.ts
import type { ToolDefinition } from './types';

// Declarative registry of supported LLM providers — the single source of
// truth for provider ids, display labels and default models, shared by the
// GUI (settings panel, sidebar, chat) and the CLI so the values never drift.
//
// Adding a new provider is a one-file change: add an entry here, its i18n
// labels in shared/i18n.ts and — if it should appear in the GUI dropdown — a
// matching <option> in index.html.

export type ProviderId = 'deepseek-openai' | 'deepseek-anthropic' | 'qwen' | 'glm';

export interface PromptBudgetConfig {
  provider?: string;
  model?: string;
  contextWindowTokens?: number;
  outputReserveTokens?: number;
  safetyMarginTokens?: number;
  /** Tokens already consumed by an assembled system prompt. */
  usedInputTokens?: number;
}

export interface ResolvedPromptBudget {
  provider?: string;
  model?: string;
  contextWindowTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  availableInputTokens: number;
  source: 'override' | 'provider-model' | 'fallback';
}

const PROMPT_BUDGET_FALLBACK = {
  contextWindowTokens: 32_768,
  outputReserveTokens: 4_096,
  safetyMarginTokens: 1_024,
};

function promptBudgetDefaults(provider: string, model: string): { contextWindowTokens: number; outputReserveTokens: number } | undefined {
  const id = provider.toLowerCase();
  const name = model.toLowerCase();
  if (id.includes('deepseek') || name.includes('deepseek')) return { contextWindowTokens: 64_000, outputReserveTokens: 32_768 };
  if (id === 'qwen' || name.includes('qwen')) return { contextWindowTokens: 128_000, outputReserveTokens: 8_192 };
  if (id === 'glm' || name.includes('glm')) return { contextWindowTokens: 128_000, outputReserveTokens: 8_192 };
  if (name.includes('claude') || id.includes('anthropic')) return { contextWindowTokens: 200_000, outputReserveTokens: 8_192 };
  if (name.includes('o1') || name.includes('o3') || name.includes('gpt-4o')) return { contextWindowTokens: 128_000, outputReserveTokens: 8_192 };
  if (id === 'ollama' || id === 'lmstudio' || name.includes('llama')) return { contextWindowTokens: 32_768, outputReserveTokens: 4_096 };
  return undefined;
}

export function resolvePromptBudget(config: PromptBudgetConfig = {}): ResolvedPromptBudget {
  const provider = config.provider?.trim() || undefined;
  const model = config.model?.trim() || undefined;
  const defaults = provider || model
    ? promptBudgetDefaults(provider ?? '', model ?? '')
    : undefined;
  const hasOverride = config.contextWindowTokens !== undefined
    || config.outputReserveTokens !== undefined
    || config.safetyMarginTokens !== undefined;
  const contextWindowTokens = Math.max(1, config.contextWindowTokens ?? defaults?.contextWindowTokens ?? PROMPT_BUDGET_FALLBACK.contextWindowTokens);
  const outputReserveTokens = Math.max(0, Math.min(
    config.outputReserveTokens ?? defaults?.outputReserveTokens ?? PROMPT_BUDGET_FALLBACK.outputReserveTokens,
    contextWindowTokens,
  ));
  const safetyMarginTokens = Math.max(0, Math.min(
    config.safetyMarginTokens ?? PROMPT_BUDGET_FALLBACK.safetyMarginTokens,
    Math.max(0, contextWindowTokens - outputReserveTokens),
  ));
  const availableInputTokens = Math.max(
    1,
    contextWindowTokens - outputReserveTokens - safetyMarginTokens - Math.max(0, config.usedInputTokens ?? 0),
  );
  return {
    provider,
    model,
    contextWindowTokens,
    outputReserveTokens,
    safetyMarginTokens,
    availableInputTokens,
    source: hasOverride ? 'override' : defaults ? 'provider-model' : 'fallback',
  };
}

/** Fast, conservative estimate shared by prompt and history budgets. */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate the tokens sent outside the messages array for function/tool
 * schemas. Providers serialize these definitions separately, so message-only
 * accounting is not enough to protect a real context window.
 */
export function estimateToolDefinitionTokens(tools: readonly ToolDefinition[] = []): number {
  if (tools.length === 0) return 0;
  return estimatePromptTokens(JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }))));
}

/**
 * A user-defined OpenAI-compatible provider (Settings → LLM → 添加自定义供应商).
 * Unlike the built-in registry above, custom providers are persisted per-user
 * (GUI: PureConfig.customProviders in localStorage; CLI: ~/.pure/config.json)
 * and may be keyless — local endpoints like Ollama / LM Studio need no API key,
 * in which case the Authorization header is omitted entirely.
 */
export interface CustomProvider {
  /** Optional provider/model-specific context metadata for custom endpoints. */
  contextWindowTokens?: number;
  outputReserveTokens?: number;
  safetyMarginTokens?: number;
  modelBudgets?: Record<string, {
    contextWindowTokens?: number;
    outputReserveTokens?: number;
    safetyMarginTokens?: number;
  }>;
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
  /** True for local endpoints (Ollama / LM Studio) that need no API key. */
  local?: boolean;
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
  local: true,
};

/**
 * Quick-add presets for popular OpenAI-compatible cloud endpoints (Settings →
 * LLM → 快捷预设). Each is a plain CustomProvider the user can tweak before
 * saving; keyed entries (OpenAI / OpenRouter / NVIDIA NIM) need an API key,
 * local Ollama works keyless.
 */
export const OPENAI_PRESET: CustomProvider = {
  id: 'openai',
  name: 'OpenAI',
  baseURL: 'https://api.openai.com/v1',
  models: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
  defaultModel: 'gpt-4o-mini',
  apiKey: '',
  hasApiKey: false,
};

export const OPENROUTER_PRESET: CustomProvider = {
  id: 'openrouter',
  name: 'OpenRouter',
  baseURL: 'https://openrouter.ai/api/v1',
  models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4', 'deepseek/deepseek-r1'],
  defaultModel: 'openai/gpt-4o-mini',
  apiKey: '',
  hasApiKey: false,
};

export const NVIDIA_PRESET: CustomProvider = {
  id: 'nvidia',
  name: 'NVIDIA NIM',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  models: ['meta/llama-3.1-8b-instruct', 'deepseek-ai/deepseek-r1', 'mistralai/mixtral-8x7b-instruct'],
  defaultModel: 'meta/llama-3.1-8b-instruct',
  apiKey: '',
  hasApiKey: false,
};

/** All one-click presets (Settings → LLM → 快捷预设), keyed by slug. */
export const CUSTOM_PRESETS: readonly CustomProvider[] = [
  OLLAMA_PRESET,
  OPENAI_PRESET,
  OPENROUTER_PRESET,
  NVIDIA_PRESET,
];

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

/** Build a budget input from persisted custom-provider metadata. */
export function promptBudgetForProvider(
  customs: readonly CustomProvider[] | undefined | null,
  provider: string | undefined,
  model: string | undefined,
): PromptBudgetConfig {
  const custom = customProviderFor(customs, provider);
  const normalizedModel = model?.trim() || undefined;
  const modelOverride = normalizedModel ? custom?.modelBudgets?.[normalizedModel] : undefined;
  return {
    provider,
    model: normalizedModel,
    contextWindowTokens: modelOverride?.contextWindowTokens ?? custom?.contextWindowTokens,
    outputReserveTokens: modelOverride?.outputReserveTokens ?? custom?.outputReserveTokens,
    safetyMarginTokens: modelOverride?.safetyMarginTokens ?? custom?.safetyMarginTokens,
  };
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
