import { describe, expect, it } from 'bun:test';
import { createSessionSnapshot, createSessionSnapshotFromLegacy, dedupeFileWrites, groupFileWrites, limitStoredMessages, mergeSessionSnapshotMetadata, mergeStoredMetadata, normalizeFileWritePath, upsertFileWrite, MAX_PERSISTED_MESSAGES, type StoredMessage, type TranscriptDraft } from '../store';
import type { Message } from '../../shared/types';

describe('mergeStoredMetadata', () => {
  it('carries stored-only analysis and thinking over to a rebuilt transcript', () => {
    const prev: StoredMessage[] = [
      { role: 'user', content: '做一个监控大屏' },
      { role: 'assistant', content: '', analysis: '这是一个省市网络监控项目…', thinkingPhases: [{ text: '先理解需求', assistantIndex: 0 }] },
    ];
    const next: StoredMessage[] = [
      { role: 'user', content: '做一个监控大屏' },
      { role: 'assistant', content: '已完成。' },
    ];
    const merged = mergeStoredMetadata(prev, next);
    expect(merged[1].analysis).toContain('省市网络监控项目');
    expect(merged[1].thinkingPhases?.[0]?.text).toBe('先理解需求');
  });

  it('lets the current turn overwrite the previous analysis', () => {
    const prev: StoredMessage[] = [{ role: 'assistant', content: '', analysis: '旧分析', thinking: '旧思考' }];
    const next: StoredMessage[] = [{ role: 'assistant', content: '', analysis: '新分析' }];
    const merged = mergeStoredMetadata(prev, next);
    expect(merged[0].analysis).toBe('新分析');
    expect(merged[0].thinking).toBe('旧思考');
  });

  it('preserves the rendered display snapshot for earlier turns', () => {
    const prev: StoredMessage[] = [{ role: 'assistant', content: '', displayContent: '![图表](x.png)\n```chart\nvalue: 1\n```' }];
    const next: StoredMessage[] = [{ role: 'assistant', content: '' }];
    const merged = mergeStoredMetadata(prev, next);
    expect(merged[0].displayContent).toContain('```chart');
  });

  it('does not merge across a role mismatch or missing positions', () => {
    expect(mergeStoredMetadata([{ role: 'assistant', content: '', analysis: 'x' }], [{ role: 'user', content: 'hi' }])[0]?.analysis).toBeUndefined();
    expect(mergeStoredMetadata([{ role: 'assistant', content: '', analysis: 'x' }], [])).toEqual([]);
  });
});

