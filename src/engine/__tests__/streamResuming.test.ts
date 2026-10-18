// src/engine/__tests__/streamResuming.test.ts
// 流式偶发中断的引擎层两修(2026-10-18):静默续跑过去零提示(缺口是一次
// 完整请求往返,几十秒,UI 读作「输出停住了」),已完成的回复会被「全文 ```
// 奇偶数」启发式误判截断而强制续写。钉住:行首 fence 判定的行为、两处
// StreamResuming yield、GUI 侧的开卡文案。源码钉为主——引擎行为测试需要
// 整条 mock 流,回报不成比例。
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const readSource = (url: URL): string => readFileSync(url, 'utf8').replace(/\r\n/g, '\n');

describe('silentlyTruncated 的行首 fence 判定', () => {
  // 与 AgentLoopEngine.ts 内联正则保持同一形状(CommonMark:fence 允许 ≤3 个
  // 前导空格)。
  const oddLineInitialFences = (content: string): boolean =>
    (content.match(/^[ \t]{0,3}```/gm) ?? []).length % 2 === 1;

  it('行内提到 ``` 不再误判为截断(旧行为的全文本计数会)', () => {
    expect(oddLineInitialFences('用 ``` 包代码是 markdown 语法,这一个回复就完了。')).toBe(false);
    expect('用 ``` 包代码是 markdown 语法。'.match(/```/g) ?? []).toHaveLength(1); // 旧判定会误伤
  });

  it('行首未闭合 fence 仍然命中(真截断)', () => {
    expect(oddLineInitialFences('前言\n```html\n<div>未闭合')).toBe(true);
  });

  it('≤3 空格缩进的 fence 算行首,4 空格不算(CommonMark)', () => {
    expect(oddLineInitialFences('前言\n ```js\ncode')).toBe(true);
    expect(oddLineInitialFences('前言\n    ```js\ncode')).toBe(false);
  });

  it('闭合的 fence 对不触发', () => {
    expect(oddLineInitialFences('看:\n```js\ncode()\n```\n完了。')).toBe(false);
  });
});

describe('StreamResuming:静默续跑必须自己开口', () => {
  const engine = readSource(new URL('../AgentLoopEngine.ts', import.meta.url));

  it('截断续跑与超时续跑两处都 yield StreamResuming(attempt/max/reason)', () => {
    const yields = engine.match(/yield \{ type: 'StreamResuming', payload: \{ attempt: streamResumes, max: MAX_STREAM_RESUMES, reason: '[a-z]+' \}, timestamp: Date\.now\(\) \}/g) ?? [];
    expect(yields).toHaveLength(2);
    expect(yields[0]).toContain("reason: 'stall'");
    expect(yields[1]).toContain("reason: 'timeout'");
    // yield 先于 continue——事件在重新发起请求之前到达 UI。
    for (const y of yields) {
      const after = engine.slice(engine.indexOf(y));
      expect(after.indexOf('continue;')).toBeGreaterThan(after.indexOf('messages.push'));
    }
  });

  it('事件类型带 max 上沿,GUI 文案带次数', () => {
    const types = readSource(new URL('../../../src/shared/types.ts', import.meta.url));
    expect(types).toContain("| { type: 'StreamResuming'; payload: { attempt: number; max: number; reason: 'stall' | 'timeout' }; timestamp: number }");
    const chat = readSource(new URL('../../../src/ui/chat.ts', import.meta.url));
    expect(chat).toContain("case 'StreamResuming':");
    expect(chat).toContain('回复断了一下，正在接着生成（第 ${event.payload.attempt}/${event.payload.max} 次）…');
    // 开卡守卫与 TransportStatus 同款:工具行在场上时不重复开卡。
    const caseAt = chat.indexOf("case 'StreamResuming':");
    const body = chat.slice(caseAt, caseAt + 700);
    expect(body).toContain('pendingRows.size === 0 && pendingByName.size === 0');
  });
});
