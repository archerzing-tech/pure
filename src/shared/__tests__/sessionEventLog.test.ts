// 架构评审 v2 A1 — 会话事件日志纯核：串行化顺序、单行不变式、降级熔断、
// 行容错解析。
import { describe, expect, it } from 'bun:test';
import { capEventText, createSerializingSink, mergeFoldWithLog, parseSessionEvents, projectSessionTimeline, recentTimelineDigest, type SessionEvent } from '../sessionEventLog';

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

// S1-2 — 时间线投影：每 kind 一条摘要、未知 kind 前向兼容、digest 取尾。
describe('projectSessionTimeline + recentTimelineDigest', () => {
  it('summarizes each known kind in log order', () => {
    const events: SessionEvent[] = [
      { ts: 1, kind: 'user_input', actor: 'gui', origin: { surface: 'gui' }, payload: { text: '调研三个主题' } },
      { ts: 2, kind: 'insertion_classified', actor: 'gui', payload: { kind: 'steer', action: 'fold', via: 'judge', text: '重点看 X' } },
      { ts: 3, kind: 'delegation_settled', actor: 'gui', payload: { agentName: 'researcher', success: true, outcome: 'done', durationMs: 12000 } },
      { ts: 4, kind: 'receipt', actor: 'gui', payload: { text: '收到——活不停，下个动作就带上这句。' } },
      { ts: 5, kind: 'turn_settled', actor: 'gui', payload: { totalMs: 34000, ttftMs: 800, branchEvents: 2 } },
    ];
    const timeline = projectSessionTimeline(events);
    expect(timeline.map((t) => t.kind)).toEqual(['user_input', 'insertion_classified', 'delegation_settled', 'receipt', 'turn_settled']);
    expect(timeline[0].summary).toContain('用户：调研三个主题');
    expect(timeline[0].summary).not.toContain('(qq)');
    expect(timeline[2].summary).toContain('researcher ✔');
    expect(timeline[2].summary).toContain('12s');
    expect(timeline[3].summary).toContain('回执：');
    expect(timeline[4].summary).toContain('回合落定');
  });

  it('marks channel-originated inputs with their surface', () => {
    const events: SessionEvent[] = [
      { ts: 1, kind: 'user_input', actor: 'gateway', origin: { surface: 'qq', peer: 'p1' }, payload: { text: '现在到哪了' } },
    ];
    expect(projectSessionTimeline(events)[0].summary).toContain('(qq)');
  });

  it('passes unknown kinds through with forward compatibility', () => {
    const timeline = projectSessionTimeline([{ ts: 1, kind: 'future_event', actor: 'gui', payload: {} }]);
    expect(timeline[0].summary).toBe('future_event');
  });

  it('digest keeps only the trailing entries', () => {
    const events = Array.from({ length: 20 }, (_, i): SessionEvent => ({ ts: i, kind: 'receipt', actor: 'gui', payload: { text: `r${i}` } }));
    const digest = recentTimelineDigest(events, 5);
    expect(digest).toHaveLength(5);
    expect(digest[0].summary).toContain('r15');
  });
});

// S1-3 — turn_messages 是转录原料：不进时间线，但解析侧完整可读。
describe('turn_messages handling', () => {
  it('is excluded from the timeline (bulk data is not digest material)', () => {
    const events: SessionEvent[] = [
      { ts: 1, kind: 'user_input', actor: 'gui', payload: { text: 'hi' } },
      { ts: 2, kind: 'turn_messages', actor: 'gui', payload: { messages: [{ role: 'assistant', content: 'answer' }] } },
      { ts: 3, kind: 'turn_settled', actor: 'gui', payload: { totalMs: 1000 } },
    ];
    const timeline = projectSessionTimeline(events);
    expect(timeline.map((t) => t.kind)).toEqual(['user_input', 'turn_settled']);
  });

  it('round-trips message arrays through the line log intact', () => {
    const messages = [
      { role: 'user', content: '做个调研' },
      { role: 'tool', content: '{"agentName":"researcher","success":true}', toolCallId: 'c1' },
      { role: 'assistant', content: '结论如下…' },
    ] as never[];
    const line = JSON.stringify({ ts: 1, kind: 'turn_messages', actor: 'gui', payload: { messages } });
    const parsed = parseSessionEvents(line);
    expect(parsed).toHaveLength(1);
    expect((parsed[0].payload as { messages: typeof messages }).messages).toHaveLength(3);
    expect((parsed[0].payload as { messages: Array<{ role: string }> }).messages[1].role).toBe('tool');
  });
});

// S1-4 — fold 合并读取面：水位语义（不重复计入）、旧会话保守、非转录事件不掺和。
describe('mergeFoldWithLog', () => {
  const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const turnEvent = (ts: number, n: number): SessionEvent => ({
    ts, kind: 'turn_messages', actor: 'gui', payload: { messages: msgs(n) },
  });

  it('appends only post-watermark transcript events to the snapshot', () => {
    const merged = mergeFoldWithLog(msgs(2), 100, [
      turnEvent(90, 1),   // ≤ 水位：已在快照里，跳过
      { ts: 95, kind: 'receipt', actor: 'gui', payload: { text: 'x' } }, // 非转录：不掺和
      turnEvent(101, 3),  // > 水位：追加
      turnEvent(200, 2),  // > 水位：追加
    ] as SessionEvent[]);
    expect(merged).toHaveLength(2 + 3 + 2);
    expect(merged[2].content).toBe('m0'); // 第一段增量的开头
  });

  it('treats a missing watermark as snapshot-authoritative (legacy sessions, conservative)', () => {
    const merged = mergeFoldWithLog(msgs(2), undefined, [turnEvent(999, 5)]);
    expect(merged).toHaveLength(2);
  });

  it('watermark equality excludes the event (ts ≤ watermark is already folded)', () => {
    const merged = mergeFoldWithLog(msgs(2), 100, [turnEvent(100, 5)]);
    expect(merged).toHaveLength(2);
  });
});
