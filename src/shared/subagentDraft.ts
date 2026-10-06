// src/shared/subagentDraft.ts
// E1.4 → 13.2 生成半边（MVP）。E1.4 建议卡说"这个角色在反复掉链子"，本模块把那条
// 建议升级成一键动作：按失败画像生成一个**收窄范围的变体角色** manifest 草稿
// （~/.pure/subagents/<role>_focused.json），用户改完重启即被 13.2 加载半边接收。
//
// 设计口径（capability-self-extension-design.md §13.2）：模型起草是完整版；MVP 先做
// 确定性草稿——不依赖 provider、瞬间完成、绝不静默落盘（调用方必须先过
// compileExternalSubagents 校验，再让用户确认）。试用制准入留给完整版。
//
// 2026-10-06 完整版加厚：确定性草稿**不改**（它是零 provider 依赖的快路径，也是模型
// 起草失败时的退路），另加一条模型起草路径——纪律与 13.4（P2-2 `toolSolidification`）
// 逐字同款：草稿必须过加载半边**同一个** `compileExternalSubagents`、模型有拒绝权
// （输出 NONE 即不当工具使）、落盘前必过确认缝、同名绝不覆盖。这三道门原本就写在
// 确定性路径的调用方里，加厚后两条路径共用，不新增第四道门。

import { compileExternalSubagents } from '../harness/externalSubagents';
import type { LLMAdapter } from './types';
import { SUBAGENT_ADVICE_WINDOW_DAYS, type SubagentAdvice } from './subagentAdvisory';

/** 草稿命名：原角色名 + `_focused`（收窄语义），与 manifest 名字规则同构。 */
export function draftRoleName(role: string): string {
  return `${role}_focused`;
}

export interface DraftRoleManifest {
  file: string;
  /** 格式化好的 manifest JSON 文本（2 空格缩进，用户可直接编辑）。 */
  json: string;
}

/**
 * 按失败画像生成变体角色草稿。超时型 → 教"一次只做一小步"；失败型 → 教"先验证
 * 再交付"。标签/预算沿用加载半边的安全默认（read-only、并行安全），超时型给满
 * 30 分钟预算（与内建角色一致，让子代理预算而不是角色超时先说话）。
 */
export function buildDraftRoleManifest(advice: SubagentAdvice): DraftRoleManifest {
  const name = draftRoleName(advice.role);
  const timeoutShaped = advice.reason === 'timeout';
  const description = timeoutShaped
    ? `${advice.role} 的收窄变体：一次委派只做一个小而自足的步骤（原角色近 ${SUBAGENT_ADVICE_WINDOW_DAYS} 天超时 ${advice.timeoutCount} 次，任务体量偏大）。用更小的任务粒度换取稳定完成。`
    : `${advice.role} 的收窄变体：只接目标明确、可验证的小任务，交付必须带验证证据（原角色近 ${SUBAGENT_ADVICE_WINDOW_DAYS} 天失败率 ${advice.failureRate}%）。`;
  const discipline = timeoutShaped
    ? `纪律：
1. 一次委派只处理一个明确的小步骤；接到大任务时，先输出"我会怎么拆"，请求把任务拆小，而不是硬跑。
2. 控制探索范围：只读完成任务所必需的文件，不做顺带的全面检查。
3. 交付从简：结论 + 一行证据即可，宁可交一半确定的结果，也不为凑完整而超时。`
    : `纪律：
1. 动手前先声明你要验证什么；交付时必须带验证证据（命令输出/文件行号），没有证据的结论要标注"未验证"。
2. 范围收紧：只做任务描述里点名的事，顺带发现的问题记录下来但不展开。
3. 卡住就如实上报卡点，不要用猜测填补证据的空缺。`;
  const manifest = {
    version: 1,
    name,
    description,
    systemPrompt: `你是 ${advice.role} 的收窄特化版，专注把一个小任务稳定做完，而不是把一个大任务做完一半。

任务：{prompt}
相关文件（可能为空）：{files}

${discipline}`,
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '一个小而明确的任务步骤' },
        files: { type: 'string', description: '相关文件路径（可选，逗号分隔）' },
      },
      required: ['prompt'],
    },
    ...(timeoutShaped ? { timeoutMs: 1_800_000 } : {}),
  };
  return { file: `${name}.json`, json: `${JSON.stringify(manifest, null, 2)}\n` };
}

