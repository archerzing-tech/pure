// src/shared/__tests__/cliDiagram.test.ts

import { describe, expect, it } from 'bun:test';
import {
  CliWireframeStream,
  parseMermaid,
  parsePlantUml,
  renderWireframe,
  renderWireframeFromMarkdown,
} from '../cliDiagram';
import { takeFormValidationFeedback } from '../formValidationFeedback';

describe('parseMermaid', () => {
  it('extracts nodes, shapes, directions and edge labels', () => {
    const g = parseMermaid(`graph TD
      A[开始] --> B{需要验证?}
      B -->|是| C(执行测试)
      B -->|否| D[直接交付]
      C --> E((完成))`);
    expect(g).not.toBeNull();
    expect(g!.direction).toBe('TD');
    expect(g!.labels.get('A')).toBe('开始');
    expect(g!.labels.get('B')).toBe('需要验证?');
    expect(g!.labels.get('E')).toBe('完成');
    expect(g!.shapes.get('B')).toBe('diamond');
    expect(g!.shapes.get('E')).toBe('circle');
    expect(g!.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['A->B', 'B->C', 'B->D', 'C->E']);
    expect(g!.edges[1].label).toBe('是');
  });

  it('supports LR direction and flowchart keyword', () => {
    const g = parseMermaid(`flowchart LR
      A --> B
      B --> C`);
    expect(g!.direction).toBe('LR');
    expect(g!.edges).toHaveLength(2);
  });

  it('handles quoted labels and bare ids', () => {
    const g = parseMermaid('graph TD\nA["带 空格 的 名字"] --> B\nB --> C');
    expect(g!.labels.get('A')).toBe('带 空格 的 名字');
    expect(g!.labels.get('B')).toBe('B');
  });

  it('treats subgraph bodies as top-level nodes', () => {
    const g = parseMermaid(`graph TD
      subgraph 内部
        A --> B
      end
      B --> C`);
    expect(g!.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['A->B', 'B->C']);
  });

  it('returns null for a bare header with no content', () => {
    expect(parseMermaid('graph TD')).toBeNull();
  });
});

describe('parsePlantUml', () => {
  it('chains activity steps and continuations', () => {
    const g = parsePlantUml(`@startuml
      start
      :接收订单;
      --> 校验库存
      :扣减库存;
      --> :发货;
      stop
      @enduml`);
    expect(g).not.toBeNull();
    const steps = g!.labels;
    expect([...steps.values()]).toEqual(['接收订单', '校验库存', '扣减库存', '发货']);
    expect(g!.edges).toHaveLength(3);
  });

  it('parses sequence participants and message labels', () => {
    const g = parsePlantUml(`@startuml
      Alice -> Bob: 你好
      Bob --> Alice: 收到
      @enduml`);
    expect(g!.labels.get('Alice')).toBe('Alice');
    expect(g!.labels.get('Bob')).toBe('Bob');
    expect(g!.edges[0].label).toBe('你好');
    expect(g!.edges).toHaveLength(2);
  });

  it('returns null without any edges', () => {
    expect(parsePlantUml('@startuml\nstart\nstop\n@enduml')).toBeNull();
  });
});

