// src/__tests__/cli-diagram-wiring.test.ts
// Source-level wiring guard: the CLI must route assistant TokenDelta content
// through the diagram wireframe converter and flush it on every completion
// path, so a model-issued mermaid/puml block never prints as raw source and a
// trailing open fence never gets dropped.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readCliSource(): string {
  // consumeTurn moved to cliRepl.ts in the cli.ts split (audit ①).
  return readFileSync(fileURLToPath(new URL('../cliRepl.ts', import.meta.url)), 'utf-8');
}

describe('CLI diagram wireframe wiring', () => {
  it('imports the converter and creates it inside consumeTurn', () => {
    const src = readCliSource();
    expect(src).toContain("import { CliWireframeStream } from './shared/cliDiagram';");
    const create = src.indexOf('new CliWireframeStream(');
    const consume = src.indexOf('async function consumeTurn(');
    expect(create).toBeGreaterThan(consume);
  });

  it('feeds TokenDelta content through the converter and flushes on exit', () => {
    const src = readCliSource();
    // Live content goes through wireframe.feed; tool-call markers bypass it.
    expect(src).toContain("if (event.payload.content) wireframe.feed(event.payload.content);");
    expect(src).toContain('else streamMgr.feed(event);');
    // The finally block flushes the converter before the stream stops, so an
    // unclosed fence degrades to its raw source instead of being dropped.
    const finallyIdx = src.indexOf('finally {', src.indexOf('async function consumeTurn('));
    const flushIdx = src.indexOf('wireframe.flush();', finallyIdx);
    const stopIdx = src.indexOf('streamMgr.stop();', flushIdx);
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(flushIdx).toBeGreaterThan(finallyIdx);
    expect(stopIdx).toBeGreaterThan(flushIdx);
  });

  it('reuses the same consumeTurn path for one-shot and REPL modes', () => {
    const src = readCliSource();
    // Both entry points call consumeTurn with a StreamManager — one converter
    // inside consumeTurn covers every surface.
    expect((src.match(/consumeTurn\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
