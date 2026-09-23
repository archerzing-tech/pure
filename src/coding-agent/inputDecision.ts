// src/coding-agent/inputDecision.ts
// ONE vocabulary for "what do we do with this user input?".
//
// The route decision used to be re-derived in six places — the synchronous
// Planner verdict, `shouldBypassSemanticRoute` / `isPlainConversational`, the
// hidden semantic route, `compileRequestWorkflow`, the mid-run insertion
// classifier and the plan-continuation heuristics — each with its own shapes and
// no arbitration between them. Two failure modes came out of that, both
// observed in the field: a modify request that the rule layer read as a plain
// question (so the router never ran and the turn was treated as chit-chat), and
// a scope addition classified as `steer` whose promise could not be cashed (the
// words were silently dropped).
//
// This module does not take over the decisions. It gives them a common SHAPE
// (`InputDecision`), a common GATE (confidence below the threshold asks instead
// of guessing) and a common LOG (a replayable trace of what was decided and
// why), so the existing producers can be converged onto it one at a time and so
// a regression test can replay real decisions instead of asserting on prose.

/** Where the decision was made. Three producers share this shape and this log:
 *  the turn-level producer, the mid-run insert classifier, and the host's
 *  hold/queue decision for an input that named its own run time. */
export type InputSource = 'turn-route' | 'mid-run-insert' | 'host-schedule';

/**
 * What the input asks us to DO. The six producers speak different vocabularies
 * (route intents, insertion kinds); this is the join they all map onto.
 *  - proceed: carry on, the input is compatible with the frame that is running
 *  - apply:   fold the input into the running work as a constraint/detail
 *  - answer:  answer the input without disturbing the running work
 *  - queue:   hold it and run it as its own turn, deterministically later
 *  - replan:  the goal or a premise changed — stop, re-derive, start over
 *  - stop:    the user asked for the running work to end, nothing to re-plan
 *  - clarify: we are not sure — ask the user before acting
 *  - ignore:  nothing to act on (chatter)
 */
export type InputAction = 'proceed' | 'apply' | 'answer' | 'queue' | 'replan' | 'stop' | 'clarify' | 'ignore';

/** True for the actions that tear down (or redirect) work already in flight. */
export function isDestructiveAction(action: InputAction): boolean {
  return action === 'replan' || action === 'stop';
}

/**
 * What the input touches. Cheap for the producers to fill in, and the only
 * thing an impact assessment can be built on later (a `replan` that names
 * 'completed-steps' is a different, more expensive animal than one that names
 * 'constraints').
 */
export type InputScope =
  | 'goal'
  | 'plan'
  | 'completed-steps'
  | 'constraints'
  | 'output-format'
  | 'resources'
  | 'timing'
  | 'none';

/**
 * WHEN the input should run.
 *  - now:            handle it in this turn
 *  - after-current:  hold it; it runs as its own turn once the current one ends
 *  - at:             run it at an absolute time (the user said "下午三点再跑")
 * `text` keeps the user's own phrasing of the time so the UI can echo it back
 * instead of showing a timestamp they never said.
 */
export interface InputTiming {
  mode: 'now' | 'after-current' | 'at';
  /** Absolute epoch ms — set iff mode === 'at'. */
  at?: number;
  /** The user's own words for the time, when they named one. */
  text?: string;
}

export interface InputDecision {
  source: InputSource;
  /** Producer-specific label (route intent, insertion kind, ...) kept verbatim
   *  so the log stays readable and a producer can still switch on it. */
  kind: string;
  action: InputAction;
  /**
   * Confidence in the ACTION, not in the label: 1.0 means "this is the right
   * thing to do with this input", which is why the no-classifier fallback
   * (queue it — the one destination that can never lose the words) reports full
   * confidence even though no label was produced.
   */
  confidence: number;
  timing: InputTiming;
  scope: InputScope[];
  /** True → the running turn must end so this input can re-enter as a fresh
   *  send. Never true on a `clarify` decision: asking must not abort work. */
  shouldAbort: boolean;
  reason: string;
  /** Why the decision looks like this — rule name, model verdict, fallback flag.
   *  Free-form and small; it is what makes a replayed log diagnosable. */
  signals: Record<string, string | number | boolean | undefined>;
}

