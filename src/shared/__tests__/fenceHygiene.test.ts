// 截断卫生（注入面）行为锁：closeDanglingFence 只在分隔行奇数时补收栏。
// 危害判例：注入文本停在 ``` 中途 → 围栏后的整段提示词被模型吞进代码块读，
// 从不报错（渲染侧同族判例 0b5679f 的注入面另一半）。

import { describe, expect, it } from 'bun:test';
import { closeDanglingFence } from '../fenceHygiene';

describe('closeDanglingFence', () => {
  it('无围栏 / 已闭合围栏：原样返回，一个字都不动', () => {
    expect(closeDanglingFence('plain text')).toBe('plain text');
    const closed = 'before\n```ts\ncode()\n```\nafter';
    expect(closeDanglingFence(closed)).toBe(closed);
    // 两个未配对感（开+开+收+收）按分隔行计数仍是偶数——口径就是行计数。
    const four = '```\na\n```\n```\nb\n```';
    expect(closeDanglingFence(four)).toBe(four);
  });

  it('未闭合围栏：补收栏且内容无损', () => {
    const dangling = '计划如下\n```map\n[阶段1] -> [阶段2]';
    const out = closeDanglingFence(dangling);
    expect(out).toBe(`${dangling}\n\`\`\``);
    expect(out).toContain('[阶段1] -> [阶段2]');
  });

  it('结尾已带换行的奇数围栏：收栏直接接上，不产生双空行', () => {
    const dangling = '```ts\nconst a = 1;\n';
    expect(closeDanglingFence(dangling)).toBe('```ts\nconst a = 1;\n```');
  });

  it('缩进 ≤3 空格的围栏行也计入（markdown 口径）', () => {
    const indented = 'text\n   ```\ncode';
    const out = closeDanglingFence(indented);
    expect(out.endsWith('```')).toBe(true);
    // 4 空格缩进是代码块内容，不算分隔行——不加收栏。
    const inCode = 'text\n    ```\nstill text';
    expect(closeDanglingFence(inCode)).toBe(inCode);
  });

  it('带信息串的开栏（```ts / ```map）计入奇偶——漏计会把「开了没收」误判成闭合', () => {
    const dangling = '计划\n```ts\nconst a = 1;';
    const out = closeDanglingFence(dangling);
    expect(out.endsWith('```')).toBe(true);
  });

  it('行中出现的 ```（非行首）不算分隔行——与渲染器口径一致', () => {
    const inline = 'run `cat <<<abc` then ```npm test``` done';
    expect(closeDanglingFence(inline)).toBe(inline);
  });
});
