// src/ui/__tests__/chat.test.ts

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseToolCallBuffer, shouldCopyAssistantBubbleTarget, copyAssistantBubbleText, generateTaskPlan, parseClarifyQuestions, generateClarifyingQuestions, pickHistoryMessages, BASE_SYSTEM_PROMPT, shouldCancelForEscape } from '../chat';
import type { Message, LLMAdapter, LLMResponse } from '../../shared/types';
// Regression guard for the layered prompt (promptLayers.ts): a past splice
// bug doubled the "Output style:" header in the composed GUI base prompt.
// Each section header must appear EXACTLY once in every persona variant.
describe('BASE_SYSTEM_PROMPT structure', () => {
  const HEADERS = ['Output style:', 'Tool-calling rules:', 'Smart typo tolerance:', 'Logical traps & approach switching:', '<capabilities>', '<agent_identity>'];

  it('has no duplicated section headers (workspace variant)', () => {
    const prompt = BASE_SYSTEM_PROMPT(true);
    for (const h of HEADERS) {
      const count = prompt.split(h).length - 1;
      expect(count, `${h} should appear exactly once`).toBe(1);
    }
  });

  it('has no duplicated section headers (no-workspace variant)', () => {
    const prompt = BASE_SYSTEM_PROMPT(false);
    for (const h of HEADERS) {
      const count = prompt.split(h).length - 1;
      expect(count, `${h} should appear exactly once`).toBe(1);
    }
  });

  it('has no duplicated section headers (temporary-workspace variant)', () => {
    const prompt = BASE_SYSTEM_PROMPT(true, true);
    for (const h of HEADERS) {
      const count = prompt.split(h).length - 1;
      expect(count, `${h} should appear exactly once`).toBe(1);
    }
  });

  it('wraps tools in <capabilities> and keeps L0 before L1', () => {
    const prompt = BASE_SYSTEM_PROMPT(true);
    expect(prompt.indexOf('<capabilities>')).toBeGreaterThan(prompt.indexOf('</agent_identity>'));
    expect(prompt.indexOf('Output style:')).toBeGreaterThan(prompt.indexOf('<capabilities>'));
  });
});

describe('parseToolCallBuffer', () => {
  it('parses the { name, arguments: string } wrapper format', () => {
    const buf = JSON.stringify({ name: 'web_search', arguments: '{"query":"foo"}' });
    const parsed = parseToolCallBuffer(buf);
    expect(parsed.name).toBe('web_search');
    expect(parsed.args).toEqual({ query: 'foo' });
  });

  it('parses the { name, arguments: object } wrapper format', () => {
    const buf = JSON.stringify({ name: 'read_file', arguments: { path: 'a.ts' } });
    const parsed = parseToolCallBuffer(buf);
    expect(parsed.name).toBe('read_file');
    expect(parsed.args).toEqual({ path: 'a.ts' });
  });

  it('falls back to RAW function-arguments JSON (engine forwards tc.function.arguments verbatim)', () => {
    // This is what the Rust backend actually streams (accumulated arguments
    // object, no wrapper keys). Previously the parser returned no args here,
    // so tool rows rendered with an empty query — two parallel web_search
    // calls looked like ONE duplicated search instead of two queries.
    const buf = '{"query":"西安到重庆 机票 航班 价格","maxResults":10}';
    const parsed = parseToolCallBuffer(buf);
    expect(parsed.name).toBeUndefined();
    expect(parsed.args).toEqual({ query: '西安到重庆 机票 航班 价格', maxResults: 10 });
  });

  it('returns {} for empty or whitespace buffers', () => {
    expect(parseToolCallBuffer(undefined)).toEqual({});
    expect(parseToolCallBuffer('')).toEqual({});
    expect(parseToolCallBuffer('   ')).toEqual({});
  });

  it('returns {} for partial / invalid JSON (mid-stream fragments)', () => {
    expect(parseToolCallBuffer('{"qu')).toEqual({});
    expect(parseToolCallBuffer('not json')).toEqual({});
    expect(parseToolCallBuffer('42')).toEqual({});
    expect(parseToolCallBuffer('null')).toEqual({});
  });

  it('does not misread a name-only payload as args', () => {
    const parsed = parseToolCallBuffer('{"name":"web_search"}');
    expect(parsed.name).toBe('web_search');
    expect(parsed.args).toBeUndefined();
  });
});