/** Below this, the action is downgraded to `clarify`. */
export const INPUT_CLARIFY_CONFIDENCE = 0.6;

/**
 * Confidence assumed when a classifier answers with a kind but no number.
 * Above the gate ON PURPOSE: the gate exists for a model that REPORTED doubt,
 * not for a model that ignored the field. Defaulting to low would make every
 * provider that drops `confidence` start asking questions about obvious input —
 * a worse regression than the one being fixed. The decision is flagged
 * (`signals.confidenceDefaulted`), so a log filled with that flag is the
 * evidence needed to revisit this number.
 */
export const INPUT_DEFAULT_CONFIDENCE = 0.7;

export function clampConfidence(value: unknown, fallback = INPUT_DEFAULT_CONFIDENCE): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/**
 * The confidence gate. A low-confidence decision becomes `clarify`: the user is
 * asked which reading was meant instead of the agent gambling — and because
 * `clarify` never aborts, nothing is torn down while the question is open.
 * The original judgement is preserved in `signals` so the prompt can name it
 * ("看起来是要改方向，但我不确定") instead of asking a contentless question.
 */
export function applyConfidenceGate(
  decision: InputDecision,
  threshold = INPUT_CLARIFY_CONFIDENCE,
): InputDecision {
  if (decision.action === 'clarify' || decision.confidence >= threshold) return decision;
  return {
    ...decision,
    action: 'clarify',
    shouldAbort: false,
    signals: {
      ...decision.signals,
      gatedFrom: decision.action,
      gateThreshold: threshold,
    },
  };
}

export function needsClarification(decision: InputDecision): boolean {
  return decision.action === 'clarify';
}

// ── Timing ────────────────────────────────────────────────────────────────
// The classifier answers `when` with a loose string; the user's own text is the
// fallback source. Parsing here (not in the prompt) keeps the clock arithmetic
// testable and provider-independent.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A cue that the message is naming a MOMENT, not carrying a time as content. */
const TIMING_CUE = /(?:之后|之後|以前|之前|等到|再过|再等|然后|随后|时候|待会|稍后|晚点|明天|明日|后天|上午|中午|下午|傍晚|晚上|凌晨|早上|分钟|小时|点(?:\s*[0-9一两二三]|半)|later|after|tomorrow|in \d+\s*(?:min|hour))/i;

/** "15:30" / "15：30" (24h) → {h, m}; null when malformed or out of range. */
export function parseClock(text: string): { h: number; m: number } | null {
  const hit = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(text);
  if (!hit) return null;
  const h = Number(hit[1]);
  const m = Number(hit[2]);
  if (h > 23 || m > 59) return null;
  return { h, m };
}

/** "下午三点" / "晚上 9 点" / "9点30" → {h, m}; null when absent/malformed. */
export function parseChineseClock(text: string): { h: number; m: number } | null {
  const hit = /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*([0-9一两二三四五六七八九十]{1,3})\s*[点時时]\s*(半|[0-9]{1,2}|[一二三四五六七八九十]{1,3}分?)?/.exec(text);
  if (!hit) return null;
  const digits = hit[2];
  let h: number;
  if (/^[0-9]+$/.test(digits)) {
    h = Number(digits);
  } else {
    if (digits === '十') h = 10;
    else if (digits.length === 2 && digits.startsWith('十')) h = 10 + chineseDigit(digits[1]);
    else if (digits.length === 2 && digits.endsWith('十')) h = chineseDigit(digits[0]) * 10;
    else h = chineseDigit(digits);
  }
  let m = 0;
  const minuteText = hit[3];
  if (minuteText === '半') m = 30;
  else if (minuteText) {
    const bare = minuteText.replace(/分$/, '');
    m = /^[0-9]+$/.test(bare) ? Number(bare) : chineseDigit(bare);
  }
  const period = hit[1];
  if (period === '下午' || period === '傍晚' || period === '晚上') {
    if (h < 12) h += 12;
  } else if (period === '中午') {
    if (h < 12) h += 12;
  } else if ((period === '凌晨' || period === '早上' || period === '上午') && h === 12) {
    h = 0;
  }
  if (!Number.isFinite(h) || h > 23 || m > 59) return null;
  return { h, m };
}

