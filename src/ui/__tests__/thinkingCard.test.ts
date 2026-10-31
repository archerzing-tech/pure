// src/ui/__tests__/thinkingCard.test.ts
// Covers collapseRepeatedReasoning (the guard against reasoning models looping
// internally) and the live-card elapsed timer / slow-response hint that keep a
// long "正在思考下一步…" from reading as a hung session.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { collapseRepeatedReasoning, createThinkingCard, startThinkingTimer, stopThinkingTimer, finalizeThinkingCard, reopenThinkingCard, dismissThinkingHint, setThinkingLabel, setThinkingNetDiagnosis, setThinkingPendingIntent, resetThinkingLabelForOutput } from '../thinkingCard';

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

  it('keeps recovery hints neutral instead of claiming a network outage', async () => {
    const handle = attachedCard();
    setThinkingLabel(handle, '模型请求未成功，正在重试（连续第 2 次）…');
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 60 });
    await sleep(150);
    const hint = handle.card.querySelector('.thinking-hint')?.textContent ?? '';
    expect(hint).toContain('上一阶段未成功');
    expect(hint).toContain('不表示你的网络已断开');
    expect(hint).not.toContain('网络或 API 异常');
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('default hint names the cause: plain waiting label → model latency, no network claim', async () => {
    const handle = attachedCard();
    // No retry has happened: waiting on the model's first token. The hint must
    // say the likely cause is model-side latency and that NO network anomaly
    // was detected — not lump the two causes together.
    setThinkingLabel(handle, '等待模型首字返回…');
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 60 });
    await sleep(150);
    const hint = handle.card.querySelector('.thinking-hint')?.textContent ?? '';
    // 呈现纪律(2026-10-30):「正在等待模型返回首个内容」退役,轻话术上场。
    expect(hint).toContain('还在等模型开口');
    expect(hint).toContain('深度思考或服务排队');
    expect(hint).toContain('暂未发现连接问题');
    expect(hint).not.toContain('重试');
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('echoes the model\'s pending announce in the hint so a long wait reads as "waiting for the announced step"', async () => {
    const handle = attachedCard();
    // chat.ts 记录模型正文最后一句预告（如「现在写生成脚本」）后开空档卡——
    // hint 必须回指原话，而不是泛化的「深度思考或服务端排队」。
    setThinkingLabel(handle, '正在思考下一步…');
    setThinkingPendingIntent(handle, '现在写生成脚本——这是纯代码产出，直接落盘');
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 60 });
    await sleep(150);
    const hint = handle.card.querySelector('.thinking-hint')?.textContent ?? '';
    expect(hint).toContain('现在写生成脚本');
    expect(hint).toContain('要等这轮开口才真正动手');
    expect(hint).not.toContain('深度思考或服务端排队');
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('escalates the same hint in place after escalateAfterMs, seconds ticking live', async () => {
    const handle = attachedCard();
    setThinkingLabel(handle, '等待模型首字返回…');
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 60, escalateAfterMs: 140 });
    await sleep(100);
    const hintEl = () => handle.card.querySelector<HTMLElement>('.thinking-hint')!;
    expect(hintEl()).not.toBeNull();
    const firstCopy = hintEl().textContent ?? '';
    expect(firstCopy).toContain('还在等模型开口');
    await sleep(150);
    const escalated = hintEl()?.textContent ?? '';
    // 同一元素原地替换（不是新 hint），带实时秒数与弱断言。
    expect(escalated).toContain('已经等了');
    expect(escalated).toMatch(/已经等了 \d+ 秒/);
    expect(escalated).toContain('暂未发现连接问题');
    expect(hintEl().classList.contains('fading')).toBe(false);
    // 秒数不是一次性快照：继续等，hint 里的秒数跟着 chip 一起涨（评审 P1：
    // 冻结在升级时刻的秒数与持续走秒的 chip 自相矛盾）。秒粒度是 1s，两次
    // 读取必须跨过整秒边界才必然可比。
    await sleep(1100);
    const later = parseInt((hintEl()?.textContent ?? '').match(/已经等了 (\d+) 秒/)?.[1] ?? '0', 10);
    const earlier = parseInt(escalated.match(/已经等了 (\d+) 秒/)?.[1] ?? '0', 10);
    expect(later).toBeGreaterThan(earlier);
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('falls back to retry copy when the retry notice arrives AFTER escalation', async () => {
    const handle = attachedCard();
    setThinkingLabel(handle, '等待模型首字返回…');
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 60, escalateAfterMs: 140 });
    await sleep(200);
    expect(handle.card.querySelector('.thinking-hint')?.textContent).toContain('已经等了');
    // 升级已发生后 label 才翻成重试态（FailurePolicy 决定晚到）——下一 tick
    // 必须回落到重试专属文案，不能让「暂未发现请求失败」和「正在重试」同卡互斥。
    setThinkingLabel(handle, '模型请求未成功，正在重试（连续第 1 次）…');
    await sleep(100);
    const hint = handle.card.querySelector('.thinking-hint')?.textContent ?? '';
    expect(hint).toContain('上一阶段未成功');
    expect(hint).not.toContain('已经等了');
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('never escalates a custom hintText (caller-owned copy stays)', async () => {
    const handle = attachedCard();
    setThinkingLabel(handle, '等待模型首字返回…');
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 60, hintText: '定制等待文案', escalateAfterMs: 140 });
    await sleep(300);
    const hint = handle.card.querySelector('.thinking-hint')?.textContent ?? '';
    expect(hint).toBe('定制等待文案');
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('escalation skips retry-state cards (they already have dedicated copy)', async () => {
    const handle = attachedCard();
    setThinkingLabel(handle, '模型请求未成功，正在重试（连续第 2 次）…');
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 60, escalateAfterMs: 140 });
    await sleep(300);
    const hint = handle.card.querySelector('.thinking-hint')?.textContent ?? '';
    expect(hint).toContain('上一阶段未成功');
    expect(hint).not.toContain('已经等了');
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('resets a recovery label as soon as real output resumes', () => {
    const handle = attachedCard();
    handle.card.classList.add('waiting');
    setThinkingLabel(handle, '模型请求未成功，正在重试（连续第 1 次）…');
    resetThinkingLabelForOutput(handle);
    expect(handle.card.classList.contains('waiting')).toBe(false);
    expect(handle.card.querySelector('.thinking-label')?.textContent).toBe('思考');
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

  it('network diagnosis overrides the generic hint in place, at hint time and at escalation', async () => {
    const handle = attachedCard();
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 60 });
    // 诊断晚到（探测 8s 超时内才返回）：已显示的 hint 被原地说真话覆盖。
    await sleep(90);
    const hint = handle.card.querySelector<HTMLElement>('.thinking-hint');
    expect(hint).not.toBeNull();
    setThinkingNetDiagnosis(handle, '到模型服务的连接超时：这不是模型在思考');
    expect(hint!.textContent).toBe('到模型服务的连接超时：这不是模型在思考');
    // 升级线（45s）不盖掉诊断——网络故障面前「模型思考常要一两分钟」是误导。
    await sleep(60);
    expect(handle.card.querySelector<HTMLElement>('.thinking-hint')!.textContent).toBe('到模型服务的连接超时：这不是模型在思考');
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('a diagnosis arriving after real output started does not touch the card', async () => {
    const handle = attachedCard();
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 60 });
    handle.textEl.textContent = '真实推理内容';
    await sleep(90);
    setThinkingNetDiagnosis(handle, '到模型服务的连接超时');
    expect(handle.card.querySelector('.thinking-hint')).toBeNull();
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('dismissThinkingHint fades the hint out and removes it; idempotent when absent', async () => {
    const handle = attachedCard();
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 60, hintText: '等待中…' });
    await sleep(120);
    expect(handle.card.querySelector('.thinking-hint')).not.toBeNull();

    dismissThinkingHint(handle);
    // Fading state is marked immediately, element leaves the DOM shortly after.
    expect(handle.card.querySelector('.thinking-hint')?.classList.contains('fading')).toBe(true);
    await sleep(500);
    expect(handle.card.querySelector('.thinking-hint')).toBeNull();

    // No hint present → safe no-op.
    dismissThinkingHint(handle);
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('dismissThinkingHint with a delay lingers 1s after output shows, then fades', async () => {
    const handle = attachedCard();
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 40, hintText: '等待中…' });
    await sleep(100);
    const hint = handle.card.querySelector('.thinking-hint');
    expect(hint).not.toBeNull();
    // Output became visible → schedule dismissal with a linger window.
    dismissThinkingHint(handle, 120);
    // Still fully visible during the dwell (no fading class yet)…
    expect(hint?.classList.contains('fading')).toBe(false);
    await sleep(60);
    expect(hint?.classList.contains('fading')).toBe(false);
    // …fading starts once the dwell elapses…
    await sleep(100);
    expect(hint?.classList.contains('fading')).toBe(true);
    // …and the element leaves the DOM after the fade completes.
    await sleep(500);
    expect(handle.card.querySelector('.thinking-hint')).toBeNull();
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('the first delayed call anchors the deadline; later deltas never extend it', async () => {
    const handle = attachedCard();
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 40, hintText: '等待中…' });
    await sleep(100);
    const hint = handle.card.querySelector('.thinking-hint')!;
    dismissThinkingHint(handle, 150);
    await sleep(50);
    // A second delta arrives mid-dwell — must be a no-op.
    dismissThinkingHint(handle, 10_000);
    await sleep(200);
    expect(hint.classList.contains('fading')).toBe(true);
    await sleep(500);
    expect(handle.card.querySelector('.thinking-hint')).toBeNull();
    stopThinkingTimer(handle);
    handle.el.remove();
  });

  it('finalize keeps a mid-linger hint alive (its own fade owns removal)', async () => {
    const handle = attachedCard();
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 40 });
    await sleep(100);
    dismissThinkingHint(handle, 150);
    finalizeThinkingCard(handle);
    // Not removed outright — the scheduled linger still finishes the job.
    expect(handle.body.querySelector('.thinking-hint')).not.toBeNull();
    await sleep(600);
    expect(handle.body.querySelector('.thinking-hint')).toBeNull();
    handle.el.remove();
  });

  it('finalize removes a lingering hint outright', async () => {
    const handle = attachedCard();
    startThinkingTimer(handle, { intervalMs: 25, hintAfterMs: 60 });
    await sleep(120);
    finalizeThinkingCard(handle);
    expect(handle.card.querySelector('.thinking-hint')).toBeNull();
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

  it('reopen revives a finalized card: live state back, frozen label and dots restored, content kept', () => {
    const handle = attachedCard();
    handle.textEl.textContent = '思考前半。';
    finalizeThinkingCard(handle);
    expect(handle.card.classList.contains('complete')).toBe(true);
    expect(handle.card.querySelector('.thinking-dots')).toBeNull();

    reopenThinkingCard(handle);
    // live 态还原:thinking 类回位、dots 重建、label 回「思考中」(不带冻结时长)。
    expect(handle.card.classList.contains('thinking')).toBe(true);
    expect(handle.card.classList.contains('complete')).toBe(false);
    expect(handle.card.querySelector('.thinking-dots')).not.toBeNull();
    const label = handle.card.querySelector<HTMLElement>('.thinking-label')!.textContent ?? '';
    expect(label).not.toMatch(/· \d+s$/);
    // 内容是 reopen 的全部意义:前半原文一字不动。
    expect(handle.textEl.textContent).toContain('思考前半。');
    // 往返稳定:finalize → reopen → finalize 不炸、不重复 dots。
    finalizeThinkingCard(handle);
    reopenThinkingCard(handle);
    expect(handle.card.querySelectorAll('.thinking-dots').length).toBe(1);
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
