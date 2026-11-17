// src/ui/__tests__/markdownBubbleFold.test.ts
// 每气泡累计代码预算（2026-11-17 看板刀）+ html 卡流式水合 gate 的 DOM 级
// 契约。放独立文件：DOMPurify 在模块导入时绑定 window——必须先注册
// happy-dom 再 await import('../markdown')，markdown.test.ts 顶部静态导入
// 的实例拿不到 window（sanitize 缺失）。

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// 注册+导入全部收在 beforeAll/afterAll：顶层无条件 register 会泄漏到同进程
// 的其他测试文件（liveTranscriptWindow 的 register 撞车、memoryTransfer 的
// delete window 撞 readonly——flaky-quartet 同族）。markdown.ts 的 DOMPurify
// 绑定导入时的 window，必须在注册之后再 import。
let mod: typeof import('../markdown');
let registeredHere = false;
beforeAll(async () => {
  if (!(globalThis as any).document?.body) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
  mod = await import('../markdown');
});
afterAll(() => {
  if (registeredHere) {
    GlobalRegistrator.unregister();
    registeredHere = false;
  }
});

// 前导叙述让片段不以 <pre> 开头——DOMPurify+happy-dom 会剥片段首个顶层元素的
// 标签（环境怪癖，生产 WebKit 无此现象），夹具对齐真实消息形状一并避开。
const blockMd = (lang: string, lines: number): string =>
  '```' + lang + '\n' + Array.from({ length: lines }, (_, i) => `line-${i}`).join('\n') + '\n```';

const openPres = (host: HTMLElement): number =>
  Array.from(host.querySelectorAll('pre > code')).filter((c) => !c.closest('.code-fold')).length;

describe('bubble cumulative code budget（2026-11-17 看板刀）', () => {
  it('folds blocks beyond the 40-line cumulative budget, keeps the head open', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await mod.renderMarkdown('先看说明。\n\n' + blockMd('js', 15) + '\n\n' + blockMd('js', 15) + '\n\n' + blockMd('js', 30), host, { yieldBeforeParse: false });
    // 15+15=40 展开预算用满 → 第三块（30 行）收壳；前两块保持原样。
    expect(host.querySelectorAll('.code-fold').length).toBe(1);
    expect(openPres(host)).toBe(2);
    host.remove();
  });

  it('a bubble under the budget stays untouched', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await mod.renderMarkdown('先看说明。\n\n' + blockMd('js', 10) + '\n\n' + blockMd('js', 10), host, { yieldBeforeParse: false });
    expect(host.querySelectorAll('.code-fold').length).toBe(0);
    host.remove();
  });

  it('per-block fold still fires for a fat block; folded blocks do not consume budget', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await mod.renderMarkdown('先看说明。\n\n' + blockMd('js', 50) + '\n\n' + blockMd('js', 8), host, { yieldBeforeParse: false });
    // 50 行块单块阈值折叠；折叠块不占累计预算 → 8 行小块保持展开。
    expect(host.querySelectorAll('.code-fold').length).toBe(1);
    expect(openPres(host)).toBe(1);
    host.remove();
  });
});

describe('streamingHtmlGate（html 卡流式水合刀）', () => {
  const makeSlot = (): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'html-slot';
    el.setAttribute('data-html-state', 'loading');
    el.setAttribute('data-md-raw', '```html\n<div>x</div>\n```');
    el.innerHTML = '<div class="html-frame-wrap"></div><pre class="html-source"><code>src</code></pre>';
    document.body.appendChild(el);
    return el;
  };

  it('closed fence kicks hydration once, then releases after error/ready', async () => {
    const el = makeSlot();
    expect(mod.streamingHtmlGate(el)).toBe(true);
    expect(el.getAttribute('data-stream-kick')).toBe('1');
    expect(el.getAttribute('data-processed')).toBe('1');
    // 无 Tauri 环境：水合走 error 终态（loadTauriCore 不可用）。
    await new Promise((r) => setTimeout(r, 20));
    expect(el.getAttribute('data-html-state')).toBe('error');
    expect(mod.streamingHtmlGate(el)).toBe(false);
    el.remove();
  });

  it('open fence never kicks and never holds', () => {
    const el = makeSlot();
    el.setAttribute('data-md-raw', '```html\n<div>x');
    expect(mod.streamingHtmlGate(el)).toBe(false);
    expect(el.getAttribute('data-stream-kick')).toBeNull();
    el.remove();
  });

  it('non-html slots are ignored', () => {
    const el = makeSlot();
    el.className = 'chart-slot';
    expect(mod.streamingHtmlGate(el)).toBe(false);
    el.remove();
  });
});
