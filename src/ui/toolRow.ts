// src/ui/toolRow.ts
// Claude-Code-style inline tool-call rows. Tool calls render as rows inside the
// chat transcript (not floating toasts): each row shows a friendly name, an
// args summary, and a status (spinner → ✓/✗ + duration). Clicking a row toggles
// a body with the full Input (args) and Output (result).
// Shared by chat.ts (live streaming) and main.ts (session replay) so both
// render identically.

import { linkifyPaths } from './pathLink';
import { formatBytes } from '../shared/format';

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
  web_researcher:   { name: 'Web Research',  icon: '🧭' },
  planner:          { name: 'Plan',          icon: '📋' },
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
    case 'web_researcher':
      return typeof v('prompt') === 'string' ? `prompt="${String(v('prompt'))}"` : '';
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
  // File / shell / search / git tools render as black console blocks. Web
  // lookups use the dedicated pale-blue surface below so their links and
  // snippets read as a separate knowledge-lookup result.

  switch (toolName) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'replace_files':
    case 'create_directory':
    case 'diff_files':
    case 'list_files':
    case 'search_files':
    case 'glob_files':
    case 'execute_command':
    case 'git_diff':
    case 'git_log':
    case 'git_status':
      return true;
    default:
      return false;
  }
}

// Cap the display length of giant string args (e.g. write_file `content` with
// a whole HTML file): the Input panel is a live trace, not a file viewer — a
// tens-of-KB text node per streamed token is what used to freeze the UI. The
// full value lives on disk once the tool executes.
const MAX_FIELD_VALUE_CHARS = 4000;

// Line cap for terminal-style output — live stream AND final result. A chatty
// build/test command can emit thousands of lines, and every line past this
// bound is another DOM node (a text node or a highlighted <span>), which is
// what froze the UI on huge outputs. Live streaming stops appending past the
// cap (the adapter still collects every line for the LLM), and the final
// result is truncated to the same bound with a notice (truncateResultLines).
export const MAX_LIVE_STREAM_LINES = 500;

/** Cap terminal output to at most `maxLines` lines, appending a notice line
 * when lines were cut. The LLM still receives the FULL output in the tool
 * result — this bounds only what the panel preview renders (and what gets
 * persisted for session replay). */
export function truncateResultLines(text: string, maxLines = MAX_LIVE_STREAM_LINES): string {
  const lines = text.split('\n');
  // A trailing newline produces a final empty element that is NOT a real line:
  // exactly-cap output (500 lines + '\n') must not spuriously truncate with a
  // misleading "1 lines truncated" notice.
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= maxLines) return text;
  const cut = lines.length - maxLines;
  return `${lines.slice(0, maxLines).join('\n')}\n… (${cut.toLocaleString()} lines truncated)`;
}

// ── Pending-state label ──
// What the row is DOING while it runs, shown in place of the generic
// "等待输出" placeholder so a write that hasn't emitted its first progress
// chunk yet reads as "正在写入 …" instead of "waiting for output". The path
// (and content size, matching the Rust "Wrote N bytes" result) appear as
// soon as the tool-call args arrive — see updateToolRowArgs.
export function pendingActionLabel(toolName: string, args: Record<string, unknown> | undefined): string {
  switch (toolName) {
    case 'write_file': {
      const path = typeof args?.path === 'string' ? args.path : '';
      if (!path) return '正在写入文件…';
      const content = typeof args?.content === 'string' ? args.content : '';
      return `正在写入 ${path}（${formatBytes(byteLength(content))}）`;
    }
    case 'edit_file':
      return '正在编辑文件…';
    case 'replace_files':
      return '正在替换文件内容…';
    case 'execute_command':
      return '正在执行命令…';
    case 'web_search':
      return '正在搜索…';
    case 'web_fetch':
      return '正在获取页面…';
    case 'web_researcher':
      return '正在研究网页资料…';
    case 'planner':
      return '正在制定执行计划…';
    case 'create_directory':
      return '正在创建目录…';
    default:
      return '等待输出';
  }
}

function byteLength(s: string): number {
  // UTF-8 byte length — matches the Rust side's content.len() so the size in
  // the placeholder agrees with the "Wrote N bytes" final result.
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}

