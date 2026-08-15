// src/ui/markdown.ts
// Assistant message renderer: Markdown → HTML with syntax highlighting (hljs),
// inline Mermaid diagrams, and inline PlantUML images (via the public
// plantuml.com server). Called once per assistant bubble on stream completion
// (see src/ui/chat.ts:Completed) and on session restore (src/ui/main.ts).
//
// Streaming UX: keep raw textContent during token-by-token streaming; only
// parse + render when the assistant message is fully complete. This avoids
// partial-code-block flicker and mermaid.parse errors on incomplete input.

import { Marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';
import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { showToast } from '../shared/toast';
import { t } from '../shared/i18n';
import { linkifyPaths } from './pathLink';
import { repairJsonSource, repairMermaidSource, repairSvgSource } from '../shared/parseRepair';
import hljs from 'highlight.js/lib/core';
import 'highlight.js/styles/atom-one-light.css';
// plantuml-encoder types come from src/shared/plantuml-encoder.d.ts.
import plantumlEncoder from 'plantuml-encoder';
import { stripToolCallXml } from './markdownCore';
export { stripToolCallXml } from './markdownCore';

// ── Languages registered for hljs (tree-shaken subset) ──
// Importing `highlight.js` (the default entry) drags in ~190 language grammars
// at ~9.1MB unpacked. Pulling `lib/core` avoids that and we register only the
// grammars users actually need for a coding-agent UI. Each grammar is 5–30KB
// minified; this set is ~150–300KB total instead of ~9MB.

import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('go', go);
// `html` shares the XML grammar as a registered alias — same parser, different lang name.
hljs.registerLanguage('html', xml);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

// Common short aliases used in markdown fenced code blocks.
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['py'],         { languageName: 'python' });
hljs.registerAliases(['rs'],         { languageName: 'rust' });
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['md'],         { languageName: 'markdown' });
hljs.registerAliases(['htm'],        { languageName: 'html' });
hljs.registerAliases(['yml'],        { languageName: 'yaml' });

const PLANTUML_HOST = 'https://www.plantuml.com/plantuml/svg/';

// ── Tiny HTML helpers (escape only what we cannot otherwise trust) ──

function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plantumlUrl(code: string): string {
  return PLANTUML_HOST + plantumlEncoder.encode(code);
}

// Attribute-safe encoding for raw source we must recover later (puml `data-raw`).
// DOMPurify's SAFE_FOR_XML (default on) strips any attribute VALUE containing
// `-->` / `<!--` / `]>` — but PlantUML sequence diagrams use `-->` as edge
// syntax. encodeURIComponent emits no such sequences (nor spaces/quotes), so
// the sanitizer keeps the attribute; bindPumlFallbacks decodes it back.
function encodeRawAttr(s: string): string {
  try {
    return encodeURIComponent(s);
  } catch {
    // Lone surrogates in the source would throw — store raw (rare; sanitize
    // may then strip the value, matching pre-DOMPurify behavior).
    return s;
  }
}

// Returns the lang token of a fenced code info-string (e.g. "ts foo bar" → "ts").
function langOf(infostring: string | undefined): string {
  return ((infostring ?? '').trim().split(/\s+/)[0] ?? '').toLowerCase();
}

function isDark(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

const DIAGRAM_RENDER_TIMEOUT_MS = 15000;

export type DiagramKind = 'mermaid' | 'svg' | 'chart' | 'puml';
type DiagramState = 'loading' | 'preview' | 'error';
const diagramRenderVersions = new WeakMap<HTMLElement, number>();

// The repaired source behind each "已自动修复" badge, keyed by slot. Kept out
// of the DOM on purpose: DOMPurify strips data-* attribute values containing
// `-->` / `<!--` / `]>` (mermaid edge syntax), and the WeakMap entries GC with
// the slot, so a removed bubble never leaks the source text.
const repairedSources = new WeakMap<HTMLElement, string>();

function nextDiagramRenderVersion(slot: HTMLElement): number {
  const version = (diagramRenderVersions.get(slot) ?? 0) + 1;
  diagramRenderVersions.set(slot, version);
  return version;
}

function isCurrentDiagramRender(slot: HTMLElement, version: number): boolean {
  return diagramRenderVersions.get(slot) === version;
}

function diagramControls(): string {
  // Every image-display diagram (svg / chart / mermaid / puml) gets exactly one
  // action — 下载图片 (PNG export). Icon-only button; the label lives in the
  // title/aria-label so the floating pill stays a compact square. No source
  // view, no view toggle.
  return `<div class="diagram-toolbar" role="group" aria-label="${attr(t('diagram.viewControls'))}">` +
    `<button type="button" class="diagram-download-btn" title="${attr(t('diagram.download'))}" aria-label="${attr(t('diagram.download'))}">` +
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>` +
    `</button>` +
    `</div>`;
}

function diagramLoading(): string {
  return `<div class="diagram-loading" role="status" aria-live="polite" aria-label="${attr(t('diagram.loading'))}">` +
    `<span class="diagram-loading-ring" aria-hidden="true"></span>` +
    `<span class="diagram-loading-label">${esc(t('diagram.loading'))}</span>` +
    `</div>`;
}

export function diagramSlot(kind: DiagramKind, source: string, preview: string): string {
  return `<div class="diagram-slot ${kind}-slot" data-diagram-kind="${kind}" data-state="loading" data-view="preview" data-raw="${attr(encodeRawAttr(source))}">` +
    diagramControls() + diagramLoading() +
    `<div class="diagram-preview ${kind}-target">${preview}</div>` +
    `<pre class="diagram-source ${kind}-source"><code class="hljs language-${kind}">${esc(source)}</code></pre>` +
    `<div class="diagram-error" role="alert"></div>` +
    `</div>`;
}

function svgSourcesHtml(sources: string[]): string {
  const slots = sources.map((source) => diagramSlot('svg', source, '')).join('');
  return sources.length > 1 ? `<div class="svg-gallery">${slots}</div>` : slots;
}

// ── Custom renderer: route mermaid / puml code blocks away from hljs ──

export const renderer = new Renderer();

// marked 18.x: renderer methods receive a single token object — we destructure.
renderer.code = (token: { text: string; lang?: string }): string => {
  const code: string = token.text;
  const lang: string = langOf(token.lang);

  if (lang === 'mermaid') {
    return diagramSlot('mermaid', code, '');
  }

  if (lang === 'puml' || lang === 'plantuml') {
    const url = plantumlUrl(code);
    const image = `<img class="puml-diagram" src="${attr(url)}" alt="${attr(t('diagram.plantumlAlt'))}" loading="eager" referrerpolicy="no-referrer" />`;
    return diagramSlot('puml', code, image);
  }

  if (lang === 'svg') {
    return svgSourcesHtml(splitTopLevelSvgSources(code));
  }

  if (lang === 'chart' || lang === 'charts') {
    return diagramSlot('chart', code, '');
  }

  // Other code blocks: emit <pre><code>; hljs tags inside after parse. The code
  // must be HTML-escaped here — marked hands us the raw source, and inserting it
  // unescaped would let `<<` sequences (generics, HTML samples, `<<img onerror>`) be
  // parsed as real markup instead of displayed text. hljs later re-reads
  // textContent and emits its own escaped highlights, so escaping up front is
  // safe and lossless.
  return `<pre><code${lang ? ` class="language-${attr(lang)}"` : ''}>${esc(code)}</code></pre>`;
};

// Raw HTML in assistant output: render it as escaped text instead of live
// markup. Models sometimes emit stray <div>/<br>/<b> tags in prose or in
// "show me how this looks" examples; letting marked inject them unescaped would
// both corrupt the layout and open an injection path from model output into the
// DOM. Block-level HTML is shown as a distinct monospace block; inline tags
// (e.g. <br> inside a paragraph) are escaped back to literal text so they never
// break the surrounding line flow.
renderer.html = (token: { text: string; block?: boolean }): string => {
  const text = esc(token.text);
  return token.block ? `<p class="md-raw-html">${text}</p>` : text;
};

// Images (```![alt](src)```) are allowed through with a strict scheme allowlist
// (http/https/data/blob — never javascript: or file:), then WRAPPED so the
// rendered picture becomes double-click-to-enlarge like every other diagram
// (```svg code blocks, charts, mermaid, PlantUML). A plain <img> has no viewer
// binding and double-clicking it silently did nothing — the exact gap the
// "SVG 图片双击无法放大" report hit: the model emitted a markdown image, not a
// fenced ```svg block. The wrapper carries `md-img-wrap`/`md-img` classes that
// bindMdImagePopup + the assistant-bubble copy guard recognize.
renderer.image = (token: { href: string; title?: string | null; text: string }): string => {
  const src = (token.href ?? '').trim();
  const alt = esc(token.text ?? '');
  // Reject only when a scheme is present AND not in the safe list. Scheme-less
  // relative paths (/img/x.png, ./pic.svg) and protocol-relative (//host/p.png)
  // stay images — marked's previous default renderer + DOMPurify allowed them,
  // and same-origin/workspace-relative images are a normal model output. Only
  // javascript:/file:/data-text/html etc. become plain alt text, so a hostile
  // URL can never turn into an executable attribute.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^(https?:|data:|blob:)/i.test(src)) {
    return alt;
  }
  const title = token.title ? ` title="${attr(token.title)}"` : '';
  return `<span class="md-img-wrap" data-viewer="img"><img class="md-img" src="${attr(src)}" alt="${alt}"${title} loading="lazy" /></span>`;
};

// Links are allowed through but restricted to http(s)/mailto/# and forced to
// open in a new tab with noopener. A regular function (not arrow) so `this` is
// the renderer and marked's inline parser can render the label markdown
// ([**bold**](url) keeps its formatting).
renderer.link = function (
  this: { parser?: { parseInline(t: unknown[]): string } },
  token: { href: string; title?: string | null; text: string; tokens?: unknown[] },
): string {
  const href = token.href.trim();
  const label = token.tokens?.length && this.parser
    ? this.parser.parseInline(token.tokens)
    : esc(token.text);
  if (/^(https?:|mailto:|#)/i.test(href)) {
    const title = token.title ? ` title="${attr(token.title)}"` : '';
    return `<a href="${attr(href)}"${title} target="_blank" rel="noopener noreferrer">${label}</a>`;
  }
  // javascript:/data: and other schemes — render the label as plain text.
  return label;
};

// ── Inline `==text==` highlight extension (the literal "高亮" layer) ──
// `==important==` renders as <mark> — a soft accent background that pops
// against plain prose, satisfying the "highlight vs non-highlight" display
// distinction. Deliberately conservative so code-like text never triggers:
// the content must START with a non-space char and contain no '=' or newline,
// so `a == b`, `x === y`, and `if (a==b)` comparisons stay literal. Exported
// for the headless tests in markdown.test.ts (marked parses without a DOM).
export const highlightExt = {
  name: 'highlight',
  level: 'inline' as const,
  start: (src: string): number => src.indexOf('=='),
  tokenizer: (src: string) => {
    const m = /^==(\S[^=\n]*?)==/.exec(src);
    if (!m) return undefined;
    return { type: 'highlight', raw: m[0], text: m[1], tokens: [] };
  },
  renderer: (token: { text: string }): string => `<mark>${esc(token.text)}</mark>`,
};

const md = new Marked({ gfm: true, breaks: true, renderer });
md.use({ extensions: [highlightExt] });

// ── Mermaid (lazy import — heavy module, ~600KB) ──

type MermaidAPI = typeof import('mermaid').default;
let mermaidMod: MermaidAPI | null = null;
let mermaidInitTheme: 'dark' | 'default' | null = null;

async function ensureMermaid(): Promise<MermaidAPI> {
  if (!mermaidMod) {
    mermaidMod = (await import('mermaid')).default;
  }
  const theme = isDark() ? 'dark' : 'default';
  if (mermaidInitTheme !== theme) {
    mermaidMod.initialize({
      startOnLoad: false,
      theme,
      securityLevel: 'strict',
      fontFamily: 'inherit',
    });
    mermaidInitTheme = theme;
  }
  return mermaidMod;
}

/**
 * Recover a slot's mermaid source. Prefer the `.mermaid-source code` text:
 * DOMPurify (SAFE_FOR_XML defaults on in v3.4.12) strips data-* attribute
 * VALUES containing `-->` / `<!--` / `]>` (its comment-marker mXSS defense) —
 * and mermaid edge syntax is literally `A-->B` — so `data-md-raw` cannot be
 * trusted as a source store once sanitize() has run. The source also lives as
 * element text, which sanitize never removes.
 */
function diagramRawOf(slot: HTMLElement): string {
  return slot.querySelector<HTMLElement>('.diagram-source code')?.textContent
    ?? slot.getAttribute('data-raw')
    ?? '';
}

function setDiagramState(slot: HTMLElement, state: DiagramState, message = ''): void {
  slot.setAttribute('data-state', state);
  const error = slot.querySelector<HTMLElement>('.diagram-error');
  if (error) {
    error.innerHTML = state === 'error'
      ? `<strong>${esc(t('diagram.renderFailed'))}</strong><span>${esc(message)}</span>` +
        `<button type="button" class="diagram-retry">${esc(t('diagram.retry'))}</button>`
      : '';
  }
  // The "已自动修复" badge is only valid while the CURRENT preview came from a
  // repaired source — drop it whenever the slot leaves the preview state (a
  // retry or a theme re-render may not need repair; a failed render must not
  // keep implying the output was auto-fixed). Its stored source goes with it,
  // so a stale entry can never be read by a later badge click.
  if (state !== 'preview') {
    slot.querySelector('.diagram-repaired')?.remove();
    repairedSources.delete(slot);
  }
}

/**
 * Append a subtle "已自动修复" badge to a slot whose source was repaired by
 * the fault-tolerance layer (see src/shared/parseRepair.ts). Positioned at the
 * slot's top-left corner, opposite the hover download pill. Clicking the badge
 * (or pressing Enter/Space on it) opens the original-vs-repaired diff viewer;
 * the click is stopped from bubbling so it never also opens the diagram viewer.
 */
function markDiagramRepaired(slot: HTMLElement, repairedSource: string): void {
  if (slot.querySelector('.diagram-repaired')) return;
  repairedSources.set(slot, repairedSource);
  const badge = document.createElement('span');
  badge.className = 'diagram-repaired';
  badge.textContent = t('diagram.repaired');
  badge.title = t('diagram.repaired.hint');
  badge.setAttribute('role', 'button');
  badge.setAttribute('tabindex', '0');
  badge.addEventListener('click', (event) => {
    event.stopPropagation();
    openRepairDiff(slot);
  });
  badge.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openRepairDiff(slot);
  });
  slot.appendChild(badge);
}

