// src/ui/__tests__/chat.test.ts

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseToolCallBuffer, shouldCopyAssistantBubbleTarget, copyAssistantBubbleText, generateTaskAnalysis, parseTaskAnalysisText, pickHistoryMessages, mergeTranscriptWithTurn, BASE_SYSTEM_PROMPT, shouldCancelForEscape, shouldEnterPlanReview, parseIntentAssessmentBlock, mergeIntentAssessments } from '../chat';
import { limitStoredMessages, MAX_PERSISTED_MESSAGES } from '../store';
import type { Message, LLMAdapter, LLMResponse } from '../../shared/types';

function readSource(url: URL): string {
  return readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
}
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

describe('generateTaskAnalysis (streamed LLM analysis + task-specific plan)', () => {
  function fakeLlm(content: string, delay = 0): LLMAdapter {
    return {
      async *stream() {
        if (delay) await new Promise(r => setTimeout(r, delay));
        yield { type: 'content', content } as any;
      },
      async complete(): Promise<LLMResponse> {
        if (delay) await new Promise(r => setTimeout(r, delay));
        return { content, toolCalls: undefined };
      },
    } as LLMAdapter;
  }

  it('streams the analysis and returns the task-specific plan', async () => {
    const llm = fakeLlm('<analysis>这是一个山东省5G监控系统，需要实时监控所有城市的现网状态，难度高，涉及数据接入、可视化与风险分析。</analysis>\n```json\n[{"action":"设计数据模型","description":"定义城市与网络状态数据"},{"action":"搭建监控大屏","description":"实现地图可视化和城市下钻"},{"action":"补充测试并验证","description":"为关键行为补充测试并运行"}]```');
    const deltas: string[] = [];
    const result = await generateTaskAnalysis(llm, '创建山东省5G监控系统', 200, undefined, { onThinking: (d) => deltas.push(d) });
    expect(deltas.join('')).toContain('山东省5G监控系统');
    expect(result.analysis).toContain('山东省5G监控系统');
    expect(result.analysis).toContain('难度高');
    expect(result.plan).not.toBeNull();
    expect(result.repaired).toBe(false);
    expect(result.plan!.steps[0]).toMatchObject({ action: '设计数据模型' });
  });

  it('keeps machine-readable plan metadata out of the visible thinking trace', async () => {
    const llm = fakeLlm('先确认数据是否真实可接入。\n```json\n[{"action":"接入数据","description":"d"}]```');
    const deltas: string[] = [];
    await generateTaskAnalysis(llm, '创建监控大屏', 200, undefined, { onThinking: (d) => deltas.push(d) });
    const visible = deltas.join('');
    expect(visible).toContain('先确认数据是否真实可接入');
    expect(visible).not.toContain('```');
    expect(visible).not.toContain('接入数据');
  });

  it('parses a bare JSON array (no <analysis>/fence) for backward compatibility', async () => {
    const llm = fakeLlm('[{"action":"Inspect","description":"Read auth module"},{"action":"Rewrite","description":"Replace token logic"}]');
    const result = await generateTaskAnalysis(llm, '重构认证模块');
    expect(result.plan).not.toBeNull();
    expect(result.repaired).toBe(false);
    expect(result.plan!.steps).toHaveLength(2);
    expect(result.plan!.steps.at(-1)).toMatchObject({ action: 'Rewrite', todosRequired: false });
    expect(result.plan!.steps[0]).toMatchObject({ action: 'Inspect', description: 'Read auth module' });
  });

  it('flags a repaired plan so callers can keep it out of the context window', async () => {
    // Slightly-broken plan JSON: parseable only after repair. The plan is
    // still returned (for the review card), but `repaired: true` tells the
    // caller to skip re-injecting the reconstructed text into the LLM prompt.
    const llm = fakeLlm("[{action: 'Inspect', description: 'Read auth module',},]");
    const result = await generateTaskAnalysis(llm, '重构认证模块');
    expect(result.plan).not.toBeNull();
    expect(result.repaired).toBe(true);
    expect(result.plan!.steps[0]).toMatchObject({ action: 'Inspect' });
  });

  it('returns null (fallback to heuristic) when the LLM returns malformed output', async () => {
    const llm = fakeLlm('sorry, I cannot plan that');
    expect((await generateTaskAnalysis(llm, 'x')).plan).toBeNull();
  });

  it('returns null (fallback to heuristic) when the LLM call times out', async () => {
    // 500ms delay > the 50ms analysis timeout — must resolve to null, not hang.
    const llm = fakeLlm('[]', 500);
    expect((await generateTaskAnalysis(llm, 'x', 50)).plan).toBeNull();
  });

  it('stops streaming thinking deltas once the timeout fires (no generator leak)', async () => {
    // A slow stream that keeps yielding after the timeout: the in-loop timeout
    // flag must stop consumption, so onThinking never fires again.
    const deltas: string[] = [];
    const llm: LLMAdapter = {
      async *stream() {
        await new Promise(r => setTimeout(r, 80));
        for (let i = 0; i < 5; i++) {
          yield { type: 'content', content: `chunk-${i}` } as any;
        }
      },
      complete: async () => ({ content: '[]', toolCalls: undefined }),
    } as LLMAdapter;
    const result = await generateTaskAnalysis(llm, 'x', 30, undefined, { onThinking: (d) => deltas.push(d) });
    expect(result.plan).toBeNull();
    expect(deltas.join('')).not.toContain('chunk-');
  });

  it('cleans the timeout when the LLM completes before the deadline', async () => {
    const llm = fakeLlm('[]');
    const before = performance.now();
    expect((await generateTaskAnalysis(llm, 'x', 200)).plan).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(performance.now() - before).toBeLessThan(100);
  });
});

