// src/adapter/rust/__tests__/RustLLMAdapter.test.ts

import { describe, it, expect } from 'bun:test';
import { RustLLMAdapter, type RustLLMDeps } from '../RustLLMAdapter';
import type { LLMChunk, Message, ToolDefinition } from '../../../shared/types';

// ── Mock Tauri primitives ──

class MockChannel<T = unknown> {
  onmessage: ((message: T) => void) | null = null;
  closed = false;
  send(message: T) {
    this.onmessage?.(message);
  }
  close() {
    this.closed = true;
  }
}

interface MockInvokeScript {
  /** Simulated SSE deltas to push through the channel before resolving. */
  deltas?: string[];
  /** Final resolved value (the accumulated result from Rust). */
  result?: unknown;
  /** Simulated invoke rejection. */
  error?: string;
}

function makeDeps(script: MockInvokeScript): { deps: RustLLMDeps; lastArgs: () => any } {
  let lastArgs: any = null;
  const invoke = async (cmd: string, args: any) => {
    expect(cmd).toBe('chat_stream');
    lastArgs = args;
    const channel = args.onChunk as MockChannel<string>;
    for (const delta of script.deltas ?? []) {
      channel.send(delta);
    }
    if (script.error) throw new Error(script.error);
    return script.result;
  };
  return {
    deps: { invoke, Channel: MockChannel as unknown as RustLLMDeps['Channel'] },
    lastArgs: () => lastArgs,
  };
}

const TOOL: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } } },
};

const MSGS: Message[] = [{ role: 'user', content: 'hi' }];

