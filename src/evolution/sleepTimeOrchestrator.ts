// src/evolution/sleepTimeOrchestrator.ts
// P0-1 sleep-time 进化编排器 —— 把 观测→反思→建议→起草→门禁→落盘 串成一次
// 可预算、可续跑的后台循环（Letta sleep-time 同款路线，但只走 pure 既有的
// 声明式落盘缝：memory.add / overlay 写盘 / 技能开关翻转，不新增加载路径）。
//
// 纪律（与 Harness 反思层同一套）：
//   • 全 DI 纯核 —— 零 DOM、零 Tauri、零 node fs；宿主注入 cursor 存储、
//     会话枚举/读取、观测来源、LLM、overlay 流。Bun 全 fake 测试驱动。
//   • 永不阻塞运行时 —— 一切异步 advisory；预算耗尽存游标即退，下轮续。
//   • 绝不重试风暴 —— overlay 门禁 deny/reject/failed 记账 7 天退避；
//     坏会话档案打毒丸标记不再重试；SIGINT 半途重放靠 reflect: 前缀查重。
//   • 总开关（config.skills.evolution / PURE_EVOLUTION_DISABLED）由宿主把守：
//     不调 runSleepTimeCycle 就是与今日逐字节一致的行为。

import type { IMemoryStore, LLMAdapter, Message } from '../shared/types';
import {
  REFLECT_DEDUPE_PREFIX,
  REFLECTION_DEFAULTS,
  buildTurnEvidence,
  countReflectionsToday,
  lessonToMemoryAdds,
  reflectTurn,
  shouldReflect,
  type ReflectionConfig,
} from '../harness/LessonReflector';
import { scanSubagentAdvice, type SubagentAdvice, type SubagentAdviceSeverity } from '../shared/subagentAdvisory';
import type { OverlayFlowOutcome, OverlayFlowResult } from '../ui/personaOverlayFlow';
import type { PromptObservation } from '../shared/promptObservability';

// ── 预算 ──

/** 单轮循环的硬预算：超了存游标退出，下轮接着跑（进化永不和运行时抢资源）。 */
export interface SleepTimeBudget {
  maxWallClockMs: number;
  maxSessions: number;
  /** 便宜档 LLM 调用数：reflectTurn 记 1，overlay 流（起草 + A/B）记 2。 */
  maxLlmCalls: number;
}

/** 宿主预设：GUI 空闲循环最宽裕，CLI oneshot 次之，/exit 只许速战速决。 */
export const SLEEP_TIME_BUDGETS = {
  gui: { maxWallClockMs: 90_000, maxSessions: 3, maxLlmCalls: 6 },
  cli: { maxWallClockMs: 30_000, maxSessions: 3, maxLlmCalls: 6 },
  exit: { maxWallClockMs: 10_000, maxSessions: 1, maxLlmCalls: 2 },
} as const satisfies Record<string, SleepTimeBudget>;

// ── 游标 ──

/** 跨循环水位，宿主落盘（GUI 走 read_file/write_file invoke，CLI 走 node fs）。
 *  丢游标不丢正确性：reflect: 前缀查重 + overlay 同名不覆盖兜底。 */
export interface OrchestratorCursor {
  /** 水位：updatedAt 晚于此的会话才进候选。 */
  lastProcessedAt: number;
  /** 已完整处理的会话 id（尾 200 —— 防同水位重放）。 */
  processedSessionIds: string[];
  /** overlay 门禁失败记账：key → 拒绝时刻 + 次数（7 天内不重试）。 */
  overlayLedger: Record<string, { deniedAt: number; attempts: number }>;
  /** advisory 重入窗：循环开始置、结束清；未到期 = 别的循环在跑，本轮让路。 */
  runningUntil?: number;
}

export function emptyCursor(now = 0): OrchestratorCursor {
  return { lastProcessedAt: now, processedSessionIds: [], overlayLedger: {} };
}

/** 任意来源的 JSON → 合法游标：宿主读盘后必经这道闸（字段缺失/类型不对的
 *  一律落默认值 —— 手改坏、半截写、旧版本文件都不能把循环带崩）。 */
