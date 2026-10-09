// src/ui/__tests__/chat.test.ts

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseToolCallBuffer, shouldCopyAssistantBubbleTarget, copyAssistantBubbleText, bindUserBubbleSelectAll, pickHistoryMessages, mergeTranscriptWithTurn, BASE_SYSTEM_PROMPT, shouldCancelForEscape, shouldEnterPlanReview, sanitizeInterruptedReason } from '../chat';
import { limitStoredMessages, MAX_PERSISTED_MESSAGES } from '../store';
import type { Message, LLMAdapter, LLMResponse } from '../../shared/types';

function readSource(url: URL): string {
  return readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
}
// Regression guard (2026-09-25 用户实测「hello 也报 Maximum call stack size
// exceeded」）：把滚动调用统一收口进 scrollUi() 时，批量替换把 scrollUi 自己
// 的函数体也换成了 this.scrollUi(…)——无限自递归，第一次发送就爆栈。守卫：
// scrollUi 体内必须调真正的 scrollChatToBottomIfPinned，且 chat.ts 里对该
// 原始函数的直接调用只允许出现在 import 行和 scrollUi 体内。
describe('scrollUi convergence guard', () => {
  it('scrollUi calls the imported scrollChatToBottomIfPinned, never itself', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const fn = src.indexOf('private scrollUi(');
    expect(fn).toBeGreaterThan(-1);
    const body = src.slice(fn, fn + 400);
    expect(body).toContain('scrollChatToBottomIfPinned(chatEl)');
    expect(body).not.toContain('this.scrollUi(');
    // 收口完整性：原始函数（带括号的调用形态）只许 scrollUi 体内这一处——
    // 其他 28 个调用点全部走 this.scrollUi(…)（隐藏会话闸）。未来若要新增
    // 原始直调，必须是有意识的决定（同步改这条守卫）。
    const directCalls = src.split('scrollChatToBottomIfPinned(').length - 1;
    expect(directCalls).toBe(1);
  });
});
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

  it('wraps tools in <capabilities> and keeps volatile fragments at the tail', () => {
    const prompt = BASE_SYSTEM_PROMPT(true);
    expect(prompt.indexOf('<capabilities>')).toBeGreaterThan(prompt.indexOf('</agent_identity>'));
    // Cache stability: capabilities carries the mid-session-volatile
    // blocked-hosts list, so it sits at the system-prompt TAIL — AFTER the
    // stable L0/L1 blocks (the old order had it right after agent_identity,
    // where any blocked-host change re-buffed the whole prefix).
    expect(prompt.indexOf('<capabilities>')).toBeGreaterThan(prompt.indexOf('Output style:'));
  });
});