describe('parseTaskAnalysisText (analysis + plan extraction)', () => {
  it('splits <analysis> prose from the fenced plan JSON and strips the tags', () => {
    const r = parseTaskAnalysisText('<analysis>这是一个监控系统，覆盖全省各地市。</analysis>\n```json\n[{"action":"A","description":"d"}]```', 'x');
    expect(r.analysis).toContain('监控系统');
    expect(r.analysis).not.toContain('<analysis>');
    expect(r.analysis).not.toContain('json');
    expect(r.plan?.steps).toHaveLength(1);
  });

  it('keeps the bare-array legacy contract (no analysis, no fence)', () => {
    const r = parseTaskAnalysisText('[{"action":"A","description":"d"}]', 'x');
    expect(r.analysis).toBe('');
    expect(r.plan?.steps).toHaveLength(1);
  });

  it('returns null plan for prose-only output', () => {
    const r = parseTaskAnalysisText('我先梳理一下这个任务……', 'x');
    expect(r.plan).toBeNull();
  });

  it('parses the model\'s <intent_assessment> block for the safety card', () => {
    const r = parseTaskAnalysisText(
      '<analysis>这是一个监控系统。</analysis>\n```json\n[{"action":"A","description":"d"}]```\n<intent_assessment>\n{"intent":"build","riskLevel":"high","reversibility":"irreversible","impact":"覆盖历史数据","recommendation":"先列影响再确认","requiresProbe":true,"requiresConfirmation":true}\n</intent_assessment>',
      'x',
    );
    expect(r.llmIntent).not.toBeNull();
    expect(r.llmIntent?.intent).toBe('build');
    expect(r.llmIntent?.riskLevel).toBe('high');
    expect(r.llmIntent?.reversibility).toBe('irreversible');
    expect(r.llmIntent?.requiresConfirmation).toBe(true);
  });

  it('degrades to null llmIntent when the block is missing', () => {
    const r = parseTaskAnalysisText('[{"action":"A","description":"d"}]', 'x');
    expect(r.llmIntent).toBeNull();
  });

  it('degrades to null llmIntent on an invalid enum value', () => {
    const block = '<intent_assessment>{"intent":"build","riskLevel":"extreme","reversibility":"reversible"}</intent_assessment>';
    expect(parseIntentAssessmentBlock(block)).toBeNull();
  });
});

