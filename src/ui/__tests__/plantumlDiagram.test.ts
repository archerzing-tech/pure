// src/ui/__tests__/plantumlDiagram.test.ts
// PlantUML renders LOCALLY — no plantuml.com, no network. These tests are the
// proof: the real engine (@plantuml/core, TeaVM) runs against a happy-dom
// document with the Graphviz layout loaded as a classic script, exactly like
// the browser does it, and the SVG comes back out.
//
// normalizePlantumlSource is pure and covered first; the render tests then
// exercise the engine end to end (they are the only slow tests in this file —
// engine start-up is a one-time cost per process).

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { normalizePlantumlSource, renderPlantumlToSvg } from '../plantumlDiagram';

const RENDER_TIMEOUT_MS = 60_000;

beforeAll(() => {
  // A real page URL matters: Emscripten-based engine bundles resolve their own
  // asset paths against location.href, and "about:blank" is not a valid base.
  GlobalRegistrator.register({ url: 'http://localhost:1420/' });
  // Load viz-global.js as a classic script into the global scope — the same
  // contract the app satisfies with a <script src="/plantuml/viz-global.js">.
  // It publishes globalThis.Viz, which is also how the module knows the layout
  // engine is already available.
  // happy-dom ships no canvas 2D context, and the engine measures every label
  // with one before laying a diagram out. The stub only has to answer
  // measureText — glyph widths move pixels around, they do not decide whether
  // an SVG comes back. (A real WebView uses the real canvas.)
  const canvasPrototype = window.HTMLCanvasElement.prototype as unknown as {
    getContext(id: string): unknown;
  };
  canvasPrototype.getContext = () => ({
    font: '',
    measureText: (text: string) => ({
      width: text.length * 7,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    }),
  });

  const host = globalThis as typeof globalThis & { Viz?: { instance?: unknown } };
  if (!host.Viz || typeof host.Viz.instance !== 'function') {
    const source = readFileSync(
      new URL('../../../node_modules/@plantuml/core/viz-global.js', import.meta.url),
      'utf8',
    );
    new Function(source)();
  }
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('normalizePlantumlSource', () => {
  it('wraps a bare body — models routinely answer without @startuml', () => {
    expect(normalizePlantumlSource('Alice -> Bob: hi')).toEqual([
      '@startuml',
      'Alice -> Bob: hi',
      '@enduml',
    ]);
  });

  it('closes an unterminated diagram with the matching @end tag', () => {
    expect(normalizePlantumlSource('@startmindmap\n* root')).toEqual([
      '@startmindmap',
      '* root',
      '@endmindmap',
    ]);
  });

  it('drops prose before @startuml and anything after @enduml', () => {
    const source = 'Here is the diagram:\n@startuml\nA -> B\n@enduml\nHope that helps!';
    expect(normalizePlantumlSource(source)).toEqual(['@startuml', 'A -> B', '@enduml']);
  });

  it('strips CRLF, a BOM and nested fence lines', () => {
    const source = '\uFEFF```puml\r\n@startuml\r\nA -> B\r\n@enduml\r\n```';
    expect(normalizePlantumlSource(source)).toEqual(['@startuml', 'A -> B', '@enduml']);
  });

  it('returns nothing for an empty block', () => {
    expect(normalizePlantumlSource('\n   \n')).toEqual([]);
  });
});

describe('offline PlantUML rendering', () => {
  it('renders a sequence diagram with no network access', async () => {
    const svg = await renderPlantumlToSvg('@startuml\nAlice -> Bob: hello\n@enduml');
    expect(svg).toContain('<svg');
    expect(svg).toContain('Alice');
    expect(svg).toContain('Bob');
  }, RENDER_TIMEOUT_MS);

  it('renders a class diagram through the bundled Graphviz layout', async () => {
    // Only the local Graphviz engine can lay this out, so a rendered picture
    // also proves viz-global.js was picked up from the app, not a CDN.
    const svg = await renderPlantumlToSvg(
      '@startuml\nclass Engine {\n  +render()\n}\nclass Viewer\nEngine --> Viewer: svg\n@enduml',
    );
    expect(svg).toContain('<svg');
    expect(svg).toContain('Engine');
    expect(svg).toContain('Viewer');
  }, RENDER_TIMEOUT_MS);

  it('rejects an empty source instead of rendering a blank card', () => {
    expect(renderPlantumlToSvg('   ')).rejects.toThrow();
  });
});
