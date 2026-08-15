import { describe, expect, it } from 'bun:test';
import { projectTranscript, type TranscriptReplayBlock } from '../transcriptProjection';
import type { TranscriptEntry } from '../store';

function types(blocks: TranscriptReplayBlock[]): string[] {
  return blocks.map(block => block.type);
}

describe('projectTranscript', () => {
  it('projects the visible transcript in message order', () => {
    const entries: TranscriptEntry[] = [
      { id: 'u1', modelMessageIndex: 0, role: 'user', content: '请检查项目' },
      {
        id: 'a1',
        modelMessageIndex: 1,
        role: 'assistant',
        content: '我先检查。',
        analysis: '先确认项目结构',
        thinkingPhases: [{ text: '读取配置', assistantIndex: 0 }],
      },
      {
        id: 'a2',
        modelMessageIndex: 2,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', toolName: 'list_files', args: { path: '.' } }],
      },
      {
        id: 't1',
        modelMessageIndex: 3,
        role: 'tool',
        content: 'src/index.ts',
        toolCallId: 'call-1',
        toolName: 'list_files',
        toolExec: {
          toolName: 'list_files',
          success: true,
          duration: 12,
          args: { path: '.' },
          resultText: 'src/index.ts',
        },
      },
      { id: 'a3', modelMessageIndex: 4, role: 'assistant', content: '检查完成。' },
    ];

    const blocks = projectTranscript(entries);
    expect(types(blocks)).toEqual(['user', 'analysis', 'thinking', 'assistant', 'tool', 'assistant']);
    expect(blocks[1]).toEqual({ type: 'analysis', text: '先确认项目结构' });
    expect(blocks[2]).toEqual({ type: 'thinking', text: '读取配置' });
    expect(blocks[4]).toMatchObject({ type: 'tool', stopped: false, exec: { toolName: 'list_files', resultText: 'src/index.ts' } });
  });

  it('pairs completed tools and marks unreturned calls as stopped', () => {
    const entries: TranscriptEntry[] = [
      {
        id: 'a1',
        modelMessageIndex: 0,
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call-1', toolName: 'read_file', args: { path: 'a.ts' } },
          { id: 'call-2', toolName: 'read_file', args: { path: 'b.ts' } },
        ],
      },
      {
        id: 't1',
        modelMessageIndex: 1,
        role: 'tool',
        content: 'a',
        toolCallId: 'call-1',
        toolName: 'read_file',
      },
      { id: 'u1', modelMessageIndex: 2, role: 'user', content: '停止' },
    ];

    const blocks = projectTranscript(entries);
    expect(types(blocks)).toEqual(['tool', 'tool', 'user']);
    expect(blocks[0]).toMatchObject({ type: 'tool', stopped: false, exec: { toolName: 'read_file', resultText: 'a', args: { path: 'a.ts' } } });
    expect(blocks[1]).toMatchObject({ type: 'tool', stopped: true, exec: { toolName: 'read_file', args: { path: 'b.ts' } } });
  });

  it('derives legacy artifact cards from successful write tools when metadata is absent', () => {
    const blocks = projectTranscript([
      {
        id: 'call',
        modelMessageIndex: 0,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'write-1', toolName: 'write_file', args: { path: 'src/app.ts' } }],
      },
      {
        id: 'result',
        modelMessageIndex: 1,
        role: 'tool',
        content: 'written',
        toolCallId: 'write-1',
        toolName: 'write_file',
      },
      { id: 'answer', modelMessageIndex: 2, role: 'assistant', content: '完成' },
    ]);

    expect(blocks.at(-2)).toMatchObject({ type: 'assistant', content: '完成' });
    expect(blocks.at(-1)).toEqual({ type: 'artifact', items: [{ path: 'src/app.ts' }] });
  });

  it('carries the preceding user request into artifact replay context', () => {
    const blocks = projectTranscript([
      { id: 'u1', modelMessageIndex: 0, role: 'user', content: '画一幅图' },
      {
        id: 'a1',
        modelMessageIndex: 1,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'draw-1', toolName: 'write_file', args: { path: 'tools/draw.py' } }],
      },
      {
        id: 't1',
        modelMessageIndex: 2,
        role: 'tool',
        content: 'written',
        toolCallId: 'draw-1',
        toolName: 'write_file',
      },
      { id: 'a2', modelMessageIndex: 3, role: 'assistant', content: '图片已生成。', artifacts: [{ path: 'output.png' }] },
    ]);

    expect(blocks.at(-1)).toEqual({
      type: 'artifact',
      items: [{ path: 'output.png' }],
      userRequest: '画一幅图',
    });
  });

  it('replays plan assessment and artifact blocks around the assistant message', () => {
    const assessment = {
      intent: 'modify' as const,
      riskLevel: 'low' as const,
      reversibility: 'reversible' as const,
      impact: '只修改一个文件',
      recommendation: '可以执行',
      requiresProbe: false,
      requiresConfirmation: false,
    };
    const blocks = projectTranscript([{
      id: 'pause',
      modelMessageIndex: 0,
      role: 'assistant',
      content: '计划已暂停',
      isPlanPause: true,
      assessment,
      artifacts: [{ path: 'src/app.ts' }],
    }]);

    expect(types(blocks)).toEqual(['assessment', 'assistant', 'artifact']);
    expect(blocks[0]).toMatchObject({ type: 'assessment', assessment });
    expect(blocks[1]).toMatchObject({ type: 'assistant', content: '计划已暂停', isPlanPause: true });
    expect(blocks[2]).toEqual({ type: 'artifact', items: [{ path: 'src/app.ts' }] });
  });
});