describe('mergeIntentAssessments (LLM judgment with rules-layer conservative fallback)', () => {
  const heuristic = {
    intent: 'modify' as const,
    riskLevel: 'low' as const,
    reversibility: 'reversible' as const,
    impact: '规则影响',
    recommendation: '规则建议',
    requiresProbe: false,
    requiresConfirmation: false,
  };

  it('lets the LLM raise risk above the rules layer (rules never lower)', () => {
    const llm = { ...heuristic, riskLevel: 'high' as const, requiresConfirmation: true };
    const merged = mergeIntentAssessments(heuristic, llm);
    expect(merged.riskLevel).toBe('high');
    expect(merged.requiresConfirmation).toBe(true);
    expect(merged.requiresProbe).toBe(true); // high risk implies probe
  });

  it('keeps the rules-layer high risk when the LLM under-rates it', () => {
    const rulesHigh = { ...heuristic, riskLevel: 'high' as const, requiresConfirmation: true };
    const llm = { ...heuristic, riskLevel: 'low' as const, requiresConfirmation: false };
    const merged = mergeIntentAssessments(rulesHigh, llm);
    expect(merged.riskLevel).toBe('high');
    expect(merged.requiresConfirmation).toBe(true);
  });

  it('takes the worse reversibility of the two sides', () => {
    const llm = { ...heuristic, reversibility: 'irreversible' as const };
    expect(mergeIntentAssessments(heuristic, llm).reversibility).toBe('irreversible');
  });

  it('prefers the LLM intent/impact/recommendation when present', () => {
    const llm = { ...heuristic, intent: 'refactor' as const, impact: '模型影响', recommendation: '模型建议' };
    const merged = mergeIntentAssessments(heuristic, llm);
    expect(merged.intent).toBe('refactor');
    expect(merged.impact).toBe('模型影响');
    expect(merged.recommendation).toBe('模型建议');
  });

  it('falls back to the heuristic untouched when the LLM gives no assessment', () => {
    expect(mergeIntentAssessments(heuristic, null)).toEqual(heuristic);
  });

  it('requires confirmation when EITHER side demands it (conservative union)', () => {
    const llm = { ...heuristic, requiresConfirmation: true };
    expect(mergeIntentAssessments(heuristic, llm).requiresConfirmation).toBe(true);
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
    expect((await generateTaskAnalysis(llm, 'build', 10, controller.signal)).plan).toBeNull();
  });
});

describe('TASK_ANALYSIS_PROMPT keeps reasoning natural and task-specific', () => {
  it('does not prescribe fixed headings or a fixed plan count', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    expect(src).toContain('natural, conversational reasoning');
    expect(src).toContain('Do not use prescribed headings, a fixed number of sections');
    expect(src).toContain('Choose the number and granularity from the work itself');
    expect(src).toContain('Do NOT invent file contents or claim that an external data source exists');
  });

  it('has no fixed pre-plan clarify card and no clarify interview round-trip', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 用户要求：不再在思考前弹固定的“开工前先确认几个问题”卡——问题由模型在
    // 执行语境中自然提出。
    expect(src.indexOf('requestClarifications(')).toBe(-1);
    expect(src.indexOf('generateClarifyingQuestions(')).toBe(-1);
    expect(src.indexOf('开工前先确认几个问题')).toBe(-1);
  });
});

