// src/ui/__tests__/chatThinkingResume.test.ts
// Source contracts (chat.test.ts house style) for the interleaved-thinking
// resume path in chat.ts: reasoning that resumes right after answer text
// finalized its card must REOPEN that same card (moved to the transcript
// tail) instead of opening a second card that splits one thought into two —
// the 真机判例 where one thinking stream rendered as two stacked cards
// (split by prose, or by an empty waiting shell that grew the second half).
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
    // appendChild on an attached node moves it: the resumed reasoning reads
    // in order below the answer prose, not inside a card sitting above.
    expect(body).toContain('this.appendToTranscript(resumed.el)');
    expect(body).toContain('reviveThinkingTimer(resumed)');
  });

  it('only an answer-mode finalize arms the resume — tool rows still open a new card per iteration', () => {
    const endThinking = src.indexOf("const endThinking = (mode: 'answer' | 'handoff' = 'handoff') => {");
    expect(endThinking).toBeGreaterThan(-1);
    const tail = src.slice(endThinking, src.indexOf('finalizeStreamingSegments', endThinking));
    // finalize 处只记 answer 模式;工具隔开的是新思考段,保持各一张卡。
    expect(tail).toContain('if (mode === \'answer\') lastThinkingCard = thinkingCard;');
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