describe('assistant bubble copy target policy', () => {
  it('allows ordinary assistant text targets', () => {
    expect(shouldCopyAssistantBubbleTarget(null)).toBe(true);
  });

  it('ignores interactive buttons, links, and diagram targets', () => {
    const target = (selector: string) => ({ closest: (value: string) => value.includes(selector) ? {} : null });
    expect(shouldCopyAssistantBubbleTarget(target('button') as unknown as EventTarget)).toBe(false);
    expect(shouldCopyAssistantBubbleTarget(target('a') as unknown as EventTarget)).toBe(false);
    expect(shouldCopyAssistantBubbleTarget(target('.svg-target') as unknown as EventTarget)).toBe(false);
    expect(shouldCopyAssistantBubbleTarget(target('.chart-target') as unknown as EventTarget)).toBe(false);
    expect(shouldCopyAssistantBubbleTarget(target('.md-img-wrap') as unknown as EventTarget)).toBe(false);
  });
});

describe('assistant bubble copy feedback', () => {
  it('copies text and reports success', async () => {
    const messages: string[] = [];
    const copied = await copyAssistantBubbleText('assistant reply', async (text) => {
      expect(text).toBe('assistant reply');
      return true;
    }, (message) => messages.push(message));
    expect(copied).toBe(true);
    expect(messages).toEqual(['已复制回复内容']);
  });

  it('reports failure when clipboard writing fails', async () => {
    const messages: string[] = [];
    const copied = await copyAssistantBubbleText('assistant reply', async () => false, (message) => messages.push(message));
    expect(copied).toBe(false);
    expect(messages).toEqual(['复制回复内容失败']);
  });

  it('does not invoke clipboard or toast for empty output', async () => {
    let calls = 0;
    const copied = await copyAssistantBubbleText('', async () => { calls++; return true; }, () => { calls++; });
    expect(copied).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('generateTaskPlan (LLM task-specific plan generation)', () => {
  function fakeLlm(content: string, delay = 0): LLMAdapter {
    return {
      async *stream() { yield { type: 'content', content } as any; },
      async complete(): Promise<LLMResponse> {
        if (delay) await new Promise(r => setTimeout(r, delay));
        return { content, toolCalls: undefined };
      },
    } as LLMAdapter;
  }

  it('returns a parsed plan when the LLM returns a JSON array', async () => {
    const llm = fakeLlm('[{"action":"Inspect","description":"Read auth module"},{"action":"Rewrite","description":"Replace token logic"}]');
    const result = await generateTaskPlan(llm, '重构认证模块');
    expect(result.plan).not.toBeNull();
    expect(result.repaired).toBe(false);
    expect(result.plan!.steps).toHaveLength(2);
    expect(result.plan!.steps[0]).toMatchObject({ action: 'Inspect', description: 'Read auth module' });
  });

  it('flags a repaired plan so callers can keep it out of the context window', async () => {
    // Slightly-broken plan JSON: parseable only after repair. The plan is
    // still returned (for the review card), but `repaired: true` tells the
    // caller to skip re-injecting the reconstructed text into the LLM prompt.
    const llm = fakeLlm("[{action: 'Inspect', description: 'Read auth module',},]");
    const result = await generateTaskPlan(llm, '重构认证模块');
    expect(result.plan).not.toBeNull();
    expect(result.repaired).toBe(true);
    expect(result.plan!.steps[0]).toMatchObject({ action: 'Inspect' });
  });

  it('returns null (fallback to heuristic) when the LLM returns malformed JSON', async () => {
    const llm = fakeLlm('sorry, I cannot plan that');
    expect((await generateTaskPlan(llm, 'x')).plan).toBeNull();
  });

  it('returns null (fallback to heuristic) when the LLM call times out', async () => {
    // 10s > the 8s generation timeout — must resolve to null, not hang.
    const llm = fakeLlm('[]', 500);
    expect((await generateTaskPlan(llm, 'x', 50)).plan).toBeNull();
  });
});

describe('Escape cancellation guard', () => {
  it('only cancels a live turn for Escape', () => {
    expect(shouldCancelForEscape('Escape', true)).toBe(true);
    expect(shouldCancelForEscape('Enter', true)).toBe(false);
    expect(shouldCancelForEscape('Escape', false)).toBe(false);
  });

  it('does not produce a plan after the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = {
      complete: async () => ({ content: '[{"action":"x","description":"x","expectedOutcome":"x"}]' }),
    } as any;
    expect((await generateTaskPlan(llm, 'build', 10, controller.signal)).plan).toBeNull();
  });
});

describe('parseClarifyQuestions (pre-plan interview)', () => {
  it('parses a plain JSON array of questions', () => {
    expect(parseClarifyQuestions('["用什么技术栈？","覆盖哪些场馆？"]')).toEqual(['用什么技术栈？', '覆盖哪些场馆？']);
  });

  it('parses fenced output and drops empty entries', () => {
    expect(parseClarifyQuestions('```json\n["Q1", "", "Q2"]\n```')).toEqual(['Q1', 'Q2']);
  });

  it('returns [] on garbage, non-array output, or empty input', () => {
    expect(parseClarifyQuestions('sorry, the request is clear')).toEqual([]);
    expect(parseClarifyQuestions('{"plan": []}')).toEqual([]);
    expect(parseClarifyQuestions('')).toEqual([]);
  });
});

describe('generateClarifyingQuestions (pre-plan interview)', () => {
  function fakeLlm(content: string): LLMAdapter {
    return {
      async *stream() { yield { type: 'content', content } as any; },
      async complete(): Promise<LLMResponse> { return { content, toolCalls: undefined }; },
    } as LLMAdapter;
  }

  it('returns questions when the request is ambiguous', async () => {
    const llm = fakeLlm('["目标平台是什么？","覆盖哪些场馆？"]');
    expect(await generateClarifyingQuestions(llm, '创建一个保障项目', '')).toEqual(['目标平台是什么？', '覆盖哪些场馆？']);
  });

  it('returns [] when the request is clear enough (empty array)', async () => {
    const llm = fakeLlm('[]');
    expect(await generateClarifyingQuestions(llm, '写一个 hello world 网页', '')).toEqual([]);
  });

  it('returns [] on malformed output and on timeout (never blocks the turn)', async () => {
    const bad = fakeLlm('no questions needed');
    expect(await generateClarifyingQuestions(bad, 'x', '')).toEqual([]);
    const hang: LLMAdapter = {
      async *stream() { yield { type: 'content', content: '[]' } as any; },
      complete: () => new Promise(() => {}),
    } as LLMAdapter;
    expect(await generateClarifyingQuestions(hang, 'x', '', 10)).toEqual([]);
  });
});

describe('pickHistoryMessages (background pre-compaction reuse)', () => {
  const full: Message[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const window: Message[] = [
    { role: 'system', content: 'Earlier conversation summary: …' },
    { role: 'assistant', content: 'b' },
  ];

  it('reuses the pre-compacted window when session + message count match', () => {
    expect(pickHistoryMessages(window, 's1', 2, 's1', full)).toBe(window);
  });

  it('falls back to the full history when no pre-compaction is cached', () => {
    expect(pickHistoryMessages(null, 's1', 2, 's1', full)).toBe(full);
  });

  it('falls back when the session changed (stale window from another session)', () => {
    expect(pickHistoryMessages(window, 's1', 2, 's2', full)).toBe(full);
  });

  it('falls back when the message count changed (new turn already appended)', () => {
    const grown: Message[] = [...full, { role: 'user', content: 'c' }];
    expect(pickHistoryMessages(window, 's1', 2, 's1', grown)).toBe(grown);
  });
});

// Plan-gate timing contract (user-facing): on a detected complex task, the
// scaffold plan-progress card must render SYNCHRONOUSLY right after the
// humanized intro — before ANY LLM round-trip in the gate — so the transcript
// never sits with an intro but no steps while the model generates the
// task-specific plan. The card then upgrades in place when the plan lands.
describe('plan-gate timing (scaffold card before LLM calls)', () => {
  it('renders showPlanCard(planForReview) before the first await in the gate', () => {
    const src = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8');
    const scaffold = src.indexOf('showPlanCard(planForReview, true);');
    const firstAwait = Math.min(
      src.indexOf('await buildWorkspaceContext('),
      src.indexOf('await generateClarifyingQuestions('),
      src.indexOf('await generateTaskPlan('),
    );
    expect(scaffold).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(-1);
    expect(scaffold).toBeLessThan(firstAwait);
  });

  it('shows the refining badge on the scaffold card and drops it on the LLM upgrade', () => {
    const src = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8');
    // The scaffold card is created with refining=true (LLM still generating the
    // task-specific plan) and the in-place upgrade with refining=false.
    const scaffoldCall = src.indexOf('showPlanCard(planForReview, true);');
    expect(scaffoldCall).toBeGreaterThan(-1);
    // Match the upgrade call exactly (the `;\n` disambiguates it from the
    // prefix of the longer scaffold call above).
    const upgrade = src.indexOf('showPlanCard(planForReview);\n');
    expect(upgrade).toBeGreaterThan(scaffoldCall);
    // createPlanCard must forward the flag so the badge renders.
    expect(src).toMatch(/createPlanCard\(plan, analysis\.mode, refining\)/);
  });

  it('upgrades the card in place with a fade/slide handoff, not an abrupt swap', () => {
    const src = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8');
    // Old scaffold animates out (plan-card-leaving), the new card animates in
    // (plan-card-entering), and the new card is inserted exactly where the old
    // one sat (old.nextSibling anchor) so the transcript order is preserved.
    expect(src).toMatch(/plan-card-leaving/);
    expect(src).toMatch(/plan-card-entering/);
    expect(src).toMatch(/old\.nextSibling/);
    // The old card is always removed (animationend or a timeout fallback), so
    // the handoff can never leave a ghost card behind.
    expect(src).toMatch(/if \(old\.isConnected\) old\.remove\(\);/);
  });
});