// ── Repair-diff viewer: original source vs repaired source ──

/** A line-level diff entry for the repair-diff viewer's side-by-side panels. */
export interface RepairDiffLine {
  kind: 'same' | 'changed';
  /** Original line — undefined for a pure addition. */
  left?: string;
  /** Repaired line — undefined for a pure removal. */
  right?: string;
}

/**
 * Line-level diff between the original and repaired sources: LCS alignment
 * with a coalescing pass that pairs adjacent removed/added runs into aligned
 * "changed" rows, so a replacement like an unclosed `]` reads as one row of
 * red-left / green-right instead of two misaligned rows. Pure (no DOM) so the
 * headless markdown tests can cover it directly.
 */
export function diffLines(original: string, repaired: string): RepairDiffLine[] {
  const A = linesOf(original);
  const B = linesOf(repaired);
  const n = A.length;
  const m = B.length;

  // LCS length table (bottom-up). Diagram sources are tiny (typically < 200
  // lines) so the O(n·m) table is a non-issue.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const raw: RepairDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      raw.push({ kind: 'same', left: A[i], right: B[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ kind: 'changed', left: A[i] });
      i++;
    } else {
      raw.push({ kind: 'changed', right: B[j] });
      j++;
    }
  }
  while (i < n) { raw.push({ kind: 'changed', left: A[i] }); i++; }
  while (j < m) { raw.push({ kind: 'changed', right: B[j] }); j++; }

  // Coalesce adjacent one-sided rows so replacements pair up per row.
  const merged: RepairDiffLine[] = [];
  let k = 0;
  while (k < raw.length) {
    if (raw[k].left !== undefined && raw[k].right !== undefined) {
      merged.push(raw[k]);
      k++;
      continue;
    }
    const removals: string[] = [];
    const additions: string[] = [];
    while (k < raw.length && (raw[k].left === undefined || raw[k].right === undefined)) {
      if (raw[k].right === undefined) removals.push(raw[k].left ?? '');
      else additions.push(raw[k].right ?? '');
      k++;
    }
    const rows = Math.max(removals.length, additions.length);
    for (let r = 0; r < rows; r++) {
      merged.push({ kind: 'changed', left: removals[r], right: additions[r] });
    }
  }
  return merged;
}

/**
 * Split source text into lines for the diff. split('\n') always appends one
 * phantom empty element after a final newline (e.g. 'A\n' → ['A', '']); drop
 * exactly that one so a mere trailing-newline difference between the two sides
 * never renders a noise row. Any further trailing empties ('A\n\n' → ['A',''])
 * are real blank lines and stay.
 */
function linesOf(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// One repair-diff viewer may be open at a time; track its cleanup so opening
// another — or a diagram viewer, which must not stack overlays — releases the
// previous one's document/window listeners (a leak when only `.remove()` ran).
let activeRepairDiffCleanup: (() => void) | null = null;

/**
 * Open the original-vs-repaired source diff for a slot whose badge was
 * clicked. Dismiss with the close button, backdrop click, or Escape; the
 * overlay is a dark scrim matching the diagram viewer, with a scrollable
 * side-by-side grid where changed lines get red-left / green-right tints.
 */
function openRepairDiff(slot: HTMLElement): void {
  const repaired = repairedSources.get(slot);
  const original = diagramRawOf(slot);
  if (repaired === undefined || original === repaired) return;
  const rows = diffLines(original, repaired);

  // Never stack overlays: release an open diagram viewer, then any prior diff.
  activeViewerCleanup?.();
  activeRepairDiffCleanup?.();

  const overlay = document.createElement('div');
  overlay.className = 'repair-diff-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('diagram.repaired.diffTitle'));

  const panel = document.createElement('div');
  panel.className = 'repair-diff-panel';

  const head = document.createElement('div');
  head.className = 'repair-diff-head';
  const title = document.createElement('span');
  title.className = 'repair-diff-title';
  title.textContent = t('diagram.repaired.diffTitle');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'mermaid-viewer-close repair-diff-close';
  close.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  close.title = t('diagram.repaired.close');
  close.setAttribute('aria-label', t('diagram.repaired.close'));
  close.addEventListener('click', cleanup);
  head.append(title, close);

  const scroll = document.createElement('div');
  scroll.className = 'repair-diff-scroll';

  // Sticky header row: empty gutter, 原始源码, empty gutter, 修复后 — the same
  // 4-column grid as the rows below, so the labels always align with cells.
  const headRow = document.createElement('div');
  headRow.className = 'repair-diff-row repair-diff-head-row';
  headRow.append(
    document.createElement('span'),
    labelSpan(t('diagram.repaired.original'), 'repair-diff-label-left'),
    document.createElement('span'),
    labelSpan(t('diagram.repaired.repairedLabel'), 'repair-diff-label-right'),
  );
  scroll.appendChild(headRow);

  let lnA = 0;
  let lnB = 0;
  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = `repair-diff-row ${row.kind}`;
    if (row.left !== undefined) lnA++;
    if (row.right !== undefined) lnB++;
    rowEl.append(
      lineNum(row.left !== undefined ? lnA : ''),
      cell(row.left, 'left'),
      lineNum(row.right !== undefined ? lnB : ''),
      cell(row.right, 'right'),
    );
    scroll.appendChild(rowEl);
  }

  panel.append(head, scroll);
  overlay.appendChild(panel);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') cleanup();
  };
  function cleanup(): void {
    activeRepairDiffCleanup = null;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) cleanup();
  });
  document.body.appendChild(overlay);
  activeRepairDiffCleanup = cleanup;
}

function labelSpan(text: string, className: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function lineNum(text: number | ''): HTMLElement {
  const el = document.createElement('span');
  el.className = 'repair-diff-ln';
  el.textContent = text === '' ? '' : String(text);
  return el;
}

function cell(text: string | undefined, side: 'left' | 'right'): HTMLElement {
  const el = document.createElement('pre');
  el.className = `repair-diff-cell ${side}`;
  el.textContent = text ?? '';
  if (text === undefined) el.classList.add('empty');
  return el;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = DIAGRAM_RENDER_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(t('diagram.renderFailed'))), timeoutMs);
    promise.then((value) => { window.clearTimeout(timer); resolve(value); }, (err) => {
      window.clearTimeout(timer);
      reject(err);
    });
  });
}

function mermaidRawOf(slot: HTMLElement): string {
  return diagramRawOf(slot);
}

async function renderMermaidNodes(container: HTMLElement): Promise<void> {
  const slots = Array.from(container.querySelectorAll<HTMLElement>('.mermaid-slot:not([data-processed])'));
  if (slots.length === 0) return;
  const attempts = slots.map((slot) => ({
    slot,
    version: nextDiagramRenderVersion(slot),
  }));

  let mermaid: MermaidAPI;
  try {
    mermaid = await withTimeout(ensureMermaid());
  } catch (err) {
    for (const { slot, version } of attempts) {
      if (!isCurrentDiagramRender(slot, version)) continue;
      slot.setAttribute('data-processed', 'true');
      setDiagramState(slot, 'error', err instanceof Error ? err.message : String(err));
    }
    return;
  }

  for (const { slot, version } of attempts) {
    const target = slot.querySelector<HTMLElement>('.mermaid-target');
    if (!target) {
      if (isCurrentDiagramRender(slot, version)) {
        slot.setAttribute('data-processed', 'true');
        setDiagramState(slot, 'error', t('diagram.missingTarget'));
      }
      continue;
    }
    const raw = mermaidRawOf(slot);
    if (!isCurrentDiagramRender(slot, version)) continue;
    slot.setAttribute('data-processed', 'true');
    setDiagramState(slot, 'loading');
    try {
      const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
      const { svg } = await withTimeout(mermaid.render(id, raw));
      if (!isCurrentDiagramRender(slot, version)) continue;
      target.innerHTML = svg;
      setDiagramState(slot, 'preview');
    } catch (err) {
      if (!isCurrentDiagramRender(slot, version)) continue;
      // Smart fault tolerance: a slightly-broken source (stray fence/backticks,
      // leading prose before the diagram start line, HTML comments, a trailing
      // line truncated mid-edge) is repaired and re-rendered once. Only the
      // ORIGINAL error surfaces when the repaired source also fails, so the
      // user always sees the real reason and can retry by hand.
      const repaired = repairMermaidSource(raw);
      if (repaired.repaired) {
        try {
          const retryId = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
          const { svg } = await withTimeout(mermaid.render(retryId, repaired.source));
          if (!isCurrentDiagramRender(slot, version)) continue;
          target.innerHTML = svg;
          markDiagramRepaired(slot, repaired.source);
          setDiagramState(slot, 'preview');
          continue;
        } catch { /* repaired source also failed → show the original error */ }
      }
      const msg = err instanceof Error ? err.message : String(err);
      setDiagramState(slot, 'error', msg);
    }
  }
}

// ── PlantUML: bind error fallbacks for offline / encoding errors ──

function bindPumlFallbacks(container: HTMLElement): void {
  for (const img of Array.from(container.querySelectorAll<HTMLImageElement>('.puml-diagram'))) {
    const slot = img.closest<HTMLElement>('.puml-slot');
    if (!slot || img.hasAttribute('data-diagram-bound')) continue;
    img.setAttribute('data-diagram-bound', 'true');
    const version = nextDiagramRenderVersion(slot);
    slot.setAttribute('data-state', 'loading');
    const timeout = window.setTimeout(() => {
      if (isCurrentDiagramRender(slot, version) && slot.getAttribute('data-state') === 'loading') {
        setDiagramState(slot, 'error', t('diagram.timeout'));
      }
    }, DIAGRAM_RENDER_TIMEOUT_MS);
    img.addEventListener('load', () => {
      window.clearTimeout(timeout);
      if (!isCurrentDiagramRender(slot, version) || slot.getAttribute('data-state') !== 'loading') return;
      setDiagramState(slot, 'preview');
      bindPumlPopup(slot);
    }, { once: true });
    img.addEventListener('error', () => {
      window.clearTimeout(timeout);
      if (!isCurrentDiagramRender(slot, version) || slot.getAttribute('data-state') !== 'loading') return;
      setDiagramState(slot, 'error', t('diagram.imageLoadFailed'));
    }, { once: true });
    if (img.complete) {
      if (img.naturalWidth > 0) {
        window.clearTimeout(timeout);
        if (isCurrentDiagramRender(slot, version)) setDiagramState(slot, 'preview');
      } else {
        window.clearTimeout(timeout);
        if (isCurrentDiagramRender(slot, version)) setDiagramState(slot, 'error', t('diagram.imageLoadFailed'));
      }
    }
  }
}

// ── Inline SVG (```svg blocks) ──

/**
 * Split a fenced SVG source into independent top-level documents. The system
 * prompt (SVG_OUTPUT_PROMPT) tells multi-image requests to emit one ```svg
 * block per image; this splitter is the fallback for models that still answer
 * a "make two options" request with two root `<svg>` elements inside one
 * block — keeping both roots in one preview would shrink each into the same
 * card. Nested SVGs stay inside their owning root. Malformed/unclosed input
 * is returned as one source so the existing repair path can handle it
 * instead of silently dropping part of the diagram.
 */
export function splitTopLevelSvgSources(source: string): string[] {
  const trimmed = source.trim();
  if (!trimmed) return [];

  const tags = findSvgTags(trimmed);
  const roots: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let rootStart = -1;
  for (const tag of tags) {
    if (tag.closing) {
      if (depth === 0) return [trimmed];
      depth--;
      if (depth === 0 && rootStart >= 0) {
        roots.push({ start: rootStart, end: tag.end });
        rootStart = -1;
      }
      continue;
    }

    if (depth === 0) rootStart = tag.start;
    if (!tag.selfClosing) depth++;
    if (depth === 0 && rootStart >= 0) {
      roots.push({ start: rootStart, end: tag.end });
      rootStart = -1;
    }
  }

  // Keep incomplete, prose-wrapped, or comment-separated input intact so no
  // source text is silently discarded and the existing repair path can handle it.
  if (depth !== 0 || rootStart >= 0 || roots.length < 2) return [trimmed];
  const first = roots[0];
  const last = roots[roots.length - 1];
  if (!isSvgSeparator(trimmed.slice(0, first.start)) || !isSvgSeparator(trimmed.slice(last.end))) {
    return [trimmed];
  }
  for (let i = 1; i < roots.length; i++) {
    if (!isSvgSeparator(trimmed.slice(roots[i - 1].end, roots[i].start))) return [trimmed];
  }
  return roots.map(({ start, end }) => trimmed.slice(start, end));
}

