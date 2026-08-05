import { describe, expect, it } from 'bun:test';
import { getStoredThinkingSegments, type StoredMessage } from '../store';

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
});
