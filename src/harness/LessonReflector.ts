// src/harness/LessonReflector.ts
// E1.1 — turn 后反思器：Completed 之后用便宜快模型（E0.3 的 REFLECT 阶段
// adapter）把本轮经过提炼成结构化 lesson（symptom / rootCause / prevention /
// evidence / scope），替代 writeSessionMemory 的模板拼接；模板版保留为反思
// 失败时的兜底（见 Harness.writeSessionLesson）。
//
// 防幻觉纪律：模型只能引用我们提供的证据目录里的调用哈希（id），引用不出的
// 根因猜测一律压成 confidence:'low'，注入端（Harness.composeMemoryPrompt）
// 默认跳过 low 条目。成本护栏：每日反思次数上限、触发条件门控、可整体关闭
// （HarnessConfig.reflection）。

// 浏览器安全哈希：共享内核的纯 TS sha256，而不是 node:crypto —— Harness 在 GUI
// 路径上是静态导入的，node:crypto 会让整个 Vite 浏览器构建失败。
import { sha256Hex } from '../shared/sha256';
import { withTimeout } from '../shared/timing';
import { GLOBAL_MEMORY_SCOPE } from '../shared/types';
import type { LLMAdapter, Message } from '../shared/types';
import type { IMemoryStore, MemoryEntry } from '../shared/types';

/** 反思产出的证据引用都带这个前缀，每日上限靠它数当天已写条目。 */
export const REFLECT_DEDUPE_PREFIX = 'reflect:';

export interface ReflectionConfig {
  /** Kill switch — false 时一切照旧走模板 lesson。默认 true。 */
  enabled?: boolean;
  /** 每日（本地日）反思次数上限，防止失控烧钱。默认 20。 */
  dailyCap?: number;
  /** 非平凡多步门槛：本轮工具调用 ≥ 该值才值得反思。默认 3。 */
  minToolCalls?: number;
}

export const REFLECTION_DEFAULTS: Required<ReflectionConfig> = {
  enabled: true,
  dailyCap: 20,
  minToolCalls: 3,
};

/** One tool call from the finished turn, in the evidence catalog format the
 *  model is allowed to cite. The id is a content hash so the lesson's evidence
 *  survives transcript truncation while staying verifiable against THIS turn. */
export interface TurnEvidence {
  id: string;
  toolName: string;
  argsPreview: string;
}

const ARGS_PREVIEW_MAX = 160;
export const EVIDENCE_ID_LENGTH = 12;

/** Extract every tool call from the turn's transcript as citable evidence,
 *  in call order. Assistant `toolCalls` entries carry name+arguments; tool
 *  role messages carry the results but are NOT evidence (the model could
 *  hallucinate results — outcome facts come from the failure records and the
 *  verification summary, which the engine produced). */
export function buildTurnEvidence(messages: Message[]): TurnEvidence[] {
  const evidence: TurnEvidence[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls) continue;
    for (const call of message.toolCalls) {
      if (!call.function?.name) continue;
      const args = typeof call.function.arguments === 'string' ? call.function.arguments : '';
      evidence.push({
        id: sha256Hex(`${call.function.name}::${args}`).slice(0, EVIDENCE_ID_LENGTH),
        toolName: call.function.name,
        argsPreview: args.slice(0, ARGS_PREVIEW_MAX),
      });
    }
  }
  return evidence;
}

/** E3.1 便车：用户纠正过的规矩/偏好 —— 只做草稿，确认前没有注入资格。 */
export interface ReflectedStatementCorrection {
  kind: 'project_convention' | 'user_preference';
  /** 以用户原话概括的规矩/偏好（≤200 字符）。 */
  statement: string;
}

/** 阶段 11.4（纠错记忆闭环）：本轮真的观测到"用户写的 token 不存在 → 换用另
 *  一个真实路径并成功"时提炼的别名。from = 用户写的不存在 token，to = 真实
 *  路径。metadata 单独留 from/to（而不只压进 statement），落库时才能拼出可读
 *  的"本工作区词条"。 */
export interface ReflectedTermAliasCorrection {
  kind: 'term_alias';
  /** 由 from/to 规范化生成的稳定句子 —— correctionDedupeKey 的内容来源，
   *  同一 from/to 无论模型怎么措辞都得到同一 dedupeKey（跨会话一致）。 */
  statement: string;
  from: string;
  to: string;
}