function isSvgSeparator(source: string): boolean {
  return source.replace(/<!--[\s\S]*?-->/g, '').trim() === '';
}

interface SvgTag {
  start: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
}

function findSvgTags(source: string): SvgTag[] {
  const tags: SvgTag[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source[i] !== '<') continue;
    const remainder = source.slice(i);
    const name = remainder.match(/^<\/?svg(?=[\s/>])/i);
    if (!name) continue;

    let quote: '"' | "'" | null = null;
    let end = i + name[0].length;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
    }
    if (quote || end >= source.length) return tags;
    const raw = source.slice(i, end + 1);
    tags.push({
      start: i,
      end: end + 1,
      closing: /^<\//.test(name[0]),
      selfClosing: !/^<\//.test(name[0]) && /\/\s*>$/.test(raw),
    });
    i = end;
  }
  return tags;
}

/**
 * Sanitize a model-generated SVG string for inline display. DOMPurify strips
 * <script>, event-handler attributes, and javascript: URLs even inside the SVG
 * namespace, so the rendered picture can never execute. Accepts a full
 * `<svg …>…</svg>` document or a bare fragment (wrapped in a root).
 */
function sanitizeSvgSource(src: string): string {
  const trimmed = src.trim();
  if (!trimmed) return '';
  const wrapped = /^<svg[\s>]/i.test(trimmed)
    ? trimmed
    : `<svg xmlns="http://www.w3.org/2000/svg">${trimmed}</svg>`;
  return DOMPurify.sanitize(wrapped);
}

/**
 * Wrap consecutive SVG blocks in a small gallery. Marked emits fenced blocks as
 * sibling elements with only whitespace text between them, so grouping at this
 * point preserves the author's order while leaving paragraphs and other media
 * as explicit separators. A single SVG remains unwrapped and uses the compact
 * half-width preview style.
 */
export function groupAdjacentSvgSlots(container: HTMLElement): void {
  const slots: HTMLElement[] = [];
  const flush = () => {
    if (slots.length < 2) {
      slots.length = 0;
      return;
    }
    const first = slots[0];
    const parent = first.parentElement;
    if (!parent) {
      slots.length = 0;
      return;
    }
    const gallery = document.createElement('div');
    gallery.className = 'svg-gallery';
    parent.insertBefore(gallery, first);
    for (const slot of slots) gallery.appendChild(slot);
    slots.length = 0;
  };

  for (const child of Array.from(container.children)) {
    if (child.classList.contains('svg-slot')) {
      slots.push(child as HTMLElement);
    } else {
      flush();
    }
  }
  flush();
}

/** Fill every unprocessed `.svg-slot`'s target with the rendered SVG. */
async function renderSvgNodes(container: HTMLElement): Promise<void> {
  const slots = Array.from(container.querySelectorAll<HTMLElement>('.svg-slot:not([data-processed])'));
  if (slots.length === 0) return;
  const attempts = slots.map((slot) => ({ slot, version: nextDiagramRenderVersion(slot) }));

  // Commit the loading state before doing any sanitization/injection. Yielding
  // one frame gives the WebView a chance to paint the square placeholder so a
  // large SVG source can never flash on screen while it is being prepared.
  for (const { slot } of attempts) {
    slot.setAttribute('data-processed', 'true');
    slot.setAttribute('data-view', 'preview');
    const target = slot.querySelector<HTMLElement>('.svg-target');
    if (target) target.innerHTML = '';
    setDiagramState(slot, 'loading');
  }
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      // Two frames give the WebView one complete paint opportunity between
      // loading-state commit and SVG sanitization/injection.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    } else {
      setTimeout(resolve, 0);
    }
  });

  for (const { slot, version } of attempts) {
    // A retry or newer render invalidates this attempt while it is yielding.
    // Never let stale sanitization overwrite the newer preview/error state.
    if (!isCurrentDiagramRender(slot, version)) continue;
    const target = slot.querySelector<HTMLElement>('.svg-target');
    if (!target) {
      setDiagramState(slot, 'error', t('diagram.missingTarget'));
      continue;
    }
    const src = diagramRawOf(slot);
    if (!src.trim()) {
      setDiagramState(slot, 'error', '(empty SVG)');
      continue;
    }
    let svg = sanitizeSvgSource(src);
    let repairedSource: string | null = null;
    if (!svg) {
      // Smart fault tolerance: a fenced / prose-wrapped or truncated document
      // is extracted or completed, then sanitized once more before giving up.
      const repaired = repairSvgSource(src);
      if (repaired.repaired) {
        svg = sanitizeSvgSource(repaired.source);
        if (svg) repairedSource = repaired.source;
      }
    }
    if (!svg) {
      setDiagramState(slot, 'error', 'SVG sanitization produced no output');
      continue;
    }
    // Commit to this render BEFORE touching the DOM: a stale attempt (already
    // superseded by a retry/theme re-render) must never append its repair
    // badge to a preview that did not actually come from a repaired source.
    if (!isCurrentDiagramRender(slot, version)) continue;
    target.innerHTML = svg;
    if (repairedSource) markDiagramRepaired(slot, repairedSource);
    setDiagramState(slot, 'preview');
  }
}

// ── Native charts (```chart blocks) ──
// Parse a line-based data DSL into a ChartSpec, then render it with the lazily
// loaded echarts module (src/ui/echartsChart.ts). The parser stays dependency-
// free and is tuned for AI-generated output (units, weather tables, full-width
// punctuation); rendering delegates to echarts' SVG renderer.

export interface ChartSeries {
  label: string;
  value: number;
}

/** One named column of a multi-series chart (header row + multiple numeric columns). */
export interface ChartMultiSeries {
  name: string;
  data: ChartSeries[];
}

/** One node of a hierarchical chart (tree / treemap / sunburst). */
export interface ChartNode {
  name: string;
  value?: number;
  children?: ChartNode[];
}

export type ChartType =
  | 'bar' | 'hbar' | 'line' | 'pie'
  | 'scatter' | 'kline' | 'radar'
  | 'tree' | 'treemap' | 'sunburst';

export interface ChartSpec {
  type: ChartType;
  title: string;
  unit: string;
  data: ChartSeries[];
  /** Present when the source carries a header plus >=2 numeric columns: one entry per column. */
  series?: ChartMultiSeries[];
  /** scatter points, grouped into named series (single series for the line DSL). */
  scatter?: Array<{ name: string; points: Array<{ name: string; value: [number, number] }> }>;
  /** kline candles, one per date; value order is [open, close, low, high]. */
  ohlc?: Array<{ date: string; value: [number, number, number, number] }>;
  /** radar axis names (indicators). */
  indicators?: string[];
  /** radar series: one entry per named row. */
  radarData?: Array<{ name: string; value: number[] }>;
  /** Root node for tree / treemap / sunburst hierarchical charts. */
  tree?: ChartNode;
}

/**
 * Parse the ```chart DSL into a ChartSpec. Supported forms:
 *
 *   type: bar | hbar | line | pie        (default bar; `type:` or bare word)
 *   title: …
 *   unit: …
 *   一月 120                              (one `label value` per line; also
 *   二月 180                                accepts `label, 120`, `label:120`,
 *                                           tab-separated, or CSV)
 *
 * Multi-series (line/bar/hbar): a header row plus rows with >=2 numeric
 * columns renders one series per column — the first column is the x label:
 *
 *   日期 北京 上海
 *   周一 25 27
 *   周二 26 28
 *
 * The same shape works as a markdown table (`| 日期 | 北京 | 上海 |`), CSV,
 * or tab-separated rows; without a header the series fall back to
 * `系列1/系列2/…`. A JSON payload (`{ "type": "pie", "data": [["a",1],…] }`)
 * is also accepted. Throws on unparseable input.
 */
/**
 * Parse the JSON form of a chart payload into a ChartSpec. Throws 'chart …'
 * errors for schema violations (missing data array, no numeric rows, bad row)
 * so the caller can tell "not JSON" from "wrong chart schema".
 */
function chartSpecFromJson(raw: unknown): ChartSpec {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const rawType = String(obj.type ?? 'bar').toLowerCase();
  const type = normalizeChartType(rawType);
  const title = String(obj.title ?? '');
  const unit = String(obj.unit ?? '');
  const dataValue = Array.isArray(raw) ? raw : obj.data;

  // Hierarchy charts accept `data` as a single root node object as well as an
  // array, so the array gate below is skipped for them.
  if (type === 'tree' || type === 'treemap' || type === 'sunburst') {
    const root = Array.isArray(dataValue) ? hierarchyFromJson(dataValue, title) : hierarchyNodeFromJson(dataValue);
    if (!root) throw new Error('chart needs at least one data row');
    if (type !== 'tree') fillHierarchyValues(root);
    return { type, title, unit, data: [], tree: root };
  }

  const arr = dataValue;
  if (!Array.isArray(arr)) throw new Error('chart JSON needs a data array');

  if (type === 'scatter') {
    // Optional multi-series form: { type, series: [{ name, data: [[x,y],…] }] }.
    const seriesRows = Array.isArray(obj.series) ? obj.series : null;
    if (seriesRows) {
      const scatter = seriesRows.map((s) => {
        const row = (s && typeof s === 'object') ? s as Record<string, unknown> : {};
        const points = Array.isArray(row.data) ? parseJsonScatterPoints(row.data) : [];
        return { name: String(row.name ?? '系列'), points };
      }).filter((s) => s.points.length > 0);
      if (scatter.length === 0) throw new Error('chart needs at least one data row');
      return { type, title, unit, data: scatter.flatMap((s) => s.points.map((p) => ({ label: p.name, value: p.value[1] }))), scatter };
    }
    const points = parseJsonScatterPoints(arr);
    if (points.length === 0) throw new Error('chart needs at least one data row');
    return {
      type, title, unit,
      data: points.map((p) => ({ label: p.name, value: p.value[1] })),
      scatter: [{ name: '数据', points }],
    };
  }

  if (type === 'kline') {
    // Each row is [date, open, close, low, high] (or an object with those keys).
    const rows = arr.map((r) => {
      if (Array.isArray(r)) {
        const nums = r.slice(1, 5).map((v) => chartNumber(v));
        return nums.every(Number.isFinite) ? { date: String(r[0] ?? ''), value: [nums[0], nums[1], nums[2], nums[3]] as [number, number, number, number] } : null;
      }
      if (r && typeof r === 'object') {
        const row = r as Record<string, unknown>;
        const nums = [row.open, row.close, row.low, row.high].map((v) => chartNumber(v));
        return nums.every(Number.isFinite) ? { date: String(row.date ?? row.label ?? ''), value: [nums[0], nums[1], nums[2], nums[3]] as [number, number, number, number] } : null;
      }
      return null;
    }).filter((r): r is NonNullable<typeof r> => r !== null && r.date !== '');
    if (rows.length === 0) throw new Error('chart needs at least one data row');
    return { type, title, unit, data: rows.map((r) => ({ label: r.date, value: r.value[3] })), ohlc: rows };
  }

  if (type === 'radar') {
    const indicators = Array.isArray(obj.indicators) ? obj.indicators.map((v) => String(v)).filter(Boolean) : [];
    const rows = arr.map((r, i) => {
      if (Array.isArray(r)) {
        const values = r.slice(1).map((v) => chartNumber(v));
        return values.some(Number.isFinite) ? { name: String(r[0] ?? `#${i + 1}`), value: values } : null;
      }
      if (r && typeof r === 'object') {
        const row = r as Record<string, unknown>;
        const values = Array.isArray(row.value) ? row.value.map((v) => chartNumber(v)) : [];
        return values.some(Number.isFinite) ? { name: String(row.name ?? `#${i + 1}`), value: values } : null;
      }
      return null;
    }).filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length === 0) throw new Error('chart needs at least one data row');
    const len = Math.max(...rows.map((r) => r.value.length));
    const finalIndicators = indicators.length >= len ? indicators.slice(0, len) : Array.from({ length: len }, (_, i) => indicators[i] ?? `维度${i + 1}`);
    return { type, title, unit, data: rows.map((r) => ({ label: r.name, value: r.value[0] ?? 0 })), indicators: finalIndicators, radarData: rows };
  }

  const data: ChartSeries[] = arr.map((r, i) => {
    if (Array.isArray(r)) {
      return { label: String(r[0] ?? `#${i + 1}`), value: chartNumber(r[1]) };
    }
    if (r && typeof r === 'object') {
      const row = r as { label?: unknown; value?: unknown };
      return { label: String(row.label ?? `#${i + 1}`), value: chartNumber(row.value) };
    }
    throw new Error(`bad chart row: ${JSON.stringify(r)}`);
  }).filter((row) => Number.isFinite(row.value));
  if (data.length === 0) throw new Error('chart needs at least one data row');
  return { type, title, unit, data };
}

