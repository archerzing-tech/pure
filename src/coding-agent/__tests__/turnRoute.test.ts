// src/coding-agent/__tests__/turnRoute.ts 的测试。
// 预判层退役后（2026-11-06）：没有 LLM 路由了，回合 workflow 由机械事实
// + 形态判据 + 词表安全闸编译。这些测试钉住四件事——prefetch 只带调度
// 事实；shape 只判形态不判意图；编译结果可从机械输入复现；记录下的决定
// 可以回放为证据。

import { beforeEach, describe, expect, it } from 'bun:test';
import { compileTurnRoute, prefetchTurnRoute, recordScheduledInput, turnShape } from '../turnRoute';
import {
  clearInputDecisionLog,
  formatInputDecisionLog,
  getInputDecisionLog,
  parseInputDecisionLog,
  replayInputDecision,
} from '../inputDecision';

/** The prompt from the field report that the keyword floor once read as a
 *  plain question (so the turn answered a question nobody asked). Kept
 *  verbatim: under the mechanical compiler it must still NOT be read as a
 *  question — the host holds no opinion on what a turn is. */
const WORK_REQUEST = '把 src/ui/scrollPin.ts 里的自动滚动改成按块触发，改用 IntersectionObserver。';

beforeEach(() => {
  clearInputDecisionLog();
});

