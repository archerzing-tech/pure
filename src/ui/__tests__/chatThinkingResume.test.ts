// src/ui/__tests__/chatThinkingResume.test.ts
// Source contracts (chat.test.ts house style) for the interleaved-thinking
// resume path in chat.ts: reasoning that resumes right after answer text
// finalized its card must REOPEN that same card instead of opening a second
// card that splits one thought into two — the 真机判例 where one thinking
// stream rendered as two stacked cards (split by prose, or by an empty
// waiting shell that grew the second half).
// Reopening happens IN PLACE: the 2026-11-15 真机判例「总是先显示结果,再显示
// 思考过程」was caused by moving the resumed card to the transcript tail —
// the answer prose stayed above it, so the result streamed before the thinking
// that produced it. The card must therefore never be re-parented here.
// Pure readFileSync — no chat import, immune to the cross-file mock landmine.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8');

describe('interleaved thinking resume (one card per thought stream)', () => {
  it('the resume branch reopens the finalized card instead of opening a fresh one', () => {
    expect(src).toContain('import { createThinkingCard, appendThinkingText, finalizeThinkingCard, reopenThinkingCard');
    const branch = src.indexOf('const resumingSameStream');
    expect(branch).toBeGreaterThan(-1);
    const body = src.slice(branch, branch + 900);
    expect(body).toContain('lastThinkingCard');
    expect(body).toContain('reopenThinkingCard(resumed)');
    expect(body).toContain('reviveThinkingTimer(resumed)');
    // 原地续写：思考卡不许被搬到正文下面（「结果先于思考」的根因）。
    expect(body).not.toContain('appendToTranscript(resumed.el)');
  });

  it('only an answer-mode finalize arms the resume — tool rows clear the pointer', () => {
    const endThinking = src.indexOf("const endThinking = (mode: 'answer' | 'handoff' = 'handoff') => {");
    expect(endThinking).toBeGreaterThan(-1);
    const tail = src.slice(endThinking, src.indexOf('finalizeStreamingSegments', endThinking));
    // finalize 处只记 answer 模式;工具隔开的是新思考段,保持各一张卡。
    expect(tail).toContain('if (mode === \'answer\') lastThinkingCard = thinkingCard;');
    // handoff（工具行/计划卡接管）作废旧指针：否则搬家逻辑一去掉，旧卡会被
    // 后续 reasoning 抓回来在工具行上方续写。
    expect(tail).toContain("if (mode === 'handoff') lastThinkingCard = null;");
  });

  it('an empty waiting shell opened during the silence yields to the resumed card', () => {
    const branch = src.indexOf('const waitingShell');
    expect(branch).toBeGreaterThan(-1);
    const body = src.slice(branch, branch + 700);
    // 壳判据:waiting 类 + 从未收到内容;非空壳(已长出文本)不弃。
    expect(body).toContain("thinkingCard.card.classList.contains('waiting')");
    expect(body).toContain('!thinkingCard.textEl.textContent');
    expect(body).toContain('thinkingCard.el.remove()');
  });
});
