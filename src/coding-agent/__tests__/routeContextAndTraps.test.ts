// 2026-10-14 — 路由的对话上下文 / 任务级矛盾 / 路由器自身矛盾的优先级。
//
// 三条都是上一轮实测出来的缺口：
//   ④ 「还是不行」「再加一个导出按钮」这类追问靠自身读不出意义，而被当成孤立句子
//      路由——一次失败的修复续问就是这么被承载成闲聊的。
//   ⑤ 「不要改任何文件，但把这个函数里的 bug 修掉」traps=0：既有正则要求同一
//      名词回指，抓不到任务级矛盾（两条各自都清楚，放一起才不可能）。
//   ⑥ 路由器会一边给 mode=plan 一边留 requiresPlan=false：「先给我一个方案」正是
//      如此，最后走成直接回答，一个计划都没有。优先级定在一处并记录不一致。
import { beforeEach, describe, expect, it } from 'bun:test';
import { Planner, inferSemanticRoute, routeHistoryMessages, type RouteContextTurn } from '../Planner';
import { decideTurnRoute, prefetchTurnRoute } from '../turnRoute';
import { compileRequestWorkflow } from '../../shared/requestWorkflow';
import type { LLMAdapter } from '../../shared/types';
import type { SemanticRouteDecision } from '../types';

/** An adapter that captures the request it was asked to route and answers with
 *  `verdict`. The capture is the point: "did the conversation reach the router,
 *  in order, before the request?" is a request-shape question, not prose. */
function capturingRouter(verdict: Partial<SemanticRouteDecision> | null): { llm: LLMAdapter; requests: unknown[] } {
  const requests: unknown[] = [];
  const llm = {
    complete: async () => ({ content: '' }),
    async *stream(request: unknown) {
      requests.push(request);
      if (!verdict) return;
      const json = JSON.stringify({
        requiresPlan: false,
        needsDeliveryGate: false,
        assessment: {
          riskLevel: 'low', reversibility: 'reversible', impact: '', recommendation: '',
          requiresProbe: false, requiresConfirmation: false,
        },
        ...verdict,
      });
      yield { type: 'content', content: json };
    },
  } as unknown as LLMAdapter;
  return { llm, requests };
}

const DEBUG_TURN: RouteContextTurn = {
  role: 'user',
  content: '登录页在我点登录后没有反应，帮我查一下为什么，然后修掉',
};
const FIXED_TURN: RouteContextTurn = {
  role: 'assistant',
  content: '修好了：app.js 绑定的 id 不存在，脚本加载即抛错。已改为监听 form 的 submit 并 preventDefault。',
};

describe('routeHistoryMessages', () => {
  it('puts the conversation before the request and never repeats the request', () => {
    // The caller's transcript already holds the message being routed; feeding it
    // twice would read as "the user said this twice".
    const built = routeHistoryMessages(
      [DEBUG_TURN, FIXED_TURN, { role: 'user', content: '还是不行' }],
      '还是不行',
    );
    expect(built.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(built[0].content).toContain('没有反应');
    expect(built[1].content).toContain('修好了');
  });

  it('keeps only the recent tail and truncates long turns', () => {
    const long: RouteContextTurn = { role: 'assistant', content: 'x'.repeat(5000) };
    const turns: RouteContextTurn[] = [
      { role: 'user', content: 'first' },
      long,
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'third' },
      { role: 'user', content: 'fourth' },
      { role: 'assistant', content: 'fifth' },
      { role: 'user', content: 'sixth' },
      { role: 'assistant', content: 'seventh' },
    ];
    const built = routeHistoryMessages(turns, 'now');
    expect(built.length).toBe(6);
    expect(built.at(-1)!.content).toBe('seventh');
    expect(built.every((m) => m.content.length <= 601)).toBe(true);
  });

  it('is empty for a first turn and drops blank turns', () => {
    expect(routeHistoryMessages(undefined, 'hello')).toEqual([]);
    expect(routeHistoryMessages([{ role: 'user', content: '   ' }], 'hello')).toEqual([]);
  });
});

