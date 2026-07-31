// src/adapter/openai/mapping.ts
// Shared OpenAI-compatible wire-format mapping.
// Used by both the direct OpenAICompatibleAdapter (browser fetch via the
// openai SDK) and the RustLLMAdapter (Tauri IPC → Rust reqwest), so the
// request payloads stay identical regardless of transport.

import type { Message, ToolDefinition } from '../../shared/types';

export interface OpenAIWireMessage {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  name?: string;
}

export function mapMessages(messages: Message[]): OpenAIWireMessage[] {
  return messages.map((m): OpenAIWireMessage => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: m.content };
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
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
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
