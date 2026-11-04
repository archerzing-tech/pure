// src/shared/providers.ts
import type { ToolDefinition } from './types';
import { estimateTextTokens } from './tokenEstimate';
import { modelCapabilitySummary, resolveModelCapability } from './modelCapabilities';
import type { ProbedCapability } from './capabilityProbe';
import { probedCapabilityKey } from './capabilityProbe';

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
  | 'anthropic'
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
  /** W1b-1 自探测的缓存读数（config.json `capabilityProbes`）。插在
   * manifest 之后、保守回落之前——探测只填 manifest 的空档，不推翻族
   * 知识（一次探测读数不该盖过厂商策展值）。 */
  probedBudget?: { contextWindowTokens: number; outputReserveTokens?: number };
}

export interface ResolvedPromptBudget {
  provider?: string;
  model?: string;
  contextWindowTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  availableInputTokens: number;
  source: 'override' | 'provider-model' | 'probed' | 'fallback';
}

const PROMPT_BUDGET_FALLBACK = {
  contextWindowTokens: 32_768,
  outputReserveTokens: 4_096,
  safetyMarginTokens: 1_024,
};

/** Output reserve may claim at most this share of the window; the rest stays input. */
const OUTPUT_RESERVE_MAX_SHARE = 0.75;

/**
 * Per-family budget defaults = each model generation's published maximums
 * (blank settings input inherits these). The knowledge now lives in the
 * capability manifest (src/shared/modelCapabilities.ts) — one ordered rule
 * table shared with the reasoning/vision traits, so adding a model generation
 * is a data edit instead of a third hand-written branch. Verified against
 * 2026-08 vendor docs; where a ceiling claim came from a single source the
 * request cap sits one safe tier below it, because max_tokens is validated
 * server-side and an over-ceiling cap fails EVERY request.
 */
function promptBudgetDefaults(provider: string, model: string): { contextWindowTokens: number; outputReserveTokens: number } | undefined {
  return resolveModelCapability(provider, model).budget;
}

/** Effective budget defaults for the settings placeholders: the model
 * family's published maximums, or the conservative fallback for unknown
 * models. Blank settings inputs inherit exactly these numbers. */