describe('proactive safety review gate', () => {
  it('keeps normal continuation on the existing plan path', () => {
    expect(shouldEnterPlanReview(true, false, true, false, false)).toBe(false);
    expect(shouldEnterPlanReview(false, false, true, false, false)).toBe(true);
  });

  it('reopens review for high-risk requests in active and paused plan states', () => {
    expect(shouldEnterPlanReview(true, false, true, false, true)).toBe(true);
    expect(shouldEnterPlanReview(false, true, true, false, true)).toBe(true);
    expect(shouldEnterPlanReview(true, true, false, false, true)).toBe(true);
  });

  it('does not force review for a low-risk turn when planning is disabled', () => {
    expect(shouldEnterPlanReview(false, false, false, false, false)).toBe(false);
  });

  it('honors the shared workflow compiler without reopening ordinary plan continuations', () => {
    expect(shouldEnterPlanReview(true, false, true, false, false, true)).toBe(false);
    expect(shouldEnterPlanReview(false, false, true, false, false, true)).toBe(true);
    expect(shouldEnterPlanReview(false, false, false, false, false, false)).toBe(false);
    expect(shouldEnterPlanReview(true, false, false, false, true, false)).toBe(true);
  });
});

describe('LLM-informed risk calibration (P0: model judgment settles the safety card)', () => {
  it('asks the model for an <intent_assessment> block after the plan JSON', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    expect(src.indexOf('TASK_ANALYSIS_PROMPT')).toBeGreaterThan(-1);
    expect(src.indexOf('<intent_assessment>')).toBeGreaterThan(-1);
    expect(src.indexOf('requiresConfirmation MUST be true when riskLevel is high')).toBeGreaterThan(-1);
  });

  it('merges the LLM assessment into effectiveIntent before the card appears', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const merge = src.indexOf('effectiveIntent = mergeIntentAssessments(analysis.intent, llmAnalysis.llmIntent);');
    expect(src).toContain('userAssessment = formatIntentPrompt(effectiveIntent);');
    const call = src.indexOf('maybeShowAssessment();', merge);
    const card = src.indexOf('assessmentFlow = createAssessmentFlowCard(effectiveIntent);');
    const riskReview = src.indexOf('let riskReview = effectiveIntent.requiresConfirmation;');
    expect(merge).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(merge); // 合并先于评估卡真正创建
    expect(card).toBeGreaterThan(-1);
    expect(riskReview).toBeGreaterThan(-1);
  });

  it('reopens the confirm gate when the model raises risk after the merge (no stale rules-only decision)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const merge = src.indexOf('effectiveIntent = mergeIntentAssessments(analysis.intent, llmAnalysis.llmIntent);');
    const recheck = src.indexOf('riskReview = effectiveIntent.requiresConfirmation;', merge);
    const gate = src.indexOf('const needsInteractiveApproval = riskReview || forcedMode === \'plan\' || forcedMode === \'build\';', recheck);
    expect(merge).toBeGreaterThan(-1);
    expect(recheck).toBeGreaterThan(merge);
    expect(gate).toBeGreaterThan(recheck);
  });
});