// ── 完整版：模型起草（13.2，与 13.4 同款纪律）──

/** 起草超时（与 13.4 TOOL.json 起草同档：写一份角色 manifest 不需要更久）。 */
const ROLE_DRAFT_TIMEOUT_MS = 60_000;

/** 起草重试上限：一次失败退回重写，两次都失败放弃（与 13.4 同值同理由）。 */
export const MAX_ROLE_DRAFT_ATTEMPTS = 2;

/**
 * 起草 system prompt。与 13.4 的 DRAFT_SYSTEM_PROMPT 同纪律：只输出 JSON，
 * 教清字段形状，并把拒绝权写在第一行——不合适就说 NONE，不许硬凑。
 *
 * 与 13.4 的差别只在内容面：工具固化改的是「怎么执行」，角色起草改的是「一个代理
 * 怎么做事」，所以纪律条文本身直接取自失败画像（超时→粒度，失败→证据），而不是让
 * 模型自己想。画像是真数据，比模型拍脑袋更可靠。
 */
const ROLE_DRAFT_SYSTEM_PROMPT = `You design a specialist sub-agent role manifest for a coding agent team. Output ONLY valid JSON (no markdown fences, no explanation).

The JSON must have these fields:
- name: lowercase_with_underscores, 2-64 chars, must start with a letter. Append "_v2" unless you are deliberately renaming.
- description: what this role does and when to delegate to it, ≥8 chars (the parent LLM picks the role by reading this).
- systemPrompt: the role's operating instructions. Use {prompt} where the delegated task goes.
- input_schema: JSON Schema object with "properties" and "required" (always include "prompt").
- tags: optional array from ["read", "write", "parallel"].
- timeoutMs: optional positive number of milliseconds.

Rules:
- Write the discipline into systemPrompt; the parent LLM cannot see this manifest.
- If this role's failure is timeouts, the discipline must shrink the unit of work. If it is failures, the discipline must demand verification evidence. Never soften either into generic advice.
- Keep systemPrompt under 400 chars. A role prompt that reads like an essay is not used.
- If the failure profile does not actually support designing a new role, output the single word: NONE`;

/** 把失败画像渲染成起草素材（与确定性草稿同源事实，不另编数据）。 */
export function buildRoleDraftPrompt(advice: SubagentAdvice): string {
  const timeoutShaped = advice.reason === 'timeout';
  const profile = [
    `ROLE UNDER TROUBLE: ${advice.role}`,
    `Failures in the last ${SUBAGENT_ADVICE_WINDOW_DAYS} days: ${advice.failures} of ${advice.delegations} delegations failed (${advice.failureRate}%), ${advice.timeoutCount} of them timed out.`,
    `Dominant failure kind: ${advice.dominantKind}. Average duration: ${advice.avgDurationMs === null ? 'not recorded' : `${Math.round(advice.avgDurationMs / 1000)}s`}.`,
    '',
    timeoutShaped
      ? 'Shape: this role times out, so its unit of work is too big. The new role must do ONE small self-contained step and hand back early.'
      : 'Shape: this role fails without finishing, so its deliverables are unverified. The new role must demand evidence and report blockers honestly instead of guessing.',
  ].join('\n');
  return profile;
}

export interface RoleDraft {
  name: string;
  description: string;
  systemPrompt: string;
  input_schema: Record<string, unknown>;
  tags?: string[];
  timeoutMs?: number;
}