describe('inferSemanticRoute with conversation context', () => {
  it('sends prior turns to the router in order, request last', async () => {
    const { llm, requests } = capturingRouter({ intent: 'debug', complexity: 'simple', mode: 'yolo' });
    const decision = await inferSemanticRoute(llm, '还是不行', undefined, undefined, 8_000, [
      DEBUG_TURN,
      FIXED_TURN,
    ]);
    expect(decision?.intent).toBe('debug');
    const request = requests[0] as Array<{ role: string; content: string }>;
    expect(request.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(request.at(-1)!.content).toBe('还是不行');
    expect(request[1].content).toContain('没有反应');
  });

  it('keeps the system prompt byte-identical with and without context', async () => {
    const withCtx = capturingRouter({ intent: 'debug', complexity: 'simple', mode: 'yolo' });
    const withoutCtx = capturingRouter({ intent: 'debug', complexity: 'simple', mode: 'yolo' });
    await inferSemanticRoute(withCtx.llm, '还是不行', undefined, undefined, 8_000, [DEBUG_TURN]);
    await inferSemanticRoute(withoutCtx.llm, '还是不行');
    const a = (withCtx.requests[0] as Array<{ role: string; content: string }>)[0];
    const b = (withoutCtx.requests[0] as Array<{ role: string; content: string }>)[0];
    expect(a.content).toBe(b.content);
  });

  it('reaches the router through decideTurnRoute (the wired path)', async () => {
    const { llm, requests } = capturingRouter({ intent: 'debug', complexity: 'simple', mode: 'yolo' });
    const decision = await decideTurnRoute(prefetchTurnRoute('还是不行'), llm, {
      hasTools: true,
      history: [DEBUG_TURN, FIXED_TURN],
    });
    expect(decision.route?.intent).toBe('debug');
    expect(decision.signals.routeHistoryTurns).toBe(2);
    expect((requests[0] as unknown[]).length).toBe(4);
  });
});

describe('task-level contradiction trap', () => {
  const planner = new Planner();

  it('flags "touch nothing, but fix this" as a contradiction to verify', () => {
    const traps = planner.detectTraps('不要改任何文件，但把这个函数里的 bug 修掉');
    expect(traps.map((t) => t.type)).toContain('self-contradiction');
  });

  it('does not flag ordinary division of labour between objects', () => {
    expect(planner.detectTraps('不要改配置文件，但把 README 里的版本号补上')).toEqual([]);
    expect(planner.detectTraps('把登录页改成支持记住我')).toEqual([]);
  });

  it('a trap keeps the turn off the chit-chat fast path', () => {
    // isPlainConversational requires traps.length === 0, so the flag alone is
    // enough to make the router run (belt to the work-frame veto's braces).
    const prefetch = prefetchTurnRoute('不要改任何文件，但把这个函数里的 bug 修掉');
    expect(prefetch.needsRouter).toBe(true);
  });
});

describe("router self-contradiction: mode 'plan' vs requiresPlan", () => {
  const PROMPT = '我想给这个项目加一个离线缓存层，先给我一个方案';
  /** A router verdict in the shape the real one produces (the parser rejects a
   *  missing assessment, so the fixture carries one). */
  const planMode = (complexity: 'simple' | 'complex'): SemanticRouteDecision => ({
    intent: 'question',
    complexity,
    mode: 'plan',
    requiresPlan: false,
    needsDeliveryGate: false,
    assessment: {
      intent: 'question',
      riskLevel: 'low',
      reversibility: 'reversible',
      impact: '',
      recommendation: '',
      requiresProbe: false,
      requiresConfirmation: false,
    },
  });

  it('a complex plan-mode request gets plan review', () => {
    const workflow = compileRequestWorkflow(PROMPT, {
      hasTools: true,
      semanticRoute: planMode('complex'),
    });
    expect(workflow.requiresPlanReview).toBe(true);
    expect(workflow.stage).toBe('plan');
  });

  it('a simple plan-mode request still does not (no over-planning)', () => {
    const workflow = compileRequestWorkflow('这个页面不太行，你看看', {
      hasTools: true,
      semanticRoute: planMode('simple'),
    });
    expect(workflow.requiresPlanReview).toBe(false);
  });

  it('records the inconsistency instead of silently picking a side', async () => {
    const { llm } = capturingRouter(planMode('complex'));
    const decision = await decideTurnRoute(prefetchTurnRoute(PROMPT), llm, { hasTools: true });
    expect(decision.route?.requiresPlan).toBe(false);
    expect(decision.signals.routerPlanFlagInconsistent).toBe(true);
    // The rule that acted on it is in the compiled workflow, not in the log's
    // prose — the two are asserted together so they cannot drift apart.
    expect(decision.workflow.requiresPlanReview).toBe(true);
  });
});
