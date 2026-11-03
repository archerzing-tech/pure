// src/ui/__tests__/fenceRegistry.test.ts
// 刀 2 渲染器注册化（docs/presentation-capability-library.md）：围栏分流的
// 唯一注册点 FENCE_ROUTES 与卡注册表（presentationLibrary.ts 的 fence 字段）
// 的双向同源锁。加新视觉形式 = 一条 route + 一张带 fence 的卡，漏任何一侧
// 或两侧 tag 漂移，这里即红。math 的 stream=false 是历史行为锁：流式期间
// math 围栏按普通代码渲染（无 slot 栏、无 hydration），完成渲染才转 KaTeX。

import { describe, expect, it } from 'bun:test';
import { FENCE_ROUTES, routeOf, renderer, normalizeMapFence } from '../markdown';
import { PRESENTATION_CARDS } from '../../shared/presentationLibrary';

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

  it('math stays out of streaming slot mounts; every other route streams (behavior pin)', () => {
    // 历史行为锁：streamRenderer 六路（无 math），math 围栏流式按普通代码走。
    for (const route of FENCE_ROUTES) {
      if (route.kind === 'math') {
        expect(route.stream, 'math must not mount a slot mid-stream').toBe(false);
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
    // 完成渲染的 math 走 KaTeX（stream=false 只影响流式）。
    expect(
      renderer.code({ text: 'a^2+b^2=c^2', lang: 'math', type: 'code', raw: 'x' } as never),
    ).toContain('katex');
    // 非 slot 语言保持普通代码块。
    expect(
      renderer.code({ text: '{"a":1}', lang: 'json', type: 'code', raw: 'x' } as never),
    ).toContain('<pre><code class="language-json">');
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