const CHINESE_DIGITS: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function chineseDigit(text: string): number {
  if (text === '十') return 10;
  const digits = [...text];
  if (digits.length === 1) return CHINESE_DIGITS[digits[0]] ?? NaN;
  // 十X / X十 / X十Y
  const [first, second] = digits;
  if (first === '十') return 10 + (CHINESE_DIGITS[second] ?? NaN);
  const tens = CHINESE_DIGITS[first];
  if (second === '十') return tens * 10;
  if (second === undefined) return tens;
  return NaN;
}

/**
 * Resolve a timing out of (classifier `when` string, user's own text).
 *   "now" / "立刻"                  → now
 *   "after" / "当前任务后"           → after-current
 *   "10 分钟后" / "两小时后"          → at(now + N)
 *   "15:30" / "下午三点" / "明天9点"  → at(the next occurrence)
 * Anything unrecognised stays `after-current`: holding the input is the only
 * destination that never drops it, and the user can always correct the timing.
 */
export function parseInputTiming(when: string | undefined, text: string, now = Date.now()): InputTiming {
  // The classifier's `when` is authoritative. The user's own text only counts
  // when it ALSO carries a timing cue: a clock inside a message is usually part
  // of the content being fixed ("把 15:30 这个时间戳改成 UTC"), and deferring that
  // would be a different bug than the one this fixes.
  const source = when?.trim() ? when : TIMING_CUE.test(text) ? text : '';
  const haystack = source;
  const inMinutes = /(\d+)\s*(?:分钟|分鐘|min(?:ute)?s?)\s*(?:后|後|之后|之後|later)/i.exec(haystack)
    ?? /(?:再过|過|再等)\s*(\d+)\s*(?:分钟|分鐘|min)/i.exec(haystack);
  if (inMinutes) {
    return { mode: 'at', at: now + Math.max(1, Number(inMinutes[1])) * MINUTE, text: inMinutes[0].trim() };
  }
  const inHours = /(半|\d+|[一两二三四五六七八九十]+)\s*(?:个?\s*)?(?:小时|小時|hours?|hrs?)\s*(?:后|後|之后|之後|later)?/i.exec(haystack);
  if (inHours) {
    const raw = inHours[1];
    const hours = raw === '半' ? 0.5 : /^\d+$/.test(raw) ? Number(raw) : chineseDigit(raw);
    if (Number.isFinite(hours) && hours > 0) {
      return { mode: 'at', at: now + hours * 60 * MINUTE, text: inHours[0].trim() };
    }
  }
  const clock = parseClock(haystack) ?? parseChineseClock(haystack);
  const dayOffset = /(后天|後天|明天|明日|tomorrow)/i.test(haystack)
    ? (/后天|後天/.test(haystack) ? 2 : 1)
    : 0;
  if (clock) {
    const target = new Date(now);
    target.setHours(clock.h, clock.m, 0, 0);
    let at = target.getTime();
    if (dayOffset > 0) at += dayOffset * DAY;
    else if (at <= now) at += DAY;
    return { mode: 'at', at, text: (clockText(source) || `${clock.h}:${String(clock.m).padStart(2, '0')}`) };
  }
  if (dayOffset > 0) {
    // "明天" without a clock: same wall-clock time next day is a guess the user
    // never made — hold it instead of inventing a time.
    return { mode: 'after-current', text: dayOffset === 2 ? '后天' : '明天' };
  }
  if (/^(now|立即|马上|立刻|现在就|即刻)\b|立刻|马上|现在就|即刻/i.test(haystack.trim())) {
    return { mode: 'now' };
  }
  return { mode: 'after-current' };
}