describe('send feedback timing', () => {
  it('paints the user bubble before send-time DOM and workspace work', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const bubble = src.indexOf("const userBubble = this.addBubble('user', userText);");
    const paint = src.indexOf('await yieldToNextPaint();', bubble);
    const secondFrame = src.indexOf('requestAnimationFrame(() => requestAnimationFrame', src.indexOf('function yieldToNextPaint'));
    const linkify = src.indexOf('linkifyPaths(userBubble);', bubble);
    const resolveWorkspace = src.indexOf('await getApplicationTmpWorkspace(sendSessionId);', bubble);
    expect(bubble).toBeGreaterThan(-1);
    expect(paint).toBeGreaterThan(bubble);
    expect(secondFrame).toBeGreaterThan(-1);
    expect(linkify).toBeGreaterThan(paint);
    expect(resolveWorkspace).toBeGreaterThan(paint);
  });

  it('deduplicates overlapping plan-marker scans by absolute stream position', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    expect(src).toContain('consumedMarkers: new Set<string>()');
    expect(src).toContain('planTrack.consumedMarkers.clear()');
    expect(src).toContain('const markerKey = `${marker.kind}:${marker.number}:${tailStart + marker.index}`;');
    expect(src).toContain('if (planTrack.consumedMarkers.has(markerKey)) continue;');
  });

  it('keeps background pre-compaction cancellable and idle-scheduled', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const precompact = src.indexOf('private preCompactInBackground');
    const idle = src.indexOf('requestIdleCallback', precompact);
    const cancelInPrecompact = src.indexOf('this.cancelBackgroundPreCompaction();', precompact);
    const yieldBeforeTrim = src.indexOf('setTimeout(resolve, 0)', precompact);
    const trim = src.indexOf('const compaction = await ctx.compact', precompact);
    expect(precompact).toBeGreaterThan(-1);
    expect(idle).toBeGreaterThan(precompact);
    expect(cancelInPrecompact).toBeGreaterThan(precompact);
    expect(yieldBeforeTrim).toBeGreaterThan(precompact);
    expect(trim).toBeGreaterThan(yieldBeforeTrim);
    expect(src.match(/this\.cancelBackgroundPreCompaction\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});

describe('bounded session message history', () => {
  it('keeps the system prompt and newest messages within the persistence bound', () => {
    const messages = Array.from({ length: MAX_PERSISTED_MESSAGES + 20 }, (_, i) => ({
      role: i === 0 ? 'system' : 'user',
      content: String(i),
    }));
    const bounded = limitStoredMessages(messages);
    expect(bounded).toHaveLength(MAX_PERSISTED_MESSAGES);
    expect(bounded[0]?.role).toBe('system');
    expect(bounded.at(-1)?.content).toBe(String(MAX_PERSISTED_MESSAGES + 19));
  });
});

describe('mergeTranscriptWithTurn (visible transcript stays complete)', () => {
  it('appends only the new turn when model history was compacted', () => {
    const transcript: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old answer' },
    ];
    const modelMessages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'system', content: 'Earlier conversation summary: old request' },
      { role: 'assistant', content: 'recent context' },
      { role: 'user', content: '<task_context>\nassessment\n</task_context>\n\nnew request' },
      { role: 'assistant', content: 'new answer' },
    ];

    expect(mergeTranscriptWithTurn(transcript, modelMessages, 'new request')).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: '<task_context>\nassessment\n</task_context>\n\nnew request' },
      { role: 'assistant', content: 'new answer' },
    ]);
  });

  it('keeps the first turn system prompt when the transcript is empty', () => {
    const modelMessages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'new request' },
      { role: 'assistant', content: 'new answer' },
    ];
    expect(mergeTranscriptWithTurn([], modelMessages, 'new request')).toEqual(modelMessages);
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

  it('falls back when the same-length transcript reference was replaced', () => {
    const current = [...full];
    const original = [...full];
    expect(pickHistoryMessages(window, 's1', 2, 's1', current, original)).toBe(current);
    expect(pickHistoryMessages(window, 's1', 2, 's1', original, original)).toBe(window);
  });
});

