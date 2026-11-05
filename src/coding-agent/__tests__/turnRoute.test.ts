// src/coding-agent/__tests__/turnRoute.ts 的测试。
// 框架改革一期后：floor 不存在了，prefetch 只带 timing 事实，「这轮是什么」
// 唯一由语义路由裁决；路由缺席时按 work 保守推进。这些测试钉住三件事——
// prefetch 不再对轮次形态有任何同步意见；路由缺席绝不冒充「答案」；
// 记录下的决定可以回放为证据。

import { beforeEach, describe, expect, it } from 'bun:test';
import { decideTurnRoute, prefetchTurnRoute, recordScheduledInput, startTurnRoute } from '../turnRoute';
import {
  INPUT_CLARIFY_CONFIDENCE,
  clearInputDecisionLog,
  formatInputDecisionLog,
  getInputDecisionLog,
  parseInputDecisionLog,
  replayInputDecision,
} from '../inputDecision';
import type { SemanticRouteDecision } from '../types';
import type { LLMAdapter } from '../../shared/types';

/** A router that answers with a fixed verdict, across two chunks the way a
 *  provider would. `null` = the router never produces usable JSON. */
function fakeRouter(route: Partial<SemanticRouteDecision> | null): LLMAdapter {
  return {
    complete: async () => ({ content: '' }),
    async *stream() {
      if (!route) {
        yield { type: 'content', content: 'I think the user wants something, hard to say.' };
        return;
      }
      const json = JSON.stringify({
        requiresPlan: false,
        needsDeliveryGate: false,
        assessment: {
          riskLevel: 'low',
          reversibility: 'reversible',
          impact: '',
          recommendation: '',
          requiresProbe: false,
          requiresConfirmation: false,
        },
        ...route,
      });
      yield { type: 'content', content: json.slice(0, 20) };
      yield { type: 'content', content: json.slice(20) };
    },
  } as unknown as LLMAdapter;
}

const WORK = { intent: 'modify', complexity: 'simple', mode: 'yolo' } satisfies Partial<SemanticRouteDecision>;
const CHAT = { intent: 'question', complexity: 'simple', mode: 'yolo' } satisfies Partial<SemanticRouteDecision>;

/** The prompt from the field report that the keyword floor once read as a
 *  plain question (so the router never ran and the turn answered a question
 *  nobody asked). The floor is gone; kept verbatim as a routing regression
 *  fixture — the router MUST be asked about it, and its verdict must win. */
const WORK_REQUEST = '把 src/ui/scrollPin.ts 里的自动滚动改成按块触发，改用 IntersectionObserver。';

beforeEach(() => {
  clearInputDecisionLog();
});

describe('prefetchTurnRoute (stage 1)', () => {
  it('has NO synchronous opinion about what the turn is — everything goes to the router', () => {
    for (const text of ['好的', '今天几号，星期几，天气如何', '帮我把这个项目重构成插件架构，分阶段来', WORK_REQUEST]) {
      const prefetch = prefetchTurnRoute(text);
      expect(prefetch.signals.rule).toBe('SEMANTIC_ROUTE');
      // Timing facts are read; turn shape is NOT claimed here.
      expect(prefetch.defer).toBe(false);
    }
  });

  it('reads a named moment off the input and holds it', () => {
    const now = new Date('2026-09-23T09:00:00').getTime();
    const prefetch = prefetchTurnRoute('下午三点再跑一遍完整测试', null, now);
    expect(prefetch.defer).toBe(true);
    expect(prefetch.timing.mode).toBe('at');
    expect(new Date(prefetch.timing.at!).getHours()).toBe(15);
  });

  it('never treats a time inside the request as a schedule', () => {
    const now = new Date('2026-09-23T09:00:00').getTime();
    expect(prefetchTurnRoute('把 15:30 这个时间戳改成本地时区', null, now).defer).toBe(false);
    expect(prefetchTurnRoute('15:30 之后的日志全都删掉', null, now).defer).toBe(false);
    expect(prefetchTurnRoute('为什么下午三点再跑就报错？', null, now).defer).toBe(false);
  });
});

