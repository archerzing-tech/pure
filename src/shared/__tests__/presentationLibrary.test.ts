// src/shared/__tests__/presentationLibrary.test.ts
// 表现形式库（2026-11-02 docs/presentation-capability-library.md）语义卡的
// 契约测试：卡完整性（判据两面都要有，防只说好处的卡催生过度可视化）、
// detail 与 promptLayers DSL 常量的同引用（防复制分叉——PlantUML 归一化
// 单源判例同款）、匹配路由、目录/全文渲染、全 ASCII（sidecar 特征串锚
// 三形态全灭判例——卡片会被打进 sidecar，锚必须可 grep）。

import { describe, expect, it } from 'bun:test';
import {
  PRESENTATION_CARDS,
  PRESENTATION_FAMILIES,
  matchPresentationCards,
  renderPresentationCard,
  renderPresentationCatalog,
} from '../presentationLibrary';
import {
  CHART_DSL_PROMPT,
  IMAGE_GEN_OUTPUT_PROMPT,
  MAP_DSL_PROMPT,
  PAINT_DSL_PROMPT,
  SVG_OUTPUT_PROMPT,
} from '../promptLayers';

describe('presentation library cards', () => {
  it('every card carries both sides of the judgment and a delivery contract', () => {
    const ids = PRESENTATION_CARDS.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length); // id 唯一
    for (const card of PRESENTATION_CARDS) {
      expect(card.title.length, `${card.id}.title`).toBeGreaterThan(0);
      expect(card.trigger.length, `${card.id}.trigger`).toBeGreaterThan(0);
      expect(card.whenToUse.length, `${card.id}.whenToUse`).toBeGreaterThan(0);
      // 负面判据必须非空：没有「何时别用」的卡会催生过度可视化。
      expect(card.whenNotToUse.length, `${card.id}.whenNotToUse`).toBeGreaterThan(0);
      expect(card.delivery.length, `${card.id}.delivery`).toBeGreaterThan(0);
      expect(card.surfaces.length, `${card.id}.surfaces`).toBeGreaterThan(0);
      expect(PRESENTATION_FAMILIES, `${card.id}.family`).toContain(card.family);
    }
  });

  it('detail fields reference the DSL constants by identity, not a copy (single source)', () => {
    // 同引用断言防分叉：DSL 改了卡片必须跟着变，出现两份文本就是分叉开始。
    const byId = Object.fromEntries(PRESENTATION_CARDS.map((card) => [card.id, card]));
    expect(byId.chart?.detail).toBe(CHART_DSL_PROMPT);
    expect(byId.map?.detail).toBe(MAP_DSL_PROMPT);
    expect(byId.paint?.detail).toBe(PAINT_DSL_PROMPT);
    expect(byId.svg?.detail).toBe(SVG_OUTPUT_PROMPT);
    expect(byId.image_gen?.detail).toBe(IMAGE_GEN_OUTPUT_PROMPT);
  });

  it('own card fields stay pure ASCII (sidecar feature-anchor discipline)', () => {
    // sidecar 中文锚不可靠判例（v3.6.6）：bun compile 字节码字符串分段编码，
    // 中文特征串 grep 三形态全灭。本库**自有字段**（判据/触发/交付纪律）全
    // ASCII ⇒ 永远可验证；detail 是单源引用的既有 DSL 常量，其中文示例句
    // 是既定现实（各自契约测试已锁），豁免。
    for (const card of PRESENTATION_CARDS) {
      const { detail: _detail, ...own } = card;
      const serialized = JSON.stringify(own);
      expect(/^[\x20-\x7E]*$/.test(serialized), `${card.id} own fields must be ASCII-only`).toBe(true);
    }
  });

  it('matches by id, alias, and family; unknown forms miss', () => {
    expect(matchPresentationCards('mermaid').map((c) => c.id)).toEqual(['mermaid']);
    expect(matchPresentationCards('plantuml').map((c) => c.id)).toEqual(['puml']);
    expect(matchPresentationCards('latex').map((c) => c.id)).toEqual(['math']);
    // 族名一次拉全族。
    expect(matchPresentationCards('illustration').map((c) => c.id).sort()).toEqual(['paint', 'svg']);
    // 子串容错 + 空串/未知未命中。
    expect(matchPresentationCards('map').map((c) => c.id)).toContain('map');
    expect(matchPresentationCards('zzz_no_such_form')).toEqual([]);
    expect(matchPresentationCards('')).toEqual([]);
  });

  it('catalog lists every id with a next-step hint; card render carries the full contract', () => {
    const catalog = renderPresentationCatalog();
    for (const card of PRESENTATION_CARDS) {
      expect(catalog).toContain(`- ${card.id} (${card.family})`);
    }
    expect(catalog).toContain('form:"<id>"');
    const rendered = renderPresentationCard(matchPresentationCards('chart')[0]);
    expect(rendered).toContain('── chart (data-viz)');
    expect(rendered).toContain('Trigger: ');
    expect(rendered).toContain('Use when: ');
    expect(rendered).toContain('Avoid when: ');
    expect(rendered).toContain('Delivery & failure: ');
    expect(rendered).toContain('Surfaces: ');
    expect(rendered).toContain(CHART_DSL_PROMPT.slice(0, 60)); // detail 全文在场
  });

  it('covers the mutually-exclusive routing judgments as real cards', () => {
    // 互斥判例上锁（map-is-never-SVG / paint-vs-svg / chart-vs-table）：
    // 这些句子是模型行为判据，从常驻细则下放成卡片后由这里守住。
    const byId = Object.fromEntries(PRESENTATION_CARDS.map((card) => [card.id, card]));
    expect(byId.map?.whenNotToUse).toContain('A MAP IS NEVER SVG');
    expect(byId.paint?.delivery).toContain('NEVER switch to SVG');
    expect(byId.chart?.whenNotToUse).toContain('GFM table');
  });

  it('carries the form-choice decision logic as a meta card (2026-11-02 用户定调)', () => {
    // 「形式跟着用途走」决策序列固化：版面 vs 拓扑（语义重心）、一次性 vs
    // 长期演进（生命周期）、读者与规模。routing 放目录首位——先决策再拉
    // 胜出形式的卡；判据写给人看（工具结果卡里用户直接可见）。
    const routing = PRESENTATION_CARDS.find((card) => card.id === 'routing');
    expect(routing?.family).toBe('meta');
    expect(PRESENTATION_CARDS[0]?.id).toBe('routing'); // 目录首位
    expect(routing?.whenNotToUse).toContain('it routes, it does not render');
    const detail = routing?.detail ?? '';
    expect(detail).toContain('Decision path, in order');
    expect(detail).toContain('TOPOLOGY'); // 拓扑重心 -> mermaid
    expect(detail).toContain('the layout IS the semantic'); // 版面重心 -> paint/svg
    expect(detail).toContain('One-shot'); // 一次性讲给人听
    expect(detail).toContain('evolving with the code'); // 长期演进翻 mermaid
    expect(detail).toContain('~30 nodes'); // 规模闸
    expect(detail).toContain('SAME form'); // 失败修正不换形式
    // 生命周期让位句双卡呼应。
    const byId = Object.fromEntries(PRESENTATION_CARDS.map((card) => [card.id, card]));
    expect(byId.mermaid?.whenToUse).toContain('evolve with the code');
    expect(byId.paint?.whenNotToUse).toContain('expensive to maintain');
  });
});
