// src/ui/__tests__/markdownFallback.test.ts
// 2026-11-16 bug2 二刀：渲染失败不许把整条气泡打回 markdown 源码。
// 覆盖两层兜底：
//   ① renderMarkdownFallback —— 完整管线 parse 级失败时的最小渲染
//      （标题/粗体/代码围栏至少成形，不再是一屏 `##`、`**`、``` 源码）；
//   ② 阶段隔离接线锁 —— innerHTML 装好之后的高亮/链接/图卡/绑定任一阶段
//      抛错都只记日志、不擦已渲染的 DOM。

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Same pass-through rationale as mapStreaming/paintStreaming: trusted fixtures,
// and happy-dom has no real DOMPurify window. This file tests the parse/render
// fallback shape, not sanitization (sanitization has its own coverage).
mock.module('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const { renderMarkdownFallback } = await import('../markdown');

describe('renderMarkdownFallback — 最小渲染兜底', () => {
  it('标题 / 粗体 / 代码围栏都成形，不再是一屏源码', () => {
    const el = document.createElement('div');
    const ok = renderMarkdownFallback(
      '## 结论\n\n这是 **重点** 内容。\n\n```js\nconst a = 1;\n```',
      el,
    );
    expect(ok).toBe(true);
    expect(el.querySelector('h2')?.textContent).toBe('结论');
    expect(el.querySelector('strong')?.textContent).toBe('重点');
    expect(el.querySelector('pre code')?.textContent).toContain('const a = 1;');
    // 与完成态同款的 md-rendered 标记（空白折叠规则一致）。
    expect(el.classList.contains('md-rendered')).toBe(true);
  });

  it('中文无空格块标记同样归一化（##标题 → h2）', () => {
    const el = document.createElement('div');
    expect(renderMarkdownFallback('##标题\n正文', el)).toBe(true);
    expect(el.querySelector('h2')?.textContent).toBe('标题');
  });

  it('未闭合的 slot 围栏先剥掉：半截图卡数据不拖垮整条兜底', () => {
    const el = document.createElement('div');
    const ok = renderMarkdownFallback('前言\n\n```mermaid\ngraph TD;\nA-->B', el);
    expect(ok).toBe(true);
    expect(el.textContent).toContain('前言');
  });
});

describe('渲染管线阶段隔离（接线锁）', () => {
  const src = readFileSync(new URL('../markdown.ts', import.meta.url), 'utf8');

  it('innerHTML 之后的后处理阶段逐个包在 renderStage 里', () => {
    for (const stage of ['bind-images', 'highlight', 'linkify', 'diagrams', 'bind-controls', 'code-actions', 'followups']) {
      expect(src).toContain(`renderStage('${stage}'`);
    }
  });

  it('katex 加载失败只让公式保持源码，不连累整条消息', () => {
    expect(src).toContain('katex unavailable (math stays source)');
  });

  it('流式期单块渲染失败只降级该块，后续块继续渲染', () => {
    expect(src).toContain('block render failed (raw fallback');
    expect(src).toContain('streaming render failed; keeping last frame');
  });

  it('loader 兜底先试最小渲染，再退回原文', () => {
    const loader = readFileSync(new URL('../markdownLoader.ts', import.meta.url), 'utf8');
    expect(loader).toContain('renderMarkdownFallback(text, container)');
    expect(loader).toContain('container.textContent = text;');
  });
});
