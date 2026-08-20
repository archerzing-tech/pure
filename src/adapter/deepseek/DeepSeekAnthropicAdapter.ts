// src/adapter/deepseek/DeepSeekAnthropicAdapter.ts
// v0.2 — DeepSeek via Anthropic-compatible endpoint.
// Base URL: https://api.deepseek.com/anthropic
// Uses native Anthropic message format (system top-level param, tool_result content blocks).

import Anthropic from '@anthropic-ai/sdk';
import type { LLMAdapter, Message, ToolDefinition, LLMChunk, LLMResponse, ToolCall } from '../../shared/types';
import { safeParseArgs } from '../../shared/format';

export interface DeepSeekAnthropicConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Per-provider endpoint override (Settings → LLM → 连接设置 / providerOverrides). */
  baseURL?: string;
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
      baseURL: config.baseURL || 'https://api.deepseek.com/anthropic',
    });
    this.model = config.model ?? 'deepseek-v4-flash';
    // Same reasoning-vs-content budget rationale as createDeepSeekAdapter: the
    // default 8192 leaves the visible answer empty on complex tasks because
    // reasoning_content consumes the whole budget first.
    this.maxTokens = config.maxTokens ?? 32768;
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
              // Anthropic emits content_block_start (with the tool name) before
              // the first input_json_delta, so the block name is available here.
              name: block.name || undefined,
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
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const { system, conversationMessages } = this.splitSystemMessage(messages);

    const response = await this.client.messages.create({
      model: this.model,
      system: system || undefined,
      messages: conversationMessages,
      tools: tools.length > 0 ? this.mapTools(tools) : undefined,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    }, signal ? { signal } : undefined);

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
    return mapAnthropicMessages(messages);
  }

  private mapTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));
  }
}

/**
 * Map canonical messages to the Anthropic wire format.
 *
 * Anthropic rejects consecutive same-role messages (alternating user/assistant
 * is required). The engine's recovery paths inject `user`-role hint messages
 * (failure-policy hints, verification-failure notes) that can land right after
 * the original user prompt or after `tool` results — so consecutive `user`
 * turns must be merged here, otherwise `deepseek-anthropic` fails with 400.
 */
function parseAnthropicImageSource(dataUrl: string, mimeType: string): { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } | null {
  if (!dataUrl) return null;
  if (!dataUrl.startsWith('data:')) return { type: 'url', url: dataUrl };
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice(5, comma);
  const data = dataUrl.slice(comma + 1);
  const mediaType = header.split(';')[0] || mimeType || 'image/png';
  if (!data) return null;
  return { type: 'base64', media_type: mediaType, data };
}

export function mapAnthropicMessages(
  messages: Message[],
): { system: string; conversationMessages: Anthropic.MessageParam[] } {
  const systemParts: string[] = [];
  const convMessages: Anthropic.MessageParam[] = [];

  const lastMessage = () => convMessages[convMessages.length - 1];

  /** Append a text block/string to the last user turn (merging consecutive users). */
  const appendToUser = (text: string): void => {
    const last = lastMessage();
    if (last?.role === 'user') {
      if (typeof last.content === 'string') {
        last.content = `${last.content}\n\n${text}`;
      } else {
        (last.content as Anthropic.ContentBlockParam[]).push({ type: 'text', text });
      }
    } else {
      convMessages.push({ role: 'user', content: text });
    }
  };

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else if (m.role === 'user') {
      appendToUser(m.content);
      if (m.images?.length) {
        const last = lastMessage();
        if (last?.role === 'user') {
          const blocks = Array.isArray(last.content)
            ? (last.content as Anthropic.ContentBlockParam[])
            : (last.content.trim() ? [{ type: 'text' as const, text: last.content }] : []);
          for (const image of m.images) {
            const source = parseAnthropicImageSource(image.dataUrl, image.mimeType);
            if (source) blocks.push({ type: 'image', source } as Anthropic.ContentBlockParam);
          }
          last.content = blocks;
        }
      }
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
            // Keep the parse-failure diagnostic: malformed args silently
            // become an empty {} tool_use input on the Anthropic API call, and
            // the warn makes the LLM's broken JSON visible in the console.
            input: safeParseArgs(tc.function.arguments, (raw) =>
              console.warn(`[DeepSeekAnthropic] failed to parse tool arguments: ${raw.slice(0, 200)}`)),
          });
        }
      }
      convMessages.push({ role: 'assistant', content: content.length > 0 ? content : m.content });
    } else if (m.role === 'tool') {
      const toolResultBlock: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
      };
      const prevMsg = lastMessage();
      if (prevMsg?.role === 'user') {
        // Normal case: previous user turn is the tool-result array — append.
        // Defensive: if it's a plain string (e.g. a hint from an old flow),
        // promote it to blocks so we never emit two consecutive user turns.
        // Skip an empty-string text block — Anthropic can reject empty text.
        const blocks = Array.isArray(prevMsg.content)
          ? (prevMsg.content as Anthropic.ContentBlockParam[])
          : (prevMsg.content.trim() ? [{ type: 'text' as const, text: prevMsg.content }] : []);
        blocks.push(toolResultBlock);
        prevMsg.content = blocks;
      } else {
        convMessages.push({ role: 'user', content: [toolResultBlock] });
      }
    }
  }

  return { system: systemParts.join('\n\n'), conversationMessages: convMessages };
}