export function sanitizeCursor(raw: unknown): OrchestratorCursor {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ledger: OrchestratorCursor['overlayLedger'] = {};
  if (r.overlayLedger && typeof r.overlayLedger === 'object') {
    for (const [key, value] of Object.entries(r.overlayLedger as Record<string, unknown>)) {
      const v = value as { deniedAt?: unknown; attempts?: unknown } | null;
      if (v && typeof v.deniedAt === 'number' && typeof v.attempts === 'number') {
        ledger[key] = { deniedAt: v.deniedAt, attempts: v.attempts };
      }
    }
  }
  return {
    lastProcessedAt: typeof r.lastProcessedAt === 'number' ? r.lastProcessedAt : 0,
    processedSessionIds: Array.isArray(r.processedSessionIds)
      ? r.processedSessionIds.filter((id): id is string => typeof id === 'string')
      : [],
    overlayLedger: ledger,
  };
}

/** 空闲循环的下一跳延迟（宿主定时器的纯核策略）：没跑过 → 等一个轮询窗
 *  （启动不抢跑）；跑过 → 间隔到期还剩多久，过期归 0。 */
export function computeIdleCycleDelayMs(
  lastCycleAt: number | undefined,
  now: number,
  pollMs: number,
  gapMs: number,
): number {
  if (!lastCycleAt) return pollMs;
  return Math.max(0, lastCycleAt + gapMs - now);
}

/** overlay 门禁失败后的退避窗：一次判卷失败不该变成每 30 分钟一次的重试风暴。 */
export const OVERLAY_BACKOFF_MS = 7 * 24 * 3600 * 1000;
/** processedSessionIds 的留存上限（FIFO 截尾）。 */
const CURSOR_SESSION_TAIL = 200;

// ── 会话输入 ──

export interface SleepTimeSessionRef {
  id: string;
  /** 会话最后活动时间 —— 游标水位与排序判据。 */
  updatedAt: number;
}

/** 一次可反思的会话切片（与会话档案的映射由宿主完成；坏档案 → undefined）。 */
export interface SleepTimeTurnInput {
  userPrompt: string;
  finalOutput?: string;
  /** 完整轮转写本 —— 证据目录（可引用调用哈希）从这里提取。 */
  messages?: Message[];
  /** 引擎记录的本轮失败（重试 + 单次）；反思的事实底座之一。 */
  failures?: { toolName?: string; message: string }[];
  verificationSummary?: string;
  verificationPassed?: boolean;
}

/**
 * 会话快照消息流 → 可反思切片：最后一条真实 user 消息 = userPrompt，其后最后
 * 一条 assistant 消息 = finalOutput；整段 messages 供证据目录提取。纯函数，
 * GUI（session.json 快照）与 CLI（直喂内存消息流）两个宿主共用同一映射。
 */
export function sessionTurnFromMessages(messages: Message[]): SleepTimeTurnInput | undefined {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && !m.internal && typeof m.content === 'string' && m.content.trim()) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return undefined;
  const userPrompt = (messages[lastUserIdx] as Message).content.trim();
  let finalOutput: string | undefined;
  for (let i = messages.length - 1; i > lastUserIdx; i--) {
    const m = messages[i];
    if (m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      finalOutput = m.content;
      break;
    }
  }
  return { userPrompt, ...(finalOutput !== undefined ? { finalOutput } : {}), messages };
}

// ── 确认策略 ──

export type ConfirmAction =
  | { kind: 'skill-gate'; severity: SubagentAdviceSeverity; skillId: string; advice: SubagentAdvice };

export type ConfirmDecision = 'allow' | 'queue' | 'skip';
export type ConfirmPolicy = (action: ConfirmAction) => ConfirmDecision | Promise<ConfirmDecision>;

/**
 * 默认确认策略（决策不含副作用 —— 翻转开关/记账由宿主的 applySkillGate 执行，
 * 复用 settings.ts 建议卡「一键应用」的同一套语义）：
 *   • 技能闸 + high → allow（关一个反复翻车的技能是低风险、可随时重开的动作）；
 *   • 技能闸 + medium → queue（只翻车一半的留给用户看卡决定）；
 *   • overlay 落盘不走此策略 —— 它必须先过 13.3 确定性 A/B 门禁，到 confirm
 *     即 verdict==='allow'，宿主侧自动确认（见 OverlayFlowDeps.confirm）。
 */
