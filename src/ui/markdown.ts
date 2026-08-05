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

// ── Custom renderer: route mermaid / puml code blocks away from hljs ──

const renderer = new Renderer();

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
    return `<img class="puml-diagram" src="${attr(url)}" alt="PlantUML diagram" data-raw="${attr(encodeRawAttr(code))}" loading="lazy" referrerpolicy="no-referrer" />`;
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

/**
 * Recover a slot's mermaid source. Prefer the `.mermaid-source code` text:
 * DOMPurify (SAFE_FOR_XML defaults on in v3.4.12) strips data-* attribute
 * VALUES containing `-->` / `<!--` / `]>` (its comment-marker mXSS defense) —
 * and mermaid edge syntax is literally `A-->B` — so `data-md-raw` cannot be
 * trusted as a source store once sanitize() has run. The source also lives as
 * element text, which sanitize never removes.
 */
function mermaidRawOf(slot: HTMLElement): string {
  const src = slot.querySelector<HTMLElement>('.mermaid-source code');
  return src?.textContent ?? slot.getAttribute('data-md-raw') ?? '';
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
    const raw = mermaidRawOf(slot);
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
        const stored = img.getAttribute('data-raw') ?? '';
        let raw = stored;
        try { raw = decodeURIComponent(stored); } catch { /* stored already raw */ }
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
 * Strip Claude-Code-style XML tool-call blocks out of assistant text for
 * DISPLAY only. Some models leak tool calls as literal text (`<tool_calls>`
 * / `<invoke name=...>`); the engine already parses real function calls, so
 * these blocks are never executed — hide them from the rendered bubble.
 * Handles both complete and stream-cut (unclosed) blocks.
 */
export function stripToolCallXml(text: string): string {
  // Fast path: the vast majority of streams never leak tool-call XML, and this
  // runs on every TokenDelta over the full accumulated text — skipping the
  // regex passes entirely keeps long streams O(n) instead of O(n²).
  //
  // NB: deliberately NO trim() here — during streaming the accumulator is a
  // live growing prefix whose trailing whitespace is a work-in-progress
  // boundary (e.g. between two code blocks); trimming it every token would
  // strip the leading indent of the next block mid-stream, causing flicker.
  // Trailing whitespace is handled once by renderMarkdown's trailing-newline
  // cleanup at completion.
  if (!/<tool_calls|<invoke\b|<parameter\b/i.test(text)) return text;
  // Remove complete <tool_calls>…</tool_calls> blocks — but only when the
  // block actually contains tool-call-shaped content (<invoke> or <parameter>),
  // so a fenced code example or prose mention of the tag is not deleted.
  let out = text.replace(/<tool_calls>([\s\S]*?)<\/tool_calls>/gi, (m, inner: string) => {
    const body = inner.toLowerCase();
    return /<invoke\b|<parameter\b/.test(body) ? '' : m;
  });
  // Stream-cut handling: a block can be cut mid-stream by throttling or
  // completion, leaving an unclosed <tool_calls> marker. Only truncate when
  // the marker is followed by tool-call-shaped content within a short window —
  // a lone prose mention (e.g. "never use <tool_calls> in your reply") must
  // not nuke the rest of the message.
  const lower = out.toLowerCase();
  // Use the LAST marker: any block after a closed one that still has an open
  // <tool_calls> is the stream-cut one (earlier complete blocks were already
  // removed or deliberately kept above), so truncating from the last marker
  // preserves kept complete blocks while still hiding the cut leak.
  const open = lower.lastIndexOf('<tool_calls>');
  if (open !== -1) {
    const afterOpen = lower.slice(open + '<tool_calls>'.length);
    const hasClose = afterOpen.indexOf('</tool_calls>') !== -1;
    if (!hasClose && /<invoke\b|<parameter\b/.test(afterOpen.slice(0, 500))) {
      out = out.slice(0, open);
    }
  }
  // Remove standalone <invoke …>…</invoke> invocations outside a wrapper.
  out = out.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, '');
  return out.trim();
}

/**
 * Parse `text` as Markdown and render into `container` with syntax highlighting
 * (hljs), inline mermaid diagrams, and inline `<img>` PlantUML diagrams.
 */
export async function renderMarkdown(text: string, container: HTMLElement): Promise<void> {
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

  // 3) Async: mermaid renders embed SVG into .mermaid-diagram nodes.
  await renderMermaidNodes(container);

  // 4) PlantUML <img>: offline/encoding error fallback (delegated to the renderer).
  bindPumlFallbacks(container);

  // 5) Bind double-click popup on mermaid and PlantUML diagrams.
  bindMermaidPopup(container);
  bindPumlPopup(container);

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
function diffStreaming(container: HTMLElement, text: string): void {
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
    const all = Array.from(document.querySelectorAll<HTMLElement>('.mermaid-slot'));
    if (all.length === 0) return;
    for (const slot of all) {
      const target = slot.querySelector<HTMLElement>('.mermaid-target');
      const raw = mermaidRawOf(slot);
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
    // Skip mermaid-source pres — they already have their own lifecycle
    if (pre.classList.contains('mermaid-source')) continue;
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
