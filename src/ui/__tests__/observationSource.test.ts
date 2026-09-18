// src/ui/__tests__/observationSource.test.ts
// E4.2 — GUI 观测数据入口：普通浏览器模式没有后端，返回 unavailable；e2e 通过
// globalThis.__PURE_OBSERVATION_FEED__ 注入 JSONL 时走与 Rust 尾巴读同一条解析器。

import { describe, it, expect, afterEach } from 'bun:test';
import { readGuiObservations } from '../observationSource';

const FEED_KEY = '__PURE_OBSERVATION_FEED__';

function setFeed(value: unknown): void {
  (globalThis as Record<string, unknown>)[FEED_KEY] = value;
}

function clearFeed(): void {
  delete (globalThis as Record<string, unknown>)[FEED_KEY];
}

describe('readGuiObservations', () => {
  afterEach(clearFeed);

  it('reports unavailable when there is neither a backend nor an injected feed', async () => {
    const read = await readGuiObservations();
    expect(read.available).toBe(false);
    expect(read.records).toEqual([]);
    expect(read.path).toBe('');
  });

  it('parses an injected JSONL feed and skips broken lines', async () => {
    setFeed([
      JSON.stringify({ schemaVersion: 1, type: 'agent_run', traceId: 't1', startedAt: 1, eventCounts: {}, toolCalls: [], reasoningChars: 0, outputChars: 0 }),
      'not json at all',
      JSON.stringify({ schemaVersion: 1, type: 'prompt_assembly', traceId: 't2', timestamp: 2, promptVersion: 'v', system: { chars: 0, hash: 'h' }, budget: {} }),
    ].join('\n'));

    const read = await readGuiObservations();
    expect(read.available).toBe(true);
    expect(read.records.map((record) => record.type)).toEqual(['agent_run', 'prompt_assembly']);
    expect(read.truncated).toBe(false);
    expect(read.path).toContain('injected');
    expect(read.totalBytes).toBe(read.readBytes);
  });

  it('ignores a non-string feed value instead of throwing', async () => {
    setFeed({ type: 'agent_run' });
    const read = await readGuiObservations();
    expect(read.available).toBe(false);
  });
});