describe('decideTurnRoute (stage 2)', () => {
  it('routes a plain chat turn through the router and answers on its verdict', async () => {
    let called = 0;
    const llm = { complete: async () => ({ content: '' }), stream: () => { called++; return (async function* () { yield { type: 'content', content: '' }; })(); } } as unknown as LLMAdapter;
    const decision = await decideTurnRoute(prefetchTurnRoute('谢谢'), fakeRouter(CHAT), { hasTools: true });
    expect(called).toBe(0); // no preRoute → decideTurnRoute fires its own call via fakeRouter
    expect(decision.kind).toBe('router-decided');
    expect(decision.deterministic).toBe(false);
    expect(decision.action).toBe('answer');
    expect(decision.route?.intent).toBe('question');
  });

  it('lets the router decide a work-shaped edit request', async () => {
    const decision = await decideTurnRoute(prefetchTurnRoute(WORK_REQUEST), fakeRouter(WORK), { hasTools: true });
    expect(decision.kind).toBe('router-decided');
    expect(decision.action).toBe('proceed');
    expect(decision.deterministic).toBe(false);
    expect(decision.signals.routerIntent).toBe('modify');
  });

  it('carries the turn as work when the router produces nothing', async () => {
    const decision = await decideTurnRoute(
      prefetchTurnRoute('帮我把这个项目重构成插件架构，分阶段来'),
      fakeRouter(null),
      { hasTools: true },
    );
    expect(decision.route).toBeNull();
    expect(decision.kind).toBe('router-skipped');
    expect(decision.deterministic).toBe(true);
    expect(decision.signals.routerIntent).toBeUndefined();
    // 中性承载（2026-11-05 判例）：没有裁决不冒充答案，也不按工作塑形——
    // 宿主对「这轮是什么」不表达意见（信号字段名留 history，回放兼容）。
    expect(decision.signals.workShapedFallback).toBe(true);
    expect(decision.action).toBe('proceed');
    expect(decision.workflow.analysis).toBeDefined();
  });

  it('keeps a continuing plan on its already-approved route', async () => {
    let called = 0;
    const llm = { complete: async () => ({ content: '' }), stream: () => { called++; return (async function* () {})(); } } as unknown as LLMAdapter;
    const decision = await decideTurnRoute(prefetchTurnRoute('继续'), llm, {
      hasTools: true,
      continuingPlan: true,
    });
    expect(called).toBe(0);
    expect(decision.route).toBeNull();
    expect(decision.signals.continuing).toBe(true);
    expect(decision.action).toBe('proceed');
    // 续跑轮不算 workShapedFallback：它有已批准的路线，不是路由缺席。
    expect(decision.signals.workShapedFallback).toBeUndefined();
  });

  it('reports a named moment as a fact without claiming to hold the turn', async () => {
    const now = new Date('2026-09-23T09:00:00').getTime();
    const prefetch = prefetchTurnRoute('下午三点再跑一遍完整测试', null, now);
    const decision = await decideTurnRoute(prefetch, null, { hasTools: true }, undefined, now);
    expect(decision.defer).toBe(true);
    expect(decision.timing.mode).toBe('at');
    // NOT `queue`: holding is the host's decision, and a producer that claimed
    // it while the caller ran the turn would make the log lie.
    expect(decision.action).not.toBe('queue');
  });

  it('logs the host\'s hold as its own decision in the same log', async () => {
    const now = new Date('2026-09-23T09:00:00').getTime();
    const prefetch = prefetchTurnRoute('下午三点再跑一遍完整测试', null, now);
    const held = recordScheduledInput(prefetch, prefetch.timing.at!, now);
    expect(held.source).toBe('host-schedule');
    expect(held.action).toBe('queue');
    expect(held.scope).toEqual(['timing']);
    expect(held.signals.dueAt).toBe(prefetch.timing.at);

    const replayed = parseInputDecisionLog(formatInputDecisionLog(getInputDecisionLog()));
    expect(replayed).toHaveLength(1);
    // `queue` is not a destructive action, so the gate leaves it alone and the
    // replay lands on the same destination.
    expect(replayInputDecision(replayed[0]).action).toBe('queue');
    expect(replayInputDecision(replayed[0]).timing.at).toBe(prefetch.timing.at);
  });

  it('reports router doubt without overriding the action', async () => {
    const decision = await decideTurnRoute(
      prefetchTurnRoute('帮我把这个项目重构成插件架构，分阶段来'),
      fakeRouter({ ...WORK, confidence: 0.2 }),
      { hasTools: true },
    );
    expect(decision.confidence).toBeLessThan(INPUT_CLARIFY_CONFIDENCE);
    expect(decision.advisoryClarify).toBe(true);
    expect(decision.signals.advisoryClarify).toBe(true);
    // Deliberate: stopping a turn the user just sent costs more than the
    // misroute the question would have caught. The flag is the record.
    expect(decision.action).toBe('proceed');
  });

  it('records every decision in a log that replays to the same action', async () => {
    await decideTurnRoute(prefetchTurnRoute('谢谢'), null, { hasTools: false });
    await decideTurnRoute(prefetchTurnRoute(WORK_REQUEST), fakeRouter(WORK), { hasTools: true });
    const log = getInputDecisionLog();
    expect(log.length).toBe(2);
    expect(log.map((entry) => entry.source)).toEqual(['turn-route', 'turn-route']);

    // The log round-trips through text — that is what makes it evidence a test
    // can carry, rather than prose about what the code does.
    const replayed = parseInputDecisionLog(formatInputDecisionLog(log));
    expect(replayed.length).toBe(2);
    for (const entry of replayed) {
      expect(replayInputDecision(entry).action).toBe(entry.action);
      expect(replayInputDecision(entry).timing.mode).toBe(entry.timing.mode);
    }
  });

  it('stays out of the log when the caller only probes', async () => {
    await decideTurnRoute(prefetchTurnRoute('谢谢'), null, { hasTools: false, log: false });
    expect(getInputDecisionLog()).toHaveLength(0);
  });
});

