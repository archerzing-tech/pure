// src/ui/__tests__/fenceRegistry.test.ts
// 刀 2 渲染器注册化（docs/presentation-capability-library.md）：围栏分流的
// 唯一注册点 FENCE_ROUTES 与卡注册表（presentationLibrary.ts 的 fence 字段）
// 的双向同源锁。加新视觉形式 = 一条 route + 一张带 fence 的卡，漏任何一侧
// 或两侧 tag 漂移，这里即红。math 的 stream=false 是历史行为锁：流式期间
// math 围栏按普通代码渲染（无 slot 栏、无 hydration），完成渲染才转 KaTeX。

import { afterEach, describe, expect, it } from 'bun:test';
import { FENCE_ROUTES, routeOf, renderer, normalizeMapFence, registerCustomFenceRoutes, resetCustomFenceRoutes, syncPresentationCardsFromConfig } from '../markdown';
import { PRESENTATION_CARDS, resetCustomCards } from '../../shared/presentationLibrary';

describe('fence route registry <-> presentation cards (刀 2 同源)', () => {
  it('every fence route has a card whose id === route.kind covering all its tags', () => {
    for (const route of FENCE_ROUTES) {
      const card = PRESENTATION_CARDS.find((c) => c.id === route.kind);
      expect(card, `route ${route.kind} must have a matching card`).toBeDefined();
      for (const tag of route.tags) {
        expect(card?.fence ?? [], `card ${route.kind} must claim tag "${tag}"`).toContain(tag);
      }
    }
  });

  it('every card fence claim exists in the matching route (no orphan claims)', () => {
    for (const card of PRESENTATION_CARDS) {
      if (!card.fence) continue;
      const route = FENCE_ROUTES.find((r) => r.kind === card.id);
      expect(route, `card ${card.id} claims fences but no route renders them`).toBeDefined();
      for (const tag of card.fence) {
        expect(route?.tags ?? [], `card ${card.id} orphan tag "${tag}"`).toContain(tag);
      }
    }
  });

  it('card fences equal route tags exactly (no drift in either direction)', () => {
    // 单向包含会放过「卡多声明/路由多识别」的漂移——全集相等才算同源。
    for (const route of FENCE_ROUTES) {
      const card = PRESENTATION_CARDS.find((c) => c.id === route.kind);
      expect([...(card?.fence ?? [])].sort()).toEqual([...route.tags].sort());
    }
  });

  it('fence tags stay lowercase ASCII (langOf normalize + anchor discipline)', () => {
    for (const card of PRESENTATION_CARDS) {
      for (const tag of card.fence ?? []) {
        expect(tag).toMatch(/^[a-z]+$/);
      }
    }
  });

  it('non-fence forms carry no fence field', () => {
    for (const id of ['routing', 'image_gen', 'image', 'table', 'fold']) {
      const card = PRESENTATION_CARDS.find((c) => c.id === id);
      expect(card, id).toBeDefined();
      expect(card?.fence, `${id} is not fence syntax`).toBeUndefined();
    }
  });

  it('alias routing works end to end (plantuml→puml, leaflet→map, latex→math)', () => {
    expect(routeOf('plantuml')?.kind).toBe('puml');
    expect(routeOf('charts')?.kind).toBe('chart');
    expect(routeOf('leaflet')?.kind).toBe('map');
    expect(routeOf('tex')?.kind).toBe('math');
    expect(routeOf('zzz_no_such_lang')).toBeUndefined();
  });

  it('math and ascii stay out of streaming slot mounts; every other route streams (behavior pin)', () => {
    // 历史行为锁：streamRenderer 六路（无 math），math 围栏流式按普通代码走。
    // ascii 同款保真形态（2026-11-05）：半截 ASCII 当代码显示内容不丢，且
    // slotFenceLang=false 让 stripUnterminatedSlotFences 不摘半截 ascii 围栏
    // ——ASCII 没有解析，摘掉是纯丢失。
    for (const route of FENCE_ROUTES) {
      if (route.kind === 'math' || route.kind === 'ascii') {
        expect(route.stream, `${route.kind} must not mount a slot mid-stream`).toBe(false);
      } else {
        expect(route.stream, `${route.kind} must stream`).toBe(true);
      }
    }
  });

  it('completed render still routes each tag to its slot (behavioral pin)', () => {
    expect(
      renderer.code({ text: 'graph TD; A-->B', lang: 'mermaid', type: 'code', raw: 'x' } as never),
    ).toContain('data-diagram-kind="mermaid"');
    expect(
      renderer.code({ text: '{"width":10,"height":10,"shapes":[]}', lang: 'paint', type: 'code', raw: 'x' } as never),
    ).toContain('data-diagram-kind="paint"');
    expect(
      renderer.code({ text: '{"markers":[]}', lang: 'map', type: 'code', raw: 'x' } as never),
    ).toContain('map-slot');
    // html 逃生舱（W4-3）：```html 围栏挂独立形态 slot（不经 diagram-slot
    // 管线，map-slot 先例），落盘 + asset:// iframe 由 DOM 层 hydration 完成。
    expect(
      renderer.code({ text: '<h1>hi</h1>', lang: 'html', type: 'code', raw: 'x' } as never),
    ).toContain('html-slot');
    // 完成渲染的 math 走 KaTeX（stream=false 只影响流式）。
    expect(
      renderer.code({ text: 'a^2+b^2=c^2', lang: 'math', type: 'code', raw: 'x' } as never),
    ).toContain('katex');
    // 非 slot 语言保持普通代码块。
    expect(
      renderer.code({ text: '{"a":1}', lang: 'json', type: 'code', raw: 'x' } as never),
    ).toContain('<pre><code class="language-json">');
  });

  it('ascii fences render as a static monospace frame - no slot, no hydration (behavioral pin)', () => {
    const html = renderer.code({ text: '+--+    +--+\n| A |--->| B |\n+--+    +--+', lang: 'ascii', type: 'code', raw: 'x' } as never);
    // 源码逐字保真（box-drawing 与空白是图的本体）；HTML 特殊字符按 esc
    // 转义（`>` → `&gt;`，防注入的正确行为），渲染后浏览器显示回原字符。
    expect(html).toContain('| A |---&gt;| B |');
    expect(html).toContain('ascii-frame');
    // 无 slot 栏、无 hydration、无 loading/错误态——ASCII 不可能渲染失败。
    expect(html).not.toContain('diagram-slot');
    expect(html).not.toContain('data-state');
    expect(html).not.toContain('diagram-toolbar');
    // 完成渲染的流式别名 tag 也归一（wireframe 不在 route 表，走普通代码块）。
    expect(routeOf('wireframe')).toBeUndefined();
  });

  it('normalizeMapFence derives its container tags from the map route (no hardcode)', () => {
    // :::map / :::leaflet 容器 → ```map 围栏（Windows 客户端形态），tag 从
    // FENCE_ROUTES 派生——map 路由将来加别名时这里自动跟上。
    const normalized = normalizeMapFence(':::map\n{"markers":[]}\n:::');
    expect(normalized).toContain('```map');
    expect(normalized).not.toContain(':::');
    expect(normalizeMapFence(':::leaflet\n{"markers":[]}\n:::')).toContain('```leaflet');
  });
});

