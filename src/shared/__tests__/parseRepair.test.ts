// src/shared/__tests__/parseRepair.test.ts
// Covers the fault-tolerance layer (src/shared/parseRepair.ts): parse-gated
// repair of slightly-broken JSON / Mermaid / SVG sources. The core guarantee:
// `repaired: true` is ONLY ever returned when the rewritten JSON actually
// parses (or, for mermaid/svg, when a structurally safe rewrite was produced),
// and valid input always passes through untouched with `repaired: false`.

import { describe, it, expect } from 'bun:test';
import { repairJsonSource, repairMermaidSource, repairSvgSource, parseToolArguments } from '../parseRepair';

// ── JSON ──

describe('repairJsonSource', () => {
  it('leaves valid JSON untouched (repaired: false)', () => {
    const r = repairJsonSource('{"a": 1, "b": [1, 2]}');
    expect(r.repaired).toBe(false);
    expect(r.source).toBe('{"a": 1, "b": [1, 2]}');
  });

  it('leaves empty input untouched', () => {
    const r = repairJsonSource('   ');
    expect(r.repaired).toBe(false);
  });

  it('fixes a trailing comma', () => {
    const r = repairJsonSource('{"a": 1,}');
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.source)).toEqual({ a: 1 });
  });

  it('fixes single-quoted strings', () => {
    const r = repairJsonSource("{'a': 'x', 'b': 2}");
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.source)).toEqual({ a: 'x', b: 2 });
  });

  it('fixes unquoted keys', () => {
    const r = repairJsonSource('{a: 1, b: [1, 2]}');
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.source)).toEqual({ a: 1, b: [1, 2] });
  });

  it('fixes multiple issues at once (unquoted keys + single quotes + trailing commas)', () => {
    const r = repairJsonSource("{type: 'pie', data: [['A', 30], ['B', 70],],}");
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.source)).toEqual({ type: 'pie', data: [['A', 30], ['B', 70]] });
  });

  it('fixes full-width punctuation', () => {
    const r = repairJsonSource('{“a”：1， “b”：2，}');
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.source)).toEqual({ a: 1, b: 2 });
  });

  it('unwraps a markdown code fence', () => {
    const r = repairJsonSource('```json\n{"a": 1}\n```');
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.source)).toEqual({ a: 1 });
  });

  it('extracts the JSON payload from surrounding prose', () => {
    const r = repairJsonSource('Here is the data you asked for: {"a": 1} hope it helps');
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.source)).toEqual({ a: 1 });
  });

  it('normalizes JS-style constants', () => {
    const r = repairJsonSource('{ok: True, bad: None, n: NaN, inf: Infinity}');
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.source)).toEqual({ ok: true, bad: null, n: null, inf: null });
  });

  it('strips line comments', () => {
    const r = repairJsonSource('{\n  "a": 1, // first value\n  "b": 2\n}');
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.source)).toEqual({ a: 1, b: 2 });
  });

  it('keeps URLs with // inside strings intact', () => {
    const r = repairJsonSource('{"url": "http://example.com/x", "a": 1,}');
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.source)).toEqual({ url: 'http://example.com/x', a: 1 });
  });

  it('structuralOnly mode fixes syntax but never alters string values', () => {
    // Trailing comma (syntax) is repaired; full-width punctuation and JS
    // constants INSIDE string values stay byte-for-byte intact.
    const r = repairJsonSource('{"msg": "苹果，香蕉 NaN True",}', { structuralOnly: true });
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.source)).toEqual({ msg: '苹果，香蕉 NaN True' });
  });

  it('default mode still converts full-width punctuation outside strings', () => {
    const r = repairJsonSource('{“a”：1， “b”：2，}');
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.source)).toEqual({ a: 1, b: 2 });
  });

  it('returns the original untouched when nothing parses', () => {
    const src = '{a: }';
    const r = repairJsonSource(src);
    expect(r.repaired).toBe(false);
    expect(r.source).toBe(src);
  });

  it('does not invent JSON from plain prose', () => {
    const src = 'this is not json at all';
    const r = repairJsonSource(src);
    expect(r.repaired).toBe(false);
    expect(r.source).toBe(src);
  });

  it('bounds the BFS with maxCandidates (defense against queue explosion)', () => {
    // `{ 'a': 1, }` needs 4 processed nodes to repair (trailing comma then
    // single-quoted key, in either order). A budget of 2 must give up.
    const broken = "{ 'a': 1, }";
    expect(repairJsonSource(broken, { maxCandidates: 2 }).repaired).toBe(false);
    // A budget that covers the fix depth completes the same repair.
    expect(repairJsonSource(broken, { maxCandidates: 10 }).repaired).toBe(true);
  });

  it('still repairs large payloads within the default budget (no regression)', () => {
    // 300 unquoted keys + single-quoted values + trailing comma. The fixers
    // are GLOBAL transforms, so this converges in ~8 BFS nodes — comfortably
    // inside the 200-node budget; a hang here would signal a budget bug.
    const payload = Array.from({ length: 300 }, (_, i) => `k${i}: 'v${i}'`).join(', ');
    const src = `{ ${payload}, }`;
    const start = performance.now();
    const r = repairJsonSource(src);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(r.repaired).toBe(true);
    const parsed = JSON.parse(r.source) as Record<string, string>;
    expect(Object.keys(parsed)).toHaveLength(300);
    expect(parsed.k0).toBe('v0');
    expect(parsed.k299).toBe('v299');
  });
});