// ── work-shaped fallback（floor 退役后的保守读）────────────────────────────
// 每一轮都会到路由；路由没给裁决（无适配器 / 超时 / JSON 不可用）时，这轮按
// 工作推进（先读后动），绝不当闲聊打发。field shape（2026-09）：同批请求句
// 曾被 keyword floor 读成 chat——那类失败从结构上不再可能，这里钉的是新不变量。
const WORK_SHAPED = [
  '登录页在我点登录后没有反应，帮我查一下为什么，然后修掉',
  '给这个登录页加上「记住我」和退出登录，并且补上测试',
  '我想给这个项目加一个离线缓存层，先给我一个方案',
  '再加一个导出按钮',
  '还是不行',
  '你之前不是已经装了 ffmpeg 了吗，用它做',
  '把 README 里那行版本号改成 3.3.3',
  '这个页面不太行，你看看',
  '为什么线上会偶发 502，日志我贴在下面了',
];

describe('work-shaped fallback when the router answers nothing', () => {
  const DEBUG_REQUEST = '登录页在我点登录后没有反应，帮我查一下为什么，然后修掉';

  it('carries the turn neutrally instead of defaulting it to chat or work', async () => {
    const decision = await decideTurnRoute(prefetchTurnRoute(DEBUG_REQUEST), fakeRouter(null), { hasTools: true });
    expect(decision.kind).toBe('router-skipped');
    expect(decision.route).toBeNull();
    expect(decision.signals.workShapedFallback).toBe(true);
    // 2026-11-05 判例反转：缺席不再强制「先读后动」探针——那是宿主对「这轮
    // 是什么」的隐形意见，hello 被它答成「这个交付目标没有可改的东西」。
    // 路由缺席 = 宿主无意见：不探工作区、不注入词表猜测的意图提示。
    expect(decision.action).toBe('proceed');
    expect(decision.workflow.stage).not.toBe('probe');
    expect(decision.workflow.needsProbe).toBe(false);
    // It does not invent a plan or a risk level out of a keyword frame.
    expect(decision.workflow.requiresPlanReview).toBe(false);
    expect(decision.workflow.analysis.intent.riskLevel).toBe('low');
  });

  it('still reports work when there is no workspace to probe', async () => {
    const decision = await decideTurnRoute(prefetchTurnRoute('再加一个导出按钮'), fakeRouter(null), { hasTools: false });
    expect(decision.workflow.needsProbe).toBe(false);
    expect(decision.workflow.stage).toBe('direct');
    // ...but it is still not an "answer": nothing settled this turn's shape.
    expect(decision.action).toBe('proceed');
  });

  it('every work-shaped phrasing reaches the router and none is pre-judged', async () => {
    for (const text of WORK_SHAPED) {
      const prefetch = prefetchTurnRoute(text);
      expect(`${text} → ${prefetch.signals.rule}`).toBe(`${text} → SEMANTIC_ROUTE`);
      // 路由缺席时全部落 work（不冒充答案）——逐句钉死。
      const decision = await decideTurnRoute(prefetch, fakeRouter(null), { hasTools: false });
      expect(decision.action).toBe('proceed');
    }
  });
});

