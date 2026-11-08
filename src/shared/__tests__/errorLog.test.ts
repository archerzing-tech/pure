// src/shared/__tests__/errorLog.test.ts
import { describe, it, expect } from 'bun:test';
import { formatErrorLine, buildToolErrorEntry, ERROR_LOG_FIELD_CAP, type ErrorLogEntry } from '../errorLog';

describe('formatErrorLine', () => {
  it('emits the four-source JSONL contract shape', () => {
    const line = formatErrorLine({ ts: 1794111206832, source: 'tool', kind: 'tool_error', message: 'boom', detail: 'durationMs=12' });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.ts).toBe(1794111206832);
    expect(parsed.source).toBe('tool');
    expect(parsed.kind).toBe('tool_error');
    expect(parsed.message).toBe('boom');
    expect(parsed.detail).toBe('durationMs=12');
    expect('stack' in parsed).toBe(false);
  });

  it('omits empty fields and caps oversize ones', () => {
    const long = 'x'.repeat(ERROR_LOG_FIELD_CAP + 500);
    const line = formatErrorLine({ ts: 1, source: 'rust', kind: 'panic', message: long, detail: '', stack: long });
    const parsed = JSON.parse(line) as { message: string; stack: string; detail?: string };
    expect(parsed.message.length).toBe(ERROR_LOG_FIELD_CAP);
    expect(parsed.stack.length).toBe(ERROR_LOG_FIELD_CAP);
    expect('detail' in parsed).toBe(false);
  });
});

describe('buildToolErrorEntry', () => {
  it('prefixes the tool name and never carries argument values', () => {
    // 参数值纪律：configure_channel 的参数里就是凭据明文，台账只许记
    // 工具名+错误文本+耗时。
    const entry: ErrorLogEntry = buildToolErrorEntry(42, 'configure_channel', 'credential rejected by platform', 340);
    expect(entry.source).toBe('tool');
    expect(entry.kind).toBe('tool_error');
    expect(entry.message).toBe('configure_channel: credential rejected by platform');
    expect(entry.detail).toBe('durationMs=340');
    expect(JSON.stringify(entry)).not.toContain('appSecret');
    expect(JSON.stringify(entry)).not.toContain('1903065122');
  });

  it('falls back when the failure carries no error text', () => {
    const entry = buildToolErrorEntry(1, 'web_fetch', '', 5);
    expect(entry.message).toBe('web_fetch: (no error text)');
  });
});
