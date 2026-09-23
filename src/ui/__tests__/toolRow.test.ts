// src/ui/__tests__/toolRow.test.ts

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { shouldExpandToolRowInitially, shouldUseTerminalPanel, toolDisplayName, toolIcon, formatToolArgsSummary, highlightStreamLine, isStepHeaderLine, truncateResultLines, MAX_LIVE_STREAM_LINES, pendingActionLabel, formatLiveOutputStatus, formatStructuredText, MAX_STRUCTURED_FORMAT_CHARS, imageExtension, imageDefaultName, createToolRow, finalizeToolRow, isToolRowExpanded, setToolRowExpanded, appendToolStreamLine, isSubagentTool, formatSubagentTraceLine, toolCardKind, groupToolRoundRuns, toolGridClass } from '../toolRow';
import { invalidateConfigCache, STORAGE_KEY } from '../config';
import type { GeneratedImage } from '../../shared/types';

// Minimal fake DOM sufficient for createToolRow + finalizeToolRow's image
// gallery branch. linkifyPaths (called inside fillInputSection) is neutralized
// by a tree-walker stub that finds no text nodes.
function installFakeDocument(): () => void {
  const previous = (globalThis as any).document;
  const createElement = (tag: string): any => {
    const classes = new Set<string>();
    const children: any[] = [];
    let className = '';
    let textContent = '';
    const el: any = {
      tagName: tag.toUpperCase(),
      children,
      childNodes: children,
      dataset: {},
      style: {},
      _listeners: {} as Record<string, (ev?: any) => void>,
      // Keep direct `el.className = ...` assignments and classList mutations in
      // sync (a real DOM does): a class added via classList must not wipe a
      // className set directly, e.g. toolRow's
      // `div.className = 'tool-row-stream-line'; div.classList.add('stream-step')`.
      get className(): string { return className; },
      set className(value: string) {
        className = value;
        classes.clear();
        String(value).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
      },
      // Setting textContent replaces all children (a real DOM does); toolRow's
      // progress redraw relies on `last.textContent = ''` then re-appending.
      get textContent(): string { return textContent; },
      set textContent(value: string) {
        textContent = value;
        children.length = 0;
      },
      _innerHTML: '',
      hidden: false,
      open: false,
      type: '',
      title: '',
      alt: '',
      src: '',
      loading: '',
      value: '',
      parentNode: null,
      parentElement: null,
      set innerHTML(value: string) {
        this._innerHTML = value;
        if (value === '') {
          children.length = 0;
        }
      },
      get innerHTML(): string { return this._innerHTML; },
      _sync: () => { className = [...classes].join(' '); },
      classList: {
        add: (...names: string[]) => { names.forEach((n) => classes.add(n)); el._sync(); },
        remove: (...names: string[]) => { names.forEach((n) => classes.delete(n)); el._sync(); },
        contains: (n: string) => classes.has(n),
        toggle: (n: string, force?: boolean) => {
          const on = force ?? !classes.has(n);
          if (on) classes.add(n); else classes.delete(n);
          el._sync();
          return on;
        },
      },
      append: (...items: any[]) => items.forEach((item) => { children.push(item); item.parentNode = el; }),
      appendChild: (item: any) => { children.push(item); item.parentNode = el; return item; },
      prepend: (...items: any[]) => items.forEach((item) => { children.unshift(item); item.parentNode = el; }),
      remove: () => {
        const parent = el.parentNode;
        if (parent?.children) {
          const i = parent.children.indexOf(el);
          if (i >= 0) parent.children.splice(i, 1);
        }
        el.parentNode = null;
      },
      setAttribute: (name: string, value: string) => { el[name] = value; if (name.startsWith('data-')) el.dataset[name.slice(5)] = value; },
      getAttribute: (name: string) => el[name] ?? null,
      addEventListener: (name: string, listener: (ev?: any) => void) => { el._listeners[name] = listener; },
      removeEventListener: () => {},
      querySelector: (): any => null,
      querySelectorAll: (): any[] => [],
      closest: (): any => null,
      click: () => { el._listeners?.click?.({ preventDefault: () => {}, stopPropagation: () => {} }); },
    };
    return el;
  };
  (globalThis as any).NodeFilter = { SHOW_TEXT: 4 };
  (globalThis as any).document = {
    createElement,
    createTextNode: (text: string) => ({ textContent: text, nodeType: 3, parentNode: null }),
    createDocumentFragment: () => ({ appendChild: () => {}, childNodes: [] }),
    createTreeWalker: () => ({ nextNode: () => null }),
    body: createElement('body'),
    _listeners: {} as Record<string, (ev?: any) => void>,
    addEventListener: (name: string, listener: (ev?: any) => void) => { (globalThis as any).document._listeners[name] = listener; },
    removeEventListener: () => {},
  };
  return () => { (globalThis as any).document = previous; };
}

function image(dataUrl: string, mimeType = 'image/png', sizeBytes = 1024): GeneratedImage {
  return { dataUrl, mimeType, sizeBytes };
}