describe('session snapshot separation', () => {
  it('keeps UI display content out of modelContext', () => {
    const modelMessages: Message[] = [
      { role: 'assistant', content: '' },
    ];
    const drafts: TranscriptDraft[] = [{
      message: modelMessages[0],
      modelMessageIndex: 0,
      content: '界面专用的恢复内容',
      displayOverride: true,
      thinking: '只展示在界面的思考过程',
    }];
    const snapshot = createSessionSnapshot(modelMessages, drafts);
    expect(snapshot.modelContext.messages[0]?.content).toBe('');
    expect(snapshot.modelContext.messages[0]).not.toHaveProperty('displayContent');
    expect(snapshot.transcript[0]?.content).toBe('界面专用的恢复内容');
    expect(snapshot.transcript[0]?.thinking).toBe('只展示在界面的思考过程');
  });

  it('migrates legacy display metadata without feeding it back into model context', () => {
    const snapshot = createSessionSnapshotFromLegacy([{
      role: 'assistant',
      content: '',
      displayContent: '旧会话界面内容',
      analysis: '旧会话分析',
    }]);
    expect(snapshot.modelContext.messages[0]?.content).toBe('');
    expect(snapshot.transcript[0]?.content).toBe('旧会话界面内容');
    expect(snapshot.transcript[0]?.analysis).toBe('旧会话分析');
  });

  it('keeps tool and plan presentation data outside the model message', () => {
    const modelMessages: Message[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', index: 0, function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' } }] },
      { role: 'tool', content: 'file contents', toolCallId: 'call-1', toolName: 'read_file' },
    ];
    const stored: StoredMessage[] = [
      { role: 'assistant', content: '', tool_calls: modelMessages[0].toolCalls, planState: { plan: { steps: [] } as never, planNumber: 1, todoNumber: 2, started: true } },
      { role: 'tool', content: 'file contents', tool_call_id: 'call-1', name: 'read_file', toolExec: { toolName: 'read_file', success: true, duration: 4, args: { path: 'src/app.ts' }, resultText: 'file contents' } },
    ];
    const snapshot = createSessionSnapshot(modelMessages, stored);
    expect(snapshot.modelContext.messages[0]?.toolCalls?.[0]?.function.name).toBe('read_file');
    expect(snapshot.transcript[1]?.toolExec?.args).toEqual({ path: 'src/app.ts' });
    expect(snapshot.uiState.planState?.todoNumber).toBe(2);
    expect(snapshot.modelContext.messages[0]).not.toHaveProperty('toolExec');
  });

  it('preserves prior UI metadata while the model message remains canonical', () => {
    const previous = createSessionSnapshotFromLegacy([{
      role: 'assistant',
      content: 'canonical answer',
      displayContent: 'rich previous rendering',
      thinking: 'previous reasoning',
    }]);
    const next = createSessionSnapshot([
      { role: 'assistant', content: 'canonical answer' },
    ], [{
      role: 'assistant',
      content: 'canonical answer',
    }]);
    const merged = mergeSessionSnapshotMetadata(previous, next);
    expect(merged.modelContext.messages[0]?.content).toBe('canonical answer');
    expect(merged.transcript[0]?.content).toBe('rich previous rendering');
    expect(merged.transcript[0]?.thinking).toBe('previous reasoning');
  });

  it('falls back to the model position when canonical content changes its derived id', () => {
    const previous = createSessionSnapshotFromLegacy([{
      role: 'assistant',
      content: '旧 canonical 内容',
      displayContent: '富媒体展示内容',
      thinking: '旧思考',
    }]);
    const next = createSessionSnapshot([
      { role: 'assistant', content: '更新后的 canonical 内容' },
    ], [{
      message: { role: 'assistant', content: '更新后的 canonical 内容' },
      modelMessageIndex: 0,
      content: '更新后的 canonical 内容',
    }]);
    const merged = mergeSessionSnapshotMetadata(previous, next);
    expect(merged.modelContext.messages[0]?.content).toBe('更新后的 canonical 内容');
    expect(merged.transcript[0]?.content).toBe('富媒体展示内容');
    expect(merged.transcript[0]?.thinking).toBe('旧思考');
  });

  it('allows an explicitly cleared plan state to stay cleared', () => {
    const previous = createSessionSnapshotFromLegacy([{
      role: 'assistant',
      content: 'paused',
      planState: { plan: { steps: [] } as never, planNumber: 1, todoNumber: 1, started: false },
    }]);
    const next = createSessionSnapshot([{ role: 'assistant', content: 'cancelled' }], [{
      role: 'assistant',
      content: 'cancelled',
    }]);
    expect(mergeSessionSnapshotMetadata(previous, next).uiState.planState).toBeNull();
  });
});

