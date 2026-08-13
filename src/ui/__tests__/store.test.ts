import { describe, expect, it } from 'bun:test';
import { dedupeFileWrites, groupFileWrites, limitStoredMessages, normalizeFileWritePath, upsertFileWrite, MAX_PERSISTED_MESSAGES, type StoredMessage } from '../store';

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