/** Parse JSON scatter points: `[x, y]`, `[name, x, y]`, or `{ name, x, y }`. */
function parseJsonScatterPoints(arr: unknown[]): Array<{ name: string; value: [number, number] }> {
  const points: Array<{ name: string; value: [number, number] }> = [];
  arr.forEach((r, i) => {
    if (Array.isArray(r)) {
      const nums = r.map((v) => chartNumber(v));
      const pair = nums.length === 2 && nums.every(Number.isFinite)
        ? [nums[0], nums[1]]
        : nums.length >= 3 && nums.slice(1, 3).every(Number.isFinite)
          ? [nums[1], nums[2]]
          : null;
      if (pair) points.push({ name: nums.length >= 3 ? String(r[0]) : `#${i + 1}`, value: [pair[0], pair[1]] });
    } else if (r && typeof r === 'object') {
      const row = r as Record<string, unknown>;
      const x = chartNumber(row.x);
      const y = chartNumber(row.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        points.push({ name: String(row.name ?? `#${i + 1}`), value: [x, y] });
      }
    }
  });
  return points;
}

/**
 * Build a single ChartNode from a JSON value (object `{name, value?, children?}`
 * or pair `[name, value]`). Returns null when nothing parseable is present.
 */
function hierarchyNodeFromJson(r: unknown): ChartNode | null {
  if (Array.isArray(r)) {
    const value = chartNumber(r[1]);
    if (!Number.isFinite(value)) return null;
    return { name: String(r[0] ?? ''), value };
  }
  if (r && typeof r === 'object') {
    const row = r as Record<string, unknown>;
    const name = String(row.name ?? '');
    if (!name) return null;
    const node: ChartNode = { name };
    const value = chartNumber(row.value);
    if (Number.isFinite(value)) node.value = value;
    if (Array.isArray(row.children)) {
      const children = row.children.map(hierarchyNodeFromJson).filter((c): c is ChartNode => c !== null);
      if (children.length > 0) node.children = children;
    }
    return node;
  }
  return null;
}

/**
 * Build a ChartNode from a JSON data array: either a single root node object or
 * an array of nodes / `[name, value]` pairs (wrapped under a synthetic root).
 * Returns null when nothing parseable is present.
 */
function hierarchyFromJson(arr: unknown[], title: string): ChartNode | null {
  if (arr.length === 0) return null;
  // A single object entry that is not a pair is treated as the root node itself.
  if (arr.length === 1 && !Array.isArray(arr[0]) && arr[0] && typeof arr[0] === 'object') {
    return hierarchyNodeFromJson(arr[0]);
  }
  const nodes = arr.map(hierarchyNodeFromJson).filter((n): n is ChartNode => n !== null);
  if (nodes.length === 0) return null;
  return { name: title || '数据', children: nodes };
}

/**
 * Post-order pass that fills missing values: a parent without a value becomes
 * the sum of its children (leaves without a value default to 1). Needed by
 * treemap / sunburst, which size slices from values.
 */
function fillHierarchyValues(node: ChartNode): number {
  const children = node.children ?? [];
  if (children.length === 0) {
    if (node.value === undefined) node.value = 1;
    return node.value;
  }
  let sum = 0;
  for (const child of children) sum += fillHierarchyValues(child);
  if (node.value === undefined) node.value = sum;
  return node.value;
}

/**
 * Core chart parser: JSON form (with smart repair) then the line DSL. The
 * `meta` out-param reports whether a JSON repair was applied, so the rendered
 * slot can show the "已自动修复" badge (see parseChartSourceWithMeta).
 */