// ── Mermaid ──

describe('repairMermaidSource', () => {
  it('leaves a clean diagram untouched', () => {
    const src = 'graph TD\nA-->B';
    const r = repairMermaidSource(src);
    expect(r.repaired).toBe(false);
    expect(r.source).toBe(src);
  });

  it('unwraps a markdown fence and dedents a uniformly-indented body', () => {
    const r = repairMermaidSource('```mermaid\n  graph TD\n  A-->B\n```');
    expect(r.repaired).toBe(true);
    expect(r.source).toBe('graph TD\nA-->B');
  });

  it('strips stray backticks', () => {
    const r = repairMermaidSource('`graph TD\nA-->B`');
    expect(r.repaired).toBe(true);
    expect(r.source).toBe('graph TD\nA-->B');
  });

  it('drops leading prose before the diagram start line', () => {
    const r = repairMermaidSource('Here is the flow you asked for:\ngraph TD\nA-->B');
    expect(r.repaired).toBe(true);
    expect(r.source.startsWith('graph TD')).toBe(true);
    expect(r.source).toContain('A-->B');
  });

  it('drops a trailing line truncated mid-edge', () => {
    const r = repairMermaidSource('graph TD\nA-->B\nA-->');
    expect(r.repaired).toBe(true);
    expect(r.source).toBe('graph TD\nA-->B');
  });

  it('removes HTML comments (markup to mermaid, not comments)', () => {
    const r = repairMermaidSource('graph TD\nA-->B <!-- inline -->');
    expect(r.repaired).toBe(true);
    expect(r.source).not.toContain('<!--');
  });

  it('closes an unpaired double quote and bracket in a truncated label', () => {
    const r = repairMermaidSource('graph TD\nA["label');
    expect(r.repaired).toBe(true);
    expect(r.source).toBe('graph TD\nA["label"]');
  });

  it('closes an unpaired square bracket at end of line', () => {
    const r = repairMermaidSource('graph TD\nA[label --> B');
    expect(r.repaired).toBe(true);
    expect(r.source).toBe('graph TD\nA[label --> B]');
  });

  it('closes unpaired parentheses and nested shapes', () => {
    expect(repairMermaidSource('graph TD\nA(foo').source).toBe('graph TD\nA(foo)');
    expect(repairMermaidSource('graph TD\nA[(db').source).toBe('graph TD\nA[(db)]');
  });

  it('strips a stray trailing closer with no matching opener', () => {
    expect(repairMermaidSource('graph TD\nA --> B]').source).toBe('graph TD\nA --> B');
  });

  it('balances a subgraph title quote', () => {
    const r = repairMermaidSource('graph TD\nsubgraph "my title\nA-->B');
    expect(r.repaired).toBe(true);
    expect(r.source).toBe('graph TD\nsubgraph "my title"\nA-->B');
  });

  it('does not touch apostrophes in unquoted labels', () => {
    expect(repairMermaidSource("graph TD\nA[don't] --> B").repaired).toBe(false);
  });

  it('does not corrupt erDiagram crows-foot braces', () => {
    expect(repairMermaidSource('erDiagram\nCUSTOMER ||--o{ ORDER : places').repaired).toBe(false);
  });

  it('keeps balanced quoted labels with inner brackets intact', () => {
    expect(repairMermaidSource('graph TD\nA["text [x]"] --> B').repaired).toBe(false);
  });

  it('ignores delimiters inside %% comment lines', () => {
    expect(repairMermaidSource('graph TD\n%% note [unclosed').repaired).toBe(false);
  });

  it('does not strip a legitimate trailing bracket after a mid-line stray', () => {
    // The stray `]` after `bar` must never delete the closer of `B[x]`.
    expect(repairMermaidSource('graph TD\nA[foo] bar] --> B[x]').repaired).toBe(false);
  });

  it('leaves free-text parens in message lines untouched', () => {
    expect(repairMermaidSource('sequenceDiagram\nA->>B: note (WIP').repaired).toBe(false);
  });

  it('keeps escaped quotes inside labels intact', () => {
    expect(repairMermaidSource('graph TD\nA["text \\"quoted\\""] --> B').repaired).toBe(false);
  });

  it('closes truncated xychart-beta x-axis quotes and brackets', () => {
    expect(repairMermaidSource('xychart-beta\nx-axis ["a", "b').source).toBe('xychart-beta\nx-axis ["a", "b"]');
  });

  it('leaves classDiagram member lines with parens untouched', () => {
    expect(repairMermaidSource('classDiagram\nAnimal : +void setName(String name)').repaired).toBe(false);
  });

  it('drops a truncated edge even when only one statement line remains', () => {
    const r = repairMermaidSource('graph TD\nA-->');
    expect(r.repaired).toBe(true);
    expect(r.source).toBe('graph TD');
  });

  it('keeps a diagram that is only a truncated edge (nothing to infer)', () => {
    const r = repairMermaidSource('A-->');
    expect(r.repaired).toBe(false);
    expect(r.source).toBe('A-->');
  });
});

