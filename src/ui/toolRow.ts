// src/ui/toolRow.ts
// Claude-Code-style inline tool-call rows. Tool calls render as rows inside the
// chat transcript (not floating toasts): each row shows a friendly name, an
// args summary, and a status (spinner → ✓/✗ + duration). Clicking a row toggles
// a body with the full Input (args) and Output (result).
// Shared by chat.ts (live streaming) and main.ts (session replay) so both
// render identically.

import { linkifyPaths } from './pathLink';
import { formatBytes } from '../shared/format';
import { isTauriRuntime } from '../shared/tauri';
import type { GeneratedImage } from '../shared/types';
// Structured (JSON/YAML) highlighting reuses the same tree-shaken hljs core
// as markdown.ts — re-registering the grammars here is idempotent and keeps
// toolRow.ts self-contained (it is imported by chat.ts, main.ts and tests).
import hljs from 'highlight.js/lib/core';
import jsonGrammar from 'highlight.js/lib/languages/json';
import yamlGrammar from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('json', jsonGrammar);
hljs.registerLanguage('yaml', yamlGrammar);

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
  researcher_web:  { name: 'Web Research',  icon: '🧭' },
  researcher_docs: { name: 'Docs Research', icon: '📚' },
  code_searcher:   { name: 'Code Search',   icon: '🔍' },
  web_search:       { name: 'Web Search',    icon: '🌐' },
  web_fetch:        { name: 'Fetch',         icon: '📡' },
  web_scrape:       { name: 'Web Scrape',    icon: '🕷️' },
  web_public_api:   { name: 'Public API',    icon: '⚡' },
  web_researcher:   { name: 'Web Research',  icon: '🧭' },
  planner:          { name: 'Plan',          icon: '📋' },
  project_auditor:  { name: 'Project Audit', icon: '🛡️' },
  sys_info:         { name: 'System Info',   icon: 'ℹ️' },
  generate_image:   { name: 'Generate Image', icon: '🎨' },
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
    case 'researcher_web':
    case 'web_researcher':
      return typeof v('prompt') === 'string' ? `prompt="${String(v('prompt'))}"` : '';
    case 'researcher_docs':
      return typeof v('library') === 'string' && typeof v('topic') === 'string'
        ? `${String(v('library'))}: ${String(v('topic'))}`
        : '';
    case 'code_searcher':
      return typeof v('query') === 'string' ? `query="${String(v('query'))}"` : '';
    case 'web_search':
      return typeof v('query') === 'string' ? `query="${String(v('query'))}"` : '';
    case 'web_fetch':
    case 'web_scrape':
      return typeof v('url') === 'string' ? `url="${String(v('url'))}"` : '';
    case 'web_public_api':
      return typeof v('category') === 'string'
        ? `category="${String(v('category'))}"`
        : typeof v('query') === 'string' ? `query="${String(v('query'))}"` : '';
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'replace_files':
    case 'list_files':
    case 'create_directory':
      return typeof v('path') === 'string' ? `path="${String(v('path'))}"` : '';
    case 'execute_command':
      return typeof v('command') === 'string' ? `$ ${String(v('command')).slice(0, 100)}` : '';
    case 'generate_image':
      return typeof v('prompt') === 'string' ? `prompt="${String(v('prompt')).slice(0, 80)}"` : '';
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
  resultKind?: 'search' | 'fetch' | 'image';
  resultItems?: Array<{ title: string; snippet: string; url: string }>;
  /** Generated images (data URLs) rendered as <img> cards, ChatGPT/Gemini style. */
  resultImages?: GeneratedImage[];
  resultText?: string;
}

