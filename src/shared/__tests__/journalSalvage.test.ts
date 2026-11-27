// src/shared/__tests__/journalSalvage.test.ts
// journal 打捞纯核（P1-c 消费端）：最后一个 stream 分组 = 未落快照的流式文本。

import { describe, expect, it } from 'bun:test';
import { formatSalvage, parseJournalLines, salvageLastStream } from '../journalSalvage';

const line = (stream: string, kind: string, text: string, ts = 1000) =>
  JSON.stringify({ ts, stream, kind, text });

describe('parseJournalLines', () => {
  it('parses good lines and counts bad ones (8MB 截断可能切出半行)', () => {
    const raw = [
      line('s1', 'content', 'a'),
      '{"ts":1,"stream":"s1","kind":"content","tex', // 半行（截断残留）
      '',
      line('s1', 'thinking', 't'),
    ].join('\n');
    const { lines, badLines } = parseJournalLines(raw);
    expect(lines.length).toBe(2);
    expect(badLines).toBe(1);
  });
});

describe('salvageLastStream', () => {
  const fixture = [
    line('old', 'content', '前面工具轮的文本', 100),
    line('crash', 'content', '第一段', 500),
    line('crash', 'thinking', '推理痕迹', 510),
    line('crash', 'content', '第二段', 520),
  ].join('\n');

  it('打捞最后一个 stream 分组，跳过更早的工具轮', () => {
    const r = salvageLastStream(fixture)!;
    expect(r.stream).toBe('crash');
    expect(r.text).toBe('第一段第二段');
    expect(r.contentChars).toBe(6);
    expect(r.thinkingChars).toBe(4);
    expect(r.olderStreams).toBe(1);
    expect(r.firstTs).toBe(500);
    expect(r.lastTs).toBe(520);
    expect(r.text.includes('推理痕迹')).toBe(false);
    expect(r.text.includes('前面工具轮')).toBe(false);
  });

  it('keepThinking 时 thinking 以引用块附加', () => {
    const r = salvageLastStream(fixture, { keepThinking: true })!;
    expect(r.text.includes('> [thinking]')).toBe(true);
    expect(r.text.includes('推理痕迹')).toBe(true);
    expect(r.text.startsWith('第一段')).toBe(true);
  });

  it('空文件 / 全坏行返回 null', () => {
    expect(salvageLastStream('')).toBeNull();
    expect(salvageLastStream('not-json\n{"bad":1}')).toBeNull();
  });

  it('单 stream 也能打捞', () => {
    const r = salvageLastStream(line('only', 'content', 'x', 1))!;
    expect(r.text).toBe('x');
    expect(r.olderStreams).toBe(0);
  });
});

describe('formatSalvage', () => {
  it('renders the summary head and body', () => {
    const r = salvageLastStream(line('s', 'content', '正文', 1700000000000))!;
    const out = formatSalvage(r, 'session_1');
    expect(out).toContain('打捞：未落快照的流式文本');
    expect(out).toContain('session_1');
    expect(out).toContain('正文');
    expect(out.trim().endsWith('正文')).toBe(true);
  });
});