describe('prefetchTurnRoute (stage 1)', () => {
  it('has NO synchronous opinion about what the turn is', () => {
    for (const text of ['好的', '今天几号，星期几，天气如何', '帮我把这个项目重构成插件架构，分阶段来', WORK_REQUEST]) {
      const prefetch = prefetchTurnRoute(text);
      expect(prefetch.signals.rule).toBe('TURN_SHAPE');
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

describe('turnShape (shape facts, not verdicts)', () => {
  it('reads a fenced code block as the strongest work signal', () => {
    const shape = turnShape('这段代码有 bug：\n```ts\nconst x = 1;\n```\n帮我看看');
    expect(shape.codeShaped).toBe(true);
    expect(shape.shortChat).toBe(false);
  });

  it('reads long-form text as a real brief', () => {
    const shape = turnShape('请帮我把这个项目重构成插件架构。'.repeat(13));
    expect(shape.longForm).toBe(true);
    expect(shape.shortChat).toBe(false);
  });

  it('reads short code-free URL-free text as chit-chat shape', () => {
    expect(turnShape('你好').shortChat).toBe(true);
    expect(turnShape('谢谢').shortChat).toBe(true);
    expect(turnShape('今天天气怎么样').shortChat).toBe(true);
  });

  it('never reads a URL-bearing, code-bearing or path-bearing short text as chit-chat', () => {
    expect(turnShape('看看 https://example.com 这个页面').shortChat).toBe(false);
    expect(turnShape('```json\n{}')).toMatchObject({ codeShaped: true, shortChat: false });
    // 47 字的真工作指令（2026-11-06 全量测试抓的缺口）：短句能装下工作，
    // 路径形态是机械可辨的信号——寒暄误判主档只慢一两秒，方向保守。
    expect(turnShape('把 src/ui/scrollPin.ts 里的自动滚动改成按块触发，改用 IntersectionObserver。').shortChat).toBe(false);
  });
});

describe('compileTurnRoute (mechanical workflow)', () => {
  it('proceeds on every turn without claiming what it is — including hello', () => {
    for (const text of ['你好', '谢谢', WORK_REQUEST]) {
      const decision = compileTurnRoute(prefetchTurnRoute(text), { hasTools: true });
      expect(decision.action).toBe('proceed');
      expect(decision.workflow.analysis).toBeDefined();
    }
  });

  it('never fires an LLM call — the compiler is synchronous and free', () => {
    const started = performance.now();
    for (const text of ['你好', WORK_REQUEST, '帮我把这个项目重构成插件架构，分阶段来']) {
      compileTurnRoute(prefetchTurnRoute(text), { hasTools: true });
    }
    // Three full compilations in well under one frame: no await, no model.
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('walks the plan pipeline for code-shaped and long-form turns', () => {
    const codeTurn = compileTurnRoute(prefetchTurnRoute('修这个：\n```ts\nconst a: number = "x";\n```'), { hasTools: true });
    expect(codeTurn.workflow.requiresPlanReview).toBe(true);
    expect(codeTurn.stage).toBe('plan');
    expect(codeTurn.signals.codeShaped).toBe(true);

    const longTurn = compileTurnRoute(
      prefetchTurnRoute('请帮我把这个项目重构成插件架构。'.repeat(13)),
      { hasTools: true },
    );
    expect(longTurn.workflow.requiresPlanReview).toBe(true);
    expect(longTurn.signals.longForm).toBe(true);
  });

  it('keeps short chit-chat on the direct stage', () => {
    const decision = compileTurnRoute(prefetchTurnRoute('你好'), { hasTools: true });
    expect(decision.stage).toBe('direct');
    expect(decision.workflow.requiresPlanReview).toBe(false);
  });

  it('keeps a continuing plan on its approved route', () => {
    const decision = compileTurnRoute(prefetchTurnRoute('继续'), {
      hasTools: true,
      continuingPlan: true,
    });
    expect(decision.signals.continuing).toBe(true);
    expect(decision.action).toBe('proceed');
    expect(decision.workflow.requiresPlanReview).toBe(true);
  });

  it('raises the confirm stage only from the word-list safety gate', () => {
    // assessIntent 只在命令级毁灭操作上抬 requiresConfirmation——这是安全闸
    // 不是意图分类，规则只会抬高安全要求。
    const destructive = compileTurnRoute(prefetchTurnRoute('drop table users'), { hasTools: true });
    expect(destructive.stage).toBe('confirm');
    expect(destructive.workflow.analysis.intent.requiresConfirmation).toBe(true);

    const ordinary = compileTurnRoute(prefetchTurnRoute('删掉 src/tmp.ts 这个文件'), { hasTools: true });
    expect(ordinary.stage).not.toBe('confirm');
  });

  it('keeps the delivery gate on forced build mode and word-list builds', () => {
    const forced = compileTurnRoute(prefetchTurnRoute('开始吧'), {
      hasTools: true,
      forcedMode: 'build',
    });
    expect(forced.workflow.needsDeliveryGate).toBe(true);
    expect(forced.workflow.userContext.buildProtocol).toBeDefined();
  });

  it('reports a named moment as a fact without claiming to hold the turn', () => {
    const now = new Date('2026-09-23T09:00:00').getTime();
    const prefetch = prefetchTurnRoute('下午三点再跑一遍完整测试', null, now);
    const decision = compileTurnRoute(prefetch, { hasTools: true }, now);
    expect(decision.defer).toBe(true);
    expect(decision.timing.mode).toBe('at');
    // NOT `queue`: holding is the host's decision, and a producer that claimed
    // it while the caller ran the turn would make the log lie.
    expect(decision.action).not.toBe('queue');
  });

  it('logs the host\'s hold as its own decision in the same log', () => {
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

  it('records every decision in a log that replays to the same action', () => {
    compileTurnRoute(prefetchTurnRoute('谢谢'), { hasTools: false });
    compileTurnRoute(prefetchTurnRoute(WORK_REQUEST), { hasTools: true });
    const log = getInputDecisionLog();
    expect(log.length).toBe(2);
    expect(log.map((entry) => entry.source)).toEqual(['turn-route', 'turn-route']);

    // The log round-trips through text — that is what makes it evidence a test
    // can replay mechanically.
    const replayed = parseInputDecisionLog(formatInputDecisionLog(log));
    expect(replayed).toHaveLength(2);
    for (const entry of replayed) {
      expect(replayInputDecision(entry).action).toBe('proceed');
    }
  });
});
