// src/adapter/rust/RustLLMAdapter.ts
// v0.1 — LLM transport through the Tauri Rust backend.
//
// Security model (per design doc §2.1): the API key never enters the
// WebView. It lives in ~/.pure/secrets.json (0600) and is resolved inside
// the Rust `chat_stream` command. The WebView only sends provider/baseUrl/
// model + messages, and receives SSE deltas over a Channel.
//
// The adapter is also injectable (constructor deps) so unit tests can mock
// invoke + Channel without a live Tauri runtime.

import type {
  LLMAdapter,
  LLMChunk,
  LLMResponse,
  Message,
  ToolCall,
  TokenUsage,
  ToolDefinition,
} from '../../shared/types';
import { normalizeTokenUsage } from '../../shared/usage';
import { buildChatParams } from '../openai/mapping';
import { isTauriRuntime } from '../../shared/tauri';

export interface RustLLMConfig {
  provider: string;
  model: string;
  baseURL?: string;
  extraBody?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  /**
   * Exact secrets-store key to resolve when `apiKey` is omitted (desktop).
   * Defaults to 'llm.apiKey' (the main provider's key). Custom providers pass
   * 'llm.apiKey.<id>' so each keeps its own key; keyless custom providers pass
   * a key name that resolves to nothing → the Authorization header is omitted.
   */
  secretKey?: string;
  proxyUrl?: string;
  proxyBypassProviders?: string[];
}

export interface RustLLMDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  Channel: new <T = unknown>(options?: { onmessage?: (message: T) => void }) => {
    onmessage: ((message: T) => void) | null;
    send: (message: T) => void;
    close: () => void;
  };
}

interface QueueItem {
  type: 'chunk' | 'end';
  value?: string;
}

const SECRET_KEY = 'llm.apiKey';

export class RustLLMAdapter implements LLMAdapter {
  private config: RustLLMConfig;
  private deps?: RustLLMDeps;

  constructor(config: RustLLMConfig, deps?: RustLLMDeps) {
    this.config = config;
    this.deps = deps;
  }

  private async getDeps(): Promise<RustLLMDeps> {
    if (this.deps) return this.deps;
    if (!isTauriRuntime()) {
      throw new Error('RustLLMAdapter requires the Tauri runtime');
    }
    const mod = await import('@tauri-apps/api/core');
    return {
      invoke: mod.invoke,
      Channel: mod.Channel as unknown as RustLLMDeps['Channel'],
    };
  }