describe('tool row expansion policy', () => {
  it('expands every execution row by default', () => {
    expect(shouldExpandToolRowInitially('execute_command')).toBe(true);
    expect(shouldExpandToolRowInitially('git_status')).toBe(true);
    expect(shouldExpandToolRowInitially('write_file')).toBe(true);
    expect(shouldExpandToolRowInitially('read_file')).toBe(true);
    expect(shouldExpandToolRowInitially('web_search')).toBe(true);
  });

  // 设置 → 外观 → 工具卡片：关掉后（配置落了 localStorage）新卡片生来折叠；
  // 旧配置没有这个字段时走默认值 true，行为不变。
  it('collapses new rows when the appearance toggle stored toolCardsExpanded=false', () => {
    const mem: Record<string, string> = {};
    const prevStorage = (globalThis as Record<string, unknown>).localStorage;
    const prevWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => { mem[k] = v; },
      removeItem: (k: string) => { delete mem[k]; },
    };
    (globalThis as Record<string, unknown>).window = { location: { search: '' } };
    try {
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 10, toolCardsExpanded: false });
      invalidateConfigCache();
      expect(shouldExpandToolRowInitially('read_file')).toBe(false);

      const restoreDoc = installFakeDocument();
      try {
        const row = createToolRow('read_file', { path: 'src/foo.ts' });
        expect(row.details.open).toBe(false); // born collapsed, still click-to-open
      } finally {
        restoreDoc();
      }

      // Legacy config without the field → defaults to open (historic behavior).
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 10 });
      invalidateConfigCache();
      expect(shouldExpandToolRowInitially('read_file')).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).localStorage;
      if (prevStorage !== undefined) (globalThis as Record<string, unknown>).localStorage = prevStorage;
      delete (globalThis as Record<string, unknown>).window;
      if (prevWindow !== undefined) (globalThis as Record<string, unknown>).window = prevWindow;
      invalidateConfigCache();
    }
  });

});

