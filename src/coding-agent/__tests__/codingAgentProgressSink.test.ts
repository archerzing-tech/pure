import { describe, expect, it } from 'bun:test';
import { CodingAgent } from '../CodingAgent';
import type { SubagentActivity } from '../SubagentOrchestrator';
import { EventFanout } from '../../shared/asyncQueue';
import type { SubagentActivityEvent } from '../../shared/types';

/** 刀 4（第 3 期）打回修复的锁：CodingAgent.makeSubagentProgressSink 是
 *  SubagentActivity → SubagentActivityEvent 的唯一桥（GUI trace 行读的是
 *  event 侧），手工逐字段拷贝——编排器加新血缘字段时这里一漏，trace 行就
 *  静默退化老文案，且编排器/toolRow 两端单测都测不到（它们绕过这座桥）。
 *  本判例直调 sink，锁住血缘字段必须成对透传。 */
describe('CodingAgent progress sink → event 桥的血缘透传', () => {
  it('publish 把 runCount 与 resumed 一并拷进事件', async () => {
    const fanout = new EventFanout<SubagentActivityEvent>();
    const agent = new CodingAgent({
      sessionId: 'sink-test',
      llm: {} as never,
      toolAdapter: {
        getTools: () => [],
        getMetadata: () => undefined,
        execute: async () => ({ id: 'x', toolName: 'x', success: false, duration: 0, error: 'unused' }),
      },
      budget: { maxTurns: 1, maxTotalTokens: 1000, maxExecutionTime: 1000, warningThreshold: 0.8, graceTurns: 0 },
      subagentEvents: fanout,
    });
    const sink = (agent as unknown as {
      makeSubagentProgressSink: (c: unknown) => { onStart: (a: SubagentActivity) => void };
    }).makeSubagentProgressSink({ subagentEvents: fanout });

    const q = fanout.subscribe();
    sink.onStart({ callId: 'c1', agentName: 'researcher', resumed: true, runCount: 3, resumedTurns: 7 });
    const event = (await q.next()).value;
    expect(event.kind).toBe('start');
    expect(event.resumed).toBe(true);
    expect(event.runCount).toBe(3);
  });
});
