// src/ui/__tests__/chat.test.ts

import { describe, expect, it } from 'bun:test';
import { parseToolCallBuffer } from '../chat';

describe('parseToolCallBuffer', () => {
  it('parses the { name, arguments: string } wrapper format', () => {
    const buf = JSON.stringify({ name: 'web_search', arguments: '{"query":"foo"}' });
    const parsed = parseToolCallBuffer(buf);
    expect(parsed.name).toBe('web_search');
    expect(parsed.args).toEqual({ query: 'foo' });
  });

  it('parses the { name, arguments: object } wrapper format', () => {
    const buf = JSON.stringify({ name: 'read_file', arguments: { path: 'a.ts' } });
    const parsed = parseToolCallBuffer(buf);
    expect(parsed.name).toBe('read_file');
    expect(parsed.args).toEqual({ path: 'a.ts' });
  });

  it('falls back to RAW function-arguments JSON (engine forwards tc.function.arguments verbatim)', () => {
    // This is what the Rust backend actually streams (accumulated arguments
    // object, no wrapper keys). Previously the parser returned no args here,
    // so tool rows rendered with an empty query — two parallel web_search
    // calls looked like ONE duplicated search instead of two queries.
    const buf = '{"query":"西安到重庆 机票 航班 价格","maxResults":10}';
    const parsed = parseToolCallBuffer(buf);
    expect(parsed.name).toBeUndefined();
    expect(parsed.args).toEqual({ query: '西安到重庆 机票 航班 价格', maxResults: 10 });
  });

  it('returns {} for empty or whitespace buffers', () => {
    expect(parseToolCallBuffer(undefined)).toEqual({});
    expect(parseToolCallBuffer('')).toEqual({});
    expect(parseToolCallBuffer('   ')).toEqual({});
  });

  it('returns {} for partial / invalid JSON (mid-stream fragments)', () => {
    expect(parseToolCallBuffer('{"qu')).toEqual({});
    expect(parseToolCallBuffer('not json')).toEqual({});
    expect(parseToolCallBuffer('42')).toEqual({});
    expect(parseToolCallBuffer('null')).toEqual({});
  });

  it('does not misread a name-only payload as args', () => {
    const parsed = parseToolCallBuffer('{"name":"web_search"}');
    expect(parsed.name).toBe('web_search');
    expect(parsed.args).toBeUndefined();
  });
});
