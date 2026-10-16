// src/ui/__tests__/canvasArtCard.test.ts
// Inline canvas-art card: candidate picking (html-only, design-mockup
// exclusion, cap, dedupe) and the sandboxed-iframe DOM shape.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createCanvasArtCard, isCanvasHtml, pickCanvasCandidates } from '../canvasArtCard';

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('isCanvasHtml', () => {
  it('detects the canvas tag in any casing and attribute form', () => {
    expect(isCanvasHtml('<html><body><canvas></canvas></body></html>')).toBe(true);
    expect(isCanvasHtml('<CANVAS width="300" height="150"></CANVAS>')).toBe(true);
    expect(isCanvasHtml('<canvas id="c"/>')).toBe(true);
  });

  it('rejects non-canvas html, svg graphics, and empty content', () => {
    expect(isCanvasHtml('<html><body><h1>hi</h1></body></html>')).toBe(false);
    expect(isCanvasHtml('<svg viewBox="0 0 10 10"><circle r="5"/></svg>')).toBe(false);
    expect(isCanvasHtml('')).toBe(false);
    // Not a real canvas tag: `<canvasx>` must not match `<canvas[\s>]`.
    expect(isCanvasHtml('<canvasx></canvasx>')).toBe(false);
  });
});

describe('pickCanvasCandidates', () => {
  it('keeps only .html/.htm, first-seen order, deduped', () => {
    const picked = pickCanvasCandidates([
      'a.png',
      'page.html',
      'page.html',
      './page.html',
      'deep/nested/page.htm',
      'notes.md',
    ]);
    expect(picked).toEqual(['page.html', 'deep/nested/page.htm']);
  });

  it('excludes the design mockup and caps the result', () => {
    const picked = pickCanvasCandidates(
      ['design.html', 'one.html', 'two.html', 'three.html'],
      { exclude: 'design.html', limit: 2 },
    );
    expect(picked).toEqual(['one.html', 'two.html']);
  });

  it('matches the exclusion across path spellings', () => {
    const picked = pickCanvasCandidates(['./design.html', 'real.html'], {
      exclude: 'design.html',
    });
    expect(picked).toEqual(['real.html']);
  });
});

describe('createCanvasArtCard', () => {
  it('renders a sandboxed iframe with the html inline plus an open action', () => {
    const html = '<html><body><canvas id="c"></canvas><script>const c=document.getElementById("c")</script></body></html>';
    const card = createCanvasArtCard(html, 'bounce.html', '/tmp/ws');
    document.body.appendChild(card.el);

    expect(card.el.className).toBe('bubble-row canvas-art-row');

    const frame = card.el.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame!.getAttribute('srcdoc')).toContain('<canvas id="c">');

    const title = card.el.querySelector('.canvas-art-title');
    expect(title?.textContent).toContain('Canvas 绘画');
    const file = card.el.querySelector('.canvas-art-file');
    expect(file?.textContent).toBe('bounce.html');

    const open = card.el.querySelector<HTMLButtonElement>('.canvas-art-open');
    expect(open?.textContent).toContain('在新窗口打开');
    // Non-Tauri runtime (happy-dom) degrades openPathLink to a clipboard
    // copy; the click must resolve without throwing.
    expect(() => open?.click()).not.toThrow();
  });
});