// Plan-gate timing contract (user-facing): on a detected complex task, a
// thinking card must open SYNCHRONOUSLY right after the humanized intro —
// before ANY LLM round-trip in the gate — so the user watches the model's
// real analysis of THIS task stream in, and the task-specific plan card
// renders only when that analysis lands. The fixed generic scaffold survives
// ONLY as the failure/timeout fallback, never as the first thing shown.
describe('plan-gate timing (thinking card before LLM calls)', () => {
  it('updates the existing plan list instead of replacing it after LLM refinement', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const show = src.indexOf('const showPlanCard = (plan: Plan, refining = false): void => {');
    const update = src.indexOf('updatePlanCard(planCard, plan, analysis.mode, refining);', show);
    const oldReplace = src.indexOf('old.classList.add(\'plan-card-leaving\')', show);
    expect(show).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(show);
    expect(oldReplace).toBe(-1);
  });

  it('opens the thinking card before workspace probing and model analysis', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const thinking = src.indexOf('const earlyAnalysisCard = shouldRunTaskAnalysis ? openThinkingCard() : null;');
    const firstProbe = src.indexOf('await discoverWorkspace(');
    const firstContextRead = src.indexOf('await buildWorkspaceContext(');
    const firstAnalysis = src.indexOf('await generateTaskAnalysis(');
    expect(thinking).toBeGreaterThan(-1);
    expect(firstProbe).toBeGreaterThan(thinking);
    expect(firstContextRead).toBeGreaterThan(thinking);
    expect(firstAnalysis).toBeGreaterThan(thinking);
  });

  it('renders the task-specific plan card only after the LLM analysis lands', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const analysisCall = src.indexOf('await generateTaskAnalysis(');
    const planRender = src.indexOf('showPlanCard(planForReview);\n');
    expect(analysisCall).toBeGreaterThan(-1);
    expect(planRender).toBeGreaterThan(analysisCall);
    // The generic scaffold survives ONLY in the fallback branch, explicitly
    // flagged as a fallback via a warning status bubble — never the first thing
    // the user sees.
    const fallback = src.indexOf('实时分析未完成，已回退到通用步骤');
    expect(fallback).toBeGreaterThan(analysisCall);
    expect(src).toMatch(/createPlanCard\(plan, analysis\.mode, refining\)/);
  });

  it('shows the assessment card only after the first LLM round-trip (real thinking first)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // The assessment card must never be created synchronously from the
    // heuristic before any model interaction — it appears only after the LLM
    // analysis has streamed (thinking card) and the interview ran.
    const firstLlm = src.indexOf('await generateTaskAnalysis(');
    const cardCall = src.indexOf('maybeShowAssessment();');
    expect(firstLlm).toBeGreaterThan(-1);
    expect(cardCall).toBeGreaterThan(-1);
    expect(cardCall).toBeGreaterThan(firstLlm);
    // The old instant-heuristic card ("已识别为 … 请求，正在评估影响范围…") must be gone.
    expect(src.indexOf('已识别为 ${analysis.intent.intent} 请求')).toBe(-1);
  });

  it('does not force project builds through a generic approval dialog', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const gate = src.indexOf('const needsInteractiveApproval = riskReview || forcedMode === \'plan\' || forcedMode === \'build\';');
    const review = src.indexOf('await requestPlanReview(', gate);
    const autoStart = src.indexOf('approvePlan(true);', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(review).toBeGreaterThan(gate);
    expect(autoStart).toBeGreaterThan(gate);
    expect(src).not.toContain('needsDeliveryGate && forcedMode !== \'yolo\'');
  });

  it('keeps explicit plan/build mode as the opt-in approval path', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    expect(src).toContain("forcedMode === 'plan' || forcedMode === 'build'");
    expect(src).not.toContain("needsDeliveryGate && forcedMode !== 'yolo'");
  });

  it('keeps the user message visible when the turn is paused mid-preflight (stop button)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 停止/取消时用户消息必须留在对话里（这是发送记录，不是幽灵气泡）：所有预检
    // 中止分支走 keepOrDropUserBubble，仅在切换到其他会话时才移除气泡。
    expect(src).toContain('const keepOrDropUserBubble = (pausedText: string): void => {');
    expect(src).toContain("keepOrDropUserBubble('⏸ 已暂停：你的请求已保留在对话中。')");
    // Every remaining userBubble.remove() is guarded by a session-switch check.
    expect(src).toMatch(/if \(gen !== this\.generation\) \{\s*userBubble\.remove\(\);\s*return;\s*\}/);
  });

  it('wires the abort signal into the plan-review dialog', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 停止按钮在计划确认显示期间必须生效，否则 send() 会永久挂起。
    expect(src).toContain('riskReview, signal: this.abortController?.signal }');
  });

  it('runs the delivery gate only when the turn did real tool work, never on a question-only turn', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 模型提问/确认轮（无 tool 消息）不是交付完成：不触发“交付前测试与审计”卡，
    // 评估卡保持执行等待而不是跳到验证结果。
    expect(src).toContain("const hasToolWork = (event.payload.messages ?? []).some((m) => m.role === 'tool');");
    expect(src).toContain('if (needsDeliveryGate && hasToolWork && !event.payload.interrupted && gen === this.generation) {');
    expect(src).toContain("(!needsDeliveryGate || (hasToolWork && projectQualityResult?.passed === true))");
    expect(src).toContain("assessmentFlow.setPhase('execute', '本轮没有产生文件改动（如需确认细节，模型会直接提问），等待你的回复后继续。'");
  });

  it('presents probe findings only after the LLM analysis, never before thinking', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 探针结论（探索/契约气泡）只能在 reportProbeFindings 内出现，而它由
    // maybeShowAssessment 调用——后者只在 LLM 分析（thinking 卡）完成后触发。
    const report = src.indexOf('const reportProbeFindings = (): void => {');
    const exploration = src.indexOf('已完成项目探索');
    const contract = src.indexOf('已建立任务契约');
    expect(report).toBeGreaterThan(-1);
    expect(exploration).toBeGreaterThan(report);
    expect(contract).toBeGreaterThan(report);
    expect(src.indexOf('reportProbeFindings();')).toBeGreaterThan(-1);
    expect(src).toContain('workflow.probeRequired && !workflow.probeAvailable');
    expect(src.indexOf('maybeShowAssessment();')).toBeGreaterThan(src.indexOf('await generateTaskAnalysis('));
  });

  it('never shows a fake "I understood" intro bubble before the LLM speaks', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 开场白必须诚实：不得出现“我先确认一下我理解的需求：<echo>”这种未经 LLM
    // 就宣称理解需求的硬编码模板（原实现用 understoodText 插值拼出）——理解与否
    // 由 thinking 卡里真实流式的分析来展示。
    expect(src.indexOf('我先确认一下我理解的需求：${understoodText}')).toBe(-1);
    expect(src.indexOf('我理解的需求：${')).toBe(-1);
  });

  it('labels the thinking card with honest phase text instead of rotating fake hints', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const cardSrc = readSource(new URL('../thinkingCard.ts', import.meta.url));
    // 伪轮播（正在理解你的需求→正在评估影响范围→正在准备好执行计划）已删除：
    // 没有那几件事在发生，就不许循环宣称。
    expect(cardSrc).not.toContain('startThinkingHints');
    expect(cardSrc).not.toContain('正在理解你的需求');
    expect(cardSrc).not.toContain('正在准备好执行计划');
    // 改为在真实阶段边界设置诚实标签。
    // 分析期只有一个诚实标签；引擎循环等待首 token 时是“正在思考…”。
    expect(src).toContain("setThinkingLabel(analysisCard, '正在分析你的请求…')");
    expect(src).toContain("setThinkingLabel(thinkingCard, '正在思考…')");
  });

  it('passes explicit approval into the plan prompt so execution starts immediately', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 本轮无需等待“开工”消息（确认卡已批准 / forced-yolo 直接放行）时，模型第一轮
    // 必须立即执行——否则模型第一轮不调用工具，引擎空转完成，计划卡还停在第一步
    // 就突然出现“交付前测试与审计”卡、评估卡跳到“验证结果”。
    expect(src).toContain('formatPlanForPrompt(planForReview, needsDeliveryGate, !pauseAfterPlanning)');
  });

  it('keeps one flat plan row mounted while refining updates its contents', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const show = src.indexOf('const showPlanCard = (plan: Plan, refining = false): void => {');
    const update = src.indexOf('updatePlanCard(planCard, plan, analysis.mode, refining);', show);
    const oldReplace = src.indexOf('old.classList.add(\'plan-card-leaving\')', show);
    expect(show).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(show);
    expect(oldReplace).toBe(-1);
    expect(src).toContain('updatePlanCard(planCard, plan, analysis.mode, refining);');
    const planSrc = readSource(new URL('../plan.ts', import.meta.url));
    expect(planSrc).toContain('export function updatePlanCard');
  });
});