describe('tool row focus layout', () => {
  it('expands one card to the full grid row and restores it without toggling details', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('execute_command', { command: 'bun test' });
      expect(isToolRowExpanded(row)).toBe(false);
      expect(row.expandButton.title).toBe('放大到整行');

      row.expandButton.click();
      expect(isToolRowExpanded(row)).toBe(true);
      expect(row.el.classList.contains('tool-row-expanded')).toBe(true);
      expect(row.details.open).toBe(true);
      expect(row.expandButton.getAttribute('aria-pressed')).toBe('true');
      expect(row.expandButton.title).toBe('还原卡片大小');

      row.expandButton.click();
      expect(isToolRowExpanded(row)).toBe(false);
      expect(row.details.open).toBe(true);
      expect(row.expandButton.getAttribute('aria-pressed')).toBe('false');
    } finally {
      restore();
    }
  });

  it('never re-opens a details the user collapsed when maximize toggles', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('execute_command', { command: 'bun test' });
      row.details.open = false; // the user collapsed this row

      row.expandButton.click();
      expect(isToolRowExpanded(row)).toBe(true);
      expect(row.details.open).toBe(false);

      row.expandButton.click();
      expect(isToolRowExpanded(row)).toBe(false);
      expect(row.details.open).toBe(false);
    } finally {
      restore();
    }
  });

  it('does not leave the compositor layer hint behind when nothing moves', () => {
    const restore = installFakeDocument();
    try {
      // Activate the FLIP path: geometry + matchMedia must exist. Static
      // geometry means the layout delta is zero (a single-card round that is
      // already full-width), so no FLIP runs and the layer hint is dropped.
      const rect = { width: 1000, height: 147, top: 100, left: 50, x: 50, y: 100, right: 1050, bottom: 247 };
      const previousMatchMedia = (globalThis as any).matchMedia;
      (globalThis as any).matchMedia = () => ({ matches: false });
      const previousCreate = (globalThis as any).document.createElement;
      (globalThis as any).document.createElement = (tag: string) => {
        const el = previousCreate(tag);
        el.getBoundingClientRect = () => rect;
        return el;
      };
      try {
        const row = createToolRow('execute_command', { command: 'bun test' });
        setToolRowExpanded(row, true);
        expect(row.el.classList.contains('tool-row-expanded')).toBe(true);
        // No delta → no animation → the will-change promotion must be undone.
        expect(row.el.style.willChange).toBe('');
        expect(row.el.style.backfaceVisibility).toBe('');
      } finally {
        (globalThis as any).matchMedia = previousMatchMedia;
        (globalThis as any).document.createElement = previousCreate;
      }
    } finally {
      restore();
    }
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

  it('renders coding subagents (code_reviewer and siblings) on the dark console surface', () => {
    // Regression: code_reviewer's body was transparent/white — visibly out of
    // step with the other dark terminal panels (execute_command / read_file).
    for (const tool of ['code_reviewer', 'project_auditor', 'task_planner', 'code_editor', 'bash_executor']) {
      expect(shouldUseTerminalPanel(tool)).toBe(true);
    }
    // Prose roles keep the light surface.
    for (const tool of ['researcher', 'deep_thinker', 'ui_designer', 'planner']) {
      expect(shouldUseTerminalPanel(tool)).toBe(false);
    }
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

describe('appendToolStreamLine progress redraw (lone-\\r chunks)', () => {
  // installFakeDocument's querySelector returns null everywhere, so we wire the
  // row's resultEl to resolve '.tool-row-stream-line:last-child' from its own
  // children — the minimal surface appendToolStreamLine touches.
  function wireStreamLines(row: ReturnType<typeof createToolRow>): void {
    row.resultEl.querySelector = (sel: string) => {
      if (sel === '.tool-row-stream-line:last-child') {
        const lines = Array.from(row.resultEl.children).filter((c: any) =>
          String(c.className).includes('tool-row-stream-line'));
        return lines.length ? lines[lines.length - 1] : null;
      }
      return null;
    };
  }

  // join textContent across an element's children (highlight segments are
  // inserted as text nodes + .stream-hl-* spans, not as the parent's textContent).
  function textOf(el: any): string {
    return Array.from(el.childNodes).map((c: any) => c.textContent ?? '').join('');
  }

  // resultEl also holds a .tool-row-live-status + waiting placeholder; only the
  // stream lines matter here.
  function streamLineCount(row: ReturnType<typeof createToolRow>): number {
    return Array.from(row.resultEl.children).filter((c: any) =>
      String(c.className).includes('tool-row-stream-line')).length;
  }

  it('redraws the last stream line in place instead of appending', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('execute_command', { command: 'pip install requests' });
      wireStreamLines(row);
      appendToolStreamLine(row, 'stdout', 'Collecting requests');
      appendToolStreamLine(row, 'stdout', 'Downloading requests 0%');
      const before = streamLineCount(row);
      const streamLines = Number(row.resultEl.dataset.streamLines);

      // ~50 pip progress redraws → still one line appended per round.
      for (let pct = 10; pct <= 100; pct += 10) {
        appendToolStreamLine(row, 'stdout', `Downloading requests ${pct}%`, true);
      }

      expect(streamLineCount(row)).toBe(before); // never appended
      expect(Number(row.resultEl.dataset.streamLines)).toBe(streamLines); // counter untouched
      const last = Array.from(row.resultEl.children)
        .filter((c: any) => String(c.className).includes('tool-row-stream-line')).pop();
      expect(textOf(last)).toBe('Downloading requests 100%');
    } finally {
      restore();
    }
  });

  it('keeps the redraw line on the stdout surface (no stray step tint)', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('execute_command', { command: 'bun install' });
      wireStreamLines(row);
      appendToolStreamLine(row, 'stdout', 'downloading 12%');
      appendToolStreamLine(row, 'stdout', 'downloading 45%', true);
      expect(streamLineCount(row)).toBe(1); // redrew, did not append
      // A lone percent is not a build-step header → plain stream line.
      const last = Array.from(row.resultEl.children)
        .filter((c: any) => String(c.className).includes('tool-row-stream-line')).pop()!;
      expect(String(last.className)).toBe('tool-row-stream-line');
    } finally {
      restore();
    }
  });

  it('falls through to append when there is no prior line to redraw', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('execute_command', { command: 'pip install' });
      wireStreamLines(row);
      appendToolStreamLine(row, 'stdout', 'downloading 12%', true);
      expect(streamLineCount(row)).toBe(1);
      const last = Array.from(row.resultEl.children)
        .filter((c: any) => String(c.className).includes('tool-row-stream-line')).pop();
      expect(textOf(last)).toBe('downloading 12%');
    } finally {
      restore();
    }
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

describe('live output status', () => {
  it('shows a stable byte count for command output after streaming starts', () => {
    expect(formatLiveOutputStatus('execute_command', 2048)).toBe('已输出 2.0 KB');
  });

  it('shows the latest file write progress without a cursor state', () => {
    expect(formatLiveOutputStatus('write_file', 12, '正在写入 dist/app.js — 50% (12 B/24 B)'))
      .toBe('正在写入 dist/app.js — 50% (12 B/24 B)');
  });

  it('keeps a byte count for other streamed tools', () => {
    expect(formatLiveOutputStatus('read_file', 3072)).toBe('已收到输出 3.0 KB');
  });
});

describe('structured text formatting (JSON/YAML in tool input/output)', () => {
  it('pretty-prints JSON output with 2-space indent', () => {
    const r = formatStructuredText('{"a":1,"b":[1,2],"c":"x"}');
    expect(r?.language).toBe('json');
    expect(r?.formatted).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ],\n  "c": "x"\n}');
  });

  it('accepts already-pretty JSON and top-level arrays', () => {
    expect(formatStructuredText('{\n  "a": 1\n}')?.language).toBe('json');
    expect(formatStructuredText('[1,2,3]')?.language).toBe('json');
  });

  it('detects multi-line YAML documents (mapping entries)', () => {
    const r = formatStructuredText('services:\n  app:\n    image: nginx\n    ports:\n      - "8080:80"');
    expect(r?.language).toBe('yaml');
    expect(r?.formatted).toBe('services:\n  app:\n    image: nginx\n    ports:\n      - "8080:80"');
  });

  it('detects YAML with a document marker and comments', () => {
    expect(formatStructuredText('---\n# comment\napiVersion: v1\nkind: List')?.language).toBe('yaml');
  });

  it('rejects terminal noise and single-line query strings', () => {
    // ls-style listing: dash-prefixed perms + 12:00 timestamp must not parse.
    expect(formatStructuredText('-rw-r--r-- 1 user group 123 Jan 1 12:00 file.txt')).toBeNull();
    // git log line: hex prefix + message, no mapping entry.
    expect(formatStructuredText('abc1234 commit message here')).toBeNull();
    // Single-line "key: value" (e.g. a query arg) is not a YAML document.
    expect(formatStructuredText('node: 22')).toBeNull();
    // env-style output has no mapping colons.
    expect(formatStructuredText('PATH=/usr/bin:/bin\nHOME=/root')).toBeNull();
    // plain multi-line prose.
    expect(formatStructuredText('hello world\nsecond line')).toBeNull();
  });

  it('rejects text past the format cap', () => {
    expect(formatStructuredText('{"a":' + '1'.repeat(MAX_STRUCTURED_FORMAT_CHARS) + '}')).toBeNull();
  });

  it('rejects malformed JSON that only starts with a brace', () => {
    expect(formatStructuredText('{not json}')).toBeNull();
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
    // project_auditor is a SUBAGENT (2026-09-17): 🤖 + Chinese role name,
    // never a tool-style English label.
    expect(toolDisplayName('project_auditor')).toBe('项目体检');
    expect(toolIcon('project_auditor')).toBe('🤖');
    expect(pendingActionLabel('project_auditor', {})).toBe('正在审计项目安全与交付风险…');
  });

  it('summarizes each delegation ask so parallel subagent cards are tellable apart', () => {
    // A parallel batch used to render N look-alike "🤖 角色名 · 子 Agent"
    // cards — the delegated question is the only distinguishing mark.
    expect(formatToolArgsSummary('code_reviewer', { prompt: '审查 auth 模块的越界检查' }))
      .toBe('prompt="审查 auth 模块的越界检查"');
    expect(formatToolArgsSummary('project_auditor', { prompt: 'audit deps for known CVEs' }))
      .toBe('prompt="audit deps for known CVEs"');
    expect(formatToolArgsSummary('task_planner', { task: '拆解登录页改版' }))
      .toBe('task="拆解登录页改版"');
    expect(formatToolArgsSummary('code_editor', { plan: '1. 抽出 hook 2. 补测试' }))
      .toBe('plan="1. 抽出 hook 2. 补测试"');
    expect(formatToolArgsSummary('deep_thinker', { question: '状态管理选型对比' }))
      .toBe('question="状态管理选型对比"');
    expect(formatToolArgsSummary('ui_designer', { requirement: '设置页两栏布局' }))
      .toBe('requirement="设置页两栏布局"');
    expect(formatToolArgsSummary('researcher', { topic: 'Tauri 2 updater 最佳实践' }))
      .toBe('topic="Tauri 2 updater 最佳实践"');
    expect(formatToolArgsSummary('bash_executor', { command: 'bun test src/engine' }))
      .toBe('$ bun test src/engine');
    // Long asks clip to one line (whitespace flattened, 60 chars + ellipsis).
    const long = 'x'.repeat(80);
    const summary = formatToolArgsSummary('code_reviewer', { prompt: long });
    expect(summary).toBe(`prompt="${'x'.repeat(60)}…"`);
    expect(formatToolArgsSummary('researcher', { topic: 'a\n\nb   c' })).toBe('topic="a b c"');
    // No ask field → empty (not "undefined").
    expect(formatToolArgsSummary('code_reviewer', {})).toBe('');
  });

  it('counts CJK content as its UTF-8 bytes, not chars', () => {
    const label = pendingActionLabel('write_file', { path: 'a.txt', content: '中文'.repeat(512) });
    // 2 chars × 3 bytes = 6 bytes per repeat × 512 = 3072 bytes = 3.0 KB
    expect(label).toContain('3.0 KB');
  });
});

