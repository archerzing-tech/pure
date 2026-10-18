// src/ui/__tests__/composerDraft.test.ts
// Per-session composer drafts: the box must survive refresh, restart and
// session switches. Pinned here: the save/load/clear primitives, the debounced
// store on input, the switch-time stash-under-OLD-id + restore-under-NEW-id
// (with a pending keystroke flushed first, not dropped), and the send-time
// clear that keeps a sent message from resurrecting on the next launch. DOM
// tests use happy-dom; the module imports nothing mockable (no dompurify —
// cross-file mock landmine, see detailsFold.test.ts header).
import { describe, it, expect, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { clearDraft, loadDraft, saveDraft, wireComposerDraft } from '../composerDraft';

try {
  GlobalRegistrator.register();
} catch {
  // A prior test file already registered a global DOM — take it over.
  GlobalRegistrator.unregister();
  GlobalRegistrator.register();
}
afterAll(() => {
  GlobalRegistrator.unregister();
});

const newBox = (): HTMLTextAreaElement => {
  const el = document.createElement('textarea');
  document.body.appendChild(el);
  return el;
};

// Unique keys per run — happy-dom's localStorage is per-process here and other
// files in the same run may hold state.
const idA = `draft-a-${Date.now()}`;
const idB = `draft-b-${Date.now()}`;

describe('draft primitives', () => {
  it('save/load round-trips and clear removes', () => {
    saveDraft(idA, '待发送的草稿');
    expect(loadDraft(idA)).toBe('待发送的草稿');
    clearDraft(idA);
    expect(loadDraft(idA)).toBe('');
    expect(loadDraft(idB)).toBe('');
  });

  it('load misses degrade to empty string', () => {
    expect(loadDraft('never-saved-session')).toBe('');
  });
});

describe('wireComposerDraft', () => {
  it('stores debounced input under the current session', async () => {
    const el = newBox();
    const drafts = wireComposerDraft(el, { getSessionId: () => idA, debounceMs: 5 });
    el.value = '第一段草稿';
    el.dispatchEvent(new Event('input'));
    expect(loadDraft(idA)).toBe(''); // not yet — debounce pending
    await Bun.sleep(30);
    expect(loadDraft(idA)).toBe('第一段草稿');
    drafts.onSent();
  });

  it('an emptied box clears the stored draft', async () => {
    const el = newBox();
    saveDraft(idA, '会被删掉的');
    const drafts = wireComposerDraft(el, { getSessionId: () => idA, debounceMs: 5 });
    el.value = '';
    el.dispatchEvent(new Event('input'));
    await Bun.sleep(30);
    expect(loadDraft(idA)).toBe('');
    drafts.onSent();
  });

  it('a switch stashes the box under the OLD session and restores the NEW one', () => {
    const el = newBox();
    el.value = 'A 会话没发完的话';
    saveDraft(idB, 'B 会话上次的草稿');
    let restored = 0;
    const handle = wireComposerDraft(el, {
      getSessionId: () => idA,
      onRestored: () => restored++,
      debounceMs: 5,
    });
    handle.onSessionChanged(idB);
    expect(loadDraft(idA)).toBe('A 会话没发完的话'); // stashed synchronously
    expect(el.value).toBe('B 会话上次的草稿'); // restored under the new id
    expect(restored).toBe(1);
    handle.onSent();
  });

  it('a switch flushes a pending keystroke instead of dropping it', async () => {
    const el = newBox();
    const drafts = wireComposerDraft(el, { getSessionId: () => idA, debounceMs: 5_000 });
    el.value = '打完立刻切走';
    el.dispatchEvent(new Event('input')); // debounce far in the future
    drafts.onSessionChanged(idB);
    expect(loadDraft(idA)).toBe('打完立刻切走');
    await Bun.sleep(20);
    expect(loadDraft(idA)).toBe('打完立刻切走'); // cancelled timer never fired again
    drafts.onSent();
  });

  it('onSent clears the draft and cancels a pending store', async () => {
    const el = newBox();
    saveDraft(idA, '发送前的草稿');
    const drafts = wireComposerDraft(el, { getSessionId: () => idA, debounceMs: 5 });
    el.value = '发送后的新字';
    el.dispatchEvent(new Event('input'));
    drafts.onSent();
    expect(loadDraft(idA)).toBe(''); // cleared despite the pending debounce
    await Bun.sleep(30);
    expect(loadDraft(idA)).toBe(''); // cancelled timer never re-saved
  });
});
