// 设置页「一键收割」接线（2026-09-28）：设置页跑在浏览器里，写不了源文件——所以
// 收割的产物是**整份生成文件**（既有收割项 + 新增），粘贴覆盖即生效。这里锁三件
// 事：按钮在、产物走共享渲染器（UI 绝不自己另写一份模板）、文案两种语言都在。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('设置页 · 插话决策诊断区', () => {
  it('按钮在诊断区的工具行里，带中英文案与提示', () => {
    const html = read('../../../index.html');
    expect(html).toContain('id="insertion-diag-harvest"');
    expect(html).toContain('data-i18n="insertionDiag.harvest"');
    expect(html).toContain('data-i18n-title="insertionDiag.harvestHint"');
  });

  it('产物走共享渲染器，而不是 UI 自己另写一份模板', () => {
    const src = read('../settings.ts');
    // 与命令行收割脚本同一个 renderHarvestedModule——两条入口的产物必须逐字
    // 相同，否则「设置页收割的」和「脚本收割的」会分家。
    expect(src).toContain('renderHarvestedModule([...HARVESTED_CASES, ...added])');
    expect(src).toContain('harvestCasesFromLog(entries, ALL_CASES');
    // 被收割的就是面板里看见的那批账（排期插话也在内，回合级路由不在）。
    expect(src).toContain("getInputDecisionLog().filter((entry) => entry.source !== 'turn-route')");
  });

  it('趋势走审计的批次口径，收割时记下这一轮', () => {
    const src = read('../settings.ts');
    // 遵守率只有一个口径（insertionAudit 的 auditTrend/auditSummary），面板不
    // 自己再数一遍——两处算法分家的话，趋势与疑点标记会互相矛盾。
    expect(src).toContain('this.renderInsertionTrend(entries)');
    expect(src).toContain('auditTrend(entries)');
    expect(src).toContain('auditSummary(entries)');
    // 收割那一刻的疑点率一起落盘：下一轮才有对照。
    expect(src).toContain('recordHarvestRound({ ts: Date.now(), harvested: added.length, rate: summary.rate, total: summary.total })');
  });

  it('每行带场景徽章；被标疑点的行把完整场景展开出来', () => {
    // 「判错了」只有配上「在什么场景下判的」才可行动：同一句换场景能从错到对
    // （我在西安 chatter→premise-change）。所以场景既要能扫（徽章），也要能读全
    // （疑点行展开 + 每行 hover）。
    const src = read('../settings.ts');
    expect(src).toContain('describeInsertionScene(entry.inputContext)');
    expect(src).toContain('insertion-diag-scene');
    expect(src).toContain('insertion-diag-scene-full');
    expect(src).toContain('title="${escapeHtml(entry.inputContext)}"');
    // 只有被标疑点的行才展开：否则日志一眼看不到头。
    expect(src).toContain('anomalies.length > 0 && entry.inputContext');
    // 没记下场景的行（排期插话）不挂徽章，也不拿空文案占位。
    expect(src).toContain("scene.key === 'unrecorded'");
    expect(src).toContain('${sceneLabel ?');
  });

  it('场景的样式与文案齐备', () => {
    const css = read('../styles.css');
    for (const cls of ['insertion-diag-scene', 'insertion-diag-scene-full']) {
      expect(css).toContain(`.${cls}`);
    }
    const i18n = read('../../shared/i18n.ts');
    for (const key of [
      'insertionDiag.scene.thinking',
      'insertionDiag.scene.inflight',
      'insertionDiag.scene.executing',
      'insertionDiag.sceneFull',
    ]) {
      expect(i18n.split(`'${key}':`).length - 1).toBeGreaterThanOrEqual(2);
    }
  });

  it('趋势的样式与文案齐备（柱条类名对得上）', () => {
    const css = read('../styles.css');
    const src = read('../settings.ts');
    // 面板画出来的类名必须在样式表里真的有，否则趋势只是一排看不见的 div。
    for (const cls of ['insertion-diag-trend', 'insertion-diag-trend-bars', 'insertion-diag-trend-bar', 'insertion-diag-trend-rounds']) {
      expect(src).toContain(cls);
      expect(css).toContain(`.${cls}`);
    }
    expect(css).toContain('.insertion-diag-trend-bar.has-anomaly');
    const i18n = read('../../shared/i18n.ts');
    for (const key of [
      'insertionDiag.trend',
      'insertionDiag.trendCaption',
      'insertionDiag.trendBarTitle',
      'insertionDiag.trendNone',
      'insertionDiag.trendRounds',
      'insertionDiag.trendNoRounds',
    ]) {
      expect(i18n.split(`'${key}':`).length - 1).toBeGreaterThanOrEqual(2);
    }
  });

  it('没有疑点时按钮点不动', () => {
    const src = read('../settings.ts');
    expect(src).toContain('harvestBtn.disabled = anomalyCount === 0');
  });

  it('文案两种语言都在（中文缺键会静默回落到英文，所以逐字查）', () => {
    // 不用 setLanguage/t()：那是全局状态，改它会污染同进程的其他测试文件。
    // 直接读文案源：每个键必须出现两次（zh + en），且第一次（zh 字典）那行
    // 必须真的写的是中文。
    const src = read('../../shared/i18n.ts');
    for (const key of [
      'insertionDiag.harvest',
      'insertionDiag.harvestHint',
      'insertionDiag.harvestNone',
      'insertionDiag.harvested',
    ]) {
      const hits = src.split(`'${key}':`).length - 1;
      expect(hits).toBeGreaterThanOrEqual(2);
      const line = src.slice(src.indexOf(`'${key}':`)).split('\n')[0];
      expect(/[\u4e00-\u9fff]/.test(line)).toBe(true);
    }
  });
});