describe('interruption reason classification', () => {
  it('does not call a provider token-budget error the engine budget limit', () => {
    const message = sanitizeInterruptedReason('429: token budget exceeded by provider');
    expect(message).not.toContain('本轮预算上限');
    expect(message).toContain('稍后');
  });

  it('keeps the engine budget wording for the exact engine reason', () => {
    expect(sanitizeInterruptedReason('Budget exceeded')).toContain('本轮预算上限');
  });

  it('explains a context-window overflow in plain words and surfaces the provider line', () => {
    // The field wedge: the provider 400 body said "maximum context length",
    // but the old truncation regex showed only `400 bad request {` — cryptic.
    const reason = `Context window exhausted: the conversation no longer fits the model's input window (2 consecutive provider rejections). Last: "400 bad request {"error":{"message":"This model's maximum context length is 65536 tokens. However, your messages resulted in 81234 tokens.","type":"invalid_request_error"}}". Retrying cannot shrink it.`;
    const message = sanitizeInterruptedReason(reason);
    expect(message).toContain('上下文超出模型窗口');
    expect(message).toContain('maximum context length');
    expect(message).not.toContain('invalid_request_error');
  });

  it('keeps the full provider body in an identical-call stop cause (no early quote/period truncation)', () => {
    // extractFailureCause used to stop at the first quote/period inside the
    // body — the same "400 bad request {" truncation. Lock the anchored
    // extraction with a non-context body (context overflows take the
    // dedicated branch above).
    const raw = `5 consecutive failures of the identical call (tool: web_fetch): "400 bad request {"error":{"message":"field tools.0 is missing; see docs.example.com/help."}}". This exact call kept failing even after a skip-it directive was issued — stopping here rather than retrying again.`;
    const message = sanitizeInterruptedReason(raw);
    expect(message).toContain('失败原因');
    expect(message).toContain('tools.0 is missing');
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

describe('Escape cancellation guard', () => {
  it('only cancels a live turn for Escape', () => {
    expect(shouldCancelForEscape('Escape', true)).toBe(true);
    expect(shouldCancelForEscape('Enter', true)).toBe(false);
    expect(shouldCancelForEscape('Escape', false)).toBe(false);
  });

});

describe('plan pre-flight keeps its honest shape', () => {
  it('has no fixed pre-plan clarify card and no clarify interview round-trip', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 用户要求：不再在思考前弹固定的“开工前先确认几个问题”卡——问题由模型在
    // 执行语境中自然提出。
    expect(src.indexOf('requestClarifications(')).toBe(-1);
    expect(src.indexOf('generateClarifyingQuestions(')).toBe(-1);
    expect(src.indexOf('开工前先确认几个问题')).toBe(-1);
  });

  it('the old silent pre-analysis pipeline stays dead; planning is now plan-by-thinking', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 旧实时分析从未稳定成功（10/10 项目全部超时/空输出），只会拖慢启动并把
    // “实时分析未完成，已回退到通用步骤”的噪音留给用户。那条静默链路必须
    // 保持删干净；2026-09-26 换上的是流式、可见、安静的 plan-by-thinking。
    expect(src.indexOf('generateTaskAnalysis')).toBe(-1);
    expect(src.indexOf('TASK_ANALYSIS_PROMPT')).toBe(-1);
    expect(src.indexOf('<intent_assessment>')).toBe(-1);
    expect(src.indexOf('<request_review>')).toBe(-1);
    expect(src.indexOf('mergeIntentAssessments')).toBe(-1);
    expect(src.indexOf('实时分析未完成')).toBe(-1);
    expect(src.indexOf('已回退到通用步骤')).toBe(-1);
    // 模型计划优先；规则计划只活在确认对话的兜底支里，自动路径宁可无卡。
    expect(src).toContain('let planForReview: Plan | null = thought?.plan ?? null;');
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

describe('rules-layer risk calibration settles the safety card', () => {
  it('derives the safety gate purely from Planner heuristics', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const riskReview = src.indexOf('const riskReview = effectiveIntent.requiresConfirmation;');
    const card = src.indexOf('assessmentFlow = createAssessmentFlowCard(effectiveIntent);');
    expect(riskReview).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(-1);
  });

  it('keeps the heuristic judgment end to end with no post-hoc recompute path', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 规则层判断在预检早期落定 userAssessment（workflow.userContext.assessment），
    // 之后不再有任何“合并后重算”的路径。
    expect(src.indexOf('userAssessment = workflow.userContext.assessment;')).toBeGreaterThan(-1);
    expect(src.indexOf('userAssessment = formatIntentPrompt(effectiveIntent);')).toBe(-1);
    const gate = src.indexOf("const needsInteractiveApproval = forcedMode === 'plan' || forcedMode === 'build';");
    expect(gate).toBeGreaterThan(src.indexOf('const riskReview = effectiveIntent.requiresConfirmation;'));
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

  it('keeps the env probe and load-time compaction off the send critical path', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // ⑤ 探针软等待：send 只 race 一个有上限的计时器；输掉竞争的一侧（探针慢、
    // 或中止事件后到）不得变成未处理 rejection。
    expect(src).toContain('const PROBE_SOFT_WAIT_MS');
    expect(src).toContain('await Promise.race([probe, new Promise<void>((resolve) => setTimeout(resolve, PROBE_SOFT_WAIT_MS))]);');
    expect(src).toContain('probe.catch(() => {})');
    // ⑥ 载入期预压实：loadFromStorage 触发；占位系统提示词 + 廉价豁免闸 +
    // 引擎/适配器惰性工厂，空闲窗口守卫与写缓存复用同一调度器。
    expect(src).toContain('this.preCompactAfterLoad();');
    const afterLoad = src.indexOf('private preCompactAfterLoad');
    expect(afterLoad).toBeGreaterThan(-1);
    expect(src.indexOf("BASE_SYSTEM_PROMPT(!!(this.effectiveWorkspace || this.workspace))", afterLoad)).toBeGreaterThan(afterLoad);
    // 廉价闸与压缩器共用同一估算出处（ContextEngine.estimateTokens）——
    // 只数正文不数工具参数的旧闸曾在长任务上错误豁免预压缩。
    expect(src.indexOf('estimateTokens(compactionInput)', afterLoad)).toBeGreaterThan(afterLoad);
    const scheduler = src.indexOf('private scheduleBackgroundPreCompaction');
    expect(scheduler).toBeGreaterThan(afterLoad);
    const factory = src.indexOf('() => new ContextEngine({', afterLoad);
    expect(factory).toBeGreaterThan(afterLoad);
    expect(factory).toBeLessThan(scheduler);
    expect(src).toContain('ctxOrFactory: ContextEngine | (() => ContextEngine | null)');
    // overBudget 的 toast 只在回合后入口发（发送期内联 trim 本就不弹，载入期同静默）。
    expect(src).toContain('compaction.overBudget && notifyOverBudget');
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
// before the workspace probe — so the user never stares at a frozen
// transcript. The plan comes straight from the local rule-based Planner and
// its card renders as soon as the probe lands; there is no LLM pre-analysis
// round-trip and no generic-scaffold fallback messaging.
describe('plan-gate timing (thinking card before preflight work)', () => {
  it('updates the existing plan list in place instead of replacing the card', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const show = src.indexOf('const showPlanCard = (plan: Plan, refining = false): void => {');
    const update = src.indexOf('updatePlanCard(planCard, plan, refining, planProgress, () => this.activeTaskScript)', show);
    const oldReplace = src.indexOf('old.classList.add(\'plan-card-leaving\')', show);
    expect(show).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(show);
    expect(oldReplace).toBe(-1);
  });

  it('opens the thinking card before any preflight await (runtime probe, workspace probing)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // The eager trace opens right before the runtime probe — before the
    // workspace scan — so the user never stares at a frozen transcript between
    // the user bubble and the first token. The plan gate reuses that same card.
    const eager = src.indexOf("thinkingCard = openThinkingCard();\n      setThinkingLabel(thinkingCard, '正在准备…');");
    const reuse = src.indexOf('const earlyAnalysisCard = shouldRunTaskAnalysis ? thinkingCard : null;');
    const firstProbe = src.indexOf('await discoverWorkspace(');
    expect(eager).toBeGreaterThan(-1);
    expect(reuse).toBeGreaterThan(-1);
    expect(firstProbe).toBeGreaterThan(eager);
  });

  it('streams a visible planning round between the probe and the plan card (2026-09-26 反转)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 计划必须是当着用户想出来的（2026-09-26 用户定调）：探针完成后先让模型
    // 流式把思考讲出来，再从同一条回复解析计划；规则步骤只在确认对话兜底。
    // 曾经的 LLM 预分析死于「静默 complete + 失败噪音」，这里必须是流式且安静。
    const probe = src.indexOf('await discoverWorkspace(');
    const thinking = src.indexOf('await this.planByThinking(chatEl, userText, userImages, needsDeliveryGate, removeThinkingCard);');
    const planRender = src.indexOf('showPlanCard(approvedPlan);');
    expect(probe).toBeGreaterThan(-1);
    expect(thinking).toBeGreaterThan(probe);
    expect(planRender).toBeGreaterThan(thinking);
    expect(src).toMatch(/llm\.stream\(request, \[\], ac\.signal\)/);
    expect(src).toMatch(/createPlanCard\(plan, refining, planProgress(, \(\) => this\.activeTaskScript)?\)/);
    expect(src.indexOf('已回退到通用步骤')).toBe(-1);
    // 死空气回归的锁定（2026-09-26）：规划期间思考卡活着顶着（「正在想这个任务
    // 怎么做…」），第一个可见字落屏才收卡（removeThinkingCard 作揭卡回调传入），
    // 规划调用走关暗思考的专用适配器（this.planLlm）。
    expect(src).toMatch(/if \(thinkingCard\) setThinkingLabel\(thinkingCard, '正在想这个任务怎么做…'\)/);
    expect(src).toMatch(/planByThinking\(chatEl, userText, userImages, needsDeliveryGate, removeThinkingCard\)/);
    expect(src).toMatch(/const llm = this\.planLlm \?\? this\.turnLlm;/);
    expect(src).toMatch(/this\.planLlm = createLLMAdapter\(config, \{ disableThinking: true \}\);/);
  });

  it('shows the assessment card after the workspace probe, never synchronously at send start', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 评估卡由规则层判断驱动：探针完成后（maybeShowAssessment 首次调用）
    // 才出现，绝不在 send() 一开始就同步弹出。
    const probe = src.indexOf('await discoverWorkspace(');
    const cardCall = src.indexOf('maybeShowAssessment();');
    expect(cardCall).toBeGreaterThan(-1);
    expect(cardCall).toBeGreaterThan(probe);
    // The old instant-heuristic card ("已识别为 … 请求，正在评估影响范围…") must be gone.
    expect(src.indexOf('已识别为 ${analysis.intent.intent} 请求')).toBe(-1);
  });

  it('does not force project builds through a generic approval dialog', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const gate = src.indexOf('const needsInteractiveApproval = forcedMode === \'plan\' || forcedMode === \'build\';');
    const review = src.indexOf('await requestPlanReview(', gate);
    const autoStart = src.indexOf('approvePlan();', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(review).toBeGreaterThan(gate);
    expect(autoStart).toBeGreaterThan(gate);
    expect(src).not.toContain('needsDeliveryGate && forcedMode !== \'yolo\'');
  });

  it('runs without waiting for authorization: high risk no longer gates, plans start at once', () => {
    // 2026-09-17 产品决策：不必要的授权停等全部取消（默认自动允许）——
    // 高风险不再触发确认卡，风险只影响评估卡的展示；计划就绪即开工，
    // 不再保留“计划批准暂停”状态。只有用户主动选择的计划/构建模式
    // 保留确认流程（那是模式本身的语义），以及不可逆 UI 确认。
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const gate = src.indexOf("const needsInteractiveApproval = forcedMode === 'plan' || forcedMode === 'build';");
    expect(gate).toBeGreaterThan(-1);
    // The old `riskReview ||` prefix must be gone — risk only shapes display.
    expect(src.indexOf('needsInteractiveApproval = riskReview')).toBe(-1);
    // pauseAfterPlanning（计划就绪→等一句“开工”）fully retired — covered by
    // the plan-prompt test below (approved=true on every path).
    expect(src.indexOf('pauseAfterPlanning')).toBe(-1);
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
    expect(src).toContain("keepOrDropUserBubble('已暂停：你的请求已保留在对话中。')");
    // Every remaining userBubble.remove() is guarded by a session-switch check.
    expect(src).toMatch(/if \(gen !== this\.generation\) \{\s*userBubble\.remove\(\);\s*return;\s*\}/);
  });

  it('commits a preflight-paused request into the live history so 继续 has context', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 回归：预检阶段被停止时，请求此前只落盘、不进 this.messages —— 同一会话里
    // 再发「继续」时模型完全看不到原始任务。所有暂停路径必须经由
    // commitPausedUserTurn 提交进内存历史并置 hasHistory，下次发送走 continueTurn。
    const commit = src.indexOf('const commitPausedUserTurn = (');
    expect(commit).toBeGreaterThan(-1);
    expect(src.slice(commit)).toContain('this.hasHistory = true');
    // keepOrDropUserBubble 委托给 commitPausedUserTurn（不再只 persistSession）。
    const keeper = src.indexOf('const keepOrDropUserBubble = (pausedText: string): void => {', commit);
    expect(keeper).toBeGreaterThan(commit);
    expect(src.slice(keeper, keeper + 600)).toContain('commitPausedUserTurn(toolResults, thinkingPhases)');
    // 工作区解析期间的中断分支同样提交（该分支在 toolResults 声明前返回）。
    expect(src).toContain('commitPausedUserTurn(new Map(), []);');
    // 流中出错且已有部分输出的收尾快照也必须写回内存历史（isAuto 的代劳输入
    // 同步带 internal，见 sessionReplayFidelity 的全链锚）。
    expect(src).toMatch(/const interruptedSnapshot: Message\[\] = limitMessageHistory\(\[\s*\.\.\.this\.messages,\s*\{ role: 'user', content: userText, internal: isAuto \|\| undefined \},/);
  });

  it('wires the abort signal into the plan-review dialog', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 停止按钮在计划确认显示期间必须生效，否则 send() 会永久挂起。
    expect(src).toContain('riskReview,');
    expect(src).toContain('signal: this.abortController?.signal,');
    // 计划卡随当前会话渲染（多会话模式下后台会话不把卡插进正在看的对话）。
    expect(src).toContain('host: this.transcriptTarget(),');
    expect(src).toContain('scope: this.sessionId || sendSessionId,');
  });

  it('honors an explicit custom-provider wire protocol instead of URL-only detection', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 自定义供应商在 Settings → LLM 里把接口协议存进 customProviders 条目
    // （不是 providerOverrides —— 那张表只装内置供应商）。适配器工厂必须把
    // custom.protocol 作为用户显式选择交给解析器，否则 /anthropic 之外的
    // 任意 URL（代理/镜像）会被误判成 openai 协议。
    expect(src).toContain("Boolean(custom?.baseURL) || Boolean(builtinOverride?.baseURL)");
    expect(src).toContain('custom?.protocol ?? builtinOverride?.protocol');
  });

  it('runs the delivery gate only when the turn did real tool work, never on a question-only turn', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 模型提问/确认轮（无 tool 消息）不是交付完成：不触发回合末交付验证，
    // 评估卡保持执行等待而不是跳到验证结果。
    expect(src).toContain("const hasToolWork = (event.payload.messages ?? []).some((m) => m.role === 'tool');");
    expect(src).toContain('if (needsDeliveryGate && hasToolWork && !event.payload.interrupted && gen === this.generation) {');
    expect(src).toContain("(!needsDeliveryGate || (hasToolWork && deliveryResult?.passed === true))");
    expect(src).toContain("assessmentFlow.setPhase('execute', '本轮没有产生文件改动（如需确认细节，模型会直接提问），等待你的回复后继续。'");
  });

  it('backstops the agent-driven delivery pipeline with the deterministic mechanical re-run', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 回合末必须真实重跑机械验证（runDeliveryVerification），失败后用真实失败
    // 输出驱动有界修复轮（runDeliveryFixRound），每轮修复后重新验证。
    const backstop = src.indexOf('await runDeliveryVerification(codingAgent.toolRegistry, workspaceProfile, turnSignal, onDeliveryStep)');
    const fixRound = src.indexOf('await runDeliveryFixRound(completionMessages, deliveryResult)');
    expect(backstop).toBeGreaterThan(-1);
    expect(fixRound).toBeGreaterThan(backstop);
    expect(src).toContain('const qualityPassed = !needsDeliveryGate || (deliveryResult?.passed === true && gen === this.generation);');
    // 旧的 LLM VERDICT 门禁卡不再出现在 GUI 流程里。
    expect(src.indexOf('createQualityGateCard')).toBe(-1);
    expect(src.indexOf('runProjectQualityGate')).toBe(-1);
  });

  it('presents probe findings once, only via reportProbeFindings', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 探针结论（探索/契约气泡）只能在 reportProbeFindings 内出现，由
    // maybeShowAssessment 在预检（工作区扫描）完成后统一呈现。
    const report = src.indexOf('const reportProbeFindings = (): void => {');
    const exploration = src.indexOf('已完成项目探索');
    const contract = src.indexOf('已建立任务契约');
    expect(report).toBeGreaterThan(-1);
    expect(exploration).toBeGreaterThan(report);
    expect(contract).toBeGreaterThan(report);
    expect(src.indexOf('reportProbeFindings();')).toBeGreaterThan(-1);
    expect(src).toContain('workflow.probeRequired && !workflow.probeAvailable');
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
    // 改为在真实阶段边界设置诚实标签：预检探查期与引擎循环等待首 token 时。
    expect(src).toContain("setThinkingLabel(earlyAnalysisCard, '正在读取工作区，并结合你的目标判断…')");
    expect(src).toContain("setThinkingLabel(thinkingCard, '等待模型首字返回…')");
    expect(src.indexOf('正在分析你的请求…')).toBe(-1);
  });

  it('passes explicit approval into the plan prompt so execution starts immediately', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 计划就绪即开工（2026-09-17 起所有路径如此，不再有等待“开工”消息的分支）：
    // 模型第一轮必须立即执行——否则模型第一轮不调用工具，引擎空转完成，计划卡
    // 还停在第一步就突然进入交付验证、评估卡跳到“验证结果”。
    expect(src).toContain('formatPlanForPrompt(approvedPlan, needsDeliveryGate, true)');
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

describe('footer context-window estimate', () => {
  it('caches the real system+tool overhead measured at prompt assembly', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 底部进度条必须复用 send() 里真实装配的系统提示词 + 工具定义开销，而不是
    // 拿一个静态近似值当真理——否则启动/恢复时的占用百分比会和真实上下文脱节。
    const cache = src.indexOf('this.contextOverhead = {');
    expect(cache).toBeGreaterThan(-1);
    expect(src.slice(cache, cache + 220)).toContain('estimatePromptTokens(systemPrompt)');
    expect(src.slice(cache, cache + 220)).toContain('estimateToolDefinitionTokens(promptTools)');
    expect(src).toContain('getContextOverheadTokens(): { system: number; tools: number }');
  });

  it('denominates the bar against the full context window using the POST-compaction load', () => {
    const src = readSource(new URL('../main.ts', import.meta.url));
    const render = src.indexOf('function renderContextWindowBar(): void {');
    expect(render).toBeGreaterThan(-1);
    const seg = src.slice(render, render + 1900);
    expect(seg).toContain('const windowTokens = budget.contextWindowTokens ?? 0;');
    // The bar shows what the next request will actually carry (the engine's
    // post-compaction estimate), NOT the raw transcript — raw history is
    // never sent as-is once it overflows, which is exactly why a "100%"
    // raw reading kept working.
    expect(seg).toContain('const rawMessageTokens = estimateMessageTokens(chat.getMessages());');
    expect(seg).toContain('const last = chat.getLastCompaction();');
    expect(seg).toContain('const used = last ? last.estimatedTokens : rawUsed;');
    // 空会话（还没对话）不显示占用，避免“一句话都没说就用了 X%”的错觉。
    expect(seg).toContain('rawMessageTokens <= 0');
    expect(seg).toContain('value > 90');
    // Compaction is visible: suffix + tooltip say when trimming is active.
    expect(seg).toContain('compacted');
    expect(src).toContain('function contextOverheadTokens(): { system: number; tools: number } {');
  });
});

describe('plan overview completion state', () => {
  it('finalizes the chat plan card on completion without depending on phase markers', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 完成收尾的证据来自本轮真实工具执行 + 正常结束（hasToolWork 与提问轮约定
    // 一致），而不是模型是否恰好发出了 `## 计划 n 已完成` 标记——漏发时卡片
    // 不能永远停在第一步。
    const planFinished = src.indexOf('const planFinished = planCard && hasToolSuccess');
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
    expect(src).toContain('createPlanCard(plan, refining, planProgress, () => this.activeTaskScript)');
    expect(src).toContain('updatePlanCard(planCard, plan, refining, planProgress, () => this.activeTaskScript)');
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
    expect(src).toContain('就差「计划');
    expect(src).toContain('!planTrack.phaseCompleted.has(finishedPlan)');
    expect(src).toContain('const legacyPlanFinished = planCard && !planTrack.protocolStarted');
    expect(src).toContain('completionSnapshot.currentPlan >= completionSnapshot.plan.steps.length;');
    expect(src).toContain('shouldAdvancePlanAtTurnEnd(planFinished === true, completionSnapshot, planTrack.completedPlan)');
    expect(src).toContain("'phaseJumped' : 'phaseStarted', planNumber: nextPlan });");
    expect(src).toContain('const protocolPlanFinished = planCard && completionSnapshot && planTrack.phaseCompleted.has(completionSnapshot.plan.steps.length);');
  });

  it('jumps the card straight to a later plan the model reports starting', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 执行期卡片靠 `## 计划 n：` 标记推进。旧逻辑在“当前计划的 Todo 未全部
    // 标记完成”时直接卡在第一步；现在模型明确进入更后面的计划时，把它当作
    // 当前计划隐式完成并直接跳到标记指出的计划（而不是每标记只前进一步）。
    // 协议门禁仍然生效：当前计划未播报完成时只暂缓（deferredReason='protocol'），
    // 验证证据统一由回合末确定性交付验证把关，不再阻塞游标。
    const guard = src.indexOf("if (marker.kind === 'phase') {", src.indexOf('const trackPlanPhase'));
    expect(guard).toBeGreaterThan(-1);
    const forceAdvance = src.indexOf('The model explicitly started a later plan', guard);
    const protocolGate = src.indexOf("planTrack.deferredReason = 'protocol';", forceAdvance);
    // 事件模型先经过协议门禁，再用 phaseJumped 事件一次性落到目标计划。
    const jump = src.indexOf("planProgress?.dispatch({ type: 'phaseJumped', planNumber: Math.max(before + 1", protocolGate);
    expect(forceAdvance).toBeGreaterThan(guard);
    expect(protocolGate).toBeGreaterThan(forceAdvance);
    expect(jump).toBeGreaterThan(protocolGate);
  });

  it('finishes the last plan from its own completion marker only when its Todos are done', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // `## 计划 n 已完成`（最后一个计划）在 Todo 全部真实完成时推进到完成态
    // （total + 1）；Todo 未完成时只更新文案，绝不 force 清空——收尾证据由
    // 回合末判定把关，避免“只做了一半就播报完成”被当成整计划完成。
    const finishPlan = src.indexOf('const finishPlan = (planNumber: number): void => {');
    expect(finishPlan).toBeGreaterThan(-1);
    const lastPlan = src.indexOf('const isLastPlan = planNumber >= finishSnapshot.plan.steps.length;', finishPlan);
    const todosGate = src.indexOf("if (!(planProgress?.canCompleteCurrentTodos() ?? false)) {", finishPlan);
    const lastActivity = src.indexOf('整个计划收尾中…', finishPlan);
    expect(lastPlan).toBeGreaterThan(finishPlan);
    expect(todosGate).toBeGreaterThan(lastPlan);
    expect(lastActivity).toBeGreaterThan(todosGate);
    // 不再对最后计划 force 清空未完成 Todo。
    expect(src.slice(finishPlan, lastActivity)).not.toContain('force: isLastPlan');
  });

  it('requires real completion evidence before marking the plan done', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 收尾判定不再只信模型播报：最后阶段 Todo 真实完成、或构建计划回合末
    // 交付验证通过，才 dispatch completed。
    const branch = src.indexOf('} else if (planCompletionCandidate');
    expect(branch).toBeGreaterThan(-1);
    const seg = src.slice(branch, branch + 1600);
    expect(seg).toContain('const lastTodosDone =');
    expect(seg).toContain('lastTodosDone || (needsDeliveryGate && (qualityPassed === true || this.deliveryGatePassed === true))');
  });

  it('keeps the plan context when the delivery gate fails', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 交付门禁未通过时不 dispatch completed：activeComplexPlan 保留，下一轮
    // “修复/继续”走原计划续跑而不是丢失计划卡后重新分析。
    const branch = src.indexOf('} else if (planCompletionCandidate');
    expect(branch).toBeGreaterThan(-1);
    const seg = src.slice(branch, branch + 1600);
    const blocked = seg.indexOf('const deliveryBlocked = needsDeliveryGate && !qualityPassed && !this.deliveryGatePassed;');
    expect(blocked).toBeGreaterThan(-1);
    const completed = seg.indexOf("planProgress?.dispatch({ type: 'completed' });");
    expect(completed).toBeGreaterThan(blocked);
    expect(seg.slice(blocked, completed)).toContain('不把计划标记为完成');
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

  it('delivers a build plan from delivery-gate evidence when the cursor is stuck mid-list', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 模型做文档类项目时常漏发 `## 计划 n` 起始/完成标记，游标卡在列表中间；
    // 此时构建计划的交付验证通过（真实 typecheck/测试/构建全绿）就是项目已交付
    // 的证据，必须把计划置为完成——否则顶部进度条永远停在「第 N/6 步」。
    const candidate = src.indexOf('const deliveryCompletedPlan = planCard');
    expect(candidate).toBeGreaterThan(-1);
    // 守卫：只对构建计划、且交付验证真实通过、游标确实未到末步时触发。
    expect(src.slice(candidate, candidate + 550)).toContain('needsDeliveryGate && qualityPassed === true');
    expect(src.slice(candidate, candidate + 550)).toContain('hasToolSuccess');
    expect(src.slice(candidate, candidate + 550)).toContain('completionSnapshot.currentPlan < completionSnapshot.plan.steps.length');
    // 本轮已播报下一计划时不抢跑（标记机制正要推进游标）。
    expect(src.slice(candidate, candidate + 550)).toContain('!planTrack.phaseStarted.has(completionSnapshot.currentPlan + 1)');
    // 兜底并入回合末完成判定，且复用「交付门禁通过」分支 dispatch completed。
    const gate = src.indexOf('|| (deliveryCompletedPlan && planCard)', candidate);
    expect(gate).toBeGreaterThan(candidate);
    expect(src.slice(gate, gate + 1200)).toContain("planProgress?.dispatch({ type: 'completed' });");
  });

  it('finalizes a build plan on a pure closing summary round using session delivery evidence', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 构建计划的收尾回合常不带工具调用（纯总结轮），deliveryResult 不会重算；
    // 只要本会话曾真实通过过交付验证，就应把计划置为完成，否则顶部进度条永远
    // 停在「执行中 第 N 步」。
    const cand = src.indexOf('const deliverySummarizedPlan = planCard');
    expect(cand).toBeGreaterThan(-1);
    const seg = src.slice(cand, cand + 700);
    expect(seg).toContain('needsDeliveryGate && this.deliveryGatePassed === true');
    expect(seg).toContain('!hasToolWork');
    expect(seg).toContain('completionSnapshot.status !== \'complete\'');
    // 与「纯工具轮」的 deliveryCompletedPlan 兜底互补，并入同一回合末完成判定。
    const branch = src.indexOf('|| (deliverySummarizedPlan && planCard)', cand);
    expect(branch).toBeGreaterThan(cand);
    const blocked = src.indexOf('const deliveryBlocked = needsDeliveryGate && !qualityPassed');
    const dispatch = src.indexOf("planProgress?.dispatch({ type: 'completed' });", blocked);
    expect(blocked).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(blocked);
    expect(src.slice(blocked, dispatch)).toContain('this.deliveryGatePassed === true');
  });

  it('never force-advances a stage whose work is incomplete', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 回合收尾兜底（canAdvancePlan）只在实际证据齐备时推进：当前阶段 Todo 全部
    // 完成、或模型已播报下一阶段、且构建计划已有验证证据。未完成的工作绝不能被
    // force 清空后当成“阶段已完成”跳过。
    const fallback = src.indexOf('if (canAdvancePlan && planProgress && planCard) {');
    expect(fallback).toBeGreaterThan(-1);
    const evidence = src.indexOf('const todosDone = planProgress.canCompleteCurrentTodos();', fallback);
    expect(evidence).toBeGreaterThan(-1);
    const announced = src.indexOf('const nextAnnounced = planTrack.phaseStarted.has(nextPlan);', evidence);
    expect(announced).toBeGreaterThan(-1);
    expect(src.indexOf("'phaseJumped' : 'phaseStarted'", announced)).toBeGreaterThan(announced);
    // 证据不足时只更新活动文案，不再无条件 force 清空未完成 Todo。
    const blockEnd = src.indexOf('} else if (planCompletionCandidate', fallback);
    expect(blockEnd).toBeGreaterThan(fallback);
    expect(src.slice(fallback, blockEnd)).not.toContain('force: true');
  });

  it('injects the agent-driven delivery pipeline prompt for project builds', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 检视→typecheck→单测→e2e 作为计划最后阶段下发给模型；UI 工程附带设计先行协议。
    const inject = src.indexOf('formatDeliveryPipeline(workspaceProfile, workflow.needsDesignPhase)');
    expect(inject).toBeGreaterThan(-1);
    const gate = src.indexOf('deliveryPipeline: needsDeliveryGate');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(inject);
    // 旧的“交付前测试与审计”节点必须删干净。
    expect(src.indexOf('交付前测试与审计')).toBe(-1);
  });

  it('pauses UI builds at the design-ready marker until the user confirms the mockup', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 有界面的工程：模型发出 `## 设计稿已就绪：<file>` 后，GUI 读取文件渲染
    // 预览卡（iframe），评估卡停在等待态，自动续跑链路被 planTerminal 硬停。
    const marker = src.indexOf('parseDesignReadyMarker(finalAnswer)');
    expect(marker).toBeGreaterThan(-1);
    const card = src.indexOf('createDesignPreviewCard(html, designMockupFile', marker);
    expect(card).toBeGreaterThan(marker);
    const awaitPhase = src.indexOf("assessmentFlow.awaitPhase('execute', '设计稿已就绪，等待你在预览卡确认后开始实现…')", card);
    expect(awaitPhase).toBeGreaterThan(card);
    expect(src.indexOf('|| designPreviewShown,')).toBeGreaterThan(-1);
  });

  it('never records a clean end for an interrupted round, so Stop kills the auto-continue chain', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 用户在多步计划执行中途点停止：引擎仍会补发一个 Completed(interrupted=true)，
    // 该回合绝不能带着 cleanEnd=true 进入 send() 的 finally——否则自动续跑会在
    // 1.2s 后重新排下一轮，表现为“点了暂停，计划却继续跑”。cleanEnd 必须把
    // interrupted 一票否决（调度器侧的契约见 autoContinue.test.ts）。
    const record = src.indexOf('this.pendingAutoContinue = {');
    expect(record).toBeGreaterThan(-1);
    const seg = src.slice(record, record + 600);
    expect(seg).toContain('planActive: planCard !== undefined,');
    expect(seg).toContain('!event.payload.interrupted && gen === this.generation');
  });

  it('serializes concurrent interjects instead of silently dropping them', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const orch = readSource(new URL('../../coding-agent/interjectOrchestrator.ts', import.meta.url));
    // 流式插话第二条在第一条判定期间到达时，旧代码 `if (this.insertInFlight)
    // return` 直接丢弃——而 main.ts 在调用 interject() 的同一瞬间就清空了输入框，
    // 用户的话就此蒸发。现在后到的插话挂到序列化链上排队等
    // 前一个判定完成，永不丢弃；单个判定失败也不许毒化链条（run.catch）。
    // S2 第六刀：链与裁决序住 InterjectOrchestrator，宿主只锁旧路不复辟。
    expect(src.indexOf('if (this.insertInFlight) return')).toBe(-1);
    expect(orch.indexOf('this.chain.then(')).toBeGreaterThan(-1);
    // 判定失败除了不毒化链条，还必须把 pending 的临时回执收场——留着它就是
    // 一条永远在闪的"插话处理中…"。
    expect(orch.indexOf('this.chain = run.catch(() => {')).toBeGreaterThan(-1);
    expect(orch.indexOf("'未能处理这句插话；请重新发送。'")).toBeGreaterThan(-1);
    // 链上的每一环重新检查 isStreaming()：前一条 RELATED 插话可能已中止回合，
    // 轮到本条时它应该走正常 send 而不是对已结束的回合做判定。
    const link = orch.indexOf('private async classifyAndApply(');
    expect(link).toBeGreaterThan(-1);
    const linkBody = orch.slice(link, orch.indexOf('private matchSteerRecipient(', link));
    expect(linkBody.indexOf('if (!this.deps.isStreaming())')).toBeGreaterThan(-1);
    expect(linkBody.indexOf('this.deps.send(text, images, displayText)')).toBeGreaterThan(-1);
  });

  it('re-arms the deferred dispatch when a classification lands after the turn already ended', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const plane = readSource(new URL('../../coding-agent/roundClosePlane.ts', import.meta.url));
    const orch = readSource(new URL('../../coding-agent/interjectOrchestrator.ts', import.meta.url));
    // 判定 LLM 可能跑好几秒：回合在这期间自然结束的话，send() 的 finally 已经
    // 跑过 deferred dispatch——RELATED 插话 / 排队任务会冻结到用户下一条消息
    // 结束后才突然执行。判定落定时若已不在流式中，必须补一次 scheduleDispatch；
    // dispatch 的 isStreaming 守卫保证重复调度不会开出第二个并发回合。
    expect(src.indexOf('if (!this.isStreaming()) this.roundClose.scheduleDispatch()')).toBeGreaterThan(-1);
    // S2 第六刀：同类补派搬进了编排器（goal-change / premise-change 两处判定
    // 落地补派）——恰两处，删掉任何一处的 mutant 都要被这条计数抓住。
    expect(orch.split('if (!this.deps.isStreaming()) this.deps.roundClose.scheduleDispatch();').length - 1).toBe(2);
    const dispatch = plane.indexOf('  dispatch(): void {');
    expect(dispatch).toBeGreaterThan(-1);
    const dispatchBody = plane.slice(dispatch, dispatch + 400);
    expect(dispatchBody.indexOf('if (this.deps.isStreaming()) return;')).toBeGreaterThan(-1);
    // 注入钉（防宿主侧硬编码假读数把闸焊死）：派发序吃的三个宿主读数必须
    // 来自真账——流态、活动水位、「继续」链。常量 stub 会让守卫永真。
    const depsIdx = src.indexOf('private roundClose = new RoundClosePlane({');
    expect(depsIdx).toBeGreaterThan(-1);
    const depsBody = src.slice(depsIdx, depsIdx + 1_600);
    expect(depsBody.indexOf('isStreaming: () => this.isStreaming()')).toBeGreaterThan(-1);
    expect(depsBody.indexOf('activityCount: () => this.agentActivities.length')).toBeGreaterThan(-1);
    expect(depsBody.indexOf('autoContinuePending: () => this.autoContinue.pending')).toBeGreaterThan(-1);
    expect(depsBody.indexOf('reenter: (t) => void this.send(t.text, t.images, t.displayText)')).toBeGreaterThan(-1);
    expect(depsBody.indexOf('timer: (fn, ms) => window.setTimeout(fn, ms)')).toBeGreaterThan(-1);
  });

  it('bridges the classification gap with one ack line the receipt replaces in place', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const orch = readSource(new URL('../../coding-agent/interjectOrchestrator.ts', import.meta.url));
    // 插话判定是秒级 LLM 往返：期间用户的话不上屏（abort 类要从 send() 重入），
    // 没有即时回执就是死空气——说了句话没人理。ack 是唯一一条 pending 状态行，
    // 最终回执原行定格（settleAck）， transcript 不为一条插话出两行系统话。
    // S2 第六刀：case 分发住编排器；ack 的 DOM 面（创建/定格/摘行）是宿主投影缝。
    expect(src.indexOf("'插话处理中…'")).toBeGreaterThan(-1);
    const settle = src.indexOf('private settleAck(');
    expect(settle).toBeGreaterThan(-1);
    // 每条插话路径都要收场 ack：定格（回执行）或移除（有自己的气泡/卡片），
    // 不许留下一条永远 pending 的孤儿。
    for (const marker of ["case 'stop':", "case 'goal-change':", "case 'premise-change':", "case 'question':", "case 'chatter':"]) {
      const at = orch.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      const body = orch.slice(at, orch.indexOf("case '", at + marker.length) === -1 ? orch.length : orch.indexOf("case '", at + marker.length));
      // discardAckRow（2026-09-27）：直接摘行的统一出口——摘行的同时账上销账。
      expect(body.indexOf('this.deps.settleAck(ack') !== -1 || body.indexOf('this.deps.discardAckRow(ack)') !== -1).toBe(true);
    }
    // 折入 / steer / 队列路径通过方法参数收场 ack。
    expect(src.indexOf('private foldInScopeAddition(text: string, images: MessageImage[], displayText: string, mechanical: boolean, ack: HTMLElement | null, cancels: boolean)')).toBeGreaterThan(-1);
    expect(src.indexOf('private steerRunningTurn(text: string, images: MessageImage[], ack: HTMLElement | null, target: SteerTarget, cancel: boolean)')).toBeGreaterThan(-1);
  });

  it('honors the confidence gate in the interject path: destructive doubt asks, never aborts', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const orch = readSource(new URL('../../coding-agent/interjectOrchestrator.ts', import.meta.url));
    // 置信门把没把握的破坏性判定降级成 clarify + shouldAbort=false，但分发
    // 此前只看 kind——低置信 goal-change 照样拆任务，"问而不赌"形同虚设。
    // 现在分发在 kind switch 之前先兑现门：gatedFrom 是停/重开就问一句，
    // 手头的活照跑；用户的回答作为新插话重新分类。不破坏的误判自己能愈
    // （排队晚点跑、旁答只答一次），照旧分发，不拿问题烦人。
    // S2 第六刀：门在编排器（分发序的一半）；「问」的 LLM 产出是宿主缝。
    const gate = orch.indexOf('needsClarification(decision)');
    expect(gate).toBeGreaterThan(-1);
    expect(orch.indexOf('isDestructiveAction(gatedFrom as InputAction)', gate)).toBeGreaterThan(-1);
    const gateCheck = orch.slice(gate, orch.indexOf('switch (decision.kind)'));
    expect(gateCheck.indexOf("this.deps.askMidrunClarification(decision, text, images, ack)")).toBeGreaterThan(-1);
    // 问询必须落到用户面前：LLM 失败/不可用时退模板问，绝不静默。
    const ask = src.indexOf('private async askMidrunClarification(');
    expect(ask).toBeGreaterThan(-1);
    const askBody = src.slice(ask, src.indexOf('private steerRunningTurn', ask));
    expect(askBody.indexOf('const fallback =')).toBeGreaterThan(-1);
    // 问句落屏走 shown（question || fallback）——账本接线改写后兜底语义不变。
    expect(askBody.indexOf('const shown = question || fallback;')).toBeGreaterThan(-1);
    expect(askBody.indexOf('bubble.textContent = shown;')).toBeGreaterThan(-1);
  });

  it('shows the queue as one live card and narrates the handoff when it drains', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 每排一件发一行系统话是流水账；样本要的是"待办队列更新"——一张就地
    // 重渲染的活卡。排空时先说一声再动手：用户的下一句话凭空开始跑，
    // 没有衔接读起来就是无中生有。
    expect(src.indexOf('private renderQueueCard(): void')).toBeGreaterThan(-1);
    expect(src.indexOf('this.renderQueueCard();', src.indexOf('private queueInterjectTask('))).toBeGreaterThan(-1);
    expect(src.indexOf('待办队列（')).toBeGreaterThan(-1);
    expect(src.indexOf('队列：处理下一件，后面还排着')).toBeGreaterThan(-1);
    expect(src.indexOf('队列：现在处理排下的那件。')).toBeGreaterThan(-1);
    // 新会话清空待办账（plane.reset）时同步撤卡，不留上一场对话的幽灵队列。
    const reset = src.indexOf('this.roundClose.reset();');
    expect(reset).toBeGreaterThan(-1);
    expect(src.indexOf('this.queueCardEl = null;', reset)).toBeGreaterThan(-1);
    // 折入回执不再点名任务类型（"调研"）——追加的活可能是任何一种。
    // 回执话术已提取到 insertionMessaging（三处取消口径的单一事实来源）：
    // 原句扫那边，chat.ts 只扫接线（含反向锁：chat.ts 不得再内联文案）。
    const msg = readSource(new URL('../../shared/insertionMessaging.ts', import.meta.url));
    expect(src.indexOf('正在跑的调研收齐后')).toBe(-1);
    expect(msg.indexOf('收齐后先补这项')).toBeGreaterThan(-1);
    expect(src.indexOf('正在跑的活收齐后先补这项')).toBe(-1);
  });

  it('wires the asked ledger at every question/recovery seam (blueprint knife 2/3)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const ledger = readSource(new URL('../../shared/sessionLedger.ts', import.meta.url));
    // 第 4 期账本刀 2/3：四个提问/回收缝都必须落账——旁答两支（答上回填、
    // 没答上只记问题）、澄清问入账 + 句柄、logDecision 回答回收、切会话清
    // 账本和句柄。守卫对源码扫描：记账调用就是接缝本身。
    // 旁答（answerMidrunQuestion）两支：答上即回填 settled=true。
    const sideAnswer = src.indexOf('private async answerMidrunQuestion(');
    expect(sideAnswer).toBeGreaterThan(-1);
    const sideBody = src.slice(sideAnswer, src.indexOf('private async askMidrunClarification(', sideAnswer));
    expect(sideBody.indexOf("recordAsked(this.sessionLedger, { ts: Date.now(), question: text, source: 'sideAnswer' })")).toBeGreaterThan(-1);
    expect(sideBody.indexOf('recordAnswer(asked, asked.asked.at(-1)!.fingerprint, answer, Date.now())')).toBeGreaterThan(-1);
    // 澄清问入账 + 句柄只等一次（同族回收后句柄用完即弃）。
    const ask = src.indexOf('private async askMidrunClarification(');
    const askBody = src.slice(ask, src.indexOf('private steerRunningTurn', ask));
    expect(askBody.indexOf("recordAsked(this.sessionLedger, { ts: Date.now(), question: shown, source: 'clarification' })")).toBeGreaterThan(-1);
    expect(askBody.indexOf('this.pendingClarification = { fingerprint: asked.asked.at(-1)!.fingerprint, gatedFrom, ts: Date.now() }')).toBeGreaterThan(-1);
    const recovery = src.indexOf('澄清回答回收（窄启发式）');
    expect(recovery).toBeGreaterThan(-1);
    const recoveryBody = src.slice(recovery, recovery + 1_200);
    // 正向：同族方向才回填；反向：句柄无条件消费（不存在跨回合滞留）。
    expect(recoveryBody.indexOf('recordAnswer(this.sessionLedger, pending.fingerprint, text, Date.now())')).toBeGreaterThan(-1);
    expect(recoveryBody.indexOf('this.pendingClarification = null;')).toBeGreaterThan(-1);
    expect(recoveryBody.indexOf("pending.gatedFrom === 'stop' && decision.kind === 'stop'")).toBeGreaterThan(-1);
    // 切会话：账本与句柄一起作废。
    const reset = src.indexOf('this.sessionLedger = createSessionLedger();');
    expect(reset).toBeGreaterThan(-1);
    expect(src.indexOf('this.pendingClarification = null;', reset)).toBeGreaterThan(-1);
    // 委派 done 账与 plans 状态链（先 mark 后 record——反了会误标新条目）。
    expect(src.indexOf('this.sessionLedger = recordDone(this.sessionLedger,')).toBeGreaterThan(-1);
    const replaced = src.indexOf('this.sessionLedger = markPlanReplaced(this.sessionLedger, this.activePlanSeq);');
    expect(replaced).toBeGreaterThan(-1);
    expect(src.indexOf('this.sessionLedger = recordPlan(this.sessionLedger,', replaced)).toBeGreaterThan(-1);
    // 素材导出函数必须真实存在（接线不能指向不存在的缝）。
    expect(ledger.indexOf('export function formatSessionLedgerFacts(')).toBeGreaterThan(-1);
  });

  it('folds mid-flight scope additions into the aggregation round, with a deterministic fallback', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 用户三次实测暴露 + 定稿阶段语义：委派没收齐时插的追加活不能排到
    // "汇总输出之后"——要折入汇合轮（先补这项，再合并汇总）；委派收齐才
    // 插的照旧排队。折入不是祈祷模型听话：投递时记录委派水位，收尾核验
    // 没有新委派就转排队兜底，话绝不丢。
    const orch = readSource(new URL('../../coding-agent/interjectOrchestrator.ts', import.meta.url));
    const task = orch.indexOf("case 'task': {");
    expect(task).toBeGreaterThan(-1);
    const taskBody = orch.slice(task, orch.indexOf("case 'chatter':", task));
    expect(taskBody.indexOf('this.deps.hasDelegationInFlight()')).toBeGreaterThan(-1);
    expect(taskBody.indexOf('this.deps.foldInScopeAddition(')).toBeGreaterThan(-1);
    expect(taskBody.indexOf('this.deps.queueInterjectTask(')).toBeGreaterThan(-1);
    // 2026-09-22 重新设计：委派在飞期间 steer 不再是合法目的地——steer 判定
    // 也走折入（承诺不可兑现的"转达"就是丢话的根源）；分类器不可用不再旁路
    // 成 steer，交给 decide(null) 的 task 兜底。
    const steer = orch.indexOf("case 'steer': {");
    expect(steer).toBeGreaterThan(-1);
    const steerBody = orch.slice(steer, orch.indexOf("case 'question':", steer));
    expect(steerBody.indexOf('this.deps.hasDelegationInFlight()')).toBeGreaterThan(-1);
    expect(steerBody.indexOf('this.deps.foldInScopeAddition(')).toBeGreaterThan(-1);
    expect(src.indexOf('No classifier for this turn')).toBe(-1);
    expect(orch.indexOf('No classifier for this turn')).toBe(-1);
    // 折入三件套：原话上屏（宿主铺排）+ 投递记录水位（账本）+ 收尾核验
    // （账本裁决、残差转排队在宿主）。S2 第四刀后闸/账/核验的语义锁扫
    // foldInLedger 源；宿主锁「经账本」的委托形状。
    const ledger = readSource(new URL('../../coding-agent/foldInLedger.ts', import.meta.url));
    const plane = readSource(new URL('../../coding-agent/roundClosePlane.ts', import.meta.url));
    expect(ledger.indexOf('this.queue.push(')).toBeGreaterThan(-1);
    expect(src.indexOf('this.addBubble(\'user\', displayText, images)', src.indexOf('private foldInScopeAddition('))).toBeGreaterThan(-1);
    expect(src.indexOf('this.folds.beginDelivery(')).toBeGreaterThan(-1);
    expect(ledger.indexOf('fold.activityCountAtDelivery = input.activityCount')).toBeGreaterThan(-1);
    // 2026-09-22 插话重设计（代执行回合）：委派收齐后的第一个 THINK 边界，
    // 宿主把 scope 追加包成普通委派调用交还引擎——引擎跳过本轮模型调用，走
    // 原生 ACT 管线（ToolStarted 出卡片 / SubagentActivity 流明细 / ToolResult
    // 收尾入档）。顺序由结构保证，卡片与正常委派同源，不再手搓任何 UI。
    expect(src.indexOf('takeSyntheticToolCalls: async () =>')).toBeGreaterThan(-1);
    const synth = src.indexOf('takeSyntheticToolCalls: async () =>');
    const synthBody = src.slice(synth, synth + 1_500);
    expect(synthBody.indexOf('if (this.hasDelegationInFlight()) return [];')).toBeGreaterThan(-1);
    // 领用记账住账本（S2 第四刀）：投递标记/水位/代执行 id 的语义锁扫
    // foldInLedger 源；宿主锁「经 claimForSynthetic」的委托形状与实时注入
    // （水位/末位角色硬编码会让账本记错账而测试全绿）。
    expect(synthBody.indexOf('this.folds.claimForSynthetic(')).toBeGreaterThan(-1);
    expect(synthBody.indexOf('activityCount: this.agentActivities.length')).toBeGreaterThan(-1);
    expect(synthBody.indexOf('lastAgentRole: () => this.agentActivities[this.agentActivities.length - 1]?.agentName')).toBeGreaterThan(-1);
    expect(ledger.indexOf('fold.delivered || !fold.mechanical) continue;')).toBeGreaterThan(-1);
    expect(ledger.indexOf('fold.delivered = true;')).toBeGreaterThan(-1);
    expect(ledger.indexOf('fold.syntheticCallId = callId;')).toBeGreaterThan(-1);
    expect(synthBody.indexOf('追加委派：')).toBeGreaterThan(-1);
    // 任务书必须带主任务上下文（2026-09-22 实测教训：用户原话速记原样当
    // 任务书，子代理把「爱奇艺」跑成了爱奇艺开放平台 API 文档）。
    expect(synthBody.indexOf('JSON.stringify({ prompt: brief })')).toBeGreaterThan(-1);
    expect(synthBody.indexOf('用户的主任务：「${userText}」')).toBeGreaterThan(-1);
    expect(synthBody.indexOf('${fold.text}')).toBeGreaterThan(-1);
    // S2 第一刀后：投递/消费语义住进 SteerBus（宿主无关），闭包只剩委托；
    // 折入铺排住进 deliverDueFoldIns（父边界回调，在飞判断在回调里）。
    // 语义锁不变：定向投递语义在 bus 源里、折入闸门在回调里、此前所有手搓
    // UI 补丁（宿主内直接 orchestrator.execute / 合成卡片 / 事件泵 / 思考卡
    // 接管）必须不存在。
    const closure = src.indexOf('takeSteerMessages: async (recipient) =>');
    const closureBody = src.slice(closure, synth);
    expect(closureBody.indexOf('this.steerBus.drain(recipient, () => this.deliverDueFoldIns())')).toBeGreaterThan(-1);
    const foldHook = src.indexOf('private deliverDueFoldIns()');
    const foldBody = src.slice(foldHook, foldHook + 2200);
    // 闸门住账本（在飞读数由宿主注入）——语义锁扫 foldInLedger 源；注入
    // 锚锁宿主喂的是实时读数（硬编码 false 会让闸死掉而测试全绿）。
    expect(ledger.indexOf('if (input.delegationInFlight) return [];')).toBeGreaterThan(-1);
    expect(ledger.indexOf('fold.delivered || fold.mechanical) continue;')).toBeGreaterThan(-1);
    expect(ledger.indexOf('fold.mergeFramed = true;')).toBeGreaterThan(-1);
    expect(foldBody.indexOf('this.folds.beginDelivery(')).toBeGreaterThan(-1);
    expect(foldBody.indexOf('delegationInFlight: this.hasDelegationInFlight()')).toBeGreaterThan(-1);
    expect(foldBody.indexOf('activityCount: this.agentActivities.length')).toBeGreaterThan(-1);
    expect(foldBody.indexOf('lastAgentRole: () => this.agentActivities[this.agentActivities.length - 1]?.agentName')).toBeGreaterThan(-1);
    expect(foldBody.indexOf('subagentOrchestrator.execute(')).toBe(-1);
    expect(foldBody.indexOf('appendToolRow(')).toBe(-1);
    expect(foldBody.indexOf('finalizeToolRow(')).toBe(-1);
    expect(foldBody.indexOf('subagentEventFanout.subscribe()')).toBe(-1);
    // 投递/消费语义的单一真相现在在 bus 模块里（点名独占/广播复制父收走）。
    const busSrc = readFileSync('src/coding-agent/steerBus.ts', 'utf8');
    expect(busSrc.indexOf('steerDeliversTo(entry.target, recipient)')).toBeGreaterThan(-1);
    expect(busSrc.indexOf('steerConsumedBy(entry.target, recipient)')).toBeGreaterThan(-1);
    expect(busSrc.indexOf('const isBranch = Boolean(recipient?.branchCallId);')).toBeGreaterThan(-1);
    // 兑现回写：foldin_* 的 ToolResult 成功 ⇒ mechanicallyDone（settle 放行）。
    // 找账住 FoldInLedger（S2 第四刀）——宿主锁委托形状，语义锁扫账本源。
    const toolResultCase = src.indexOf("case 'ToolResult': {");
    expect(toolResultCase).toBeGreaterThan(-1);
    expect(src.slice(toolResultCase, toolResultCase + 900).indexOf('this.folds.markMechanicallyDone(')).toBeGreaterThan(-1);
    expect(ledger.indexOf('f.syntheticCallId === callId')).toBeGreaterThan(-1);
    // 代执行回合的卡片兜底（2026-09-23 用户实测：合成回合没有流式 TokenDelta，
    // 卡片必须由 ToolStarted 补上，否则追加的委派后台在跑、对话流里无卡）。
    const toolStartedCase = src.indexOf("case 'ToolStarted': {");
    expect(toolStartedCase).toBeGreaterThan(-1);
    const startedBody = src.slice(toolStartedCase, toolStartedCase + 1_400);
    expect(startedBody.indexOf('pendingRows.has(callId)')).toBeGreaterThan(-1);
    expect(startedBody.indexOf("appendToolRow(toolName, args, subagentNames.has(toolName) ? 'agent' : 'tool')")).toBeGreaterThan(-1);
    expect(startedBody.indexOf('pendingRows.set(callId,')).toBeGreaterThan(-1);
    // 插话回显次序（2026-09-23 用户实测：回执压在用户原话头上；2026-09-25
    // 复测升级：流式行插进判定窗口时「末尾追加+相邻才搬」失守，改为回显
    // 插队到 ack 行正前）——折入与 echo 两条路径都要走 placeEchoBeforeAck。
    const foldInFn = src.indexOf('private foldInScopeAddition(');
    expect(src.slice(foldInFn, foldInFn + 600).indexOf('this.placeEchoBeforeAck(ack, bubble)')).toBeGreaterThan(-1);
    // 插话回显住编排器分发（S2 第六刀），宿主 echoUser 投影做插队。
    const echoFn = src.indexOf('echoUser: (ack, displayText, images) =>');
    expect(src.slice(echoFn, echoFn + 300).indexOf('this.placeEchoBeforeAck(ack as HTMLElement | null, bubble)')).toBeGreaterThan(-1);
    // 水位核验的裁决住账本（S2 第四刀）；宿主只把残差转排队。
    expect(ledger.indexOf('activityCount > fold.activityCountAtDelivery')).toBeGreaterThan(-1);
    // 残差转排队住收尾缝（S2 第五刀）：foldSettle 依赖把账本残差按合并口径
    // 包成排队任务，冻结进 RoundClosePlane 的待办账。
    expect(src.indexOf('foldSettle: (activityCount) => this.folds.settle(activityCount).map((fold) =>')).toBeGreaterThan(-1);
    expect(src.indexOf('this.foldInFollowUpText(fold.text)')).toBeGreaterThan(-1);
    // dispatch 一进门先结算折入，同一趟把兜底任务派出去。
    expect(plane.indexOf('for (const task of this.deps.foldSettle(this.deps.activityCount())) this.queueTask(task);')).toBeGreaterThan(-1);
  });

  it('handles a cancelled branch of parallel work as a removal, never an addition (2026-09-24 取消案例)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const msg = readSource(new URL('../../shared/insertionMessaging.ts', import.meta.url));
    // 真实事故：三方并行调研中"jev 这个就不调研了"被判成加活折入——回执
    // "先补这项，再合并出一份覆盖全部的汇总"与意图正好相反。取消语义在
    // 宿主侧必须全链路成立：回执说拿掉、汇合轮框架说排除、收尾兜底不重跑。
    // 取消的机器可读标记是 signals.cancelsPart（快路径 CANCEL_PART_RE 或分
    // 类器 cancels_part 都归一到它）。
    expect(msg.indexOf('收到——这项不做了；其余照常。')).toBeGreaterThan(-1);
    const foldInFn = src.indexOf('private foldInScopeAddition(');
    const foldInBody = src.slice(foldInFn, src.indexOf('private cancelFoldInstruction', foldInFn));
    expect(foldInBody.indexOf('this.folds.add(')).toBeGreaterThan(-1);
    expect(foldInBody.indexOf('mechanical, cancels')).toBeGreaterThan(-1);
    // 收执话术走共享模块（foldInReceipt）——原句的归属在 insertionMessaging，
    // chat.ts 侧锁住「必须经它」而不是自己内联。
    expect(foldInBody.indexOf('this.settleAck(ack, foldInReceipt(cancels, this.hasDelegationInFlight()))')).toBeGreaterThan(-1);
    // 汇合轮框架反着说死：不许为取消项派新委派、部分产出不进汇总、幸存分
    // 支照常合并——绝不能沿用追加口径（"派出去做完…覆盖所有对象"）。
    expect(src.indexOf('private cancelFoldInstruction(text: string): string')).toBeGreaterThan(-1);
    const cancelFrame = msg.indexOf('【中途取消，不是追加】');
    expect(cancelFrame).toBeGreaterThan(-1);
    const cancelFrameBody = msg.slice(cancelFrame, cancelFrame + 400);
    expect(cancelFrameBody.indexOf('不要再为它派任何委派')).toBeGreaterThan(-1);
    expect(cancelFrameBody.indexOf('不写入最终汇总')).toBeGreaterThan(-1);
    expect(cancelFrameBody.indexOf('只覆盖剩下的对象')).toBeGreaterThan(-1);
    // 交付分流：取消型折入走取消框架，追加型照旧。
    const deliver = src.indexOf('plan.fold.cancels ? this.cancelFoldInstruction(plan.fold.text) : this.foldInInstruction(plan.fold.text)');
    expect(deliver).toBeGreaterThan(-1);
    // 收尾核验对取消型直接放行：排除一项永远不会产生新委派活动，按追加
    // 的水位核验它恒算"没照办"，转排队只会把"取消"当活重跑（反向伤害）。
    // 裁决住账本（S2 第四刀）——语义锁扫 foldInLedger 源；宿主锁委托形状
    // （收尾结算经 roundClose 的 foldSettle 依赖缝进账本，S2 第五刀）。
    expect(src.indexOf('foldSettle: (activityCount) => this.folds.settle(activityCount).map((fold) =>')).toBeGreaterThan(-1);
    const ledger = readSource(new URL('../../coding-agent/foldInLedger.ts', import.meta.url));
    expect(ledger.indexOf('if (fold.cancels) continue;')).toBeGreaterThan(-1);
    // steer 分发透传取消标记；task 分发兜底改道——分类器万一仍把取消判成
    // task（案例的真实形态），绝不排队、绝不机械折入。
    // S2 第六刀：分发住 InterjectOrchestrator；折入/转达经动作缝回宿主。
    const orch = readSource(new URL('../../coding-agent/interjectOrchestrator.ts', import.meta.url));
    const steer = orch.indexOf("case 'steer': {");
    const steerBody = orch.slice(steer, orch.indexOf("case 'question':", steer));
    expect(steerBody.indexOf('decision.signals.cancelsPart === true')).toBeGreaterThan(-1);
    const task = orch.indexOf("case 'task': {");
    const taskBody = orch.slice(task, orch.indexOf("case 'chatter':", task));
    expect(taskBody.indexOf('decision.signals.cancelsPart === true')).toBeGreaterThan(-1);
    const override = taskBody.indexOf('cancelsPart === true');
    expect(taskBody.indexOf('this.deps.foldInScopeAddition(text, images, displayText, false, ack, true)', override)).toBeGreaterThan(-1);
    // 委派未出生的窗口（2026-09-26）：转达引擎的调用挂 null ack——收执由
    // 挂号处点名（能抽出话题就点名），不再用泛泛的"已转达"；机制承诺（没派
    // 的不会派之类）2026-09-28 起不进收执——那个窗口可能根本没有委派可派
    // （单任务场景，说了就是编造），承诺归框架/协议。收执只说砍了什么。
    // cancel=true 走取消专用注入框架（"手头的活继续"会把取消引导成计划照旧）。
    expect(taskBody.indexOf("this.deps.steerRunningTurn(text, images, null, 'parent', true)", override)).toBeGreaterThan(-1);
    expect(taskBody.indexOf('this.deps.queueInterjectTask(', override)).toBeGreaterThan(taskBody.indexOf('if (decision.signals.cancelsPart === true)', override));
  });

  it('a cancel arriving BEFORE any delegation exists gates the branch at birth (2026-09-26 插话先于委派)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const msg = readSource(new URL('../../shared/insertionMessaging.ts', import.meta.url));
    // 用户实测：插话落在委派出生之前——点名路（abortBranch）无支可点，
    // 折入路只守汇报步，三支照派、取消落空。修法=委派起飞闸：话挂
    // pendingCancels，批次起飞时 gateDelegations 按区分词匹配兑现（整批
    // 调用一起做候选集，「调研」这类共用词永远指不出单支）；挂号一次性
    // 消费、随回合清空——用户后来的「继续/再跑」是新指令，挂号无权否决。
    expect(src.indexOf('private delegationControl = new DelegationControlPlane();')).toBeGreaterThan(-1);
    // 四个挂号入口：steer 案（无委派窗 + 在飞点不出支的折入）、task 案（同两处）。
    // S2 第六刀：分发住编排器——挂号经 delegation 依赖缝进 plane。
    const orch = readSource(new URL('../../coding-agent/interjectOrchestrator.ts', import.meta.url));
    const steer = orch.indexOf("case 'steer': {");
    const steerBody = orch.slice(steer, orch.indexOf("case 'question':", steer));
    expect(steerBody.split('this.deps.delegation.registerCancel(text)').length - 1).toBe(2);
    const task = orch.indexOf("case 'task': {");
    const taskBody = orch.slice(task, orch.indexOf("case 'chatter':", task));
    expect(taskBody.split('this.deps.delegation.registerCancel(text)').length - 1).toBe(2);
    // 无委派窗的收执说人话：没派的不会派，不是泛泛的"已转达"；收执点名
    // 直接走 cancelBeforeDispatchReceipt（2026-09-26 用户实测反馈固定话术里
    // 「这项」是空的——能抽出话题就点名，与停支收执同一人味；S2 第六刀起
    // 编排器内联两参组合，宿主的旧包络方法已删）。
    expect(msg.indexOf('这项不做了。')).toBeGreaterThan(-1);
    expect(orch.split('this.deps.settleAck(ack, cancelBeforeDispatchReceipt(cancelReceiptTopic(text)))').length - 1).toBe(2);
    // 叙述一致性（2026-09-26 用户反馈）：取消型插话的转达走取消专用框架——
    // 通用框架「手头的活继续」会把取消引导成"计划照旧"，模型照数三支，
    // 收执说"不派了"、计划书里三支全名，自相矛盾。两处挂号调用都带 cancel=true。
    // footgun 反向锁（2026-10-01）：cancel 不再有默认值——曾经 `cancel = false`
    // 让忘传的取消路径静默用通用框架（"计划照旧"，2026-09-26 事故）；现在
    // 忘传是编译错误，签名里绝不能再出现 `cancel = false`。
    expect(src.indexOf('cancel = false')).toBe(-1);
    expect(src.indexOf('private steerRunningTurn(text: string, images: MessageImage[], ack: HTMLElement | null, target: SteerTarget, cancel: boolean)')).toBeGreaterThan(-1);
    // 取消专用框架的话术归 insertionMessaging.steerFrameText（chat.ts 侧锁
    // cancel 参数流转，那边锁措辞与分流——一致性测试再锁三处同向）。
    expect(msg.indexOf('用户收掉了一个方向/话题')).toBeGreaterThan(-1);
    // 叙述规则按场景给（2026-09-28）：有分路数剩下的分路，没分路就不提
    // 分路——不再教单任务场景「复述原规划几路」（对着一路编排「几路」）。
    // 负向锁切在 steerFrameText 函数体上：文档注释里留的事故原文不算数。
    const frameFn = msg.indexOf('export function steerFrameText');
    const frameBody = msg.slice(frameFn, msg.indexOf('/** ③-a', frameFn));
    expect(frameBody.indexOf('没有分路就不要提分路')).toBeGreaterThan(-1);
    expect(frameBody.indexOf('原规划几路')).toBe(-1);
    expect(orch.split("this.deps.steerRunningTurn(text, images, null, 'parent', true)").length - 1).toBe(2);
    // 起飞闸接进引擎配置：候选集由宿主备好，匹配与消费在纯函数
    // planTakeoffGate（与测试共用同一套纪律）。
    expect(src.indexOf('gateDelegations: async (calls) =>')).toBeGreaterThan(-1);
    expect(src.indexOf('gateDelegations: async (calls) => this.delegationControl.gate(calls, subagentNames)')).toBeGreaterThan(-1);
    // 匹配与消费住在 plane 里（delegationControl.gate）——宿主侧锁闭包委托形状。
    expect(orch.indexOf('cancelReceiptTopic')).toBeGreaterThan(-1);
    // 挂号不跨回合：finalize 与 new chat 两条清扫都要在。
    expect(src.split('this.delegationControl.settleRound()').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('clears same-named branches queued but not yet airborne (第 2 期「排队未起飞的同名支」)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 层定位：委派起飞闸。池内调用一起开跑（不存在"排在池里"的委派），
    // relay 下游由 fail-fast 管；真正「已排队、还没起飞」的委派只有一种
    // ——下一批次里父又派的那一支。所以停支的效力不只落在在飞那支：
    // 用户原话同时挂上同一道起飞闸，同回合的重派在出生点就被拦下。
    // 挂闸在 plane.stopNamed 内部（registerBranchStop）——delegationControl.test 锁着；宿主锁委托形状：
    const stopFn = src.indexOf('private stopNamedBranch(text: string, mode:');
    expect(stopFn).toBeGreaterThan(-1);
    const stopBody = src.slice(stopFn, src.indexOf('private branchLabel(', stopFn));
    expect(stopBody.indexOf('this.delegationControl.stopNamed(')).toBeGreaterThan(-1);
    // 两个停支入口（祈使停 + 取消型暂停）共用 stopNamedBranch，因此共用这道闸。
    // S2 第六刀：两个入口都在编排器分发里——经引擎动作缝（stopNamedBranch）
    // 回宿主，宿主再进 plane（真停把手）。
    const orch = readSource(new URL('../../coding-agent/interjectOrchestrator.ts', import.meta.url));
    expect(orch.split("this.deps.stopNamedBranch(text, pause ? 'pause' : 'abort')").length - 1).toBe(1);
    expect(orch.split("this.deps.stopNamedBranch(text, 'pause')").length - 1).toBe(1);
    // 闸读两本挂号簿住在 plane（gate 内 planTakeoffGate；挂闸在 stopNamed 内）。
    // 合成重派豁免：resume_/foldin_ 承载用户**最新**的话（「接着跑」「再加
    // 一个」），旧挂号无权否决——与挂号不跨回合同源纪律。
    // 合成重派豁免住在 plane（gate 内）——delegationControl.test 锁着。
    // 随回合清空（与 pendingCancels 同命）：回合收尾与 new chat 两条清扫都
    // 要在——控制器跨会话单例，new chat 不摘簿子，旧会话的停支挂号会闯进
    // 新会话把同话题的委派误杀在出生点。
    expect(src.split('this.delegationControl.settleRound()').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('re-delegates a NAMED paused branch with its original args (第 2 期第三刀)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const plane = readSource(new URL('../../coding-agent/roundClosePlane.ts', import.meta.url));
    // 「把 X 那支接着跑完」：续跑的唯一凭据是**原始参数**——稳定 sessionId
    // 命中 checkpoint，子引擎 continue。原始参数在委派批次起飞时捕获。
    expect(src.indexOf('private delegationControl = new DelegationControlPlane();')).toBeGreaterThan(-1);
    // 参数捕获与待重派账都住在 plane（gate 先捕获再过闸；queueResume 去重）
    // ——delegationControl.test 锁着。
    const dcSource = readSource(new URL('../../coding-agent/delegationControl.ts', import.meta.url));
    expect(dcSource.indexOf('private resumes: ResumeRecord[] = [];')).toBeGreaterThan(-1);
    // 宿主入口：resumesBranch 信号 → 点名（已暂停/已取消的支）→ 排队同参重派；
    // 排在停支/取消之前（带点名锚的「接着跑」最具体）。S2 第六刀：点名与
    // 排队住编排器；候选视图（stoppedBranches）是宿主读数缝，凭据进 plane。
    const orch = readSource(new URL('../../coding-agent/interjectOrchestrator.ts', import.meta.url));
    const steer = orch.indexOf("case 'steer': {");
    const steerBody = orch.slice(steer, orch.indexOf("case 'question':", steer));
    expect(steerBody.indexOf('decision.signals.resumesBranch === true')).toBeGreaterThan(-1);
    expect(steerBody.indexOf('this.resumeNamedBranch(text)')).toBeGreaterThan(-1);
    expect(steerBody.indexOf('resumesBranch === true')).toBeLessThan(steerBody.indexOf('decision.signals.branchStop === true'));
    const resumeFn = orch.indexOf('private resumeNamedBranch(text: string)');
    expect(resumeFn).toBeGreaterThan(-1);
    // 第 2 期第三刀：返回类型带 checkpoint 预检凭据（收执诚实二分——收执、
    // 兜底指令按同一份预检二分，见 insertionMessaging 的 RESUME_INVARIANTS）。
    expect(orch.slice(resumeFn, resumeFn + 160)).toContain("{ label: string; checkpoint: { hit: boolean; turns: number } } | null");
    const resumeBody = orch.slice(resumeFn, orch.indexOf('private findCoveringBranch(', resumeFn));
    // 宿主读数缝的候选过滤（paused+cancelled 两腿都要）——scoped 到
    // stoppedBranches 绑定块：全文件扫描会被 buildInsertionContext 里逐字
    // 相同的 standby 过滤串糊掉，砍腿的 mutant 照样全绿。
    const stoppedBind = src.indexOf('stoppedBranches: () => this.agentActivities');
    expect(stoppedBind).toBeGreaterThan(-1);
    const stoppedBody = src.slice(stoppedBind, src.indexOf('coveringCandidates:', stoppedBind));
    expect(stoppedBody.indexOf("item.status === 'paused' || item.status === 'cancelled'")).toBeGreaterThan(-1);
    expect(resumeBody.indexOf('this.deps.delegation.delegationArgs.get(matched.callId)')).toBeGreaterThan(-1);
    expect(resumeBody.indexOf('this.deps.delegation.queueResume(')).toBeGreaterThan(-1);
    // 消费端：委派收齐后的 THINK 边界用原始参数包成普通委派调用还引擎。
    const synth = src.indexOf('takeSyntheticToolCalls: async () =>');
    expect(synth).toBeGreaterThan(-1);
    const synthBody = src.slice(synth, synth + 3_500);
    expect(synthBody.indexOf('for (const resume of this.delegationControl.takeResumes())')).toBeGreaterThan(-1);
    expect(synthBody.indexOf('arguments: resume.args')).toBeGreaterThan(-1);
    // 兜底：没赶上 THINK 边界 → 收尾转成排队的新指令，话绝不丢；装配住
    // DelegationControlPlane（S2 第五刀），经 roundClose 的 resumeFallback
    // 依赖缝在折入核验同拍转排队。
    expect(src.indexOf('resumeFallback: () => this.delegationControl.settleResumesFallback()')).toBeGreaterThan(-1);
    expect(plane.indexOf('const fallback = this.deps.resumeFallback();')).toBeGreaterThan(-1);
    expect(plane.indexOf('if (fallback) this.queueTask(fallback);')).toBeGreaterThan(-1);
    // 分类器判据输入：暂停/已停的支作为可续跑候补喂给分类器（否则它看不见）。
    expect(src.indexOf('已暂停/已停的支（用户点名可让它们接着跑）')).toBeGreaterThan(-1);
  });

  it('records branch events into the turn ledger (第 2 期第四刀)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 一等分支事件落进本回合的分支账（turnTimings.branches），随 turn finally
    // 与 stats 一起入盘——事件、活动面板、账三个消费者同源。
    const activityCase = src.indexOf("case 'SubagentActivity': {");
    expect(activityCase).toBeGreaterThan(-1);
    const body = src.slice(activityCase, activityCase + 2_000);
    expect(body.indexOf("activity.kind === 'branch_aborted'")).toBeGreaterThan(-1);
    expect(body.indexOf("activity.kind === 'branch_resumed'")).toBeGreaterThan(-1);
    expect(body.indexOf("activity.kind === 'branch_retrying'")).toBeGreaterThan(-1);
    expect(body.indexOf('turnTiming.branches ??= [];')).toBeGreaterThan(-1);
    expect(body.indexOf('turnTiming.branches.push(')).toBeGreaterThan(-1);
  });

  it('background sessions never yank the shared scroll container', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 后台会话的自动续跑也走 send()：无守卫的 forceScrollToBottom 会把用户
    // 正在阅读的会话每 1.2 秒拽到底部。两处 fresh-turn 滚动都必须包在
    // viewActive 守卫里。
    const guarded = src.split('if (this.viewActive) {').length - 1;
    expect(guarded).toBeGreaterThanOrEqual(2);
    for (const anchor of ['linkifyPaths(userBubble);', 'synchronous full-transcript layout)']) {
      const site = src.indexOf(anchor);
      expect(site).toBeGreaterThan(-1);
      const seg = src.slice(site, site + 600);
      expect(seg.indexOf('if (this.viewActive) {')).toBeGreaterThan(-1);
      expect(seg.indexOf('forceScrollToBottom(')).toBeGreaterThan(seg.indexOf('if (this.viewActive) {'));
    }
  });

  it('keeps the activity rail above the composer via the ResizeObserver offset', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 2026-09-23 用户实测：右下角漂浮卡片堆到输入框头上。composer 高度是
    // 动态的（多行输入/附件），所以布局偏移必须由 #input-bar 的
    // ResizeObserver 实时写进 --agent-host-bottom，而不是写死的 CSS 长度。
    const fn = src.indexOf('function installAgentActivityHostLayout(');
    expect(fn).toBeGreaterThan(-1);
    const body = src.slice(fn, fn + 1_200);
    expect(body.indexOf("new ResizeObserver(sync).observe(inputBar)")).toBeGreaterThan(-1);
    expect(body.indexOf("host.style.setProperty('--agent-host-bottom'")).toBeGreaterThan(-1);
    // 挂载点接线：面板一挂上就装观察器（幂等，重复调用是空操作）。
    const mount = src.indexOf('mountAgentActivityPanel(): void');
    expect(src.slice(mount, mount + 300).indexOf('installAgentActivityHostLayout();')).toBeGreaterThan(-1);
  });

  it('no longer stalls the plan cursor on per-phase verification gates', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 逐阶段验证门禁（phaseVerifySeen / schedulePhaseBackstop）已被回合末的
    // 确定性交付验证取代：计划游标不再因缺少阶段内验证证据而卡死，机械检查
    // 统一在回合结束由 runDeliveryVerification 真实重跑。
    expect(src.indexOf('phaseVerifySeen')).toBe(-1);
    expect(src.indexOf('schedulePhaseBackstop')).toBe(-1);
    expect(src.indexOf('await runDeliveryVerification(')).toBeGreaterThan(-1);
  });

  it('finalizes a no-tool final turn at the last plan so the card catches up', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 收尾轮没有工具调用（工作在前一轮已全部完成，本轮只是总结或被用户确认）
    // 时，只要卡片已在最后一个计划上，就按完成收尾——否则卡片永远停在 N-1/N，
    // 和已经完成的任务不同步。
    const planFinished = src.indexOf('const planFinished = planCard && hasToolSuccess');
    expect(planFinished).toBeGreaterThan(-1);
    const summarized = src.indexOf('const planSummarized = planCard && !hasToolWork', planFinished);
    const lastPlan = src.indexOf('completionSnapshot.currentPlan === completionSnapshot.plan.steps.length', summarized);
    const turnText = src.indexOf('turnText.length > 0', summarized);
    const combined = src.indexOf('(planFinished || planSummarized) && planCard', summarized);
    expect(summarized).toBeGreaterThan(planFinished);
    expect(lastPlan).toBeGreaterThan(summarized);
    expect(turnText).toBeGreaterThan(lastPlan);
    expect(combined).toBeGreaterThan(turnText);
    // 完成后由唯一进度模型进入终态，卡片通过订阅刷新。
    const complete = src.indexOf("planProgress?.dispatch({ type: 'completed' });", combined);
    expect(complete).toBeGreaterThan(combined);
  });

  it('keeps the transcript plan card as the only live plan projection', () => {
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
    // planState——否则还原时卡片不会以 complete 状态重现。
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

  it('restores the chat plan card state from the saved session progress', () => {
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
    expect(src).toContain('const restoredPlanCard = createRestoredPlanCard(progress, () => chat.getTaskScript());');
    expect(src).not.toContain('bindPlanCardProgress(restoredPlanCard, progress);');
    expect(src).not.toContain('createRestoredPlanCard(block.snapshot)');
  });

  it('persists every reasoning phase for the matching assistant message', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    expect(src).toContain('thinkingPhases.filter(candidate => candidate.assistantIndex === currentAssistantIndex && candidate.text)');
    expect(src).toContain('thinkingPhases: phases.length > 0 ? phases : undefined');
  });

  it('keeps ChatController free of planOverview wiring', () => {
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
    expect(src).toContain('buildSystemPrompt(!!effectiveWorkspace, usingTemporaryWorkspace, config, promptTools, imageGen, conventions)');
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

  it('shows a waiting card during slow-model gaps between tool results and the next step', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // After a ToolResult finalizes, a debounced watchdog opens a "正在思考下一步…"
    // card so a slow model's silent re-read of the result never reads as stuck.
    const gapCard = src.indexOf('scheduleToolGapCard');
    expect(gapCard).toBeGreaterThan(-1);
    expect(src).toContain("setThinkingLabel(thinkingCard, '正在思考下一步…');");
    // The watchdog is debounced (back-to-back tool calls don't flash a card).
    expect(src).toContain('const TOOL_GAP_DEBOUNCE_MS = 600;');
    // ToolResult finalization arms it; the next reasoning/token/tool event
    // cancels it (endThinking / cancelToolGapCard) so it never lingers.
    expect(src).toContain('scheduleToolGapCard();');
    expect(src).toContain('cancelToolGapCard();');
    // A clean turn end cancels any armed watchdog (no ghost card after Completed).
    const endThinking = src.indexOf('const endThinking = () => {');
    expect(src.slice(endThinking, endThinking + 300)).toContain('cancelToolGapCard();');
  });

  it('keeps long silences legible: elapsed timer, retry surfacing, label reset', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const thinkingSrc = readSource(new URL('../thinkingCard.ts', import.meta.url));
    // Every live thinking card starts the elapsed-seconds timer on open, with
    // the slow-response hint budget adapted to the provider's first-token latency.
    expect(src).toContain('const openThinkingCard = ');
    expect(src).toContain('startThinkingTimer(card, {');
    expect(src).toContain('firstTokenHintTimeoutMs(config.provider,');
    // Abort paths stop the timer explicitly.
    expect(src).toContain('stopThinkingTimer(thinkingCard);');
    // Engine LLM retries are surfaced on the card instead of staying silent —
    // a retry re-streams the whole context and used to look exactly like a hang.
    expect(src).toContain("case 'FailurePolicyDecision': {");
    expect(src).toContain('模型请求未成功');
    expect(src).toContain('工具执行未成功');
    expect(src).toContain('验证未通过');
    // The silence-waiter/recovery label resets once real reasoning or answer
    // output arrives, and the
    // slow-response hint lingers 1s after visible output, then fades.
    expect(src).toContain('resetThinkingLabelForOutput(thinkingCard)');
    expect(thinkingSrc).toContain('export function resetThinkingLabelForOutput');
    // ReasoningDelta dismisses OUTSIDE the waiting-branch (plain first-token
    // waits must dismiss too), anchored at the first visible delta.
    expect(src).toContain('dismissThinkingHint(thinkingCard, HINT_LINGER_MS);');
    // Answer-token models schedule the linger BEFORE endThinking so a showing
    // hint survives finalize and completes its own fade.
    const tokenDelta = src.indexOf("case 'TokenDelta': {");
    expect(tokenDelta).toBeGreaterThan(-1);
    const linger = src.indexOf('dismissThinkingHint(thinkingCard, HINT_LINGER_MS);', tokenDelta);
    const endThinkingCall = src.indexOf('endThinking();', tokenDelta);
    expect(linger).toBeGreaterThan(-1);
    expect(linger).toBeLessThan(endThinkingCall);
  });
});

