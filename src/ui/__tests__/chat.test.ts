// src/ui/__tests__/chat.test.ts

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseToolCallBuffer, shouldCopyAssistantBubbleTarget, copyAssistantBubbleText, bindUserBubbleSelectAll, generateTaskAnalysis, parseTaskAnalysisText, pickHistoryMessages, mergeTranscriptWithTurn, BASE_SYSTEM_PROMPT, shouldCancelForEscape, shouldEnterPlanReview, parseIntentAssessmentBlock, mergeIntentAssessments, parseRequestReviewBlock } from '../chat';
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

  it('surfaces analysis + plan from streamed reasoning when content is empty (reasoning-first models)', async () => {
    // DeepSeek/Qwen reasoning models put the natural analysis into
    // `reasoning_content` and can leave `content` empty. The analysis must
    // still reach the user (thinking card + persisted replay), not degrade to
    // the "分析未完成" fallback.
    const analysisProse = '<analysis>这是一个山东省5G监控系统，需要接入各省市现网数据，难度高。</analysis>';
    const llm: LLMAdapter = {
      async *stream() {
        yield { type: 'reasoning', content: '好的，我来分析这个请求。' } as any;
        yield { type: 'reasoning', content: analysisProse } as any;
        yield { type: 'reasoning', content: '```json\n[{"action":"设计数据模型","description":"定义省市与网络状态数据"},{"action":"搭建监控大屏","description":"实现地图可视化和城市下钻"}]\n```' } as any;
      },
      complete: async () => ({ content: '', toolCalls: undefined }),
    } as LLMAdapter;
    const deltas: string[] = [];
    const result = await generateTaskAnalysis(llm, '创建山东省5G监控系统', 200, undefined, { onThinking: (d) => deltas.push(d) });
    expect(result.analysis).toContain('山东省5G监控系统');
    expect(result.plan).not.toBeNull();
    expect(result.plan!.steps).toHaveLength(2);
    expect(deltas.join('')).toContain('我来分析这个请求');
    expect(deltas.join('')).toContain('山东省5G监控系统');
  });

  it('merges analysis from reasoning with a plan delivered in content', async () => {
    // Reasoning-first model that still emits the JSON plan in `content`: each
    // field takes its first usable source instead of forcing the fallback.
    const llm: LLMAdapter = {
      async *stream() {
        yield { type: 'reasoning', content: '<analysis>先确认数据源是否真实可接入，再决定架构。</analysis>' } as any;
        yield { type: 'content', content: '```json\n[{"action":"接入数据","description":"建立数据接入管道"}]```' } as any;
      },
      complete: async () => ({ content: '', toolCalls: undefined }),
    } as LLMAdapter;
    const result = await generateTaskAnalysis(llm, '创建监控大屏', 200);
    expect(result.analysis).toContain('数据源');
    expect(result.plan?.steps[0].action).toBe('接入数据');
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

describe('parseRequestReviewBlock (诉求合理性评审)', () => {
  const sample = (items: unknown): string =>
    `<request_review>\n${JSON.stringify(items)}\n</request_review>`;

  it('parses mixed verdicts with reasons and suggestions', () => {
    const review = parseRequestReviewBlock(sample([
      { part: '直接删除旧版本目录', verdict: 'unreasonable', reason: '旧目录里还有迁移脚本在引用', suggestion: '先归档再删除' },
      { part: '两天内完成全量迁移', verdict: 'questionable', reason: '依赖数据清洗，工期不确定', suggestion: '先做数据量评估' },
      { part: '保留新功能接口', verdict: 'reasonable', reason: '与现有架构一致' },
    ]));
    expect(review).toHaveLength(3);
    expect(review[0].verdict).toBe('unreasonable');
    expect(review[0].suggestion).toBe('先归档再删除');
    expect(review[1].verdict).toBe('questionable');
    expect(review[2].verdict).toBe('reasonable');
    expect(review[2].suggestion).toBeUndefined();
  });

  it('returns [] when the block is missing (no gate)', () => {
    expect(parseRequestReviewBlock('只有分析文字，没有评审块')).toEqual([]);
    expect(parseRequestReviewBlock('[{"action":"A"}]')).toEqual([]);
  });

  it('returns [] on an empty array (everything reasonable)', () => {
    expect(parseRequestReviewBlock(sample([]))).toEqual([]);
  });

  it('drops items with invalid verdicts or empty parts, keeps valid ones', () => {
    const review = parseRequestReviewBlock(sample([
      { part: '保留新接口', verdict: 'reasonable', reason: '一致' },
      { part: '某条可疑项', verdict: 'maybe', reason: '非法判定' },
      { verdict: 'unreasonable', reason: '缺少 part' },
    ]));
    expect(review).toHaveLength(1);
    expect(review[0].part).toBe('保留新接口');
  });

  it('returns [] on malformed JSON inside the block', () => {
    expect(parseRequestReviewBlock('<request_review>{broken json</request_review>')).toEqual([]);
    expect(parseRequestReviewBlock('<request_review>{"verdict":"reasonable"}</request_review>')).toEqual([]);
  });

  it('strips the review block from the visible analysis text', () => {
    const text = `<analysis>我理解你的诉求。</analysis>\n${sample([{ part: 'X', verdict: 'questionable', reason: 'Y', suggestion: 'Z' }])}\n\`\`\`json\n[{"action":"A","description":"d"}]\`\`\``;
    const r = parseTaskAnalysisText(text, 'x');
    expect(r.analysis).toContain('我理解你的诉求');
    expect(r.analysis).not.toContain('request_review');
    expect(r.analysis).not.toContain('questionable');
    expect(r.review).toHaveLength(1);
    expect(r.review[0].verdict).toBe('questionable');
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

  it('returns from a stalled analysis stream at the timeout instead of hanging the GUI', async () => {
    const started = Date.now();
    const llm = {
      async *stream() {
        await new Promise<void>(() => {});
        yield { type: 'content', content: 'never arrives' };
      },
    } as any;
    const result = await generateTaskAnalysis(llm, 'build', 20);
    expect(result.plan).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
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
    const paint = src.indexOf('await yieldToNextPaint(turnController.signal);', bubble);
    const secondFrame = src.indexOf('requestAnimationFrame(() => requestAnimationFrame', src.indexOf('function yieldToNextPaint'));
    const linkify = src.indexOf('linkifyPaths(userBubble);', bubble);
    const resolveWorkspace = src.indexOf('getApplicationTmpWorkspace(sendSessionId)', bubble);
    expect(bubble).toBeGreaterThan(-1);
    expect(paint).toBeGreaterThan(bubble);
    expect(secondFrame).toBeGreaterThan(-1);
    expect(linkify).toBeGreaterThan(paint);
    expect(resolveWorkspace).toBeGreaterThan(paint);
  });

  it('flushes the latest assistant text before inserting a tool card', () => {
    const chatSrc = readSource(new URL('../chat.ts', import.meta.url));
    const loaderSrc = readSource(new URL('../markdownLoader.ts', import.meta.url));
    const finalize = chatSrc.indexOf('const finalizeStreamingSegments = (): void => {');
    const flush = chatSrc.indexOf('flushStreamingRender(seg.el, text);', finalize);
    const cancel = chatSrc.indexOf('cancelStreamingRender(seg.el);', finalize);

    expect(chatSrc).toContain('flushStreamingRender, cancelStreamingRender');
    expect(loaderSrc).toContain('export function flushStreamingRender(container: HTMLElement, fallbackText = \'\'): void');
    expect(flush).toBeGreaterThan(finalize);
    expect(cancel).toBeGreaterThan(flush);
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
    const show = src.indexOf('const showPlanCard = (plan: Plan, refining = false, fallback = false): void => {');
    const update = src.indexOf('updatePlanCard(planCard, plan, refining, fallback, planProgress);', show);
    const oldReplace = src.indexOf('old.classList.add(\'plan-card-leaving\')', show);
    expect(show).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(show);
    expect(oldReplace).toBe(-1);
  });

  it('opens the thinking card before any preflight await (runtime probe, workspace probing, model analysis)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // The eager trace opens right before the runtime probe — before the
    // workspace scan and model analysis — so the user never stares at a
    // frozen transcript between the user bubble and the first token. The
    // analysis path reuses that same card instead of stacking a second one.
    const eager = src.indexOf("thinkingCard = openThinkingCard();\n      setThinkingLabel(thinkingCard, '正在准备…');");
    const reuse = src.indexOf('const earlyAnalysisCard = shouldRunTaskAnalysis ? thinkingCard : null;');
    const firstProbe = src.indexOf('await discoverWorkspace(');
    const firstContextRead = src.indexOf('await buildWorkspaceContext(');
    const firstAnalysis = src.indexOf('await generateTaskAnalysis(');
    expect(eager).toBeGreaterThan(-1);
    expect(reuse).toBeGreaterThan(-1);
    expect(firstProbe).toBeGreaterThan(eager);
    expect(firstContextRead).toBeGreaterThan(eager);
    expect(firstAnalysis).toBeGreaterThan(eager);
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
    expect(src).toMatch(/createPlanCard\(plan, refining, fallback, planProgress\)/);
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

  it('keeps recoverable verifier retries out of the transcript as user-facing error cards', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    expect(src).toContain("if (thinkingCard) setThinkingLabel(thinkingCard, '正在调整输出…');");
    expect(src).not.toContain('↻ ${event.payload.code}: ${event.payload.message}');
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
    const show = src.indexOf('const showPlanCard = (plan: Plan, refining = false, fallback = false): void => {');
    const update = src.indexOf('updatePlanCard(planCard, plan, refining, fallback, planProgress);', show);
    const oldReplace = src.indexOf('old.classList.add(\'plan-card-leaving\')', show);
    expect(show).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(show);
    expect(oldReplace).toBe(-1);
    expect(src).toContain('updatePlanCard(planCard, plan, refining, fallback, planProgress);');
    const planSrc = readSource(new URL('../plan.ts', import.meta.url));
    expect(planSrc).toContain('export function updatePlanCard');
  });
});

describe('user bubble double-click select-all', () => {
  function installSelectionDom(): () => void {
    const prevDocument = (globalThis as any).document;
    const prevWindow = (globalThis as any).window;
    const selection = {
      ranges: [] as any[],
      removeAllRanges() { this.ranges = []; },
      addRange(range: any) { this.ranges.push(range); },
    };
    (globalThis as any).document = {
      createRange: (): any => ({
        selectNodeContents(node: any) { this.startContainer = node; this.endContainer = node; },
      }),
    };
    (globalThis as any).window = { getSelection: () => selection };
    return () => {
      (globalThis as any).document = prevDocument;
      (globalThis as any).window = prevWindow;
    };
  }

  function fakeBubble(): any {
    const bubble: any = {
      dataset: {},
      _listeners: {} as Record<string, (ev: any) => void>,
      addEventListener: (name: string, listener: (ev: any) => void) => { bubble._listeners[name] = listener; },
    };
    return bubble;
  }

  it('selects the entire bubble contents on double-click', () => {
    const restore = installSelectionDom();
    try {
      const bubble = fakeBubble();
      bindUserBubbleSelectAll(bubble);
      bubble._listeners.dblclick({ target: bubble });
      const ranges = (globalThis as any).window.getSelection().ranges;
      expect(ranges.length).toBe(1);
      expect(ranges[0].startContainer).toBe(bubble);
      expect(ranges[0].endContainer).toBe(bubble);
    } finally {
      restore();
    }
  });

  it('binds only once even when called repeatedly', () => {
    const restore = installSelectionDom();
    try {
      const bubble = fakeBubble();
      bindUserBubbleSelectAll(bubble);
      bindUserBubbleSelectAll(bubble);
      bubble._listeners.dblclick({ target: bubble });
      const ranges = (globalThis as any).window.getSelection().ranges;
      expect(ranges.length).toBe(1);
    } finally {
      restore();
    }
  });

  it('leaves double-clicks on links and buttons alone', () => {
    const restore = installSelectionDom();
    try {
      const bubble = fakeBubble();
      bindUserBubbleSelectAll(bubble);
      bubble._listeners.dblclick({ target: { closest: () => ({}) } });
      const ranges = (globalThis as any).window.getSelection().ranges;
      expect(ranges.length).toBe(0);
    } finally {
      restore();
    }
  });

  it('binds user bubbles in live chat and session replay', () => {
    const chatSrc = readSource(new URL('../chat.ts', import.meta.url));
    const mainSrc = readSource(new URL('../main.ts', import.meta.url));
    expect(chatSrc).toContain('export function bindUserBubbleSelectAll(bubble: HTMLElement): void {');
    expect(chatSrc).toContain('bindUserBubbleSelectAll(bubble);');
    expect(mainSrc).toContain('bindUserBubbleSelectAll(bubble);');
  });
});

describe('plan overview completion state', () => {
  it('finalizes the floating outline on completion without depending on phase markers', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 完成收尾的证据来自本轮真实工具执行 + 正常结束（hasToolWork 与提问轮约定
    // 一致），而不是模型是否恰好发出了 `## 计划 n 已完成` 标记——漏发时大纲
    // 不能永远停在第一步。
    const planFinished = src.indexOf('const planFinished = planCard && hasToolWork');
    const complete = src.indexOf("planProgress?.dispatch({ type: 'completed' });", planFinished);
    expect(planFinished).toBeGreaterThan(-1);
    expect(complete).toBeGreaterThan(planFinished);
    // 提问/确认轮（末句以问号结尾）不能误判为完成。
    expect(src).toContain('const turnAsksForInput = finalAnswer.length > 0 && /[?？]\\s*$/.test(finalAnswer);');
    expect(src).toContain('&& !turnAsksForInput && gen === this.generation && !this.pausePlanCard;');
  });

  it('keeps the chat plan card as the only live plan projection', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    expect(src).toContain('let planProgress: PlanProgressModel | null = null;');
    expect(src).toContain('createPlanCard(plan, refining, fallback, planProgress);');
    expect(src).toContain('updatePlanCard(planCard, plan, refining, fallback, planProgress);');
    expect(src).not.toContain('planOverview().bindProgress(planProgress);');
    expect(src).toContain("planProgress?.dispatch({ type: 'completed' });");
    expect(src).not.toContain('overview.update(plan, done ? \'complete\' : status');
  });

  it('uses conversation stage announcements as the only protocol-driven top-level cursor events', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    expect(src).toContain('phaseStarted: new Set<number>()');
    expect(src).toContain('phaseCompleted: new Set<number>()');
    expect(src).toContain('protocolStarted: false');
    expect(src).toContain('planTrack.phaseStarted.add(marker.number)');
    expect(src).toContain('planTrack.phaseCompleted.add(marker.number)');
    expect(src).toContain('等待对话播报');
    expect(src).toContain('!planTrack.phaseCompleted.has(finishedPlan)');
    expect(src).toContain('const legacyPlanFinished = planCard && !planTrack.protocolStarted');
    expect(src).toContain('completionSnapshot.currentPlan >= completionSnapshot.plan.steps.length;');
    expect(src).toContain('shouldAdvancePlanAtTurnEnd(planFinished === true, completionSnapshot, planTrack.completedPlan)');
    expect(src).toContain("planProgress.dispatch({ type: 'phaseStarted', planNumber: nextPlan });");
    expect(src).toContain('const protocolPlanFinished = planCard && completionSnapshot && planTrack.phaseCompleted.has(completionSnapshot.plan.steps.length);');
  });

  it('jumps the card straight to a later plan the model reports starting', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 执行期卡片靠 `## 计划 n：` 标记推进。旧逻辑在“当前计划的 Todo 未全部
    // 标记完成”时直接卡在第一步；现在模型明确进入更后面的计划时，把它当作
    // 当前计划隐式完成并直接跳到标记指出的计划（而不是每标记只前进一步），
    // 项目构建仍等真实验证证据。
    const guard = src.indexOf("if (marker.kind === 'phase') {", src.indexOf('const trackPlanPhase'));
    expect(guard).toBeGreaterThan(-1);
    const forceAdvance = src.indexOf('The model explicitly started a later plan', guard);
    const verifyGate = src.indexOf('needsDeliveryGate && !planTrack.phaseVerifySeen[before]', guard);
    // 事件模型先经过协议/验证门禁，再用 phaseJumped 事件一次性落到目标计划。
    const jump = src.indexOf("planProgress?.dispatch({ type: 'phaseJumped', planNumber: Math.max(before + 1", verifyGate);
    expect(forceAdvance).toBeGreaterThan(guard);
    expect(verifyGate).toBeGreaterThan(forceAdvance);
    expect(jump).toBeGreaterThan(verifyGate);
  });

  it('completes the last plan from its own completion marker (no N-1/N stall)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // `## 计划 n 已完成`（最后一个计划）以前永远无法把卡片推到完成态：
    // updatePlanCardPhase 把 total+1 截到 total，而收尾门禁又要求本轮有工具
    // 调用——无工具收尾轮（纯总结 / 用户确认）会让卡片和大纲永远停在 N-1/N。
    const finishPlan = src.indexOf('const finishPlan = (planNumber: number): void => {');
    expect(finishPlan).toBeGreaterThan(-1);
    const lastPlan = src.indexOf('const isLastPlan = planNumber >= finishSnapshot.plan.steps.length;', finishPlan);
    const forceComplete = src.indexOf("planProgress?.dispatch({ type: 'todosCompleted', force: isLastPlan });", finishPlan);
    const lastActivity = src.indexOf('整个计划收尾中…', finishPlan);
    expect(lastPlan).toBeGreaterThan(finishPlan);
    expect(forceComplete).toBeGreaterThan(lastPlan);
    expect(lastActivity).toBeGreaterThan(forceComplete);
  });

  it('does not double-advance the plan cursor at turn completion', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // finishPlan 收到 `## 计划 n 已完成` 时已经把游标推进到 n+1，并记录到
    // completedPlan；回合收尾的兜底（shouldAdvancePlanAtTurnEnd）据此不再推进
    // 一次，否则“一轮一阶段”会把下一阶段整段跳过。
    const finishPlan = src.indexOf('const finishPlan = (planNumber: number): void => {');
    expect(finishPlan).toBeGreaterThan(-1);
    const advance = src.indexOf("planProgress?.dispatch({ type: 'phaseStarted', planNumber: planNumber + 1 });", finishPlan);
    const record = src.indexOf('planTrack.completedPlan = planNumber;', advance);
    expect(record).toBeGreaterThan(advance);
    const canAdvance = src.indexOf('shouldAdvancePlanAtTurnEnd(planFinished === true, completionSnapshot, planTrack.completedPlan)');
    expect(canAdvance).toBeGreaterThan(-1);
  });

  it('finalizes a no-tool final turn at the last plan so the outline catches up', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 收尾轮没有工具调用（工作在前一轮已全部完成，本轮只是总结或被用户确认）
    // 时，只要卡片已在最后一个计划上，就按完成收尾——否则卡片与浮动大纲永远
    // 停在 N-1/N，和已经完成的任务不同步。
    const planFinished = src.indexOf('const planFinished = planCard && hasToolWork');
    expect(planFinished).toBeGreaterThan(-1);
    const summarized = src.indexOf('const planSummarized = planCard && !hasToolWork', planFinished);
    const lastPlan = src.indexOf('completionSnapshot.currentPlan === completionSnapshot.plan.steps.length', summarized);
    const turnText = src.indexOf('turnText.length > 0', summarized);
    const combined = src.indexOf('(planFinished || planSummarized) && planCard', summarized);
    expect(summarized).toBeGreaterThan(planFinished);
    expect(lastPlan).toBeGreaterThan(summarized);
    expect(turnText).toBeGreaterThan(lastPlan);
    expect(combined).toBeGreaterThan(turnText);
    // 完成后由唯一进度模型进入终态，两个视图通过订阅同时刷新。
    const complete = src.indexOf("planProgress?.dispatch({ type: 'completed' });", combined);
    expect(complete).toBeGreaterThan(combined);
  });

  it('does not mount a floating outline when a turn has no plan card', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // The floating outline is no longer part of ChatController's lifecycle;
    // the transcript plan card is the only live plan projection.
    expect(src).not.toContain("from './planOverview'");
    expect(src).not.toContain('planOverview()');
    expect(src).not.toContain('setOverviewPositionSession(');
    expect(src).not.toContain('syncPlanOverview');
  });

  it('persists the completed plan state for chat-card restoration', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 完成态：activeComplexPlan 已被置空，但快照带 complete: true，仍要落盘
    // planState——否则还原时大纲不会以 complete 状态重现。
    const turnPlanState = src.indexOf('const turnPlanState = this.activeComplexPlan');
    expect(turnPlanState).toBeGreaterThan(-1);
    const completeBranch = src.indexOf('this.activePlanCardSnapshot?.complete', turnPlanState);
    const completeFlag = src.indexOf('complete: true', completeBranch);
    expect(completeBranch).toBeGreaterThan(turnPlanState);
    expect(completeFlag).toBeGreaterThan(completeBranch);
    const planState = src.indexOf('const planState = index === messages.length - 1 && turnPlanState', completeFlag);
    expect(planState).toBeGreaterThan(completeFlag);
  });

  it('routes every plan model change through the session persistence adapter', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    expect(src).toContain('createSessionPlanProgressPersistence(sessionId, workspace)');
    expect(src).toContain('model.subscribePersistence');
    expect(src).toContain('await this.activePlanProgressPersistence?.flush();');
    expect(src).not.toContain('syncActivePlanCursor');
  });

  it('restores the chat plan card state without a floating outline integration', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const guard = src.indexOf('const savedPlanState = snapshot.uiState.planState;');
    expect(guard).toBeGreaterThan(-1);
    const progress = src.indexOf('const savedProgress = snapshot.uiState.planProgress', guard);
    expect(progress).toBeGreaterThan(guard);
    expect(src).toContain('this.bindActivePlanProgress(restoredProgress);');
    expect(src).toContain("status: savedPlanState.complete ? 'complete' as const");
    expect(src).not.toContain("from './planOverview'");
    expect(src).not.toContain('planOverview().bindProgress');
  });

  it('restores the transcript plan card directly from the session progress model', () => {
    const src = readSource(new URL('../main.ts', import.meta.url));
    expect(src).toContain('const progress = chat.getPlanProgressModel();');
    expect(src).toContain('const restoredPlanCard = createRestoredPlanCard(progress);');
    expect(src).not.toContain('bindPlanCardProgress(restoredPlanCard, progress);');
    expect(src).not.toContain('createRestoredPlanCard(block.snapshot)');
  });

  it('persists every reasoning phase for the matching assistant message', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    expect(src).toContain('thinkingPhases.filter(candidate => candidate.assistantIndex === currentAssistantIndex && candidate.text)');
    expect(src).toContain('thinkingPhases: phases.length > 0 ? phases : undefined');
  });

  it('does not create or synchronize a floating outline from ChatController', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    expect(src).not.toContain("from './planOverview'");
    expect(src).not.toContain('planOverview()');
    expect(src).not.toContain('setOverviewPositionSession(');
  });
});