export function promptBudgetDefaultFor(provider: string, model: string): { contextWindowTokens: number; outputReserveTokens: number } {
  const defaults = promptBudgetDefaults(provider, model);
  return {
    contextWindowTokens: defaults?.contextWindowTokens ?? PROMPT_BUDGET_FALLBACK.contextWindowTokens,
    outputReserveTokens: defaults?.outputReserveTokens ?? PROMPT_BUDGET_FALLBACK.outputReserveTokens,
  };
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
  const contextWindowTokens = Math.max(1, config.contextWindowTokens ?? defaults?.contextWindowTokens ?? config.probedBudget?.contextWindowTokens ?? PROMPT_BUDGET_FALLBACK.contextWindowTokens);
  // At least a quarter of the window must stay available for input. An
  // output reserve equal to the whole window — a mis-paired combination,
  // e.g. a 128_000 provider-level window override meeting glm's 128_000
  // default reserve — resolves to availableInputTokens = 1 and strips every
  // assembled fragment. No shipped default exceeds this share (the highest
  // is minimax at 64%), so the cap only fires on mis-paired overrides.
  const outputReserveTokens = Math.max(0, Math.min(
    config.outputReserveTokens ?? defaults?.outputReserveTokens ?? config.probedBudget?.outputReserveTokens ?? PROMPT_BUDGET_FALLBACK.outputReserveTokens,
    Math.max(1, Math.floor(contextWindowTokens * OUTPUT_RESERVE_MAX_SHARE)),
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
    source: hasOverride ? 'override' : defaults ? 'provider-model' : config.probedBudget ? 'probed' : 'fallback',
  };
}

/** Fast, conservative CJK-aware estimate shared by prompt and history budgets. */
export function estimatePromptTokens(text: string): number {
  return estimateTextTokens(text);
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
    /** Reasoning-effort setting for THIS model (same row as the budgets —
     * deepseek-v4-flash vs deepseek-v4-pro differ). */
    reasoningEffort?: ReasoningEffortSetting;
  }>;
  /** Stable slug used as the provider id (e.g. 'ollama', 'openrouter'). */
  id: string;
  /** Display name (e.g. 'Ollama (local)'). */
  name: string;
  /** OpenAI-compatible base URL (e.g. http://localhost:11434/v1). */
  baseURL: string;
  /**
   * Wire protocol for this endpoint ('openai' / 'anthropic'); unset or 'auto'
   * detects from the URL (see protocolForURL). Lets an Anthropic-compatible
   * endpoint live on an arbitrary URL (proxy / mirror) without a /anthropic
   * path segment.
   */
  protocol?: LLMProtocol;
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
export type LLMProtocol = 'openai' | 'anthropic' | 'auto';

export interface ProviderOverride {
  /** Wire protocol used by this provider endpoint; auto detects from the URL. */
  protocol?: LLMProtocol;
  /** Custom display name shown on the card / summary instead of the i18n label. */
  name?: string;
  /** Custom OpenAI-compatible base URL overriding the registry default. */
  baseURL?: string;
  /** Provider-wide context window fallback. */
  contextWindowTokens?: number;
  /** Provider-wide maximum output-token fallback. */
  outputReserveTokens?: number;
  /** Provider-wide safety margin kept outside the input and output budgets. */
  safetyMarginTokens?: number;
  /** Model-specific budget overrides keyed by model id. */
  modelBudgets?: Record<string, {
    contextWindowTokens?: number;
    outputReserveTokens?: number;
    safetyMarginTokens?: number;
    /** Reasoning-effort setting for THIS model (same row as the budgets —
     * deepseek-v4-flash vs deepseek-v4-pro differ). */
    reasoningEffort?: ReasoningEffortSetting;
  }>;
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
  /** Default API base URL. */
  baseURL: string;
  /** Default wire protocol for this provider. */
  protocol: Exclude<LLMProtocol, 'auto'>;
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
  { id: 'deepseek-openai', label: 'DeepSeek', defaultModel: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'], i18nKey: 'provider.deepseek-openai', baseURL: 'https://api.deepseek.com', protocol: 'openai', deepSeekFamily: true },
  { id: 'qwen', label: 'Qwen', defaultModel: 'qwen3-coder-next', models: ['qwen3-coder-next', 'qwen3-max'], i18nKey: 'provider.qwen', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai', deepSeekFamily: false },
  { id: 'glm', label: 'GLM', defaultModel: 'glm-5.3-flash', models: ['glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'glm-5.2-flash'], i18nKey: 'provider.glm', baseURL: 'https://api.z.ai/api/coding/paas/v4', protocol: 'openai', deepSeekFamily: false },
  { id: 'moonshot', label: 'Moonshot', defaultModel: 'kimi-k3', models: ['kimi-k3', 'kimi-k2.6'], i18nKey: 'provider.moonshot', baseURL: 'https://api.moonshot.cn/v1', protocol: 'openai', deepSeekFamily: false },
  { id: 'minimax', label: 'MiniMax', defaultModel: 'MiniMax-M2.7', models: ['MiniMax-M2.7', 'MiniMax-M2'], i18nKey: 'provider.minimax', baseURL: 'https://api.minimaxi.com/anthropic', protocol: 'anthropic', deepSeekFamily: false },
  { id: 'anthropic', label: 'Anthropic', defaultModel: 'claude-sonnet-5', models: ['claude-sonnet-5', 'claude-sonnet-4-5', 'claude-opus-5', 'claude-haiku-5'], i18nKey: 'provider.anthropic', baseURL: 'https://api.anthropic.com/v1', protocol: 'anthropic', deepSeekFamily: false },
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.2', models: ['gpt-5.2', 'gpt-4o-mini', 'o3-mini'], i18nKey: 'provider.openai', baseURL: 'https://api.openai.com/v1', protocol: 'openai', deepSeekFamily: false, imageGenModel: 'gpt-image-1' },
  { id: 'openrouter', label: 'OpenRouter', defaultModel: 'openai/gpt-4o-mini', models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4', 'deepseek/deepseek-r1'], i18nKey: 'provider.openrouter', baseURL: 'https://openrouter.ai/api/v1', protocol: 'openai', deepSeekFamily: false },
  { id: 'nvidia', label: 'NVIDIA', defaultModel: 'meta/llama-3.1-8b-instruct', models: ['meta/llama-3.1-8b-instruct', 'deepseek-ai/deepseek-r1', 'mistralai/mixtral-8x7b-instruct'], i18nKey: 'provider.nvidia', baseURL: 'https://integrate.api.nvidia.com/v1', protocol: 'openai', deepSeekFamily: false },
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

/** Return the next stable id for a manually added custom provider. */
export function nextCustomProviderId(
  customs: readonly Pick<CustomProvider, 'id'>[] | undefined | null,
): string {
  const used = new Set((customs ?? []).map((provider) => provider.id));
  for (let n = 1; n <= 999; n += 1) {
    const id = `custom${String(n).padStart(3, '0')}`;
    if (!used.has(id)) return id;
  }
  throw new Error('No available custom provider id');
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
  if (!override.protocol && !override.name && !override.baseURL
    && override.contextWindowTokens === undefined
    && override.outputReserveTokens === undefined
    && override.safetyMarginTokens === undefined
    && !override.modelBudgets
    && !override.apiKey && !override.hasApiKey) {
    return undefined;
  }
  return override;
}

/** Build a budget input from persisted custom-provider metadata. `probed` 是
 * config.json `capabilityProbes` 的缓存（W1b-1 自探测）：manifest 没档的
 * 组合才消费它，且端点与探测时不一致即作废——窗口是端点的事实，换了
 * 端点旧读数就是别人的窗口。 */
export function promptBudgetForProvider(
  customs: readonly CustomProvider[] | undefined | null,
  provider: string | undefined,
  model: string | undefined,
  overrides?: Record<string, ProviderOverride> | null,
  probed?: Record<string, ProbedCapability> | null,
): PromptBudgetConfig {
  const custom = customProviderFor(customs, provider);
  const normalizedModel = model?.trim() || undefined;
  const modelOverride = normalizedModel ? custom?.modelBudgets?.[normalizedModel] : undefined;
  const providerOverride = providerOverrideFor(overrides, provider);
  const builtinModelOverride = normalizedModel ? providerOverride?.modelBudgets?.[normalizedModel] : undefined;
  const probe = normalizedModel && provider && probed ? probed[probedCapabilityKey(provider, normalizedModel)] : undefined;
  const currentEndpoint = custom?.baseURL ?? providerOverride?.baseURL ?? PROVIDER_BY_ID.get(provider ?? '')?.baseURL;
  const probeUsable = probe && (!probe.endpoint || !currentEndpoint || probe.endpoint === currentEndpoint) ? probe : undefined;
  return {
    provider,
    model: normalizedModel,
    contextWindowTokens: modelOverride?.contextWindowTokens
      ?? custom?.contextWindowTokens
      ?? builtinModelOverride?.contextWindowTokens
      ?? providerOverride?.contextWindowTokens,
    outputReserveTokens: modelOverride?.outputReserveTokens
      ?? custom?.outputReserveTokens
      ?? builtinModelOverride?.outputReserveTokens
      ?? providerOverride?.outputReserveTokens,
    safetyMarginTokens: modelOverride?.safetyMarginTokens
      ?? custom?.safetyMarginTokens
      ?? builtinModelOverride?.safetyMarginTokens
      ?? providerOverride?.safetyMarginTokens,
    ...(probeUsable?.contextWindowTokens ? { probedBudget: { contextWindowTokens: probeUsable.contextWindowTokens, outputReserveTokens: probeUsable.outputReserveTokens } } : {}),
  };
}

/** The model-visible budget snapshot for sys_info's live-settings line
 *  (2026-11-03 定调：设置自愈的裁决权归模型，pure 只补感知手脚——现状可见
 *  +知识可查+改了真生效；何时调、调成多少全部归模型)。一行 ASCII 说清三件
 *  事：本会话实际跑的值（promptBudgetForProvider 从 config.json 捡到的配置
 *  经 resolvePromptBudget 解析）、这个模型的家族天花板（认不认识）、去哪调。
 *  `scope` 必须按面说真话（说明句=行为判据判例）：GUI 回合边界活检热生效，
 *  CLI 启动时装配一次 config，改了要新会话才生效。 */
export function promptBudgetLiveLine(
  customs: readonly CustomProvider[] | undefined | null,
  provider: string | undefined,
  model: string | undefined,
  overrides?: Record<string, ProviderOverride> | null,
  scope: 'next turn' | 'next session' = 'next turn',
  probed?: Record<string, ProbedCapability> | null,
): string {
  const effective = resolvePromptBudget(promptBudgetForProvider(customs, provider, model, overrides, probed));
  const family = promptBudgetDefaultFor(provider ?? '', model ?? '');
  const source = effective.source === 'override'
    ? 'explicit-override'
    : effective.source === 'provider-model'
      ? 'family-defaults'
      : effective.source === 'probed'
        ? 'probed-from-endpoint'
        : 'conservative-fallback';
  const familyNote = effective.source === 'fallback'
    ? `family defaults unknown (model not recognized - conservative fallback window=${family.contextWindowTokens} is in effect; set an override or run a settings connectivity test to probe the endpoint if you know the real limits)`
    : effective.source === 'probed'
      ? `window probed from the endpoint's /models metadata (manifest has no family entry - set an explicit override if you know better than the endpoint)`
      : `family defaults window=${family.contextWindowTokens} outputReserve=${family.outputReserveTokens}`;
  const scopeNote = scope === 'next turn'
    ? 'applies from your next turn'
    : 'applies from your NEXT session (CLI reads config at startup)';
  const capabilityNote = modelCapabilitySummary(resolveModelCapability(provider ?? '', model ?? ''));
  return `llm budget: provider=${provider ?? 'unknown'} model=${model ?? 'unknown'} window=${effective.contextWindowTokens} outputReserve=${effective.outputReserveTokens} safetyMargin=${effective.safetyMarginTokens} source=${source}; ${familyNote}; ${capabilityNote}; tune with "providerOverrides" or "customProviders.modelBudgets" in ~/.pure/config.json - ${scopeNote}`;
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

// ── Reasoning-effort capability (`reasoning_effort` request parameter) ──
// DATA, deliberately conservative: only model families from 2026 onwards are
// assumed to accept `reasoning_effort`; anything unmatched defaults to NOT
// supported (Settings → LLM can force a specific provider::model on/off).
// Adding a new family is a one-line diff here plus one test line.

export type ReasoningEffortLevel = 'low' | 'medium' | 'high';
/** Per-model reasoning setting, stored alongside the model's token budgets:
 * 'off' never sends the parameter, a concrete level forces it, and absence
 * (undefined) means auto — the 2026+ name pattern decides, then medium. */
export type ReasoningEffortSetting = 'off' | ReasoningEffortLevel;

/** True when a model id matches a known 2026+ reasoning-capable family. The
 *  family list is part of the capability manifest, next to the budget tables
 *  it has to stay consistent with (providers.test.ts pins the agreement). */
export function isReasoningModelName(model: string | undefined | null): boolean {
  return resolveModelCapability(undefined, model).reasoning.supported;
}

/**
 * Resolve the reasoning-effort wire value for a turn. The setting lives ON
 * THE MODEL — `modelBudgets[model].reasoningEffort`, the same slot as the
 * model's token budgets (deepseek-v4-flash vs deepseek-v4-pro differ) — with
 * custom-provider entries taking precedence over built-in overrides:
 *   'off'            → never send
 *   'low'|'medium'|'high' → always send that level
 *   unset (auto)     → the 2026+ name pattern decides, then medium
 * Anthropic-protocol endpoints are excluded for now — they reject unknown
 * top-level body fields, and the anthropic thinking API has a different shape.
 * Accepts PureConfig structurally (providers.ts must not import ui/config.ts).
 */
export function resolveReasoningEffort(
  cfg: {
    provider?: string | null;
    model?: string | null;
    customProviders?: readonly CustomProvider[] | null;
    providerOverrides?: Record<string, ProviderOverride> | null;
    protocol?: 'openai' | 'anthropic' | string | null;
  },
  /** Per-call override for a SINGLE call (判例/路由这类「判断但轻」的一次性
   *  调用，或简单回合的降档）：只在模型本来就会收到推理参数时生效——不支持
   *  的模型照样一个参数都不发。'off' 撤回参数；具体档位强制该档。undefined
   *  = 完全按每模型设置/名单解析（行为与不加此参逐字节一致）。 */
  effortOverride?: ReasoningEffortSetting,
): { supported: boolean; effort?: ReasoningEffortLevel } {
  const model = cfg.model?.trim();
  if (!model) return { supported: false };
  const custom = customProviderFor(cfg.customProviders, cfg.provider);
  const override = providerOverrideFor(cfg.providerOverrides, cfg.provider);
  // Same precedence as promptBudgetForProvider: custom entry → built-in override.
  const setting: ReasoningEffortSetting | undefined
    = custom?.modelBudgets?.[model]?.reasoningEffort
      ?? override?.modelBudgets?.[model]?.reasoningEffort;
  if (cfg.protocol === 'anthropic') return { supported: false };
  const base: { supported: boolean; effort?: ReasoningEffortLevel }
    = setting === 'off' ? { supported: false }
      : setting === 'low' || setting === 'medium' || setting === 'high' ? { supported: true, effort: setting }
        // Auto: only models on the 2026+ list get the parameter (level medium).
        : isReasoningModelName(model) ? { supported: true, effort: 'medium' } : { supported: false };
  // The override only DOWNSHIFTS a call that would already carry the parameter
  // (or withdraws it) — it never adds reasoning to a model that takes none.
  if (effortOverride === undefined || !base.supported) return base;
  return effortOverride === 'off' ? { supported: false } : { supported: true, effort: effortOverride };
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
  return providerDef(id)?.defaultModel ?? 'deepseek-flash';
}

/** Default base URL for a provider; falls back to the DeepSeek endpoint. */
export function baseURLFor(id: string): string {
  return providerDef(id)?.baseURL ?? 'https://api.deepseek.com';
}

/** Infer the wire protocol from a configured endpoint. */
export function protocolForURL(baseURL: string | undefined | null): Exclude<LLMProtocol, 'auto'> {
  // /anthropic 路径段（minimax / deepseek 兼容端点）与官方域（api.anthropic.com）
  // 都是厂商事实；其余端点默认 openai 兼容（用户可显式覆盖协议）。
  return /(?:\/anthropic(?:\/|$)|anthropic\.com)/i.test(baseURL?.trim() ?? '')
    ? 'anthropic'
    : 'openai';
}

/**
 * Resolve the wire protocol for a provider request. A non-auto user override
 * always wins. Otherwise a user-supplied endpoint is authoritative because a
 * built-in provider's registry protocol only describes its default endpoint.
 */
export function resolveProviderProtocol(
  providerProtocol: Exclude<LLMProtocol, 'auto'> | undefined,
  baseURL: string | undefined | null,
  endpointOverridden: boolean,
  protocolOverride?: LLMProtocol,
): Exclude<LLMProtocol, 'auto'> {
  if (protocolOverride && protocolOverride !== 'auto') return protocolOverride;
  if (endpointOverridden || !providerProtocol) return protocolForURL(baseURL);
  return providerProtocol;
}

/**
 * Time-to-first-token budget before the slow-response hint appears on the
 * thinking card. DeepSeek reasoning / o1 / o3 style models and local endpoints
 * (Ollama / LM Studio) routinely take 20s+ before the first token arrives, so
 * the hint must not cry wolf at the fast-chat default; fast chat models keep
 * the shorter default. The provider id alone is not enough — the same provider
 * serves both fast chat models and slow reasoning models.
 */
export function firstTokenHintTimeoutMs(provider: string | undefined | null, model: string | undefined | null): number {
  const id = `${provider ?? ''} ${model ?? ''}`.toLowerCase();
  const slowFirstToken = id.includes('reasoner')
    || id.includes('deepseek')
    || /\bo[13]\b/.test(id)
    || id.includes('ollama')
    || id.includes('lmstudio');
  return slowFirstToken ? 30_000 : 15_000;
}

/**
 * 规划/轻回合的「压暗思考」参数。GLM（bigmodel）两条路：
 * - glm-5.3 系（2026-10 官方文档）：强制思考模型，thinking.type 传 disabled
 *   已不支持——native 端点报 1210 错，anthropic 兼容端点静默忽略（实测）。
 *   官方口径=保 thinking + `reasoning_effort` 压低；实测 compat 端点吃这个
 *   字段，同问 total 10.6s → 5.4s。轻回合的可见叙述本身就是思考，档位固定
 *   low——用户在模型行选的高/中档留给正回合，寒暄不值得深想。
 * - 更老的 GLM（4.5/4.6/5.0-5.2）：`thinking: {"type": "disabled"}` 照旧
 *   生效（2026-09-26 实测第一个可见字 97.7s → 1.4s）。
 * 其他 provider 没有验证过「开着不炸」的等价参数（DeepSeek 无开关、官方
 * Anthropic 以省略为关），返回 undefined 由调用方跳过——静默期靠思考卡
 * 的存活与慢响应提示顶着。
 */
export function planThinkingOffExtraBody(
  provider: string | undefined | null,
  baseURL: string | undefined | null,
  model?: string | undefined | null,
): Record<string, unknown> | undefined {
  const id = `${provider ?? ''}`.toLowerCase();
  const host = `${baseURL ?? ''}`.toLowerCase();
  if (!id.includes('glm') && !host.includes('bigmodel')) return undefined;
  if (/glm-5\.3/.test(`${model ?? ''}`.toLowerCase())) {
    return { thinking: { type: 'enabled' }, reasoning_effort: 'low' };
  }
  return { thinking: { type: 'disabled' } };
}

/** True for the deepseek-* providers (shared API base / budget tuning). */
export function isDeepSeekFamily(id: string | undefined | null): boolean {
  return providerDef(id)?.deepSeekFamily ?? false;
}
