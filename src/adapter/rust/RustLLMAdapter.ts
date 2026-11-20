// src/adapter/rust/RustLLMAdapter.ts
// v0.1 — LLM transport through the Tauri Rust backend.
// Security model (per design doc §2.1): the API key never enters the
// WebView. It lives in ~/.pure/secrets.json (0600) and is resolved inside
// the Rust `chat_stream` command. The WebView only sends provider/baseUrl/
// model + messages, and receives SSE deltas over a Channel.
// The adapter is also injectable (constructor deps) so unit tests can mock
// invoke + Channel without a live Tauri runtime.

import type {
  AssistantThinkingBlock,
  LLMAdapter,
  LLMChunk,
  LLMResponse,
  Message,
  ToolCall,
  TokenUsage,
  ToolDefinition,
} from '../../shared/types';
import { normalizeTokenUsage } from '../../shared/usage';
import { buildChatParams, stripAllThinking, stripHistoricalThinking } from '../openai/mapping';
import { isTauriRuntime } from '../../shared/tauri';
import { paramHealScope, planParamWithdrawal, recordParamWithdrawal, withdrawExtraBody } from '../../shared/paramRejectionHeal';

export interface RustLLMConfig {
  provider: string;
  model: string;
  protocol?: 'openai' | 'anthropic';
  baseURL?: string;
  extraBody?: Record<string, unknown>;
  /** Anthropic 扩展思考预算；仅 claude-3.7/4 系 + anthropic 协议由宿主设置。
   *  工具循环里 Rust 会把最近一条 assistant 的 thinking 块原样回传。 */
  thinkingBudget?: number;
  maxTokens?: number;
  temperature?: number;
  /**
   * Exact secrets-store key to resolve when `apiKey` is omitted (desktop).
   * Every provider passes 'llm.apiKey.<id>' so each keeps its own key; keyless
   * custom providers pass a key name that resolves to nothing → the
   * Authorization header is omitted.
   */
  secretKey?: string;
  /** Allow the named `secretKey` slot to fall back to the legacy shared
   *  'llm.apiKey' slot when it is missing. Built-in providers pass true (a key
   *  written before per-provider slots still lives there); keyless custom
   *  endpoints pass false so they never receive an unrelated key. */
  allowLegacyKeyFallback?: boolean;
  proxyUrl?: string;
  /** One-shot opposite-route fallback for the Rust request layer: '' = direct,
   *  a URL = that proxy, undefined = no fallback (netRouteProxyPair shape). */
  fallbackProxyUrl?: string;
  /** Real-outcome feedback for the netRoute learning: which route served the
   *  turn (or which failed). headersMs = response-header time (TCP+TLS+proxy
   *  negotiation, clean of prefill/thinking) when ok — the slow-direct
   *  evidence for the learner. Wired by chat.ts to recordNetOutcome. */
  onNetOutcome?: (outcome: { route: 'direct' | 'proxy'; ok: boolean; headersMs?: number }) => void;
  /** Fired when the Rust transport fails over — i.e. the PRIMARY route just
   *  failed a connect attempt even though the request as a whole will likely
   *  succeed on the fallback. The catch-path never runs in that case, so
   *  without this the learner never hears about primary failures and keeps
   *  re-picking them (2026-10-29: empty table → every session's first turn
   *  re-dials a dead proxy port and flashes the failover label). */
  onPrimaryFailure?: () => void;
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

/**
 * Network-class transport errors: connection refused/reset, timeouts, TLS
 * handshake failures, dead proxies. These mean the pooled TCP connections
 * (or the path to them) died — NOT that the provider rejected the request —
 * so the backend's cached LLM stream client must be dropped before the next
 * retry. Cancellation never reaches this matcher, and provider-side
 * rejections (400/401/429 bodies, context-length overflow) don't match.
 */
const NETWORK_ERROR_RE = /connect|timed?\s?out|timeout|reset|broken pipe|connection|tls|ssl|certificate|ECONN|ETIMEDOUT|ECONNRESET|EPIPE|unreachable|network|proxy/i;

function isNetworkClassError(err: Error): boolean {
  return NETWORK_ERROR_RE.test(err.message);
}

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