function parseChartSourceCore(source: string, meta: { repaired: boolean; repairedSource?: string }): ChartSpec {
  const trimmed = source.trim();
  if (!trimmed) throw new Error('empty chart source');

  // JSON form. The gate also admits ```-fenced and quote-led text so a fenced
  // JSON payload reaches the repair path instead of falling straight to the
  // line parser (which would fail with a confusing "no data rows" error).
  if (/^[{["`]/.test(trimmed)) {
    try {
      return chartSpecFromJson(JSON.parse(trimmed));
    } catch {
      // Invalid JSON (or a schema-violating payload) — attempt a smart repair
      // (trailing commas / single quotes / unquoted keys / code fences /
      // full-width punctuation / prose wrappers / comments) before the line
      // parser gets a shot. Parse-gated: only accepted if it parses cleanly.
      const repaired = repairJsonSource(trimmed);
      if (repaired.repaired) {
        try {
          const spec = chartSpecFromJson(JSON.parse(repaired.source));
          meta.repaired = true;
          meta.repairedSource = repaired.source;
          return spec;
        } catch { /* repaired payload still rejected → line parser below */ }
      }
    }
  }

  let type: ChartSpec['type'] = 'bar';
  let title = '';
  let unit = '';
  const lines: string[] = [];
  // Untrimmed counterpart of `lines` — the hierarchy parser needs leading
  // whitespace to recover the tree structure (indentation = depth).
  const rawLines: string[] = [];

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const typeM = line.match(/^type\s*[:=：]\s*(.+)$/i);
    if (typeM) {
      const t = typeM[1].trim().toLowerCase();
      type = normalizeChartType(t);
      continue;
    }
    const titleM = line.match(/^title\s*[:=：]\s*(.+)$/i);
    if (titleM) { title = titleM[1].trim().replace(/^["']|["']$/g, ''); continue; }
    const unitM = line.match(/^unit\s*[:=：]\s*(.+)$/i);
    if (unitM) { unit = unitM[1].trim().replace(/^["']|["']$/g, ''); continue; }
    // Bare type shorthand (`line`, `pie`, …) as its own line — only honored
    // while no data row has been collected yet (the single-series pass below
    // re-checks it against actual parsed rows for the legacy note-first case).
    if (lines.length === 0 && CHART_BARE_TYPE_RE.test(line)) {
      type = normalizeChartType(line);
      continue;
    }
    lines.push(line);
    rawLines.push(rawLine);
  }

  if (lines.length === 0) throw new Error('chart needs at least one data row');

  // New chart families have their own line shapes, routed before the generic
  // single/multi-series logic (which would misread e.g. kline's 4 OHLC columns
  // as four separate series).
  if (type === 'scatter') return parseScatterLines(type, title, unit, lines);
  if (type === 'kline') return parseKlineLines(type, title, unit, lines);
  if (type === 'radar') return parseRadarLines(type, title, unit, lines);
  if (type === 'tree' || type === 'treemap' || type === 'sunburst') {
    const root = parseHierarchyLines(rawLines, type !== 'tree');
    if (!root) throw new Error('chart needs at least one data row');
    if (type !== 'tree') fillHierarchyValues(root);
    return { type, title, unit, data: [], tree: root };
  }

  // Multi-series: at least two rows with >=2 numeric columns (after the label)
  // render as one series per column — `日期 北京 上海` header + `周一 25 27` rows.
  if (isMultiSeries(lines)) {
    return parseMultiSeries(type, title, unit, lines);
  }

  // Single-series parsing (weather tables, `label value` rows, …).
  const data: ChartSeries[] = [];
  let tableValueIndex: number | null = null;
  for (const line of lines) {
    if (data.length === 0 && CHART_BARE_TYPE_RE.test(line)) {
      type = normalizeChartType(line);
      continue;
    }
    if (line.includes('|')) {
      const headerIndex = parseChartTableHeader(line);
      if (headerIndex !== null) {
        tableValueIndex = headerIndex;
        continue;
      }
      const table = parseChartTableRow(line, tableValueIndex);
      if (table) {
        data.push(table);
        continue;
      }
    }
    // Weather models commonly append units (`25°C`, `25℃`, `25度`) and use
    // full-width punctuation (`周一：25℃`). Keep the unit out of the numeric
    // value while preserving the complete label. A trailing percent or common
    // measurement unit is accepted as well for non-weather charts.
    const m = line.replace(/^(?:[-*•]\s+)/, '').match(
      /^(.*?)[\s,:，：|]+([-+]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*(?:°\s*[CF]|℃|º[CF]|度|摄氏度|华氏度|%|毫米|mm|km\/?h))?\s*[|,，]?\s*$/i,
    );
    if (!m) continue; // skip malformed lines (headings, notes)
    const value = chartNumber(m[2]);
    if (!Number.isFinite(value)) continue;
    const rawLabel = m[1].trim();
    if (/(?:暂无|无数据|未知|n\/a|na)$/i.test(rawLabel)) continue;
    const label = rawLabel.replace(/^[|"']+|[|"']+$/g, '');
    data.push({ label: label || `#${data.length + 1}`, value });
  }

  if (data.length === 0) throw new Error('chart needs at least one data row');
  return { type, title, unit, data };
}

/**
 * Parse the ```chart DSL into a ChartSpec. See parseChartSourceWithMeta for
 * the repair flag. Supported forms:
 *
 *   type: bar | hbar | line | pie        (default bar; `type:` or bare word)
 *   title: …
 *   unit: …
 *   一月 120                              (one `label value` per line; also
 *   二月 180                                accepts `label, 120`, `label:120`,
 *                                           tab-separated, or CSV)
 *
 * Multi-series (line/bar/hbar): a header row plus rows with >=2 numeric
 * columns renders one series per column — the first column is the x label:
 *
 *   日期 北京 上海
 *   周一 25 27
 *   周二 26 28
 *
 * The same shape works as a markdown table (`| 日期 | 北京 | 上海 |`), CSV,
 * or tab-separated rows; without a header the series fall back to
 * `系列1/系列2/…`. A JSON payload (`{ "type": "pie", "data": [["a",1],…] }`)
 * is also accepted — slightly broken JSON (trailing commas, single quotes,
 * unquoted keys, fences, full-width punctuation) is repaired automatically.
 * Throws on unparseable input.
 */
export function parseChartSource(source: string): ChartSpec {
  return parseChartSourceCore(source, { repaired: false });
}

/**
 * Like parseChartSource, but also reports whether a JSON repair was applied
 * and, when it was, the repaired source string (the badge's diff view needs
 * both the original and the repaired payload).
 */
export function parseChartSourceWithMeta(source: string): { spec: ChartSpec; repaired: boolean; repairedSource?: string } {
  const meta: { repaired: boolean; repairedSource?: string } = { repaired: false };
  const spec = parseChartSourceCore(source, meta);
  return { spec, repaired: meta.repaired, repairedSource: meta.repairedSource };
}

const CHART_BARE_TYPE_RE = /^(bar|hbar|horizontal\s*bar|line|pie|area|scatter|散点图?|kline|candlestick|candle|k线图?|蜡烛图?|radar|雷达图?|tree|树(形)?图?|treemap|矩形树图?|sunburst|旭日图?|柱状图?|横向柱状图?|折线图?|饼图)$/i;

function isNumericToken(token: string): boolean {
  return Number.isFinite(chartNumber(token));
}

interface MultiRow {
  label: string;
  values: number[];
  /** Every cell/column token of the row — used to match a header's column count. */
  cells: string[];
}

/**
 * A multi-series data row: a label plus >=2 numeric columns. Table/CSV/TSV use
 * `label v1 v2` separators (pipes, commas, tabs, colons); the whitespace form
 * treats the trailing pure-number tokens as the columns (`周一 25 27`). Returns
 * null for single-value rows, header rows, and malformed lines.
 */
function parseMultiRow(line: string): MultiRow | null {
  let cells: string[];
  if (line.includes('|')) {
    cells = line.split('|').map((c) => c.trim()).filter(Boolean);
  } else if (/[\t,，:：]/.test(line)) {
    cells = line.split(/[\t,，:：]+/).map((s) => s.trim()).filter(Boolean);
  } else {
    const parts = line.split(/\s+/).filter(Boolean);
    const values: number[] = [];
    // Collect trailing numeric tokens as values, but always keep the first
    // token as the row label — a line like `2024 10 20` means x=2024, not a
    // numeric column. Matches the single-series `label value` semantics.
    let i = parts.length;
    while (i > 1 && isNumericToken(parts[i - 1])) {
      values.unshift(chartNumber(parts[i - 1]));
      i--;
    }
    if (values.length < 2) return null;
    return { label: parts.slice(0, i).join(' '), values, cells: parts };
  }
  if (cells.length < 3) return null;
  const values = cells.slice(1).map((c) => chartNumber(c));
  if (values.some((v) => !Number.isFinite(v))) return null;
  return { label: cells[0], values, cells };
}

/** True when at least two lines carry >=2 numeric columns — the chart is multi-series. */
function isMultiSeries(lines: string[]): boolean {
  let count = 0;
  for (const line of lines) {
    if (parseMultiRow(line)) count++;
  }
  return count >= 2;
}

/** Split a possible header line into cells (pipes, tabs, commas, or spaces). */
function splitHeaderCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (line.includes('|')) return line.split('|').map((c) => c.trim()).filter(Boolean);
  return line.split(/[\t,，:：\s]+/).filter(Boolean);
}

function parseMultiSeries(
  type: ChartSpec['type'],
  title: string,
  unit: string,
  lines: string[],
): ChartSpec {
  // A bare type line that slipped past collection (note-first sources) still wins.
  if (lines[0] && CHART_BARE_TYPE_RE.test(lines[0])) {
    type = normalizeChartType(lines[0]);
  }
  const rows: Array<{ label: string; values: number[] }> = [];
  let names: string[] | null = null;
  const isSeparatorRow = (l: string): boolean => {
    const cells = l.includes('|') ? l.split('|').map((x) => x.trim()).filter(Boolean) : [];
    return cells.length > 0 && cells.every((x) => /^:?-{2,}:?$/.test(x));
  };
  for (let i = 0; i < lines.length; i++) {
    const row = parseMultiRow(lines[i]);
    if (row) {
      rows.push(row);
      continue;
    }
    // A non-data FIRST line with the same column count as the following data
    // row is the header (series names). Skip separator rows (`---`) and notes
    // to find the first real data row. Other non-data lines are notes.
    if (names === null && rows.length === 0 && i < lines.length - 1 && !CHART_BARE_TYPE_RE.test(lines[i])) {
      const cells = splitHeaderCells(lines[i]);
      let next: MultiRow | null = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (!isSeparatorRow(lines[j])) {
          next = parseMultiRow(lines[j]);
          if (next) break;
        }
      }
      if (cells && next && cells.length >= 3 && cells.length === next.cells.length
          && cells.slice(1).every((c) => !isNumericToken(c))
          && !cells.every((c) => /^:?-{2,}:?$/.test(c))) {
        names = cells.slice(1);
        continue;
      }
    }
  }
  if (rows.length === 0) throw new Error('chart needs at least one data row');
  const seriesCount = Math.max(...rows.map((r) => r.values.length));
  const seriesNames = names !== null && names.length >= seriesCount
    ? names.slice(0, seriesCount)
    : Array.from({ length: seriesCount }, (_, i) => `系列${i + 1}`);
  return {
    type,
    title,
    unit,
    data: rows.map((r) => ({ label: r.label, value: r.values[0] ?? 0 })),
    series: seriesNames.map((name, si) => ({
      name,
      data: rows.map((r) => ({ label: r.label, value: Number.isFinite(r.values[si]) ? r.values[si] : 0 })),
    })),
  };
}

// ── Scatter / kline / radar / hierarchy line-DSL parsers ──

/** Split a DSL line into cells (pipes, commas, colons, tabs, or whitespace). */
function chartCells(line: string): string[] {
  if (line.includes('|')) return line.split('|').map((c) => c.trim()).filter(Boolean);
  return line.split(/[\t,，:：\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Scatter DSL: one point per line as `name x y` (or bare `x y`). Multi-series
 * scatter uses the JSON form. Points get an auto `#n` name when absent.
 */
function parseScatterLines(type: ChartSpec['type'], title: string, unit: string, lines: string[]): ChartSpec {
  const points: Array<{ name: string; value: [number, number] }> = [];
  for (const rawLine of lines) {
    if (CHART_BARE_TYPE_RE.test(rawLine)) continue;
    const cells = chartCells(rawLine);
    const nums = cells.map((c) => chartNumber(c));
    const x = nums[nums.length - 2];
    const y = nums[nums.length - 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const name = cells.slice(0, -2).join(' ').trim() || `#${points.length + 1}`;
    points.push({ name, value: [x, y] });
  }
  if (points.length === 0) throw new Error('chart needs at least one data row');
  return {
    type, title, unit,
    data: points.map((p) => ({ label: p.name, value: p.value[1] })),
    scatter: [{ name: '数据', points }],
  };
}

/**
 * K-line DSL: a header (`日期 开盘 收盘 最低 最高`) plus one OHLC row per date.
 * Column order is OPEN CLOSE LOW HIGH to match echarts candlestick data items.
 */
function parseKlineLines(type: ChartSpec['type'], title: string, unit: string, lines: string[]): ChartSpec {
  const rows: Array<{ date: string; value: [number, number, number, number] }> = [];
  for (const rawLine of lines) {
    if (CHART_BARE_TYPE_RE.test(rawLine)) continue;
    const cells = chartCells(rawLine);
    if (cells.length < 5) continue;
    const nums = cells.slice(1, 5).map((c) => chartNumber(c));
    if (!nums.every(Number.isFinite)) continue; // header / separator rows
    rows.push({ date: cells[0], value: [nums[0], nums[1], nums[2], nums[3]] });
  }
  if (rows.length === 0) throw new Error('chart needs at least one data row');
  return {
    type, title, unit,
    data: rows.map((r) => ({ label: r.date, value: r.value[3] })),
    ohlc: rows,
  };
}

/**
 * Radar DSL: optional `indicators: 速度 攻击 防御` line (or a header row of
 * indicator names) plus one series row per line: `名称 v1 v2 v3 …`.
 */
function parseRadarLines(type: ChartSpec['type'], title: string, unit: string, lines: string[]): ChartSpec {
  let indicators: string[] = [];
  const rows: Array<{ name: string; value: number[] }> = [];
  for (const rawLine of lines) {
    if (CHART_BARE_TYPE_RE.test(rawLine)) continue;
    const im = rawLine.match(/^indicators\s*[:=：]\s*(.+)$/i);
    if (im) {
      indicators = chartCells(im[1]);
      continue;
    }
    const cells = chartCells(rawLine);
    const nums = cells.slice(1).map((c) => chartNumber(c));
    if (nums.length > 0 && nums.every(Number.isFinite)) {
      rows.push({ name: cells[0] || `#${rows.length + 1}`, value: nums });
      continue;
    }
    // Header row: >=2 cells, no numeric cells → indicator names (if not set yet).
    if (indicators.length === 0 && cells.length >= 2 && cells.every((c) => !Number.isFinite(chartNumber(c)))) {
      indicators = cells;
    }
  }
  if (rows.length === 0) throw new Error('chart needs at least one data row');
  const len = Math.max(...rows.map((r) => r.value.length));
  const finalIndicators = indicators.length >= len ? indicators.slice(0, len) : Array.from({ length: len }, (_, i) => indicators[i] ?? `维度${i + 1}`);
  return {
    type, title, unit,
    data: rows.map((r) => ({ label: r.name, value: r.value[0] ?? 0 })),
    indicators: finalIndicators,
    radarData: rows,
  };
}

/**
 * Hierarchical DSL (tree / treemap / sunburst): indentation defines depth —
 * each 2-space indent (or a `- ` / `* ` bullet) drops one level. The first
 * line is the root. For treemap / sunburst a trailing number on a line becomes
 * the node's value (`  电子 500`). Returns the root node, or null when empty.
 */
function parseHierarchyLines(lines: string[], withValues: boolean): ChartNode | null {
  const stack: Array<{ node: ChartNode; depth: number }> = [];
  let root: ChartNode | null = null;
  for (const rawLine of lines) {
    if (CHART_BARE_TYPE_RE.test(rawLine) && stack.length === 0) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const depth = Math.round(indent / 2);
    let text = rawLine.trim().replace(/^[-*•]\s*/, '');
    if (!text) continue;
    let node: ChartNode = { name: text };
    if (withValues) {
      const m = text.match(/^(.*?)[\s,:，：|]+([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*$/);
      if (m) {
        const value = Number(m[2]);
        if (Number.isFinite(value)) {
          node = { name: m[1].trim() || text, value };
        }
      }
    }
    if (!root) {
      root = node;
      stack.push({ node, depth });
      continue;
    }
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1].node : root;
    (parent.children ??= []).push(node);
    stack.push({ node, depth });
  }
  return root;
}

function chartNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== 'string') return Number.NaN;
  const normalized = value.trim().replace(/，/g, ',');
  const match = normalized.match(
    /^[-+]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?\s*(?:°\s*[CF]|℃|º[CF]|度|摄氏度|华氏度|%|毫米|mm|km\/?h)?$/i,
  );
  return match ? Number(normalized.replace(/,/g, '').replace(/\s*(?:°\s*[CF]|℃|º[CF]|度|摄氏度|华氏度|%|毫米|mm|km\/?h)$/i, '')) : Number.NaN;
}

function chartTableCells(line: string): string[] {
  return line.split('|').map((cell) => cell.trim()).filter(Boolean);
}

function parseChartTableHeader(line: string): number | null {
  if (!line.includes('|')) return null;
  const cells = chartTableCells(line);
  const index = cells.findIndex((cell) => /(?:气温|温度|平均.*温|最高温|最低温|temperature|temp)/i.test(cell));
  return index >= 0 ? index : null;
}

function parseChartTableRow(line: string, preferredValueIndex: number | null): ChartSeries | null {
  if (!line.includes('|')) return null;
  const cells = chartTableCells(line);
  if (cells.length < 2 || cells.every((cell) => /^:?-{2,}:?$/.test(cell))) return null;
  const valueIndex = preferredValueIndex === null
    ? cells.length - 1
    : preferredValueIndex;
  if (valueIndex <= 0 || valueIndex >= cells.length) return null;
  const value = chartNumber(cells[valueIndex]);
  if (!Number.isFinite(value)) return null;
  const label = cells.slice(0, valueIndex).join(' / ').replace(/^[:：-]+|[:：-]+$/g, '').trim();
  return { label: label || `#${valueIndex}`, value };
}

function normalizeChartType(t: string): ChartSpec['type'] {
  if (/^(hbar|horizontal|横向柱状|条形)/i.test(t)) return 'hbar';
  if (/^(line|折线)/i.test(t)) return 'line';
  if (/^(pie|饼)/i.test(t)) return 'pie';
  if (/^(scatter|散点)/i.test(t)) return 'scatter';
  if (/^(kline|candle|k线|蜡烛)/i.test(t)) return 'kline';
  if (/^(radar|雷达)/i.test(t)) return 'radar';
  if (/^(treemap|矩形树图)/i.test(t)) return 'treemap';
  if (/^(sunburst|旭日)/i.test(t)) return 'sunburst';
  if (/^(tree|树)/i.test(t)) return 'tree';
  return 'bar';
}

/**
 * Fill every unprocessed `.chart-slot`'s target with an echarts SVG chart.
 * Lazily loads the echarts module (its own ~400KB chunk) so the first chart in
 * a session pays one small import while startup stays untouched. Parse errors
 * are synchronous; import/render failures surface the standard error state.
 */
let echartsChartMod: typeof import('./echartsChart') | null = null;

async function ensureEchartsChart(): Promise<typeof import('./echartsChart')> {
  if (!echartsChartMod) {
    echartsChartMod = await withTimeout(import('./echartsChart'));
  }
  return echartsChartMod;
}

async function renderChartNodes(container: HTMLElement): Promise<void> {
  const slots = Array.from(container.querySelectorAll<HTMLElement>('.chart-slot:not([data-processed])'));
  if (slots.length === 0) return;
  const attempts = slots.map((slot) => ({ slot, version: nextDiagramRenderVersion(slot) }));

  // Commit the loading state, then yield two frames so the slot is laid out
  // before echarts init. Without the yield, echarts can measure a 0/100px
  // container width when a chart is rendered synchronously right after its DOM
  // is inserted (session restore, retry) — the SVG then comes out distorted
  // and the PNG export inherits the wrong dimensions.
  for (const { slot, version } of attempts) {
    if (!isCurrentDiagramRender(slot, version)) continue;
    slot.setAttribute('data-processed', 'true');
    setDiagramState(slot, 'loading');
  }
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    } else {
      setTimeout(resolve, 0);
    }
  });

  let mod: typeof import('./echartsChart');
  try {
    mod = await ensureEchartsChart();
  } catch (err) {
    for (const { slot, version } of attempts) {
      if (!isCurrentDiagramRender(slot, version)) continue;
      setDiagramState(slot, 'error', err instanceof Error ? err.message : String(err));
    }
    return;
  }

  for (const { slot, version } of attempts) {
    if (!isCurrentDiagramRender(slot, version)) continue;
    const target = slot.querySelector<HTMLElement>('.chart-target');
    if (!target) {
      setDiagramState(slot, 'error', t('diagram.missingTarget'));
      continue;
    }
    try {
      const { spec, repaired, repairedSource } = parseChartSourceWithMeta(diagramRawOf(slot));
      mod.renderEchartInto(target, spec);
      if (!isCurrentDiagramRender(slot, version)) continue;
      if (repaired && repairedSource) markDiagramRepaired(slot, repairedSource);
      setDiagramState(slot, 'preview');
    } catch (err) {
      if (!isCurrentDiagramRender(slot, version)) continue;
      const msg = err instanceof Error ? err.message : String(err);
      setDiagramState(slot, 'error', msg);
    }
  }
}

// ── hljs: synchronous per-bubble ──

function highlightAll(container: HTMLElement): void {
  const els = container.querySelectorAll<HTMLElement>(
    'pre code.hljs, pre code[class*="language-"]',
  );
  for (const el of Array.from(els)) {
    try {
      hljs.highlightElement(el);
    } catch {
      /* keep raw text on parse failure */
    }
  }
}

// ── Public API ──


/**
 * Parse `text` as Markdown and render into `container` with syntax highlighting
 * (hljs), inline mermaid diagrams, and inline `<img>` PlantUML diagrams.
 */
export async function renderMarkdown(
  text: string,
  container: HTMLElement,
  options: { yieldBeforeParse?: boolean } = {},
): Promise<void> {
  // Yield before the expensive parse/sanitize/highlight pipeline during live
  // completion. Session replay already slices work into batches, so it opts
  // out here to avoid a second artificial frame gap for every assistant block.
  if (options.yieldBeforeParse !== false) {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
  }
  // 1) Parse to HTML synchronously (renders fenced-code overrides inline).
  // marked always appends a trailing \n; trim it — with white-space:pre-wrap on
  // the bubble, that trailing newline would render as a visible blank line.
  const html = (md.parse(text, { async: false }) as string).replace(/\n+$/, '');
  // Defense-in-depth: the custom renderer already escapes raw HTML and
  // restricts link/image schemes, but sanitize the final HTML anyway so any
  // future renderer gap (or a marked default renderer, e.g. <img>) can never
  // inject executable markup from model output into the WebView. ADD_ATTR keeps
  // our target="_blank" links working; data-* attributes are allowed by default.
  container.innerHTML = DOMPurify.sanitize(html, {
    // ADD_ATTR: target is ours on links; loading + referrerpolicy are ours on
    // the PlantUML <img> and are not in DOMPurify's default allowed set.
    ADD_ATTR: ['target', 'loading', 'referrerpolicy'],
  });
  // Bind image viewers immediately after DOM replacement. Waiting until after
  // Mermaid/chart work below leaves an already-visible image with no dblclick
  // handler while another diagram is still loading.
  bindMdImagePopup(container);
  // Mark the bubble as fully-rendered markdown so CSS can collapse whitespace
  // (white-space:normal). marked emits newline characters BETWEEN block
  // elements (</p>\n<p>, </li>\n<li>, </pre>\n<ul>…); under the bubble's
  // default white-space:pre-wrap each of those renders as a full blank line,
  // inflating the perceived line/paragraph spacing. During streaming (raw
  // text + diffStreaming) pre-wrap stays on; only the finished render flips.
  container.classList.add('md-rendered');

  // 2) Synchronous: hljs over all code blocks (idempotent).
  highlightAll(container);

  // 2b) Clickable file paths: any path-shaped text (prose, inline code, code
  // blocks) becomes a .path-link that opens the path on click. Runs after hljs
  // so highlighted code spans are walked too. During streaming (diffStreaming)
  // paths stay plain text — only the completed render gets links, avoiding
  // re-linking churn on every token.
  linkifyPaths(container);

  // 3) Inline SVG (```svg) + native charts (```chart) — both synchronous.
  // Group before awaiting sanitization so independent loading placeholders are
  // already laid out as a gallery while their SVGs are being prepared.
  groupAdjacentSvgSlots(container);
  await renderSvgNodes(container);
  // SVG targets become visible before chart/Mermaid rendering can finish. Bind
  // their double-click handler now, not at the end of the whole pipeline.
  bindVectorPopup(container);
  await renderChartNodes(container);

  // Start PlantUML listeners before awaiting Mermaid so a slow Mermaid render
  // cannot extend the PlantUML spinner beyond its own bounded timeout.
  bindPumlFallbacks(container);

  // 4) Async: mermaid renders embed SVG into .mermaid-diagram nodes.
  await renderMermaidNodes(container);

  // 5) Bind the post-render preview/source controls and diagram viewers.
  bindDiagramControls(container);
  bindMermaidPopup(container);
  bindPumlPopup(container);
  bindVectorPopup(container);
  bindMdImagePopup(container);

  // 6) Add copy + save buttons to code blocks.
  addCodeBlockActions(container);
}

// ═══════════════════════════════════════════════════════════════════════
// Streaming-time renderer
// ═══════════════════════════════════════════════════════════════════════
//
// The streaming renderer is kept as close to the final one as possible so the
// message the user watches grow is the message they end up with — no layout
// "reset" at completion. Every block (including the still-growing last one) is
// rendered through the normal marked pipeline; mermaid blocks emit a
// `.mermaid-slot` holding the source while the stream runs, then the Completed
// pass renders the SVG into the same slot (CSS cross-fades source→diagram).
// PlantUML is the one deliberate exception: its server-side image only loads at
// completion, so during streaming it appears as a plain code block.

const STREAM_THROTTLE_MS = 100;

const streamRenderer = new Renderer();
streamRenderer.html = (token: { text: string; block?: boolean }): string => {
  const text = esc(token.text);
  return token.block ? `<p class="md-raw-html">${text}</p>` : text;
};
streamRenderer.link = function (
  this: { parser?: { parseInline(t: unknown[]): string } },
  token: { href: string; title?: string | null; text: string; tokens?: unknown[] },
): string {
  const href = token.href.trim();
  const label = token.tokens?.length && this.parser
    ? this.parser.parseInline(token.tokens)
    : esc(token.text);
  if (/^(https?:|mailto:|#)/i.test(href)) {
    const title = token.title ? ` title="${attr(token.title)}"` : '';
    return `<a href="${attr(href)}"${title} target="_blank" rel="noopener noreferrer">${label}</a>`;
  }
  return label;
};
streamRenderer.code = (token: { text: string; lang?: string }): string => {
  const lang = langOf(token.lang);
  if (lang === 'mermaid') return diagramSlot('mermaid', token.text, '');
  if (lang === 'svg') {
    return svgSourcesHtml(splitTopLevelSvgSources(token.text));
  }
  if (lang === 'chart' || lang === 'charts') return diagramSlot('chart', token.text, '');
  return `<pre><code class="hljs language-${attr(lang)}">${esc(token.text)}</code></pre>`;
};
const mdStream = new Marked({ gfm: true, breaks: true, renderer: streamRenderer });
mdStream.use({ extensions: [highlightExt] });

interface StreamState {
  timer: number | undefined;
  lastRenderedText: string;
  lastRenderTime: number;
  /** Newest text seen; the timer closure reads this so a coalesced render always commits the latest frame, never the stale one from schedule time. */
  latestText: string;
}

const streamStates = new WeakMap<HTMLElement, StreamState>();

function streamStateFor(container: HTMLElement): StreamState {
  let s = streamStates.get(container);
  if (!s) {
    s = { timer: undefined, lastRenderedText: '', lastRenderTime: 0, latestText: '' };
    streamStates.set(container, s);
  }
  return s;
}

/**
 * Per-block incremental diff. Walks `mdStream.lexer(text)` (top-level tokens)
 * and pair-wise matches each token against the existing DOM child at the same
 * index via `data-md-raw`. Identical raw → leave the child alone (hljs spans,
 * scroll position, and any animation effects are preserved). Different raw →
 * replace with a freshly-rendered-and-highlighted single block. Beyond tokens
 * length → trim trailing old children.
 *
 * Net effect: a long-running stream that adds tokens to ONE block (e.g. writes
 * inner content of a code fence that has already opened) re-renders only that
 * one element, never disturbing adjacent closed fences, paragraphs, or hljs-tagged
 * code blocks.
 */
function ungroupStreamingSvgGalleries(container: HTMLElement): void {
  for (const gallery of Array.from(container.children)) {
    if (!gallery.classList.contains('svg-gallery') || gallery.hasAttribute('data-md-raw')) continue;
    while (gallery.firstElementChild) container.insertBefore(gallery.firstElementChild, gallery);
    gallery.remove();
  }
}

function diffStreaming(container: HTMLElement, text: string): void {
  ungroupStreamingSvgGalleries(container);
  // During streaming, chat.ts sets `bubble.textContent = …` for instant raw
  // feedback; that leaves a plain text node that must NOT render next to the
  // highlighted blocks below (it would duplicate every message). Drop all
  // non-element children before diffing the rendered blocks in.
  for (const child of Array.from(container.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) container.removeChild(child);
  }

  // Match the finished render's whitespace handling from the very first
  // streamed frame. Block HTML marked emits contains newlines INSIDE list /
  // table / blockquote containers (`<ul>\n<li>…`); under the bubble's default
  // white-space:pre-wrap each renders as a visible blank line, and they would
  // collapse when renderMarkdown adds .md-rendered at completion — a layout
  // jump the user sees as the message "re-formatting itself" after it ends.
  // Applying the class here keeps streaming layout identical to the final one.
  container.classList.add('md-rendered');

  type Token = { type: string; raw: string; [k: string]: unknown };
  let tokens: Token[];
  try {
    // marked 18: lexer is on the Marked instance, returns top-level block tokens.
    tokens = mdStream.lexer(text) as unknown as Token[];
  } catch (err) {
    // Partial markdown can occasionally trip the lexer — keep the last-frame
    // DOM (whose data-md-raw was already correct for the prior tick).
    if (typeof console !== 'undefined') {
      const msg = err instanceof Error ? err.message : String(err);
      console.debug(`[markdown-ts] lexer failed len=${text.length}: ${msg}`);
    }
    return;
  }

  // NB: we advance a separate `childIdx` (not the token index) because some
  // token types — `space`, `def` — render no element (renderBlockToken returns
  // '' and we `continue`). Indexing children by token position would drift and
  // append duplicate blocks whenever blank lines split paragraphs.
  let childIdx = 0;
  for (let ti = 0; ti < tokens.length; ti++) {
    const tk = tokens[ti];
    const oldEl = container.children[childIdx] as HTMLElement | undefined;

    // Same source slice ⇒ child is already the canonical rendering for this
    // token. Skip entirely.
    if (oldEl && oldEl.getAttribute('data-md-raw') === tk.raw) { childIdx++; continue; }

    // Render EVERY token — including the still-growing last one — through the
    // same block pipeline the completed render uses. marked's lexer already
    // assigns stable block types to partial input (`# Hea` is a heading, an
    // opened ``` fence is a code block, `- it` is a list), so the user watches
    // the real formatted block grow in place. Rendering the last token as raw
    // plain text instead (the old design) is what produced the "one version,
    // then another" jump: the tail of the message looked like unformatted
    // markdown during the stream and snapped into a different layout at
    // completion. Inherent streaming latency remains — `**bold` stays literal
    // until the closing `**` arrives, exactly like ChatGPT/Claude.
    const html = renderBlockToken(tk);
    if (!html) continue;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const newEl = tmp.firstElementChild as HTMLElement | null;
    if (!newEl) continue;
    newEl.setAttribute('data-md-raw', tk.raw);

    // Highlight freshly-mounted code blocks only. Pre-existing hljs spans on
    // unchanged siblings are left intact.
    if (newEl.tagName === 'PRE' && newEl.firstElementChild?.tagName === 'CODE') {
      try {
        hljs.highlightElement(newEl.firstElementChild as HTMLElement);
      } catch { /* keep raw text on parser failure */ }
    }

    if (oldEl) container.replaceChild(newEl, oldEl);
    else container.appendChild(newEl);
    childIdx++;
  }

  // Trim trailing old children beyond the elements we just reconciled (rare
  // during stream — usually only happens if the LLM deletes content).
  while (container.children.length > childIdx) {
   container.removeChild(container.lastElementChild!);
  }
  // Group adjacent SVG slots immediately in the streaming DOM. The next diff
  // pass ungroups only these generated galleries, while a gallery representing
  // one multi-root fence keeps its data-md-raw wrapper and remains stable.
  groupAdjacentSvgSlots(container);
}

/**
 * Render a single top-level block token through the streaming-mode Marked
 * instance's parser.
 *
 * NB: we must go through `mdStream.parser([token])` rather than calling
 * `streamRenderer[token.type](token)` directly — marked 18 renderer methods
 * reach for `this.parser` (set by the Parser during a real parse pass), so
 * invoking them standalone throws and would degrade every paragraph/heading/
 * list block to a raw <p> during streaming (no inline bold/italic/code).
 */
function renderBlockToken(token: { type: string; raw: string; [k: string]: unknown }): string {
  try {
    const out = mdStream.parser([token as import('marked').Token]) as string;
    if (out && out.trim()) return out;
  } catch { /* fall through */ }
  // Fallback: render the raw text as a non-styled paragraph. Some token types
  // emit whitespace-only artifacts that don't carry visible content. The
  // bubble is already white-space:normal (md-rendered) during streaming, so
  // the fallback needs explicit pre-wrap to keep multi-line raw newlines
  // visible instead of collapsing them to spaces.
  if (!token.raw.trim()) return '';
  return `<p class="stream-raw">${esc(String(token.raw))}</p>`;
}

/**
 * Throttled renderer for in-progress assistant messages. Call on every
 * TokenDelta — renders the bubble at most once per 100ms.
 *
 * Leading-edge throttle: the first token renders immediately, subsequent
 * tokens arriving inside the window coalesce into a single render scheduled
 * at the window boundary (with the LATEST text). The old trailing-edge
 * design (reset-the-timer-on-every-call) meant a continuous stream never
 * actually rendered until it paused — the bubble stayed raw text.
 *
 * Internals re-render only the top-level DOM blocks whose source changed,
 * leaving closed/complete blocks (e.g. already-closed ```fenced code```)
 * frozen — no re-parse, no hljs re-tag, no DOM thrash.
 *
 * `onRendered` (optional) fires after a render pass commits — use it to
 * re-sync scroll position, since diffStreaming mutates content up to 100ms
 * after the token that triggered it.
 */
export function scheduleStreamingRender(
  text: string,
  container: HTMLElement,
  onRendered?: () => void,
): void {
  const state = streamStateFor(container);
  if (state.lastRenderedText === text) return;
  state.latestText = text;

  const doRender = () => {
    state.timer = undefined;
    // Render the newest text the throttle window has seen, not the snapshot
    // from when the timer was scheduled (tokens keep arriving meanwhile).
    const latest = state.latestText;
    diffStreaming(container, latest);
    state.lastRenderedText = latest;
    state.lastRenderTime = Date.now();
    onRendered?.();
  };

  const elapsed = Date.now() - state.lastRenderTime;
  if (elapsed >= STREAM_THROTTLE_MS) {
    // Leading edge (or first token): render immediately.
    if (state.timer != null) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    doRender();
    return;
  }

  // Inside the window: coalesce into one render at the boundary, always
  // carrying the newest text (doRender reads state.latestText).
  if (state.timer == null) {
    state.timer = window.setTimeout(doRender, STREAM_THROTTLE_MS - elapsed);
  }
}

/**
 * Cancel any pending streaming render for `container`. Must be called from
 * the Completed event handler before/after handing off to renderMarkdown,
 * so a late-firing throttled tick cannot race against the final pipeline.
 */
export function cancelStreamingRender(container: HTMLElement): void {
  const state = streamStates.get(container);
  if (!state) return;
  if (state.timer != null) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  // Wipe lastRenderedText so any stray scheduleStreamingRender() calls still
  // no-op on the now-finalized bubble; reset the throttle clock so a fresh
  // stream on this bubble starts with an immediate render.
  state.lastRenderedText = '';
  state.lastRenderTime = 0;
}

// ── Theme coupling ──
//
// settings.ts toggles `[data-theme]` on <html>. hljs colors are CSS-overridden
// in styles.css via [data-theme="dark"] rules — no re-render needed there.
// Mermaid SVG colors are baked in at render time, so we re-render every
// .mermaid-diagram on the page when the theme flips.

if (typeof document !== 'undefined') {
  document.addEventListener('pure:theme-changed', async () => {
    mermaidInitTheme = null; // force re-init on next mermaid call
    // echarts charts also bake colors at render time — re-render every chart
    // slot so they follow the theme (the old instance is disposed inside
    // renderEchartInto before the new one renders).
    const chartSlots = Array.from(document.querySelectorAll<HTMLElement>('.chart-slot[data-state="preview"]'));
    if (chartSlots.length > 0) {
      for (const slot of chartSlots) {
        nextDiagramRenderVersion(slot);
        slot.removeAttribute('data-processed');
        const target = slot.querySelector<HTMLElement>('.chart-target');
        if (target) target.innerHTML = '';
      }
      await renderChartNodes(document.body);
      bindVectorPopup(document.body);
    }
    const all = Array.from(document.querySelectorAll<HTMLElement>('.mermaid-slot'));
    if (all.length === 0) return;
    for (const slot of all) {
      const target = slot.querySelector<HTMLElement>('.mermaid-target');
      nextDiagramRenderVersion(slot);
      slot.removeAttribute('data-processed');
      if (target) target.innerHTML = '';
      slot.setAttribute('data-state', 'loading');
    }
    await renderMermaidNodes(document.body);
    bindDiagramControls(document.body);
    bindMermaidPopup(document.body);
    bindPumlPopup(document.body);
    bindVectorPopup(document.body);
  });
}

// ── Click-to-expand diagram viewer ──

function bindDiagramActivation(
  target: HTMLElement,
  getDiagram: () => HTMLElement | null,
  activation: 'click' | 'dblclick' = 'click',
): void {
  if (target.hasAttribute('data-popup-bound')) return;
  target.setAttribute('data-popup-bound', 'true');
  target.setAttribute('role', 'button');
  target.setAttribute('tabindex', '0');
  target.setAttribute('aria-label', t('diagram.openViewer'));
  const open = (event?: Event) => {
    // Let interactive descendants keep their own behavior (links inside a
    // rendered SVG must navigate, not open the viewer). The activation target
    // itself carries role="button" (for keyboard access), so only a hit on a
    // DIFFERENT interactive element underneath suppresses the viewer — a click
    // on the target or its picture content always opens it.
    const clicked = event?.target as Element | null;
    if (clicked && typeof clicked.closest === 'function') {
      const hit = clicked.closest('a[href], button, [role="button"]');
      // A generated SVG may use links or role="button" on individual shapes.
      // For the diagram's dblclick affordance the whole picture must remain
      // enlargable; otherwise only those particular SVGs intermittently ignore
      // the gesture depending on where the pointer lands.
      if (hit && hit !== target && activation !== 'dblclick') return;
    }
    const diagram = getDiagram();
    if (diagram) showDiagramViewer(diagram);
  };
  target.addEventListener(activation, (event) => open(event));
  target.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open();
  });
}

function bindDiagramControls(container: HTMLElement): void {
  for (const slot of Array.from(container.querySelectorAll<HTMLElement>('.diagram-slot'))) {
    if (slot.hasAttribute('data-controls-bound')) continue;
    slot.setAttribute('data-controls-bound', 'true');
    // Every slot has a single 下载图片 action: PlantUML images come from an
    // external server URL, the rest are locally-rendered SVGs to rasterize.
    for (const button of Array.from(slot.querySelectorAll<HTMLButtonElement>('.diagram-download-btn'))) {
      button.addEventListener('click', () => {
        if (slot.getAttribute('data-diagram-kind') === 'puml') {
          void downloadPumlImage(slot);
        } else {
          void exportDiagramPng(slot);
        }
      });
    }
    slot.addEventListener('click', (event) => {
      if (!(event.target as Element | null)?.closest('.diagram-retry')) return;
      const kind = slot.getAttribute('data-diagram-kind');
      const target = slot.querySelector<HTMLElement>('.diagram-preview');
      if (!kind || !target) return;
      slot.removeAttribute('data-processed');
      target.innerHTML = kind === 'puml' ? target.innerHTML : '';
      setDiagramState(slot, 'loading');
      const host = slot.parentElement ?? slot;
      if (kind === 'mermaid') {
        void renderMermaidNodes(host).then(() => {
          bindMermaidPopup(host);
        });
      } else if (kind === 'svg') {
        void renderSvgNodes(host).then(() => bindVectorPopup(host));
      } else if (kind === 'chart') {
        void renderChartNodes(host).then(() => bindVectorPopup(host));
      } else {
        const oldImage = target.querySelector<HTMLImageElement>('.puml-diagram');
        if (oldImage) {
          const replacement = oldImage.cloneNode(true) as HTMLImageElement;
          replacement.removeAttribute('data-diagram-bound');
          target.replaceChildren(replacement);
          bindPumlFallbacks(slot);
          bindPumlPopup(slot);
        }
      }
    });
  }
}

function bindMermaidPopup(container: HTMLElement): void {
  const slots = container.matches('.mermaid-slot')
    ? [container]
    : Array.from(container.querySelectorAll<HTMLElement>('.mermaid-slot[data-state="preview"]'));
  for (const slot of Array.from(slots)) {
    const target = slot.querySelector<HTMLElement>('.mermaid-target');
    if (!target) continue;
    bindDiagramActivation(target, () => {
      const svg = target.querySelector('svg');
      return svg?.cloneNode(true) as HTMLElement | null;
    });
  }
}

function bindPumlPopup(container: HTMLElement): void {
  const imgs = container.matches('img.puml-diagram')
    ? [container as HTMLImageElement]
    : Array.from(container.querySelectorAll<HTMLImageElement>('.puml-slot[data-state="preview"] .puml-diagram'));
  for (const img of imgs) {
    bindDiagramActivation(img, () => img.cloneNode(true) as HTMLElement);
  }
}

function bindVectorPopup(container: HTMLElement): void {
  // Every svg-rendered preview (```svg blocks AND ```chart charts) opens the
  // enlarged pan/zoom viewer on double-click; a single click stays a natural
  // selection gesture. The floating 下载图片 button handles exports.
  const targets = container.querySelectorAll<HTMLElement>(
    '.svg-slot[data-state="preview"] .svg-target, .chart-slot[data-state="preview"] .chart-target',
  );
  for (const target of Array.from(targets)) {
    bindDiagramActivation(target, () => {
      const svg = target.querySelector('svg');
      return svg?.cloneNode(true) as HTMLElement | null;
    }, 'dblclick');
  }
}

/**
 * Inline markdown images (```![alt](src)```) get the same enlarged-viewer
 * treatment as diagram slots: double-click (or Enter/Space) opens the image in
 * the pan/zoom viewer. The activation target is the whole `.md-img-wrap`
 * wrapper so a double-click anywhere on the picture — not just the <img>
 * pixel box — opens the viewer.
 */
function bindMdImagePopup(container: HTMLElement): void {
  const wraps = container.matches('.md-img-wrap')
    ? [container]
    : Array.from(container.querySelectorAll<HTMLElement>('.md-img-wrap'));
  for (const wrap of wraps) {
    const img = wrap.querySelector<HTMLImageElement>('.md-img');
    if (!img) continue;
    bindDiagramActivation(wrap, () => img.cloneNode(true) as HTMLElement, 'dblclick');
  }
}

// Tracks the active diagram viewer's cleanup so opening a new viewer releases
// the previous one's window/document listeners (a leak when only `.remove()`
// was called on the old overlay).
let activeViewerCleanup: (() => void) | null = null;

function normalizeViewerDiagramSize(el: HTMLElement): void {
  const svg = el instanceof SVGSVGElement
    ? el
    : el.querySelector<SVGSVGElement>('svg');
  if (!svg) return;

  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const viewBoxWidth = viewBox && viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0 ? viewBox[2] : null;
  const viewBoxHeight = viewBox && viewBox.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3] > 0 ? viewBox[3] : null;
  const width = svg.getAttribute('width')?.trim().toLowerCase() ?? null;
  const height = svg.getAttribute('height')?.trim().toLowerCase() ?? null;
  const numericLength = (value: string | null): number | null => {
    const match = value?.match(/^(\d+(?:\.\d+)?)(?:px)?$/);
    return match ? Number(match[1]) : null;
  };
  const attrWidth = numericLength(width);
  const attrHeight = numericLength(height);
  const canvasWidth = viewBoxWidth ?? attrWidth ?? 800;
  const canvasHeight = viewBoxHeight ?? attrHeight ?? 600;

  // A standalone SVG with width/height="100%" relies on the preview's CSS
  // containing block. Once moved into the fixed viewer that percentage can
  // resolve to zero (or to the wrapper's shrink-to-fit width), leaving a blank
  // overlay. Give percentage/auto dimensions a concrete canvas, while
  // preserving numeric SVG dimensions when no viewBox is available.
  if (!width || width === '100%' || width === 'auto') {
    svg.style.width = `${canvasWidth}px`;
  }
  if (!height || height === '100%' || height === 'auto') {
    svg.style.height = `${canvasHeight}px`;
  }
}

function showDiagramViewer(el: HTMLElement): void {
  // Remove any existing viewer (and never stack a repair-diff on top of it)
  activeRepairDiffCleanup?.();
  activeViewerCleanup?.();
  const existing = document.querySelector('.mermaid-viewer-overlay');
  if (existing) existing.remove();

  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 10;
  const ZOOM_STEP = 0.25;

  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let didDrag = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;
  let fitZoom = 1;

  // ── Overlay ──
  const overlay = document.createElement('div');
  overlay.className = 'mermaid-viewer-overlay';

  // ── SVG wrapper ──
  const svgWrap = document.createElement('div');
  svgWrap.className = 'mermaid-viewer-svg-wrap';
  normalizeViewerDiagramSize(el);
  svgWrap.appendChild(el);
  overlay.appendChild(svgWrap);

  // ── Close button (fixed top-right) ──
  const closeBtn = document.createElement('button');
  closeBtn.className = 'mermaid-viewer-close';
  closeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  closeBtn.title = 'Close (Esc)';
  closeBtn.addEventListener('click', () => cleanup());
  overlay.appendChild(closeBtn);

  // ── Controls bar (fixed bottom-center) ──
  const ctrlBar = document.createElement('div');
  ctrlBar.className = 'mermaid-viewer-controls';

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.className = 'mermaid-viewer-zoom-btn';
  zoomOutBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
  zoomOutBtn.title = 'Zoom out';

  const zoomPct = document.createElement('span');
  zoomPct.className = 'mermaid-viewer-zoom-pct';

  const zoomInBtn = document.createElement('button');
  zoomInBtn.className = 'mermaid-viewer-zoom-btn';
  zoomInBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/></svg>';
  zoomInBtn.title = 'Zoom in';

  const zoomResetBtn = document.createElement('button');
  zoomResetBtn.className = 'mermaid-viewer-zoom-btn';
  zoomResetBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>';
  zoomResetBtn.title = 'Reset zoom';

  ctrlBar.appendChild(zoomOutBtn);
  ctrlBar.appendChild(zoomPct);
  ctrlBar.appendChild(zoomInBtn);
  ctrlBar.appendChild(zoomResetBtn);
  overlay.appendChild(ctrlBar);

  // ── Apply transform ──
  const applyTransform = () => {
    svgWrap.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    zoomPct.textContent = `${Math.round(zoom * 100)}%`;
  };

  // ── Fit to viewport ──
  const fitToViewport = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const elW = el.getBoundingClientRect().width || 800;
    const elH = el.getBoundingClientRect().height || 600;
    const wrapPad = 40; // 20px padding * 2 on svgWrap
    const pad = 80;
    const scaleX = (vw - pad * 2 - wrapPad) / elW;
    const scaleY = (vh - pad * 2 - wrapPad) / elH;
    fitZoom = Math.min(scaleX, scaleY, 2);
    zoom = fitZoom;
    panX = (vw - (elW + wrapPad) * zoom) / 2;
    panY = (vh - (elH + wrapPad) * zoom) / 2;
    applyTransform();
    svgWrap.classList.add('ready');
  };

  // ── Pan handlers ──
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    didDrag = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    overlay.classList.add('grabbing');
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    if (!didDrag && (Math.abs(e.clientX - dragStartX) > 3 || Math.abs(e.clientY - dragStartY) > 3)) {
      didDrag = true;
    }
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
    applyTransform();
  };

  const onMouseUp = () => {
    if (!dragging) return;
    dragging = false;
    overlay.classList.remove('grabbing');
  };

  overlay.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  // ── Zoom handlers ──
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor));
    if (newZoom === zoom) return;
    const ratio = newZoom / zoom;
    panX = cx - (cx - panX) * ratio;
    panY = cy - (cy - panY) * ratio;
    zoom = newZoom;
    applyTransform();
  };

  zoomInBtn.addEventListener('click', () => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    zoomAt(zoom + ZOOM_STEP, cx, cy);
  });

  zoomOutBtn.addEventListener('click', () => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    zoomAt(zoom - ZOOM_STEP, cx, cy);
  });

  zoomResetBtn.addEventListener('click', () => fitToViewport());

  // Double-click to fit
  overlay.addEventListener('dblclick', () => {
    fitToViewport();
  });

  // Ctrl+wheel / pinch zoom at cursor
  overlay.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.deltaY === 0) return;
    zoomAt(zoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), e.clientX, e.clientY);
  }, { passive: false });

  // ── Cleanup ──
  const cleanup = () => {
    overlay.remove();
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKey);
    if (activeViewerCleanup === cleanup) activeViewerCleanup = null;
  };

  // Close on backdrop click (only when not dragging)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !didDrag) cleanup();
    didDrag = false;
  });

  // Close on Escape
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') cleanup();
  };
  document.addEventListener('keydown', onKey);

  activeViewerCleanup = cleanup;
  document.body.appendChild(overlay);

  // Initial fit
  requestAnimationFrame(() => fitToViewport());
}


