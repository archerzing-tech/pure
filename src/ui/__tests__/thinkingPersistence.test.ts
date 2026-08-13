import { describe, expect, it } from 'bun:test';
import { buildStoredToolExec, getStoredDisplayContent, getStoredThinkingSegments, getStoredToolCallInfos, limitStoredMessages, type StoredMessage } from '../store';

describe('stored thinking replay', () => {
  it('prefers ordered thinking phases over the legacy combined field', () => {
    const message: StoredMessage = {
      role: 'assistant',
      content: '',
      thinking: 'legacy',
      thinkingPhases: [
        { text: 'first phase', assistantIndex: 0 },
        { text: 'second phase', assistantIndex: 1 },
      ],
    };

    expect(getStoredThinkingSegments(message)).toEqual(['first phase', 'second phase']);
  });

  it('restores legacy thinking sessions as one phase', () => {
    expect(getStoredThinkingSegments({ role: 'assistant', content: 'answer', thinking: 'old trace' }))
      .toEqual(['old trace']);
  });

  it('does not replay empty phases', () => {
    expect(getStoredThinkingSegments({
      role: 'assistant',
      content: '',
      thinkingPhases: [{ text: '', assistantIndex: 0 }, { text: 'visible', assistantIndex: 1 }],
    })).toEqual(['visible']);
  });

  it('prefers the rendered display snapshot for media-rich replies', () => {
    const message: StoredMessage = {
      role: 'assistant',
      content: '',
      displayContent: '![generated](diagram.png)\n```chart\nvalue: 1\n```',
      analysis: '先确认图表数据来源，再生成可验证的展示。',
      artifacts: [{ path: 'diagram.png' }],
    };
    expect(getStoredDisplayContent(message)).toContain('```chart');
    expect(limitStoredMessages([message])[0]?.analysis).toContain('数据来源');
    expect(limitStoredMessages([message])[0]?.artifacts).toEqual([{ path: 'diagram.png' }]);
  });

  it('falls back to the model content for older sessions', () => {
    expect(getStoredDisplayContent({ role: 'assistant', content: 'legacy markdown' })).toBe('legacy markdown');
  });

  it('reconstructs legacy tool input and output when toolExec metadata is absent', () => {
    const assistant: StoredMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' } }],
    };
    const call = getStoredToolCallInfos(assistant)[0];
    const result: StoredMessage = {
      role: 'tool',
      content: 'export const app = true;',
      tool_call_id: 'call-1',
      name: 'read_file',
    };

    expect(call).toEqual({ id: 'call-1', toolName: 'read_file', args: { path: 'src/app.ts' } });
    expect(buildStoredToolExec(result, call)).toMatchObject({
      toolName: 'read_file',
      success: true,
      args: { path: 'src/app.ts' },
      resultText: 'export const app = true;',
    });
  });

  it('preserves legacy tool failures as visible tool rows', () => {
    expect(buildStoredToolExec({ role: 'tool', content: 'Error: permission denied', name: 'write_file' })).toMatchObject({
      toolName: 'write_file',
      success: false,
      resultText: 'Error: permission denied',
    });
  });
});