describe('bounded session messages', () => {
  it('preserves the system prompt and newest messages', () => {
    const messages = Array.from({ length: MAX_PERSISTED_MESSAGES + 3 }, (_, i) => ({
      role: i === 0 ? 'system' : 'user',
      content: String(i),
    }));
    const bounded = limitStoredMessages(messages);
    expect(bounded).toHaveLength(MAX_PERSISTED_MESSAGES);
    expect(bounded[0].role).toBe('system');
    expect(bounded.at(-1)?.content).toBe(String(MAX_PERSISTED_MESSAGES + 2));
  });

  it('keeps the plan-pause marker and assessment on the newest message when truncating', () => {
    const messages: StoredMessage[] = Array.from({ length: MAX_PERSISTED_MESSAGES + 2 }, (_, i) => ({
      role: 'user',
      content: String(i),
    }));
    messages.push({
      role: 'assistant',
      content: '计划先列到这里…',
      isPlanPause: true,
      assessment: {
        intent: 'modify',
        riskLevel: 'medium',
        reversibility: 'partially-reversible',
        impact: '可能波及多个模块。',
        recommendation: '先做只读探针。',
        requiresProbe: true,
        requiresConfirmation: false,
      },
    });
    const bounded = limitStoredMessages(messages);
    expect(bounded.at(-1)?.isPlanPause).toBe(true);
    expect(bounded.at(-1)?.assessment?.riskLevel).toBe('medium');
    expect(bounded.at(-1)?.content).toBe('计划先列到这里…');
  });

  it('never separates an assistant tool call from its tool result', () => {
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'old-call' }] },
      { role: 'tool', content: 'old result', tool_call_id: 'old-call' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'new' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'new-call' }] },
      { role: 'tool', content: 'new result', tool_call_id: 'new-call' },
      { role: 'assistant', content: 'new answer', planState: { plan: {} as never, planNumber: 2, todoNumber: 1, started: true } },
    ];
    const bounded = limitStoredMessages(messages, 6);
    expect(bounded.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(bounded.some((message) => message.tool_call_id === 'old-call')).toBe(false);
    expect(bounded.some((message) => message.tool_call_id === 'new-call')).toBe(true);
    expect(bounded.at(-1)?.planState?.planNumber).toBe(2);
  });
});

describe('file write activity deduplication', () => {
  it('normalizes equivalent relative path spellings', () => {
    expect(normalizeFileWritePath('./src\\app.ts')).toBe('src/app.ts');
    expect(normalizeFileWritePath(' src//app.ts ')).toBe('src/app.ts');
  });

  it('normalizes dot segments and absolute path separators', () => {
    expect(normalizeFileWritePath('./src/../src/app.ts')).toBe('src/app.ts');
    expect(normalizeFileWritePath('/Users/me/project/../project/app.ts')).toBe('/Users/me/project/app.ts');
  });

  it('treats workspace-relative and workspace-absolute paths as one file', () => {
    const entries = [{ path: '/workspace/src/app.ts', ts: 1, success: true }];
    upsertFileWrite(entries, { path: 'src/app.ts', ts: 2, success: false }, '/workspace');
    expect(entries).toEqual([{ path: 'src/app.ts', ts: 2, success: false }]);
  });

  it('keeps only the latest entry for each file', () => {
    expect(dedupeFileWrites([
      { path: 'src/app.ts', ts: 1, success: true },
      { path: './src/app.ts', ts: 2, success: false },
      { path: 'README.md', ts: 3, success: true },
    ])).toEqual([
      { path: 'src/app.ts', ts: 2, success: false },
      { path: 'README.md', ts: 3, success: true },
    ]);
  });

  it('updates an existing file row instead of appending a duplicate', () => {
    const entries = [{ path: 'src/app.ts', ts: 1, success: true }];
    upsertFileWrite(entries, { path: './src/app.ts', ts: 2, success: false });
    expect(entries).toEqual([{ path: 'src/app.ts', ts: 2, success: false }]);
  });

  it('groups paths and keeps the most recent write status ordered by time', () => {
    expect(groupFileWrites([
      { path: 'README.md', ts: 3, success: true },
      { path: './src/app.ts', ts: 1, success: true },
      { path: 'src/app.ts', ts: 4, success: false },
      { path: 'old.ts', ts: 2, success: true },
    ])).toEqual([
      { path: 'src/app.ts', ts: 4, success: false },
      { path: 'README.md', ts: 3, success: true },
      { path: 'old.ts', ts: 2, success: true },
    ]);
  });

  it('does not let an older persisted entry replace a newer status', () => {
    expect(dedupeFileWrites([
      { path: 'src/app.ts', ts: 9, success: true },
      { path: './src/app.ts', ts: 3, success: false },
    ])).toEqual([{ path: 'src/app.ts', ts: 9, success: true }]);
  });
});