/**
 * Derive an export filename base for a diagram slot: prefer the chart
 * `title:` line (sanitized to filesystem-safe characters), falling back to a
 * kind-appropriate name (mermaid/chart) on parse failure.
 */
function diagramSourceName(slot: HTMLElement): string {
  const kind = slot.getAttribute('data-diagram-kind');
  const fallback = kind === 'mermaid' ? 'mermaid' : kind === 'svg' ? 'svg' : 'chart';
  let base = fallback;
  try {
    const title = parseChartSource(diagramRawOf(slot)).title.trim();
    if (title) {
      base = title.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 60) || fallback;
    }
  } catch {
    /* non-chart source (e.g. mermaid) — keep the default name */
  }
  return base;
}

/**
 * Serialize a rendered diagram SVG into a self-contained document: xmlns added
 * if missing. Chart SVGs (echarts) and mermaid carry their colors inline, so
 * no extra <style> injection is needed. Supports chart, mermaid, and SVG slots.
 */
function serializeDiagramSvg(slot: HTMLElement): { svg: string; nameBase: string } | null {
  const svg = slot.querySelector<SVGSVGElement>('.chart-target svg, .svg-target svg, .mermaid-target svg');
  if (!svg) return null;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return { svg: new XMLSerializer().serializeToString(clone), nameBase: diagramSourceName(slot) };
}

