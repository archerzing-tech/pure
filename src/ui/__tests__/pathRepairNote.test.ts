// src/ui/__tests__/pathRepairNote.test.ts
// Roadmap 阶段 11.2 (P1): the path-repair note has to survive a reload and a
// follow-up turn — a correction the user can no longer see (or take back) is
// exactly the silent rewrite the iron laws forbid.

import { describe, expect, it, afterAll, beforeAll, beforeEach, afterEach } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Message } from '../../shared/types';
import { createPathRepairNote } from '../pathRepairNote';
import type { PathRepair } from '../pathIndex';
import { createSessionSnapshot, mergeSessionSnapshotMetadata } from '../store';
import { projectTranscript } from '../transcriptProjection';
import type { TranscriptDraft } from '../store';

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

const REPAIRS: PathRepair[] = [{ from: 'src/ui/mian.ts', to: 'src/ui/main.ts' }];

function userDraft(content: string, pathRepairs?: PathRepair[]): { messages: Message[]; drafts: TranscriptDraft[] } {
  const messages: Message[] = [{ role: 'user', content: '看一下 src/ui/main.ts' }];
  return {
    messages,
    drafts: [{ message: messages[0], modelMessageIndex: 0, content, pathRepairs }],
  };
}

describe('path-repair note persistence', () => {
  it('keeps the user-visible words and the repair pairs in the transcript, not in model context', () => {
    const { messages, drafts } = userDraft('看一下 src/ui/mian.ts', REPAIRS);
    const snapshot = createSessionSnapshot(messages, drafts);

    expect(snapshot.modelContext.messages[0]?.content).toBe('看一下 src/ui/main.ts');
    expect(snapshot.transcript[0]?.pathRepairs).toEqual(REPAIRS);
    // The note is rebuilt from the projected block, so it must ride along here too.
    const blocks = projectTranscript(snapshot.transcript);
    expect(blocks[0]).toMatchObject({ type: 'user', content: '看一下 src/ui/mian.ts', repairs: REPAIRS });
  });

  it('survives the next turn re-persisting the whole transcript', () => {
    // persistSession rebuilds the transcript from in-memory messages every turn;
    // in-memory messages never carry display-only fields.
    const firstDraft = userDraft('看一下 src/ui/mian.ts', REPAIRS);
    const first = createSessionSnapshot(firstDraft.messages, firstDraft.drafts);
    const nextTurn = createSessionSnapshot(
      [...first.modelContext.messages, { role: 'assistant', content: '好的' }],
      [
        { message: first.modelContext.messages[0], modelMessageIndex: 0 },
        { message: { role: 'assistant', content: '好的' }, modelMessageIndex: 1 },
      ],
    );
    const merged = mergeSessionSnapshotMetadata(first, nextTurn);
    expect(merged.transcript[0]?.pathRepairs).toEqual(REPAIRS);
  });
});

describe('createPathRepairNote', () => {
  it('names the correction and offers the way back to the original words', () => {
    let restored = 0;
    const note = createPathRepairNote(REPAIRS, () => { restored += 1; });
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain('src/ui/mian.ts');
    expect(note!.textContent).toContain('src/ui/main.ts');

    const button = note!.querySelector('button') as HTMLButtonElement;
    button.click();
    expect(restored).toBe(1);
  });

  it('renders nothing when no path was repaired', () => {
    expect(createPathRepairNote([], () => {})).toBeNull();
  });
});