  async *stream(
    messages: Message[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<LLMChunk, void, void> {
    const deps = await this.getDeps();
    const params = buildChatParams({
      model: this.config.model,
      messages,
      tools,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
      extraBody: this.config.extraBody,
    });

    // One request id per stream call: passed into chat_stream so the Rust
    // backend can register a cancel channel under it, and reused by the abort
    // handler below to fire cancel_chat_stream (Stop must abort the in-flight
    // request instead of letting it generate + bill until the idle timeout).
    const requestId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `llm_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // ── Bridge Rust's callback-based Channel into an async queue ──
    const channel = new deps.Channel<string>();
    const queue: QueueItem[] = [];
    const waiters: Array<(item: QueueItem) => void> = [];

    let invokeDone = false;
    let finalResult: any = null;
    let invokeError: Error | null = null;
    let closed = false;

    const push = (item: QueueItem) => {
      const waiter = waiters.shift();
      if (waiter) waiter(item);
      else queue.push(item);
    };

    channel.onmessage = (raw) => {
      push({ type: 'chunk', value: String(raw) });
    };

    const invokePromise = deps
      .invoke('chat_stream', {
        args: {
          messages: params.messages,
          tools: (params.tools as unknown[] | undefined) ?? [],
          provider: this.config.provider,
          model: params.model,
          apiKey: '',
          baseUrl: this.config.baseURL ?? '',
          secretKey: this.config.secretKey ?? '',
          extraBody: this.config.extraBody,
          maxTokens: params.max_tokens,
          temperature: params.temperature,
          requestId,
          proxyUrl: this.config.proxyUrl ?? '',
          proxyBypassProviders: this.config.proxyBypassProviders ?? [],
        },
        onChunk: channel,
      })
      .then((res) => {
        finalResult = res;
      })
      .catch((err: unknown) => {
        invokeError = err instanceof Error ? err : new Error(String(err));
      })
      .finally(() => {
        invokeDone = true;
        push({ type: 'end' });
      });

    const next = (): Promise<QueueItem> => {
      const item = queue.shift();
      if (item) return Promise.resolve(item);
      if (invokeDone) return Promise.resolve({ type: 'end' });
      return new Promise((resolve) => waiters.push(resolve));
    };

    const abortHandler = () => {
      if (closed) return;
      closed = true;
      try {
        channel.close();
      } catch {
        /* channel already closed */
      }
      // Tell Rust to abort the in-flight chat_stream so it stops generating
      // (and billing tokens) immediately instead of lingering until its idle
      // timeout. No-op when the stream already finished (registry entry gone).
      deps.invoke('cancel_chat_stream', { requestId }).catch(() => {});
      push({ type: 'end' });
    };

    if (signal?.aborted) abortHandler();
    signal?.addEventListener('abort', abortHandler, { once: true });

    try {
      while (true) {
        const item = await next();
        if (item.type === 'end') break;
        if (item.value === undefined) continue;

        let payload: any;
        try {
          payload = JSON.parse(item.value);
        } catch {
          continue;
        }
        if (payload?.type === 'delta' && typeof payload.content === 'string') {
          yield { type: 'content', content: payload.content };
        }
        // Reasoning/thinking deltas (DeepSeek/Qwen/GLM `reasoning_content`)
        // flow to the UI as their own chunk so the GUI can show the model's
        // live thinking without mixing it into the visible answer.
        if (payload?.type === 'reasoning' && typeof payload.content === 'string') {
          yield { type: 'reasoning', content: payload.content };
        }
        // Tool-call argument deltas — the Rust backend forwards the
        // accumulating arguments buffer (throttled to ~100ms) so the GUI can
        // render the tool row live while a giant argument (e.g. write_file
        // `content`, a whole HTML file) is generated, instead of appearing
        // frozen until the entire stream ends. The id-bearing `done` chunk
        // still delivers the final parsed args.
        if (payload?.type === 'tool_call_delta') {
          yield {
            type: 'tool_call_delta',
            index: typeof payload.index === 'number' ? payload.index : 0,
            name: typeof payload.name === 'string' ? payload.name : undefined,
            arguments: typeof payload.arguments === 'string' ? payload.arguments : undefined,
          };
        }
        // Billing usage (OpenAI-style `usage`, DeepSeek cache-hit/miss) —
        // normalized and yielded once per stream for session stats.
        if (payload?.type === 'usage') {
          const usage: TokenUsage | undefined = normalizeTokenUsage(payload.usage);
          if (usage) yield { type: 'usage', usage };
        }
      }

      // Cancelled — do not emit a synthetic `done`.
      if (signal?.aborted) return;
      if (invokeError) throw invokeError;

      // Rust resolves with the accumulated text + tool calls once the SSE
      // stream finishes; emit the terminal `done` chunk the engine expects.
      const text: string = (finalResult?.text as string | undefined) ?? '';
      const rawToolCalls: Array<Record<string, any>> =
        (finalResult?.toolCalls as Array<Record<string, any>> | undefined) ?? [];
      const toolCalls: ToolCall[] = rawToolCalls.map((tc, i) => ({
        id: (tc.id as string | undefined) || `call_${i}`,
        index: i,
        function: {
          name: (tc.function?.name as string | undefined) ?? '',
          arguments: (tc.function?.arguments as string | undefined) ?? '',
        },
      }));
      yield { type: 'done', content: text, toolCalls };
    } finally {
      signal?.removeEventListener('abort', abortHandler);
      if (!closed && !invokeDone) {
        try {
          channel.close();
        } catch {
          /* ignore */
        }
      }
      void invokePromise;
    }
  }

  async complete(messages: Message[], tools: ToolDefinition[], signal?: AbortSignal): Promise<LLMResponse> {
    let content = '';
    let toolCalls: ToolCall[] = [];
    for await (const chunk of this.stream(messages, tools, signal)) {
      if (chunk.type === 'content') {
        content += chunk.content;
      } else if (chunk.type === 'done') {
        content = chunk.content;
        toolCalls = chunk.toolCalls;
      }
    }
    return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
  }
}

export { SECRET_KEY };
