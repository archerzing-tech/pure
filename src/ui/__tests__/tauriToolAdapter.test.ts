// src/ui/__tests__/tauriToolAdapter.test.ts

import { describe, expect, it } from 'bun:test';
import { formatCommandOutput, buildCommandResult, formatWriteProgress, buildWebSearchArgs, buildCodeSearchArgs, filterResearchSources, researchLimits, TauriToolAdapter } from '../TauriToolAdapter';
import type { ToolCall } from '../../shared/types';
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

  it('forwards a configured proxy only when one is enabled', () => {
    expect(buildWebSearchArgs('/ws', { query: 'rust' }, '', '', 'socks5://127.0.0.1:1080').proxyUrl)
      .toBe('socks5://127.0.0.1:1080');
  });
});

describe('research tool argument contracts', () => {
  it('forwards the full code search contract to Rust', () => {
    expect(buildCodeSearchArgs('/ws', {
      query: 'useActionState',
      path: 'src',
      globs: ['*.ts', '!*.test.ts'],
      caseSensitive: false,
      maxResults: 7,
      globalMaxResults: 19,
      timeoutSeconds: 4,
    })).toEqual({
      workspace: '/ws',
      query: 'useActionState',
      path: 'src',
      globs: ['*.ts', '!*.test.ts'],
      caseSensitive: false,
      maxResults: 7,
      globalMaxResults: 19,
      timeoutSeconds: 4,
    });
  });

  it('filters sources by hostname and clamps research limits', () => {
    const sources = [
      { title: 'Docs', snippet: 'x', url: 'https://docs.example.com/api' },
      { title: 'Other', snippet: 'y', url: 'https://other.example.net' },
    ];
    expect(filterResearchSources(sources, ['example.com'])).toEqual([sources[0]]);
    expect(researchLimits({ maxSources: 99, maxCharsPerSource: 1 })).toEqual({ maxSources: 8, maxCharsPerSource: 500 });
  });
});

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `test_${name}`, index: 0, function: { name, arguments: JSON.stringify(args) } };
}

describe('Tauri researcher execution paths', () => {
  it('reports empty web research as a failed tool result', async () => {
    const invoke = async (command: string) => command === 'web_search' ? 'No results found' : '';
    const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('researcher_web', { prompt: 'missing' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('No usable research sources');
  });

  it('fetches documentation evidence and preserves the structured payload', async () => {
    const calls: string[] = [];
    const invoke = async (command: string) => {
      calls.push(command);
      if (command === 'web_search') return ['1. React docs', '   API reference', '   https://docs.example.com/react'].join('\n');
      if (command === 'web_fetch') return 'useActionState reference';
      throw new Error(`unexpected command: ${command}`);
    };
    const result = await new TauriToolAdapter('/ws', '', '', '', invoke).execute(toolCall('researcher_docs', {
      library: 'React',
      topic: 'useActionState',
      maxSources: 1,
    }));
    expect(result.success).toBe(true);
    expect(calls).toEqual(['web_search', 'web_fetch']);
    const payload = JSON.parse(String(result.result)) as { sources: Array<{ content?: string }>; officialVerified?: boolean };
    expect(payload.sources[0].content).toBe('useActionState reference');
    expect(payload.officialVerified).toBe(false);
  });
});

describe('Tauri workspace snapshots', () => {
  it('captures and restores a write through the IPC contract', async () => {
    let exists = true;
    let content = 'before';
    const invoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (command === 'path_info') return { exists, isDirectory: false };
      if (command === 'read_file') return content;
      if (command === 'write_file') {
        exists = true;
        content = String(args?.content ?? '');
        return `Wrote ${content.length} bytes`;
      }
      if (command === 'remove_path') {
        exists = false;
        return 'Removed';
      }
      throw new Error(`unexpected command: ${command}`);
    };
    const adapter = new TauriToolAdapter('/ws', '', '', '', invoke, 'session-tauri');
    const changed = await adapter.execute(toolCall('write_file', { path: 'app.ts', content: 'after' }));
    expect(changed.success).toBe(true);
    expect(adapter.getSnapshotPort().getLatestWriteBatch()?.sessionId).toBe('session-tauri');
    const restored = await adapter.getSnapshotPort().undoLastWriteBatch();
    expect(restored.restored).toBe(true);
    expect(content).toBe('before');
  });

  it('does not restore over a newer external value', async () => {
    let exists = false;
    let content = '';
    const invoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (command === 'path_info') return { exists, isDirectory: false };
      if (command === 'read_file') return content;
      if (command === 'write_file') { exists = true; content = String(args?.content ?? ''); return 'Wrote'; }
      if (command === 'remove_path') { exists = false; return 'Removed'; }
      throw new Error(`unexpected command: ${command}`);
    };
    const adapter = new TauriToolAdapter('/ws', '', '', '', invoke);
    await adapter.execute(toolCall('write_file', { path: 'new.ts', content: 'agent' }));
    content = 'user';
    const result = await adapter.getSnapshotPort().undoLastWriteBatch();
    expect(result.restored).toBe(false);
    expect(result.conflicts).toEqual(['new.ts']);
    expect(content).toBe('user');
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
