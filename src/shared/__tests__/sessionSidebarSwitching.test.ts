// src/ui/__tests__/sessionSidebarSwitching.test.ts
// 问题 3 的回归（2026-09-29 用户反馈）：会话切换必须立刻给出「正在切换」
// 的视觉反馈，加载完成/点击落空时摘掉。DOM 层用 jsdom 风格的最小桩验证
// 类名流转；markSwitching/clearSwitching 是私有的，这里经由 load() 的
// 可观察行为（DOM 类名）驱动，与真实点击路径一致。

import { describe, expect, test } from 'bun:test';

function readSource(): string {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  return readFileSync(new URL('../../ui/sessionSidebar.ts', import.meta.url), 'utf8');
}

describe('session sidebar switching feedback', () => {
  test('marks the clicked card switching BEFORE the disk read starts', () => {
    const src = readSource();
    // markSwitching 必须先于 loadSession —— 反馈的意义就在「点击即亮」，
    // 排到读盘之后就失去意义。
    const markIdx = src.indexOf('this.markSwitching(id);');
    const loadIdx = src.indexOf('await this.deps.loadSession(id);');
    expect(markIdx).toBeGreaterThan(-1);
    expect(loadIdx).toBeGreaterThan(markIdx);
  });

  test('every terminal path clears the switching state', () => {
    const src = readSource();
    // 落空（卡片已删）、热会话、空内容、冷加载完成 —— 四条出口都要清。
    expect(src.split('this.clearSwitching();').length - 1).toBeGreaterThanOrEqual(4);
  });

  test('the switching class is scoped per card, rapid clicks keep only the newest', () => {
    const src = readSource();
    // markSwitching 先摘掉其他卡的 is-switching，再点亮当前卡。
    const fn = src.slice(src.indexOf('private markSwitching'), src.indexOf('private clearSwitching'));
    expect(fn).toContain("getAttribute('data-sid') !== id");
    expect(fn).toContain("classList.add('is-switching')");
  });

  test('styles cover the switching state and degrade for reduced motion', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const css = readFileSync(new URL('../../ui/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.sidebar-session-item.is-switching');
    expect(css).toContain('@keyframes session-switch-spin');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
