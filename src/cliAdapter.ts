// src/cliAdapter.ts
// Adapter construction for the CLI — split out of src/cli.ts (audit ①). Maps a
// parsed CliArgs invocation to a concrete LLMAdapter (mock / user-defined
// OpenAI-compatible / built-in provider), plus the provider display labels used
// by `pure config`. Depends only on cliConfig + shared providers — never on the
// harness or run-loop modules (acyclic graph).
import { MockLLMAdapter } from './adapter/mock/MockLLMAdapter';
import { createDeepSeekAdapter, createQwenAdapter, createGLMAdapter, OpenAICompatibleAdapter } from './adapter/openai/OpenAICompatibleAdapter';
import { DeepSeekAnthropicAdapter } from './adapter/deepseek/DeepSeekAnthropicAdapter';
import { baseURLFor, customProviderFor, customProviderLabel, providerOverrideFor, promptBudgetForProvider, protocolForURL, resolvePromptBudget } from './shared/providers';
import { reflectModelFor } from './shared/phaseModels';
import { bold, cyan, dim, red } from './termcolors';
import type { LLMAdapter } from './shared/types';
import type { CliArgs } from './cliConfig';

function createAdapter(args: CliArgs): { adapter: LLMAdapter; label: string } {
  if (args.provider === 'mock') {
    return { adapter: new MockLLMAdapter(), label: 'Mock (v0.1)' };
  }

  // User-defined OpenAI-compatible provider (Ollama / LM Studio / any
  // /v1/chat/completions endpoint). Keyless entries send no Authorization
  // header; keyed ones use their own key from the custom entry.
  const custom = customProviderFor(args.customProviders, args.provider);
  if (custom) {
    if (!custom.baseURL) {
      console.error(`${red('❌')} Custom provider ${cyan(custom.name)} is missing a base URL. Run ${bold('pure config')} to fix it.`);
      process.exit(1);
    }
    const model = args.model || custom.defaultModel;
    const maxTokens = resolvePromptBudget(
      promptBudgetForProvider(args.customProviders, args.provider, model, args.providerOverrides),
    ).outputReserveTokens;
    const apiKey = custom.apiKey || args.apiKey;
    return {
      adapter: new OpenAICompatibleAdapter({ baseURL: custom.baseURL, apiKey, model, maxTokens }),
      label: `${custom.name} (${model})`,
    };
  }

  if (!args.apiKey) {
    console.error(`${red('❌')} No API key configured for ${cyan(args.provider)}.`);
    console.error(`    ${dim('Run')} ${bold('pure config')} ${dim('to set up your provider and API key once for all sessions.')}`);
    console.error(`    ${dim('Or pass it inline:')} ${bold('pure --api-key <key>')}`);
    console.error(`    ${dim('Or set an env var:')}  DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / ZHIPU_API_KEY / MOONSHOT_API_KEY / MINIMAX_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / NVIDIA_API_KEY`);
    process.exit(1);
  }

  const maxTokens = resolvePromptBudget(
    promptBudgetForProvider(args.customProviders, args.provider, args.model, args.providerOverrides),
  ).outputReserveTokens;

  // Built-in providers honor a per-provider endpoint override (proxy / mirror)
  // from ~/.pure/config.json providerOverrides, mirroring the GUI settings.
  const builtinOverride = providerOverrideFor(args.providerOverrides, args.provider);
  const endpoint = builtinOverride?.baseURL || undefined;
  const displayName = customProviderLabel(args.customProviders, args.provider, args.providerOverrides);

  switch (args.provider) {
    case 'qwen': {
      // A configured override (e.g. a DashScope compatible-mode endpoint or a
      // gateway) replaces the dedicated workspace deployment, so the
      // workspace requirement only applies to the default path.
      if (!endpoint) {
        const wsId = process.env.DASHSCOPE_WORKSPACE_ID ?? '';
        if (!wsId) { console.error('❌ Qwen requires DASHSCOPE_WORKSPACE_ID env var'); process.exit(1); }
        return { adapter: createQwenAdapter(args.apiKey, wsId, args.model, undefined, maxTokens), label: `${displayName} (${args.model})` };
      }
      return { adapter: createQwenAdapter(args.apiKey, '', args.model, endpoint, maxTokens), label: `${displayName} (${args.model})` };
    }
    case 'glm': {
      // 用户可以把 glm 覆盖成 Anthropic 兼容端点（如 open.bigmodel.cn/api/anthropic，
      // GUI 设置页就这么配）。CLI/gateway 同样按端点 URL 探测协议，别把 OpenAI 格式
      // 打到 anthropic 端点上 —— 那只会得到 4xx 或空回复。
      if (endpoint && protocolForURL(endpoint) === 'anthropic') {
        return { adapter: new DeepSeekAnthropicAdapter({ apiKey: args.apiKey, model: args.model, baseURL: endpoint, maxTokens }), label: `${displayName} (${args.model})` };
      }
      return { adapter: createGLMAdapter(args.apiKey, args.model, endpoint, maxTokens), label: `${displayName} (${args.model})` };
    }
    case 'deepseek-openai':
      return { adapter: createDeepSeekAdapter(args.apiKey, args.model, endpoint, maxTokens), label: `${displayName} (${args.model})` };
    // The remaining built-ins are plain OpenAI-compatible endpoints;
    case 'moonshot':
    case 'minimax':
    case 'openai':
    case 'openrouter':
    case 'nvidia':
      return {
        adapter: new OpenAICompatibleAdapter({ baseURL: endpoint || baseURLFor(args.provider), apiKey: args.apiKey, model: args.model, maxTokens }),
        label: `${displayName} (${args.model})`,
      };
    default:
      return { adapter: createDeepSeekAdapter(args.apiKey, args.model, endpoint, maxTokens), label: `${displayName} (${args.model})` };
  }
}

