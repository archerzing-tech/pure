// src/adapter/memory/__tests__/toolCorrections.test.ts
// E1.3 — cluster-scanner unit tests on injected mock observations (the
// design's acceptance criteria), plus approve-toolCorrection write shape.
// The injection-side integration (approved note reaches the system prompt)
// lives in Harness.test.ts where the FakeMemoryStore + Harness plumbing is.

import { describe, it, expect } from 'bun:test';
import type { MemoryEntry } from '../../../shared/types';
import {
  approveToolCorrection,
  buildToolNoteAppliedRecord,
  detectPlatform,
  scanToolCorrections,
  TOOL_NOTE_DEDUPE_PREFIX,
} from '../toolCorrections';

const NOW = Date.parse('2026-09-18T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function errorEntry(content: string, ageDays = 0, project = '/proj-a'): MemoryEntry {
  return {
    id: `m_${Math.random().toString(36).slice(2)}`,
    type: 'error_pattern',
    content,
    timestamp: NOW - ageDays * DAY,
    sessionId: 'seed',
    projectPath: project,
  };
}

const NETWORK_FAIL = 'Stopped by failure policy: error sending request to https://api.example.com: connection refused (tool: web_fetch). giving up';
const AUTH_FAIL = 'Failed during execution: HTTP 401 unauthorized, invalid api key (tool: web_fetch). Do not make this exact call again';

describe('scanToolCorrections', () => {
  it('returns empty for empty or quiet stores', () => {
    expect(scanToolCorrections([], { now: NOW })).toEqual([]);
    expect(scanToolCorrections([errorEntry(NETWORK_FAIL)], { now: NOW })).toEqual([]);
  });

  it('clusters the same tool + error class across projects and produces a note', () => {
    const entries = [
      errorEntry(NETWORK_FAIL, 0, '/proj-a'),
      errorEntry(NETWORK_FAIL, 1, '/proj-b'),
      errorEntry(NETWORK_FAIL, 2, '/proj-a'),
    ];
    const suggestions = scanToolCorrections(entries, { now: NOW });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].toolName).toBe('web_fetch');
    expect(suggestions[0].errorClass).toBe('network');
    expect(suggestions[0].count).toBe(3);
    expect(suggestions[0].note).toContain('web_fetch');
    expect(suggestions[0].note).toContain('3 network failures');
    expect(suggestions[0].dedupeKey).toBe(`${TOOL_NOTE_DEDUPE_PREFIX}web_fetch::network`);
  });

  it('respects the window: old failures do not count', () => {
    const entries = [
      errorEntry(NETWORK_FAIL, 0),
      errorEntry(NETWORK_FAIL, 1),
      errorEntry(NETWORK_FAIL, 20), // outside the 14-day window
    ];
    expect(scanToolCorrections(entries, { now: NOW })).toEqual([]);
  });

  it('keeps classes apart and sorts by count descending', () => {
    const entries = [
      errorEntry(NETWORK_FAIL, 0),
      errorEntry(NETWORK_FAIL, 1),
      errorEntry(NETWORK_FAIL, 2),
      errorEntry(NETWORK_FAIL, 3),
      errorEntry(AUTH_FAIL, 0),
      errorEntry(AUTH_FAIL, 1),
      errorEntry(AUTH_FAIL, 2),
    ];
    const suggestions = scanToolCorrections(entries, { now: NOW });
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].errorClass).toBe('network');
    expect(suggestions[0].count).toBe(4);
    expect(suggestions[1].errorClass).toBe('auth');
    expect(suggestions[1].count).toBe(3);
  });

  it('skips entries without a tool tag (nothing to attribute)', () => {
    const entries = [
      errorEntry('Stopped by failure policy: connection refused. giving up', 0),
      errorEntry('Stopped by failure policy: connection refused. giving up', 1),
      errorEntry('Stopped by failure policy: connection refused. giving up', 2),
    ];
    expect(scanToolCorrections(entries, { now: NOW })).toEqual([]);
  });

  it('never suggests a pair that already has an approved note', () => {
    const entries = [
      errorEntry(NETWORK_FAIL, 0),
      errorEntry(NETWORK_FAIL, 1),
      errorEntry(NETWORK_FAIL, 2),
      {
        id: 'note-1',
        type: 'tool_preference' as const,
        content: 'Caution: web_fetch hit 3 network failures in 14 days on this machine.',
        timestamp: NOW,
        sessionId: 'tool-correction',
        projectPath: '__machine__',
        platform: 'darwin',
        dedupeKey: `${TOOL_NOTE_DEDUPE_PREFIX}web_fetch::network`,
      },
    ];
    expect(scanToolCorrections(entries, { now: NOW })).toEqual([]);
  });

  it('caps the output at 8 suggestions', () => {
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      const tool = `tool_${i}`;
      for (let j = 0; j < 3; j++) {
        entries.push(errorEntry(`Failed during execution: HTTP 401 unauthorized (tool: ${tool}). stop`, j));
      }
    }
    expect(scanToolCorrections(entries, { now: NOW })).toHaveLength(8);
  });
});

describe('approveToolCorrection', () => {
  it('writes a machine-global platform-tagged tool_preference with the keyed dedupeKey', async () => {
    const written: MemoryEntry[] = [];
    const store = { add: async (entry: Omit<MemoryEntry, 'id'>) => { written.push({ ...entry, id: 'n1' }); return 'n1'; } };
    const entries = [errorEntry(NETWORK_FAIL, 0), errorEntry(NETWORK_FAIL, 1), errorEntry(NETWORK_FAIL, 2)];
    const [suggestion] = scanToolCorrections(entries, { now: NOW });

    await approveToolCorrection(store, suggestion, 'darwin');

    expect(written).toHaveLength(1);
    expect(written[0].type).toBe('tool_preference');
    expect(written[0].projectPath).toBe('__machine__');
    expect(written[0].platform).toBe('darwin');
    expect(written[0].dedupeKey).toBe(`${TOOL_NOTE_DEDUPE_PREFIX}web_fetch::network`);
    expect(written[0].content).toBe(suggestion.note);
  });

  it('caps the note at 300 characters', async () => {
    const written: MemoryEntry[] = [];
    const store = { add: async (entry: Omit<MemoryEntry, 'id'>) => { written.push({ ...entry, id: 'n1' }); return 'n1'; } };
    const entries = [errorEntry(NETWORK_FAIL, 0), errorEntry(NETWORK_FAIL, 1), errorEntry(NETWORK_FAIL, 2)];
    const [suggestion] = scanToolCorrections(entries, { now: NOW, windowDays: 14, minCluster: 3 });
    const longSuggestion = { ...suggestion, note: 'x'.repeat(1000) };

    await approveToolCorrection(store, longSuggestion, 'darwin');
    expect(written[0].content).toHaveLength(300);
  });
});

describe('detectPlatform', () => {
  it('matches the test process platform', () => {
    expect(detectPlatform()).toBe(process.platform);
  });
});

describe('buildToolNoteAppliedRecord', () => {
  it('snapshots the cluster (tool × class × count × window) into an observation record', () => {
    const entries = [errorEntry(NETWORK_FAIL, 0), errorEntry(NETWORK_FAIL, 1), errorEntry(NETWORK_FAIL, 2)];
    const [suggestion] = scanToolCorrections(entries, { now: NOW });
    const record = buildToolNoteAppliedRecord(suggestion, NOW + 5);
    expect(record).toEqual({
      type: 'advice_applied',
      appliedAt: NOW + 5,
      kind: 'tool-note',
      target: 'web_fetch',
      detail: 'network',
      evidence: { count: 3, windowDays: 14 },
    });
  });
});