/**
 * Rasterize a self-contained SVG document to a PNG blob at `scale`× its
 * size, painted over the current theme's card background so the result is
 * readable anywhere (transparent would expose the theme-colored text).
 * Sizing prefers the source SVG's viewBox (mermaid emits width="100%" on the
 * root, which can make img.naturalWidth resolve to 0 in the image context);
 * natural size is the fallback. Returns null when rasterization fails.
 */
function svgToPngBlob(svgText: string, scale = 2): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      // Size from the SVG's own viewBox when present (mermaid emits width="100%"
      // on the root, which can make img.naturalWidth resolve to 0 in the image
      // context); the decoded natural size is the fallback.
      const vb = svgText.match(/viewBox=["']?\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i);
      const w = vb ? Number(vb[1]) : img.naturalWidth;
      const h = vb ? Number(vb[2]) : img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(null); return; }
      ctx.fillStyle = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-card').trim() || (isDark() ? '#1f2430' : '#ffffff');
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      // toBlob can silently never invoke its callback (engine quirk, memory
      // pressure) — a safety timer guarantees the caller's error path runs.
      let settled = false;
      const settle = (blob: Blob | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(blob);
      };
      const timer = setTimeout(() => settle(null), 5000);
      canvas.toBlob((blob) => settle(blob), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/**
 * Save an image blob through the native save dialog (Tauri) or browser
 * download (File System Access / anchor fallback). The Tauri path base64-encodes
 * the bytes for the save_file_binary IPC command (save_file is text-only).
 */
async function saveImageFile(blob: Blob, filename: string, mime: string): Promise<string | null> {
  const ext = mime === 'image/png' ? 'png' : 'svg';
  if (isTauriRuntime()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: filename, filters: [{ name: 'Image', extensions: [ext] }] });
    if (!path) return null; // cancelled
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
    const core = await loadTauriCore();
    if (!core) throw new Error('Tauri core unavailable');
    await core.invoke('save_file_binary', { path, dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) });
    return path;
  }

  // Browser dev mode: File System Access API (Chrome/Edge).
  const w = window as unknown as {
    showSaveFilePicker?: (opts: {
      suggestedName?: string;
      types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<{
      createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }>;
    }>;
  };
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Image', accept: { [mime]: [`.${ext}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return filename;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null; // cancelled
      // Any other failure — fall through to the download fallback.
    }
  }

  // Last-resort download (works everywhere).
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return null;
}