describe('renderWireframe', () => {
  it('renders a TD mermaid graph as box-drawing wireframe', () => {
    const out = renderWireframe(`graph TD
      A[开始] --> B[处理]
      B --> C[完成]`, 'mermaid');
    expect(out).not.toBeNull();
    expect(out).toContain('┌');
    expect(out).toContain('│开 始 │');
    expect(out).toContain('│处 理 │');
    expect(out).toContain('│完 成 │');
    expect(out).toContain('▼');
    // Ranks stack vertically: A on top, C at the bottom.
    const lines = out!.split('\n');
    const a = lines.findIndex((l) => l.includes('开 始'));
    const c = lines.findIndex((l) => l.includes('完 成'));
    expect(a).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(a);
  });

  it('renders edge labels inside the wireframe', () => {
    const out = renderWireframe(`graph TD
      A[登录] -->|通过| B[首页]`, 'mermaid');
    expect(out).toContain('通');
  });

  it('renders LR graphs with boxes side by side', () => {
    const out = renderWireframe(`graph LR
      A[请求] --> B[网关]`, 'mermaid');
    const lines = out!.split('\n');
    const a = lines[1];
    const b = lines[1];
    expect(a.includes('请 求')).toBe(true);
    expect(b.includes('网 关')).toBe(true);
    expect(out).toContain('▶');
  });

  it('renders PlantUML activity flows', () => {
    const out = renderWireframe(`@startuml
      start
      :步骤一;
      --> :步骤二;
      stop
      @enduml`, 'puml');
    expect(out).not.toBeNull();
    expect(out).toContain('步 骤 一');
    expect(out).toContain('步 骤 二');
    expect(out).toContain('▼');
  });

  it('returns null for unsupported syntax', () => {
    expect(renderWireframe('graph TD', 'mermaid')).toBeNull();
    expect(renderWireframe('not a diagram at all', 'mermaid')).toBeNull();
  });

  it('keeps lines within the width cap', () => {
    const long = `graph LR\n${Array.from({ length: 12 }, (_, i) => `N${i}[标签标签标签标签标签] --> N${i + 1}[标签标签标签标签标签]`).join('\n')}`;
    const out = renderWireframe(long, 'mermaid');
    for (const line of out!.split('\n')) {
      expect([...line].length).toBeLessThanOrEqual(120);
    }
  });
});

describe('CliWireframeStream', () => {
  function collect(): { stream: CliWireframeStream; out: () => string } {
    let buffer = '';
    const stream = new CliWireframeStream((chunk) => { buffer += chunk; });
    return { stream, out: () => buffer };
  }

  it('streams prose through unchanged', () => {
    const { stream, out } = collect();
    stream.feed('你好，');
    stream.feed('世界');
    stream.flush();
    expect(out()).toBe('你好，世界');
  });

  it('converts a complete mermaid block into a wireframe (char-by-char)', () => {
    const { stream, out } = collect();
    const full = ['流程：', '', '```mermaid', 'graph TD', 'A --> B', '```', '', '完毕'].join('\n');
    for (const ch of full) stream.feed(ch);
    stream.flush();
    expect(out()).toContain('流程：');
    expect(out()).toContain('线框渲染');
    expect(out()).not.toContain('graph TD');
    expect(out()).toContain('完毕');
  });

  it('converts a puml block in one multi-line chunk', () => {
    const { stream, out } = collect();
    stream.feed(['```puml', '@startuml', ':A;', '--> :B;', '@enduml', '```'].join('\n'));
    stream.flush();
    expect(out()).toContain('线框渲染');
    expect(out()).not.toContain('@startuml');
  });

  it('passes non-diagram code blocks through raw', () => {
    const { stream, out } = collect();
    stream.feed('代码：\n```ts\nconst a = 1;\n```\n');
    stream.flush();
    expect(out()).toBe('代码：\n```ts\nconst a = 1;\n```\n');
  });

  it('flushes an unclosed fence as raw source instead of dropping it', () => {
    const { stream, out } = collect();
    stream.feed('```mermaid\ngraph TD\nA --> B');
    stream.flush();
    expect(out()).toContain('```mermaid');
    expect(out()).toContain('A --> B');
  });

  it('leaves a stray single backtick in prose intact', () => {
    const { stream, out } = collect();
    stream.feed('反引号 ` 结束');
    stream.flush();
    expect(out()).toBe('反引号 ` 结束');
  });

  it('projects a complete chart/map/paint block instead of dumping raw JSON (刀 4)', () => {
    const { stream, out } = collect();
    const full = ['数据：', '', '```chart', 'type: bar', '苹果 10', '香蕉 20', '```', '', '完'].join('\n');
    for (const ch of full) stream.feed(ch);
    stream.flush();
    expect(out()).toContain('数据：');
    expect(out()).toContain('文本投影');
    expect(out()).toMatch(/香蕉 \| █+ 20/); // 条形本体
    expect(out()).not.toContain('```chart');
    expect(out()).toContain('完');
  });

  it('projects the leaflet alias and a paint payload', () => {
    const { stream, out } = collect();
    stream.feed(['```leaflet', JSON.stringify({ markers: [{ lat: 34.34, lng: 108.94, title: '西安' }] }), '```'].join('\n'));
    stream.feed('\n');
    stream.feed(['```paint', JSON.stringify({ width: 100, height: 50, shapes: [{ type: 'rect', x: 1, y: 2, w: 3, h: 4 }] }), '```'].join('\n'));
    stream.flush();
    expect(out()).toContain('● 西安 — 34.34, 108.94');
    expect(out()).toContain('- rect (1,2) 3×4');
  });

  it('falls back to raw source when a projection form fails to parse', () => {
    takeFormValidationFeedback(); // 清场：模块级事件器跨文件共享（e46be4a 判例）
    const { stream, out } = collect();
    stream.feed(['```paint', 'not json', '```'].join('\n'));
    stream.flush();
    expect(out()).toContain('```paint');
    expect(out()).toContain('not json');
    expect(out()).not.toContain('文本投影');
    // 刀 6 CLI 面：回退不再是静默——失败事件已记，读走可验证（读即清）。
    const feedback = takeFormValidationFeedback();
    expect(feedback).toContain('paint FAILED');
    expect(feedback).toContain('projection unavailable');
    expect(takeFormValidationFeedback()).toBe('');
  });

  it('records a failed event when a wireframe render fails (刀 6)', () => {
    takeFormValidationFeedback(); // 清场：模块级事件器跨文件共享（e46be4a 判例）
    const { stream, out } = collect();
    stream.feed(['```mermaid', '这段文字不是 mermaid 语法', '```'].join('\n'));
    stream.flush();
    // 渲染不出来 → 源码照显（诚实降级），但事件必须回流给模型。
    expect(out()).toContain('```mermaid');
    expect(out()).toContain('不是 mermaid 语法');
    const feedback = takeFormValidationFeedback();
    expect(feedback).toContain('mermaid FAILED');
    expect(feedback).toContain('wireframe render failed');
  });
});