function displayArgValue(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.length <= MAX_FIELD_VALUE_CHARS) return s;
  const truncated = s.length - MAX_FIELD_VALUE_CHARS;
  return `${s.slice(0, MAX_FIELD_VALUE_CHARS)}\n… (${truncated.toLocaleString()} chars truncated)`;
}

function makeFieldRow(key: string, value: unknown): HTMLElement {
  const field = document.createElement('div');
  field.className = 'tool-row-field';
  const k = document.createElement('span');
  k.className = 'tool-row-field-key';
  k.textContent = key;
  const val = document.createElement('span');
  val.className = 'tool-row-field-value';
  val.textContent = displayArgValue(value);
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

// Web tools also arrive from MCP servers, registered as `serverName__toolName`
// (e.g. a `web-search` server exposing `search`). Match the base name after
// the server prefix so MCP search/fetch tools get the same treatment as the
// built-in web_search / web_fetch: light-blue card, read-only permission
// class, browser-toggle gate and workspace independence. web_researcher is
// excluded here — it is a subagent tool, not a plain web read.
const WEB_TOOL_BASE_NAMES = new Set(['web_search', 'web_fetch', 'web-search', 'web-fetch', 'search', 'fetch']);

export function isWebSearchLike(toolName: string): boolean {
  const base = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
  return WEB_TOOL_BASE_NAMES.has(base);
}

export function createToolRow(toolName: string, args: Record<string, unknown>): ToolRowHandle {
  const wrapper = document.createElement('div');
  wrapper.className = 'bubble-row tool-row-row';

  const details = document.createElement('details');
  details.className = 'tool-row pending';
  if (toolName === 'sys_info') details.classList.add('sys-info');
  if (isWebSearchLike(toolName) || toolName === 'web_researcher') {
    details.classList.add('web-tool');
  }
  if (toolName === 'web_researcher') details.classList.add('web-researcher');
  if (toolName === 'planner') details.classList.add('planner');

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
  // Pending state shows a spinner only — the "what are we waiting for" cue
  // lives inside the Output panel (.tool-row-waiting + live streamed lines),
  // which is where the user actually looks for the result.
  statusEl.innerHTML = '<span class="spinner"></span>';

  summary.append(icon, name, argsEl, statusEl);

  const body = document.createElement('div');
  body.className = 'tool-row-body';

  // Scroll window for the Input/Output sections. The body's own padding (and
  // especially its bottom padding) must stay OUTSIDE this window — a padding
  // inside a scroll container sits at the END of the scrollable content, so a
  // tall Input/Output pair clipped the last terminal panel flush against the
  // frame's bottom edge (zero gap) until the user scrolled the inner body.
  const scroll = document.createElement('div');
  scroll.className = 'tool-row-scroll';

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
  scroll.appendChild(inputSection);

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
  // Live "waiting for output" placeholder inside the Output panel — a blinking
  // terminal cursor is unmissable right where the user looks for the result.
  // finalizeToolRow clears it (resultEl.innerHTML = ''); markToolRowStopped
  // clears it too.
  const waiting = document.createElement('div');
  waiting.className = 'tool-row-waiting';
  const waitingText = document.createElement('span');
  waitingText.className = 'waiting-text';
  // Tool-aware "what is happening right now" text (正在写入 … / 正在搜索 …)
  // instead of a generic 等待输出 — refreshed with the final args by
  // updateToolRowArgs once the id-bearing tool-call chunk arrives.
  waitingText.textContent = pendingActionLabel(toolName, args);
  const waitingDots = document.createElement('span');
  waitingDots.className = 'waiting-dots';
  const termCursor = document.createElement('span');
  termCursor.className = 'term-cursor';
  waiting.append(waitingText, waitingDots, termCursor);
  resultEl.appendChild(waiting);
  outputSection.appendChild(outputLabel);
  outputSection.appendChild(resultEl);
  scroll.appendChild(outputSection);

  body.appendChild(scroll);

  details.append(summary, body);
  wrapper.appendChild(details);

  // Open every row from the moment it appears, so the user can follow the
  // input/output as it executes; clicking the summary still toggles it.
  if (shouldExpandToolRowInitially(toolName)) details.open = true;

  return { el: wrapper, details, statusEl, argsEl, inputSection, resultEl, toolName };
}

export function updateToolRowArgs(
  row: ToolRowHandle,
  toolName: string,
  args: Record<string, unknown>,
  refreshInput = true,
): void {
  row.argsEl.textContent = formatToolArgsSummary(toolName, args);
  // Refresh the pending label as the streamed args converge: a write row
  // created before its args arrived upgrades from "正在写入文件…" to
  // "正在写入 src/foo.ts（12.3 KB）" the moment path + content are known.
  // Cheap (text node only), so it runs on every delta regardless of
  // refreshInput.
  if (row.details.classList.contains('pending')) {
    const waitingText = row.resultEl.querySelector('.tool-row-waiting .waiting-text');
    if (waitingText) waitingText.textContent = pendingActionLabel(toolName, args);
  }
  // Streaming deltas skip the Input-body rebuild: re-creating every field (and
  // re-running path-linkification over a multi-KB content arg) on each token
  // is what froze the UI mid-stream. The body is filled on row creation and on
  // the id-bearing `tool_call` / `done` chunk (see chat.ts TokenDelta).
  if (refreshInput) fillInputSection(row.inputSection, args);
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
    if (row.toolName === 'execute_command') {
      // Terminal output keeps its live highlight in the final result so the
      // panel doesn't flatten to monochrome the moment the command finishes —
      // same tokenizer + step detection as the streaming lines, applied per
      // line. Session replay (main.ts) goes through here too, so restored
      // Bash rows render identically.
      appendHighlightedResult(pre, meta.resultText);
    } else {
      pre.textContent = meta.resultText;
    }
    row.resultEl.appendChild(pre);
    // File paths in tool output (search hits, git status, listings) open on click.
    linkifyPaths(row.resultEl);
    // Do not change the open state here. Every row starts open, and preserving
    // the native details state lets the user's collapse/reopen choice win even
    // when a result arrives asynchronously.
  }
}