export interface ToolRowHandle {
  el: HTMLElement;        // .bubble-row.tool-row-row wrapper
  details: HTMLDetailsElement;
  statusEl: HTMLElement;
  argsEl: HTMLElement;
  inputSection: HTMLElement;
  resultEl: HTMLElement;
  expandButton: HTMLButtonElement;
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
    case 'code_searcher':
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

// ── Structured (JSON/YAML) detection + formatting ──
// Tool input/output that happens to be JSON or YAML (cat package.json in
// Bash, read_file of a config, a web_fetch API payload, a JSON-typed arg) is
// pretty-printed and syntax-highlighted instead of dumped as raw text.
// JSON is re-serialized with 2-space indent; YAML is only highlighted (no
// YAML parser is bundled, so re-indenting would risk corrupting the text).

export type StructuredLanguage = 'json' | 'yaml';

export interface StructuredText {
  language: StructuredLanguage;
  /** Pretty-printed (JSON) or original (YAML) text, ready to highlight. */
  formatted: string;
}

// Cap for attempting structured parsing — beyond this the text is left as-is
// (a giant log dump is not worth JSON.parsing + re-serializing for display).
export const MAX_STRUCTURED_FORMAT_CHARS = 100_000;

// Conservative YAML sniff: every non-empty line must look like a mapping entry
// (simple/letter-led key, quoted key), a list item, a comment, or a document
// marker; at least TWO such lines with at least ONE real mapping entry. This
// rejects terminal noise (`-rw-r--r-- … 12:00 file`, `abc1234 commit msg`,
// `KEY=value` env lines, single-line query strings like `node: 22`) while
// accepting real YAML documents (compose/k8s configs, .yml files).
function looksLikeYaml(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 2) return false;
  let structure = 0;
  let mappings = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^---$|^\.\.\.$/.test(trimmed) || trimmed.startsWith('#')) { structure++; continue; }
    if (/^\s*- /.test(line)) { structure++; continue; }
    if (/^\s*(?:[\w@][\w.@\/-]*|"[^"]*"|'[^']*')\s*:(\s|$)/.test(line)) { structure++; mappings++; continue; }
    return false;
  }
  return structure >= 2 && mappings >= 1;
}

/** Detect JSON/YAML in a tool input or output string. Returns null for plain
 * text (callers then render it verbatim). */
export function formatStructuredText(text: string): StructuredText | null {
  if (!text || text.length > MAX_STRUCTURED_FORMAT_CHARS) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      return { language: 'json', formatted: JSON.stringify(JSON.parse(trimmed), null, 2) };
    } catch { /* not JSON — fall through to YAML */ }
  }
  if (looksLikeYaml(trimmed)) return { language: 'yaml', formatted: text };
  return null;
}

// Render pretty text with hljs token spans. hljs escapes the source before
// wrapping tokens, so innerHTML is safe; the fallback degrades to textContent.
function renderStructured(container: HTMLElement, language: StructuredLanguage, text: string): void {
  try {
    container.innerHTML = hljs.highlight(text, { language }).value;
  } catch {
    container.textContent = text;
  }
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
    case 'researcher_web':
      return '正在研究网页资料…';
    case 'researcher_docs':
      return '正在检索官方文档…';
    case 'code_searcher':
      return '正在搜索代码库…';
    case 'web_search':
      return '正在搜索…';
    case 'web_fetch':
      return '正在获取页面…';
    case 'web_researcher':
      return '正在研究网页资料…';
    case 'generate_image':
      return '正在生成图片…';
    case 'planner':
      return '正在制定执行计划…';
    case 'project_auditor':
      return '正在审计项目安全与交付风险…';
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

export function formatLiveOutputStatus(toolName: string, bytes: number, latestLine = ''): string {
  if (toolName === 'write_file' && latestLine.startsWith('正在写入 ')) return latestLine;
  if (toolName === 'execute_command') return `已输出 ${formatBytes(bytes)}`;
  return `已收到输出 ${formatBytes(bytes)}`;
}

function updateLiveOutputStatus(row: ToolRowHandle, kind: 'stdout' | 'stderr', line: string): void {
  const previous = Number(row.resultEl.dataset.outputBytes ?? 0);
  const bytes = previous + byteLength(line) + 1;
  row.resultEl.dataset.outputBytes = String(bytes);
  let status = row.resultEl.querySelector('.tool-row-live-status') as HTMLElement | null;
  if (!status) {
    status = document.createElement('div');
    status.className = 'tool-row-live-status';
    status.setAttribute('aria-live', 'polite');
    row.resultEl.prepend(status);
  }
  status.textContent = formatLiveOutputStatus(row.toolName, bytes, kind === 'stderr' ? `错误输出 ${formatBytes(bytes)}` : line);
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
  // JSON-typed args (a config document being written, an API payload) render
  // pretty-printed + highlighted like tool output; everything else stays the
  // plain one-line value.
  const structured = formatStructuredText(typeof value === 'string' ? value : JSON.stringify(value));
  if (structured) {
    val.classList.add('tool-row-field-structured');
    // Same display cap as plain values, applied AFTER pretty-printing so a
    // formatted document still fits the row.
    let display = structured.formatted;
    if (display.length > MAX_FIELD_VALUE_CHARS) {
      const cut = display.length - MAX_FIELD_VALUE_CHARS;
      display = `${display.slice(0, MAX_FIELD_VALUE_CHARS)}\n… (${cut.toLocaleString()} chars truncated)`;
    }
    renderStructured(val, structured.language, display);
  } else {
    val.textContent = displayArgValue(value);
  }
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
const WEB_TOOL_BASE_NAMES = new Set(['web_search', 'web_fetch', 'web_scrape', 'web_public_api', 'researcher_web', 'researcher_docs', 'web-search', 'web-fetch', 'web-scrape', 'search', 'fetch']);

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

  const expandButton = document.createElement('button');
  expandButton.type = 'button';
  expandButton.className = 'tool-row-expand-btn';
  expandButton.setAttribute('aria-pressed', 'false');
  setToolRowExpandedLabel(expandButton, false);
  const stopSummaryToggle = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  expandButton.addEventListener('pointerdown', stopSummaryToggle);
  expandButton.addEventListener('click', (event) => {
    stopSummaryToggle(event);
    setToolRowExpanded(handle, !handle.el.classList.contains('tool-row-expanded'));
  });

  summary.append(icon, name, argsEl, statusEl, expandButton);

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

  const handle: ToolRowHandle = { el: wrapper, details, statusEl, argsEl, inputSection, resultEl, expandButton, toolName };
  return handle;
}

function setToolRowExpandedLabel(button: HTMLButtonElement, expanded: boolean): void {
  const label = expanded ? '还原卡片大小' : '放大到整行';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(expanded));
  button.innerHTML = expanded
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 3H3v6M3 3l6 6M15 21h6v-6M21 21l-6-6"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 9V3h6M3 3l6 6M21 15v6h-6M21 21l-6-6"/></svg>';
}

