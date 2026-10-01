// 架构评审 v2 A1 — 会话事件日志纯核：串行化顺序、单行不变式、降级熔断、
// 行容错解析。
import { describe, expect, it } from 'bun:test';
import { capEventText, createSerializingSink, parseSessionEvents, type SessionEvent } from '../sessionEventLog';

function event(kind: string, ts: number, payload: unknown = {}): SessionEvent {
  return { ts, kind, actor: 'gui', payload };
}

describe('createSerializingSink', () => {
  it('serializes concurrent appends in call order (event order is the log\'s life)', async () => {
    const lines: string[] = [];
    const delays = [30, 10, 20]; // 乱序完成
    const sink = createSerializingSink(async (line) => {
      await new Promise((r) => setTimeout(r, delays[lines.length]));
      lines.push(line);
    });
    await Promise.all([
      sink.append(event('user_input', 1, { n: 1 })),
      sink.append(event('turn_settled', 2, { n: 2 })),
      sink.append(event('user_input', 3, { n: 3 })),
    ]);
    expect(lines.map((l) => (JSON.parse(l) as { payload: { n: number } }).payload.n)).toEqual([1, 2, 3]);
  });

  it('degrades once on write failure and keeps the chain alive (log never blocks the turn)', async () => {
    let failures = 0;
    const written: string[] = [];
    const errors: unknown[] = [];
    let failNext = true;
    const sink = createSerializingSink(
      async (line) => {
        if (failNext) { failNext = false; failures++; throw new Error('disk full'); }
        written.push(line);
      },
      (e) => errors.push(e),
    );
    await sink.append(event('a', 1)); // 失败
    await sink.append(event('b', 2)); // 恢复
    expect(failures).toBe(1);
    expect(errors).toHaveLength(1);
    expect(written).toHaveLength(1);
    expect((JSON.parse(written[0]) as { kind: string }).kind).toBe('b');
  });

  it('serializes newline-bearing payloads safely (JSON escaping keeps the single-line invariant)', async () => {
    const lines: string[] = [];
    const sink = createSerializingSink(async (line) => { lines.push(line); });
    await sink.append(event('user_input', 1, { text: 'a\nb' }));
    expect(lines).toHaveLength(1);
    expect(lines[0].includes('\n')).toBe(false);
  });
});

describe('parseSessionEvents', () => {
  it('parses valid lines in file order and skips broken ones', () => {
    const raw = [
      JSON.stringify(event('user_input', 1, { text: 'hi' })),
      '{broken json',
      JSON.stringify({ ts: 2, kind: 'turn_settled' }), // 缺 actor ⇒ 跳过
      '',
      JSON.stringify(event('turn_settled', 3)),
    ].join('\n');
    const events = parseSessionEvents(raw);
    expect(events.map((e) => e.kind)).toEqual(['user_input', 'turn_settled']);
    expect(events[0].ts).toBe(1);
  });

  it('round-trips origin annotations', () => {
    const e: SessionEvent = { ts: 1, kind: 'user_input', actor: 'gateway', origin: { surface: 'qq', peer: 'p1' }, payload: {} };
    expect(parseSessionEvents(JSON.stringify(e))[0].origin).toEqual({ surface: 'qq', peer: 'p1' });
  });
});

describe('capEventText', () => {
  it('caps long user text with an ellipsis', () => {
    expect(capEventText('x'.repeat(3000)).length).toBeLessThanOrEqual(2001);
    expect(capEventText('short')).toBe('short');
  });
});