// Render terminal output with the same token highlighting used by live stream
// lines: percentages / step counters / progress bars / error-warn-success
// tokens, plus whole-line tinting for build-step headers. Newlines stay as
// text nodes so the <pre> wraps exactly like the plain-text path.
//
// The output is capped at MAX_LIVE_STREAM_LINES — the same bound as the live
// preview (and the same lines the user watched stream in) — so a 5000-line
// build log can't balloon the DOM; the cut tail becomes a single dimmed
// truncation notice line. Empty lines skip the wrapper span entirely.
function appendHighlightedResult(pre: HTMLElement, text: string): void {
  const capped = truncateResultLines(text);
  const truncated = capped !== text;
  const lines = capped.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > 0) pre.appendChild(document.createTextNode('\n'));
    if (line === '') {
      pre.appendChild(document.createTextNode(line));
      continue;
    }
    const lineEl = document.createElement('span');
    lineEl.className = 'tool-result-line';
    if (isStepHeaderLine(line)) lineEl.classList.add('stream-step');
    // The truncation notice (always the last line when output was cut) renders
    // dimmed so it reads as a system note, not part of the command output.
    if (truncated && i === lines.length - 1) lineEl.classList.add('tool-result-truncated');
    appendHighlightSegments(lineEl, line);
    pre.appendChild(lineEl);
  }
}

export function markToolRowStopped(row: ToolRowHandle): void {
  row.details.classList.remove('pending');
  row.details.classList.add('stopped');
  row.statusEl.textContent = '⏹';
  // Drop the "waiting for output" placeholder. Any output that already
  // streamed into the panel stays visible — a command cut off mid-run leaves
  // its partial trace behind instead of an empty box.
  row.resultEl.querySelector('.tool-row-waiting')?.remove();
}

// Append a live stdout/stderr line to the row's Output panel while the
// command is still running (streamed from the Rust backend's
// execute_command_stream). The "waiting for output" placeholder is removed on
// the first line so it never lingers next to real output.
// Live rendering cap (MAX_LIVE_STREAM_LINES above): extremely chatty commands
// (builds, test runners) can emit thousands of lines; past this many live
// line divs we stop appending to keep the DOM bounded. The adapter keeps
// collecting every line for the full final result, so nothing is lost — only
// the live preview stops growing.

// ── Live stream line highlighting ──
// Progress-type output (percentages, step counters, progress bars) and
// status tokens (error / warning / success) get a color highlight while the
// command runs, so a scrolling build log reads at a glance instead of a wall
// of monochrome text. Pure segmenter — DOM building happens in
// appendToolStreamLine, and every piece of streamed text is inserted via
// textContent (never innerHTML), so output can't inject markup.

