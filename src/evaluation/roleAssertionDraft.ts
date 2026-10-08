// src/evaluation/roleAssertionDraft.ts
// 北极星第 6 步 13.3（part 3）/ 13.1 — 从真实产出起草 A/B 内容断言（零 IO）。
//
// 真实派发只给 {args, output}，给不出"该出现什么"（must/mustNot）。用一次便宜
// 模型调用从（角色契约 + 真实产出）起草断言：断言描述的是**该角色的产出契约**
// （结构/证据/必须覆盖的维度），而不是逐字抄这份产出——否则断言不可迁移，A/B
// 也会退化成"像不像那次输出"。自洽门的判定核（gateAdmits）与原文支撑预滤
// （filterUnsupportedMarkers）也在这里；base 重跑的执行在收割脚本里。
// 与 LessonReflector 的纪律一致：模型没有最终决定权。

import type { LLMAdapter } from '../shared/types';
import { normalizeGraderText } from './roleRegression';

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

/** 单条断言长度上限——断言是用来做子串匹配的短标记，不是句子。60 字中文≈一
 *  整句话，正是首跑（2026-10-08，8 候选 0 落盘）脆断言的温床：起草模型把评审
 *  措辞整句搬进 must，原文稍有 paraphrase 门就找不到。过门样本（researcher 6
 *  例）的 marker 全是 ≤10 字的结构 token，24 字给中英混合术语留足余量。 */
export const MAX_ASSERTION_CHARS = 24;
/** 每侧断言条数上限——太多会让 A/B 过脆（任何风格偏差都判挂）。 */
export const MAX_ASSERTIONS = 6;
const REAL_OUTPUT_MAX = 3000;

const DRAFT_SYSTEM_PROMPT = `You write content assertions for a regression test of ONE subagent role. You are given the role's contract (what its output must accomplish) and one real produced output as a reference sample.

Respond with STRICT JSON only — no markdown fences, no prose:
{
  "must": ["short structural marker that any good output of this role MUST contain"],
  "mustNot": ["short marker that a BAD output would contain (e.g. ungrounded claims of success)"]
}

Hard rules:
- Each "must" marker MUST appear VERBATIM in the reference output. Pick structural tokens the sample actually contains: dimension labels, section/heading words, evidence terms, craft terminology. A marker the sample merely paraphrases is discarded before it ever reaches the checker.
- Assertions describe the ROLE CONTRACT, not this one sample. Prefer generic structural vocabulary over sample-specific findings, file names, or numbers.
- Each marker is a literal substring (2-${MAX_ASSERTION_CHARS} chars), matched case-insensitively with whitespace collapsed. A single word or short phrase — NEVER a sentence, never a clause with a verb, never a paraphrase of the sample's wording.
- "must" must be non-empty (${MAX_ASSERTIONS} items max) and must hold for a competent output of this role, whether or not the sample is ideal.
- "mustNot" (${MAX_ASSERTIONS} items max) targets failure signatures: blanket approval, invented evidence, empty stubs. It does NOT need to appear in the reference output (it shouldn't). Emit [] if you cannot justify any.
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

/** 首跑复盘（2026-10-08）的零成本预滤：must 标记在这份真实产出里归一化后
 *  找不到 = 起草模型在 paraphrase 或幻觉——判分器永远找不到它的支撑，A/B 的
 *  base 侧必挂，与其烧一次 base 重跑等门毙，不如在这里丢掉。mustNot 不滤
 *  （失败特征本来就不该出现在好产出里）。must 被滤空 = 起草整体不可用，
 *  返回 undefined，调用方跳过该样本。归一化语义取自判分器的
 *  normalizeGraderText——「找得到」的判据两边必须同一份。 */
export function filterUnsupportedMarkers(
  draft: AssertionDraft,
  realOutput: string,
): AssertionDraft | undefined {
  const haystack = normalizeGraderText(realOutput);
  const must = draft.must.filter((marker) => haystack.includes(normalizeGraderText(marker)));
  if (must.length === 0) return undefined;
  return { must, mustNot: draft.mustNot };
}

/** 自洽门的判定核：K 次 base 重跑的通过票型是否过半收录。过半而非全票——
 *  门要与判定 LLM 的抖动对冲；平票与全败都算不过（宁可漏收，不放脆断言进
 *  A/B 扭曲 base 基线）。空跑（K=0）恒不过——「跑 0 次全收录」是门的退化。 */
export function gateAdmits(passes: readonly boolean[]): boolean {
  const yes = passes.filter(Boolean).length;
  return yes * 2 > passes.length;
}

/** Wall-clock bound for one assertion draft. 5 minutes, not 1: 2026-09-30 S1
 *  真机（glm-5.3-flash，深思档）对真实样本的起草实测 165s —— 60s 上限让收割器
 *  在推理型 flash 模型上每条必超时、一条都收不进。收割是批量后台活（GUI 收割
 *  入口有进度提示），总墙钟由候选数上界兜底，单条放宽不破坏"挂死不挡路"的
 *  纪律：真挂死的 provider 依然会被拒并跳过该样本。 */
const DRAFT_TIMEOUT_MS = 300_000;

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
