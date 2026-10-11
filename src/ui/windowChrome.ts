// src/ui/windowChrome.ts
// 自绘窗口壳（tauri.conf.json decorations:false）的 JS 侧：标题栏右侧三枚
// 窗口键——最小化 / 最大化·还原 / 关闭——在 Windows 与 macOS 上共用同一套
// 皮肤与几何（2026-10-11 用户定稿：都放最右侧）。关闭走 win.close()，Rust
// 侧 CloseRequested 的既有语义（有任务 → 藏进托盘并提示；空闲 → 退出）
// 原样生效，这里不复制那份判断。浏览器 / 测试环境没有窗口可管：控件整组
// 隐藏，data-tauri-drag-region 拖拽区保持惰性。
import { isTauriRuntime } from '../shared/tauri';
import { t } from '../shared/i18n';

export function setupWindowChrome(): void {
  const bar = document.getElementById('window-titlebar');
  if (!bar || bar.dataset.wired === '1') return;
  bar.dataset.wired = '1';

  const min = document.getElementById('win-min');
  const max = document.getElementById('win-max');
  const close = document.getElementById('win-close');
  const labels: ReadonlyArray<readonly [HTMLElement | null, string]> = [
    [min, 'win.minimize'],
    [max, 'win.maximize'],
    [close, 'win.close'],
  ];
  for (const [el, key] of labels) {
    if (!el) continue;
    el.title = t(key);
    el.setAttribute('aria-label', t(key));
  }

  if (!isTauriRuntime()) {
    bar.classList.add('browser-preview');
    return;
  }

  void (async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      // 权限缺失等失败必须落日志：capabilities 漏授权时窗口键会「点了没
      // 反应」，静默吞掉就成了无头案（2026-10-11 真机踩过）。
      const safe = (p: Promise<void>): Promise<void> => p.catch((e) => console.warn('[window-chrome]', e));
      min?.addEventListener('click', () => void safe(win.minimize()));
      max?.addEventListener('click', () => void safe(win.toggleMaximize()));
      close?.addEventListener('click', () => void safe(win.close()));

      // 最大化态把 maximize 图标换成 restore，并去掉窗口圆角（铺满屏幕时
      // 圆角会在四角露出底色）。菜单/系统改变窗口尺寸时也会走到 onResized。
      const syncMax = async (): Promise<void> => {
        const isMax = await win.isMaximized();
        max?.classList.toggle('is-max', isMax);
        document.body.classList.toggle('window-maximized', isMax);
      };
      await syncMax();
      void win.onResized(() => { void syncMax(); });
    } catch {
      // 窗口 API 意外不可用（例如老版本 webview 注入缺失）：退回浏览器
      // 形态，别留三个点了没反应的按钮。
      bar.classList.add('browser-preview');
    }
  })();
}