function clockText(source: string): string {
  const hit = /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*[0-9一两二三四五六七八九十]{1,3}\s*[点時时]\s*(?:半|[0-9]{1,2}|[一二三四五六七八九十]{1,3}分?)?/.exec(source);
  return hit?.[0]?.trim() ?? '';
}

// ── Input-level scheduling ────────────────────────────────────────────────
// Whether ONE input names the moment it should run at. This is stricter than
// parseInputTiming on purpose: that one resolves the timing of an input the
// system has ALREADY decided to hold (the classifier saw the whole message and
// the destination is a queue either way, so a loose read only mislabels WHERE
// it waits). Here the answer decides whether the user's message runs now or is
// held until later — misreading a request as "later" is far more expensive than
// missing a schedule, so a bare time is NOT enough: it has to sit inside a
// deferral frame.
//
//   "再过 10 分钟再跑一遍测试"        → at(now + 10min)
//   "下午三点再跑一遍"                → at(today/tomorrow 15:00)
//   "等到明天早上九点"                → at(tomorrow 09:00)
//
// but a time that is merely the OBJECT of the request never counts:
//
//   "把 15:30 这个时间戳改成 UTC"      → not a schedule
//   "15:30 之后的日志都删掉"          → not a schedule (the `(?!的)` below)
//   "为什么下午三点再跑就报错？"        → not a schedule (question intonation)
//
// Only a resolvable MOMENT counts: a bare "明天" is day-granularity talk
// ("明天再说"), not a schedulable input, so it never comes back as `at`.

/** A clock with an optional part-of-day and an optional day word in front. */
const CLOCK_SRC = '(?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\\s*(?:\\d{1,2}\\s*[:：]\\s*\\d{2}|[0-9一两二三四五六七八九十]{1,3}\\s*[点時时]\\s*(?:半|\\d{1,2}分?|[一二三四五六七八九十]{1,3}分?)?)';
const DAY_SRC = '(?:今天|今日|明天|明日|后天|後天|today|tomorrow)?';
const CLOCK_WITH_DAY_SRC = `${DAY_SRC}\\s*${CLOCK_SRC}`;

/** The deferral frames, in the order they are tried. A frame must contain both
 *  the time and the mark that says "not yet" — the capture is what gets parsed,
 *  so nothing outside the frame can leak into the clock arithmetic. */
const DURATION_SRC = '(?:半|\\d+|[一两二三四五六七八九十]+)\\s*(?:个?\\s*)?(?:分钟|分鐘|min(?:ute)?s?|小时|小時|hours?|hrs?)';

const DEFER_FRAMES: RegExp[] = [
  // 前缀式：「再过 10 分钟」「再等半小时」——延期词在前，时长本身就是"还没到"的证据。
  new RegExp(`(?:再过|再等)\\s*${DURATION_SRC}(?!的)`),
  // 后缀式：「10 分钟后」「半小时之后」——"之后"后必须真的接着指令。
  new RegExp(`${DURATION_SRC}\\s*(?:之后|之後|以后|以後|后|後|later)(?!的)`),
  // 时刻 + 延后：「下午三点再跑」「明天早上九点的时候」「15:30 再跑」
  new RegExp(`${CLOCK_WITH_DAY_SRC}\\s*(?:再|之后|之後|以后|以後|的时候|的時候|到时|到時)(?!的)`, 'i'),
  // 明确的等到：「等到下午三点」「等到明天早上九点」
  new RegExp(`(?:等到|等到了|等到时候|到)\s*(?:${CLOCK_WITH_DAY_SRC})`, 'i'),
];