// ── SVG ──

describe('repairSvgSource', () => {
  it('leaves a clean SVG untouched', () => {
    const src = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    const r = repairSvgSource(src);
    expect(r.repaired).toBe(false);
    expect(r.source).toBe(src);
  });

  it('unwraps a markdown fence', () => {
    const r = repairSvgSource('```svg\n<svg viewBox="0 0 1 1"><rect/></svg>\n```');
    expect(r.repaired).toBe(true);
    expect(r.source).toContain('<svg');
    expect(r.source).toContain('</svg>');
  });

  it('extracts the SVG block from surrounding prose', () => {
    const r = repairSvgSource('Here you go: <svg viewBox="0 0 1 1"><rect/></svg> thanks!');
    expect(r.repaired).toBe(true);
    expect(r.source).toBe('<svg viewBox="0 0 1 1"><rect/></svg>');
  });

  it('completes a document missing its closing tag', () => {
    const r = repairSvgSource('<svg viewBox="0 0 1 1"><rect/></svg');
    expect(r.repaired).toBe(true);
    expect(r.source).toBe('<svg viewBox="0 0 1 1"><rect/></svg>');
  });

  it('appends a closing tag when the root never closes', () => {
    const r = repairSvgSource('<svg viewBox="0 0 1 1"><rect/>');
    expect(r.repaired).toBe(true);
    expect(r.source.endsWith('</svg>')).toBe(true);
  });

  it('leaves a deeper truncated closing tag untouched (no double-close)', () => {
    const src = '<svg viewBox="0 0 1 1"><rect/></sv';
    const r = repairSvgSource(src);
    expect(r.repaired).toBe(false);
    expect(r.source).toBe(src);
  });

  it('leaves a bare fragment for the sanitizer to wrap', () => {
    const src = '<rect width="10" height="10"/>';
    const r = repairSvgSource(src);
    expect(r.repaired).toBe(false);
    expect(r.source).toBe(src);
  });
});

// ── parseToolArguments (tool-call JSON → object, repair before giving up) ──

describe('parseToolArguments', () => {
  it('passes valid object JSON straight through', () => {
    expect(parseToolArguments('{"prompt": "hi", "path": "./a.ts"}')).toEqual({
      prompt: 'hi',
      path: './a.ts',
    });
  });

  it('returns {} for empty or whitespace-only input', () => {
    expect(parseToolArguments('')).toEqual({});
    expect(parseToolArguments('   ')).toEqual({});
  });

  it('repairs trailing commas and single quotes, preserving args', () => {
    const args = parseToolArguments("{ prompt: 'fix the bug', path: './src/', }");
    expect(args).toEqual({ prompt: 'fix the bug', path: './src/' });
  });

  it('repairs unquoted keys and full-width punctuation', () => {
    const args = parseToolArguments("{ prompt: '重构一下', path： './src' }");
    expect(args).toEqual({ prompt: '重构一下', path: './src' });
  });

  it('drops payloads with unquoted string values (beyond repair scope)', () => {
    // The repair layer quotes unquoted KEYS but not unquoted string VALUES,
    // so this genuinely invalid payload falls back to {} instead of leaking
    // a half-repaired object.
    expect(parseToolArguments('{ prompt: 给我重构一下, path: ./src }')).toEqual({});
  });

  it('recovers args from a fenced JSON payload', () => {
    const args = parseToolArguments('```json\n{"prompt": "run tests"}\n```');
    expect(args).toEqual({ prompt: 'run tests' });
  });

  it('rejects array payloads (contract: plain object only)', () => {
    // JSON.parse succeeds on arrays — the object gate must still drop them.
    expect(parseToolArguments('[1, 2, 3]')).toEqual({});
    expect(parseToolArguments('"just a string"')).toEqual({});
    expect(parseToolArguments('42')).toEqual({});
  });

  it('returns {} for unfixable garbage', () => {
    expect(parseToolArguments('not json at all {{{')).toEqual({});
    expect(parseToolArguments('{ "a": }')).toEqual({});
  });

  it('still drops the payload when the repair output is not an object', () => {
    // A prose-wrapped array extracts to an array → not a valid args object.
    expect(parseToolArguments('Here is the list: [1, 2, 3]')).toEqual({});
  });
});