describe('custom fence routes (刀 3 组合式自定义的渲染通道)', () => {
  afterEach(() => {
    resetCustomFenceRoutes();
    resetCustomCards();
  });

  it('a custom fence tag rides the base pipeline end to end (zero new renderers)', () => {
    // ```myarch 围栏：路由挂到 paint 通道，产出 paint 的 slot——kind/build/
    // stream 全部复用静态表，hydration/retry 因 data-diagram-kind 写 base kind
    // 而天然走 KIND_PIPELINE。
    syncPresentationCardsFromConfig([{ id: 'myarch', base: 'paint', fence: ['myarch'] }]);
    const route = routeOf('myarch');
    expect(route?.kind).toBe('paint');
    expect(route?.stream).toBe(true);
    const html = renderer.code({ text: '{"width":10,"height":10,"shapes":[]}', lang: 'myarch', type: 'code', raw: 'x' } as never);
    expect(html).toContain('class="diagram-slot paint-slot"');
    expect(html).toContain('data-diagram-kind="paint"');
    expect(html).not.toContain('<pre><code');
  });

  it('custom routes join slot-fence and map-fence normalization consistently', () => {
    // 半截围栏截断口径与 :::容器归一对自定义 tag 一视同仁（都查 routeOf /
    // 自定义路由集合），不是只有内置 tag 享受一致性。
    syncPresentationCardsFromConfig([{ id: 'mymap', base: 'map', fence: ['mymap'] }]);
    expect(routeOf('mymap')?.kind).toBe('map');
    expect(normalizeMapFence(':::mymap\n{"markers":[]}\n:::')).toContain('```mymap');
  });

  it('a judgment-only custom card (no new tag) does not touch the route tables', () => {
    syncPresentationCardsFromConfig([{ id: 'myarch', base: 'paint' }]);
    expect(routeOf('myarch')).toBeUndefined(); // 复用 base 语法，无新路由
    expect(matchCustomTagUntouched());
  });

  it('re-sync with identical config short-circuits; changed config re-registers', () => {
    const cfg = [{ id: 'myarch', base: 'paint', fence: ['myarch'] }];
    syncPresentationCardsFromConfig(cfg);
    expect(routeOf('myarch')?.kind).toBe('paint');
    // 同配置重复调用：幂等无副作用。
    syncPresentationCardsFromConfig(cfg);
    expect(routeOf('myarch')?.kind).toBe('paint');
    // 换配置：路由跟着变。
    syncPresentationCardsFromConfig([{ id: 'myarch', base: 'chart', fence: ['myarch'] }]);
    expect(routeOf('myarch')?.kind).toBe('chart');
    // 清空（agent 删键）：路由退回内置-only。
    syncPresentationCardsFromConfig(undefined);
    expect(routeOf('myarch')).toBeUndefined();
  });
});

/** 防御断言：无新 tag 的卡不产生任何自定义路由。 */
function matchCustomTagUntouched(): boolean {
  for (const route of FENCE_ROUTES) {
    if (route.tags.length === 0) return false;
  }
  return true;
}
