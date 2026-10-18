// src/ui/__tests__/turnVariants.test.ts
// Reply-variant ledger, pure logic: the last-user-turn slice anchor, the
// snapshot restore normalizer (corrupt archives degrade to "no variants",
// never block a session), and the fingerprint that keeps a re-adoption of the
// shown slice from occupying a second slot. Pure module — no DOM, no imports
// of anything mockable.
import { describe, it, expect } from 'bun:test';
import { lastUserTurnStart, normalizeTurnVariants, variantFingerprint, TURN_VARIANT_CAP } from '../turnVariants';
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

describe('normalizeTurnVariants', () => {
  it('round-trips a well-formed group', () => {
    const group = {
      userText: '画一张图',
      active: 1,
      variants: [
        { messages: [user('画一张图'), assistant('版本一')] },
        { messages: [user('画一张图'), assistant('版本二')] },
      ],
    };
    const restored = normalizeTurnVariants(structuredClone(group));
    expect(restored).not.toBeNull();
    expect(restored?.userText).toBe('画一张图');
    expect(restored?.variants.length).toBe(2);
    expect(restored?.active).toBe(1);
    // fingerprints get recomputed on the way in
    expect(restored?.variants[0].fingerprint).toBe(variantFingerprint(group.variants[0].messages));
  });

  it('degrades malformed archives to null', () => {
    expect(normalizeTurnVariants(null)).toBeNull();
    expect(normalizeTurnVariants('x')).toBeNull();
    expect(normalizeTurnVariants([])).toBeNull();
    expect(normalizeTurnVariants({ variants: [{ messages: [user('一')] }] })).toBeNull(); // no userText
    expect(normalizeTurnVariants({ userText: '一', variants: 'nope' })).toBeNull();
    expect(normalizeTurnVariants({ userText: '一', variants: [] })).toBeNull();
  });

  it('drops slices that do not start at their user message, and clamps a bad active', () => {
    const restored = normalizeTurnVariants({
      userText: '问',
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