describe('subagent tool body renders the delegated output', () => {
  it('extracts SubagentResult.output instead of stringifying the object (bash_executor body fix)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const candidate = src.indexOf("const resultText = rawResult && typeof rawResult === 'object'");
    expect(candidate).toBeGreaterThan(-1);
    // The object path must pull .output for subagents (bash conclusion, review
    // verdict), not fall through to String(object) === "[object Object]".
    expect(src.slice(candidate, candidate + 700)).toContain("'summary' in rawResult");
    expect(src.slice(candidate, candidate + 700)).toContain("'output' in rawResult");
    // A SubagentResult with output: undefined must become "" (the empty-result
    // note in finalizeToolRow), never the object-stringify fallback.
    expect(src.slice(candidate, candidate + 700)).toContain("(rawResult as { output?: unknown }).output ?? ''");
  });

  it('line-caps subagent bodies like live execute_command output', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    const subagentBranch = src.indexOf('} else if (subagentNames.has(toolName)) {');
    expect(subagentBranch).toBeGreaterThan(-1);
    const slice = src.slice(subagentBranch, subagentBranch + 520);
    expect(slice).toContain('resultPreview = truncateResultLines(resultText);');
    // The generic 800-char slice stays for non-subagent tools only.
    expect(slice).toContain('resultText.slice(0, 800);');
  });
});

