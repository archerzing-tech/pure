// src/shared/__tests__/writeFeedback.test.ts
// 写入即时反馈（2026-11-23）：用户判例「同一个任务里反复出现 1.2 万字符的写入」。
// 这层只在工具结果里补一句成本事实，判定权仍归模型。

import { describe, it, expect } from 'bun:test';
import {
  LARGE_WRITE_CHARS,
  REWRITE_MIN_CHARS,
  createWriteFeedbackWatch,
  writeVolumeChars,
} from '../writeFeedback';

const big = (n: number) => 'x'.repeat(n);

const write = (path: string, content: string, extra: Record<string, unknown> = {}) => ({
  toolName: 'write_file',
  args: { path, content, ...extra },
  success: true,
});

describe('writeVolumeChars', () => {
  it('只认非 append 的 write_file 正文体量', () => {
    expect(writeVolumeChars('write_file', { path: 'a.ts', content: big(9000) })).toBe(9000);
    expect(writeVolumeChars('write_file', { path: 'a.ts', content: big(9000), append: true })).toBe(0);
    expect(writeVolumeChars('edit_file', { path: 'a.ts', oldString: 'a', newString: big(9000) })).toBe(0);
    expect(writeVolumeChars('write_file', { path: 'a.ts' })).toBe(0);
  });

  it('参数是原始 JSON 字符串时同样能算（引擎侧的形态）', () => {
    expect(writeVolumeChars('write_file', JSON.stringify({ path: 'a.ts', content: big(7000) }))).toBe(7000);
    expect(writeVolumeChars('write_file', '{not json')).toBe(0);
  });
});

describe('createWriteFeedbackWatch', () => {
  it('小写入不提醒', () => {
    const watch = createWriteFeedbackWatch();
    expect(watch.note(write('src/a.ts', big(LARGE_WRITE_CHARS - 1)))).toBe('');
  });

  it('首次大写入给体量与拆分形状，且只给一次', () => {
    const watch = createWriteFeedbackWatch();
    const note = watch.note(write('src/app.js', big(12_340)));
    expect(note).toContain('12,340 characters');
    expect(note).toContain('≈12.3 KB');
    expect(note).toContain('append:true');
    expect(note).toContain('edit_file');
    expect(note).toContain('one parallel batch');
    // 同一路径的第二次大整写走「重写」分支，不再重复首次提示
    const second = watch.note(write('src/app.js', big(12_000)));
    expect(second).not.toContain('This single write_file carried');
    expect(second).toContain('from scratch again');
  });

  it('同路径整写第二次：点明磁盘上已有内容，改走 edit_file', () => {
    const watch = createWriteFeedbackWatch();
    watch.note(write('src/styles.css', big(9_000)));
    const note = watch.note(write('src/styles.css', big(10_500)));
    expect(note).toContain('src/styles.css');
    expect(note).toContain('9,000 characters');
    expect(note).toContain('edit_file');
    expect(note).toContain('append:true when adding to the end');
    // 同路径重写提示每会话只一条，避免长任务里刷屏
    expect(watch.note(write('src/styles.css', big(8_000)))).toBe('');
  });

  it('append 分段是被鼓励的形状：不提醒，但计入重写时的「已有体量」', () => {
    const watch = createWriteFeedbackWatch();
    expect(watch.note(write('src/big.ts', big(7_000), { append: true }))).toBe('');
    expect(watch.note(write('src/big.ts', big(7_000), { append: true }))).toBe('');
    const rewrite = watch.note(write('src/big.ts', big(14_000)));
    // append 之后是首次整写，给的是首次提示（此时确实还没整份重来过）
    expect(rewrite).toContain('This single write_file carried');
  });

  it('append 之后的重写：用累计体量说明白写了多少', () => {
    const watch = createWriteFeedbackWatch();
    watch.note(write('src/big.ts', big(14_000))); // 首次整写
    watch.note(write('src/big.ts', big(2_000), { append: true })); // 续写
    const rewrite = watch.note(write('src/big.ts', big(15_000)));
    expect(rewrite).toContain('from scratch again');
    expect(rewrite).toContain('16,000 characters');
  });

  it('中等文档重写也提醒（2026-11-26 判例：1.2k–6k 曾因 6k 早退完全静默）', () => {
    const watch = createWriteFeedbackWatch();
    // 首次写入 3000 字符（设计文档典型体量）：低于 6k，首次提示不说（合理）。
    expect(watch.note(write('docs/design.md', big(3_000)))).toBe('');
    // 「简化文档」→ 整篇重写到 2000 字符：文件里已有内容，必须给出事实与可选动作。
    const note = watch.note(write('docs/design.md', big(2_000)));
    expect(note).toContain('from scratch again');
    expect(note).toContain('edit_file');
    expect(note).toContain('previous write in this session: 3,000 characters');
    // 缩小型重写额外点明「逐节删除可保住未改动部分原文」。
    expect(note).toContain('shrinks it from 3,000 to 2,000 characters');
  });

  it('放大型重写不出现 shrink 措辞', () => {
    const watch = createWriteFeedbackWatch();
    watch.note(write('docs/plan.md', big(2_000)));
    const note = watch.note(write('docs/plan.md', big(2_400)));
    expect(note).toContain('from scratch again');
    expect(note).not.toContain('shrinks it from');
  });

  it('小补丁不计为重写：整写 12k 之后再来 800 字符不算重新生成', () => {
    const watch = createWriteFeedbackWatch();
    watch.note(write('src/app.js', big(12_000)));
    expect(watch.note(write('src/app.js', big(REWRITE_MIN_CHARS - 1)))).toBe('');
  });

  it('失败、非 write_file、缺 path 一律不提醒', () => {
    const watch = createWriteFeedbackWatch();
    expect(watch.note({ ...write('src/a.ts', big(20_000)), success: false })).toBe('');
    expect(watch.note({ toolName: 'edit_file', args: { path: 'a.ts', newString: big(20_000) }, success: true })).toBe('');
    expect(watch.note({ toolName: 'write_file', args: { content: big(20_000) }, success: true })).toBe('');
    expect(watch.note({ toolName: 'write_file', success: true })).toBe('');
  });

  it('MCP 前缀名按基础名识别（mcp__fs__write_file）', () => {
    const watch = createWriteFeedbackWatch();
    const note = watch.note({ toolName: 'mcp__fs__write_file', args: { path: 'a.txt', content: big(8_000) }, success: true });
    expect(note).toContain('8,000 characters');
  });

  it('不同路径各自给首次提示；reset 清空会话账', () => {
    const watch = createWriteFeedbackWatch();
    expect(watch.note(write('a.js', big(7_000)))).toContain('a.js');
    expect(watch.note(write('b.js', big(7_000)))).toContain('b.js');
    watch.reset();
    expect(watch.note(write('a.js', big(7_000)))).toContain('This single write_file carried');
  });
});
