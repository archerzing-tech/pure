// src/adapter/openai/mapping.ts
// Shared OpenAI-compatible wire-format mapping.
// Used by both the direct OpenAICompatibleAdapter (browser fetch via the
// openai SDK) and the RustLLMAdapter (Tauri IPC → Rust reqwest), so the
// request payloads stay identical regardless of transport.

import type { Message, ToolDefinition } from '../../shared/types';
import { trimHistoricalImages } from '../../shared/imageContext';

export type OpenAIWireContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
>;

export interface OpenAIWireMessage {
  role: string;
  content?: OpenAIWireContent | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  name?: string;
}

export function mapMessages(messages: Message[]): OpenAIWireMessage[] {
  // P1-2（2026-11-13 性能审计）：较早的截图降级为缩略图，避免每轮重传 MB 级
  // base64；当前轮的图与快照/磁盘均不变。
  const requestMessages = trimHistoricalImages(messages);
  return requestMessages.map((m): OpenAIWireMessage => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user': {
        if (!m.images?.length) return { role: 'user', content: m.content };
        const content: OpenAIWireContent = [
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
          ...m.images
            .filter((image) => image.dataUrl)
            .map((image) => ({ type: 'image_url' as const, image_url: { url: image.dataUrl } })),
        ];
        return { role: 'user', content };
      }
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls?.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        };
      case 'tool': {
        // W4-2: a tool message may carry screenshots — content becomes an
        // array of content parts (string content stays a plain string, the
        // shape every OpenAI-compatible backend already expects). DeepSeek
        // compatibility with array tool content is a real-machine item.
        if (m.images?.some(i => i.dataUrl)) {
          const content: OpenAIWireContent = [
            ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
            ...m.images
              .filter(i => i.dataUrl)
              .map(i => ({ type: 'image_url' as const, image_url: { url: i.dataUrl } })),
          ];
          return { role: 'tool', tool_call_id: m.toolCallId ?? '', content };
        }
        return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
      }
      default:
        return { role: 'user', content: m.content };
    }
  });
}

export interface OpenAIWireTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function mapTools(tools: ToolDefinition[]): OpenAIWireTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

export interface BuildChatParamsOptions {
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stream: boolean;
  extraBody?: Record<string, unknown>;
}

/** Build the OpenAI chat/completions request body (JSON-safe for IPC). */
export function buildChatParams(opts: BuildChatParamsOptions): Record<string, unknown> {
  const base: Record<string, unknown> = {
    model: opts.model,
    messages: mapMessages(opts.messages),
    max_tokens: opts.maxTokens ?? 8192,
    temperature: opts.temperature ?? 0,
    stream: opts.stream,
  };
  if (opts.tools.length > 0) {
    base.tools = mapTools(opts.tools);
  }
  if (opts.extraBody) {
    return { ...base, ...opts.extraBody };
  }
  return base;
}
