import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Windows 宿主窗不透明契约（2026-11-12 活锁定案）。
//
// 根因：transparent 窗 = WebView2 宿主 16 个 WS_EX_TRANSPARENT 辅助窗的
// 存在理由，宿主 DLL（EmbeddedBrowserWebView，微软代码，无修改权）在主线程
// 对它们逐个同步 SetWindowPos + WM_NCPAINT + ShowWindow，流式重排喂料后
// 自激成消息风暴 → 主线程 hung。Windows 一律不透明方角；mac 保留透明圆角。
//
// tauri.windows.conf.json 走 RFC 7396 JSON Merge Patch：对象递归合并、
// **数组整体替换**——所以 app.windows 必须是完整窗定义，base 里主窗任何
// 字段改动都必须镜像过来（transparent 除外）。这份测试就是防漂移的锁。

const root = join(import.meta.dir, '..', '..', '..');

const base = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')) as {
  app: { windows: Record<string, unknown>[] };
};
const win = JSON.parse(
  readFileSync(join(root, 'src-tauri', 'tauri.windows.conf.json'), 'utf8'),
) as {
  mainBinaryName?: string;
  bundle?: { windows?: { nsis?: { installerHooks?: string } } };
  app: { windows: Record<string, unknown>[] };
};

const FOUR_BROWSER_ARGS =
  '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion';

describe('windows platform window config (transparent knife)', () => {
  it('keeps the pre-existing bundle settings (binary rename + installer hooks)', () => {
    // tauri.windows.conf.json 不是本刀新建的：v4.7.3 的 ms-gamingoverlay 根治
    // 刀（主二进制改名 pure-app.exe，退出微软游戏名单匹配）和 NSIS 安装器
    // 钩子都住在这份平台配置里。本刀往里加 app.windows 时差点把它们覆盖掉
    // （Rust 编译期 check 不消费这两个 bundle 期字段，绿灯拦不住）——锁死。
    expect(win.mainBinaryName).toBe('pure-app');
    const hooks = win.bundle?.windows?.nsis?.installerHooks;
    expect(hooks).toBe('./windows-installer-hooks.nsh');
    expect(() =>
      readFileSync(join(root, 'src-tauri', 'windows-installer-hooks.nsh'), 'utf8'),
    ).not.toThrow();
  });

  it('mirrors the base main window field-for-field except transparent', () => {
    expect(base.app.windows).toHaveLength(1);
    expect(win.app.windows).toHaveLength(1);
    const mac = { ...base.app.windows[0] } as Record<string, unknown>;
    const windows = { ...win.app.windows[0] } as Record<string, unknown>;
    expect(mac.transparent).toBe(true);
    expect(windows.transparent).toBe(false);
    delete mac.transparent;
    delete windows.transparent;
    expect(windows).toEqual(mac);
  });

  it('keeps the four browser args identical across all three creation paths', () => {
    const libRs = readFileSync(join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    const sidebar = readFileSync(join(root, 'src', 'ui', 'sessionSidebar.ts'), 'utf8');
    expect(base.app.windows[0].additionalBrowserArgs).toBe(FOUR_BROWSER_ARGS);
    expect(win.app.windows[0].additionalBrowserArgs).toBe(FOUR_BROWSER_ARGS);
    expect(libRs).toContain(`.additional_browser_args("${FOUR_BROWSER_ARGS}")`);
    expect(sidebar).toContain(`additionalBrowserArgs:\n        '${FOUR_BROWSER_ARGS}'`);
  });

  it('keeps the sidebar window transparent only off-Windows', () => {
    const sidebar = readFileSync(join(root, 'src', 'ui', 'sessionSidebar.ts'), 'utf8');
    // 平台条件式是这一刀的本体；回退成无条件 true 会复活宿主消息风暴。
    expect(sidebar).toContain('transparent: !isWindows');
    expect(sidebar).not.toContain('transparent: true');
  });

  it('keeps lib.rs free of additional transparent() call sites', () => {
    const libRs = readFileSync(join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    // 唯一允许的 .transparent(true) 在 macOS-only 菜单新窗里；Windows 侧
    // 新建窗路径若再出现 transparent，宿主辅助窗风暴会从新入口回来。
    expect(libRs.match(/\.transparent\(/g) ?? []).toHaveLength(1);
  });
});
