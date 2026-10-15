// src/ui/__tests__/ambiguityHint.test.ts
// Roadmap 阶段 11.3 (P2): a path token with two equally-close files must be
// SHOWN, never rewritten. The three accept/ignore/send paths are the contract:
//   Tab   → adopt the candidates as a note (draft untouched)
//   Esc   → ignore
//   Enter → send the draft as written, no note
// plus the IME guard (拼音→汉字 must not open the layer) and the send channel
// (note in the model body, original words in the transcript).

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ComposerAmbiguityHint, buildAmbiguityAnnotation, composeAmbiguitySend } from '../ambiguityHint';
import type { AmbiguityHint } from '../pathIndex';

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

const HINTS: AmbiguityHint[] = [
  { token: 'src/ap.ts', candidates: ['src/app.ts', 'src/api.ts'] },
];

function mount(value: string, hints: AmbiguityHint[] = HINTS): { input: HTMLTextAreaElement; hint: ComposerAmbiguityHint } {
  const input = document.createElement('textarea');
  input.value = value;
  document.body.appendChild(input);
  input.setSelectionRange(value.length, value.length);
  input.focus();
  const hint = new ComposerAmbiguityHint(input, () => hints);
  return { input, hint };
}

/** Type text and wait past the 120ms scan debounce. */
async function type(input: HTMLTextAreaElement, text: string): Promise<void> {
  input.value += text;
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
}

function key(name: string, extra: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra });
}

describe('ComposerAmbiguityHint', () => {
  it('shows the candidates for an ambiguous token', async () => {
    const { input, hint } = mount('改一下 ');
    await type(input, 'src/ap.ts');
    const popup = document.querySelector('.ambiguity-hint');
    expect(popup).not.toBeNull();
    expect(popup!.textContent).toContain('src/ap.ts');
    expect(popup!.textContent).toContain('src/app.ts');
    expect(popup!.textContent).toContain('src/api.ts');
    hint.destroy();
  });

  it('adopts on Tab without touching the draft', async () => {
    const { input, hint } = mount('改一下 ');
    await type(input, 'src/ap.ts');
    const before = input.value;

    const tab = key('Tab');
    input.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(true);
    expect(input.value).toBe(before); // never rewritten
    expect(hint.consumeAccepted()).toEqual(HINTS); // candidates ride along instead
    expect(document.querySelector('.ambiguity-hint')).toBeNull();
    hint.destroy();
  });

  it('ignores on Esc and drops anything adopted', async () => {
    const { input, hint } = mount('改一下 ');
    await type(input, 'src/ap.ts');

    const esc = key('Escape');
    input.dispatchEvent(esc);

    expect(esc.defaultPrevented).toBe(true);
    expect(hint.consumeAccepted()).toEqual([]);
    expect(document.querySelector('.ambiguity-hint')).toBeNull();
    expect(input.value).toBe('改一下 src/ap.ts');
    hint.destroy();
  });

  it('leaves a bare Enter meaning "send as written" (no preventDefault, no note)', async () => {
    const { input, hint } = mount('改一下 ');
    await type(input, 'src/ap.ts');

    const enter = key('Enter');
    input.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(false); // the composer's send handler still runs
    expect(hint.consumeAccepted()).toEqual([]); // nothing adopted → nothing annotated
    expect(input.value).toBe('改一下 src/ap.ts');
    hint.destroy();
  });

  it('stays out of the way while the IME is composing', async () => {
    const { input, hint } = mount('改一下 ');
    input.dispatchEvent(new Event('compositionstart'));
    await type(input, 'src/ap.ts');

    expect(document.querySelector('.ambiguity-hint')).toBeNull();
    input.dispatchEvent(new Event('compositionend'));
    hint.destroy();
  });

  it('yields the composer corner to the autocomplete popup', async () => {
    const { input, hint } = mount('改一下 ');
    const ac = document.createElement('div');
    ac.className = 'ac-popup';
    document.body.appendChild(ac);
    await type(input, 'src/ap.ts');
    expect(document.querySelector('.ambiguity-hint')).toBeNull();
    hint.destroy();
  });
});

describe('composeAmbiguitySend (11.3 send channel)', () => {
  it('puts the note in the model body and keeps the original as the display text', () => {
    const original = '改一下 src/ap.ts';
    const { text, displayOverride } = composeAmbiguitySend(original, HINTS);

    // Model body: original words plus the annotation (part of the body, not a
    // new field — chat.ts/store.ts stay untouched).
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain('src/ap.ts');
    expect(text).toContain('src/app.ts');
    expect(text).toContain('src/api.ts');
    expect(text).not.toContain('repair.ambiguity'); // no raw i18n key leaks
    // Transcript: the user's own words, unchanged.
    expect(displayOverride).toBe(original);
  });

  it('sends the draft untouched when nothing was adopted (plain Enter)', () => {
    const original = '改一下 src/ap.ts';
    expect(composeAmbiguitySend(original, [])).toEqual({ text: original, displayOverride: undefined });
  });

  it('renders nothing for an empty hint list', () => {
    expect(buildAmbiguityAnnotation([])).toBe('');
  });
});