describe('generate_image tool row identity', () => {
  it('has a distinct Generate Image identity', () => {
    expect(toolDisplayName('generate_image')).toBe('Generate Image');
    expect(toolIcon('generate_image')).toBe('🎨');
    expect(formatToolArgsSummary('generate_image', { prompt: 'a cute puppy icon' }))
      .toBe('prompt="a cute puppy icon"');
    expect(pendingActionLabel('generate_image', {})).toBe('正在生成图片…');
    // Image cards live on the non-terminal surface (like web lookups).
    expect(shouldUseTerminalPanel('generate_image')).toBe(false);
  });
});

describe('generated image filename helpers', () => {
  it('maps mime types to file extensions', () => {
    expect(imageExtension('image/png')).toBe('png');
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/webp')).toBe('webp');
    expect(imageExtension('image/gif')).toBe('gif');
    expect(imageExtension('')).toBe('png');
  });

  it('builds a slugged name with the index and correct extension', () => {
    const name = imageDefaultName('一只小狗图标', 1, 'image/png');
    expect(name.startsWith('一只小狗图标-2-')).toBe(true);
    expect(name.endsWith('.png')).toBe(true);
    const jpg = imageDefaultName('puppy/icon: cute!', 3, 'image/jpeg');
    expect(jpg.startsWith('puppy_icon_cute-4-')).toBe(true);
    expect(jpg.endsWith('.jpg')).toBe(true);
    expect(imageDefaultName(undefined, 0, 'image/webp').startsWith('generated-image-1-')).toBe(true);
  });
});

