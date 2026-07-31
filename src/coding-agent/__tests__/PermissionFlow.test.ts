// src/coding-agent/__tests__/PermissionFlow.test.ts
// Covers the write-file confirmation flow: preview building (ToolRegistry)
// and passthrough of path/contentPreview to the request handler.

import { describe, it, expect } from 'bun:test';
import { buildWritePreview } from '../ToolRegistry';
import { PermissionManager } from '../PermissionManager';
import type { PermissionRequestInfo } from '../types';

describe('buildWritePreview', () => {
  it('builds a full-content preview for write_file', () => {
    const preview = buildWritePreview('write_file', {
      path: 'src/foo.ts',
      content: 'export const a = 1;',
    });
    expect(preview).toEqual({ path: 'src/foo.ts', contentPreview: 'export const a = 1;' });
  });

  it('builds an old→new diff snippet for edit_file', () => {
    const preview = buildWritePreview('edit_file', {
      path: 'README.md',
      oldString: 'v0.1',
      newString: 'v0.2',
    });
    expect(preview?.path).toBe('README.md');
    expect(preview?.contentPreview).toContain('- v0.1');
    expect(preview?.contentPreview).toContain('+ v0.2');
  });

  it('returns undefined for non-write tools (nothing to preview)', () => {
    expect(buildWritePreview('read_file', { path: 'a.ts' })).toBeUndefined();
    expect(buildWritePreview('execute_command', { command: 'ls' })).toBeUndefined();
  });

  it('tolerates missing args without throwing', () => {
    expect(buildWritePreview('write_file', {})).toEqual({ path: undefined, contentPreview: '' });
    expect(buildWritePreview('edit_file', {})).toEqual({ path: undefined, contentPreview: '- \n+ ' });
  });
});

describe('PermissionManager write preview passthrough', () => {
  it('passes path + contentPreview to the request handler for medium-risk writes', async () => {
    let received: PermissionRequestInfo | null = null;
    const pm = new PermissionManager('NORMAL', (info) => {
      received = info;
      return Promise.resolve({ allowed: true });
    });

    const decision = await pm.askUser({
      tool: 'write_file',
      isRead: false,
      riskLevel: 'medium',
      description: 'Create or overwrite a file',
      path: 'src/new.ts',
      contentPreview: 'export const x = 1;',
    });

    expect(decision.allowed).toBe(true);
    expect(received).not.toBeNull();
    expect(received!.path).toBe('src/new.ts');
    expect(received!.contentPreview).toBe('export const x = 1;');
    expect(received!.dangerLevel).toBe('caution');
  });

  it('keeps the preview absent for read tools (dialog shows no preview block)', async () => {
    let received: PermissionRequestInfo | null = null;
    const pm = new PermissionManager('NORMAL', (info) => {
      received = info;
      return Promise.resolve({ allowed: true });
    });

    await pm.askUser({
      tool: 'read_file',
      isRead: true,
      riskLevel: 'medium',
      description: 'Read a file',
      argsHash: 'h',
    });

    expect(received!.path).toBeUndefined();
    expect(received!.contentPreview).toBeUndefined();
  });

  it('passes the abort signal through to the request handler', async () => {
    let received: PermissionRequestInfo | null = null;
    const pm = new PermissionManager('NORMAL', (info) => {
      received = info;
      return Promise.resolve({ allowed: true });
    });

    const ac = new AbortController();
    await pm.askUser({
      tool: 'write_file',
      isRead: false,
      riskLevel: 'medium',
      description: 'Create or overwrite a file',
      path: 'src/new.ts',
      signal: ac.signal,
    });

    expect(received!.signal).toBe(ac.signal);
  });
});