export type StreamHighlightClass = 'progress' | 'error' | 'warn' | 'success';

export interface StreamLineSegment {
  text: string;
  cls?: StreamHighlightClass;
}

const STREAM_HIGHLIGHT_PATTERNS: Array<{ re: RegExp; cls: StreamHighlightClass }> = [
  // Percentages: 42%, 99.9%
  { re: /\d+(?:\.\d+)?%/g, cls: 'progress' },
  // Step counters: 1/4, [2/5], (3/7)
  { re: /\d+\/\d+/g, cls: 'progress' },
  // Terminal progress bars: ████░░░░
  { re: /[█▇▆▅▄▃▂▁░▒▓]+/g, cls: 'progress' },
  { re: /error:|Error:|FAILED|failed|Failed|✗|✘/g, cls: 'error' },
  { re: /warning:|Warning:|WARN(?:ING)?|⚠/g, cls: 'warn' },
  { re: /\b(?:Success|success|Done|done|OK|ok)\b|✓|✔/g, cls: 'success' },
];

// Line-level build-step headers: marker-prefixed (`> `, `==> `, `[1/4] `, `## `)
// or starting with a common build verb. The whole line gets a step tint.
// Bracket prefixes are restricted to real step counters ([1/4]) so timestamped
// log lines like `[18:02:34] …` are NOT misread as build steps.
const STEP_PREFIX_RE = /^(?:> |==> |=== |## |\[\d+\/\d+\] |● |▶ )/;
const STEP_VERB_RE = /^(?:Building|Compiling|Installing|Fetching|Downloading|Finished|Running|Starting|Checking|Linking|Generating|Testing|Deploying|Packaging|Uploading|Copying|Cleaning|Preparing|Resolving|Extracting)\b/;

export function isStepHeaderLine(line: string): boolean {
  return STEP_PREFIX_RE.test(line) || STEP_VERB_RE.test(line);
}

/** Split a streamed line into plain + highlighted segments (in order). */
export function highlightStreamLine(line: string): StreamLineSegment[] {
  const hits: Array<{ start: number; end: number; cls: StreamHighlightClass }> = [];
  for (const { re, cls } of STREAM_HIGHLIGHT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      hits.push({ start: m.index, end: m.index + m[0].length, cls });
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  // Sort by position; overlapping hits keep the first (earlier pattern wins).
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number; cls: StreamHighlightClass }> = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.start < last.end) continue;
    merged.push(h);
  }
  const segs: StreamLineSegment[] = [];
  let pos = 0;
  for (const h of merged) {
    if (h.start > pos) segs.push({ text: line.slice(pos, h.start) });
    segs.push({ text: line.slice(h.start, h.end), cls: h.cls });
    pos = h.end;
  }
  if (pos < line.length) segs.push({ text: line.slice(pos) });
  return segs;
}

// Append the plain/highlighted segments of one streamed line into `parent`
// (textContent-only — streamed output can never inject markup).
function appendHighlightSegments(parent: HTMLElement, line: string): void {
  for (const seg of highlightStreamLine(line)) {
    if (seg.cls) {
      const span = document.createElement('span');
      span.className = `stream-hl-${seg.cls}`;
      span.textContent = seg.text;
      parent.appendChild(span);
    } else {
      parent.appendChild(document.createTextNode(seg.text));
    }
  }
}

export function appendToolStreamLine(row: ToolRowHandle, kind: 'stdout' | 'stderr', line: string): void {
  row.resultEl.querySelector('.tool-row-waiting')?.remove();
  // Counter-based cap (not a per-line DOM scan): once the live preview stops
  // growing, later lines short-circuit immediately. The adapter still
  // collects every line for the full final result.
  const n = Number(row.resultEl.dataset.streamLines ?? 0);
  if (n >= MAX_LIVE_STREAM_LINES) return;
  row.resultEl.dataset.streamLines = String(n + 1);
  const div = document.createElement('div');
  div.className = kind === 'stderr' ? 'tool-row-stream-line stderr' : 'tool-row-stream-line';
  // Step tint only on stdout — a stderr line that starts with `> ` or a build
  // verb must keep its red error identity, not get overridden to the step color.
  if (kind === 'stdout' && isStepHeaderLine(line)) div.classList.add('stream-step');
  appendHighlightSegments(div, line);
  row.resultEl.appendChild(div);
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}
