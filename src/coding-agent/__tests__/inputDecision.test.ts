import { beforeEach, describe, expect, it } from 'bun:test';
import {
  INPUT_CLARIFY_CONFIDENCE,
  INPUT_DEFAULT_CONFIDENCE,
  INPUT_DECISION_LOG_LIMIT,
  applyConfidenceGate,
  clampConfidence,
  clearInputDecisionLog,
  describeInsertionScene,
  describeTiming,
  formatInputDecision,
  formatInputDecisionLog,
  getInputDecisionLog,
  isDestructiveAction,
  needsClarification,
  detectScheduledInput,
  parseInputDecisionLog,
  parseInputTiming,
  recordInputDecision,
  replayInputDecision,
  type InputDecision,
} from '../inputDecision';

function decision(overrides: Partial<InputDecision> = {}): InputDecision {
  return {
    source: 'mid-run-insert',
    kind: 'premise-change',
    action: 'replan',
    confidence: 0.9,
    timing: { mode: 'now' },
    scope: ['plan'],
    shouldAbort: true,
    reason: 'test',
    signals: {},
    ...overrides,
  };
}

describe('InputDecision confidence gate', () => {
  it('clamps whatever a provider returns and falls back to the documented default', () => {
    expect(clampConfidence(0.42)).toBe(0.42);
    expect(clampConfidence('0.8')).toBe(0.8);
    expect(clampConfidence(1.7)).toBe(1);
    expect(clampConfidence(-3)).toBe(0);
    expect(clampConfidence(undefined)).toBe(INPUT_DEFAULT_CONFIDENCE);
    expect(clampConfidence('high')).toBe(INPUT_DEFAULT_CONFIDENCE);
  });

  it('turns a doubtful verdict into a question and clears the abort flag', () => {
    const gated = applyConfidenceGate(decision({ confidence: 0.4 }));
    expect(gated.action).toBe('clarify');
    expect(needsClarification(gated)).toBe(true);
    // Asking must never tear the running work down first — the whole point is
    // that the answer arrives BEFORE anything is cut.
    expect(gated.shouldAbort).toBe(false);
    expect(gated.signals.gatedFrom).toBe('replan');
    expect(gated.confidence).toBe(0.4);
    // The doubtful reading survives so the UI can name it in the question.
    expect(gated.kind).toBe('premise-change');
    expect(gated.reason).toBe('test');
  });

  it('leaves a confident verdict alone, exactly at the threshold', () => {
    const kept = applyConfidenceGate(decision({ confidence: INPUT_CLARIFY_CONFIDENCE }));
    expect(kept.action).toBe('replan');
    expect(kept.shouldAbort).toBe(true);
  });

  it('is idempotent — a gated decision is not gated twice', () => {
    const once = applyConfidenceGate(decision({ confidence: 0.1 }));
    const twice = applyConfidenceGate(once);
    expect(twice).toEqual(once);
  });

  it('knows which actions tear down running work', () => {
    expect(isDestructiveAction('replan')).toBe(true);
    expect(isDestructiveAction('stop')).toBe(true);
    expect(isDestructiveAction('queue')).toBe(false);
    expect(isDestructiveAction('clarify')).toBe(false);
  });
});