// A superseded turn (queued task / auto-continue round / session switch
// bumped this.generation while the old turn was mid-tool) exits the event
// loop via the generation-guard `break`, so its Interrupted branch never
// runs. The `finally` must therefore repeat the Interrupted branch's UI
// teardown — or the background transcript kept a forever-animating thinking
// card, tool rows stuck on "calling…", a blinking streaming caret and an
// assessment card pinned on 执行中 (all idempotent calls; normal paths are
// no-ops here).
describe('superseded-turn finally teardown', () => {
  const readSource = (url: URL): string => readFileSync(url, 'utf8');

  it('cleans turn-scoped UI up in the finally for generation-guard exits', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // chat.ts has an inner finally (pause-path cleanup at ~3553); the turn
    // teardown lives in doSend's LAST outer finally. The inner one (the
    // 2026-09-27 drain sweep wrap) sits INSIDE it — anchor on the teardown
    // body, not on lastIndexOf alone.
    const teardownAnchor = src.indexOf('this.finishLiveTurn(liveTurn);\n        releaseSupersededTurn();');
    expect(teardownAnchor).toBeGreaterThan(-1);
    const finallyIdx = src.lastIndexOf('} finally {', teardownAnchor);
    expect(finallyIdx).toBeGreaterThan(-1);
    // the finally also carries the turn-timing commit (first-token
    // observability) ahead of the teardown calls asserted below, and the
    // auto-continue block + drain-sweep finally after them.
    const finallyBlock = src.slice(finallyIdx, teardownAnchor + 4200);
    // Same teardown set the Interrupted branch runs, inside the finally:
    expect(finallyBlock).toContain('endThinking();');
    expect(finallyBlock).toContain('resolvePendingToolRows(toolCallRefresh, pendingRows, pendingByName);');
    expect(finallyBlock).toContain('cancelStreamingRender(seg.el);');
    expect(finallyBlock).toContain("seg.el.classList.remove('streaming');");
    // Assessment card force-cancel is scoped to the superseded path — a
    // normal turn's flow must not be rewritten by the finally.
    expect(finallyBlock).toContain('if (gen !== this.generation) assessmentFlow?.cancel(');
    // The drain schedule survives any teardown throw (2026-09-27 排队事故)。
    // 2026-09-29: a pause-led final also cancels the「继续」bar when the
    // user's own held insert is about to re-enter via the round-close dispatch —
    // a manual continue click there would be a lie.
    expect(finallyBlock).toContain('if (pausedThisTurn && this.roundClose.hasHeldInsert()) this.autoContinue.cancel();');
    expect(finallyBlock).toContain('this.roundClose.scheduleDispatch();');
  });
});

