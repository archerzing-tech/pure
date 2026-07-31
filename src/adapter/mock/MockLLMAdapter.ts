// src/adapter/mock/MockLLMAdapter.ts
// v0.1 — returns a fixed scripted response. No tools, no streaming complexity.

import type { LLMAdapter, Message, ToolDefinition, LLMChunk, LLMResponse } from '../../shared/types';

export class MockLLMAdapter implements LLMAdapter {
  private response: string;

  constructor(response = 'Hello! This is a mock response from the v0.1 pure agent. The architecture is wired up correctly.') {
    this.response = response;
  }

  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _signal?: AbortSignal,
  ): AsyncGenerator<LLMChunk, void, void> {
    // v0.1: yield content character by character for basic streaming feel
    for (const ch of this.response) {
      yield { type: 'content' as const, content: ch };
    }
    yield { type: 'done' as const, content: this.response, toolCalls: [] };
  }

  async complete(
    _messages: Message[],
    _tools: ToolDefinition[],
  ): Promise<LLMResponse> {
    return { content: this.response, toolCalls: [] };
  }
}