describe('tool row renders generated images as <img> cards', () => {
  it('finalizeToolRow renders an image gallery instead of raw text', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('generate_image', { prompt: 'a puppy' });
      finalizeToolRow(row, {
        success: true,
        duration: 1500,
        resultKind: 'image',
        resultImages: [image('data:image/png;base64,AAA'), image('data:image/png;base64,BBB', 'image/jpeg', 2048)],
        resultText: 'Generated 2 image(s)…',
      });
      expect(row.statusEl.textContent).toBe('✓ 1.5s');
      const gallery = Array.from(row.resultEl.children).find((c: any) => c.className.includes('image-gallery')) as any;
      expect(gallery).toBeDefined();
      expect(gallery.className).toBe('image-gallery'); // 2 images → multi-card grid
      expect(gallery.children.length).toBe(2);
      const first = gallery.children[0];
      expect(first.className).toBe('image-card');
      const img = first.children[0];
      expect(img.tagName).toBe('IMG');
      expect(img.src).toBe('data:image/png;base64,AAA');
      // The summary text (which embeds the prompt) becomes the alt caption.
      expect(img.alt).toContain('Generated 2 image(s)…');
      expect(img.alt).toContain('图 1');
      // Download button + caption metadata ride on the card.
      const download = first.children[1];
      expect(download.className).toBe('image-download-btn');
      expect(first.children[2].className).toBe('image-card-meta');
      expect(first.children[2].textContent).toContain('PNG');
    } finally {
      restore();
    }
  });

  it('a single image renders in the single-card geometry', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('generate_image', { prompt: 'logo' });
      finalizeToolRow(row, {
        success: true,
        duration: 900,
        resultKind: 'image',
        resultImages: [image('data:image/png;base64,ONE')],
        resultText: 'Generated 1 image(s)…',
      });
      const gallery = Array.from(row.resultEl.children).find((c: any) => c.className.includes('image-gallery')) as any;
      expect(gallery.className).toBe('image-gallery single');
      expect(gallery.children.length).toBe(1);
    } finally {
      restore();
    }
  });

  it('clicking a generated image opens the lightbox overlay', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('generate_image', { prompt: 'puppy' });
      finalizeToolRow(row, {
        success: true,
        duration: 1000,
        resultKind: 'image',
        resultImages: [image('data:image/png;base64,CLICK')],
        resultText: 'ok',
      });
      const gallery = Array.from(row.resultEl.children).find((c: any) => c.className.includes('image-gallery')) as any;
      const img = gallery.children[0].children[0];
      img._listeners.click({ target: img });
      const overlay = (globalThis as any).document.body.children.find((c: any) => c.className === 'image-lightbox');
      expect(overlay).toBeDefined();
      expect(overlay.children[0].src).toBe('data:image/png;base64,CLICK');
      // Escape dismisses the overlay.
      (globalThis as any).document._listeners.keydown({ key: 'Escape' });
      expect((globalThis as any).document.body.children.length).toBe(0);
    } finally {
      restore();
    }
  });

  it('a failed tool row gets the failure class and a hover tooltip with the error', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('read_file', { path: 'a.txt' });
      finalizeToolRow(row, {
        success: false,
        duration: 800,
        resultText: 'Path escapes workspace: a.txt',
      });
      // The row carries the failure marker (CSS red-tints the frame + summary)
      // and the status flips to a red ✗.
      expect(row.details.classList.contains('failure')).toBe(true);
      expect(row.details.classList.contains('pending')).toBe(false);
      expect(row.statusEl.textContent).toBe('✗ 800ms');
      // The reason is readable on hover even when the row is collapsed.
      expect(row.details.title).toContain('Path escapes workspace');
      // The error text renders in the Output panel.
      const output = Array.from(row.resultEl.children).find((c: any) => c.className.includes('tool-result-preview')) as any;
      expect(output).toBeDefined();
      expect(output.textContent).toContain('Path escapes workspace');
    } finally {
      restore();
    }
  });
});

describe('bash_executor body matches the unified console look', () => {
  it('gets the dark terminal panel on both sections like execute_command', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('bash_executor', { command: 'bun test' });
      expect(String(row.inputSection.className)).toContain('terminal-panel');
      // The Output section wraps resultEl; it must carry the same dark panel.
      const outputSection = (row.resultEl.parentNode as any);
      expect(String(outputSection.className)).toContain('terminal-panel');
    } finally {
      restore();
    }
  });

  it('terminal-highlights bash_executor output on finalize (not monochrome text)', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('bash_executor', { command: 'bun run build' });
      finalizeToolRow(row, {
        success: true,
        duration: 1200,
        resultText: '✓ 构建通过，产物位于 dist/',
      });
      const preview = Array.from(row.resultEl.children).find((c: any) => String(c.className).includes('tool-result-preview')) as any;
      expect(preview).toBeDefined();
      // Terminal-highlight path: line spans instead of a single text node, and
      // the ✓ success token gets a colored span (stream-hl-success).
      const lineEl = preview.children[0];
      expect(String(lineEl.className)).toContain('tool-result-line');
      const colored = Array.from(lineEl.children).filter((c: any) => String(c.className).startsWith('stream-hl-'));
      expect(colored.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });
});

