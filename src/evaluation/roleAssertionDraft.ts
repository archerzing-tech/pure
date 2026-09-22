// src/evaluation/roleAssertionDraft.ts
// 北极星第 6 步 13.3（part 3）/ 13.1 — 从真实产出起草 A/B 内容断言（零 IO）。
//
// 真实派发只给 {args, output}，给不出"该出现什么"（must/mustNot）。用一次便宜
// 模型调用从（角色契约 + 真实产出）起草断言：断言描述的是**该角色的产出契约**
// （结构/证据/必须覆盖的维度），而不是逐字抄这份产出——否则断言不可迁移，A/B
// 也会退化成"像不像那次输出"。自洽门（base 侧必须通过）在脚本里执行，本模块
// 只做提示词构造与回复校验，与 LessonReflector 的纪律一致：模型没有最终决定权。

import type { LLMAdapter } from '../shared/types';

export interface AssertionDraftInput {
  role: string;
  /** 该角色 base persona 的契约摘要（脚本从注册表取）——断言的锚。 */
  roleContract: string;
  /** 一条真实派发的产出（会被截断），仅作参考，不是断言来源。 */
  realOutput: string;
}

export interface AssertionDraft {
  must: string[];
  mustNot: string[];
}

/** 单条断言长度上限——断言是用来做子串匹配的短标记，不是句子。 */
export const MAX_ASSERTION_CHARS = 60;
/** 每侧断言条数上限——太多会让 A/B 过脆（任何风格偏差都判挂）。 */
export const MAX_ASSERTIONS = 6;
const REAL_OUTPUT_MAX = 3000;

const DRAFT_SYSTEM_PROMPT = `You write content assertions for a regression test of ONE subagent role. You are given the role's contract (what its output must accomplish) and one real produced output as a reference sample.

Respond with STRICT JSON only — no markdown fences, no prose:
{
  "must": ["short marker that any good output of this role MUST contain"],
  "mustNot": ["short marker that a BAD output would contain (e.g. ungrounded claims of success)"]
}

Hard rules:
- Assertions describe the ROLE CONTRACT, not this one sample. Do not copy sample-specific wording, file names, or findings verbatim.
- Each marker is a short literal substring (2–${MAX_ASSERTION_CHARS} chars) that the checker will search for case-insensitively. Prefer stable, structural markers (section names, required dimension labels, evidence words) over full sentences.
- "must" must be non-empty (${MAX_ASSERTIONS} items max) and must hold for a competent output of this role, whether or not the sample is ideal.
- "mustNot" (${MAX_ASSERTIONS} items max) targets failure signatures: blanket approval, invented evidence, empty stubs. Emit [] if you cannot justify any.
- Write markers in the SAME language as the role contract.`;

/** Render the user-message payload. Truncated so a monster output can't blow the call. */
export function buildAssertionDraftPrompt(input: AssertionDraftInput): string {
  return [
    `ROLE: ${input.role}`,
    `ROLE CONTRACT:\n${input.roleContract.slice(0, 1500) || '(not provided)'}`,
    `REFERENCE OUTPUT (a real delegation's result — reference only, do not copy verbatim):\n${input.realOutput.slice(0, REAL_OUTPUT_MAX)}`,
  ].join('\n\n');
}

/** Pull the first balanced JSON object out of a model reply (tolerates fences/prose). */
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
          return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function cleanMarkers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const marker = item.trim().replace(/\s+/g, ' ');
    if (marker.length < 2 || marker.length > MAX_ASSERTION_CHARS) continue;
    const key = marker.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(marker);
    if (out.length >= MAX_ASSERTIONS) break;
  }
  return out;
}

/** Validate + sanitize a reply into a usable assertion draft. Returns undefined
 *  when the reply is unusable (no must markers) — caller skips the sample rather
 *  than admitting an assertion set that can't measure anything. */
export function parseAssertionDraft(reply: string): AssertionDraft | undefined {
  const parsed = extractJsonObject(reply);
  if (!parsed) return undefined;
  const must = cleanMarkers(parsed.must);
  if (must.length === 0) return undefined;
  return { must, mustNot: cleanMarkers(parsed.mustNot) };
}

/** Same wall-clock discipline as the lesson reflector: a hung provider must not
 *  wedge the harvest script — reject and let the caller skip the sample. */
const DRAFT_TIMEOUT_MS = 60_000;

export async function draftRoleAssertions(
  llm: LLMAdapter,
  input: AssertionDraftInput,
  signal?: AbortSignal,
): Promise<AssertionDraft | undefined> {
  const reply = await Promise.race([
    llm.complete(
      [
        { role: 'system', content: DRAFT_SYSTEM_PROMPT },
        { role: 'user', content: buildAssertionDraftPrompt(input) },
      ],
      [],
      signal,
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`assertion draft timed out after ${DRAFT_TIMEOUT_MS}ms`)), DRAFT_TIMEOUT_MS),
    ),
  ]);
  return parseAssertionDraft(reply.content);
}