describe('RustLLMAdapter', () => {
  it('streams content deltas and emits a final done chunk with tool calls', async () => {
    const { deps, lastArgs } = makeDeps({
      deltas: [
        JSON.stringify({ type: 'delta', content: 'Hel' }),
        JSON.stringify({ type: 'delta', content: 'lo' }),
      ],
      result: {
        text: 'Hello',
        toolCalls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
      },
    });

    const adapter = new RustLLMAdapter(
      { provider: 'deepseek-openai', model: 'deepseek-v4-flash', baseURL: 'https://api.deepseek.com' },
      deps,
    );

    const chunks: string[] = [];
    let done: { content: string; toolCalls: any[] } | null = null;
    for await (const chunk of adapter.stream(MSGS, [TOOL])) {
      if (chunk.type === 'content') chunks.push(chunk.content);
      if (chunk.type === 'done') done = { content: chunk.content, toolCalls: chunk.toolCalls };
    }

    expect(chunks).toEqual(['Hel', 'lo']);
    expect(done).not.toBeNull();
    expect(done!.content).toBe('Hello');
    expect(done!.toolCalls).toHaveLength(1);
    expect(done!.toolCalls[0].function.name).toBe('read_file');

    // The API key must never leave the WebView.
    const args = lastArgs();
    expect(args.args.apiKey).toBe('');
    expect(args.args.messages[0]).toEqual({ role: 'user', content: 'hi' });
    expect(args.args.tools[0].type).toBe('function');
    expect(args.args.baseUrl).toBe('https://api.deepseek.com');
  });

  it('streams reasoning deltas as reasoning chunks, separate from content', async () => {
    const { deps } = makeDeps({
      deltas: [
        JSON.stringify({ type: 'reasoning', content: 'Let me think about this.' }),
        JSON.stringify({ type: 'delta', content: 'Answer here.' }),
      ],
      result: { text: 'Answer here.', toolCalls: [] },
    });

    const adapter = new RustLLMAdapter(
      { provider: 'deepseek-openai', model: 'deepseek-v4-flash', baseURL: 'https://api.deepseek.com' },
      deps,
    );

    const contents: string[] = [];
    const reasoning: string[] = [];
    for await (const chunk of adapter.stream(MSGS, [])) {
      if (chunk.type === 'content') contents.push(chunk.content);
      if (chunk.type === 'reasoning') reasoning.push(chunk.content);
    }

    expect(reasoning).toEqual(['Let me think about this.']);
    expect(contents).toEqual(['Answer here.']);
  });

  it('forwards tool_call_delta payloads as tool_call_delta chunks', async () => {
    const { deps } = makeDeps({
      deltas: [
        JSON.stringify({ type: 'tool_call_delta', index: 0, name: 'write_file', arguments: '{"path":' }),
        JSON.stringify({ type: 'tool_call_delta', index: 0, name: 'write_file', arguments: '{"path":"snake.html","content":"<html>' }),
      ],
      result: { text: '', toolCalls: [{ id: 'c1', function: { name: 'write_file', arguments: '{"path":"snake.html","content":"<html></html>"}' } }] },
    });

    const adapter = new RustLLMAdapter(
      { provider: 'deepseek-openai', model: 'deepseek-v4-flash' },
      deps,
    );

    const deltas: string[] = [];
    for await (const chunk of adapter.stream(MSGS, [])) {
      if (chunk.type === 'tool_call_delta') {
        deltas.push(`${chunk.name ?? ''}:${chunk.arguments ?? ''}`);
      }
    }

    expect(deltas).toEqual([
      'write_file:{"path":',
      'write_file:{"path":"snake.html","content":"<html>',
    ]);
  });

  it('passes provider extraBody through to the request args', async () => {
    const { deps, lastArgs } = makeDeps({ deltas: [JSON.stringify({ type: 'delta', content: 'ok' })], result: { text: 'ok', toolCalls: [] } });
    const adapter = new RustLLMAdapter(
      { provider: 'glm', model: 'glm-5.2', extraBody: { tool_stream: true } },
      deps,
    );
    const out: string[] = [];
    for await (const chunk of adapter.stream(MSGS, [])) {
      if (chunk.type === 'content') out.push(chunk.content);
    }
    expect(out).toEqual(['ok']);
    expect(lastArgs().args.extraBody).toEqual({ tool_stream: true });
  });

  it('stops without emitting done when aborted mid-stream', async () => {
    const { deps } = makeDeps({
      deltas: [JSON.stringify({ type: 'delta', content: 'partial' })],
      result: { text: 'partial', toolCalls: [] },
    });
    const adapter = new RustLLMAdapter(
      { provider: 'deepseek-openai', model: 'm' },
      deps,
    );

    const controller = new AbortController();
    const received: string[] = [];
    const iterator = adapter.stream(MSGS, [], controller.signal)[Symbol.asyncIterator]();

    const first = await iterator.next();
    const chunk = first.value as Extract<LLMChunk, { type: 'content' }>;
    expect(chunk.type).toBe('content');
    received.push(chunk.content);

    controller.abort();
    const second = await iterator.next();
    expect(second.done).toBe(true);
    expect(received).toEqual(['partial']);
  });

  it('rethrows invoke errors (e.g. HTTP 401) to the caller', async () => {
    const { deps } = makeDeps({ error: '401 Unauthorized: invalid key' });
    const adapter = new RustLLMAdapter(
      { provider: 'deepseek-openai', model: 'm' },
      deps,
    );

    let caught: Error | null = null;
    try {
      for await (const _ of adapter.stream(MSGS, [])) { /* drain */ }
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('401 Unauthorized');
  });

  it('complete() accumulates the final response', async () => {
    const { deps } = makeDeps({
      deltas: [JSON.stringify({ type: 'delta', content: 'answer' })],
      result: { text: 'answer', toolCalls: [{ id: 'c1', function: { name: 'write_file', arguments: '{}' } }] },
    });
    const adapter = new RustLLMAdapter(
      { provider: 'deepseek-openai', model: 'm' },
      deps,
    );
    const res = await adapter.complete(MSGS, []);
    expect(res.content).toBe('answer');
    expect(res.toolCalls).toHaveLength(1);
  });

  it('aborting the stream fires cancel_chat_stream with the same request id', async () => {
    const invokeCalls: Array<{ cmd: string; args: any }> = [];
    // chat_stream never resolves in this test; only cancel_chat_stream does.
    const never = new Promise<unknown>(() => {});
    const deps = {
      invoke: async (cmd: string, args: any) => {
        invokeCalls.push({ cmd, args });
        if (cmd === 'cancel_chat_stream') return true;
        return never;
      },
      Channel: MockChannel as unknown as RustLLMDeps['Channel'],
    };
    const adapter = new RustLLMAdapter(
      { provider: 'deepseek-openai', model: 'deepseek-v4-flash' },
      deps,
    );

    const ac = new AbortController();
    const gen = adapter.stream(MSGS, [], ac.signal);

    // Async generators are lazy — kick the body with a first next() (it
    // suspends at `await this.getDeps()` before invoking chat_stream, hence
    // the microtask flush), then keep the returned promise for draining below
    // so the stream is never double-awaited.
    const first = gen.next();
    await new Promise((r) => setTimeout(r, 0));

    // chat_stream is invoked with a fresh request id (nested under the outer
    // { args, onChunk } invoke payload, unlike cancel_chat_stream's flat args).
    const startArgs = invokeCalls.find(c => c.cmd === 'chat_stream')!.args;
    expect(startArgs.args.requestId).toBeTruthy();

    // Abort → the handler must tell Rust to cancel THE SAME stream.
    ac.abort();
    const cancel = invokeCalls.find(c => c.cmd === 'cancel_chat_stream');
    expect(cancel?.args.requestId).toBe(startArgs.args.requestId);

    // The generator ends without emitting a synthetic `done`.
    const types: string[] = [];
    const firstResult = await first;
    if (!firstResult.done) types.push(firstResult.value.type);
    for await (const c of gen) types.push(c.type);
    expect(types).not.toContain('done');
  });
});