describe('InputDecision timing', () => {
  // +08:00 local: 2026-09-23 11:00.
  const now = new Date(2026, 8, 23, 11, 0, 0).getTime();

  it('reads an explicit clock from the classifier as "at"', () => {
    const timing = parseInputTiming('15:30', '等会儿再跑一遍测试', now);
    expect(timing.mode).toBe('at');
    expect(timing.at).toBe(new Date(2026, 8, 23, 15, 30, 0).getTime());
    expect(timing.text).toBe('15:30');
  });

  it('rolls a past clock to the next day instead of firing immediately', () => {
    const timing = parseInputTiming('09:00', '明天早上跑', now);
    const target = new Date(timing.at!);
    expect(target.getTime()).toBeGreaterThan(now);
    expect(target.getHours()).toBe(9);
  });

  it('understands Chinese clock phrasing and periods', () => {
    expect(new Date(parseInputTiming('下午三点', '下午三点再跑', now).at!).getHours()).toBe(15);
    expect(new Date(parseInputTiming('晚上 9 点', '', now).at!).getHours()).toBe(21);
    expect(new Date(parseInputTiming('上午 9 点', '', now).at!).getHours()).toBe(9);
    expect(new Date(parseInputTiming('9点30', '', now).at!).getMinutes()).toBe(30);
  });

  it('turns relative phrases into absolute times', () => {
    expect(parseInputTiming('', '20 分钟后提醒我', now).at).toBe(now + 20 * 60_000);
    expect(parseInputTiming('两小时后', '', now).at).toBe(now + 2 * 60 * 60_000);
    // 半小时 / 半小时后 — "半" is a duration, not a digit.
    expect(parseInputTiming('', '半小时后提醒我', now).at).toBe(now + 30 * 60_000);
  });

  it('honours an explicit now/after reading', () => {
    expect(parseInputTiming('now', '马上，先停下', now).mode).toBe('now');
    expect(parseInputTiming('after', '这个跑完再说', now).mode).toBe('after-current');
  });

  it('holds (never invents a time) when a clock is content, not a schedule', () => {
    // "把 15:30 这个时间戳改成 UTC" is WORK ABOUT a time, not work AT a time.
    const timing = parseInputTiming(undefined, '把 15:30 这个时间戳改成 UTC 格式', now);
    expect(timing.mode).toBe('after-current');
    expect(timing.at).toBeUndefined();
  });

  it('does not guess a time from a bare 明天', () => {
    const timing = parseInputTiming(undefined, '明天把方案发我', now);
    expect(timing.mode).toBe('after-current');
    expect(timing.text).toBe('明天');
  });

  it('describes a timing the way a user would say it', () => {
    expect(describeTiming({ mode: 'now' })).toBe('立即');
    expect(describeTiming({ mode: 'after-current' })).toBe('当前任务之后');
    expect(describeTiming({ mode: 'at', at: now, text: '下午三点' })).toBe('下午三点');
    expect(describeTiming({ mode: 'at', at: new Date(2026, 8, 23, 15, 30).getTime() })).toBe('15:30');
  });
});

// Whether ONE input names the moment it should run at. Stricter than
// parseInputTiming by design: this one decides whether the user's message runs
// now or is held, so a time that is merely the OBJECT of the request must never
// read as a schedule.
describe('detectScheduledInput', () => {
  const now = new Date(2026, 8, 23, 9, 0, 0).getTime();

  it('recognises a named moment in a deferral frame', () => {
    const at3pm = detectScheduledInput('下午三点再跑一遍完整测试', now);
    expect(at3pm?.mode).toBe('at');
    expect(new Date(at3pm!.at!).getHours()).toBe(15);

    const in10 = detectScheduledInput('再过 10 分钟再跑一遍测试', now);
    expect(in10?.at).toBe(now + 10 * 60_000);

    const halfHour = detectScheduledInput('半小时后帮我跑一遍测试', now);
    expect(halfHour?.at).toBe(now + 30 * 60_000);

    const tomorrow = detectScheduledInput('等到明天早上九点', now);
    expect(new Date(tomorrow!.at!).getDate()).toBe(24);
    expect(new Date(tomorrow!.at!).getHours()).toBe(9);
  });

  it('keeps the user\'s own words for the time', () => {
    expect(detectScheduledInput('下午三点再跑一遍', now)?.text).toContain('下午三点');
  });

  it('refuses a time that is the object of the request, not its moment', () => {
    // A bare clock inside an edit is CONTENT: the user is changing a timestamp.
    expect(detectScheduledInput('把 15:30 这个时间戳改成 UTC 格式', now)).toBeNull();
    // …and a range marker is not a deferral either.
    expect(detectScheduledInput('15:30 之后的日志全都删掉', now)).toBeNull();
    // A question about a schedule is not a schedule.
    expect(detectScheduledInput('为什么下午三点再跑就报错？', now)).toBeNull();
    // Day-granularity talk is not a schedulable moment.
    expect(detectScheduledInput('明天再说吧', now)).toBeNull();
    expect(detectScheduledInput('帮我做个下午茶的落地页', now)).toBeNull();
  });

  it('never resolves a moment in the past', () => {
    const timing = detectScheduledInput('早上八点再跑一遍', now);
    expect(timing!.at).toBeGreaterThan(now);
  });
});