// First-token latency: every hidden pre-turn wait sits between the user's send
// and the first visible token. These bounds keep that chain from growing back —
// the hidden semantic route keeps its own full budget (it must decide, not be
// truncated), while the first MCP handshake was awaited serially right before
// the model call and now overlaps the preflight.
describe('first-token preflight budgets', () => {
  const src = readSource(new URL('../chat.ts', import.meta.url));

  it('starts the first MCP handshake before the preflight and only awaits the remainder', () => {
    // The warm-up must be wired right after the agent is built (before the
    // plan/probe preflight), and the later await must use the short budget.
    const warmup = src.indexOf('MCP warm-up: kick the transport handshake off HERE');
    const awaitSite = src.indexOf("// ── Deferred init: the MCP handshake was started right after the agent");
    expect(warmup).toBeGreaterThan(-1);
    expect(awaitSite).toBeGreaterThan(warmup);
    const warmupBlock = src.slice(warmup, warmup + 900);
    expect(warmupBlock).toContain('mcpConnectPromise = this.mcpClient.connectAll()');
    const awaitBlock = src.slice(awaitSite, awaitSite + 700);
    expect(awaitBlock).toContain('if (mcpConnectPromise) {');
    expect(awaitBlock).toContain('MCP_FIRST_TURN_BUDGET_MS');
    // The 1.5s serial wait is gone for good.
    expect(src).not.toContain("1_500,\n            'MCP initialization',");
  });

  it('caps the first-turn MCP resource wait and caches AGENTS.md reads', () => {
    expect(src).toContain('const MCP_RESOURCE_FIRST_TURN_BUDGET_MS = 800;');
    expect(src).toContain('collectResourceContext({ waitMs: MCP_RESOURCE_FIRST_TURN_BUDGET_MS })');
    // Three IPC reads for AGENTS.md used to run on every single turn.
    expect(src).toContain('let guiConventionsCache: { at: number; workspace: string; text: string } | null = null;');
    expect(src).toContain('const text = await readGuiConventions(ws);');
  });
});