// ── 第 6 期：路由提前（startTurnRoute / preRoute）──────────────────────────
// 路由这一跳原来压在引擎装配之后的临界路径上干等；宿主改为在回合开头就把它
// 发出去，与记忆落库、运行时探针并行。这里钉住两件事：该跑的回合确实只跑一次，
// 不该跑的回合一次都不跑——「提前」不能变成「多发」。
describe('startTurnRoute / preRoute（路由提前与前置并行）', () => {
  function countingRouter(route: Partial<SemanticRouteDecision> | null): { llm: LLMAdapter; calls: () => number } {
    let calls = 0;
    const inner = fakeRouter(route) as unknown as { complete: unknown; stream: (...a: unknown[]) => unknown };
    const llm = {
      complete: inner.complete,
      stream: (...args: unknown[]) => {
        calls++;
        return inner.stream(...args);
      },
    } as unknown as LLMAdapter;
    return { llm, calls: () => calls };
  }

  it('不为不需要路由的回合预启动（续计划 / 没有适配器）', () => {
    const { llm } = countingRouter(WORK);
    // 续计划：保留已批准的路线，重路由会把「继续」读成新计划。
    expect(startTurnRoute(prefetchTurnRoute('继续'), llm, { continuing: true })).toBeNull();
    // 没有可用适配器（CLI / 探针路径）。
    expect(startTurnRoute(prefetchTurnRoute(WORK_REQUEST), null, { continuing: false })).toBeNull();
  });

  it('宿主预启动的这一次调用被唯一产出者复用，不再发第二次', async () => {
    const { llm, calls } = countingRouter(WORK);
    const prefetch = prefetchTurnRoute(WORK_REQUEST);
    const routeFetch = startTurnRoute(prefetch, llm, { continuing: false });
    expect(routeFetch).not.toBeNull();

    const decision = await decideTurnRoute(prefetch, llm, { hasTools: true, preRoute: routeFetch });
    // 全程只有一次路由往返：预启动的 promise 被 decideTurnRoute 直接 await，
    // 裁决的含义仍由它唯一产出。
    expect(calls()).toBe(1);
    expect(decision.kind).toBe('router-decided');
    expect(decision.route?.intent).toBe('modify');
    expect(decision.action).toBe('proceed');
    // 与不预启动的同一输入逐字结果一致，证明「提前」只搬了时机。
    const baseline = await decideTurnRoute(prefetchTurnRoute(WORK_REQUEST), fakeRouter(WORK), { hasTools: true });
    expect(decision.action).toBe(baseline.action);
    expect(decision.reason).toBe(baseline.reason);
    expect(decision.workflow.stage).toBe(baseline.workflow.stage);
  });

  it('宿主没预启动时 decideTurnRoute 照旧自己发（CLI / 探针路径不受影响）', async () => {
    const { llm, calls } = countingRouter(WORK);
    const decision = await decideTurnRoute(prefetchTurnRoute(WORK_REQUEST), llm, { hasTools: true });
    expect(calls()).toBe(1);
    expect(decision.kind).toBe('router-decided');
  });
});
