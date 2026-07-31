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
import hljs from 'highlight.js/lib/core';
import 'highlight.js/styles/atom-one-light.css';
// plantuml-encoder types come from src/shared/plantuml-encoder.d.ts.
import plantumlEncoder from 'plantuml-encoder';

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

// Returns the lang token of a fenced code info-string (e.g. "ts foo bar" → "ts").
function langOf(infostring: string | undefined): string {
  return ((infostring ?? '').trim().split(/\s+/)[0] ?? '').toLowerCase();
}

function isDark(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

// ── Custom renderer: route mermaid / puml code blocks away from hljs ──

const renderer = new Renderer();

// marked 18.x: renderer methods receive a single token object — we destructure.
// marked 18.x: renderer methods receive a single token object — we destructure.
renderer.code = (token: { text: string; lang?: string }): string => {
  const code: string = token.text;
  const lang: string = langOf(token.lang);

  if (lang === 'mermaid') {
    // Same outer slot structure as the streaming-mode renderer so diffStreaming
    // can leave the node alone when the raw source is unchanged (cheap reuse).
    // data-state starts as "pending"; renderMermaidNodes flips to "arrived"
    // after a successful mermaid.render() — that's the CSS cross-fade trigger.
    return `<div class="mermaid-slot" data-md-raw="${attr(code)}" data-state="pending">` +
           `<pre class="mermaid-source"><code class="hljs language-mermaid">${esc(code)}</code></pre>` +
           `<div class="mermaid-target"></div>` +
           `</div>`;
  }

  if (lang === 'puml' || lang === 'plantuml') {
    const url = plantumlUrl(code);
    // Keep generic alt text — the full source goes in data-raw so the
    // error-fallback path can render it without leaking to screen-readers or
    // search bots via the <img alt> attribute.
    return `<img class="puml-diagram" src="${attr(url)}" alt="PlantUML diagram" data-raw="${attr(code)}" loading="lazy" referrerpolicy="no-referrer" />`;
  }

  // Other code blocks: emit <pre><code>; hljs tags inside after parse.
  return `<pre><code${lang ? ` class="language-${attr(lang)}"` : ''}>${code}</code></pre>`;
};

const md = new Marked({ gfm: true, breaks: true, renderer });

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

async function renderMermaidNodes(container: HTMLElement): Promise<void> {
  // Render into `.mermaid-target` (the absolute-positioned child of `.mermaid-slot`).
  // data-state toggling here is the trigger for the CSS source→svg cross-fade:
  // when mermaid.render() returns successfully we flip state from "pending" → "arrived".
  const slots = container.querySelectorAll<HTMLElement>('.mermaid-slot:not([data-processed])');
  if (slots.length === 0) return;

  let mermaid: MermaidAPI;
  try {
    mermaid = await ensureMermaid();
  } catch (err) {
    for (const slot of Array.from(slots)) {
      const target = slot.querySelector<HTMLElement>('.mermaid-target');
      if (target) target.innerHTML = `<pre class="mermaid-error">${esc(String(err))}</pre>`;
      slot.setAttribute('data-processed', 'true');
      slot.setAttribute('data-state', 'arrived');
    }
    return;
  }

  for (const slot of Array.from(slots)) {
    const target = slot.querySelector<HTMLElement>('.mermaid-target');
    if (!target) {
      slot.setAttribute('data-processed', 'true');
      continue;
    }
    const raw = slot.getAttribute('data-md-raw') ?? '';
    slot.setAttribute('data-processed', 'true');
    // Hold source visible until the SVG has actually arrived in target.innerHTML;
    // an optical glitch-free handoff requires source to fade out AS target fades in.
    slot.setAttribute('data-state', 'pending');
    try {
      const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
      const { svg } = await mermaid.render(id, raw);
      target.innerHTML = svg;
      slot.setAttribute('data-state', 'arrived');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      target.innerHTML = `<pre class="mermaid-error"><code>${attr(msg)}</code>\n\n${esc(raw)}</pre>`;
      slot.setAttribute('data-state', 'arrived');
    }
  }
}

// ── PlantUML: bind error fallbacks for offline / encoding errors ──

function bindPumlFallbacks(container: HTMLElement): void {
  for (const img of Array.from(container.querySelectorAll<HTMLImageElement>('.puml-diagram'))) {
    img.addEventListener(
      'error',
      () => {
        // Use data-raw (the encoded source) rather than img.alt to avoid stuffing
        // the diagram syntax into a fallback that may be itself selected/copied.
        const raw = img.getAttribute('data-raw') ?? '';
        img.outerHTML = `<pre class="puml-fallback"><code>${esc(raw)}</code></pre>`;
      },
      { once: true },
    );
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
export async function renderMarkdown(text: string, container: HTMLElement): Promise<void> {
  // 1) Parse to HTML synchronously (renders fenced-code overrides inline).
  // marked always appends a trailing \n; trim it — with white-space:pre-wrap on
  // the bubble, that trailing newline would render as a visible blank line.
  const html = (md.parse(text, { async: false }) as string).replace(/\n+$/, '');
  container.innerHTML = html;

  // 2) Synchronous: hljs over all code blocks (idempotent).
  highlightAll(container);

  // 3) Async: mermaid renders embed SVG into .mermaid-diagram nodes.
  await renderMermaidNodes(container);

  // 4) PlantUML <img>: offline/encoding error fallback (delegated to the renderer).
  bindPumlFallbacks(container);

  // 5) Bind double-click popup on mermaid and PlantUML diagrams.
  bindMermaidPopup(container);
  bindPumlPopup(container);

  // 6) Add copy buttons to code blocks.
  addCodeCopyButtons(container);
}

// ═══════════════════════════════════════════════════════════════════════
// Streaming-time renderer
// ═══════════════════════════════════════════════════════════════════════
//
// During token-by-token streaming, half-finished ```mermaid ... ``` blocks
// would crash mermaid.render() mid-stream and cause flicker on every tick.
// To avoid both problems we run a SEPARATE renderer during streaming that
// emits *all* fenced code blocks as <pre><code class="hljs language-X">…</code></pre>
// (no .mermaid-diagram divs, no <img class="puml-diagram">). Code blocks still
// form progressively via hljs — the user sees characters colorize as tokens
// arrive. Mermaid / PlantUML only get their final diagrams on the Completed
// event when renderMarkdown() runs the full pipeline with no flickering
// intermediate state.

const STREAM_THROTTLE_MS = 100;

const streamRenderer = new Renderer();
streamRenderer.code = (token: { text: string; lang?: string }): string => {
  const lang = (token.lang ?? '').toLowerCase();
  if (lang === 'mermaid') {
    // Mermaid blocks render as a `.mermaid-slot` with two stacked children:
    //   • <pre.mermaid-source> shows the source during the stream
    //   • <div.mermaid-target> is the placeholder for the rendered SVG
    // When `data-state` flips to "arrived" (set by renderMermaidNodes), CSS
    // cross-fades source→target so the user sees the source shrink into the
    // diagram on Completed. The slot's outer height is preserved by keeping
    // `source` in normal flow until `target` becomes the visible element.
    return `<div class="mermaid-slot" data-md-raw="${attr(token.text)}" data-state="pending">` +
           `<pre class="mermaid-source"><code class="hljs language-mermaid">${esc(token.text)}</code></pre>` +
           `<div class="mermaid-target"></div>` +
           `</div>`;
  }
  return `<pre><code class="hljs language-${attr(lang)}">${esc(token.text)}</code></pre>`;
};
const mdStream = new Marked({ gfm: true, breaks: true, renderer: streamRenderer });

interface StreamState {
  timer: number | undefined;
  lastRenderedText: string;
}

const streamStates = new WeakMap<HTMLElement, StreamState>();

function streamStateFor(container: HTMLElement): StreamState {
  let s = streamStates.get(container);
  if (!s) {
    s = { timer: undefined, lastRenderedText: '' };
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
function diffStreaming(container: HTMLElement, text: string): void {
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

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const oldEl = container.children[i] as HTMLElement | undefined;

    // Same source slice ⇒ child is already the canonical rendering for this
    // token. Skip entirely.
    if (oldEl && oldEl.getAttribute('data-md-raw') === tk.raw) continue;

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
  }

  // Trim trailing old children if the new token list is shorter (rare during
  // stream — usually only happens if the LLM deletes content via stop tokens).
  while (container.children.length > tokens.length) {
   container.removeChild(container.lastElementChild!);
  }
}

/**
 * Render a single top-level block token by delegating to the streaming-mode
 * marker's method for that token type. Wraps the marker call in a try/catch
 * because some token types in marked 18 throw when invoked out of document
 * context — we fall back to a generic <p>{raw}</p> in that case.
 */
function renderBlockToken(token: { type: string; raw: string; [k: string]: unknown }): string {
  const fn = (streamRenderer as unknown as Record<string, (t: unknown) => string>)[token.type];
  if (typeof fn === 'function') {
    try {
      const out = fn(token);
      if (out) return out;
    } catch { /* fall through */ }
  }
  // Fallback: render the raw text as a non-styled paragraph. Some token types
  // emit whitespace-only artifacts that don't carry visible content.
  if (!token.raw.trim()) return '';
  return `<p>${esc(String(token.raw))}</p>`;
}

/**
 * Throttled renderer for in-progress assistant messages. Call on every
 * TokenDelta — the function schedules itself to run at most once per 100ms.
 * Internals re-render only the top-level DOM blocks whose source changed,
 * leaving closed/complete blocks (e.g. already-closed ```fenced code```)
 * frozen — no re-parse, no hljs re-tag, no DOM thrash.
 */
export function scheduleStreamingRender(text: string, container: HTMLElement): void {
  const state = streamStateFor(container);
  if (state.timer != null) clearTimeout(state.timer);
  state.timer = window.setTimeout(() => {
    state.timer = undefined;
    if (state.lastRenderedText === text) {
      // Diagnostic: text unchanged since last render. Useful when triaging
      // throttler behavior in the WebView console (DevTools / `tauri dev`).
      if (typeof console !== 'undefined') {
        console.debug(`[markdown-ts] streaming cache hit len=${text.length}`);
      }
      return;
    }
    diffStreaming(container, text);
    state.lastRenderedText = text;
    if (typeof console !== 'undefined') {
      console.debug(`[markdown-ts] streaming diff len=${text.length}`);
    }
  }, STREAM_THROTTLE_MS);
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
  // no-op on the now-finalized bubble.
  state.lastRenderedText = '';
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
    const all = Array.from(document.querySelectorAll<HTMLElement>('.mermaid-slot'));
    if (all.length === 0) return;
    for (const slot of all) {
      const target = slot.querySelector<HTMLElement>('.mermaid-target');
      const raw = slot.getAttribute('data-md-raw') ?? '';
      slot.removeAttribute('data-processed');
      if (target) target.innerHTML = '';
      slot.setAttribute('data-state', 'pending');
    }
    await renderMermaidNodes(document.body);
    bindMermaidPopup(document.body);
    bindPumlPopup(document.body);
  });
}

// ── Diagram double-click popup (Mermaid + PlantUML) ──

function bindMermaidPopup(container: HTMLElement): void {
  const slots = container.querySelectorAll<HTMLElement>('.mermaid-slot[data-state="arrived"]');
  for (const slot of Array.from(slots)) {
    const target = slot.querySelector<HTMLElement>('.mermaid-target');
    if (!target || target.hasAttribute('data-popup-bound')) continue;
    target.setAttribute('data-popup-bound', 'true');
    target.addEventListener('dblclick', () => {
      const svg = target.querySelector('svg');
      if (!svg) return;
      showDiagramViewer(svg.cloneNode(true) as HTMLElement);
    });
  }
}

function bindPumlPopup(container: HTMLElement): void {
  const imgs = container.querySelectorAll<HTMLImageElement>('.puml-diagram');
  for (const img of Array.from(imgs)) {
    if (img.hasAttribute('data-popup-bound')) continue;
    img.setAttribute('data-popup-bound', 'true');
    img.addEventListener('dblclick', () => {
      showDiagramViewer(img.cloneNode(true) as HTMLElement);
    });
  }
}

function showDiagramViewer(el: HTMLElement): void {
  // Remove any existing viewer
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
  overlay.addEventListener('dblclick', () => fitToViewport());

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

  document.body.appendChild(overlay);

  // Initial fit
  requestAnimationFrame(() => fitToViewport());
}

// ── Code copy buttons ──

function addCodeCopyButtons(container: HTMLElement): void {
  const pres = container.querySelectorAll<HTMLElement>('pre');
  for (const pre of Array.from(pres)) {
    // Skip mermaid-source pres — they already have their own lifecycle
    if (pre.classList.contains('mermaid-source')) continue;
    if (pre.querySelector('.code-copy-btn')) continue;

    const copyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const checkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';

    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.innerHTML = copyIcon;
    btn.title = 'Copy';
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code');
      const text = code?.textContent ?? pre.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        btn.innerHTML = checkIcon;
        btn.title = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = copyIcon;
          btn.title = 'Copy';
          btn.classList.remove('copied');
        }, 1800);
      } catch {
        btn.title = 'Error';
        setTimeout(() => {
          btn.innerHTML = copyIcon;
          btn.title = 'Copy';
        }, 1200);
      }
    });
    pre.appendChild(btn);
  }
}
