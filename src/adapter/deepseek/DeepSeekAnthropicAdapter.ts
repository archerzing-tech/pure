// src/adapter/deepseek/DeepSeekAnthropicAdapter.ts
// v0.2 — DeepSeek via Anthropic-compatible endpoint.
// Base URL: https://api.deepseek.com/anthropic
// Uses native Anthropic message format (system top-level param, tool_result content blocks).
// 8.2 — prompt-cache breakpoints on the stable prefix (system + tools +
// conversation up to the newest turn) and billing-usage capture from the
// stream, so anthropic-protocol sessions show the same cache-hit cost drop
// the openai protocol already reports via DeepSeek's automatic caching.

import Anthropic from '@anthropic-ai/sdk';
import type { AssistantThinkingBlock, LLMAdapter, Message, ToolDefinition, LLMChunk, LLMResponse, ToolCall } from '../../shared/types';
import { safeParseArgs } from '../../shared/format';
import { normalizeTokenUsage } from '../../shared/usage';
import { trimHistoricalImages } from '../../shared/imageContext';
import { stripAllThinking, stripHistoricalThinking } from '../openai/mapping';

export interface DeepSeekAnthropicConfig {
  /** Optional: keyless local endpoints (anthropic 兼容路由器) legitimately
   *  have no key — the constructor passes a placeholder the server ignores. */
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Per-provider endpoint override (Settings → LLM → 连接设置 / providerOverrides). */
  baseURL?: string;
  /** Anthropic 扩展思考预算（仅 Claude 3.7/4 系由宿主设置）。 */
  thinkingBudget?: number;
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
  private thinkingBudget?: number;

  constructor(config: DeepSeekAnthropicConfig) {
    // dangerouslyAllowBrowser matches OpenAICompatibleAdapter: the desktop build
    // streams through Rust (RustLLMAdapter), so this SDK only ever runs in the
    // browser dev harness — where the SDK's browser guard otherwise refuses to
    // construct and every anthropic-protocol turn dies before the request.
    this.client = new Anthropic({
      // Keyless local endpoints: the SDK throws on an empty key at request
      // time, so pass a placeholder (the header value is ignored by keyless
      // servers) — same rationale as OpenAICompatibleAdapter's 'ollama'.
      apiKey: config.apiKey || 'keyless-local',
      baseURL: config.baseURL || 'https://api.deepseek.com/anthropic',
      dangerouslyAllowBrowser: true,
    });
    this.model = config.model ?? 'deepseek-flash';
    // Same reasoning-vs-content budget rationale as createDeepSeekAdapter: the
    // default 8192 leaves the visible answer empty on complex tasks because
    // reasoning_content consumes the whole budget first.
    this.maxTokens = config.maxTokens ?? 32768;
    this.temperature = config.temperature ?? 0;
    this.thinkingBudget = config.thinkingBudget;
  }

  /** 旧会话最近的工具调用没有 thinking 块时不要开 thinking——Anthropic 会以
   *  「thinking blocks must be preserved」拒绝整个请求。 */
  private effectiveThinkingBudget(messages: Message[]): number | undefined {
    if (!this.thinkingBudget) return undefined;
    const lastToolAssistant = [...messages].reverse().find(
      (m) => m.role === 'assistant' && m.toolCalls?.length,
    );
    if (lastToolAssistant && !lastToolAssistant.thinkingBlocks?.length) return undefined;
    return this.thinkingBudget;
  }

