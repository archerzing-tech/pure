// src/ui/__tests__/pasteChipWorkspace.test.ts
// Long-text overflow saves route into the user-selected session workspace when
// one was chosen BEFORE the overflow; otherwise the backend falls back to the
// application tmp workspace on an empty workspaceDir.
//
// These tests stay hermetic on purpose: bun test shares one process across
// files, so faking window.__TAURI_INTERNALS__ here would poison the module
// cache inside shared/tauri.ts for every later file. Wiring is asserted via
// source text (same pattern as workspace.test.ts); behavior below/above the
// threshold runs in the plain no-window environment where isTauriRuntime() is
// deterministically false.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PASTE_FILE_THRESHOLD, PasteChipManager, purePasteName } from '../pasteChip';

const uiDir = join(import.meta.dir, '..');

function src(rel: string): string {
  return readFileSync(join(uiDir, rel), 'utf8');
}

describe('long-text save destination wiring', () => {
  it('manager exposes a getWorkspace callback used at overflow time', () => {
    const source = src('pasteChip.ts');
    expect(source).toContain('getWorkspace: () => string');
    // Both typed-long-text and paste paths capture the workspace NOW (before
    // the async write resolves) and pass it as workspaceDir.
    expect(source.match(/const workspaceDir = this\.getWorkspace\(\)\.trim\(\);/g)?.length).toBe(2);
    expect(source.match(/workspaceDir \}/g)?.length).toBe(2);
  });

  it('main.ts injects the live chat workspace into the manager', () => {
    const source = src('main.ts');
    expect(source).toContain("new PasteChipManager(() => chat.getSessionId()");
    expect(source).toContain('() => chat.getWorkspace()');
  });

  it('backend routes empty workspaceDir back to the app tmp workspace', () => {
    const rust = readFileSync(
      join(uiDir, '../../src-tauri/src/lib.rs'),
      'utf8',
    );
    expect(rust).toContain('fn paste_save_dir(session_id: &str, workspace_dir: Option<&str>) -> PathBuf');
    expect(rust).toContain('.filter(|d| !d.is_empty())');
  });
});

describe('PasteChipManager.addLongText (no-Tauri env)', () => {
  it('creates a memory chip above the threshold without touching disk', () => {
    const mgr = new PasteChipManager(() => 'session-1');
    const long = 'x'.repeat(PASTE_FILE_THRESHOLD + 1);
    const att = mgr.addLongText(long);
    expect(att).not.toBeNull();
    expect(att?.name).toMatch(/^pure-\d{8}-\d{6}-[a-z0-9]{4}\.txt$/);
    expect(att?.content).toBe(long);
    expect(att?.kind).toBe('text');
    // Browser/dev mode: nothing persisted yet, memory fallback carries content.
    expect(att?.path).toBe('');
    expect(mgr.hasAttachments()).toBe(true);
  });

  it('ignores text at or below the threshold', () => {
    const mgr = new PasteChipManager(() => 'session-1');
    expect(mgr.addLongText('x'.repeat(PASTE_FILE_THRESHOLD))).toBeNull();
    expect(mgr.hasAttachments()).toBe(false);
  });

  it('keeps distinct names for same-second saves', () => {
    const seen = new Set([purePasteName(), purePasteName(), purePasteName()]);
    expect(seen.size).toBe(3);
  });
});