export type ReflectedCorrection = ReflectedStatementCorrection | ReflectedTermAliasCorrection;

export interface ReflectedLesson {
  symptom: string;
  rootCause: string;
  prevention: string;
  recovery: string;
  /** 调用哈希引用 —— 已经过本轮证据目录校验，目录外的 id 被剥掉。 */
  evidence: string[];
  /** E1.1 防幻觉纪律：拿不出有效证据的根因猜测强制 low（默认不注入）。 */
  confidence: 'high' | 'low';
  /** E2.1 便车：成功多步任务上额外提炼的步骤骨架（≤600 字符）。 */
  procedure?: string;
  /** E3.1 便车：本轮里用户明确纠正过的做法/规矩（草稿，待用户确认）。 */
  correction?: ReflectedCorrection;
  /** E1 落地（2026-10-13）——教训的适用域：'project'（默认）= 只对当前项目
   *  成立；'machine' = 环境/网络/平台/工具链类事实，在本机跨项目成立（装大
   *  repo 该走 API 分批、某工具本机缺失……）。machine 条目落全局库并走无
   *  条件注入通道（与 tool_preference 同构）；解析缺省/非法值一律回落
   *  project——误标 machine 会污染每个会话的注入面，宁可漏标。 */
  scope?: 'project' | 'machine';
}

const REFLECT_SYSTEM_PROMPT = `You are a meticulous engineering retrospective analyst. You receive the transcript facts of one completed agent turn (the user request, the tool calls it made, any failures, and the final outcome). Produce ONE reusable lesson for future sessions on this project.

Respond with STRICT JSON only — no markdown fences, no prose outside the JSON:
{
  "symptom": "what the task/situation was, one sentence",
  "rootCause": "why it went wrong or what made the working approach work; cite evidence ids",
  "prevention": "what a future session should do differently (or keep doing)",
  "recovery": "how the turn recovered, or 'not needed'",
  "evidence": ["id1", "id2"],
  "procedure": "optional: for a SUCCESSFUL multi-step task, a compact step skeleton (intent -> steps -> how it was verified), under 600 chars; omit for trivial or failed turns",
  "scope": "optional: 'machine' ONLY when the lesson is about this machine's environment, network, platform, or installed toolchain (it would hold in ANY project on this computer — e.g. GitHub is slow here, a tool is missing); omit for everything project-specific",
  "correction": "optional. Two forms. (a) The user explicitly corrected how the agent should work: {\"kind\": \"project_convention\" or \"user_preference\", \"statement\": \"the rule as the user stated it, under 200 chars\"}. (b) You OBSERVED in THIS turn that a name/path the user used does not exist and you then successfully used a different real one: {\"kind\": \"term_alias\", \"from\": \"the nonexistent token the user wrote\", \"to\": \"the real path you used instead\"}. Omit otherwise"
}

Hard rules:
- "evidence" may ONLY contain ids from the provided tool-call catalog. Never invent ids.
- If you cannot ground the root cause in catalog evidence, keep your best guess in rootCause but the system will downgrade confidence automatically.
- Output "correction" (a) ONLY for explicit user corrections of output style, working practice, or project rules (e.g. "no comments in this repo", "always run tests before commit"). Never infer it from tone alone.
- Output "correction" (b) term_alias ONLY when the recorded failures show a not-found for \`from\` AND a later successful call used \`to\`; BOTH \`from\` and \`to\` must appear in the tool-call catalog. Never invent an alias, and never emit one where from === to.
- Keep every string under 300 characters. Write in English.`;

export interface ReflectTurnInput {
  userPrompt: string;
  finalOutput?: string;
  evidence: TurnEvidence[];
  /** Engine-recorded failures this turn (retries + single failures) — ground
   *  truth for what broke, independent of the model's reading. */
  failures: { toolName?: string; message: string }[];
  verificationSummary: string;
  verificationPassed: boolean;
}

/** Render the user-message payload: request, evidence catalog, failures,
 *  outcome. Capped so a monster transcript can't blow the reflection call —
 *  evidence previews are already truncated per-call. */
