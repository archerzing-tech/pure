import { describe, expect, it } from 'bun:test';
import { formatSegmentSummary, groupConversationTurns, segmentConversationTurns, summarizeSegmentTurns } from '../conversationTurns';
import type { TranscriptReplayBlock } from '../transcriptProjection';

function user(content: string): TranscriptReplayBlock {
  return { type: 'user', content, images: [], attachments: [] };
}

function assistant(content: string): TranscriptReplayBlock {
  return { type: 'assistant', content, isPlanPause: false };
}

describe('conversation turns', () => {
  it('keeps each user request with every following block until the next user request', () => {
    const { preamble, turns } = groupConversationTurns([
      assistant('preamble'),
      user('第一轮'),
      assistant('第一轮回答'),
      { type: 'tool', stopped: false, exec: { toolName: 'read_file', success: true, duration: 1 } },
      user('第二轮'),
      assistant('第二轮回答'),
    ]);

    expect(preamble).toHaveLength(1);
    expect(turns).toHaveLength(2);
    expect(turns[0].userText).toBe('第一轮');
    expect(turns[0].blocks.map(block => block.type)).toEqual(['user', 'assistant', 'tool']);
    expect(turns[1].blocks.map(block => block.type)).toEqual(['user', 'assistant']);
  });

  it('leaves conversations up to 50 turns fully expanded', () => {
    const turns = Array.from({ length: 50 }, (_, index) => ({
      index: index + 1,
      userText: `第${index + 1}轮`,
      blocks: [user(`第${index + 1}轮`)],
    }));
    const segments = segmentConversationTurns(turns);
    expect(segments).toHaveLength(50);
    expect(segments.every(segment => !segment.historical)).toBe(true);
  });

  it('groups old turns into bounded segments while keeping the latest 8 as plain turns', () => {
    const turns = Array.from({ length: 100 }, (_, index) => ({
      index: index + 1,
      userText: `第${index + 1}轮`,
      blocks: [user(`第${index + 1}轮`)],
    }));
    const segments = segmentConversationTurns(turns);
    const historical = segments.filter(segment => segment.historical);
    const plain = segments.filter(segment => !segment.historical);

    expect(historical.map(segment => [segment.startTurn, segment.endTurn])).toEqual([
      [1, 10], [11, 20], [21, 30], [31, 40], [41, 50], [51, 60], [61, 70], [71, 80], [81, 90], [91, 92],
    ]);
    expect(plain.map(segment => segment.startTurn)).toEqual([93, 94, 95, 96, 97, 98, 99, 100]);
  });

  it('summarizes a history group with its workload so a group never reads as empty', () => {
    const turns = [
      {
        index: 1,
        userText: '帮我做一个落地页',
        blocks: [
          user('帮我做一个落地页'),
          { type: 'tool', stopped: false, exec: { toolName: 'read_file', success: true, duration: 1 } },
          { type: 'tool', stopped: false, exec: { toolName: 'write_file', success: true, duration: 1 } },
          { type: 'artifact', items: [{ path: 'index.html' }, { path: 'style.css' }] },
        ] as TranscriptReplayBlock[],
      },
    ];
    const stats = summarizeSegmentTurns(turns);
    expect(stats).toEqual({ turnCount: 1, toolCalls: 2, artifacts: 2 });
    const summary = formatSegmentSummary({ startTurn: 1, endTurn: 10, turns, historical: true });
    expect(summary).toContain('第 1–10 轮');
    expect(summary).toContain('2 次工具调用');
    expect(summary).toContain('2 个产物');
    expect(summary).toContain('帮我做一个落地页');
  });

  it('never loses or duplicates a turn while segmenting 200 turns', () => {
    const turns = Array.from({ length: 200 }, (_, index) => ({
      index: index + 1,
      userText: `第${index + 1}轮`,
      blocks: [user(`第${index + 1}轮`)],
    }));
    const segments = segmentConversationTurns(turns);
    expect(segments.flatMap(segment => segment.turns)).toEqual(turns);
    expect(segments.flatMap(segment => segment.turns)).toHaveLength(200);
  });
});