  async *stream(
    messages: Message[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<LLMChunk, void, void> {
    const thinkingBudget = this.effectiveThinkingBudget(messages);
    const { system, conversationMessages } = this.splitSystemMessage(
      thinkingBudget ? stripHistoricalThinking(messages) : stripAllThinking(messages),
    );
    const cacheable = cacheableAnthropicRequest(system, conversationMessages);

    const stream = this.client.messages.stream({
      model: this.model,
      system: cacheable.system,
      messages: cacheable.conversationMessages,
      tools: tools.length > 0 ? this.mapTools(tools) : undefined,
      // Anthropic 硬约束：max_tokens 必须大于 budget_tokens；开思考时不发
      // temperature（官方要求思考模式温度不可自定义，发了会 400）。
      max_tokens: thinkingBudget ? Math.max(this.maxTokens, thinkingBudget + 1024) : this.maxTokens,
      ...(thinkingBudget
        ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } }
        : { temperature: this.temperature }),
    });

    signal?.addEventListener('abort', () => stream.controller.abort(), { once: true });

    const toolBlocks: Map<number, ToolBlock> = new Map();
    const thinkingBlocks = new Map<number, AssistantThinkingBlock>();
    let content = '';
    // Anthropic reports billing usage as message_start (input + cache split)
    // plus message_delta (final cumulative output_tokens) — captured here and
    // emitted once through the same `usage` chunk the OpenAI adapters yield,
    // so per-session cost and cache-hit rate work for this protocol too.
    let startUsage: Record<string, unknown> | undefined;
    let usageEmitted = false;

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          startUsage = event.message.usage as unknown as Record<string, unknown>;
          break;
        }
        case 'message_delta': {
          if (!usageEmitted && event.usage) {
            usageEmitted = true;
            const merged = { ...(startUsage ?? {}), output_tokens: event.usage.output_tokens };
            const usage = normalizeTokenUsage(anthropicUsageToOpenAI(merged));
            if (usage) yield { type: 'usage', usage };
          }
          break;
        }
        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            content += event.delta.text;
            yield { type: 'content', content: event.delta.text };
          }
          if (event.delta.type === 'thinking_delta') {
            const block = thinkingBlocks.get(event.index);
            if (block) block.thinking = (block.thinking ?? '') + event.delta.thinking;
            // 思考流独立于正文，与 DeepSeek/GLM 的 reasoning_content 同面。
            yield { type: 'reasoning', content: event.delta.thinking };
          }
          if (event.delta.type === 'signature_delta') {
            const block = thinkingBlocks.get(event.index);
            if (block) block.signature = (block.signature ?? '') + event.delta.signature;
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
          if (event.content_block.type === 'thinking') {
            thinkingBlocks.set(event.index, { type: 'thinking', thinking: '', signature: '' });
          }
          if (event.content_block.type === 'redacted_thinking') {
            thinkingBlocks.set(event.index, { type: 'redacted_thinking', data: event.content_block.data });
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
    const collectedThinking = [...thinkingBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]) => block)
      .filter((block) => block.type === 'redacted_thinking' || Boolean(block.thinking && block.signature));

    yield {
      type: 'done',
      content,
      toolCalls,
      ...(collectedThinking.length > 0 ? { thinkingBlocks: collectedThinking } : {}),
    };
  }

  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const thinkingBudget = this.effectiveThinkingBudget(messages);
    const { system, conversationMessages } = this.splitSystemMessage(
      thinkingBudget ? stripHistoricalThinking(messages) : stripAllThinking(messages),
    );
    const cacheable = cacheableAnthropicRequest(system, conversationMessages);

    const response = await this.client.messages.create({
      model: this.model,
      system: cacheable.system,
      messages: cacheable.conversationMessages,
      tools: tools.length > 0 ? this.mapTools(tools) : undefined,
      max_tokens: thinkingBudget ? Math.max(this.maxTokens, thinkingBudget + 1024) : this.maxTokens,
      ...(thinkingBudget
        ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } }
        : { temperature: this.temperature }),
    }, signal ? { signal } : undefined);

    const textBlocks = response.content.filter(b => b.type === 'text');
    const toolBlocks = response.content.filter(b => b.type === 'tool_use');

    const content = textBlocks.map(b => b.text).join('');

    const toolCalls: ToolCall[] = toolBlocks.map((b, i) => ({
      id: b.id || `call_${i}`,
      index: i,
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }));

    const thinkingBlocks: AssistantThinkingBlock[] = response.content
      .filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
      .map((b) => b.type === 'thinking'
        ? { type: 'thinking', thinking: b.thinking, signature: b.signature }
        : { type: 'redacted_thinking', data: b.data });

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: normalizeTokenUsage(anthropicUsageToOpenAI(response.usage as unknown as Record<string, unknown>)),
      ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    };
  }

  private splitSystemMessage(messages: Message[]): {
    system: string;
    conversationMessages: Anthropic.MessageParam[];
  } {
    return mapAnthropicMessages(messages);
  }

  private mapTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    const mapped = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));
    // 8.2: the last tool carries the cache breakpoint — the whole tools block
    // (identical every turn) is then cached as one prefix segment.
    const last = mapped[mapped.length - 1] as (Anthropic.Tool & { cache_control?: unknown }) | undefined;
    if (last) last.cache_control = CACHE_CONTROL;
    return mapped;
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