export function defaultConfirmPolicy(): ConfirmPolicy {
  return (action) => (action.severity === 'high' ? 'allow' : 'queue');
}

// ── 依赖与结果 ──

export interface SleepTimeDeps {
  /** 游标存取（宿主落盘；load 失败/缺文件 → undefined → 从头开始）。 */
  cursor: {
    load(): Promise<OrchestratorCursor | undefined>;
    save(cursor: OrchestratorCursor): Promise<void>;
  };
  /** 待处理会话枚举（宿主按项目/时间过滤；不给 = 只处理 directSession）。 */
  listPendingSessions?: () => Promise<SleepTimeSessionRef[]>;
  /** 会话档案读取；坏档案返回 undefined（打毒丸标记，不再重试）。 */
  loadSession?: (id: string) => Promise<SleepTimeTurnInput | undefined>;
  /** CLI 直喂：刚结束的会话还在内存里（oneshot 没有档案）——优先处理。 */
  directSession?: SleepTimeTurnInput & { id?: string };
  /** 记忆缝（既有 register 接缝，不新增加载路径）。 */
  memory: Pick<IMemoryStore, 'add' | 'list'>;
  /** 便宜档 LLM（宿主绑 E0.3 的 REFLECT adapter，同 Harness 的 E0.3 契约）。 */
  llm: LLMAdapter;
  /** 反思配置（每日上限等；缺省用 REFLECTION_DEFAULTS）。 */
  reflection?: Partial<ReflectionConfig>;
  /** 记忆条目归属项目（Harness 同源的 projectPath）。 */
  projectPath?: string;
  /** 观测来源（GUI 读 app.jsonl 尾读，CLI 读 FilePromptObservationStore）。 */
  observations?: () => Promise<PromptObservation[]> | PromptObservation[];
  /** 13.3 overlay 全流程（起草→校验→A/B→确认→落盘）。宿主装配
   *  runPersonaOverlayFlow；confirm 绑定为 async () => true（走到 confirm
   *  即门禁 verdict==='allow'，符合「门禁通过即自动落盘」立场）。 */
  runOverlayFlow?: (advice: SubagentAdvice, signal?: AbortSignal) => Promise<OverlayFlowResult>;
  /** overlay 文件存在性预检（防每轮白烧一次起草调用）。 */
  overlayExists?: (role: string) => Promise<boolean>;
  /** 技能闸执行（翻转 config + persist + advice_applied 记账 —— settings.ts 语义）。 */
  applySkillGate?: (advice: SubagentAdvice) => Promise<void> | void;
  confirmPolicy?: ConfirmPolicy;
  budget?: Partial<SleepTimeBudget>;
  /** 可测试性：时钟与取消。 */
  now?: () => number;
  signal?: AbortSignal;
  /** 动作流水（宿主日志/遥测；核心只报告不决策）。 */
  onAction?: (action: SleepTimeAction) => void;
}

export type SleepTimeAction =
  | { kind: 'session-processed'; sessionId: string; lessonWritten: boolean }
  | { kind: 'session-skipped'; sessionId: string; reason: SessionSkipReason }
  | { kind: 'skill-gate-applied'; advice: SubagentAdvice }
  | { kind: 'overlay-written'; role: string }
  | { kind: 'overlay-deferred'; role: string; outcome: OverlayFlowOutcome; backoffMs: number };

export type SessionSkipReason =
  | 'cursor' // 水位/尾表已覆盖
  | 'already-reflected' // reflect: 前缀查重命中（防 SIGINT 半途重放）
  | 'bad-archive'
  | 'daily-cap'
  | 'not-worth-reflecting'; // shouldReflect 未过门（零工具调用的纯聊天）

export interface CycleResult {
  startedAt: number;
  endedAt: number;
  sessionsProcessed: string[];
  lessonsWritten: number;
  advicesConsidered: number;
  skillGatesApplied: number;
  overlaysWritten: number;
  /** 哪个预算维度先到顶（null = 自然跑完）。 */
  budgetExhausted: 'wall-clock' | 'sessions' | 'llm' | null;
  aborted: boolean;
  /** 重入窗未到期直接让路（本轮什么都没做）。 */
  skippedRunning: boolean;
  errors: string[];
}