// ── `pure config` — interactive one-time setup ──
// Writes ~/.pure/config.json so future `pure` invocations work without env vars.

const PROVIDER_LABELS: Record<Exclude<CliArgs['provider'], 'mock'>, string> = {
  'deepseek-openai': 'DeepSeek (OpenAI-compatible API)',
  'qwen': 'Qwen / DashScope',
  'glm': 'GLM / Zhipu',
  'moonshot': 'Moonshot Kimi',
  'minimax': 'MiniMax',
  'openai': 'OpenAI',
  'openrouter': 'OpenRouter',
  'nvidia': 'NVIDIA NIM',
};

const PROVIDER_ENV_HINT: Record<Exclude<CliArgs['provider'], 'mock'>, string> = {
  'deepseek-openai': 'DEEPSEEK_API_KEY',
  'qwen': 'DASHSCOPE_API_KEY',
  'glm': 'ZHIPU_API_KEY',
  'moonshot': 'MOONSHOT_API_KEY',
  'minimax': 'MINIMAX_API_KEY',
  'openai': 'OPENAI_API_KEY',
  'openrouter': 'OPENROUTER_API_KEY',
  'nvidia': 'NVIDIA_API_KEY',
};

/** P0-2（2026-09-30）— sleep-time 反思 / overlay 起草的 LLM 解析（E0.3 的
 *  REFLECT 相位契约，CLI 侧）。配了 --reflect-model / config.phaseModels.reflect
 *  时为那个模型建一个同 provider adapter（端点覆盖、预算、provider 怪癖与主
 *  adapter 同一套解析）；没配或覆盖等于主模型时直接复用调用方手里的主 adapter，
 *  不重建。与 Harness 的 llmFor('REFLECT') ?? llm 同一回退语义。 */
function resolveReflectAdapter(args: CliArgs, main: LLMAdapter): LLMAdapter {
  const model = reflectModelFor(args.phaseModels, args.model);
  return model ? createAdapter({ ...args, model }).adapter : main;
}

export { createAdapter, resolveReflectAdapter, PROVIDER_LABELS, PROVIDER_ENV_HINT };