  /**
   * 参数拒绝自愈的流式包装：端点 400 拒收 extraBody 里的某个键（如 DeepSeek
   * V4.1 不收 reasoning_effort=medium）时，记账撤参、原地重试一次——回合
   * 不中断。只在**零 payload 已吐出**时重试：400 在任何 SSE delta 之前就被
   * 拒，重发不会重复内容；一旦已有内容吐给引擎，重发会造成重复输出，此时
   * 原样上抛。重试仍败才把原始错误交给引擎的确定性止损阶梯。
   */
  async *stream(
    messages: Message[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<LLMChunk, void, void> {
    const scope = paramHealScope(this.config.baseURL, this.config.model);
    for (let attempt = 0; ; attempt++) {
      let sawPayload = false;
      try {
        for await (const chunk of this.streamCore(messages, tools, signal, withdrawExtraBody(this.config.extraBody, scope))) {
          if (chunk.type !== 'status') sawPayload = true;
          yield chunk;
        }
        return;
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        const param = attempt === 0 && !signal?.aborted && !sawPayload
          ? planParamWithdrawal(text, Object.keys(this.config.extraBody ?? {}))
          : null;
        if (!param) throw err;
        recordParamWithdrawal(scope, param);
      }
    }
  }

  private async *streamCore(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal | undefined,
    extraBody: Record<string, unknown> | undefined,
  ): AsyncGenerator<LLMChunk, void, void> {
    const deps = await this.getDeps();
    const protocol = this.config.protocol ?? 'openai';
    // 旧会话（功能上线前）里最近的工具调用没有 thinking 块；此时再开 thinking
    // 会让 Anthropic 以“必须原样保留思考块”拒绝整个请求，宁可不升级这条会话。
    const lastToolAssistant = [...messages].reverse().find(
      (m) => m.role === 'assistant' && m.toolCalls?.length,
    );
    const thinkingBudget = protocol === 'anthropic'
      && this.config.thinkingBudget
      && (!lastToolAssistant || lastToolAssistant.thinkingBlocks?.length)
      ? this.config.thinkingBudget
      : undefined;
    const wireMessages = protocol === 'anthropic'
      ? (thinkingBudget ? stripHistoricalThinking(messages) : stripAllThinking(messages))
      : messages;
    const params = buildChatParams({
      model: this.config.model,
      messages: wireMessages,
      tools,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
      extraBody,
      includeThinkingBlocks: protocol === 'anthropic',
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
          protocol: this.config.protocol ?? 'openai',
          apiKey: '',
          baseUrl: this.config.baseURL ?? '',
          secretKey: this.config.secretKey ?? '',
          allowLegacyKeyFallback: this.config.allowLegacyKeyFallback ?? false,
          extraBody,
          maxTokens: params.max_tokens,
          ...(thinkingBudget ? { thinkingBudget } : {}),
          temperature: params.temperature,
          requestId,
          proxyUrl: this.config.proxyUrl ?? '',
          // Must be ABSENT (not empty) when there is no fallback: Rust reads
          // Some("") as the DIRECT route.
          ...(this.config.fallbackProxyUrl !== undefined
            ? { fallbackProxyUrl: this.config.fallbackProxyUrl }
            : {}),
          proxyBypassProviders: this.config.proxyBypassProviders ?? [],
        },
        onChunk: channel,
      })
      .then((res) => {
        finalResult = res;
        // Report the route that ACTUALLY served this turn (Rust echoes it in
        // the result; an older backend without the field falls back to what
        // was chosen here) so the WebView's netRoute learning pins what worked.
        const resObj = res as { netRoute?: 'direct' | 'proxy'; headersMs?: number } | null;
        const route = resObj?.netRoute
          ?? (this.config.proxyUrl ? 'proxy' : 'direct');
        this.config.onNetOutcome?.({ route, ok: true, headersMs: resObj?.headersMs });
      })
      .catch((err: unknown) => {
        invokeError = err instanceof Error ? err : new Error(String(err));
        // Cancelled turns say nothing about route health — never poison the
        // learning with them.
        if (signal?.aborted || invokeError.message === 'cancelled') return;
        this.config.onNetOutcome?.({
          route: this.config.proxyUrl ? 'proxy' : 'direct',
          ok: false,
        });
        // Intranet kill switch for the half-open-connection bug: NAT/firewalls
        // silently reclaim idle TCP sessions between turns, the next turn
        // writes onto a dead pooled connection, and the engine's THINK-round
        // retries would reuse the SAME cached client (same dead pool) until
        // the failure policy stops the session ("已中断：连续多次尝试失败").
        // Ask Rust to drop the pool so the next attempt builds fresh
        // connections. Fire-and-forget — the original error still propagates.
        if (isNetworkClassError(invokeError)) {
          deps.invoke('reset_llm_stream_clients', {}).catch(() => {});
        }
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
        // Wire-lifecycle notices (connection retry / backoff / route failover)
        // — forwarded so the engine can surface them and the GUI can label the
        // silent connect window honestly. Best-effort by nature; unknown
        // stages are dropped rather than guessed at.
        if (payload?.type === 'status' && typeof payload.stage === 'string') {
          const stages = ['retrying', 'connected', 'failover'] as const;
          const stage = stages.find((s) => s === payload.stage);
          if (stage === 'failover') this.config.onPrimaryFailure?.();
          if (stage) {
            yield {
              type: 'status',
              stage,
              attempt: typeof payload.attempt === 'number' ? payload.attempt : undefined,
              maxAttempts: typeof payload.maxAttempts === 'number' ? payload.maxAttempts : undefined,
              waitMs: typeof payload.waitMs === 'number' ? payload.waitMs : undefined,
            };
          }
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
      const thinkingBlocks = (finalResult?.thinkingBlocks as AssistantThinkingBlock[] | undefined) ?? [];
      // 刀 3：Rust 侧截断信号（finish_reason=length / stop_reason=max_tokens）
      // 原样透传——引擎靠它区分「模型写错 JSON」与「参数被输出上限砍半」。
      const truncated = finalResult?.truncated === true;
      yield {
        type: 'done',
        content: text,
        toolCalls,
        truncated,
        ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
      };
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
    let thinkingBlocks: AssistantThinkingBlock[] | undefined;
    for await (const chunk of this.stream(messages, tools, signal)) {
      if (chunk.type === 'content') {
        content += chunk.content;
      } else if (chunk.type === 'done') {
        content = chunk.content;
        toolCalls = chunk.toolCalls;
        thinkingBlocks = chunk.thinkingBlocks;
      }
    }
    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      thinkingBlocks,
    };
  }
}

export { SECRET_KEY };