// ── 主循环 ──

/**
 * 跑一轮 sleep-time 进化循环：会话反思（增量、预算内）→ 建议路由（每轮一次
 * scanSubagentAdvice：skill-gate 问确认策略，overlay 走 13.3 门禁 + 7 天退避）。
 * 永不 throw —— 单点失败进 result.errors，循环继续；游标每处理完一个会话就
 * 存一次（崩溃/中断后从水位续跑，已写条目靠 reflect: 前缀查重不重放）。
 */
export async function runSleepTimeCycle(deps: SleepTimeDeps): Promise<CycleResult> {
  const nowFn = deps.now ?? ((): number => Date.now());
  const startedAt = nowFn();
  const budget: SleepTimeBudget = { ...SLEEP_TIME_BUDGETS.gui, ...deps.budget };
  const reflection = { ...REFLECTION_DEFAULTS, ...deps.reflection };
  const projectPath = deps.projectPath ?? '';
  const policy = deps.confirmPolicy ?? defaultConfirmPolicy();
  const result: CycleResult = {
    startedAt,
    endedAt: startedAt,
    sessionsProcessed: [],
    lessonsWritten: 0,
    advicesConsidered: 0,
    skillGatesApplied: 0,
    overlaysWritten: 0,
    budgetExhausted: null,
    aborted: false,
    skippedRunning: false,
    errors: [],
  };
  const emit = (action: SleepTimeAction): void => { try { deps.onAction?.(action); } catch { /* 流水永不影响循环 */ } };

  // 游标 + advisory 重入窗：另一个循环在跑就让路（GUI 定时器 + CLI 并存的护栏）。
  let cursor: OrchestratorCursor;
  try {
    // 水位从 0 起步（不是 startedAt）：水位语义是「已处理基线」，新游标没有
    // 基线。若设成 startedAt，直喂会话（updatedAt === startedAt）会被
    // `<= 水位` 判成已处理，首轮就被孤儿化。已反思过的会话由 reflect: 前缀
    // 查重兜底，不存在重放。
    cursor = (await deps.cursor.load()) ?? emptyCursor(0);
  } catch (err) {
    result.errors.push(`cursor load failed: ${errorMessage(err)}`);
    result.endedAt = nowFn();
    return result;
  }
  if (cursor.runningUntil && cursor.runningUntil > startedAt) {
    result.skippedRunning = true;
    result.endedAt = nowFn();
    return result;
  }
  const deadline = startedAt + budget.maxWallClockMs;
  cursor.runningUntil = deadline;
  let llmCalls = 0;
  const aborted = (): boolean => deps.signal?.aborted ?? false;

  const saveCursor = async (): Promise<void> => {
    try {
      await deps.cursor.save(cursor);
    } catch (err) {
      result.errors.push(`cursor save failed: ${errorMessage(err)}`);
    }
  };
  await saveCursor();

  try {
    // ── 会话反思（directSession 优先，然后按 updatedAt 新→旧排水）──
    const candidates: Array<SleepTimeSessionRef & { turn?: SleepTimeTurnInput }> = [];
    if (deps.directSession) {
      candidates.push({ id: deps.directSession.id ?? 'direct-session', updatedAt: startedAt, turn: deps.directSession });
    }
    if (deps.listPendingSessions) {
      let listed: SleepTimeSessionRef[] = [];
      try {
        listed = await deps.listPendingSessions();
      } catch (err) {
        result.errors.push(`listPendingSessions failed: ${errorMessage(err)}`);
      }
      listed
        .filter((s) => !candidates.some((c) => c.id === s.id))
        // 旧→新（FIFO）—— 水位单调推进的前提：若先处理新会话，水位会越过
        // 尚未处理的旧会话把它们永久孤儿化。预算不足时最新会话留给下轮。
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .forEach((s) => candidates.push(s));
    }

    for (const candidate of candidates) {
      if (result.sessionsProcessed.length >= budget.maxSessions) { result.budgetExhausted = 'sessions'; break; }
      if (aborted()) { result.aborted = true; break; }
      if (nowFn() >= deadline) { result.budgetExhausted = 'wall-clock'; break; }
      // 游标过滤：水位之下或已完整处理过的会话不再进。
      if (candidate.updatedAt <= cursor.lastProcessedAt || cursor.processedSessionIds.includes(candidate.id)) {
        emit({ kind: 'session-skipped', sessionId: candidate.id, reason: 'cursor' });
        continue;
      }
      // reflect: 前缀查重 —— 反思已落库的会话绝不重放（防 SIGINT 半途重跑）。
      let existing: ReturnType<IMemoryStore['list']> = [];
      try {
        existing = deps.memory.list({ projectPath });
      } catch { existing = []; }
      const reflectPrefix = `${REFLECT_DEDUPE_PREFIX}${candidate.id}:`;
      if (existing.some((e) => typeof e.dedupeKey === 'string' && e.dedupeKey.startsWith(reflectPrefix))) {
        markProcessed(cursor, candidate);
        emit({ kind: 'session-skipped', sessionId: candidate.id, reason: 'already-reflected' });
        continue;
      }
      // 档案读取：坏的打毒丸标记（每轮都撞同一个坏档案才是真事故）。
      const turn = candidate.turn ?? (deps.loadSession ? await deps.loadSession(candidate.id).catch(() => undefined) : undefined);
      if (!turn || !turn.userPrompt.trim()) {
        markProcessed(cursor, candidate);
        result.errors.push(`session ${candidate.id}: archive unreadable or empty`);
        emit({ kind: 'session-skipped', sessionId: candidate.id, reason: 'bad-archive' });
        continue;
      }
      // 每日上限：先数库（reflect: 前缀）再花钱 —— 与 Harness 同一计数器。
      let reflectionsToday = 0;
      try {
        reflectionsToday = countReflectionsToday(deps.memory, projectPath, nowFn());
      } catch { reflectionsToday = 0; }
      if (reflectionsToday >= reflection.dailyCap) {
        markProcessed(cursor, candidate);
        emit({ kind: 'session-skipped', sessionId: candidate.id, reason: 'daily-cap' });
        continue;
      }
      // shouldReflect 同款门：零工具调用的纯聊天不值得一次 LLM 调用。
      const evidence = buildTurnEvidence(turn.messages ?? []);
      if (!shouldReflect(evidence.length, (turn.failures ?? []).length, reflection)) {
        markProcessed(cursor, candidate);
        emit({ kind: 'session-skipped', sessionId: candidate.id, reason: 'not-worth-reflecting' });
        continue;
      }
      if (nowFn() >= deadline) { result.budgetExhausted = 'wall-clock'; break; }
      if (llmCalls + 1 > budget.maxLlmCalls) { result.budgetExhausted = 'llm'; break; }
      llmCalls += 1;

      let lessonWritten = false;
      try {
        const verificationSummary = turn.verificationSummary ?? '';
        const verificationPassed = turn.verificationPassed ?? false;
        const lesson = await reflectTurn(deps.llm, {
          userPrompt: turn.userPrompt,
          finalOutput: turn.finalOutput,
          evidence,
          failures: turn.failures ?? [],
          verificationSummary,
          verificationPassed,
        }, deps.signal);
        if (lesson) {
          const adds = lessonToMemoryAdds(lesson, {
            sessionId: candidate.id,
            projectPath,
            dedupeKey: `${reflectPrefix}${turn.userPrompt.trim().toLowerCase()}`,
            verificationSummary,
            verificationPassed,
          });
          const [main, ...piggybacks] = adds;
          if (main) {
            await deps.memory.add(main);
            lessonWritten = true;
            result.lessonsWritten += 1;
          }
          // 便车条目（procedure/correction）失败只降级 —— 与 Harness 同纪律。
          for (const add of piggybacks) {
            try { await deps.memory.add(add); } catch { /* 便车不致命 */ }
          }
        }
      } catch (err) {
        result.errors.push(`session ${candidate.id} reflection failed: ${errorMessage(err)}`);
      }
      markProcessed(cursor, candidate);
      result.sessionsProcessed.push(candidate.id);
      emit({ kind: 'session-processed', sessionId: candidate.id, lessonWritten });
      await saveCursor(); // 每会话一存 —— 崩溃后从水位续跑
    }

    // ── 建议路由（每轮一次 scanSubagentAdvice 增量）──
    if (deps.observations && !result.budgetExhausted && !aborted()) {
      let records: PromptObservation[] = [];
      try {
        records = await deps.observations();
      } catch (err) {
        result.errors.push(`observations failed: ${errorMessage(err)}`);
      }
      for (const advice of scanSubagentAdvice(records, { now: nowFn() })) {
        if (aborted()) { result.aborted = true; break; }
        if (nowFn() >= deadline) { result.budgetExhausted = 'wall-clock'; break; }
        result.advicesConsidered += 1;
        // 技能闸路由：问策略，allow 且宿主有执行缝才动手。
        if (advice.action === 'skill-gate' && advice.skillId) {
          let decision: ConfirmDecision;
          try {
            decision = await policy({ kind: 'skill-gate', severity: advice.severity, skillId: advice.skillId, advice });
          } catch (err) {
            result.errors.push(`confirmPolicy failed: ${errorMessage(err)}`);
            continue;
          }
          if (decision === 'allow' && deps.applySkillGate) {
            try {
              await deps.applySkillGate(advice);
              result.skillGatesApplied += 1;
              emit({ kind: 'skill-gate-applied', advice });
            } catch (err) {
              result.errors.push(`applySkillGate failed: ${errorMessage(err)}`);
            }
          }
          // 技能闸类建议要么闸已拉、要么留给用户看卡 —— 不进 overlay 路径
          //（闸拉了角色不再派发，overlay 无的放矢；queue/skip 则等用户决定）。
          continue;
        }
        // overlay 路由：无流缝的宿主到此为止（卡片本来就在仪表盘上）。
        if (!deps.runOverlayFlow) continue;
        if (deps.overlayExists) {
          try {
            if (await deps.overlayExists(advice.role)) continue; // 已有 overlay，同名不覆盖
          } catch { /* 预检失败不挡流，flow 里还有同款检查 */ }
        }
        const key = `overlay:${advice.role}`;
        const prior = cursor.overlayLedger[key];
        if (prior && nowFn() - prior.deniedAt < OVERLAY_BACKOFF_MS) continue; // 7 天退避
        // 起草 + A/B ≈ 2 次便宜调用；预算不够就留给下轮。
        if (llmCalls + 2 > budget.maxLlmCalls) { result.budgetExhausted = 'llm'; break; }
        llmCalls += 2;
        let flow: OverlayFlowResult;
        try {
          flow = await deps.runOverlayFlow(advice, deps.signal);
        } catch (err) {
          flow = { outcome: 'failed', reason: errorMessage(err) };
        }
        if (flow.outcome === 'written') {
          result.overlaysWritten += 1;
          delete cursor.overlayLedger[key];
          emit({ kind: 'overlay-written', role: advice.role });
        } else {
          // deny/reject/invalid/failed/none/exists 一律记账退避：判卷不过或模型
          // 拒稿都不是 30 分钟后再试就能改变的事。
          cursor.overlayLedger[key] = { deniedAt: nowFn(), attempts: (prior?.attempts ?? 0) + 1 };
          emit({ kind: 'overlay-deferred', role: advice.role, outcome: flow.outcome, backoffMs: OVERLAY_BACKOFF_MS });
        }
        await saveCursor();
      }
    }
  } finally {
    cursor.runningUntil = undefined;
    await saveCursor();
  }

  result.endedAt = nowFn();
  return result;
}

function markProcessed(cursor: OrchestratorCursor, session: SleepTimeSessionRef): void {
  cursor.lastProcessedAt = Math.max(cursor.lastProcessedAt, session.updatedAt);
  cursor.processedSessionIds.push(session.id);
  if (cursor.processedSessionIds.length > CURSOR_SESSION_TAIL) {
    cursor.processedSessionIds = cursor.processedSessionIds.slice(-CURSOR_SESSION_TAIL);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