/**
 * Rasterize the rendered diagram (svg / chart / mermaid) and export it as a
 * PNG image (2× scale for crisp output on HiDPI displays).
 *
 * Known limitation: mermaid sequence/class diagrams render some labels inside
 * <foreignObject>, which browsers refuse to paint when an SVG is loaded as an
 * <img> — those labels drop out of the PNG.
 */
async function exportDiagramPng(slot: HTMLElement): Promise<void> {
  const out = serializeDiagramSvg(slot);
  if (!out) {
    showToast(t('diagram.downloadError'));
    return;
  }
  try {
    const blob = await svgToPngBlob(out.svg, 2);
    if (!blob) {
      showToast(t('diagram.downloadError'));
      return;
    }
    const savedTo = await saveImageFile(blob, `${out.nameBase}.png`, 'image/png');
    if (savedTo) showToast(`${t('codeBlock.savedTo')} ${savedTo}`);
  } catch {
    showToast(t('diagram.downloadError'));
  }
}

/**
 * Export a PlantUML diagram (rendered from the external plantuml.com URL) as
 * a PNG image. The server sends CORS headers, so we fetch the SVG it rendered
 * and rasterize it like local diagrams; if the fetch ever fails (offline,
 * CORS change), fall back to downloading the raw SVG file directly.
 */
async function downloadPumlImage(slot: HTMLElement): Promise<void> {
  const img = slot.querySelector<HTMLImageElement>('.puml-diagram');
  if (!img?.src) {
    showToast(t('diagram.downloadError'));
    return;
  }
  const stamp = Date.now();
  try {
    const resp = await fetch(img.src, { mode: 'cors' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const svgText = await resp.text();
    if (!/<svg[\s>]/i.test(svgText)) throw new Error('not an SVG response');
    const blob = await svgToPngBlob(svgText, 2);
    if (!blob) throw new Error('rasterization failed');
    const savedTo = await saveImageFile(blob, `diagram-${stamp}.png`, 'image/png');
    if (savedTo) showToast(`${t('codeBlock.savedTo')} ${savedTo}`);
  } catch {
    // CORS/offline: fall back to downloading the raw SVG the server rendered.
    const a = document.createElement('a');
    a.href = img.src;
    a.download = `diagram-${stamp}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

// ── Code block actions (copy + save) ──

// hljs language token → default file extension for the save button. hljs emits
// its CANONICAL names in code classes (language-typescript, language-python,
// …) — short aliases (ts/py/…) are kept for robustness.
const EXT_BY_LANG: Record<string, string> = {
  // canonical hljs names
  typescript: 'ts', tsx: 'tsx', javascript: 'js', jsx: 'jsx',
  python: 'py', rust: 'rs', go: 'go', golang: 'go',
  java: 'java', kotlin: 'kt', scala: 'scala', swift: 'swift',
  c: 'c', cpp: 'cpp', cplusplus: 'cpp', cc: 'cpp', csharp: 'cs',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  html: 'html', htm: 'html', xml: 'xml', svg: 'svg',
  json: 'json', jsonc: 'json',
  sql: 'sql',
  yaml: 'yml', toml: 'toml', ini: 'ini',
  markdown: 'md',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  powershell: 'ps1',
  ruby: 'rb', php: 'php', lua: 'lua', perl: 'pl',
  makefile: 'mk', dockerfile: '',
  diff: 'diff', patch: 'patch', text: 'txt', plaintext: 'txt', csv: 'csv',
  graphql: 'graphql', svelte: 'svelte', vue: 'vue', nginx: 'conf', apache: 'conf',
  // short aliases
  ts: 'ts', js: 'js', mjs: 'js', cjs: 'js', py: 'py', rs: 'rs',
  yml: 'yml', md: 'md', sh: 'sh', cs: 'cs', rb: 'rb',
};

function extForLang(lang: string): string {
  if (!lang) return 'txt';
  return EXT_BY_LANG[lang] ?? 'txt';
}

function codeLangOf(pre: HTMLElement): string {
  const cls = pre.querySelector('code')?.className ?? '';
  const m = cls.match(/(?:^|\s)language-([\w-]+)/);
  return (m?.[1] ?? '').toLowerCase();
}

/**
 * Derive a sensible default filename for the save dialog. An explicit
 * `// file: name.ts` / `# filename: x.py` / `<!-- file: a.html -->` comment
 * wins; otherwise a language-appropriate name (`code.ts`, `script.sh` for
 * shebangs, `Dockerfile`/`Makefile` for those languages).
 */
export function suggestFilename(text: string, lang: string): string {
  const hint = text.match(
    /(?:^|\n)\s*(?:\/\/|#|--|;|<!--|\/\*)\s*(?:file|filename)\s*[:=]\s*([\w.\-]+\.[\w]+)/i,
  );
  if (hint) {
    const name = hint[1].split('/').pop()!.split('\\').pop()!;
    return name;
  }
  if (lang === 'dockerfile') return 'Dockerfile';
  if (lang === 'makefile') return 'Makefile';
  if (text.trimStart().startsWith('#!')) return 'script.sh';
  return `code.${extForLang(lang)}`;
}

/**
 * Save a code block to disk. In Tauri: native save dialog (plugin-dialog) +
 * the dedicated `save_file` invoke (absolute, user-chosen path). In browser
 * dev: the File System Access API when available, else a download anchor.
 * Returns the path saved to, or null when the user cancelled the dialog.
 */
async function saveCodeBlock(text: string, filename: string, lang: string): Promise<string | null> {
  if (isTauriRuntime()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const ext = extForLang(lang);
    // Omit the filter entirely when there's no extension (e.g. Dockerfile) —
    // a filter with an empty extensions array can misbehave on native dialogs.
    const filters = ext ? [{ name: 'Code', extensions: [ext] }] : undefined;
    const path = await save({ defaultPath: filename, filters });
    if (!path) return null; // cancelled
    const core = await loadTauriCore();
    if (!core) throw new Error('Tauri core unavailable');
    await core.invoke('save_file', { path, content: text });
    return path;
  }

  // Browser dev mode: File System Access API (Chrome/Edge).
  const w = window as unknown as {
    showSaveFilePicker?: (opts: {
      suggestedName?: string;
      types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<{
      createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }>;
    }>;
  };
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Code', accept: { 'text/plain': ['.txt', `.${extForLang(lang)}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return filename;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null; // cancelled
      // Any other failure — fall through to the download fallback.
    }
  }

  // Last-resort download (works everywhere).
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return null;
}

function addCodeBlockActions(container: HTMLElement): void {
  const pres = container.querySelectorAll<HTMLElement>('pre');
  for (const pre of Array.from(pres)) {
    // Skip diagram/chart source pres — they have their own slot lifecycle
    // (mermaid/svg/chart); the rendered diagram is what the user interacts with.
    if (pre.classList.contains('mermaid-source')) continue;
    if (pre.classList.contains('svg-source')) continue;
    if (pre.classList.contains('chart-source')) continue;
    if (pre.classList.contains('diagram-source')) continue;
    if (pre.querySelector('.code-copy-btn')) continue;

    const code = pre.querySelector('code');
    const copyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const saveIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';
    const checkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';

    // Copy button (existing behavior).
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-copy-btn';
    copyBtn.innerHTML = copyIcon;
    copyBtn.title = t('codeBlock.copy');
    copyBtn.addEventListener('click', async () => {
      const text = code?.textContent ?? pre.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.innerHTML = checkIcon;
        copyBtn.title = t('codeBlock.copied');
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.innerHTML = copyIcon;
          copyBtn.title = t('codeBlock.copy');
          copyBtn.classList.remove('copied');
        }, 1800);
      } catch {
        copyBtn.title = t('codeBlock.copyError');
        setTimeout(() => {
          copyBtn.innerHTML = copyIcon;
          copyBtn.title = t('codeBlock.copy');
        }, 1200);
      }
    });
    pre.appendChild(copyBtn);

    // Save button (new): pick a directory/location and write the code block.
    const saveBtn = document.createElement('button');
    saveBtn.className = 'code-save-btn';
    saveBtn.innerHTML = saveIcon;
    saveBtn.title = t('codeBlock.save');
    saveBtn.addEventListener('click', async () => {
      const text = code?.textContent ?? pre.textContent ?? '';
      const lang = codeLangOf(pre);
      const filename = suggestFilename(text, lang);
      try {
        const savedTo = await saveCodeBlock(text, filename, lang);
        if (!savedTo) return; // dialog cancelled — leave the button as-is
        saveBtn.innerHTML = checkIcon;
        saveBtn.title = t('codeBlock.saved');
        saveBtn.classList.add('saved');
        setTimeout(() => {
          saveBtn.innerHTML = saveIcon;
          saveBtn.title = t('codeBlock.save');
          saveBtn.classList.remove('saved');
        }, 1800);
        showToast(`${t('codeBlock.savedTo')} ${savedTo}`);
      } catch {
        saveBtn.title = t('codeBlock.saveError');
        setTimeout(() => {
          saveBtn.innerHTML = saveIcon;
          saveBtn.title = t('codeBlock.save');
        }, 1500);
      }
    });
    pre.appendChild(saveBtn);
  }
}
