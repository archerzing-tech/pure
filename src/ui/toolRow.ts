// src/ui/toolRow.ts
// Claude-Code-style inline tool-call rows. Tool calls render as rows inside the
// chat transcript (not floating toasts): each row shows a friendly name, an
// args summary, and a status (spinner → ✓/✗ + duration). Clicking a row toggles
// a body with the full Input (args) and Output (result).
// Shared by chat.ts (live streaming) and main.ts (session replay) so both
// render identically.

import { linkifyPaths } from './pathLink';

// Friendly display names + icons per tool (Claude Code uses short verbs).
const TOOL_META: Record<string, { name: string; icon: string }> = {
  read_file:        { name: 'Read',          icon: '📖' },
  write_file:       { name: 'Write',         icon: '✏️' },
  edit_file:        { name: 'Edit',          icon: '✏️' },
  replace_files:    { name: 'Replace',       icon: '🔁' },
  list_files:       { name: 'List',          icon: '📂' },
  create_directory: { name: 'Make Directory', icon: '📁' },
  search_files:     { name: 'Search',        icon: '🔍' },
  glob_files:       { name: 'Glob',          icon: '🔎' },
  diff_files:       { name: 'Diff',          icon: '⇄' },
  execute_command:  { name: 'Bash',          icon: '🖥️' },
  git_diff:         { name: 'Git Diff',      icon: '⑂' },
  git_log:          { name: 'Git Log',       icon: '⑂' },
  git_status:       { name: 'Git Status',    icon: '⑂' },
  web_search:       { name: 'Web Search',    icon: '🌐' },
  web_fetch:        { name: 'Fetch',         icon: '📡' },
  sys_info:         { name: 'System Info',   icon: 'ℹ️' },
};

export function toolDisplayName(toolName: string): string {
  return TOOL_META[toolName]?.name ?? toolName;
}

export function toolIcon(toolName: string): string {
  return TOOL_META[toolName]?.icon ?? '🔧';
}

// One-line args summary for the row header (e.g. `path="src/foo.ts"`,
// `query="..."`, `` `$ command` ``).
export function formatToolArgsSummary(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const v = (k: string) => args[k];
  switch (toolName) {
    case 'web_search':
      return typeof v('query') === 'string' ? `query="${String(v('query'))}"` : '';
    case 'web_fetch':
      return typeof v('url') === 'string' ? `url="${String(v('url'))}"` : '';
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'replace_files':
    case 'list_files':
    case 'create_directory':
      return typeof v('path') === 'string' ? `path="${String(v('path'))}"` : '';
    case 'execute_command':
      return typeof v('command') === 'string' ? `$ ${String(v('command')).slice(0, 100)}` : '';
    case 'search_files':
    case 'glob_files':
      return typeof v('pattern') === 'string' ? `pattern="${String(v('pattern'))}"` : '';
    default:
      return '';
  }
}

export interface ToolRowResultMeta {
  success: boolean;
  duration: number;
  resultKind?: 'search' | 'fetch';
  resultItems?: Array<{ title: string; snippet: string; url: string }>;
  resultText?: string;
}

export interface ToolRowHandle {
  el: HTMLElement;        // .bubble-row.tool-row-row wrapper
  details: HTMLDetailsElement;
  statusEl: HTMLElement;
  argsEl: HTMLElement;
  inputSection: HTMLElement;
  resultEl: HTMLElement;
  toolName: string;
}

// Every tool row is a live execution trace. Open it initially so the user can
// follow inputs and outputs as they arrive; the native <details> control still
// lets the user collapse and reopen any row at any time.
export function shouldExpandToolRowInitially(_toolName: string): boolean {
  return true;
}

export function shouldUseTerminalPanel(toolName: string): boolean {
  return toolName === 'read_file'
    || toolName === 'write_file'
    || toolName === 'edit_file'
    || toolName === 'execute_command'
    || toolName === 'list_files';
}

function makeFieldRow(key: string, value: unknown): HTMLElement {
  const field = document.createElement('div');
  field.className = 'tool-row-field';
  const k = document.createElement('span');
  k.className = 'tool-row-field-key';
  k.textContent = key;
  const val = document.createElement('span');
  val.className = 'tool-row-field-value';
  val.textContent = typeof value === 'string' ? value : JSON.stringify(value);
  field.append(k, val);
  return field;
}

function fillInputSection(section: HTMLElement, args: Record<string, unknown>): void {
  section.querySelectorAll('.tool-row-field').forEach((f) => f.remove());
  const keys = Object.keys(args).filter((k) => k !== '');
  for (const k of keys) {
    section.appendChild(makeFieldRow(k, args[k]));
  }
  // Path arguments (path=…, files=[…]) become clickable-to-open.
  linkifyPaths(section);
}