describe('generate_image text-to-image wiring', () => {
  it('registers the image tool and swaps the SVG contract when the provider supports it', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // Capability is computed per send from provider + model + custom settings.
    expect(src).toContain('const imageGen = imageGenEnabled(config.customProviders, config.provider, config.model);');
    // The tool joins the live registry in workspace mode…
    expect(src).toContain("codingAgent.toolRegistry.register({ ...IMAGE_GEN_TOOL_DEF, tags: [Tags.READ], riskLevel: 'low' });");
    // …and the plain toolsDef list otherwise.
    expect(src).toContain('...(imageGen ? [IMAGE_GEN_TOOL_DEF] : [])');
    // Both prompt surfaces (early base + final assembly) get the flag.
    expect(src).toContain('buildSystemPrompt(!!effectiveWorkspace, usingTemporaryWorkspace, config, promptTools, imageGen)');
    expect(src).toContain('capabilities: buildGuiCapabilities(!!effectiveWorkspace, usingTemporaryWorkspace, { imageGeneration: imageGen })');
    expect(src).toContain('imageGeneration: imageGen,');
    // generate_image is workspace-independent (available in plain-chat mode).
    expect(src).toContain("|| name === 'generate_image'");
  });

  it('keeps base64 images out of the LLM context via the side channel', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // ToolResult.result stays compact (summary object); the data URLs are
    // claimed from the adapter cache and rendered as <img> cards.
    expect(src).toContain("resultImages = takeGeneratedImages(event.payload.toolCallId);");
    expect(src).toContain("resultKind = 'image';");
    expect(src).toContain('resultImages,');
    // The row finalizer receives the images, and replay persists them.
    const adapterSrc = readSource(new URL('../TauriToolAdapter.ts', import.meta.url));
    expect(adapterSrc).toContain('cacheGeneratedImages(toolCall.id, images);');
    expect(adapterSrc).toContain('summary: `Generated ${images.length} image(s)');
    const storeSrc = readSource(new URL('../store.ts', import.meta.url));
    expect(storeSrc).toContain('resultImages?: GeneratedImage[];');
    const toolRowSrc = readSource(new URL('../toolRow.ts', import.meta.url));
    expect(toolRowSrc).toContain("resultKind === 'image' && meta.resultImages?.length");
  });
});