export function detectScheduledInput(text: string, now = Date.now()): InputTiming | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // 问句里的时间几乎一定是被问到的内容，不是排期（"为什么下午三点再跑就报错？"）。
  if (/[?？]\s*$/.test(trimmed)) return null;
  for (const frame of DEFER_FRAMES) {
    const match = frame.exec(trimmed);
    if (!match) continue;
    const phrase = match[0].trim();
    const timing = parseInputTiming(phrase, phrase, now);
    if (timing.mode === 'at' && typeof timing.at === 'number' && timing.at > now) return timing;
  }
  return null;
}

export function describeTiming(timing: InputTiming): string {
  if (timing.mode === 'now') return '立即';
  if (timing.mode === 'after-current') return '当前任务之后';
  if (!timing.at) return '指定时间';
  const d = new Date(timing.at);
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (timing.text && timing.text.trim() && !/^\d{1,2}[:：]\d{2}$/.test(timing.text.trim())) return timing.text.trim();
  return clock;
}

// ── Replayable log ────────────────────────────────────────────────────────
// Every decision the app makes about an input is recorded here. The point is
// not debugging-by-printf: it is that a routing bug ("this modify request was
// treated as chit-chat") can be turned into a test case by exporting the log
// and asserting the same decision comes back, instead of hand-writing prose
// assertions about source text.

export const INPUT_DECISION_LOG_LIMIT = 200;

const decisionLog: InputDecision[] = [];

export interface LoggedInputDecision extends InputDecision {
  ts: number;
}

const stampedLog: LoggedInputDecision[] = [];

export function recordInputDecision(decision: InputDecision, ts = Date.now()): void {
  const entry: LoggedInputDecision = { ...decision, ts };
  decisionLog.push(entry);
  if (decisionLog.length > INPUT_DECISION_LOG_LIMIT) decisionLog.splice(0, decisionLog.length - INPUT_DECISION_LOG_LIMIT);
  stampedLog.push(entry);
  if (stampedLog.length > INPUT_DECISION_LOG_LIMIT) stampedLog.splice(0, stampedLog.length - INPUT_DECISION_LOG_LIMIT);
}

export function getInputDecisionLog(): readonly LoggedInputDecision[] {
  return stampedLog;
}

export function clearInputDecisionLog(): void {
  decisionLog.length = 0;
  stampedLog.length = 0;
}

/** One JSON object per line — a format a test can write to disk and replay. */
export function formatInputDecisionLog(log: readonly LoggedInputDecision[] = stampedLog): string {
  return log.map((entry) => JSON.stringify(entry)).join('\n');
}

export function parseInputDecisionLog(text: string): LoggedInputDecision[] {
  const out: LoggedInputDecision[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as LoggedInputDecision;
      if (parsed && typeof parsed.action === 'string' && typeof parsed.kind === 'string') out.push(parsed);
    } catch {
      // A corrupt line must not take the whole replay down.
    }
  }
  return out;
}

/**
 * Replay: the same decision, re-derived from a logged entry, must still land on
 * the same action. Used by the regression tests as the single assertion shape
 * for every producer — the log is the fixture.
 */
export function replayInputDecision(entry: LoggedInputDecision): InputDecision {
  const { ts: _ts, ...decision } = entry;
  return applyConfidenceGate(decision);
}

/** Human-readable one-liner for the activity panel / console diagnostics. */
export function formatInputDecision(decision: InputDecision): string {
  const confidence = `${Math.round(decision.confidence * 100)}%`;
  return `${decision.source}:${decision.kind} → ${decision.action} (${confidence}, ${describeTiming(decision.timing)})`
    + `${decision.scope.length ? ` scope=[${decision.scope.join(',')}]` : ''}`;
}
