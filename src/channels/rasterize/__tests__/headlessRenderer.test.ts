import { describe, it, expect } from 'bun:test';
import { createDefaultRichRenderers, normalizePlantumlSource } from '../headlessRenderer';

describe('normalizePlantumlSource', () => {
  it('wraps a bare body in @startuml/@enduml', () => {
    expect(normalizePlantumlSource('A -> B')).toEqual(['@startuml', 'A -> B', '@enduml']);
  });

  it('keeps well-formed source and only trims blank edges', () => {
    expect(normalizePlantumlSource('\n@startuml\nA -> B\n@enduml\n')).toEqual(['@startuml', 'A -> B', '@enduml']);
  });

  it('closes a diagram whose @enduml the model forgot', () => {
    expect(normalizePlantumlSource('@startuml\nA -> B')).toEqual(['@startuml', 'A -> B', '@enduml']);
  });

  it('normalizes CRLF line endings', () => {
    expect(normalizePlantumlSource('@startuml\r\nA -> B\r\n@enduml')).toEqual(['@startuml', 'A -> B', '@enduml']);
  });

  it('returns nothing for blank input', () => {
    expect(normalizePlantumlSource('   \n\n')).toEqual([]);
  });
});

describe('createDefaultRichRenderers', () => {
  it('always covers chart and svg', () => {
    const renderers = createDefaultRichRenderers();
    expect(typeof renderers.chartToPng).toBe('function');
    expect(typeof renderers.svgToPng).toBe('function');
    renderers.dispose?.();
  });
});