describe('InputDecision log', () => {
  beforeEach(() => clearInputDecisionLog());

  it('场景随日志一起导出与读回——诊断区与回放都要看得见', () => {
    // 「判错了」只有配上「在什么场景下判的」才可行动（同一句换场景能从错到
    // 对）。导出/粘贴/回放这一整条路都得带着它。
    recordInputDecision(
      { ...decision(), inputContext: '用户当前诉求：调研三个平台\n并行委派：共 3 个，在飞 3 个' },
      1000,
    );
    const [entry] = parseInputDecisionLog(formatInputDecisionLog(getInputDecisionLog()));
    expect(entry.inputContext).toContain('在飞 3 个');
    expect(replayInputDecision(entry).inputContext).toContain('在飞 3 个');
  });

  it('records and replays a decision onto the same action', () => {
    const confident = decision({ kind: 'task', action: 'queue', confidence: 1, shouldAbort: false, timing: { mode: 'after-current', at: undefined } });
    recordInputDecision(confident, 1000);
    const roundTripped = parseInputDecisionLog(formatInputDecisionLog(getInputDecisionLog()));
    expect(roundTripped).toHaveLength(1);
    expect(roundTripped[0].ts).toBe(1000);
    expect(replayInputDecision(roundTripped[0])).toEqual(confident);
  });

  it('a replayed entry that was recorded ungated still lands on clarify', () => {
    // A producer that skipped the gate (the bug shape this module prevents)
    // must not replay as destructive: the log is re-judged, not trusted.
    recordInputDecision(decision({ confidence: 0.2, action: 'replan', shouldAbort: true }), 1000);
    const [entry] = parseInputDecisionLog(formatInputDecisionLog(getInputDecisionLog()));
    const replayed = replayInputDecision(entry);
    expect(replayed.action).toBe('clarify');
    expect(replayed.shouldAbort).toBe(false);
  });

  it('keeps the log bounded and readable', () => {
    for (let i = 0; i < INPUT_DECISION_LOG_LIMIT + 25; i++) {
      recordInputDecision(decision({ kind: `k${i}` }), i);
    }
    const log = getInputDecisionLog();
    expect(log).toHaveLength(INPUT_DECISION_LOG_LIMIT);
    expect(log[0].kind).toBe('k25'); // oldest dropped, newest kept
    expect(formatInputDecision(log[log.length - 1])).toContain('mid-run-insert:k');
  });

  it('survives a corrupt line in a replayed log', () => {
    const good = formatInputDecisionLog([{ ...decision(), ts: 1 }]);
    const parsed = parseInputDecisionLog(`${good}\n{not json\n{"kind":"task"}`);
    expect(parsed).toHaveLength(1);
  });
});

describe('describeInsertionScene — 场景徽章（显示用，不参与判定）', () => {
  it('从上下文措辞读出思考中 / 在飞 N / 执行中', () => {
    expect(describeInsertionScene(
      '用户当前诉求：写一首五言绝句\n（当前状态：模型正在思考这个任务的规划、还未开始执行）',
    )).toEqual({ key: 'thinking' });
    expect(describeInsertionScene(
      '用户当前诉求：调研三个平台\n并行委派：共 3 个，在飞 2 个',
    )).toEqual({ key: 'inflight', count: 2 });
    expect(describeInsertionScene('用户当前诉求：调研三个平台')).toEqual({ key: 'executing' });
  });

  it('"在飞 0 个"当成执行中，而不是一个自相矛盾的徽章', () => {
    expect(describeInsertionScene('并行委派：共 3 个，在飞 0 个')).toEqual({ key: 'executing' });
  });

  it('没记下场景就是 unrecorded，不许冒充"执行中"', () => {
    // 排期插话（host-schedule）没经过裁决器，压根没有场景可显示。归进
    // executing 等于给一次没发生过的观察编一个结论——诊断区存在的意义恰好是
    // "判错了要能看到在什么场景下判的"，编出来的场景会把这条线索污染掉。
    expect(describeInsertionScene(undefined)).toEqual({ key: 'unrecorded' });
    expect(describeInsertionScene('   ')).toEqual({ key: 'unrecorded' });
  });

  it('思考期压过在飞数——正在想的时候那才是真正的场景', () => {
    expect(describeInsertionScene(
      '并行委派：共 3 个，在飞 3 个\n思考最新说到：先定体裁',
    )).toEqual({ key: 'thinking' });
  });
});
