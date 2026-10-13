import { describe, it, expect } from 'bun:test';
import { createDefaultRichRenderers, normalizePlantumlSource } from '../headlessRenderer';
import { readDevToolsPort } from '../headlessChrome';

describe('normalizePlantumlSource', () => {
  it('wraps a bare body in @startuml/@enduml', () => {
    expect(normalizePlantumlSource('A -> B')).toEqual(['@startuml', 'A -> B', '@enduml']);
  });

  it('keeps well-formed source and only trims blank edges', () => {
    expect(normalizePlantumlSource('\n@startuml\nA -> B\n@enduml\n')).toEqual(['@startuml', 'A -> B', '@enduml']);
  });

  it('closes a diagram whose @enduml the model forgot', () => {
    expect(normalizePlantumlSource('@startuml\nA -> B')).toEqual(['@startuml', 'A -> B', '@enduml']);
  });

  it('normalizes CRLF line endings', () => {
    expect(normalizePlantumlSource('@startuml\r\nA -> B\r\n@enduml')).toEqual(['@startuml', 'A -> B', '@enduml']);
  });

  it('returns nothing for blank input', () => {
    expect(normalizePlantumlSource('   \n\n')).toEqual([]);
  });
});

describe('createDefaultRichRenderers', () => {
  it('always covers chart and svg', () => {
    const renderers = createDefaultRichRenderers();
    expect(typeof renderers.chartToPng).toBe('function');
    expect(typeof renderers.svgToPng).toBe('function');
    renderers.dispose?.();
  });
});

// 审计批 6① — 截止时间必须约束到 stderr 的 read 本身。launch 用假进程不可
// 行，deadline 行为只能真测：假 Subprocess 只带一个可控的 stderr 流。
describe('readDevToolsPort (审计批 6①)', () => {
  const asSubprocess = (stderr: unknown) => ({ stderr }) as import('bun').Subprocess;

  it('parses the port from the stderr banner', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('DevTools listening on ws://127.0.0.1:9222/devtools/browser/x\n'));
      },
    });
    expect(await readDevToolsPort(asSubprocess(stream), 1_000)).toBe(9222);
  });

  // 回归主体：Chrome 启动挂死时 stderr 一个字节都不来，旧的「读间隙查表」
  // 让 await 永远悬着、launch 永不返回。新代码在 deadline 内收场。
  it('returns null within the deadline when stderr stays silent', async () => {
    const started = Date.now();
    const port = await readDevToolsPort(asSubprocess(new ReadableStream({ start() { /* 永不 enqueue */ } })), 200);
    expect(port).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000); // 旧代码在这里悬死到测试超时
  });

  it('returns null when the stream closes without a banner', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('some noise\n'));
        controller.close();
      },
    });
    expect(await readDevToolsPort(asSubprocess(stream), 1_000)).toBeNull();
  });
});
