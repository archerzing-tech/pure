// src/ui/__tests__/workspace.test.ts

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('workspace picker startup path', () => {
  it('caches and preloads the native dialog module before the first click', () => {
    const workspace = readFileSync(new URL('../workspace.ts', import.meta.url), 'utf8');
    expect(workspace).toContain('let dialogModulePromise: Promise<DialogModule> | null = null;');
    expect(workspace).toContain('function getDialogModule(): Promise<DialogModule>');
    expect(workspace).toContain('if (isTauriRuntime()) void getDialogModule().catch(() => {});');
    expect(workspace).toContain('const { open } = await getDialogModule();');
    expect(workspace).not.toContain('const { open } = await import(\'@tauri-apps/plugin-dialog\');');
  });

  it('binds workspace controls on the critical startup path', () => {
    const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
    const criticalInit = main.indexOf('wireComposerSelects();');
    const workspaceInit = main.indexOf('workspace.init();', criticalInit);
    const splash = main.indexOf('dismissBootSplash();', criticalInit);
    expect(criticalInit).toBeGreaterThan(-1);
    expect(workspaceInit).toBeGreaterThan(criticalInit);
    expect(workspaceInit).toBeLessThan(splash);
    expect(main.indexOf('workspace.init();', workspaceInit + 1)).toBe(-1);
  });
});