export function buildReflectTranscript(input: ReflectTurnInput): string {
  const catalog = input.evidence.length > 0
    ? input.evidence.map((e) => `[${e.id}] ${e.toolName} ${e.argsPreview}`).join('\n')
    : '(no tool calls recorded)';
  const failures = input.failures.length > 0
    ? input.failures.map((f) => `- ${f.toolName ?? 'unknown'}: ${f.message.slice(0, 200)}`).join('\n')
    : '(none)';
  const parts = [
    `USER REQUEST:\n${input.userPrompt.slice(0, 600)}`,
    `TOOL-CALL CATALOG (the only citable evidence ids):\n${catalog}`,
    `RECORDED FAILURES (ground truth):\n${failures}`,
    `VERIFICATION: ${input.verificationSummary.slice(0, 300)} (passed: ${input.verificationPassed})`,
  ];
  if (input.finalOutput) parts.push(`FINAL OUTCOME:\n${input.finalOutput.slice(0, 600)}`);
  return parts.join('\n\n');
}

/** Pull the first balanced JSON object out of a model reply (tolerates fences
 *  and stray prose — cheap models love preambles). */
function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function asString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

const CORRECTION_KINDS = new Set(['project_convention', 'user_preference', 'term_alias']);

/** 草稿条目的 dedupeKey：同一句纠正（内容哈希）跨会话、跨轮次只落一条。 */
export function correctionDedupeKey(correction: ReflectedCorrection): string {
  return `correction:${correction.kind}:${sha256Hex(correction.statement).slice(0, EVIDENCE_ID_LENGTH)}`;
}

/** term_alias 的 statement 由 from/to 规范化生成 —— 不采信模型的措辞，同一
 *  from/to 永远落到同一句子，从而保证 dedupeKey 跨轮次/跨会话一致（硬验收）。 */
function termAliasStatement(from: string, to: string): string {
  return `The user writes "${from}" to mean the real path "${to}".`.slice(0, 200);
}

/** term_alias 落库的 content：可读的「本工作区词条」（≤300）。 */
function termAliasContent(from: string, to: string): string {
  return `本工作区词条：用户写「${from}」时指的是「${to}」（真实存在）。`.slice(0, 300);
}

/** 纠正草稿的校验：kind 白名单之外、statement 短于 8 个有效字符的一律丢弃 ——
 *  宁可漏收，不往仪表盘塞噪音草稿。term_alias 额外要求 from/to 非空且不同，
 *  statement 由二者规范化生成（模型给的 statement 一律不采信，防止措辞漂移
 *  破坏 dedupeKey 稳定性）。 */
function parseCorrection(value: unknown): ReflectedCorrection | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  if (!CORRECTION_KINDS.has(kind)) return undefined;
  if (kind === 'term_alias') {
    const from = asString(raw.from, 200).trim();
    const to = asString(raw.to, 200).trim();
    if (!from || !to || from === to) return undefined;
    return { kind: 'term_alias', statement: termAliasStatement(from, to), from, to };
  }
  const statement = asString(raw.statement, 240).trim().slice(0, 200);
  if (statement.length < 8) return undefined;
  return { kind: kind as 'project_convention' | 'user_preference', statement };
}

/** term_alias 的证据纪律（复用 parseReflectedLesson 的证据目录校验）：from 与
 *  to 都必须真的出现在本轮的调用目录里 —— from 出现在失败那次调用的参数、to
 *  出现在随后成功的调用参数。二者对不上就丢弃别名（lessons 主体照旧保留），
 *  呼应"绝不臆造别名"的硬规则。 */
function isTermAliasGrounded(correction: ReflectedCorrection, turnEvidence: TurnEvidence[]): boolean {
  if (correction.kind !== 'term_alias') return true;
  const inCatalog = (token: string): boolean => turnEvidence.some((e) => e.argsPreview.includes(token));
  return inCatalog(correction.from) && inCatalog(correction.to);
}

/** Validate + sanitize a model reply against THIS turn's evidence catalog.
 *  Returns undefined when the reply isn't a usable lesson (caller falls back
 *  to the template write). Evidence ids outside the catalog are stripped;
 *  nothing left to cite forces confidence:'low' — the anti-hallucination
 *  discipline is enforced HERE, not trusted to the model. */
