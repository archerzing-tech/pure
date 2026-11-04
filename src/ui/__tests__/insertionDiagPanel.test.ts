// 设置页「插话决策日志」面板本体的结构锁。收割/趋势/疑点标记已随审计链退役
// （2026-11-05：宿主侧字面嗅探 2026-10-28 整删后 auditInsertionDecision 恒空，
// 骨架没跟上语义），这里只锁还活着的东西：场景徽章与文案双语言齐备。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('设置页 · 插话决策诊断区', () => {
  it('每行带场景徽章（在什么场景下判的，才可行动）', () => {
    const src = read('../settings.ts');
    expect(src).toContain('describeInsertionScene(entry.inputContext)');
    expect(src).toContain('insertion-diag-scene');
    expect(src).toContain('title="${escapeHtml(entry.inputContext)}"');
    // 没记下场景的行（排期插话）不挂徽章，也不拿空文案占位。
    expect(src).toContain("scene.key === 'unrecorded'");
    expect(src).toContain('${sceneLabel ?');
  });

  it('场景徽章的样式与文案齐备', () => {
    const css = read('../styles.css');
    expect(css).toContain('.insertion-diag-scene');
    const i18n = read('../../shared/i18n.ts');
    for (const key of [
      'insertionDiag.scene.thinking',
      'insertionDiag.scene.inflight',
      'insertionDiag.scene.executing',
    ]) {
      expect(i18n.split(`'${key}':`).length - 1).toBeGreaterThanOrEqual(2);
    }
  });
});
