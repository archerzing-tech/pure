// src/shared/skillDistill.ts
// E2.2 — 经验→技能沉淀（第一版用户触发）。对话里出现「把这个做法沉淀成技能」
// 一类指令时：取最近的过程记忆（procedure，兜底反思 lesson），让模型扩写成
// 标准 SKILL.md，入口各自落盘（CLI 写 ~/.pure/skills/auto-<name>/，GUI 走
// write_app_skill 命令）。设计明确不做自动触发——"使用后成功"的归因要等
// E4.1。本模块保持纯函数：正则识别、来源挑选、提示词、解析校验，fs 归入口。

import { parseSkillMarkdown } from './skillFiles';
import type { MemoryEntry, Message, ToolDefinition } from './types';

/** 指令识别：短语锚定，宁可漏配不可误触（误触会吞掉一条正常消息）。 */
const DISTILL_PATTERNS: RegExp[] = [
  /(沉淀|保存|固化|存|整理)成(个|一个)?技能/,
  /\b(?:distill|save|turn|make|package)\b[^.!?\n]{0,40}\b(?:as|into)\s+(?:a\s+)?(?:reusable\s+)?skill\b/i,
];

/** 命中沉淀指令则返回整条消息（作为扩写时的用户语境），否则 null。 */
export function matchSkillDistillInstruction(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 500) return null;
  for (const pattern of DISTILL_PATTERNS) {
    if (pattern.test(trimmed)) return trimmed;
  }
  return null;
}

/** 最近命中的 procedure/playbook：procedure 优先（E2.1 的产物），退而求其次
 *  取反思器写的 successful_pattern（reflect: 前缀，证据有校验）。都按时间取最新。 */
export function pickDistillSource(entries: MemoryEntry[]): MemoryEntry | undefined {
  const byNewest = (a: MemoryEntry, b: MemoryEntry) => b.timestamp - a.timestamp;
  const procedure = entries
    .filter(e => e.type === 'procedure')
    .sort(byNewest)[0];
  if (procedure) return procedure;
  return entries
    .filter(e => e.type === 'successful_pattern' && e.dedupeKey?.startsWith('reflect:'))
    .sort(byNewest)[0];
}

export const DISTILL_SYSTEM_PROMPT = `You distill a proven procedure into a reusable SKILL.md for an AI agent to follow next time the same kind of task appears.

Output ONLY the SKILL.md content — nothing else:
1. YAML frontmatter with exactly two fields:
   name: lowercase-kebab-case, ASCII letters/digits/dashes only, at most 50 characters, starting with a verb (e.g. "recover-stuck-git-rebase")
   description: one line, at most 100 characters, what the skill does and when to use it
2. A markdown body under 2000 characters: when-to-use note, numbered steps that an agent can follow mechanically, and how to verify the result. Keep only what generalizes — no session-specific file paths or one-off details.

No code fences, no commentary before or after.`;

export interface DistilledSkill {
  /** Final skill id — sanitized and forced onto the `auto-` prefix. */
  name: string;
  /** One-line frontmatter description (newlines stripped). */
  description: string;
  /** Body text (frontmatter stripped). */
  body: string;
  /** Normalized full SKILL.md ready to write. */
  markdown: string;
}

const NAME_MAX = 50;
const BODY_MAX = 8000;
const DESCRIPTION_MAX = 120;

function sanitizeSkillName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, NAME_MAX)
    .replace(/[._-]+$/g, '');
  if (!cleaned) return '';
  return cleaned.startsWith('auto-') ? cleaned : `auto-${cleaned}`;
}

/** Parse the model's reply into a normal SKILL.md. Tolerates code fences and
 *  prose around the file; enforces the `auto-` prefix so distilled skills are
 *  distinguishable from hand-installed ones. Returns null when nothing usable
 *  came back — callers then tell the user honestly instead of writing junk. */
export function parseDistilledSkill(reply: string): DistilledSkill | null {
  const fenced = reply.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? reply).trim();
  const parsed = parseSkillMarkdown(candidate) ?? parseSkillMarkdown(reply);
  if (!parsed || !parsed.body.trim()) return null;

  const fallbackName = `auto-skill-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const name = sanitizeSkillName(parsed.name) || fallbackName;
  const description = parsed.description.replace(/\s*\n+\s*/g, ' ').trim().slice(0, DESCRIPTION_MAX);
  const body = parsed.body.trim().slice(0, BODY_MAX);

  const markdown = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  return { name, description, body, markdown };
}

/** 结构化最小接口：LLMAdapter（CLI/GUI 真适配器）天然满足，测试里也好造假。 */
export interface DistillLlm {
  complete: (messages: Message[], tools: ToolDefinition[], signal?: AbortSignal) => Promise<{ content?: string }>;
}

const DISTILL_TIMEOUT_MS = 60_000;

/** One expansion round trip. Rejects on transport failure / timeout (callers
 *  degrade to an honest error message); resolves undefined on an unusable
 *  reply. Same shape as the E1.1 reflector's reflectTurn. */
export async function distillSkill(
  llm: DistillLlm,
  sourceContent: string,
  instruction: string,
  signal?: AbortSignal,
  timeoutMs: number = DISTILL_TIMEOUT_MS,
): Promise<DistilledSkill | undefined> {
  const userPrompt = [
    'Distill this procedure from a completed task into a reusable skill.',
    '',
    `Procedure notes (ground truth — do not invent steps it doesn't mention):`,
    sourceContent.slice(0, 4000),
    '',
    instruction ? `What the user asked: ${instruction}` : '',
  ].join('\n');

  let reply: string | undefined;
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('skill distill timed out')), timeoutMs),
    );
    const messages: Message[] = [
      { role: 'system', content: DISTILL_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];
    reply = (await Promise.race([llm.complete(messages, [], signal), timeout])).content;
  } catch {
    return undefined;
  }
  if (!reply) return undefined;
  return parseDistilledSkill(reply) ?? undefined;
}
