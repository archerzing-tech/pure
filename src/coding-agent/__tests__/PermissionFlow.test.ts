// src/coding-agent/__tests__/PermissionFlow.test.ts
// Covers the write-file confirmation flow: preview building (ToolRegistry)
// and passthrough of path/contentPreview to the request handler.

import { describe, it, expect } from 'bun:test';
import { buildWritePreview } from '../ToolRegistry';
import { PermissionManager } from '../PermissionManager';
import type { PermissionContext, PermissionRequestInfo } from '../types';

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

  it('caches an explicit "allow always this session" decision even for high-risk tools', async () => {
    let handlerCalls = 0;
    const pm = new PermissionManager('NORMAL', async () => {
      handlerCalls++;
      return { allowed: true, remember: true };
    });

    const ctx: PermissionContext = {
      tool: 'execute_command',
      command: 'rm -rf node_modules',
      description: 'Execute a shell command',
      isRead: false,
      riskLevel: 'high',
    };

    const first = await pm.askUser(ctx);
    const second = await pm.askUser(ctx);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    // Cached → the dialog/handler must not fire a second time.
    expect(handlerCalls).toBe(1);
  });

  it('does not cache a one-shot "allow once" decision, even for high risk', async () => {
    let handlerCalls = 0;
    const pm = new PermissionManager('NORMAL', async () => {
      handlerCalls++;
      return { allowed: true, remember: false };
    });

    const ctx: PermissionContext = {
      tool: 'execute_command',
      command: 'ls',
      description: 'Execute a shell command',
      isRead: false,
      riskLevel: 'high',
    };

    await pm.askUser(ctx);
    await pm.askUser(ctx);
    // Every use re-asks — only explicit session approvals are cached.
    expect(handlerCalls).toBe(2);
  });

  it('clearCache resets remembered approvals for a new chat session', async () => {
    let handlerCalls = 0;
    const pm = new PermissionManager('NORMAL', async () => {
      handlerCalls++;
      return { allowed: true, remember: true };
    });

    const ctx: PermissionContext = {
      tool: 'execute_command',
      command: 'ls',
      description: 'Execute a shell command',
      isRead: false,
      riskLevel: 'high',
    };

    await pm.askUser(ctx);
    pm.clearCache();
    await pm.askUser(ctx);
    expect(handlerCalls).toBe(2);
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
