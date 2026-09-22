// src/harness/personaOverlayReflector.ts
// 北极星第 6 步 13.3（part 3）— overlay 起草器。E1.4 建议卡显示某角色持续短板，
// 本模块用一次便宜模型（E0.3 的 REFLECT 相）把失败画像 + base 契约提炼成一段
// overlay 文本（只增补约束/技巧，不重写 base）。
//
// 纪律与 LessonReflector 一致：模型没有最终决定权。产出必须过 part 1 的同一编译器
// `compilePersonaOverlays`（长度/角色/非空校验，宿主的落盘路径会再过一次），
// 并且必须过 part 2 的 A/B 门槛才许落盘——本模块只负责"起草"，准入门在调用方。
//
// 纯函数核心（提示词构造 + 回复解析）与 LLM 往返分开：前者 Bun 测试全覆盖，
// 后者只做超时/失败兜底（失败返回 undefined，绝不让起草失败影响仪表盘渲染）。

import { MAX_OVERLAY_CHARS } from './personaOverlays';
import { SUBAGENT_ADVICE_WINDOW_DAYS, type SubagentAdvice } from '../shared/subagentAdvisory';
import type { LLMAdapter } from '../shared/types';

export interface OverlayDraftInput {
  role: string;
  /** E1.4 的失败画像——起草的唯一事实来源。 */
  advice: SubagentAdvice;
  /** 该角色 base persona 的契约摘要（脚本/宿主从注册表取），断言的锚。 */
  baseContract: string;
}

/** 失败画像转成给模型看的事实块（不喂原始报文，只喂可迁移的结论）。 */
export function buildFailureProfile(advice: SubagentAdvice): string {
  const lines = [
    `- 近 ${SUBAGENT_ADVICE_WINDOW_DAYS} 天派发 ${advice.delegations} 次，失败 ${advice.failures} 次（${advice.failureRate}%）。`,
    `- 主导失败类型：${advice.dominantKind}。`,
  ];
  if (advice.timeoutCount > 0) lines.push(`- 其中超时 ${advice.timeoutCount} 次。`);
  if (advice.avgDurationMs !== null) lines.push(`- 平均耗时约 ${Math.round(advice.avgDurationMs / 1000)} 秒。`);
  lines.push(advice.reason === 'timeout'
    ? '- 判断：任务体量偏大，角色倾向于一次做太多。'
    : '- 判断：交付缺少验证证据 / 范围失控。');
  return lines.join('\n');
}

const DRAFT_SYSTEM_PROMPT = `You improve ONE subagent role by writing an OVERLAY: a short addendum appended AFTER the role's existing system prompt. You do NOT rewrite the base prompt.

Output ONLY the overlay text in Markdown — no JSON, no code fences, no preamble, no explanation. If the failure profile gives you nothing useful to add, output the single word: NONE

Hard rules:
- Additions only: extra constraints, checklists, or techniques that target the observed failures. Never restate or contradict the base contract.
- Be specific and actionable, not generic advice. Every rule must trace to the given failure profile.
- Keep it tight — under ${MAX_OVERLAY_CHARS} characters. A short checklist beats an essay.
- Write in the SAME language as the base contract.`;

/** Render the user-message payload: role, its contract, and the failure profile. */
export function buildOverlayDraftPrompt(input: OverlayDraftInput): string {
  return [
    `ROLE: ${input.role}`,
    `BASE CONTRACT (what this role already is — do not rewrite):\n${input.baseContract.slice(0, 1500) || '(not provided)'}`,
    `OBSERVED FAILURE PROFILE (the only justification for your additions):\n${buildFailureProfile(input.advice)}`,
  ].join('\n\n');
}

/** Strip a leading/trailing code fence a chatty model may wrap the overlay in. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (match ? match[1] : trimmed).trim();
}

/** Validate a model reply into overlay text. `NONE` (the model declining) and
 *  anything outside [8, MAX_OVERLAY_CHARS] is unusable → undefined. */
export function parseOverlayDraft(reply: string): string | undefined {
  const text = stripFences(reply);
  if (!text || text === 'NONE') return undefined;
  if (text.length < 8 || text.length > MAX_OVERLAY_CHARS) return undefined;
  return text;
}

/** Same wall-clock discipline as the lesson reflector: a hung provider degrades
 *  to "no draft", never wedges the dashboard. */
const DRAFT_TIMEOUT_MS = 60_000;

export async function draftPersonaOverlay(
  llm: LLMAdapter,
  input: OverlayDraftInput,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const reply = await Promise.race([
    llm.complete(
      [
        { role: 'system', content: DRAFT_SYSTEM_PROMPT },
        { role: 'user', content: buildOverlayDraftPrompt(input) },
      ],
      [],
      signal,
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`overlay draft timed out after ${DRAFT_TIMEOUT_MS}ms`)), DRAFT_TIMEOUT_MS),
    ),
  ]);
  return parseOverlayDraft(reply.content);
}
