// src/ui/__tests__/chat.test.ts

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseToolCallBuffer, shouldCopyAssistantBubbleTarget, copyAssistantBubbleText, bindUserBubbleSelectAll, pickHistoryMessages, mergeTranscriptWithTurn, BASE_SYSTEM_PROMPT, shouldCancelForEscape, shouldEnterPlanReview } from '../chat';
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

  it('no longer runs the LLM real-time pre-analysis (removed entirely)', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 实时分析从未稳定成功（10/10 项目全部超时/空输出），只会拖慢启动并把
    // “实时分析未完成，已回退到通用步骤”的噪音留给用户。整条链路必须删干净。
    expect(src.indexOf('generateTaskAnalysis')).toBe(-1);
    expect(src.indexOf('TASK_ANALYSIS_PROMPT')).toBe(-1);
    expect(src.indexOf('<intent_assessment>')).toBe(-1);
    expect(src.indexOf('<request_review>')).toBe(-1);
    expect(src.indexOf('mergeIntentAssessments')).toBe(-1);
    expect(src.indexOf('实时分析未完成')).toBe(-1);
    expect(src.indexOf('已回退到通用步骤')).toBe(-1);
    // 计划直接来自本地规则分析。
    expect(src).toContain('let planForReview: Plan = analysis.plan ?? {');
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
    const gate = src.indexOf("const needsInteractiveApproval = riskReview || forcedMode === 'plan' || forcedMode === 'build';");
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
    const update = src.indexOf('updatePlanCard(planCard, plan, refining, planProgress);', show);
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

  it('renders the heuristic plan card directly with no LLM pre-analysis round-trip', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 计划直接来自本地规则分析（Planner）：探针完成后立即渲染计划卡，
    // 不再有 LLM 分析等待与“回退到通用步骤”的兜底分支。
    const probe = src.indexOf('await discoverWorkspace(');
    const planRender = src.indexOf('showPlanCard(planForReview);');
    expect(probe).toBeGreaterThan(-1);
    expect(planRender).toBeGreaterThan(probe);
    expect(src).toMatch(/createPlanCard\(plan, refining, planProgress\)/);
    expect(src.indexOf('已回退到通用步骤')).toBe(-1);
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
    const backstop = src.indexOf('await runDeliveryVerification(codingAgent.toolRegistry, workspaceProfile, turnSignal)');
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
    expect(src).toContain("setThinkingLabel(thinkingCard, '正在思考…')");
    expect(src.indexOf('正在分析你的请求…')).toBe(-1);
  });

  it('passes explicit approval into the plan prompt so execution starts immediately', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 本轮无需等待“开工”消息（确认卡已批准 / forced-yolo 直接放行）时，模型第一轮
    // 必须立即执行——否则模型第一轮不调用工具，引擎空转完成，计划卡还停在第一步
    // 就突然进入交付验证、评估卡跳到“验证结果”。
    expect(src).toContain('formatPlanForPrompt(planForReview, needsDeliveryGate, !pauseAfterPlanning)');
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
    expect(src).toContain('createPlanCard(plan, refining, planProgress);');
    expect(src).toContain('updatePlanCard(planCard, plan, refining, planProgress);');
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
    expect(src).toContain('已完成”播报…');
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
    expect(seg).toContain('lastTodosDone || (needsDeliveryGate && qualityPassed === true)');
  });

  it('keeps the plan context when the delivery gate fails', () => {
    const src = readSource(new URL('../chat.ts', import.meta.url));
    // 交付门禁未通过时不 dispatch completed：activeComplexPlan 保留，下一轮
    // “修复/继续”走原计划续跑而不是丢失计划卡后重新分析。
    const branch = src.indexOf('} else if (planCompletionCandidate');
    expect(branch).toBeGreaterThan(-1);
    const seg = src.slice(branch, branch + 1600);
    const blocked = seg.indexOf('const deliveryBlocked = needsDeliveryGate && !qualityPassed;');
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
    expect(src).toContain('const restoredPlanCard = createRestoredPlanCard(progress);');
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
});
