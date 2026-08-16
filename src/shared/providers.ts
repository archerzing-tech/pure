// src/shared/providers.ts
import type { ToolDefinition } from './types';

// Declarative registry of supported LLM providers — the single source of
// truth for provider ids, display labels and default models, shared by the
// GUI (settings panel, sidebar, chat) and the CLI so the values never drift.
//
// Adding a new provider is a one-file change: add an entry here, its i18n
// labels in shared/i18n.ts and — if it should appear in the GUI dropdown — a
// matching <option> in index.html.

export type ProviderId =
  | 'deepseek-openai'
  | 'qwen'
  | 'glm'
  | 'moonshot'
  | 'minimax'
  | 'openai'
  | 'openrouter'
  | 'nvidia';

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
  if (id === 'moonshot' || name.includes('kimi')) return { contextWindowTokens: 128_000, outputReserveTokens: 8_192 };
  if (id === 'minimax' || name.includes('minimax')) return { contextWindowTokens: 128_000, outputReserveTokens: 8_192 };
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
  /** Optional display names per model id (model id → human label). */
  modelNames?: Record<string, string>;
  /** Default model used when config.model is empty. */
  defaultModel: string;
  /** API key when the endpoint requires one; empty = keyless (local). */
  apiKey: string;
  /** True when the key lives in Rust secrets (desktop) instead of storage. */
  hasApiKey: boolean;
  /** True for local endpoints (Ollama / LM Studio) that need no API key. */
  local?: boolean;
  /**
   * True when this provider exposes an OpenAI-compatible text-to-image API
   * (`/images/generations`). When enabled, the GUI registers a generate_image
   * tool and tells the model to use it for image requests instead of ```svg
   * blocks (which remain the automatic fallback when disabled / unavailable).
   */
  imageGen?: boolean;
  /**
   * The provider's text-to-image model id (e.g. 'gpt-image-1', 'dall-e-3').
   * When unset but imageGen is true, the chat model itself is used if its name
   * looks like an image model, otherwise 'gpt-image-1'.
   */
  imageGenModel?: string;
}

/**
 * Per-provider overrides for BUILT-IN providers (config v10). Custom providers
 * already carry their own name/baseURL/key on their entry, so this map only
 * holds user edits for the built-ins (deepseek-openai / qwen / glm, …): a
 * custom display name, a custom endpoint (proxy / mirror), and a per-provider
 * API key. Desktop keys live in Rust secrets under `llm.apiKey.<id>` (same
 * slot scheme as custom providers) and never round-trip through storage.
 */
export interface ProviderOverride {
  /** Custom display name shown on the card / summary instead of the i18n label. */
  name?: string;
  /** Custom OpenAI-compatible base URL overriding the registry default. */
  baseURL?: string;
  /** Browser-mode per-provider API key (desktop keeps it in Rust secrets). */
  apiKey?: string;
  /** True when the key lives in Rust secrets under `llm.apiKey.<id>`. */
  hasApiKey?: boolean;
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
  // The OpenAI API key also authorizes the Images API, so the preset ships
  // with text-to-image enabled (gpt-image-1) — image requests then render as
  // real <img> cards instead of SVG. Users can turn it off or pick dall-e-3.
  imageGen: true,
  imageGenModel: 'gpt-image-1',
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
  /**
   * Default model library shown when the user hasn't customized the list yet
   * (Settings → LLM → provider card → 模型库). First entry == defaultModel.
   */
  models: string[];
  /** i18n key for the full display name in settings dropdowns. */
  i18nKey: string;
  /** Default base URL for the OpenAI-compatible HTTP fallback (browser mode). */
  baseURL: string;
  /**
   * DeepSeek-family providers share the same API base / budget tuning; other
   * providers get their own (larger) token budget (see ui/chat.ts).
   */
  deepSeekFamily: boolean;
  /**
   * Built-in text-to-image model (OpenAI /images/generations). When set, the
   * provider exposes the generate_image tool like a custom provider with
   * imageGen enabled.
   */
  imageGenModel?: string;
}