/** 解析 LLM 回复为 RoleDraft。NONE / 坏 JSON / 缺字段 → undefined。 */
export function parseRoleDraft(reply: string): RoleDraft | undefined {
  const text = reply.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  if (!text || text === 'NONE') return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<RoleDraft>;
    if (typeof parsed.name !== 'string' || typeof parsed.description !== 'string' || typeof parsed.systemPrompt !== 'string') {
      return undefined;
    }
    if (!parsed.input_schema || typeof parsed.input_schema !== 'object') return undefined;
    const draft: RoleDraft = {
      name: parsed.name,
      description: parsed.description,
      systemPrompt: parsed.systemPrompt,
      input_schema: parsed.input_schema as Record<string, unknown>,
    };
    if (Array.isArray(parsed.tags)) draft.tags = parsed.tags.filter((tag): tag is string => typeof tag === 'string');
    if (typeof parsed.timeoutMs === 'number' && Number.isFinite(parsed.timeoutMs)) draft.timeoutMs = parsed.timeoutMs;
    return draft;
  } catch {
    return undefined;
  }
}

/**
 * 草稿过加载半边**同一个**校验器（与 13.4 的 draftPassesCompiler 同纪律）。
 * reservedNames 是内建角色名：碰名的草稿一律不许落盘。
 */
export function roleDraftPassesCompiler(draft: RoleDraft, reservedNames: Iterable<string>): boolean {
  const { defs, errors } = compileExternalSubagents(
    [{ file: `${draft.name}.json`, text: roleDraftManifest(draft) }],
    reservedNames,
  );
  return defs.length === 1 && errors.length === 0;
}

/** 草稿 → 落盘文本（确定性路径的 manifest 序列化与此处共用同一形状）。 */
export function roleDraftManifest(draft: RoleDraft): string {
  const manifest: Record<string, unknown> = {
    version: 1,
    name: draft.name,
    description: draft.description,
    systemPrompt: draft.systemPrompt,
    input_schema: draft.input_schema,
  };
  if (draft.tags && draft.tags.length > 0) manifest.tags = draft.tags;
  if (draft.timeoutMs !== undefined) manifest.timeoutMs = draft.timeoutMs;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export type RoleDraftOutcome =
  | { kind: 'drafted'; draft: RoleDraft }
  | { kind: 'none' }        // 模型拒绝（画像不支持设计新角色）
  | { kind: 'invalid'; reason: string };

/**
 * 模型起草一步：LLM 出草稿 → 解析 → 过加载半边校验器。
 * **不写盘、不确认**——落盘那三道门（确认 / 同名不覆盖 / 写失败）全在调用方，
 * 与确定性路径共用同一处，模型起草不另开通路。失败重试 ≤ MAX_ROLE_DRAFT_ATTEMPTS。
 */
export async function runRoleDraftFlow(input: {
  advice: SubagentAdvice;
  llm: LLMAdapter;
  reservedNames: Iterable<string>;
  signal?: AbortSignal;
}): Promise<RoleDraftOutcome> {
  let lastError = '';
  // 拒绝权只能来自模型**真的说 NONE**：所以在解析之前就判定并当场返回，不靠
  // lastError 里含 "declined" 字样反推——否则「首轮解析坏、二轮校验失败」会被误报成
  // 「模型拒绝」，用户看到的是一个根本没发生过的拒绝。这两种结局要给不同的下一步。
  for (let attempt = 1; attempt <= MAX_ROLE_DRAFT_ATTEMPTS; attempt++) {
    let reply: string;
    try {
      const result = await Promise.race([
        input.llm.complete(
          [
            { role: 'system', content: ROLE_DRAFT_SYSTEM_PROMPT },
            { role: 'user', content: buildRoleDraftPrompt(input.advice) },
          ],
          [],
          input.signal,
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`draft timed out after ${ROLE_DRAFT_TIMEOUT_MS}ms`)), ROLE_DRAFT_TIMEOUT_MS)),
      ]);
      reply = result.content;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }

    if (reply.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim() === 'NONE') {
      return { kind: 'none' };
    }

    const draft = parseRoleDraft(reply);
    if (!draft) {
      lastError = 'model produced unparseable JSON';
      continue;
    }
    if (!roleDraftPassesCompiler(draft, input.reservedNames)) {
      lastError = `draft failed loader validation (name="${draft.name}")`;
      continue;
    }
    return { kind: 'drafted', draft };
  }
  return { kind: 'invalid', reason: lastError };
}
