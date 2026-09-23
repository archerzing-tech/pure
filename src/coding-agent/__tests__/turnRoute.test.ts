// src/coding-agent/__tests__/turnRoute.test.ts
// The turn-level producer: five derivations that used to have no arbitration
// now emit ONE InputDecision. These tests pin the two things that matter —
// that it routes the way the separate call sites did, and that the decision it
// records can be replayed as evidence.

import { beforeEach, describe, expect, it } from 'bun:test';
import { decideTurnRoute, prefetchTurnRoute, recordScheduledInput } from '../turnRoute';
import { isPlainConversational } from '../Planner';
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

/** The prompt from the field report that the keyword floor read as a plain
 *  question, so the router never ran and the turn answered a question nobody
 *  asked. Kept verbatim: it is the regression fixture. */
const FLOOR_BLIND_SPOT = '把 src/ui/scrollPin.ts 里的自动滚动改成按块触发，改用 IntersectionObserver。';

beforeEach(() => {
  clearInputDecisionLog();
});

describe('prefetchTurnRoute (stage 1)', () => {
  it('recognises small talk without spending a router call or a workspace', () => {
    const prefetch = prefetchTurnRoute('好的');
    expect(prefetch.kind).toBe('pleasantry');
    expect(prefetch.needsRouter).toBe(false);
    expect(prefetch.workspaceFree).toBe(true);
    expect(prefetch.signals.rule).toBe('PLEASANTRY_BYPASS');
  });

  it('skips the router for the turns the synchronous floor already settles', () => {
    const prefetch = prefetchTurnRoute('今天几号，星期几，天气如何');
    expect(prefetch.kind).toBe('conversational');
    expect(prefetch.needsRouter).toBe(false);
    // Still NOT workspace-free: the answer may want to read the code, and the
    // old bypass flag was only ever about small talk.
    expect(prefetch.workspaceFree).toBe(false);
  });

  it('asks the router for anything the floor cannot settle', () => {
    expect(prefetchTurnRoute('帮我把这个项目重构成插件架构，分阶段来').needsRouter).toBe(true);
  });

  it('never lets the chit-chat shortcut swallow an edit request', () => {
    // Both halves are required: an edit verb AND something identifiable to
    // edit. A question about the code must keep its fast path.
    expect(prefetchTurnRoute('为什么 src/ui/scrollPin.ts 里要这样写？').signals.editFrameVeto).toBeUndefined();
    expect(prefetchTurnRoute('把 src/ui/scrollPin.ts 里的自动滚动改成按块触发。').signals.editFrameVeto).toBe(true);
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
  it('does not ask the router for a small-talk turn', async () => {
    let called = 0;
    const llm = { complete: async () => ({ content: '' }), stream: () => { called++; return (async function* () {})(); } } as unknown as LLMAdapter;
    const decision = await decideTurnRoute(prefetchTurnRoute('谢谢'), llm, { hasTools: true });
    expect(called).toBe(0);
    expect(decision.kind).toBe('pleasantry');
    expect(decision.deterministic).toBe(true);
    expect(decision.action).toBe('answer');
    expect(decision.route).toBeNull();
  });

  it('lets the router outrank the keyword floor when the two disagree', async () => {
    // The floor's blind spot, asserted so the test keeps documenting WHY the
    // router must still run here.
    expect(isPlainConversational(FLOOR_BLIND_SPOT)).toBe(true);
    expect(isPlainConversational('帮我把这个项目重构成插件架构，分阶段来')).toBe(false);
    const prefetch = prefetchTurnRoute(FLOOR_BLIND_SPOT);
    // The edit-frame veto is what stops the floor's "chat" from skipping the
    // router — without it this prompt is routed as chit-chat.
    expect(prefetch.floorChat).toBe(true);
    expect(prefetch.signals.editFrameVeto).toBe(true);
    expect(prefetch.needsRouter).toBe(true);

    const decision = await decideTurnRoute(prefetch, fakeRouter(WORK), { hasTools: true });
    expect(decision.kind).toBe('router-decided');
    expect(decision.action).toBe('proceed');
    expect(decision.deterministic).toBe(false);
    // The floor and the router read it differently — recorded, not hidden.
    expect(decision.agreement).toBe(false);
    expect(decision.signals.routerIntent).toBe('modify');
    expect(decision.signals.floor).toBe('chat');
  });

  it('flags the opposite disagreement: the careful floor called work, the router says chat', async () => {
    const decision = await decideTurnRoute(
      prefetchTurnRoute('帮我把这个项目重构成插件架构，分阶段来'),
      fakeRouter(CHAT),
      { hasTools: true },
    );
    expect(decision.signals.floor).toBe('work');
    expect(decision.agreement).toBe(false);
    expect(decision.action).toBe('answer');
  });

  it('falls back to the Planner floor when the router produces nothing', async () => {
    const decision = await decideTurnRoute(
      prefetchTurnRoute('帮我把这个项目重构成插件架构，分阶段来'),
      fakeRouter(null),
      { hasTools: true },
    );
    expect(decision.route).toBeNull();
    expect(decision.kind).toBe('router-skipped');
    expect(decision.deterministic).toBe(true);
    expect(decision.signals.routerIntent).toBeUndefined();
    // The floor still has to carry the turn.
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
    await decideTurnRoute(prefetchTurnRoute(FLOOR_BLIND_SPOT), fakeRouter(WORK), { hasTools: true });
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