export const PROVIDERS: readonly ProviderDef[] = [
  { id: 'deepseek-openai', label: 'DeepSeek', defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-reasoner'], i18nKey: 'provider.deepseek-openai', baseURL: 'https://api.deepseek.com', deepSeekFamily: true },
  { id: 'qwen', label: 'Qwen', defaultModel: 'qwen3-coder-next', models: ['qwen3-coder-next', 'qwen3-max'], i18nKey: 'provider.qwen', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', deepSeekFamily: false },
  { id: 'glm', label: 'GLM', defaultModel: 'glm-5.2', models: ['glm-5.2', 'glm-5.2-flash'], i18nKey: 'provider.glm', baseURL: 'https://open.bigmodel.cn/api/paas/v4', deepSeekFamily: false },
  { id: 'moonshot', label: 'Moonshot', defaultModel: 'kimi-k3', models: ['kimi-k3', 'kimi-k2.6'], i18nKey: 'provider.moonshot', baseURL: 'https://api.moonshot.cn/v1', deepSeekFamily: false },
  { id: 'minimax', label: 'MiniMax', defaultModel: 'MiniMax-M2.7', models: ['MiniMax-M2.7', 'MiniMax-M2'], i18nKey: 'provider.minimax', baseURL: 'https://api.minimaxi.com/v1', deepSeekFamily: false },
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.2', models: ['gpt-5.2', 'gpt-4o-mini', 'o3-mini'], i18nKey: 'provider.openai', baseURL: 'https://api.openai.com/v1', deepSeekFamily: false, imageGenModel: 'gpt-image-1' },
  { id: 'openrouter', label: 'OpenRouter', defaultModel: 'openai/gpt-4o-mini', models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4', 'deepseek/deepseek-r1'], i18nKey: 'provider.openrouter', baseURL: 'https://openrouter.ai/api/v1', deepSeekFamily: false },
  { id: 'nvidia', label: 'NVIDIA', defaultModel: 'meta/llama-3.1-8b-instruct', models: ['meta/llama-3.1-8b-instruct', 'deepseek-ai/deepseek-r1', 'mistralai/mixtral-8x7b-instruct'], i18nKey: 'provider.nvidia', baseURL: 'https://integrate.api.nvidia.com/v1', deepSeekFamily: false },
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

/** Find a built-in provider override by id (undefined when absent). */
export function providerOverrideFor(
  overrides: Record<string, ProviderOverride> | undefined | null,
  id: string | undefined | null,
): ProviderOverride | undefined {
  if (!overrides || !id) return undefined;
  const override = overrides[id];
  if (!override) return undefined;
  // An all-empty override is a stale tombstone — treat it as absent.
  if (!override.name && !override.baseURL && !override.apiKey && !override.hasApiKey) {
    return undefined;
  }
  return override;
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

// ── Text-to-image capability (generate_image tool) ──
// The GUI exposes an image-generation tool only when the connected provider /
// model actually supports it. Detection is (1) an explicit per-provider
// setting, or (2) an image-capable model name (gpt-image-*, dall-e-*, cogview*,
// flux*, gemini-*-image, …). When it is OFF — the default for DeepSeek / Qwen /
// GLM and most custom endpoints — models answer image requests with ```svg
// blocks (the SVG output contract), which stays the universal fallback.

/** Model-name patterns that indicate the model itself can generate images. */
const IMAGE_MODEL_PATTERN =
  /(?:gpt-image|dall-e|dall_e|image-1|cogview|flux|sdxl|stable-diffusion|nano-banana|imagen|gemini-[0-9.]+-[a-z-]*image|imagegen)/i;

/** True when a model id looks like a text-to-image model. */
export function isImageModelName(model: string | undefined | null): boolean {
  return !!model && IMAGE_MODEL_PATTERN.test(model.trim());
}

/**
 * True when the connected provider/model should expose the generate_image
 * tool: the custom provider explicitly enables it, or the active model name
 * matches an image-capable model. Built-in providers (deepseek/qwen/glm) only
 * light up via the model-name rule (e.g. cogview / flux names).
 */
export function imageGenEnabled(
  customs: readonly CustomProvider[] | undefined | null,
  provider: string | undefined | null,
  model: string | undefined | null,
): boolean {
  const custom = customProviderFor(customs, provider);
  if (custom?.imageGen === true) return true;
  if (custom?.imageGenModel?.trim()) return true;
  if (providerDef(provider)?.imageGenModel?.trim()) return true;
  return isImageModelName(model);
}

/**
 * The text-to-image model id used by generate_image: the provider's explicit
 * imageGenModel, else the chat model itself when it is image-capable, else the
 * provider default ('gpt-image-1'). Only meaningful when imageGenEnabled().
 */
export function imageGenModelFor(
  customs: readonly CustomProvider[] | undefined | null,
  provider: string | undefined | null,
  model: string | undefined | null,
): string {
  const custom = customProviderFor(customs, provider);
  const explicit = custom?.imageGenModel?.trim();
  if (explicit) return explicit;
  const builtin = providerDef(provider)?.imageGenModel?.trim();
  if (builtin) return builtin;
  if (isImageModelName(model)) return model!.trim();
  return 'gpt-image-1';
}

/** Display label for a provider id, resolving custom providers by name. */
export function customProviderLabel(
  customs: readonly CustomProvider[] | undefined | null,
  id: string | undefined | null,
  overrides?: Record<string, ProviderOverride> | null,
): string {
  return customProviderFor(customs, id)?.name
    ?? providerOverrideFor(overrides, id)?.name
    ?? providerLabel(id);
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
  overrides?: Record<string, ProviderOverride> | null,
): string {
  return customProviderFor(customs, id)?.baseURL
    ?? providerOverrideFor(overrides, id)?.baseURL
    ?? baseURLFor(id ?? '');
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
