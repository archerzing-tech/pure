// src/adapter/openai/__tests__/OpenAICompatibleAdapter.test.ts
// Provider factory functions honor a per-provider endpoint override (CLI
// providerOverrides, synced from the GUI's Settings → LLM → 连接设置).

import { describe, it, expect, beforeEach } from 'bun:test';
import { createDeepSeekAdapter, createQwenAdapter, createGLMAdapter, OpenAICompatibleAdapter } from '../OpenAICompatibleAdapter';
import { resetParamHealForTests } from '../../../shared/paramRejectionHeal';
import type { Message, ToolDefinition } from '../../../shared/types';

beforeEach(() => resetParamHealForTests());

/** Read the base URL the OpenAI SDK client actually holds. */
function clientBaseURL(adapter: { client: { baseURL: string } }): string {
  return adapter.client.baseURL;
}

describe('provider adapter factories — endpoint overrides', () => {
  it('createDeepSeekAdapter defaults to the official endpoint and honors an override', () => {
    expect(clientBaseURL(createDeepSeekAdapter('sk-1', 'deepseek-v4-flash') as never))
      .toBe('https://api.deepseek.com');
    expect(clientBaseURL(createDeepSeekAdapter('sk-1', 'deepseek-v4-flash', 'https://gateway.example.com/v1') as never))
      .toBe('https://gateway.example.com/v1');
  });

  it('createQwenAdapter defaults to the workspace deployment and honors an override without a workspace', () => {
    expect(clientBaseURL(createQwenAdapter('sk-1', 'ws-123', 'qwen3-coder-next') as never))
      .toBe('https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
    expect(clientBaseURL(createQwenAdapter('sk-1', '', 'qwen3-coder-next', 'https://dashscope.aliyuncs.com/compatible-mode/v1') as never))
      .toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
  });

  it('createGLMAdapter defaults to the z.ai endpoint and honors an override', () => {
    expect(clientBaseURL(createGLMAdapter('sk-1') as never))
      .toBe('https://api.z.ai/api/coding/paas/v4');
    expect(clientBaseURL(createGLMAdapter('sk-1', 'glm-5.3-flash', 'https://open.bigmodel.cn/api/paas/v4') as never))
      .toBe('https://open.bigmodel.cn/api/paas/v4');
  });
});

// ── 参数拒绝自愈（2026-11-18 DeepSeek V4.1 真机 400 判例）─────────────────

describe('OpenAICompatibleAdapter param-rejection heal', () => {
  const MSGS: Message[] = [{ role: 'user', content: 'hi' }];
  const TOOLS: ToolDefinition[] = [];
  const DEEPSEEK_400 = '400 Bad Request: {"error":{"message":"DeepSeek V4.1 reasoning_effort must be low, high, xhigh, max, or an integer within [1, 100] in chat_template_kwargs"}}';

  function adapterWithScript(script: Array<{ ok: boolean; params?: unknown; stream?: boolean }>) {
    const adapter = new OpenAICompatibleAdapter({
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      model: 'deepseek-v4.1',
      extraBody: { reasoning_effort: 'medium', tool_stream: true },
    });
    const calls: unknown[] = [];
    let step = 0;
    (adapter as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            calls.push(params);
            const entry = script[Math.min(step, script.length - 1)];
            step++;
            if (!entry.ok) throw new Error(DEEPSEEK_400);
            if (entry.stream) {
              return (async function* () {
                yield { choices: [{ delta: { content: 'ok' } }] };
                yield { choices: [{}], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
              })();
            }
            return { choices: [{ message: { content: 'ok', tool_calls: [] } }] };
          },
        },
      },
    };
    return { adapter: adapter as OpenAICompatibleAdapter, calls };
  }

  it('stream: 400 拒参后撤参原地重试一次，回合不中断', async () => {
    const { adapter, calls } = adapterWithScript([{ ok: false }, { ok: true, stream: true }]);
    const chunks = [];
    for await (const c of adapter.stream(MSGS, TOOLS)) chunks.push(c);
    expect(chunks.some((c) => c.type === 'content' && c.content === 'ok')).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[0]).toMatchObject({ reasoning_effort: 'medium', tool_stream: true });
    // 重试请求撤掉了被拒的键、保留了没被拒的。
    expect(calls[1]).toMatchObject({ tool_stream: true });
    expect((calls[1] as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it('complete: 同一条自愈路径覆盖非流式调用', async () => {
    const { adapter, calls } = adapterWithScript([{ ok: false }, { ok: true }]);
    const res = await adapter.complete(MSGS, TOOLS);
    expect(res.content).toBe('ok');
    expect(calls.length).toBe(2);
    expect((calls[1] as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it('撤参后本进程后续请求不再带该键（sticky 记账）', async () => {
    const { adapter, calls } = adapterWithScript([{ ok: false }, { ok: true, stream: true }, { ok: true, stream: true }]);
    for await (const _ of adapter.stream(MSGS, TOOLS)) { void _; }
    for await (const _ of adapter.stream(MSGS, TOOLS)) { void _; }
    expect(calls.length).toBe(3);
    // 第二次 stream 的首个请求直接就是撤参后的形状——无需再吃一个 400。
    expect(calls[2]).toMatchObject({ tool_stream: true });
    expect((calls[2] as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it('非参数类 400（网络/凭证）不触发撤参重试', async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk', model: 'm',
      extraBody: { reasoning_effort: 'medium' },
    });
    let calls = 0;
    (adapter as unknown as { client: unknown }).client = {
      chat: { completions: { create: async () => { calls++; throw new Error('401 Unauthorized: invalid api key'); } } },
    };
    let threw = false;
    try {
      await adapter.complete(MSGS, TOOLS);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(calls).toBe(1);
  });
});
