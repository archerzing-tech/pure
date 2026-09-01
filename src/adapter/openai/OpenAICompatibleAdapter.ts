// src/adapter/openai/OpenAICompatibleAdapter.ts
// v0.2 — single adapter for all OpenAI-compatible Chinese LLMs.
// DeepSeek / Qwen / GLM — just swap baseURL + model.
// GLM uses extraBody { tool_stream: true } spread into params.

import OpenAI from 'openai';
import type { LLMAdapter, Message, ToolDefinition, LLMChunk, LLMResponse, ToolCall, TokenUsage } from '../../shared/types';
import { normalizeTokenUsage } from '../../shared/usage';
import { buildChatParams } from './mapping';

export interface OpenAICompatibleConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  extraBody?: Record<string, unknown>;
}

export class OpenAICompatibleAdapter implements LLMAdapter {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private extraBody?: Record<string, unknown>;

  constructor(config: OpenAICompatibleConfig) {
    // The openai SDK constructor THROWS 'Missing credentials' on an empty
    // apiKey — but keyless local endpoints (Ollama / LM Studio) don't need
    // one and ignore the Authorization header anyway. A placeholder keeps the
    // constructor happy; the emitted `Bearer ollama` header is never validated
    // by these servers (matches the community standard for local LLMs). The
    // Rust transport omits the header entirely for keyless providers.
    const apiKey = config.apiKey || 'ollama';
    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseURL,
      dangerouslyAllowBrowser: true,
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 8192;
    this.temperature = config.temperature ?? 0;
    this.extraBody = config.extraBody;
  }

  async *stream(
    messages: Message[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<LLMChunk, void, void> {
    const stream = await this.client.chat.completions.create(
      this.buildParams(messages, tools, true),
      { signal },
    );

    const toolCallAccum: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let content = '';
    // Billing usage arrives on the FINAL stream chunk (choices may be empty,
    // so capture it before the `!delta` skip below).
    let rawUsage: unknown;

    for await (const chunk of stream) {
      if (chunk.usage) rawUsage = chunk.usage;
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        yield { type: 'content', content: delta.content };
      }

      // Reasoning deltas: DeepSeek/Qwen/GLM expose `reasoning_content`;
      // OpenAI-style responses use `reasoning` (string or {content: [{text}]}).
      // Yielded separately so the GUI can render a live thinking card while
      // keeping the reasoning out of the visible answer.
      const d = delta as any;
      const reasoning =
        typeof d.reasoning_content === 'string'
          ? d.reasoning_content
          : typeof d.reasoning === 'string'
            ? d.reasoning
            : Array.isArray(d.reasoning?.content)
              ? d.reasoning.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
              : undefined;
      if (reasoning) yield { type: 'reasoning', content: reasoning };

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallAccum.has(idx)) {
            toolCallAccum.set(idx, { id: tc.id ?? '', name: '', arguments: '' });
          }
          const acc = toolCallAccum.get(idx)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;

          yield {
            type: 'tool_call_delta',
            index: idx,
            name: tc.function?.name,
            arguments: tc.function?.arguments,
          };
        }
      }
    }

    const toolCalls: ToolCall[] = [...toolCallAccum.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, acc]) => ({
        id: acc.id || `call_${index}`,
        index,
        function: { name: acc.name, arguments: acc.arguments },
      }));

    const usage: TokenUsage | undefined = normalizeTokenUsage(rawUsage);
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', content, toolCalls };
  }

  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create(
      this.buildParams(messages, tools, false),
      signal ? { signal } : undefined,
    );

    const choice = response.choices[0]?.message;
    const content = choice?.content ?? '';

    const rawToolCalls = choice?.tool_calls ?? [];
    const toolCalls: ToolCall[] = [];
    for (let i = 0; i < rawToolCalls.length; i++) {
      const tc = rawToolCalls[i];
      if (tc.type === 'function' && 'function' in tc && tc.function) {
        toolCalls.push({
          id: tc.id || `call_${i}`,
          index: i,
          function: { name: tc.function.name, arguments: tc.function.arguments ?? '' },
        });
      }
    }

    return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
  }

  private buildParams(
    messages: Message[],
    tools: ToolDefinition[],
    stream: true,
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
  private buildParams(
    messages: Message[],
    tools: ToolDefinition[],
    stream: false,
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
  private buildParams(
    messages: Message[],
    tools: ToolDefinition[],
    stream: boolean,
  ): any {
    return buildChatParams({
      model: this.model,
      messages,
      tools,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      stream,
      extraBody: this.extraBody,
    });
  }
}

// ── Pre-configured factory functions ──

export function createDeepSeekAdapter(apiKey: string, model = 'deepseek-v4-flash', baseURL?: string) {
  return new OpenAICompatibleAdapter({
    // A per-provider override (Settings → LLM → 连接设置, synced via
    // providerOverrides) wins over the official endpoint.
    baseURL: baseURL || 'https://api.deepseek.com',
    apiKey,
    model,
    // DeepSeek reasoning models draw reasoning_content and content from the
    // SAME output-token budget. The shared 8192 default gets exhausted by
    // thinking on complex tasks (e.g. generating a full HTML animation), so
    // the visible answer comes back EMPTY → non-empty-output verify failure →
    // retry loop. 32768 leaves room for reasoning AND the actual answer.
    maxTokens: 32768,
  });
}

export function createQwenAdapter(apiKey: string, workspaceId: string, model = 'qwen3-coder-next', baseURL?: string) {
  return new OpenAICompatibleAdapter({
    // Default = the dedicated workspace deployment; an explicit override
    // (e.g. a DashScope compatible-mode endpoint or a gateway) replaces it
    // and drops the workspace requirement.
    baseURL: baseURL || `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`,
    apiKey,
    model,
  });
}

export function createGLMAdapter(apiKey: string, model = 'glm-5.3-flash', baseURL?: string) {
  return new OpenAICompatibleAdapter({
    baseURL: baseURL || 'https://api.z.ai/api/coding/paas/v4',
    apiKey,
    model,
    maxTokens: 32768,
  });
}