describe('subagent delegations read as agents, not tool calls (2026-09-17)', () => {
  it('renders the roster with 🤖, a Chinese role name, the 子 Agent badge and a tinted row', () => {
    expect(toolIcon('code_reviewer')).toBe('🤖');
    expect(toolDisplayName('code_reviewer')).toBe('代码评审');
    expect(toolDisplayName('ui_designer')).toBe('界面设计');
    const restore = installFakeDocument();
    try {
      const row = createToolRow('code_reviewer', { prompt: '审查这次改动' });
      const details = row.details as any;
      expect(details.classList.contains('subagent-row')).toBe(true);
      expect(details.title).toBe('code_reviewer');
      // The fake DOM has no tree-walking querySelectorAll — the summary is
      // details.children[0], and the badge is one of its direct children.
      const summary = details.children[0];
      const badge = (summary.children as any[]).find(
        (el) => el.className === 'tool-row-agent-badge',
      );
      expect(badge?.textContent).toBe('子 Agent');
    } finally {
      restore();
    }
  });

  it('tints the row edge cyan and keeps the summary tinted after finalize', () => {
    // Second-pass distinction (2026-09-17 follow-up): the badge alone drowned
    // once the row opened — the body was the SAME black console as
    // execute_command. The 3px cyan left edge must mark the whole row.
    const restore = installFakeDocument();
    try {
      const row = createToolRow('code_reviewer', { prompt: '审查' });
      const details = row.details as any;
      // The fake DOM records className assignments, so the edge style itself
      // is CSS-side; here we pin the structural contract the CSS keys on.
      expect(details.classList.contains('subagent-row')).toBe(true);
      finalizeToolRow(row, { success: true, duration: 1200, resultText: '结论：通过' });
      expect(details.classList.contains('success')).toBe(true);
      expect(details.classList.contains('subagent-row')).toBe(true);
    } finally {
      restore();
    }
  });

  it('renders an explicit handoff note when a successful subagent produced no text', () => {
    // The engine's finalOutput is empty when the sub-agent ended on a tool
    // call or an empty response; a green rail card next to a BLANK Output
    // panel read as a desync bug. The row must explain the handoff instead.
    const restore = installFakeDocument();
    try {
      const row = createToolRow('ui_designer', { requirement: '设计登录页' });
      finalizeToolRow(row, { success: true, duration: 8000, resultText: '' });
      const note = (row.resultEl as any).children.find?.((el: any) => el.className === 'tool-result-empty')
        ?? Array.from((row.resultEl as any).children).find((el: any) => el.className === 'tool-result-empty');
      expect(note).toBeTruthy();
      expect(String(note.textContent)).toContain('子 Agent 已完成');
      // A NON-subagent row with no text stays blank — the note is agent-only.
      const plain = createToolRow('read_file', { path: 'a.ts' });
      finalizeToolRow(plain, { success: true, duration: 5, resultText: '' });
      const plainChildren = Array.from((plain.resultEl as any).children) as any[];
      expect(plainChildren.some((el) => el.className === 'tool-result-empty')).toBe(false);
    } finally {
      restore();
    }
  });

  it('keeps tool rows badge-free — bash_executor included, same ruling as the rail', () => {
    // bash_executor IS Tags.AGENT, but it is a shell command wearing an agent
    // wrapper: the activity rail already refused to card it, and the
    // transcript must not call it a colleague either.
    expect(isSubagentTool('execute_command')).toBe(false);
    expect(isSubagentTool('bash_executor')).toBe(false);
    expect(isSubagentTool('code_reviewer')).toBe(true);
    const restore = installFakeDocument();
    try {
      const row = createToolRow('read_file', { path: 'src/a.ts' });
      expect((row.details as any).classList.contains('subagent-row')).toBe(false);
      const summary = (row.details as any).children[0];
      expect((summary.children as any[]).some(
        (el) => el.className === 'tool-row-agent-badge',
      )).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('formatSubagentTraceLine (delegation card interior trace)', () => {
  it('renders start / tool / done / error as one human line each', () => {
    expect(formatSubagentTraceLine({ callId: 'c1', agentName: 'code_reviewer', kind: 'start', summary: 'review the diff for off-by-one' }))
      .toBe('▶ code_reviewer 接活：review the diff for off-by-one');
    expect(formatSubagentTraceLine({ callId: 'c1', agentName: 'code_reviewer', kind: 'start' }))
      .toBe('▶ code_reviewer 开工');
    expect(formatSubagentTraceLine({ callId: 'c1', agentName: 'code_reviewer', kind: 'tool', toolName: 'read_file', toolState: 'running', toolArgsHint: 'src/a.ts' }))
      .toBe('→ read_file src/a.ts');
    expect(formatSubagentTraceLine({ callId: 'c1', agentName: 'code_reviewer', kind: 'tool', toolName: 'read_file', toolState: 'completed' }))
      .toBe('✓ read_file 完成');
    expect(formatSubagentTraceLine({ callId: 'c1', agentName: 'code_reviewer', kind: 'done', success: true, durationMs: 1500 }))
      .toBe('✓ code_reviewer 交付 · 用时 1.5s');
    expect(formatSubagentTraceLine({ callId: 'c1', agentName: 'code_reviewer', kind: 'error', error: 'budget exhausted' }))
      .toBe('✗ code_reviewer 中断：budget exhausted');
  });

  it('clips long asks and drops contentless kinds', () => {
    const longAsk = 'x'.repeat(200);
    const line = formatSubagentTraceLine({ callId: 'c1', agentName: 'code_editor', kind: 'start', summary: longAsk })!;
    expect(line.length).toBeLessThan(100);
    expect(line.endsWith('…')).toBe(true);
    // THINK/OBSERVE state churn says nothing the tool lines don't — skipped.
    expect(formatSubagentTraceLine({ callId: 'c1', agentName: 'code_editor', kind: 'state', state: 'THINK' })).toBeNull();
    expect(formatSubagentTraceLine({ callId: 'c1', agentName: 'code_editor', kind: 'tool', toolState: 'running' })).toBeNull();
  });
});

describe('finalizeToolRow subagentTrace (live lines survive the result wipe)', () => {
  function textOf(el: any): string {
    return Array.from(el.childNodes).map((c: any) => c.textContent ?? '').join('');
  }
  function streamLines(row: ReturnType<typeof createToolRow>): any[] {
    return Array.from((row.resultEl as any).children).filter((c: any) =>
      String(c.className).includes('tool-row-stream-line'));
  }

  it('re-renders the trace after the wipe, before the final output', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('code_reviewer', { prompt: 'review auth.ts' });
      finalizeToolRow(row, {
        success: true,
        duration: 4200,
        resultText: 'LGTM with 2 suggestions',
        subagentTrace: [
          '▶ code_reviewer 接活：review auth.ts',
          '→ read_file src/auth.ts',
          '✓ read_file 完成',
          '✓ code_reviewer 交付 · 用时 4.2s',
        ],
      });
      const lines = streamLines(row);
      expect(lines.map((l) => textOf(l))).toEqual([
        '▶ code_reviewer 接活：review auth.ts',
        '→ read_file src/auth.ts',
        '✓ read_file 完成',
        '✓ code_reviewer 交付 · 用时 4.2s',
      ]);
      // The final body renders AFTER the trace (trace first = run narrative).
      // (The fake DOM's textContent setter swallows text into a scalar, so the
      // <pre> body is asserted by presence + position, not by its text.)
      const body = Array.from((row.resultEl as any).children).filter((c: any) => c.tagName === 'PRE');
      expect(body).toHaveLength(1);
      expect(Array.from((row.resultEl as any).children).indexOf(lines[3]))
        .toBeLessThan(Array.from((row.resultEl as any).children).indexOf(body[0]));
      // The live-stream counter is reset to the re-rendered count, honest for
      // any later appendToolStreamLine (a retried delegation on the same row).
      expect(Number(row.resultEl.dataset.streamLines)).toBe(4);
    } finally {
      restore();
    }
  });

  it('keeps failed trace lines on the stderr surface', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('bash_executor', { command: 'bun test' });
      finalizeToolRow(row, {
        success: false,
        duration: 800,
        resultText: 'subagent failed',
        subagentTrace: ['→ read_file a.ts', '✗ bash_executor 中断：timeout'],
      });
      const lines = streamLines(row);
      expect(String(lines[0].className)).toBe('tool-row-stream-line');
      expect(String(lines[1].className)).toBe('tool-row-stream-line stderr');
    } finally {
      restore();
    }
  });

  it('caps the re-rendered trace like the live stream', () => {
    const restore = installFakeDocument();
    try {
      const row = createToolRow('code_reviewer', { prompt: 'review' });
      const flood = Array.from({ length: MAX_LIVE_STREAM_LINES + 50 }, (_, i) => `→ tool_${i}`);
      finalizeToolRow(row, { success: true, duration: 10, resultText: 'done', subagentTrace: flood });
      expect(streamLines(row)).toHaveLength(MAX_LIVE_STREAM_LINES);
      expect(Number(row.resultEl.dataset.streamLines)).toBe(MAX_LIVE_STREAM_LINES);
    } finally {
      restore();
    }
  });
});

describe('toolCardKind / groupToolRoundRuns (tool rows vs agent rows)', () => {
  it('classifies delegation tools as agent cards, everything else as tool cards', () => {
    expect(toolCardKind('sys_info')).toBe('tool');
    expect(toolCardKind('execute_command')).toBe('tool');
    expect(toolCardKind('web_search')).toBe('tool');
    // bash_executor stays a tool — same ruling as the badge/rail (a shell
    // command wearing an agent wrapper).
    expect(toolCardKind('bash_executor')).toBe('tool');
    expect(toolCardKind('researcher')).toBe('agent');
    expect(toolCardKind('code_reviewer')).toBe('agent');
  });

  it('splits a mixed round into consecutive same-kind runs, preserving order', () => {
    // The travel-planner shape: a location probe, then three parallel agents.
    // The probe reads as its own step ABOVE the swarm — never a fourth cell
    // squeezed next to the agents it feeds.
    const round = ['sys_info', 'researcher', 'researcher', 'researcher'];
    expect(groupToolRoundRuns(round, toolCardKind)).toEqual([
      ['sys_info'],
      ['researcher', 'researcher', 'researcher'],
    ]);
    // The mirror case: agents first, probe after → probe stays BELOW the
    // agents. 分类不能重排时间顺序 — no visual jumping into an earlier row.
    expect(groupToolRoundRuns(['code_reviewer', 'code_editor', 'sys_info'], toolCardKind)).toEqual([
      ['code_reviewer', 'code_editor'],
      ['sys_info'],
    ]);
    // Alternating kinds never merge across an interruption.
    expect(groupToolRoundRuns(['web_search', 'researcher', 'web_search'], toolCardKind)).toEqual([
      ['web_search'],
      ['researcher'],
      ['web_search'],
    ]);
    // The full six-card case: probe A alone, the four agents in ONE run (a
    // wrapped agent stays within its own grid — still parallel, never merged
    // into a tool row; how many fit per line is the CSS width calculation),
    // tool B alone at the end.
    expect(groupToolRoundRuns(['sys_info', 'researcher', 'researcher', 'researcher', 'researcher', 'execute_command'], toolCardKind)).toEqual([
      ['sys_info'],
      ['researcher', 'researcher', 'researcher', 'researcher'],
      ['execute_command'],
    ]);
    // Pure rounds behave exactly as before the split.
    expect(groupToolRoundRuns(['web_search', 'web_search'], toolCardKind)).toEqual([['web_search', 'web_search']]);
    expect(groupToolRoundRuns([], toolCardKind)).toEqual([]);
  });
});

// ── Subagent card readability (2026-09-20 user feedback) ──
// Two reported defects, both measured in a real engine before fixing:
//  1. a web-research subagent renders as a .web-tool row (pale-blue surface)
//     while its interior trace lines carried the terminal ink #f2f2f2 → 1.1:1
//     contrast, i.e. invisible Output text;
//  2. three parallel agents sharing one 255px-wide grid column squeezed the
//     CJK role label into a vertical stack (11.8px × 68px) and collapsed the
//     args to 0px.
const readUi = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

/**
 * Extract the declaration block of the first rule whose selector list STARTS a
 * line with `selector`. The line anchor matters: a descendant selector that
 * merely ends in the same text (`.tool-grid--agents … .tool-row-args {`) must
 * not answer for the base rule.
 */
const cssRuleBlock = (css: string, selector: string, contains?: string): string => {
  const anchor = `\n${selector}`;
  let from = 0;
  for (;;) {
    const index = css.indexOf(anchor, from);
    if (index === -1) return '';
    const open = css.indexOf('{', index);
    const close = css.indexOf('}', open);
    const block = open === -1 || close === -1 ? '' : css.slice(open + 1, close);
    // A selector can appear more than once (`.bubble-row.tool-grid` is also
    // used for the animation reset), so callers can pin the rule they mean by
    // one of its declarations.
    if (!contains || block.includes(contains)) return block;
    from = index + anchor.length;
  }
};

describe('subagent card readability', () => {
  const css = readUi('../styles.css');

  it('gives the agent grid its own wider minimum column', () => {
    expect(toolGridClass('agent')).toBe('bubble-row tool-grid tool-grid--agents');
    expect(toolGridClass('tool')).toBe('bubble-row tool-grid');
    expect(toolGridClass('agent')).toContain(toolGridClass('tool'));
    // The minimums come from the measured header budget: ~165px of chrome for a
    // tool card (longest label `Generate Image` ≈ 95px) and ~250px for an agent
    // card, which also carries the 子 Agent chip.
    expect(cssRuleBlock(css, '.bubble-row.tool-grid {', 'grid-template-columns')).toContain('minmax(264px');
    expect(cssRuleBlock(css, '.bubble-row.tool-grid--agents')).toContain('minmax(280px');
    // Three agent cards still share one row at the regular transcript width
    // (940px #chat max-width minus 2 × 32px padding = 876px content).
    expect(3 * 280 + 2 * 10).toBeLessThanOrEqual(940 - 32 * 2);
    expect(3 * 264 + 2 * 10).toBeLessThanOrEqual(940 - 32 * 2);
  });

  it('tightens the agent header only when agent cards share a row', () => {
    const shared = '.bubble-row.tool-grid--agents > .bubble-row.tool-row-row:not(:only-child)';
    // The args stub is the first thing to go: in a 280px card it is a two- or
    // three-character stub of a long research prompt, while the name and the
    // 子 Agent chip are what the header is FOR. A lone agent card keeps it.
    expect(cssRuleBlock(css, `${shared} .tool-row-args {`)).toContain('display: none');
    expect(cssRuleBlock(css, `${shared} .tool-row-summary {`)).toContain('gap: 5px');
  });

  it('keeps live rendering and replay on the shared grid class', () => {
    for (const file of ['../chat.ts', '../main.ts']) {
      const source = readUi(file);
      expect(source).toContain('toolGridClass(');
      expect(source).not.toContain("className = 'bubble-row tool-grid'");
    }
  });

  it('never lets a tool or agent name wrap into a vertical column', () => {
    const name = cssRuleBlock(css, '.tool-row-name {');
    expect(name).toContain('white-space: nowrap');
    expect(name).toContain('text-overflow: ellipsis');
    // `flex: 0 0 auto`: the name never yields at all, so no card width can turn
    // it into a stack of single characters (measured before the fix: CJK names
    // at 11.8px × 68px, i.e. one character per line). 12em caps a pathological
    // name so it can never push the expand button off the card.
    expect(name).toContain('flex: 0 0 auto');
    expect(name).toContain('max-width: 12em');
    // The squeeze lands on the args instead — its auto basis lets the long args
    // string shrink to zero. A `1 1 0%` basis did the opposite and rendered
    // `Bash` itself as "…" in a 285px card.
    expect(cssRuleBlock(css, '.tool-row-args {')).toContain('flex: 1 1 auto');
  });

  it('prints the delegation trace in the pale-blue surface ink, not the console ink', () => {
    const light = cssRuleBlock(css, '.tool-row.web-tool .tool-row-stream-line,');
    expect(light).toContain('color: #1d3a5f');
    expect(light).not.toContain('var(--term-ink)');
    // stderr and the error/warn tokens darken too (#ff4d4f is 2.3:1 on #c8daf0).
    expect(cssRuleBlock(css, '.tool-row.web-tool .tool-row-stream-line.stderr,')).toContain('color: #b3261e');
    expect(cssRuleBlock(css, '.tool-row.web-tool .stream-hl-error,')).toContain('color: #b3261e');
    expect(cssRuleBlock(css, '.tool-row.web-tool .stream-hl-success')).toContain('color: #146b32');
    const dark = cssRuleBlock(css, '[data-theme="dark"] .tool-row.web-tool .tool-row-stream-line,');
    expect(dark).toContain('color: #d8e8fb');
  });
});

// The scroll window is the one place where a long transcript's cost lands: a
// chatty command renders up to 500 highlighted lines per body, and dozens of
// open bodies at once made scrolling miss every other frame (measured rAF gap
// p95 33ms → 19ms with containment). It is a CSS-only fix, so a test is the
// only thing standing between it and a future "cleanup".
describe('tool card scroll cost', () => {
  const css = readUi('../styles.css');

  it('keeps the tool scroll window contained so long transcripts stay in frame', () => {
    const scroll = cssRuleBlock(css, '.tool-row-scroll {', 'contain');
    expect(scroll).toContain('overflow-y: auto');
    expect(scroll).toContain('contain: layout paint');
    // `style` is intentionally out (counters/quotes isolation, no measured
    // benefit) and the rule must stay on the INNER window: containment on the
    // outer body or on #chat is the variant that has left restored rows blank
    // in WKWebView before.
    expect(scroll).not.toContain('contain: content');
    expect(scroll).not.toContain('contain: layout paint style');
  });
});