/** 8.2 — the ephemeral marker that turns a content block into a cache
 *  breakpoint for providers that implement Anthropic prompt caching. */
export const CACHE_CONTROL = { type: 'ephemeral' } as const;

/**
 * 8.2 — prompt-cache breakpoints. Mark the stable prefix so providers bill it
 * at the cache-hit rate from the second request of a session on: the system
 * prompt (identical every turn), the tools block (marked in mapTools), and —
 * here — the last content block of the second-to-last message. Everything
 * before that block is the reusable prefix; only the newest turn is billed
 * as fresh input. Anthropic allows at most 4 breakpoints per request; this
 * scheme spends 3 and leaves one spare. Mutates and returns the array.
 */
export function applyAnthropicCacheBreakpoints(
  conversationMessages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const prefixLast = conversationMessages[conversationMessages.length - 2] as
    | { content: Anthropic.MessageParam['content'] }
    | undefined;
  if (!prefixLast) return conversationMessages;
  if (typeof prefixLast.content === 'string') {
    if (prefixLast.content) {
      prefixLast.content = [{ type: 'text', text: prefixLast.content, cache_control: CACHE_CONTROL }];
    }
  } else if (Array.isArray(prefixLast.content) && prefixLast.content.length > 0) {
    const last = prefixLast.content[prefixLast.content.length - 1] as { cache_control?: unknown };
    if (last && typeof last === 'object') last.cache_control = CACHE_CONTROL;
  }
  return conversationMessages;
}

/**
 * 8.2 — assemble the cacheable request shape: system as a breakpoint-carrying
 * text block plus the breakpoint-marked conversation prefix.
 */
export function cacheableAnthropicRequest(
  system: string,
  conversationMessages: Anthropic.MessageParam[],
): { system: Anthropic.TextBlockParam[] | undefined; conversationMessages: Anthropic.MessageParam[] } {
  return {
    system: system
      ? [{ type: 'text', text: system, cache_control: CACHE_CONTROL }]
      : undefined,
    conversationMessages: applyAnthropicCacheBreakpoints(conversationMessages),
  };
}

/**
 * 8.2 — translate Anthropic wire usage into the OpenAI-style raw shape that
 * normalizeTokenUsage already understands. Anthropic's `input_tokens` excludes
 * the cached and cache-write portions (reported separately); the total billed
 * prompt is the sum of all three. Cache reads map to the hit field, uncached
 * input (including the 1.25×-billed cache writes) to the miss field.
 */
export function anthropicUsageToOpenAI(usage: unknown): Record<string, number> {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const input = num(u.input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  return {
    prompt_tokens: input + cacheRead + cacheWrite,
    completion_tokens: num(u.output_tokens),
    prompt_cache_hit_tokens: cacheRead,
    prompt_cache_miss_tokens: input + cacheWrite,
  };
}
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
  // P1-2（2026-11-13 性能审计）：较早的截图降级为缩略图，避免每轮重传 MB 级
  // base64；当前轮的图与快照/磁盘均不变。
  messages = trimHistoricalImages(messages);
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
      // thinking 块必须排在 text / tool_use 之前，且 signature 原样回传。
      for (const block of m.thinkingBlocks ?? []) {
        if (block.type === 'thinking' && block.thinking && block.signature) {
          content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature } as Anthropic.ContentBlockParam);
        } else if (block.type === 'redacted_thinking' && block.data) {
          content.push({ type: 'redacted_thinking', data: block.data } as Anthropic.ContentBlockParam);
        }
      }
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
      // W4-2: tool_result content takes a block array — text first, then the
      // tool's screenshots as image blocks. Empty text is skipped (Anthropic
      // rejects empty text blocks, same as the user-path rule above); if no
      // image survives parsing, fall back to plain string content.
      if (m.images?.some(i => i.dataUrl)) {
        const blocks: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = m.content.trim()
          ? [{ type: 'text', text: m.content }]
          : [];
        for (const image of m.images) {
          const source = parseAnthropicImageSource(image.dataUrl, image.mimeType);
          if (source) blocks.push({ type: 'image', source } as Anthropic.ImageBlockParam);
        }
        if (blocks.length > 0) toolResultBlock.content = blocks;
      }
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

