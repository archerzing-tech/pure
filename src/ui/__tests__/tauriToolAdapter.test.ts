// src/ui/__tests__/tauriToolAdapter.test.ts

import { describe, expect, it } from 'bun:test';
import { formatCommandOutput, buildCommandResult, formatWriteProgress, buildWebSearchArgs } from '../TauriToolAdapter';
import { formatCommandError, formatBytes } from '../../shared/format';

describe('formatCommandOutput', () => {
  it('joins plain stdout lines', () => {
    expect(formatCommandOutput([
      { kind: 'stdout', line: 'line one' },
      { kind: 'stdout', line: 'line two' },
    ])).toBe('line one\nline two');
  });

  it('labels stderr sections with [stderr]', () => {
    expect(formatCommandOutput([
      { kind: 'stdout', line: 'ok' },
      { kind: 'stderr', line: 'warn' },
    ])).toBe('ok\n\n[stderr]\nwarn');
  });

  it('separates multiple stderr sections', () => {
    expect(formatCommandOutput([
      { kind: 'stderr', line: 'err a' },
      { kind: 'stderr', line: 'err b' },
      { kind: 'stdout', line: 'out' },
      { kind: 'stderr', line: 'err c' },
    ])).toBe('[stderr]\nerr a\nerr b\nout\n\n[stderr]\nerr c');
  });

  it('handles empty input', () => {
    expect(formatCommandOutput([])).toBe('');
  });
});

describe('formatCommandError', () => {
  it('includes the exit code and appends output when present', () => {
    expect(formatCommandError(3, '[stderr]\nboom')).toBe('Command failed with exit code 3:\n[stderr]\nboom');
  });

  it('omits output when empty', () => {
    expect(formatCommandError(1, '')).toBe('Command failed with exit code 1');
  });

  it('trims surrounding whitespace from the output tail', () => {
    expect(formatCommandError(2, '  some output  ')).toBe('Command failed with exit code 2:\nsome output');
  });
});

describe('buildCommandResult', () => {
  it('reports success with the output for exit code 0', () => {
    const r = buildCommandResult(0, [{ kind: 'stdout', line: 'ok' }]);
    expect(r.success).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.result).toBe('ok');
  });

  it('reports failure with the exit code in the error for non-zero exits', () => {
    const r = buildCommandResult(3, [{ kind: 'stderr', line: 'boom' }]);
    expect(r.success).toBe(false);
    expect(r.error).toContain('exit code 3');
    expect(r.error).toContain('boom'); // stderr survives into the failure message
    expect(r.result).toContain('[stderr]'); // output is labeled, not swallowed
  });

  it('keeps output in the result even when the command fails', () => {
    const r = buildCommandResult(2, [{ kind: 'stdout', line: 'partial' }]);
    expect(r.success).toBe(false);
    expect(r.error).toContain('partial');
    expect(r.result).toBe('partial');
  });
});

describe('formatBytes', () => {
  it('formats bytes, KB, and MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(12 * 1024)).toBe('12.0 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});

describe('buildWebSearchArgs (Rust web_search invoke arg lock)', () => {
  it('passes the query, default maxResults, and both API keys', () => {
    expect(buildWebSearchArgs('/ws', { query: '西安到重庆 机票' }, 'tvly-1', 'serper-2')).toEqual({
      workspace: '/ws',
      query: '西安到重庆 机票',
      maxResults: 10,
      apiKey: 'tvly-1',
      serperApiKey: 'serper-2',
    });
  });

  it('keeps a caller-supplied maxResults and defaults empty keys to empty strings', () => {
    expect(buildWebSearchArgs('/ws', { query: 'rust', maxResults: 5 }, '', '')).toEqual({
      workspace: '/ws',
      query: 'rust',
      maxResults: 5,
      apiKey: '',
      serperApiKey: '',
    });
  });
});

describe('formatWriteProgress (Rust write_file_stream protocol lock)', () => {
  it('formats the exact line the adapter streams for a progress event', () => {
    // 230/512 KB = 44.9% → 45%; mirrors the Rust {type,written,total} event.
    expect(formatWriteProgress('src/foo.ts', 230 * 1024, 512 * 1024))
      .toBe('正在写入 src/foo.ts — 45% (230.0 KB/512.0 KB)');
  });

  it('treats a zero-total (empty file) as 100%', () => {
    expect(formatWriteProgress('empty.txt', 0, 0))
      .toBe('正在写入 empty.txt — 100% (0 B/0 B)');
  });

  it('shows the full write at the final chunk', () => {
    expect(formatWriteProgress('big.bin', 1024 * 1024, 1024 * 1024))
      .toBe('正在写入 big.bin — 100% (1.0 MB/1.0 MB)');
  });
});
