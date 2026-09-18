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

import { createHash } from 'node:crypto';
import type { LLMAdapter, Message } from '../shared/types';
import type { IMemoryStore } from '../shared/types';

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
        id: createHash('sha256').update(`${call.function.name}::${args}`).digest('hex').slice(0, EVIDENCE_ID_LENGTH),
        toolName: call.function.name,
        argsPreview: args.slice(0, ARGS_PREVIEW_MAX),
      });
    }
  }
  return evidence;
}

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
}

const REFLECT_SYSTEM_PROMPT = `You are a meticulous engineering retrospective analyst. You receive the transcript facts of one completed agent turn (the user request, the tool calls it made, any failures, and the final outcome). Produce ONE reusable lesson for future sessions on this project.

Respond with STRICT JSON only — no markdown fences, no prose outside the JSON:
{
  "symptom": "what the task/situation was, one sentence",
  "rootCause": "why it went wrong or what made the working approach work; cite evidence ids",
  "prevention": "what a future session should do differently (or keep doing)",
  "recovery": "how the turn recovered, or 'not needed'",
  "evidence": ["id1", "id2"],
  "procedure": "optional: for a SUCCESSFUL multi-step task, a compact step skeleton (intent -> steps -> how it was verified), under 600 chars; omit for trivial or failed turns"
}

Hard rules:
- "evidence" may ONLY contain ids from the provided tool-call catalog. Never invent ids.
- If you cannot ground the root cause in catalog evidence, keep your best guess in rootCause but the system will downgrade confidence automatically.
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

  return {
    symptom,
    rootCause,
    prevention,
    recovery,
    evidence,
    confidence: evidence.length > 0 ? 'high' : 'low',
    ...(procedure ? { procedure } : {}),
  };
}

/** 今天（本地日）已经写过多少条反思记忆 —— 每日上限的计数器，直接数库里的
 *  reflect: 条目，不引入第二份持久化状态。 */
export function countReflectionsToday(store: IMemoryStore, projectPath: string, now = Date.now()): number {
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
  const reply = await Promise.race([
    llm.complete(
      [
        { role: 'system', content: REFLECT_SYSTEM_PROMPT },
        { role: 'user', content: buildReflectTranscript(input) },
      ],
      [],
      signal,
    ),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`lesson reflection timed out after ${REFLECTION_TIMEOUT_MS}ms`)),
        REFLECTION_TIMEOUT_MS,
      ),
    ),
  ]);
  return parseReflectedLesson(reply.content, input.evidence);
}
