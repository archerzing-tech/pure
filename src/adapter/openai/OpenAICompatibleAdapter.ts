// src/adapter/openai/OpenAICompatibleAdapter.ts
// v0.2 — single adapter for all OpenAI-compatible Chinese LLMs.
// DeepSeek / Qwen / GLM — just swap baseURL + model.
// GLM uses extraBody { tool_stream: true } spread into params.

import OpenAI from 'openai';
import type { LLMAdapter, Message, ToolDefinition, LLMChunk, LLMResponse, ToolCall } from '../../shared/types';
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
    this.client = new OpenAI({
      apiKey: config.apiKey,
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

    for await (const chunk of stream) {
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

    yield { type: 'done', content, toolCalls };
  }

  async complete(
    messages: Message[],
    tools: ToolDefinition[],
  ): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create(
      this.buildParams(messages, tools, false),
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

export function createDeepSeekAdapter(apiKey: string, model = 'deepseek-v4-flash') {
  return new OpenAICompatibleAdapter({
    baseURL: 'https://api.deepseek.com',
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

export function createQwenAdapter(apiKey: string, workspaceId: string, model = 'qwen3-coder-next') {
  return new OpenAICompatibleAdapter({
    baseURL: `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`,
    apiKey,
    model,
  });
}

export function createGLMAdapter(apiKey: string, model = 'glm-5.2') {
  return new OpenAICompatibleAdapter({
    baseURL: 'https://api.z.ai/api/paas/v4',
    apiKey,
    model,
    extraBody: { tool_stream: true },
  });
}
