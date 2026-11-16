// src/ui/__tests__/markdownBlockStreaming.test.ts
// streamingRender=false 的块级流式渲染（2026-11-16）：
//   • closedBlockPrefix 只认「空行 / 收尾围栏」两种块边界，围栏内空行不算；
//   • scheduleBlockRender 把已闭合前缀按正常管线渲染，未闭合尾段保持原文并
//     逐 token 增量追加（不是每 token 全文重建）；
//   • 收口（工具行/完成前）flushBlockRender 把尾段也渲染掉。

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

mock.module('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

const { closedBlockPrefix, scheduleBlockRender, flushBlockRender, cancelBlockRender } = await import('../markdown');

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const containers: HTMLElement[] = [];
function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  containers.push(el);
  return el;
}

afterEach(() => {
  for (const el of containers.splice(0)) {
    cancelBlockRender(el);
    el.remove();
  }
});

describe('closedBlockPrefix — 只认真正的块边界', () => {
  it('空行切断：前面的段落完整，后面是尾部', () => {
    expect(closedBlockPrefix('## 标题\n\n正文还在写')).toBe('## 标题\n\n');
  });

  it('行尾单个换行不算闭合（段落可能还没写完）', () => {
    expect(closedBlockPrefix('第一段\n')).toBe('');
    expect(closedBlockPrefix('第一段')).toBe('');
  });

  it('围栏内部的空行不切断', () => {
    const src = '```js\nconst a = 1;\n\nconst b = 2;\n';
    expect(closedBlockPrefix(src)).toBe('');
  });

  it('收尾围栏本身即边界（代码块闭合就不用等空行）', () => {
    const src = '```js\nconst a = 1;\n```\n后文';
    expect(closedBlockPrefix(src)).toBe('```js\nconst a = 1;\n```\n');
  });

  it('围栏后的空行继续推进边界', () => {
    const src = '前言\n\n```js\nx\n```\n\n尾部';
    expect(closedBlockPrefix(src)).toBe('前言\n\n```js\nx\n```\n\n');
  });

  it('没有可信边界时返回空串（整段都算尾部原文）', () => {
    expect(closedBlockPrefix('')).toBe('');
    expect(closedBlockPrefix('只有一句话')).toBe('');
  });
});

describe('scheduleBlockRender — 闭合块渲染 + 尾段原文', () => {
  it('首个闭合块立即渲染，未闭合尾段保持原文', () => {
    const el = makeContainer();
    scheduleBlockRender('## 结论\n\n第一段还没写完', el);
    // 标题是闭合块：已经是 h2
    expect(el.querySelector('h2')?.textContent).toBe('结论');
    // 尾段原文直出，且是本拍新增的那部分
    const tail = el.querySelector('.stream-block-tail');
    expect(tail?.textContent).toBe('第一段还没写完');
    // 原文里的 markdown 标记原样保留（没被提前解析）
    expect(el.textContent).not.toContain('## 结论');
  });

  it('尾段逐 token 增量追加，不重建整个气泡', () => {
    const el = makeContainer();
    scheduleBlockRender('## 结论\n\n第一段', el);
    const tail = el.querySelector('.stream-block-tail')!;
    scheduleBlockRender('## 结论\n\n第一段继续', el);
    // 同一个尾段节点、文本继续增长（append 而不是 replaceChildren 重建）
    expect(el.querySelector('.stream-block-tail')).toBe(tail);
    expect(tail.textContent).toBe('第一段继续');
    // 已闭合的标题节点保持同一个（没有整条重绘）
    const h2 = el.querySelector('h2')!;
    scheduleBlockRender('## 结论\n\n第一段继续写', el);
    expect(el.querySelector('h2')).toBe(h2);
  });

  it('新空行到达后（节流窗口内）块在收口时补渲染，尾段清空', () => {
    const el = makeContainer();
    scheduleBlockRender('## 标题\n\n第一段', el);
    // 第二段写完后才有空行 → 前缀推进，但节流窗口内先挂起
    scheduleBlockRender('## 标题\n\n第一段\n\n第二段', el);
    flushBlockRender(el);
    expect(el.querySelector('h2')?.textContent).toBe('标题');
    const paras = Array.from(el.querySelectorAll('p')).map((p) => p.textContent);
    expect(paras).toEqual(['第一段', '第二段']);
    expect(el.querySelector('.stream-block-tail')).toBeNull();
  });

  it('闭合的代码围栏按代码块渲染（等空行才渲染的旧观感不再出现）', () => {
    const el = makeContainer();
    scheduleBlockRender('```js\nconst a = 1;\n```\n\n说明', el);
    expect(el.querySelector('pre code')?.textContent).toContain('const a = 1;');
    expect(el.querySelector('.stream-block-tail')?.textContent).toBe('说明');
  });

  it('cancelBlockRender 清掉调度状态：下一段文本从头开始', () => {
    const el = makeContainer();
    scheduleBlockRender('## 标题\n\n尾', el);
    cancelBlockRender(el);
    expect(el.querySelector('.stream-block-tail')).toBeNull();
    // 状态已删：旧文本不会在别处复活
    expect(() => flushBlockRender(el)).not.toThrow();
  });
});
