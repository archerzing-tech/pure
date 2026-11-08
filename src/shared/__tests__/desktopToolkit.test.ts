// src/shared/__tests__/desktopToolkit.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDesktopControl, INSTALL_DESKTOP_CONTROL_DEF, DESKTOP_TOOL_MANIFESTS } from '../desktopToolkit';
import { compileExternalTool } from '../../harness/externalTools';

// macOS 的 tmpdir 在 /var/... 而 /var 是 /private/var 的 symlink——统一到 real path。
const pureDir = realpathSync(mkdtempSync(join(tmpdir(), 'pure-dtk-')));

function makeDeps(overrides: Partial<{ platform: string; cliclickFound: boolean; failWrite: boolean }> = {}) {
  return {
    platform: overrides.platform ?? 'darwin',
    cliclickFound: overrides.cliclickFound ?? true,
    ensureDir: (dir: string) => {
      mkdirSync(dir, { recursive: true });
    },
    writeFile: (file: string, content: string) => {
      if (overrides.failWrite) throw new Error('disk full (simulated)');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('node:fs').writeFileSync(file, content);
    },
  };
}

afterAll(() => {
  rmSync(pureDir, { recursive: true, force: true });
});

describe('installDesktopControl', () => {
  beforeEach(() => {
    rmSync(join(pureDir, 'tools'), { recursive: true, force: true });
  });

  it('installs three TOOL.json files that pass the external-tool compiler', async () => {
    const r = await installDesktopControl(makeDeps(), pureDir);
    expect(r.ok).toBe(true);
    expect(r.installed).toEqual(['desktop_click', 'desktop_type', 'desktop_key']);
    for (const manifest of DESKTOP_TOOL_MANIFESTS) {
      const file = join(pureDir, 'tools', manifest.name, 'TOOL.json');
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, 'utf8');
      const parsed = JSON.parse(text);
      expect(parsed.name).toBe(manifest.name);
      // 编译契约：模板形状必须能通过 externalTools 编译器（目录名同构），
      // 否则装了也白装——下一轮扫描直接进 errors 被丢掉。
      const compiled = compileExternalTool({ file, text }, (name) => existsSync(join(pureDir, 'tools', name)));
      expect(compiled.errors).toEqual([]);
      expect(compiled.tools).toHaveLength(1);
    }
  });

  it('reports brew guidance when cliclick is missing', async () => {
    const r = await installDesktopControl(makeDeps({ cliclickFound: false }), pureDir);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('brew install cliclick');
  });

  it('refuses non-macOS platforms without writing files', async () => {
    const r = await installDesktopControl(makeDeps({ platform: 'win32' }), pureDir);
    expect(r.ok).toBe(false);
    expect(r.installed).toEqual([]);
    expect(existsSync(join(pureDir, 'tools'))).toBe(false);
    expect(r.message).toContain('register_mcp_server'); // 第三方路线指路
  });

  it('reports write failures without claiming success', async () => {
    const r = await installDesktopControl(makeDeps({ failWrite: true }), pureDir);
    expect(r.ok).toBe(false);
    expect(r.installed).toEqual([]);
    expect(r.message).toContain('安装失败');
  });

  it('is idempotent (reinstall overwrites the same files)', async () => {
    const deps = makeDeps();
    await installDesktopControl(deps, pureDir);
    const again = await installDesktopControl(deps, pureDir);
    expect(again.ok).toBe(true);
    expect(readFileSync(join(pureDir, 'tools', 'desktop_click', 'TOOL.json'), 'utf8')).toContain('"name": "desktop_click"');
  });

  it('exposes a resident schema for the install tool', () => {
    expect(INSTALL_DESKTOP_CONTROL_DEF.name).toBe('install_desktop_control');
    expect(INSTALL_DESKTOP_CONTROL_DEF.input_schema.required).toEqual([]);
  });
});