// 「计划必须是当着用户想出来的」（2026-09-26 用户定调）：规则出卡退出主路径，
// 思考流式可见且不套提纲，失败必须安静（上一代 LLM 预分析就死在噪音上）。
describe('plan-by-thinking flow', () => {
  const src = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8');

  it('plans with a streaming model call before the plan card, not from rule steps', () => {
    // 出卡之前必须先有 planByThinking；思考完全没落地才允许规则兜底。
    // 2026-09-27 思考窗吸收：调用包在 planPreflightActive 的开/关窗里。
    const thinkingIdx = src.indexOf('thought = await this.planByThinking(chatEl, userText, userImages, needsDeliveryGate, removeThinkingCard);');
    expect(thinkingIdx).toBeGreaterThan(-1);
    const cardIdx = src.indexOf('showPlanCard(approvedPlan);');
    expect(cardIdx).toBeGreaterThan(thinkingIdx);
    // 模型计划优先；规则计划只活在「确认对话必须有一份具体方案」的兜底支里。
    expect(src).toContain('let planForReview: Plan | null = thought?.plan ?? null;');
    const fallbackIdx = src.indexOf('planForReview = analysis.plan ?? deriveFallbackPlan(userText);');
    expect(fallbackIdx).toBeGreaterThan(thinkingIdx);
    expect(src).toContain('} else if (thought?.narration && !needsInteractiveApproval) {');
  });

  it('thinking lands in the model context; both paths embed it into userPlan', () => {
    // 新会话首回合 hasHistory=false，引擎输入读不到 this.messages——思考必须
    // 原文嵌进 userPlan，「按上面那段思考开工」在首回合是指向空气的。
    // 2026-09-27 时序修正：思考押账（pendingPlanNarration），等本回合用户消息
    // 落账时插到它后面；直接 push 会让回放里思考抢在用户请求前面。
    expect(src).toContain('this.pendingPlanNarration = thought.narration;');
    expect(src).not.toContain("this.messages.push({ role: 'assistant', content: thought.narration })");
    expect(src).toContain('userPlan = planThinkingContext(thought.narration, { projectBuild: needsDeliveryGate });');
    expect(src).toContain("planThinkingContext(thought.narration, { projectBuild: needsDeliveryGate, hasPlanCard: true })");
    // 无卡路径跳过了 approvePlan：评估卡阶段必须同样落定，不能悬在半空。
    expect(src).toContain("assessmentFlow.setPhase('execute', '边界已确认，准备按小步策略执行…');");
  });

  it('stays quiet on failure: no failure bubble anywhere in the planning call', () => {
    const fnIdx = src.indexOf('private async planByThinking(');
    expect(fnIdx).toBeGreaterThan(-1);
    const endIdx = src.indexOf('private async answerMidrunQuestion', fnIdx);
    expect(endIdx).toBeGreaterThan(fnIdx);
    const fn = src.slice(fnIdx, endIdx);
    // 超时/网络错误静默落到底部判定——绝不复刻旧预分析的失败提示噪音。
    expect(fn).toContain('catch {');
    expect(fn).not.toContain('addStatusBubble');
    expect(fn).not.toContain('showError');
    expect(fn).toContain('PLAN_THINKING_TIMEOUT_MS');
    expect(fn).toContain('parsePlanJsonWithMeta(planText)');
    // 思考与中止路径都要收干净计时器与转发监听。
    expect(fn).toContain('clearTimeout(timer);');
    expect(fn).toContain("removeEventListener('abort', forwardAbort);");
  });

  it('the stall watchdog treats active streaming as alive (2026-09-27 欲言又止修复)', () => {
    // burst 间停顿不是安静：看门狗必须看「流活动保鲜戳」，否则在活跃流式的
    // 停顿里弹「正在思考下一步…」、下一个事件又收掉——卡片反复闪现闪没。
    expect(src).toContain('const GAP_STREAM_QUIET_MS = 4_000;');
    expect(src).toContain('if (Date.now() - this.lastStreamActivityAt < GAP_STREAM_QUIET_MS) return;');
    // 保鲜戳由两处流循环刷新：引擎事件循环 + 规划叙述块循环。
    expect(src).toContain('private lastStreamActivityAt = 0;');
    const refreshes = src.split('this.lastStreamActivityAt = Date.now();').length - 1;
    expect(refreshes).toBe(2);
    // 引擎事件循环的第一件事就是刷新（每个事件都算活着）。
    const loopIdx = src.indexOf('for await (const event of events) {');
    expect(loopIdx).toBeGreaterThan(-1);
    const refreshIdx = src.indexOf('this.lastStreamActivityAt = Date.now();', loopIdx);
    expect(refreshIdx).toBeGreaterThan(loopIdx);
    expect(src.slice(loopIdx, refreshIdx)).not.toContain('\n\n');
  });

  it('an interrupted Completed never merges the same payload twice (2026-09-27 HVC 复测修复)', () => {
    // 引擎的中断路径先 yield Interrupted、break 之后再补一个 interrupted=true
    // 的 Completed（同一份 messages）。GUI 两个分支都会 merge——第二遍在已被
    // 第一遍改过的转录上再并一次，userTC 进两份、回合回复被顶掉（复测存档
    // [system, 叙述, userTC, userTC] 的来源）。Completed 侧必须让位。
    const completedIdx = src.indexOf("case 'Completed': {");
    expect(completedIdx).toBeGreaterThan(-1);
    const mergeIdx = src.indexOf('finalMessages = mergeTranscriptWithTurn(this.messages, completionMessages, userText, this.takePendingPlanNarration());', completedIdx);
    expect(mergeIdx).toBeGreaterThan(completedIdx);
    const guard = src.slice(Math.max(0, mergeIdx - 400), mergeIdx);
    expect(guard).toContain('!interruptedMessages');
  });

  it('the idle transition sweeps the deferred dispatch on its own (2026-09-27 排队事故第三层)', () => {
    // 派发定时器曾只在 send() finally 末尾一处装上：收尾代码任何一步先抛，
    // 排队任务就永远没人派（队列卡挂着、活再没跑）。修后两道保险都在源里：
    // setStreaming(false) 的空闲扫除 + finally 包裹的 ownsTurn 派发。
    const streamingIdx = src.indexOf('private setStreaming(v: boolean) {');
    expect(streamingIdx).toBeGreaterThan(-1);
    const body = src.slice(streamingIdx, src.indexOf('\n  }', streamingIdx));
    expect(body).toContain('if (!v) this.roundClose.scheduleDispatch();');
    // finally 兜底：ownsTurn 派发包在 try/finally 里，收尾路再怎么断都装上。
    const finallyIdx = src.indexOf('this.finishLiveTurn(liveTurn);\n        releaseSupersededTurn();');
    expect(finallyIdx).toBeGreaterThan(-1);
    const guardIdx = src.indexOf('} finally {', finallyIdx);
    expect(guardIdx).toBeGreaterThan(finallyIdx);
    const sweep = src.slice(guardIdx, src.indexOf('\n      }', guardIdx));
    expect(sweep).toContain('if (ownsTurn) {');
    expect(sweep).toContain('if (pausedThisTurn && this.roundClose.hasHeldInsert()) this.autoContinue.cancel();');
    expect(sweep).toContain('this.roundClose.scheduleDispatch();');
  });

  it('preflight absorption: the window flag wraps planByThinking and merges before the abort check (2026-09-27 排队事故)', () => {
    // 思考窗吸收的三件套：开窗在 planByThinking 前、关窗在 finally（抛了也
    // 关）、并账在 aborted 检查前（暂停路径提交的也是合并后的文本）。
    // S2 第六刀：窗开关/暂存/吸收分支住 InterjectOrchestrator——宿主侧锁窄
    // API 的调用序，吸收判据（三闸）锁在 inputDecision 的纯函数上。
    const orch = readFileSync(new URL('../../coding-agent/interjectOrchestrator.ts', import.meta.url), 'utf8');
    const decider = readFileSync(new URL('../../coding-agent/inputDecision.ts', import.meta.url), 'utf8');
    const flagIdx = src.indexOf('this.interjectOrchestrator.openPreflightWindow();');
    expect(flagIdx).toBeGreaterThan(-1);
    const callIdx = src.indexOf('thought = await this.planByThinking(', flagIdx);
    expect(callIdx).toBeGreaterThan(flagIdx);
    const closeIdx = src.indexOf('this.interjectOrchestrator.closePreflightWindow();', callIdx);
    expect(closeIdx).toBeGreaterThan(callIdx);
    // 并账先于中止检查：keepOrDropUserBubble 提交合并文本。
    const mergeIdx = src.indexOf('userText = this.applyPreflightSupplements(userText, userImages);', closeIdx);
    expect(mergeIdx).toBeGreaterThan(closeIdx);
    const abortIdx = src.indexOf('if (this.abortController?.signal.aborted)', mergeIdx);
    expect(abortIdx).toBeGreaterThan(mergeIdx);
    // 吸收分支不吞取消/停支/续支：三闸齐备；四类话进窗即吸收——steer/
    // premise-change/goal-change 一律，task 仅凭 supplements_current
    // （2026-09-28 jev 案例：纠错话进不了窗，三个子 agent 按错前提派出）。
    const absorbIdx = orch.indexOf('this.pendingPreflightSupplements.push({ text, images });');
    expect(absorbIdx).toBeGreaterThan(-1);
    // 判据在纯函数（shouldAbsorbIntoThinkingWindow）；编排器把它接到窗开关上。
    const fnIdx = decider.indexOf('export function shouldAbsorbIntoThinkingWindow(');
    expect(fnIdx).toBeGreaterThan(-1);
    const absorbGuard = decider.slice(fnIdx, decider.indexOf('\n}', fnIdx));
    expect(absorbGuard).toContain("decision.kind === 'steer'");
    expect(absorbGuard).toContain("decision.kind === 'premise-change'");
    expect(absorbGuard).toContain("decision.kind === 'goal-change'");
    expect(absorbGuard).toContain("decision.kind === 'task' && decision.signals.supplementsCurrent === true");
    expect(absorbGuard).toContain("decision.signals.cancelsPart !== true");
    expect(absorbGuard).toContain("decision.signals.branchStop !== true");
    expect(absorbGuard).toContain("decision.signals.resumesBranch !== true");
    expect(orch.slice(orch.lastIndexOf('shouldAbsorbIntoThinkingWindow(decision', absorbIdx), absorbIdx)).toContain('this.planPreflightActive');
    // 纠错有自己的收执话术（推倒重想的理由不同：事实错了，不是加东西）。
    expect(orch).toContain('已按纠正重构思路，重新规划…');
    // 分类上下文带思考窗阶段：分类器得知道手头的活是"正在想"。
    expect(src).toContain('if (this.interjectOrchestrator.preflightWindowActive()) {');
  });

  it('吸收即推倒重想：重启请求掐流、思考重开、N 句 N 轮（2026-09-27 用户定调）', () => {
    // "诗句里一定要出现明月"必须在构图里，不是旧思考上后贴——吸收分支置
    // 重启请求 + 掐掉在飞的思考流；send() 的重启循环见暂存非空/哨兵就并账
    // 重开；用户主动停的优先级永远高于重启（回合信号断 = 不重启）。
    // S2 第六刀：置位/掐流面住 InterjectOrchestrator；宿主侧的重启循环经窄
    // API（wasPreflightRestarted/clearPreflightRestart/endPreflightThought）。
    const orch = readFileSync(new URL('../../coding-agent/interjectOrchestrator.ts', import.meta.url), 'utf8');
    const absorbIdx = orch.indexOf('this.preflightRestartRequested = true;');
    expect(absorbIdx).toBeGreaterThan(-1);
    const abortCallIdx = orch.indexOf('this.preflightAbort?.abort();', absorbIdx);
    expect(abortCallIdx).toBeGreaterThan(absorbIdx);
    // 吸收回执走系统腔（无 agent 拟人），不再输出固定拟人话术。
    expect(orch).toContain('已按纠正重构思路，重新规划…');
    expect(orch).toContain('已并入补充，重新规划…');
    // planByThinking 侧：流句柄挂上寄存器（beginPreflightThought）；每轮开局
    // 清掉上一轮的重启请求（残留会把新控制器的超时误认成重启）。
    const fnIdx = src.indexOf('private async planByThinking(');
    const acIdx = src.indexOf('this.interjectOrchestrator.beginPreflightThought(ac);', fnIdx);
    expect(acIdx).toBeGreaterThan(fnIdx);
    expect(orch.slice(orch.indexOf('beginPreflightThought('))).toContain('this.preflightRestartRequested = false;');
    // 循环内重启检查排在回合中止检查之后：用户的停永远赢过重启。
    const turnAbortIdx = src.indexOf('if (this.abortController?.signal.aborted) break;', acIdx);
    const restartIdx = src.indexOf('if (ac.signal.aborted && this.interjectOrchestrator.wasPreflightRestarted() && !this.abortController?.signal.aborted)', turnAbortIdx);
    expect(restartIdx).toBeGreaterThan(turnAbortIdx);
    // 推倒的思考整体作废：气泡收走、已想内容清空，restart 哨兵交回 send()。
    const discardIdx = src.indexOf('bubble?.remove();', restartIdx);
    expect(discardIdx).toBeGreaterThan(-1);
    expect(src.slice(restartIdx, discardIdx)).toContain('this.interjectOrchestrator.clearPreflightRestart();');
    expect(src).toContain('return { narration: \'\', plan: null, restarted: true };');
    // 句柄用完即摘：不再有悬挂的在飞把手。
    expect(src.slice(acIdx).indexOf('this.interjectOrchestrator.endPreflightThought();')).toBeGreaterThan(-1);
    // 重启循环：暂存非空或哨兵在场就并账重开一轮，窗跨整段循环不关。
    const loopIdx = src.indexOf('if ((this.interjectOrchestrator.pendingPreflightCount() > 0 || thought?.restarted) && thought !== null) {');
    expect(loopIdx).toBeGreaterThan(-1);
    expect(src.slice(loopIdx, src.indexOf('} finally {', loopIdx))).toContain('continue;');
    // 分类调用就是四参一条路：时机×内容的判断全在裁决器，协调器不再收
    // 任何窗口开关（2026-09-28 用户定调——决策不看关键词）。
    const decideIdx = orch.indexOf('this.deps.decider.decide(');
    expect(decideIdx).toBeGreaterThan(-1);
    const decideCall = orch.slice(decideIdx, orch.indexOf(');', decideIdx));
    expect(decideCall).not.toContain('inThoughtWindow');
    // 裁决走关暗推理的适配器（2026-09-28 实测）：bigmodel 上开着思考首字 8–28s、
    // 极端 90s，而生产的裁决预算只有 8s——不关的话判定整批落到字面安全网，
    // 「时机×内容」这一步就没了。与规划路径同款（planLlm）。档位选择是宿主
    // 读数缝（decideLlm）——判据锁在宿主绑定上。
    expect(src).toContain('decideLlm: () => this.judgeLlm ?? this.turnLlm ?? null');
    expect(src).toMatch(/this\.judgeLlm = createLLMAdapter\(config, \{ disableThinking: true \}\);/);
    // 裁决器看得见"此刻在思考"与思考最新说到哪：时机证据随上下文过河。
    expect(src).toContain("parts.push('（当前状态：模型正在思考这个任务的规划、还未开始执行——此刻纠正事实或补充约束会并进请求重新思考）');");
    expect(src).toContain('思考最新说到：');
  });

  it('every ack discard path settles the ledger — no ghost status rows in replays (2026-09-27 排队事故)', () => {
    // ack 行被直接 parentElement.remove() 后账本记录还在：快照把它拼回事件
    // 流，回放凭空多一句"收到——看一下这句话怎么安排…"（真实画图会话事件
    // 流第 0 条）。统一出口 discardAckRow = 销账 + 摘行；settleAck 之外的
    // 丢弃路必须全部走它。
    const helperIdx = src.indexOf('private discardAckRow(ack: HTMLElement | null): void {');
    expect(helperIdx).toBeGreaterThan(-1);
    // helper 自身那一处 remove 是实现本体；除此之外不允许再出现直接摘行。
    const withoutHelper = src.slice(0, helperIdx) + src.slice(src.indexOf('\n  }', helperIdx));
    expect(withoutHelper.includes('ack?.parentElement?.remove()')).toBe(false);
  });
});

