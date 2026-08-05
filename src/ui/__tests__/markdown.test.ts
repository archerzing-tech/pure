// src/ui/__tests__/markdown.test.ts
// Covers the save-button filename derivation (suggestFilename) — the helper
// that picks a default name for the code-block save dialog.

import { describe, it, expect } from 'bun:test';
import { suggestFilename } from '../markdown';

describe('suggestFilename', () => {
  it('prefers an explicit file/filename comment hint', () => {
    expect(suggestFilename('// file: main.ts\nconst x = 1;', 'ts')).toBe('main.ts');
    expect(suggestFilename('# filename: script.py\nprint(1)', 'python')).toBe('script.py');
    expect(suggestFilename('<!-- file: index.html -->\n<p>hi</p>', 'html')).toBe('index.html');
    expect(suggestFilename('-- file: db.sql\nSELECT 1;', 'sql')).toBe('db.sql');
  });

  it('maps a shebang to script.sh', () => {
    expect(suggestFilename('#!/usr/bin/env bash\necho hi', 'bash')).toBe('script.sh');
  });

  it('uses the canonical Dockerfile / Makefile names', () => {
    expect(suggestFilename('FROM node:20', 'dockerfile')).toBe('Dockerfile');
    expect(suggestFilename('all:;@echo hi', 'makefile')).toBe('Makefile');
  });

  it('falls back to code.<ext> by language, or code.txt for unknown langs', () => {
    expect(suggestFilename('fn main() {}', 'rust')).toBe('code.rs');
    expect(suggestFilename('print("hi")', 'python')).toBe('code.py');
    expect(suggestFilename('const x = 1;', 'typescript')).toBe('code.ts');
    expect(suggestFilename('???', 'weirdlang')).toBe('code.txt');
  });
});
