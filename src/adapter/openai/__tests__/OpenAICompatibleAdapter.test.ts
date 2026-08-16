// src/adapter/openai/__tests__/OpenAICompatibleAdapter.test.ts
// Provider factory functions honor a per-provider endpoint override (CLI
// providerOverrides, synced from the GUI's Settings → LLM → 连接设置).

import { describe, it, expect } from 'bun:test';
import { createDeepSeekAdapter, createQwenAdapter, createGLMAdapter } from '../OpenAICompatibleAdapter';

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
    expect(clientBaseURL(createGLMAdapter('sk-1', 'glm-5.2') as never))
      .toBe('https://api.z.ai/api/paas/v4');
    expect(clientBaseURL(createGLMAdapter('sk-1', 'glm-5.2', 'https://open.bigmodel.cn/api/paas/v4') as never))
      .toBe('https://open.bigmodel.cn/api/paas/v4');
  });
});
