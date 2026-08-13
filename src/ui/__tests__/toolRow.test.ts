// src/ui/__tests__/toolRow.test.ts

import { describe, expect, it } from 'bun:test';
import { shouldExpandToolRowInitially, shouldUseTerminalPanel, toolDisplayName, toolIcon, formatToolArgsSummary, highlightStreamLine, isStepHeaderLine, truncateResultLines, MAX_LIVE_STREAM_LINES, pendingActionLabel } from '../toolRow';

describe('tool row expansion policy', () => {
  it('expands every execution row by default', () => {
    expect(shouldExpandToolRowInitially('execute_command')).toBe(true);
    expect(shouldExpandToolRowInitially('git_status')).toBe(true);
    expect(shouldExpandToolRowInitially('write_file')).toBe(true);
    expect(shouldExpandToolRowInitially('read_file')).toBe(true);
    expect(shouldExpandToolRowInitially('web_search')).toBe(true);
  });

});

describe('tool row web presentation policy', () => {
  it('keeps web tools on the unified non-terminal surface', () => {
    for (const tool of ['web_search', 'web_fetch', 'web_researcher']) {
      expect(shouldExpandToolRowInitially(tool)).toBe(true);
      expect(shouldUseTerminalPanel(tool)).toBe(false);
    }
  });

  it('never emits .terminal-panel for web / sys_info rows', () => {
    // Regression guard for the dead CSS selector
    // `.tool-row.web-tool .tool-row-section.terminal-panel`: web lookups and
    // sys_info render on the pale-blue surface ONLY, so that rule (and the
    // base terminal-panel styling it overrode) can never match. Any future
    // tool that switches to terminal-panel must re-add its web-tool overrides.
    for (const tool of ['web_search', 'web_fetch', 'web_researcher', 'sys_info']) {
      expect(shouldUseTerminalPanel(tool)).toBe(false);
    }
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
    expect(shouldUseTerminalPanel('web_search')).toBe(false);
    expect(shouldUseTerminalPanel('web_fetch')).toBe(false);
    expect(shouldUseTerminalPanel('web_researcher')).toBe(false);
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

describe('pendingActionLabel', () => {
  it('shows the target path and content size for write_file once args arrive', () => {
    const label = pendingActionLabel('write_file', { path: 'src/foo.ts', content: 'x'.repeat(2048) });
    expect(label).toContain('正在写入 src/foo.ts');
    expect(label).toContain('2.0 KB'); // UTF-8 byte length, matching Rust content.len()
  });

  it('falls back to a generic label while write args are still streaming', () => {
    expect(pendingActionLabel('write_file', {})).toBe('正在写入文件…');
    expect(pendingActionLabel('write_file', undefined)).toBe('正在写入文件…');
  });

  it('uses tool-specific labels instead of the generic waiting text', () => {
    expect(pendingActionLabel('execute_command', {})).toBe('正在执行命令…');
    expect(pendingActionLabel('web_search', {})).toBe('正在搜索…');
    expect(pendingActionLabel('web_fetch', {})).toBe('正在获取页面…');
    expect(pendingActionLabel('web_researcher', {})).toBe('正在研究网页资料…');
    expect(pendingActionLabel('read_file', {})).toBe('等待输出');
  });

  it('keeps all web tools on the pale-blue non-terminal surface', () => {
    expect(shouldUseTerminalPanel('web_search')).toBe(false);
    expect(shouldUseTerminalPanel('web_fetch')).toBe(false);
    expect(shouldUseTerminalPanel('web_researcher')).toBe(false);
  });

  it('has a distinct display identity for web research calls', () => {
    expect(toolDisplayName('web_researcher')).toBe('Web Research');
    expect(toolIcon('web_researcher')).toBe('🧭');
    expect(formatToolArgsSummary('web_researcher', { prompt: 'Tauri drag and drop API' }))
      .toBe('prompt="Tauri drag and drop API"');
    expect(shouldUseTerminalPanel('web_researcher')).toBe(false);
  });

  it('shows a distinct project audit identity and pending state', () => {
    expect(toolDisplayName('project_auditor')).toBe('Project Audit');
    expect(toolIcon('project_auditor')).toBe('🛡️');
    expect(pendingActionLabel('project_auditor', {})).toBe('正在审计项目安全与交付风险…');
  });

  it('counts CJK content as its UTF-8 bytes, not chars', () => {
    const label = pendingActionLabel('write_file', { path: 'a.txt', content: '中文'.repeat(512) });
    // 2 chars × 3 bytes = 6 bytes per repeat × 512 = 3072 bytes = 3.0 KB
    expect(label).toContain('3.0 KB');
  });
});