describe('renderWireframeFromMarkdown', () => {
  it('replaces diagram fences and preserves the rest', () => {
    const out = renderWireframeFromMarkdown(
      ['说明：', '', '```mermaid', 'graph LR', 'A --> B', '```', '', '完'].join('\n'),
    );
    expect(out).toContain('说明：');
    expect(out).toContain('线框渲染');
    expect(out).toContain('完');
    expect(out).not.toContain('graph LR');
  });

  it('keeps non-diagram fences verbatim', () => {
    const out = renderWireframeFromMarkdown('```python\nprint(1)\n```');
    expect(out).toBe('```python\nprint(1)\n```');
  });

  it('one-shot pass also projects chart/map/paint blocks (刀 4)', () => {
    const out = renderWireframeFromMarkdown(
      ['前文', '', '```map', JSON.stringify({ title: '路线', markers: [{ lat: 1.5, lng: 2.5, title: 'A 点' }] }), '```', '', '后文'].join('\n'),
    );
    expect(out).toContain('前文');
    expect(out).toContain('文本投影');
    expect(out).toContain('● A 点 — 1.5, 2.5');
    expect(out).not.toContain('```map');
    expect(out).toContain('后文');
  });

  it('returns the input unchanged when there is no fence', () => {
    const text = '普通文本，无代码块';
    expect(renderWireframeFromMarkdown(text)).toBe(text);
  });

  it('one-shot pass records projection failures too (刀 6)', () => {
    takeFormValidationFeedback(); // 清场：模块级事件器跨文件共享（e46be4a 判例）
    renderWireframeFromMarkdown(['```map', 'not json', '```'].join('\n'));
    const feedback = takeFormValidationFeedback();
    expect(feedback).toContain('map FAILED');
    expect(takeFormValidationFeedback()).toBe('');
  });
});
