// src/adapter/memory/__tests__/correctionDrafts.test.ts
// E3.1 — correction-draft helpers: the draft-badge gate (what shows a 确认
// button in the dashboard) and the confirm rewrite (id dropped, confidence
// raised). Harness-side draft writing lives in Harness.test.ts.

import { describe, it, expect } from 'bun:test';
import type { MemoryEntry } from '../../../shared/types';
import { DRAFT_CONFIRMABLE_TYPES, confirmedDraftEntry, isDraftEntry } from '../correctionDrafts';

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm1',
    type: 'project_convention',
    content: 'No comments in this repo.',
    timestamp: Date.parse('2026-09-18T12:00:00Z'),
    sessionId: 's1',
    projectPath: '/ws',
    dedupeKey: 'correction:project_convention:abc123',
    confidence: 'low',
    ...overrides,
  };
}

describe('isDraftEntry', () => {
  it('marks low-confidence convention/preference entries as drafts', () => {
    expect(isDraftEntry(entry())).toBe(true);
    expect(isDraftEntry(entry({ type: 'user_preference' }))).toBe(true);
  });

  it('never marks high-confidence entries — confirmed rules are not drafts', () => {
    expect(isDraftEntry(entry({ confidence: 'high' }))).toBe(false);
    expect(isDraftEntry(entry({ confidence: undefined }))).toBe(false);
  });

  it('keeps E1.1 low-confidence error lessons out of the draft UI', () => {
    // error_pattern 的 low 是防幻觉降级，不是待确认草稿。
    expect(isDraftEntry(entry({ type: 'error_pattern' }))).toBe(false);
  });
});

describe('DRAFT_CONFIRMABLE_TYPES', () => {
  it('is exactly the reflector correction whitelist', () => {
    expect([...DRAFT_CONFIRMABLE_TYPES].sort()).toEqual(['project_convention', 'user_preference']);
  });
});

describe('confirmedDraftEntry', () => {
  it('raises confidence to high and drops the volatile lifecycle fields', () => {
    const confirmed = confirmedDraftEntry(entry({
      hitCount: 4,
      lastUsedAt: 123,
      decayScore: 0.4,
      lifecycle: 'degraded',
      supersededBy: 'm9',
    }));
    expect(confirmed.confidence).toBe('high');
    expect('id' in confirmed).toBe(false);
    expect('hitCount' in confirmed).toBe(false);
    expect('lastUsedAt' in confirmed).toBe(false);
    expect('decayScore' in confirmed).toBe(false);
    expect('lifecycle' in confirmed).toBe(false);
    expect('supersededBy' in confirmed).toBe(false);
  });

  it('keeps the stable fields — type, content, scope, dedupeKey', () => {
    const confirmed = confirmedDraftEntry(entry({
      type: 'user_preference',
      platform: 'darwin',
      lesson: { symptom: 's', rootCause: 'r', recoveryPath: 'p', verification: 'v', avoidNextTime: 'a' },
    }));
    expect(confirmed.type).toBe('user_preference');
    expect(confirmed.content).toBe('No comments in this repo.');
    expect(confirmed.projectPath).toBe('/ws');
    expect(confirmed.sessionId).toBe('s1');
    expect(confirmed.platform).toBe('darwin');
    expect(confirmed.dedupeKey).toBe('correction:project_convention:abc123');
    expect(confirmed.lesson?.symptom).toBe('s');
  });

  it('keeps the dedupeKey so re-harvested identical statements dedupe onto the confirmed entry', () => {
    const confirmed = confirmedDraftEntry(entry());
    expect(confirmed.dedupeKey?.startsWith('correction:')).toBe(true);
  });
});