// 委派记账的接线守卫（2026-10-07 审计取证）。
//
// T1 的 `delegations[]` 只在观测层知道「哪些工具名是角色」时才写，而那个判断由
// CodingAgent 构造函数从 `config.observability` 装上去。GUI 一直没传这个键，
// `config.observability?.setDelegationRolePredicate(...)` 于是整体静默 no-op——
// 真机 32 条 agent_run 记录里 delegations 出现 0 次，成本视图（T4）永远读空、
// 13.2 试用制没有结局可裁。丢这个键的代价是**零报错**：没有这条守卫，下次重构
// 配置字面量时它会再丢一次，而下一次同样要等真机数据才发现。
describe('delegation accounting wiring', () => {
  it('the CodingAgent config the GUI builds carries the observability singleton', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    expect(src).toContain("import { promptObservability } from '../shared/promptObservability'");
    // 边界用构造行与构造后紧邻的赋值行夹住：不数括号，也不依赖配置项的顺序。
    const start = src.indexOf('const codingAgent = new CodingAgent({');
    const end = src.indexOf('this.codingAgentRef = codingAgent;');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const wiring = src.slice(start, end);
    expect(wiring).toMatch(/^\s*observability: promptObservability,$/m);
    // 传的必须是那个全局单例（sink 挂在它身上），不是每轮新建的实例——
    // 后者会让记账离开 JSONL，磁盘上照样一条没有。
    expect(src.split('observability: promptObservability').length - 1).toBe(1);
  });
});
