// src/shared/__tests__/presentationLibrary.test.ts
// 表现形式库（2026-11-02 docs/presentation-capability-library.md）语义卡的
// 契约测试：卡完整性（判据两面都要有，防只说好处的卡催生过度可视化）、
// detail 与 promptLayers DSL 常量的同引用（防复制分叉——PlantUML 归一化
// 单源判例同款）、匹配路由、目录/全文渲染、全 ASCII（sidecar 特征串锚
// 三形态全灭判例——卡片会被打进 sidecar，锚必须可 grep）。

import { afterEach, describe, expect, it } from 'bun:test';
import {
  PRESENTATION_CARDS,
  PRESENTATION_FAMILIES,
  allPresentationCards,
  matchPresentationCards,
  registerCustomCards,
  renderPresentationCard,
  renderPresentationCatalog,
  resetCustomCards,
  type CustomCardInput,
} from '../presentationLibrary';
import {
  CHART_DSL_PROMPT,
  IMAGE_GEN_OUTPUT_PROMPT,
  MAP_DSL_PROMPT,
  PAINT_DSL_PROMPT,
  ROUTING_ESSENTIALS,
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

  it('fence fields follow the registry discipline (刀 2 渲染器注册化)', () => {
    // 围栏形式（与 ui/markdown.ts FENCE_ROUTES 同源的那七张）必须声明 fence
    // tag 全集；非围栏形式（routing/image_gen/image/table/fold）不得声明——
    // 双向同源锁在 src/ui/__tests__/fenceRegistry.test.ts。
    const FENCE_IDS = ['mermaid', 'puml', 'chart', 'map', 'svg', 'paint', 'math'];
    for (const card of PRESENTATION_CARDS) {
      if (FENCE_IDS.includes(card.id)) {
        expect(card.fence?.length, `${card.id} must claim its fence tags`).toBeGreaterThan(0);
      } else {
        expect(card.fence, `${card.id} is not fence syntax`).toBeUndefined();
      }
    }
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
    // 第 0 步：双交付纪律（真机判例 session_1793600755798_1 + 复测
    // session_1793602596186_3）——「图进 docs」是合法归宿，落盘是需求一部分；
    // 纪律不是「文件不是选项」而是先后有序：围栏先进聊天（权威版本），再存
    // 块源码到指定路径。无归宿明示时文件仍然不是聊天交付的替身。
    expect(detail).toContain('0. Fence first, file second');
    expect(detail).toContain('deliver BOTH');
    expect(detail).toContain('the authoritative version');
    // 归宿明示=存盘授权（三测判例：归宿当背景解读，围栏后落盘缺席）——
    // 同轮交付、自选文件名、不再反问。
    expect(detail).toContain('in the same turn');
    expect(detail).toContain('IS the authorization to save there');
    expect(detail).toContain('pick a sensible filename');
    expect(detail).toContain('never file-over-fence');
    expect(detail).toContain('TOPOLOGY'); // 拓扑重心 -> mermaid
    expect(detail).toContain('the layout IS the semantic'); // 版面重心 -> paint/svg
    expect(detail).toContain('One-shot'); // 一次性讲给人听
    expect(detail).toContain('evolving with the code'); // 长期演进翻 mermaid
    expect(detail).toContain('still a fenced block in the chat first'); // 演进判据不豁免铁律
    expect(detail).toContain('~30 nodes'); // 规模闸
    expect(detail).toContain('SAME form'); // 失败修正不换形式
    // 拉卡触发词客观化：请求提到图的归宿/读者即拉（主观 unsure 自信时不触发，
    // 同一真机判例）。
    expect(routing?.whenToUse).toContain('WHERE the visual will live');
    expect(routing?.whenToUse).toContain('whether or not you feel unsure');
    // 生命周期让位句双卡呼应。
    const byId = Object.fromEntries(PRESENTATION_CARDS.map((card) => [card.id, card]));
    expect(byId.mermaid?.whenToUse).toContain('evolve with the code');
    expect(byId.paint?.whenNotToUse).toContain('expensive to maintain');
    // 机械注入精要与卡共享铁律锚（两个载体一个口径）：精要注入给「没拉卡」
    // 的请求，卡全文给拉了的请求——两处的交付纪律句子必须逐字同锚。
    expect(ROUTING_ESSENTIALS).toContain('never file-over-fence');
    expect(ROUTING_ESSENTIALS).toContain('DOUBLE DELIVERY');
  });
});

