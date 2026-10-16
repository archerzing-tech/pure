// src/ui/canvasArtCard.ts
// Inline canvas-art preview: when the model delivers an .html file that draws
// on <canvas> (animation / generative art / a small game), the GUI renders it
// directly in the conversation inside a sandboxed iframe — the same
// srcdoc + sandbox="allow-scripts" (no allow-same-origin) pattern the design
// preview card shipped, so scripts run but the frame gets no origin, storage
// or same-origin DOM access. The file card below still points at the path;
// this card is the "see it now" surface.

import { openPathLink } from './pathLink';

/** True when html actually draws via <canvas> (tag open, any casing). */
export function isCanvasHtml(html: string): boolean {
  return /<canvas[\s>]/i.test(html);
}

/**
 * Pick the turn's written files that deserve an inline canvas card:
 * .html/.htm only, the design mockup excluded (the design-preview card
 * already renders it — two iframes for one file reads as a glitch), deduped
 * in first-seen order, capped (default 2) so a scaffold run with many pages
 * does not flood the transcript with frames.
 */
export function pickCanvasCandidates(
  paths: string[],
  opts: { exclude?: string; limit?: number } = {},
): string[] {
  const limit = opts.limit ?? 2;
  const normalize = (p: string): string =>
    p.trim().toLowerCase().replaceAll('\\', '/').replace(/^\.\//, '');
  const exclude = opts.exclude ? normalize(opts.exclude) : null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const norm = normalize(path);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (!norm.endsWith('.html') && !norm.endsWith('.htm')) continue;
    if (exclude !== null && norm === exclude) continue;
    out.push(path);
    if (out.length >= limit) break;
  }
  return out;
}

export interface CanvasArtCardHandle {
  el: HTMLElement;
}

export function createCanvasArtCard(
  html: string,
  fileName: string,
  workspace?: string,
): CanvasArtCardHandle {
  const el = document.createElement('div');
  el.className = 'bubble-row canvas-art-row';

  const card = document.createElement('div');
  card.className = 'canvas-art-card';

  const head = document.createElement('div');
  head.className = 'canvas-art-head';
  const title = document.createElement('span');
  title.className = 'canvas-art-title';
  title.textContent = '🖼️ Canvas 绘画';
  const file = document.createElement('span');
  file.className = 'canvas-art-file';
  file.textContent = fileName;
  head.append(title, file);

  const frame = document.createElement('iframe');
  frame.className = 'canvas-art-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', `Canvas 绘画：${fileName}`);
  frame.srcdoc = html;

  const actions = document.createElement('div');
  actions.className = 'canvas-art-actions';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'canvas-art-open';
  open.textContent = '↗ 在新窗口打开';
  open.addEventListener('click', () => {
    openPathLink(fileName, workspace);
  });
  actions.appendChild(open);

  card.append(head, frame, actions);
  el.appendChild(card);

  return { el };
}
