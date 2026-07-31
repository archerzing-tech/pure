// src/adapter/deepseek/DeepSeekAnthropicAdapter.ts
// v0.2 — DeepSeek via Anthropic-compatible endpoint.
// Base URL: https://api.deepseek.com/anthropic
// Uses native Anthropic message format (system top-level param, tool_result content blocks).

import Anthropic from '@anthropic-ai/sdk';
import type { LLMAdapter, Message, ToolDefinition, LLMChunk, LLMResponse, ToolCall } from '../../shared/types';

export interface DeepSeekAnthropicConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

interface ToolBlock {
  id: string;
  name: string;
  arguments: string;
}

export class DeepSeekAnthropicAdapter implements LLMAdapter {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: DeepSeekAnthropicConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: 'https://api.deepseek.com/anthropic',
    });
    this.model = config.model ?? 'deepseek-v4-flash';
    this.maxTokens = config.maxTokens ?? 8192;
    this.temperature = config.temperature ?? 0;
  }

  async *stream(
    messages: Message[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<LLMChunk, void, void> {
    const { system, conversationMessages } = this.splitSystemMessage(messages);

    const stream = this.client.messages.stream({
      model: this.model,
      system: system || undefined,
      messages: conversationMessages,
      tools: tools.length > 0 ? this.mapTools(tools) : undefined,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    });

    signal?.addEventListener('abort', () => stream.controller.abort(), { once: true });

    const toolBlocks: Map<number, ToolBlock> = new Map();
    let content = '';

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            content += event.delta.text;
            yield { type: 'content', content: event.delta.text };
          }
          if (event.delta.type === 'input_json_delta') {
            const idx = event.index;
            if (!toolBlocks.has(idx)) {
              toolBlocks.set(idx, { id: '', name: '', arguments: '' });
            }
            const block = toolBlocks.get(idx)!;
            block.arguments += event.delta.partial_json;
            yield {
              type: 'tool_call_delta',
              index: idx,
              arguments: event.delta.partial_json,
            };
          }
          break;

        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            toolBlocks.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              arguments: '',
            });
          }
          break;

        case 'content_block_stop':
          if (toolBlocks.has(event.index)) {
            const block = toolBlocks.get(event.index)!;
            yield {
              type: 'tool_call',
              index: event.index,
              id: block.id,
              name: block.name,
              arguments: block.arguments,
            };
          }
          break;
      }
    }

    const toolCalls: ToolCall[] = [...toolBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, block]) => ({
        id: block.id || `call_${index}`,
        index,
        function: { name: block.name, arguments: block.arguments },
      }));

    yield { type: 'done', content, toolCalls };
  }

  async complete(
    messages: Message[],
    tools: ToolDefinition[],
  ): Promise<LLMResponse> {
    const { system, conversationMessages } = this.splitSystemMessage(messages);

    const response = await this.client.messages.create({
      model: this.model,
      system: system || undefined,
      messages: conversationMessages,
      tools: tools.length > 0 ? this.mapTools(tools) : undefined,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    const toolBlocks = response.content.filter(b => b.type === 'tool_use');

    const content = textBlocks.map(b => b.text).join('');

    const toolCalls: ToolCall[] = toolBlocks.map((b, i) => ({
      id: b.id || `call_${i}`,
      index: i,
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }));

    return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
  }

  private splitSystemMessage(messages: Message[]): {
    system: string;
    conversationMessages: Anthropic.MessageParam[];
  } {
    const systemParts: string[] = [];
    const convMessages: Anthropic.MessageParam[] = [];

    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
      } else if (m.role === 'user') {
        convMessages.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.content) {
          content.push({ type: 'text', text: m.content });
        }
        if (m.toolCalls?.length) {
          for (const tc of m.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: safeParseJSON(tc.function.arguments),
            });
          }
        }
        convMessages.push({ role: 'assistant', content: content.length > 0 ? content : m.content });
      } else if (m.role === 'tool') {
        const prevMsg = convMessages[convMessages.length - 1];
        const toolResultBlock: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: m.content,
        };
        if (prevMsg?.role === 'user' && Array.isArray(prevMsg.content)) {
          (prevMsg.content as Anthropic.ContentBlockParam[]).push(toolResultBlock);
        } else {
          convMessages.push({ role: 'user', content: [toolResultBlock] });
        }
      }
    }

    return { system: systemParts.join('\n\n'), conversationMessages: convMessages };
  }

  private mapTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));
  }
}

function safeParseJSON(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw); } catch {
    console.warn(`[DeepSeekAnthropic] failed to parse tool arguments: ${raw.slice(0, 200)}`);
    return {};
  }
}
