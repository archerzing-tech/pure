// src/ui/__tests__/thinkingCard.test.ts
// Covers collapseRepeatedReasoning (the guard against reasoning models looping
// internally) and the live-card elapsed timer / slow-response hint that keep a
// long "正在思考下一步…" from reading as a hung session.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { collapseRepeatedReasoning, createThinkingCard, startThinkingTimer, stopThinkingTimer, finalizeThinkingCard } from '../thinkingCard';

beforeAll(() => {
  if (typeof document === 'undefined') GlobalRegistrator.register();
});

afterAll(() => {
  if (typeof document !== 'undefined') GlobalRegistrator.unregister();
});

describe('collapseRepeatedReasoning', () => {
  it('collapses a repeated two-sentence loop to a single period', () => {
    const a = "After calling sys_info(), I'll have the current date and day information.";
    const b = "I'll call sys_info() now:";
    const loop = [a, b, a, b, a, b, a, b].join('\n\n');
    const out = collapseRepeatedReasoning(loop);
    expect(out).toBe(`${a}\n\n${b}`);
    expect(out).not.toContain('I\'ll call sys_info() now:\n\nI\'ll call sys_info() now:');
  });

  it('collapses a single repeated paragraph', () => {
    const p = 'Let me verify the date first.';
    const out = collapseRepeatedReasoning([p, p, p, p].join('\n\n'));
    expect(out).toBe(p);
  });

  it('handles a partial trailing period', () => {
    const a = 'Step one.';
    const b = 'Step two.';
    const out = collapseRepeatedReasoning([a, b, a, b, a].join('\n\n'));
    expect(out).toBe(`${a}\n\n${b}`);
  });

  it('leaves varied reasoning untouched', () => {
    const varied = '先查日期。\n\n查到了，今天是周三。\n\n接下来给出星期几的结论。';
    expect(collapseRepeatedReasoning(varied)).toBe(varied);
  });

  it('does not collapse short text with no repetition', () => {
    expect(collapseRepeatedReasoning('只有一个段落。')).toBe('只有一个段落。');
    expect(collapseRepeatedReasoning('')).toBe('');
  });

  it('does not collapse a two-block text that is not a repeat', () => {
    const text = 'Block A.\n\nBlock B.';
    expect(collapseRepeatedReasoning(text)).toBe(text);
  });
});

describe('live thinking card timer (long-silence feedback)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function attachedCard() {
    const handle = createThinkingCard();
    document.body.appendChild(handle.el);
    return handle;
  }

  it('ticks an elapsed-seconds chip beside the label', async () => {
    const handle = attachedCard();
    startThinkingTimer(handle, { intervalMs: 30 });
    const chip = () => handle.card.querySelector<HTMLElement>('.thinking-timer')!;
    expect(chip()).not.toBeNull();
    expect(chip().textContent).toBe('0s');
    await sleep(120);
    const secs = parseInt(chip().textContent ?? 'x', 10);
    expect(secs).toBeGreaterThanOrEqual(2);
    stopThinkingTimer(handle);
    expect(handle.card.querySelector('.thinking-timer')).toBeNull();
    handle.el.remove();
  });

  it('inserts the slow-response hint once the silence crosses the threshold with no reasoning text', async () => {
    const handle = attachedCard();
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 80, hintText: '仍在等待模型…' });
    await sleep(200);
    expect(handle.card.querySelector('.thinking-hint')?.textContent).toContain('仍在等待模型');
    // The hint sits ABOVE the reasoning scroll window inside the body.
    expect(handle.body.firstElementChild?.className).toBe('thinking-hint');
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('never hints once real reasoning text has arrived', async () => {
    const handle = attachedCard();
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 60 });
    handle.textEl.textContent = '真实推理内容';
    await sleep(150);
    expect(handle.card.querySelector('.thinking-hint')).toBeNull();
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('finalize freezes the duration into the done label and removes the chip', async () => {
    const handle = attachedCard();
    document.body.appendChild(handle.el); // already appended; keep reference
    startThinkingTimer(handle, { intervalMs: 20 });
    handle.textEl.textContent = '推理正文';
    await sleep(90); // ≥ ~4 ticks at 20ms
    finalizeThinkingCard(handle);
    expect(handle.card.querySelector('.thinking-timer')).toBeNull();
    expect(handle.card.classList.contains('complete')).toBe(true);
    expect(handle.card.querySelector<HTMLElement>('.thinking-label')!.textContent).toMatch(/· \d+s$/);
    handle.el.remove();
  });

  it('stopThinkingTimer is idempotent and safe on detached cards', () => {
    const handle = attachedCard();
    startThinkingTimer(handle, { intervalMs: 20 });
    stopThinkingTimer(handle);
    stopThinkingTimer(handle);
    handle.el.remove();
    // Removing the card cancels its own interval on the next tick — no throw.
    const detached = createThinkingCard();
    startThinkingTimer(detached, { intervalMs: 20 });
    stopThinkingTimer(detached);
  });
});