// Per-row cleanup for the in-flight FLIP transition (transitionend listener +
// fallback timeout). Cancelling the previous cleanup before starting a new
// animation stops a stale timeout from snapping a newer animation mid-flight
// when the maximize/collapse button is clicked rapidly. WeakMap keys are
// weakly held, so rows removed mid-animation are GC'd without extra work.
const flipAnimations = new WeakMap<HTMLElement, () => void>();

export function setToolRowExpanded(row: ToolRowHandle, expanded: boolean): void {
  const el = row.el;
  if (el.classList.contains('tool-row-expanded') === expanded) return;

  // FLIP the width/height change: capture the row's box, toggle the class
  // (grid-column 1/-1 + taller scroll window), then invert the layout delta
  // as a transform so maximize/collapse eases instead of snapping. CSS can't
  // transition grid-column, so the motion lives here in JS.
  const canAnimate = typeof el.getBoundingClientRect === 'function'
    && typeof matchMedia === 'function'
    && !matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Cancel any in-flight animation (and its pending cleanup) and snap to the
  // true layout box so rapid re-clicks measure cleanly instead of stacking
  // transforms or letting a stale timeout wipe a newer animation.
  if (canAnimate) {
    flipAnimations.get(el)?.();
    flipAnimations.delete(el);
    el.style.transition = 'none';
    el.style.transform = '';
    el.style.transformOrigin = '';
    void el.offsetWidth;
    el.style.transition = '';
  }

  const first = canAnimate ? el.getBoundingClientRect() : null;

  // Promote the row to its own compositor layer BEFORE the layout change so
  // the layer is born in the pre-toggle (collapsed) state. Creating it after
  // the grid reflow makes WKWebView rasterize the FINAL expanded box first and
  // paint one untransformed frame — the visible "闪一下" flash on macOS. The
  // already-promoted layer just re-rasterizes in place when the class toggles.
  if (canAnimate) {
    el.style.willChange = 'transform';
    el.style.backfaceVisibility = 'hidden';
  }

  el.classList.toggle('tool-row-expanded', expanded);
  setToolRowExpandedLabel(row.expandButton, expanded);

  if (first && first.width > 0 && first.height > 0) {
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const sx = first.width / last.width;
    const sy = first.height / last.height;
    const moved = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5
      || Math.abs(sx - 1) > 0.005 || Math.abs(sy - 1) > 0.005;
    if (moved) {
      // Force GPU transforms (translate3d/scale3d). A long terminal output is
      // a heavy subtree; without the layer hint WKWebView repaints it on the
      // first frame and the maximize/collapse ease visibly stutters.
      el.style.transformOrigin = 'top left';
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale3d(${sx}, ${sy}, 1)`;
      void el.offsetWidth;
      el.style.transition = 'transform 0.32s var(--ease-out)';
      el.style.transform = 'translate3d(0, 0, 0) scale3d(1, 1, 1)';
      let timer: ReturnType<typeof setTimeout>;
      const onEnd = (event: TransitionEvent): void => {
        if (event.target !== el || event.propertyName !== 'transform') return;
        finish();
      };
      const finish = (): void => {
        el.removeEventListener('transitionend', onEnd);
        clearTimeout(timer);
        el.style.transition = '';
        el.style.transform = '';
        el.style.transformOrigin = '';
        el.style.willChange = '';
        el.style.backfaceVisibility = '';
        if (flipAnimations.get(el) === finish) flipAnimations.delete(el);
      };
      timer = setTimeout(finish, 360);
      el.addEventListener('transitionend', onEnd);
      flipAnimations.set(el, finish);
    } else if (canAnimate) {
      // No measurable layout delta (already full-width) — drop the layer hint
      // so the row is never left permanently promoted.
      el.style.willChange = '';
      el.style.backfaceVisibility = '';
    }
  } else if (canAnimate) {
    el.style.willChange = '';
    el.style.backfaceVisibility = '';
  }
}

export function isToolRowExpanded(row: ToolRowHandle): boolean {
  return row.el.classList.contains('tool-row-expanded');
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
  // Failed rows carry the reason as a hover tooltip so the error is readable
  // even when the row is collapsed (the Output panel stays expandable).
  if (!meta.success && meta.resultText) {
    row.details.title = meta.resultText.slice(0, 300);
  }

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
  } else if (meta.resultKind === 'image' && meta.resultImages?.length) {
    // Image cards need room: the default 240px Output cap would crop a
    // portrait image. The row-level class lifts the cap for this result.
    row.details.classList.add('image-result');
    row.resultEl.appendChild(renderImageGallery(meta.resultImages, meta.resultText));
  } else if (meta.resultText) {
    const pre = document.createElement('pre');
    pre.className = meta.resultKind === 'fetch' ? 'fetch-preview' : 'tool-result-preview';
    if (row.toolName === 'code_searcher') {
      pre.textContent = formatCodeSearchPreview(meta.resultText);
    } else {
      // JSON/YAML output (cat package.json, read_file of a config, an API
      // payload) renders pretty-printed + highlighted. Bash output that is
      // NOT structured keeps its live stream highlight so the panel doesn't
      // flatten to monochrome the moment the command finishes — same
      // tokenizer + step detection as the streaming lines, applied per line.
      // Session replay (main.ts) goes through here too, so restored rows
      // render identically.
      const structured = formatStructuredText(meta.resultText);
      if (structured) {
        renderStructured(pre, structured.language, structured.formatted);
      } else if (row.toolName === 'execute_command') {
        appendHighlightedResult(pre, meta.resultText);
      } else {
        pre.textContent = meta.resultText;
      }
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
function formatCodeSearchPreview(text: string): string {
  try {
    const payload = JSON.parse(text) as { matches?: Array<{ path?: string; line?: number; column?: number; text?: string }>; truncated?: boolean };
    if (!Array.isArray(payload.matches)) return text;
    const lines = payload.matches.slice(0, 120).map((match) =>
      `${match.path ?? '?'}:${match.line ?? 0}${match.column ? `:${match.column}` : ''}: ${match.text ?? ''}`,
    );
    if (payload.truncated) lines.push('… results truncated; refine query or scope');
    return lines.join('\n') || '(no matches)';
  } catch {
    return text;
  }
}

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
  // Counter-based cap (not a per-line DOM scan): once the live preview stops
  // growing, later lines short-circuit immediately. The adapter still
  // collects every line for the full final result.
  const n = Number(row.resultEl.dataset.streamLines ?? 0);
  if (n >= MAX_LIVE_STREAM_LINES) return;
  row.resultEl.querySelector('.tool-row-waiting')?.remove();
  updateLiveOutputStatus(row, kind, line);
  row.resultEl.dataset.streamLines = String(n + 1);
  const div = document.createElement('div');
  div.className = kind === 'stderr' ? 'tool-row-stream-line stderr' : 'tool-row-stream-line';
  // Step tint only on stdout — a stderr line that starts with `> ` or a build
  // verb must keep its red error identity, not get overridden to the step color.
  if (kind === 'stdout' && isStepHeaderLine(line)) div.classList.add('stream-step');
  appendHighlightSegments(div, line);
  row.resultEl.appendChild(div);
}

// ── Generated-image gallery (generate_image tool results) ──
// ChatGPT/Gemini-style picture cards: each image renders as an <img> with a
// download button and click-to-enlarge lightbox. One image fills the row; two
// or more sit side by side (mirroring the SVG gallery grid).

export function imageExtension(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'png';
}

export function imageDefaultName(prompt: string | undefined, index: number, mimeType: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = (prompt ?? 'generated-image')
    .slice(0, 40)
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'generated-image';
  return `${base}-${index + 1}-${stamp}.${imageExtension(mimeType)}`;
}

/** Download one generated image: native save dialog in Tauri (plugin-dialog +
 * save_file_binary), browser anchor download otherwise. */
async function downloadImage(image: GeneratedImage, index: number, prompt?: string): Promise<void> {
  const name = imageDefaultName(prompt, index, image.mimeType);
  if (isTauriRuntime()) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({
        defaultPath: name,
        filters: [{ name: 'Image', extensions: [imageExtension(image.mimeType)] }],
      });
      if (!path) return;
      const comma = image.dataUrl.indexOf(',');
      if (comma > 0 && image.dataUrl.startsWith('data:')) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('save_file_binary', { path, dataBase64: image.dataUrl.slice(comma + 1) });
        return;
      }
      // https URL payload — let the WebView download it directly.
    } catch {
      /* fall through to the anchor path */
    }
  }
  const a = document.createElement('a');
  a.href = image.dataUrl;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// One lightbox at a time; releasing the previous overlay's listeners prevents
// leaks when images are enlarged repeatedly.
let activeImageLightboxCleanup: (() => void) | null = null;

function openImageLightbox(dataUrl: string, alt: string): void {
  activeImageLightboxCleanup?.();
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', alt);
  const img = document.createElement('img');
  img.className = 'image-lightbox-img';
  img.src = dataUrl;
  img.alt = alt;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'image-lightbox-close';
  close.title = '关闭';
  close.setAttribute('aria-label', '关闭');
  close.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  overlay.append(img, close);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') cleanup();
  };
  function cleanup(): void {
    activeImageLightboxCleanup = null;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  close.addEventListener('click', cleanup);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  activeImageLightboxCleanup = cleanup;
}

function renderImageGallery(images: GeneratedImage[], prompt?: string): HTMLElement {
  const gallery = document.createElement('div');
  gallery.className = images.length > 1 ? 'image-gallery' : 'image-gallery single';
  images.forEach((image, index) => {
    const card = document.createElement('figure');
    card.className = 'image-card';
    const img = document.createElement('img');
    img.className = 'generated-image';
    img.src = image.dataUrl;
    img.alt = prompt ? `${prompt}（图 ${index + 1}）` : `生成图片 ${index + 1}`;
    img.loading = 'lazy';
    img.addEventListener('click', () => openImageLightbox(image.dataUrl, img.alt));
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'image-download-btn';
    download.title = '下载图片';
    download.setAttribute('aria-label', '下载图片');
    download.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    download.addEventListener('click', (e) => {
      e.stopPropagation();
      void downloadImage(image, index, prompt);
    });
    const caption = document.createElement('figcaption');
    caption.className = 'image-card-meta';
    caption.textContent = `${image.mimeType.replace('image/', '').toUpperCase()} · ${formatBytes(image.sizeBytes || 0)}`;
    card.append(img, download, caption);
    gallery.appendChild(card);
  });
  return gallery;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}
