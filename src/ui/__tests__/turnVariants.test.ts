// src/ui/__tests__/turnVariants.test.ts
// Reply-variant ledger, pure logic: the last-user-turn slice anchor, the
// group-to-turn identity check (anchored on the ACTIVE variant's first
// message — an edit intentionally changes the turn's user text), the snapshot
// restore normalizer (corrupt archives degrade to "no variants", never block
// a session), and the fingerprint that keeps a re-adoption of the shown slice
// from occupying a second slot. Pure module — no DOM, no imports of anything
// mockable.
import { describe, it, expect } from 'bun:test';
import { groupAnchoredToTurn, lastUserTurnStart, normalizeTurnVariants, variantFingerprint, TURN_VARIANT_CAP } from '../turnVariants';
import type { Message } from '../../shared/types';

const user = (content: string, internal?: boolean): Message => ({ role: 'user', content, ...(internal ? { internal } : {}) });
const assistant = (content: string): Message => ({ role: 'assistant', content });

describe('lastUserTurnStart', () => {
  it('finds the last non-internal user message', () => {
    const messages = [user('一'), assistant('答一'), user('二'), assistant('答二')];
    expect(lastUserTurnStart(messages)).toBe(2);
  });

  it('skips internal user commits (pause/auto) and anchors at the visible turn', () => {
    const messages = [user('一'), assistant('答一'), user('继续', true), assistant('答续')];
    expect(lastUserTurnStart(messages)).toBe(0);
  });

  it('returns null for an empty or userless array', () => {
    expect(lastUserTurnStart([])).toBeNull();
    expect(lastUserTurnStart([assistant('只有答')])).toBeNull();
  });
});

describe('groupAnchoredToTurn', () => {
  const group = (activeUserText: string) => ({
    active: 0,
    variants: [{ messages: [user(activeUserText), assistant('答')], fingerprint: 'x' }],
  });

  it('holds while the active variant still matches the last user turn', () => {
    const messages = [user('前文'), assistant('前答'), user('画一张图'), assistant('版本')];
    expect(groupAnchoredToTurn(group('画一张图'), messages)).toBe(true);
  });

  it('breaks when the turn moved on (a new question came after the ledger)', () => {
    const messages = [user('画一张图'), assistant('版本'), user('新问题'), assistant('新答')];
    expect(groupAnchoredToTurn(group('画一张图'), messages)).toBe(false);
  });

  it('follows the ACTIVE slot — an edited question re-anchors the same group', () => {
    // 编辑重发后 active 槽首条是编辑后的文本:组跟着 active 走,不认冻结字符串。
    const edited = {
      active: 1,
      variants: [
        { messages: [user('原问'), assistant('原答')], fingerprint: 'a' },
        { messages: [user('改过的话'), assistant('新答')], fingerprint: 'b' },
      ],
    };
    const messages = [user('改过的话'), assistant('新答')];
    expect(groupAnchoredToTurn(edited, messages)).toBe(true);
  });

  it('is false without any user turn', () => {
    expect(groupAnchoredToTurn(group('问'), [])).toBe(false);
  });
});

describe('normalizeTurnVariants', () => {
  it('round-trips a well-formed group and recomputes fingerprints', () => {
    const group = {
      active: 1,
      variants: [
        { messages: [user('问'), assistant('版本一')], fingerprint: 'stale' },
        { messages: [user('问'), assistant('版本二')], fingerprint: 'stale' },
      ],
    };
    const restored = normalizeTurnVariants(structuredClone(group));
    expect(restored).not.toBeNull();
    expect(restored?.variants.length).toBe(2);
    expect(restored?.active).toBe(1);
    expect(restored?.variants[0].fingerprint).toBe(variantFingerprint(group.variants[0].messages));
  });

  it('degrades malformed archives to null', () => {
    expect(normalizeTurnVariants(null)).toBeNull();
    expect(normalizeTurnVariants('x')).toBeNull();
    expect(normalizeTurnVariants([])).toBeNull();
    expect(normalizeTurnVariants({ variants: 'nope' })).toBeNull();
    expect(normalizeTurnVariants({ variants: [] })).toBeNull();
  });

  it('drops slices that do not start at their user message, and clamps a bad active', () => {
    const restored = normalizeTurnVariants({
      active: 9,
      variants: [
        { messages: [assistant('没有 user 开头')] },
        { messages: [] },
        { messages: [user('问'), assistant('好的版本')] },
      ],
    });
    expect(restored).not.toBeNull();
    expect(restored?.variants.length).toBe(1);
    expect(restored?.variants[0].messages[0].content).toBe('问');
    expect(restored?.active).toBe(0); // clamped to the only survivor
  });
});

describe('variantFingerprint', () => {
  it('is stable for identical slices and differs across answers', () => {
    const a = [user('问'), assistant('答')];
    expect(variantFingerprint([...a])).toBe(variantFingerprint(a));
    expect(variantFingerprint([user('问'), assistant('另答')])).not.toBe(variantFingerprint(a));
  });

  it('exposes the capacity bound used by the ledger', () => {
    expect(TURN_VARIANT_CAP).toBeGreaterThanOrEqual(2);
  });
});