describe('custom presentation cards (刀 3 组合式自定义)', () => {
  // 每个用例自带注册/清理——注册表是进程全局，跨文件污染判例（bun test
  // 单进程）要求用例间不串账。
  afterEach(() => resetCustomCards());

  it('registers a minimal card by inheriting everything from its base', () => {
    // 组合式封装的本意：只写想改的——{ id, base } 就该得到一张完整卡，
    // 判据/交付/细则全部继承 base（paint）。
    const { registered, rejected } = registerCustomCards([{ id: 'myarch', base: 'paint' }]);
    expect(rejected).toEqual([]);
    expect(registered).toEqual(['myarch']);
    const card = matchPresentationCards('myarch')[0];
    const paint = PRESENTATION_CARDS.find((c) => c.id === 'paint')!;
    expect(card.family).toBe('illustration'); // 族继承 base（paint 属 illustration 族）
    expect(card.title).toContain('(custom)');
    expect(card.whenToUse).toBe(paint.whenToUse);
    expect(card.detail).toBe(paint.detail);
    expect(card.fence).toEqual(['paint']); // 缺省复用 base 围栏语法
  });

  it('rewrites the trigger when the card brings its own fence tag', () => {
    const { rejected } = registerCustomCards([
      { id: 'myarch', base: 'paint', fence: ['myarch'], title: '我司架构图' },
    ]);
    expect(rejected).toEqual([]);
    const card = matchPresentationCards('myarch')[0];
    expect(card.fence).toEqual(['myarch']);
    expect(card.trigger).toContain('myarch');
    expect(card.trigger).toContain('paint pipeline');
  });

  it('rejects collisions and bad bases card-by-card without blocking the rest', () => {
    const { registered, rejected } = registerCustomCards([
      { id: 'mermaid', base: 'paint' }, // 撞内置 id
      { id: 'flow', base: 'chart', aliases: ['latex'] }, // 别名撞内置
      { id: 'bad base', base: 'zzz' }, // base 未知 + 坏 id
      { id: 'mychart', base: 'chart', fence: ['map'] }, // fence 撞内置 tag
      { id: 'okcard', base: 'chart', fence: ['oktag'] },
    ]);
    expect(registered).toEqual(['okcard']);
    expect(rejected.map((r) => r.id)).toEqual(['mermaid', 'flow', 'bad base', 'mychart']);
    expect(rejected.every((r) => r.reason.length > 0)).toBe(true);
  });

  it('rejects custom fence tags that are not lowercase ASCII (sidecar/anchor discipline)', () => {
    const { rejected } = registerCustomCards([{ id: 'mybox', base: 'paint', fence: ['MyBox'] }]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain('lowercase ASCII');
  });

  it('re-registering the same id updates in place (idempotent, no duplicates)', () => {
    registerCustomCards([{ id: 'myarch', base: 'paint', title: 'v1' }]);
    registerCustomCards([{ id: 'myarch', base: 'paint', title: 'v2' }]);
    const hits = allPresentationCards().filter((card) => card.id === 'myarch');
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('v2');
  });

  it('custom cards join the catalog, matching, and full-card rendering', () => {
    registerCustomCards([{ id: 'myarch', base: 'paint', whenToUse: '公司内部的三层架构草图' }]);
    // 目录含自定义卡 + 注册说明句（agent 怎么加新卡——设置 agent 化铁律）。
    const catalog = renderPresentationCatalog();
    expect(catalog).toContain('- myarch (illustration)');
    expect(catalog).toContain('presentationCards');
    // 匹配路由对自定义卡生效。
    expect(matchPresentationCards('myarch').map((c) => c.id)).toEqual(['myarch']);
    // 全卡渲染走同一渲染函数（工具返回体形态一致）。
    const rendered = renderPresentationCard(matchPresentationCards('myarch')[0]);
    expect(rendered).toContain('── myarch (illustration)');
    expect(rendered).toContain('公司内部的三层架构草图');
    // 合并视图：内置卡在前，自定义在后。
    const all = allPresentationCards();
    expect(all[all.length - 1].id).toBe('myarch');
    expect(all.length).toBe(PRESENTATION_CARDS.length + 1);
  });

  it('reset clears the runtime view (test isolation + re-registration works)', () => {
    registerCustomCards([{ id: 'myarch', base: 'paint' }]);
    expect(matchPresentationCards('myarch')).toHaveLength(1);
    resetCustomCards();
    expect(matchPresentationCards('myarch')).toEqual([]);
    expect(allPresentationCards()).toHaveLength(PRESENTATION_CARDS.length);
    // 重置后再注册不受「takenNames 占位残留」影响。
    const { rejected } = registerCustomCards([{ id: 'myarch', base: 'paint' }]);
    expect(rejected).toEqual([]);
  });

  it('a fully-specified custom card overrides every provided field', () => {
    const input: CustomCardInput = {
      id: 'myarch',
      base: 'paint',
      title: 'Architecture sketch',
      aliases: ['arch'],
      trigger: 'Fenced block tagged myarch',
      whenToUse: 'internal tier sketches',
      whenNotToUse: 'never for topology',
      delivery: 'same as paint',
      surfaces: 'gui only',
    };
    const { rejected } = registerCustomCards([input]);
    expect(rejected).toEqual([]);
    const card = matchPresentationCards('arch')[0];
    expect(card.title).toBe('Architecture sketch');
    expect(card.whenToUse).toBe('internal tier sketches');
    expect(card.whenNotToUse).toBe('never for topology');
    expect(card.delivery).toBe('same as paint');
    expect(card.surfaces).toBe('gui only');
  });
});