export function createToolRow(toolName: string, args: Record<string, unknown>): ToolRowHandle {
  const wrapper = document.createElement('div');
  wrapper.className = 'bubble-row tool-row-row';

  const details = document.createElement('details');
  details.className = 'tool-row pending';

  const summary = document.createElement('summary');
  summary.className = 'tool-row-summary';

  const icon = document.createElement('span');
  icon.className = 'tool-row-icon';
  icon.textContent = toolIcon(toolName);

  const name = document.createElement('span');
  name.className = 'tool-row-name';
  name.textContent = toolDisplayName(toolName);

  const argsEl = document.createElement('span');
  argsEl.className = 'tool-row-args';
  argsEl.textContent = formatToolArgsSummary(toolName, args);

  const statusEl = document.createElement('span');
  statusEl.className = 'tool-row-status';
  statusEl.innerHTML = '<span class="spinner"></span>';

  summary.append(icon, name, argsEl, statusEl);

  const body = document.createElement('div');
  body.className = 'tool-row-body';

  const usesTerminalPanel = shouldUseTerminalPanel(toolName);

  // Input section
  const inputSection = document.createElement('div');
  inputSection.className = 'tool-row-section tool-row-input';
  if (usesTerminalPanel) inputSection.classList.add('terminal-panel');
  const inputLabel = document.createElement('div');
  inputLabel.className = 'tool-row-section-label';
  inputLabel.textContent = 'Input';
  inputSection.appendChild(inputLabel);
  fillInputSection(inputSection, args);
  body.appendChild(inputSection);

  // Output section
  const outputSection = document.createElement('div');
  outputSection.className = 'tool-row-section tool-row-output';
  if (usesTerminalPanel) {
    outputSection.classList.add('terminal-panel');
  }
  const outputLabel = document.createElement('div');
  outputLabel.className = 'tool-row-section-label';
  outputLabel.textContent = 'Output';
  const resultEl = document.createElement('div');
  resultEl.className = 'tool-row-result';
  outputSection.appendChild(outputLabel);
  outputSection.appendChild(resultEl);
  body.appendChild(outputSection);

  details.append(summary, body);
  wrapper.appendChild(details);

  // Open every row from the moment it appears, so the user can follow the
  // input/output as it executes; clicking the summary still toggles it.
  if (shouldExpandToolRowInitially(toolName)) details.open = true;

  return { el: wrapper, details, statusEl, argsEl, inputSection, resultEl, toolName };
}

export function updateToolRowArgs(row: ToolRowHandle, toolName: string, args: Record<string, unknown>): void {
  row.argsEl.textContent = formatToolArgsSummary(toolName, args);
  fillInputSection(row.inputSection, args);
}

export function finalizeToolRow(row: ToolRowHandle, meta: ToolRowResultMeta): void {
  row.details.classList.remove('pending');
  row.details.classList.add(meta.success ? 'success' : 'failure');
  row.statusEl.textContent = `${meta.success ? '✓' : '✗'} ${formatDuration(meta.duration)}`;

  // Result body (clear first so double-invocation never duplicates output)
  row.resultEl.innerHTML = '';
  if (meta.success && meta.resultKind === 'search' && meta.resultItems?.length) {
    const list = document.createElement('ol');
    list.className = 'search-result-list';
    meta.resultItems.slice(0, 8).forEach((r) => {
      const li = document.createElement('li');
      li.className = 'search-result-item';
      const titleLink = document.createElement('a');
      titleLink.href = r.url;
      titleLink.target = '_blank';
      titleLink.rel = 'noopener noreferrer';
      titleLink.textContent = r.title;
      titleLink.className = 'search-result-title';
      li.appendChild(titleLink);
      const snippet = document.createElement('div');
      snippet.className = 'search-result-snippet';
      snippet.textContent = r.snippet;
      li.appendChild(snippet);
      const url = document.createElement('a');
      url.href = r.url;
      url.target = '_blank';
      url.rel = 'noopener noreferrer';
      url.textContent = r.url;
      url.className = 'search-result-url';
      li.appendChild(url);
      list.appendChild(li);
    });
    row.resultEl.appendChild(list);
    if (meta.resultItems.length > 8) {
      const more = document.createElement('div');
      more.className = 'search-result-more';
      more.textContent = `+${meta.resultItems.length - 8} more results`;
      row.resultEl.appendChild(more);
    }
  } else if (meta.resultText) {
    const pre = document.createElement('pre');
    pre.className = meta.resultKind === 'fetch' ? 'fetch-preview' : 'tool-result-preview';
    pre.textContent = meta.resultText;
    row.resultEl.appendChild(pre);
    // File paths in tool output (search hits, git status, listings) open on click.
    linkifyPaths(row.resultEl);
    // Do not change the open state here. Every row starts open, and preserving
    // the native details state lets the user's collapse/reopen choice win even
    // when a result arrives asynchronously.
  }
}

export function markToolRowStopped(row: ToolRowHandle): void {
  row.details.classList.remove('pending');
  row.details.classList.add('stopped');
  row.statusEl.textContent = '⏹';
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}
