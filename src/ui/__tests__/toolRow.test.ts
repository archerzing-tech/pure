// src/ui/__tests__/toolRow.test.ts

import { describe, expect, it } from 'bun:test';
import { shouldExpandToolRowInitially, shouldUseTerminalPanel, highlightStreamLine, isStepHeaderLine, truncateResultLines, MAX_LIVE_STREAM_LINES } from '../toolRow';

describe('tool row expansion policy', () => {
  it('expands every execution row by default', () => {
    expect(shouldExpandToolRowInitially('execute_command')).toBe(true);
    expect(shouldExpandToolRowInitially('git_status')).toBe(true);
    expect(shouldExpandToolRowInitially('write_file')).toBe(true);
    expect(shouldExpandToolRowInitially('read_file')).toBe(true);
    expect(shouldExpandToolRowInitially('web_search')).toBe(true);
  });

});

describe('tool row terminal panel policy', () => {
  it('uses terminal panels for every file / shell / search / web tool', () => {
    expect(shouldUseTerminalPanel('read_file')).toBe(true);
    expect(shouldUseTerminalPanel('write_file')).toBe(true);
    expect(shouldUseTerminalPanel('edit_file')).toBe(true);
    expect(shouldUseTerminalPanel('replace_files')).toBe(true);
    expect(shouldUseTerminalPanel('create_directory')).toBe(true);
    expect(shouldUseTerminalPanel('diff_files')).toBe(true);
    expect(shouldUseTerminalPanel('execute_command')).toBe(true);
    expect(shouldUseTerminalPanel('list_files')).toBe(true);
    expect(shouldUseTerminalPanel('search_files')).toBe(true);
    expect(shouldUseTerminalPanel('glob_files')).toBe(true);
    expect(shouldUseTerminalPanel('git_diff')).toBe(true);
    expect(shouldUseTerminalPanel('web_search')).toBe(true);
    expect(shouldUseTerminalPanel('web_fetch')).toBe(true);
    expect(shouldUseTerminalPanel('unknown_tool')).toBe(false);
  });
});

describe('live stream line highlighting', () => {
  it('highlights percentages and step counters', () => {
    const segs = highlightStreamLine('Compiling main.rs (42%) [1/3]');
    expect(segs.some((s) => s.cls === 'progress' && s.text === '42%')).toBe(true);
    expect(segs.some((s) => s.cls === 'progress' && s.text === '1/3')).toBe(true);
  });

  it('tags error, warning, and success tokens', () => {
    expect(highlightStreamLine('error: build failed').some((s) => s.cls === 'error')).toBe(true);
    expect(highlightStreamLine('warning: unused variable').some((s) => s.cls === 'warn')).toBe(true);
    expect(highlightStreamLine('✓ Done in 1.2s').some((s) => s.cls === 'success')).toBe(true);
  });

  it('detects build-step header lines', () => {
    expect(isStepHeaderLine('> Building project')).toBe(true);
    expect(isStepHeaderLine('[1/4] Compiling core')).toBe(true);
    expect(isStepHeaderLine('==> Installing dependencies')).toBe(true);
    expect(isStepHeaderLine('  42% complete')).toBe(false);
    expect(isStepHeaderLine('[18:02:34] info: starting server')).toBe(false);
  });

  it('joins segments back into the exact original line', () => {
    const line = 'fetch https://x 50% done ok ████░';
    expect(highlightStreamLine(line).map((s) => s.text).join('')).toBe(line);
  });
});

describe('final result truncation (MAX_LIVE_STREAM_LINES)', () => {
  it('passes short output through unchanged', () => {
    const text = 'ok\n';
    expect(truncateResultLines(text)).toBe(text);
  });

  it('passes output at exactly the cap through unchanged', () => {
    const lines = Array.from({ length: MAX_LIVE_STREAM_LINES }, (_, i) => `line ${i}`);
    expect(truncateResultLines(lines.join('\n'))).toBe(lines.join('\n'));
  });

  it('caps output past the limit with a truncation notice line', () => {
    const lines = Array.from({ length: MAX_LIVE_STREAM_LINES + 100 }, (_, i) => `line ${i}`);
    const capped = truncateResultLines(lines.join('\n'));
    const out = capped.split('\n');
    expect(out.length).toBe(MAX_LIVE_STREAM_LINES + 1); // cap + notice line
    expect(out[0]).toBe('line 0');
    expect(out[out.length - 1]).toContain('100 lines truncated');
  });

  it('reports the exact cut count in the notice', () => {
    const lines = Array.from({ length: MAX_LIVE_STREAM_LINES + 7 }, (_, i) => `line ${i}`);
    expect(truncateResultLines(lines.join('\n'))).toContain('7 lines truncated');
  });

  it('does not truncate exactly-cap output that ends with a trailing newline', () => {
    const lines = Array.from({ length: MAX_LIVE_STREAM_LINES }, (_, i) => `line ${i}`);
    const text = `${lines.join('\n')}\n`; // trailing newline → split yields an empty tail
    expect(truncateResultLines(text)).toBe(text);
    expect(truncateResultLines(text)).not.toContain('truncated');
  });
});