export function parseReflectedLesson(reply: string, turnEvidence: TurnEvidence[]): ReflectedLesson | undefined {
  const parsed = extractJsonObject(reply);
  if (!parsed) return undefined;
  const symptom = asString(parsed.symptom, 300);
  const rootCause = asString(parsed.rootCause, 300);
  if (!symptom || !rootCause) return undefined;

  const validIds = new Set(turnEvidence.map((e) => e.id));
  const cited = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  const evidence = [...new Set(cited.filter((id): id is string => typeof id === 'string' && validIds.has(id)))];

  const prevention = asString(parsed.prevention, 300) || 'Keep the same inspection and verification sequence for similar tasks.';
  const recovery = asString(parsed.recovery, 300) || 'not needed';
  const procedure = asString(parsed.procedure, 600);
  const parsedCorrection = parseCorrection(parsed.correction);
  // term_alias 证据纪律：from/to 都要在调用目录里对得上，否则丢弃（lesson 主体保留）。
  const correction = parsedCorrection && isTermAliasGrounded(parsedCorrection, turnEvidence)
    ? parsedCorrection
    : undefined;
  // 白名单校验：缺省/拼错一律 project（见 ReflectedLesson.scope 注）。
  const scope = parsed.scope === 'machine' ? 'machine' : 'project';

  return {
    symptom,
    rootCause,
    prevention,
    recovery,
    evidence,
    confidence: evidence.length > 0 ? 'high' : 'low',
    ...(procedure ? { procedure } : {}),
    ...(correction ? { correction } : {}),
    ...(scope === 'machine' ? { scope } : {}),
  };
}

/** 今天（本地日）已经写过多少条反思记忆 —— 每日上限的计数器，直接数库里的
 *  reflect: 条目，不引入第二份持久化状态。只需 list 缝 —— Pick 让 sleep-time
 *  编排器的窄记忆依赖也能复用同一计数器。 */
export function countReflectionsToday(store: Pick<IMemoryStore, 'list'>, projectPath: string, now = Date.now()): number {
  let entries: ReturnType<IMemoryStore['list']> = [];
  try {
    entries = store.list({ projectPath });
  } catch {
    return 0;
  }
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = dayStart.getTime() + 24 * 60 * 60 * 1000;
  return entries.filter((e) =>
    typeof e.dedupeKey === 'string'
    && e.dedupeKey.startsWith(REFLECT_DEDUPE_PREFIX)
    && e.timestamp >= dayStart.getTime()
    && e.timestamp < dayEnd,
  ).length;
}

/** lessonToMemoryAdds 的落库上下文：持久化层盖在产出条目上的戳。全部由宿主
 *  （Harness 或 sleep-time 编排器）解析好传入 —— 纯函数不碰实例状态。 */
export interface LessonPersistContext {
  sessionId: string;
  projectPath: string;
  /** 本轮的 reflect: 查重键（前缀 + sessionId + prompt 小写）。 */
  dedupeKey: string;
  verificationSummary: string;
  verificationPassed: boolean;
}

/**
 * 反思结果 → 待落库记忆条目（lesson 主条目 + procedure 便车 + correction 草稿，
 * Harness.reflectLesson 原三段构造的逐字抽取 —— dedupeKey 格式与截断长度都不变，
 * 供 sleep-time 编排器复用同一条落库纪律）。procedure 便车只在
 * ctx.verificationPassed 时跟随；correction 草稿一律 confidence:'low'。
 */
