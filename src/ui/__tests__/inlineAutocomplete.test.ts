// src/ui/__tests__/inlineAutocomplete.test.ts
// The composer autocomplete must never rewrite a draft on its own. Reported
// symptom: a Chinese sentence came out with a long shell command spliced into
// it — a command the user never typed, taken from the agent's own executed
// commands (session stats feed this popup). Two holes caused it: the popup
// claimed the Enter that belongs to the IME (拼音→汉字 commit), and it accepted
// a candidate on a bare Enter that the user meant as "send".

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { InlineAutocomplete, type AutocompleteCandidate } from '../inlineAutocomplete';

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

const COMMAND: AutocompleteCandidate = {
  label: "grep -iE '(ANTHROPIC|OPENAI)' ~/.zshrc",
  insert: "grep -iE '(ANTHROPIC|OPENAI)' ~/.zshrc",
  kind: 'command',
};

function mount(value: string): { input: HTMLTextAreaElement; ac: InlineAutocomplete } {
  const input = document.createElement('textarea');
  input.value = value;
  document.body.appendChild(input);
  input.setSelectionRange(value.length, value.length);
  input.focus();
  const ac = new InlineAutocomplete(input, { extraCandidates: () => [COMMAND] });
  return { input, ac };
}

/** Type text and wait past the 120ms query debounce. */
async function type(input: HTMLTextAreaElement, text: string): Promise<void> {
  input.value += text;
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
}

function key(name: string, extra: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra });
}

describe('InlineAutocomplete', () => {
  it('offers a stored command as a candidate for a typed prefix', async () => {
    const { input, ac } = mount('看一下 ');
    await type(input, 'ANTHROPIC');
    expect(document.querySelector('.ac-popup')).not.toBeNull();
    ac.destroy();
  });

  it('stays out of the way while the IME is composing', async () => {
    const { input, ac } = mount('同步调研当前 AI Agent 方向 ');
    input.dispatchEvent(new Event('compositionstart'));
    await type(input, 'ANTHROPIC');

    // No popup over the sentence being composed...
    expect(document.querySelector('.ac-popup')).toBeNull();
    // ...and no query either: the pinyin buffer is not a search prefix.
    const before = input.value;
    const enter = key('Enter');
    input.dispatchEvent(enter);
    expect(input.value).toBe(before);
    expect(enter.defaultPrevented).toBe(false);

    input.dispatchEvent(new Event('compositionend'));
    ac.destroy();
  });

  it('ignores the IME commit Enter even when no composition event arrived', async () => {
    const { input, ac } = mount('看一下 ');
    await type(input, 'ANTHROPIC');
    const enter = key('Enter', { isComposing: true });
    input.dispatchEvent(enter);
    expect(input.value).toBe('看一下 ANTHROPIC');
    expect(enter.defaultPrevented).toBe(false);
    ac.destroy();
  });

  it('leaves Enter meaning "send" until the user steps into the popup', async () => {
    const { input, ac } = mount('看一下 ');
    await type(input, 'ANTHROPIC');
    const enter = key('Enter');
    input.dispatchEvent(enter);
    // Untouched draft, and not swallowed: the composer's send handler still runs.
    expect(input.value).toBe('看一下 ANTHROPIC');
    expect(enter.defaultPrevented).toBe(false);
    ac.destroy();
  });

  it('accepts with Enter once the user has navigated the list', async () => {
    const { input, ac } = mount('看一下 ');
    await type(input, 'ANTHROPIC');
    input.dispatchEvent(key('ArrowDown'));
    const enter = key('Enter');
    input.dispatchEvent(enter);
    expect(input.value).toBe(`看一下 ${COMMAND.insert}`);
    expect(enter.defaultPrevented).toBe(true);
    ac.destroy();
  });

  it('keeps Tab as an explicit accept — it has no other meaning in a composer', async () => {
    const { input, ac } = mount('看一下 ');
    await type(input, 'ANTHROPIC');
    input.dispatchEvent(key('Tab'));
    expect(input.value).toBe(`看一下 ${COMMAND.insert}`);
    ac.destroy();
  });
});