export function lessonToMemoryAdds(lesson: ReflectedLesson, ctx: LessonPersistContext): Omit<MemoryEntry, 'id'>[] {
  // E1 落地（2026-10-13）：机器级教训（scope:'machine'）落全局库
  // （GLOBAL_MEMORY_SCOPE）——网络/环境/平台类事实跟机器走，不跟项目走；
  // 注入端走无条件通道（Harness 的 machineLessons，与 tool_preference 同构）。
  // correction 不跟随：用户纠正的是项目规矩/个人偏好，留在项目域。
  const persistPath = lesson.scope === 'machine' ? GLOBAL_MEMORY_SCOPE : ctx.projectPath;
  const evidenceNote = lesson.evidence.length > 0
    ? ` Evidence: ${lesson.evidence.length} tool call(s) (${lesson.evidence.join(', ')}).`
    : '';
  const parts = [
    `Symptom: ${lesson.symptom}`,
    `Root cause: ${lesson.rootCause}`,
    `Prevention: ${lesson.prevention}`,
    `Recovery: ${lesson.recovery}`,
  ];
  const adds: Omit<MemoryEntry, 'id'>[] = [
    {
      type: 'successful_pattern',
      content: `Reflected lesson — ${parts.join('. ')}.${evidenceNote}`.slice(0, 900),
      timestamp: Date.now(),
      sessionId: ctx.sessionId,
      projectPath: persistPath,
      lesson: {
        symptom: lesson.symptom,
        rootCause: lesson.rootCause,
        recoveryPath: lesson.recovery,
        verification: ctx.verificationSummary,
        avoidNextTime: lesson.prevention,
        ...(lesson.evidence.length > 0 ? { evidence: lesson.evidence } : {}),
      },
      dedupeKey: ctx.dedupeKey,
      // 防幻觉纪律：证据目录里引用不出东西的根因猜测 → low，注入端默认跳过。
      confidence: lesson.confidence,
    },
  ];
  if (lesson.procedure && ctx.verificationPassed) {
    adds.push({
      type: 'procedure',
      content: lesson.procedure.slice(0, 600),
      timestamp: Date.now(),
      sessionId: ctx.sessionId,
      projectPath: persistPath,
      dedupeKey: `procedure:${ctx.dedupeKey}`,
    });
  }
  // E3.1 便车：用户明确纠正过的做法/规矩 → 低置信草稿。确认前没有注入资格
  // （confidence:'low' 在 composeMemoryPrompt 被过滤），落库只为仪表盘待确认
  // 卡片；dedupeKey 用内容哈希，同一句纠正跨会话只落一条。
  // 阶段 11.4：term_alias（纠错别名）同样走这条草稿通道，只映射为现有
  // project_convention 类型（不新增 MemoryType/SOT）；content 换成可读的
  // 「本工作区词条：用户写 from 时指的是 to」。确认后只让模型"看到"该别名，
  // 不回灌 pathIndex 做自动改写（那会新建存储，违反约束）。
  if (lesson.correction) {
    const correction = lesson.correction;
    const isAlias = correction.kind === 'term_alias';
    adds.push({
      type: isAlias ? 'project_convention' : correction.kind,
      content: isAlias
        ? termAliasContent(correction.from, correction.to)
        : correction.statement.slice(0, 300),
      timestamp: Date.now(),
      sessionId: ctx.sessionId,
      // 项目域：即便 lesson.scope === 'machine'，别名也留项目（不随 scope 走全局）。
      projectPath: ctx.projectPath,
      dedupeKey: correctionDedupeKey(correction),
      confidence: 'low',
    });
  }
  return adds;
}

/** Should this completed turn spend a reflection call? Failures make it
 *  interesting regardless of length; otherwise it takes a genuinely multi-step
 *  process. Zero tool calls (plain chat) never reflects. */
export function shouldReflect(
  evidenceCount: number,
  failureCount: number,
  config: Required<ReflectionConfig>,
): boolean {
  if (!config.enabled) return false;
  if (evidenceCount === 0) return false;
  return failureCount > 0 || evidenceCount >= config.minToolCalls;
}

/** Reflection calls get the same wall-clock budget the HANDOVER phase gets —
 *  a hung provider must degrade to the template lesson, not hang the drain. */
const REFLECTION_TIMEOUT_MS = 60_000;

/** One reflection round-trip: transcript → cheap model → validated lesson.
 *  REJECTS on transport failure / timeout (caller falls back to the template
 *  write); a reply that isn't a usable lesson resolves to undefined for the
 *  same fallback. Evidence validation happens in parseReflectedLesson — the
 *  model never gets the final say on what counts as evidence. */
export async function reflectTurn(
  llm: LLMAdapter,
  input: ReflectTurnInput,
  signal?: AbortSignal,
): Promise<ReflectedLesson | undefined> {
  const reply = await withTimeout(
    llm.complete(
      [
        { role: 'system', content: REFLECT_SYSTEM_PROMPT },
        { role: 'user', content: buildReflectTranscript(input) },
      ],
      [],
      signal,
    ),
    REFLECTION_TIMEOUT_MS,
    'lesson reflection',
  );
  return parseReflectedLesson(reply.content, input.evidence);
}
